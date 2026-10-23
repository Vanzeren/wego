import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

app.setName('wego');

// One-time migration from the ego-lite era: carry state (spaces, profiles,
// settings, cookies/partitions) over to the wego locations.
function migrateDir(from, to) {
  try {
    if (!fs.existsSync(to) && fs.existsSync(from)) fs.renameSync(from, to);
  } catch { /* keep both; new dir will be created fresh */ }
}
migrateDir(path.join(os.homedir(), '.ego-lite'), path.join(os.homedir(), '.wego'));
migrateDir(path.join(app.getPath('appData'), 'ego-lite'), path.join(app.getPath('appData'), 'wego'));
// No TCP DevTools endpoint: raw CDP tunnels over the authenticated bridge
// socket (cdp-server.js VirtualCdpServer). WEGO_DEBUG_PORT is a dev-only escape
// hatch that re-enables Chromium's UNAUTHENTICATED 127.0.0.1 debug server —
// never set it on shared machines.
if (process.env.WEGO_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.WEGO_DEBUG_PORT);
}

const gotLock = app.requestSingleInstanceLock();
let windowApi = null;
let bridgeHandle = null;

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => windowApi?.focus());
  app.whenReady().then(start).catch((e) => {
    console.error('wego failed to start:', e);
    app.exit(1);
  });
}

async function start() {
  const egoDir = path.join(os.homedir(), '.wego');
  fs.mkdirSync(egoDir, { recursive: true });
  fs.chmodSync(egoDir, 0o700);

  if (!process.env.WEGO_DEBUG_PORT) {
    // Drop the stale file from older versions so nothing probes a dead port.
    try { fs.unlinkSync(path.join(app.getPath('userData'), 'DevToolsActivePort')); } catch { /* absent */ }
  }

  const { createMainWindow } = await import('./window.js');
  const { startBridgeServer } = await import('./bridge.js');

  windowApi = createMainWindow({ stateDir: egoDir });
  bridgeHandle = await startBridgeServer({
    spaces: windowApi.spaces,
    windowApi,
    cdpServer: windowApi.cdpServer,
  });

  app.on('will-quit', () => {
    windowApi?.flushPersistence?.(); // sync-write pending settings/spaces before exit
    bridgeHandle?.close();
  });
}
