/**
 * Per-browser UI preferences.
 *
 * Scope shrank deliberately: this used to hold mention history and the
 * notification config, both of which now live on the server. Keeping mentions
 * in localStorage capped history at a few hundred rows, lost everything on a
 * cache clear, and meant two open tabs disagreed about what had been seen.
 *
 * What is left is genuinely per-browser and per-person: which filters this user
 * likes, and whether they want sound.
 */

const STORAGE_KEY = 'smm_ui_preferences';

const DEFAULTS = {
  soundEnabled: true,
  desktopEnabled: false,
  filters: {
    platform: 'all',
    sentiment: 'all',
    company: 'all',
    search: ''
  },
  timeline: {
    bucketMinutes: 15,
    buckets: 24
  }
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export const preferences = {
  load() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) return clone(DEFAULTS);

      const parsed = JSON.parse(stored);
      return {
        ...clone(DEFAULTS),
        ...parsed,
        filters: { ...DEFAULTS.filters, ...(parsed.filters || {}) },
        timeline: { ...DEFAULTS.timeline, ...(parsed.timeline || {}) }
      };
    } catch {
      // Corrupt or unavailable storage should never stop the dashboard loading.
      return clone(DEFAULTS);
    }
  },

  save(values) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
    } catch {
      // Private browsing refuses writes; preferences simply do not persist.
    }
  }
};

export { DEFAULTS as PREFERENCE_DEFAULTS };
