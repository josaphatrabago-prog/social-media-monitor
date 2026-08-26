/**
 * Polling scheduler.
 *
 * Each platform gets its own independently-timed slot, because the platforms do
 * not tolerate the same cadence: YouTube's search.list costs 100 quota units a
 * call while a TikTok scraper run costs money, so a single global interval is
 * either too slow for Facebook or too expensive for YouTube.
 *
 * Design choices worth knowing:
 *   - setTimeout chaining, not setInterval. A poll that takes longer than its
 *     own interval must not stack up behind itself.
 *   - `since` is computed from the last *successful* poll rather than "now
 *     minus lookback", so a failed or slow poll cannot silently skip a window.
 *   - Repeated failures back off exponentially. Hammering an API that is
 *     rate-limiting you is how a temporary 429 becomes a day-long block.
 */
import { EventEmitter } from 'node:events';
import { createLogger } from '../log.js';
import { describeSeconds, parseFrequency } from '../util/frequency.js';

const log = createLogger('scheduler');

/** Re-fetch a little before the last success, so a boundary item is not missed. */
const OVERLAP_SECONDS = 30;

const MAX_BACKOFF_MULTIPLIER = 8;

class Slot {
  constructor({ key, platform, connector, mode, reason, frequency }) {
    this.key = key;
    this.platform = platform;
    this.connector = connector;
    this.mode = mode;
    this.reason = reason;

    this.frequency = frequency;
    this.timer = null;

    this.lastRunAt = null;
    this.lastSuccessAt = null;
    this.nextRunAt = null;
    this.running = false;

    this.consecutiveErrors = 0;
    this.lastError = null;
    this.totals = { polls: 0, fetched: 0, matched: 0, added: 0, errors: 0 };
  }

  get runnable() {
    return Boolean(this.connector);
  }

  /** Milliseconds until the next run, honouring cron and error backoff. */
  delayMs(now = Date.now()) {
    if (this.frequency.kind === 'cron') {
      const next = this.frequency.cron.nextRun(new Date(now));
      return next ? Math.max(1000, next.getTime() - now) : 60000;
    }

    const backoff = Math.min(2 ** this.consecutiveErrors, MAX_BACKOFF_MULTIPLIER);
    return this.frequency.seconds * 1000 * backoff;
  }

  status() {
    return {
      key: this.key,
      platform: this.platform,
      mode: this.mode,
      reason: this.reason,
      runnable: this.runnable,
      frequency: this.frequency.source,
      frequencyLabel: this.frequency.label,
      running: this.running,
      lastRunAt: this.lastRunAt ? new Date(this.lastRunAt).toISOString() : null,
      lastSuccessAt: this.lastSuccessAt ? new Date(this.lastSuccessAt).toISOString() : null,
      nextRunAt: this.nextRunAt ? new Date(this.nextRunAt).toISOString() : null,
      consecutiveErrors: this.consecutiveErrors,
      lastError: this.lastError,
      totals: { ...this.totals }
    };
  }
}

export class Scheduler extends EventEmitter {
  /**
   * @param {Object} options
   * @param {Array} options.slots      from createConnectors()
   * @param {Object} options.pipeline
   * @param {Object} options.matcher
   * @param {Object} options.monitoring config.monitoring
   */
  constructor({ slots, pipeline, matcher, monitoring }) {
    super();
    this.pipeline = pipeline;
    this.matcher = matcher;
    this.monitoring = monitoring;
    this.paused = Boolean(monitoring.startPaused);
    this.started = false;

    this.slots = slots.map((slot) => new Slot({
      ...slot,
      frequency: this.#frequencyFor(slot.key)
    }));
  }

