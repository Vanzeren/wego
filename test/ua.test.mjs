// Unit tests for the UA cleanup.
import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanUserAgent } from '../src/browser/ua.js';

const ELECTRON_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) wego/0.1.0 Chrome/140.0.7339.249 Electron/38.8.0 Safari/537.36';
const CLEAN = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.249 Safari/537.36';

test('strips app and Electron tokens, keeps Chrome version', () => {
  assert.equal(cleanUserAgent(ELECTRON_UA), CLEAN);
});

test('already-clean UA passes through unchanged', () => {
  assert.equal(cleanUserAgent(CLEAN), CLEAN);
});

test('windows UA variant', () => {
  const win = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) wego/1.2.3 Chrome/999.0.0.0 Electron/99.0.0 Safari/537.36';
  assert.equal(cleanUserAgent(win),
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/999.0.0.0 Safari/537.36');
});
