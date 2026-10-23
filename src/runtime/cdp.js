// CDP session manager over the ego raw channel (src/client/wego.js).
// Flatten sessions: Target.attachToTarget {flatten:true}; each session
// multiplexes command ids and routes events by sessionId.

export class CDPError extends Error {
  constructor(message, error_code) {
    super(message);
    this.error_code = error_code;
  }
}

const DEFAULT_TIMEOUT = 30_000;

class CDPSession {
  constructor(manager, sessionId, targetId) {
    this._manager = manager;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this._nextId = 1;
    this._pending = new Map(); // id -> {resolve, reject, timer, method}
    this._listeners = new Map(); // method -> Set<cb>
    this.detached = false;
  }

  send(method, params = {}, { timeout = DEFAULT_TIMEOUT } = {}) {
    if (this.detached) return Promise.reject(new CDPError('CDP session detached', 'WEGO_CDP_CHANNEL_UNAVAILABLE'));
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new CDPError(`CDP command timed out: ${method}`, 'WEGO_CDP_CHANNEL_UNAVAILABLE'));
      }, timeout);
      this._pending.set(id, { resolve, reject, timer, method });
      this._manager._sendRaw({ id, sessionId: this.sessionId, method, params });
    });
  }

  on(method, cb) {
    if (!this._listeners.has(method)) this._listeners.set(method, new Set());
    this._listeners.get(method).add(cb);
    return () => this.off(method, cb);
  }

  off(method, cb) {
    this._listeners.get(method)?.delete(cb);
  }

  _dispatchEvent(method, params) {
    const set = this._listeners.get(method);
    if (!set) return;
    for (const cb of set) {
      try { cb(params); } catch { /* listener error */ }
    }
  }

  _resolve(id, result) {
    const p = this._pending.get(id);
    if (!p) return;
    this._pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(result);
  }

  _reject(id, error) {
    const p = this._pending.get(id);
    if (!p) return;
    this._pending.delete(id);
    clearTimeout(p.timer);
    p.reject(new CDPError(error.message || 'CDP error', error.error_code || 'WEGO_OPERATION_FAILED'));
  }

  _failAll(reason, code = 'WEGO_CDP_CHANNEL_UNAVAILABLE') {
    for (const [id, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new CDPError(reason, code));
      this._pending.delete(id);
    }
  }
}

export class CDPManager {
  constructor(ego) {
    this._ego = ego;
    this._sessions = new Map(); // sessionId -> CDPSession
    this._byTarget = new Map(); // targetId -> CDPSession (reattach bookkeeping)
    this._browser = new CDPSession(this, undefined, undefined);
    this._disposed = false;
    this._reattaching = new Set();
    this._attaching = new Map(); // targetId -> in-flight attach promise
    // Detach notifications that arrive in the same message chunk as the
    // attach response they refer to (continuation hasn't run yet).
    this._pendingDetaches = new Set();

    ego.onCDPMessage = (raw) => this._onMessage(raw);
    ego.onSendCDPMessageError = (message, error_code) => {
      const code = error_code || 'WEGO_CDP_SEND_FAILED';
      this._browser._failAll(message, code);
      for (const s of this._sessions.values()) s._failAll(message, code);
    };
  }

  get browser() { return this._browser; }

  _sendRaw(msg) {
    this._ego.sendCDPMessage(JSON.stringify(msg)).catch(() => {});
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const session = msg.sessionId ? this._sessions.get(msg.sessionId) : this._browser;
    if (typeof msg.id === 'number') {
      if (!session) return;
      if (msg.error) session._reject(msg.id, msg.error);
      else session._resolve(msg.id, msg.result);
      return;
    }
    // event
    if (msg.method === 'Target.detachedFromTarget') {
      const sid = msg.params?.sessionId;
      const s = sid && this._sessions.get(sid);
      if (s) {
        this._handleDetached(s);
      } else if (sid) {
        // detach raced the attach continuation: park it so attach() can
        // tear the session down as soon as it registers.
        if (this._pendingDetaches.size >= 128) this._pendingDetaches.delete(this._pendingDetaches.values().next().value);
        this._pendingDetaches.add(sid);
      }
      return;
    }
    if (session) session._dispatchEvent(msg.method, msg.params);
    if (msg.sessionId && !session) return;
  }

