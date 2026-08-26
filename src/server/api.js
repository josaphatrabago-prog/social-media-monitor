/**
 * JSON API.
 *
 * Every route is a function of (context, request-ish) returning plain data, so
 * the routes stay testable without a live socket. The HTTP layer handles
 * serialisation, status codes and auth.
 */
import { toCsv } from '../util/csv.js';
import { recentLogs } from '../log.js';
import { FREQUENCY_PRESETS, parseFrequency } from '../util/frequency.js';

const EXPORT_COLUMNS = [
  { key: 'id', label: 'ID' },
  { key: 'timestamp', label: 'Timestamp' },
  { key: 'platform', label: 'Platform' },
  { key: 'kind', label: 'Type' },
  { key: 'companies', label: 'Companies' },
  { key: 'matchedTerms', label: 'Matched Terms' },
  { key: 'sentiment', label: 'Sentiment' },
  { key: 'sentimentScore', label: 'Sentiment Score' },
  { key: 'authorName', label: 'Author' },
  { key: 'authorHandle', label: 'Author Handle' },
  { key: 'text', label: 'Text' },
  { key: 'url', label: 'URL' },
  { key: 'likes', label: 'Likes' },
  { key: 'comments', label: 'Comments' },
  { key: 'shares', label: 'Shares' },
  { key: 'views', label: 'Views' }
];

/** Flattens a mention into one CSV row. */
function toExportRow(mention) {
  return {
    id: mention.id,
    timestamp: mention.timestamp,
    platform: mention.platform,
    kind: mention.kind,
    companies: (mention.companies || []).map((entry) => entry.companyName).join('; '),
    matchedTerms: (mention.matchedTerms || []).join('; '),
    sentiment: mention.sentiment,
    sentimentScore: mention.sentimentScore,
    authorName: mention.author?.name || '',
    authorHandle: mention.author?.handle || '',
    text: mention.text,
    url: mention.url || '',
    likes: mention.metrics?.likes ?? '',
    comments: mention.metrics?.comments ?? '',
    shares: mention.metrics?.shares ?? '',
    views: mention.metrics?.views ?? ''
  };
}

/** Query-string values arrive as strings; normalise the ones we treat as numbers. */
function readNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function filtersFrom(query) {
  return {
    platform: query.get('platform') || undefined,
    company: query.get('company') || undefined,
    sentiment: query.get('sentiment') || undefined,
    search: query.get('search') || undefined,
    since: query.get('since') || undefined,
    until: query.get('until') || undefined
  };
}

