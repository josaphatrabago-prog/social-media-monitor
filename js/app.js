/**
 * Dashboard controller.
 *
 * The server owns all state; this file renders it and sends commands back.
 * Mentions arrive over SSE and are prepended live, while counts, charts and
 * the alert log are refreshed from the API on a short debounce - a burst of
 * forty comments should repaint the charts once, not forty times.
 */
import { api } from './api.js';
import { preferences } from './storage.js';
import { createNotificationCenter } from './notifications.js';
import { renderPlatformBars, renderSentimentDonut, renderVolumeChart } from './charts.js';

const FEED_PAGE_SIZE = 50;
const ANALYTICS_DEBOUNCE_MS = 1200;
const TIMELINE_BUCKET_COUNT = 24;

/** Bucket size (minutes) to a human range label, matching the select options. */
const PLATFORM_MODE_LABEL = {
  native: 'live API',
  aggregator: 'via aggregator',
  mock: 'synthetic',
  skipped: 'not configured'
};

function byId(id) {
  return document.getElementById(id);
}

function relativeTime(isoString) {
  const seconds = Math.round((Date.now() - new Date(isoString).getTime()) / 1000);

  if (seconds < 45) return 'just now';
  if (seconds < 90) return '1 min ago';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 7200) return '1 hour ago';
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hours ago`;
  return new Date(isoString).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function clockTime(isoString) {
  return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Builds the mention body as DOM nodes, marking the server-supplied match
 * ranges. Done with text nodes rather than innerHTML so a post containing
 * markup can never inject anything into the dashboard.
 */
function highlightedText(text, highlights) {
  const fragment = document.createDocumentFragment();
  let cursor = 0;

  for (const range of highlights || []) {
    const start = Math.max(0, Math.min(range.start, text.length));
    const end = Math.max(start, Math.min(range.end, text.length));
    if (start < cursor) continue;

    if (start > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, start)));

    const mark = document.createElement('mark');
    mark.className = 'highlight-keyword';
    mark.textContent = text.slice(start, end);
    fragment.appendChild(mark);

    cursor = end;
  }

  if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)));
  return fragment;
}

class Dashboard {
  constructor() {
    this.prefs = preferences.load();
    this.notifications = createNotificationCenter();
    this.notifications.soundEnabled = this.prefs.soundEnabled;
    this.notifications.desktopEnabled = this.prefs.desktopEnabled;

    this.status = null;
    this.config = null;
    this.feedTotal = 0;
    this.feedOffset = 0;
    this.newSinceLoad = 0;
    this.analyticsTimer = null;
    this.stream = null;
  }

  /* ---------------------------------------------------------------- startup */

  async init() {
    this.bindControls();
    this.applyPreferencesToUi();

    await this.notifications.registerServiceWorker();

    try {
      await this.refreshStatus();
      await this.refreshConfig();
      await Promise.all([this.loadFeed(), this.refreshAnalytics(), this.refreshAlerts()]);
    } catch (error) {
      this.notifications.toast({
        title: 'Could not reach the monitor',
        message: `${error.message}. Is the server running?`,
        type: 'negative',
        durationMs: 12000
      });
    }

    this.openStream();

    // Timestamps in the feed are relative, so they need periodic repainting.
    setInterval(() => this.refreshRelativeTimes(), 60000);
  }

  savePreferences() {
    preferences.save(this.prefs);
  }

  applyPreferencesToUi() {
    byId('toggle-sound').checked = this.prefs.soundEnabled;
    byId('toggle-desktop').checked = this.prefs.desktopEnabled;
    byId('filter-search').value = this.prefs.filters.search || '';
    byId('filter-platform').value = this.prefs.filters.platform || 'all';
    byId('filter-sentiment').value = this.prefs.filters.sentiment || 'all';
    byId('timeline-range').value = String(this.prefs.timeline.bucketMinutes || 15);
    this.updateDesktopHint();
  }

  /* ----------------------------------------------------------------- stream */

  openStream() {
    this.stream = api.stream({
      open: () => this.setConnectionState('live', 'Live'),
      error: () => this.setConnectionState('error', 'Reconnecting…'),

      hello: () => this.setConnectionState('live', 'Live'),
      mention: (mention) => this.onMention(mention),
      crisis: (event) => this.onCrisis(event),
      desktop: (payload) => this.notifications.showDesktop(payload),
      scheduler: (status) => this.onSchedulerState(status),
      notification: (record) => this.prependAlert(record),
      cleared: () => {
        this.feedOffset = 0;
        this.loadFeed();
        this.refreshAnalytics();
      },
      'poll-error': (event) => {
        this.notifications.toast({
          title: `${event.platform} poll failed`,
          message: event.error,
          type: 'warning'
        });
      }
    });
  }

  setConnectionState(state, label) {
    const dot = byId('connection-dot');
    const text = byId('connection-text');

    dot.className = `status-dot ${state === 'live' ? '' : state}`.trim();
    text.textContent = label;
  }

  onMention(mention) {
    this.newSinceLoad += 1;
    this.feedTotal += 1;

    if (this.matchesFilters(mention)) {
      const feed = byId('mention-feed');
      const empty = feed.querySelector('.feed-empty');
      if (empty) empty.remove();

      const card = this.renderMentionCard(mention, { isNew: true });
      feed.prepend(card);

      // Keep the DOM bounded; older cards stay reachable via Load more.
      while (feed.children.length > FEED_PAGE_SIZE * 3) feed.lastElementChild.remove();
    }

    if (mention.sentiment === 'negative') {
      this.notifications.playChime('negative');
      this.notifications.toast({
        title: `🚨 Negative mention on ${mention.platform}`,
        message: mention.text.slice(0, 120),
        type: 'negative'
      });
    } else {
      this.notifications.playChime(mention.sentiment);
    }

    this.updateFeedMeta();
    this.scheduleAnalyticsRefresh();
  }

  onCrisis(event) {
    this.notifications.playAlarm();
    this.notifications.toast({
      title: `🔥 Crisis alert — ${event.severity}`,
      message: `${event.negativeCount} negative mentions in ${event.windowMinutes} minutes ` +
        `(threshold ${event.threshold}).`,
      type: 'crisis'
    });

    this.showCrisisBanner(event);
    this.scheduleAnalyticsRefresh();
    this.refreshAlerts();
  }

  onSchedulerState(status) {
    this.status = { ...(this.status || {}), scheduler: status };
    this.renderSchedulerUi(status);
  }

  /* ------------------------------------------------------------- rendering  */

  async refreshStatus() {
    const status = await api.status();
    this.status = status;

    byId('mock-banner').hidden = !status.mockMode;
    this.renderSchedulerUi(status.scheduler);
    this.renderBrands(status.companies);
    this.renderCompanyFilter(status.companies);
    this.renderChannels(status.channels);
    this.renderCrisisMetric(status.crisis);

    if (status.crisis.level !== 'normal' && status.crisis.negativeCount >= status.crisis.threshold) {
      this.showCrisisBanner({
        severity: status.crisis.level,
        negativeCount: status.crisis.negativeCount,
        windowMinutes: status.crisis.windowMinutes,
        threshold: status.crisis.threshold,
        companies: []
      });
    }

    for (const warning of status.warnings || []) {
      console.warn('config warning:', warning);
    }
  }

  async refreshConfig() {
    const { config } = await api.config();
    this.config = config;

    byId('input-frequency').value = config.monitoring.frequency;
    byId('input-crisis-window').value = config.crisis.windowMinutes;
    byId('input-crisis-threshold').value = config.crisis.negativeThreshold;
    byId('input-crisis-multiplier').value = config.crisis.baselineMultiplier;
    byId('input-crisis-cooldown').value = config.crisis.cooldownMinutes;
    byId('input-sentiment-positive').value = config.sentiment.positiveThreshold;
    byId('input-sentiment-negative').value = config.sentiment.negativeThreshold;
    byId('toggle-desktop-channel').checked = Boolean(config.notifications.desktop?.enabled);

    this.syncFrequencySelect(config.monitoring.frequency);
    this.renderWebhookSettings(config.notifications);
  }

  syncFrequencySelect(frequency) {
    const select = byId('frequency-select');
    const known = [...select.options].some((option) => option.value === frequency);
    select.value = known ? frequency : 'custom';
  }

  renderSchedulerUi(scheduler) {
    if (!scheduler) return;

    const toggle = byId('btn-toggle-stream');
    toggle.textContent = scheduler.paused ? 'Resume' : 'Pause';
    toggle.classList.toggle('btn-primary', scheduler.paused);
    toggle.classList.toggle('btn-secondary', !scheduler.paused);

    if (scheduler.paused) this.setConnectionState('paused', 'Paused');

    const container = byId('platform-status');
    container.replaceChildren();

    for (const platform of scheduler.platforms) {
      const row = document.createElement('div');
      row.className = `platform-row platform-row-${platform.mode}`;

      const head = document.createElement('div');
      head.className = 'platform-row-head';

      const name = document.createElement('span');
      name.className = 'platform-row-name';
      name.textContent = platform.platform;

      const mode = document.createElement('span');
      mode.className = `platform-mode-tag mode-${platform.mode}`;
      mode.textContent = PLATFORM_MODE_LABEL[platform.mode] || platform.mode;

      head.append(name, mode);

      const detail = document.createElement('div');
      detail.className = 'platform-row-detail';

      if (!platform.runnable) {
        detail.textContent = platform.reason || 'not configured';
      } else {
        const parts = [platform.frequencyLabel];
        parts.push(platform.lastSuccessAt
          ? `last ${relativeTime(platform.lastSuccessAt)}`
          : 'no successful poll yet');
        if (platform.totals.added) parts.push(`${platform.totals.added} stored`);
        if (platform.consecutiveErrors) parts.push(`${platform.consecutiveErrors} error(s)`);
        detail.textContent = parts.join(' · ');
      }

      row.append(head, detail);

      if (platform.lastError) {
        const error = document.createElement('div');
        error.className = 'platform-row-error';
        error.textContent = platform.lastError.message;
        row.appendChild(error);
      }

      container.appendChild(row);
    }
  }

  renderBrands(companies) {
    const container = byId('brand-summary');
    container.replaceChildren();

    for (const company of companies) {
      const row = document.createElement('div');
      row.className = 'tracked-brand-row';

      // Not ".brand-name" - that class already styles the navbar heading.
      const name = document.createElement('div');
      name.className = 'tracked-brand-name';
      name.textContent = company.name;

      const meta = document.createElement('div');
      meta.className = 'tracked-brand-meta';
      meta.textContent = `${company.termCount} matched term${company.termCount === 1 ? '' : 's'}`;

      row.append(name, meta);
      container.appendChild(row);
    }
  }

  renderCompanyFilter(companies) {
    const select = byId('filter-company');
    const current = this.prefs.filters.company || 'all';

    select.replaceChildren();
    select.appendChild(new Option('All brands', 'all'));

    for (const company of companies) {
      select.appendChild(new Option(company.name, company.id));
    }

    select.value = companies.some((company) => company.id === current) ? current : 'all';
  }

  renderChannels(channels) {
    const container = byId('channel-list');
    container.replaceChildren();

    const seen = new Set();
    const rows = [
      ...channels.mention.map((channel) => ({ ...channel, scope: 'mentions' })),
      ...channels.crisis.map((channel) => ({ ...channel, scope: 'crisis' }))
    ];

    if (rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'setting-hint';
      empty.textContent = 'No channels are subscribed to any event yet.';
      container.appendChild(empty);
      return;
    }

    for (const channel of rows) {
      const key = `${channel.kind}:${channel.name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const row = document.createElement('div');
      row.className = 'channel-row';

      const dot = document.createElement('span');
      dot.className = `channel-dot ${channel.ready ? 'ready' : 'blocked'}`;

      const label = document.createElement('span');
      label.className = 'channel-name';
      label.textContent = channel.name;

      const state = document.createElement('span');
      state.className = 'channel-state';
      state.textContent = channel.ready ? 'ready' : (channel.reason || 'not configured');

      row.append(dot, label, state);
      container.appendChild(row);
    }
  }

  renderWebhookSettings(notifications) {
    const container = byId('webhook-settings');
    container.replaceChildren();

    const entries = [
      ...(notifications.webhooks || []).map((hook) => ({
        kind: 'webhook',
        name: hook.name || hook.type,
        label: `${hook.name || hook.type} (${hook.type})`,
        enabled: hook.enabled,
        configured: Boolean(hook.url),
        events: hook.events || []
      })),
      {
        kind: 'email',
        name: 'email',
        label: 'Email alerts',
        enabled: notifications.email?.enabled,
        configured: Boolean(notifications.email?.smtp?.host),
        events: notifications.email?.events || []
      }
    ];

    for (const entry of entries) {
      const group = document.createElement('div');
      group.className = 'setting-group';

      const toggle = document.createElement('label');
      toggle.className = 'toggle-switch';

      const text = document.createElement('span');
      text.className = 'toggle-switch-text';
      text.textContent = entry.label;

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'switch-input';
      input.checked = Boolean(entry.enabled);
      input.addEventListener('change', () => this.toggleChannel(entry, input));

      const slider = document.createElement('span');
      slider.className = 'switch-slider';

      toggle.append(text, input, slider);

      const hint = document.createElement('p');
      hint.className = 'setting-hint';
      hint.textContent = entry.configured
        ? `Events: ${entry.events.join(', ') || 'none'}`
        : 'No URL or SMTP host in .env — this channel will be skipped.';

      group.append(toggle, hint);
      container.appendChild(group);
    }
  }

  async toggleChannel(entry, input) {
    try {
      const result = await api.toggleChannel(entry.kind, entry.name, input.checked);
      this.renderChannels(result.channels);
      this.notifications.toast({
        title: `${entry.label} ${input.checked ? 'enabled' : 'disabled'}`,
        type: 'positive',
        durationMs: 2500
      });
    } catch (error) {
      input.checked = !input.checked;
      this.notifications.toast({ title: 'Could not update channel', message: error.message, type: 'negative' });
    }
  }

  renderCrisisMetric(crisis) {
    byId('stat-crisis').firstChild.textContent = String(crisis.negativeCount);
    byId('stat-crisis-threshold').textContent = `/${crisis.threshold}`;

    const label = byId('stat-crisis-label');
    const card = byId('crisis-metric-card');

    if (crisis.level === 'normal') {
      label.textContent = `Normal · ${crisis.windowMinutes}m window`;
      label.className = 'metric-change';
      card.classList.remove('metric-card-alert');
    } else {
      label.textContent = `${crisis.level.toUpperCase()} · ${crisis.windowMinutes}m window`;
      label.className = 'metric-change down';
      card.classList.add('metric-card-alert');
    }
  }

  showCrisisBanner(event) {
    const banner = byId('crisis-banner');
    banner.hidden = false;

    byId('crisis-banner-title').textContent =
      `Crisis alert — ${String(event.severity).toUpperCase()}`;

    const brands = (event.companies || []).map((company) => company.companyName).join(', ');
    byId('crisis-banner-detail').textContent =
      `${event.negativeCount} negative mentions in the last ${event.windowMinutes} minutes ` +
      `(threshold ${event.threshold})${brands ? ` · ${brands}` : ''}`;
  }

  /* ------------------------------------------------------------------- feed */

  currentFilters() {
    return {
      search: byId('filter-search').value.trim(),
      platform: byId('filter-platform').value,
      sentiment: byId('filter-sentiment').value,
      company: byId('filter-company').value
    };
  }

  matchesFilters(mention) {
    const filters = this.currentFilters();

    if (filters.platform !== 'all' && mention.platform !== filters.platform) return false;
    if (filters.sentiment !== 'all' && mention.sentiment !== filters.sentiment) return false;

    if (filters.company !== 'all') {
      const ids = (mention.companies || []).map((entry) => entry.companyId);
      if (!ids.includes(filters.company)) return false;
    }

    if (filters.search) {
      const haystack = [
        mention.text,
        mention.author?.name,
        mention.author?.handle,
        (mention.matchedTerms || []).join(' ')
      ].filter(Boolean).join(' ').toLowerCase();

      if (!haystack.includes(filters.search.toLowerCase())) return false;
    }

    return true;
  }

  async loadFeed({ append = false } = {}) {
    const feed = byId('mention-feed');
    feed.setAttribute('aria-busy', 'true');

    if (!append) this.feedOffset = 0;

    const result = await api.mentions({
      ...this.currentFilters(),
      limit: FEED_PAGE_SIZE,
      offset: this.feedOffset
    });

    this.feedTotal = result.total;

    if (!append) feed.replaceChildren();

    if (result.items.length === 0 && !append) {
      const empty = document.createElement('div');
      empty.className = 'feed-empty';
      empty.innerHTML =
        '<div class="feed-empty-icon">🛰️</div>' +
        '<div class="feed-empty-title">No mentions match these filters</div>' +
        '<div class="feed-empty-hint">Adjust the filters, or wait for the next poll.</div>';
      feed.appendChild(empty);
    } else {
      const fragment = document.createDocumentFragment();
      for (const mention of result.items) fragment.appendChild(this.renderMentionCard(mention));
      feed.appendChild(fragment);
    }

    this.feedOffset += result.items.length;
    feed.setAttribute('aria-busy', 'false');
    this.updateFeedMeta();
  }

  updateFeedMeta() {
    const shown = byId('mention-feed').querySelectorAll('.mention-card').length;

    byId('feed-count').textContent = this.feedTotal === 0
      ? 'No mentions'
      : `Showing ${shown} of ${this.feedTotal} matching mention${this.feedTotal === 1 ? '' : 's'}`;

    byId('btn-load-more').hidden = this.feedOffset >= this.feedTotal;

    const delta = byId('stat-total-delta');
    if (this.newSinceLoad > 0) {
      delta.textContent = `↑ ${this.newSinceLoad} new`;
      delta.className = 'metric-change up';
    }
  }

  renderMentionCard(mention, { isNew = false } = {}) {
    const card = document.createElement('article');
    card.className = 'mention-card';
    card.dataset.timestamp = mention.timestamp;
    if (mention.sentiment === 'negative') card.classList.add('high-alert');
    if (isNew) {
      card.classList.add('mention-card-new');
      // Let the entry animation finish, then stop marking it as new so a long
      // session does not accumulate dozens of highlighted cards.
      setTimeout(() => card.classList.remove('mention-card-new'), 4000);
    }

    /* header */
    const header = document.createElement('header');
    header.className = 'mention-header';

    const authorInfo = document.createElement('div');
    authorInfo.className = 'author-info';

    const avatar = document.createElement('div');
    avatar.className = 'author-avatar';
    avatar.textContent = (mention.author?.name || '?').trim().charAt(0).toUpperCase();

    const authorDetails = document.createElement('div');
    authorDetails.className = 'author-details';

    const authorName = document.createElement('span');
    authorName.className = 'author-name';
    authorName.textContent = mention.author?.name || 'Unknown';

    const authorHandle = document.createElement('span');
    authorHandle.className = 'author-handle';
    authorHandle.textContent = mention.author?.handle || '';

    authorDetails.append(authorName, authorHandle);
    authorInfo.append(avatar, authorDetails);

    const badges = document.createElement('div');
    badges.className = 'mention-badges';

    const platformBadge = document.createElement('span');
    platformBadge.className = `platform-badge platform-${mention.platform.toLowerCase()}`;
    platformBadge.textContent = mention.platform;

    const kindBadge = document.createElement('span');
    kindBadge.className = 'kind-badge';
    kindBadge.textContent = mention.kind;

    badges.append(platformBadge, kindBadge);

    if (mention.isMock) {
      const mockBadge = document.createElement('span');
      mockBadge.className = 'kind-badge kind-badge-mock';
      mockBadge.textContent = 'demo';
      badges.appendChild(mockBadge);
    }

    header.append(authorInfo, badges);

    /* body */
    const body = document.createElement('p');
    body.className = 'mention-content';
    body.appendChild(highlightedText(mention.text, mention.highlights));

    /* footer */
    const footer = document.createElement('footer');
    footer.className = 'mention-footer';

    const left = document.createElement('div');
    left.className = 'mention-footer-left';

    const sentimentPill = document.createElement('span');
    sentimentPill.className = `sentiment-pill sentiment-${mention.sentiment}`;
    const icon = { positive: '🟢', neutral: '⚪', negative: '🔴' }[mention.sentiment];
    sentimentPill.textContent = `${icon} ${mention.sentiment} ${mention.sentimentScore}`;
    sentimentPill.title = (mention.sentimentTerms || []).length
      ? `Scored on: ${mention.sentimentTerms.map((term) => `${term.term} (${term.weight})`).join(', ')}`
      : 'No sentiment-bearing terms found';

    left.appendChild(sentimentPill);

    for (const company of mention.companies || []) {
      const tag = document.createElement('span');
      tag.className = 'brand-tag-pill';
      tag.textContent = company.companyName;
      tag.title = `Matched via ${company.matchType}`;
      left.appendChild(tag);
    }

    if (mention.matchedViaParent) {
      const viaParent = document.createElement('span');
      viaParent.className = 'brand-tag-pill brand-tag-weak';
      viaParent.textContent = 'via parent post';
      viaParent.title = 'This comment did not name the brand itself; its parent post did.';
      left.appendChild(viaParent);
    }

    const right = document.createElement('div');
    right.className = 'mention-meta-actions';

    const time = document.createElement('span');
    time.className = 'mention-time';
    time.dataset.timestamp = mention.timestamp;
    time.textContent = relativeTime(mention.timestamp);
    time.title = new Date(mention.timestamp).toLocaleString();
    right.appendChild(time);

    if (mention.url) {
      const link = document.createElement('a');
      link.className = 'action-link';
      link.href = mention.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Open ↗';
      right.appendChild(link);
    }

    footer.append(left, right);
    card.append(header, body, footer);

    if (mention.parent?.title) {
      const parent = document.createElement('div');
      parent.className = 'mention-parent';
      parent.textContent = `on: ${mention.parent.title}`;
      card.insertBefore(parent, footer);
    }

    return card;
  }

  refreshRelativeTimes() {
    for (const node of document.querySelectorAll('.mention-time[data-timestamp]')) {
      node.textContent = relativeTime(node.dataset.timestamp);
    }
  }

  /* -------------------------------------------------------------- analytics */

  scheduleAnalyticsRefresh() {
    if (this.analyticsTimer) return;

    this.analyticsTimer = setTimeout(() => {
      this.analyticsTimer = null;
      this.refreshAnalytics();
      this.refreshStatus().catch(() => {});
    }, ANALYTICS_DEBOUNCE_MS);
  }

  async refreshAnalytics() {
    const filters = this.currentFilters();
    const bucketMinutes = Number(byId('timeline-range').value) || 15;

    const [stats, timeline] = await Promise.all([
      api.stats(filters),
      api.timeline({ bucketMinutes, buckets: TIMELINE_BUCKET_COUNT })
    ]);

    byId('stat-total').textContent = stats.total;
    byId('stat-positive').textContent = `${stats.sentimentShare.positive}%`;
    byId('stat-positive-count').textContent = `${stats.sentiment.positive} mentions`;
    byId('stat-negative').textContent = `${stats.sentimentShare.negative}%`;
    byId('stat-negative-count').textContent = `${stats.sentiment.negative} mentions`;

    renderSentimentDonut(byId('sentiment-chart'), stats);
    renderPlatformBars(byId('platform-chart'), stats.platforms);
    renderVolumeChart(byId('volume-chart'), timeline);
  }

  async refreshAlerts() {
    const { alerts } = await api.alerts(15);
    const container = byId('alert-log');
    container.replaceChildren();

    if (alerts.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'setting-hint';
      empty.textContent = 'No alerts have fired yet.';
      container.appendChild(empty);
      return;
    }

    for (const alert of alerts) container.appendChild(this.renderAlertRow(alert));
  }

  renderAlertRow(alert) {
    const row = document.createElement('div');
    const isCrisis = alert.type === 'crisis';
    row.className = `alert-row ${isCrisis ? 'alert-row-crisis' : ''}`.trim();

    const head = document.createElement('div');
    head.className = 'alert-row-head';

    const title = document.createElement('span');
    title.className = 'alert-row-title';
    title.textContent = isCrisis
      ? `🔥 Crisis · ${alert.negativeCount} negative in ${alert.windowMinutes}m`
      : `${alert.event || 'notification'}`;

    const time = document.createElement('span');
    time.className = 'alert-row-time';
    time.textContent = clockTime(alert.timestamp || alert.triggeredAt);

    head.append(title, time);
    row.appendChild(head);

    const detail = document.createElement('div');
    detail.className = 'alert-row-detail';

    if (isCrisis) {
      detail.textContent = `${alert.severity} · rules: ${(alert.rules || []).join(' + ')}` +
        ` · ${(alert.companies || []).map((company) => company.companyName).join(', ')}`;
    } else {
      const delivered = (alert.delivered || []).join(', ') || 'no channels';
      const failed = (alert.failed || []).length ? ` · failed: ${alert.failed.map((f) => f.name).join(', ')}` : '';
      detail.textContent = `sent to ${delivered}${failed}`;
    }

    row.appendChild(detail);
    return row;
  }

  prependAlert(record) {
    const container = byId('alert-log');
    const hint = container.querySelector('.setting-hint');
    if (hint) hint.remove();

    container.prepend(this.renderAlertRow({ type: 'notification', ...record }));
    while (container.children.length > 15) container.lastElementChild.remove();
  }

  /* --------------------------------------------------------------- controls */

  bindControls() {
    /* filters */
    let searchTimer = null;
    byId('filter-search').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => this.onFiltersChanged(), 300);
    });

    for (const id of ['filter-platform', 'filter-sentiment', 'filter-company']) {
      byId(id).addEventListener('change', () => this.onFiltersChanged());
    }

    byId('timeline-range').addEventListener('change', () => {
      this.prefs.timeline.bucketMinutes = Number(byId('timeline-range').value);
      this.savePreferences();
      this.refreshAnalytics();
    });

    byId('btn-load-more').addEventListener('click', () => this.loadFeed({ append: true }));

    /* exports */
    byId('btn-export-csv').addEventListener('click', () => {
      api.download('csv', this.currentFilters());
      this.notifications.toast({ title: 'CSV export started', type: 'positive', durationMs: 2500 });
    });

    byId('btn-export-json').addEventListener('click', () => {
      api.download('json', this.currentFilters());
      this.notifications.toast({ title: 'JSON export started', type: 'positive', durationMs: 2500 });
    });

    byId('btn-clear-feed').addEventListener('click', () => this.clearMentions());

    /* scheduler */
    byId('btn-toggle-stream').addEventListener('click', () => this.toggleScheduler());
    byId('btn-poll-now').addEventListener('click', () => this.pollNow());
    byId('frequency-select').addEventListener('change', (event) => this.onFrequencySelect(event));

    /* local alert preferences */
    byId('toggle-sound').addEventListener('change', (event) => {
      this.prefs.soundEnabled = event.target.checked;
      this.notifications.soundEnabled = event.target.checked;
      this.savePreferences();
      if (event.target.checked) this.notifications.playChime('positive');
    });

    byId('toggle-desktop').addEventListener('change', (event) => this.onDesktopToggle(event));

    byId('btn-test-mention').addEventListener('click', () => this.sendTestAlert('mention'));
    byId('btn-test-crisis').addEventListener('click', () => this.sendTestAlert('crisis'));

    /* crisis banner */
    byId('btn-crisis-ack').addEventListener('click', () => this.acknowledgeCrisis());
    byId('btn-crisis-filter').addEventListener('click', () => {
      byId('filter-sentiment').value = 'negative';
      this.onFiltersChanged();
    });

    byId('btn-simulate-crisis').addEventListener('click', () => this.simulateCrisis());

    /* modals */
    byId('btn-open-brands').addEventListener('click', () => this.openBrandsModal());
    byId('btn-edit-brands').addEventListener('click', () => this.openBrandsModal());
    byId('btn-open-settings').addEventListener('click', () => this.openModal('modal-settings'));
    byId('btn-save-brands').addEventListener('click', () => this.saveBrands());
    byId('btn-save-settings').addEventListener('click', () => this.saveSettings());

    for (const button of document.querySelectorAll('[data-close-modal]')) {
      button.addEventListener('click', () => this.closeModal(button.dataset.closeModal));
    }

    for (const overlay of document.querySelectorAll('.modal-overlay')) {
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) this.closeModal(overlay.id);
      });
    }

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      for (const overlay of document.querySelectorAll('.modal-overlay.active')) {
        this.closeModal(overlay.id);
      }
    });
  }

  onFiltersChanged() {
    const filters = this.currentFilters();
    this.prefs.filters = filters;
    this.savePreferences();

    this.loadFeed();
    this.refreshAnalytics();
  }

  async toggleScheduler() {
    try {
      const paused = this.status?.scheduler?.paused;
      const result = paused ? await api.resume() : await api.pause();
      this.onSchedulerState(result.scheduler);

      this.notifications.toast({
        title: paused ? 'Monitoring resumed' : 'Monitoring paused',
        type: paused ? 'positive' : 'info',
        durationMs: 2500
      });

      if (!paused) this.setConnectionState('paused', 'Paused');
      else this.setConnectionState('live', 'Live');
    } catch (error) {
      this.notifications.toast({ title: 'Could not change state', message: error.message, type: 'negative' });
    }
  }

  async pollNow() {
    try {
      const result = await api.pollNow();
      this.notifications.toast({
        title: 'Polling now',
        message: result.polling.join(', '),
        type: 'info',
        durationMs: 2500
      });
    } catch (error) {
      this.notifications.toast({ title: 'Poll failed', message: error.message, type: 'negative' });
    }
  }

  async onFrequencySelect(event) {
    const value = event.target.value;

    if (value === 'custom') {
      this.openModal('modal-settings');
      byId('input-frequency').focus();
      this.syncFrequencySelect(this.config?.monitoring.frequency || '5m');
      return;
    }

    await this.applyFrequency(value);
  }

  async applyFrequency(frequency) {
    try {
      const result = await api.setFrequency(frequency, { persist: true });
      this.onSchedulerState(result.scheduler);
      if (this.config) this.config.monitoring.frequency = frequency;
      this.syncFrequencySelect(frequency);

      this.notifications.toast({
        title: 'Frequency updated',
        message: `Now polling ${result.scheduler.globalFrequencyLabel}`,
        type: 'positive',
        durationMs: 3000
      });
    } catch (error) {
      this.notifications.toast({ title: 'Invalid frequency', message: error.message, type: 'negative' });
      this.syncFrequencySelect(this.config?.monitoring.frequency || '5m');
    }
  }

  async onDesktopToggle(event) {
    if (!event.target.checked) {
      this.prefs.desktopEnabled = false;
      this.notifications.desktopEnabled = false;
      this.savePreferences();
      this.updateDesktopHint();
      return;
    }

    const result = await this.notifications.requestDesktopPermission();
    event.target.checked = result.granted;
    this.prefs.desktopEnabled = result.granted;
    this.savePreferences();
    this.updateDesktopHint();

    if (!result.granted) {
      this.notifications.toast({
        title: 'Desktop notifications not enabled',
        message: result.reason,
        type: 'warning',
        durationMs: 7000
      });
    }
  }

  updateDesktopHint() {
    const hint = byId('desktop-hint');
    const permission = this.notifications.permission;

    if (permission === 'unsupported') {
      hint.textContent = 'This browser has no Notification API.';
    } else if (permission === 'denied') {
      hint.textContent = 'Blocked — re-enable notifications in the browser site settings.';
    } else if (this.prefs.desktopEnabled && permission === 'granted') {
      hint.textContent = 'Enabled for negative mentions and crises.';
    } else {
      hint.textContent = 'Requires browser permission.';
    }
  }

  async sendTestAlert(kind) {
    try {
      const result = await api.testNotification(kind);
      const delivered = result.delivered.filter((entry) => entry.ok).map((entry) => entry.name);
      const failed = result.delivered.filter((entry) => !entry.ok);

      this.notifications.toast({
        title: delivered.length ? `Test sent to ${delivered.join(', ')}` : 'No channel accepted the test',
        message: [
          failed.length ? `Failed: ${failed.map((entry) => `${entry.name} (${entry.error})`).join('; ')}` : '',
          result.skipped.length ? `Skipped: ${result.skipped.map((entry) => `${entry.name} — ${entry.reason}`).join('; ')}` : ''
        ].filter(Boolean).join(' · '),
        type: delivered.length ? 'positive' : 'warning',
        durationMs: 8000
      });
    } catch (error) {
      this.notifications.toast({ title: 'Test failed', message: error.message, type: 'negative' });
    }
  }

  async acknowledgeCrisis() {
    try {
      const result = await api.acknowledgeCrisis();
      byId('crisis-banner').hidden = true;
      this.renderCrisisMetric(result.crisis);
      this.notifications.toast({ title: 'Crisis acknowledged', message: 'Cooldown reset.', type: 'info' });
    } catch (error) {
      this.notifications.toast({ title: 'Could not acknowledge', message: error.message, type: 'negative' });
    }
  }

  async simulateCrisis() {
    try {
      const result = await api.simulateCrisis(8);
      this.notifications.toast({
        title: `Queued ${result.queued} synthetic negative mentions`,
        message: result.note,
        type: 'warning'
      });
    } catch (error) {
      this.notifications.toast({ title: 'Simulation failed', message: error.message, type: 'negative' });
    }
  }

  async clearMentions() {
    const confirmed = window.confirm(
      'Delete every stored mention? Alert history is kept. This cannot be undone.'
    );
    if (!confirmed) return;

    try {
      const result = await api.clearMentions();
      this.newSinceLoad = 0;
      byId('crisis-banner').hidden = true;
      await Promise.all([this.loadFeed(), this.refreshAnalytics(), this.refreshStatus()]);
      this.notifications.toast({ title: `Cleared ${result.removed} mentions`, type: 'info' });
    } catch (error) {
      this.notifications.toast({ title: 'Could not clear', message: error.message, type: 'negative' });
    }
  }

  /* ----------------------------------------------------------------- modals */

  openModal(id) {
    byId(id).classList.add('active');
  }

  closeModal(id) {
    byId(id).classList.remove('active');
  }

  openBrandsModal() {
    this.renderBrandEditor(this.config?.companies || []);
    this.openModal('modal-brands');
  }

  /**
   * Terms are edited as one-per-line text areas rather than tag widgets: it is
   * far less code, and pasting a list of twenty aliases from a spreadsheet
   * actually works.
   */
  renderBrandEditor(companies) {
    const container = byId('brand-editor');
    container.replaceChildren();

    companies.forEach((company, index) => {
      container.appendChild(this.renderBrandCard(company, index));
    });

    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.className = 'btn btn-secondary';
    addButton.textContent = '+ Add brand';
    addButton.addEventListener('click', () => {
      const cards = container.querySelectorAll('.brand-card').length;
      container.insertBefore(
        this.renderBrandCard({ id: '', name: '', aliases: [], hashtags: [], handles: [], exclude: [] }, cards),
        addButton
      );
    });

    container.appendChild(addButton);
  }

  renderBrandCard(company, index) {
    const card = document.createElement('div');
    card.className = 'brand-card';
    card.dataset.index = String(index);

    const header = document.createElement('div');
    header.className = 'brand-card-header';

    const nameField = document.createElement('div');
    nameField.className = 'setting-group brand-card-name';

    const nameLabel = document.createElement('label');
    nameLabel.className = 'setting-label';
    nameLabel.textContent = 'Registered / display name';
    nameLabel.htmlFor = `brand-name-${index}`;

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'setting-input';
    nameInput.id = `brand-name-${index}`;
    nameInput.dataset.field = 'name';
    nameInput.value = company.name || '';
    nameInput.placeholder = 'CEBU RITEHOMES DEVELOPMENT & REALTY CORP.';

    nameField.append(nameLabel, nameInput);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-danger btn-sm';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => card.remove());

    header.append(nameField, remove);
    card.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'setting-grid';

    const fields = [
      ['aliases', 'Aliases', 'CEBU RITEHOMES\nCebu Rite Homes\nRitehomes'],
      ['hashtags', 'Hashtags', '#Ritehomes\n#CebuRitehomes'],
      ['handles', 'Handles', '@ritehomes'],
      ['exclude', 'Excluded terms', 'fan page']
    ];

    for (const [field, label, placeholder] of fields) {
      const group = document.createElement('div');
      group.className = 'setting-group';

      const fieldLabel = document.createElement('label');
      fieldLabel.className = 'setting-label';
      fieldLabel.textContent = `${label} (one per line)`;
      fieldLabel.htmlFor = `brand-${field}-${index}`;

      const textarea = document.createElement('textarea');
      textarea.className = 'setting-input setting-textarea';
      textarea.id = `brand-${field}-${index}`;
      textarea.dataset.field = field;
      textarea.rows = 4;
      textarea.placeholder = placeholder;
      textarea.value = (company[field] || []).join('\n');

      group.append(fieldLabel, textarea);
      grid.appendChild(group);
    }

    card.appendChild(grid);
    card.dataset.companyId = company.id || '';
    return card;
  }

  collectBrands() {
    const cards = [...document.querySelectorAll('#brand-editor .brand-card')];

    return cards.map((card) => {
      const readLines = (field) => (card.querySelector(`[data-field="${field}"]`)?.value || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      const name = card.querySelector('[data-field="name"]')?.value.trim() || '';

      return {
        // A new brand gets a slug id derived from its name; existing ids are
        // preserved so stored mentions keep pointing at the same brand.
        id: card.dataset.companyId ||
          name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40),
        name,
        aliases: readLines('aliases'),
        hashtags: readLines('hashtags'),
        handles: readLines('handles'),
        exclude: readLines('exclude')
      };
    }).filter((company) => company.name && company.id);
  }

  async saveBrands() {
    const companies = this.collectBrands();

    if (companies.length === 0) {
      this.notifications.toast({
        title: 'At least one brand is required',
        message: 'Every brand needs a name.',
        type: 'warning'
      });
      return;
    }

    try {
      await api.patchConfig({ companies, persist: byId('brands-persist').checked });
      await this.refreshConfig();
      await this.refreshStatus();
      this.closeModal('modal-brands');

      this.notifications.toast({
        title: 'Brands updated',
        message: `Now matching ${companies.length} brand(s). Existing mentions are unchanged.`,
        type: 'positive'
      });
    } catch (error) {
      this.notifications.toast({ title: 'Could not save brands', message: error.message, type: 'negative' });
    }
  }

  async saveSettings() {
    const patch = {
      monitoring: { frequency: byId('input-frequency').value.trim() },
      crisis: {
        windowMinutes: Number(byId('input-crisis-window').value),
        negativeThreshold: Number(byId('input-crisis-threshold').value),
        baselineMultiplier: Number(byId('input-crisis-multiplier').value),
        cooldownMinutes: Number(byId('input-crisis-cooldown').value)
      },
      sentiment: {
        positiveThreshold: Number(byId('input-sentiment-positive').value),
        negativeThreshold: Number(byId('input-sentiment-negative').value)
      },
      notifications: { desktop: { enabled: byId('toggle-desktop-channel').checked } },
      persist: byId('settings-persist').checked
    };

    try {
      const result = await api.patchConfig(patch);
      await this.refreshConfig();
      await this.refreshStatus();
      this.closeModal('modal-settings');

      const restart = result.rebuilt?.restartRequired || [];
      this.notifications.toast({
        title: 'Settings applied',
        message: restart.length ? `Restart required for: ${restart.join(', ')}` : 'All changes are live.',
        type: 'positive',
        durationMs: restart.length ? 8000 : 4000
      });
    } catch (error) {
      this.notifications.toast({ title: 'Could not apply settings', message: error.message, type: 'negative' });
    }
  }
}

const dashboard = new Dashboard();
dashboard.init();
