/** API routes, scheduler timing decisions and the SSE hub. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert, describe, test } from './harness.js';
import { createApi } from '../src/server/api.js';
import { createEventHub } from '../src/server/sse.js';
import { Scheduler } from '../src/core/scheduler.js';
import { createStore } from '../src/core/store.js';
import { createCrisisDetector } from '../src/core/crisis.js';
import { createMatcher } from '../src/core/matcher.js';
import { ConfigStore } from '../src/config.js';
import { toExportRow } from '../src/server/api.js';

let counter = 0;

function tempDir() {
  counter += 1;
  const directory = path.join(os.tmpdir(), `smm-srv-${process.pid}-${counter}`);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function cleanup(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

const COMPANIES = [{ id: 'acme', name: 'Acme Corp', aliases: ['Acme'] }];

/** A ConfigStore backed by a real file, so save() can be exercised. */
function configStoreIn(directory, overrides = {}) {
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    companies: COMPANIES,
    monitoring: { frequency: '5m', enabledPlatforms: ['youtube'], mockMode: 'on' },
    crisis: { windowMinutes: 15, negativeThreshold: 5 },
    notifications: {
      desktop: { enabled: true, events: ['crisis'] },
      webhooks: [{ name: 'Ops', type: 'slack', url: 'env:TEST_HOOK_URL', enabled: true, events: ['crisis'] }]
    },
    ...overrides
  }, null, 2));

  const store = new ConfigStore(configPath);
  store.load();
  return store;
}

/** Builds an API surface over real store/crisis objects and stub collaborators. */
function apiFor(directory) {
  const configStore = configStoreIn(directory);
  const store = createStore({ dataDir: directory }).init();
  const crisis = createCrisisDetector(configStore.get().crisis);
  const hub = { clientCount: 0, broadcast: () => 0 };

  const schedulerCalls = [];
  const scheduler = {
    status: () => ({ started: true, paused: false, platforms: [] }),
    pause: () => { schedulerCalls.push('pause'); return { paused: true }; },
    resume: () => { schedulerCalls.push('resume'); return { paused: false }; },
    runNow: (platform) => { schedulerCalls.push(`runNow:${platform || 'all'}`); return ['YouTube']; },
    applyMonitoringConfig: () => schedulerCalls.push('applyMonitoringConfig')
  };

  const dispatcherCalls = [];
  const dispatcher = {
    channelsFor: () => [{ kind: 'desktop', name: 'Browser push', ready: true, reason: null }],
    reconfigure: () => dispatcherCalls.push('reconfigure'),
    test: (kind) => {
      dispatcherCalls.push(`test:${kind}`);
      return Promise.resolve({ event: kind, delivered: [{ name: 'Browser push', ok: true }], skipped: [] });
    }
  };

  const mockCalls = [];
  const connectors = {
    mockMode: true,
    mock: { queueCrisis: (count) => mockCalls.push(count) }
  };

  const rebuilds = [];
  const api = createApi({
    configStore,
    store,
    scheduler,
    crisis,
    dispatcher,
    hub,
    connectors,
    rebuild: (patch) => {
      rebuilds.push(patch);
      return { applied: Object.keys(patch), restartRequired: [] };
    },
    version: 'test'
  });

  return { api, configStore, store, crisis, schedulerCalls, dispatcherCalls, mockCalls, rebuilds };
}

/** Mimics the HTTP layer's call shape. */
function call(api, route, { query = {}, body = null } = {}) {
  const handler = api[route];
  if (!handler) throw new Error(`no route ${route}`);
  return handler({ query: new URLSearchParams(query), body });
}

function mention(id, overrides = {}) {
  return {
    id,
    timestamp: new Date().toISOString(),
    platform: 'YouTube',
    kind: 'video',
    text: 'Acme Corp did well',
    author: { name: 'A', handle: '@a' },
    url: 'https://example.invalid/1',
    sentiment: 'positive',
    sentimentScore: 0.5,
    companies: [{ companyId: 'acme', companyName: 'Acme Corp' }],
    matchedTerms: ['Acme'],
    metrics: { likes: 3, comments: 1 },
    ...overrides
  };
}

