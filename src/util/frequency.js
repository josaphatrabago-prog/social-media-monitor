/**
 * Parses the many shapes a monitoring frequency can take into one object the
 * scheduler understands. Accepts presets, durations, raw seconds and cron.
 */
import { parseCron, isValidCron } from './cron.js';

/** Named presets offered in the dashboard dropdown. */
export const FREQUENCY_PRESETS = {
  realtime: 30,
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '12h': 43200
};

/**
 * Polling floor. Platform APIs are quota-metered, so anything faster than this
 * burns quota without producing fresher data.
 */
export const MIN_INTERVAL_SECONDS = 10;
export const MAX_INTERVAL_SECONDS = 7 * 24 * 3600;

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours|d|days)$/i;

const DURATION_MULTIPLIER = {
  s: 1, sec: 1, secs: 1, seconds: 1,
  m: 60, min: 60, mins: 60, minutes: 60,
  h: 3600, hr: 3600, hrs: 3600, hours: 3600,
  d: 86400, days: 86400
};

function clamp(seconds) {
  return Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, Math.round(seconds)));
}

/**
 * @param {string|number} input  "5m" | "realtime" | 90 | "cron:0 * * * *"
 * @returns {{kind: 'interval'|'cron', seconds?: number, cron?: object,
 *            label: string, source: string}}
 */
export function parseFrequency(input) {
  if (input === null || input === undefined || input === '') {
    throw new Error('frequency: value is required');
  }

  const source = String(input).trim();

  if (typeof input === 'number' || /^\d+(\.\d+)?$/.test(source)) {
    const seconds = clamp(Number(source));
    return { kind: 'interval', seconds, label: describeSeconds(seconds), source };
  }

  const lower = source.toLowerCase();

  if (lower.startsWith('cron:') || lower.startsWith('cron ')) {
    const expression = source.slice(5).trim();
    if (!isValidCron(expression)) {
      throw new Error(`frequency: invalid cron expression "${expression}"`);
    }
    return {
      kind: 'cron',
      cron: parseCron(expression),
      label: `cron (${expression})`,
      source
    };
  }

  if (FREQUENCY_PRESETS[lower] !== undefined) {
    const seconds = FREQUENCY_PRESETS[lower];
    const label = lower === 'realtime' ? `real-time (${seconds}s)` : describeSeconds(seconds);
    return { kind: 'interval', seconds, label, source };
  }

  const duration = DURATION_PATTERN.exec(lower);
  if (duration) {
    const seconds = clamp(Number(duration[1]) * DURATION_MULTIPLIER[duration[2].toLowerCase()]);
    return { kind: 'interval', seconds, label: describeSeconds(seconds), source };
  }

  // A bare 5-field cron with no "cron:" prefix is a common thing to type.
  if (isValidCron(source)) {
    return {
      kind: 'cron',
      cron: parseCron(source),
      label: `cron (${source})`,
      source: `cron:${source}`
    };
  }

  throw new Error(
    `frequency: cannot understand "${source}". Use a preset ` +
    `(${Object.keys(FREQUENCY_PRESETS).join(', ')}), a duration like "45s" or "2h", ` +
    'a number of seconds, or "cron:*/10 * * * *".'
  );
}

export function describeSeconds(seconds) {
  if (seconds < 60) return `every ${seconds}s`;
  if (seconds < 3600) {
    const minutes = seconds / 60;
    return `every ${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)}m`;
  }
  if (seconds < 86400) {
    const hours = seconds / 3600;
    return `every ${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
  }
  const days = seconds / 86400;
  return `every ${Number.isInteger(days) ? days : days.toFixed(1)}d`;
}

/** True when the value is a frequency this module can parse. */
export function isValidFrequency(input) {
  try {
    parseFrequency(input);
    return true;
  } catch {
    return false;
  }
}
