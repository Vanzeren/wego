// Unit tests for SpaceManager (pure state model, no electron).
import test from 'node:test';
import assert from 'node:assert/strict';

import { SpaceManager } from '../src/browser/spaces.js';

function makeManager(hooks = {}) {
  return new SpaceManager({ createView: () => null, destroyView: () => {}, ...hooks });
}

test('personal space gets id 1 and becomes active', () => {
  const sm = makeManager();
  const p = sm.createPersonalSpace();
  assert.equal(p.id, 1);
  assert.equal(sm.getActive().name, 'Personal');
  assert.equal(p.ownership, 'user');
  assert.equal(p.control, 'user');
});

test('createTaskSpace creates with a first tab and monotonic ids; same name resumes', () => {
  const sm = makeManager();
  sm.createPersonalSpace();
  const a = sm.createTaskSpace({ name: 'alpha' });
  assert.equal(a.id, 2);
  assert.equal(a.taskId, 'alpha'); // ego parity: taskId === name
  const again = sm.createTaskSpace({ name: 'alpha' });
  assert.equal(again.id, a.id); // resumed, not duplicated
  const space = sm.getSpace(a.id);
  assert.equal(space.tabs.length, 1); // p1 blank tab
  assert.equal(space.control, 'agent');
});

test('createTaskSpace rejects a user-owned name', () => {
  const sm = makeManager();
  sm.createPersonalSpace();
  assert.throws(() => sm.createTaskSpace({ name: 'Personal' }), /WEGO_TASK_SPACE_NAME_IN_USE|name in use/);
});

test('claimTaskSpace flips ownership, renames, syncs taskId', () => {
  const sm = makeManager();
  const p = sm.createPersonalSpace();
  const out = sm.claimTaskSpace({ id: p.id, name: 'claimed' });
  assert.equal(out.taskId, 'claimed');
  const space = sm.getSpace(p.id);
  assert.equal(space.ownership, 'agent');
  assert.equal(space.control, 'agent');
  assert.throws(() => sm.claimTaskSpace({ id: 99 }), /Task space not found: 99/);
  try { sm.claimTaskSpace({ id: 99 }); } catch (e) { assert.equal(e.error_code, 'WEGO_TASK_SPACE_NOT_FOUND'); }
});

test('handoff gates tab ops; takeover restores', () => {
  const sm = makeManager();
  sm.createPersonalSpace();
  const t = sm.createTaskSpace({ name: 'gated' });
  assert.equal(sm.handOffTaskSpace({ id: t.id }), `${t.id} has been handed off to the user.`);
  try {
    sm.createTab(t.id, 'http://x/');
    assert.unreachable();
  } catch (e) {
    assert.equal(e.error_code, 'WEGO_TASK_SPACE_USER_IN_CONTROL');
  }
  assert.equal(sm.takeOverTaskSpace({ id: t.id }), `${t.id} has been taken over by the agent.`);
  const tab = sm.createTab(t.id, 'http://x/');
  assert.ok(tab.targetId);
});

test('user-control gating also blocks snapshot-class reads like listTabs? no: listTabs is gated, listTaskSpaces is not', () => {
  const sm = makeManager();
  sm.createPersonalSpace();
  const t = sm.createTaskSpace({ name: 'g2' });
  sm.handOffTaskSpace({ id: t.id });
  assert.throws(() => sm.listTabs(t.id), /user control/);
  assert.doesNotThrow(() => sm.listTaskSpaces());
});

test('completeTaskSpace keeps the space with user ownership; closeTaskSpace destroys tabs', () => {
  const destroyed = [];
  const sm = makeManager({ destroyView: (space, tab) => destroyed.push(tab.targetId) });
  sm.createPersonalSpace();
  const a = sm.createTaskSpace({ name: 'done' });
  assert.equal(sm.completeTaskSpace({ id: a.id }), `${a.id} task space completed.`);
  assert.equal(sm.getSpace(a.id).ownership, 'user');
  const b = sm.createTaskSpace({ name: 'gone' });
  const tabIds = sm.getSpace(b.id).tabs.map((t) => t.targetId);
  assert.equal(sm.closeTaskSpace({ id: b.id }), `${b.id} task space closed.`);
  assert.equal(sm.getSpace(b.id), null);
  assert.deepEqual(destroyed, tabIds);
});

test('closeTaskSpace moves active space to a remaining one', () => {
  const sm = makeManager();
  const p = sm.createPersonalSpace();
  const a = sm.createTaskSpace({ name: 'active-one' });
  sm.setActiveSpace(a.id);
  sm.closeTaskSpace({ id: a.id });
  assert.equal(sm.getActive().id, p.id);
});

test('recentTabTitles caps at 5 with newest first, no head duplicates', () => {
  const sm = makeManager();
  sm.createPersonalSpace();
  const t = sm.createTaskSpace({ name: 'titles' });
  const targetId = sm.getSpace(t.id).tabs[0].targetId;
  for (const title of ['one', 'two', 'three', 'four', 'five', 'six', 'six']) {
    sm.noteTitle(t.id, targetId, title);
  }
  assert.deepEqual(sm.getSpace(t.id).recentTabTitles, ['six', 'five', 'four', 'three', 'two']);
});

