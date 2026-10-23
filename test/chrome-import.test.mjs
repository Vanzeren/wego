// Unit tests for Chrome cookie import (crypto + DB read, no real Chrome).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  decryptCookieValue,
  deriveKey,
  chromeTimeToUnix,
  readCookiesFromDb,
  importChromeCookieDescriptors,
} from '../src/browser/chrome-import.js';

const IV = Buffer.alloc(16, 0x20);

// Mirror of Chrome's Linux encryption for fixture construction.
function encryptCookieValue(plainWithHostHash, key) {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, IV);
  return Buffer.concat([Buffer.from('v10'), cipher.update(plainWithHostHash), cipher.final()]);
}

const KEY = deriveKey('peanuts');

test('decryptCookieValue round-trips a host-hash-prefixed v10 value', () => {
  const host = '.example.com';
  const payload = Buffer.concat([crypto.createHash('sha256').update(host).digest(), Buffer.from('secret-value')]);
  const blob = encryptCookieValue(payload, KEY);
  assert.equal(decryptCookieValue(blob, host, KEY), 'secret-value');
});

test('decryptCookieValue handles values without the host-hash prefix', () => {
  const blob = encryptCookieValue(Buffer.from('legacy-value'), KEY);
  // host hash won't match → whole plaintext is the value
  assert.equal(decryptCookieValue(blob, '.example.com', KEY), 'legacy-value');
});

test('decryptCookieValue passes through unencrypted values and rejects nothing', () => {
  assert.equal(decryptCookieValue(Buffer.from('plain'), '.example.com', KEY), 'plain');
  assert.equal(decryptCookieValue(Buffer.alloc(0), '.example.com', KEY), null);
});

test('decryptCookieValue keeps values ending in a padding-like byte', () => {
  // Regression: decipher.final() already strips PKCS7 padding; a second manual
  // unpad truncated values whose real last byte was 0x01-0x10.
  const host = '.example.com';
  const value = Buffer.from('AB\x08');
  const payload = Buffer.concat([crypto.createHash('sha256').update(host).digest(), value]);
  const blob = encryptCookieValue(payload, KEY);
  assert.equal(decryptCookieValue(blob, host, KEY), 'AB\x08');
});

test('chromeTimeToUnix converts the 1601 epoch', () => {
  assert.equal(chromeTimeToUnix(11644473600 * 1_000_000), 0); // 1970-01-01
  assert.equal(chromeTimeToUnix((11644473600 + 3600) * 1_000_000), 3600);
});

function makeCookiesDb(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wego-cookiedb-'));
  const file = path.join(dir, 'Cookies');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE cookies (
    host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
    expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER)`);
  const ins = db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const r of rows) ins.run(...r);
  db.close();
  return { dir, file };
}

test('readCookiesFromDb maps rows including samesite and expiry', () => {
  const expires = (11644473600 + 2000000000) * 1_000_000;
  const { dir, file } = makeCookiesDb([
    ['.example.com', 'sid', 'abc', Buffer.alloc(0), '/', expires, 1, 1, 2],
    ['example.org', 'pref', '', Buffer.from('v10junk'), '/app', 0, 0, 0, -1],
  ]);
  const rows = readCookiesFromDb(file);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    { host: rows[0].host, secure: rows[0].secure, httpOnly: rows[0].httpOnly, sameSite: rows[0].sameSite },
    { host: '.example.com', secure: true, httpOnly: true, sameSite: 'lax' },
  );
  assert.equal(rows[0].expires, 2000000000);
  assert.equal(rows[1].sameSite, 'unspecified');
  assert.equal(rows[1].expires, 0); // session cookie
  fs.rmSync(dir, { recursive: true, force: true });
});

test('importChromeCookieDescriptors decrypts and shapes Electron cookies', async () => {
  const host = '.example.com';
  const payload = Buffer.concat([crypto.createHash('sha256').update(host).digest(), Buffer.from('tok-123')]);
  const blob = encryptCookieValue(payload, KEY);
  const { dir } = makeCookiesDb([
    [host, 'token', '', blob, '/', 0, 1, 0, 2],
    ['.plain.com', 'p', 'plainval', Buffer.alloc(0), '/', 0, 0, 0, 0],
  ]);
  const { cookies, undecryptable, total } = await importChromeCookieDescriptors({
    chromeDir: dir,
    password: 'peanuts',
  });
  assert.equal(total, 2);
  assert.equal(undecryptable, 0);
  const tok = cookies.find((c) => c.name === 'token');
  assert.equal(tok.value, 'tok-123');
  assert.equal(tok.url, 'https://example.com/'); // secure → https, bare host
  assert.equal(tok.sameSite, 'lax');
  assert.equal(tok.expirationDate, undefined); // session cookie
  const plain = cookies.find((c) => c.name === 'p');
  assert.equal(plain.url, 'http://plain.com/');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('importChromeCookieDescriptors stages the DB copy under stateDir and cleans up', async () => {
  const host = '.example.com';
  const payload = Buffer.concat([crypto.createHash('sha256').update(host).digest(), Buffer.from('tok')]);
  const blob = encryptCookieValue(payload, KEY);
  const { dir } = makeCookiesDb([[host, 'token', '', blob, '/', 0, 0, 0, 0]]);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wego-state-'));
  try {
    const { cookies, total } = await importChromeCookieDescriptors({ chromeDir: dir, password: 'peanuts', stateDir });
    assert.equal(total, 1);
    assert.equal(cookies[0].value, 'tok');
    // The staged copy is removed afterwards; nothing lingers in the state dir.
    assert.deepEqual(fs.readdirSync(stateDir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('importChromeCookieDescriptors counts undecryptable rows with a wrong key', async () => {
  const host = '.example.com';
  const payload = Buffer.concat([crypto.createHash('sha256').update(host).digest(), Buffer.from('x')]);
  const blob = encryptCookieValue(payload, KEY);
  const { dir } = makeCookiesDb([[host, 'token', '', blob, '/', 0, 0, 0, 0]]);
  const { cookies, undecryptable } = await importChromeCookieDescriptors({
    chromeDir: dir,
    password: 'definitely-wrong',
  });
  assert.equal(cookies.length, 0);
  assert.equal(undecryptable, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
