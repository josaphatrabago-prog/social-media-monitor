/**
 * Dashboard API client.
 *
 * All state now lives on the server, so this module is the single place that
 * talks to it: REST for queries and commands, Server-Sent Events for the live
 * stream. The browser no longer holds mention history or posts webhooks - both
 * moved server-side (localStorage could not survive a refresh with real
 * volumes, and Slack blocks browser-origin webhook posts via CORS).
 */

const TOKEN_STORAGE_KEY = 'smm_monitor_token';

/**
 * A token may arrive as ?token=... on first load. It is moved into
 * sessionStorage and stripped from the address bar so it is not left in
 * screenshots or browser history.
 */
function resolveToken() {
  const fromUrl = new URLSearchParams(window.location.search).get('token');

  if (fromUrl) {
    try {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, fromUrl);
    } catch {
      // Private browsing can refuse storage; the in-memory value still works.
    }

    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('token');
    window.history.replaceState({}, '', cleanUrl);
    return fromUrl;
  }

  try {
    return sessionStorage.getItem(TOKEN_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

const token = resolveToken();

function authHeaders(extra = {}) {
  return token ? { 'x-monitor-token': token, ...extra } : extra;
}

/** Appends the token for endpoints that cannot carry a header (SSE, downloads). */
function withToken(path) {
  if (!token) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}token=${encodeURIComponent(token)}`;
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: authHeaders(options.body ? { 'content-type': 'application/json' } : {})
  });

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const payload = await response.json();
      if (payload?.error) message = payload.error;
    } catch {
      // Keep the status-code message.
    }
    throw new Error(message);
  }

  return response.json();
}

function buildQuery(params = {}) {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === 'all') continue;
    query.set(key, String(value));
  }

  const queryString = query.toString();
  return queryString ? `?${queryString}` : '';
}

export const api = {
  get hasToken() {
    return Boolean(token);
  },

  status: () => request('/api/status'),
  config: () => request('/api/config'),
  mentions: (filters) => request(`/api/mentions${buildQuery(filters)}`),
  stats: (filters) => request(`/api/stats${buildQuery(filters)}`),
  timeline: (options) => request(`/api/timeline${buildQuery(options)}`),
  alerts: (limit = 20) => request(`/api/alerts${buildQuery({ limit })}`),

  pause: () => request('/api/control/pause', { method: 'POST' }),
  resume: () => request('/api/control/resume', { method: 'POST' }),
  pollNow: (platform) => request('/api/control/poll', {
    method: 'POST',
    body: JSON.stringify({ platform })
  }),

  setFrequency: (frequency, { platform, persist } = {}) => request('/api/control/frequency', {
    method: 'POST',
    body: JSON.stringify({ frequency, platform, persist })
  }),

  patchConfig: (patch) => request('/api/config', {
    method: 'PATCH',
    body: JSON.stringify(patch)
  }),

  testNotification: (kind) => request('/api/notify/test', {
    method: 'POST',
    body: JSON.stringify({ kind })
  }),

  simulateCrisis: (count) => request('/api/simulate/crisis', {
    method: 'POST',
    body: JSON.stringify({ count })
  }),

  acknowledgeCrisis: () => request('/api/crisis/acknowledge', { method: 'POST' }),

  clearMentions: () => request('/api/mentions', { method: 'DELETE' }),

  /**
   * Triggers a file download. The export runs server-side so the file reflects
   * every stored mention matching the filters, not just the page in view.
   */
  download(format, filters = {}) {
    const query = buildQuery({ ...filters, format });
    const link = document.createElement('a');
    link.href = withToken(`/api/export${query}`);
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  },

  /**
   * Opens the live event stream.
   * @param {Object<string, Function>} handlers keyed by event name
   * @returns {{close: Function}}
   */
  stream(handlers = {}) {
    const source = new EventSource(withToken('/api/events'));

    for (const [event, handler] of Object.entries(handlers)) {
      if (event === 'open' || event === 'error') continue;

      source.addEventListener(event, (message) => {
        try {
          handler(JSON.parse(message.data));
        } catch (error) {
          console.warn(`stream: bad payload for "${event}"`, error);
        }
      });
    }

    if (handlers.open) source.addEventListener('open', handlers.open);
    // EventSource reconnects on its own; the handler is for surfacing state.
    if (handlers.error) source.addEventListener('error', handlers.error);

    return { close: () => source.close() };
  }
};

export { buildQuery };
