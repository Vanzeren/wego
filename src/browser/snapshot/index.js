// Snapshot engine — main-process side.
// Top-document capture goes through webContents.executeJavaScript (main
// world). Cross-origin OOPIFs cannot be reached that way; they are captured
// from their own CDP targets (see cdp-client.js) and merged back under their
// iframe line with disjoint ref ranges and frameId-tagged refs.

import { pageScriptSource } from './page-script.js';
import { mergeFrameCapture, tagFrameRefs } from './merge.js';
import { MainCdpClient } from './cdp-client.js';

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

let cdp = null;

// Called once by the bridge at startup with the in-process VirtualCdpServer.
export function configureSnapshot({ cdpServer } = {}) {
  cdp = cdpServer ? new MainCdpClient(cdpServer) : null;
}

// Ref ranges: the top document owns 1..REF_BLOCK-1, each OOPIF capture gets
// one block so merged refIds never collide.
const REF_BLOCK = 100000;

function captureExpression(refBase, options) {
  return `globalThis.__wegoSnapshotRefBase=${refBase};${pageScriptSource}\n;globalThis.__wegoSnapshot.capture(${JSON.stringify(options)});`;
}

async function topCapture(webContents, options) {
  // The page program keeps its registry alive per document (SCRIPT_ID guard),
  // so after the first capture we only re-run capture() — no need to ship and
  // re-parse the full ~20KB source on every snapshot.
  const optsJson = JSON.stringify(cleanOptions(options));
  let raw;
  try {
    try {
      // Fast path (repeat captures): registry already installed per document.
      raw = await webContents.executeJavaScript(`globalThis.__wegoSnapshot.capture(${optsJson});`, true);
    } catch {
      // First capture in this document: ship the program, then capture.
      raw = await webContents.executeJavaScript(
        pageScriptSource + `\n;globalThis.__wegoSnapshot.capture(${optsJson});`, true);
    }
  } catch (err) {
    if (!isUsable(webContents)) {
      throw egoError('WEGO_WEB_CONTENTS_UNAVAILABLE', 'Web contents destroyed during snapshot');
    }
    const msg = String((err && err.message) || err || 'unknown error')
      .replace(/^(?:Uncaught\s+)?Error:\s*/, '');
    throw egoError('WEGO_SNAPSHOT_FAILED', 'Snapshot failed: ' + msg);
  }
  if (!raw || typeof raw.content !== 'string' || !Array.isArray(raw.refs)) {
    throw egoError('WEGO_SNAPSHOT_FAILED', 'Snapshot failed: malformed in-page result');
  }
  return raw;
}

// Normalize for matching an iframe element's src against TargetInfo.url.
function normUrl(u) {
  return String(u || '').replace(/#.*$/, '').replace(/\/$/, '');
}

// Merge one level of undescended (cross-origin) iframes from `frames` into
// `capture`, recursing into their own captures. Mutates capture.content/refs.
async function mergeRemoteFrames(capture, frames, options, pageSession, state) {
  const pending = (frames ?? []).filter((f) => !f.descended && f.src);
  for (const frame of pending) {
    const target = state.frameTargets.find(
      (t) => !state.consumed.has(t.targetId) && normUrl(t.url) === normUrl(frame.src),
    );
    if (!target) continue;
    // Ownership: the frame target id doubles as its CDP frame id; the owner
    // element must live in OUR page target, or some other page embeds the
    // same URL and we must not merge it here. (Skipped for nested levels —
    // the parent frame was already verified.)
    if (pageSession) {
      try {
        await pageSession.send('DOM.getFrameOwner', { frameId: target.targetId });
      } catch {
        continue;
      }
    }
    state.consumed.add(target.targetId);
    let sub = null;
    // Persistent per-frame ref block: keyed on the frame's targetId, not
    // traversal order, so the same frame always lands in the same block and
    // distinct frames never collide.
    let block = state.frameBlocks.get(target.targetId);
    if (block === undefined) {
      if (state.frameBlocks.size >= 8) return; // safety cap on merged frames
      block = state.frameBlocks.size + 1;
      state.frameBlocks.set(target.targetId, block);
    }
    const refBase = block * REF_BLOCK;
    try {
      const session = await cdp.attach(target.targetId);
      try {
        const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
          expression: captureExpression(refBase, cleanOptions(options)),
          returnByValue: true,
        });
        if (!exceptionDetails && result?.value && typeof result.value.content === 'string') {
          sub = result.value;
        }
      } finally {
        await session.detach();
      }
    } catch { /* frame gone or not attachable: leave the bare iframe line */ }
    if (!sub) continue;
    capture.content = mergeFrameCapture(capture.content, frame.refId, sub.content);
    capture.refs.push(...tagFrameRefs(sub.refs, target.targetId));
    // Nested remote frames inside this frame's capture merge recursively.
    await mergeRemoteFrames(capture, sub.frames, options, null, state);
  }
}

