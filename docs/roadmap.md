# Roadmap / design notes

## Done: cross-origin OOPIF refs in snapshots

Implemented (v0.1.0): OOPIFs appear as `iframe` CDP targets; the orchestrator
(`src/browser/snapshot/index.js`) captures each from its own flatten session
with a disjoint ref block (k·100000), verifies ownership via
`DOM.getFrameOwner`, merges text/refs (`merge.js`), and tags refs with
`frameId`. SDK ref resolution and all element actions run on a session
attached to the frame target — coordinates are frame-viewport-local, so no
translation is needed (verified by probe + smoke OOPIF case). Remaining
edges: selector-based actions don't cross into OOPIFs (refs only); OOPIF
`subtree` scope captures the whole frame; nested OOPIF ownership checks are
best-effort.

## Later

- ~~Chrome profile import~~ Done for cookies (`profiles import-chrome`):
  libsecret + KWallet key sources, v10/v11 decryption, host-hash strip,
  expired/SameSite=None handling. Still open: extensions/bookmarks/history,
  non-Default Chrome profiles.
- Persistent spaces across restarts (serialize SpaceManager state; tabs
  restore from session history).
- `keyboard.paste({ html })` via the Electron clipboard module exposed over
  the bridge (browser-side clipboard write, then `Control+V` dispatch, then
  restore the user's clipboard — the macOS/Windows ego behavior).
- Multi-window support (one window per space on demand).
- Debounced/queued `spaceChanged` pushes for chatty pages.
