// Unit tests for action receipt timing (quiet-period early exit).
import test from 'node:test';
import assert from 'node:assert/strict';

import { Page } from '../src/runtime/page.js';

function barePage() {
  const p = Object.create(Page.prototype);
  p._popups = [];
  p._dialog = null;
  return p;
}

test('quiet receipt resolves well under the old 500ms ceiling', async () => {
  const p = barePage();
  const t0 = Date.now();
  const receipt = await p._receipt();
  const elapsed = Date.now() - t0;
  assert.equal(receipt.ok, true);
  assert.equal(receipt.popups, undefined);
  assert.ok(elapsed < 300, `expected early exit, took ${elapsed}ms`);
  assert.ok(elapsed >= 100, `quiet window should still be observed, took ${elapsed}ms`);
});

test('receipt returns immediately when a dialog is already open', async () => {
  const p = barePage();
  p._dialog = { type: 'alert', message: 'hi' };
  const t0 = Date.now();
  const receipt = await p._receipt();
  assert.ok(Date.now() - t0 < 120);
  assert.deepEqual(receipt.dialog, { type: 'alert', message: 'hi' });
});

test('receipt catches a popup that arrives inside the quiet window', async () => {
  const p = barePage();
  setTimeout(() => p._popups.push({ label: 'p2', targetId: 'T' }), 60);
  const receipt = await p._receipt();
  assert.deepEqual(receipt.popups, [{ label: 'p2', targetId: 'T' }]);
});