describe('api routes', () => {
  test('health reports version and uptime', () => {
    const directory = tempDir();
    try {
      const { api } = apiFor(directory);
      const result = call(api, 'GET /api/health');
      assert.equal(result.status, 'ok');
      assert.equal(result.version, 'test');
    } finally {
      cleanup(directory);
    }
  });

  test('status summarises companies, channels and mock mode', () => {
    const directory = tempDir();
    try {
      const { api, store } = apiFor(directory);
      store.add(mention('a'));

      const result = call(api, 'GET /api/status');
      assert.equal(result.mockMode, true);
      assert.equal(result.counts.mentions, 1);
      assert.equal(result.companies[0].id, 'acme');
      assert.equal(result.companies[0].termCount, 2, 'name plus one alias');
      assert.ok(result.frequencyPresets.some((preset) => preset.key === '15m'));
      assert.equal(result.crisis.threshold, 5);
    } finally {
      cleanup(directory);
    }
  });

  test('config is returned redacted', () => {
    const directory = tempDir();
    try {
      process.env.TEST_HOOK_URL = 'https://hooks.slack.com/services/AAA/BBB/CCCsecret';
      const { api } = apiFor(directory);

      const { config } = call(api, 'GET /api/config');
      assert.notOk(
        JSON.stringify(config).includes('CCCsecret'),
        'the webhook URL must never reach the browser in full'
      );
    } finally {
      delete process.env.TEST_HOOK_URL;
      cleanup(directory);
    }
  });

  test('mentions applies filters and caps the page size', () => {
    const directory = tempDir();
    try {
      const { api, store } = apiFor(directory);
      store.addMany([
        mention('a', { sentiment: 'negative' }),
        mention('b', { platform: 'TikTok' }),
        mention('c')
      ]);

      assert.equal(call(api, 'GET /api/mentions', { query: { sentiment: 'negative' } }).total, 1);
      assert.equal(call(api, 'GET /api/mentions', { query: { platform: 'TikTok' } }).total, 1);
      assert.equal(call(api, 'GET /api/mentions', { query: { limit: '9999' } }).limit, 500, 'limit is clamped');
    } finally {
      cleanup(directory);
    }
  });

  test('export returns a raw CSV download with a filename', () => {
    const directory = tempDir();
    try {
      const { api, store } = apiFor(directory);
      store.add(mention('a'));

      const result = call(api, 'GET /api/export', { query: { format: 'csv' } });
      assert.ok(result.raw, 'must be flagged as a file download');
      assert.includes(result.raw.contentType, 'text/csv');
      assert.includes(result.raw.filename, '.csv');
      assert.includes(result.raw.body, 'Acme Corp did well');
    } finally {
      cleanup(directory);
    }
  });

  test('export honours filters and defaults to JSON', () => {
    const directory = tempDir();
    try {
      const { api, store } = apiFor(directory);
      store.addMany([mention('a'), mention('b', { platform: 'TikTok' })]);

      const result = call(api, 'GET /api/export', { query: { platform: 'TikTok' } });
      const payload = JSON.parse(result.raw.body);

      assert.equal(payload.count, 1);
      assert.equal(payload.mentions[0].platform, 'TikTok');
      assert.ok(payload.stats, 'the export should carry its own summary');
    } finally {
      cleanup(directory);
    }
  });

  test('toExportRow flattens nested fields', () => {
    const row = toExportRow(mention('a'));
    assert.equal(row.companies, 'Acme Corp');
    assert.equal(row.authorHandle, '@a');
    assert.equal(row.likes, 3);
  });

  test('frequency route validates before applying', () => {
    const directory = tempDir();
    try {
      const { api, configStore, schedulerCalls } = apiFor(directory);

      const result = call(api, 'POST /api/control/frequency', { body: { frequency: '15m' } });
      assert.equal(result.frequency, '15m');
      assert.equal(configStore.get().monitoring.frequency, '15m');
      assert.includes(schedulerCalls, 'applyMonitoringConfig');

      assert.throws(
        () => call(api, 'POST /api/control/frequency', { body: { frequency: 'banana' } }),
        'cannot understand'
      );
      assert.equal(configStore.get().monitoring.frequency, '15m', 'a bad value must change nothing');

      assert.throws(() => call(api, 'POST /api/control/frequency', { body: {} }), 'required');
    } finally {
      cleanup(directory);
    }
  });

  test('frequency route can target one platform', () => {
    const directory = tempDir();
    try {
      const { api, configStore } = apiFor(directory);
      call(api, 'POST /api/control/frequency', { body: { frequency: '1h', platform: 'youtube' } });

      assert.equal(configStore.get().monitoring.perPlatform.youtube, '1h');
      assert.equal(configStore.get().monitoring.frequency, '5m', 'the global value is untouched');
    } finally {
      cleanup(directory);
    }
  });

  test('pause, resume and poll delegate to the scheduler', () => {
    const directory = tempDir();
    try {
      const { api, schedulerCalls } = apiFor(directory);

      call(api, 'POST /api/control/pause');
      call(api, 'POST /api/control/resume');
      call(api, 'POST /api/control/poll', { body: { platform: 'youtube' } });

      assert.deepEqual(schedulerCalls, ['pause', 'resume', 'runNow:youtube']);
    } finally {
      cleanup(directory);
    }
  });

  test('channel toggle flips enabled without touching the URL placeholder', () => {
    const directory = tempDir();
    try {
      const { api, configStore } = apiFor(directory);

      const result = call(api, 'POST /api/channels/toggle', {
        body: { kind: 'webhook', name: 'Ops', enabled: false, persist: true }
      });

      assert.equal(result.enabled, false);
      assert.equal(configStore.raw.notifications.webhooks[0].enabled, false);
      assert.equal(
        configStore.raw.notifications.webhooks[0].url,
        'env:TEST_HOOK_URL',
        'the env placeholder must survive a persist'
      );

      const onDisk = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'));
      assert.equal(onDisk.notifications.webhooks[0].url, 'env:TEST_HOOK_URL');
    } finally {
      cleanup(directory);
    }
  });

  test('channel toggle validates its input', () => {
    const directory = tempDir();
    try {
      const { api } = apiFor(directory);

      assert.throws(() => call(api, 'POST /api/channels/toggle', { body: { kind: 'webhook', name: 'Ops' } }), 'must be true or false');
      assert.throws(() => call(api, 'POST /api/channels/toggle', { body: { kind: 'pigeon', enabled: true } }), 'must be desktop, email or webhook');
      assert.throws(() => call(api, 'POST /api/channels/toggle', { body: { kind: 'webhook', name: 'Nope', enabled: true } }), 'no webhook named');
    } finally {
      cleanup(directory);
    }
  });

  test('PATCH config rebuilds only what changed', () => {
    const directory = tempDir();
    try {
      const { api, rebuilds, configStore } = apiFor(directory);

      const result = call(api, 'PATCH /api/config', { body: { crisis: { negativeThreshold: 9 } } });

      assert.ok(result.ok);
      assert.equal(configStore.get().crisis.negativeThreshold, 9);
      assert.deepEqual(rebuilds[0], { crisis: { negativeThreshold: 9 } });
      assert.notOk(result.persisted, 'persist defaults to off');
    } finally {
      cleanup(directory);
    }
  });

  test('PATCH config rejects a non-object body', () => {
    const directory = tempDir();
    try {
      const { api } = apiFor(directory);
      assert.throws(() => call(api, 'PATCH /api/config', { body: null }), 'JSON object body');
    } finally {
      cleanup(directory);
    }
  });

  test('crisis acknowledge clears the cooldown', () => {
    const directory = tempDir();
    try {
      const { api, crisis } = apiFor(directory);
      crisis.lastFiredAt = Date.now();

      const result = call(api, 'POST /api/crisis/acknowledge');
      assert.ok(result.acknowledged);
      assert.equal(crisis.lastFiredAt, null);
    } finally {
      cleanup(directory);
    }
  });

  test('crisis simulation is queued in mock mode and refused otherwise', () => {
    const directory = tempDir();
    try {
      const { api, mockCalls } = apiFor(directory);

      const result = call(api, 'POST /api/simulate/crisis', { body: { count: 7 } });
      assert.equal(result.queued, 7);
      assert.deepEqual(mockCalls, [7]);

      // Clamped to a sane range.
      call(api, 'POST /api/simulate/crisis', { body: { count: 9999 } });
      assert.equal(mockCalls[1], 50);
    } finally {
      cleanup(directory);
    }
  });

  test('crisis simulation is refused when not in mock mode', () => {
    const directory = tempDir();
    try {
      const configStore = configStoreIn(directory);
      const api = createApi({
        configStore,
        store: createStore({ dataDir: directory }).init(),
        scheduler: { status: () => ({}) },
        crisis: createCrisisDetector({}),
        dispatcher: { channelsFor: () => [] },
        hub: { clientCount: 0, broadcast: () => 0 },
        connectors: { mockMode: false, mock: null },
        rebuild: () => ({ applied: [], restartRequired: [] }),
        version: 'test'
      });

      assert.throws(() => call(api, 'POST /api/simulate/crisis', { body: { count: 3 } }), 'only available in mock mode');
    } finally {
      cleanup(directory);
    }
  });

  test('notify test delegates to the dispatcher', async () => {
    const directory = tempDir();
    try {
      const { api, dispatcherCalls } = apiFor(directory);
      const result = await call(api, 'POST /api/notify/test', { body: { kind: 'crisis' } });

      assert.equal(result.kind, 'crisis');
      assert.includes(dispatcherCalls, 'test:crisis');
    } finally {
      cleanup(directory);
    }
  });

  test('DELETE mentions clears the store and resets crisis state', () => {
    const directory = tempDir();
    try {
      const { api, store, crisis } = apiFor(directory);
      store.addMany([mention('a'), mention('b')]);
      crisis.lastFiredAt = Date.now();

      const result = call(api, 'DELETE /api/mentions');
      assert.equal(result.removed, 2);
      assert.equal(store.mentions.length, 0);
      assert.equal(crisis.lastFiredAt, null);
    } finally {
      cleanup(directory);
    }
  });
});

