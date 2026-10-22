// Tab view lifecycle: WebContentsView factory, dark targetId marker flow,
// per-tab input wiring (zoom keys, Ctrl+F), event feeds into SpaceManager,
// scrollbar injection, find result forwarding.
// Receives a late-bound ctx (refs assigned by window.js as they come up).
import { WebContentsView } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { partitionForProfile as partitionFor } from './partitions.js';
import { zoomFromKey } from './zoom.js';

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
  // ctx: { win, httpEndpoint, settings, applyZoom, toggleFindbar,
  //        activeTabWc(), findbar: { isVisible(), view() }, spaces() }
  const { win, httpEndpoint, settings } = ctx;

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
      if (url.includes('wego-marker-')) return; // targetId marker
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
      webPreferences: { partition: partitionFor(space.profileId), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: space.ownership === 'agent' ? false : true },
    });
    wireTabView(space, tab, view);
    // Match the chrome background: when a re-attached view (z-order raise on
    // tab switch) or a freshly created view has no compositor frame yet,
    // the area fills with this color — white here reads as a jarring flash.
    view.setBackgroundColor('#17181c');
    win.contentView.addChildView(view);
    view.setBounds(ctx.initialViewBounds());
    const wc = view.webContents;
    const intended = tab.url && tab.url !== 'about:blank' ? normalizeUrl(tab.url) : NEWTAB_URL;
    // Dark data-URL marker: unique (matched in /json/list to resolve the
    // real CDP targetId) and dark, so new tabs no longer flash white
    // before the new-tab page paints.
    const marker = `data:text/html,<!doctype html><style>html{background:%2317181c}</style><!--wego-marker-${space.id}-${tab.targetId}-->`;
    tab.targetIdReady = (async () => {
      await wc.loadURL(marker);
      const realId = await resolveCdpTargetId(marker, wc);
      ctx.spaces().noteTargetId(space.id, tab.targetId, realId);
      return realId;
    })();
    // The real URL loads only after the marker round-trip so the target
    // list match above cannot race it away.
    tab.targetIdReady.then(() => {
      if (wc.isDestroyed()) return;
      wc.loadURL(intended).catch(() => {});
    }).catch(() => {});
    return view;
  }

  function destroyView(space, tab) {
    try { win.contentView.removeChildView(tab.view); } catch { /* not attached */ }
    try { tab.view?.webContents.close(); } catch { /* already destroyed */ }
  }

  return { createView, destroyView, wireInput };
}
