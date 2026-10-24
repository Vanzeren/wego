// NDJSON client for the wego bridge (docs/protocol.md).
// Presents the native `globalThis.ego` surface: request/response by id,
// server-push events via ego.onEvent, local task-space selection, and the
// raw CDP tunnel (cdpMessage / { event: "cdp" } pushes).

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_SOCK = () =>
  process.env.WEGO_BRIDGE_SOCK || path.join(os.homedir(), '.wego', 'bridge.sock');

function invalidArg(message) {
  const err = new TypeError(message);
  err.error_code = 'WEGO_INVALID_ARGUMENT';
  return err;
}

function localError(message, error_code) {
  const err = new Error(message);
  err.error_code = error_code;
  return err;
}

export async function connectWego({ socketPath } = {}) {
  const sockPath = socketPath || DEFAULT_SOCK();
  const sock = net.createConnection(sockPath);

  await new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });

  // Node's UTF-8 decoder keeps partial multibyte sequences across chunks.
  sock.setEncoding('utf8');

  let buffer = '';
  let nextId = 1;
  const pending = new Map(); // id -> {resolve, reject}

  const ego = {
    onEvent: null, // assignable: (event) => {} for server pushes
    onCDPMessage: null, // assignable: (rawString) => {}
    onSendCDPMessageError: null, // assignable: (message, error_code) => {}
  };

  sock.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore malformed line
      }
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) {
          p.reject(localError(msg.error.message, msg.error.error_code));
        } else {
          p.resolve(msg.result);
        }
      } else if (msg.event === 'cdp') {
        // Raw CDP tunnel: responses and events for ego.sendCDPMessage.
        if (typeof ego.onCDPMessage === 'function') {
          try { ego.onCDPMessage(JSON.stringify(msg.message)); } catch { /* user handler */ }
        }
      } else if (msg.event) {
        if (msg.event === 'spaceChanged') controlCacheDirty = true;
        if (typeof ego.onEvent === 'function') {
          try { ego.onEvent(msg); } catch { /* user handler */ }
        }
      }
    }
  });

  sock.on('close', () => {
    for (const [, p] of pending) {
      p.reject(localError('Bridge socket closed', 'WEGO_BROWSER_UNAVAILABLE'));
    }
    pending.clear();
  });

  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, {
        resolve,
        reject: (err) => {
          if (err && err.error_code === 'WEGO_TASK_SPACE_USER_IN_CONTROL') controlCacheDirty = true;
          reject(err);
        },
      });
      sock.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  // ---- local task-space selection ----
  let selectedSpaceId = null;

  // ---- user-control gating cache ----
  let controlCache = new Map(); // spaceId -> control
  let controlCacheDirty = true;

  async function controlFor(spaceId) {
    if (controlCacheDirty) {
      try {
        const { taskSpaces } = await call('listTaskSpaces');
        controlCache = new Map(taskSpaces.map((s) => [s.id, s.control]));
        controlCacheDirty = false;
      } catch {
        controlCacheDirty = true;
      }
    }
    return controlCache.get(spaceId);
  }

  const USER_IN_CONTROL = { error: 'Task space is under user control', error_code: 'WEGO_TASK_SPACE_USER_IN_CONTROL' };
  const NOT_SELECTED = { error: 'Task space not selected', error_code: 'WEGO_TASK_SPACE_NOT_SELECTED' };

  // Gate task-mutating calls. Returns an error object when gated, else null.
  async function gate(spaceId) {
    const control = await controlFor(spaceId);
    return control === 'user' ? USER_IN_CONTROL : null;
  }

  function requireSelected() {
    return selectedSpaceId;
  }

  // ---- native-bindings surface ----

  ego.getBrowserVersion = () => call('getBrowserVersion');
  ego.listProfiles = () => call('listProfiles');
  ego.listTaskSpaces = async () => {
    const result = await call('listTaskSpaces');
    controlCache = new Map(result.taskSpaces.map((s) => [s.id, s.control]));
    controlCacheDirty = false;
    return result;
  };

  ego.createTaskSpace = (name, profileId) => {
    if (typeof name !== 'string' || name.length === 0) throw invalidArg('createTaskSpace(name) requires a non-empty string name');
    if (profileId !== undefined && typeof profileId !== 'string') throw invalidArg('createTaskSpace profileId must be a string');
    return call('createTaskSpace', { name, ...(profileId !== undefined ? { profileId } : {}) });
  };

  ego.claimTaskSpace = (id, name) => {
    // validation throws synchronously (tests + agent sanity); the cache
    // update rides the async tail so it lands after the bridge confirms.
    if (typeof id !== 'number' || !Number.isInteger(id)) throw invalidArg('claimTaskSpace(id) requires an integer id');
    if (name !== undefined && typeof name !== 'string') throw invalidArg('claimTaskSpace name must be a string');
    return call('claimTaskSpace', { id, ...(name !== undefined ? { name } : {}) })
      .then((r) => { controlCache.set(id, 'agent'); return r; });
  };

  ego.useTaskSpace = (id) => {
    if (typeof id !== 'number' || !Number.isInteger(id)) throw invalidArg('useTaskSpace(id) requires an integer id');
    selectedSpaceId = id;
    return id;
  };

  ego.closeTaskSpace = async () => {
    const id = requireSelected();
    if (id === null) return NOT_SELECTED;
    const gated = await gate(id);
    if (gated) return gated;
    const r = await call('closeTaskSpace', { id });
    controlCache.delete(id);
    return r;
  };

  ego.completeTaskSpace = async () => {
    const id = requireSelected();
    if (id === null) return NOT_SELECTED;
    const gated = await gate(id);
    if (gated) return gated;
    const r = await call('completeTaskSpace', { id });
    controlCache.delete(id);
    return r;
  };

  ego.handOffTaskSpace = async () => {
    const id = requireSelected();
    if (id === null) return NOT_SELECTED;
    const r = await call('handOffTaskSpace', { id });
    controlCache.set(id, 'user'); // don't wait for the debounced spaceChanged push
    return r;
  };

  ego.takeOverTaskSpace = async () => {
    const id = requireSelected();
    if (id === null) return NOT_SELECTED;
    const r = await call('takeOverTaskSpace', { id });
    controlCache.set(id, 'agent'); // don't wait for the debounced spaceChanged push
    return r;
  };

  ego.setAgentTaskState = async (state) => {
    if (typeof state !== 'string') throw invalidArg('setAgentTaskState(state) requires a string');
    const id = requireSelected();
    if (id === null) return NOT_SELECTED;
    const gated = await gate(id);
    if (gated) return gated;
    return call('setAgentTaskState', { id, state });
  };

  ego.animationHighlightMouseToPosition = async (x, y) => {
    if (typeof x !== 'number' || typeof y !== 'number') throw invalidArg('animationHighlightMouseToPosition(x, y) requires numbers');
    const id = requireSelected();
    if (id === null) return NOT_SELECTED;
    const gated = await gate(id);
    if (gated) return gated;
    return call('animationHighlightMouseToPosition', { id, x, y });
  };

  ego.createTab = async (url) => {
    if (typeof url !== 'string' || url.length === 0) throw invalidArg('createTab(url) requires a non-empty string url');
    const id = requireSelected();
    if (id === null) return NOT_SELECTED;
    const gated = await gate(id);
    if (gated) return gated;
    return call('createTab', { id, url });
  };

  ego.listTabs = async () => {
    const id = requireSelected();
    if (id === null) return NOT_SELECTED;
    const gated = await gate(id);
    if (gated) return gated;
    return call('listTabs', { id });
  };

  ego.snapshot = async (options) => {
    if (options !== undefined && (typeof options !== 'object' || options === null)) {
      throw invalidArg('snapshot(options) requires an object');
    }
    const id = requireSelected();
    if (id === null) throw localError('Task space not selected', 'WEGO_TASK_SPACE_NOT_SELECTED');
    const gated = await gate(id);
    if (gated) throw localError(gated.error, gated.error_code);
    return call('snapshot', { id, ...(options ? { options } : {}) });
  };

  // raw CDP send; local pre-send failures go to onSendCDPMessageError
  ego.sendCDPMessage = async (jsonString) => {
    if (typeof jsonString !== 'string') throw invalidArg('sendCDPMessage(message) requires a string');
    const fail = (message, code) => {
      if (typeof ego.onSendCDPMessageError === 'function') {
        try { ego.onSendCDPMessageError(message, code); } catch { /* user handler */ }
      }
    };
    if (selectedSpaceId === null) return fail('Task space not selected', 'WEGO_TASK_SPACE_NOT_SELECTED');
    const control = await controlFor(selectedSpaceId);
    if (control === 'user') return fail('Task space is under user control', 'WEGO_TASK_SPACE_USER_IN_CONTROL');
    let message;
    try {
      message = JSON.parse(jsonString);
    } catch {
      return fail('sendCDPMessage: invalid JSON', 'WEGO_INVALID_ARGUMENT');
    }
    // Fire-and-forget tunnel: CDP responses/events come back as
    // { event: "cdp" } pushes routed to ego.onCDPMessage.
    try {
      await call('cdpMessage', message);
    } catch (e) {
      return fail(e?.message || 'CDP channel unavailable', e?.error_code || 'WEGO_CDP_CHANNEL_UNAVAILABLE');
    }
  };

  ego.close = () => {
    try { sock.destroy(); } catch { /* ignore */ }
  };

  // expose internals for the runtime layer
  ego._call = call;
  ego._getSelectedSpaceId = () => selectedSpaceId;

  return ego;
}
