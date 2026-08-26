/**
 * Facebook Graph API connector.
 *
 * Important scope limitation, stated up front because it shapes the whole
 * design: Facebook has had NO public keyword search for posts since Graph API
 * v2.0 (the old /search?type=post was removed in 2015). Nothing you can do with
 * an access token will search "all of Facebook" for a brand name.
 *
 * What is actually reachable, and what this connector reads:
 *   - posts and comments on Pages you hold a token for  -> /{page-id}/feed
 *   - posts that tag or mention your Page               -> /{page-id}/tagged
 *   - posts in Groups where your app is installed       -> /{group-id}/feed
 *
 * Everything fetched is then keyword-filtered by the pipeline's matcher, so a
 * Page's own feed still surfaces only brand-relevant discussion.
 *
 * For wider coverage - competitor Pages, public groups you do not administer,
 * or general public chatter - configure platforms.aggregator with a provider
 * (Apify / RapidAPI). Meta's own Content Library and the retired CrowdTangle
 * are the only first-party routes to broad public search, and both require
 * separate approval.
 *
 * Video captions have the same ownership constraint: /{video-id}/captions works
 * only for videos on a Page you control. Post text, descriptions and comments
 * are read for every reachable video.
 */
import { PlatformConnector, SUB_REQUEST_CONCURRENCY } from './base.js';
import { buildUrl, getJson } from '../util/http.js';

const DEFAULT_API_VERSION = 'v21.0';
const GRAPH_ROOT = 'https://graph.facebook.com';
const COMMENTS_PER_POST = 25;

export class FacebookConnector extends PlatformConnector {
  static platform = 'Facebook';
  static key = 'facebook';

  constructor(context) {
    super(context);
    this.sourceWarningShown = false;
  }

  missingCredentials() {
    const missing = [];
    if (!this.settings.accessToken) missing.push('FB_ACCESS_TOKEN');

    const hasSource = (this.settings.pageIds || []).length > 0 ||
      (this.settings.searchGroups || []).length > 0;
    if (!hasSource) missing.push('platforms.facebook.pageIds or searchGroups');

    return missing;
  }

  get apiBase() {
    return `${GRAPH_ROOT}/${this.settings.apiVersion || DEFAULT_API_VERSION}`;
  }

  async fetch({ since, limit }) {
    const token = this.settings.accessToken;
    const sinceUnix = since ? Math.floor(new Date(since).getTime() / 1000) : undefined;

    if (!this.sourceWarningShown) {
      this.sourceWarningShown = true;
      this.log.info(
        `reading ${(this.settings.pageIds || []).length} page(s) and ` +
        `${(this.settings.searchGroups || []).length} group(s); ` +
        'Facebook has no public post search, so coverage is limited to these sources'
      );
    }

    const pageIds = this.settings.pageIds || [];
    const groupIds = this.settings.searchGroups || [];

    const pageItems = await this.mapLimited(
      pageIds,
      SUB_REQUEST_CONCURRENCY,
      (pageId) => this.#fetchPage(pageId, sinceUnix, token)
    );

    const groupItems = await this.mapLimited(
      groupIds,
      SUB_REQUEST_CONCURRENCY,
      (groupId) => this.#fetchFeed(`${this.apiBase}/${groupId}/feed`, sinceUnix, token, 'group')
    );

    return this.applyWindow([...pageItems, ...groupItems], { since, limit });
  }

  /** A Page's own feed plus, when permitted, posts tagging the Page. */
  async #fetchPage(pageId, sinceUnix, token) {
    const items = await this.#fetchFeed(
      `${this.apiBase}/${pageId}/feed`,
      sinceUnix,
      token,
      'page'
    );

    let tagged = [];
    try {
      tagged = await this.#fetchFeed(
        `${this.apiBase}/${pageId}/tagged`,
        sinceUnix,
        token,
        'tagged'
      );
    } catch (error) {
      // /tagged needs pages_read_engagement plus the Page itself being taggable.
      this.log.debug(`tagged feed unavailable for ${pageId}: ${error.message}`);
    }

    return [...items, ...tagged];
  }

  /**
   * One feed edge, expanding comments inline via field expansion so each post
   * costs a single request rather than one per post.
   */
  async #fetchFeed(endpoint, sinceUnix, token, sourceKind) {
    const commentFields = this.settings.includeComments
      ? `,comments.limit(${COMMENTS_PER_POST}){id,message,created_time,permalink_url,from{name,id},like_count}`
      : '';

    const url = buildUrl(endpoint, {
      fields:
        'id,message,story,created_time,permalink_url,from{name,id},' +
        'attachments{title,description,media_type},' +
        'shares,reactions.summary(true).limit(0)' +
        commentFields,
      limit: Math.min(50, this.monitoring.maxItemsPerPoll || 25),
      since: sinceUnix,
      access_token: token
    });

    const payload = await getJson(url);
    const items = [];

    for (const post of payload.data || []) {
      const attachment = post.attachments?.data?.[0] || {};

      // Some posts carry no message but do carry an attachment description
      // (a shared video, for instance), which is where the brand name lives.
      const text = this.cleanText([
        post.message,
        post.story,
        attachment.title,
        attachment.description
      ].filter(Boolean).join(' - '));

      const postUrl = post.permalink_url || `https://www.facebook.com/${post.id}`;

      if (text) {
        items.push({
          platform: this.platform,
          externalId: this.makeExternalId(sourceKind === 'tagged' ? 'tagged' : 'post', post.id),
          kind: 'post',
          text,
          author: {
            name: this.cleanText(post.from?.name) || 'Facebook user',
            handle: post.from?.id ? `facebook.com/${post.from.id}` : '',
            id: post.from?.id || '',
            url: post.from?.id ? `https://www.facebook.com/${post.from.id}` : ''
          },
          url: postUrl,
          timestamp: this.toIso(post.created_time),
          metrics: {
            shares: post.shares?.count || 0,
            likes: post.reactions?.summary?.total_count || 0,
            comments: post.comments?.data?.length || 0
          },
          parent: null
        });
      }

      for (const comment of post.comments?.data || []) {
        const commentText = this.cleanText(comment.message);
        if (!commentText) continue;

        items.push({
          platform: this.platform,
          externalId: this.makeExternalId('comment', comment.id),
          kind: 'comment',
          text: commentText,
          author: {
            name: this.cleanText(comment.from?.name) || 'Facebook user',
            handle: comment.from?.id ? `facebook.com/${comment.from.id}` : '',
            id: comment.from?.id || '',
            url: comment.from?.id ? `https://www.facebook.com/${comment.from.id}` : ''
          },
          url: comment.permalink_url || postUrl,
          timestamp: this.toIso(comment.created_time),
          metrics: { likes: comment.like_count || 0 },
          parent: { id: post.id, title: text.slice(0, 120), url: postUrl }
        });
      }
    }

    return items;
  }
}
