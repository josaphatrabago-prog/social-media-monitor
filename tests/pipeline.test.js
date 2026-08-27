/** Pipeline ingestion, notification routing and connector normalisation. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert, describe, test } from './harness.js';
import { createMatcher } from '../src/core/matcher.js';
import { createSentimentAnalyzer } from '../src/core/sentiment.js';
import { createStore } from '../src/core/store.js';
import { createCrisisDetector } from '../src/core/crisis.js';
import { createPipeline, stableId } from '../src/core/pipeline.js';
import { NotificationDispatcher } from '../src/notify/index.js';
import { formatPayload } from '../src/notify/webhook.js';
import { buildCrisisEmail, buildMentionEmail } from '../src/notify/email.js';
import { buildMessage } from '../src/notify/smtp.js';
import { createConnectors } from '../src/platforms/index.js';
import { MockConnector } from '../src/platforms/mock.js';
import { PlatformConnector } from '../src/platforms/base.js';
import { YouTubeConnector } from '../src/platforms/youtube.js';
import { readField } from '../src/platforms/aggregator.js';
import { DEFAULTS, deepMerge } from '../src/config.js';

let counter = 0;

function tempDir() {
  counter += 1;
  const directory = path.join(os.tmpdir(), `smm-pipe-${process.pid}-${counter}`);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function cleanup(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

const COMPANIES = [
  {
    id: 'ritehomes',
    name: 'CEBU RITEHOMES DEVELOPMENT & REALTY CORP.',
    aliases: ['Ritehomes'],
    hashtags: ['#Ritehomes'],
    handles: [],
    exclude: []
  }
];

/** A dispatcher that records calls instead of making network requests. */
function recordingDispatcher() {
  const calls = [];
  return {
    calls,
    dispatch(kind, data) {
      calls.push({ kind, data });
      return Promise.resolve({ event: kind, delivered: [], skipped: [] });
    },
    channelsFor: () => [],
    reconfigure() {}
  };
}

function buildPipeline(directory, { crisisOptions } = {}) {
  const store = createStore({ dataDir: directory }).init();
  const dispatcher = recordingDispatcher();
  const crisis = createCrisisDetector(crisisOptions || { windowMinutes: 15, negativeThreshold: 3, cooldownMinutes: 30 });

  const pipeline = createPipeline({
    matcher: createMatcher(COMPANIES),
    sentiment: createSentimentAnalyzer({}),
    store,
    crisis,
    dispatcher
  });

  return { pipeline, store, dispatcher, crisis };
}

/** A connector-shaped raw item. */
function rawItem(overrides = {}) {
  return {
    platform: 'Facebook',
    externalId: `fb:post:${Math.random().toString(36).slice(2)}`,
    kind: 'post',
    text: 'Great experience with Ritehomes, highly recommend',
    author: { name: 'Test User', handle: 'facebook.com/test' },
    url: 'https://example.invalid/post',
    timestamp: new Date().toISOString(),
    metrics: {},
    parent: null,
    ...overrides
  };
}

