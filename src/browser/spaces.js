import { EventEmitter } from 'node:events';

function err(code, message) {
  const e = new Error(message);
  e.error_code = code;
  return e;
}

// In-memory space/tab model. Pure state: WebContentsView creation/destruction
// is delegated to hooks injected by window.js. Emits 'spaceChanged' (spaceId)
// and 'taskState' (spaceId, state); bridge.js and window.js subscribe.
export class SpaceManager extends EventEmitter {
  #spaces = new Map();
  #nextSpaceId = 1;
  #nextTabNum = 1;
  #hooks;
  activeSpaceId = null;

  constructor(hooks = {}) {
    super();
    this.#hooks = hooks;
  }

  getSpace(id) {
    return this.#spaces.get(id) ?? null;
  }

  getActive() {
    return this.activeSpaceId == null ? null : this.#spaces.get(this.activeSpaceId) ?? null;
  }

  allSpaces() {
    return [...this.#spaces.values()];
  }

  requireSpace(id) {
    const s = this.#spaces.get(id);
    if (!s) throw err('WEGO_TASK_SPACE_NOT_FOUND', `Task space not found: ${id}`);
    return s;
  }

  #requireAgentControl(space) {
    if (space.control !== 'agent') {
      throw err('WEGO_TASK_SPACE_USER_IN_CONTROL', `Task space ${space.id} is under user control`);
    }
  }

