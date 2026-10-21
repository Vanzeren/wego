# Repository Guidelines (for agents working on this repo)

Linux port of the ego-lite agent browser. Electron 38 shell + Unix-socket
bridge + Node SDK (`ego-browser` CLI). ESM JavaScript, **zero npm
dependencies** — do not add any without explicit approval. Node ≥ 22, Electron
≥ 38 (`electron` on PATH or `EGO_ELECTRON`).

## Architecture invariants

- `docs/protocol.md` is the binding contract between the browser (bridge
  server) and the SDK (client + runtime). Change both sides together.
- The bridge never holds per-connection state; the numeric space `id` travels
  in every params object. `ego.useTaskSpace(id)` is client-side selection.
- Raw CDP never flows over the bridge socket. The SDK connects to the
  browser-level CDP WebSocket (`getCDPEndpoint()`) with flatten sessions.
- Bridge responses must never expose placeholder `tab-N` targetIds;
  `SpaceManager.awaitTargetId` gates this. Views are created with a unique
  marker URL (`about:blank#ego-…`) that is matched in `/json/list`.
- **All tab views stay attached to the window at full visible bounds**; the
  active one is raised in z-order. Detaching or offscreen-parking collapses
  the layout viewport to 0x0 and silently breaks geometry/CDP Input.
- Error objects crossing the bridge carry `error_code` from protocol.md.

## Verify changes

```bash
npm start          # or let the CLI auto-launch
node scripts/smoke.mjs   # end-to-end: snapshot/fill/click/screenshot/file-chooser
ego-browser doctor
```

The smoke test is the regression gate; extend it when adding Page surface.
For manual rounds keep a fixture server running:
`node -e "…serve ./fixtures on 18923…"` (see git history or scripts/smoke.mjs
for the server snippet), then `ego-browser nodejs <<'EOF' … EOF`.

Electron instances: the app holds a single-instance lock. `pkill -f
"/usr/lib/electron38"` before relaunching, or your new code never runs.

## Conventions

- Public helper/API changes: update `skill-body/SKILL.md` (the guide printed
  by `ego-browser skill`) and README in the same commit.
- Agent-facing semantics follow upstream ego-lite docs; deviate only for real
  platform constraints and document the deviation in skill-body + README.
- Tests: `scripts/smoke.mjs` is the suite; fixtures in `fixtures/`.
