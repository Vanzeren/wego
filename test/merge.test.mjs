// Unit tests for the OOPIF subtree merge helper.
import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeFrameCapture, tagFrameRefs } from '../src/browser/snapshot/merge.js';

const PARENT = [
  '- generic',
  '  - heading "Host"',
  '  - iframe "Remote" [ref=12]',
  '  - button "After" [ref=13]',
].join('\n');

const SUB = [
  '- generic',
  '  - text "Inside frame"',
  '  - button "Frame button" [ref=100001]',
].join('\n');

test('subtree lines insert right after the iframe line, one level deeper', () => {
  const out = mergeFrameCapture(PARENT, 12, SUB);
  assert.deepEqual(out.split('\n'), [
    '- generic',
    '  - heading "Host"',
    '  - iframe "Remote" [ref=12]',
    '    - generic',
    '      - text "Inside frame"',
    '      - button "Frame button" [ref=100001]',
    '  - button "After" [ref=13]',
  ]);
});

test('missing iframe ref leaves content unchanged', () => {
  assert.equal(mergeFrameCapture(PARENT, 99, SUB), PARENT);
});

test('deeply nested iframe line indents relative to its own depth', () => {
  const nested = '- generic\n      - iframe "Deep" [ref=5]\n  - text "tail"';
  const out = mergeFrameCapture(nested, 5, '- button "b" [ref=200001]');
  assert.deepEqual(out.split('\n'), [
    '- generic',
    '      - iframe "Deep" [ref=5]',
    '        - button "b" [ref=200001]',
    '  - text "tail"',
  ]);
});

test('tagFrameRefs adds frameId without mutating entries', () => {
  const refs = [{ refId: 100001, role: 'button', name: 'X' }];
  const tagged = tagFrameRefs(refs, 'FRAME-1');
  assert.equal(tagged[0].frameId, 'FRAME-1');
  assert.equal(refs[0].frameId, undefined);
});
