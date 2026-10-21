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
    if (!s) throw err('EGO_TASK_SPACE_NOT_FOUND', `Task space not found: ${id}`);
    return s;
  }

  #requireAgentControl(space) {
    if (space.control !== 'agent') {
      throw err('EGO_TASK_SPACE_USER_IN_CONTROL', `Task space ${space.id} is under user control`);
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
    for (const s of this.#spaces.values()) {
      if (s.name !== name) continue;
      if (s.ownership === 'agent') return { id: s.id, taskId: s.taskId, name: s.name }; // resume
      throw err('EGO_TASK_SPACE_NAME_IN_USE', `Task space name in use: ${name}`);
    }
    const space = this.#newSpace({ name, createdBy: 'agent', ownership: 'agent', control: 'agent', profileId });
    space.profileName = profileName ?? profileId;
    // ego parity: a new task space starts with Page p1 on a blank tab.
    this.#addTab(space, 'about:blank');
    return { id: space.id, taskId: space.taskId, name: space.name };
  }

  claimTaskSpace({ id, name }) {
    const space = this.requireSpace(id);
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
    if (this.activeSpaceId === id) {
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

  // ---- tabs ----

  #addTab(space, url) {
    const tab = { targetId: `tab-${this.#nextTabNum++}`, view: null, url, title: '' };
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

  addUserTab(id, url) {
    const space = this.requireSpace(id);
    const tab = this.#addTab(space, url);
    return { targetId: tab.targetId, index: space.tabs.length - 1 };
  }

  #findTabIndex(space, targetId) {
    const i = space.tabs.findIndex((t) => t.targetId === targetId);
    if (i < 0) throw err('EGO_INVALID_ARGUMENT', `Tab not found: ${targetId} in space ${space.id}`);
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

  async awaitTargetId(id, targetId) {
    const space = this.requireSpace(id);
    const tab = space.tabs.find((t) => t.targetId === targetId);
    if (!tab) throw err('EGO_INVALID_ARGUMENT', `Tab not found: ${targetId} in space ${id}`);
    if (tab.targetIdReady) {
      const ok = await tab.targetIdReady.then(() => true, () => false);
      if (!ok || tab.targetId.startsWith('tab-')) {
        throw err('EGO_OPERATION_FAILED', `CDP target resolution failed for tab in space ${id}`);
      }
    }
    return tab.targetId;
  }

  async whenTabsReady(id) {
    const space = this.requireSpace(id);
    await Promise.all(space.tabs.map((t) => t.targetIdReady?.catch(() => {}) ?? null));
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
