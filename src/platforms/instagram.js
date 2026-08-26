/**
 * Instagram Graph API connector.
 *
 * Three real capabilities are used, all first-party:
 *
 *   1. Hashtag search - ig_hashtag_search resolves "#ritehomes" to a hashtag id,
 *      then {hashtag-id}/recent_media returns public posts and reels using it.
 *   2. Tagged mentions - {ig-user-id}/tags returns media where your business
 *      account was tagged.
 *   3. Comments on your own media - {media-id}/comments.
 *
 * Two constraints worth knowing before trusting the numbers:
 *
 *   - Hashtag limit: an app may query at most 30 unique hashtags per rolling
 *     7 days per user. Adding hashtags to config is not free - a typo can burn
 *     a slot for a week.
 *   - recent_media does NOT include the author's username for third-party
 *     posts. Meta withholds it, so those items are attributed to the hashtag
 *     with a link to the post rather than a fabricated author name.
 */
import { PlatformConnector, SUB_REQUEST_CONCURRENCY } from './base.js';
import { buildUrl, getJson } from '../util/http.js';

const DEFAULT_API_VERSION = 'v21.0';
const GRAPH_ROOT = 'https://graph.facebook.com';
const MEDIA_FIELDS = 'id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count';

export class InstagramConnector extends PlatformConnector {
  static platform = 'Instagram';
  static key = 'instagram';

  constructor(context) {
    super(context);
    this.hashtagIdCache = new Map();
  }

  missingCredentials() {
    const missing = [];
    if (!this.settings.accessToken) missing.push('IG_ACCESS_TOKEN');
    if (!this.settings.businessAccountId) missing.push('IG_BUSINESS_ACCOUNT_ID');
    return missing;
  }

  get apiBase() {
    return `${GRAPH_ROOT}/${this.settings.apiVersion || DEFAULT_API_VERSION}`;
  }

  async fetch({ since, limit }) {
    const token = this.settings.accessToken;
    const userId = this.settings.businessAccountId;

    // Only hashtag terms are usable here; a plain company name is not a
    // searchable dimension on Instagram's API.
    const hashtags = this.#hashtagTerms();

    const hashtagItems = await this.mapLimited(
      hashtags,
      SUB_REQUEST_CONCURRENCY,
      (hashtag) => this.#fetchHashtagMedia(hashtag, userId, token)
    );

    let taggedItems = [];
    if (this.settings.trackTaggedMentions) {
      taggedItems = await this.#fetchTagged(userId, token);
    }

    return this.applyWindow([...hashtagItems, ...taggedItems], { since, limit });
  }

  /** Hashtag terms from every configured company, without the leading "#". */
  #hashtagTerms() {
    const fromConfig = (this.matcher?.companies || [])
      .flatMap((company) => company.hashtags || [])
      .map((tag) => String(tag).replace(/^#/, '').trim())
      .filter(Boolean);

    return [...new Set(fromConfig)];
  }

  /** Resolves and caches a hashtag id - resolution itself costs a query. */
  async #hashtagId(hashtag, userId, token) {
    if (this.hashtagIdCache.has(hashtag)) return this.hashtagIdCache.get(hashtag);

    const url = buildUrl(`${this.apiBase}/ig_hashtag_search`, {
      user_id: userId,
      q: hashtag,
      access_token: token
    });

    const payload = await getJson(url);
    const id = payload.data?.[0]?.id || null;

    this.hashtagIdCache.set(hashtag, id);
    if (!id) this.log.warn(`hashtag "#${hashtag}" could not be resolved`);

    return id;
  }

  async #fetchHashtagMedia(hashtag, userId, token) {
    const hashtagId = await this.#hashtagId(hashtag, userId, token);
    if (!hashtagId) return [];

    const url = buildUrl(`${this.apiBase}/${hashtagId}/recent_media`, {
      user_id: userId,
      fields: MEDIA_FIELDS,
      limit: Math.min(50, this.monitoring.maxItemsPerPoll || 25),
      access_token: token
    });

    const payload = await getJson(url);

    return (payload.data || [])
      .map((media) => this.#normaliseMedia(media, {
        kind: media.media_type === 'VIDEO' ? 'reel' : 'post',
        // Meta withholds third-party usernames on hashtag media, so the
        // hashtag is credited rather than inventing an author.
        authorName: `#${hashtag}`,
        authorHandle: `instagram.com/explore/tags/${hashtag}`,
        idKind: 'hashtag_media'
      }))
      .filter((item) => item.text);
  }

  /** Media where the monitored business account was tagged. */
  async #fetchTagged(userId, token) {
    const url = buildUrl(`${this.apiBase}/${userId}/tags`, {
      fields: `${MEDIA_FIELDS},username`,
      limit: Math.min(50, this.monitoring.maxItemsPerPoll || 25),
      access_token: token
    });

    let payload;
    try {
      payload = await getJson(url);
    } catch (error) {
      this.log.debug(`tagged media unavailable: ${error.message}`);
      return [];
    }

    const media = payload.data || [];

    const items = media
      .map((entry) => this.#normaliseMedia(entry, {
        kind: entry.media_type === 'VIDEO' ? 'reel' : 'post',
        authorName: entry.username ? `@${entry.username}` : 'Instagram user',
        authorHandle: entry.username ? `instagram.com/${entry.username}` : '',
        idKind: 'tagged'
      }))
      .filter((item) => item.text);

    if (!this.settings.includeComments) return items;

    const comments = await this.mapLimited(
      media.filter((entry) => (entry.comments_count || 0) > 0),
      SUB_REQUEST_CONCURRENCY,
      (entry) => this.#fetchComments(entry, token)
    );

    return [...items, ...comments];
  }

  async #fetchComments(media, token) {
    const url = buildUrl(`${this.apiBase}/${media.id}/comments`, {
      fields: 'id,text,timestamp,username,like_count',
      limit: 25,
      access_token: token
    });

    let payload;
    try {
      payload = await getJson(url);
    } catch (error) {
      this.log.debug(`comments unavailable for media ${media.id}: ${error.message}`);
      return [];
    }

    return (payload.data || [])
      .map((comment) => ({
        platform: this.platform,
        externalId: this.makeExternalId('comment', comment.id),
        kind: 'comment',
        text: this.cleanText(comment.text),
        author: {
          name: comment.username ? `@${comment.username}` : 'Instagram user',
          handle: comment.username ? `instagram.com/${comment.username}` : '',
          id: '',
          url: comment.username ? `https://instagram.com/${comment.username}` : ''
        },
        url: media.permalink || '',
        timestamp: this.toIso(comment.timestamp),
        metrics: { likes: comment.like_count || 0 },
        parent: {
          id: media.id,
          title: this.cleanText(media.caption).slice(0, 120),
          url: media.permalink || ''
        }
      }))
      .filter((item) => item.text);
  }

  #normaliseMedia(media, { kind, authorName, authorHandle, idKind }) {
    return {
      platform: this.platform,
      externalId: this.makeExternalId(idKind, media.id),
      kind,
      text: this.cleanText(media.caption),
      author: {
        name: authorName,
        handle: authorHandle,
        id: '',
        url: authorHandle ? `https://${authorHandle}` : ''
      },
      url: media.permalink || '',
      timestamp: this.toIso(media.timestamp),
      metrics: {
        likes: media.like_count || 0,
        comments: media.comments_count || 0
      },
      parent: null
    };
  }
}
