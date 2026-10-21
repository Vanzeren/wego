import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

app.setName('ego-lite');
// Chromium picks a free port; the chosen port/ws path land in DevToolsActivePort.
app.commandLine.appendSwitch('remote-debugging-port', '0');

const gotLock = app.requestSingleInstanceLock();
let windowApi = null;
let bridgeHandle = null;

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => windowApi?.focus());
  app.whenReady().then(start).catch((e) => {
    console.error('ego-lite failed to start:', e);
    app.exit(1);
  });
}

async function start() {
  const egoDir = path.join(os.homedir(), '.ego-lite');
  fs.mkdirSync(egoDir, { recursive: true });
  fs.chmodSync(egoDir, 0o700);

  const cdp = readCdpEndpoint();

  const { createMainWindow } = await import('./window.js');
  const { startBridgeServer } = await import('./bridge.js');

  windowApi = createMainWindow({ httpEndpoint: cdp.httpEndpoint });
  bridgeHandle = await startBridgeServer({ spaces: windowApi.spaces, windowApi, cdp });

  app.on('will-quit', () => bridgeHandle?.close());
}

function readCdpEndpoint() {
  const file = path.join(app.getPath('userData'), 'DevToolsActivePort');
  const deadline = Date.now() + 10_000;
  const waitBuf = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      const [port, wsPath] = fs.readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
      if (port && wsPath) {
        return {
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}${wsPath}`,
          httpEndpoint: `http://127.0.0.1:${port}`,
        };
      }
    } catch { /* not written yet */ }
    if (Date.now() > deadline) throw new Error(`DevToolsActivePort not found at ${file}`);
    Atomics.wait(waitBuf, 0, 0, 50);
  }
}
