/**
 * Notification dispatcher.
 *
 * Routes one event to every channel subscribed to it, with three protections
 * that matter more than the delivery code itself:
 *
 *   - Event routing: each channel declares the events it wants, so a marketing
 *     Discord can take crises only while ops Slack takes every negative.
 *   - Rate limiting: a shared token bucket. Without it, a 40-comment pile-on
 *     posts 40 Slack messages and the channel gets muted by a human, which is
 *     exactly when alerting stops working.
 *   - Isolation: channels are dispatched with allSettled, so a dead webhook
 *     never blocks the email that would have woken somebody up.
 *
 * Desktop notifications are not delivered here. They are pushed to connected
 * dashboards over SSE via the `onDesktop` callback, because the browser owns
 * the Notification permission.
 */
import { deliverWebhook } from './webhook.js';
import { deliverEmail } from './email.js';
import { createLogger } from '../log.js';

const log = createLogger('notify');

/** Events a mention can raise, given its sentiment. */
function eventNamesFor(mention) {
  return ['mention.any', `mention.${mention.sentiment}`];
}

function wants(channel, eventNames) {
  const subscribed = channel.events || [];
  return eventNames.some((name) => subscribed.includes(name));
}

/** Fixed-window token bucket. */
class RateLimiter {
  constructor(maxPerMinute) {
    this.maxPerMinute = maxPerMinute;
    this.windowStart = 0;
    this.count = 0;
    this.suppressed = 0;
  }

  /** @returns {boolean} true when the caller may send */
  take(now = Date.now()) {
    if (this.maxPerMinute <= 0) return true;

    const minute = Math.floor(now / 60000);
    if (minute !== this.windowStart) {
      if (this.suppressed > 0) {
        log.warn(`rate limit suppressed ${this.suppressed} notification(s) in the previous minute`);
      }
      this.windowStart = minute;
      this.count = 0;
      this.suppressed = 0;
    }

    if (this.count >= this.maxPerMinute) {
      this.suppressed += 1;
      return false;
    }

    this.count += 1;
    return true;
  }
}

export class NotificationDispatcher {
  /**
   * @param {Object} options
   * @param {Object} options.config          resolved config
   * @param {Function} [options.onDesktop]   (payload) => void, pushes over SSE
   * @param {Function} [options.onDelivery]  (record) => void, for the audit log
   */
  constructor({ config, onDesktop, onDelivery } = {}) {
    this.onDesktop = onDesktop || (() => {});
    this.onDelivery = onDelivery || (() => {});
    this.reconfigure(config);
  }

  reconfigure(config) {
    this.settings = config.notifications;
    this.limiter = new RateLimiter(this.settings.rateLimit?.maxPerMinute ?? 30);
  }

  /** Channels that would receive `eventNames`, with a ready/blocked reason. */
  channelsFor(eventNames) {
    const channels = [];

    const { desktop, webhooks = [], email } = this.settings;

    if (desktop?.enabled && wants(desktop, eventNames)) {
      channels.push({ kind: 'desktop', name: 'Browser push', ready: true });
    }

    for (const hook of webhooks) {
      if (!hook.enabled || !wants(hook, eventNames)) continue;
      channels.push({
        kind: 'webhook',
        name: hook.name || hook.type,
        ready: Boolean(hook.url),
        reason: hook.url ? null : 'no URL configured',
        hook
      });
    }

    if (email?.enabled && wants(email, eventNames)) {
      const ready = Boolean(email.smtp?.host && (email.to || []).length);
      channels.push({
        kind: 'email',
        name: `Email (${(email.to || []).length} recipient(s))`,
        ready,
        reason: ready ? null : 'SMTP host or recipient list is empty'
      });
    }

    return channels;
  }

