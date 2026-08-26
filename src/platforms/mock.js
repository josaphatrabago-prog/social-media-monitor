/**
 * Mock connector - realistic synthetic mentions for demos and tests.
 *
 * This exists because every real connector needs credentials the system cannot
 * assume, and a monitoring dashboard that shows an empty feed is impossible to
 * evaluate. Mock mode produces the same normalised shape as a live connector,
 * so the pipeline, crisis detector, notifiers and dashboard all run against it
 * unchanged.
 *
 * It composes text from real company terms and vocabulary the sentiment lexicon
 * actually scores, in English, Tagalog and Bisaya, so the sentiment mix on the
 * dashboard is genuine output rather than a pre-labelled fixture.
 */
import { PlatformConnector } from './base.js';

const PLATFORMS = [
  { name: 'Facebook', kinds: ['post', 'comment'] },
  { name: 'YouTube', kinds: ['video', 'comment'] },
  { name: 'TikTok', kinds: ['video', 'comment'] },
  { name: 'Instagram', kinds: ['post', 'reel'] }
];

const POSITIVE_TEMPLATES = [
  'Highly recommending {term}! Top notch build quality and a smooth transaction all throughout.',
  'Turnover was on time and the finishing is well built. Salamat {term}!',
  'Nindot kaayo ang output sa {term}, professional ang team and very responsive sa questions.',
  'Solid workmanship from {term}. Worth every peso, no issues after 6 months.',
  '{term} delivered as promised. Maayo kaayo ang customer service, thank you!',
  'Sulit ang bayad sa {term} - clean turnover and matibay ang materials used.',
  'Ang ganda ng model unit ng {term}! Modern design and affordable din. {hashtag}'
];

const NEUTRAL_TEMPLATES = [
  'Anyone here with experience buying from {term}? Planning to inquire this week.',
  'Site visit today at the {term} project. Posting the full walkthrough later. {hashtag}',
  'Asking for the price list and payment terms of {term} po. Thanks in advance.',
  'FULL TOUR: inside the newest development by {term}. Comment your thoughts below.',
  'Comparing {term} with two other developers in Cebu. Anyone made a decision yet?',
  'Reviewing the structural materials specified by {term} in their commercial builds.',
  'Is {term} accredited with the local housing board? Just checking before we proceed.'
];

const NEGATIVE_TEMPLATES = [
  'Walang update sa turnover namin from {term}, 8 months na. Reklamo na talaga ko.',
  'Delayed turnover again from {term} and still no response from their office.',
  'Poor workmanship sa unit namin - cracked walls and leaking ceiling. {term} please fix this.',
  'Hindi pa tapos ang amenities na promised ng {term}. False advertising ba ito?',
  'Do not recommend {term}. Demand refund na kami, sobrang bagal ng processing.',
  'Structural issues na nakita sa {term} project. Sino pa may same problem? {hashtag}',
  'Bati kaayo ang service sa {term}, wala silay tubag sa amoang email for weeks.',
  'Second follow-up and still waiting for the {term} documents. Very frustrating.'
];

const FIRST_NAMES = [
  'Maria', 'Jun', 'Aileen', 'Rico', 'Grace', 'Dennis', 'Cherry', 'Mark',
  'Liza', 'Noel', 'Jessa', 'Arnel', 'Kim', 'Paolo', 'Rowena', 'Ferdie'
];

const LAST_NAMES = [
  'Santos', 'Dela Cruz', 'Abella', 'Ybanez', 'Gonzales', 'Lim', 'Tan',
  'Cabrera', 'Baclayon', 'Ceniza', 'Villanueva', 'Ompad'
];

const PAGE_NAMES = [
  'Cebu Property Buyers Group', 'Cebu Real Estate Watch', 'Mandaue Homeowners',
  'Cebu House Tour Vlogs', 'Civil Engineering Reviews PH', 'Cebu Condo Talk',
  'RealEstateCebu', 'CebuArchitectureDaily', 'Visayas Contractors Forum'
];

/** Default sentiment mix for a normal poll. */
const DEFAULT_MIX = { positive: 0.45, neutral: 0.35, negative: 0.2 };

