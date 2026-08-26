/**
 * Configuration loader.
 *
 * Two representations are kept side by side:
 *   - raw:      exactly what is on disk, with "env:NAME" placeholders intact
 *   - resolved: placeholders swapped for real secret values, used at runtime
 *
 * Runtime edits are applied to raw and then re-resolved, so saving config.json
 * can never bake a credential into a file the user commits.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './log.js';
import { isValidFrequency, parseFrequency } from './util/frequency.js';

const log = createLogger('config');

const SECRET_KEY_PATTERN = /token|key|secret|pass|access|webhook|url$/i;

const DEFAULTS = {
  companies: [],
  monitoring: {
    frequency: '5m',
    perPlatform: {},
    enabledPlatforms: ['facebook', 'youtube', 'tiktok', 'instagram'],
    lookbackMinutes: 120,
    maxItemsPerPoll: 50,
    mockMode: 'auto',
    startPaused: false
  },
  sentiment: {
    positiveThreshold: 1,
    negativeThreshold: -1,
    extraPositive: [],
    extraNegative: []
  },
  crisis: {
    windowMinutes: 15,
    negativeThreshold: 5,
    baselineMultiplier: 3,
    cooldownMinutes: 30
  },
  notifications: {
    rateLimit: { maxPerMinute: 30 },
    desktop: { enabled: true, events: ['mention.negative', 'crisis'] },
    webhooks: [],
    email: {
      enabled: false,
      from: '',
      to: [],
      events: ['crisis'],
      smtp: { host: '', port: 465, secure: true, user: '', pass: '' }
    }
  },
  platforms: {},
  storage: { dataDir: './data', maxMentions: 20000, retentionDays: 90 },
  server: { host: '127.0.0.1', port: 3000 }
};

const KNOWN_PLATFORMS = ['facebook', 'youtube', 'tiktok', 'instagram'];
const KNOWN_EVENTS = [
  'mention.any',
  'mention.positive',
  'mention.neutral',
  'mention.negative',
  'crisis'
];

/* ------------------------------------------------------------------ helpers */

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Deep merge where arrays replace rather than concatenate. */
function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : override;
  }

  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = isPlainObject(value) && isPlainObject(base[key])
      ? deepMerge(base[key], value)
      : value;
  }
  return result;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Loads KEY=value pairs from a .env file without clobbering real env vars. */
export function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return {};

  const loaded = {};
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const withoutExport = trimmed.replace(/^export\s+/, '');
    const separator = withoutExport.indexOf('=');
    if (separator === -1) continue;

    const key = withoutExport.slice(0, separator).trim();
    let value = withoutExport.slice(separator + 1).trim();

    const isQuoted = (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (isQuoted && value.length >= 2) value = value.slice(1, -1);

    if (!key) continue;
    loaded[key] = value;
    if (process.env[key] === undefined) process.env[key] = value;
  }

  return loaded;
}

/**
 * Replaces "env:NAME" and dollar-brace placeholders with environment values.
 * An unset variable resolves to '' so callers can treat it as "not configured".
 */
function resolvePlaceholders(node) {
  if (typeof node === 'string') {
    if (node.startsWith('env:')) return process.env[node.slice(4).trim()] ?? '';
    return node.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name) => process.env[name] ?? '');
  }
  if (Array.isArray(node)) return node.map(resolvePlaceholders);
  if (isPlainObject(node)) {
    const result = {};
    for (const [key, value] of Object.entries(node)) {
      // Any "$..." key is documentation for whoever edits config.json and is
      // dropped before the config reaches the app.
      if (key.startsWith('$')) continue;
      result[key] = resolvePlaceholders(value);
    }
    return result;
  }
  return node;
}

/** Applies the env vars that are allowed to win over config.json. */
function applyEnvOverrides(config) {
  const result = clone(config);

  if (process.env.PORT) result.server.port = Number(process.env.PORT);
  if (process.env.HOST) result.server.host = process.env.HOST;
  if (process.env.MONITOR_FREQUENCY) result.monitoring.frequency = process.env.MONITOR_FREQUENCY;
  if (process.env.SMTP_PORT) result.notifications.email.smtp.port = Number(process.env.SMTP_PORT);

  if (process.env.ALERT_EMAIL_TO) {
    const recipients = process.env.ALERT_EMAIL_TO
      .split(',')
      .map((address) => address.trim())
      .filter(Boolean);

    if (recipients.length) {
      result.notifications.email.to = recipients;
      result.notifications.email.enabled = true;
    }
  }

  return result;
}

