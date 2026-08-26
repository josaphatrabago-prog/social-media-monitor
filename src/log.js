/** Tiny levelled logger with a ring buffer the dashboard can read back. */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_BUFFERED_LINES = 300;

const COLORS = {
  debug: '\u001b[90m',
  info: '\u001b[36m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
  reset: '\u001b[0m'
};

const recent = [];
let minLevel = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function write(level, scope, message, detail) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    scope,
    message: String(message),
    detail: detail === undefined ? undefined : detail
  };

  recent.push(entry);
  if (recent.length > MAX_BUFFERED_LINES) recent.shift();

  if (LEVELS[level] < minLevel) return;

  const time = entry.ts.slice(11, 19);
  const label = level.toUpperCase().padEnd(5);
  const line = `${COLORS[level]}${time} ${label}${COLORS.reset} [${scope}] ${entry.message}`;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;

  stream.write(detail === undefined ? `${line}\n` : `${line} ${format(detail)}\n`);
}

function format(detail) {
  if (detail instanceof Error) return detail.stack || detail.message;
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

/** Returns a logger bound to a scope, e.g. createLogger('youtube'). */
export function createLogger(scope) {
  return {
    debug: (message, detail) => write('debug', scope, message, detail),
    info: (message, detail) => write('info', scope, message, detail),
    warn: (message, detail) => write('warn', scope, message, detail),
    error: (message, detail) => write('error', scope, message, detail)
  };
}

export function setLogLevel(level) {
  if (LEVELS[level] !== undefined) minLevel = LEVELS[level];
}

/** Most recent log lines, newest last. */
export function recentLogs(limit = 100) {
  return recent.slice(-limit);
}
