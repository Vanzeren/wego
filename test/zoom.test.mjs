// Unit tests for zoom ladder and shortcut parsing.
import test from 'node:test';
import assert from 'node:assert/strict';

import { nextZoom, nextZoomLevel, zoomFromKey, ZOOM_MIN, ZOOM_MAX, LEVEL_MIN, LEVEL_MAX } from '../src/browser/zoom.js';
import { createSettings } from '../src/browser/settings.js';

test('nextZoom steps in/out and resets', () => {
  assert.equal(nextZoom(1, 1), 1.1);
  assert.equal(nextZoom(1.1, 1), 1.21);
  assert.equal(nextZoom(1.1, -1), 1);
  assert.equal(nextZoom(2.5, 0), 1); // reset
});

test('nextZoom clamps to bounds', () => {
  assert.equal(nextZoom(ZOOM_MAX, 1), ZOOM_MAX);
  assert.equal(nextZoom(ZOOM_MIN, -1), ZOOM_MIN);
  let z = 1;
  for (let i = 0; i < 50; i++) z = nextZoom(z, -1);
  assert.equal(z, ZOOM_MIN);
  for (let i = 0; i < 50; i++) z = nextZoom(z, 1);
  assert.equal(z, ZOOM_MAX);
});

test('zoomFromKey: plain Ctrl is page scope, Ctrl+Shift is ui scope', () => {
  const base = { type: 'keyDown', control: true, shift: false, alt: false, meta: false };
  assert.deepEqual(zoomFromKey({ ...base, key: '=' }), { scope: 'page', dir: 1 });
  assert.deepEqual(zoomFromKey({ ...base, key: '-' }), { scope: 'page', dir: -1 });
  assert.deepEqual(zoomFromKey({ ...base, key: '0' }), { scope: 'page', dir: 0 });
  assert.deepEqual(zoomFromKey({ ...base, shift: true, key: '+' }), { scope: 'ui', dir: 1 });
  assert.deepEqual(zoomFromKey({ ...base, shift: true, key: '_' }), { scope: 'ui', dir: -1 });
});

test('zoomFromKey ignores non-zoom input', () => {
  assert.equal(zoomFromKey({ type: 'keyDown', control: true, key: 'a' }), null);
  assert.equal(zoomFromKey({ type: 'keyUp', control: true, key: '=' }), null);
  assert.equal(zoomFromKey({ type: 'keyDown', key: '=' }), null); // no ctrl
  assert.equal(zoomFromKey({ type: 'keyDown', control: true, alt: true, key: '=' }), null);
  assert.equal(zoomFromKey(null), null);
});

test('nextZoomLevel steps in 0.5 levels, resets to 0, clamps', () => {
  assert.equal(nextZoomLevel(0, 1), 0.5);
  assert.equal(nextZoomLevel(0.5, 1), 1);
  assert.equal(nextZoomLevel(0, -1), -0.5);
  assert.equal(nextZoomLevel(2, 0), 0);
  assert.equal(nextZoomLevel(LEVEL_MAX, 1), LEVEL_MAX);
  assert.equal(nextZoomLevel(LEVEL_MIN, -1), LEVEL_MIN);
});

test('every UI zoom ladder value is accepted by settings validation', () => {
  const settings = createSettings();
  let value = settings.get('uiZoom');
  for (let i = 0; i < 50; i++) {
    value = nextZoom(value, 1);
    settings.set('uiZoom', value);
  }
  assert.equal(value, ZOOM_MAX);
  for (let i = 0; i < 50; i++) {
    value = nextZoom(value, -1);
    settings.set('uiZoom', value);
  }
  assert.equal(value, ZOOM_MIN);
});
