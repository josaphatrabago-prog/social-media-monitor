/**
 * Crisis spike detection over a sliding window.
 *
 * Two independent rules can fire, because either alone misses real incidents:
 *
 *   - absolute: negatives in the window reach the configured threshold. This is
 *     the rule the brief asks for and it catches a cold-start pile-on.
 *   - relative: negatives run at `baselineMultiplier` times the recent
 *     baseline. This catches a spike on an account that always carries some
 *     background complaints, where the absolute threshold is met every window
 *     and would otherwise never look unusual.
 *
 * A cooldown stops one incident from paging the on-call every poll, but an
 * escalation (materially more negatives than when it last fired) breaks
 * through the cooldown - going quiet while a crisis is still growing is worse
 * than a duplicate alert.
 */
import { createLogger } from '../log.js';

const log = createLogger('crisis');

/** How many trailing windows are averaged for the baseline. */
const BASELINE_WINDOWS = 8;

/** The relative rule needs at least this many negatives to avoid noise. */
const MIN_NEGATIVES_FOR_RELATIVE_RULE = 3;

/** Re-alert inside a cooldown once the count grows by this fraction. */
const ESCALATION_GROWTH = 0.5;

export class CrisisDetector {
  /** @param {Object} options config.crisis */
  constructor(options = {}) {
    this.windowMinutes = options.windowMinutes ?? 15;
    this.negativeThreshold = options.negativeThreshold ?? 5;
    this.baselineMultiplier = options.baselineMultiplier ?? 3;
    this.cooldownMinutes = options.cooldownMinutes ?? 30;

    this.lastFiredAt = null;
    this.lastFiredCount = 0;
  }

  /** Mean negatives per window across the windows preceding the current one. */
  #baseline(store, now) {
    const windowMs = this.windowMinutes * 60 * 1000;
    const historyStart = now - (BASELINE_WINDOWS + 1) * windowMs;
    const currentWindowStart = now - windowMs;

    let count = 0;
    for (const mention of store.mentions) {
      if (mention.sentiment !== 'negative') continue;
      const time = new Date(mention.timestamp).getTime();
      if (Number.isNaN(time)) continue;
      if (time >= historyStart && time < currentWindowStart) count += 1;
    }

    return count / BASELINE_WINDOWS;
  }

  #severity(negativeCount) {
    if (negativeCount >= this.negativeThreshold * 3) return 'critical';
    if (negativeCount >= this.negativeThreshold * 2) return 'high';
    return 'elevated';
  }

  /** Current window state, whether or not an alert is warranted. */
  status(store, now = Date.now()) {
    const negatives = store.negativesInWindow(this.windowMinutes, now);
    const baseline = this.#baseline(store, now);
    const inCooldown = this.lastFiredAt !== null &&
      now - this.lastFiredAt < this.cooldownMinutes * 60 * 1000;

    return {
      windowMinutes: this.windowMinutes,
      negativeCount: negatives.length,
      threshold: this.negativeThreshold,
      baseline: Math.round(baseline * 100) / 100,
      baselineMultiplier: this.baselineMultiplier,
      inCooldown,
      cooldownEndsAt: inCooldown
        ? new Date(this.lastFiredAt + this.cooldownMinutes * 60 * 1000).toISOString()
        : null,
      lastFiredAt: this.lastFiredAt ? new Date(this.lastFiredAt).toISOString() : null,
      level: negatives.length >= this.negativeThreshold
        ? this.#severity(negatives.length)
        : 'normal'
    };
  }

  /**
   * @param {import('./store.js').MentionStore} store
   * @param {number} now
   * @returns {Object|null} the crisis event, or null when nothing should fire
   */
  evaluate(store, now = Date.now()) {
    const negatives = store.negativesInWindow(this.windowMinutes, now);
    const negativeCount = negatives.length;
    const baseline = this.#baseline(store, now);

    const absoluteRule = negativeCount >= this.negativeThreshold;
    const relativeRule = baseline > 0 &&
      negativeCount >= MIN_NEGATIVES_FOR_RELATIVE_RULE &&
      negativeCount >= baseline * this.baselineMultiplier;

    if (!absoluteRule && !relativeRule) return null;

    const cooldownMs = this.cooldownMinutes * 60 * 1000;
    const withinCooldown = this.lastFiredAt !== null && now - this.lastFiredAt < cooldownMs;
    const escalated = negativeCount >= this.lastFiredCount * (1 + ESCALATION_GROWTH) &&
      negativeCount > this.lastFiredCount;

    if (withinCooldown && !escalated) return null;

    this.lastFiredAt = now;
    this.lastFiredCount = negativeCount;

    // Which brands and platforms the negativity is concentrated in.
    const byCompany = new Map();
    const byPlatform = {};

    for (const mention of negatives) {
      byPlatform[mention.platform] = (byPlatform[mention.platform] || 0) + 1;

      for (const entry of mention.companies || []) {
        const bucket = byCompany.get(entry.companyId) ||
          { companyId: entry.companyId, companyName: entry.companyName, count: 0 };
        bucket.count += 1;
        byCompany.set(entry.companyId, bucket);
      }
    }

    const rules = [];
    if (absoluteRule) rules.push('absolute');
    if (relativeRule) rules.push('relative');

    const event = {
      type: 'crisis',
      triggeredAt: new Date(now).toISOString(),
      windowMinutes: this.windowMinutes,
      negativeCount,
      threshold: this.negativeThreshold,
      baseline: Math.round(baseline * 100) / 100,
      baselineMultiplier: this.baselineMultiplier,
      rules,
      escalated: withinCooldown && escalated,
      severity: this.#severity(negativeCount),
      companies: [...byCompany.values()].sort((a, b) => b.count - a.count),
      platforms: Object.entries(byPlatform)
        .map(([platform, count]) => ({ platform, count }))
        .sort((a, b) => b.count - a.count),
      // Worst three, so an alert shows what people are actually saying.
      samples: [...negatives]
        .sort((a, b) => (a.sentimentScore ?? 0) - (b.sentimentScore ?? 0))
        .slice(0, 3)
        .map((mention) => ({
          id: mention.id,
          platform: mention.platform,
          author: mention.author?.name || 'unknown',
          text: mention.text,
          url: mention.url,
          sentimentScore: mention.sentimentScore
        }))
    };

    log.warn(
      `CRISIS ${event.severity}: ${negativeCount} negative mention(s) in ` +
      `${this.windowMinutes}m (threshold ${this.negativeThreshold}, ` +
      `baseline ${event.baseline}, rules: ${rules.join('+')})`
    );

    return event;
  }

  /** Applies a live config change without losing cooldown state. */
  reconfigure(options = {}) {
    if (options.windowMinutes !== undefined) this.windowMinutes = options.windowMinutes;
    if (options.negativeThreshold !== undefined) this.negativeThreshold = options.negativeThreshold;
    if (options.baselineMultiplier !== undefined) this.baselineMultiplier = options.baselineMultiplier;
    if (options.cooldownMinutes !== undefined) this.cooldownMinutes = options.cooldownMinutes;
  }

  /** Clears cooldown state - used by the dashboard's "acknowledge" action. */
  reset() {
    this.lastFiredAt = null;
    this.lastFiredCount = 0;
  }
}

export function createCrisisDetector(options) {
  return new CrisisDetector(options);
}
