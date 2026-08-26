#!/usr/bin/env node
/**
 * Social Media Monitor - entry point.
 *
 * Wires the pieces together and starts polling:
 *
 *   config -> matcher + sentiment -> connectors -> scheduler
 *                                       |
 *                                   pipeline -> store -> notifications
 *                                       |
 *                                   event hub -> dashboard (SSE)
 *
 * Usage:
 *   node server.js                 start the dashboard and poll continuously
 *   node server.js --mock          force synthetic data
 *   node server.js --once          poll every platform once, print, exit
 *   node server.js --port 4000     override the port
 *   node server.js --frequency 1m  override the polling frequency
 *   node server.js --no-server     poll without serving the dashboard
 *
 * In production HOST, PORT and MONITOR_TOKEN come from the environment, which
 * is how infra/social-media-monitor.service and infra/nginx.conf reach it: the
 * app listens on loopback and nginx injects the token header upstream.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './src/config.js';
import { createLogger, setLogLevel } from './src/log.js';
import { createMatcher } from './src/core/matcher.js';
import { createSentimentAnalyzer } from './src/core/sentiment.js';
import { createStore } from './src/core/store.js';
import { createCrisisDetector } from './src/core/crisis.js';
import { createPipeline } from './src/core/pipeline.js';
import { createScheduler } from './src/core/scheduler.js';
import { createConnectors } from './src/platforms/index.js';
import { createDispatcher } from './src/notify/index.js';
import { createEventHub } from './src/server/sse.js';
import { createServer } from './src/server/http.js';

const VERSION = '2.0.0';
const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));

const log = createLogger('main');

/** Minimal flag parser: --flag, --key value, --key=value. */
function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;

    const [key, inlineValue] = token.slice(2).split('=');
    if (inlineValue !== undefined) {
      args[key] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }

  return args;
}

/**
 * Applies CLI flags as session-only overrides.
 *
 * Deliberately setOverrides() and not update(): a flag like --frequency must
 * not end up in config.json the next time something persists a change.
 */