  #changed(space) {
    this.emit('spaceChanged', space.id);
  }

  #describe(space) {
    return {
      id: space.id,
      taskId: space.taskId,
      name: space.name,
      createdBy: space.createdBy,
      ownership: space.ownership,
      control: space.control,
      profileId: space.profileId,
      profileName: space.profileName ?? space.profileId,
      recentTabTitles: [...space.recentTabTitles],
    };
  }

  #newSpace({ name, createdBy, ownership, control, profileId }) {
    const space = {
      id: this.#nextSpaceId++,
      // ego parity: taskId is a display-name compatibility field, same as name.
      taskId: name,
      name,
      createdBy,
      ownership,
      control,
      profileId,
      tabs: [],
      activeTargetId: null,
      agentState: '',
      recentTabTitles: [],
    };
    this.#spaces.set(space.id, space);
    return space;
  }

  createPersonalSpace() {
    const space = this.#newSpace({
      name: 'Personal', createdBy: 'user', ownership: 'user', control: 'user', profileId: 'Default',
    });
    if (this.activeSpaceId == null) this.activeSpaceId = space.id;
    return space;
  }

  // UI path: create a user-owned space with one blank tab and switch to it.
  createUserSpace(name) {
    const trimmed = typeof name === 'string' && name.trim() ? name.trim() : `Space ${this.#nextSpaceId}`;
    const space = this.#newSpace({
      name: trimmed, createdBy: 'user', ownership: 'user', control: 'user', profileId: 'Default',
    });
    this.#addTab(space, 'about:blank');
    this.setActiveSpace(space.id);
    return space;
  }

  // Never leave zero spaces behind: the chrome needs at least one.
  #ensureSpaceRemains() {
    if (this.#spaces.size === 0) {
      const personal = this.createPersonalSpace();
      this.addUserTab(personal.id, 'about:blank');
    }
  }

  // UI path: close any space regardless of control state (the user owns the
  // browser; an agent driving the closed space gets WEGO_TASK_SPACE_NOT_FOUND
  // on its next call). Never leaves zero spaces behind.
  closeUserSpace(id) {
    const space = this.requireSpace(id);
    for (const tab of [...space.tabs]) {
      try { this.#hooks.destroyView?.(space, tab); } catch { /* view already gone */ }
    }
    this.#spaces.delete(id);
    this.#ensureSpaceRemains();
    if (this.activeSpaceId === id || !this.#spaces.has(this.activeSpaceId)) {
      this.activeSpaceId = this.#spaces.keys().next().value ?? null;
    }
    this.emit('spaceChanged', id);
    return `${id} space closed.`;
  }

  setActiveSpace(id) {
    const space = this.requireSpace(id);
    if (this.activeSpaceId !== id) {
      this.activeSpaceId = id;
      this.#changed(space);
    }
  }

  listTaskSpaces() {
    return { taskSpaces: [...this.#spaces.values()].map((s) => this.#describe(s)) };
  }

  createTaskSpace({ name, profileId = 'Default', profileName }) {
    let userOwnedName = false;
    for (const s of this.#spaces.values()) {
      if (s.name !== name) continue;
      if (s.ownership === 'agent') {
        // Resume (also after a restart, where control reset to user).
        if (s.control !== 'agent') {
          s.control = 'agent';
          this.#changed(s);
        }
        return { id: s.id, taskId: s.taskId, name: s.name };
      }
      userOwnedName = true;
    }
    if (userOwnedName) throw err('WEGO_TASK_SPACE_NAME_IN_USE', `Task space name in use: ${name}`);
    const space = this.#newSpace({ name, createdBy: 'agent', ownership: 'agent', control: 'agent', profileId });
    space.profileName = profileName ?? profileId;
    // ego parity: a new task space starts with Page p1 on a blank tab.
    this.#addTab(space, 'about:blank');
    return { id: space.id, taskId: space.taskId, name: space.name };
  }

  claimTaskSpace({ id, name }) {
    const space = this.requireSpace(id);
    if (name && name !== space.name) {
      for (const other of this.#spaces.values()) {
        if (other !== space && other.ownership === 'agent' && other.name === name) {
          throw err('WEGO_TASK_SPACE_NAME_IN_USE', `Task space name in use: ${name}`);
        }
      }
    }
    space.ownership = 'agent';
    space.control = 'agent';
    if (name) space.name = name;
    space.taskId = space.name;
    this.#changed(space);
    return { id: space.id, taskId: space.taskId, name: space.name };
  }

  closeTaskSpace({ id }) {
    const space = this.requireSpace(id);
    this.#requireAgentControl(space);
    for (const tab of space.tabs) {
      try { this.#hooks.destroyView?.(space, tab); } catch { /* view already gone */ }
    }
    this.#spaces.delete(id);
    this.#ensureSpaceRemains(); // same zero-space fallback as closeUserSpace
    if (this.activeSpaceId === id || !this.#spaces.has(this.activeSpaceId)) {
      this.activeSpaceId = this.#spaces.keys().next().value ?? null;
    }
    this.emit('spaceChanged', id);
    return `${id} task space closed.`;
  }

  completeTaskSpace({ id }) {
    const space = this.requireSpace(id);
    this.#requireAgentControl(space);
    space.ownership = 'user';
    space.control = 'user';
    this.#changed(space);
    return `${id} task space completed.`;
  }

  handOffTaskSpace({ id }) {
    const space = this.requireSpace(id);
    space.control = 'user';
    this.#changed(space);
    return `${id} has been handed off to the user.`;
  }

  takeOverTaskSpace({ id }) {
    const space = this.requireSpace(id);
    if (space.ownership !== 'agent') {
      throw err('WEGO_TASK_SPACE_USER_IN_CONTROL', `Task space ${id} is user-owned`);
    }
    space.control = 'agent';
    this.#changed(space);
    return `${id} has been taken over by the agent.`;
  }

  setAgentTaskState({ id, state }) {
    const space = this.requireSpace(id);
    this.#requireAgentControl(space);
    space.agentState = state;
    this.emit('taskState', id, state);
    return `${id} state updated.`;
  }

  // ---- persistence ----

  // Snapshot of restorable state. Control is intentionally NOT persisted:
  // after a browser restart no agent is attached, so every space comes back
  // under user control; an agent regains control by resuming (createTaskSpace
  // on an agent-owned name flips control back) or claimTaskSpace.
  serializeState() {
    return {
      nextSpaceId: this.#nextSpaceId,
      activeSpaceId: this.activeSpaceId,
      spaces: [...this.#spaces.values()].map((s) => ({
        id: s.id,
        name: s.name,
        createdBy: s.createdBy,
        ownership: s.ownership,
        profileId: s.profileId,
        profileName: s.profileName,
        agentState: s.agentState,
        activeTabIndex: Math.max(0, s.tabs.findIndex((t) => t.targetId === s.activeTargetId)),
        tabs: s.tabs.map((t) => ({ url: t.url, title: t.title })),
      })),
    };
  }

  // Rebuild spaces from serializeState() data. Views are created lazily
  // through the same hook as live tabs (marker → real targetId → real URL).
  restoreState(data) {
    if (!data || !Array.isArray(data.spaces) || data.spaces.length === 0) return false;

    // Validate the complete snapshot before mutating spaces, ids, or views.
    const ids = new Set();
    let maxId = 0;
    for (const saved of data.spaces) {
      if (!saved || typeof saved !== 'object' || !Number.isInteger(saved.id) || saved.id < 1 || ids.has(saved.id)) {
        return false;
      }
      ids.add(saved.id);
      maxId = Math.max(maxId, saved.id);
      if (Array.isArray(saved.tabs)) {
        for (const tab of saved.tabs) {
          if (!tab || typeof tab !== 'object') return false;
        }
      }
    }

    for (const saved of data.spaces) {
      const space = {
        id: saved.id,
        taskId: saved.name, // ego parity: taskId === name
        name: saved.name,
        createdBy: saved.createdBy === 'agent' ? 'agent' : 'user',
        ownership: saved.ownership === 'agent' ? 'agent' : 'user',
        control: 'user', // restart: no agent attached
        profileId: saved.profileId || 'Default',
        profileName: saved.profileName ?? saved.profileId ?? 'Default',
        tabs: [],
        activeTargetId: null,
        agentState: typeof saved.agentState === 'string' ? saved.agentState : '',
        recentTabTitles: [],
      };
      this.#spaces.set(space.id, space);
      const tabs = Array.isArray(saved.tabs) && saved.tabs.length ? saved.tabs : [{ url: 'about:blank', title: '' }];
      for (const t of tabs) this.#addTab(space, typeof t.url === 'string' && t.url ? t.url : 'about:blank');
      const idx = Math.min(saved.activeTabIndex ?? 0, tabs.length - 1);
      if (space.tabs[idx]) space.activeTargetId = space.tabs[idx].targetId;
    }
    const savedNextSpaceId = Number.isInteger(data.nextSpaceId) ? data.nextSpaceId : 1;
    this.#nextSpaceId = Math.max(this.#nextSpaceId, savedNextSpaceId, maxId + 1);
    this.activeSpaceId = this.#spaces.has(data.activeSpaceId)
      ? data.activeSpaceId
      : (this.#spaces.keys().next().value ?? null);
    return true;
  }

  // ---- tabs ----

  #addTab(space, url, openerTargetId = null) {
    const tab = { targetId: `tab-${this.#nextTabNum++}`, view: null, url, title: '', openerTargetId };
    tab.view = this.#hooks.createView?.(space, tab) ?? null;
    space.tabs.push(tab);
    space.activeTargetId = tab.targetId;
    this.#changed(space);
    return tab;
  }

  createTab(id, url) {
    const space = this.requireSpace(id);
    this.#requireAgentControl(space);
    const tab = this.#addTab(space, url);
    return { targetId: tab.targetId, index: space.tabs.length - 1 };
  }

  addUserTab(id, url, openerTargetId = null) {
    const space = this.requireSpace(id);
    const tab = this.#addTab(space, url, openerTargetId);
    return { targetId: tab.targetId, index: space.tabs.length - 1 };
  }

  #findTabIndex(space, targetId) {
    const i = space.tabs.findIndex((t) => t.targetId === targetId);
    if (i < 0) throw err('WEGO_INVALID_ARGUMENT', `Tab not found: ${targetId} in space ${space.id}`);
    return i;
  }

  #removeTab(space, targetId) {
    const i = this.#findTabIndex(space, targetId);
    const [tab] = space.tabs.splice(i, 1);
    try { this.#hooks.destroyView?.(space, tab); } catch { /* view already gone */ }
    if (space.activeTargetId === targetId) {
      const next = space.tabs[Math.min(i, space.tabs.length - 1)];
      space.activeTargetId = next ? next.targetId : null;
    }
    // A space always keeps at least one tab: with none, the layout would keep
    // showing whatever other space's view was last raised. (Space teardown
    // paths — closeTaskSpace/closeUserSpace — bypass this hook.)
    if (space.tabs.length === 0) {
      this.#addTab(space, 'about:blank');
      return;
    }
    this.#changed(space);
  }

  closeTab(id, targetId) {
    const space = this.requireSpace(id);
    this.#requireAgentControl(space);
    this.#removeTab(space, targetId);
    return { closed: true };
  }

  closeUserTab(id, targetId) {
    const space = this.requireSpace(id);
    this.#removeTab(space, targetId);
    return { closed: true };
  }

  #activate(space, targetId) {
    this.#findTabIndex(space, targetId);
    space.activeTargetId = targetId;
    this.#changed(space);
  }

  activateTab(id, targetId) {
    const space = this.requireSpace(id);
    this.#requireAgentControl(space);
    this.#activate(space, targetId);
    return { activated: true };
  }

  #moveTabImpl(space, targetId, toIndex) {
    const from = this.#findTabIndex(space, targetId);
    if (!Number.isInteger(toIndex)) throw err('WEGO_INVALID_ARGUMENT', 'toIndex must be an integer');
    const [tab] = space.tabs.splice(from, 1);
    const clamped = Math.max(0, Math.min(toIndex, space.tabs.length));
    space.tabs.splice(clamped, 0, tab);
    this.#changed(space);
    return { moved: true, from, to: clamped };
  }

  // Reorder a tab within its space; order persists via spaces.json.
  // UI path (user gesture in the chrome): not gated by agent control.
  moveUserTab(id, targetId, toIndex) {
    const space = this.requireSpace(id);
    return this.#moveTabImpl(space, targetId, toIndex);
  }

  activateUserTab(id, targetId) {
    const space = this.requireSpace(id);
    this.#activate(space, targetId);
    return { activated: true };
  }

  listTabs(id) {
    const space = this.requireSpace(id);
    this.#requireAgentControl(space); // ego parity: listTabs is gated too
    return {
      tabs: space.tabs.map((t, i) => ({
        index: i,
        targetId: t.targetId,
        url: t.url,
        title: t.title,
        active: t.targetId === space.activeTargetId,
      })),
    };
  }

  // ---- view event feeds (called by window.js) ----

  // Swap the placeholder tab-N id for the real Chromium CDP targetId once
  // window.js resolves it. tab.targetIdReady (set by the createView hook)
  // gates bridge responses so placeholder ids never leak to the SDK.
  noteTargetId(id, oldTargetId, newTargetId) {
    const space = this.#spaces.get(id);
    const tab = space?.tabs.find((t) => t.targetId === oldTargetId);
    if (!tab) return;
    tab.targetId = newTargetId;
    if (space.activeTargetId === oldTargetId) space.activeTargetId = newTargetId;
    this.emit('spaceChanged', id);
  }

  // A tab whose CDP targetId resolution failed (view/renderer died before the
  // debugger could resolve the real id) would wedge awaitTargetId/whenTabsReady
  // forever with its placeholder tab-N id. Called from the createView hook's
  // rejection path: drop the tab only if it is still that same placeholder
  // (a successful noteTargetId swap or explicit close makes this a no-op).
  dropUnresolvedTab(id, placeholderId) {
    const space = this.#spaces.get(id);
    if (!space) return;
    if (!space.tabs.some((t) => t.targetId === placeholderId)) return;
    this.#removeTab(space, placeholderId); // emits spaceChanged; keeps ≥1 tab
  }

  async awaitTargetId(id, targetId) {
    const space = this.requireSpace(id);
    const tab = space.tabs.find((t) => t.targetId === targetId);
    if (!tab) throw err('WEGO_INVALID_ARGUMENT', `Tab not found: ${targetId} in space ${id}`);
    if (tab.targetIdReady) {
      const ok = await tab.targetIdReady.then(() => true, () => false);
      if (!ok || tab.targetId.startsWith('tab-')) {
        throw err('WEGO_OPERATION_FAILED', `CDP target resolution failed for tab in space ${id}`);
      }
    }
    return tab.targetId;
  }

  async whenTabsReady(id) {
    const space = this.requireSpace(id);
    // Snapshot the awaited set: a tab added WHILE we await has no resolution
    // guarantee and must not fail (or be failed by) this call.
    const awaited = [...space.tabs];
    await Promise.all(awaited.map((t) => t.targetIdReady?.catch(() => {}) ?? null));
    // Fail like awaitTargetId: a tab whose marker resolution failed would
    // otherwise leak its placeholder tab-N id into bridge listTabs responses.
    const stale = awaited.find((t) => t.targetId.startsWith('tab-') && space.tabs.includes(t));
    if (stale) {
      throw err('WEGO_OPERATION_FAILED', `CDP target resolution failed for tab ${stale.targetId} in space ${id}`);
    }
  }

  noteUrl(id, targetId, url) {
    const tab = this.#spaces.get(id)?.tabs.find((t) => t.targetId === targetId);
    if (!tab || tab.url === url) return;
    tab.url = url;
    this.emit('spaceChanged', id);
  }

  noteTitle(id, targetId, title) {
    const space = this.#spaces.get(id);
    const tab = space?.tabs.find((t) => t.targetId === targetId);
    if (!tab || tab.title === title) return;
    tab.title = title;
    if (title && space.recentTabTitles[0] !== title) {
      space.recentTabTitles.unshift(title);
      if (space.recentTabTitles.length > 5) space.recentTabTitles.length = 5;
    }
    this.emit('spaceChanged', id);
  }

  serializeAll() {
    return {
      activeSpaceId: this.activeSpaceId,
      spaces: [...this.#spaces.values()].map((s) => ({
        ...this.#describe(s),
        agentState: s.agentState,
        activeTargetId: s.activeTargetId,
        tabs: s.tabs.map((t) => ({ targetId: t.targetId, url: t.url, title: t.title })),
      })),
    };
  }
}
