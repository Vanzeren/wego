// Integration tests for the bridge server over a real Unix socket,
// using SpaceManager with no-op view hooks (no electron needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SpaceManager } from '../src/browser/spaces.js';
import { startBridgeServer } from '../src/browser/bridge.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ego-bridge-test-'));
}

// Client: one request at a time over a fresh connection; server-push event
// frames (no id) are skipped while waiting for the matching response.
function request(sockPath, method, params) {
  return new Promise((resolve, reject) => {
    const s = net.connect(sockPath, () => {
      s.write(`${JSON.stringify({ id: 1, method, ...(params !== undefined ? { params } : {}) })}\n`);
    });
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id === 1) {
          s.end();
          resolve(msg);
          return;
        }
      }
    });
    s.on('error', reject);
  });
}

async function setup(t, { failTabResolution = false } = {}) {
  const dir = tmpdir();
  const sockPath = path.join(dir, 'bridge.sock');
  process.env.EGO_BRIDGE_SOCK = sockPath;
  const spaces = new SpaceManager({
    createView(space, tab) {
      if (failTabResolution) {
        const p = Promise.reject(new Error('no target'));
        p.catch(() => {}); // mark handled; awaiters still see the rejection
        tab.targetIdReady = p;
      } else {
        tab.targetIdReady = Promise.resolve().then(() => spaces.noteTargetId(space.id, tab.targetId, `CDP-${tab.targetId}`));
      }
      return null;
    },
    destroyView() {},
  });
  spaces.createPersonalSpace();
  spaces.addUserTab(1, 'about:blank');
  const highlights = [];
  const bridge = await startBridgeServer({
    spaces,
    windowApi: { sendHighlight: (pt) => highlights.push(pt) },
    cdp: { webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/x', httpEndpoint: 'http://127.0.0.1:1' },
  });
  t.after(() => {
    bridge.close();
    delete process.env.EGO_BRIDGE_SOCK;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { spaces, sockPath, dir, highlights };
}

test('ping and meta endpoints', async (t) => {
  const { sockPath } = await setup(t);
  assert.deepEqual(await request(sockPath, 'ping'), { id: 1, result: 'pong' });
  const ver = await request(sockPath, 'getBrowserVersion');
  assert.equal(ver.result.currentVersion, '0.1.0');
  assert.ok(ver.result.cdpEndpoint.startsWith('ws://'));
  const ep = await request(sockPath, 'getCDPEndpoint');
  assert.ok(ep.result.webSocketDebuggerUrl);
});

test('profiles: list, create, persist to profiles.json', async (t) => {
  const { sockPath, dir } = await setup(t);
  let r = await request(sockPath, 'listProfiles');
  assert.deepEqual(r.result.profiles, [{ id: 'Default', name: 'Default', isDefault: true }]);
  r = await request(sockPath, 'createProfile', { name: 'Work' });
  assert.equal(r.result.id, 'Profile 2');
  r = await request(sockPath, 'listProfiles');
  assert.equal(r.result.profiles.length, 2);
  assert.equal(r.result.profiles[1].isDefault, false);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'profiles.json'), 'utf8'));
  assert.equal(onDisk[1].name, 'Work');
});

test('createTaskSpace: validation, profile lookup, first tab with real targetId, resume', async (t) => {
  const { sockPath } = await setup(t);
  let r = await request(sockPath, 'createTaskSpace', { name: '' });
  assert.equal(r.error.error_code, 'EGO_INVALID_ARGUMENT');
  r = await request(sockPath, 'createTaskSpace', { name: 'x', profileId: 'Nope' });
  assert.equal(r.error.error_code, 'EGO_PROFILE_NOT_FOUND');
  r = await request(sockPath, 'createTaskSpace', { name: 'alpha' });
  assert.equal(r.result.name, 'alpha');
  const tabs = await request(sockPath, 'listTabs', { id: r.result.id });
  assert.equal(tabs.result.tabs.length, 1);
  assert.match(tabs.result.tabs[0].targetId, /^CDP-/); // placeholder never leaks
  const resumed = await request(sockPath, 'createTaskSpace', { name: 'alpha' });
  assert.equal(resumed.result.id, r.result.id);
});

test('name collision with user-owned space is EGO_TASK_SPACE_NAME_IN_USE', async (t) => {
  const { sockPath } = await setup(t);
  const r = await request(sockPath, 'createTaskSpace', { name: 'Personal' });
  assert.equal(r.error.error_code, 'EGO_TASK_SPACE_NAME_IN_USE');
});

test('handoff blocks createTab and snapshot with EGO_TASK_SPACE_USER_IN_CONTROL; takeover restores', async (t) => {
  const { sockPath } = await setup(t);
  const task = (await request(sockPath, 'createTaskSpace', { name: 'gated' })).result;
  await request(sockPath, 'handOffTaskSpace', { id: task.id });
  let r = await request(sockPath, 'createTab', { id: task.id, url: 'http://x/' });
  assert.equal(r.error.error_code, 'EGO_TASK_SPACE_USER_IN_CONTROL');
  r = await request(sockPath, 'snapshot', { id: task.id });
  assert.equal(r.error.error_code, 'EGO_TASK_SPACE_USER_IN_CONTROL');
  await request(sockPath, 'takeOverTaskSpace', { id: task.id });
  r = await request(sockPath, 'createTab', { id: task.id, url: 'http://x/' });
  assert.match(r.result.targetId, /^CDP-/);
});

