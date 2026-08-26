/**
 * Ingestion pipeline.
 *
 * One path for every platform:
 *
 *   raw item -> normalise -> keyword match -> sentiment -> de-duplicate
 *            -> store -> notify -> evaluate crisis window
 *
 * Order matters in two places. Matching runs before sentiment so unrelated
 * chatter is never scored or stored, and de-duplication runs before notifying
 * so a post re-appearing in the next poll cannot alert twice.
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createLogger } from '../log.js';

const log = createLogger('pipeline');

/** Short, stable id derived from whatever identity the platform gave us. */
function stableId(item) {
  const seed = item.externalId
    ? item.externalId
    : `${item.platform}|${item.author?.handle || item.author?.name || ''}|${item.text}`;

  return createHash('sha1').update(seed).digest('hex').slice(0, 16);
}

export class Pipeline extends EventEmitter {
  /**
   * @param {Object} options
   * @param {Object} options.matcher
   * @param {Object} options.sentiment
   * @param {Object} options.store
   * @param {Object} options.crisis
   * @param {Object} options.dispatcher
   */
  constructor({ matcher, sentiment, store, crisis, dispatcher }) {
    super();
    this.matcher = matcher;
    this.sentiment = sentiment;
    this.store = store;
    this.crisis = crisis;
    this.dispatcher = dispatcher;
  }

  /** Swaps in rebuilt analysers after a live config change. */
  reconfigure({ matcher, sentiment }) {
    if (matcher) this.matcher = matcher;
    if (sentiment) this.sentiment = sentiment;
  }

  /**
   * Turns a connector item into a stored mention, or null when it does not
   * mention any monitored company.
   */
  normalise(item) {
    const text = String(item.text || '').trim();
    if (!text) return null;

    // The parent title is matched too: a comment saying only "same problem
    // here" is relevant when it sits under a video that names the brand.
    const match = this.matcher.match(text);
    const parentMatch = item.parent?.title ? this.matcher.match(item.parent.title) : null;

    if (!match.matched && !parentMatch?.matched) return null;

    const companies = match.matched ? match.companies : parentMatch.companies;
    const score = this.sentiment.analyze(text);

    return {
      id: stableId(item),
      externalId: item.externalId || null,
      platform: item.platform,
      kind: item.kind || 'post',
      text,
      author: {
        name: item.author?.name || 'Unknown',
        handle: item.author?.handle || '',
        id: item.author?.id || '',
        url: item.author?.url || ''
      },
      url: item.url || '',
      timestamp: item.timestamp || new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
      metrics: item.metrics || {},
      parent: item.parent || null,

      companies: companies.map((entry) => ({
        companyId: entry.companyId,
        companyName: entry.companyName,
        hits: entry.hits,
        matchType: entry.bestType
      })),
      matchedTerms: [...new Set(companies.flatMap((entry) => entry.terms))],
      // Ranges are relative to `text`, so the dashboard can highlight without
      // re-implementing any matching logic.
      highlights: match.matched ? match.highlights : [],
      // A comment that only matched through its parent is flagged, because it
      // is weaker evidence than a direct mention.
      matchedViaParent: !match.matched,

      sentiment: score.label,
      sentimentScore: score.score,
      sentimentRaw: score.raw,
      sentimentTerms: score.hits.map((hit) => ({ term: hit.term, weight: hit.weight })),

      isMock: Boolean(item.isMock)
    };
  }

  /**
   * @param {Array<Object>} rawItems
   * @param {{source?: string}} context
   * @returns {Promise<Object>} ingest summary
   */
  async ingest(rawItems, context = {}) {
    const source = context.source || 'unknown';
    const summary = {
      source,
      received: rawItems.length,
      matched: 0,
      added: 0,
      duplicates: 0,
      mentions: [],
      crisis: null
    };

    const candidates = [];
    for (const item of rawItems) {
      const mention = this.normalise(item);
      if (mention) candidates.push(mention);
    }

    summary.matched = candidates.length;

    // Oldest first, so the sliding crisis window sees events in real order.
    candidates.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const { mentions: accepted, duplicates } = this.store.addMany(candidates);
    summary.added = accepted.length;
    summary.duplicates = duplicates;
    summary.mentions = accepted;

    for (const mention of accepted) {
      this.emit('mention', mention);
    }

    // Notifications are fired after the whole batch is stored so the crisis
    // detector has complete data, and so per-mention alerts and the crisis
    // alert cannot interleave confusingly.
    const notifications = accepted.map((mention) =>
      this.dispatcher.dispatch('mention', mention).catch((error) => {
        log.warn(`notification for ${mention.id} failed: ${error.message}`);
      }));

    const crisisEvent = accepted.length > 0 ? this.crisis.evaluate(this.store) : null;

    if (crisisEvent) {
      summary.crisis = crisisEvent;
      this.store.recordAlert(crisisEvent);
      this.emit('crisis', crisisEvent);
      notifications.push(
        this.dispatcher.dispatch('crisis', crisisEvent).catch((error) => {
          log.warn(`crisis notification failed: ${error.message}`);
        })
      );
    }

    await Promise.allSettled(notifications);

    // Logged even when nothing came back. A poll that succeeds and finds
    // nothing is the normal state for a brand with little coverage, and it has
    // to be distinguishable from a poll that never ran - otherwise "quiet" and
    // "broken" look identical in the journal.
    log.info(
      `${source}: ${summary.received} fetched, ${summary.matched} matched, ` +
      `${summary.added} new, ${summary.duplicates} duplicate` +
      (crisisEvent ? `, CRISIS (${crisisEvent.severity})` : '')
    );

    this.emit('ingest', summary);
    return summary;
  }
}

export function createPipeline(options) {
  return new Pipeline(options);
}

export { stableId };
