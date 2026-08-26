/**
 * Seeds the store with roughly a day of demo mentions, so the dashboard has a
 * real history to draw the first time you open it.
 *
 * Everything goes through the actual pipeline - matcher, sentiment scoring,
 * de-duplication, storage - so the counts, charts and highlights on screen are
 * genuine output rather than fixtures. Items keep the `demo` badge and their
 * example.invalid links, so seeded data cannot be mistaken for real posts.
 *
 *   node tools/seed-demo.mjs            # ~24h of history
 *   node tools/seed-demo.mjs --hours 6  # shorter run
 *   node tools/seed-demo.mjs --clear    # wipe stored mentions first
 *
 * Safe to delete. Nothing else imports it.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { setLogLevel } from '../src/log.js';
import { createMatcher } from '../src/core/matcher.js';
import { createSentimentAnalyzer } from '../src/core/sentiment.js';
import { createStore } from '../src/core/store.js';
import { createCrisisDetector } from '../src/core/crisis.js';
import { createPipeline } from '../src/core/pipeline.js';
import { MockConnector } from '../src/platforms/mock.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PLATFORMS = ['Facebook', 'YouTube', 'TikTok', 'Instagram'];
const BUCKET_MINUTES = 15;

function parseArgs(argv) {
  const args = { hours: 24, clear: false };

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--clear') args.clear = true;
    if (argv[index] === '--hours') args.hours = Number(argv[index + 1]) || 24;
  }

  return args;
}

/**
 * Mentions per 15-minute slot, shaped like a real day: quiet overnight, busier
 * mid-morning and evening, with a complaint cluster a few hours back so the
 * volume chart and the negative share have something worth looking at.
 */
function volumeFor(minutesAgo) {
  const hoursAgo = minutesAgo / 60;
  const hourOfDay = new Date(Date.now() - minutesAgo * 60000).getHours();

  if (hourOfDay >= 1 && hourOfDay < 6) return Math.random() < 0.3 ? 1 : 0;
  if (hoursAgo > 5 && hoursAgo < 7) return 3 + Math.floor(Math.random() * 3);

  const base = hourOfDay >= 9 && hourOfDay <= 21 ? 2 : 1;
  return Math.random() < 0.25 ? 0 : base + Math.floor(Math.random() * 2);
}

/** Negative share runs much higher inside the complaint cluster. */
function mixFor(minutesAgo) {
  const hoursAgo = minutesAgo / 60;
  if (hoursAgo > 5 && hoursAgo < 7) return { negative: 0.75, neutral: 0.15, positive: 0.1 };
  return { negative: 0.18, neutral: 0.32, positive: 0.5 };
}

const args = parseArgs(process.argv.slice(2));
setLogLevel('error');

const configStore = loadConfig(path.join(PROJECT_ROOT, 'config.json'));
const config = configStore.get();

const matcher = createMatcher(config.companies);
const store = createStore(config.storage).init();
const crisis = createCrisisDetector(config.crisis);

if (args.clear) store.clear();

const pipeline = createPipeline({
  matcher,
  sentiment: createSentimentAnalyzer(config.sentiment),
  store,
  crisis,
  // Backfilling history should not page anybody.
  dispatcher: {
    dispatch: () => Promise.resolve({ delivered: [], skipped: [] }),
    channelsFor: () => [],
    reconfigure() {}
  }
});

const generators = new Map(PLATFORMS.map((platform) => [
  platform,
  new MockConnector({
    settings: {},
    monitoring: config.monitoring,
    matcher,
    forcePlatform: platform
  })
]));

let added = 0;
const slots = Math.round((args.hours * 60) / BUCKET_MINUTES);

for (let slot = slots; slot >= 0; slot -= 1) {
  const minutesAgo = slot * BUCKET_MINUTES;
  const count = volumeFor(minutesAgo);
  if (count === 0) continue;

  const mix = mixFor(minutesAgo);
  const batch = [];

  for (let index = 0; index < count; index += 1) {
    const platform = PLATFORMS[Math.floor(Math.random() * PLATFORMS.length)];
    const generator = generators.get(platform);
    generator.mix = mix;

    const [item] = await generator.fetch({ limit: 1 });
    if (!item) continue;

    // Spread each slot's items across its own 15 minutes.
    item.timestamp = new Date(
      Date.now() - minutesAgo * 60000 - Math.floor(Math.random() * BUCKET_MINUTES * 60000)
    ).toISOString();

    batch.push(item);
  }

  if (batch.length) {
    const summary = await pipeline.ingest(batch, { source: 'seed' });
    added += summary.added;
  }
}

const stats = store.stats();
const status = crisis.status(store);
const hourly = store.timeline({ bucketMinutes: 60, buckets: Math.min(24, args.hours) });

process.stdout.write(
  `seeded ${added} demo mentions across the last ${args.hours}h\n` +
  `  sentiment  : ${stats.sentiment.positive} positive / ${stats.sentiment.neutral} neutral / ` +
  `${stats.sentiment.negative} negative (${stats.sentimentShare.negative}% negative)\n` +
  `  platforms  : ${stats.platforms.map((entry) => `${entry.platform} ${entry.count}`).join(', ')}\n` +
  `  brands     : ${stats.companies.map((entry) => `${entry.companyId} ${entry.total}`).join(', ')}\n` +
  `  per hour   : ${hourly.buckets.map((bucket) => bucket.total).join(',')}  (oldest to newest)\n` +
  `  crisis now : ${status.negativeCount}/${status.threshold} in the ${status.windowMinutes}m window (${status.level})\n`
);