/* --------------------------------------------------------------- validation */

/** @returns {{errors: string[], warnings: string[]}} */
export function validateConfig(config) {
  const errors = [];
  const warnings = [];

  if (!Array.isArray(config.companies) || config.companies.length === 0) {
    errors.push('companies: at least one company is required');
  } else {
    const seenIds = new Set();

    config.companies.forEach((company, index) => {
      const where = `companies[${index}]`;

      if (!company.name || typeof company.name !== 'string') {
        errors.push(`${where}.name is required`);
      }

      if (!company.id) {
        errors.push(`${where}.id is required`);
      } else if (seenIds.has(company.id)) {
        errors.push(`${where}.id "${company.id}" is duplicated`);
      } else {
        seenIds.add(company.id);
      }

      for (const field of ['aliases', 'hashtags', 'handles', 'exclude', 'searchTerms']) {
        if (company[field] !== undefined && !Array.isArray(company[field])) {
          errors.push(`${where}.${field} must be an array`);
        }
      }
    });
  }

  if (!isValidFrequency(config.monitoring.frequency)) {
    errors.push(`monitoring.frequency: "${config.monitoring.frequency}" is not a valid frequency`);
  }

  for (const [platform, frequency] of Object.entries(config.monitoring.perPlatform || {})) {
    if (!KNOWN_PLATFORMS.includes(platform)) {
      warnings.push(`monitoring.perPlatform: unknown platform "${platform}"`);
    }
    if (!isValidFrequency(frequency)) {
      errors.push(`monitoring.perPlatform.${platform}: "${frequency}" is not a valid frequency`);
    }
  }

  for (const platform of config.monitoring.enabledPlatforms || []) {
    if (!KNOWN_PLATFORMS.includes(platform)) {
      warnings.push(`monitoring.enabledPlatforms: unknown platform "${platform}"`);
    }
  }

  if (!['auto', 'on', 'off'].includes(config.monitoring.mockMode)) {
    errors.push('monitoring.mockMode must be one of: auto, on, off');
  }

  const { crisis } = config;
  if (!(crisis.windowMinutes > 0)) errors.push('crisis.windowMinutes must be greater than 0');
  if (!(crisis.negativeThreshold >= 1)) errors.push('crisis.negativeThreshold must be at least 1');
  if (!(crisis.baselineMultiplier >= 1)) errors.push('crisis.baselineMultiplier must be at least 1');

  if (config.sentiment.positiveThreshold < config.sentiment.negativeThreshold) {
    errors.push('sentiment.positiveThreshold must be >= sentiment.negativeThreshold');
  }

  (config.notifications.webhooks || []).forEach((hook, index) => {
    const where = `notifications.webhooks[${index}]`;
    const label = hook.name || hook.type || index;

    if (!['slack', 'discord', 'teams', 'generic'].includes(hook.type)) {
      errors.push(`${where}.type must be slack, discord, teams or generic`);
    }
    if (hook.enabled && !hook.url) {
      warnings.push(`${where} ("${label}") is enabled but has no URL - it will be skipped`);
    }
    if (hook.url && !/^https:\/\//i.test(hook.url)) {
      errors.push(`${where}.url must be an https URL`);
    }
    for (const event of hook.events || []) {
      if (!KNOWN_EVENTS.includes(event)) {
        warnings.push(`${where}.events: unknown event "${event}"`);
      }
    }
  });

  const { email } = config.notifications;
  if (email.enabled) {
    if (!email.smtp.host) {
      warnings.push('notifications.email is enabled but SMTP host is empty - email alerts will be skipped');
    }
    if (!email.to || email.to.length === 0) {
      warnings.push('notifications.email is enabled but has no recipients');
    }
  }

  const port = Number(config.server.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push(`server.port "${config.server.port}" is not a valid port`);
  }

  return { errors, warnings };
}

/* ------------------------------------------------------------------- loader */

/** Removes from `overrides` every key that `patch` sets explicitly. */
function dropOverriddenKeys(overrides, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in overrides)) continue;

    if (isPlainObject(value) && isPlainObject(overrides[key])) {
      dropOverriddenKeys(overrides[key], value);
      if (Object.keys(overrides[key]).length === 0) delete overrides[key];
    } else {
      delete overrides[key];
    }
  }
}

