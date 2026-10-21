// Unit tests for the ego client bindings against a scripted fake bridge.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { connectEgo } from '../src/client/ego.js';

// Fake NDJSON bridge: handlers map method → fn(params) → result | {error:...} | throws.
// Records calls for assertions.
function fakeBridge(t, handlers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-client-test-'));
  const sockPath = path.join(dir, 'fake.sock');
  const calls = [];
  const server = net.createServer((s) => {
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        calls.push(msg);
        const h = handlers[msg.method] ?? (() => ({ message: 'unhandled', error_code: 'EGO_OPERATION_FAILED' }));
        Promise.resolve()
          .then(() => h(msg.params ?? {}))
          .then((r) => {
            const out = r && r.error_code
              ? { id: msg.id, error: { message: r.error ?? r.message ?? 'err', error_code: r.error_code } }
              : { id: msg.id, result: r };
            s.write(`${JSON.stringify(out)}\n`);
          });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(sockPath, () => {
      t.after(() => {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
      });
      resolve({ sockPath, calls });
    });
  });
}

const AGENT_SPACE = { id: 7, taskId: 'demo', name: 'demo', ownership: 'agent', control: 'agent', createdBy: 'agent', profileId: 'Default', profileName: 'Default', recentTabTitles: [] };

test('argument validation throws TypeError with EGO_INVALID_ARGUMENT', async (t) => {
  const { sockPath } = await fakeBridge(t, {});
  const ego = await connectEgo({ socketPath: sockPath });
  t.after(() => ego.close());
  const check = (e) => e instanceof TypeError && e.error_code === 'EGO_INVALID_ARGUMENT';
  // sync-throwing bindings
  for (const fn of [
    () => ego.createTaskSpace(''),
    () => ego.createTaskSpace(42),
    () => ego.claimTaskSpace('7'),
    () => ego.useTaskSpace('7'),
  ]) {
    assert.throws(fn, check);
  }
  // async bindings reject (assert.rejects also accepts sync throws)
  for (const fn of [
    () => ego.createTab(123),
    () => ego.setAgentTaskState(1),
    () => ego.sendCDPMessage({ not: 'a string' }),
    () => ego.animationHighlightMouseToPosition('x', 1),
  ]) {
    await assert.rejects(fn, check);
  }
});

test('task-scoped calls without selection resolve the NOT_SELECTED error object; snapshot rejects', async (t) => {
  const { sockPath } = await fakeBridge(t, { listTaskSpaces: () => ({ taskSpaces: [] }) });
  const ego = await connectEgo({ socketPath: sockPath });
  t.after(() => ego.close());
  const r = await ego.createTab('http://x/');
  assert.equal(r.error_code, 'EGO_TASK_SPACE_NOT_SELECTED');
  await assert.rejects(() => ego.snapshot(), (e) => e.error_code === 'EGO_TASK_SPACE_NOT_SELECTED');
});

test('useTaskSpace selection flows into request params', async (t) => {
  const { sockPath, calls } = await fakeBridge(t, {
    listTaskSpaces: () => ({ taskSpaces: [AGENT_SPACE] }),
    createTab: ({ url }) => ({ targetId: 'T1', url }),
  });
  const ego = await connectEgo({ socketPath: sockPath });
  t.after(() => ego.close());
  assert.equal(ego.useTaskSpace(7), 7);
  await ego.createTab('http://x/');
  const createCall = calls.find((c) => c.method === 'createTab');
  assert.deepEqual(createCall.params, { id: 7, url: 'http://x/' });
});

test('user control gates mutating calls locally without a bridge round-trip', async (t) => {
  const userSpace = { ...AGENT_SPACE, control: 'user' };
  const { sockPath, calls } = await fakeBridge(t, {
    listTaskSpaces: () => ({ taskSpaces: [userSpace] }),
    createTab: () => ({ targetId: 'T1' }),
  });
  const ego = await connectEgo({ socketPath: sockPath });
  t.after(() => ego.close());
  ego.useTaskSpace(7);
  const r = await ego.createTab('http://x/');
  assert.equal(r.error_code, 'EGO_TASK_SPACE_USER_IN_CONTROL');
  assert.equal(calls.filter((c) => c.method === 'createTab').length, 0); // blocked locally
  await assert.rejects(() => ego.snapshot(), (e) => e.error_code === 'EGO_TASK_SPACE_USER_IN_CONTROL');
});

test('sendCDPMessage failures reach onSendCDPMessageError, not the wire', async (t) => {
  const userSpace = { ...AGENT_SPACE, control: 'user' };
  const { sockPath } = await fakeBridge(t, {
    listTaskSpaces: () => ({ taskSpaces: [userSpace] }),
  });
  const ego = await connectEgo({ socketPath: sockPath });
  t.after(() => ego.close());
  const failures = [];
  ego.onSendCDPMessageError = (message, code) => failures.push({ message, code });
  // no selection
  await ego.sendCDPMessage(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(failures.at(-1).code, 'EGO_TASK_SPACE_NOT_SELECTED');
  // user control
  ego.useTaskSpace(7);
  await ego.sendCDPMessage(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(failures.at(-1).code, 'EGO_TASK_SPACE_USER_IN_CONTROL');
  // clearing the callback with a non-function is allowed
  ego.onSendCDPMessageError = null;
});

test('bridge error objects propagate with error_code', async (t) => {
  const { sockPath } = await fakeBridge(t, {
    listTaskSpaces: () => ({ taskSpaces: [AGENT_SPACE] }),
    claimTaskSpace: () => ({ error: 'Task space not found: 7', error_code: 'EGO_TASK_SPACE_NOT_FOUND' }),
  });
  const ego = await connectEgo({ socketPath: sockPath });
  t.after(() => ego.close());
  await assert.rejects(() => ego.claimTaskSpace(7), (e) => e.error_code === 'EGO_TASK_SPACE_NOT_FOUND');
});
