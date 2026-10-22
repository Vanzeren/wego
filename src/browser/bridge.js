import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function err(code, message) {
  const e = new Error(message);
  e.error_code = code;
  return e;
}

function bad(message) {
  return err('EGO_INVALID_ARGUMENT', message);
}

function reqId(params) {
  if (!params || typeof params.id !== 'number' || !Number.isInteger(params.id) || params.id < 1) {
    throw bad('id must be a positive integer');
  }
  return params.id;
}

function reqString(params, key) {
  const v = params?.[key];
  if (typeof v !== 'string' || !v.trim()) throw bad(`${key} must be a non-empty string`);
  return v;
}

function optString(params, key) {
  const v = params?.[key];
  if (v !== undefined && typeof v !== 'string') throw bad(`${key} must be a string`);
  return v;
}

const SNAPSHOT_SCOPES = new Set(['full_page', 'only_within_viewport', 'subtree']);

function validateSnapshotOptions(options) {
  if (options === undefined || options === null) return {};
  if (typeof options !== 'object' || Array.isArray(options)) throw bad('options must be an object');
  const { scope, root, rootFrameId, interactiveOnly, includeActionMarks, includeStableLocator, maxResultLength } = options;
  if (scope !== undefined && !SNAPSHOT_SCOPES.has(scope)) {
    throw bad(`options.scope must be one of: ${[...SNAPSHOT_SCOPES].join(', ')}`);
  }
  if (root !== undefined && (typeof root !== 'number' || !Number.isInteger(root))) throw bad('options.root must be an integer');
  if (rootFrameId !== undefined && typeof rootFrameId !== 'string') throw bad('options.rootFrameId must be a string');
  if (rootFrameId !== undefined && scope !== 'subtree') throw bad('options.rootFrameId requires scope "subtree"');
  if (scope === 'subtree' && root === undefined) throw bad('options.root is required when scope is "subtree"');
  for (const [k, v] of [['interactiveOnly', interactiveOnly], ['includeActionMarks', includeActionMarks], ['includeStableLocator', includeStableLocator]]) {
    if (v !== undefined && typeof v !== 'boolean') throw bad(`options.${k} must be a boolean`);
  }
  if (maxResultLength !== undefined && (typeof maxResultLength !== 'number' || maxResultLength < 0)) {
    throw bad('options.maxResultLength must be a non-negative number');
  }
  return options;
}