test('noteTargetId swaps placeholder and keeps activeTargetId consistent', () => {
  const sm = makeManager();
  sm.createPersonalSpace();
  const t = sm.createTaskSpace({ name: 'swap' });
  const space = sm.getSpace(t.id);
  const placeholder = space.tabs[0].targetId;
  assert.equal(space.activeTargetId, placeholder);
  sm.noteTargetId(t.id, placeholder, 'REAL-Cdp-ID');
  assert.equal(space.tabs[0].targetId, 'REAL-Cdp-ID');
  assert.equal(space.activeTargetId, 'REAL-Cdp-ID');
});

test('awaitTargetId resolves real id; failed resolution raises WEGO_OPERATION_FAILED', async () => {
  const sm = makeManager({
    createView(space, tab) {
      tab.targetIdReady = tab.url.includes('bad')
        ? Promise.reject(new Error('no target'))
        : Promise.resolve().then(() => sm.noteTargetId(space.id, tab.targetId, `REAL-${tab.targetId}`));
      return null;
    },
  });
  sm.createPersonalSpace();
  const t = sm.createTaskSpace({ name: 'ok-space' });
  const okTab = sm.createTab(t.id, 'http://good/');
  assert.match(await sm.awaitTargetId(t.id, okTab.targetId), /^REAL-/);
  const badTab = sm.createTab(t.id, 'http://bad/');
  await assert.rejects(() => sm.awaitTargetId(t.id, badTab.targetId), /WEGO_OPERATION_FAILED|resolution failed/);
});

test('setAgentTaskState stores text and emits taskState', () => {
  const sm = makeManager();
  sm.createPersonalSpace();
  const t = sm.createTaskSpace({ name: 'state' });
  let seen = null;
  sm.on('taskState', (id, state) => { seen = { id, state }; });
  assert.equal(sm.setAgentTaskState({ id: t.id, state: 'scraping' }), `${t.id} state updated.`);
  assert.deepEqual(seen, { id: t.id, state: 'scraping' });
  assert.equal(sm.getSpace(t.id).agentState, 'scraping');
});

test('spaceChanged fires on create/claim/tab ops', () => {
  const sm = makeManager();
  sm.createPersonalSpace();
  const events = [];
  sm.on('spaceChanged', (id) => events.push(id));
  const t = sm.createTaskSpace({ name: 'ev' });
  sm.createTab(t.id, 'http://x/');
  assert.ok(events.length >= 2);
  assert.ok(events.every((id) => id === t.id));
});

test('serializeState/restoreState round-trips spaces, tabs, ids; control resets to user', () => {
  const views = [];
  const sm = makeManager({ createView: (space, tab) => { views.push(`${space.name}:${tab.url}`); return null; } });
  sm.createPersonalSpace();
  sm.addUserTab(1, 'http://personal/');
  const t = sm.createTaskSpace({ name: 'research' });
  sm.createTab(t.id, 'http://a/');
  sm.createTab(t.id, 'http://b/');
  sm.setAgentTaskState({ id: t.id, state: 'halfway' });

  const data = JSON.parse(JSON.stringify(sm.serializeState())); // through JSON like the file
  const views2 = [];
  const sm2 = makeManager({ createView: (space, tab) => { views2.push(`${space.name}:${tab.url}`); return null; } });
  assert.equal(sm2.restoreState(data), true);

  const { taskSpaces } = sm2.listTaskSpaces();
  assert.equal(taskSpaces.length, 2);
  const research = taskSpaces.find((s) => s.name === 'research');
  assert.equal(research.id, t.id);
  assert.equal(research.ownership, 'agent');
  assert.equal(research.control, 'user'); // restart semantics
  assert.equal(sm2.getSpace(t.id).agentState, 'halfway');
  assert.deepEqual(sm2.getSpace(t.id).tabs.map((x) => x.url), ['about:blank', 'http://a/', 'http://b/']);
  // every restored tab got a view through the hook
  assert.equal(views2.length, 4);
  // id allocator continues past restored ids
  const fresh = sm2.createTaskSpace({ name: 'fresh' });
  assert.ok(fresh.id > t.id);
});

test('resuming an agent space by name after restore flips control back to agent', () => {
  const sm = makeManager();
  sm.createPersonalSpace();
  const t = sm.createTaskSpace({ name: 'resume-me' });
  const data = JSON.parse(JSON.stringify(sm.serializeState()));
  const sm2 = makeManager();
  sm2.restoreState(data);
  assert.equal(sm2.getSpace(t.id).control, 'user');
  const resumed = sm2.createTaskSpace({ name: 'resume-me' });
  assert.equal(resumed.id, t.id);
  assert.equal(sm2.getSpace(t.id).control, 'agent');
});

test('restoreState rejects corrupt data and activeTabIndex is honored', () => {
  const sm = makeManager();
  assert.equal(sm.restoreState(null), false);
  assert.equal(sm.restoreState({ spaces: 'nope' }), false);

  const sm2 = makeManager();
  const t = sm2.createTaskSpace({ name: 'tabs' });
  sm2.createTab(t.id, 'http://one/');
  sm2.createTab(t.id, 'http://two/');
  const space = sm2.getSpace(t.id);
  sm2.activateTab(t.id, space.tabs[1].targetId);
  const data = JSON.parse(JSON.stringify(sm2.serializeState()));
  const sm3 = makeManager();
  sm3.restoreState(data);
  const restored = sm3.getSpace(t.id);
  assert.equal(restored.activeTargetId, restored.tabs[1].targetId);
});
