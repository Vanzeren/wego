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
      if (findbarView) {
        findbarView.webContents.setZoomFactor(settings.uiZoom);
        if (findbarVisible) findbarView.setBounds(findbarBounds());
      }
      layoutViews(); // chrome geometry changed; re-place the views
    } else {
      const tab = activeTabWc();
      if (!tab || tab.isDestroyed()) return null;
      // Global page zoom: apply to every existing tab and force-apply on
      // every navigation (see wireTabView), overriding Chromium's per-origin
      // zoom memory.
      settings.pageZoomLevel = nextZoomLevel(tab.getZoomLevel(), dir);
      for (const space of spaces.allSpaces()) {
        for (const t of space.tabs) {
          const wc = t.view?.webContents;
          if (wc && !wc.isDestroyed()) wc.setZoomLevel(settings.pageZoomLevel);
        }
      }
    }
    saveSettings();
    return { uiZoom: settings.uiZoom, pageZoomLevel: settings.pageZoomLevel };
  }

  // ---- findbar: a dedicated always-on-top view ---------------------------
  // The chrome page can never paint over page views (they are composited
  // above it), so an in-chrome findbar gets its bottom clipped by the page.
  // The findbar is its own tiny WebContentsView parked offscreen when hidden.
  let findbarView = null;
  let findbarVisible = false;
  let findText = '';

  function ensureFindbar() {
    if (findbarView) return findbarView;
    findbarView = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'renderer', 'findbar-preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    findbarView.setBackgroundColor('#00000000'); // transparent outside the card
    win.contentView.addChildView(findbarView);
    findbarView.webContents.loadFile(path.join(__dirname, 'renderer', 'findbar.html')).catch(() => {});
    findbarView.webContents.setZoomFactor(settings.uiZoom);
    return findbarView;
  }

  function findbarBounds() {
    const z = settings.uiZoom;
    const [w] = win.getContentSize();
    const bw = Math.round(400 * z);
    const bh = Math.round(58 * z);
    const top = Math.round(CHROME_HEIGHT * z) + Math.round(6 * z);
    return { x: Math.max(0, w - bw - Math.round(16 * z)), y: top, width: bw, height: bh };
  }

  function raiseFindbar() {
    try {
      win.contentView.removeChildView(findbarView);
      win.contentView.addChildView(findbarView);
    } catch { /* view race */ }
  }

  function showFindbar() {
    ensureFindbar();
    findbarVisible = true;
    findbarView.setBounds(findbarBounds());
    raiseFindbar();
    findbarView.webContents.setZoomFactor(settings.uiZoom);
    findbarView.webContents.focus();
    findbarView.webContents.send('findbar:prefill', findText);
  }

  function hideFindbar() {
    if (!findbarView) return;
    findbarVisible = false;
    const b = findbarBounds();
    findbarView.setBounds({ x: -5000, y: b.y, width: b.width, height: b.height });
    const tab = activeTabWc();
    if (tab && !tab.isDestroyed()) tab.focus();
  }

  function toggleFindbar() {
    if (findbarVisible) {
      hideFindbar();
      activeTabWc()?.stopFindInPage('clearSelection');
    } else {
      showFindbar();
    }
  }

  function wireZoomInput(wc) {
    wc.on('before-input-event', (event, input) => {
      // Ctrl+F: toggle the find bar regardless of which webContents has focus.
      if (input.type === 'keyDown' && input.control && !input.shift && !input.alt && !input.meta
          && (input.key === 'f' || input.key === 'F')) {
        toggleFindbar();
        event.preventDefault();
        return;
      }
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
  // Shared target-list cache: concurrent tab creations would otherwise each
  // fetch and parse /json/list per poll iteration.
  let targetsCache = { at: 0, list: null };
  async function fetchTargets() {
    if (targetsCache.list && Date.now() - targetsCache.at < 50) return targetsCache.list;
    const res = await fetch(`${httpEndpoint}/json/list`);
    const list = await res.json();
    targetsCache = { at: Date.now(), list };
    return list;
  }

  // Resolve the real Chromium CDP targetId for a freshly created WebContentsView
  // by loading a unique marker URL and matching it in the DevTools target list.
  async function resolveCdpTargetId(marker, wc) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (wc.isDestroyed()) throw new Error('webContents destroyed');
      try {
        const hit = (await fetchTargets()).find((t) => t.url === marker);
        if (hit) {
          targetsCache = { at: 0, list: null }; // force refresh for the next marker
          return hit.id;
        }
      } catch { /* endpoint briefly unavailable */ }
      await new Promise((r) => setTimeout(r, 25));
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
    // Global page zoom is re-applied on every navigation so Chromium's
    // per-origin zoom memory never diverges from the user's setting. Skip at
    // the default: applying a zoom forces a layout recompute that can race
    // the first click on fresh tabs.
    if (settings.pageZoomLevel !== 0) wc.setZoomLevel(settings.pageZoomLevel);
    wc.on('did-navigate', () => {
      if (!wc.isDestroyed() && wc.getZoomLevel() !== settings.pageZoomLevel) {
        wc.setZoomLevel(settings.pageZoomLevel);
      }
    });
    wireZoomInput(wc);
    // find-in-page results for the find bar (only from the active tab)
    wc.on('found-in-page', (_e, result) => {
      if (findbarVisible && findbarView && activeTabWc() === wc && !findbarView.webContents.isDestroyed()) {
        findbarView.webContents.send('findbar:result', {
          matches: result.matches ?? 0,
          activeMatchOrdinal: result.activeMatchOrdinal ?? 0,
        });
      }
    });
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
        // Agent tabs need timers/rAF at full rate; user tabs get Chromium's
        // background throttling to save CPU. Covered views reveal with the
        // (dark) view background, so the gap is invisible — see
        // setBackgroundColor below. Edge case: a user space claimed by an
        // agent keeps throttled tabs (claimTaskSpace does not recreate views).
        webPreferences: { partition: partitionFor(space.profileId), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: space.ownership === 'agent' ? false : true },
      });
      wireTabView(space, tab, view);
      // Match the chrome background: when a re-attached view (z-order raise on
      // tab switch) or a freshly created view has no compositor frame yet,
      // the area fills with this color — white here reads as a jarring flash.
      view.setBackgroundColor('#17181c');
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

  // Skip redundant setBounds: layoutViews runs on every spaceChanged (every
  // navigation/title update), but the bounds only change on resize/zoom.
  const lastBounds = new WeakMap();

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
    const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
    for (const space of spaces.allSpaces()) {
      for (const tab of space.tabs) {
        if (!tab.view) continue;
        if (lastBounds.get(tab.view) === key) continue;
        lastBounds.set(tab.view, key);
        try { tab.view.setBounds(bounds); } catch { /* destroyed */ }
      }
    }
    const active = spaces.getActive();
    const top = active?.tabs.find((t) => t.targetId === active.activeTargetId)?.view ?? null;
    if (top && top !== currentTop) {
      currentTop = top;
      // the find selection belongs to the previous tab
      if (findbarVisible) {
        hideFindbar();
        findText = '';
      }
      try {
        win.contentView.removeChildView(top); // re-add => top of z-order
        win.contentView.addChildView(top);
      } catch { /* view race */ }
    }
    // the findbar floats above page content
    if (findbarVisible && findbarView) {
      raiseFindbar();
      findbarView.setBounds(findbarBounds()); // track resize/zoom
    }
  }

  function pushState() {
    if (!win.isDestroyed()) win.webContents.send('state', spaces.serializeAll());
  }

  spaces.on('spaceChanged', () => { layoutViews(); pushState(); scheduleSave(spaces); });
  spaces.on('taskState', () => { pushState(); scheduleSave(spaces); });
  win.on('resize', layoutViews);

  // Find-in-page state is declared with the findbar view block above.

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
      // Find bar: meta operation over the active tab, never gated.
      case 'findToggle': toggleFindbar(); break;
      case 'find':
        findText = typeof msg.text === 'string' ? msg.text : '';
        if (findText) activeWc()?.findInPage(findText);
        else activeWc()?.stopFindInPage('clearSelection');
        break;
      case 'findNext':
        if (findText) activeWc()?.findInPage(findText, { forward: msg.forward !== false, findNext: true });
        break;
      case 'findClose':
        activeWc()?.stopFindInPage('clearSelection');
        hideFindbar();
        break;
      case 'switchSpace':
        if (typeof msg.id === 'number' && spaces.getSpace(msg.id)) spaces.setActiveSpace(msg.id);
        break;
      // Sidebar space management: meta operations, never gated by the active
      // space's control state.
      case 'newSpace':
        spaces.createUserSpace(typeof msg.name === 'string' ? msg.name : '');
        break;
      case 'closeSpace':
        if (typeof msg.id === 'number') spaces.closeUserSpace(msg.id);
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