// NDJSON JSON-RPC server on the bridge Unix socket. See docs/protocol.md.
export async function startBridgeServer({ spaces, windowApi, cdp }) {
  let captureSnapshot = null;
  let clipboard = null;
  try {
    const engine = await import('./snapshot/index.js');
    captureSnapshot = engine.captureSnapshot;
    engine.configureSnapshot({ webSocketDebuggerUrl: cdp.webSocketDebuggerUrl });
  } catch {
    captureSnapshot = null; // snapshot engine slice not present
  }
  try {
    ({ clipboard } = await import('electron'));
  } catch {
    clipboard = null; // unit tests without electron: paste reports unavailable
  }

  const sockPath = process.env.EGO_BRIDGE_SOCK || path.join(os.homedir(), '.ego-lite', 'bridge.sock');
  const stateDir = path.dirname(sockPath);
  fs.mkdirSync(stateDir, { recursive: true });
  try { fs.unlinkSync(sockPath); } catch { /* no stale socket */ }

  // Profile registry: Default always exists; extra profiles persist here and
  // map to Electron session partitions persist:profile-<id> (see window.js).
  const profilesFile = path.join(stateDir, 'profiles.json');
  const profiles = (() => {
    try {
      const list = JSON.parse(fs.readFileSync(profilesFile, 'utf8'));
      if (Array.isArray(list) && list.some((p) => p.id === 'Default')) return list;
    } catch { /* first run or corrupt */ }
    return [{ id: 'Default', name: 'Default' }];
  })();
  let nextProfileNum = profiles.length;
  const saveProfiles = () => fs.writeFileSync(profilesFile, JSON.stringify(profiles, null, 2), { mode: 0o600 });
  saveProfiles();

  const clients = new Set();

  function broadcast(obj) {
    const line = `${JSON.stringify(obj)}\n`;
    for (const c of clients) c.write(line);
  }

  // Chatty pages fire spaceChanged per navigation/title update; coalesce
  // pushes per space within a short window. taskState stays immediate.
  const PUSH_DEBOUNCE_MS = 30;
  const pendingSpaces = new Set();
  let pushTimer = null;
  spaces.on('spaceChanged', (spaceId) => {
    pendingSpaces.add(spaceId);
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      for (const id of pendingSpaces) broadcast({ event: 'spaceChanged', spaceId: id });
      pendingSpaces.clear();
    }, PUSH_DEBOUNCE_MS);
  });
  spaces.on('taskState', (spaceId, state) => broadcast({ event: 'taskState', spaceId, state }));

  const dispatch = {
    ping: () => 'pong',

    getBrowserVersion: () => ({
      currentVersion: '0.1.0',
      updateAvailable: false,
      cdpEndpoint: cdp.webSocketDebuggerUrl,
    }),

    listProfiles: () => ({
      profiles: profiles.map((p) => ({ id: p.id, name: p.name, isDefault: p.id === 'Default' })),
    }),

    // Extension beyond the ego native API: profiles are created via CLI/UI,
    // not by agents through ego.* bindings.
    createProfile: (params) => {
      const name = reqString(params, 'name');
      const profile = { id: `Profile ${++nextProfileNum}`, name };
      profiles.push(profile);
      saveProfiles();
      return { id: profile.id, name: profile.name };
    },

    // Import cookies from desktop Chrome into an ego profile's session.
    // Decryption uses the libsecret/KWallet keyring; see chrome-import.js.
    // params: { profileId? = 'Default', chromeDir? = Chrome Default profile }
    importChromeCookies: async (params) => {
      const profileId = optString(params, 'profileId') ?? 'Default';
      const profile = profiles.find((p) => p.id === profileId);
      if (!profile) throw err('EGO_PROFILE_NOT_FOUND', `Profile not found: ${profileId}`);
      const chromeDir = optString(params, 'chromeDir');
      const { session } = await import('electron');
      const { importChromeCookieDescriptors } = await import('./chrome-import.js');
      const { partitionForProfile } = await import('./partitions.js');
      const { cookies, undecryptable, expired, total } = await importChromeCookieDescriptors(
        chromeDir ? { chromeDir } : {},
      );
      const ses = session.fromPartition(partitionForProfile(profile.id));
      let imported = 0;
      let failed = 0;
      for (const c of cookies) {
        try {
          await ses.cookies.set(c);
          imported++;
        } catch {
          failed++;
        }
      }
      return { imported, failed, undecryptable, expired, total, profileId: profile.id };
    },

    listTaskSpaces: () => spaces.listTaskSpaces(),

    createTaskSpace: (params) => {
      const name = reqString(params, 'name');
      const profileId = optString(params, 'profileId');
      if (profileId !== undefined && profileId !== 'default') {
        const profile = profiles.find((p) => p.id === profileId);
        if (!profile) throw err('EGO_PROFILE_NOT_FOUND', 'Profile not found');
        return spaces.createTaskSpace({ name, profileId: profile.id, profileName: profile.name });
      }
      return spaces.createTaskSpace({ name, profileName: 'Default' });
    },

    claimTaskSpace: (params) => {
      const id = reqId(params);
      const name = optString(params, 'name');
      return spaces.claimTaskSpace({ id, name });
    },

    closeTaskSpace: (params) => spaces.closeTaskSpace({ id: reqId(params) }),
    completeTaskSpace: (params) => spaces.completeTaskSpace({ id: reqId(params) }),
    handOffTaskSpace: (params) => spaces.handOffTaskSpace({ id: reqId(params) }),
    takeOverTaskSpace: (params) => spaces.takeOverTaskSpace({ id: reqId(params) }),

    setAgentTaskState: (params) => {
      const id = reqId(params);
      if (typeof params.state !== 'string') throw bad('state must be a string');
      return spaces.setAgentTaskState({ id, state: params.state });
    },

    animationHighlightMouseToPosition: (params) => {
      const id = reqId(params);
      if (typeof params.x !== 'number' || !Number.isFinite(params.x)) throw bad('x must be a number');
      if (typeof params.y !== 'number' || !Number.isFinite(params.y)) throw bad('y must be a number');
      const space = spaces.requireSpace(id);
      if (space.control !== 'agent') {
        throw err('EGO_TASK_SPACE_USER_IN_CONTROL', `Task space ${id} is under user control`);
      }
      // Best-effort: the protocol string resolves regardless of UI delivery.
      try { windowApi.sendHighlight({ x: params.x, y: params.y }); } catch { /* window gone */ }
      return `${id} mouse highlight shown.`;
    },

    createTab: async (params) => {
      const id = reqId(params);
      const url = reqString(params, 'url');
      const out = spaces.createTab(id, url);
      // Never leak the placeholder tab-N id: the SDK attaches CDP sessions
      // with this value, so it must be the real Chromium targetId.
      const targetId = await spaces.awaitTargetId(id, out.targetId);
      return { targetId, index: out.index };
    },

    listTabs: async (params) => {
      const id = reqId(params);
      await spaces.whenTabsReady(id);
      return spaces.listTabs(id);
    },

    closeTab: (params) => {
      const id = reqId(params);
      const targetId = reqString(params, 'targetId');
      return spaces.closeTab(id, targetId);
    },

    activateTab: (params) => {
      const id = reqId(params);
      const targetId = reqString(params, 'targetId');
      return spaces.activateTab(id, targetId);
    },

    snapshot: async (params) => {
      const id = reqId(params);
      const targetId = optString(params, 'targetId');
      const options = validateSnapshotOptions(params.options);
      const space = spaces.requireSpace(id);
      if (space.control !== 'agent') {
        throw err('EGO_TASK_SPACE_USER_IN_CONTROL', `Task space ${id} is under user control`);
      }
      const tab = targetId !== undefined
        ? space.tabs.find((t) => t.targetId === targetId)
        : space.tabs.find((t) => t.targetId === space.activeTargetId);
      const wc = tab?.view?.webContents;
      if (!wc || wc.isDestroyed()) {
        throw err('EGO_WEB_CONTENTS_UNAVAILABLE', `Web contents unavailable: ${targetId ?? `space ${id} has no active tab`}`);
      }
      if (!captureSnapshot) throw err('EGO_SNAPSHOT_FAILED', 'snapshot engine unavailable');
      // Real Chromium targetId enables OOPIF ownership checks in the engine.
      const realTargetId = await spaces.awaitTargetId(id, tab.targetId);
      return captureSnapshot(wc, options, { targetId: realTargetId, rootFrameId: options.rootFrameId });
    },

    // App-level zoom (same code path as the Ctrl/Ctrl+Shift +/- shortcuts).
    appZoom: (params) => {
      const scope = params?.scope;
      const dir = params?.dir;
      if (scope !== 'ui' && scope !== 'page') throw bad('scope must be "ui" or "page"');
      if (!Number.isInteger(dir) || dir < -1 || dir > 1) throw bad('dir must be -1, 0, or 1');
      const out = windowApi.applyZoom(scope, dir);
      if (!out) throw err('EGO_WEB_CONTENTS_UNAVAILABLE', 'no active tab');
      return out;
    },

    getCDPEndpoint: () => ({
      webSocketDebuggerUrl: cdp.webSocketDebuggerUrl,
      httpEndpoint: cdp.httpEndpoint,
    }),

    // Clipboard paste with restore (ego parity: native paste, then the user's
    // previous clipboard contents are put back). Browser-side because CDP
    // page sessions cannot write the system clipboard.
    paste: async (params) => {
      const id = reqId(params);
      const space = spaces.requireSpace(id);
      if (space.control !== 'agent') {
        throw err('EGO_TASK_SPACE_USER_IN_CONTROL', `Task space ${id} is under user control`);
      }
      if (params.text !== undefined && typeof params.text !== 'string') throw bad('text must be a string');
      if (params.html !== undefined && typeof params.html !== 'string') throw bad('html must be a string');
      if (params.text === undefined && params.html === undefined) throw bad('paste requires text or html');
      const targetId = optString(params, 'targetId');
      const tab = targetId !== undefined
        ? space.tabs.find((t) => t.targetId === targetId)
        : space.tabs.find((t) => t.targetId === space.activeTargetId);
      const wc = tab?.view?.webContents;
      if (!wc || wc.isDestroyed()) throw err('EGO_WEB_CONTENTS_UNAVAILABLE', 'Web contents unavailable');
      if (!clipboard) throw err('EGO_OPERATION_FAILED', 'clipboard unavailable');
      const prev = { text: clipboard.readText(), html: clipboard.readHTML() };
      clipboard.write({
        ...(params.text !== undefined ? { text: params.text } : {}),
        ...(params.html !== undefined ? { html: params.html } : {}),
      });
      try {
        wc.focus();
        wc.paste();
        await new Promise((r) => setTimeout(r, 80)); // let the paste land
      } finally {
        clipboard.write({ text: prev.text, html: prev.html });
      }
      return `${id} pasted.`;
    },
  };

  async function handleLine(socket, line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // unframed garbage: no id to reply to
    }
    const { id, method, params } = msg ?? {};
    if (id === undefined) return; // client push: ignore
    try {
      if (typeof method !== 'string' || !dispatch[method]) throw bad(`Unknown method: ${method}`);
      if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
        throw bad('params must be an object');
      }
      const result = await dispatch[method](params ?? {});
      socket.write(`${JSON.stringify({ id, result })}\n`);
    } catch (e) {
      socket.write(`${JSON.stringify({
        id,
        error: { message: e?.message ?? String(e), error_code: e?.error_code ?? 'EGO_OPERATION_FAILED' },
      })}\n`);
    }
  }

  const server = net.createServer((socket) => {
    clients.add(socket);
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (data) => {
      buf += data;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) void handleLine(socket, line);
      }
    });
    const drop = () => clients.delete(socket);
    socket.on('close', drop);
    socket.on('error', drop);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, resolve);
  });
  fs.chmodSync(sockPath, 0o600);

  return {
    sockPath,
    close() {
      for (const c of clients) c.destroy();
      clients.clear();
      server.close();
      try { fs.unlinkSync(sockPath); } catch { /* already gone */ }
    },
  };
}
