// VirtualCdpServer: emulates the Chromium browser-level CDP endpoint
// in-process, replacing the unauthenticated TCP DevTools server. Clients
// (bridge connections, the main-process snapshot engine) each get one
// virtual BROWSER session; page/frame sessions ride on the owning tab's
// webContents.debugger — one real root debugger per webContents, refcounted,
// with ALL debugger traffic serialized through a per-webContents promise
// queue.
//
// Empirically verified delivery shapes (Electron 38):
// - webContents.debugger 'message' handler: (event, method, params, sessionId?)
//   — child-session events carry the real sessionId as the 4th argument;
//   root-session events have it empty/undefined.
// - Target.attachedToTarget / Target.detachedFromTarget arrive as root-session
//   events with the sessionId INSIDE params.
// - Target.getTargetInfo on the root session returns this tab's targetInfo.
// - Target.getTargets on the root session is browser-context-wide (NOT scoped
//   to the tab), so OOPIF enumeration instead uses a short-lived
//   Target.setAutoAttach cycle: attachedToTarget events on a tab's root name
//   exactly that tab's own iframe children.
// - Target.attachToTarget {targetId, flatten:true} on the root session opens
//   a real child session to an OOPIF; commands route via
//   dbg.sendCommand(method, params, realChildSid).

function cdpError(code, message) {
  const e = new Error(message);
  e.cdpCode = code;
  return e;
}

const notFound = (method) => cdpError(-32601, `'${method}' wasn't found`);
const noSuchSession = () => cdpError(-32000, 'No session with given id found');
const noSuchTarget = () => cdpError(-32000, 'No target with given id found');

export class VirtualCdpServer {
  // listTargets: () => [{ targetId, type:'page', url, title }] — real ids only
  // resolveWc: (targetId) => webContents|null
  constructor({ listTargets, resolveWc } = {}) {
    this._listTargets = listTargets ?? (() => []);
    this._resolveWc = resolveWc ?? (() => null);
    this._clients = new Set();
    this._records = new Map(); // webContents -> record
    this._sessions = new Map(); // virtual sessionId -> virtual session
    this._iframeIndex = new Map(); // iframe targetId -> parent webContents
    this._knownTargets = new Map(); // page targetId -> { url, title } (discovery diff)
    this._nextSessionNum = 1;
  }

  // ---- client lifecycle ------------------------------------------------

  // openClient(push) → { handleMessage(msg), close() }
  // push(obj) receives CDP responses/events byte-identical in shape to what
  // the DevTools WebSocket sent: {id,result,sessionId?} | {id,error,sessionId?}
  // | {method,params,sessionId?}.
  openClient(push) {
    const client = { push, discover: false, sessions: new Set(), closed: false };
    this._clients.add(client);
    return {
      handleMessage: (msg) => this._handle(client, msg),
      close: () => this._closeClient(client),
    };
  }

  async _closeClient(client) {
    if (client.closed) return;
    client.closed = true;
    this._clients.delete(client);
    for (const sid of [...client.sessions]) {
      const vs = this._sessions.get(sid);
      if (vs) await this._detachSession(vs).catch(() => {});
    }
  }

  // ---- tab-target discovery pushes (wired from window.js spaceChanged) --

  notifyTargetsChanged() {
    const current = new Map();
    for (const t of this._listTargets()) {
      current.set(t.targetId, { url: t.url ?? '', title: t.title ?? '' });
    }
    const subscribers = [...this._clients].filter((c) => c.discover && !c.closed);
    if (subscribers.length) {
      const info = (targetId, { url, title }) => ({
        targetId, type: 'page', url, title, attached: true, canAccessOpener: false,
      });
      for (const [targetId, meta] of current) {
        const prev = this._knownTargets.get(targetId);
        for (const c of subscribers) {
          if (!prev) this._push(c, { method: 'Target.targetCreated', params: { targetInfo: info(targetId, meta) } });
          else if (prev.url !== meta.url || prev.title !== meta.title) {
            this._push(c, { method: 'Target.targetInfoChanged', params: { targetInfo: info(targetId, meta) } });
          }
        }
      }
      for (const targetId of this._knownTargets.keys()) {
        if (!current.has(targetId)) {
          for (const c of subscribers) this._push(c, { method: 'Target.targetDestroyed', params: { targetId } });
        }
      }
    }
    this._knownTargets = current;
  }

