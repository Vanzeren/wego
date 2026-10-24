import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { VirtualCdpServer } from '../src/browser/cdp-server.js';

class FakeDebugger extends EventEmitter {
  constructor() {
    super();
    this.attached = false;
    this.attachCount = 0;
    this.detachCount = 0;
    this.commands = [];
    this.onCommand = null;
  }

  isAttached() {
    return this.attached;
  }

  attach() {
    this.attached = true;
    this.attachCount++;
  }

  detach() {
    this.attached = false;
    this.detachCount++;
  }

  simulateDetach() {
    this.attached = false;
    this.emit('detach');
  }

  emitAttached(sessionId, targetInfo) {
    this.emit('message', {}, 'Target.attachedToTarget', { sessionId, targetInfo });
  }

  emitChild(method, params, sessionId) {
    this.emit('message', {}, method, params, sessionId);
  }

  async sendCommand(method, params = {}, sessionId) {
    this.commands.push({ method, params, sessionId });
    const hooked = this.onCommand?.(method, params, sessionId);
    if (hooked !== undefined) return hooked;
    if (method === 'Target.getTargetInfo') {
      return { targetInfo: { targetId: 'PAGE', type: 'page' } };
    }
    if (method === 'Target.attachToTarget') {
      return { sessionId: `real-${params.targetId}` };
    }
    if (method === 'Runtime.evaluate') {
      return { result: { type: 'number', value: 42 } };
    }
    return {};
  }
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.debugger = new FakeDebugger();
    this.destroyed = false;
  }

  isDestroyed() {
    return this.destroyed;
  }
}

function makeServer(wc) {
  const page = { targetId: 'PAGE', type: 'page', url: 'https://example.test/', title: 'Page' };
  return new VirtualCdpServer({
    listTargets: () => [page],
    resolveWc: (targetId) => targetId === page.targetId ? wc : null,
  });
}

function openClient(server) {
  const messages = [];
  let nextId = 1;
  const client = server.openClient((message) => messages.push(message));

  async function call(method, params = {}, sessionId) {
    const id = nextId++;
    await client.handleMessage({
      id,
      method,
      params,
      ...(sessionId ? { sessionId } : {}),
    });
    const response = messages.find((message) => message.id === id);
    assert.ok(response, `missing response to ${method}`);
    return response;
  }

  return {
    messages,
    call,
    async command(method, params = {}, sessionId) {
      const response = await call(method, params, sessionId);
      assert.equal(response.error, undefined, `${method} failed: ${JSON.stringify(response.error)}`);
      return response.result;
    },
    events(method) {
      return messages.filter((message) => message.method === method);
    },
  };
}

const iframe = {
  targetId: 'IFRAME',
  type: 'iframe',
  url: 'https://cross-origin.test/frame',
  title: 'Frame',
};

test('F2: browser getTargets temporarily enumerates OOPIFs on an unattached page', async () => {
  const wc = new FakeWebContents();
  wc.debugger.onCommand = function (method, params) {
    if (method === 'Target.setAutoAttach' && params.autoAttach) {
      this.emitAttached('real-frame', iframe);
    }
    if (method === 'Target.detachFromTarget') {
      this.emit('message', {}, 'Target.detachedFromTarget', { sessionId: params.sessionId });
    }
  };
  const client = openClient(makeServer(wc));

  const { targetInfos } = await client.command('Target.getTargets');
  assert.deepEqual(
    targetInfos.map(({ targetId, type }) => ({ targetId, type })),
    [
      { targetId: 'PAGE', type: 'page' },
      { targetId: 'IFRAME', type: 'iframe' },
    ],
  );

  assert.equal(wc.debugger.attachCount, 1);
  assert.equal(wc.debugger.detachCount, 1);
  assert.equal(wc.debugger.isAttached(), false, 'temporary debugger must be released');
  assert.ok(wc.debugger.commands.some(({ method, params }) =>
    method === 'Target.setAutoAttach' && params.autoAttach === false));
  assert.ok(wc.debugger.commands.some(({ method, params }) =>
    method === 'Target.detachFromTarget' && params.sessionId === 'real-frame'));
  assert.equal(wc.debugger.listenerCount('message'), 0);
  assert.equal(wc.debugger.listenerCount('detach'), 0);
  assert.equal(wc.listenerCount('destroyed'), 0);
});

