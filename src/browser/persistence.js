// Persistence: settings.json and spaces.json file IO, debounced atomic writes.
// Pure filesystem + timers; no electron imports (unit-testable).
import fs from 'node:fs';
import path from 'node:path';

export function createPersistence({ stateDir } = {}) {
  const settingsFile = stateDir ? path.join(stateDir, 'settings.json') : null;
  const spacesFile = stateDir ? path.join(stateDir, 'spaces.json') : null;

  function loadSettings(defaults) {
    try { return { ...defaults, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; }
    catch { return { ...defaults }; }
  }

  function atomicWrite(file, text) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file); // atomic replace
  }

  let settingsTimer = null;
  let pendingSettings = null;
  function saveSettings(settings) {
    if (!settingsFile) return;
    pendingSettings = settings;
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => {
      settingsTimer = null;
      try { atomicWrite(settingsFile, JSON.stringify(pendingSettings)); } catch { /* not writable */ }
      pendingSettings = null;
    }, 400);
  }

  let spacesTimer = null;
  let pendingSpaces = null;
  function scheduleSpacesSave(spaces) {
    if (!spacesFile) return;
    pendingSpaces = spaces;
    clearTimeout(spacesTimer);
    spacesTimer = setTimeout(() => {
      spacesTimer = null;
      try { atomicWrite(spacesFile, JSON.stringify(pendingSpaces.serializeState())); } catch { /* not writable */ }
      pendingSpaces = null;
    }, 500);
  }

  // Immediately perform any pending debounced writes synchronously and cancel
  // the timers. Called on app quit so the last edits are not lost.
  function flush() {
    clearTimeout(settingsTimer);
    settingsTimer = null;
    clearTimeout(spacesTimer);
    spacesTimer = null;
    if (settingsFile && pendingSettings) {
      try { atomicWrite(settingsFile, JSON.stringify(pendingSettings)); } catch { /* not writable */ }
      pendingSettings = null;
    }
    if (spacesFile && pendingSpaces) {
      try { atomicWrite(spacesFile, JSON.stringify(pendingSpaces.serializeState())); } catch { /* not writable */ }
      pendingSpaces = null;
    }
  }

  function loadSpaces() {
    if (!spacesFile) return null;
    try { return JSON.parse(fs.readFileSync(spacesFile, 'utf8')); }
    catch { return null; } // missing/corrupt: caller starts fresh
  }

  return { loadSettings, saveSettings, scheduleSpacesSave, loadSpaces, flush };
}