describe('pipeline', () => {
  test('normalise drops items that mention no monitored company', () => {
    const directory = tempDir();
    try {
      const { pipeline } = buildPipeline(directory);
      assert.equal(pipeline.normalise(rawItem({ text: 'Nice weather in Cebu' })), null);
      assert.equal(pipeline.normalise(rawItem({ text: '   ' })), null);
    } finally {
      cleanup(directory);
    }
  });

  test('normalise produces a fully scored mention', () => {
    const directory = tempDir();
    try {
      const { pipeline } = buildPipeline(directory);
      const mention = pipeline.normalise(rawItem());

      assert.ok(mention.id, 'needs a stable id');
      assert.equal(mention.platform, 'Facebook');
      assert.equal(mention.sentiment, 'positive');
      assert.equal(mention.companies[0].companyId, 'ritehomes');
      assert.includes(mention.matchedTerms, 'Ritehomes');
      assert.ok(mention.highlights.length > 0);
      assert.ok(mention.sentimentTerms.length > 0, 'should explain the score');
      assert.notOk(mention.matchedViaParent);
    } finally {
      cleanup(directory);
    }
  });

  test('a comment can match through its parent post', () => {
    const directory = tempDir();
    try {
      const { pipeline } = buildPipeline(directory);
      const mention = pipeline.normalise(rawItem({
        kind: 'comment',
        text: 'Same problem here, still waiting',
        parent: { id: 'p1', title: 'Ritehomes turnover update', url: 'https://example.invalid/p1' }
      }));

      assert.ok(mention, 'should be kept');
      assert.ok(mention.matchedViaParent, 'and flagged as weaker evidence');
      assert.deepEqual(mention.highlights, [], 'no highlight, since the text itself has no match');
    } finally {
      cleanup(directory);
    }
  });

  test('stableId is deterministic and distinguishes items', () => {
    const item = rawItem({ externalId: 'fb:post:123' });
    assert.equal(stableId(item), stableId({ ...item, text: 'different text' }));
    assert.notOk(stableId(item) === stableId({ ...item, externalId: 'fb:post:456' }));
  });

  test('stableId falls back to content when there is no external id', () => {
    const withoutId = { platform: 'X', author: { handle: '@a' }, text: 'hello' };
    assert.equal(stableId(withoutId), stableId({ ...withoutId }));
    assert.notOk(stableId(withoutId) === stableId({ ...withoutId, text: 'other' }));
  });

  test('ingest stores matches, counts duplicates and notifies once each', async () => {
    const directory = tempDir();
    try {
      const { pipeline, store, dispatcher } = buildPipeline(directory);
      const shared = rawItem({ externalId: 'fb:post:dupe' });

      const summary = await pipeline.ingest([
        shared,
        shared,
        rawItem({ text: 'Nothing relevant here' }),
        rawItem({ externalId: 'fb:post:other', text: 'Ritehomes is fine' })
      ], { source: 'Facebook' });

      assert.equal(summary.received, 4);
      assert.equal(summary.matched, 3, 'the duplicate still matches');
      assert.equal(summary.added, 2);
      assert.equal(summary.duplicates, 1);
      assert.equal(store.mentions.length, 2);

      const mentionCalls = dispatcher.calls.filter((call) => call.kind === 'mention');
      assert.equal(mentionCalls.length, 2, 'a duplicate must never alert twice');
    } finally {
      cleanup(directory);
    }
  });

  test('re-ingesting the same batch notifies nobody', async () => {
    const directory = tempDir();
    try {
      const { pipeline, dispatcher } = buildPipeline(directory);
      const batch = [rawItem({ externalId: 'fb:post:a' }), rawItem({ externalId: 'fb:post:b' })];

      await pipeline.ingest(batch, { source: 'Facebook' });
      dispatcher.calls.length = 0;

      const second = await pipeline.ingest(batch, { source: 'Facebook' });
      assert.equal(second.added, 0);
      assert.equal(dispatcher.calls.length, 0, 'the next poll must be silent');
    } finally {
      cleanup(directory);
    }
  });

  test('ingest fires a crisis once the window fills', async () => {
    const directory = tempDir();
    try {
      const { pipeline, dispatcher } = buildPipeline(directory);

      const negatives = Array.from({ length: 4 }, (_, index) => rawItem({
        externalId: `fb:post:neg${index}`,
        text: 'Ritehomes delayed turnover again, do not recommend'
      }));

      const summary = await pipeline.ingest(negatives, { source: 'Facebook' });

      assert.equal(summary.added, 4);
      assert.ok(summary.crisis, 'threshold of 3 should have fired');
      assert.equal(summary.crisis.negativeCount, 4);

      const crisisCalls = dispatcher.calls.filter((call) => call.kind === 'crisis');
      assert.equal(crisisCalls.length, 1, 'one crisis alert per batch, not one per mention');
    } finally {
      cleanup(directory);
    }
  });

  test('emits mention and ingest events', async () => {
    const directory = tempDir();
    try {
      const { pipeline } = buildPipeline(directory);
      const mentions = [];
      let summary = null;

      pipeline.on('mention', (mention) => mentions.push(mention));
      pipeline.on('ingest', (result) => { summary = result; });

      await pipeline.ingest([rawItem(), rawItem()], { source: 'Facebook' });

      assert.equal(mentions.length, 2);
      assert.equal(summary.source, 'Facebook');
    } finally {
      cleanup(directory);
    }
  });

  test('an empty poll is a no-op that does not evaluate a crisis', async () => {
    const directory = tempDir();
    try {
      const { pipeline, dispatcher } = buildPipeline(directory);
      const summary = await pipeline.ingest([], { source: 'YouTube' });

      assert.equal(summary.added, 0);
      assert.equal(summary.crisis, null);
      assert.equal(dispatcher.calls.length, 0);
    } finally {
      cleanup(directory);
    }
  });

  test('reconfigure swaps the analyser without recreating the pipeline', async () => {
    const directory = tempDir();
    try {
      const { pipeline } = buildPipeline(directory);

      const before = pipeline.normalise(rawItem({ text: 'Ritehomes is nice' }));
      assert.equal(before.sentiment, 'positive');

      pipeline.reconfigure({
        sentiment: createSentimentAnalyzer({ positiveThreshold: 10, negativeThreshold: -10 })
      });

      const after = pipeline.normalise(rawItem({ text: 'Ritehomes is nice' }));
      assert.equal(after.sentiment, 'neutral', 'the stricter threshold should apply');
    } finally {
      cleanup(directory);
    }
  });
});

