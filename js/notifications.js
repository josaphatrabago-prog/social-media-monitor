/**
 * Notifications Engine - Manages Browser Desktop Push Notifications,
 * Webhook dispatches (Slack/Discord/Custom), Audio Alerts, and Toast UI.
 */
import { StorageManager } from './storage.js';

export class NotificationEngine {
  constructor() {
    this.audioContext = null;
  }

  /**
   * Request native browser push notification permission
   */
  async requestPushPermission() {
    if (!('Notification' in window)) {
      return { success: false, reason: 'Notifications API not supported in this browser' };
    }

    try {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        this.showToast('Browser Push Notifications Enabled', 'You will receive desktop alerts for critical brand mentions.', 'info');
        return { success: true, permission };
      } else {
        this.showToast('Push Notifications Denied', 'Browser push permissions were denied or dismissed.', 'warning');
        return { success: false, permission };
      }
    } catch (e) {
      console.error('Error requesting push permission:', e);
      return { success: false, reason: e.message };
    }
  }

  /**
   * Send a Desktop Push Notification if enabled
   */
  sendDesktopPush(title, options = {}) {
    const config = StorageManager.getNotificationConfig();
    if (!config.enableBrowserPush) return;

    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const notification = new Notification(title, {
          icon: options.icon || 'https://cdn-icons-png.flaticon.com/512/3602/3602145.png',
          body: options.body || '',
          tag: options.tag || 'social-mention',
          requireInteraction: options.requireInteraction || false
        });

        notification.onclick = function () {
          window.focus();
          if (options.url) {
            window.open(options.url, '_blank');
          }
        };
      } catch (e) {
        console.warn('Could not dispatch desktop notification:', e);
      }
    }
  }

  /**
   * Dispatch a Webhook notification payload to Slack / Discord / Custom endpoint
   */
  async dispatchWebhook(mention, configOverride = null) {
    const config = configOverride || StorageManager.getNotificationConfig();
    if (!config.enableWebhooks || !config.webhookUrl) return { sent: false };

    // Format rich payload tailored for Slack/Discord or standard webhooks
    const isSlack = config.webhookUrl.includes('slack.com');
    const isDiscord = config.webhookUrl.includes('discord.com');

    let payload = {};

    if (isSlack) {
      payload = {
        text: `🚨 *[${mention.platform.toUpperCase()}] New Mention Alert*: "${mention.matchedKeyword}"`,
        attachments: [
          {
            color: mention.sentiment === 'negative' ? '#f43f5e' : (mention.sentiment === 'positive' ? '#10b981' : '#94a3b8'),
            author_name: `${mention.authorName} (${mention.authorHandle})`,
            text: mention.text,
            fields: [
              { title: 'Sentiment', value: mention.sentiment.toUpperCase(), short: true },
              { title: 'Platform', value: mention.platform, short: true }
            ],
            ts: Math.floor(new Date(mention.timestamp).getTime() / 1000)
          }
        ]
      };
    } else if (isDiscord) {
      payload = {
        username: 'Social Mention Monitor',
        content: `🚨 **New Brand Mention Detected!**`,
        embeds: [
          {
            title: `Mention on ${mention.platform}`,
            description: mention.text,
            color: mention.sentiment === 'negative' ? 16007006 : (mention.sentiment === 'positive' ? 1095937 : 9741240),
            fields: [
              { name: 'Keyword', value: mention.matchedKeyword, inline: true },
              { name: 'Sentiment', value: mention.sentiment.toUpperCase(), inline: true },
              { name: 'Author', value: `${mention.authorName} (${mention.authorHandle})`, inline: true }
            ],
            timestamp: new Date(mention.timestamp).toISOString()
          }
        ]
      };
    } else {
      // Standard Generic Webhook JSON
      payload = {
        event: 'brand_mention',
        timestamp: mention.timestamp,
        matchedKeyword: mention.matchedKeyword,
        sentiment: mention.sentiment,
        platform: mention.platform,
        author: {
          name: mention.authorName,
          handle: mention.authorHandle
        },
        content: mention.text,
        url: mention.url
      };
    }

    try {
      const response = await fetch(config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      StorageManager.addAlertLog({
        type: 'WEBHOOK_SENT',
        destination: config.webhookUrl,
        mentionId: mention.id,
        status: response.ok ? 'SUCCESS' : `HTTP ${response.status}`
      });

      return { sent: true, ok: response.ok, status: response.status };
    } catch (e) {
      console.error('Webhook dispatch failed:', e);
      StorageManager.addAlertLog({
        type: 'WEBHOOK_FAILED',
        destination: config.webhookUrl,
        mentionId: mention.id,
        error: e.message
      });
      return { sent: false, error: e.message };
    }
  }

  /**
   * Synthesize audio chime alert using Web Audio API (Zero external assets required!)
   */
  playAudioAlert(isUrgent = false) {
    const config = StorageManager.getNotificationConfig();
    if (!config.enableSound) return;

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      if (!this.audioContext) {
        this.audioContext = new AudioCtx();
      }

      if (this.audioContext.state === 'suspended') {
        this.audioContext.resume();
      }

      const now = this.audioContext.currentTime;
      const osc = this.audioContext.createOscillator();
      const gain = this.audioContext.createGain();

      osc.type = isUrgent ? 'sawtooth' : 'sine';
      
      if (isUrgent) {
        // High alert two-tone alarm chime
        osc.frequency.setValueAtTime(880, now); // A5
        osc.frequency.setValueAtTime(1174.66, now + 0.12); // D6
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      } else {
        // Soft positive chime
        osc.frequency.setValueAtTime(523.25, now); // C5
        osc.frequency.setValueAtTime(659.25, now + 0.1); // E5
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      }

      osc.connect(gain);
      gain.connect(this.audioContext.destination);

      osc.start(now);
      osc.stop(now + (isUrgent ? 0.35 : 0.25));
    } catch (e) {
      console.warn('Audio alert error:', e);
    }
  }

  /**
   * Display floating UI Toast Notification
   */
  showToast(title, message, type = 'info', durationMs = 4500) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    let icon = '🔔';
    if (type === 'negative') icon = '⚠️';
    if (type === 'positive') icon = '✨';

    toast.innerHTML = `
      <div class="toast-icon">${icon}</div>
      <div class="toast-content">
        <div class="toast-title">${this.escapeHtml(title)}</div>
        <div class="toast-message">${this.escapeHtml(message)}</div>
      </div>
    `;

    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(20px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, durationMs);
  }

  escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
