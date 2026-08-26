/**
 * Storage Manager - Handles local storage persistence for company profiles,
 * notification channels, rules, and mention history.
 */

const STORAGE_KEYS = {
  COMPANY_CONFIG: 'social_monitor_company_config',
  NOTIFICATION_CONFIG: 'social_monitor_notification_config',
  MENTIONS_HISTORY: 'social_monitor_mentions_history',
  ALERT_LOGS: 'social_monitor_alert_logs'
};

const DEFAULT_COMPANY_CONFIG = {
  companyName: 'CEBU RITEHOMES DEVELOPMENT & REALTY CORP.',
  brandAliases: [
    'CEBU RITEHOMES',
    'Cebu Rite Homes',
    'Ritehomes Realty',
    'ROVEN TECHNIC CONSTRUCTION',
    'Roven Technic',
    'Roven Construction'
  ],
  competitorKeywords: ['Cebu Real Estate', 'Cebu Contractors'],
  excludedTerms: ['unrelated'],
  checkIntervalSeconds: 10,
  monitoredPlatforms: ['Facebook', 'YouTube', 'TikTok', 'Instagram']
};

const DEFAULT_NOTIFICATION_CONFIG = {
  enableBrowserPush: false,
  enableWebhooks: false,
  webhookUrl: '',
  enableSound: true,
  soundOnNegativeOnly: false,
  alertOnCrisisOnly: false,
  crisisThreshold: 3
};

export class StorageManager {
  static getCompanyConfig() {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.COMPANY_CONFIG);
      return data ? JSON.parse(data) : { ...DEFAULT_COMPANY_CONFIG };
    } catch (e) {
      console.warn('StorageManager error fetching company config:', e);
      return { ...DEFAULT_COMPANY_CONFIG };
    }
  }

  static saveCompanyConfig(config) {
    try {
      localStorage.setItem(STORAGE_KEYS.COMPANY_CONFIG, JSON.stringify(config));
    } catch (e) {
      console.error('Failed to save company config:', e);
    }
  }

  static getNotificationConfig() {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.NOTIFICATION_CONFIG);
      return data ? JSON.parse(data) : { ...DEFAULT_NOTIFICATION_CONFIG };
    } catch (e) {
      console.warn('StorageManager error fetching notification config:', e);
      return { ...DEFAULT_NOTIFICATION_CONFIG };
    }
  }

  static saveNotificationConfig(config) {
    try {
      localStorage.setItem(STORAGE_KEYS.NOTIFICATION_CONFIG, JSON.stringify(config));
    } catch (e) {
      console.error('Failed to save notification config:', e);
    }
  }

  static getMentionsHistory() {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.MENTIONS_HISTORY);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  }

  static saveMentionsHistory(mentions) {
    try {
      const trimmed = mentions.slice(0, 250);
      localStorage.setItem(STORAGE_KEYS.MENTIONS_HISTORY, JSON.stringify(trimmed));
    } catch (e) {
      console.error('Failed to save mentions history:', e);
    }
  }

  static getAlertLogs() {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.ALERT_LOGS);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  }

  static addAlertLog(logItem) {
    try {
      const logs = this.getAlertLogs();
      logs.unshift({
        id: 'alert_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        timestamp: new Date().toISOString(),
        ...logItem
      });
      localStorage.setItem(STORAGE_KEYS.ALERT_LOGS, JSON.stringify(logs.slice(0, 50)));
    } catch (e) {
      console.error('Failed to add alert log:', e);
    }
  }
}
