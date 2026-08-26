/**
 * Main Application Controller - Connects UI components, state,
 * event handlers, monitoring engine, and notification dispatcher.
 */

import { StorageManager } from './storage.js';
import { NotificationEngine } from './notifications.js';
import { MentionMonitor } from './monitor.js';
import { AnalyticsEngine } from './analytics.js';

class AppController {
  constructor() {
    this.mentions = StorageManager.getMentionsHistory();
    this.notifications = new NotificationEngine();
    
    // Initialize monitor engine callbacks
    this.monitor = new MentionMonitor(
      this.handleNewMention.bind(this),
      this.handleCrisisAlert.bind(this)
    );

    // Active filters
    this.searchQuery = '';
    this.selectedPlatform = 'all';
    this.selectedSentiment = 'all';

    // Temp tags state for modals
    this.tempAliases = [];
    this.tempExcluded = [];
  }

  init() {
    this.bindEvents();
    this.loadStateToUI();
    this.renderSidebarKeywords();
    this.renderFeed();
    this.updateAnalytics();

    // Start live mention stream
    this.monitor.startStream();
  }

  bindEvents() {
    // Stream Pause/Resume Toggle
    const btnToggleStream = document.getElementById('btn-toggle-stream');
    if (btnToggleStream) {
      btnToggleStream.addEventListener('click', () => {
        if (this.monitor.isStreaming) {
          this.monitor.stopStream();
          btnToggleStream.textContent = 'Resume Monitor';
          document.getElementById('stream-status-dot').classList.add('paused');
          document.getElementById('stream-status-text').textContent = 'Monitoring Paused';
          this.notifications.showToast('Monitoring Paused', 'Mention stream simulation has been paused.', 'info');
        } else {
          this.monitor.startStream();
          btnToggleStream.textContent = 'Pause Monitor';
          document.getElementById('stream-status-dot').classList.remove('paused');
          document.getElementById('stream-status-text').textContent = 'Live Monitoring Active';
          this.notifications.showToast('Monitoring Resumed', 'Listening for new brand mentions...', 'positive');
        }
      });
    }

    // Clear Feed
    const btnClearFeed = document.getElementById('btn-clear-feed');
    if (btnClearFeed) {
      btnClearFeed.addEventListener('click', () => {
        this.mentions = [];
        StorageManager.saveMentionsHistory([]);
        this.renderFeed();
        this.updateAnalytics();
        this.notifications.showToast('Feed Cleared', 'All current mentions removed from dashboard view.', 'info');
      });
    }

    // Export CSV
    const btnExport = document.getElementById('btn-export-csv');
    if (btnExport) {
      btnExport.addEventListener('click', () => this.exportCSV());
    }

    // Search and Filter Listeners
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.searchQuery = e.target.value.toLowerCase();
        this.renderFeed();
      });
    }

    const platformSelect = document.getElementById('filter-platform');
    if (platformSelect) {
      platformSelect.addEventListener('change', (e) => {
        this.selectedPlatform = e.target.value;
        this.renderFeed();
      });
    }

    const sentimentSelect = document.getElementById('filter-sentiment');
    if (sentimentSelect) {
      sentimentSelect.addEventListener('change', (e) => {
        this.selectedSentiment = e.target.value;
        this.renderFeed();
      });
    }

    // Toggle Switches in Sidebar
    const toggleBrowserPush = document.getElementById('toggle-browser-push');
    if (toggleBrowserPush) {
      toggleBrowserPush.addEventListener('change', async (e) => {
        const notifConfig = StorageManager.getNotificationConfig();
        if (e.target.checked) {
          const res = await this.notifications.requestPushPermission();
          notifConfig.enableBrowserPush = res.success;
          e.target.checked = res.success;
        } else {
          notifConfig.enableBrowserPush = false;
        }
        StorageManager.saveNotificationConfig(notifConfig);
      });
    }

    const toggleAudio = document.getElementById('toggle-audio-alert');
    if (toggleAudio) {
      toggleAudio.addEventListener('change', (e) => {
        const notifConfig = StorageManager.getNotificationConfig();
        notifConfig.enableSound = e.target.checked;
        StorageManager.saveNotificationConfig(notifConfig);
      });
    }

    const toggleWebhook = document.getElementById('toggle-webhook');
    if (toggleWebhook) {
      toggleWebhook.addEventListener('change', (e) => {
        const notifConfig = StorageManager.getNotificationConfig();
        if (e.target.checked && !notifConfig.webhookUrl) {
          this.openSettingsModal();
          this.notifications.showToast('Webhook URL Required', 'Please enter a Slack or Discord webhook endpoint.', 'info');
        }
        notifConfig.enableWebhooks = e.target.checked;
        StorageManager.saveNotificationConfig(notifConfig);
      });
    }

    // Test Webhook Button
    const btnTestWebhook = document.getElementById('btn-test-webhook');
    if (btnTestWebhook) {
      btnTestWebhook.addEventListener('click', async () => {
        const config = StorageManager.getNotificationConfig();
        if (!config.webhookUrl) {
          this.openSettingsModal();
          this.notifications.showToast('No Webhook Configured', 'Add a webhook URL in settings first.', 'warning');
          return;
        }

        const mockMention = {
          id: 'test_123',
          platform: 'X',
          authorName: 'Test Automation',
          authorHandle: '@bot',
          matchedKeyword: StorageManager.getCompanyConfig().companyName,
          text: 'This is a test notification from your Pulse Social Media Monitor system!',
          sentiment: 'positive',
          timestamp: new Date().toISOString(),
          url: '#'
        };

        const res = await this.notifications.dispatchWebhook(mockMention);
        if (res.sent && res.ok) {
          this.notifications.showToast('Test Webhook Delivered!', 'Successfully sent alert to configured webhook.', 'positive');
        } else {
          this.notifications.showToast('Webhook Delivery Failed', res.error || `HTTP ${res.status}`, 'negative');
        }
      });
    }

    // Modal Control Triggers
    document.getElementById('btn-open-keywords')?.addEventListener('click', () => this.openKeywordsModal());
    document.getElementById('btn-edit-company-inline')?.addEventListener('click', () => this.openKeywordsModal());
    document.getElementById('btn-close-modal-keywords')?.addEventListener('click', () => this.closeModal('modal-keywords'));
    document.getElementById('btn-cancel-keywords')?.addEventListener('click', () => this.closeModal('modal-keywords'));
    document.getElementById('btn-save-keywords')?.addEventListener('click', () => this.saveKeywordsFromModal());

    document.getElementById('btn-open-settings')?.addEventListener('click', () => this.openSettingsModal());
    document.getElementById('btn-close-modal-settings')?.addEventListener('click', () => this.closeModal('modal-settings'));
    document.getElementById('btn-cancel-settings')?.addEventListener('click', () => this.closeModal('modal-settings'));
    document.getElementById('btn-save-settings')?.addEventListener('click', () => this.saveSettingsFromModal());

    // Inline Tag Input Keydown
    document.getElementById('input-new-alias')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const val = e.target.value.trim();
        if (val && !this.tempAliases.includes(val)) {
          this.tempAliases.push(val);
          e.target.value = '';
          this.renderModalTagList('container-brand-aliases', this.tempAliases, 'alias');
        }
      }
    });

    document.getElementById('input-new-excluded')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const val = e.target.value.trim();
        if (val && !this.tempExcluded.includes(val)) {
          this.tempExcluded.push(val);
          e.target.value = '';
          this.renderModalTagList('container-excluded-words', this.tempExcluded, 'excluded');
        }
      }
    });
  }

  loadStateToUI() {
    const comp = StorageManager.getCompanyConfig();
    const notif = StorageManager.getNotificationConfig();

    document.getElementById('sidebar-company-name').textContent = comp.companyName;

    const togglePush = document.getElementById('toggle-browser-push');
    if (togglePush) togglePush.checked = notif.enableBrowserPush;

    const toggleAudio = document.getElementById('toggle-audio-alert');
    if (toggleAudio) toggleAudio.checked = notif.enableSound;

    const toggleWebhook = document.getElementById('toggle-webhook');
    if (toggleWebhook) toggleWebhook.checked = notif.enableWebhooks;
  }

  renderSidebarKeywords() {
    const comp = StorageManager.getCompanyConfig();
    const container = document.getElementById('sidebar-keywords-list');
    if (!container) return;

    const allKw = [comp.companyName, ...(comp.brandAliases || [])].filter(Boolean);
    container.innerHTML = allKw.map(kw => `
      <span class="platform-badge" style="background: rgba(99, 102, 241, 0.15); color: #a5b4fc; border: 1px solid rgba(99,102,241,0.3);">
        ${this.notifications.escapeHtml(kw)}
      </span>
    `).join('');
  }

  handleNewMention(mention) {
    this.mentions.unshift(mention);
    StorageManager.saveMentionsHistory(this.mentions);

    this.renderFeed();
    this.updateAnalytics();

    // Trigger Notification Systems
    this.notifications.playAudioAlert(mention.sentiment === 'negative');

    if (mention.sentiment === 'negative') {
      this.notifications.showToast(
        `🚨 Negative Mention on ${mention.platform}`,
        `"${mention.text.substring(0, 75)}..."`,
        'negative'
      );

      this.notifications.sendDesktopPush(`🚨 Urgent Brand Alert (${mention.platform})`, {
        body: mention.text,
        requireInteraction: true
      });

      this.notifications.dispatchWebhook(mention);
    } else {
      this.notifications.showToast(
        `Mention on ${mention.platform}`,
        `Keyword: "${mention.matchedKeyword}" by ${mention.authorName}`,
        'info',
        3000
      );
    }
  }

  handleCrisisAlert(crisisInfo) {
    this.notifications.playAudioAlert(true);
    this.notifications.showToast(
      `🔥 CRISIS ALERT TRIGGERED`,
      `${crisisInfo.count} negative mentions detected in the last 5 minutes!`,
      'negative',
      8000
    );

    const crisisBadge = document.getElementById('stat-crisis-badge');
    if (crisisBadge) {
      crisisBadge.textContent = '🔥 SPIKE';
      crisisBadge.className = 'metric-change down';
    }
  }

  renderFeed() {
    const feedEl = document.getElementById('mention-feed');
    if (!feedEl) return;

    // Filter mentions based on active search & dropdowns
    const filtered = this.mentions.filter(m => {
      if (this.selectedPlatform !== 'all' && m.platform.toLowerCase() !== this.selectedPlatform.toLowerCase()) {
        return false;
      }
      if (this.selectedSentiment !== 'all' && m.sentiment !== this.selectedSentiment) {
        return false;
      }
      if (this.searchQuery) {
        const fullTxt = `${m.authorName} ${m.authorHandle} ${m.text} ${m.matchedKeyword}`.toLowerCase();
        if (!fullTxt.includes(this.searchQuery)) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      feedEl.innerHTML = `
        <div style="text-align: center; padding: 3rem 1rem; color: var(--text-muted);">
          <div style="font-size: 2rem; margin-bottom: 0.5rem;">🛰️</div>
          <div style="font-size: 0.95rem; font-weight: 600;">No mentions matching current filters</div>
          <div style="font-size: 0.8rem; margin-top: 0.25rem;">Adjust search filters or wait for incoming live mentions stream.</div>
        </div>
      `;
      return;
    }

    feedEl.innerHTML = filtered.map(m => {
      const timeStr = new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const platformClass = `platform-${m.platform.toLowerCase()}`;
      const isHighAlert = m.sentiment === 'negative';

      // Highlight matched keyword in body text
      let highlightedText = this.notifications.escapeHtml(m.text);
      if (m.matchedKeyword) {
        const regex = new RegExp(`(${m.matchedKeyword})`, 'gi');
        highlightedText = highlightedText.replace(regex, `<span class="highlight-keyword">$1</span>`);
      }

      return `
        <article class="mention-card ${isHighAlert ? 'high-alert' : ''} ${m.unread ? 'unread' : ''}">
          <header class="mention-header">
            <div class="author-info">
              <div class="author-avatar">${m.authorName.charAt(0)}</div>
              <div class="author-details">
                <span class="author-name">${this.notifications.escapeHtml(m.authorName)}</span>
                <span class="author-handle">${this.notifications.escapeHtml(m.authorHandle)}</span>
              </div>
            </div>

            <span class="platform-badge ${platformClass}">${m.platform}</span>
          </header>

          <p class="mention-content">${highlightedText}</p>

          <footer class="mention-footer">
            <div style="display: flex; align-items: center; gap: 0.6rem;">
              <span class="sentiment-pill sentiment-${m.sentiment}">
                ${m.sentiment === 'positive' ? '🟢 Positive' : (m.sentiment === 'negative' ? '🔴 Negative' : '⚪ Neutral')}
              </span>
              <span>Matched: <strong>${this.notifications.escapeHtml(m.matchedKeyword)}</strong></span>
            </div>

            <div class="mention-meta-actions">
              <span>${timeStr}</span>
              <a href="${m.url}" target="_blank" class="action-link">View Post ↗</a>
            </div>
          </footer>
        </article>
      `;
    }).join('');
  }

  updateAnalytics() {
    AnalyticsEngine.renderAnalyticsUI(this.mentions);
  }

  exportCSV() {
    if (this.mentions.length === 0) {
      this.notifications.showToast('No Data', 'No mentions available to export.', 'warning');
      return;
    }

    const headers = ['ID', 'Timestamp', 'Platform', 'Author Name', 'Author Handle', 'Keyword', 'Sentiment', 'Text'];
    const rows = this.mentions.map(m => [
      m.id,
      m.timestamp,
      m.platform,
      `"${m.authorName.replace(/"/g, '""')}"`,
      `"${m.authorHandle.replace(/"/g, '""')}"`,
      `"${m.matchedKeyword.replace(/"/g, '""')}"`,
      m.sentiment,
      `"${m.text.replace(/"/g, '""')}"`
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `social_mentions_export_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    this.notifications.showToast('CSV Download Started', 'Exported mention history to CSV.', 'positive');
  }

  openKeywordsModal() {
    const comp = StorageManager.getCompanyConfig();
    document.getElementById('input-company-name').value = comp.companyName || '';
    document.getElementById('input-check-interval').value = comp.checkIntervalSeconds || 5;

    this.tempAliases = [...(comp.brandAliases || [])];
    this.tempExcluded = [...(comp.excludedTerms || [])];

    this.renderModalTagList('container-brand-aliases', this.tempAliases, 'alias');
    this.renderModalTagList('container-excluded-words', this.tempExcluded, 'excluded');

    document.getElementById('modal-keywords').classList.add('active');
  }

  renderModalTagList(containerId, list, type) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const inputId = type === 'alias' ? 'input-new-alias' : 'input-new-excluded';
    const inputEl = document.getElementById(inputId);

    const tagsHtml = list.map((item, idx) => `
      <span class="keyword-tag">
        ${this.notifications.escapeHtml(item)}
        <span class="keyword-tag-remove" data-type="${type}" data-idx="${idx}">✕</span>
      </span>
    `).join('');

    container.innerHTML = tagsHtml;
    container.appendChild(inputEl);

    // Bind remove event listeners
    container.querySelectorAll('.keyword-tag-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const index = parseInt(e.target.getAttribute('data-idx'));
        if (type === 'alias') this.tempAliases.splice(index, 1);
        else this.tempExcluded.splice(index, 1);
        this.renderModalTagList(containerId, type === 'alias' ? this.tempAliases : this.tempExcluded, type);
      });
    });
  }

  saveKeywordsFromModal() {
    const comp = StorageManager.getCompanyConfig();
    const newName = document.getElementById('input-company-name').value.trim();
    const newInterval = parseInt(document.getElementById('input-check-interval').value) || 5;

    if (newName) comp.companyName = newName;
    comp.brandAliases = this.tempAliases;
    comp.excludedTerms = this.tempExcluded;
    comp.checkIntervalSeconds = Math.max(2, Math.min(60, newInterval));

    StorageManager.saveCompanyConfig(comp);
    this.loadStateToUI();
    this.renderSidebarKeywords();
    this.closeModal('modal-keywords');

    // Restart monitor with new interval & rules
    this.monitor.stopStream();
    this.monitor.startStream();

    this.notifications.showToast('Keywords Saved', 'Updated target brand monitoring criteria.', 'positive');
  }

  openSettingsModal() {
    const notif = StorageManager.getNotificationConfig();
    document.getElementById('input-webhook-url').value = notif.webhookUrl || '';
    document.getElementById('input-crisis-threshold').value = notif.crisisThreshold || 3;

    document.getElementById('modal-settings').classList.add('active');
  }

  saveSettingsFromModal() {
    const notif = StorageManager.getNotificationConfig();
    notif.webhookUrl = document.getElementById('input-webhook-url').value.trim();
    notif.crisisThreshold = parseInt(document.getElementById('input-crisis-threshold').value) || 3;

    if (notif.webhookUrl) notif.enableWebhooks = true;

    StorageManager.saveNotificationConfig(notif);
    this.loadStateToUI();
    this.closeModal('modal-settings');

    this.notifications.showToast('Notification Rules Saved', 'Updated webhook and alert thresholds.', 'positive');
  }

  closeModal(modalId) {
    document.getElementById(modalId)?.classList.remove('active');
  }
}

// Bootstrap Application on DOM Content Loaded
document.addEventListener('DOMContentLoaded', () => {
  const app = new AppController();
  app.init();
});