function redact(node, keyName = '') {
  if (typeof node === 'string') {
    if (!node) return '';
    if (!SECRET_KEY_PATTERN.test(keyName)) return node;
    return node.length <= 8 ? '********' : `${node.slice(0, 4)}...${node.slice(-2)}`;
  }
  if (Array.isArray(node)) return node.map((item) => redact(item, keyName));
  if (isPlainObject(node)) {
    const result = {};
    for (const [key, value] of Object.entries(node)) result[key] = redact(value, key);
    return result;
  }
  return node;
}

export class ConfigStore {
  constructor(configPath) {
    this.configPath = configPath;
    this.raw = clone(DEFAULTS);
    this.resolved = clone(DEFAULTS);
    this.warnings = [];

    /**
     * Session-only values from CLI flags such as --mock or --frequency.
     *
     * Held apart from `raw` because save() writes `raw` to disk: if a flag were
     * merged into it, the first persisted change from anywhere in the app would
     * silently make that flag permanent.
     */
    this.overrides = {};
  }

  /** Reads .env and config.json from disk. Throws on validation errors. */
  load() {
    loadEnvFile(path.join(path.dirname(this.configPath), '.env'));

    let fromDisk = {};
    if (fs.existsSync(this.configPath)) {
      try {
        fromDisk = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      } catch (error) {
        throw new Error(`config: ${this.configPath} is not valid JSON - ${error.message}`);
      }
    } else {
      log.warn(`${this.configPath} not found - using built-in defaults`);
    }

    this.raw = deepMerge(clone(DEFAULTS), fromDisk);
    this.refresh();
    return this.resolved;
  }

  /** Re-resolves placeholders and re-validates. Throws if invalid. */
  refresh() {
    const merged = deepMerge(this.raw, this.overrides);
    const resolved = applyEnvOverrides(resolvePlaceholders(merged));
    const { errors, warnings } = validateConfig(resolved);

    if (errors.length) {
      throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
    }

    // Only log warnings that are new. refresh() runs on every update, and
    // re-printing the same six lines after each config change buries the ones
    // that actually just appeared.
    const alreadySeen = new Set(this.warnings);
    warnings.filter((warning) => !alreadySeen.has(warning)).forEach((warning) => log.warn(warning));

    this.warnings = warnings;
    this.resolved = resolved;
  }

  get() {
    return this.resolved;
  }

  /**
   * Merges a patch into the raw config and re-validates. On failure the
   * previous config is restored, so a bad API call cannot break a live monitor.
   */
  update(patch) {
    const previousRaw = clone(this.raw);
    const previousOverrides = clone(this.overrides);

    // An explicit change wins over a CLI flag for the same key, otherwise the
    // flag would keep shadowing it for the rest of the session.
    dropOverriddenKeys(this.overrides, patch);
    this.raw = deepMerge(this.raw, patch);

    try {
      this.refresh();
    } catch (error) {
      this.raw = previousRaw;
      this.overrides = previousOverrides;
      this.refresh();
      throw error;
    }

    return this.resolved;
  }

  /**
   * Applies session-only CLI overrides. These affect the running process but
   * are never written by save().
   */
  setOverrides(patch) {
    const previousOverrides = clone(this.overrides);
    this.overrides = deepMerge(this.overrides, patch);

    try {
      this.refresh();
    } catch (error) {
      this.overrides = previousOverrides;
      this.refresh();
      throw error;
    }

    return this.resolved;
  }

  /** Persists the raw config (placeholders intact) back to config.json. */
  save() {
    fs.writeFileSync(this.configPath, `${JSON.stringify(this.raw, null, 2)}\n`, 'utf8');
    log.info(`saved ${path.basename(this.configPath)}`);
  }

  /** Resolved config with secret-looking values masked, safe to send to the UI. */
  redacted() {
    return redact(this.resolved);
  }
}

/** Convenience wrapper used by server.js. */
export function loadConfig(configPath) {
  const store = new ConfigStore(configPath);
  store.load();
  return store;
}

export { DEFAULTS, KNOWN_EVENTS, KNOWN_PLATFORMS, deepMerge, parseFrequency };
