// Settings: single source of truth for user preferences. Pure module, no
// electron imports (unit-testable, like persistence.js). Validators run per
// key on set() and on load (invalid persisted values fall back to defaults).
import path from 'node:path';

export const SEARCH_ENGINES = {
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s' },
  baidu: { name: '百度', url: 'https://www.baidu.com/s?wd=%s' },
};

// downloadDir '' means the default (~/Downloads).
export const DEFAULTS = {
  uiZoom: 1,
  pageZoomLevel: 0,
  searchEngine: 'duckduckgo',
  downloadDir: '',
  restoreSession: true,
};

function invalid(key, constraint) {
  const err = new Error(`invalid setting ${JSON.stringify(key)}: must be ${constraint}`);
  err.error_code = 'WEGO_INVALID_ARGUMENT';
  return err;
}

const VALIDATORS = {
  uiZoom(v) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0.5 || v > 2) {
      throw invalid('uiZoom', 'a number in [0.5, 2]');
    }
  },
  pageZoomLevel(v) {
    // Electron zoom levels are fractional (each step ×1.2: 0.5, 1.5, 2.5…);
    // rejecting non-integers crashed the main process from the zoom handler.
    if (typeof v !== 'number' || !Number.isFinite(v) || v < -3 || v > 5) {
      throw invalid('pageZoomLevel', 'a number in [-3, 5]');
    }
  },
  searchEngine(v) {
    if (typeof v !== 'string' || !Object.hasOwn(SEARCH_ENGINES, v)) {
      throw invalid('searchEngine', `one of: ${Object.keys(SEARCH_ENGINES).join(', ')}`);
    }
  },
  downloadDir(v) {
    if (typeof v !== 'string' || (v !== '' && !path.isAbsolute(v))) {
      throw invalid('downloadDir', "'' (default ~/Downloads) or an absolute path");
    }
  },
  restoreSession(v) {
    if (typeof v !== 'boolean') throw invalid('restoreSession', 'a boolean');
  },
};

export function createSettings({ persistence, onChange } = {}) {
  const data = persistence ? persistence.loadSettings(DEFAULTS) : { ...DEFAULTS };
  // A hand-edited or stale settings.json must not wedge the browser: reset
  // any invalid persisted value to its default.
  for (const key of Object.keys(DEFAULTS)) {
    try { VALIDATORS[key](data[key]); } catch { data[key] = DEFAULTS[key]; }
  }

  function get(key) {
    return data[key];
  }

  function all() {
    return { ...data };
  }

  function set(key, value) {
    if (!Object.hasOwn(VALIDATORS, key)) throw invalid(key, `one of: ${Object.keys(DEFAULTS).join(', ')}`);
    VALIDATORS[key](value);
    data[key] = value;
    persistence?.saveSettings(all());
    onChange?.(key, value, all());
  }

  return { get, all, set };
}

// Build the search URL for an engine key + raw query. Unknown keys fall back
// to DuckDuckGo so a stale value never breaks the omnibox.
export function searchUrlFor(engineKey, query) {
  const engine = Object.hasOwn(SEARCH_ENGINES, engineKey)
    ? SEARCH_ENGINES[engineKey]
    : SEARCH_ENGINES.duckduckgo;
  return engine.url.replace('%s', encodeURIComponent(query));
}
