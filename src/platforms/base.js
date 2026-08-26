/**
 * Connector contract.
 *
 * Every platform module exports a class extending PlatformConnector and returns
 * items in one normalised shape, so the pipeline never contains
 * platform-specific branching:
 *
 *   {
 *     platform:   'YouTube',
 *     externalId: 'yt:comment:Ugx...',      // stable, unique per platform
 *     kind:       'post' | 'comment' | 'video' | 'reel' | 'caption',
 *     text:       'the words to analyse',
 *     author:     { name, handle, id, url },
 *     url:        'https://...',            // link a human can open
 *     timestamp:  '2026-08-26T01:00:00.000Z',
 *     metrics:    { likes, comments, shares, views },
 *     parent:     { id, title, url } | null // video/post a comment belongs to
 *   }
 *
 * A connector that lacks credentials must report isConfigured === false rather
 * than throwing, so the scheduler can skip it and the dashboard can explain why.
 */
import { createLogger } from '../log.js';

/** Thrown when a connector is asked to fetch without usable credentials. */
export class NotConfiguredError extends Error {
  constructor(platform, missing) {
    super(`${platform}: not configured (missing ${missing.join(', ')})`);
    this.name = 'NotConfiguredError';
    this.platform = platform;
    this.missing = missing;
  }
}

export class PlatformConnector {
  /** Display name, e.g. "YouTube". Subclasses override. */
  static platform = 'Base';

  /** Lower-case key used in config.platforms and the API. */
  static key = 'base';

  /**
   * @param {{settings: Object, monitoring: Object, matcher: Object}} context
   */
  constructor(context = {}) {
    this.settings = context.settings || {};
    this.monitoring = context.monitoring || {};
    this.matcher = context.matcher;
    this.log = createLogger(this.constructor.key);
  }

  get platform() {
    return this.constructor.platform;
  }

  get key() {
    return this.constructor.key;
  }

  /** Credential names that are absent. Empty array means ready to run. */
  missingCredentials() {
    return [];
  }

  get isConfigured() {
    return this.missingCredentials().length === 0;
  }

  /**
   * Why this connector cannot run, or null. Shown in the dashboard so an
   * unconfigured platform is never silently absent.
   */
  get statusReason() {
    const missing = this.missingCredentials();
    return missing.length ? `missing ${missing.join(', ')}` : null;
  }

  /**
   * @param {{terms: string[], since: Date, limit: number}} _options
   * @returns {Promise<Array<Object>>} normalised items
   */
  async fetch(_options) {
    throw new Error(`${this.key}: fetch() not implemented`);
  }

  /* ------------------------------------------------------- shared utilities */

  /** Namespaced, stable id: "yt:comment:Ugx...". */
  makeExternalId(kind, id) {
    return `${this.key}:${kind}:${id}`;
  }

  /** Best-effort ISO 8601. Falls back to now for unparseable input. */
  toIso(value) {
    if (!value) return new Date().toISOString();

    // Facebook returns "2026-08-26T09:00:00+0000", which Date parses unevenly
    // across runtimes; normalise the offset to +00:00 first.
    const normalised = typeof value === 'string'
      ? value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
      : value;

    const parsed = new Date(normalised);
    return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  }

  /** Collapses whitespace and strips HTML that comment APIs return. */
  cleanText(value) {
    if (!value) return '';
    return String(value)
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Keeps only items newer than `since` and caps the batch.
   * Connectors call this last so every platform honours the same limits.
   */
  applyWindow(items, { since, limit }) {
    const cutoff = since ? new Date(since).getTime() : null;

    const filtered = cutoff === null
      ? items
      : items.filter((item) => new Date(item.timestamp).getTime() >= cutoff);

    filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return limit ? filtered.slice(0, limit) : filtered;
  }

  /**
   * Runs several async tasks with a small concurrency cap. Comment fan-out on
   * a search page can be dozens of requests; firing them all at once is the
   * fastest way to hit a rate limit.
   */
  async mapLimited(items, limit, task) {
    const results = [];
    let cursor = 0;

    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        try {
          results.push(await task(items[index], index));
        } catch (error) {
          this.log.warn(`sub-request failed: ${error.message}`);
        }
      }
    });

    await Promise.all(workers);
    return results.flat().filter(Boolean);
  }
}

/** Default fan-out cap for per-item follow-up requests (comments, etc.). */
export const SUB_REQUEST_CONCURRENCY = 4;