describe('notification dispatcher', () => {
  /** Config with one desktop channel plus a URL-less webhook. */
  function dispatcherConfig(overrides = {}) {
    return deepMerge(DEFAULTS, deepMerge({
      notifications: {
        rateLimit: { maxPerMinute: 100 },
        desktop: { enabled: true, events: ['mention.negative', 'crisis'] },
        webhooks: [{ name: 'Ops', type: 'slack', url: '', enabled: true, events: ['mention.any'] }],
        email: { enabled: false, events: ['crisis'], to: [], smtp: { host: '' } }
      }
    }, overrides));
  }

  function sampleMention(sentiment = 'negative') {
    return {
      id: `m-${sentiment}`,
      platform: 'Facebook',
      kind: 'post',
      text: 'test mention text',
      author: { name: 'A' },
      url: '',
      timestamp: new Date().toISOString(),
      sentiment,
      sentimentScore: -0.5,
      companies: [{ companyId: 'c', companyName: 'C' }],
      matchedTerms: ['C']
    };
  }

  test('routes only to channels subscribed to the event', async () => {
    const pushed = [];
    const dispatcher = new NotificationDispatcher({
      config: dispatcherConfig(),
      onDesktop: (payload) => pushed.push(payload)
    });

    await dispatcher.dispatch('mention', sampleMention('negative'));
    assert.equal(pushed.length, 1, 'desktop wants mention.negative');

    pushed.length = 0;
    await dispatcher.dispatch('mention', sampleMention('positive'));
    assert.equal(pushed.length, 0, 'desktop should ignore a positive mention');
  });

  test('mention.any subscribers receive every sentiment', () => {
    const dispatcher = new NotificationDispatcher({ config: dispatcherConfig() });

    for (const sentiment of ['positive', 'neutral', 'negative']) {
      const channels = dispatcher.channelsFor(['mention.any', `mention.${sentiment}`]);
      assert.ok(channels.some((channel) => channel.name === 'Ops'), `Ops should match ${sentiment}`);
    }
  });

  test('reports an unconfigured channel as skipped rather than failing', async () => {
    const dispatcher = new NotificationDispatcher({ config: dispatcherConfig() });
    const result = await dispatcher.dispatch('mention', sampleMention('negative'));

    assert.equal(result.skipped.length, 1);
    assert.includes(result.skipped[0].reason, 'no URL');
  });

  test('rate limits ordinary mentions', async () => {
    const dispatcher = new NotificationDispatcher({
      config: dispatcherConfig({ notifications: { rateLimit: { maxPerMinute: 2 } } }),
      onDesktop: () => {}
    });

    const results = [];
    for (let index = 0; index < 5; index += 1) {
      results.push(await dispatcher.dispatch('mention', sampleMention('negative')));
    }

    const limited = results.filter((result) =>
      result.skipped.some((entry) => entry.reason === 'rate limited'));

    assert.equal(limited.length, 3, 'only the first two should get through');
  });

  test('a crisis is never rate limited', async () => {
    const pushed = [];
    const dispatcher = new NotificationDispatcher({
      config: dispatcherConfig({ notifications: { rateLimit: { maxPerMinute: 1 } } }),
      onDesktop: (payload) => pushed.push(payload)
    });

    // Burn the budget on a normal mention first.
    await dispatcher.dispatch('mention', sampleMention('negative'));
    pushed.length = 0;

    await dispatcher.dispatch('crisis', {
      severity: 'high', negativeCount: 9, windowMinutes: 15, threshold: 5,
      companies: [{ companyName: 'C' }], platforms: [], samples: [], rules: ['absolute']
    });

    assert.equal(pushed.length, 1, 'the crisis must still get through');
  });

  test('records a delivery entry for the audit log', async () => {
    const records = [];
    const dispatcher = new NotificationDispatcher({
      config: dispatcherConfig(),
      onDesktop: () => {},
      onDelivery: (record) => records.push(record)
    });

    await dispatcher.dispatch('mention', sampleMention('negative'));

    assert.equal(records.length, 1);
    assert.equal(records[0].event, 'mention.negative');
    assert.includes(records[0].delivered, 'Browser push');
  });

  test('desktop payloads mark a crisis as requiring interaction', () => {
    const dispatcher = new NotificationDispatcher({ config: dispatcherConfig() });

    const crisis = dispatcher.buildDesktopPayload('crisis', {
      negativeCount: 9, windowMinutes: 15, threshold: 5, severity: 'high',
      companies: [{ companyName: 'C' }]
    });
    assert.ok(crisis.requireInteraction);
    assert.equal(crisis.tag, 'crisis');

    const positive = dispatcher.buildDesktopPayload('mention', sampleMention('positive'));
    assert.notOk(positive.requireInteraction);
  });

  test('reconfigure picks up a new rate limit', async () => {
    const dispatcher = new NotificationDispatcher({
      config: dispatcherConfig(),
      onDesktop: () => {}
    });

    dispatcher.reconfigure(dispatcherConfig({ notifications: { rateLimit: { maxPerMinute: 1 } } }));

    await dispatcher.dispatch('mention', sampleMention('negative'));
    const second = await dispatcher.dispatch('mention', sampleMention('negative'));

    assert.ok(second.skipped.some((entry) => entry.reason === 'rate limited'));
  });
});