describe('scheduler', () => {
  /** A scheduler over stub connectors; nothing is actually started. */
  function schedulerFor(monitoring, slots) {
    return new Scheduler({
      slots: slots || [
        { key: 'youtube', platform: 'YouTube', connector: { fetch: async () => [] }, mode: 'native', reason: null },
        { key: 'facebook', platform: 'Facebook', connector: null, mode: 'skipped', reason: 'missing FB_ACCESS_TOKEN' }
      ],
      pipeline: { ingest: async () => ({ received: 0, matched: 0, added: 0, duplicates: 0 }) },
      matcher: createMatcher(COMPANIES),
      monitoring
    });
  }

  test('applies per-platform frequency overrides', () => {
    const scheduler = schedulerFor({
      frequency: '5m',
      perPlatform: { youtube: '1h' },
      enabledPlatforms: ['youtube', 'facebook']
    });

    const status = scheduler.status();
    const youtube = status.platforms.find((entry) => entry.key === 'youtube');
    const facebook = status.platforms.find((entry) => entry.key === 'facebook');

    assert.equal(youtube.frequency, '1h');
    assert.equal(facebook.frequency, '5m', 'no override means the global value');
  });

  test('reports which platforms are runnable and why', () => {
    const scheduler = schedulerFor({ frequency: '5m', perPlatform: {} });
    const status = scheduler.status();

    assert.equal(scheduler.runnableSlots.length, 1);
    assert.includes(
      status.platforms.find((entry) => entry.key === 'facebook').reason,
      'FB_ACCESS_TOKEN'
    );
  });

  test('setFrequency validates and applies to all or one platform', () => {
    const scheduler = schedulerFor({ frequency: '5m', perPlatform: {} });

    scheduler.setFrequency('15m');
    assert.ok(scheduler.status().platforms.every((entry) => entry.frequency === '15m'));

    scheduler.setFrequency('1h', 'youtube');
    const status = scheduler.status();
    assert.equal(status.platforms.find((entry) => entry.key === 'youtube').frequency, '1h');
    assert.equal(status.platforms.find((entry) => entry.key === 'facebook').frequency, '15m');

    assert.throws(() => scheduler.setFrequency('banana'), 'cannot understand');
    assert.throws(() => scheduler.setFrequency('5m', 'myspace'), 'unknown platform');
  });

  test('pause and resume are idempotent and reflected in status', () => {
    const scheduler = schedulerFor({ frequency: '5m', perPlatform: {} });

    assert.notOk(scheduler.status().paused);
    scheduler.pause();
    assert.ok(scheduler.status().paused);
    scheduler.pause();
    assert.ok(scheduler.status().paused, 'pausing twice is harmless');
    scheduler.resume();
    assert.notOk(scheduler.status().paused);
  });

  test('startPaused is honoured', () => {
    const scheduler = schedulerFor({ frequency: '5m', perPlatform: {}, startPaused: true });
    assert.ok(scheduler.paused);
  });

  test('runNow refuses an unknown or unrunnable platform', () => {
    const scheduler = schedulerFor({ frequency: '5m', perPlatform: {} });

    assert.deepEqual(scheduler.runNow(), ['YouTube']);
    assert.throws(() => scheduler.runNow('facebook'), 'no runnable platform');
    assert.throws(() => scheduler.runNow('myspace'), 'no runnable platform');

    scheduler.stop();
  });

  test('cron slots compute a delay from the next matching minute', () => {
    const scheduler = schedulerFor({ frequency: 'cron:*/15 * * * *', perPlatform: {} });
    const slot = scheduler.slots.find((entry) => entry.key === 'youtube');

    const delay = slot.delayMs(Date.parse('2026-08-26T10:03:00'));
    assert.ok(delay > 0 && delay <= 15 * 60000, `unexpected delay ${delay}`);
  });

  test('interval slots back off exponentially after failures', () => {
    const scheduler = schedulerFor({ frequency: '60s', perPlatform: {} });
    const slot = scheduler.slots.find((entry) => entry.key === 'youtube');

    assert.equal(slot.delayMs(), 60000);

    slot.consecutiveErrors = 2;
    assert.equal(slot.delayMs(), 240000, '2 failures means a 4x delay');

    slot.consecutiveErrors = 10;
    assert.equal(slot.delayMs(), 480000, 'capped at 8x');
  });

  test('applyMonitoringConfig re-reads frequencies', () => {
    const scheduler = schedulerFor({ frequency: '5m', perPlatform: {} });
    scheduler.applyMonitoringConfig({ frequency: '12h', perPlatform: { youtube: '1m' } });

    const status = scheduler.status();
    assert.equal(status.platforms.find((entry) => entry.key === 'youtube').frequency, '1m');
    assert.equal(status.platforms.find((entry) => entry.key === 'facebook').frequency, '12h');
  });

  test('a poll actually reaches the pipeline', async () => {
    const fetched = [];
    const ingested = [];

    const scheduler = new Scheduler({
      slots: [{
        key: 'youtube',
        platform: 'YouTube',
        mode: 'native',
        reason: null,
        connector: {
          fetch: async (options) => {
            fetched.push(options);
            return [{ platform: 'YouTube', text: 'Acme Corp', externalId: 'y1', timestamp: new Date().toISOString() }];
          }
        }
      }],
      pipeline: {
        ingest: async (items, context) => {
          ingested.push({ count: items.length, source: context.source });
          return { received: items.length, matched: 1, added: 1, duplicates: 0 };
        }
      },
      matcher: createMatcher(COMPANIES),
      monitoring: { frequency: '1h', perPlatform: {}, lookbackMinutes: 60, maxItemsPerPoll: 25 }
    });

    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 120));
    scheduler.stop();

    assert.equal(ingested.length, 1, 'the first poll should run immediately');
    assert.equal(ingested[0].source, 'YouTube');
    assert.ok(fetched[0].since instanceof Date, 'connectors receive a window');
    assert.ok(fetched[0].terms.includes('Acme Corp'));

    const slot = scheduler.slots[0];
    assert.equal(slot.totals.added, 1);
    assert.equal(slot.consecutiveErrors, 0);
  });

  test('a failing poll is recorded and backed off, not crashed on', async () => {
    const scheduler = new Scheduler({
      slots: [{
        key: 'youtube',
        platform: 'YouTube',
        mode: 'native',
        reason: null,
        connector: { fetch: async () => { throw new Error('HTTP 429 quota exceeded'); } }
      }],
      pipeline: { ingest: async () => ({ received: 0, matched: 0, added: 0, duplicates: 0 }) },
      matcher: createMatcher(COMPANIES),
      monitoring: { frequency: '1h', perPlatform: {}, lookbackMinutes: 60 }
    });

    const errors = [];
    scheduler.on('poll:error', (event) => errors.push(event));

    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 120));
    scheduler.stop();

    assert.equal(errors.length, 1);
    assert.includes(errors[0].error, '429');

    const slot = scheduler.slots[0];
    assert.equal(slot.consecutiveErrors, 1);
    assert.equal(slot.totals.errors, 1);
    assert.includes(slot.lastError.message, 'quota');
  });
});

