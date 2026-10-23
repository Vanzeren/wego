// Resolver behavior tests: run the actual injected resolver source
// (RESOLVER_FN from src/runtime/selectors.js) against a tiny hand-rolled
// fake DOM — no browser, no deps.
import test from 'node:test';
import assert from 'node:assert/strict';

import { __testing } from '../src/runtime/selectors.js';

// --- tiny fake DOM -----------------------------------------------------------

function descendants(root) {
  const out = [];
  const visit = (n) => { for (const c of n.children) { out.push(c); visit(c); } };
  visit(root);
  return out;
}

function matchOne(el, sel) {
  let rest = sel.trim();
  const mTag = /^[a-zA-Z][\w-]*/.exec(rest);
  if (mTag) {
    if (el.tagName !== mTag[0].toUpperCase()) return false;
    rest = rest.slice(mTag[0].length);
  }
  while (rest) {
    let m;
    if ((m = /^\.([\w-]+)/.exec(rest))) {
      if (!(el.getAttribute('class') || '').split(/\s+/).includes(m[1])) return false;
    } else if ((m = /^#([\w-]+)/.exec(rest))) {
      if (el.getAttribute('id') !== m[1]) return false;
    } else if ((m = /^\[([\w-]+)(?:="([^"]*)")?\]/.exec(rest))) {
      if (!el.hasAttribute(m[1])) return false;
      if (m[2] !== undefined && el.getAttribute(m[1]) !== m[2]) return false;
    } else return false;
    rest = rest.slice(m[0].length);
  }
  return true;
}

class FakeEl {
  constructor(tag, attrs = {}, text = '') {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.text = text;
    this.children = [];
    this.parentElement = null;
    this.shadowRoot = null;
    this.ownerDocument = null;
    this.rootNode = null; // set during doc assignment
    this.rect = { width: 10, height: 10 };
    this.style = { visibility: 'visible', display: 'block' };
    this.disabled = false;
  }
  append(child) { child.parentElement = this; this.children.push(child); return child; }
  attachShadow() {
    this.shadowRoot = { nodeType: 11, host: this, children: [], ownerDocument: null, parentElement: null };
    return this.shadowRoot;
  }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  hasAttribute(n) { return n in this.attrs; }
  get textContent() {
    return [this.text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ').trim();
  }
  matches(sel) { return sel.split(',').some((s) => matchOne(this, s)); }
  contains(o) { return descendants(this).includes(o); }
  getBoundingClientRect() { return this.rect; }
  getRootNode() { return this.rootNode || this.ownerDocument; }
}

class FakeDoc {
  constructor(root) {
    this.nodeType = 9;
    this.root = root;
    this.defaultView = { getComputedStyle: (el) => el.style };
    const assign = (node, rootNode) => {
      for (const c of node.children) {
        c.ownerDocument = this;
        c.rootNode = rootNode;
        if (c.shadowRoot) { c.shadowRoot.ownerDocument = this; assign(c.shadowRoot, c.shadowRoot); }
        assign(c, rootNode);
      }
    };
    assign(root, this);
  }
  get children() { return [this.root]; } // so descendants(doc) works
  createTreeWalker(root) {
    const it = descendants(root)[Symbol.iterator]();
    return { nextNode() { const r = it.next(); return r.done ? null : r.value; } };
  }
  querySelectorAll(sel) { return descendants(this.root).filter((el) => el.matches(sel)); }
  getElementById(id) { return descendants(this.root).find((el) => el.getAttribute('id') === id) || null; }
}

// --- fixture + resolver harness ----------------------------------------------

const resolve = eval('(' + __testing.RESOLVER_FN + ')');

function buildDom() {
  const root = new FakeEl('div', { id: 'root' });
  const save = root.append(new FakeEl('button', { class: 'btn' }, 'Save'));
  const cancel = root.append(new FakeEl('button', { class: 'btn' }, 'Cancel'));
  const hello = root.append(new FakeEl('span', {}, 'Hello World'));
  const link = root.append(new FakeEl('a', { href: '/more' }));
  const zeroSpan = link.append(new FakeEl('span', {}, 'Read more'));
  zeroSpan.rect = { width: 0, height: 0 }; // zero-area text carrier
  const itemA = root.append(new FakeEl('div', { class: 'item' }, 'first'));
  const itemB = root.append(new FakeEl('div', { class: 'item' }, 'second'));
  const host = root.append(new FakeEl('div', { class: 'host' }));
  const shadowBtn = new FakeEl('button', { class: 'shadowbtn' }, 'Shadow Action');
  host.attachShadow().children.push(shadowBtn);
  shadowBtn.parentElement = null; // shadow children have no light-DOM parent
  const doc = new FakeDoc(root);
  return { doc, root, save, cancel, hello, link, zeroSpan, itemA, itemB, host, shadowBtn };
}

function withDom(t) {
  const dom = buildDom();
  globalThis.document = dom.doc;
  globalThis.NodeFilter = { SHOW_ELEMENT: 4 };
  t.after(() => { delete globalThis.document; delete globalThis.NodeFilter; });
  return dom;
}

// --- tests -------------------------------------------------------------------

test('css match resolves a unique element', (t) => {
  const { shadowBtn } = withDom(t);
  const out = resolve('.shadowbtn');
  assert.equal(out.count, 1);
  assert.equal(out.element, shadowBtn);
  assert.equal(out.visible, true);
  assert.equal(out.disabled, false);
});

test('css ambiguity reports count > 1; nth=-1 picks the last', (t) => {
  const { save, cancel } = withDom(t);
  assert.equal(resolve('.btn').count, 2);
  assert.equal(resolve('.btn >> nth=-1').element, cancel);
  assert.equal(resolve('.btn >> nth=0').element, save);
  assert.equal(resolve('.item >> nth=5').count, 0); // out of range nth
});

test('text= substring is case-insensitive and keeps deepest match', (t) => {
  const { hello } = withDom(t);
  const out = resolve('text=hello');
  assert.equal(out.count, 1);
  assert.equal(out.element, hello);
});

test('text="..." is exact and case-sensitive', (t) => {
  const { hello } = withDom(t);
  assert.equal(resolve('text="Hello World"').element, hello);
  assert.equal(resolve('text="hello world"').count, 0);
  assert.equal(resolve('text="Hello"').count, 0);
});

test('loc=role:button[name=X] exact and [name*=X] substring', (t) => {
  const { save } = withDom(t);
  assert.equal(resolve('loc=role:button[name=Save]').element, save);
  assert.equal(resolve('loc=role:button[name*=Sav]').element, save);
  assert.equal(resolve('loc=role:button[name=save]').count, 0); // exact is case-sensitive
  assert.equal(resolve('loc=role:button').count, 3); // save + cancel + shadow button
});

test('shadow-root piercing finds elements inside open shadow roots', (t) => {
  const { shadowBtn } = withDom(t);
  assert.equal(resolve('loc=role:button[name="Shadow Action"]').element, shadowBtn);
});

test('zero-area match climbs to visible interactive ancestor', (t) => {
  const { link } = withDom(t);
  const out = resolve('text=Read more');
  assert.equal(out.count, 1);
  assert.equal(out.element, link); // climbed from the invisible span to <a href>
  assert.equal(out.visible, true);
});

test('no match returns count 0', (t) => {
  withDom(t);
  assert.equal(resolve('.missing').count, 0);
  assert.equal(resolve('text=nothing here').count, 0);
  assert.equal(resolve('loc=role:checkbox').count, 0);
});
