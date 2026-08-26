/**
 * Mention store: an in-memory index over an append-only JSONL file.
 *
 * JSONL rather than a database because the whole system is dependency-free and
 * the working set is small (tens of thousands of rows). Reads are served from
 * memory; every accepted mention is appended to disk so a restart resumes with
 * full history and de-duplication intact.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../log.js';

const log = createLogger('store');

const MENTIONS_FILE = 'mentions.jsonl';
const ALERTS_FILE = 'alerts.jsonl';

/** Newest-first comparison on ISO timestamps. */
function byNewest(a, b) {
  return b.timestamp.localeCompare(a.timestamp);
}

function parseTime(value) {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

export class MentionStore {
  /** @param {{dataDir: string, maxMentions?: number, retentionDays?: number}} options */
  constructor(options = {}) {
    this.dataDir = path.resolve(options.dataDir || './data');
    this.maxMentions = options.maxMentions ?? 20000;
    this.retentionDays = options.retentionDays ?? 90;

    this.mentions = [];
    this.alerts = [];
    this.seenIds = new Set();
  }

  get mentionsPath() {
    return path.join(this.dataDir, MENTIONS_FILE);
  }

  get alertsPath() {
    return path.join(this.dataDir, ALERTS_FILE);
  }

  /** Creates the data directory and replays both JSONL files into memory. */
  init() {
    fs.mkdirSync(this.dataDir, { recursive: true });

    this.mentions = this.#readJsonl(this.mentionsPath)
      .filter((entry) => entry && entry.id && entry.timestamp);
    this.alerts = this.#readJsonl(this.alertsPath);

    this.mentions.sort(byNewest);
    this.seenIds = new Set(this.mentions.map((entry) => entry.id));

    const removed = this.prune();
    log.info(
      `loaded ${this.mentions.length} mentions, ${this.alerts.length} alerts from ${this.dataDir}` +
      (removed ? ` (pruned ${removed})` : '')
    );

    return this;
  }

  #readJsonl(filePath) {
    if (!fs.existsSync(filePath)) return [];

    const rows = [];
    let badLines = 0;

    for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        rows.push(JSON.parse(trimmed));
      } catch {
        badLines += 1;
      }
    }

    if (badLines) log.warn(`${path.basename(filePath)}: skipped ${badLines} unreadable line(s)`);
    return rows;
  }

  #append(filePath, record) {
    try {
      fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (error) {
      log.error(`failed writing ${path.basename(filePath)}`, error);
    }
  }

  /** Rewrites a JSONL file from the current in-memory rows (used after pruning). */
  #rewrite(filePath, rows) {
    try {
      const body = rows.map((row) => JSON.stringify(row)).join('\n');
      fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
    } catch (error) {
      log.error(`failed rewriting ${path.basename(filePath)}`, error);
    }
  }

  has(id) {
    return this.seenIds.has(id);
  }

  /**
   * @param {Object} mention already normalised and scored
   * @returns {{added: boolean, reason?: string}}
   */
  add(mention) {
    if (!mention || !mention.id) return { added: false, reason: 'missing id' };
    if (this.seenIds.has(mention.id)) return { added: false, reason: 'duplicate' };

    this.seenIds.add(mention.id);
    this.mentions.push(mention);

    // Newly-fetched items are usually the newest, so a full sort is wasteful;
    // only re-sort when this one actually arrived out of order.
    if (this.mentions.length > 1) {
      const previous = this.mentions[this.mentions.length - 2];
      if (previous.timestamp < mention.timestamp) this.mentions.sort(byNewest);
    }

    this.#append(this.mentionsPath, mention);
    return { added: true };
  }

  /** @returns {{added: number, duplicates: number, mentions: Array}} */
  addMany(mentions) {
    const accepted = [];
    let duplicates = 0;

    for (const mention of mentions) {
      const result = this.add(mention);
      if (result.added) accepted.push(mention);
      else if (result.reason === 'duplicate') duplicates += 1;
    }

    return { added: accepted.length, duplicates, mentions: accepted };
  }

  recordAlert(alert) {
    const record = { id: `alert_${Date.now()}_${this.alerts.length}`, ...alert };
    this.alerts.push(record);
    this.#append(this.alertsPath, record);
    return record;
  }

  /**
   * Filters the in-memory index.
   * @param {Object} options platform, company, sentiment, search, since, until,
   *                         limit, offset, order
   */
  query(options = {}) {
    const {
      platform, company, sentiment, search,
      since, until, limit = 100, offset = 0, order = 'desc'
    } = options;

    const sinceTime = since ? parseTime(since) : null;
    const untilTime = until ? parseTime(until) : null;
    const needle = search ? String(search).toLowerCase() : null;

    const platforms = toSet(platform);
    const companies = toSet(company);
    const sentiments = toSet(sentiment);

    const matched = this.mentions.filter((mention) => {
      if (platforms && !platforms.has(mention.platform)) return false;
      if (sentiments && !sentiments.has(mention.sentiment)) return false;

      if (companies) {
        const ids = mention.companies?.map((entry) => entry.companyId) || [];
        if (!ids.some((id) => companies.has(id))) return false;
      }

      if (sinceTime !== null || untilTime !== null) {
        const time = parseTime(mention.timestamp);
        if (time === null) return false;
        if (sinceTime !== null && time < sinceTime) return false;
        if (untilTime !== null && time > untilTime) return false;
      }

      if (needle) {
        const haystack = [
          mention.text,
          mention.author?.name,
          mention.author?.handle,
          mention.matchedTerms?.join(' ')
        ].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(needle)) return false;
      }

      return true;
    });

    const ordered = order === 'asc' ? [...matched].reverse() : matched;

    return {
      total: matched.length,
      offset,
      limit,
      items: ordered.slice(offset, offset + limit)
    };
  }

  /** Sentiment / platform / company breakdown over an optional window. */
  stats(options = {}) {
    const { items } = this.query({ ...options, limit: Number.MAX_SAFE_INTEGER, offset: 0 });

    const sentiment = { positive: 0, neutral: 0, negative: 0 };
    const platforms = {};
    const companies = {};
    let scoreTotal = 0;

    for (const mention of items) {
      sentiment[mention.sentiment] = (sentiment[mention.sentiment] || 0) + 1;
      platforms[mention.platform] = (platforms[mention.platform] || 0) + 1;
      scoreTotal += Number(mention.sentimentScore) || 0;

      for (const entry of mention.companies || []) {
        const bucket = companies[entry.companyId] || {
          companyId: entry.companyId,
          companyName: entry.companyName,
          total: 0,
          positive: 0,
          neutral: 0,
          negative: 0
        };
        bucket.total += 1;
        bucket[mention.sentiment] += 1;
        companies[entry.companyId] = bucket;
      }
    }

    const total = items.length;
    const share = (count) => (total ? Math.round((count / total) * 1000) / 10 : 0);

    return {
      total,
      sentiment,
      sentimentShare: {
        positive: share(sentiment.positive),
        neutral: share(sentiment.neutral),
        negative: share(sentiment.negative)
      },
      averageScore: total ? Math.round((scoreTotal / total) * 1000) / 1000 : 0,
      platforms: Object.entries(platforms)
        .map(([name, count]) => ({ platform: name, count, share: share(count) }))
        .sort((a, b) => b.count - a.count),
      companies: Object.values(companies).sort((a, b) => b.total - a.total)
    };
  }

  /**
   * Real time-bucketed volume, newest bucket last. Buckets are aligned to the
   * clock so the same call twice in a row returns comparable series.
   *
   * @param {{bucketMinutes?: number, buckets?: number, now?: number}} options
   */
  timeline(options = {}) {
    const bucketMinutes = Math.max(1, options.bucketMinutes ?? 15);
    const bucketCount = Math.max(1, options.buckets ?? 24);
    const bucketMs = bucketMinutes * 60 * 1000;

    const now = options.now ?? Date.now();
    const latestStart = Math.floor(now / bucketMs) * bucketMs;
    const earliestStart = latestStart - (bucketCount - 1) * bucketMs;

    const series = [];
    for (let index = 0; index < bucketCount; index += 1) {
      const start = earliestStart + index * bucketMs;
      series.push({
        start: new Date(start).toISOString(),
        end: new Date(start + bucketMs).toISOString(),
        total: 0,
        positive: 0,
        neutral: 0,
        negative: 0
      });
    }

    for (const mention of this.mentions) {
      const time = parseTime(mention.timestamp);
      if (time === null || time < earliestStart || time >= latestStart + bucketMs) continue;

      const index = Math.floor((time - earliestStart) / bucketMs);
      const bucket = series[index];
      if (!bucket) continue;

      bucket.total += 1;
      bucket[mention.sentiment] = (bucket[mention.sentiment] || 0) + 1;
    }

    return { bucketMinutes, buckets: series };
  }

  /** Negative mentions inside the trailing window - the crisis detector's input. */
  negativesInWindow(windowMinutes, now = Date.now()) {
    const cutoff = now - windowMinutes * 60 * 1000;

    return this.mentions.filter((mention) => {
      if (mention.sentiment !== 'negative') return false;
      const time = parseTime(mention.timestamp);
      return time !== null && time >= cutoff;
    });
  }

  /** Drops rows past the retention window or over the row cap. */
  prune(now = Date.now()) {
    const before = this.mentions.length;

    if (this.retentionDays > 0) {
      const cutoff = now - this.retentionDays * 24 * 60 * 60 * 1000;
      this.mentions = this.mentions.filter((mention) => {
        const time = parseTime(mention.timestamp);
        return time === null || time >= cutoff;
      });
    }

    if (this.maxMentions > 0 && this.mentions.length > this.maxMentions) {
      this.mentions = this.mentions.slice(0, this.maxMentions);
    }

    const removed = before - this.mentions.length;
    if (removed > 0) {
      this.seenIds = new Set(this.mentions.map((entry) => entry.id));
      this.#rewrite(this.mentionsPath, this.mentions);
    }

    return removed;
  }

  /** Wipes stored mentions. Alerts are kept as an audit trail. */
  clear() {
    const removed = this.mentions.length;
    this.mentions = [];
    this.seenIds = new Set();
    this.#rewrite(this.mentionsPath, []);
    log.info(`cleared ${removed} mentions`);
    return removed;
  }

  recentAlerts(limit = 20) {
    return this.alerts.slice(-limit).reverse();
  }
}

function toSet(value) {
  if (value === undefined || value === null || value === '' || value === 'all') return null;
  const list = Array.isArray(value)
    ? value
    : String(value).split(',').map((entry) => entry.trim()).filter(Boolean);
  return list.length ? new Set(list) : null;
}

export function createStore(options) {
  return new MentionStore(options);
}
