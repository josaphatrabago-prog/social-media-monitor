/**
 * Generic aggregator connector (Apify / RapidAPI).
 *
 * Purpose: cover the gaps the first-party APIs leave - public Facebook search,
 * YouTube transcripts, TikTok without Research API access - without hard-coding
 * any one vendor's response shape.
 *
 * Because every scraper actor returns different field names, the mapping is
 * configuration rather than code. Each entry declares the actor to run and
 * where to find each normalised field, using dot paths:
 *
 *   "aggregator": {
 *     "enabled": true,
 *     "provider": "apify",
 *     "apifyToken": "env:APIFY_TOKEN",
 *     "actors": {
 *       "facebook": {
 *         "actor": "apify~facebook-posts-scraper",
 *         "input": { "resultsLimit": 25 },
 *         "termsField": "searchQueries",
 *         "map": {
 *           "id": "postId",
 *           "text": "text",
 *           "url": "url",
 *           "timestamp": "time",
 *           "authorName": "user.name",
 *           "authorHandle": "user.profileUrl",
 *           "likes": "likesCount"
 *         }
 *       }
 *     }
 *   }
 *
 * Anything the map omits falls back to a sensible guess from a list of common
 * field names, so a well-behaved actor often needs no map at all.
 */
import { PlatformConnector } from './base.js';
import { buildUrl, getJson, postJson } from '../util/http.js';

const APIFY_ROOT = 'https://api.apify.com/v2';
const ACTOR_TIMEOUT_MS = 180000;

/** Field names commonly used by scraper actors, tried in order. */
const FALLBACK_PATHS = {
  id: ['id', 'postId', 'videoId', 'commentId', 'aweme_id', 'pk'],
  text: ['text', 'caption', 'message', 'content', 'description', 'title', 'video_description'],
  url: ['url', 'postUrl', 'webVideoUrl', 'permalink', 'link', 'permalink_url'],
  timestamp: ['timestamp', 'time', 'createTimeISO', 'created_time', 'publishedAt', 'taken_at'],
  authorName: ['authorName', 'author.name', 'user.name', 'ownerFullName', 'authorMeta.name', 'username'],
  authorHandle: ['authorHandle', 'author.handle', 'user.username', 'ownerUsername', 'authorMeta.nickName'],
  likes: ['likes', 'likesCount', 'diggCount', 'like_count', 'reactionsCount'],
  comments: ['comments', 'commentsCount', 'commentCount', 'comment_count'],
  shares: ['shares', 'sharesCount', 'shareCount', 'share_count'],
  views: ['views', 'viewsCount', 'playCount', 'view_count']
};

/** Reads "user.profile.name" out of a nested object. */
function readPath(source, dotPath) {
  if (!dotPath) return undefined;

  return dotPath.split('.').reduce(
    (node, key) => (node === null || node === undefined ? undefined : node[key]),
    source
  );
}

/** Mapped path first, then the fallback candidates. */
function readField(item, map, field) {
  const mapped = readPath(item, map?.[field]);
  if (mapped !== undefined && mapped !== null && mapped !== '') return mapped;

  for (const candidate of FALLBACK_PATHS[field] || []) {
    const value = readPath(item, candidate);
    if (value !== undefined && value !== null && value !== '') return value;
  }

  return undefined;
}

export class AggregatorConnector extends PlatformConnector {
  static platform = 'Aggregator';
  static key = 'aggregator';

  /**
   * @param {Object} context plus `targetPlatform` - the platform whose gap this
   *                         instance is filling, used for labelling items.
   */
  constructor(context) {
    super(context);
    this.targetPlatform = context.targetPlatform || 'Web';
    this.actorConfig = (this.settings.actors || {})[this.targetPlatform.toLowerCase()] || null;
  }

  get platform() {
    return this.targetPlatform;
  }

  missingCredentials() {
    const missing = [];

    if (!this.settings.enabled) missing.push('platforms.aggregator.enabled');
    if (!this.actorConfig) {
      missing.push(`platforms.aggregator.actors.${this.targetPlatform.toLowerCase()}`);
    }

    if (this.settings.provider === 'rapidapi') {
      if (!this.settings.rapidApiKey) missing.push('RAPIDAPI_KEY');
    } else if (!this.settings.apifyToken) {
      missing.push('APIFY_TOKEN');
    }

    return missing;
  }

  async fetch({ terms, since, limit }) {
    const items = this.settings.provider === 'rapidapi'
      ? await this.#fetchViaRapidApi(terms, limit)
      : await this.#fetchViaApify(terms, limit);

    return this.applyWindow(items, { since, limit });
  }

  async #fetchViaApify(terms, limit) {
    const { actor, input = {}, termsField = 'searchQueries' } = this.actorConfig;
    const actorPath = String(actor).replace('/', '~');

    const url = buildUrl(`${APIFY_ROOT}/acts/${actorPath}/run-sync-get-dataset-items`, {
      token: this.settings.apifyToken
    });

    const payload = await postJson(
      url,
      { ...input, [termsField]: terms, resultsLimit: limit || 25 },
      { timeoutMs: ACTOR_TIMEOUT_MS, retries: 1 }
    );

    return this.#normaliseAll(Array.isArray(payload) ? payload : []);
  }

  async #fetchViaRapidApi(terms, limit) {
    const { endpoint, queryField = 'query', host, itemsPath } = this.actorConfig;

    const collected = await this.mapLimited(terms, 2, async (term) => {
      const url = buildUrl(endpoint, { [queryField]: term, count: limit || 25 });

      const payload = await getJson(url, {
        headers: {
          'x-rapidapi-key': this.settings.rapidApiKey,
          'x-rapidapi-host': host || new URL(endpoint).host
        }
      });

      const list = itemsPath ? readPath(payload, itemsPath) : payload;
      return this.#normaliseAll(Array.isArray(list) ? list : []);
    });

    return collected;
  }

  #normaliseAll(rawItems) {
    const { map } = this.actorConfig || {};

    return rawItems
      .map((item, index) => {
        const text = this.cleanText(readField(item, map, 'text'));
        if (!text) return null;

        const id = String(readField(item, map, 'id') ?? `${Date.now()}-${index}`);
        const authorName = this.cleanText(readField(item, map, 'authorName'));
        const authorHandle = this.cleanText(readField(item, map, 'authorHandle'));

        return {
          platform: this.targetPlatform,
          externalId: `agg:${this.targetPlatform.toLowerCase()}:${id}`,
          kind: 'post',
          text,
          author: {
            name: authorName || `${this.targetPlatform} user`,
            handle: authorHandle || '',
            id: '',
            url: ''
          },
          url: this.cleanText(readField(item, map, 'url')) || '',
          timestamp: this.toIso(readField(item, map, 'timestamp')),
          metrics: {
            likes: Number(readField(item, map, 'likes')) || 0,
            comments: Number(readField(item, map, 'comments')) || 0,
            shares: Number(readField(item, map, 'shares')) || 0,
            views: Number(readField(item, map, 'views')) || 0
          },
          parent: null,
          viaAggregator: true
        };
      })
      .filter(Boolean);
  }
}

export { readPath, readField };