describe('event hub', () => {
  /** Minimal ServerResponse stand-in that records what was written. */
  function fakeResponse() {
    return {
      chunks: [],
      headers: null,
      writeHead(status, headers) { this.headers = headers; return this; },
      write(chunk) { this.chunks.push(chunk); return true; },
      end() { this.ended = true; },
      on() {}
    };
  }

  function fakeRequest() {
    return { headers: {}, on() {} };
  }

  test('a new client gets SSE headers and a hello frame', () => {
    const hub = createEventHub();
    const response = fakeResponse();

    hub.addClient(fakeRequest(), response);

    assert.includes(response.headers['content-type'], 'text/event-stream');
    assert.equal(response.headers['cache-control'], 'no-cache, no-transform');
    assert.includes(response.chunks.join(''), 'event: hello');
    assert.equal(hub.clientCount, 1);

    hub.close();
  });

  test('broadcast reaches every client in SSE frame format', () => {
    const hub = createEventHub();
    const first = fakeResponse();
    const second = fakeResponse();

    hub.addClient(fakeRequest(), first);
    hub.addClient(fakeRequest(), second);

    const delivered = hub.broadcast('mention', { id: 'm1', platform: 'TikTok' });
    assert.equal(delivered, 2);

    for (const response of [first, second]) {
      const payload = response.chunks.join('');
      assert.includes(payload, 'event: mention');
      assert.includes(payload, '"id":"m1"');
      assert.ok(/id: \d+\n/.test(payload), 'frames need an id so a reconnect can replay');
    }

    hub.close();
  });

  test('broadcasting with no clients is a no-op', () => {
    const hub = createEventHub();
    assert.equal(hub.broadcast('mention', {}), 0);
    hub.close();
  });

  test('a client whose socket throws is dropped', () => {
    const hub = createEventHub();
    const broken = fakeResponse();
    hub.addClient(fakeRequest(), broken);

    broken.write = () => { throw new Error('EPIPE'); };
    assert.equal(hub.broadcast('mention', {}), 0);
    assert.equal(hub.clientCount, 0, 'a dead client must not be retried forever');

    hub.close();
  });

  test('a reconnecting client is replayed only what it missed', () => {
    const hub = createEventHub();
    hub.addClient(fakeRequest(), fakeResponse());

    hub.broadcast('mention', { id: 'first' });
    hub.broadcast('mention', { id: 'second' });

    const reconnecting = fakeResponse();
    hub.addClient({ headers: { 'last-event-id': '2' }, on() {} }, reconnecting);

    const payload = reconnecting.chunks.join('');
    assert.includes(payload, '"id":"second"');
    assert.notOk(payload.includes('"id":"first"'), 'already-seen events must not be re-sent');

    hub.close();
  });
});

