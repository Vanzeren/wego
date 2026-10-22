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
      if (s) this._handleDetached(s);
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
    if (this._reattaching.has(targetId)) {
      session.detached = true;
      session._failAll('CDP session detached');
      this._byTarget.delete(targetId);
      return;
    }
    this._reattaching.add(targetId);
    (async () => {
      try {
        const { sessionId } = await this._browser.send('Target.attachToTarget', { targetId, flatten: true });
        // keep session identity: pending commands and listeners survive
        this._sessions.set(sessionId, session);
        session.sessionId = sessionId;
      } catch {
        session.detached = true;
        session._failAll('CDP session detached');
        this._byTarget.delete(targetId);
      } finally {
        this._reattaching.delete(targetId);
      }
    })();
  }

  // attach(targetId) → page-level session
  async attach(targetId) {
    const existing = this._byTarget.get(targetId);
    if (existing && !existing.detached) return existing;
    const { sessionId } = await this._browser.send('Target.attachToTarget', { targetId, flatten: true });
    const session = new CDPSession(this, sessionId, targetId);
    this._sessions.set(sessionId, session);
    this._byTarget.set(targetId, session);
    return session;
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
