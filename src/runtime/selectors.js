// Target resolution shared by actions. Selector strings:
//   '@N' | 'ref=N'        snapshot refs (handled by refs.js, not here)
//   'text=...'             unquoted: case-insensitive substring, ws-normalized
//   'text="..."'           double-quoted: exact case-sensitive match
//   'loc=css:...'          CSS
//   'loc=role:role[name=X]'        exact name; [name*=X] substring
//   'loc=href:...'         anchors by href substring
//   'xpath=...'            XPath
//   'css=...' / raw CSS
//   '>> nth=N'             terminal index (N>=0, or -1 = last)
// Resolution runs in-page via one injected resolver (stringified below);
// it pierces open shadow roots, top document first, then same-origin iframes.

import { ElementResolutionError, parseRefTarget, resolve as resolveRef } from './refs.js';
import { computeRoleSource } from '../shared/roles.js';

const RESOLVER_FN = String.raw`function __wegoResolve(sel) {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  // Canonical role mapping embedded from src/shared/roles.js — must match the
  // snapshot engine byte-for-byte so snapshot-emitted loc=role: locators resolve.
  const roleOf = ${computeRoleSource};
  function nameOf(el) {
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const parts = labelledby.split(/\s+/).map((id) => {
        try { return el.ownerDocument.getElementById(id); } catch { return null; }
      }).filter(Boolean).map((n) => norm(n.textContent));
      if (parts.length) return parts.join(' ');
    }
    const aria = el.getAttribute('aria-label');
    if (aria) return norm(aria);
    const id = el.id;
    if (id) {
      try {
        const lab = el.ownerDocument.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (lab) return norm(lab.textContent);
      } catch {}
    }
    if (el.labels && el.labels.length) return norm(el.labels[0].textContent);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const ph = el.getAttribute('placeholder');
      if (ph) return norm(ph);
    }
    if (el.tagName === 'IMG') return norm(el.getAttribute('alt') || '');
    return norm(el.textContent || '');
  }

  // --- deep traversal: open shadow roots, one document ---
  function* walk(root) {
    const doc = root.nodeType === 9 ? root : root.ownerDocument || root;
    const tw = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = root.nodeType === 1 ? root : tw.nextNode();
    while (node) {
      yield node;
      if (node.shadowRoot) yield* walk(node.shadowRoot);
      node = tw.nextNode();
    }
  }
  function* walkDeep(doc) {
    yield* walk(doc);
    // same-origin iframes after top document
    for (const frame of doc.querySelectorAll('iframe')) {
      try {
        if (frame.contentDocument) yield* walk(frame.contentDocument);
      } catch { /* cross-origin */ }
    }
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }
  function disabled(el) {
    if (el.disabled) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    let p = el.parentElement;
    while (p) { if (p.tagName === 'FIELDSET' && p.disabled) return true; p = p.parentElement; }
    return false;
  }

  // --- parse selector ---
  let mode = 'css', arg = sel, nth = null;
  const nthM = /^(.*?)\s*>>\s*nth=(-?\d+)\s*$/.exec(sel);
  if (nthM) { arg = nthM[1].trim(); nth = parseInt(nthM[2], 10); }
  let m;
  if ((m = /^text=(.*)$/.exec(arg))) {
    mode = 'text';
    let v = m[1];
    if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
      mode = 'textExact'; arg = v.slice(1, -1);
    } else { arg = norm(v).toLowerCase(); }
  } else if ((m = /^loc=css:(.*)$/.exec(arg))) { mode = 'css'; arg = m[1];
  } else if ((m = /^loc=href:(.*)$/.exec(arg))) { mode = 'href'; arg = m[1];
  } else if ((m = /^loc=role:([a-zA-Z]+)(?:\[(name\*?)=(["']?)(.*?)\3\])?$/.exec(arg))) {
    mode = 'role'; arg = { role: m[1], substr: m[2] === 'name*', name: m[4] !== undefined ? m[4] : null };
  } else if ((m = /^xpath=(.*)$/.exec(arg))) { mode = 'xpath'; arg = m[1];
  } else if ((m = /^css=(.*)$/.exec(arg))) { mode = 'css'; arg = m[1]; }

  const doc = document;
  let matches = [];
  if (mode === 'css') {
    const all = [];
    for (const el of walkDeep(doc)) {
      if (el.nodeType !== 1) continue;
      try { if (el.matches(arg)) all.push(el); } catch { return { error: 'invalid_selector', detail: arg }; }
    }
    matches = all;
  } else if (mode === 'xpath') {
    let res;
    try {
      res = doc.evaluate(arg, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    } catch { return { error: 'invalid_selector', detail: arg }; }
    for (let i = 0; i < res.snapshotLength; i++) {
      const n = res.snapshotItem(i);
      if (n && n.nodeType === 1) matches.push(n);
    }
  } else if (mode === 'text' || mode === 'textExact') {
    for (const el of walkDeep(doc)) {
      const t = norm(el.innerText || el.textContent || '');
      if (mode === 'text' ? t.toLowerCase().includes(arg) : t === arg) {
        // keep deepest elements only to avoid ancestor cascade
        matches.push(el);
      }
    }
    matches = matches.filter((el) => !matches.some((o) => o !== el && el.contains(o)));
  } else if (mode === 'href') {
    for (const el of walkDeep(doc)) {
      if (el.tagName === 'A' && (el.getAttribute('href') || '').includes(arg)) matches.push(el);
    }
  } else if (mode === 'role') {
    for (const el of walkDeep(doc)) {
      if (roleOf(el) !== arg.role) continue;
      if (arg.name !== null) {
        const n = nameOf(el);
        if (arg.substr ? !n.includes(arg.name) : n !== arg.name) continue;
      }
      matches.push(el);
    }
  }

  if (nth !== null) {
    if (matches.length === 0) return { count: 0 };
    const i = nth === -1 ? matches.length - 1 : nth;
    matches = matches[i] ? [matches[i]] : [];
  }

  if (matches.length === 0) return { count: 0 };
  if (matches.length > 1) return { count: matches.length };
  let el = matches[0];
  if (!visible(el)) {
    // A matched leaf may be a zero-area text carrier (e.g. an invisible span
    // inside a visible link). Climb to a unique interactive ancestor — the
    // same reading ego gives to wrapper matches. Shadow boundaries crossed
    // via getRootNode().host.
    let cur = el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
    while (cur && cur.nodeType === 1) {
      const interactive = cur.matches('a[href],button,[role="button"],[role="link"],input,select,textarea,summary,[tabindex],[onclick]');
      if (interactive && visible(cur)) { el = cur; break; }
      if (interactive) break; // interactive but still invisible: stop climbing
      cur = cur.parentElement || (cur.getRootNode && cur.getRootNode().host) || null;
    }
  }
  return { count: 1, visible: visible(el), disabled: disabled(el), element: el };
}`;

