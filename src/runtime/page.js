// Page: the v2 SDK page surface. Wraps one tab (CDP target) of a task space.
// All waits/actions go through the page's flatten CDP session (cdp.js);
// '@N' refs resolve via refs.js, selectors via selectors.js.

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { populate as populateRefs, parseRefTarget, lookup as lookupRef } from './refs.js';
import { resolveTarget } from './selectors.js';
import { parseKeySpec, pressKey, mouseEvent, MOUSE_BUTTONS } from './input.js';
import { Download, FileChooser } from './driver/files.js';
import { buildMouse, buildKeyboard } from './driver/namespaces.js';
import { findLearning, hostOf } from './learning.js';
import { CDPError } from './cdp.js';

const DEFAULT_TIMEOUT = 30_000;

function timeoutError(what, ms) {
  return new CDPError(`Timeout ${ms}ms exceeded: ${what}`, 'WEGO_OPERATION_FAILED');
}

function poll(fn, { interval = 100 } = {}) {
  return new Promise((resolve) => {
    const tick = async () => {
      let v;
      try { v = await fn(); } catch { v = undefined; }
      if (v) return resolve(v);
      setTimeout(tick, interval);
    };
    tick();
  });
}

function withTimeout(promise, ms, what) {
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError(what, ms)), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

// getContentQuads returns one quad per inline box fragment — the first can be
// a zero-width child (e.g. an inline link wrapping a collapsed span). The
// clickable point is the UNION of all fragments.
export function quadUnionBox(quads) {
  const xs = [];
  const ys = [];
  for (const q of quads) {
    for (let i = 0; i < 8; i += 2) { xs.push(q[i]); ys.push(q[i + 1]); }
  }
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  return { left, top, width: right - left, height: bottom - top, cx: (left + right) / 2, cy: (top + bottom) / 2 };
}

// ---------------------------------------------------------------- pointer dispatch

// CDP Input.dispatchMouseEvent is silently dropped for views that are
// covered (never composited foreground) — nondeterministically across
// compositor states. Synthetic in-page events always land. Foreground tabs
// (visibilityState visible) get real trusted input; covered tabs get
// synthetic events (isTrusted=false but delivered everywhere).
async function syntheticPointer(session, objectId, point, { clickCount = 1, hover = false } = {}) {
  const fn = `function(x, y, count, hover) {
    const mk = (type) => new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    if (hover) { this.dispatchEvent(mk('pointermove')); this.dispatchEvent(mk('mousemove')); return; }
    // real clicks focus on mousedown — synthetic ones must too (paste and
    // keyboard follow the focused element)
    if (this.focus) { try { this.focus(); } catch {} }
    for (let i = 0; i < count; i++) {
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) this.dispatchEvent(mk(type));
    }
  }`;
  await session.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: fn,
    arguments: [{ value: point.x }, { value: point.y }, { value: clickCount }, { value: hover }],
  });
}

export class Page {
  static _learnHinted = new Set(); // hosts already hinted this process

  constructor(space, label, targetId, openedBy) {
    this.space = space;
    this.label = label;
    this.spaceId = space.spaceId;
    this.targetId = targetId;
    this.openedBy = openedBy;

    this._sessionPromise = null;
    this._eventBuffer = []; // CDP event summaries, cap 10k
    this._dialog = null; // current JS dialog {type, message}
    this._popups = []; // observed popup targets in this space
    this._downloadWaiters = [];
    this._activeDownloads = new Map();
    this._popupWaiters = [];
    this._chooserWaiters = [];
    this._networkInFlight = 0;
    this._lastNetworkActivity = 0;
    this._mousePos = { x: 0, y: 0 };

    // bound snapshot with .raw variant
    this.snapshot = this.snapshot.bind(this);
    this.snapshot.raw = this._snapshotRaw.bind(this);
  }

  _ctx() { return this.space._ctx; }

