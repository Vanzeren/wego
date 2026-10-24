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

test('createTaskSpace resumes an agent-owned namesake after a user-owned entry', () => {
  const sm = makeManager();
  const user = sm.createUserSpace('shared');
  const claimant = sm.createUserSpace('claimant');
  const agent = sm.claimTaskSpace({ id: claimant.id, name: 'shared' });

  const resumed = sm.createTaskSpace({ name: 'shared' });
  assert.equal(resumed.id, agent.id);
  assert.equal(sm.getSpace(user.id).ownership, 'user');

  // Claiming a user space to its existing name remains legal even when an
  // agent-owned namesake already exists.
  const claimed = sm.claimTaskSpace({ id: user.id, name: 'shared' });
  assert.equal(claimed.name, 'shared');
  assert.equal(sm.getSpace(user.id).ownership, 'agent');
  assert.equal(sm.getSpace(user.id).control, 'agent');
});

test('claimTaskSpace rejects another agent-owned name without mutating the user space', () => {
  const sm = makeManager();
  const user = sm.createUserSpace('original');
  sm.createTaskSpace({ name: 'occupied' });

  assert.throws(
    () => sm.claimTaskSpace({ id: user.id, name: 'occupied' }),
    (e) => e.error_code === 'WEGO_TASK_SPACE_NAME_IN_USE',
  );
  const space = sm.getSpace(user.id);
  assert.equal(space.name, 'original');
  assert.equal(space.taskId, 'original');
  assert.equal(space.ownership, 'user');
  assert.equal(space.control, 'user');
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

test('takeOverTaskSpace rejects user-owned spaces without changing ownership or control', () => {
  const sm = makeManager();
  const personal = sm.createPersonalSpace();

  assert.throws(() => sm.takeOverTaskSpace({ id: personal.id }));
  assert.equal(sm.getSpace(personal.id).ownership, 'user');
  assert.equal(sm.getSpace(personal.id).control, 'user');
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

test('restoreState rejects null space and tab entries without partial state or views', () => {
  const source = makeManager();
  source.createTaskSpace({ name: 'valid' });
  const valid = source.serializeState().spaces[0];

  for (const spaces of [
    [valid, null],
    [{ ...valid, tabs: [null] }],
  ]) {
    let views = 0;
    const sm = makeManager({ createView: () => { views++; return null; } });
    assert.equal(sm.restoreState({ spaces }), false);
    assert.deepEqual(sm.allSpaces(), []);
    assert.equal(sm.getActive(), null);
    assert.equal(views, 0);
  }
});

test('restoreState rejects duplicate space ids without modifying existing state', () => {
  let views = 0;
  const sm = makeManager({ createView: () => { views++; return null; } });
  const existing = sm.createUserSpace('existing');
  sm.addUserTab(existing.id, 'http://existing/');
  const before = sm.serializeState();
  views = 0;
  const saved = {
    id: 7,
    name: 'restored',
    createdBy: 'agent',
    ownership: 'agent',
    profileId: 'Default',
    profileName: 'Default',
    agentState: '',
    activeTabIndex: 0,
    tabs: [{ url: 'http://restored/', title: '' }],
  };

  assert.equal(sm.restoreState({
    nextSpaceId: 8,
    activeSpaceId: 7,
    spaces: [saved, { ...saved, name: 'duplicate' }],
  }), false);
  assert.deepEqual(sm.serializeState(), before);
  assert.equal(sm.getSpace(existing.id), existing);
  assert.equal(views, 0);
});

test('restoreState allocates new ids above restored ids when nextSpaceId is missing or stale', () => {
  for (const nextSpaceId of [undefined, 2]) {
    const sm = makeManager();
    const saved = {
      id: 7,
      name: 'restored',
      createdBy: 'agent',
      ownership: 'agent',
      profileId: 'Default',
      activeTabIndex: 0,
      tabs: [{ url: 'http://restored/', title: '' }],
    };
    const data = { spaces: [saved], activeSpaceId: 7 };
    if (nextSpaceId !== undefined) data.nextSpaceId = nextSpaceId;

    assert.equal(sm.restoreState(data), true);
    const fresh = sm.createTaskSpace({ name: 'fresh' });
    assert.ok(fresh.id >= 8, `nextSpaceId=${nextSpaceId} produced id ${fresh.id}`);
  }
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

test('moveUserTab reorders within the space, clamps, keeps active tab', () => {
  const sm = makeManager();
  const t = sm.createTaskSpace({ name: 'order' });
  sm.createTab(t.id, 'http://a/');
  sm.createTab(t.id, 'http://b/');
  const space = sm.getSpace(t.id);
  const urls = () => space.tabs.map((x) => x.url);
  assert.deepEqual(urls(), ['about:blank', 'http://a/', 'http://b/']);
  sm.moveUserTab(t.id, space.tabs[2].targetId, 0);
  assert.deepEqual(urls(), ['http://b/', 'about:blank', 'http://a/']);
  // clamp beyond both ends
  sm.moveUserTab(t.id, space.tabs[0].targetId, 99);
  assert.deepEqual(urls(), ['about:blank', 'http://a/', 'http://b/']);
  sm.moveUserTab(t.id, space.tabs[2].targetId, -5);
  assert.deepEqual(urls(), ['http://b/', 'about:blank', 'http://a/']);
  // active follows the tab object, not the slot
  sm.activateTab(t.id, space.tabs[0].targetId);
  sm.moveUserTab(t.id, space.tabs[0].targetId, 2);
  assert.equal(space.activeTargetId, space.tabs[2].targetId);
  assert.throws(() => sm.moveUserTab(t.id, 'nope', 0), /Tab not found/);
  assert.throws(() => sm.moveUserTab(t.id, space.tabs[0].targetId, 1.5), /toIndex/);
  // not gated by agent control (user gesture path)
  sm.handOffTaskSpace({ id: t.id });
  assert.doesNotThrow(() => sm.moveUserTab(t.id, space.tabs[0].targetId, 0));
});

test('createUserSpace: named/default naming, blank tab, becomes active', () => {
  const sm = makeManager();
  sm.createPersonalSpace();
  const named = sm.createUserSpace('  Research  ');
  assert.equal(named.name, 'Research');
  assert.equal(named.ownership, 'user');
  assert.equal(named.tabs.length, 1);
  assert.equal(sm.getActive().id, named.id);
  const anon = sm.createUserSpace('');
  assert.match(anon.name, /^Space \d+$/);
});

test('closing the last tab of a space opens a blank tab (never zero tabs)', () => {
  const sm = makeManager();
  const t = sm.createTaskSpace({ name: 'drain' });
  const space = sm.getSpace(t.id);
  sm.closeTab(t.id, space.tabs[0].targetId);
  assert.equal(space.tabs.length, 1);
  assert.equal(space.tabs[0].url, 'about:blank');
  assert.equal(space.activeTargetId, space.tabs[0].targetId);
  // same via the user path
  sm.closeUserTab(t.id, space.tabs[0].targetId);
  assert.equal(space.tabs.length, 1);
  assert.equal(space.tabs[0].url, 'about:blank');
});

test('closeTaskSpace on the last space auto-creates a fresh Personal space', () => {
  const sm = makeManager();
  const t = sm.createTaskSpace({ name: 'only-space' });
  sm.closeTaskSpace({ id: t.id });
  const all = sm.allSpaces();
  assert.equal(all.length, 1);
  assert.equal(all[0].name, 'Personal');
  assert.equal(all[0].ownership, 'user');
  assert.equal(all[0].control, 'user');
  assert.equal(all[0].tabs.length, 1);
  assert.equal(sm.getActive().id, all[0].id);
});

test('whenTabsReady throws WEGO_OPERATION_FAILED when a tab keeps its placeholder id', async () => {
  const sm = makeManager();
  const t = sm.createTaskSpace({ name: 'pending' });
  const tab = sm.getSpace(t.id).tabs[0];
  tab.targetIdReady = Promise.reject(new Error('marker load aborted'));
  tab.targetIdReady.catch(() => {});
  await assert.rejects(
    () => sm.whenTabsReady(t.id),
    (e) => e.error_code === 'WEGO_OPERATION_FAILED' && e.message.includes(tab.targetId),
  );
  // resolved markers pass through cleanly
  tab.targetIdReady = Promise.resolve('CDP-1');
  sm.noteTargetId(t.id, tab.targetId, 'CDP-1');
  await sm.whenTabsReady(t.id);
});

test('dropUnresolvedTab removes an orphan placeholder and emits spaceChanged', () => {
  const destroyed = [];
  const sm = makeManager({ destroyView: (s, tab) => destroyed.push(tab.targetId) });
  sm.createPersonalSpace();
  const t = sm.createTaskSpace({ name: 'orphan' });
  const space = sm.getSpace(t.id);
  const placeholder = space.tabs[0].targetId;
  let events = 0;
  sm.on('spaceChanged', (id) => { if (id === t.id) events++; });
  sm.dropUnresolvedTab(t.id, placeholder);
  assert.deepEqual(destroyed, [placeholder]);
  // auto-replacement keeps ≥1 tab and the placeholder is gone
  assert.equal(space.tabs.some((tab) => tab.targetId === placeholder), false);
  assert.equal(space.tabs.length, 1);
  assert.ok(events >= 1);
  // no-ops: unknown placeholder, already-swapped id, missing space
  sm.dropUnresolvedTab(t.id, 'tab-999');
  sm.dropUnresolvedTab(999, placeholder);
  assert.equal(space.tabs.length, 1);
});

test('dropUnresolvedTab is a no-op once the real targetId landed', () => {
  const sm = makeManager();
  sm.createPersonalSpace();
  const t = sm.createTaskSpace({ name: 'swapped' });
  const space = sm.getSpace(t.id);
  const placeholder = space.tabs[0].targetId;
  sm.noteTargetId(t.id, placeholder, 'REAL-1');
  sm.dropUnresolvedTab(t.id, placeholder);
  assert.deepEqual(space.tabs.map((tab) => tab.targetId), ['REAL-1']);
});

test('whenTabsReady ignores tabs added while awaiting (add-during-await race)', async () => {
  let resolveLate;
  const sm = makeManager({
    createView(space, tab) {
      tab.targetIdReady = tab.url.includes('late')
        ? new Promise((r) => { resolveLate = r; })
        : Promise.resolve().then(() => sm.noteTargetId(space.id, tab.targetId, `REAL-${tab.targetId}`));
      return null;
    },
  });
  sm.createPersonalSpace();
  const t = sm.createTaskSpace({ name: 'race' });
  // first tab resolves immediately; start the await, then add a tab whose
  // resolution is still pending — it must not fail or hold this call.
  const ready = sm.whenTabsReady(t.id);
  sm.createTab(t.id, 'http://late/');
  await ready; // resolves without throwing despite the pending new tab
  resolveLate();
});

test('closeTaskSpace bypasses the auto-replacement (space fully destroyed)', () => {
  const destroyed = [];
  const sm = makeManager({ destroyView: (s, tab) => destroyed.push(tab.url) });
  sm.createPersonalSpace();
  const t = sm.createTaskSpace({ name: 'gone' });
  sm.createTab(t.id, 'http://x/');
  sm.closeTaskSpace({ id: t.id });
  assert.equal(sm.getSpace(t.id), null);
  // both tabs destroyed, no replacement blank created
  assert.deepEqual(destroyed.sort(), ['about:blank', 'http://x/'].sort());
});

test('closeUserSpace: ungated, destroys views, switches active, never empty', () => {
  const destroyed = [];
  const sm = makeManager({ destroyView: (space, tab) => destroyed.push(tab.targetId) });
  const p = sm.createPersonalSpace();
  sm.addUserTab(p.id, 'http://x/');
  const agentSpace = sm.createTaskSpace({ name: 'agent-work' });
  sm.setActiveSpace(agentSpace.id);
  // ungated: closes even an agent-controlled space
  sm.closeUserSpace(agentSpace.id);
  assert.equal(sm.getSpace(agentSpace.id), null);
  assert.equal(sm.getActive().id, p.id);
  assert.ok(destroyed.length >= 1);
  // closing the last space auto-creates a fresh Personal
  sm.closeUserSpace(p.id);
  assert.equal(sm.listTaskSpaces().taskSpaces.length, 1);
  assert.equal(sm.listTaskSpaces().taskSpaces[0].name, 'Personal');
  assert.ok(sm.getActive());
});
