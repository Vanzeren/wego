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
    this._path = null;
    this._done = new Promise((resolve) => { this._resolveDone = resolve; });
  }
  url() { return this._url; }
  suggestedFilename() { return this._suggested; }
  path() { return this._path; }
  async saveAs(absPath) {
    if (!path.isAbsolute(absPath)) throw Object.assign(new Error('saveAs path must be absolute'), { error_code: 'WEGO_INVALID_ARGUMENT' });
    await this._done;
    await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
    await fs.promises.copyFile(this._path, absPath);
    return absPath;
  }
  async cancel() {
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
