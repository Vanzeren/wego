// The settings panel: a dedicated WebContentsView floating as a centered
// card above the active tab's content area. Same pattern as the find bar
// (the chrome page can never paint over page views) — transparent outside
// the card, parked offscreen when hidden, re-rendered on every show.
import { WebContentsView } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function setupSettingsView(ctx) {
  // ctx: { win, settings, chromeHeight(), sidebarWidth(), activeTabWc() }
  const { win, settings } = ctx;
  let view = null;
  let visible = false;
  let loaded = false; // settings.html has registered onShow

  function ensure() {
    if (view) return view;
    view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'renderer', 'settings-preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    view.setBackgroundColor('#00000000'); // transparent outside the card
    win.contentView.addChildView(view);
    view.webContents.loadFile(path.join(__dirname, 'renderer', 'settings.html')).catch(() => {});
    view.webContents.setZoomFactor(settings.get('uiZoom'));
    view.webContents.on('did-finish-load', () => {
      loaded = true;
      if (visible) view.webContents.send('settings:show');
    });
    return view;
  }

  // Centered card over the content area (right of the sidebar, below the
  // chrome bars); chrome geometry scales with uiZoom.
  function bounds() {
    const z = settings.get('uiZoom');
    const [w, h] = win.getContentSize();
    const offX = Math.round(ctx.sidebarWidth() * z);
    const offY = Math.round(ctx.chromeHeight() * z);
    const cw = Math.max(0, w - offX);
    const ch = Math.max(0, h - offY);
    const bw = Math.min(Math.round(560 * z), cw);
    const bh = Math.min(Math.round(460 * z), ch);
    return {
      x: offX + Math.max(0, Math.round((cw - bw) / 2)),
      y: offY + Math.max(0, Math.round((ch - bh) / 2)),
      width: bw,
      height: bh,
    };
  }

  function raise() {
    try {
      win.contentView.removeChildView(view);
      win.contentView.addChildView(view); // re-add => top of z-order
    } catch { /* view race */ }
  }

  function show() {
    ensure();
    visible = true;
    view.setBounds(bounds());
    raise();
    view.webContents.setZoomFactor(settings.get('uiZoom'));
    view.webContents.focus();
    if (loaded) view.webContents.send('settings:show');
  }

  function hide() {
    if (!view) return;
    visible = false;
    const b = bounds();
    view.setBounds({ x: -5000, y: b.y, width: b.width, height: b.height });
    const tab = ctx.activeTabWc();
    if (tab && !tab.isDestroyed()) tab.focus();
  }

  function toggle() {
    if (visible) hide();
    else show();
  }

  return {
    toggle,
    hide,
    show,
    raise,
    isVisible: () => visible,
    view: () => view,
    bounds,
    onZoomChanged() {
      if (!view) return;
      view.webContents.setZoomFactor(settings.get('uiZoom'));
      if (visible) view.setBounds(bounds());
    },
  };
}