describe('webhook payloads', () => {
  const mention = {
    id: 'm1',
    platform: 'TikTok',
    kind: 'video',
    text: 'Ritehomes delayed turnover',
    author: { name: 'Jane', handle: '@jane', url: 'https://example.invalid/jane' },
    url: 'https://example.invalid/v/1',
    timestamp: '2026-08-26T01:00:00.000Z',
    sentiment: 'negative',
    sentimentScore: -0.6,
    companies: [{ companyId: 'r', companyName: 'Ritehomes' }],
    matchedTerms: ['Ritehomes']
  };

  const crisis = {
    severity: 'critical',
    triggeredAt: '2026-08-26T01:05:00.000Z',
    negativeCount: 12,
    windowMinutes: 15,
    threshold: 5,
    baseline: 1.2,
    rules: ['absolute', 'relative'],
    escalated: true,
    companies: [{ companyId: 'r', companyName: 'Ritehomes', count: 12 }],
    platforms: [{ platform: 'TikTok', count: 12 }],
    samples: [{ platform: 'TikTok', author: 'Jane', text: 'worst experience', url: 'https://example.invalid/v/1', sentimentScore: -0.9 }]
  };

  test('slack payloads carry a coloured attachment', () => {
    const payload = formatPayload('slack', 'mention', mention);
    assert.equal(payload.attachments[0].color, '#f43f5e');
    assert.includes(payload.attachments[0].text, 'Ritehomes delayed turnover');
    assert.equal(typeof payload.attachments[0].ts, 'number');
  });

  test('discord payloads use an integer colour', () => {
    const payload = formatPayload('discord', 'mention', mention);
    assert.equal(typeof payload.embeds[0].color, 'number');
    assert.equal(payload.embeds[0].url, mention.url);
  });

  test('teams payloads are MessageCards with an action', () => {
    const payload = formatPayload('teams', 'mention', mention);
    assert.equal(payload['@type'], 'MessageCard');
    assert.notOk(payload.themeColor.startsWith('#'), 'Teams wants the hex without a hash');
    assert.equal(payload.potentialAction[0]['@type'], 'OpenUri');
  });

  test('generic payloads wrap the raw record', () => {
    const payload = formatPayload('generic', 'mention', mention);
    assert.equal(payload.event, 'mention');
    assert.equal(payload.data.id, 'm1');
  });

  test('crisis payloads include counts, rules and samples for every provider', () => {
    for (const type of ['slack', 'discord', 'teams', 'generic']) {
      const serialised = JSON.stringify(formatPayload(type, 'crisis', crisis));
      assert.includes(serialised, '12', `${type} should report the count`);
      assert.includes(serialised, 'Ritehomes', `${type} should name the brand`);
    }
  });

  test('an unknown provider falls back to generic instead of throwing', () => {
    const payload = formatPayload('carrier-pigeon', 'mention', mention);
    assert.equal(payload.event, 'mention');
  });
});