  async _session() {
    if (!this._sessionPromise) {
      this._sessionPromise = (async () => {
        const session = await this._ctx().cdp.attach(this.targetId);
        await session.send('Page.enable');
        await session.send('Runtime.enable').catch(() => {});
        await session.send('Network.enable').catch(() => {});
        // JS dialogs: native UI is disabled (disableDialogs); record every
        // call via a binding so receipts/info() still surface them, with
        // safe auto-dismiss defaults (confirm→false, prompt→null).
        const shim = `(() => {
          const record = (type, message, ret) => {
            const entry = { type, message: String(message ?? ''), at: Date.now() };
            (globalThis.__wegoDialogLog = globalThis.__wegoDialogLog || []).push(entry);
            try { globalThis.__wegoDialog(JSON.stringify(entry)); } catch {}
            return ret;
          };
          window.alert = (m) => record('alert', m, undefined);
          window.confirm = (m) => record('confirm', m, false);
          window.prompt = (m) => record('prompt', m, null);
        })();`;
        await session.send('Page.addScriptToEvaluateOnNewDocument', { source: shim }).catch(() => {});
        await session.send('Runtime.evaluate', { expression: shim }).catch(() => {});
        await session.send('Runtime.addBinding', { name: '__wegoDialog' }).catch(() => {});
        session.on('Runtime.bindingCalled', (p) => {
          if (p.name !== '__wegoDialog') return;
          try { this._dialog = JSON.parse(p.payload); } catch { /* malformed */ }
          this._recordEvent('Runtime.bindingCalled', { name: p.name });
        });

        session.on('Page.javascriptDialogOpening', (p) => {
          this._dialog = { type: p.type, message: p.message };
          this._recordEvent('Page.javascriptDialogOpening', p);
        });
        session.on('Page.javascriptDialogClosed', () => { this._dialog = null; });

        // Intercept file choosers so scripts can arm waitForFileChooser()
        // before the triggering click. Unwaited choosers are cancelled so the
        // page never hangs on a native dialog.
        await session.send('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => {});
        session.on('Page.fileChooserOpened', (p) => {
          this._recordEvent('Page.fileChooserOpened', p);
          const chooser = new FileChooser(this, p);
          const waiters = this._chooserWaiters.splice(0);
          if (waiters.length) {
            for (const w of waiters) w(chooser);
          } else {
            void chooser.cancel();
          }
        });

        session.on('Network.requestWillBeSent', () => { this._networkInFlight++; this._lastNetworkActivity = Date.now(); });
        session.on('Network.loadingFinished', () => { this._networkInFlight = Math.max(0, this._networkInFlight - 1); this._lastNetworkActivity = Date.now(); });
        session.on('Network.loadingFailed', () => { this._networkInFlight = Math.max(0, this._networkInFlight - 1); this._lastNetworkActivity = Date.now(); });

        // Downloads: Electron routes them through session.will-download, and
        // CDP download events never fire — the SDK waits on the bridge
        // registry instead (see waitForEvent('download')).

        // buffer remaining events as summaries
        for (const m of ['Page.loadEventFired', 'Page.domContentEventFired', 'Page.frameNavigated', 'Console.messageAdded']) {
          session.on(m, (p) => this._recordEvent(m, p));
        }
        return session;
      })();
    }
    return this._sessionPromise;
  }

  _recordEvent(method, params) {
    if (this._eventBuffer.length >= 10_000) this._eventBuffer.shift();
    let summary;
    try { summary = JSON.stringify(params); } catch { summary = ''; }
    if (summary && summary.length > 200) summary = summary.slice(0, 200) + '…';
    this._eventBuffer.push({ method, summary });
  }

  // popup observation: browser-level Target.targetCreated, filtered to this space
  _watchPopups() {
    if (this._popupWatch) return;
    this._popupWatch = this._ctx().cdp.browser.on('Target.targetCreated', async (p) => {
      const info = p.targetInfo;
      if (!info || info.type !== 'page') return;
      if (!this.space._ownsTarget(info.targetId)) return;
      const label = this.space._labelForTarget(info.targetId);
      this._popups.push({ label, targetId: info.targetId });
      const waiters = this._popupWaiters.splice(0);
      for (const w of waiters) w({ label, targetId: info.targetId });
    });
  }

  // ---- info ----

  async url() {
    const session = await this._session();
    const { result } = await session.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
    return result.value;
  }

  async title() {
    const session = await this._session();
    const { result } = await session.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
    return result.value;
  }

  async info() {
    const [url, title] = await Promise.all([this.url(), this.title()]);
    return { url, title, ...(this._dialog ? { dialog: this._dialog } : {}) };
  }

  // ---- navigation / waits ----

  async goto(url, { timeout = DEFAULT_TIMEOUT, waitUntil = 'load' } = {}) {
    const session = await this._session();
    await session.send('Page.navigate', { url }, { timeout });
    await this.waitForLoadState(waitUntil, { timeout });
    // Surfacing accumulated site experience exactly when it becomes relevant.
    const host = hostOf(await this.url().catch(() => url) ?? url);
    if (host && findLearning(host) && !Page._learnHinted.has(host)) {
      Page._learnHinted.add(host);
      console.log(`[wego-learn] notes available for ${host} — run learnContext("${host}")`);
    }
  }

  async reload({ timeout = DEFAULT_TIMEOUT } = {}) {
    const session = await this._session();
    await session.send('Page.reload', {});
    await this.waitForLoadState('load', { timeout });
  }

  async waitForURL(target, { timeout = DEFAULT_TIMEOUT } = {}) {
    const match = typeof target === 'string'
      ? (u) => u === target || u.includes(target)
      : target instanceof RegExp
        ? (u) => target.test(u)
        : typeof target === 'function'
          ? (u) => !!target(u)
          : null;
    if (!match) throw Object.assign(new TypeError('waitForURL expects string | RegExp | function'), { error_code: 'WEGO_INVALID_ARGUMENT' });
    const session = await this._session();
    await withTimeout(
      poll(async () => {
        const { result } = await session.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
        return match(result.value) ? result.value : undefined;
      }),
      timeout, `waitForURL(${target})`,
    );
  }

  async waitForLoadState(state = 'load', { timeout = DEFAULT_TIMEOUT } = {}) {
    const session = await this._session();
    const readyStateWanted = { load: 'complete', domcontentloaded: 'interactive', networkidle: null }[state];
    if (readyStateWanted === undefined && state !== 'networkidle') {
      throw Object.assign(new TypeError(`waitForLoadState: unknown state ${state}`), { error_code: 'WEGO_INVALID_ARGUMENT' });
    }
    if (state === 'networkidle') {
      await withTimeout(
        poll(() => (this._networkInFlight === 0 && Date.now() - this._lastNetworkActivity >= 500 ? true : undefined)),
        timeout, 'waitForLoadState(networkidle)',
      );
      return;
    }
    await withTimeout(
      poll(async () => {
        const { result } = await session.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
        const ok = state === 'load' ? result.value === 'complete' : result.value === 'interactive' || result.value === 'complete';
        return ok ? true : undefined;
      }),
      timeout, `waitForLoadState(${state})`,
    );
  }

  async waitForSelector(target, { state = 'visible', timeout = DEFAULT_TIMEOUT } = {}) {
    if (!['visible', 'attached', 'hidden'].includes(state)) {
      throw Object.assign(new TypeError(`waitForSelector: unknown state ${state}`), { error_code: 'WEGO_INVALID_ARGUMENT' });
    }
    await withTimeout(
      poll(async () => {
        try {
          await resolveTarget(this, target, { checkActionable: state === 'visible' });
          return state === 'hidden' ? undefined : true;
        } catch (e) {
          if (e.kind === 'not_found' || e.kind === 'stale') return state === 'hidden' ? true : undefined;
          if (e.kind === 'not_actionable') return undefined;
          return undefined;
        }
      }),
      timeout, `waitForSelector(${target}, ${state})`,
    );
  }

  async waitForFunction(fn, arg, { timeout = DEFAULT_TIMEOUT } = {}) {
    const session = await this._session();
    const source = typeof fn === 'function' ? fn.toString() : String(fn);
    await withTimeout(
      poll(async () => {
        const { result } = await session.send('Runtime.evaluate', {
          expression: `Promise.resolve((${source})(${JSON.stringify(arg)})).then(v => v ? true : undefined, () => undefined)`,
          awaitPromise: true,
          returnByValue: true,
        });
        return result.value;
      }),
      timeout, 'waitForFunction',
    );
  }

  waitForTimeout(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async waitForEvent(name, { timeout = DEFAULT_TIMEOUT } = {}) {
    if (name === 'popup') {
      this._watchPopups();
      return withTimeout(new Promise((r) => this._popupWaiters.push(r)), timeout, "waitForEvent('popup')");
    }
    if (name === 'download') {
      // Downloads live in the bridge registry (browser-side will-download
      // handler); CDP download events do not fire under Electron.
      const ego = this._ctx().ego;
      const listDownloads = async () =>
        (await ego._call('downloads').catch(() => ({ downloads: [] }))).downloads ?? [];
      const known = new Map((await listDownloads()).map((d) => [d.url, d.savePath]));
      return withTimeout((async () => {
        for (;;) {
          for (const d of await listDownloads()) {
            const knownPath = known.get(d.url);
            const isNew = knownPath === undefined;
            const restarted = knownPath !== undefined && knownPath !== d.savePath && d.state === 'progressing';
            if (isNew || restarted) {
              known.set(d.url, d.savePath);
              const dl = new Download(this, null, d.url, d.filename);
              dl._path = d.savePath;
              // resolve done when the registry entry settles
              (async () => {
                for (;;) {
                  const cur = (await listDownloads()).find((x) => x.savePath === dl._path);
                  if (!cur || cur.state !== 'progressing') { dl._resolveDone(); return; }
                  await new Promise((r) => setTimeout(r, 200));
                }
              })();
              return dl;
            }
          }
          await new Promise((r) => setTimeout(r, 150));
        }
      })(), timeout, "waitForEvent('download')");
    }
    throw Object.assign(new TypeError(`waitForEvent: unknown event ${name}`), { error_code: 'WEGO_INVALID_ARGUMENT' });
  }

  async waitForFileChooser({ timeout = DEFAULT_TIMEOUT } = {}) {
    await this._session(); // ensures interception is enabled before the click
    return withTimeout(new Promise((r) => this._chooserWaiters.push(r)), timeout, 'waitForFileChooser');
  }

  events() {
    const out = this._eventBuffer;
    this._eventBuffer = [];
    return out;
  }

  // ---- snapshot ----

  // Normalize snapshot options: '@N' string roots → integers; OOPIF iframe
  // refs route the capture to the frame target via rootFrameId.
  _snapshotOptions(options) {
    if (!options) return options;
    const out = { ...options };
    if (out.root !== undefined) {
      const refId = parseRefTarget(out.root);
      if (refId === null) {
        throw Object.assign(new TypeError('snapshot root must be a @N ref from a snapshot'), { error_code: 'WEGO_INVALID_ARGUMENT' });
      }
      const entry = lookupRef(this, refId);
      if (!entry) {
        throw new CDPError(`Ref @${refId} is not from this page's latest snapshot; re-snapshot and retry`, 'WEGO_OPERATION_FAILED');
      }
      out.root = refId;
      if (entry.frameId) out.rootFrameId = entry.frameId;
    }
    return out;
  }

  async snapshot(options) {
    const ego = this._ctx().ego;
    ego.useTaskSpace(this.spaceId);
    const opts = this._snapshotOptions(options);
    const { content, refs } = await ego._call('snapshot', { id: this.spaceId, targetId: this.targetId, ...(opts ? { options: opts } : {}) });
    const fullPage = !options || !options.scope || options.scope === 'full_page';
    populateRefs(this, refs, { fullPage });
    return content;
  }
  // raw form: { content, refs }
  async _snapshotRaw(options) {
    const ego = this._ctx().ego;
    ego.useTaskSpace(this.spaceId);
    const opts = this._snapshotOptions(options);
    const result = await ego._call('snapshot', { id: this.spaceId, targetId: this.targetId, ...(opts ? { options: opts } : {}) });
    const fullPage = !options || !options.scope || options.scope === 'full_page';
    populateRefs(this, result.refs, { fullPage });
    return result;
  }

  // ---- element mechanics ----

  async _quads(objectId, session) {
    try {
      const { quads } = await session.send('DOM.getContentQuads', { objectId });
      if (quads && quads.length) return quads;
    } catch { /* fall through */ }
    const { result } = await session.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function(){ const r = this.getBoundingClientRect(); return [r.left, r.top, r.right, r.top, r.right, r.bottom, r.left, r.bottom]; }',
      returnByValue: true,
    });
    return result.value ? [result.value] : [];
  }

