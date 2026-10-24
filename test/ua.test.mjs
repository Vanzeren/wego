// Unit tests for the UA cleanup.
import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanUserAgent, userAgentForUrl, GOOGLE_AUTH_USER_AGENT } from '../src/browser/ua.js';

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

test('Google auth uses Firefox UA only on accounts.google.com', () => {
  assert.equal(
    userAgentForUrl(CLEAN, 'https://accounts.google.com/v3/signin/identifier'),
    GOOGLE_AUTH_USER_AGENT,
  );
  assert.equal(userAgentForUrl(CLEAN, 'https://platform.openai.com/login', GOOGLE_AUTH_USER_AGENT), CLEAN);
  assert.equal(userAgentForUrl(CLEAN, 'https://example.com/', 'Custom/1.0'), 'Custom/1.0');
});

test('Google UA matching rejects lookalike hosts and insecure URLs', () => {
  assert.equal(userAgentForUrl(CLEAN, 'https://accounts.google.com.evil.test/'), CLEAN);
  assert.equal(userAgentForUrl(CLEAN, 'https://sub.accounts.google.com/'), CLEAN);
  assert.equal(userAgentForUrl(CLEAN, 'http://accounts.google.com/'), CLEAN);
  assert.equal(userAgentForUrl(CLEAN, 'not a url'), CLEAN);
});
