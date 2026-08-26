/**
 * Minimal 5-field cron parser: "minute hour day-of-month month day-of-week".
 *
 * Supported syntax per field: a wildcard, a wildcard with a step, a single
 * value, a range, a range with a step, and comma-separated lists of those.
 * Month and weekday names (JAN..DEC, SUN..SAT) are accepted. Seconds are not
 * supported - the scheduler uses plain intervals for anything sub-minute.
 */

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 6 }
];

/** How far ahead nextRun() is willing to search before giving up (~1 year). */
const MAX_SEARCH_MINUTES = 366 * 24 * 60;

function nameToNumber(token, fieldName) {
  const lower = token.toLowerCase();
  if (fieldName === 'month') {
    const index = MONTH_NAMES.indexOf(lower);
    if (index !== -1) return index + 1;
  }
  if (fieldName === 'dayOfWeek') {
    const index = DAY_NAMES.indexOf(lower);
    if (index !== -1) return index;
  }
  return null;
}

function parseNumber(token, field) {
  const named = nameToNumber(token, field.name);
  if (named !== null) return named;

  if (!/^\d+$/.test(token)) {
    throw new Error(`cron: "${token}" is not a valid ${field.name} value`);
  }

  let value = Number(token);
  // Cron allows 7 as an alias for Sunday.
  if (field.name === 'dayOfWeek' && value === 7) value = 0;

  if (value < field.min || value > field.max) {
    throw new Error(
      `cron: ${field.name} ${value} out of range ${field.min}-${field.max}`
    );
  }
  return value;
}

/** Turns one cron field into a Set of the numbers it matches. */
function parseField(expression, field) {
  const matches = new Set();

  for (const part of expression.split(',')) {
    const token = part.trim();
    if (!token) throw new Error(`cron: empty ${field.name} entry`);

    const [rangePart, stepPart] = token.split('/');
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) === 0) {
        throw new Error(`cron: invalid step "${stepPart}" in ${field.name}`);
      }
      step = Number(stepPart);
    }

    let start;
    let end;
    if (rangePart === '*') {
      start = field.min;
      end = field.max;
    } else if (rangePart.includes('-')) {
      const [from, to] = rangePart.split('-');
      start = parseNumber(from, field);
      end = parseNumber(to, field);
      if (end < start) {
        throw new Error(`cron: reversed range "${rangePart}" in ${field.name}`);
      }
    } else {
      start = parseNumber(rangePart, field);
      end = stepPart === undefined ? start : field.max;
    }

    for (let value = start; value <= end; value += step) matches.add(value);
  }

  return matches;
}

/**
 * @param {string} expression e.g. "*\/10 * * * *"
 * @returns {{fields: Object, expression: string, matches: Function, nextRun: Function}}
 */
export function parseCron(expression) {
  const parts = String(expression).trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `cron: expected 5 fields, got ${parts.length} in "${expression}"`
    );
  }

  const fields = {};
  FIELDS.forEach((field, index) => {
    fields[field.name] = parseField(parts[index], field);
  });

  const domRestricted = parts[2].trim() !== '*';
  const dowRestricted = parts[4].trim() !== '*';

  function matches(date) {
    if (!fields.minute.has(date.getMinutes())) return false;
    if (!fields.hour.has(date.getHours())) return false;
    if (!fields.month.has(date.getMonth() + 1)) return false;

    const dayOfMonthOk = fields.dayOfMonth.has(date.getDate());
    const dayOfWeekOk = fields.dayOfWeek.has(date.getDay());

    // Standard cron quirk: when both day fields are restricted, either may match.
    if (domRestricted && dowRestricted) return dayOfMonthOk || dayOfWeekOk;
    if (domRestricted) return dayOfMonthOk;
    if (dowRestricted) return dayOfWeekOk;
    return true;
  }

  /** First matching minute strictly after `from`. Returns null if none within a year. */
  function nextRun(from = new Date()) {
    const candidate = new Date(from.getTime());
    candidate.setSeconds(0, 0);
    candidate.setMinutes(candidate.getMinutes() + 1);

    for (let step = 0; step < MAX_SEARCH_MINUTES; step += 1) {
      if (matches(candidate)) return candidate;
      candidate.setMinutes(candidate.getMinutes() + 1);
    }
    return null;
  }

  return { expression: String(expression).trim(), fields, matches, nextRun };
}

/** True when `expression` parses as a 5-field cron. */
export function isValidCron(expression) {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}
