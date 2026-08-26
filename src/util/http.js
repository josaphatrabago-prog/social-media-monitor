/**
 * fetch() wrapper with a timeout, bounded retries and useful error messages.
 * Retries only on transport failures, HTTP 429 and 5xx - never on a 4xx,
 * which almost always means bad credentials or a malformed query.
 */

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 500;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Query parameters that carry credentials. Platform APIs take secrets in the
 * query string, so any error message quoting a URL verbatim writes the secret
 * to the log - and these errors are logged by design.
 */
const SECRET_QUERY_PARAMS = /^(access_token|key|api_key|apikey|token|client_secret|password|auth)$/i;

/** Replaces secret-bearing query values with a placeholder. */
export function redactUrl(url) {
  try {
    const parsed = new URL(url);
    let changed = false;

    for (const name of [...parsed.searchParams.keys()]) {
      if (!SECRET_QUERY_PARAMS.test(name)) continue;
      parsed.searchParams.set(name, 'REDACTED');
      changed = true;
    }

    return changed ? parsed.toString() : url;
  } catch {
    // Not a parseable URL; strip anything that looks like a token assignment.
    return String(url).replace(
      /\b(access_token|key|api_key|token|client_secret)=[^&\s]+/gi,
      '$1=REDACTED'
    );
  }
}

export class HttpError extends Error {
  constructor(status, statusText, body, url) {
    super(`HTTP ${status} ${statusText} for ${redactUrl(url)}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    // Kept redacted: this object is logged and serialised in places the raw
    // URL has no business reaching.
    this.url = redactUrl(url);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Truncated body text, so a giant HTML error page cannot flood the log. */
async function readBody(response) {
  try {
    const text = await response.text();
    return text.length > 600 ? `${text.slice(0, 600)}...` : text;
  } catch {
    return '';
  }
}

export async function request(url, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    ...fetchOptions
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { ...fetchOptions, signal: controller.signal });

      if (!response.ok) {
        const body = await readBody(response);
        const error = new HttpError(response.status, response.statusText, body, url);
        if (!RETRYABLE_STATUS.has(response.status) || attempt === retries) throw error;
        lastError = error;
      } else {
        return response;
      }
    } catch (error) {
      const isAbort = error.name === 'AbortError';
      lastError = isAbort
        ? new Error(`Request to ${redactUrl(url)} timed out after ${timeoutMs}ms`)
        : error;
      if (error instanceof HttpError && !RETRYABLE_STATUS.has(error.status)) throw error;
      if (attempt === retries) throw lastError;
    } finally {
      clearTimeout(timer);
    }

    await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
  }

  throw lastError;
}

export async function getJson(url, options = {}) {
  const response = await request(url, {
    ...options,
    headers: { accept: 'application/json', ...(options.headers || {}) }
  });
  return response.json();
}

export async function postJson(url, payload, options = {}) {
  const response = await request(url, {
    method: 'POST',
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {})
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

/** Builds "base?a=1&b=2", dropping empty params. */
export function buildUrl(base, params = {}) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  return url.toString();
}
