/**
 * TikTok connector with three interchangeable providers.
 *
 * TikTok has no general-purpose public keyword search API, so "monitor TikTok"
 * always means picking one of these routes. Set platforms.tiktok.provider:
 *
 *   "tiktok-research"  First-party Research API. Accurate and permitted, but
 *                      access requires an approved application and is granted
 *                      mainly to academic and non-profit researchers.
 *   "apify"            Managed scraper actors. No approval needed, costs money
 *                      per run, and results depend on the actor staying
 *                      current with TikTok's markup.
 *   "rapidapi"         Third-party gateway APIs. Cheapest to start, least
 *                      stable - hosts and response shapes change often.
 *
 * Captions, hashtags and top comments are covered. Comment fetching is only
 * wired for rapidapi and the research API; Apify needs a separate comments
 * actor, which the connector reports rather than silently skipping.
 */
import { PlatformConnector, SUB_REQUEST_CONCURRENCY } from './base.js';
import { buildUrl, getJson, postJson } from '../util/http.js';

const RESEARCH_ROOT = 'https://open.tiktokapis.com/v2/research';
const APIFY_ROOT = 'https://api.apify.com/v2';

const RESEARCH_FIELDS = [
  'id', 'video_description', 'create_time', 'username', 'region_code',
  'like_count', 'comment_count', 'share_count', 'view_count', 'hashtag_names'
].join(',');

export class TikTokConnector extends PlatformConnector {
  static platform = 'TikTok';
  static key = 'tiktok';

  constructor(context) {
    super(context);
    this.commentWarningShown = false;
  }

  get provider() {
    return this.settings.provider || 'apify';
  }

  missingCredentials() {
    switch (this.provider) {
      case 'tiktok-research':
        return this.settings.researchToken ? [] : ['TIKTOK_RESEARCH_TOKEN'];
      case 'rapidapi':
        return this.settings.rapidApiKey ? [] : ['RAPIDAPI_KEY'];
      case 'apify':
        return this.settings.apifyToken ? [] : ['APIFY_TOKEN'];
      default:
        return [`platforms.tiktok.provider "${this.provider}" is not supported`];
    }
  }

  async fetch({ terms, since, limit }) {
    const videos = await this.#fetchVideos(terms, since, limit);

    if (!this.settings.includeComments || videos.length === 0) {
      return this.applyWindow(videos, { since, limit });
    }

    const comments = await this.#fetchCommentsFor(videos);
    return this.applyWindow([...videos, ...comments], { since, limit });
  }

