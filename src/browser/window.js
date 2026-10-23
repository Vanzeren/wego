// Main window orchestrator: creates the BrowserWindow, wires the modules
// (persistence / views / findbar / ipc), owns layout (stacked view bounds +
// z-order) and the zoom glue. See AGENTS.md for the architecture invariants.
import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpaceManager } from './spaces.js';
import { nextZoom, nextZoomLevel } from './zoom.js';
import { createPersistence } from './persistence.js';
import { createSettings, SEARCH_ENGINES } from './settings.js';
import { setupViews } from './views.js';
import { setupFindbar } from './findbar.js';
import { setupSettingsView } from './settings-view.js';
import { setupIpc } from './ipc.js';
import { VirtualCdpServer } from './cdp-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Keep in sync with renderer/ui.js layout constants.
const CHROME_HEIGHT = 84;
const SIDEBAR_WIDTH = 200;

export function createMainWindow({ stateDir } = {}) {
  const persistence = createPersistence({ stateDir });
  // Single source of truth for preferences; onChange applies side effects
  // and repushes chrome state (defined below, late-bound like the rest).
  const settings = createSettings({
    persistence,
    onChange: (key, value) => onSettingsChanged(key, value),
  });

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

  // Single window, stacked views. Agent tabs mount stacked in the main
  // window (non-top, beneath the user's active view); input reaches covered
  // views fine, and the re-attach self-heal in views.js (the compositor
  // priming note in createView) recovers raced attaches.

  // Shared context, late-bound as modules come up.
  const ctx = {
    win,
    settings,
    downloads: new Map(), // unique id (url#N) → { id, url, savePath, filename, state } (views.js fills)
    spaces: () => spaces,
    activeTabWc: () => {
      const space = spaces.getActive();
      const tab = space?.tabs.find((t) => t.targetId === space.activeTargetId);
      const wc = tab?.view?.webContents;
      return wc && !wc.isDestroyed() ? wc : null;
    },
    chromeHeight: () => CHROME_HEIGHT,
    sidebarWidth: () => SIDEBAR_WIDTH,
    initialViewBounds: (space) => space && space.ownership === 'agent'
      ? { x: 0, y: 0, width: 1400, height: 900 }
      : { x: SIDEBAR_WIDTH, y: CHROME_HEIGHT, width: 1200, height: 800 },
    layoutViews,
    pushState,
  };

  const zoomGlue = {
    applyZoom(scope, dir) {
      if (scope === 'ui') {
        settings.set('uiZoom', nextZoom(settings.get('uiZoom'), dir));
      } else {
        const tab = ctx.activeTabWc();
        if (!tab) return null;
        // Global page zoom: apply to every existing tab and force-apply on
        // every navigation (see views.js), overriding Chromium's per-origin
        // zoom memory.
        settings.set('pageZoomLevel', nextZoomLevel(tab.getZoomLevel(), dir));
      }
      return { uiZoom: settings.get('uiZoom'), pageZoomLevel: settings.get('pageZoomLevel') };
    },
  };
  ctx.applyZoom = zoomGlue.applyZoom;

  const views = setupViews(ctx);
  const findbar = setupFindbar(ctx);
  ctx.findbar = findbar;
  ctx.toggleFindbar = findbar.toggle;
  const settingsView = setupSettingsView(ctx);
  ctx.settingsView = settingsView;
  ctx.toggleSettings = settingsView.toggle;

  const spaces = new SpaceManager({ createView: views.createView, destroyView: views.destroyView });

  // Virtual browser-level CDP endpoint over the tab registry: page targets
  // come from SpaceManager tabs (placeholder tab-N ids are hidden until the
  // real targetId lands), OOPIF iframe targets are enumerated through each
  // tab's root debugger on demand. Discovery pushes ride spaceChanged diffs.
  const cdpServer = new VirtualCdpServer({
    listTargets: () => {
      const out = [];
      for (const space of spaces.allSpaces()) {
        for (const tab of space.tabs) {
          if (!tab.view || tab.targetId.startsWith('tab-')) continue;
          out.push({ targetId: tab.targetId, type: 'page', url: tab.url ?? '', title: tab.title ?? '' });
        }
      }
      return out;
    },
    resolveWc: (targetId) => {
      for (const space of spaces.allSpaces()) {
        const tab = space.tabs.find((t) => t.targetId === targetId);
        const wc = tab?.view?.webContents;
        if (wc && !wc.isDestroyed()) return wc;
      }
      return null;
    },
  });
  ctx.cdpServer = cdpServer;
  spaces.on('spaceChanged', () => cdpServer.notifyTargetsChanged());

  // Settings side effects, applied immediately on every change. Late-bound
  // refs (findbar/settingsView/spaces) are only touched at runtime, after
  // all modules are up.
  function onSettingsChanged(key, value) {
    if (key === 'uiZoom') {
      win.webContents.setZoomFactor(value);
      findbar.onZoomChanged();
      settingsView.onZoomChanged();
      layoutViews(); // chrome geometry changed; re-place the views
    } else if (key === 'pageZoomLevel') {
      for (const space of spaces.allSpaces()) {
        for (const t of space.tabs) {
          const wc = t.view?.webContents;
          if (wc && !wc.isDestroyed()) wc.setZoomLevel(value);
        }
      }
    }
    pushState();
  }

  // ---- layout: stacked views, active tab raised --------------------------

  // Skip redundant setBounds: layoutViews runs on every spaceChanged (every
  // navigation/title update), but the bounds only change on resize/zoom.
  const lastBounds = new WeakMap();
  let currentTop = null;

  // Lay out the window: every view at full bounds, the active tab raised;
  // self-healing z-order (addChildView puts new views on top).
  function layoutWindow(spacesInWin, activeSpace) {
    if (win.isDestroyed()) return;
    const [w, h] = win.getContentSize();
    // The chrome UI lives in the (zoomed) chrome page: its 200px sidebar
    // and 84px bars occupy 200·uiZoom / 84·uiZoom window pixels.
    const offX = Math.round(SIDEBAR_WIDTH * settings.get('uiZoom'));
    const offY = Math.round(CHROME_HEIGHT * settings.get('uiZoom'));
    const bounds = {
      x: offX,
      y: offY,
      width: Math.max(0, w - offX),
      height: Math.max(0, h - offY),
    };
    const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
    for (const space of spacesInWin) {
      for (const tab of space.tabs) {
        if (!tab.view) continue;
        if (lastBounds.get(tab.view) === key) continue;
        lastBounds.set(tab.view, key);
        try { tab.view.setBounds(bounds); } catch { /* destroyed */ }
      }
    }
    const top = activeSpace?.tabs.find((t) => t.targetId === activeSpace.activeTargetId)?.view ?? null;
    if (!top) return;
    const children = win.contentView.children;
    const isOnTop = children.length > 0 && children[children.length - 1] === top;
    if (!isOnTop || top !== currentTop) {
      try {
        win.contentView.removeChildView(top); // re-add => top of z-order
        win.contentView.addChildView(top);
      } catch { /* view race */ }
    }
    currentTop = top;
  }

  function layoutViews() {
    if (win.isDestroyed()) return;
    const prevMainTop = currentTop;
    layoutWindow(spaces.allSpaces(), spaces.getActive());
    // the findbar floats above page content in the main window
    if (findbar.isVisible() && findbar.view()) {
      findbar.raise();
      findbar.view().setBounds(findbar.bounds()); // track resize/zoom
    }
    // the settings card floats above everything else
    if (settingsView.isVisible() && settingsView.view()) {
      settingsView.raise();
      settingsView.view().setBounds(settingsView.bounds()); // track resize/zoom
    }
    // tab actually switched in the main window: close find selection
    if (currentTop !== prevMainTop && findbar.isVisible()) {
      findbar.hide();
      findbar.clearText();
    }
  }

  function pushState() {
    if (!win.isDestroyed()) {
      const wc = ctx.activeTabWc();
      const nav = { back: wc?.canGoBack() ?? false, forward: wc?.canGoForward() ?? false };
      const engine = SEARCH_ENGINES[settings.get('searchEngine')] ?? SEARCH_ENGINES.duckduckgo;
      win.webContents.send('state', {
        ...spaces.serializeAll(),
        nav,
        settings: { ...settings.all(), searchUrlTemplate: engine.url },
      });
    }
  }

  spaces.on('spaceChanged', () => { layoutViews(); pushState(); persistence.scheduleSpacesSave(spaces); });
  spaces.on('taskState', () => { pushState(); persistence.scheduleSpacesSave(spaces); });
  win.on('resize', layoutViews);

  setupIpc(ctx, ipcMain);
  views.wireInput(win.webContents);

  // Restore spaces from the previous run (unless disabled in settings);
  // fall back to a fresh Personal space. Spaces keep persisting either way,
  // so re-enabling the setting restores them next launch.
  let restored = false;
  const savedSpaces = settings.get('restoreSession') ? persistence.loadSpaces() : null;
  if (savedSpaces) {
    try { restored = spaces.restoreState(savedSpaces); } catch { restored = false; }
  }
  if (!restored) {
    const personal = spaces.createPersonalSpace();
    spaces.addUserTab(personal.id, 'about:blank');
  }

  win.webContents.on('did-finish-load', () => {
    if (settings.get('uiZoom') !== 1) win.webContents.setZoomFactor(settings.get('uiZoom'));
    pushState();
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.setPosition(120, 80);
  win.show();
  layoutViews();

  return {
    win,
    spaces,
    cdpServer,
    downloads: ctx.downloads,
    applyZoom: zoomGlue.applyZoom,
    flushPersistence: () => persistence.flush(),
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
