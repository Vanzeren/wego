// Electron appends "<appName>/<version> Electron/<version>" to the UA and
// picky sites (QQ Mail etc.) bounce non-mainstream agents. Strip those
// tokens; the Chrome/<version> token tracks the runtime automatically.
// Pure module (no electron import) so it is unit-testable.
export function cleanUserAgent(ua) {
  return ua
    .replace(/ [\w.-]+\/[\w.]+(?= Chrome\/)/, '') // appName/version before Chrome
    .replace(/ Electron\/[\w.]+/, '');
}

// Verified against Google's embedded-auth rejection path. Keep this scoped to
// the Google account endpoint; every other origin retains the normal UA.
export const GOOGLE_AUTH_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0';

// The optional current UA lets the request hook avoid overriding custom UAs.
// Once our Google-specific UA leaves the endpoint, restore the default on the
// very first non-Google request instead of leaking it into the redirect chain.
export function userAgentForUrl(defaultUserAgent, url, currentUserAgent = defaultUserAgent) {
  let googleAuth = false;
  try {
    const parsed = new URL(url);
    googleAuth = parsed.protocol === 'https:' && parsed.hostname === 'accounts.google.com';
  } catch { /* invalid/internal URL: keep the current identity */ }
  if (googleAuth) return GOOGLE_AUTH_USER_AGENT;
  return currentUserAgent === GOOGLE_AUTH_USER_AGENT ? defaultUserAgent : currentUserAgent;
}
