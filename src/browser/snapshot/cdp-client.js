// Minimal browser-level CDP client for the Electron main process.
// Rides a VirtualCdpServer client in-process (no socket, no TCP endpoint);
// flatten sessions. Used by the snapshot orchestrator to reach OOPIF targets.

export class MainCdpClient {
  constructor(cdpServer) {
    this._server = cdpServer;
    this._client = null;
    this._nextId = 1;
    this._pending = new Map();
    this._sessions = new Map(); // targetId -> persistent session (attachCached)
    this._targetsCache = { at: 0, list: null };
    this._discoveryArmed = false; // Target.setDiscoverTargets sent on the live client
  }

  _ensureClient() {
    if (this._client) return this._client;
    this._client = this._server.openClient((msg) => {
      if (msg.id && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'CDP error'));
        else resolve(msg.result);
        return;
      }
      // Prune cached attachCached sessions for destroyed targets (and any
      // flattened child sessions they spawned) so _sessions cannot leak.
      if (msg.method === 'Target.targetDestroyed') {
        const targetId = msg.params?.targetId;
        const sessionId = msg.params?.sessionId;
        for (const [key, session] of this._sessions) {
          if (key === targetId || (sessionId && session.sessionId === sessionId)) {
            this._sessions.delete(key);
          }
        }
      }
    });
    // One-time per client: receive Target.targetDestroyed events so cached
    // attachCached sessions are pruned (see the push handler above).
    if (!this._discoveryArmed) {
      this._discoveryArmed = true;
      this.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
    }
    return this._client;
  }

  async send(method, params = {}, sessionId) {
    const client = this._ensureClient();
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      Promise.resolve(
        client.handleMessage({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
      ).catch((e) => {
        if (this._pending.delete(id)) reject(e);
      });
    });
  }

  // Short TTL: target lists shift on every tab/frame create, but a snapshot
  // burst (top page + its OOPIFs) reads it repeatedly.
  async getTargets() {
    if (this._targetsCache.list && Date.now() - this._targetsCache.at < 250) {
      return this._targetsCache.list;
    }
    const { targetInfos } = await this.send('Target.getTargets');
    this._targetsCache = { at: Date.now(), list: targetInfos };
    return targetInfos;
  }

  // attach → { sessionId, send(method, params) , detach() }
  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return {
      sessionId,
      send: (method, params = {}) => this.send(method, params, sessionId),
      detach: () => this.send('Target.detachFromTarget', { sessionId }).catch(() => {}),
    };
  }

  // Persistent session for repeated use (e.g. the page session behind
  // DOM.getFrameOwner checks). Dropped automatically if attach fails later.
  async attachCached(targetId) {
    const existing = this._sessions.get(targetId);
    if (existing) return existing;
    const session = await this.attach(targetId);
    this._sessions.set(targetId, session);
    return session;
  }
}
