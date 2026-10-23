# Repository Guidelines (for agents working on this repo)

wego — the browser you and your agents share (Linux). Electron 38 shell + Unix-socket
bridge + Node SDK (`wego-browser` CLI). ESM JavaScript, **zero npm
dependencies** — do not add any without explicit approval. Node ≥ 22, Electron
≥ 38 (`electron` on PATH or `WEGO_ELECTRON`).

## Architecture invariants

- `docs/protocol.md` is the binding contract between the browser (bridge
  server) and the SDK (client + runtime). Change both sides together.
- The bridge never holds per-connection state; the numeric space `id` travels
  in every params object. `useTaskSpace(id)` is client-side selection.
- Raw CDP tunnels over the bridge socket (`cdpMessage` / `{event:"cdp"}`
  pushes) via the in-process VirtualCdpServer (`src/browser/cdp-server.js`);
  there is NO TCP debug endpoint (`WEGO_DEBUG_PORT` is the dev-only,
  unauthenticated escape hatch).
- Bridge responses must never expose placeholder `tab-N` targetIds;
  `SpaceManager.awaitTargetId` gates this. Views learn their real Chromium
  targetId via `Target.getTargetInfo` on the in-process
  `webContents.debugger` (`VirtualCdpServer.resolveTargetId`) — no marker
  navigation, no DevTools HTTP endpoint.
- **All tab views stay attached to the window at full visible bounds**; the
  active one is raised in z-order. Detaching or offscreen-parking collapses
  the layout viewport to 0x0 and silently breaks geometry/CDP Input. Covered
  views reveal with `view.setBackgroundColor`, which MUST stay the dark
  chrome color (`#17181c`) — a light color shows as a jarring flash on tab
  switch/create. Agent-owned tabs additionally need
  `backgroundThrottling: false` (automation timers); user tabs may throttle.
- **The chrome page can never paint over page views** — they are composited
  above it, so anything in the chrome renderer extending past the 84px top
  band gets clipped by the page. Floating overlays over page content (find
  bar, future handback/banner) MUST be their own small WebContentsView
  (see the findbar block in window.js), raised after the top page view in
  `layoutViews`.
- Error objects crossing the bridge carry `error_code` from protocol.md.

## Verify changes

```bash
npm start          # or let the CLI auto-launch
npm test           # unit/integration suite (node --test test/, no browser needed)
node scripts/smoke.mjs   # end-to-end: snapshot/fill/click/screenshot/file-chooser
wego-browser doctor
```

Two test layers, both are regression gates:
- `test/*.test.mjs` — fast unit/integration: SpaceManager, input mapping,
  ref ledger, bridge server over a real socket (fake view hooks), wego client
  against a scripted fake bridge. Runs without a display.
- `scripts/smoke.mjs` — real-browser e2e; extend it when adding Page surface.
For manual rounds keep a fixture server running:
`node -e "…serve ./fixtures on 18923…"` (see git history or scripts/smoke.mjs
for the server snippet), then `wego-browser nodejs <<'EOF' … EOF`.

Electron instances: the app holds a single-instance lock. `pkill -f
"/usr/lib/electron38"` before relaunching, or your new code never runs.

## Module map

- `src/browser/window.js` — orchestrator only: window creation, view layout
  (stacked bounds + z-order), zoom glue, startup restore.
- `src/browser/views.js` — tab view lifecycle: marker→targetId flow, input
  wiring (zoom keys, Ctrl+F), event feeds, scrollbar injection.
- `src/browser/findbar.js` — find bar overlay view (own WebContentsView).
- `src/browser/ipc.js` — `ui:action` dispatch table (gating rules live here).
- `src/browser/persistence.js` — `settings.json`/`spaces.json` (electron-free,
  unit-testable).
- `src/browser/spaces.js` — SpaceManager state machine (pure, no electron).
- `src/browser/bridge.js` — bridge socket server; `src/browser/cdp-server.js` —
  virtual CDP endpoint (raw CDP tunnel, refcounted webContents.debugger);
  `src/browser/snapshot/` — snapshot engine; `src/browser/chrome-import.js` —
  Chrome onboarding.
- `src/runtime/page.js` — Page class (core: sessions, receipts, evaluate);
  `src/runtime/driver/` holds Page-adjacent artifacts (`files.js` =
  Download/FileChooser, `namespaces.js` = mouse/keyboard factories).

## Conventions

- **Privacy (open-source hygiene): real site learnings NEVER go in the repo.**
  They live in `~/.wego/learnings/`. The repo carries only the impersonal
  format example `skills/wego-browser/learnings-example/`; `learnings/` is
  gitignored as a second line of defense. Before publishing, audit
  `git grep -i` for personal info anyway.
- Public helper/API changes: update `skill-body/SKILL.md` (the guide printed
  by `wego-browser skill`) and README in the same commit.
- Agent-facing semantics follow upstream ego-lite docs; deviate only for real
  platform constraints and document the deviation in skill-body + README.

## Test maintenance (mandatory)

- **Every behavior change ships with tests in the same commit.** No
  test-less fixes or features.
- Bug fix → add a regression test that fails before the fix and passes after
  (see `test/input.test.mjs` Shift-chord case for the pattern).
- New bridge method or changed params/results/error codes → extend
  `test/bridge.test.mjs`; client-side gating/validation →
  `test/wego-client.test.mjs`; state-machine change → `test/spaces.test.mjs`.
- New Page/SDK surface → extend `scripts/smoke.mjs` (real browser) and add
  fixture elements to `fixtures/` when the behavior needs them.
- Changing existing behavior: update the affected tests; never delete or
  weaken a failing assertion just to go green — pin the intended behavior
  instead.
- Before committing: `npm test` and `node scripts/smoke.mjs` must both pass.
  Fixtures for smoke live in `fixtures/`; do not hand-edit `/tmp` artifacts.
