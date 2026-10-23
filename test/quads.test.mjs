// Unit tests for the quad union helper (inline elements fragment boxes).
import test from 'node:test';
import assert from 'node:assert/strict';

import { quadUnionBox } from '../src/runtime/page.js';

test('quadUnionBox unions multiple inline fragments', () => {
  // first fragment is a zero-width child box, second is the real box
  const quads = [
    [359, 189, 359, 189, 359, 189, 359, 189],
    [359, 174, 379, 174, 379, 192, 359, 192],
  ];
  const box = quadUnionBox(quads);
  assert.equal(Math.round(box.width), 20);
  assert.equal(Math.round(box.height), 18);
  assert.ok(box.cx > 359 && box.cx < 379);
});

test('quadUnionBox single quad passthrough', () => {
  const box = quadUnionBox([[10, 10, 50, 10, 50, 30, 10, 30]]);
  assert.equal(box.width, 40);
  assert.equal(box.height, 20);
  assert.equal(box.cx, 30);
  assert.equal(box.cy, 20);
});

test('quadUnionBox zero-area stays zero (guard still fires)', () => {
  const box = quadUnionBox([[5, 5, 5, 5, 5, 5, 5, 5]]);
  assert.equal(box.width, 0);
  assert.equal(box.height, 0);
});
