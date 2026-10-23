// Unit tests for the settings module (pure, no electron).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPersistence } from '../src/browser/persistence.js';
import { createSettings, searchUrlFor, DEFAULTS, SEARCH_ENGINES } from '../src/browser/settings.js';

function tmpStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wego-settings-test-'));
}

test('defaults are used when nothing is persisted', () => {
  const s = createSettings({ persistence: createPersistence({ stateDir: tmpStateDir() }) });
  assert.deepEqual(s.all(), DEFAULTS);
});

test('set → flush → reload round-trips through real persistence', () => {
  const stateDir = tmpStateDir();
  const persistence = createPersistence({ stateDir });
  const s1 = createSettings({ persistence });
  s1.set('uiZoom', 1.5);
  s1.set('pageZoomLevel', 2);
  s1.set('searchEngine', 'baidu');
  s1.set('downloadDir', '/tmp/dl');
  s1.set('restoreSession', false);
  persistence.flush();
  const s2 = createSettings({ persistence: createPersistence({ stateDir }) });
  assert.equal(s2.get('uiZoom'), 1.5);
  assert.equal(s2.get('pageZoomLevel'), 2);
  assert.equal(s2.get('searchEngine'), 'baidu');
  assert.equal(s2.get('downloadDir'), '/tmp/dl');
  assert.equal(s2.get('restoreSession'), false);
});

test('validators reject invalid values with WEGO_INVALID_ARGUMENT', () => {
  const s = createSettings({ persistence: createPersistence({ stateDir: tmpStateDir() }) });
  const bad = [
    ['uiZoom', 3],
    ['uiZoom', 0.4],
    ['uiZoom', 'big'],
    ['pageZoomLevel', 9],
    ['pageZoomLevel', 1.5],
    ['searchEngine', 'askjeeves'],
    ['downloadDir', 'relative/path'],
    ['restoreSession', 'yes'],
    ['nonsense', 1],
  ];
  for (const [key, value] of bad) {
    assert.throws(() => s.set(key, value), (e) => e.error_code === 'WEGO_INVALID_ARGUMENT', `${key}=${value}`);
  }
  // rejected sets must not mutate state
  assert.deepEqual(s.all(), DEFAULTS);
});

test('boundary values are accepted', () => {
  const s = createSettings();
  s.set('uiZoom', 0.5);
  s.set('uiZoom', 2);
  s.set('pageZoomLevel', -3);
  s.set('pageZoomLevel', 5);
  s.set('downloadDir', '');
  assert.equal(s.get('uiZoom'), 2);
  assert.equal(s.get('pageZoomLevel'), 5);
});

test('invalid persisted values fall back to defaults', () => {
  const stateDir = tmpStateDir();
  fs.writeFileSync(path.join(stateDir, 'settings.json'),
    JSON.stringify({ uiZoom: 99, searchEngine: 'askjeeves', pageZoomLevel: 1 }));
  const s = createSettings({ persistence: createPersistence({ stateDir }) });
  assert.equal(s.get('uiZoom'), 1);
  assert.equal(s.get('searchEngine'), 'duckduckgo');
  assert.equal(s.get('pageZoomLevel'), 1); // valid values survive
});

test('searchUrlFor encodes the query into the template', () => {
  assert.equal(searchUrlFor('google', 'hello world'), 'https://www.google.com/search?q=hello%20world');
  assert.equal(searchUrlFor('baidu', '汉字'), `https://www.baidu.com/s?wd=${encodeURIComponent('汉字')}`);
  assert.equal(searchUrlFor('duckduckgo', 'a&b'), 'https://duckduckgo.com/?q=a%26b');
  // unknown engine falls back to DuckDuckGo
  assert.equal(searchUrlFor('nope', 'x'), 'https://duckduckgo.com/?q=x');
  assert.ok(Object.keys(SEARCH_ENGINES).length >= 4);
});

test('onChange fires with (key, value, all)', () => {
  const calls = [];
  const s = createSettings({ onChange: (k, v, all) => calls.push([k, v, all]) });
  s.set('restoreSession', false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'restoreSession');
  assert.equal(calls[0][1], false);
  assert.equal(calls[0][2].restoreSession, false);
});
