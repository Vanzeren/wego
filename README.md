# ego-lite for Linux

A Linux port of the [ego-lite](https://github.com/citrolabs/ego-lite) agent
browser: one Chromium browser that you and your AI agents share. Agents work
in isolated **task spaces** (their own tabs, their own control state) inside
the same browser, driving pages through a compact JavaScript SDK over CDP —
while your own browsing stays untouched.

Built on Electron 38 (Chromium) + Node.js. Zero npm dependencies.

```
┌──────────────────────────────────────────────────────────┐
│ Electron app (ego-lite)                                  │
│  BrowserWindow ─ chrome UI (tabs, omnibox, spaces sidebar)│
│  WebContentsView per tab (persist:default session)        │
│  SpaceManager ─ spaces, ownership, user/agent control      │
│  Bridge server ─ NDJSON JSON-RPC over Unix socket          │
│  Snapshot engine ─ in-page accessibility tree + refs       │
└───────▲───────────────────────────────▲──────────────────┘
        │ ~/.ego-lite/bridge.sock        │ ws://127.0.0.1 (CDP)
┌───────┴────────┐               ┌───────┴────────┐
│ ego-browser CLI │               │ CDP sessions   │
│ nodejs / skill  │──────────────▶│ (flatten)      │
│ src/client/ego  │  globalThis.ego│ src/runtime    │
└────────────────┘               └────────────────┘
```

## Quick start

Requirements: Linux with a display (Wayland or X11), Node.js ≥ 22, Electron 38
(`electron` on PATH, or set `EGO_ELECTRON`).

```bash
# from this directory
npm start                    # launch the browser
npm link                     # optional: put `ego-browser` on PATH

# drive it from any agent or shell
ego-browser nodejs <<'EOF'
const task = await taskSpace("research example");
const page = task.page("p1");
await page.goto("https://example.com");
console.log(await page.snapshot());
await task.finish({ keep: [] });
EOF
```

`ego-browser nodejs` auto-launches the browser if it is not running.

CLI subcommands: `nodejs` (run a script), `skill` (print the full agent usage
guide), `launch`, `doctor`, `version`, `help`.

The agent skill lives in `skills/ego-browser/` (install it into your agent's
skills directory); `skill-body/SKILL.md` is the versioned usage guide that
`ego-browser skill` prints.

## What works (verified end-to-end on Wayland/KDE)

- Frameless window with custom min/max/close controls; drag the chrome
  background to move, double-click to maximize.
- HiDPI zoom: `Ctrl +/-/0` page zoom (layout, per-origin), `Ctrl+Shift +/-/0`
  whole-UI zoom; both persist (`~/.ego-lite/settings.json`), also adjustable
  via the `appZoom` bridge method.

- Task spaces: create / resume-by-name / claim / list, numeric ids, ownership
  (`user`/`agent`) and control state; user-control gating returns
  `EGO_TASK_SPACE_USER_IN_CONTROL` and blocks tabs, snapshot, and raw CDP.
- Handoff / takeover (`task.handOff()`, `takeOverTaskSpace(id)`), agent
  progress text, `finish({ keep })` semantics.
- Shared profile: all Default-profile spaces share `persist:default`, so
  agent spaces inherit your logins. Extra profiles
  (`ego-browser profiles create <name>`) get isolated cookie/storage
  partitions; bind a space with `taskSpace(name, { profile: "Profile 2" })`.
- Chrome onboarding: `ego-browser profiles import-chrome` decrypts and
  imports your desktop Chrome cookies (libsecret/GNOME or KWallet/KDE
  keyring) — verified to carry real login state. Target another ego profile
  with `--profile "Profile 2"` or another Chrome profile dir with
  `--chrome-dir`.
- Spaces persist across browser restarts (`~/.ego-lite/spaces.json`): names,
  ownership, tabs, and page URLs are restored; control resets to the user and
  an agent regains it by resuming the space by name.
- Snapshot: accessibility-tree text with `[ref=N]` refs, roles/names, shadow
  DOM, same-origin iframes (`framePath`) AND cross-origin OOPIFs — captured
  from their own CDP targets, merged into one tree with frameId-tagged refs,
  clickable via the same `@N` flow. Disabled/hidden handling, compaction,
  subtree/viewport/full-page scopes, stable locators
  (`loc=role:...[name=...]`, unique CSS).
- Actions with real input: click/dblclick/hover/drag, fill (with edit
  verification), press, selectOption, setInputFiles, mouse.*, keyboard.*
  (chords, `ControlOrMeta`), all auto-scrolling the target into view.
- Selectors: `@N` refs, `text=` (quoted/unquoted), `loc=css:`/`loc=role:`/
  `loc=href:`, `xpath=`, `css=`, raw CSS, `>> nth=N`; shadow-piercing; exactly-
  one-match semantics with `not_found`/`ambiguous`/`not_actionable` errors.
- Waits: load states, URL, selector, function, network idle, popup/download
  events; dialogs (accept/dismiss); file choosers (`waitForFileChooser` +
  `setFiles`/`cancel`); screenshots; `page.evaluate`/`page.fetch`/`page.cdp`;
  raw browser CDP via `task.cdp`.
- Popups (`window.open`, `target=_blank`) become tabs in the same space;
  downloads via `waitForEvent("download")` + `saveAs`.
- `scripts/smoke.mjs`: self-contained end-to-end check (`npm run smoke`).

## Known limits (vs ego-lite on macOS/Windows)

- Selector-based actions (`css=`, `text=`, …) do not reach inside
  cross-origin OOPIFs — use a snapshot ref (`@N`) for those nodes. Nested
  OOPIF-in-OOPIF ownership checks are best-effort.
- Chrome import covers cookies (not extensions/bookmarks/history) and reads
  the `Default` Chrome profile.
- The remote-debugging endpoint is bound to 127.0.0.1 without auth; the bridge
  socket is `0600`. Do not expose either on shared machines.

## Layout

```
src/browser/   Electron main: window, spaces, bridge server, snapshot engine, renderer UI
src/client/    ego bindings client (Unix socket + CDP WebSocket)
src/runtime/   agent SDK: TaskSpace/Page, selectors, refs, input, CDP sessions
src/cli/       ego-browser CLI (nodejs/skill/launch/doctor/...)
skill-body/    usage guide printed by `ego-browser skill`
skills/        entry agent skill + install reference
docs/          bridge protocol contract
fixtures/      local test pages; scripts/smoke.mjs end-to-end check
```

`docs/protocol.md` is the binding contract between the browser and the SDK.
