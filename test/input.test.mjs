// Unit tests for keyboard/mouse input mapping (no browser needed).
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseKeySpec, pressKey, typeText, mouseEvent } from '../src/runtime/input.js';

function recorder() {
  const calls = [];
  return { calls, send: async (method, params) => { calls.push({ method, params }); return {}; } };
}

test('parseKeySpec: single printable char', () => {
  const d = parseKeySpec('a');
  assert.equal(d.main.key, 'a');
  assert.equal(d.main.code, 'KeyA');
  assert.equal(d.main.text, 'a');
  assert.equal(d.modifiers, 0);
});

test('parseKeySpec: named keys with text', () => {
  assert.equal(parseKeySpec('Enter').main.text, '\r');
  assert.equal(parseKeySpec('Tab').main.vk, 9);
  assert.equal(parseKeySpec('F5').main.vk, 116);
  assert.equal(parseKeySpec('Escape').main.text, undefined);
});

test('parseKeySpec: ControlOrMeta resolves to Control on Linux', () => {
  const d = parseKeySpec('ControlOrMeta+a');
  assert.equal(d.modifiers, 2); // Control bit
  assert.equal(d.main.key, 'a');
  assert.equal(d.main.text, undefined); // chords never insert text
});

test('parseKeySpec: Shift+letter uppercases the inserted text', () => {
  const d = parseKeySpec('Shift+a');
  assert.equal(d.modifiers, 8);
  assert.equal(d.main.text, 'A');
});

test('parseKeySpec: non-modifier in chord position and unknown keys are rejected', () => {
  assert.throws(() => parseKeySpec('a+b'), /Non-modifier key/);
  assert.throws(() => parseKeySpec('DefinitelyNotAKey'), /Unknown key/);
  assert.throws(() => parseKeySpec(''), /non-empty/);
});

test('pressKey dispatches keyDown then keyUp with modifiers', async () => {
  const s = recorder();
  await pressKey(s, 'Control+c');
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[0].method, 'Input.dispatchKeyEvent');
  assert.equal(s.calls[0].params.type, 'rawKeyDown'); // no text on chords
  assert.equal(s.calls[1].params.type, 'keyUp');
  assert.equal(s.calls[0].params.modifiers, 2);
});

test('pressKey on printable char uses keyDown with text', async () => {
  const s = recorder();
  await pressKey(s, 'x');
  assert.equal(s.calls[0].params.type, 'keyDown');
  assert.equal(s.calls[0].params.text, 'x');
});

test('typeText presses every character', async () => {
  const s = recorder();
  await typeText(s, 'abc');
  const keys = s.calls.filter((c) => c.params.type === 'keyDown').map((c) => c.params.key);
  assert.deepEqual(keys, ['a', 'b', 'c']);
});

test('mouseEvent sends CDP params with defaults', async () => {
  const s = recorder();
  await mouseEvent(s, 'mousePressed', 10, 20, { button: 'left', buttons: 1, clickCount: 2 });
  assert.deepEqual(s.calls[0].params, {
    type: 'mousePressed', x: 10, y: 20, button: 'left', buttons: 1, clickCount: 2,
  });
  await mouseEvent(s, 'mouseWheel', 0, 0, { deltaX: 5, deltaY: -10 });
  assert.equal(s.calls[1].params.deltaY, -10);
  assert.equal(s.calls[1].params.button, 'none');
});