export class MockConnector extends PlatformConnector {
  static platform = 'Mock';
  static key = 'mock';

  constructor(context) {
    super(context);

    this.counter = 0;
    this.pendingCrisis = 0;
    this.itemsPerPoll = context.itemsPerPoll ?? 3;
    this.mix = { ...DEFAULT_MIX, ...(context.mix || {}) };

    /**
     * When set, every generated item claims this platform. The registry gives
     * each platform slot its own generator, so an item attributed to the
     * Facebook poll really is a Facebook item.
     */
    this.forcePlatform = context.forcePlatform || null;
  }

  missingCredentials() {
    return [];
  }

  get statusReason() {
    return 'synthetic data (mock mode)';
  }

  /**
   * Queues a burst of negative mentions so crisis detection can be exercised
   * on demand from the dashboard.
   */
  queueCrisis(count = 6) {
    this.pendingCrisis += Math.max(1, count);
    this.log.warn(`queued ${count} synthetic negative mentions for the next poll`);
  }

  async fetch({ limit }) {
    const companies = this.matcher?.companies || [];
    if (companies.length === 0) return [];

    const burst = this.pendingCrisis;
    this.pendingCrisis = 0;

    const total = burst > 0 ? burst : this.itemsPerPoll;
    const items = [];

    for (let index = 0; index < total; index += 1) {
      const sentiment = burst > 0 ? 'negative' : this.#pickSentiment();
      items.push(this.#makeItem(companies, sentiment, index));
    }

    return limit ? items.slice(0, limit) : items;
  }

  #pickSentiment() {
    const roll = Math.random();
    if (roll < this.mix.negative) return 'negative';
    if (roll < this.mix.negative + this.mix.neutral) return 'neutral';
    return 'positive';
  }

  #makeItem(companies, sentiment, offset) {
    const company = pick(companies);
    const platform = this.forcePlatform
      ? (PLATFORMS.find((entry) => entry.name === this.forcePlatform) ||
        { name: this.forcePlatform, kinds: ['post', 'comment'] })
      : pick(PLATFORMS);
    const kind = pick(platform.kinds);

    const templates = sentiment === 'negative'
      ? NEGATIVE_TEMPLATES
      : (sentiment === 'neutral' ? NEUTRAL_TEMPLATES : POSITIVE_TEMPLATES);

    const term = pick([company.name, ...(company.aliases || [])].filter(Boolean));
    const hashtag = pick(company.hashtags || []) || '';

    const text = pick(templates)
      .replace(/\{term\}/g, term)
      .replace(/\{hashtag\}/g, hashtag)
      .replace(/\s+/g, ' ')
      .trim();

    this.counter += 1;
    const id = `mock-${Date.now().toString(36)}-${this.counter}-${offset}`;
    const isPage = kind === 'post' && Math.random() < 0.4;
    const authorName = isPage
      ? pick(PAGE_NAMES)
      : `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
    const handle = slugify(authorName);

    // Spread timestamps over the last few minutes so the volume chart and the
    // sliding crisis window both have something realistic to work with.
    const ageMs = Math.floor(Math.random() * 4 * 60 * 1000);

    return {
      platform: platform.name,
      externalId: `mock:${platform.name.toLowerCase()}:${id}`,
      kind,
      text,
      author: {
        name: authorName,
        handle: `${platform.name.toLowerCase()}.com/${handle}`,
        id: handle,
        url: `https://example.invalid/${handle}`
      },
      // A clearly non-routable host, so nobody mistakes demo data for a real post.
      url: `https://example.invalid/${platform.name.toLowerCase()}/${id}`,
      timestamp: new Date(Date.now() - ageMs).toISOString(),
      metrics: {
        likes: randomInt(0, 400),
        comments: randomInt(0, 60),
        shares: randomInt(0, 25),
        views: kind === 'video' || kind === 'reel' ? randomInt(200, 90000) : 0
      },
      parent: kind === 'comment'
        ? {
          id: `mock-parent-${this.counter}`,
          title: `${term} project update`,
          url: `https://example.invalid/${platform.name.toLowerCase()}/parent-${this.counter}`
        }
        : null,
      isMock: true
    };
  }
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
}