function truncate(content, options) {
  const max = options && options.maxResultLength;
  if (Number.isInteger(max) && max >= 0 && content.length > max) {
    return content.slice(0, max); // truncates content only, never refs
  }
  return content;
}

// Subtree scope rooted at an OOPIF node: the root refId lives in the frame
// target's registry, so capture inside that frame target directly.
async function frameSubtreeCapture(frameTargetId, options) {
  if (!cdp) throw egoError('WEGO_SNAPSHOT_FAILED', 'Snapshot failed: frame capture unavailable (no CDP)');
  const session = await cdp.attach(frameTargetId);
  try {
    const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
      expression: captureExpression(0, cleanOptions(options)),
      returnByValue: true,
    });
    if (exceptionDetails || !result?.value || typeof result.value.content !== 'string') {
      const msg = exceptionDetails?.exception?.description || exceptionDetails?.text || 'no result';
      throw egoError('WEGO_SNAPSHOT_FAILED', 'Snapshot failed in frame: ' + msg);
    }
    return { content: result.value.content, refs: tagFrameRefs(result.value.refs, frameTargetId) };
  } finally {
    await session.detach();
  }
}

export async function captureSnapshot(webContents, options = {}, context = {}) {
  if (!isUsable(webContents)) {
    throw egoError('WEGO_WEB_CONTENTS_UNAVAILABLE', 'Web contents unavailable: missing or destroyed');
  }
  if (context.rootFrameId) {
    const sub = await frameSubtreeCapture(context.rootFrameId, options);
    return { content: truncate(sub.content, options), refs: sub.refs };
  }
  const raw = await topCapture(webContents, options);

  if (cdp && raw.frames?.some((f) => !f.descended && f.src)) {
    let frameTargets = [];
    try {
      frameTargets = (await cdp.getTargets()).filter((t) => t.type === 'iframe');
    } catch { /* CDP unavailable: return the unmerged top capture */ }
    if (frameTargets.length) {
      const state = { frameTargets, consumed: new Set(), frameBlocks: new Map() };
      // Page session only for DOM.getFrameOwner ownership checks; cached
      // across snapshots instead of attach/detach per call.
      let pageSession = null;
      if (context.targetId) {
        try {
          pageSession = await cdp.attachCached(context.targetId);
          await pageSession.send('DOM.enable').catch(() => {
            cdp._sessions.delete(context.targetId); // stale session
            pageSession = null;
          });
        } catch { pageSession = null; }
      }
      // Fail closed: without the page session the frame-ownership check
      // cannot run, and frames from OTHER pages could merge into this
      // snapshot — refuse instead of returning a cross-page capture.
      if (!pageSession) {
        throw egoError(
          'WEGO_CDP_CHANNEL_UNAVAILABLE',
          'Snapshot failed: page CDP session unavailable for OOPIF ownership checks',
        );
      }
      try {
        await mergeRemoteFrames(raw, raw.frames, options, pageSession, state);
      } catch { /* frame merge raced teardown: return the unmerged top capture */ }
    }
  }

  let content = truncate(raw.content, options);
  return { content, refs: raw.refs };
}

export { pageScriptSource };
