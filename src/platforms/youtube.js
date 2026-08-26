/**
 * YouTube Data API v3 connector.
 *
 * Covers video titles, descriptions and top comments with a plain API key.
 *
 * Transcripts are deliberately NOT fetched here. The captions endpoints
 * (captions.list / captions.download) require an OAuth2 token owned by the
 * channel that uploaded the video, so an API key cannot read the transcript of
 * someone else's upload. Rather than pretend, `includeCaptions` logs once and
 * defers to a transcript provider configured under platforms.aggregator.
 *
 * Quota notes, because this is the easiest way to burn a YouTube project:
 *   search.list costs 100 units per call, commentThreads.list costs 1, and the
 *   default daily quota is 10,000 units. One search term polled every 5 minutes
 *   is 100 x 12 x 24 = 28,800 units/day, which is over quota. Poll YouTube at
 *   15 minutes or slower (monitoring.perPlatform.youtube) when tracking several
 *   terms.
 */
import { PlatformConnector, SUB_REQUEST_CONCURRENCY } from './base.js';
import { buildUrl, getJson } from '../util/http.js';

const API_ROOT = 'https://www.googleapis.com/youtube/v3';
const MAX_RESULTS_PER_SEARCH = 50;

export class YouTubeConnector extends PlatformConnector {
  static platform = 'YouTube';
  static key = 'youtube';

  constructor(context) {
    super(context);
    this.captionWarningShown = false;
  }

  missingCredentials() {
    return this.settings.apiKey ? [] : ['YOUTUBE_API_KEY'];
  }

  async fetch({ terms, since, limit }) {
    const apiKey = this.settings.apiKey;
    const collected = [];

    for (const term of terms) {
      const videos = await this.#searchVideos(term, since, apiKey);
      collected.push(...videos.items);

      if (this.settings.includeComments && videos.videoIds.length) {
        const comments = await this.mapLimited(
          videos.videoIds,
          SUB_REQUEST_CONCURRENCY,
          (video) => this.#fetchComments(video, apiKey)
        );
        collected.push(...comments);
      }
    }

    if (this.settings.includeCaptions && !this.captionWarningShown) {
      this.captionWarningShown = true;
      this.log.warn(
        'includeCaptions is on, but captions.download needs an OAuth2 token from ' +
        'the uploading channel - an API key cannot read third-party transcripts. ' +
        'Titles and descriptions are still searched. Configure a transcript ' +
        'provider under platforms.aggregator to cover transcripts.'
      );
    }

    return this.applyWindow(dedupeByExternalId(collected), { since, limit });
  }

  /** search.list restricted to videos, newest first. */
  async #searchVideos(term, since, apiKey) {
    const url = buildUrl(`${API_ROOT}/search`, {
      part: 'snippet',
      q: term,
      type: 'video',
      order: 'date',
      maxResults: Math.min(MAX_RESULTS_PER_SEARCH, this.monitoring.maxItemsPerPoll || 25),
      publishedAfter: since ? new Date(since).toISOString() : undefined,
      regionCode: this.settings.regionCode || undefined,
      relevanceLanguage: this.settings.relevanceLanguage || undefined,
      key: apiKey
    });

    const payload = await getJson(url);
    const items = [];
    const videoIds = [];

    for (const entry of payload.items || []) {
      const videoId = entry.id?.videoId;
      if (!videoId) continue;

      const snippet = entry.snippet || {};
      videoIds.push({ id: videoId, title: this.cleanText(snippet.title) });

      items.push({
        platform: this.platform,
        externalId: this.makeExternalId('video', videoId),
        kind: 'video',
        // Title and description are analysed together: a brand is often only
        // named in the description while the title stays generic.
        text: [this.cleanText(snippet.title), this.cleanText(snippet.description)]
          .filter(Boolean)
          .join(' - '),
        author: {
          name: this.cleanText(snippet.channelTitle) || 'Unknown channel',
          handle: snippet.channelId ? `youtube.com/channel/${snippet.channelId}` : '',
          id: snippet.channelId || '',
          url: snippet.channelId ? `https://www.youtube.com/channel/${snippet.channelId}` : ''
        },
        url: `https://www.youtube.com/watch?v=${videoId}`,
        timestamp: this.toIso(snippet.publishedAt),
        metrics: {},
        parent: null
      });
    }

    return { items, videoIds };
  }

  /** commentThreads.list for one video. */
  async #fetchComments(video, apiKey) {
    const url = buildUrl(`${API_ROOT}/commentThreads`, {
      part: 'snippet',
      videoId: video.id,
      order: 'relevance',
      textFormat: 'plainText',
      maxResults: this.settings.commentsPerVideo || 20,
      key: apiKey
    });

    let payload;
    try {
      payload = await getJson(url);
    } catch (error) {
      // Comments disabled on a video is a 403, not a failure worth alerting on.
      this.log.debug(`comments unavailable for ${video.id}: ${error.message}`);
      return [];
    }

    return (payload.items || []).map((thread) => {
      const comment = thread.snippet?.topLevelComment;
      const snippet = comment?.snippet || {};

      return {
        platform: this.platform,
        externalId: this.makeExternalId('comment', comment?.id || thread.id),
        kind: 'comment',
        text: this.cleanText(snippet.textDisplay || snippet.textOriginal),
        author: {
          name: this.cleanText(snippet.authorDisplayName) || 'Unknown',
          handle: snippet.authorChannelUrl || '',
          id: snippet.authorChannelId?.value || '',
          url: snippet.authorChannelUrl || ''
        },
        url: `https://www.youtube.com/watch?v=${video.id}&lc=${comment?.id || ''}`,
        timestamp: this.toIso(snippet.publishedAt),
        metrics: { likes: snippet.likeCount || 0 },
        parent: {
          id: video.id,
          title: video.title,
          url: `https://www.youtube.com/watch?v=${video.id}`
        }
      };
    }).filter((item) => item.text);
  }
}

/** The same video can come back for several search terms. */
function dedupeByExternalId(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.externalId)) return false;
    seen.add(item.externalId);
    return true;
  });
}