  /**
   * @param {'mention'|'crisis'} kind
   * @param {Object} data mention or crisis event
   * @returns {Promise<{event: string, delivered: Array, skipped: Array}>}
   */
  async dispatch(kind, data) {
    const eventNames = kind === 'crisis' ? ['crisis'] : eventNamesFor(data);
    const channels = this.channelsFor(eventNames);

    if (channels.length === 0) {
      return { event: eventNames.join('|'), delivered: [], skipped: [] };
    }

    // Crises always go out: they are exactly the moment the rate limit must
    // not silence the system.
    if (kind !== 'crisis' && !this.limiter.take()) {
      log.debug(`rate limited: dropped ${eventNames.join('|')} notification`);
      return {
        event: eventNames.join('|'),
        delivered: [],
        skipped: [{ name: 'all channels', reason: 'rate limited' }]
      };
    }

    const skipped = channels
      .filter((channel) => !channel.ready)
      .map((channel) => ({ name: channel.name, reason: channel.reason }));

    const runnable = channels.filter((channel) => channel.ready);

    const results = await Promise.allSettled(runnable.map((channel) => {
      if (channel.kind === 'webhook') return deliverWebhook(channel.hook, kind, data);
      if (channel.kind === 'email') return deliverEmail(this.settings.email, kind, data);

      // Desktop delivery is a local push, not a network call.
      this.onDesktop(this.buildDesktopPayload(kind, data));
      return Promise.resolve({ ok: true, name: channel.name });
    }));

    const delivered = results.map((result, index) => {
      const channel = runnable[index];
      if (result.status === 'fulfilled') {
        return { kind: channel.kind, name: channel.name, ...result.value };
      }
      return {
        kind: channel.kind,
        name: channel.name,
        ok: false,
        error: result.reason?.message || String(result.reason)
      };
    });

    const record = {
      timestamp: new Date().toISOString(),
      event: kind === 'crisis' ? 'crisis' : `mention.${data.sentiment}`,
      subject: kind === 'crisis'
        ? `${data.negativeCount} negative mentions in ${data.windowMinutes}m`
        : `${data.platform}: ${String(data.text).slice(0, 80)}`,
      delivered: delivered.filter((entry) => entry.ok).map((entry) => entry.name),
      failed: delivered.filter((entry) => !entry.ok).map((entry) => ({
        name: entry.name,
        error: entry.error
      })),
      skipped
    };

    this.onDelivery(record);
    return { event: record.event, delivered, skipped };
  }

  /** Shape the dashboard's service worker turns into a system notification. */
  buildDesktopPayload(kind, data) {
    if (kind === 'crisis') {
      return {
        kind: 'crisis',
        title: `🔥 CRISIS: ${data.negativeCount} negative mentions`,
        body: `${data.negativeCount} negative mentions in the last ${data.windowMinutes} minutes ` +
          `(threshold ${data.threshold}). ${data.companies.map((c) => c.companyName).join(', ')}`,
        tag: 'crisis',
        requireInteraction: true,
        severity: data.severity,
        url: '/'
      };
    }

    return {
      kind: 'mention',
      title: `${data.sentiment === 'negative' ? '🚨' : '📡'} ${data.platform} — ${data.sentiment} mention`,
      body: String(data.text).slice(0, 180),
      tag: `mention-${data.id}`,
      requireInteraction: data.sentiment === 'negative',
      severity: data.sentiment,
      url: data.url || '/'
    };
  }

  /**
   * Sends a synthetic alert to every configured channel, so a user can prove
   * the plumbing works before an incident.
   */
  async test(kind = 'mention') {
    const sample = kind === 'crisis'
      ? {
        type: 'crisis',
        triggeredAt: new Date().toISOString(),
        windowMinutes: 15,
        negativeCount: 7,
        threshold: 5,
        baseline: 0.5,
        baselineMultiplier: 3,
        rules: ['absolute'],
        escalated: false,
        severity: 'high',
        companies: [{ companyId: 'test', companyName: 'Test Brand', count: 7 }],
        platforms: [{ platform: 'Facebook', count: 4 }, { platform: 'TikTok', count: 3 }],
        samples: [{
          id: 'test-1',
          platform: 'Facebook',
          author: 'Test User',
          text: 'This is a TEST crisis alert from your Social Media Monitor. No action needed.',
          url: '',
          sentimentScore: -0.8
        }]
      }
      : {
        id: 'test-mention',
        platform: 'Facebook',
        kind: 'post',
        text: 'This is a TEST notification from your Social Media Monitor. No action needed.',
        author: { name: 'Test User', handle: 'facebook.com/test' },
        url: '',
        timestamp: new Date().toISOString(),
        sentiment: 'negative',
        sentimentScore: -0.5,
        companies: [{ companyId: 'test', companyName: 'Test Brand' }],
        matchedTerms: ['Test Brand']
      };

    log.info(`sending test ${kind} notification`);
    return this.dispatch(kind === 'crisis' ? 'crisis' : 'mention', sample);
  }
}

export function createDispatcher(options) {
  return new NotificationDispatcher(options);
}
