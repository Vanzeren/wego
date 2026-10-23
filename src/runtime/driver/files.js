// Download and FileChooser: Page-adjacent artifact classes.
// Each wraps one browser-side artifact; they only need the owning Page's
// session and receipt helpers.
import fs from 'node:fs';
import path from 'node:path';

import { CDPError } from '../cdp.js';

export class Download {
  constructor(page, guid, url, suggestedFilename) {
    this._page = page;
    this._guid = guid;
    this._url = url;
    this._suggested = suggestedFilename;
    this._id = null; // bridge registry id (url#N), set by the waitForEvent poller
    this._path = null; // real save path, resolved from the bridge registry
    this._done = new Promise((resolve) => { this._resolveDone = resolve; });
  }
  url() { return this._url; }
  suggestedFilename() { return this._suggested; }

  // The actual file lives where the browser's will-download handler put it;
  // resolve (and wait briefly for registration) through the bridge. Entries
  // are keyed by a unique id (url#N) so same-URL downloads stay distinct.
  async _resolvePath() {
    if (this._path) return this._path;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const { downloads } = await this._page._ctx().ego._call('downloads').catch(() => ({ downloads: [] }));
      const hit = (downloads ?? []).find((d) => (this._id ? d.id === this._id : d.url === this._url));
      if (hit?.savePath) {
        this._path = hit.savePath;
        if (hit.state === 'completed') this._resolveDone();
        return this._path;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new CDPError(`download not registered by the browser: ${this._url}`, 'WEGO_OPERATION_FAILED');
  }

  async path() { return this._resolvePath(); }
  async saveAs(absPath) {
    if (!path.isAbsolute(absPath)) throw Object.assign(new Error('saveAs path must be absolute'), { error_code: 'WEGO_INVALID_ARGUMENT' });
    await this._done;
    await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
    await fs.promises.copyFile(await this._resolvePath(), absPath);
    return absPath;
  }
  async cancel() {
    if (!this._guid) return; // Electron path: no CDP guid; leave the file
    await this._page._session().then((s) => s.send('Browser.cancelDownload', { guid: this._guid })).catch(() => {});
  }
}

// One intercepted file chooser. Created when Page.fileChooserOpened fires;
// resolve it with setFiles() or let the no-waiter path cancel it.
export class FileChooser {
  constructor(page, params) {
    this._page = page;
    this._backendNodeId = params.backendNodeId;
    this.mode = params.mode; // 'selectSingle' | 'selectMultiple'
    this._done = false;
  }

  isMultiple() { return this.mode === 'selectMultiple'; }

  async setFiles(paths) {
    if (this._done) throw new CDPError('File chooser already handled', 'WEGO_OPERATION_FAILED');
    const list = Array.isArray(paths) ? paths : [paths];
    for (const p of list) {
      if (typeof p !== 'string' || !path.isAbsolute(p)) {
        throw Object.assign(new TypeError('setFiles expects absolute paths'), { error_code: 'WEGO_INVALID_ARGUMENT' });
      }
    }
    const session = await this._page._session();
    await session.send('DOM.setFileInputFiles', { files: list, backendNodeId: this._backendNodeId });
    this._done = true;
    return this._page._receipt();
  }

  // Empty file list resolves the intercepted chooser as a cancel.
  async cancel() {
    if (this._done) return;
    const session = await this._page._session();
    await session.send('DOM.setFileInputFiles', { files: [], backendNodeId: this._backendNodeId }).catch(() => {});
    this._done = true;
  }
}
