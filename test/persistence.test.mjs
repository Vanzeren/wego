// Unit tests for persistence flush (debounced writes must survive app quit).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPersistence } from '../src/browser/persistence.js';

test('flush writes pending debounced saves synchronously and cancels timers', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wego-persist-'));
  try {
    const p = createPersistence({ stateDir });
    p.saveSettings({ uiZoom: 1.2, pageZoomLevel: 1 });
    p.scheduleSpacesSave({ serializeState: () => ({ spaces: [{ id: 1 }] }) });
    p.flush();
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, 'settings.json'), 'utf8')), {
      uiZoom: 1.2,
      pageZoomLevel: 1,
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, 'spaces.json'), 'utf8')), {
      spaces: [{ id: 1 }],
    });
    // Timers were cancelled: a second flush is a no-op, nothing throws.
    p.flush();
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('flush with nothing pending is a no-op', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wego-persist-'));
  try {
    const p = createPersistence({ stateDir });
    p.flush();
    assert.deepEqual(fs.readdirSync(stateDir), []);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
