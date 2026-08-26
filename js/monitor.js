/**
 * Social Media Monitoring Engine
 * Monitors brand mentions across Facebook, YouTube, TikTok, Instagram, X, and Reddit.
 * Analyzes keyword matches, evaluates sentiment, detects crisis spikes, and dispatches notifications.
 */
import { StorageManager } from './storage.js';

const POSITIVE_WORDS = [
  'love', 'loved', 'great', 'awesome', 'excellent', 'amazing', 'best', 'fantastic',
  'superb', 'fast', 'reliable', 'helpful', 'top-notch', 'smooth', 'recommend', 'brilliant',
  'quality', 'modern', 'professional', 'trusted', 'beautiful', 'solid', 'efficient'
];

const NEGATIVE_WORDS = [
  'hate', 'hated', 'terrible', 'horrible', 'worst', 'broken', 'slow', 'delay',
  'delayed', 'scam', 'refund', 'fail', 'failed', 'disappointed', 'useless', 'complaint',
  'crack', 'overpriced', 'defect', 'issue', 'unresponsive', 'poor', 'frustrating'
];

export class MentionMonitor {
  constructor(onNewMentionCallback, onCrisisCallback) {
    this.onNewMention = onNewMentionCallback;
    this.onCrisis = onCrisisCallback;
    this.isStreaming = false;
    this.streamTimer = null;
    this.recentNegativeWindow = [];
    this.mentionIdCounter = 2000;
  }

  /**
   * Start stream listening at user-defined frequency
   */
  startStream() {
    if (this.isStreaming) return;
    this.isStreaming = true;

    const companyConfig = StorageManager.getCompanyConfig();
    const intervalMs = (companyConfig.checkIntervalSeconds || 10) * 1000;

    // Trigger initial scan
    this.fetchNextMention();

    this.streamTimer = setInterval(() => {
      this.fetchNextMention();
    }, intervalMs);
  }

  /**
   * Stop stream timer
   */
  stopStream() {
    this.isStreaming = false;
    if (this.streamTimer) {
      clearInterval(this.streamTimer);
      this.streamTimer = null;
    }
  }

  /**
   * Process raw social mention
   */
  processRawMention(rawMention) {
    const config = StorageManager.getCompanyConfig();
    const companyKeywords = [config.companyName, ...(config.brandAliases || [])].filter(Boolean);
    const excluded = (config.excludedTerms || []).filter(Boolean);

    const textLower = rawMention.text.toLowerCase();

    for (const ex of excluded) {
      if (textLower.includes(ex.toLowerCase())) {
        return null;
      }
    }

    let matchedKeyword = companyKeywords.find(kw => textLower.includes(kw.toLowerCase()));
    if (!matchedKeyword && companyKeywords.length > 0) {
      matchedKeyword = companyKeywords[0];
    }

    const sentimentResult = this.analyzeSentiment(rawMention.text);

    const processed = {
      id: 'm_' + Date.now() + '_' + (++this.mentionIdCounter),
      timestamp: rawMention.timestamp || new Date().toISOString(),
      platform: rawMention.platform || 'Facebook',
      authorName: rawMention.authorName || 'Anonymous',
      authorHandle: rawMention.authorHandle || '@user',
      text: rawMention.text,
      matchedKeyword: matchedKeyword || config.companyName,
      sentiment: rawMention.sentiment || sentimentResult.sentiment,
      sentimentScore: sentimentResult.score,
      url: rawMention.url || '#',
      unread: true
    };

    if (processed.sentiment === 'negative') {
      this.evaluateCrisisSpike(processed);
    }

    return processed;
  }

