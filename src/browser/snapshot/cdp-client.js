// Minimal browser-level CDP client for the Electron main process.
// One lazily-opened WebSocket to the Chromium endpoint; flatten sessions.
// Used by the snapshot orchestrator to reach OOPIF targets.

export class MainCdpClient {
  constructor(webSocketDebuggerUrl) {
    this._url = webSocketDebuggerUrl;
    this._ws = null;
    this._opening = null;
    this._nextId = 1;
    this._pending = new Map();
  }

  async _ensureWs() {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) return this._ws;
    if (this._opening) return this._opening;
    this._opening = (async () => {
      const ws = new WebSocket(this._url);
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(new Error('CDP websocket connect failed'));
      });
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.id && this._pending.has(msg.id)) {
          const { resolve, reject } = this._pending.get(msg.id);
          this._pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || 'CDP error'));
          else resolve(msg.result);
        }
      };
      ws.onclose = () => {
        this._ws = null;
        for (const { reject } of this._pending.values()) reject(new Error('CDP websocket closed'));
        this._pending.clear();
      };
      this._ws = ws;
      return ws;
    })();
    try {
      return await this._opening;
    } finally {
      this._opening = null;
    }
  }

  async send(method, params = {}, sessionId) {
    await this._ensureWs();
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async getTargets() {
    const { targetInfos } = await this.send('Target.getTargets');
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
}