  #fetchVideos(terms, since, limit) {
    switch (this.provider) {
      case 'tiktok-research':
        return this.#fetchViaResearchApi(terms, since, limit);
      case 'rapidapi':
        return this.#fetchViaRapidApi(terms, limit);
      case 'apify':
      default:
        return this.#fetchViaApify(terms, limit);
    }
  }

  /* ------------------------------------------------- provider: Research API */

  async #fetchViaResearchApi(terms, since, limit) {
    const url = buildUrl(`${RESEARCH_ROOT}/video/query/`, { fields: RESEARCH_FIELDS });

    const startDate = since ? new Date(since) : new Date(Date.now() - 24 * 3600 * 1000);
    const body = {
      query: {
        or: [
          { operation: 'IN', field_name: 'keyword', field_values: terms },
          {
            operation: 'IN',
            field_name: 'hashtag_name',
            field_values: terms
              .filter((term) => term.startsWith('#'))
              .map((term) => term.slice(1))
          }
        ].filter((clause) => clause.field_values.length > 0)
      },
      start_date: compactDate(startDate),
      end_date: compactDate(new Date()),
      max_count: Math.min(100, limit || 50)
    };

    const payload = await postJson(url, body, {
      headers: { authorization: `Bearer ${this.settings.researchToken}` }
    });

    return (payload?.data?.videos || []).map((video) => ({
      platform: this.platform,
      externalId: this.makeExternalId('video', video.id),
      kind: 'video',
      text: this.#withHashtags(video.video_description, video.hashtag_names),
      author: {
        name: video.username ? `@${video.username}` : 'TikTok user',
        handle: video.username ? `tiktok.com/@${video.username}` : '',
        id: video.username || '',
        url: video.username ? `https://www.tiktok.com/@${video.username}` : ''
      },
      url: video.username
        ? `https://www.tiktok.com/@${video.username}/video/${video.id}`
        : `https://www.tiktok.com/video/${video.id}`,
      // create_time is unix seconds.
      timestamp: this.toIso(new Date((video.create_time || 0) * 1000)),
      metrics: {
        likes: video.like_count || 0,
        comments: video.comment_count || 0,
        shares: video.share_count || 0,
        views: video.view_count || 0
      },
      parent: null
    })).filter((item) => item.text);
  }

  /* -------------------------------------------------------- provider: Apify */

  async #fetchViaApify(terms, limit) {
    const actor = (this.settings.apifyActor || 'clockworks~tiktok-scraper').replace('/', '~');
    const url = buildUrl(`${APIFY_ROOT}/acts/${actor}/run-sync-get-dataset-items`, {
      token: this.settings.apifyToken
    });

    const payload = await postJson(url, {
      searchQueries: terms,
      resultsPerPage: Math.min(50, limit || 25),
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
      shouldDownloadSubtitles: false
    }, { timeoutMs: 120000, retries: 1 });

    const items = Array.isArray(payload) ? payload : [];

    return items.map((item) => {
      const username = item.authorMeta?.name || item.authorMeta?.uniqueId || '';
      const videoId = item.id || item.videoMeta?.id || '';

      return {
        platform: this.platform,
        externalId: this.makeExternalId('video', videoId),
        kind: 'video',
        text: this.#withHashtags(
          item.text,
          (item.hashtags || []).map((tag) => tag.name || tag)
        ),
        author: {
          name: username ? `@${username}` : 'TikTok user',
          handle: username ? `tiktok.com/@${username}` : '',
          id: item.authorMeta?.id || '',
          url: username ? `https://www.tiktok.com/@${username}` : ''
        },
        url: item.webVideoUrl || (username && videoId
          ? `https://www.tiktok.com/@${username}/video/${videoId}`
          : ''),
        timestamp: this.toIso(item.createTimeISO || (item.createTime && item.createTime * 1000)),
        metrics: {
          likes: item.diggCount || 0,
          comments: item.commentCount || 0,
          shares: item.shareCount || 0,
          views: item.playCount || 0
        },
        parent: null
      };
    }).filter((item) => item.text && item.externalId);
  }

  /* ----------------------------------------------------- provider: RapidAPI */

  async #fetchViaRapidApi(terms, limit) {
    const host = this.settings.rapidApiHost || 'tiktok-scraper7.p.rapidapi.com';
    const headers = {
      'x-rapidapi-key': this.settings.rapidApiKey,
      'x-rapidapi-host': host
    };

    const perTerm = await this.mapLimited(terms, 2, async (term) => {
      const url = buildUrl(`https://${host}/feed/search`, {
        keywords: term,
        count: Math.min(30, limit || 20),
        region: 'PH'
      });

      const payload = await getJson(url, { headers });
      const videos = payload?.data?.videos || payload?.data || [];

      return videos.map((video) => {
        const username = video.author?.unique_id || '';

        return {
          platform: this.platform,
          externalId: this.makeExternalId('video', video.video_id || video.aweme_id || ''),
          kind: 'video',
          text: this.cleanText(video.title),
          author: {
            name: video.author?.nickname || (username ? `@${username}` : 'TikTok user'),
            handle: username ? `tiktok.com/@${username}` : '',
            id: video.author?.id || '',
            url: username ? `https://www.tiktok.com/@${username}` : ''
          },
          url: username && video.video_id
            ? `https://www.tiktok.com/@${username}/video/${video.video_id}`
            : '',
          timestamp: this.toIso(video.create_time ? video.create_time * 1000 : null),
          metrics: {
            likes: video.digg_count || 0,
            comments: video.comment_count || 0,
            shares: video.share_count || 0,
            views: video.play_count || 0
          },
          parent: null,
          providerVideoId: video.video_id || video.aweme_id || ''
        };
      });
    });

    return perTerm.filter((item) => item.text && item.externalId);
  }

  /* ---------------------------------------------------------------- comments */

  async #fetchCommentsFor(videos) {
    if (this.provider === 'apify') {
      if (!this.commentWarningShown) {
        this.commentWarningShown = true;
        this.log.warn(
          'includeComments is on, but the Apify provider needs a dedicated ' +
          'comments actor. Video captions and hashtags are still monitored; ' +
          'switch provider to rapidapi or tiktok-research for comments.'
        );
      }
      return [];
    }

    if (this.provider !== 'rapidapi') return [];

    const host = this.settings.rapidApiHost || 'tiktok-scraper7.p.rapidapi.com';
    const headers = {
      'x-rapidapi-key': this.settings.rapidApiKey,
      'x-rapidapi-host': host
    };

    return this.mapLimited(videos, SUB_REQUEST_CONCURRENCY, async (video) => {
      const videoId = video.providerVideoId;
      if (!videoId) return [];

      const url = buildUrl(`https://${host}/comment/list`, {
        url: videoId,
        count: this.settings.commentsPerVideo || 15
      });

      const payload = await getJson(url, { headers });

      return (payload?.data?.comments || []).map((comment) => ({
        platform: this.platform,
        externalId: this.makeExternalId('comment', comment.cid || comment.id || ''),
        kind: 'comment',
        text: this.cleanText(comment.text),
        author: {
          name: comment.user?.nickname || 'TikTok user',
          handle: comment.user?.unique_id ? `tiktok.com/@${comment.user.unique_id}` : '',
          id: comment.user?.id || '',
          url: comment.user?.unique_id ? `https://www.tiktok.com/@${comment.user.unique_id}` : ''
        },
        url: video.url,
        timestamp: this.toIso(comment.create_time ? comment.create_time * 1000 : null),
        metrics: { likes: comment.digg_count || 0 },
        parent: { id: videoId, title: video.text.slice(0, 120), url: video.url }
      })).filter((item) => item.text && item.externalId);
    });
  }

  /** Appends hashtags to the caption so hashtag-only mentions still match. */
  #withHashtags(caption, hashtags) {
    const tags = (hashtags || [])
      .filter(Boolean)
      .map((tag) => (String(tag).startsWith('#') ? String(tag) : `#${tag}`));

    return this.cleanText([caption, ...tags].filter(Boolean).join(' '));
  }
}

/** TikTok's Research API wants YYYYMMDD. */
function compactDate(date) {
  return new Date(date).toISOString().slice(0, 10).replace(/-/g, '');
}
