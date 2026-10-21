// In-page snapshot program for the ego-lite snapshot engine.
// This module exports SOURCE TEXT: index.js injects it into the page's MAIN
// world via webContents.executeJavaScript. `egoSnapshotPageMain` must stay
// fully self-contained (no references to module scope) because it is
// stringified with Function#toString and re-evaluated inside the page.
//
// Injection is idempotent: a fresh document has no `__egoSnapshot`, so a full
// install runs (new token, empty registry). Re-evaluation in the same
// document hits the SCRIPT_ID guard and keeps the existing registry, so refs
// stay stable across captures within one document.

function egoSnapshotPageMain() {
  const SCRIPT_ID = 'ego-lite-snapshot/1';
  const prev = globalThis.__egoSnapshot;
  if (prev && prev.__scriptId === SCRIPT_ID) return prev;

  const token = 'doc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  // OOPIF captures inject __egoSnapshotRefBase before this source so refs are
  // unique across frames within one merged snapshot.
  let nextRefId = 1 + (Number(globalThis.__egoSnapshotRefBase) || 0);
  const byId = new Map();    // refId -> Element (direct references; also covers iframe-document elements)
  const byEl = new WeakMap(); // Element -> refId (keeps refs stable across repeated captures)

  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'title', 'base', 'link']);
  // Elements whose DOM children are never rendered as content.
  const LEAF_TAGS = new Set(['img', 'canvas', 'svg', 'br', 'hr', 'wbr', 'input', 'area', 'embed', 'audio', 'video', 'track', 'source', 'textarea']);
  const ACTIONABLE_ROLES = new Set(['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'treeitem']);
  // Roles whose accessible name may fall back to visible inner text.
  const NAME_FROM_CONTENT = new Set(['button', 'link', 'heading', 'option', 'tab', 'menuitem', 'treeitem', 'switch', 'checkbox', 'radio']);
  const INPUT_TYPE_ROLE = {
    button: 'button', submit: 'button', reset: 'button', image: 'button',
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton',
  };

  // \s already covers NBSP and FEFF; add the zero-width family explicitly.
  const WS_RE = /[\s\u200b\u200c\u200d]+/g;

  function collapse(s) { return String(s).replace(WS_RE, ' ').trim(); }
  function cap(s) { return s.length > 80 ? s.slice(0, 80) : s; }
  function esc(s) { return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
  function quoteName(s) { return '"' + esc(s) + '"'; }
  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s).replace(/([^\w-])/g, '\\$1');
  }

  function winOf(el) {
    const doc = el.ownerDocument;
    return (doc && doc.defaultView) || window;
  }

  function computeRole(el) {
    const tag = el.tagName.toLowerCase();
    const roleAttr = (el.getAttribute('role') || '').trim();
    if (roleAttr) return roleAttr.split(/\s+/)[0].toLowerCase(); // explicit role wins
    switch (tag) {
      case 'a':
      case 'area': return el.hasAttribute('href') ? 'link' : 'generic';
      case 'button': return 'button';
      case 'input': {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        return INPUT_TYPE_ROLE[t] || 'textbox';
      }
      case 'textarea': return 'textbox';
      case 'select': {
        const size = parseInt(el.getAttribute('size') || '0', 10);
        return (el.multiple || size > 1) ? 'listbox' : 'combobox';
      }
      case 'option': return 'option';
      case 'img':
      case 'canvas':
      case 'svg': return 'img';
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': return 'heading';
      case 'ul':
      case 'ol': return 'list';
      case 'li': return 'listitem';
      case 'table': return 'table';
      case 'tr': return 'row';
      case 'td':
      case 'th': return 'cell';
      case 'nav': return 'navigation';
      case 'main': return 'main';
      case 'form': return 'form';
      case 'dialog': return 'dialog';
      case 'iframe': return 'iframe';
      default: return 'generic';
    }
  }

  function textOf(el) {
    let t = '';
    try { t = el.innerText || ''; } catch { t = ''; }
    if (!t) { try { t = el.textContent || ''; } catch { t = ''; } }
    return collapse(t);
  }

  // Accessible name, in priority order:
  // aria-labelledby -> aria-label -> <label for> -> wrapping <label>
  // -> alt/title/placeholder -> value (input buttons) -> visible inner text.
  function computeName(el, role) {
    const root = (el.getRootNode && el.getRootNode()) || el.ownerDocument;
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const parts = [];
      for (const id of labelledby.trim().split(/\s+/)) {
        let target = null;
        try { if (root && root.getElementById) target = root.getElementById(id); } catch { target = null; }
        if (!target && el.ownerDocument) { try { target = el.ownerDocument.getElementById(id); } catch { target = null; } }
        if (target) { const t = textOf(target); if (t) parts.push(t); }
      }
      if (parts.length) return cap(parts.join(' '));
    }
    const ariaLabel = collapse(el.getAttribute('aria-label') || '');
    if (ariaLabel) return cap(ariaLabel);
    if (el.id && root && root.querySelector) {
      let lbl = null;
      try { lbl = root.querySelector('label[for="' + cssEscape(el.id) + '"]'); } catch { lbl = null; }
      if (lbl) { const t = textOf(lbl); if (t) return cap(t); }
    }
    if (el.closest) {
      const wrap = el.closest('label');
      if (wrap) { const t = textOf(wrap); if (t) return cap(t); }
    }
    const alt = collapse(el.getAttribute('alt') || '');
    if (alt) return cap(alt);
    const title = collapse(el.getAttribute('title') || '');
    if (title) return cap(title);
    const placeholder = collapse(el.getAttribute('placeholder') || '');
    if (placeholder) return cap(placeholder);
    if (el.tagName === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') {
        const v = collapse(el.getAttribute('value') || '');
        if (v) return cap(v);
      }
    }
    if (NAME_FROM_CONTENT.has(role)) {
      const t = textOf(el);
      if (t) return cap(t);
    }
    return '';
  }

  function assignRef(el) {
    let id = byEl.get(el);
    if (id === undefined) {
      id = nextRefId++;
      byEl.set(el, id);
      byId.set(id, el);
    }
    return id;
  }

  function getRefElement(refId) {
    const el = byId.get(refId);
    if (!el) return null;
    if (!el.isConnected) { byId.delete(refId); return null; } // stale
    return el;
  }

  function isDisabled(el) {
    try { return el.matches(':disabled'); } catch { return false; }
  }

  function isRefWorthy(el, role) {
    if (ACTIONABLE_ROLES.has(role)) return true;
    const ti = el.getAttribute('tabindex');
    if (ti !== null && ti !== '') {
      const n = parseInt(ti, 10);
      if (Number.isFinite(n) && n >= 0 && role !== 'generic') return true;
    }
    if (el.hasAttribute('onclick')) return true;
    try { if (el.isContentEditable) return true; } catch { /* ignore */ }
    return false;
  }

  // Index of a frame element among the iframes of its parent document.
  function frameIndex(fe) {
    const doc = fe.ownerDocument;
    if (!doc) return 0;
    const all = doc.querySelectorAll('iframe');
    for (let i = 0; i < all.length; i++) if (all[i] === fe) return i;
    return 0;
  }

  // Slash-joined iframe index path from the top document ('' for the top document).
  function framePathOf(el) {
    const parts = [];
    try {
      let win = el.ownerDocument && el.ownerDocument.defaultView;
      let guard = 0;
      while (win && win.frameElement && guard++ < 32) {
        parts.unshift(String(frameIndex(win.frameElement)));
        win = win.frameElement.ownerDocument && win.frameElement.ownerDocument.defaultView;
      }
    } catch { /* cross-origin ancestor: stop */ }
    return parts.join('/');
  }

  function intersectsViewport(rect, win) {
    return rect.width > 0 && rect.height > 0 &&
      rect.bottom > 0 && rect.right > 0 &&
      rect.top < (win.innerHeight || 0) && rect.left < (win.innerWidth || 0);
  }

  // --- stable locators -------------------------------------------------------

  // Count computed role+name pairs over every element of one root scope
  // (document or shadow root). Deliberately counts hidden elements too:
  // conservative — fewer locs emitted, never ambiguous ones.
  function buildCounts(root) {
    const counts = new Map();
    let all;
    try { all = Array.from(root.querySelectorAll('*')); } catch { return counts; }
    for (let i = 0; i < all.length; i++) {
      const e = all[i];
      if (e.shadowRoot) {
        try { for (const inner of e.shadowRoot.querySelectorAll('*')) all.push(inner); } catch { /* ignore */ }
      }
      if (!e.tagName) continue;
      const tag = e.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;
      const role = computeRole(e);
      const name = computeName(e, role);
      const key = role + '' + name;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }

  // Unique plain-CSS path: #id, else a tag:nth-of-type chain from body.
  // Joined with '>' (no spaces) so `loc=` stays a single token. Returns null
  // for shadow-root elements (not expressible in standard CSS).
  function uniqueCssPath(el) {
    const root = (el.getRootNode && el.getRootNode()) || null;
    if (!root || root.nodeType !== 9) return null;
    if (el.id) {
      const sel = '#' + cssEscape(el.id);
      try { if (root.querySelectorAll(sel).length === 1) return 'css:' + sel; } catch { /* fall through */ }
    }
    const parts = [];
    let cur = el;
    let guard = 0;
    while (cur && cur.nodeType === 1 && guard++ < 64) {
      const tag = cur.tagName.toLowerCase();
      if (tag === 'body') { parts.unshift('body'); break; }
      if (tag === 'html') return null;
      const parent = cur.parentElement;
      if (!parent) return null;
      let idx = 0;
      let seen = 0;
      const sibs = parent.children;
      for (let i = 0; i < sibs.length; i++) {
        if (sibs[i].tagName === cur.tagName) {
          seen++;
          if (sibs[i] === cur) { idx = seen; break; }
        }
      }
      if (!idx) return null;
      parts.unshift(tag + ':nth-of-type(' + idx + ')');
      cur = parent;
    }
    if (!parts.length || parts[0] !== 'body') return null;
    const sel = parts.join('>');
    try { return root.querySelectorAll(sel).length === 1 ? 'css:' + sel : null; } catch { return null; }
  }

  function computeLoc(el, role, name, ctx) {
    const root = (el.getRootNode && el.getRootNode()) || el.ownerDocument;
    let counts = ctx.countCache.get(root);
    if (!counts) { counts = buildCounts(root); ctx.countCache.set(root, counts); }
    if (counts.get(role + '' + name) === 1) return 'role:' + role + '[name=' + quoteName(name) + ']';
    return uniqueCssPath(el) || undefined;
  }

  // --- tree walk -------------------------------------------------------------

  function stripTextDeep(nodes) {
    const out = [];
    for (const n of nodes) {
      if (n.kind === 'text') continue;
      if (n.children) n.children = stripTextDeep(n.children);
      out.push(n);
    }
    return out;
  }

  function walkChildren(parent, ctx, out) {
    for (const child of parent.childNodes) {
      if (child.nodeType === 3) {
        const t = cap(collapse(child.nodeValue || ''));
        if (t) out.push({ kind: 'text', text: t });
      } else if (child.nodeType === 1) {
        walkElement(child, ctx, out);
      }
    }
  }

  function walkElement(el, ctx, out) {
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    if (tag === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'hidden') return;
    if (el.getAttribute('aria-hidden') === 'true') return;
    const win = winOf(el);
    let style;
    try { style = win.getComputedStyle(el); } catch { return; }
    if (style.display === 'none') return;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return;
    let rect;
    try { rect = el.getBoundingClientRect(); } catch { return; }
    if (ctx.viewportOnly && !intersectsViewport(rect, win)) return;

    if (tag === 'iframe') { walkIframe(el, ctx, out); return; }

    const role = computeRole(el);
    let children = [];
    if (!LEAF_TAGS.has(tag)) walkChildren(el, ctx, children);
    const sr = el.shadowRoot; // open shadow roots only; closed roots yield null
    if (sr) {
      const sc = [];
      walkChildren(sr, ctx, sc);
      if (sc.length) children.push({ kind: 'shadow', children: sc });
    }
    if (NAME_FROM_CONTENT.has(role)) children = stripTextDeep(children); // their text is the name

    const zero = rect.width === 0 && rect.height === 0;
    if (zero) {
      // Zero-size element: keep only if it has visible descendants, and then
      // only the descendants (the element itself is invisible).
      if (children.length === 0) return;
      for (const c of children) out.push(c);
      return;
    }

    const name = computeName(el, role);
    const disabled = isDisabled(el);
    const node = { kind: 'el', role, name, children, disabled, el };
    if (isRefWorthy(el, role)) {
      node.refId = assignRef(el);
      node.actionMarked = !disabled; // disabled controls keep a ref but no action mark
      if (ctx.locs) node.loc = computeLoc(el, role, name, ctx);
    }
    out.push(node);
  }

  function walkIframe(el, ctx, out) {
    const name = computeName(el, 'iframe');
    const node = { kind: 'el', role: 'iframe', name, children: [], disabled: false, el, refId: assignRef(el), actionMarked: false };
    if (ctx.locs) node.loc = computeLoc(el, 'iframe', name, ctx);
    let fdoc = null;
    try { fdoc = el.contentDocument; } catch { fdoc = null; } // cross-origin -> no children
    if (fdoc) {
      const rootEl = fdoc.documentElement || fdoc.body;
      if (rootEl) walkElement(rootEl, ctx, node.children);
    }
    // Orchestrator metadata: undescended (cross-origin) iframes get merged
    // from their own OOPIF target afterwards.
    if (ctx.frames) ctx.frames.push({ refId: node.refId, src: el.src || '', descended: !!fdoc });
    out.push(node);
  }

  // --- compaction ------------------------------------------------------------

  // Remove unnamed childless generics; unwrap unnamed generics with exactly
  // one child. Bottom-up, so one pass is enough. Never collapses ref-bearing
  // nodes, named nodes, or any non-generic role.
  function compactList(nodes) {
    const out = [];
    for (const n of nodes) {
      if (n.children) n.children = compactList(n.children);
      if (n.kind === 'el' && n.role === 'generic' && !n.name && n.refId == null) {
        if (n.children.length === 0) continue;
        if (n.children.length === 1) { out.push(n.children[0]); continue; }
      }
      out.push(n);
    }
    return out;
  }

  // --- interactiveOnly pruning ------------------------------------------------

  function markActionable(n) {
    let any = n.kind === 'el' && !!n.actionMarked;
    for (const c of n.children || []) if (markActionable(c)) any = true;
    n.hasAction = any;
    return any;
  }

  function pruneInteractive(n) {
    n.children = (n.children || []).filter((c) => c.hasAction);
    for (const c of n.children) pruneInteractive(c);
  }

  // --- rendering ---------------------------------------------------------------

  function emitNode(n, depth, lines, refs, actionMarks) {
    const pad = '  '.repeat(depth);
    if (n.kind === 'text') {
      lines.push(pad + '- text ' + quoteName(n.text));
      return;
    }
    if (n.kind === 'shadow') {
      lines.push(pad + '- shadow-root');
      for (const c of n.children) emitNode(c, depth + 1, lines, refs, actionMarks);
      return;
    }
    let line = pad + '- ' + n.role;
    if (n.name) line += ' ' + quoteName(n.name);
    if (n.refId != null) {
      line += ' [ref=' + n.refId + ']';
      if (n.loc) line += ' loc=' + n.loc;
      const ref = { refId: n.refId, role: n.role, name: n.name || '' };
      if (n.loc) ref.loc = n.loc;
      const fp = framePathOf(n.el);
      if (fp) ref.framePath = fp;
      refs.push(ref);
    }
    if (n.disabled) line += ' (disabled)';
    if (actionMarks && n.actionMarked) line += ' \u2190';
    lines.push(line);
    for (const c of n.children || []) emitNode(c, depth + 1, lines, refs, actionMarks);
  }

  // --- capture entry point -----------------------------------------------------

  function capture(rawOptions) {
    const opts = rawOptions || {};
    const scope = (opts.scope === 'only_within_viewport' || opts.scope === 'subtree') ? opts.scope : 'full_page';
    let rootEl;
    if (scope === 'subtree') {
      const target = getRefElement(opts.root);
      if (!target) throw new Error('subtree root not found or stale');
      rootEl = target;
      if (rootEl.tagName === 'IFRAME') {
        let fdoc = null;
        try { fdoc = rootEl.contentDocument; } catch { fdoc = null; }
        if (fdoc) rootEl = fdoc.documentElement || fdoc.body || rootEl;
      }
    } else {
      rootEl = document.documentElement || document.body;
    }
    if (!rootEl) throw new Error('document has no root element');

    const ctx = {
      viewportOnly: scope === 'only_within_viewport',
      locs: opts.includeStableLocator === true,
      countCache: new Map(),
      frames: [],
    };
    const roots = [];
    walkElement(rootEl, ctx, roots);
    let rootNode;
    if (roots.length === 1 && roots[0].kind === 'el') {
      rootNode = roots[0];
    } else {
      // Root was promoted away (zero-size) — keep a synthetic root line.
      const role = computeRole(rootEl);
      rootNode = { kind: 'el', role, name: computeName(rootEl, role), children: roots, el: rootEl };
    }
    rootNode.children = compactList(rootNode.children || []); // root line itself is never compacted
    if (opts.interactiveOnly === true) {
      markActionable(rootNode);
      pruneInteractive(rootNode); // root line always kept
    }
    const lines = [];
    const refs = [];
    emitNode(rootNode, 0, lines, refs, opts.includeActionMarks === true);
    return { content: lines.join('\n'), refs, frames: ctx.frames };
  }

  const api = {
    __scriptId: SCRIPT_ID,
    token,
    getRefElement,
    getDocumentToken() { return token; },
    capture,
  };
  globalThis.__egoSnapshot = api;
  return api;
}

export const pageScriptSource = '(' + egoSnapshotPageMain.toString() + ')()';
export default pageScriptSource;
