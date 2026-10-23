// Tab view lifecycle: WebContentsView factory, targetId resolution via the
// in-process debugger (VirtualCdpServer.resolveTargetId), per-tab input
// wiring (zoom keys, Ctrl+F), event feeds into SpaceManager,
// scrollbar injection, find result forwarding.
// Receives a late-bound ctx (refs assigned by window.js as they come up).
import { WebContentsView } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { partitionForProfile as partitionFor } from './partitions.js';
import { zoomFromKey } from './zoom.js';
import { cleanUserAgent } from './ua.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Blank tabs load the designed new-tab page; state keeps 'about:blank' as
// the canonical "empty tab" value so the omnibox stays clean.
export const NEWTAB_URL = pathToFileURL(path.join(__dirname, 'renderer', 'newtab.html')).href;

function normalizeUrl(input) {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)) return input;
  return `https://${input}`;
}

// Slim dark scrollbars for every page; pages with their own scrollbar
// styling keep precedence on equal specificity via cascade order.
const SCROLLBAR_CSS = `
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(128,128,128,.38); border-radius: 6px;
  border: 2px solid transparent; background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background-color: rgba(128,128,128,.62); }
::-webkit-scrollbar-button { display: none; }
::-webkit-scrollbar-corner { background: transparent; }
`;