  // ---- targetId resolution for views.js (replaces the marker flow) -----

  async resolveTargetId(wc) {
    const record = await this._acquire(wc);
    try {
      const { targetInfo } = await this._cmd(record, 'Target.getTargetInfo');
      return targetInfo.targetId;
    } finally {
      await this._release(wc);
    }
  }

  // ---- per-webContents root debugger management -------------------------

  _newRecord(wc) {
    return {
      wc,
      refCount: 0,
      queue: Promise.resolve(),
      attached: false,
      dead: false,
      domains: new Map(), // domain -> Set<virtualSid> (page sessions)
      autoAttachArmed: new Set(), // virtual page session ids
      autoAttachApplied: false,
      children: new Map(), // realSid -> { targetId, title, url, owners: Map<virtualSid, vs> }
      pendingUnknown: new Map(), // realSid -> buffered events (in-flight attaches)
      enumerating: null, // Map<realSid, targetInfo> while an enumeration cycle runs
      enumPromise: null, // in-flight _enumerateRecordFrames (shared)
      onMessage: null,
      onDetach: null,
      onDestroyed: null,
    };
  }

  _enqueue(record, fn) {
    const run = record.queue.then(() => fn());
    record.queue = run.catch(() => {});
    return run;
  }

  _cmd(record, method, params = {}, sessionId) {
    return this._enqueue(record, async () => {
      if (record.dead || !record.attached || record.wc.isDestroyed()) {
        throw cdpError(-32000, 'Target closed');
      }
      // A sendCommand issued across a renderer swap can settle NEVER; the
      // whole per-wc queue serializes behind it, so cap the wait — a jammed
      // entry must not wedge the tab's debugger traffic for good.
      let timer;
      try {
        return await Promise.race([
          record.wc.debugger.sendCommand(method, params, sessionId),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(cdpError(-32000, `CDP command timed out: ${method}`)), 30_000);
            timer.unref?.();
          }),
        ]);
      } catch (e) {
        throw e?.cdpCode ? e : cdpError(-32000, e?.message ?? String(e));
      } finally {
        clearTimeout(timer);
      }
    });
  }

  async _acquire(wc) {
    if (!wc || wc.isDestroyed()) throw cdpError(-32000, 'Target closed');
    let record = this._records.get(wc);
    if (record?.dead) {
      this._records.delete(wc);
      record = null;
    }
    if (!record) {
      record = this._newRecord(wc);
      this._records.set(wc, record);
    }
    record.refCount++;
    await this._enqueue(record, async () => {
      if (record.attached || record.dead || wc.isDestroyed()) return;
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      record.attached = true;
      this._wire(record);
    });
    if (record.dead || !record.attached || wc.isDestroyed()) {
      record.refCount--;
      throw cdpError(-32000, 'Target closed');
    }
    return record;
  }

  async _release(wc) {
    const record = this._records.get(wc);
    if (!record) return;
    record.refCount--;
    if (record.refCount > 0) return;
    await this._enqueue(record, async () => {
      if (record.refCount > 0 || record.dead) return; // re-acquired meanwhile
      record.attached = false;
      const dbg = wc.debugger;
      try { dbg.removeListener('message', record.onMessage); } catch { /* gone */ }
      try { dbg.removeListener('detach', record.onDetach); } catch { /* gone */ }
      try { wc.removeListener('destroyed', record.onDestroyed); } catch { /* gone */ }
      try { if (!wc.isDestroyed() && dbg.isAttached()) dbg.detach(); } catch { /* gone */ }
    }).catch(() => {});
    if (record.refCount <= 0 && this._records.get(wc) === record) {
      this._records.delete(wc);
    }
  }

  _wire(record) {
    const dbg = record.wc.debugger;
    record.onMessage = (_event, method, params, sessionId) => {
      this._onDebuggerMessage(record, method, params, sessionId || undefined);
    };
    record.onDetach = () => this._onDebuggerDetach(record);
    record.onDestroyed = () => this._onDebuggerDetach(record);
    dbg.on('message', record.onMessage);
    dbg.on('detach', record.onDetach);
    record.wc.once('destroyed', record.onDestroyed);
  }

  // Renderer crash / tab close / external detach: synthesize
  // Target.detachedFromTarget for every virtual session on this webContents
  // (the SDK's auto-reattach flow depends on these) and drop the record.
  _onDebuggerDetach(record) {
    if (record.dead) return;
    record.dead = true;
    record.attached = false;
    for (const vs of [...this._sessions.values()]) {
      if (vs.wc !== record.wc || vs.detached) continue;
      vs.detached = true;
      this._sessions.delete(vs.id);
      vs.client.sessions.delete(vs.id);
      this._push(vs.client, { method: 'Target.detachedFromTarget', params: { sessionId: vs.id } });
    }
    this._records.delete(record.wc);
  }

  // ---- debugger event routing -------------------------------------------

  _onDebuggerMessage(record, method, params, realSid) {
    if (realSid) {
      const child = record.children.get(realSid);
      if (!child) {
        // Event for a child session whose attach is still resolving
        // (Target.attachedToTarget can precede the command response).
        const buf = record.pendingUnknown.get(realSid) ?? [];
        if (buf.length < 100) buf.push({ method, params });
        record.pendingUnknown.set(realSid, buf);
        return;
      }
      const domain = method.split('.')[0];
      for (const vs of child.owners.values()) {
        if (vs.detached || !vs.domains.has(domain)) continue;
        this._push(vs.client, { method, params, sessionId: vs.id });
      }
      return;
    }

    if (method === 'Target.attachedToTarget') {
      this._onChildAttached(record, params ?? {});
      return;
    }
    if (method === 'Target.detachedFromTarget') {
      this._onChildDetached(record, params ?? {});
      return;
    }

    // Root-session domain event: only to virtual page sessions that enabled it.
    const domain = method.split('.')[0];
    const set = record.domains.get(domain);
    if (!set) return;
    for (const vsId of set) {
      const vs = this._sessions.get(vsId);
      if (!vs || vs.detached) continue;
      this._push(vs.client, { method, params, sessionId: vsId });
    }
  }

  _onChildAttached(record, params) {
    const realSid = params.sessionId;
    const targetInfo = params.targetInfo ?? {};
    if (!realSid) return;
    if (record.enumerating) {
      // Short-lived enumeration cycle owns these; it detaches them after.
      record.enumerating.set(realSid, targetInfo);
      return;
    }
    if (record.children.has(realSid)) return; // explicit attach already mapped
    if (!record.autoAttachArmed.size) {
      // No virtual page session armed auto-attach: an explicit
      // Target.attachToTarget is in flight and will claim this realSid.
      if (!record.pendingUnknown.has(realSid)) record.pendingUnknown.set(realSid, []);
      return;
    }
    const owners = new Map();
    for (const pageSid of record.autoAttachArmed) {
      const pageVs = this._sessions.get(pageSid);
      if (!pageVs || pageVs.detached) continue;
      const childVs = this._newSession(pageVs.client, {
        kind: 'frame', targetId: targetInfo.targetId, wc: record.wc, realSid, holdsRef: false,
        parentSid: pageVs.id,
      });
      owners.set(childVs.id, childVs);
      this._push(pageVs.client, {
        method: 'Target.attachedToTarget',
        params: { ...params, sessionId: childVs.id },
        sessionId: pageVs.id,
      });
    }
    if (!owners.size) return;
    const child = { targetId: targetInfo.targetId, title: targetInfo.title, url: targetInfo.url, owners };
    record.children.set(realSid, child);
    this._flushPending(record, realSid, child);
  }

  _onChildDetached(record, params) {
    const realSid = params.sessionId;
    record.pendingUnknown.delete(realSid);
    const child = record.children.get(realSid);
    if (!child) return;
    record.children.delete(realSid);
    for (const vs of child.owners.values()) {
      if (vs.detached) continue;
      vs.detached = true;
      this._sessions.delete(vs.id);
      vs.client.sessions.delete(vs.id);
      // Browser-level notification (no sessionId field) — the SDK's
      // auto-reattach keys off params.sessionId on the browser session.
      this._push(vs.client, { method: 'Target.detachedFromTarget', params: { sessionId: vs.id } });
      if (vs.holdsRef) void this._release(vs.wc);
    }
  }

  _flushPending(record, realSid, child) {
    const buffered = record.pendingUnknown.get(realSid);
    record.pendingUnknown.delete(realSid);
    if (!buffered) return;
    for (const { method, params } of buffered) {
      const domain = method.split('.')[0];
      for (const vs of child.owners.values()) {
        if (vs.detached || !vs.domains.has(domain)) continue;
        this._push(vs.client, { method, params, sessionId: vs.id });
      }
    }
  }

  // ---- message dispatch --------------------------------------------------

  async _handle(client, msg) {
    if (client.closed || !msg || typeof msg.method !== 'string') return;
    const { id, method, sessionId } = msg;
    const params = msg.params ?? {};
    try {
      let result;
      if (sessionId) {
        const vs = this._sessions.get(sessionId);
        if (!vs || vs.client !== client || vs.detached) throw noSuchSession();
        result = await this._sessionCommand(vs, method, params);
      } else {
        result = await this._browserCommand(client, method, params);
      }
      if (id !== undefined) {
        this._push(client, { id, result: result ?? {}, ...(sessionId ? { sessionId } : {}) });
      }
    } catch (e) {
      if (id !== undefined) {
        this._push(client, {
          id,
          error: { code: e?.cdpCode ?? -32000, message: e?.message ?? String(e) },
          ...(sessionId ? { sessionId } : {}),
        });
      }
    }
  }

  async _browserCommand(client, method, params) {
    switch (method) {
      case 'Target.getTargets':
        return { targetInfos: await this._collectTargets() };

      case 'Target.setDiscoverTargets': {
        client.discover = !!params.discover;
        if (client.discover) {
          // Chromium replays existing targets as targetCreated after the
          // response; setImmediate keeps that ordering.
          const targets = this._listTargets();
          setImmediate(() => {
            for (const t of targets) {
              this._push(client, {
                method: 'Target.targetCreated',
                params: {
                  targetInfo: {
                    targetId: t.targetId, type: 'page', url: t.url ?? '',
                    title: t.title ?? '', attached: true, canAccessOpener: false,
                  },
                },
              });
            }
          });
        }
        return {};
      }

      case 'Target.attachToTarget': {
        if (params.flatten !== true) {
          throw cdpError(-32602, 'Only flatten sessions are supported');
        }
        const targetId = params.targetId;
        if (typeof targetId !== 'string' || !targetId) {
          throw cdpError(-32602, 'targetId must be a non-empty string');
        }
        const wc = this._resolveWc(targetId);
        if (wc) {
          await this._acquire(wc);
          try {
            const vs = this._newSession(client, { kind: 'page', targetId, wc, holdsRef: true });
            return { sessionId: vs.id };
          } catch (e) {
            await this._release(wc);
            throw e;
          }
        }
        // OOPIF iframe target: find the parent tab (enumerate if the index
        // has never seen this id), then open a real flatten child session on
        // the parent's root debugger.
        let parentWc = this._iframeIndex.get(targetId);
        if (!parentWc || parentWc.isDestroyed()) {
          await this._enumerateFrames();
          parentWc = this._iframeIndex.get(targetId);
        }
        if (!parentWc || parentWc.isDestroyed()) throw noSuchTarget();
        const record = await this._acquire(parentWc);
        try {
          const { sessionId: realSid } = await this._cmd(record, 'Target.attachToTarget', { targetId, flatten: true });
          const vs = this._newSession(client, { kind: 'frame', targetId, wc: parentWc, realSid, holdsRef: true });
          const child = { targetId, owners: new Map([[vs.id, vs]]) };
          record.children.set(realSid, child);
          this._flushPending(record, realSid, child);
          return { sessionId: vs.id };
        } catch (e) {
          await this._release(parentWc);
          throw e;
        }
      }

      case 'Target.detachFromTarget': {
        const vs = this._sessions.get(params.sessionId);
        if (!vs || vs.client !== client || vs.detached) throw noSuchSession();
        await this._detachSession(vs);
        return {};
      }

      case 'Browser.getVersion':
        return {
          protocolVersion: '1.3',
          product: `Chrome/${process.versions.chrome}`,
          revision: '',
          userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`,
          jsVersion: process.versions.v8,
        };

      default:
        throw notFound(method);
    }
  }

  async _sessionCommand(vs, method, params) {
    const record = this._records.get(vs.wc);
    if (!record || record.dead) throw cdpError(-32000, 'Target closed');

    // Domain enable/disable: the shared root debugger (or shared real child
    // session) is enabled once per domain; per-virtual-session membership
    // gates event routing.
    const m = method.match(/^([A-Za-z][A-Za-z0-9]*)\.(enable|disable)$/);
    if (m) {
      const [, domain, op] = m;
      const gate = vs.kind === 'page' ? record.domains : this._childDomains(record, vs.realSid);
      let set = gate.get(domain);
      if (op === 'enable') {
        vs.domains.add(domain);
        if (!set) {
          set = new Set();
          gate.set(domain, set);
        }
        const first = set.size === 0;
        set.add(vs.id);
        if (first) return this._cmd(record, method, params, vs.realSid ?? undefined);
        return {};
      }
      if (vs.domains.delete(domain) && set?.delete(vs.id) && set.size === 0) {
        gate.delete(domain);
        return this._cmd(record, method, params, vs.realSid ?? undefined);
      }
      return {};
    }

    if (method === 'Target.setAutoAttach' && vs.kind === 'page') {
      const want = !!params.autoAttach;
      if (want === vs.autoAttach) return {};
      vs.autoAttach = want;
      if (want) record.autoAttachArmed.add(vs.id);
      else record.autoAttachArmed.delete(vs.id);
      await this._applyAutoAttach(record);
      return {};
    }

    if (method === 'Target.attachToTarget' && vs.kind === 'page') {
      if (params.flatten !== true) {
        throw cdpError(-32602, 'Only flatten sessions are supported');
      }
      const { sessionId: realSid } = await this._cmd(record, 'Target.attachToTarget', {
        targetId: params.targetId, flatten: true,
      });
      const childVs = this._newSession(vs.client, {
        kind: 'frame', targetId: params.targetId, wc: vs.wc, realSid, holdsRef: false,
        parentSid: vs.id,
      });
      const child = { targetId: params.targetId, owners: new Map([[childVs.id, childVs]]) };
      record.children.set(realSid, child);
      this._flushPending(record, realSid, child);
      return { sessionId: childVs.id };
    }

    if (method === 'Target.detachFromTarget') {
      const child = this._sessions.get(params.sessionId);
      if (!child || child.client !== vs.client || child.detached) throw noSuchSession();
      // page sessions may only detach subtarget sessions they spawned
      if (vs.kind === 'page' && child !== vs && child.parentSid !== vs.id) throw noSuchSession();
      await this._detachSession(child);
      return {};
    }

    return this._cmd(record, method, params, vs.realSid ?? undefined);
  }

  _childDomains(record, realSid) {
    const child = record.children.get(realSid);
    if (!child) throw noSuchSession();
    child.domains ??= new Map();
    return child.domains;
  }

  async _applyAutoAttach(record) {
    const desired = record.autoAttachArmed.size > 0;
    if (desired === record.autoAttachApplied) return;
    record.autoAttachApplied = desired;
    await this._cmd(record, 'Target.setAutoAttach', {
      autoAttach: desired, waitForDebuggerOnStart: false, flatten: true,
    }).catch(() => {
      record.autoAttachApplied = false;
    });
  }

  // ---- sessions -----------------------------------------------------------

  _newSession(client, { kind, targetId, wc, realSid = null, holdsRef, parentSid = null }) {
    const vs = {
      id: `vs-${this._nextSessionNum++}`,
      client,
      kind,
      targetId,
      wc,
      realSid,
      holdsRef,
      parentSid,
      domains: new Set(),
      autoAttach: false,
      detached: false,
    };
    this._sessions.set(vs.id, vs);
    client.sessions.add(vs.id);
    return vs;
  }

  async _detachSession(vs) {
    if (vs.detached) return;
    vs.detached = true;
    this._sessions.delete(vs.id);
    vs.client.sessions.delete(vs.id);
    const record = this._records.get(vs.wc);
    if (record && !record.dead) {
      if (vs.kind === 'page') {
        if (record.autoAttachArmed.delete(vs.id)) await this._applyAutoAttach(record);
        for (const domain of vs.domains) {
          const set = record.domains.get(domain);
          if (set?.delete(vs.id) && set.size === 0) {
            record.domains.delete(domain);
            await this._cmd(record, `${domain}.disable`).catch(() => {});
          }
        }
        // Drop auto-attach children this page session owned.
        for (const [realSid, child] of [...record.children]) {
          let touched = false;
          for (const [csid, cvs] of [...child.owners]) {
            if (cvs.parentSid !== vs.id) continue;
            child.owners.delete(csid);
            cvs.detached = true;
            this._sessions.delete(csid);
            cvs.client.sessions.delete(csid);
            this._push(cvs.client, { method: 'Target.detachedFromTarget', params: { sessionId: csid } });
            touched = true;
          }
          if (touched && child.owners.size === 0) {
            record.children.delete(realSid);
            await this._cmd(record, 'Target.detachFromTarget', { sessionId: realSid }).catch(() => {});
          }
        }
      } else {
        const child = record.children.get(vs.realSid);
        if (child) {
          child.owners.delete(vs.id);
          if (child.owners.size === 0) record.children.delete(vs.realSid);
        }
        await this._cmd(record, 'Target.detachFromTarget', { sessionId: vs.realSid }).catch(() => {});
      }
    }
    if (vs.holdsRef) await this._release(vs.wc);
  }

  // ---- target enumeration --------------------------------------------------

  async _collectTargets() {
    const pages = this._listTargets().map((t) => ({
      targetId: t.targetId,
      type: 'page',
      title: t.title ?? '',
      url: t.url ?? '',
      attached: true,
      canAccessOpener: false,
    }));
    const iframes = await this._enumerateFrames();
    return [...pages, ...iframes];
  }

  // Iframe (OOPIF) targets are only visible through an attached tab root
  // debugger. Target.getTargets on that root session leaks targets from the
  // WHOLE browser context (wrong parent attribution), so enumeration uses a
  // short-lived Target.setAutoAttach cycle instead: attachedToTarget events
  // on a tab's root name exactly that tab's own subtargets.
  async _enumerateFrames() {
    const iframes = [];
    const index = new Map();
    for (const record of this._records.values()) {
      if (!record.attached || record.dead || record.wc.isDestroyed()) continue;
      try {
        for (const ti of await this._enumerateRecordFrames(record)) {
          index.set(ti.targetId, record.wc);
          iframes.push({
            targetId: ti.targetId,
            type: 'iframe',
            title: ti.title ?? '',
            url: ti.url ?? '',
            attached: [...record.children.values()].some((c) => c.targetId === ti.targetId),
            canAccessOpener: false,
          });
        }
      } catch { /* record died mid-enumeration */ }
    }
    this._iframeIndex = index;
    return iframes;
  }

  _enumerateRecordFrames(record) {
    if (record.enumPromise) return record.enumPromise;
    record.enumPromise = (async () => {
      // Already armed by a virtual page session: record.children IS the
      // current frame set, no cycle needed.
      if (record.autoAttachApplied && !record.enumerating) {
        return [...record.children.values()].map((c) => ({
          targetId: c.targetId, title: c.title ?? '', url: c.url ?? '',
        }));
      }
      const collector = new Map(); // realSid -> targetInfo
      record.enumerating = collector;
      record.autoAttachApplied = true;
      try {
        await this._cmd(record, 'Target.setAutoAttach', {
          autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
        });
        // attachedToTarget for existing children is dispatched right behind
        // the response; 100ms is generous for in-process delivery.
        await new Promise((r) => setTimeout(r, 100));
      } finally {
        record.enumerating = null;
        const desired = record.autoAttachArmed.size > 0;
        record.autoAttachApplied = desired;
        if (!desired) {
          await this._cmd(record, 'Target.setAutoAttach', {
            autoAttach: false, waitForDebuggerOnStart: false, flatten: true,
          }).catch(() => {});
        }
        // Drop the real child sessions the cycle created — but never ones a
        // client attached explicitly or an armed session claimed meanwhile.
        for (const realSid of collector.keys()) {
          if (record.children.has(realSid)) continue;
          await this._cmd(record, 'Target.detachFromTarget', { sessionId: realSid }).catch(() => {});
        }
      }
      return [...collector.values()]
        .filter((ti) => ti.type === 'iframe')
        .map((ti) => ({ targetId: ti.targetId, title: ti.title ?? '', url: ti.url ?? '' }));
    })().finally(() => {
      record.enumPromise = null;
    });
    return record.enumPromise;
  }

  _push(client, msg) {
    if (client.closed) return;
    try {
      client.push(msg);
    } catch { /* transport gone */ }
  }
}
