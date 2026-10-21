// Chrome cookie import for Linux (main process).
// Reads Chrome's Cookies SQLite (via a copy — Chrome locks the live DB),
// decrypts v10/v11 values (AES-128-CBC, key from the libsecret keyring or
// the 'peanuts' fallback), and hands plain cookie descriptors to the bridge
// for injection into an Electron session.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const SALT = 'saltysalt';
const IV = Buffer.alloc(16, 0x20); // 16 spaces, Chrome's Linux scheme

// Chrome's encrypted_value on Linux: 'v10'|'v11' + AES-128-CBC ciphertext.
// The plaintext for Chrome >= 80 is prefixed with a 32-byte SHA-256 host hash.
export function decryptCookieValue(encrypted, hostKey, key) {
  const buf = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted);
  if (buf.length === 0) return null;
  const prefix = buf.subarray(0, 3).toString('utf8');
  if (prefix !== 'v10' && prefix !== 'v11') {
    // Unencrypted plain value (rare on Linux).
    return buf.toString('utf8');
  }
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, IV);
  let plain = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]);
  // PKCS7 unpad
  const pad = plain[plain.length - 1];
  if (pad >= 1 && pad <= 16) plain = plain.subarray(0, plain.length - pad);
  // Strip the 32-byte host-key hash prefix when present.
  if (plain.length > 32) {
    const hash = plain.subarray(0, 32);
    if (crypto.createHash('sha256').update(hostKey).digest().equals(hash)) {
      return plain.subarray(32).toString('utf8');
    }
  }
  return plain.toString('utf8');
}

export function deriveKey(password) {
  return crypto.pbkdf2Sync(password, SALT, 1, 16, 'sha1');
}

// KWallet (KDE) stores Chrome's OSCrypt password in wallet 'kdewallet',
// folder 'Chrome Keys', entry 'Chrome Safe Storage'.
function kwalletPassword() {
  const qdbus = ['qdbus6', 'qdbus'].find((cmd) => {
    try { execFileSync(cmd, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] }); return true; }
    catch { return false; }
  });
  if (!qdbus) return null;
  try {
    const base = ['org.kde.kwalletd5', '/modules/kwalletd5'];
    const open = execFileSync(qdbus, [...base, 'org.kde.KWallet.open', 'kdewallet', '0', 'ego-import'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
    }).trim();
    if (!/^-?\d+$/.test(open) || Number(open) < 0) return null;
    for (const folder of ['Chrome Keys', 'Chromium Keys']) {
      const out = execFileSync(qdbus, [...base, 'org.kde.KWallet.readPassword', open, folder, 'Chrome Safe Storage', 'ego-import'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
      });
      if (out) return out.replace(/\n$/, '');
    }
  } catch { /* no kwalletd / entry missing */ }
  return null;
}

// Keyring password via libsecret (GNOME), then KWallet (KDE);
// 'peanuts' is Chrome's fallback when no keyring integration is in effect.
export function chromeKeychainPassword() {
  try {
    const out = execFileSync('secret-tool', ['lookup', 'application', 'Chrome'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    if (out) return out;
  } catch { /* no secret-tool / locked keyring */ }
  const kw = kwalletPassword();
  if (kw) return kw;
  return 'peanuts';
}

// Chrome epoch: microseconds since 1601-01-01 → Unix seconds.
export function chromeTimeToUnix(us) {
  return Math.floor(us / 1_000_000 - 11644473600);
}

const SAMESITE = { [-1]: 'unspecified', 0: 'unspecified', 1: 'no_restriction', 2: 'lax', 3: 'strict' };

// Read cookies from a Cookies DB file (already a private copy).
export function readCookiesFromDb(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const stmt = db.prepare(
      'SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies',
    );
    stmt.setReadBigInts(true); // expires_utc overflows JS number range handling
    const rows = stmt.all();
    return rows.map((r) => {
      const expiresUtc = typeof r.expires_utc === 'bigint' ? Number(r.expires_utc) : (r.expires_utc ?? 0);
      return {
        host: r.host_key,
        name: r.name,
        value: r.value, // empty when encrypted_value is used
        encryptedValue: r.encrypted_value,
        path: r.path || '/',
        expires: expiresUtc ? chromeTimeToUnix(expiresUtc) : 0,
        secure: !!r.is_secure,
        httpOnly: !!r.is_httponly,
        sameSite: SAMESITE[Number(r.samesite)] ?? 'unspecified',
      };
    });
  } finally {
    db.close();
  }
}

// Copy the live Chrome cookie store (DB + WAL) into a temp dir and read it.
export async function readChromeCookies({ chromeDir } = {}) {
  const base = chromeDir ?? path.join(os.homedir(), '.config', 'google-chrome', 'Default');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-chrome-cookies-'));
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const src = base + '/Cookies' + suffix;
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, 'Cookies' + suffix));
    }
    if (!fs.existsSync(path.join(tmp, 'Cookies'))) {
      throw new Error(`Chrome Cookies DB not found at ${base}`);
    }
    return readCookiesFromDb(path.join(tmp, 'Cookies'));
  } finally {
    // DB is closed by the time we return; safe to remove.
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Full pipeline: returns Electron-ready cookie descriptors for ses.cookies.set.
export async function importChromeCookieDescriptors({ chromeDir, password } = {}) {
  const key = deriveKey(password ?? chromeKeychainPassword());
  const rows = await readChromeCookies({ chromeDir });
  const now = Math.floor(Date.now() / 1000);
  const out = [];
  let undecryptable = 0;
  let expired = 0;
  for (const row of rows) {
    if (row.expires > 0 && row.expires < now) { expired++; continue; }
    let value = row.value;
    if (!value && row.encryptedValue && row.encryptedValue.length) {
      try {
        value = decryptCookieValue(row.encryptedValue, row.host, key);
      } catch {
        undecryptable++;
        continue;
      }
    }
    if (value == null) { undecryptable++; continue; }
    const bareHost = row.host.replace(/^\./, '');
    // Chromium rejects SameSite=None without Secure; downgrade instead of
    // dropping the cookie.
    const sameSite = row.sameSite === 'no_restriction' && !row.secure ? 'unspecified' : row.sameSite;
    out.push({
      url: `${row.secure ? 'https' : 'http'}://${bareHost}${row.path}`,
      name: row.name,
      value,
      domain: row.host,
      path: row.path,
      secure: row.secure,
      httpOnly: row.httpOnly,
      sameSite,
      ...(row.expires > 0 ? { expirationDate: row.expires } : {}),
    });
  }
  return { cookies: out, undecryptable, expired, total: rows.length };
}