  async _scrollIntoView(objectId, session) {
    try {
      await session.send('DOM.scrollIntoViewIfNeeded', { objectId });
      return;
    } catch { /* fallback below */ }
    await session.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function(){ this.scrollIntoView({block:"center", inline:"center"}); }',
    }).catch(() => {});
  }

  // pointFor: coordinates are viewport-local to the resolved session. For
  // OOPIF refs that is the frame's own viewport — CDP Input on the frame
  // session takes frame-local coordinates, so no translation is needed.
  async _pointFor(target, { checkActionable = true } = {}) {
    const { objectId, session } = await resolveTarget(this, target, { checkActionable });
    await this._scrollIntoView(objectId, session);
    const quads = await this._quads(objectId, session);
    if (!quads.length) {
      throw Object.assign(new Error(`Element has no clickable point: ${target}`), { kind: 'not_actionable', name: 'ElementResolutionError' });
    }
    const box = quadUnionBox(quads);
    if (box.width === 0 || box.height === 0) {
      // Zero-area controls (e.g. collapsed submit buttons) silently swallow
      // clicks at their center — refuse honestly instead of misclicking.
      throw Object.assign(new Error(`Element has zero ${box.width === 0 ? 'width' : 'height'} (not clickable): ${target}`), { kind: 'not_actionable', name: 'ElementResolutionError' });
    }
    return { objectId, point: { x: box.cx, y: box.cy }, session };
  }

  // receipt: popups/dialog observed after dispatch. Exits early after a
  // short quiet window instead of always waiting the full 500ms ceiling —
  // dialogs and target=_blank popups arrive within milliseconds; popups
  // scheduled by page JS beyond the quiet window are what
  // waitForEvent('popup') exists for.
  async _receipt() {
    const beforePopups = this._popups.length;
    const dialogSeen = this._dialog ? this._dialog : null;
    const deadline = Date.now() + 500;
    const quietUntil = Date.now() + 120;
    while (Date.now() < deadline) {
      if (this._dialog || this._popups.length > beforePopups) break;
      if (Date.now() >= quietUntil) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    const receipt = { ok: true };
    const popups = this._popups.splice(beforePopups);
    if (popups.length) receipt.popups = popups;
    const dialog = this._dialog || dialogSeen;
    if (dialog) receipt.dialog = dialog;
    return receipt;
  }

  // visibilityState cache per page (covered tabs report hidden)
  async _covered(session) {
    const now = Date.now();
    if (this._visCache && now - this._visCache.at < 300) return this._visCache.covered;
    const { result } = await session.send('Runtime.evaluate', {
      expression: 'document.visibilityState === "hidden"',
      returnByValue: true,
    }).catch(() => ({ result: { value: false } }));
    this._visCache = { at: now, covered: !!result?.value };
    return this._visCache.covered;
  }

  async _dispatchClick(point, { clickCount = 1, session, objectId } = {}) {
    session ??= await this._session();
    this._watchPopups();
    this._mousePos = { x: point.x, y: point.y };
    if (objectId && await this._covered(session)) {
      await syntheticPointer(session, objectId, point, { clickCount });
      return;
    }
    await mouseEvent(session, 'mouseMoved', point.x, point.y);
    await mouseEvent(session, 'mousePressed', point.x, point.y, { button: 'left', buttons: MOUSE_BUTTONS.left, clickCount });
    await mouseEvent(session, 'mouseReleased', point.x, point.y, { button: 'left', buttons: 0, clickCount });
  }

  // ---- actions ----

  async click(target, { label } = {}) {
    void label;
    const { point, session, objectId } = await this._pointFor(target);
    await this._dispatchClick(point, { clickCount: 1, session, objectId });
    return this._receipt();
  }

  async dblclick(target, { label } = {}) {
    void label;
    const { point, session, objectId } = await this._pointFor(target);
    await this._dispatchClick(point, { clickCount: 2, session, objectId });
    return this._receipt();
  }

  async hover(target, { label } = {}) {
    void label;
    // hover may target disabled elements
    const { point, session, objectId } = await this._pointFor(target, { checkActionable: false });
    if (objectId && await this._covered(session)) {
      await syntheticPointer(session, objectId, point, { hover: true });
      return this._receipt();
    }
    await mouseEvent(session, 'mouseMoved', point.x, point.y);
    return this._receipt();
  }

  async dragAndDrop(source, destination, { label } = {}) {
    void label;
    const src = await this._pointFor(source, { checkActionable: false });
    const dst = await this._pointFor(destination, { checkActionable: false });
    await mouseEvent(src.session, 'mouseMoved', src.point.x, src.point.y);
    await mouseEvent(src.session, 'mousePressed', src.point.x, src.point.y, { button: 'left', buttons: MOUSE_BUTTONS.left, clickCount: 1 });
    await mouseEvent(dst.session, 'mouseMoved', dst.point.x, dst.point.y, { button: 'left', buttons: MOUSE_BUTTONS.left });
    await mouseEvent(dst.session, 'mouseReleased', dst.point.x, dst.point.y, { button: 'left', buttons: 0, clickCount: 1 });
    return this._receipt();
  }

  async fill(target, text) {
    const { objectId, session } = await resolveTarget(this, target, { checkActionable: true });
    await this._scrollIntoView(objectId, session);
    // focus + select-all existing value in-page
    await session.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function(){
        this.focus();
        if (this.select) { try { this.select(); } catch {} }
        else if (this.isContentEditable) {
          const r = this.ownerDocument.createRange();
          r.selectNodeContents(this);
          const s = this.ownerDocument.defaultView.getSelection();
          s.removeAllRanges(); s.addRange(r);
        }
      }`,
    });
    const before = await session.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function(){ return "value" in this ? this.value : this.textContent; }',
      returnByValue: true,
    });
    await session.send('Input.insertText', { text: String(text) });
    // ensure input/change fired
    const after = await session.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function(){
        const v = "value" in this ? this.value : this.textContent;
        return v;
      }`,
      returnByValue: true,
    });
    if (after.result.value !== String(text)) {
      await session.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function(v){
          if ("value" in this) this.value = v; else this.textContent = v;
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
        }`,
        arguments: [{ value: String(text) }],
      });
      const verify = await session.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function(){ return "value" in this ? this.value : this.textContent; }',
        returnByValue: true,
      });
      if (verify.result.value !== String(text)) {
        throw new CDPError(`fill failed: element value did not update (before=${JSON.stringify(before.result.value)})`, 'WEGO_OPERATION_FAILED');
      }
    }
    return this._receipt();
  }

  async selectOption(target, values) {
    const { objectId, session } = await resolveTarget(this, target, { checkActionable: false });
    if (values === null) {
      await session.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function(){ for (const o of this.options) o.selected = false; this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true})); }`,
      });
      return this._receipt();
    }
    const list = Array.isArray(values) ? values : [values];
    const { result } = await session.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function(specs){
        const picked = [];
        for (const spec of specs) {
          let found = null;
          for (const o of this.options) {
            if ('label' in spec && o.label === spec.label) found = o;
            else if ('index' in spec && o.index === spec.index) found = o;
            else if (typeof spec === 'string' && o.value === spec) found = o;
            if (found) break;
          }
          if (!found) return { error: 'option_not_found' };
          found.selected = true;
          picked.push(found.value);
        }
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return { picked };
      }`,
      arguments: [{ value: list.map((v) => (typeof v === 'string' ? v : v)) }],
      returnByValue: true,
    });
    if (result.value?.error) throw new CDPError(`selectOption: option not found in ${target}`, 'WEGO_OPERATION_FAILED');
    return this._receipt();
  }

  async focus(target) {
    const { objectId, session } = await resolveTarget(this, target, { checkActionable: false });
    await session.send('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function(){ this.focus(); }' });
    return this._receipt();
  }

  async press(target, key) {
    if (key === undefined) { key = target; target = null; } // press(key) convenience? keep strict: (target,key)
    if (target == null) throw Object.assign(new TypeError('press(target, key) requires a target'), { error_code: 'WEGO_INVALID_ARGUMENT' });
    const { objectId, session } = await resolveTarget(this, target, { checkActionable: false });
    await session.send('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function(){ this.focus(); }' });
    await pressKey(session, key);
    return this._receipt();
  }

  async setInputFiles(target, absPaths) {
    const paths = Array.isArray(absPaths) ? absPaths : [absPaths];
    for (const p of paths) {
      if (!path.isAbsolute(p)) throw Object.assign(new TypeError('setInputFiles paths must be absolute'), { error_code: 'WEGO_INVALID_ARGUMENT' });
    }
    const { objectId, session } = await resolveTarget(this, target, { checkActionable: false });
    const { node } = await session.send('DOM.describeNode', { objectId });
    await session.send('DOM.setFileInputFiles', { files: paths, nodeId: node.nodeId }).catch(async () => {
      const { node: n2 } = await session.send('DOM.describeNode', { objectId });
      await session.send('DOM.setFileInputFiles', { files: paths, backendNodeId: n2.backendNodeId });
    });
    return this._receipt();
  }

  // ---- dialogs ----

  // Dialogs are recorded by the in-page shim and auto-dismissed with safe
  // defaults (Electron shows native dialogs which wedge automation). Accept
  // acknowledges and clears the current record; promptText is accepted for
  // API compatibility but cannot retro-answer an already-continued prompt.
  async acceptDialog(promptText) {
    void promptText;
    const d = this._dialog;
    this._dialog = null;
    return d;
  }

  async dismissDialog() {
    const d = this._dialog;
    this._dialog = null;
    return d;
  }

  // ---- evaluate / fetch / screenshot / cdp ----

  async evaluate(fnOrString, arg) {
    const session = await this._session();
    const source = typeof fnOrString === 'function' ? fnOrString.toString() : String(fnOrString);
    const isFunc = typeof fnOrString === 'function' || /^\s*(async\s*)?(\(|\w+\s*=>|function)/.test(source);
    const expression = isFunc
      ? `(${source})(${JSON.stringify(arg)})`
      : source;
    const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) {
      const msg = exceptionDetails.exception?.description || exceptionDetails.text;
      throw new CDPError(`evaluate failed: ${msg}`, 'WEGO_OPERATION_FAILED');
    }
    return result.value;
  }

  async fetch(url, options = {}) {
    const { saveAs, ...fetchOpts } = options || {};
    const session = await this._session();
    const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
      expression: `(async () => {
        const res = await window.fetch(${JSON.stringify(url)}, ${JSON.stringify(fetchOpts)});
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = '';
        const CH = 0x8000;
        for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
        const headers = {};
        res.headers.forEach((v, k) => { headers[k] = v; });
        return { ok: res.ok, status: res.status, statusText: res.statusText, url: res.url, headers, body: btoa(bin) };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new CDPError(`fetch failed: ${exceptionDetails.text}`, 'WEGO_OPERATION_FAILED');
    const out = result.value;
    const bodyBuf = Buffer.from(out.body, 'base64');
    if (saveAs !== undefined) {
      if (!path.isAbsolute(saveAs)) throw Object.assign(new TypeError('fetch saveAs must be an absolute path'), { error_code: 'WEGO_INVALID_ARGUMENT' });
      await fs.promises.mkdir(path.dirname(saveAs), { recursive: true });
      await fs.promises.writeFile(saveAs, bodyBuf);
    }
    return { ok: out.ok, status: out.status, statusText: out.statusText, url: out.url, headers: out.headers, body: bodyBuf.toString('utf8') };
  }

  async cdp(method, params = {}) {
    const session = await this._session();
    return session.send(method, params);
  }

  async screenshot({ path: outPath } = {}) {
    const session = await this._session();
    if (outPath !== undefined && !path.isAbsolute(outPath)) {
      throw Object.assign(new TypeError('screenshot path must be absolute'), { error_code: 'WEGO_INVALID_ARGUMENT' });
    }
    const finalPath = outPath || path.join(os.tmpdir(), `ego-shot-${crypto.randomBytes(6).toString('hex')}.png`);
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
    const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
    await fs.promises.writeFile(finalPath, Buffer.from(data, 'base64'));
    return finalPath;
  }

  async close() {
    const ego = this._ctx().ego;
    ego.useTaskSpace(this.spaceId);
    await ego._call('closeTab', { id: this.spaceId, targetId: this.targetId });
    this.space._removePage(this.label);
  }

  // ---- mouse / keyboard namespaces ----

  get mouse() { return buildMouse(this); }

  get keyboard() { return buildKeyboard(this); }
}
