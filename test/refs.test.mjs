// Unit tests for the per-Page ref ledger (refs.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import { ElementResolutionError, ledgerFor, populate, lookup, parseRefTarget, resolve } from '../src/runtime/refs.js';

test('parseRefTarget accepts @N, ref=N and integers', () => {
  assert.equal(parseRefTarget('@12'), 12);
  assert.equal(parseRefTarget('ref=7'), 7);
  assert.equal(parseRefTarget(' @3 '), 3);
  assert.equal(parseRefTarget(9), 9);
  assert.equal(parseRefTarget('css=div'), null);
  assert.equal(parseRefTarget('@x'), null);
  assert.equal(parseRefTarget(null), null);
});

test('populate full-page replaces the ledger; partial merges by refId', () => {
  const page = {};
  populate(page, [{ refId: 1, role: 'button', name: 'A' }, { refId: 2, role: 'link', name: 'B' }]);
  assert.equal(lookup(page, 2).name, 'B');
  populate(page, [{ refId: 2, role: 'link', name: 'B2' }, { refId: 3, role: 'textbox', name: 'C' }], { fullPage: false });
  assert.ok(lookup(page, 1)); // kept on merge
  assert.equal(lookup(page, 2).name, 'B2'); // updated
  populate(page, [{ refId: 9, role: 'button', name: 'Z' }]); // full page: replace
  assert.equal(lookup(page, 1), null);
  assert.equal(lookup(page, 9).name, 'Z');
});

test('resolve rejects refs that are not in the ledger', async () => {
  const page = {};
  await assert.rejects(
    () => resolve(page, '@5'),
    (e) => e instanceof ElementResolutionError && e.kind === 'stale' && /latest snapshot/.test(e.message),
  );
});

test('resolve returns null for non-ref targets (selector path handles those)', async () => {
  const page = {};
  assert.equal(await resolve(page, 'css=div'), null);
});

test('resolve maps a live registry element to { objectId, session }; null means stale', async () => {
  const fakeSession = {
    send: async (method, params) => {
      assert.equal(method, 'Runtime.evaluate');
      assert.match(params.expression, /__wegoSnapshot\.getRefElement\(4\)/);
      assert.equal(params.returnByValue, false);
      return { result: { objectId: 'obj-4' } };
    },
  };
  const withElement = { _session: async () => fakeSession };
  populate(withElement, [{ refId: 4, role: 'button', name: 'Go' }]);
  assert.deepEqual(await resolve(withElement, '@4'), { objectId: 'obj-4', session: fakeSession });

  const gone = {
    _session: async () => ({ send: async () => ({ result: { subtype: 'null' } }) }),
  };
  populate(gone, [{ refId: 4, role: 'button', name: 'Go' }]);
  await assert.rejects(() => resolve(gone, '@4'), (e) => e.kind === 'stale' && /stale/.test(e.message));
});

test('frameId refs resolve on a session attached to the frame target', async () => {
  const frameSession = { send: async () => ({ result: { objectId: 'obj-frame' } }) };
  const attached = [];
  const page = {
    _session: async () => { throw new Error('must not use page session for OOPIF refs'); },
    _ctx: () => ({ cdp: { attach: async (targetId) => { attached.push(targetId); return frameSession; } } }),
  };
  populate(page, [{ refId: 100042, role: 'button', name: 'Frame button', frameId: 'FRAME-TARGET-1' }]);
  const out = await resolve(page, '@100042');
  assert.deepEqual(attached, ['FRAME-TARGET-1']);
  assert.deepEqual(out, { objectId: 'obj-frame', session: frameSession });
});
