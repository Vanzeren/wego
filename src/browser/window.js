// Main window orchestrator: creates the BrowserWindow, wires the modules
// (persistence / views / findbar / ipc), owns layout (stacked view bounds +
// z-order) and the zoom glue. See AGENTS.md for the architecture invariants.
import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpaceManager } from './spaces.js';
import { nextZoom, nextZoomLevel } from './zoom.js';
import { createPersistence } from './persistence.js';
import { setupViews } from './views.js';
import { setupFindbar } from './findbar.js';
import { setupIpc } from './ipc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Keep in sync with renderer/ui.js layout constants.
const CHROME_HEIGHT = 84;
const SIDEBAR_WIDTH = 200;

export function createMainWindow({ httpEndpoint, stateDir } = {}) {
  const persistence = createPersistence({ stateDir });
  const settings = persistence.loadSettings({ uiZoom: 1, pageZoomLevel: 0 });

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

  // Single window, stacked views. Agent tabs get compositor-primed at
  // creation (views.js): raised ~600ms showing a pixel-perfect clone of the
  // user's current content (invisible), then covered — their input pipeline
  // stays live forever after.
  function windowFor(space) {
    return win;
  }

  // Shared context, late-bound as modules come up.
  const ctx = {
    win,
    settings,
    httpEndpoint,
    downloads: new Map(), // url → { savePath, filename, state } (views.js fills)
    windowFor,
    spaces: () => spaces,
    activeTabWc: () => {
      const space = spaces.getActive();
      const tab = space?.tabs.find((t) => t.targetId === space.activeTargetId);
      const wc = tab?.view?.webContents;
      return wc && !wc.isDestroyed() ? wc : null;
    },
    chromeHeight: () => CHROME_HEIGHT,
    initialViewBounds: (space) => space && space.ownership === 'agent'
      ? { x: 0, y: 0, width: 1400, height: 900 }
      : { x: SIDEBAR_WIDTH, y: CHROME_HEIGHT, width: 1200, height: 800 },
    layoutViews,
    pushState,
  };

  const zoomGlue = {
    applyZoom(scope, dir) {
      if (scope === 'ui') {
        settings.uiZoom = nextZoom(settings.uiZoom, dir);
        win.webContents.setZoomFactor(settings.uiZoom);
        findbar.onZoomChanged();
        layoutViews(); // chrome geometry changed; re-place the views
      } else {
        const tab = ctx.activeTabWc();
        if (!tab) return null;
        // Global page zoom: apply to every existing tab and force-apply on
        // every navigation (see views.js), overriding Chromium's per-origin
        // zoom memory.
        settings.pageZoomLevel = nextZoomLevel(tab.getZoomLevel(), dir);
        for (const space of spaces.allSpaces()) {
          for (const t of space.tabs) {
            const wc = t.view?.webContents;
            if (wc && !wc.isDestroyed()) wc.setZoomLevel(settings.pageZoomLevel);
          }
        }
      }
      persistence.saveSettings(settings);
      return { uiZoom: settings.uiZoom, pageZoomLevel: settings.pageZoomLevel };
    },
  };
  ctx.applyZoom = zoomGlue.applyZoom;

  const views = setupViews(ctx);
  const findbar = setupFindbar(ctx);
  ctx.findbar = findbar;
  ctx.toggleFindbar = findbar.toggle;

  const spaces = new SpaceManager({ createView: views.createView, destroyView: views.destroyView });

  // ---- layout: stacked views, active tab raised --------------------------

  // Skip redundant setBounds: layoutViews runs on every spaceChanged (every
  // navigation/title update), but the bounds only change on resize/zoom.
  const lastBounds = new WeakMap();
  let currentTop = null;
  let currentAgentTop = null;

  // Lay out one window: every view of its spaces at full bounds, the active
  // tab raised; self-healing z-order (addChildView puts new views on top).
  function layoutWindow(targetWin, spacesInWin, activeSpace) {
    if (!targetWin || targetWin.isDestroyed()) return;
    const [w, h] = targetWin.getContentSize();
    let offX = 0;
    let offY = 0;
    if (targetWin === win) {
      // The chrome UI lives in the (zoomed) chrome page: its 200px sidebar
      // and 84px bars occupy 200·uiZoom / 84·uiZoom window pixels.
      offX = Math.round(SIDEBAR_WIDTH * settings.uiZoom);
      offY = Math.round(CHROME_HEIGHT * settings.uiZoom);
    }
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
    const children = targetWin.contentView.children;
    const isOnTop = children.length > 0 && children[children.length - 1] === top;
    const memo = targetWin === win ? currentTop : currentAgentTop;
    if (!isOnTop || top !== memo) {
      try {
        targetWin.contentView.removeChildView(top); // re-add => top of z-order
        targetWin.contentView.addChildView(top);
      } catch { /* view race */ }
    }
    if (targetWin === win) currentTop = top; else currentAgentTop = top;
  }

  function layoutViews() {
    if (win.isDestroyed()) return;
    const prevMainTop = currentTop;
    layoutWindow(win, spaces.allSpaces(), spaces.getActive());
    // the findbar floats above page content in the main window
    if (findbar.isVisible() && findbar.view()) {
      findbar.raise();
      findbar.view().setBounds(findbar.bounds()); // track resize/zoom
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
      win.webContents.send('state', { ...spaces.serializeAll(), nav });
    }
  }

  spaces.on('spaceChanged', () => { layoutViews(); pushState(); persistence.scheduleSpacesSave(spaces); });
  spaces.on('taskState', () => { pushState(); persistence.scheduleSpacesSave(spaces); });
  win.on('resize', layoutViews);

  setupIpc(ctx, ipcMain);
  views.wireInput(win.webContents);

  // Restore spaces from the previous run; fall back to a fresh Personal space.
  let restored = false;
  const savedSpaces = persistence.loadSpaces();
  if (savedSpaces) {
    try { restored = spaces.restoreState(savedSpaces); } catch { restored = false; }
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
    downloads: ctx.downloads,
    applyZoom: zoomGlue.applyZoom,
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