function invalidSelector(target) {
  const err = new ElementResolutionError('not_found', `Unresolvable selector: ${target}`);
  return err;
}

// Resolve a target string to { objectId, session } on the CDP session that
// owns the element (page session, or the OOPIF frame session for frame refs).
// opts.checkActionable: when true, hidden/disabled → not_actionable.
export async function resolveTarget(page, target, { checkActionable = false } = {}) {
  if (typeof target === 'string' || typeof target === 'number') {
    const refId = parseRefTarget(target);
    if (refId !== null) {
      return resolveRef(page, target); // { objectId, session }
    }
  }
  if (typeof target !== 'string' || target.trim() === '') throw invalidSelector(String(target));

  const session = await page._session();
  const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
    expression: `(()=>{const r=(${RESOLVER_FN})(${JSON.stringify(target)});if(!r||r.error||r.count!==1)return{error:r&&r.error,count:r?r.count:0};return{count:1,visible:r.visible,disabled:r.disabled,hasElement:!!r.element};})()`,
    returnByValue: true,
    includeCommandLineAPI: false,
  });
  if (exceptionDetails) {
    throw new ElementResolutionError('not_found', `Selector failed in page: ${target}`);
  }
  const out = result?.value;
  if (!out || out.error === 'invalid_selector') {
    throw new ElementResolutionError('not_found', `Invalid selector: ${target}`);
  }
  if (out.count === 0) {
    throw new ElementResolutionError('not_found', `No element matches: ${target}`);
  }
  if (out.count > 1) {
    throw new ElementResolutionError('ambiguous', `Selector matched ${out.count} elements: ${target} (use '>> nth=N')`);
  }

  // Re-resolve without returnByValue to grab the objectId.
  const obj = await session.send('Runtime.evaluate', {
    expression: `(${RESOLVER_FN})(${JSON.stringify(target)}).element`,
    returnByValue: false,
  });
  if (!obj.result || !obj.result.objectId) {
    throw new ElementResolutionError('stale', `Element vanished during resolution: ${target}`);
  }
  if (checkActionable && (!out.visible || out.disabled)) {
    throw new ElementResolutionError('not_actionable', `Element is not actionable (hidden or disabled): ${target}`);
  }
  return { objectId: obj.result.objectId, session };
}

// Test-only handle on the injected resolver source (see test/selectors.test.mjs).
export const __testing = { RESOLVER_FN };
