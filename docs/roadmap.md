# Roadmap / design notes

## Next: cross-origin OOPIF refs in snapshots (the headline gap)

Current state: the snapshot engine descends into same-origin iframes via
`contentDocument` from the top document's main world. Cross-origin iframes are
out-of-process (OOPIF): `contentDocument` is null, so the engine prints the
`iframe` line without children or refs.

Design sketch:

1. **Discovery.** On the page CDP session, `Page.getFrameTree` lists all
   frames with `frame.id` and parentage. Frames whose origin differs from the
   top document run as separate CDP targets (type `"iframe"`), attachable via
   `Target.attachToTarget { flatten: true }` from the browser session.
2. **Per-frame capture.** Inject the same `page-script.js` into each OOPIF
   session (`Runtime.evaluate` in that target's main world), call
   `__egoSnapshot.capture(options)`. Refs stay unique if each frame's registry
   allocates from a disjoint range: seed the counter with a frame-specific
   base (e.g. top frame 1–999999, each OOPIF assigned a base of
   `1_000_000 * (k+1)` by the orchestrator at injection time).
3. **Merge.** The browser-side snapshot orchestrator
   (`src/browser/snapshot/index.js`) stitches each OOPIF subtree under its
   `iframe` line, sets `frameId` on ref entries (OOPIF target id), and keeps
   `framePath` for same-origin descent.
4. **Ref resolution.** `refs.js` currently evaluates
   `__egoSnapshot.getRefElement(N)` on the page's top session. It must route
   by ref range/frameId to the owning OOPIF session; the Page ledger stores
   `frameId` per ref from the merged snapshot. Stale-frame detach
   (`Target.detachedFromTarget`) invalidates that frame's refs.
5. **Coordinates.** `DOM.getContentQuads` inside an OOPIF returns
   frame-viewport coordinates; translate by the iframe element's content box
   in the ancestor chain before `Input.dispatchMouseEvent` on the top target.

Acceptance mirrors the ego native-snapshot-ref requirement: one page with a
same-origin iframe and a cross-origin OOPIF, repeated backend node ids across
renderers, every printed button/textbox gets a distinct ref, each ref resolves
in its own frame.

## Later

- Chrome profile import (cookies via Secret Service keyring + SQLite,
  extensions/bookmarks copy) — the onboarding feature of ego-lite.
- Persistent spaces across restarts (serialize SpaceManager state; tabs
  restore from session history).
- `keyboard.paste({ html })` via the Electron clipboard module exposed over
  the bridge (browser-side clipboard write, then `Control+V` dispatch, then
  restore the user's clipboard — the macOS/Windows ego behavior).
- Multi-window support (one window per space on demand).
- Debounced/queued `spaceChanged` pushes for chatty pages.