  _handleDetached(session) {
    // auto-reattach once, then give up
    if (this._disposed) return;
    const targetId = session.targetId;
    this._sessions.delete(session.sessionId);
    // Commands already in flight were sent on the dead session — their
    // responses will never arrive, so fail them now instead of letting
    // callers hang until the 30s timeout.
    session.detached = true;
    session._failAll('CDP session detached');
    if (this._reattaching.has(targetId)) {
      this._byTarget.delete(targetId);
      return;
    }
    this._reattaching.add(targetId);
    (async () => {
      try {
        const { sessionId } = await this._browser.send('Target.attachToTarget', { targetId, flatten: true });
        // keep session identity: listeners survive; a fresh sessionId means
        // all enabled domains/setup state is gone and must be re-armed.
        session.sessionId = sessionId;
        session.detached = false;
        this._sessions.set(sessionId, session);
        if (this._pendingDetaches.delete(sessionId)) {
          this._handleDetached(session);
          return;
        }
        session._dispatchEvent('wego:reattached', {});
      } catch {
        this._byTarget.delete(targetId);
      } finally {
        this._reattaching.delete(targetId);
      }
    })();
  }

  // attach(targetId) → page-level session
  async attach(targetId) {
    // Popup adoption and waitForEvent('popup') rely on Target.targetCreated
    // pushes, which only flow after setDiscoverTargets. Arm once, lazily, so
    // every client process subscribes before its first attach.
    if (!this._discoveryArmed && !this._disposed) {
      this._discoveryArmed = true;
      this._browser.send('Target.setDiscoverTargets', { discover: true }).catch(() => { this._discoveryArmed = false; });
    }
    const existing = this._byTarget.get(targetId);
    if (existing && !existing.detached) return existing;
    const inFlight = this._attaching.get(targetId);
    if (inFlight) return inFlight;
    const p = (async () => {
      const { sessionId } = await this._browser.send('Target.attachToTarget', { targetId, flatten: true });
      const session = new CDPSession(this, sessionId, targetId);
      this._sessions.set(sessionId, session);
      this._byTarget.set(targetId, session);
      if (this._pendingDetaches.delete(sessionId)) this._handleDetached(session);
      return session;
    })();
    this._attaching.set(targetId, p);
    try {
      return await p;
    } finally {
      this._attaching.delete(targetId);
    }
  }

  // Self-initiated detach: tell the browser (best effort) and drop all local
  // bookkeeping so the target can't be resurrected through stale maps.
  detach(targetId) {
    const session = this._byTarget.get(targetId);
    if (!session) return;
    this._byTarget.delete(targetId);
    this._sessions.delete(session.sessionId);
    if (!session.detached && session.sessionId && !this._disposed) {
      this._browser.send('Target.detachFromTarget', { sessionId: session.sessionId }, { timeout: 3000 }).catch(() => {});
    }
    session.detached = true;
    session._failAll('CDP session detached');
  }

  // current live session for a target (after reattach)
  sessionFor(targetId) {
    return this._byTarget.get(targetId);
  }

  async detachAll() {
    this._disposed = true;
    for (const session of this._sessions.values()) {
      try {
        await this._browser.send('Target.detachFromTarget', { sessionId: session.sessionId }, { timeout: 3000 });
      } catch { /* best effort */ }
      session._failAll('CDP manager disposed');
    }
    this._sessions.clear();
    this._byTarget.clear();
    this._browser._failAll('CDP manager disposed');
  }
}