export function createApi(context) {
  const { configStore, store, scheduler, crisis, dispatcher, hub, connectors, rebuild } = context;

  return {
    /* ------------------------------------------------------------- reading */

    'GET /api/health': () => ({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      version: context.version
    }),

    'GET /api/status': () => {
      const config = configStore.get();

      return {
        scheduler: scheduler.status(),
        crisis: crisis.status(store),
        counts: {
          mentions: store.mentions.length,
          alerts: store.alerts.length,
          sseClients: hub.clientCount
        },
        mockMode: connectors.mockMode,
        companies: config.companies.map((company) => ({
          id: company.id,
          name: company.name,
          termCount: 1 + (company.aliases?.length || 0) +
            (company.hashtags?.length || 0) + (company.handles?.length || 0)
        })),
        channels: {
          mention: dispatcher.channelsFor(['mention.any', 'mention.negative'])
            .map(({ kind, name, ready, reason }) => ({ kind, name, ready, reason })),
          crisis: dispatcher.channelsFor(['crisis'])
            .map(({ kind, name, ready, reason }) => ({ kind, name, ready, reason }))
        },
        warnings: configStore.warnings,
        frequencyPresets: Object.entries(FREQUENCY_PRESETS)
          .map(([key, seconds]) => ({ key, seconds }))
      };
    },

    'GET /api/mentions': ({ query }) => store.query({
      ...filtersFrom(query),
      limit: Math.min(500, readNumber(query.get('limit'), 100)),
      offset: Math.max(0, readNumber(query.get('offset'), 0)),
      order: query.get('order') === 'asc' ? 'asc' : 'desc'
    }),

    'GET /api/stats': ({ query }) => store.stats(filtersFrom(query)),

    'GET /api/timeline': ({ query }) => store.timeline({
      bucketMinutes: Math.max(1, readNumber(query.get('bucketMinutes'), 15)),
      buckets: Math.min(200, Math.max(2, readNumber(query.get('buckets'), 24)))
    }),

    'GET /api/alerts': ({ query }) => ({
      alerts: store.recentAlerts(Math.min(100, readNumber(query.get('limit'), 20)))
    }),

    'GET /api/logs': ({ query }) => ({
      logs: recentLogs(Math.min(300, readNumber(query.get('limit'), 100)))
    }),

    'GET /api/config': () => ({
      config: configStore.redacted(),
      warnings: configStore.warnings
    }),

    /* ------------------------------------------------------------ exporting */

    'GET /api/export': ({ query }) => {
      const format = (query.get('format') || 'json').toLowerCase();
      const { items } = store.query({
        ...filtersFrom(query),
        limit: Number.MAX_SAFE_INTEGER,
        offset: 0
      });

      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

      if (format === 'csv') {
        return {
          raw: {
            contentType: 'text/csv; charset=utf-8',
            filename: `mentions-${stamp}.csv`,
            body: toCsv(items.map(toExportRow), EXPORT_COLUMNS)
          }
        };
      }

      return {
        raw: {
          contentType: 'application/json; charset=utf-8',
          filename: `mentions-${stamp}.json`,
          body: JSON.stringify({
            exportedAt: new Date().toISOString(),
            filters: filtersFrom(query),
            count: items.length,
            stats: store.stats(filtersFrom(query)),
            mentions: items
          }, null, 2)
        }
      };
    },

    /* ------------------------------------------------------------- control */

    'POST /api/control/pause': () => ({ scheduler: scheduler.pause() }),

    'POST /api/control/resume': () => ({ scheduler: scheduler.resume() }),

    'POST /api/control/poll': ({ body }) => ({
      polling: scheduler.runNow(body?.platform || undefined)
    }),

    'POST /api/control/frequency': ({ body }) => {
      if (!body?.frequency) {
        const error = new Error('body.frequency is required');
        error.statusCode = 400;
        throw error;
      }

      // Validate before touching anything, so a typo cannot stop the monitor.
      parseFrequency(body.frequency);

      const patch = body.platform
        ? { monitoring: { perPlatform: { [body.platform]: body.frequency } } }
        : { monitoring: { frequency: body.frequency } };

      configStore.update(patch);
      if (body.persist) configStore.save();

      scheduler.applyMonitoringConfig(configStore.get().monitoring);

      return {
        applied: body.platform || 'all platforms',
        frequency: body.frequency,
        persisted: Boolean(body.persist),
        scheduler: scheduler.status()
      };
    },

    'PATCH /api/config': ({ body }) => {
      if (!body || typeof body !== 'object') {
        const error = new Error('a JSON object body is required');
        error.statusCode = 400;
        throw error;
      }

      const { persist, ...patch } = body;
      configStore.update(patch);
      if (persist) configStore.save();

      // Rebuild whatever the patch touched.
      const updated = rebuild(patch);

      return {
        ok: true,
        persisted: Boolean(persist),
        rebuilt: updated,
        config: configStore.redacted(),
        warnings: configStore.warnings
      };
    },

    'POST /api/notify/test': async ({ body }) => {
      const kind = body?.kind === 'crisis' ? 'crisis' : 'mention';
      const result = await dispatcher.test(kind);
      return { kind, ...result };
    },

    'POST /api/crisis/acknowledge': () => {
      crisis.reset();
      return { acknowledged: true, crisis: crisis.status(store) };
    },

    'POST /api/simulate/crisis': ({ body }) => {
      if (!connectors.mock) {
        const error = new Error('crisis simulation is only available in mock mode');
        error.statusCode = 409;
        throw error;
      }

      const count = Math.min(50, Math.max(1, readNumber(body?.count, 6)));
      connectors.mock.queueCrisis(count);
      scheduler.runNow();

      return { queued: count, note: 'synthetic negative mentions will arrive on the next poll' };
    },

    'DELETE /api/mentions': () => {
      const removed = store.clear();
      crisis.reset();
      hub.broadcast('cleared', { removed });
      return { removed };
    }
  };
}

export { EXPORT_COLUMNS, toExportRow };