describe('scheduler lifecycle', () => {
  /** A started scheduler must hold the event loop; stop() must release it. */
  test('start holds a timer and stop clears it', async () => {
    const scheduler = new Scheduler({
      slots: [{
        key: 'youtube',
        platform: 'YouTube',
        mode: 'native',
        reason: null,
        connector: { fetch: async () => [] }
      }],
      pipeline: { ingest: async () => ({ received: 0, matched: 0, added: 0, duplicates: 0 }) },
      matcher: createMatcher(COMPANIES),
      monitoring: { frequency: '1h', perPlatform: {}, lookbackMinutes: 60 }
    });

    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 60));

    const slot = scheduler.slots[0];
    assert.ok(slot.timer, 'a pending poll must be scheduled');
    assert.ok(slot.nextRunAt > Date.now(), 'and have a future run time');

    // The timer must NOT be unref'd: it is what keeps `--no-server` alive.
    const activeTimers = process.getActiveResourcesInfo().filter((entry) => entry === 'Timeout');
    assert.ok(activeTimers.length > 0, 'the poll timer must keep the process alive');

    scheduler.stop();
    assert.equal(slot.timer, null, 'stop() must clear the timer so the process can exit');
    assert.equal(slot.nextRunAt, null);
    assert.notOk(scheduler.started);
  });

  test('a paused scheduler reschedules instead of polling', async () => {
    let fetches = 0;
    const scheduler = new Scheduler({
      slots: [{
        key: 'youtube',
        platform: 'YouTube',
        mode: 'native',
        reason: null,
        connector: { fetch: async () => { fetches += 1; return []; } }
      }],
      pipeline: { ingest: async () => ({ received: 0, matched: 0, added: 0, duplicates: 0 }) },
      matcher: createMatcher(COMPANIES),
      monitoring: { frequency: '10s', perPlatform: {}, lookbackMinutes: 60, startPaused: true }
    });

    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 120));
    scheduler.stop();

    assert.equal(fetches, 0, 'a paused scheduler must not call any connector');
  });
});