test('F4: a frame session cannot detach its parent page but can detach itself', async () => {
  const wc = new FakeWebContents();
  wc.debugger.onCommand = function (method, params) {
    if (method === 'Target.setAutoAttach' && params.autoAttach) {
      this.emitAttached('real-frame', iframe);
    }
  };
  const client = openClient(makeServer(wc));

  const { sessionId: pageSid } = await client.command('Target.attachToTarget', {
    targetId: 'PAGE', flatten: true,
  });
  await client.command('Target.setAutoAttach', {
    autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
  }, pageSid);
  const attached = client.events('Target.attachedToTarget').find((event) =>
    event.sessionId === pageSid && event.params.targetInfo.targetId === iframe.targetId);
  assert.ok(attached, 'page did not receive its auto-attached frame');
  const frameSid = attached.params.sessionId;

  const denied = await client.call('Target.detachFromTarget', { sessionId: pageSid }, frameSid);
  assert.equal(denied.error?.code, -32000);
  const evaluation = await client.command('Runtime.evaluate', { expression: '6 * 7' }, pageSid);
  assert.equal(evaluation.result.value, 42, 'parent page must remain usable');

  const selfDetach = await client.call('Target.detachFromTarget', { sessionId: frameSid }, frameSid);
  assert.equal(selfDetach.error, undefined);
  assert.deepEqual(selfDetach.result, {});
});

test('F3: reattaching after debugger detach does not accumulate listeners', async () => {
  const wc = new FakeWebContents();
  const client = openClient(makeServer(wc));

  const { sessionId: oldSid } = await client.command('Target.attachToTarget', {
    targetId: 'PAGE', flatten: true,
  });
  assert.equal(wc.debugger.listenerCount('message'), 1);
  assert.equal(wc.debugger.listenerCount('detach'), 1);
  assert.equal(wc.listenerCount('destroyed'), 1);

  wc.debugger.simulateDetach();
  const { sessionId: newSid } = await client.command('Target.attachToTarget', {
    targetId: 'PAGE', flatten: true,
  });
  assert.notEqual(newSid, oldSid);

  assert.equal(wc.debugger.listenerCount('message'), 1);
  assert.equal(wc.debugger.listenerCount('detach'), 1);
  assert.equal(wc.listenerCount('destroyed'), 1);
  const oldDetachEvents = client.events('Target.detachedFromTarget').filter((event) =>
    event.params.sessionId === oldSid);
  assert.equal(oldDetachEvents.length, 1, 'old session must be detached exactly once');
});

test('F1: explicit OOPIF attach is not leaked to an auto-attaching client', async () => {
  const wc = new FakeWebContents();
  let emitEnumerationFrame = true;
  wc.debugger.onCommand = function (method, params) {
    if (method === 'Target.setAutoAttach' && params.autoAttach && emitEnumerationFrame) {
      this.emitAttached('enumeration-frame', iframe);
    }
    if (method === 'Target.attachToTarget' && params.targetId === iframe.targetId) {
      // Electron can deliver this event before the attach command response.
      this.emitAttached('explicit-frame', iframe);
      return { sessionId: 'explicit-frame' };
    }
  };
  const server = makeServer(wc);
  const clientA = openClient(server);
  const clientB = openClient(server);

  const { sessionId: pageSid } = await clientA.command('Target.attachToTarget', {
    targetId: 'PAGE', flatten: true,
  });
  // Populate the public target index while this page already owns a debugger.
  const { targetInfos } = await clientA.command('Target.getTargets');
  assert.ok(targetInfos.some((target) => target.targetId === iframe.targetId));
  emitEnumerationFrame = false;
  await clientA.command('Target.setAutoAttach', {
    autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
  }, pageSid);

  const { sessionId: frameSidB } = await clientB.command('Target.attachToTarget', {
    targetId: iframe.targetId, flatten: true,
  });
  assert.equal(clientA.events('Target.attachedToTarget').length, 0,
    'client A must not learn about client B\'s explicit session');

  await clientB.command('Runtime.enable', {}, frameSidB);
  wc.debugger.emitChild('Runtime.consoleAPICalled', { type: 'log', args: [] }, 'explicit-frame');
  assert.equal(clientB.events('Runtime.consoleAPICalled').length, 1);
  assert.equal(clientB.events('Runtime.consoleAPICalled')[0].sessionId, frameSidB);
  assert.equal(clientA.events('Runtime.consoleAPICalled').length, 0,
    'child events must only route to the explicit owner');

  wc.debugger.emit('message', {}, 'Target.detachedFromTarget', { sessionId: 'explicit-frame' });
  const detachedB = clientB.events('Target.detachedFromTarget').filter((event) =>
    event.params.sessionId === frameSidB);
  assert.equal(detachedB.length, 1);
  assert.equal(clientA.events('Target.detachedFromTarget').length, 0,
    'client A must not retain a ghost session for the explicit attach');
});