describe('email and smtp', () => {
  const mention = {
    id: 'm1',
    platform: 'Facebook',
    kind: 'post',
    text: 'Ritehomes <script>alert(1)</script> complaint',
    author: { name: 'Jane & Co', handle: '@jane' },
    url: 'https://example.invalid/p/1',
    timestamp: '2026-08-26T01:00:00.000Z',
    sentiment: 'negative',
    sentimentScore: -0.6,
    companies: [{ companyName: 'Ritehomes' }],
    matchedTerms: ['Ritehomes']
  };

  test('mention emails escape HTML from post text', () => {
    const { subject, html } = buildMentionEmail(mention);
    assert.includes(subject, 'NEGATIVE');
    assert.notOk(html.includes('<script>'), 'raw markup must not survive into the email');
    assert.includes(html, '&lt;script&gt;');
    assert.includes(html, 'Jane &amp; Co');
  });

  test('crisis emails summarise the incident', () => {
    const { subject, html } = buildCrisisEmail({
      severity: 'high', triggeredAt: '2026-08-26T01:05:00.000Z',
      negativeCount: 9, windowMinutes: 15, threshold: 5, baseline: 1,
      rules: ['absolute'], escalated: false,
      companies: [{ companyName: 'Ritehomes', count: 9 }],
      platforms: [{ platform: 'Facebook', count: 9 }],
      samples: [{ platform: 'Facebook', author: 'Jane', text: 'bad', url: '', sentimentScore: -0.9 }]
    });

    assert.includes(subject, '9 negative mentions');
    assert.includes(html, 'Ritehomes');
    assert.includes(html, 'Recent baseline');
  });

  test('smtp messages are well-formed multipart with base64 parts', () => {
    const message = buildMessage({
      from: 'alerts@example.com',
      recipients: ['ops@example.com', 'boss@example.com'],
      subject: 'Krisis: 6 mensahe',
      html: '<b>hello</b>'
    });

    assert.includes(message, 'To: ops@example.com, boss@example.com');
    assert.includes(message, 'Content-Type: multipart/alternative; boundary=');
    assert.includes(message, 'Content-Transfer-Encoding: base64');
    assert.includes(message, 'MIME-Version: 1.0');
    assert.ok(message.includes('\r\n'), 'headers must use CRLF');

    // Both alternatives must be present, and the HTML must survive encoding.
    const parts = message.split('Content-Type: text/');
    assert.equal(parts.length, 3, 'a plain-text and an HTML part');
    assert.includes(Buffer.from(parts[2].split('\r\n\r\n')[1].trim(), 'base64').toString('utf8'), '<b>hello</b>');
  });

  test('non-ASCII subjects are RFC 2047 encoded', () => {
    const message = buildMessage({
      from: 'a@b.c', recipients: ['x@y.z'], subject: 'Krisis ⚠', html: 'x'
    });
    assert.includes(message, '=?UTF-8?B?');
  });
});

