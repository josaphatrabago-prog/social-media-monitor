/**
 * Browser-side alerting: desktop notifications, audio chimes and toasts.
 *
 * Webhook and email delivery used to live here and now runs on the server.
 * Two reasons it had to move: Slack's incoming-webhook endpoint sends no CORS
 * headers, so a browser POST is blocked before it leaves the page, and a
 * webhook URL is a credential that should never be shipped to a visitor.
 *
 * What genuinely belongs in the browser is the part only the browser can do:
 * the Notification permission and playing a sound.
 */

const TOAST_DURATION_MS = 4500;
const CRISIS_TOAST_DURATION_MS = 9000;

/** Volume ceiling for the alert tones - loud enough to notice, not to startle. */
const CHIME_GAIN = 0.16;
const ALARM_GAIN = 0.3;

export class NotificationCenter {
  constructor() {
    this.audioContext = null;
    this.soundEnabled = true;
    this.desktopEnabled = false;
    this.serviceWorker = null;
  }

  /* ---------------------------------------------------------- service worker */

  /**
   * Registers the service worker. It is what lets a notification survive the
   * tab losing focus and carry an action button.
   */
  async registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return null;

    try {
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      this.serviceWorker = registration;
      return registration;
    } catch (error) {
      // Service workers need a secure context: https, or http on localhost.
      console.warn('service worker registration failed', error.message);
      return null;
    }
  }

  /* ----------------------------------------------------- desktop notifications */

  get permission() {
    return 'Notification' in window ? Notification.permission : 'unsupported';
  }

  /** @returns {Promise<{granted: boolean, reason?: string}>} */
  async requestDesktopPermission() {
    if (!('Notification' in window)) {
      return { granted: false, reason: 'this browser has no Notification API' };
    }

    if (Notification.permission === 'denied') {
      return {
        granted: false,
        reason: 'notifications are blocked for this site - re-enable them in the browser site settings'
      };
    }

    const result = Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission();

    this.desktopEnabled = result === 'granted';
    return this.desktopEnabled
      ? { granted: true }
      : { granted: false, reason: `permission ${result}` };
  }

  /**
   * Raises a system notification from a server-pushed payload.
   * @param {{title: string, body: string, tag: string, requireInteraction: boolean, url: string}} payload
   */
  async showDesktop(payload) {
    if (!this.desktopEnabled || this.permission !== 'granted') return false;

    const options = {
      body: payload.body,
      tag: payload.tag,
      // Re-showing a tag silently would hide an escalating crisis.
      renotify: payload.kind === 'crisis',
      requireInteraction: Boolean(payload.requireInteraction),
      data: { url: payload.url || '/' },
      icon: BELL_ICON_DATA_URI,
      badge: BELL_ICON_DATA_URI
    };

    try {
      // The service worker path supports actions and outlives the page.
      if (this.serviceWorker?.showNotification) {
        await this.serviceWorker.showNotification(payload.title, {
          ...options,
          actions: payload.url && payload.url !== '/'
            ? [{ action: 'open', title: 'Open post' }]
            : []
        });
        return true;
      }

      const notification = new Notification(payload.title, options);
      notification.onclick = () => {
        window.focus();
        if (payload.url && payload.url !== '/') window.open(payload.url, '_blank', 'noopener');
        notification.close();
      };
      return true;
    } catch (error) {
      console.warn('desktop notification failed', error.message);
      return false;
    }
  }

  /* ------------------------------------------------------------------- audio */

  #context() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;

    if (!this.audioContext) this.audioContext = new AudioContextClass();
    // Browsers suspend audio until a user gesture has occurred.
    if (this.audioContext.state === 'suspended') this.audioContext.resume();

    return this.audioContext;
  }

  /** One tone. Kept private so the public methods read as intent, not synthesis. */
  #tone({ frequency, startAt, duration, gain, type = 'sine' }) {
    const context = this.#context();
    if (!context) return;

    const oscillator = context.createOscillator();
    const amplifier = context.createGain();

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, startAt);

    amplifier.gain.setValueAtTime(0.0001, startAt);
    amplifier.gain.exponentialRampToValueAtTime(gain, startAt + 0.015);
    amplifier.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

    oscillator.connect(amplifier);
    amplifier.connect(context.destination);
    oscillator.start(startAt);
    oscillator.stop(startAt + duration + 0.02);
  }

  /** Soft two-note chime for an ordinary mention. */
  playChime(sentiment = 'neutral') {
    if (!this.soundEnabled) return;
    const context = this.#context();
    if (!context) return;

    const now = context.currentTime;
    // Rising for good news, falling for bad - distinguishable without looking.
    const notes = sentiment === 'negative' ? [659.25, 523.25] : [523.25, 659.25];

    this.#tone({ frequency: notes[0], startAt: now, duration: 0.16, gain: CHIME_GAIN });
    this.#tone({ frequency: notes[1], startAt: now + 0.12, duration: 0.2, gain: CHIME_GAIN });
  }

  /** Three urgent pulses for a crisis - deliberately unlike the chime. */
  playAlarm() {
    if (!this.soundEnabled) return;
    const context = this.#context();
    if (!context) return;

    const now = context.currentTime;
    for (let pulse = 0; pulse < 3; pulse += 1) {
      const startAt = now + pulse * 0.26;
      this.#tone({ frequency: 880, startAt, duration: 0.1, gain: ALARM_GAIN, type: 'square' });
      this.#tone({ frequency: 1174.66, startAt: startAt + 0.1, duration: 0.12, gain: ALARM_GAIN, type: 'square' });
    }
  }

  /* ------------------------------------------------------------------ toasts */

  /**
   * @param {{title: string, message?: string, type?: 'info'|'positive'|'negative'|'warning'|'crisis', durationMs?: number}} options
   */
  toast({ title, message = '', type = 'info', durationMs }) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const icons = {
      info: '🔔',
      positive: '✨',
      negative: '⚠️',
      warning: '⚠️',
      crisis: '🔥'
    };

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', type === 'crisis' || type === 'negative' ? 'alert' : 'status');

    const icon = document.createElement('div');
    icon.className = 'toast-icon';
    icon.textContent = icons[type] || icons.info;

    const content = document.createElement('div');
    content.className = 'toast-content';

    const titleNode = document.createElement('div');
    titleNode.className = 'toast-title';
    titleNode.textContent = title;
    content.appendChild(titleNode);

    if (message) {
      const messageNode = document.createElement('div');
      messageNode.className = 'toast-message';
      messageNode.textContent = message;
      content.appendChild(messageNode);
    }

    const close = document.createElement('button');
    close.className = 'toast-close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '✕';
    close.addEventListener('click', () => dismiss());

    toast.append(icon, content, close);
    container.appendChild(toast);

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      toast.classList.add('toast-leaving');
      setTimeout(() => toast.remove(), 260);
    };

    const timeout = durationMs ??
      (type === 'crisis' ? CRISIS_TOAST_DURATION_MS : TOAST_DURATION_MS);
    setTimeout(dismiss, timeout);

    return dismiss;
  }
}

/** Small inline bell, so notifications carry an icon with no network request. */
const BELL_ICON_DATA_URI =
  'data:image/svg+xml;base64,' + btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    '<rect width="64" height="64" rx="14" fill="#6366f1"/>' +
    '<path d="M32 14a9 9 0 0 0-9 9v7l-4 7h26l-4-7v-7a9 9 0 0 0-9-9zm0 32a5 5 0 0 0 5-5H27a5 5 0 0 0 5 5z" fill="#fff"/>' +
    '</svg>'
  );

export function createNotificationCenter() {
  return new NotificationCenter();
}
