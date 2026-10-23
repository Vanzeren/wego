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

- Occluded (covered) tabs report `visibilityState: hidden`, so
  IntersectionObserver-gated lazy content (e.g. bilibili's video player
  element) never initializes while an agent's page is backgrounded. Options:
  per-agent-space secondary window (ego-style), or a "bring to front
  temporarily" automation step. Found during the real-site tour (S4).
- ~~Chrome profile import~~ Done for cookies (`profiles import-chrome`):
  libsecret + KWallet key sources, v10/v11 decryption, host-hash strip,
  expired/SameSite=None handling, `--profile`/`--chrome-dir` targeting.
  Still open: extensions/bookmarks/history.
- ~~Persistent spaces across restarts~~ Done: `spaces.json` debounce-saved on
  every mutation, restored at startup; control resets to user, resume-by-name
  flips it back to agent.
- ~~`keyboard.paste({ html })`~~ Done: bridge-side clipboard write, native
  paste, restore.
- Multi-window support (one window per space on demand) — deferred: the
  single window + space switcher covers current agent and daily-browse flows.
- ~~Debounced/queued `spaceChanged` pushes~~ Done: 30ms per-space coalescing;
  `taskState` stays immediate.
- Chrome bookmarks/history/extensions import — deferred: bookmark import has
  no UI to land in yet (no bookmarks bar), and the reference Chrome profile
  has zero bookmarks; extensions are not loadable into Electron sessions in
  any supported way. Revisit when a bookmarks UI exists.