  #frequencyFor(platformKey) {
    const override = this.monitoring.perPlatform?.[platformKey];
    return parseFrequency(override || this.monitoring.frequency);
  }

  get runnableSlots() {
    return this.slots.filter((slot) => slot.runnable);
  }

  start() {
    if (this.started) return this;
    this.started = true;

    if (this.runnableSlots.length === 0) {
      log.warn('no runnable platforms - nothing will be polled');
      return this;
    }

    for (const slot of this.runnableSlots) {
      log.info(`${slot.platform}: ${slot.frequency.label} (${slot.mode})`);
      // First poll is immediate so the dashboard is not empty on launch.
      this.#schedule(slot, this.paused ? slot.delayMs() : 0);
    }

    return this;
  }

  stop() {
    for (const slot of this.slots) {
      if (slot.timer) clearTimeout(slot.timer);
      slot.timer = null;
      slot.nextRunAt = null;
    }
    this.started = false;
    log.info('stopped');
    this.emit('state', this.status());
  }

  pause() {
    if (this.paused) return this.status();
    this.paused = true;
    log.info('paused');
    this.emit('state', this.status());
    return this.status();
  }

  resume() {
    if (!this.paused) return this.status();
    this.paused = false;
    log.info('resumed');

    // Bring every idle slot forward so resuming feels immediate.
    for (const slot of this.runnableSlots) {
      if (!slot.running) this.#schedule(slot, 0);
    }

    this.emit('state', this.status());
    return this.status();
  }

  #schedule(slot, delayOverride) {
    if (slot.timer) clearTimeout(slot.timer);

    const delay = delayOverride ?? slot.delayMs();
    slot.nextRunAt = Date.now() + delay;
    slot.timer = setTimeout(() => this.#runSlot(slot), delay);

    // Never let a pending poll keep the process alive on its own.
    if (typeof slot.timer.unref === 'function') slot.timer.unref();
  }

  /** The window this poll should ask each connector for. */
  #sinceFor(slot) {
    const lookbackMs = (this.monitoring.lookbackMinutes || 120) * 60 * 1000;
    const lookbackFloor = Date.now() - lookbackMs;

    if (!slot.lastSuccessAt) return new Date(lookbackFloor);

    const fromLastSuccess = slot.lastSuccessAt - OVERLAP_SECONDS * 1000;
    return new Date(Math.max(lookbackFloor, fromLastSuccess));
  }

  async #runSlot(slot) {
    if (this.paused) {
      this.#schedule(slot);
      return;
    }

    if (slot.running) {
      this.#schedule(slot);
      return;
    }

    slot.running = true;
    slot.lastRunAt = Date.now();
    slot.totals.polls += 1;
    this.emit('poll:start', { platform: slot.platform, key: slot.key });

    try {
      const items = await slot.connector.fetch({
        terms: this.matcher.queryTerms(),
        since: this.#sinceFor(slot),
        limit: this.monitoring.maxItemsPerPoll || 50
      });

      const summary = await this.pipeline.ingest(items, { source: slot.platform });

      slot.lastSuccessAt = Date.now();
      slot.consecutiveErrors = 0;
      slot.lastError = null;
      slot.totals.fetched += summary.received;
      slot.totals.matched += summary.matched;
      slot.totals.added += summary.added;

      this.emit('poll:done', { platform: slot.platform, key: slot.key, summary });
    } catch (error) {
      slot.consecutiveErrors += 1;
      slot.totals.errors += 1;
      slot.lastError = { message: error.message, at: new Date().toISOString() };

      const backoff = Math.min(2 ** slot.consecutiveErrors, MAX_BACKOFF_MULTIPLIER);
      log.error(
        `${slot.platform} poll failed (${slot.consecutiveErrors} in a row, ` +
        `backing off ${backoff}x): ${error.message}`
      );

      this.emit('poll:error', { platform: slot.platform, key: slot.key, error: error.message });
    } finally {
      slot.running = false;
      this.#schedule(slot);
      this.emit('state', this.status());
    }
  }

  /**
   * Forces an immediate poll.
   * @param {string} [platformKey] one platform, or every runnable one
   */
  runNow(platformKey) {
    const targets = platformKey
      ? this.runnableSlots.filter((slot) => slot.key === platformKey)
      : this.runnableSlots;

    if (targets.length === 0) {
      throw new Error(
        platformKey
          ? `no runnable platform "${platformKey}"`
          : 'no runnable platforms'
      );
    }

    for (const slot of targets) {
      if (!slot.running) this.#schedule(slot, 0);
    }

    return targets.map((slot) => slot.platform);
  }

  /**
   * Changes the polling frequency at runtime.
   * @param {string|number} frequency
   * @param {string} [platformKey] omit to change every platform
   */
  setFrequency(frequency, platformKey) {
    const parsed = parseFrequency(frequency);
    const targets = platformKey
      ? this.slots.filter((slot) => slot.key === platformKey)
      : this.slots;

    if (targets.length === 0) throw new Error(`unknown platform "${platformKey}"`);

    for (const slot of targets) {
      slot.frequency = parsed;
      if (slot.runnable && this.started && !slot.running) this.#schedule(slot);
    }

    log.info(
      `frequency set to ${parsed.label} for ` +
      `${platformKey || 'all platforms'}`
    );

    this.emit('state', this.status());
    return { frequency: parsed.source, label: parsed.label, platforms: targets.map((s) => s.platform) };
  }

  /** Rebuilds slot timing after config.monitoring changed. */
  applyMonitoringConfig(monitoring) {
    this.monitoring = monitoring;

    for (const slot of this.slots) {
      slot.frequency = this.#frequencyFor(slot.key);
      if (slot.runnable && this.started && !slot.running) this.#schedule(slot);
    }

    this.emit('state', this.status());
  }

  status() {
    return {
      started: this.started,
      paused: this.paused,
      globalFrequency: this.monitoring.frequency,
      globalFrequencyLabel: parseFrequency(this.monitoring.frequency).label,
      lookbackMinutes: this.monitoring.lookbackMinutes,
      platforms: this.slots.map((slot) => slot.status())
    };
  }
}

export function createScheduler(options) {
  return new Scheduler(options);
}

export { describeSeconds };