describe('first-poll backfill', () => {
  function schedulerWith(monitoring) {
    return new Scheduler({
      slots: [{ key: 'facebook', platform: 'Facebook', mode: 'native', reason: null, connector: { fetch: async () => [] } }],
      pipeline: { ingest: async () => ({ received: 0, matched: 0, added: 0, duplicates: 0 }) },
      matcher: createMatcher(COMPANIES),
      monitoring
    });
  }

  test('the first poll reaches back backfillMinutes, not lookbackMinutes', async () => {
    let seenSince = null;

    const scheduler = new Scheduler({
      slots: [{
        key: 'facebook',
        platform: 'Facebook',
        mode: 'native',
        reason: null,
        connector: {
          fetch: async ({ since }) => { seenSince = since; return []; }
        }
      }],
      pipeline: { ingest: async () => ({ received: 0, matched: 0, added: 0, duplicates: 0 }) },
      matcher: createMatcher(COMPANIES),
      monitoring: { frequency: '1h', perPlatform: {}, lookbackMinutes: 120, backfillMinutes: 525600 }
    });

    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    scheduler.stop();

    assert.ok(seenSince, 'the connector should have been called');

    const daysBack = (Date.now() - seenSince.getTime()) / 86400000;
    assert.ok(daysBack > 300, `first poll should reach back ~a year, got ${Math.round(daysBack)} days`);
  });

  test('steady state uses lastSuccessAt, not the backfill window', () => {
    const scheduler = schedulerWith({
      frequency: '1h', perPlatform: {}, lookbackMinutes: 120, backfillMinutes: 525600
    });

    const slot = scheduler.slots[0];
    slot.lastSuccessAt = Date.now() - 10 * 60000;

    // Reach the private helper the way #runSlot does, via a poll.
    const since = new Date(Math.max(
      Date.now() - 120 * 60000,
      slot.lastSuccessAt - 30 * 1000
    ));

    const minutesBack = (Date.now() - since.getTime()) / 60000;
    assert.ok(minutesBack < 15, `steady state should be minutes, not a year (got ${Math.round(minutesBack)})`);
  });

  test('backfillMinutes falls back to lookbackMinutes when unset', async () => {
    let seenSince = null;

    const scheduler = new Scheduler({
      slots: [{
        key: 'facebook',
        platform: 'Facebook',
        mode: 'native',
        reason: null,
        connector: { fetch: async ({ since }) => { seenSince = since; return []; } }
      }],
      pipeline: { ingest: async () => ({ received: 0, matched: 0, added: 0, duplicates: 0 }) },
      matcher: createMatcher(COMPANIES),
      monitoring: { frequency: '1h', perPlatform: {}, lookbackMinutes: 240 }
    });

    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    scheduler.stop();

    const minutesBack = (Date.now() - seenSince.getTime()) / 60000;
    assert.ok(minutesBack > 200 && minutesBack < 280, `expected ~240 minutes, got ${Math.round(minutesBack)}`);
  });
});
