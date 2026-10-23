// Round-trip tests for the canonical role table in src/shared/roles.js.
// Guards both behavior and embed-safety of computeRoleSource, plus the two
// embedding sites (selectors.js resolver, page-script.js snapshot program).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeRole, computeRoleSource } from '../src/shared/roles.js';

// Minimal element stub matching the surface computeRole touches.
function stub(tag, attrs = {}, { multiple = false } = {}) {
  return {
    tagName: tag.toUpperCase(),
    multiple,
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    hasAttribute: (n) => n in attrs,
  };
}

const CASES = [
  ['th', {}, {}, 'columnheader'],
  ['td', {}, {}, 'cell'],
  ['input', { type: 'number' }, {}, 'spinbutton'],
  ['input', { type: 'image' }, {}, 'button'],
  ['input', {}, {}, 'textbox'],
  ['select', {}, { multiple: true }, 'listbox'],
  ['select', {}, {}, 'combobox'],
  ['select', { size: '3' }, {}, 'listbox'],
  ['a', { href: 'https://example.test/' }, {}, 'link'],
  ['a', {}, {}, 'generic'],
  ['div', { role: 'Navigation' }, {}, 'navigation'], // explicit role wins, lowercased
  ['marquee', {}, {}, 'generic'],
];

test('computeRole covers the ARIA-aligned table', () => {
  for (const [tag, attrs, opts, expected] of CASES) {
    assert.equal(computeRole(stub(tag, attrs, opts)), expected, `${tag} ${JSON.stringify(attrs)}`);
  }
});

test('computeRoleSource is String.raw/embed safe (no ${ or backticks)', () => {
  assert.ok(!computeRoleSource.includes('${'), 'source must not contain ${');
  assert.ok(!computeRoleSource.includes('`'), 'source must not contain backticks');
});

test('eval of computeRoleSource behaves identically to computeRole', () => {
  const revived = eval('(' + computeRoleSource + ')');
  assert.equal(typeof revived, 'function');
  for (const [tag, attrs, opts] of CASES) {
    const el = stub(tag, attrs, opts);
    assert.equal(revived(el), computeRole(el), `${tag} ${JSON.stringify(attrs)}`);
  }
});

test('embedding sites keep the computeRoleSource contract (drift guard)', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const selectorsSrc = fs.readFileSync(path.join(root, 'src/runtime/selectors.js'), 'utf8');
  const pageScriptSrc = fs.readFileSync(path.join(root, 'src/browser/snapshot/page-script.js'), 'utf8');
  assert.ok(selectorsSrc.includes('${computeRoleSource}'),
    'selectors.js must interpolate computeRoleSource into RESOLVER_FN');
  assert.ok(/import\s*\{\s*computeRoleSource\s*\}/.test(pageScriptSrc),
    'page-script.js must import computeRoleSource');
  assert.ok(pageScriptSrc.includes('__WEGO_COMPUTE_ROLE__'),
    'page-script.js must substitute __WEGO_COMPUTE_ROLE__');
});
