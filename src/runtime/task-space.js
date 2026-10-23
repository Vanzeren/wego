// TaskSpace: v2 SDK surface over one bridge task space.
// Owns the label→Page mapping; 'p1' is the space's first tab.

import { Page } from './page.js';
import { CDPError } from './cdp.js';

export class TaskSpace {
  // ctx: { ego, cdp (CDPManager) }
  constructor(ctx, descriptor) {
    this._ctx = ctx;
    this.spaceId = descriptor.id;
    this.taskId = descriptor.taskId;
    this.name = descriptor.name;
    this.ownership = descriptor.ownership || 'agent';
    this._pages = new Map(); // label -> Page
    this._nextLabel = 1;
    this._knownTargets = new Set();
    this._finished = false;

    const ego = ctx.ego;
    ego.useTaskSpace(this.spaceId);

    // popups/new tabs discovered via Target.targetCreated get labels on demand
    this._popupDiscovery = ctx.cdp.browser.on('Target.targetCreated', (p) => {
      const info = p.targetInfo;
      if (!info || info.type !== 'page') return;
      // browser-level events carry openerTargetId for window.open popups
      if (info.openerTargetId && this._knownTargets.has(info.openerTargetId)) {
        this._adoptTarget(info.targetId, 'agent');
      }
    });
  }

  // ---- page management ----

  _adoptTarget(targetId, openedBy, label) {
    if (this._knownTargets.has(targetId)) {
      for (const p of this._pages.values()) if (p.targetId === targetId) return p;
    }
    const lbl = label || `p${this._nextLabel++}`;
    const page = new Page(this, lbl, targetId, openedBy);
    this._pages.set(lbl, page);
    this._knownTargets.add(targetId);
    return page;
  }

  _ownsTarget(targetId) { return this._knownTargets.has(targetId); }

  _labelForTarget(targetId) {
    for (const [label, p] of this._pages) if (p.targetId === targetId) return label;
    return this._adoptTarget(targetId, 'agent').label;
  }

  _removePage(label) {
    const p = this._pages.get(label);
    if (p) this._knownTargets.delete(p.targetId);
    this._pages.delete(label);
  }

  // sync handle by label; auto-adopts 'p1' etc. only for existing labels
  page(label = 'p1') {
    const p = this._pages.get(label);
    if (!p) throw new CDPError(`No page with label ${JSON.stringify(label)} in task space ${this.spaceId}`, 'WEGO_OPERATION_FAILED');
    return p;
  }

  pages() { return [...this._pages.values()]; }

  async tabs() {
    const ego = this._ctx.ego;
    ego.useTaskSpace(this.spaceId);
    const { tabs } = await ego._call('listTabs', { id: this.spaceId });
    return tabs.map((t) => {
      let label;
      for (const [l, p] of this._pages) if (p.targetId === t.targetId) label = l;
      return {
        label,
        page: label ? this._pages.get(label) : undefined,
        targetId: t.targetId,
        title: t.title,
        url: t.url,
        active: t.active,
        openedBy: label ? this._pages.get(label).openedBy : 'unknown',
      };
    });
  }

  async newPage(url = 'about:blank') {
    const ego = this._ctx.ego;
    ego.useTaskSpace(this.spaceId);
    const { targetId } = await ego._call('createTab', { id: this.spaceId, url });
    return this._adoptTarget(targetId, 'agent');
  }

  // adopt an existing tab descriptor or Page from another space
  async adopt(tabOrPage, { as } = {}) {
    const targetId = tabOrPage.targetId;
    if (!targetId) throw Object.assign(new TypeError('adopt expects a tab descriptor or Page'), { error_code: 'WEGO_INVALID_ARGUMENT' });
    return this._adoptTarget(targetId, tabOrPage.openedBy || 'agent', as);
  }

  async release(label) {
    const p = this._pages.get(label);
    if (!p) throw new CDPError(`No page with label ${JSON.stringify(label)}`, 'WEGO_OPERATION_FAILED');
    // detach our CDP session but leave the tab alive for the user
    const session = this._ctx.cdp.sessionFor(p.targetId);
    if (session) {
      await this._ctx.cdp.browser.send('Target.detachFromTarget', { sessionId: session.sessionId }).catch(() => {});
    }
    this._removePage(label);
  }

  async userPage() {
    // the tab the user is looking at: the space's active tab
    const tabs = await this.tabs();
    const active = tabs.find((t) => t.active) || tabs[0];
    if (!active) return null;
    return active.page || this._adoptTarget(active.targetId, 'user');
  }

  // ---- lifecycle ----

  async handOff() {
    const ego = this._ctx.ego;
    ego.useTaskSpace(this.spaceId);
    const result = await ego.handOffTaskSpace();
    this.ownership = 'user';
    return result;
  }

  // exactly-once: keep-labels' tabs detach to user, agent tabs closed,
  // then completeTaskSpace when keeps remain else closeTaskSpace.
  async finish({ keep = [] } = {}) {
    if (this._finished) return;
    this._finished = true;
    this._popupDiscovery?.(); // drop the shared browser-session listener
    this._popupDiscovery = null;
    const ego = this._ctx.ego;
    ego.useTaskSpace(this.spaceId);
    const keepSet = new Set(keep);
    for (const [label, p] of [...this._pages]) {
      if (keepSet.has(label)) {
        const session = this._ctx.cdp.sessionFor(p.targetId);
        if (session) {
          await this._ctx.cdp.browser.send('Target.detachFromTarget', { sessionId: session.sessionId }).catch(() => {});
        }
        this._removePage(label);
      } else {
        await ego._call('closeTab', { id: this.spaceId, targetId: p.targetId }).catch(() => {});
        this._removePage(label);
      }
    }
    if (keep.length) {
      await ego.completeTaskSpace().catch(() => {});
    } else {
      await ego.closeTaskSpace().catch(() => {});
    }
  }

  async waitForControl({ timeout = 60_000 } = {}) {
    const ego = this._ctx.ego;
    const deadline = Date.now() + timeout;
    for (;;) {
      const { taskSpaces } = await ego.listTaskSpaces();
      const mine = taskSpaces.find((s) => s.id === this.spaceId);
      if (!mine) throw new CDPError(`Task space ${this.spaceId} no longer exists`, 'WEGO_TASK_SPACE_NOT_FOUND');
      if (mine.control === 'agent') return mine;
      if (Date.now() >= deadline) throw new CDPError(`waitForControl timed out for space ${this.spaceId}`, 'WEGO_OPERATION_FAILED');
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async cdp(method, params = {}) {
    return this._ctx.cdp.browser.send(method, params);
  }
}
