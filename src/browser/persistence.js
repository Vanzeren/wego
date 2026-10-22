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
  function saveSettings(settings) {
    if (!settingsFile) return;
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => {
      try { atomicWrite(settingsFile, JSON.stringify(settings)); } catch { /* not writable */ }
    }, 400);
  }

  let spacesTimer = null;
  function scheduleSpacesSave(spaces) {
    if (!spacesFile) return;
    clearTimeout(spacesTimer);
    spacesTimer = setTimeout(() => {
      try { atomicWrite(spacesFile, JSON.stringify(spaces.serializeState())); } catch { /* not writable */ }
    }, 500);
  }

  function loadSpaces() {
    if (!spacesFile) return null;
    try { return JSON.parse(fs.readFileSync(spacesFile, 'utf8')); }
    catch { return null; } // missing/corrupt: caller starts fresh
  }

  return { loadSettings, saveSettings, scheduleSpacesSave, loadSpaces };
}