test('snapshot without a live web contents is EGO_WEB_CONTENTS_UNAVAILABLE', async (t) => {
  const { sockPath } = await setup(t);
  const task = (await request(sockPath, 'createTaskSpace', { name: 'snap' })).result;
  const r = await request(sockPath, 'snapshot', { id: task.id });
  assert.equal(r.error.error_code, 'EGO_WEB_CONTENTS_UNAVAILABLE');
});

test('snapshot option validation runs before gating', async (t) => {
  const { sockPath } = await setup(t);
  const task = (await request(sockPath, 'createTaskSpace', { name: 'snap-opts' })).result;
  let r = await request(sockPath, 'snapshot', { id: task.id, options: { scope: 'nope' } });
  assert.equal(r.error.error_code, 'EGO_INVALID_ARGUMENT');
  r = await request(sockPath, 'snapshot', { id: task.id, options: { scope: 'subtree' } });
  assert.equal(r.error.error_code, 'EGO_INVALID_ARGUMENT'); // root required
});

test('failed CDP target resolution surfaces as EGO_OPERATION_FAILED on createTab', async (t) => {
  const { sockPath } = await setup(t, { failTabResolution: true });
  const task = (await request(sockPath, 'createTaskSpace', { name: 'failer' })).result;
  const r = await request(sockPath, 'createTab', { id: task.id, url: 'http://x/' });
  assert.equal(r.error.error_code, 'EGO_OPERATION_FAILED');
});

test('unknown method and malformed params are EGO_INVALID_ARGUMENT', async (t) => {
  const { sockPath } = await setup(t);
  let r = await request(sockPath, 'doesNotExist');
  assert.equal(r.error.error_code, 'EGO_INVALID_ARGUMENT');
  r = await request(sockPath, 'listTabs', { id: 'seven' });
  assert.equal(r.error.error_code, 'EGO_INVALID_ARGUMENT');
});

test('setAgentTaskState, highlight, task lifecycle strings', async (t) => {
  const { sockPath, highlights } = await setup(t);
  const task = (await request(sockPath, 'createTaskSpace', { name: 'life' })).result;
  let r = await request(sockPath, 'setAgentTaskState', { id: task.id, state: 'working' });
  assert.equal(r.result, `${task.id} state updated.`);
  r = await request(sockPath, 'animationHighlightMouseToPosition', { id: task.id, x: 10, y: 20 });
  assert.equal(r.result, `${task.id} mouse highlight shown.`);
  assert.deepEqual(highlights, [{ x: 10, y: 20 }]);
  r = await request(sockPath, 'completeTaskSpace', { id: task.id });
  assert.equal(r.result, `${task.id} task space completed.`);
  // completed spaces are user-controlled: agent close is now gated
  r = await request(sockPath, 'closeTaskSpace', { id: task.id });
  assert.equal(r.error.error_code, 'EGO_TASK_SPACE_USER_IN_CONTROL');
  const other = (await request(sockPath, 'createTaskSpace', { name: 'life-2' })).result;
  r = await request(sockPath, 'closeTaskSpace', { id: other.id });
  assert.equal(r.result, `${other.id} task space closed.`);
  r = await request(sockPath, 'closeTaskSpace', { id: other.id });
  assert.equal(r.error.error_code, 'EGO_TASK_SPACE_NOT_FOUND');
});

test('spaceChanged push events reach connected clients', async (t) => {
  const { sockPath } = await setup(t);
  const events = [];
  const s = net.connect(sockPath);
  s.on('data', (d) => {
    for (const line of d.toString().split('\n').filter(Boolean)) {
      const msg = JSON.parse(line);
      if (msg.event) events.push(msg);
    }
  });
  await new Promise((r) => s.on('connect', r));
  await request(sockPath, 'createTaskSpace', { name: 'pushy' });
  await new Promise((r) => setTimeout(r, 150));
  s.end();
  assert.ok(events.some((e) => e.event === 'spaceChanged'));
});

test('rapid spaceChanged bursts are coalesced into one push per space', async (t) => {
  const { sockPath, spaces } = await setup(t);
  const events = [];
  const s = net.connect(sockPath);
  s.on('data', (d) => {
    for (const line of d.toString().split('\n').filter(Boolean)) {
      const msg = JSON.parse(line);
      if (msg.event === 'spaceChanged') events.push(msg);
    }
  });
  await new Promise((r) => s.on('connect', r));
  const t2 = spaces.createTaskSpace({ name: 'bursty' });
  await spaces.whenTabsReady(t2.id);
  await new Promise((r) => setTimeout(r, 150));
  s.end();
  // createTaskSpace fires #addTab (1 change); noteTargetId from readiness may
  // fire one more after the debounce window — never the uncoalesced burst.
  const forSpace = events.filter((e) => e.spaceId === t2.id);
  assert.ok(forSpace.length >= 1 && forSpace.length <= 2, `expected 1-2 pushes, got ${forSpace.length}`);
});