  analyzeSentiment(text) {
    const tokens = text.toLowerCase().match(/\b[a-z0-9'-]+\b/g) || [];
    let posCount = 0;
    let negCount = 0;

    for (const word of tokens) {
      if (POSITIVE_WORDS.includes(word)) posCount++;
      if (NEGATIVE_WORDS.includes(word)) negCount++;
    }

    const score = posCount - negCount;
    let sentiment = 'neutral';
    if (score > 0) sentiment = 'positive';
    if (score < 0) sentiment = 'negative';

    return { sentiment, score, posCount, negCount };
  }

  evaluateCrisisSpike(negativeMention) {
    const now = Date.now();
    const windowMs = 5 * 60 * 1000;

    this.recentNegativeWindow.push(now);
    this.recentNegativeWindow = this.recentNegativeWindow.filter(ts => (now - ts) <= windowMs);

    const notifConfig = StorageManager.getNotificationConfig();
    const threshold = notifConfig.crisisThreshold || 3;

    if (this.recentNegativeWindow.length >= threshold) {
      if (this.onCrisis) {
        this.onCrisis({
          count: this.recentNegativeWindow.length,
          windowMinutes: 5,
          latestMention: negativeMention
        });
      }
    }
  }

  fetchNextMention() {
    const mockPool = [
      {
        platform: 'Facebook',
        authorName: 'Cebu Property Buyers Group',
        authorHandle: 'facebook.com/cebuproperties',
        text: 'Highly recommending CEBU RITEHOMES DEVELOPMENT & REALTY CORP.! Their new residential subdivision in Mandaue has top-notch build quality and smooth transaction process 🏠✨',
        sentiment: 'positive'
      },
      {
        platform: 'YouTube',
        authorName: 'Cebu House Tour Vlogs',
        authorHandle: 'youtube.com/@cebuhousetours',
        text: 'FULL TOUR: Inside the latest structural project constructed by ROVEN TECHNIC CONSTRUCTION. Solid concrete foundations and beautiful modern finishes!',
        sentiment: 'positive'
      },
      {
        platform: 'TikTok',
        authorName: 'RealEstateCebu',
        authorHandle: '@cebu_realty_tips',
        text: 'Checking out the model unit at CEBU RITEHOMES DEVELOPMENT & REALTY CORP. Is this worth buying in 2026? Comment below! #CebuRealEstate #Ritehomes',
        sentiment: 'neutral'
      },
      {
        platform: 'Instagram',
        authorName: 'RovenTechnicProjects',
        authorHandle: '@roventechnic_official',
        text: 'Milestone reached! Commercial site construction update by ROVEN TECHNIC CONSTRUCTION. Progressing fast and on schedule 🏗️👷‍♂️',
        sentiment: 'positive'
      },
      {
        platform: 'Facebook',
        authorName: 'Maria Santos',
        authorHandle: 'facebook.com/maria.santos',
        text: 'Inquiring about site turnover timeline for CEBU RITEHOMES DEVELOPMENT & REALTY CORP. Customer service team was very responsive.',
        sentiment: 'positive'
      },
      {
        platform: 'YouTube',
        authorName: 'Civil Engineering Reviews PH',
        authorHandle: 'youtube.com/@civil_ph',
        text: 'Analyzing structural materials used by ROVEN TECHNIC CONSTRUCTION in recent commercial building projects in Cebu City.',
        sentiment: 'neutral'
      },
      {
        platform: 'TikTok',
        authorName: 'CebuHomeowner',
        authorHandle: '@cebu_homeowner_99',
        text: 'Delayed update on turnover schedule from CEBU RITEHOMES DEVELOPMENT & REALTY CORP. Hope they resolve contractor delays soon!',
        sentiment: 'negative'
      },
      {
        platform: 'Instagram',
        authorName: 'CebuArchitectureDaily',
        authorHandle: '@cebu_arch_daily',
        text: 'Stunning facade work completed by ROVEN TECHNIC CONSTRUCTION in IT Park Cebu. Looks amazing! 🔥',
        sentiment: 'positive'
      }
    ];

    const item = mockPool[Math.floor(Math.random() * mockPool.length)];
    const processed = this.processRawMention(item);

    if (processed && this.onNewMention) {
      this.onNewMention(processed);
    }
  }
}