describe('connectors', () => {
  test('mock mode is chosen when no credentials exist', () => {
    const config = deepMerge(DEFAULTS, {
      companies: COMPANIES,
      monitoring: { mockMode: 'auto', enabledPlatforms: ['facebook', 'youtube'] },
      platforms: {}
    });

    const { slots, mockMode } = createConnectors({ config, matcher: createMatcher(COMPANIES) });
    assert.ok(mockMode);
    assert.equal(slots.length, 2);
    assert.ok(slots.every((slot) => slot.mode === 'mock'));
  });

  test('a configured platform runs natively while the rest are skipped', () => {
    const config = deepMerge(DEFAULTS, {
      companies: COMPANIES,
      monitoring: { mockMode: 'auto', enabledPlatforms: ['facebook', 'youtube'] },
      platforms: { youtube: { apiKey: 'test-key', includeComments: false } }
    });

    const { slots, mockMode } = createConnectors({ config, matcher: createMatcher(COMPANIES) });
    assert.notOk(mockMode, 'one real credential should disable mock mode');

    const youtube = slots.find((slot) => slot.key === 'youtube');
    const facebook = slots.find((slot) => slot.key === 'facebook');

    assert.equal(youtube.mode, 'native');
    assert.equal(facebook.mode, 'skipped');
    assert.includes(facebook.reason, 'FB_ACCESS_TOKEN');
    assert.equal(facebook.connector, null);
  });

  test('mockMode "off" never substitutes synthetic data', () => {
    const config = deepMerge(DEFAULTS, {
      companies: COMPANIES,
      monitoring: { mockMode: 'off', enabledPlatforms: ['tiktok'] },
      platforms: {}
    });

    const { slots, mockMode } = createConnectors({ config, matcher: createMatcher(COMPANIES) });
    assert.notOk(mockMode);
    assert.equal(slots[0].mode, 'skipped');
  });

  test('connectors report exactly which credentials are missing', () => {
    const youtube = new YouTubeConnector({ settings: {}, monitoring: {}, matcher: createMatcher(COMPANIES) });
    assert.notOk(youtube.isConfigured);
    assert.deepEqual(youtube.missingCredentials(), ['YOUTUBE_API_KEY']);
    assert.includes(youtube.statusReason, 'YOUTUBE_API_KEY');

    const ready = new YouTubeConnector({ settings: { apiKey: 'k' }, monitoring: {}, matcher: createMatcher(COMPANIES) });
    assert.ok(ready.isConfigured);
    assert.equal(ready.statusReason, null);
  });

  test('cleanText strips HTML entities that comment APIs return', () => {
    const connector = new YouTubeConnector({ settings: { apiKey: 'k' }, monitoring: {}, matcher: createMatcher(COMPANIES) });
    assert.equal(connector.cleanText('a &amp; b<br>c  &quot;d&quot;'), 'a & b c "d"');
  });

  test('toIso normalises the offset format Facebook returns', () => {
    const connector = new YouTubeConnector({ settings: { apiKey: 'k' }, monitoring: {}, matcher: createMatcher(COMPANIES) });
    assert.equal(connector.toIso('2026-08-26T09:00:00+0000'), '2026-08-26T09:00:00.000Z');
    assert.ok(connector.toIso('not a date'), 'unparseable input falls back to now');
  });

  test('applyWindow drops items older than since and caps the batch', () => {
    const connector = new YouTubeConnector({ settings: { apiKey: 'k' }, monitoring: {}, matcher: createMatcher(COMPANIES) });
    const now = Date.now();

    const items = [
      { timestamp: new Date(now - 1000).toISOString() },
      { timestamp: new Date(now - 60 * 60000).toISOString() },
      { timestamp: new Date(now - 2000).toISOString() }
    ];

    const windowed = connector.applyWindow(items, { since: new Date(now - 10 * 60000), limit: 5 });
    assert.equal(windowed.length, 2, 'the hour-old item is outside the window');
    assert.ok(windowed[0].timestamp > windowed[1].timestamp, 'newest first');

    assert.equal(connector.applyWindow(items, { since: null, limit: 1 }).length, 1);
  });

  test('mock connector generates matching, well-formed items', async () => {
    const mock = new MockConnector({
      settings: {}, monitoring: {}, matcher: createMatcher(COMPANIES), itemsPerPoll: 5
    });

    const items = await mock.fetch({ limit: 5 });
    assert.equal(items.length, 5);

    const matcher = createMatcher(COMPANIES);
    for (const item of items) {
      assert.ok(item.externalId, 'needs an id');
      assert.ok(item.text, 'needs text');
      assert.ok(item.isMock, 'must be flagged as synthetic');
      assert.ok(matcher.match(item.text).matched, `generated text should mention a brand: ${item.text}`);
      assert.ok(item.url.includes('example.invalid'), 'demo links must not look real');
    }
  });

  test('mock connector honours forcePlatform', async () => {
    const mock = new MockConnector({
      settings: {}, monitoring: {}, matcher: createMatcher(COMPANIES),
      itemsPerPoll: 6, forcePlatform: 'TikTok'
    });

    const items = await mock.fetch({ limit: 6 });
    assert.ok(items.every((item) => item.platform === 'TikTok'));
  });

  test('queueCrisis produces a burst of negatives', async () => {
    const matcher = createMatcher(COMPANIES);
    const analyzer = createSentimentAnalyzer({});
    const mock = new MockConnector({ settings: {}, monitoring: {}, matcher, itemsPerPoll: 2 });

    mock.queueCrisis(7);
    const items = await mock.fetch({ limit: 20 });

    assert.equal(items.length, 7);
    const negatives = items.filter((item) => analyzer.analyze(item.text).label === 'negative');
    assert.equal(negatives.length, 7, 'every queued item should score negative');
  });

  test('mock ids are unique across polls', async () => {
    const mock = new MockConnector({
      settings: {}, monitoring: {}, matcher: createMatcher(COMPANIES), itemsPerPoll: 10
    });

    const first = await mock.fetch({ limit: 10 });
    const second = await mock.fetch({ limit: 10 });
    const ids = new Set([...first, ...second].map((item) => item.externalId));

    assert.equal(ids.size, 20, 'a repeated poll must not collide with the previous one');
  });

  test('aggregator readField uses the map first, then common fallbacks', () => {
    const item = { postId: 'p1', user: { name: 'Jane' }, text: 'hello', likesCount: 4 };

    assert.equal(readField(item, { id: 'postId' }, 'id'), 'p1');
    assert.equal(readField(item, {}, 'authorName'), 'Jane', 'falls back to user.name');
    assert.equal(readField(item, {}, 'likes'), 4);
    assert.equal(readField(item, {}, 'views'), undefined, 'absent fields stay undefined');
  });
});