function applyCliOverrides(configStore, args) {
  const monitoring = {};
  if (args.mock) monitoring.mockMode = 'on';
  if (args.frequency) monitoring.frequency = args.frequency;

  const server = {};
  if (args.port) server.port = Number(args.port);
  if (args.host) server.host = args.host;

  const patch = {};
  if (Object.keys(monitoring).length) patch.monitoring = monitoring;
  if (Object.keys(server).length) patch.server = server;

  if (Object.keys(patch).length > 0) configStore.setOverrides(patch);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(
      'Social Media Monitor\n\n' +
      '  node server.js [--mock] [--once] [--no-server]\n' +
      '                 [--port <n>] [--host <addr>] [--frequency <spec>]\n' +
      '                 [--config <path>] [--log-level debug|info|warn|error]\n\n'
    );
    return;
  }

  if (args['log-level']) setLogLevel(args['log-level']);

  const configPath = path.resolve(args.config || path.join(PROJECT_ROOT, 'config.json'));
  const configStore = loadConfig(configPath);
  applyCliOverrides(configStore, args);

  const config = configStore.get();

  log.info(`Social Media Monitor v${VERSION}`);
  log.info(
    `tracking ${config.companies.length} companies across ` +
    `${config.monitoring.enabledPlatforms.length} platform(s)`
  );

  /* ------------------------------------------------------------ components */

  const matcher = createMatcher(config.companies);
  const sentiment = createSentimentAnalyzer(config.sentiment);
  const store = createStore(config.storage).init();
  const crisis = createCrisisDetector(config.crisis);
  const hub = createEventHub();

  const dispatcher = createDispatcher({
    config,
    onDesktop: (payload) => hub.broadcast('desktop', payload),
    onDelivery: (record) => {
      store.recordAlert({ type: 'notification', ...record });
      hub.broadcast('notification', record);
    }
  });

  const pipeline = createPipeline({ matcher, sentiment, store, crisis, dispatcher });
  const connectors = createConnectors({ config, matcher });

  const scheduler = createScheduler({
    slots: connectors.slots,
    pipeline,
    matcher,
    monitoring: config.monitoring
  });

  /* --------------------------------------------------------- event plumbing */

  pipeline.on('mention', (mention) => hub.broadcast('mention', mention));
  pipeline.on('crisis', (event) => hub.broadcast('crisis', event));
  pipeline.on('ingest', (summary) => {
    hub.broadcast('ingest', {
      source: summary.source,
      received: summary.received,
      matched: summary.matched,
      added: summary.added,
      duplicates: summary.duplicates
    });
  });

  scheduler.on('state', (status) => hub.broadcast('scheduler', status));
  scheduler.on('poll:error', (event) => hub.broadcast('poll-error', event));

  /* ------------------------------------------------- live config rebuilding */

  /**
   * Applies a config patch to already-running components.
   * @returns {{applied: string[], restartRequired: string[]}}
   */
  function rebuild(patch) {
    const applied = [];
    const restartRequired = [];
    const current = configStore.get();

    if (patch.companies) {
      matcher.rebuild(current.companies);
      applied.push('companies (matcher recompiled)');
    }

    if (patch.sentiment) {
      pipeline.reconfigure({ sentiment: createSentimentAnalyzer(current.sentiment) });
      applied.push('sentiment');
    }

    if (patch.crisis) {
      crisis.reconfigure(current.crisis);
      applied.push('crisis thresholds');
    }

    if (patch.notifications) {
      dispatcher.reconfigure(current);
      applied.push('notification channels');
    }

    if (patch.monitoring) {
      scheduler.applyMonitoringConfig(current.monitoring);
      applied.push('monitoring schedule');

      // Which connector runs for a platform is decided at construction, so
      // these two need a restart rather than pretending to take effect.
      if (patch.monitoring.enabledPlatforms || patch.monitoring.mockMode) {
        restartRequired.push('monitoring.enabledPlatforms / monitoring.mockMode');
      }
    }

    if (patch.storage) restartRequired.push('storage');
    if (patch.server) restartRequired.push('server');

    return { applied, restartRequired };
  }

  /* ------------------------------------------------------------- run modes */

  if (args.once) {
    log.info('single-poll mode');
    const results = [];

    for (const slot of connectors.slots.filter((entry) => entry.connector)) {
      try {
        const items = await slot.connector.fetch({
          terms: matcher.queryTerms(),
          since: new Date(Date.now() - (config.monitoring.lookbackMinutes || 120) * 60000),
          limit: config.monitoring.maxItemsPerPoll
        });
        const summary = await pipeline.ingest(items, { source: slot.platform });
        results.push(summary);
      } catch (error) {
        log.error(`${slot.platform} failed: ${error.message}`);
      }
    }

    const totals = results.reduce((accumulator, summary) => ({
      received: accumulator.received + summary.received,
      matched: accumulator.matched + summary.matched,
      added: accumulator.added + summary.added
    }), { received: 0, matched: 0, added: 0 });

    log.info(
      `done: ${totals.received} fetched, ${totals.matched} matched, ${totals.added} stored`
    );

    hub.close();
    return;
  }

  let httpServer = null;
  if (!args['no-server']) {
    httpServer = createServer({
      configStore,
      store,
      scheduler,
      crisis,
      dispatcher,
      hub,
      connectors,
      rebuild,
      staticRoot: PROJECT_ROOT,
      authToken: process.env.MONITOR_TOKEN || null,
      version: VERSION
    });

    await httpServer.listen();
  }

  scheduler.start();

  if (scheduler.paused) log.warn('monitoring starts PAUSED (monitoring.startPaused)');

  /* ------------------------------------------------------------- shutdown  */

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info(`${signal} received, shutting down`);
    scheduler.stop();
    if (httpServer) await httpServer.close();
    else hub.close();

    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', reason instanceof Error ? reason : String(reason));
  });
}

main().catch((error) => {
  log.error('startup failed', error);
  process.exit(1);
});