export function setupViews(ctx) {
  // ctx: { win, cdpServer, settings, applyZoom, toggleFindbar,
  //        activeTabWc(), findbar: { isVisible(), view() }, spaces() }
  const { win, settings } = ctx;

  // Electron shows a native save dialog for downloads unless a will-download
  // handler sets a path — CDP Browser.setDownloadBehavior alone does NOT stop
  // it. Policy: save to ~/Downloads with Chrome-style dedupe (" (n)" suffix),
  // and record every download in ctx.downloads (unique id → {savePath,state})
  // so the SDK can resolve the real file via the bridge `downloads` method.
  // The id is `url#N`: concurrent same-URL downloads no longer overwrite each
  // other, and settled entries prune after a 60s grace TTL so the registry cannot grow unbounded.
  const wiredSessions = new WeakSet();
  let downloadSeq = 0;
  function wireDownloads(wc) {
    if (wiredSessions.has(wc.session)) return;
    wiredSessions.add(wc.session);
    wc.session.on('will-download', (_e, item) => {
      const dir = path.join(process.env.HOME || '/tmp', 'Downloads');
      fs.mkdirSync(dir, { recursive: true });
      // Defense-in-depth: strip any path components from the suggested name
      // (Chromium already does) and fall back when nothing usable remains.
      let name = path.basename(item.getFilename());
      if (!name || name === '.' || name === '..') name = 'download';
      let target = path.join(dir, name);
      for (let n = 1; fs.existsSync(target); n++) {
        const ext = path.extname(name);
        target = path.join(dir, `${name.slice(0, -ext.length)} (${n})${ext}`);
      }
      item.setSavePath(target);
      const id = `${item.getURL()}#${++downloadSeq}`;
      const entry = { id, url: item.getURL(), filename: name, savePath: target, state: 'progressing' };
      ctx.downloads.set(id, entry);
      item.on('updated', (_ev, state) => { entry.state = state === 'interrupted' ? 'interrupted' : 'progressing'; });
      item.once('done', (_ev, state) => {
        entry.state = state; // 'completed' | 'cancelled' | 'interrupted'
        // Keep settled entries for a grace TTL: a download that completes
        // within one bridge poll gap must still be observable by
        // waitForEvent('download')/saveAs; prune after to bound the registry.
        setTimeout(() => ctx.downloads.delete(id), 60_000).unref();
      });
    });
  }

  function wireInput(wc) {
    wc.on('before-input-event', (event, input) => {
      // Ctrl+F: toggle the find bar regardless of which webContents has focus.
      if (input.type === 'keyDown' && input.control && !input.shift && !input.alt && !input.meta
          && (input.key === 'f' || input.key === 'F')) {
        ctx.toggleFindbar();
        event.preventDefault();
        return;
      }
      const z = zoomFromKey(input);
      if (!z) return;
      ctx.applyZoom(z.scope, z.dir);
      event.preventDefault();
    });
  }

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
    wireInput(wc);
    // find-in-page results for the find bar (only from the active tab)
    wc.on('found-in-page', (_e, result) => {
      const fb = ctx.findbar;
      if (fb.isVisible() && fb.view() && ctx.activeTabWc() === wc && !fb.view().webContents.isDestroyed()) {
        fb.view().webContents.send('findbar:result', {
          matches: result.matches ?? 0,
          activeMatchOrdinal: result.activeMatchOrdinal ?? 0,
        });
      }
    });
    // Popups (window.open / target=_blank) become tabs in the same space.
    wc.setWindowOpenHandler(({ url }) => {
      ctx.spaces().addUserTab(space.id, url || 'about:blank');
      return { action: 'deny' };
    });
    const trackUrl = (url) => {
      ctx.spaces().noteUrl(space.id, tab.targetId, url === NEWTAB_URL ? 'about:blank' : url);
    };
    wc.on('did-navigate', (_e, url) => trackUrl(url));
    wc.on('did-navigate-in-page', (_e, url) => trackUrl(url));
    wc.on('page-title-updated', (_e, title) => ctx.spaces().noteTitle(space.id, tab.targetId, title));
    // re-inject per navigation; remove the previous copy first
    let scrollbarCssKey = null;
    wc.on('dom-ready', () => {
      if (wc.isDestroyed()) return;
      if (scrollbarCssKey) wc.removeInsertedCSS(scrollbarCssKey).catch(() => {});
      wc.insertCSS(SCROLLBAR_CSS).then((k) => { scrollbarCssKey = k; }).catch(() => {});
    });
  }

  function createView(space, tab) {
    const view = new WebContentsView({
      // Agent tabs need timers/rAF at full rate; user tabs get Chromium's
      // background throttling to save CPU. Covered views reveal with the
      // (dark) view background, so the gap is invisible — see
      // setBackgroundColor below. Edge case: a user space claimed by an
      // agent keeps throttled tabs (claimTaskSpace does not recreate views).
      webPreferences: {
        partition: partitionFor(space.profileId), contextIsolation: true, nodeIntegration: false, sandbox: true,
        backgroundThrottling: space.ownership === 'agent' ? false : true,
        // Electron's dialog manager would open NATIVE windows for
        // alert/confirm/prompt, wedging the renderer and our CDP session.
        // Suppress them; the SDK installs a recording shim instead
        // (page.js _session: Runtime.addBinding + init script).
        disableDialogs: true,
      },
    });
    wireTabView(space, tab, view);
    wireDownloads(view.webContents);
    view.webContents.setUserAgent(cleanUserAgent(view.webContents.getUserAgent()));
    // Match the chrome background: when a re-attached view (z-order raise on
    // tab switch) or a freshly created view has no compositor frame yet,
    // the area fills with this color — white here reads as a jarring flash.
    view.setBackgroundColor('#17181c');
    ctx.win.contentView.addChildView(view);
    // Compositor priming: CDP Input.dispatchMouseEvent is silently dropped
    // until the view has been RE-ATTACHED once (remove+add rebinds its input
    // path). Doing it does not change z-order semantics: the layout self-heal
    // keeps the correct view on top either way.
    view.setBounds(ctx.initialViewBounds(space));
    const wc = view.webContents;
    const intended = tab.url && tab.url !== 'about:blank' ? normalizeUrl(tab.url) : NEWTAB_URL;
    // The real Chromium targetId comes from the in-process debugger
    // (Target.getTargetInfo) — no marker navigation, no DevTools HTTP
    // endpoint. The view paints its dark background color until the intended
    // page's first frame.
    tab.targetIdReady = (async () => {
      const realId = await ctx.cdpServer.resolveTargetId(wc);
      ctx.spaces().noteTargetId(space.id, tab.targetId, realId);
      // Readiness covers the intended page too: bridge listTabs/createTab
      // await this promise, so a racing SDK goto can never be clobbered by a
      // late new-tab-page load.
      if (!wc.isDestroyed()) await wc.loadURL(intended).catch(() => {});
      ctx.layoutViews(); // correct z-order / re-cover
      return realId;
    })();
    // Handlers (awaitTargetId/whenTabsReady) attach later; silence the
    // rejection window in between.
    tab.targetIdReady.catch(() => {});
    return view;
  }

  function destroyView(space, tab) {
    try { ctx.win.contentView.removeChildView(tab.view); } catch { /* not attached */ }
    try { tab.view?.webContents.close(); } catch { /* already destroyed */ }
  }

  return { createView, destroyView, wireInput };
}
