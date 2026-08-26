/** Store persistence and querying, plus crisis-window detection. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert, describe, test } from './harness.js';
import { createStore } from '../src/core/store.js';
import { createCrisisDetector } from '../src/core/crisis.js';

let directoryCounter = 0;

/** A throwaway data directory per test, cleaned up by the caller. */
function tempDir() {
  directoryCounter += 1;
  const directory = path.join(
    os.tmpdir(),
    `smm-test-${process.pid}-${directoryCounter}`
  );
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function cleanup(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

/**
 * @param {number} minutesAgo
 */
function mention(id, { minutesAgo = 0, sentiment = 'neutral', platform = 'Facebook', company = 'acme', now = Date.now() } = {}) {
  return {
    id,
    timestamp: new Date(now - minutesAgo * 60000).toISOString(),
    platform,
    kind: 'post',
    text: `sample ${sentiment} text about ${company}`,
    author: { name: `User ${id}`, handle: `@user${id}` },
    url: `https://example.invalid/${id}`,
    sentiment,
    sentimentScore: sentiment === 'negative' ? -0.6 : (sentiment === 'positive' ? 0.5 : 0),
    companies: [{ companyId: company, companyName: company.toUpperCase() }],
    matchedTerms: [company],
    metrics: {}
  };
}

describe('store', () => {
  test('rejects duplicates by id', () => {
    const directory = tempDir();
    try {
      const store = createStore({ dataDir: directory }).init();

      assert.ok(store.add(mention('a')).added);
      const second = store.add(mention('a'));
      assert.notOk(second.added);
      assert.equal(second.reason, 'duplicate');
      assert.equal(store.mentions.length, 1);
    } finally {
      cleanup(directory);
    }
  });

  test('addMany reports counts and returns only accepted rows', () => {
    const directory = tempDir();
    try {
      const store = createStore({ dataDir: directory }).init();
      const result = store.addMany([mention('a'), mention('b'), mention('a')]);

      assert.equal(result.added, 2);
      assert.equal(result.duplicates, 1);
      assert.equal(result.mentions.length, 2);
    } finally {
      cleanup(directory);
    }
  });

  test('survives a restart with history and de-duplication intact', () => {
    const directory = tempDir();
    try {
      const first = createStore({ dataDir: directory }).init();
      first.addMany([mention('a'), mention('b'), mention('c')]);

      const second = createStore({ dataDir: directory }).init();
      assert.equal(second.mentions.length, 3, 'history should reload from disk');
      assert.notOk(second.add(mention('b')).added, 'de-duplication should survive');
    } finally {
      cleanup(directory);
    }
  });

  test('keeps mentions newest first regardless of insertion order', () => {
    const directory = tempDir();
    try {
      const store = createStore({ dataDir: directory }).init();
      store.add(mention('old', { minutesAgo: 60 }));
      store.add(mention('new', { minutesAgo: 1 }));
      store.add(mention('middle', { minutesAgo: 30 }));

      assert.deepEqual(store.mentions.map((entry) => entry.id), ['new', 'middle', 'old']);
    } finally {
      cleanup(directory);
    }
  });

  test('skips unreadable JSONL lines instead of failing to start', () => {
    const directory = tempDir();
    try {
      const file = path.join(directory, 'mentions.jsonl');
      fs.writeFileSync(
        file,
        `${JSON.stringify(mention('good'))}\n{ this is not json\n\n${JSON.stringify(mention('good2'))}\n`
      );

      const store = createStore({ dataDir: directory }).init();
      assert.equal(store.mentions.length, 2);
    } finally {
      cleanup(directory);
    }
  });

  test('filters by platform, sentiment, company and free text', () => {
    const directory = tempDir();
    try {
      const store = createStore({ dataDir: directory }).init();
      store.addMany([
        mention('a', { platform: 'TikTok', sentiment: 'negative', company: 'acme' }),
        mention('b', { platform: 'YouTube', sentiment: 'positive', company: 'acme' }),
        mention('c', { platform: 'TikTok', sentiment: 'positive', company: 'globex' })
      ]);

      assert.equal(store.query({ platform: 'TikTok' }).total, 2);
      assert.equal(store.query({ sentiment: 'positive' }).total, 2);
      assert.equal(store.query({ company: 'globex' }).total, 1);
      assert.equal(store.query({ platform: 'TikTok', sentiment: 'negative' }).total, 1);
      assert.equal(store.query({ search: 'globex' }).total, 1);
      assert.equal(store.query({ search: 'NOTHING' }).total, 0);
      assert.equal(store.query({ platform: 'all' }).total, 3, '"all" must not filter');
    } finally {
      cleanup(directory);
    }
  });

  test('accepts comma-separated multi-value filters', () => {
    const directory = tempDir();
    try {
      const store = createStore({ dataDir: directory }).init();
      store.addMany([
        mention('a', { platform: 'TikTok' }),
        mention('b', { platform: 'YouTube' }),
        mention('c', { platform: 'Instagram' })
      ]);

      assert.equal(store.query({ platform: 'TikTok,YouTube' }).total, 2);
    } finally {
      cleanup(directory);
    }
  });

  test('paginates', () => {
    const directory = tempDir();
    try {
      const store = createStore({ dataDir: directory }).init();
      store.addMany(Array.from({ length: 25 }, (_, index) =>
        mention(`m${index}`, { minutesAgo: index })));

      const page = store.query({ limit: 10, offset: 10 });
      assert.equal(page.total, 25);
      assert.equal(page.items.length, 10);
      assert.equal(page.items[0].id, 'm10');
    } finally {
      cleanup(directory);
    }
  });

  test('stats computes shares that account for every mention', () => {
    const directory = tempDir();
    try {
      const store = createStore({ dataDir: directory }).init();
      store.addMany([
        mention('a', { sentiment: 'positive' }),
        mention('b', { sentiment: 'positive' }),
        mention('c', { sentiment: 'negative' }),
        mention('d', { sentiment: 'neutral' })
      ]);

      const stats = store.stats();
      assert.equal(stats.total, 4);
      assert.deepEqual(stats.sentiment, { positive: 2, neutral: 1, negative: 1 });
      assert.equal(stats.sentimentShare.positive, 50);
      assert.equal(stats.companies[0].total, 4);
      assert.equal(stats.platforms[0].count, 4);
    } finally {
      cleanup(directory);
    }
  });

  test('timeline buckets mentions by real timestamp', () => {
    const directory = tempDir();
    try {
      // Deliberately mid-bucket: buckets are aligned to the clock, so with a
      // `now` of exactly 12:00:00 the newest bucket is 12:00-12:15 and an item
      // from two minutes earlier belongs to the *previous* one.
      const now = Date.parse('2026-08-26T12:07:30.000Z');
      const store = createStore({ dataDir: directory }).init();

      // Two in the current 15-minute bucket, one an hour back, none between.
      store.addMany([
        mention('a', { minutesAgo: 2, now, sentiment: 'negative' }),
        mention('b', { minutesAgo: 5, now, sentiment: 'positive' }),
        mention('c', { minutesAgo: 62, now })
      ]);

      const { buckets } = store.timeline({ bucketMinutes: 15, buckets: 6, now });
      assert.equal(buckets.length, 6);

      const totals = buckets.map((bucket) => bucket.total);
      assert.equal(totals.reduce((sum, value) => sum + value, 0), 3);
      assert.equal(buckets[buckets.length - 1].total, 2, 'newest bucket holds the two recent items');
      assert.equal(buckets[buckets.length - 1].negative, 1);

      // Assert placement against each bucket's own range rather than a
      // hard-coded index, which depends on where `now` falls in its bucket.
      const hourOld = new Date(now - 62 * 60000).getTime();
      const owning = buckets.find((bucket) =>
        hourOld >= Date.parse(bucket.start) && hourOld < Date.parse(bucket.end));

      assert.ok(owning, 'the hour-old item should fall inside a bucket');
      assert.equal(owning.total, 1);
      assert.notOk(
        owning === buckets[buckets.length - 1],
        'and it must not be counted in the newest bucket'
      );
    } finally {
      cleanup(directory);
    }
  });

  test('timeline buckets are clock-aligned and end with the bucket holding now', () => {
    const directory = tempDir();
    try {
      const now = Date.parse('2026-08-26T12:07:30.000Z');
      const store = createStore({ dataDir: directory }).init();

      const { buckets } = store.timeline({ bucketMinutes: 15, buckets: 4, now });
      const newest = buckets[buckets.length - 1];

      assert.equal(new Date(newest.start).toISOString(), '2026-08-26T12:00:00.000Z');
      assert.ok(
        now >= Date.parse(newest.start) && now < Date.parse(newest.end),
        'the newest bucket must contain now'
      );

      // Contiguous, ascending, no gaps.
      for (let index = 1; index < buckets.length; index += 1) {
        assert.equal(buckets[index].start, buckets[index - 1].end);
      }
    } finally {
      cleanup(directory);
    }
  });

  test('timeline ignores mentions outside the window', () => {
    const directory = tempDir();
    try {
      const now = Date.parse('2026-08-26T12:00:00.000Z');
      const store = createStore({ dataDir: directory }).init();
      store.add(mention('ancient', { minutesAgo: 60 * 24 * 30, now }));

      const { buckets } = store.timeline({ bucketMinutes: 15, buckets: 4, now });
      assert.equal(buckets.reduce((sum, bucket) => sum + bucket.total, 0), 0);
    } finally {
      cleanup(directory);
    }
  });

  test('negativesInWindow only returns recent negatives', () => {
    const directory = tempDir();
    try {
      const now = Date.now();
      const store = createStore({ dataDir: directory }).init();
      store.addMany([
        mention('a', { minutesAgo: 2, sentiment: 'negative', now }),
        mention('b', { minutesAgo: 10, sentiment: 'negative', now }),
        mention('c', { minutesAgo: 40, sentiment: 'negative', now }),
        mention('d', { minutesAgo: 1, sentiment: 'positive', now })
      ]);

      assert.equal(store.negativesInWindow(15, now).length, 2);
      assert.equal(store.negativesInWindow(60, now).length, 3);
    } finally {
      cleanup(directory);
    }
  });

  test('prune enforces retention and the row cap, and rewrites the file', () => {
    const directory = tempDir();
    try {
      const now = Date.now();
      const store = createStore({ dataDir: directory, retentionDays: 1, maxMentions: 100 }).init();
      store.addMany([
        mention('fresh', { minutesAgo: 5, now }),
        mention('stale', { minutesAgo: 60 * 24 * 3, now })
      ]);

      assert.equal(store.prune(now), 1);
      assert.deepEqual(store.mentions.map((entry) => entry.id), ['fresh']);

      const reloaded = createStore({ dataDir: directory, retentionDays: 1 }).init();
      assert.equal(reloaded.mentions.length, 1, 'prune should have rewritten the file');
    } finally {
      cleanup(directory);
    }
  });

  test('maxMentions keeps the newest rows', () => {
    const directory = tempDir();
    try {
      const store = createStore({ dataDir: directory, maxMentions: 3, retentionDays: 0 }).init();
      store.addMany(Array.from({ length: 10 }, (_, index) =>
        mention(`m${index}`, { minutesAgo: index })));

      store.prune();
      assert.equal(store.mentions.length, 3);
      assert.deepEqual(store.mentions.map((entry) => entry.id), ['m0', 'm1', 'm2']);
    } finally {
      cleanup(directory);
    }
  });

  test('clear empties mentions but keeps the alert trail', () => {
    const directory = tempDir();
    try {
      const store = createStore({ dataDir: directory }).init();
      store.addMany([mention('a'), mention('b')]);
      store.recordAlert({ type: 'crisis', negativeCount: 5 });

      assert.equal(store.clear(), 2);
      assert.equal(store.mentions.length, 0);
      assert.equal(store.alerts.length, 1);
      assert.ok(store.add(mention('a')).added, 'ids should be re-addable after a clear');
    } finally {
      cleanup(directory);
    }
  });

  test('recentAlerts returns newest first', () => {
    const directory = tempDir();
    try {
      const store = createStore({ dataDir: directory }).init();
      store.recordAlert({ type: 'notification', event: 'first' });
      store.recordAlert({ type: 'notification', event: 'second' });

      assert.equal(store.recentAlerts(5)[0].event, 'second');
    } finally {
      cleanup(directory);
    }
  });
});

describe('crisis detector', () => {
  /** A store pre-loaded with `count` negatives inside the window. */
  function storeWithNegatives(directory, count, now = Date.now()) {
    const store = createStore({ dataDir: directory }).init();
    store.addMany(Array.from({ length: count }, (_, index) =>
      mention(`neg${index}`, { minutesAgo: index % 14, sentiment: 'negative', now })));
    return store;
  }

  test('fires on the absolute threshold', () => {
    const directory = tempDir();
    try {
      const now = Date.now();
      const store = storeWithNegatives(directory, 5, now);
      const detector = createCrisisDetector({ windowMinutes: 15, negativeThreshold: 5, cooldownMinutes: 30 });

      const event = detector.evaluate(store, now);
      assert.ok(event, 'should fire at the threshold');
      assert.includes(event.rules, 'absolute');
      assert.equal(event.negativeCount, 5);
      assert.ok(event.samples.length > 0, 'should carry example mentions');
    } finally {
      cleanup(directory);
    }
  });

  test('stays quiet below the threshold', () => {
    const directory = tempDir();
    try {
      const now = Date.now();
      const store = storeWithNegatives(directory, 3, now);
      const detector = createCrisisDetector({ windowMinutes: 15, negativeThreshold: 5 });

      assert.equal(detector.evaluate(store, now), null);
    } finally {
      cleanup(directory);
    }
  });

  test('escalates severity with volume', () => {
    const directory = tempDir();
    try {
      const now = Date.now();
      const detector = createCrisisDetector({ windowMinutes: 15, negativeThreshold: 5, cooldownMinutes: 0 });

      assert.equal(detector.evaluate(storeWithNegatives(tempDir(), 5, now), now).severity, 'elevated');
      detector.reset();
      assert.equal(detector.evaluate(storeWithNegatives(tempDir(), 11, now), now).severity, 'high');
      detector.reset();
      assert.equal(detector.evaluate(storeWithNegatives(tempDir(), 16, now), now).severity, 'critical');
    } finally {
      cleanup(directory);
    }
  });

  test('suppresses repeats during cooldown', () => {
    const directory = tempDir();
    try {
      const now = Date.now();
      const store = storeWithNegatives(directory, 6, now);
      const detector = createCrisisDetector({ windowMinutes: 15, negativeThreshold: 5, cooldownMinutes: 30 });

      assert.ok(detector.evaluate(store, now));
      assert.equal(detector.evaluate(store, now + 60_000), null, 'second call inside cooldown');
      assert.equal(detector.evaluate(store, now + 10 * 60_000), null);
    } finally {
      cleanup(directory);
    }
  });

  test('breaks through cooldown when the count grows materially', () => {
    const directory = tempDir();
    try {
      const now = Date.now();
      const store = storeWithNegatives(directory, 6, now);
      const detector = createCrisisDetector({ windowMinutes: 15, negativeThreshold: 5, cooldownMinutes: 30 });

      assert.ok(detector.evaluate(store, now));

      // 6 -> 12 is a 100% increase, well past the 50% escalation bar.
      store.addMany(Array.from({ length: 6 }, (_, index) =>
        mention(`extra${index}`, { minutesAgo: 1, sentiment: 'negative', now })));

      const escalation = detector.evaluate(store, now + 60_000);
      assert.ok(escalation, 'a growing incident must re-alert');
      assert.ok(escalation.escalated);
    } finally {
      cleanup(directory);
    }
  });

  test('reset clears the cooldown', () => {
    const directory = tempDir();
    try {
      const now = Date.now();
      const store = storeWithNegatives(directory, 6, now);
      const detector = createCrisisDetector({ windowMinutes: 15, negativeThreshold: 5, cooldownMinutes: 30 });

      assert.ok(detector.evaluate(store, now));
      detector.reset();
      assert.ok(detector.evaluate(store, now + 1000), 'should fire again after acknowledge');
    } finally {
      cleanup(directory);
    }
  });

  test('status reports the window without firing', () => {
    const directory = tempDir();
    try {
      const now = Date.now();
      const store = storeWithNegatives(directory, 4, now);
      const detector = createCrisisDetector({ windowMinutes: 15, negativeThreshold: 5 });

      const status = detector.status(store, now);
      assert.equal(status.negativeCount, 4);
      assert.equal(status.threshold, 5);
      assert.equal(status.level, 'normal');
      assert.equal(status.lastFiredAt, null, 'status must not fire the detector');
    } finally {
      cleanup(directory);
    }
  });

  test('reconfigure applies new thresholds without losing cooldown state', () => {
    const directory = tempDir();
    try {
      const now = Date.now();
      const store = storeWithNegatives(directory, 4, now);
      const detector = createCrisisDetector({ windowMinutes: 15, negativeThreshold: 10 });

      assert.equal(detector.evaluate(store, now), null);
      detector.reconfigure({ negativeThreshold: 3 });
      assert.ok(detector.evaluate(store, now), 'lowered threshold should now fire');
    } finally {
      cleanup(directory);
    }
  });
});
