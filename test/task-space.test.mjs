// TaskSpace cleanup semantics over the public runScript API and a fake bridge.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript } from '../src/runtime/index.js';

async function fakeBridge(t, space, handlers = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wego-task-space-test-'));
  const sockPath = path.join(dir, 'bridge.sock');
  const previousSock = process.env.WEGO_BRIDGE_SOCK;
  process.env.WEGO_BRIDGE_SOCK = sockPath;
  const calls = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        calls.push(message);
        const defaults = {
          listTaskSpaces: () => ({ taskSpaces: [space] }),
          listTabs: () => ({ tabs: [
            { index: 0, targetId: 'T1', url: 'https://user.example/1', title: 'One', active: true },
            { index: 1, targetId: 'T2', url: 'https://user.example/2', title: 'Two', active: false },
          ] }),
          claimTaskSpace: () => ({ id: space.id, taskId: space.taskId, name: space.name }),
          createTaskSpace: () => ({ id: space.id, taskId: space.taskId, name: space.name }),
          closeTab: () => ({ closed: true }),
          completeTaskSpace: () => `${space.id} task space completed.`,
          closeTaskSpace: () => `${space.id} task space closed.`,
        };
        const handler = handlers[message.method] ?? defaults[message.method];
        const response = handler
          ? { id: message.id, result: handler(message.params) }
          : { id: message.id, error: { message: `unhandled ${message.method}`, error_code: 'WEGO_INVALID_ARGUMENT' } };
        socket.write(`${JSON.stringify(response)}\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(sockPath, resolve));
  t.after(() => {
    server.close();
    if (previousSock === undefined) delete process.env.WEGO_BRIDGE_SOCK;
    else process.env.WEGO_BRIDGE_SOCK = previousSock;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return calls;
}

test('finish closes all tabs in an owned agent space', async (t) => {
  const calls = await fakeBridge(t, { id: 9, taskId: 'own', name: 'own', ownership: 'agent', control: 'agent' });
  const { exitCode } = await runScript("const task = await taskSpace('own'); await task.finish({ keep: [] });");
  assert.equal(exitCode, 0);
  assert.deepEqual(calls.filter((call) => call.method === 'closeTab').map((call) => call.params.targetId), ['T1', 'T2']);
  assert.equal(calls.filter((call) => call.method === 'closeTaskSpace').length, 1);
  assert.equal(calls.filter((call) => call.method === 'completeTaskSpace').length, 0);
});

test('finish preserves existing tabs in a claimed space', async (t) => {
  const calls = await fakeBridge(t, { id: 7, taskId: 'claimed', name: 'claimed', ownership: 'agent', control: 'agent' });
  const { exitCode } = await runScript('const task = await claimTaskSpace(7); await task.finish({ keep: [] });');
  assert.equal(exitCode, 0);
  assert.equal(calls.filter((call) => call.method === 'closeTab').length, 0);
  assert.equal(calls.filter((call) => call.method === 'closeTaskSpace').length, 0);
  assert.equal(calls.filter((call) => call.method === 'completeTaskSpace').length, 1);
});
