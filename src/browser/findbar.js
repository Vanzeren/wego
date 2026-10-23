// The find bar: a dedicated tiny WebContentsView floating above page content.
// The chrome page can never paint over page views (they are composited above
// it), so an in-chrome findbar would get clipped — this view is the reason it
// exists. Parked offscreen when hidden.
import { WebContentsView } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function setupFindbar(ctx) {
  // ctx: { win, settings, activeTabWc(), layoutViews() }
  const { win, settings } = ctx;
  let view = null;
  let visible = false;
  let text = '';
  let loaded = false; // findbar.html has registered onPrefill

  function ensure() {
    if (view) return view;
    view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'renderer', 'findbar-preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    view.setBackgroundColor('#00000000'); // transparent outside the card
    win.contentView.addChildView(view);
    view.webContents.loadFile(path.join(__dirname, 'renderer', 'findbar.html')).catch(() => {});
    view.webContents.setZoomFactor(settings.uiZoom);
    // First show() can beat findbar.html's onPrefill registration; deliver the
    // prefill once the page signals it is loaded instead.
    view.webContents.on('did-finish-load', () => {
      loaded = true;
      if (visible) view.webContents.send('findbar:prefill', text);
    });
    return view;
  }

  function bounds() {
    const z = settings.uiZoom;
    const [w] = win.getContentSize();
    const bw = Math.round(400 * z);
    const bh = Math.round(58 * z);
    const top = Math.round(ctx.chromeHeight() * z) + Math.round(6 * z);
    return { x: Math.max(0, w - bw - Math.round(16 * z)), y: top, width: bw, height: bh };
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
    view.webContents.setZoomFactor(settings.uiZoom);
    view.webContents.focus();
    if (loaded) view.webContents.send('findbar:prefill', text);
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
    if (visible) {
      hide();
      ctx.activeTabWc()?.stopFindInPage('clearSelection');
    } else {
      show();
    }
  }

  return {
    toggle,
    hide,
    show,
    raise,
    isVisible: () => visible,
    view: () => view,
    bounds,
    getText: () => text,
    setText(t) { text = t; },
    clearText() { text = ''; },
    onZoomChanged() {
      if (!view) return;
      view.webContents.setZoomFactor(settings.uiZoom);
      if (visible) view.setBounds(bounds());
    },
    sendResult(result) {
      if (visible && view && !view.webContents.isDestroyed()) {
        view.webContents.send('findbar:result', result);
      }
    },
  };
}