describe('a wholly failed poll must not look healthy', () => {
  /** A connector stub whose sub-requests all fail, as an expired token would. */
  class AllFailingConnector extends PlatformConnector {
    static platform = 'Test';
    static key = 'test';

    async fetchWithGuard(items) {
      return this.mapLimited(items, 2, async () => {
        throw new Error('HTTP 400 Bad Request');
      }, { throwIfAllFail: true });
    }

    async fetchWithoutGuard(items) {
      return this.mapLimited(items, 2, async () => {
        throw new Error('HTTP 400 Bad Request');
      });
    }

    async fetchPartial(items) {
      let first = true;
      return this.mapLimited(items, 1, async (item) => {
        if (first) { first = false; return [{ ok: item }]; }
        throw new Error('HTTP 400 Bad Request');
      }, { throwIfAllFail: true });
    }
  }

  const connector = new AllFailingConnector({ settings: {}, monitoring: {}, matcher: null });

  test('throws when every source fails', async () => {
    await assert.rejects(
      connector.fetchWithGuard(['a', 'b', 'c']),
      'all 3 source(s) failed',
      'a totally broken platform must surface as an error'
    );
  });

  test('stays quiet without the guard, for optional extras', async () => {
    const result = await connector.fetchWithoutGuard(['a', 'b']);
    assert.deepEqual(result, [], 'comments being disabled is not a poll failure');
  });

  test('partial success is still success', async () => {
    const result = await connector.fetchPartial(['a', 'b', 'c']);
    assert.equal(result.length, 1, 'one good source is enough to keep the poll');
  });

  test('no sources at all is not a failure', async () => {
    assert.deepEqual(await connector.fetchWithGuard([]), []);
  });
});
