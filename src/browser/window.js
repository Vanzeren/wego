import { BrowserWindow, WebContentsView, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SpaceManager } from './spaces.js';
import { partitionForProfile as partitionFor } from './partitions.js';
import { nextZoom, nextZoomLevel, zoomFromKey } from './zoom.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Blank tabs load the designed new-tab page; state keeps 'about:blank' as
// the canonical "empty tab" value so the omnibox stays clean.
const NEWTAB_URL = pathToFileURL(path.join(__dirname, 'renderer', 'newtab.html')).href;

// Keep in sync with renderer/ui.js layout constants.
const CHROME_HEIGHT = 84;
const SIDEBAR_WIDTH = 200;

function normalizeUrl(input) {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)) return input;
  return `https://${input}`;
}

export function createMainWindow({ httpEndpoint, stateDir } = {}) {
  const spacesFile = stateDir ? path.join(stateDir, 'spaces.json') : null;
  const settingsFile = stateDir ? path.join(stateDir, 'settings.json') : null;

  // Zoom settings: page zoom applies per tab (new tabs inherit the last
  // value), UI zoom scales the whole chrome. Both persist.
  const settings = (() => {
    try { return { uiZoom: 1, pageZoomLevel: 0, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; }
    catch { return { uiZoom: 1, pageZoomLevel: 0 }; }
  })();
  let settingsTimer = null;
  const saveSettings = () => {
    if (!settingsFile) return;
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => {
      try { fs.writeFileSync(settingsFile, JSON.stringify(settings), { mode: 0o600 }); } catch { /* ignore */ }
    }, 400);
  };

  let activeTabWc = () => null; // wired after spaces exist
  function applyZoom(scope, dir) {
    if (scope === 'ui') {
      settings.uiZoom = nextZoom(settings.uiZoom, dir);
      win.webContents.setZoomFactor(settings.uiZoom);
      layoutViews(); // chrome geometry changed; re-place the views
    } else {
      const tab = activeTabWc();
      if (!tab || tab.isDestroyed()) return null;
      // setZoomLevel is browser-style page zoom: it changes the layout
      // viewport (what sites and users expect from Ctrl+/-/0).
      settings.pageZoomLevel = nextZoomLevel(tab.getZoomLevel(), dir);
      tab.setZoomLevel(settings.pageZoomLevel);
    }
    saveSettings();
    return { uiZoom: settings.uiZoom, pageZoomLevel: settings.pageZoomLevel };
  }

  function wireZoomInput(wc) {
    wc.on('before-input-event', (event, input) => {
      const z = zoomFromKey(input);
      if (!z) return;
      applyZoom(z.scope, z.dir);
      event.preventDefault();
    });
  }

  let saveTimer = null;
  function scheduleSave(spaces) {
    if (!spacesFile) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        const tmp = `${spacesFile}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(spaces.serializeState()), { mode: 0o600 });
        fs.renameSync(tmp, spacesFile); // atomic replace
      } catch { /* state dir not writable */ }
    }, 500);
  }
  // Resolve the real Chromium CDP targetId for a freshly created WebContentsView
  // by loading a unique marker URL and matching it in the DevTools target list.
  async function resolveCdpTargetId(marker, wc) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (wc.isDestroyed()) throw new Error('webContents destroyed');
      try {
        const res = await fetch(`${httpEndpoint}/json/list`);
        const targets = await res.json();
        const hit = targets.find((t) => t.url === marker);
        if (hit) return hit.id;
      } catch { /* endpoint briefly unavailable */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`CDP targetId resolution timed out for ${marker}`);
  }

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    frame: false, // no Wayland/X11 server-side decoration; chrome draws its own
    backgroundColor: '#17181c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Every tab view stays attached at FULL visible bounds; the active tab is
  // raised to the top of the z-order and is opaque, so it fully covers the
  // rest. Chromium clips native child views to the parent bounds, so parking
  // views offscreen would collapse their layout viewport to 0x0 and break
  // getBoundingClientRect/CDP Input for background agent tabs.
  let currentTop = null;

  function wireTabView(space, tab, view) {
    const wc = view.webContents;
    // Applying a zoom (even level 0) forces a layout recompute that can land
    // between getContentQuads and Input.dispatchMouseEvent on fresh tabs —
    // skip it entirely at the default.
    if (settings.pageZoomLevel !== 0) wc.setZoomLevel(settings.pageZoomLevel);
    wireZoomInput(wc);
    // Popups (window.open / target=_blank) become tabs in the same space.
    wc.setWindowOpenHandler(({ url }) => {
      spaces.addUserTab(space.id, url || 'about:blank');
      return { action: 'deny' };
    });
    const trackUrl = (url) => {
      if (url.includes('wego-marker-')) return; // targetId marker
      spaces.noteUrl(space.id, tab.targetId, url === NEWTAB_URL ? 'about:blank' : url);
    };
    wc.on('did-navigate', (_e, url) => trackUrl(url));
    wc.on('did-navigate-in-page', (_e, url) => trackUrl(url));
    wc.on('page-title-updated', (_e, title) => spaces.noteTitle(space.id, tab.targetId, title));
  }

  const spaces = new SpaceManager({
    createView(space, tab) {
      const view = new WebContentsView({
        webPreferences: { partition: partitionFor(space.profileId), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
      });
      wireTabView(space, tab, view);
      view.setBackgroundColor('#ffffff');
      win.contentView.addChildView(view);
      view.setBounds({ x: SIDEBAR_WIDTH, y: CHROME_HEIGHT, width: 1200, height: 800 });
      const wc = view.webContents;
      const intended = tab.url && tab.url !== 'about:blank' ? normalizeUrl(tab.url) : NEWTAB_URL;
      // Dark data-URL marker: unique (matched in /json/list to resolve the
      // real CDP targetId) and dark, so new tabs no longer flash white
      // before the new-tab page paints.
      const marker = `data:text/html,<!doctype html><style>html{background:%2317181c}</style><!--wego-marker-${space.id}-${tab.targetId}-->`;
      tab.targetIdReady = (async () => {
        await wc.loadURL(marker);
        const realId = await resolveCdpTargetId(marker, wc);
        spaces.noteTargetId(space.id, tab.targetId, realId);
        return realId;
      })();
      // The real URL loads only after the marker round-trip so the target
      // list match above cannot race it away.
      tab.targetIdReady.then(() => {
        if (wc.isDestroyed()) return;
        wc.loadURL(intended).catch(() => {});
      }).catch(() => {});
      return view;
    },
    destroyView(space, tab) {
      try { win.contentView.removeChildView(tab.view); } catch { /* not attached */ }
      try { tab.view?.webContents.close(); } catch { /* already destroyed */ }
    },
  });

  // Zoom shortcuts act on the active tab even when the chrome has focus.
  activeTabWc = () => {
    const space = spaces.getActive();
    const tab = space?.tabs.find((t) => t.targetId === space.activeTargetId);
    const wc = tab?.view?.webContents;
    return wc && !wc.isDestroyed() ? wc : null;
  };
  wireZoomInput(win.webContents);

  function layoutViews() {
    if (win.isDestroyed()) return;
    const [w, h] = win.getContentSize();
    // The chrome UI lives in the (zoomed) chrome page: its 200px sidebar and
    // 84px bars occupy 200·uiZoom / 84·uiZoom window pixels. View bounds must
    // use the scaled offsets or the views overlap the chrome.
    const offX = Math.round(SIDEBAR_WIDTH * settings.uiZoom);
    const offY = Math.round(CHROME_HEIGHT * settings.uiZoom);
    const bounds = {
      x: offX,
      y: offY,
      width: Math.max(0, w - offX),
      height: Math.max(0, h - offY),
    };
    for (const space of spaces.allSpaces()) {
      for (const tab of space.tabs) {
        try { tab.view?.setBounds(bounds); } catch { /* destroyed */ }
      }
    }
    const active = spaces.getActive();
    const top = active?.tabs.find((t) => t.targetId === active.activeTargetId)?.view ?? null;
    if (top && top !== currentTop) {
      currentTop = top;
      try {
        win.contentView.removeChildView(top); // re-add => top of z-order
        win.contentView.addChildView(top);
      } catch { /* view race */ }
    }
  }

  function pushState() {
    if (!win.isDestroyed()) win.webContents.send('state', spaces.serializeAll());
  }

  spaces.on('spaceChanged', () => { layoutViews(); pushState(); scheduleSave(spaces); });
  spaces.on('taskState', () => { pushState(); scheduleSave(spaces); });
  win.on('resize', layoutViews);

  // User gestures mutate the active space directly and are only honored while
  // control === 'user'; agent control transitions go through SpaceManager.
  ipcMain.handle('ui:action', (_e, msg) => {
    const { type } = msg ?? {};
    const space = spaces.getActive();
    const activeWc = () => {
      const tab = space?.tabs.find((t) => t.targetId === space.activeTargetId);
      const wc = tab?.view?.webContents;
      return wc && !wc.isDestroyed() ? wc : null;
    };
    const userEditable = !!space && space.control === 'user';
    switch (type) {
      case 'back': if (userEditable) activeWc()?.navigationHistory.goBack(); break;
      case 'forward': if (userEditable) activeWc()?.navigationHistory.goForward(); break;
      case 'reload': if (userEditable) activeWc()?.reload(); break;
      case 'navigate':
        if (userEditable && typeof msg.url === 'string' && msg.url) {
          activeWc()?.loadURL(normalizeUrl(msg.url)).catch(() => {});
        }
        break;
      case 'newTab':
        if (userEditable) spaces.addUserTab(space.id, typeof msg.url === 'string' && msg.url ? msg.url : 'about:blank');
        break;
      case 'closeTab':
        if (userEditable && typeof msg.targetId === 'string') spaces.closeUserTab(space.id, msg.targetId);
        break;
      case 'moveTab':
        if (userEditable && typeof msg.targetId === 'string' && Number.isInteger(msg.toIndex)) {
          spaces.moveUserTab(space.id, msg.targetId, msg.toIndex);
        }
        break;
      case 'activateTab':
        if (userEditable && typeof msg.targetId === 'string') spaces.activateUserTab(space.id, msg.targetId);
        break;
      case 'switchSpace':
        if (typeof msg.id === 'number' && spaces.getSpace(msg.id)) spaces.setActiveSpace(msg.id);
        break;
      case 'takeover': if (space) spaces.handOffTaskSpace({ id: space.id }); break;
      case 'handback': if (space) spaces.takeOverTaskSpace({ id: space.id }); break;
      // Window chrome: always the user's domain, never gated by space control.
      case 'winControl':
        if (msg.op === 'minimize') win.minimize();
        else if (msg.op === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
        else if (msg.op === 'close') win.close();
        break;
    }
    pushState();
  });

  // Restore spaces from the previous run; fall back to a fresh Personal space.
  let restored = false;
  if (spacesFile) {
    try {
      restored = spaces.restoreState(JSON.parse(fs.readFileSync(spacesFile, 'utf8')));
    } catch { restored = false; } // missing/corrupt file: start fresh
  }
  if (!restored) {
    const personal = spaces.createPersonalSpace();
    spaces.addUserTab(personal.id, 'about:blank');
  }

  win.webContents.on('did-finish-load', () => {
    if (settings.uiZoom !== 1) win.webContents.setZoomFactor(settings.uiZoom);
    pushState();
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.setPosition(120, 80);
  win.show();
  layoutViews();

  return {
    win,
    spaces,
    applyZoom,
    focus() {
      if (win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    },
    sendHighlight({ x, y }) {
      if (!win.isDestroyed()) win.webContents.send('highlight', { x, y });
    },
  };
}
