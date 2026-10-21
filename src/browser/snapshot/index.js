// Snapshot engine — main-process side.
// Injects the page program (./page-script.js source) into the page's MAIN
// world and calls its exposed capture(). Injection is idempotent on the page
// side (SCRIPT_ID guard), so every capture simply re-evaluates the source.

import { pageScriptSource } from './page-script.js';

function egoError(code, message) {
  const err = new Error(message);
  err.error_code = code;
  return err;
}

function isUsable(webContents) {
  if (!webContents) return false;
  try {
    if (typeof webContents.isDestroyed === 'function') return !webContents.isDestroyed();
    return !webContents.destroyed;
  } catch {
    return false;
  }
}

// Forward only the recognized in-page options; maxResultLength is applied
// here in the main process and never reaches the page.
function cleanOptions(options) {
  const out = {};
  if (!options || typeof options !== 'object') return out;
  if (options.scope === 'full_page' || options.scope === 'only_within_viewport' || options.scope === 'subtree') {
    out.scope = options.scope;
  }
  if (Number.isInteger(options.root)) out.root = options.root;
  if (options.interactiveOnly === true) out.interactiveOnly = true;
  if (options.includeActionMarks === true) out.includeActionMarks = true;
  if (options.includeStableLocator === true) out.includeStableLocator = true;
  return out;
}

export async function captureSnapshot(webContents, options = {}) {
  if (!isUsable(webContents)) {
    throw egoError('EGO_WEB_CONTENTS_UNAVAILABLE', 'Web contents unavailable: missing or destroyed');
  }
  const expression =
    pageScriptSource +
    '\n;globalThis.__egoSnapshot.capture(' + JSON.stringify(cleanOptions(options)) + ');';

  let raw;
  try {
    raw = await webContents.executeJavaScript(expression, true);
  } catch (err) {
    if (!isUsable(webContents)) {
      throw egoError('EGO_WEB_CONTENTS_UNAVAILABLE', 'Web contents destroyed during snapshot');
    }
    const msg = String((err && err.message) || err || 'unknown error')
      .replace(/^(?:Uncaught\s+)?Error:\s*/, '');
    throw egoError('EGO_SNAPSHOT_FAILED', 'Snapshot failed: ' + msg);
  }
  if (!raw || typeof raw.content !== 'string' || !Array.isArray(raw.refs)) {
    throw egoError('EGO_SNAPSHOT_FAILED', 'Snapshot failed: malformed in-page result');
  }

  let content = raw.content;
  const max = options && options.maxResultLength;
  if (Number.isInteger(max) && max >= 0 && content.length > max) {
    content = content.slice(0, max); // truncates content only, never refs
  }
  return { content, refs: raw.refs };
}

export { pageScriptSource };
