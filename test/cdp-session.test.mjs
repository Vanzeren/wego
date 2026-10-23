// Unit tests for runtime CDP session lifecycle (reattach, detach, waiter
// cleanup) using a scripted fake ego channel.
import test from 'node:test';
import assert from 'node:assert/strict';

import { CDPManager } from '../src/runtime/cdp.js';
import { Page } from '../src/runtime/page.js';

// Fake ego raw channel: records outgoing messages; tests push replies/events.
function fakeEgo() {
  const sent = [];
  return {
    sent,
    onCDPMessage: null,
    onSendCDPMessageError: null,
    async sendCDPMessage(raw) {
      const m = JSON.parse(raw);
      sent.push(m);
      // keep background sends from holding the event loop hostage
      if (m.method === 'Target.setDiscoverTargets') this.push({ id: m.id, result: {} });
      if (m.method === 'Target.detachFromTarget') this.push({ id: m.id, result: {} });
    },
    push(msg) { this.onCDPMessage(JSON.stringify(msg)); },
    // respond to the most recent message matching method (and sessionId)
    respond(method, result, sessionId) {
      const m = [...sent].reverse().find((x) => x.method === method && x.sessionId === sessionId);
      assert.ok(m, `no sent message for ${method}`);
      this.push({ id: m.id, ...(m.sessionId ? { sessionId: m.sessionId } : {}), result });
      return m;
    },
  };
}

async function attachPage(ego, cdp, targetId = 'T1') {
  const p = cdp.attach(targetId);
  await Promise.resolve();
  const m = ego.respond('Target.attachToTarget', { sessionId: 'S1' });
  const session = await p;
  return { session, attachMsg: m };
}

test('concurrent attach() calls share one in-flight attach', async () => {
  const ego = fakeEgo();
  const cdp = new CDPManager(ego);
  const p1 = cdp.attach('T1');
  const p2 = cdp.attach('T1');
  await Promise.resolve();
  ego.respond('Target.attachToTarget', { sessionId: 'S1' });
  const [s1, s2] = await Promise.all([p1, p2]);
  assert.equal(s1, s2);
  assert.equal(ego.sent.filter((m) => m.method === 'Target.attachToTarget').length, 1);
});

test('detach event fails pending commands immediately, then reattach re-arms', async () => {
  const ego = fakeEgo();
  const cdp = new CDPManager(ego);
  const { session } = await attachPage(ego, cdp);
  let reattached = 0;
  session.on('wego:reattached', () => { reattached++; });

  const pending = session.send('Runtime.evaluate', { expression: '1' });
  const assertion = assert.rejects(pending, /CDP session detached/);
  ego.push({ method: 'Target.detachedFromTarget', params: { sessionId: 'S1' } });
  await assertion; // rejected well before any 30s timeout
  assert.equal(session.detached, true);

  // auto-reattach in flight
  await Promise.resolve();
  ego.respond('Target.attachToTarget', { sessionId: 'S2' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(session.detached, false);
  assert.equal(session.sessionId, 'S2');
  assert.equal(reattached, 1);
  assert.equal(cdp.sessionFor('T1'), session);

  // new commands flow on the new sessionId
  const q = session.send('Page.enable');
  ego.respond('Page.enable', {}, 'S2');
  await q;
});

test('failed reattach leaves the session detached and drops _byTarget', async () => {
  const ego = fakeEgo();
  const cdp = new CDPManager(ego);
  const { session } = await attachPage(ego, cdp);
  ego.push({ method: 'Target.detachedFromTarget', params: { sessionId: 'S1' } });
  await Promise.resolve();
  const m = [...ego.sent].reverse().find((x) => x.method === 'Target.attachToTarget');
  ego.push({ id: m.id, error: { message: 'target gone' } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(session.detached, true);
  assert.equal(cdp.sessionFor('T1'), undefined);
});

test('detach event arriving before the attach continuation is not dropped', async () => {
  const ego = fakeEgo();
  const cdp = new CDPManager(ego);
  let reattached = 0;
  const p = cdp.attach('T1');
  await Promise.resolve();
  const m = [...ego.sent].reverse().find((x) => x.method === 'Target.attachToTarget');
  // same chunk: detach for the not-yet-registered sid, then the attach reply
  ego.push({ method: 'Target.detachedFromTarget', params: { sessionId: 'S1' } });
  ego.push({ id: m.id, result: { sessionId: 'S1' } });
  const session = await p;
  session.on('wego:reattached', () => { reattached++; });
  assert.equal(session.detached, true); // immediately re-detached
  await Promise.resolve();
  ego.respond('Target.attachToTarget', { sessionId: 'S2' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(session.detached, false);
  assert.equal(reattached, 1);
});

test('detach(targetId) clears local maps and notifies the browser', async () => {
  const ego = fakeEgo();
  const cdp = new CDPManager(ego);
  const { session } = await attachPage(ego, cdp);
  cdp.detach('T1');
  assert.equal(session.detached, true);
  assert.equal(cdp.sessionFor('T1'), undefined);
  assert.equal(cdp._sessions.size, 0);
  const detachMsg = ego.sent.find((m) => m.method === 'Target.detachFromTarget');
  assert.ok(detachMsg);
  assert.equal(detachMsg.params.sessionId, 'S1');
  // a later stray detach event for the old sid is harmless
  ego.push({ method: 'Target.detachedFromTarget', params: { sessionId: 'S1' } });
});

// ---- page-level waiter cleanup ----

function bareChooserPage() {
  const p = Object.create(Page.prototype);
  p._chooserWaiters = [];
  p._popupWaiters = [];
  p._eventBuffer = [];
  p._dialog = null;
  p._networkInFlight = 0;
  p._lastNetworkActivity = 0;
  const sent = [];
  const listeners = new Map();
  const session = {
    __wegoListenersArmed: false,
    sent,
    async send(method, params) { sent.push({ method, params }); return {}; },
    on(method, cb) { listeners.set(method, cb); return () => listeners.delete(method); },
    emit(method, params) { listeners.get(method)?.(params); },
  };
  p._session = async () => session;
  return { page: p, session };
}

test('timed-out waitForFileChooser removes its waiter; next chooser is cancelled', async () => {
  const { page, session } = bareChooserPage();
  Page.prototype._registerSessionListeners.call(page, session);

  await assert.rejects(page.waitForFileChooser({ timeout: 50 }), /Timeout 50ms exceeded/);
  assert.equal(page._chooserWaiters.length, 0, 'timed-out waiter must be removed');

  // With no waiter armed, the interception path cancels the chooser.
  session.emit('Page.fileChooserOpened', { backendNodeId: 42, mode: 'selectSingle' });
  await new Promise((r) => setTimeout(r, 10));
  const cancel = session.sent.find((m) => m.method === 'DOM.setFileInputFiles');
  assert.ok(cancel, 'unwaited chooser should hit the cancel path');
  assert.deepEqual(cancel.params, { files: [], backendNodeId: 42 });
});

test('armed waitForFileChooser resolves with the chooser', async () => {
  const { page, session } = bareChooserPage();
  Page.prototype._registerSessionListeners.call(page, session);
  const wait = page.waitForFileChooser({ timeout: 1000 });
  await Promise.resolve();
  session.emit('Page.fileChooserOpened', { backendNodeId: 7, mode: 'selectSingle' });
  const chooser = await wait;
  assert.equal(chooser._backendNodeId, 7);
  assert.equal(page._chooserWaiters.length, 0);
});
