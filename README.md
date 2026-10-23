# wego

**The browser you and your agents share.** wego is a Linux browser where AI
agents work in isolated **task spaces** inside the same browser you use —
their own tabs, their own control state, your logins. It started as a Linux
port of [ego-lite](https://github.com/citrolabs/ego-lite) and has since grown
its own product direction (cross-origin OOPIF snapshots, profiles, Chrome
onboarding, persistent spaces, HiDPI zoom, frameless UI).

Built on Electron 38 (Chromium) + Node.js. Zero npm dependencies.

```
┌──────────────────────────────────────────────────────────┐
│ Electron app (wego)                                      │
│  BrowserWindow ─ chrome UI (tabs, omnibox, spaces sidebar)│
│  WebContentsView per tab (persist:default session)        │
│  SpaceManager ─ spaces, ownership, user/agent control      │
│  Bridge server ─ NDJSON JSON-RPC over Unix socket          │
│  Snapshot engine ─ in-page accessibility tree + refs       │
└───────▲───────────────────────────────────────────────────┘
        │ ~/.wego/bridge.sock (CDP tunneled as cdpMessage/cdp)
┌───────┴────────┐               ┌────────────────┐
│ wego-browser CLI │               │ CDP sessions   │
│ nodejs / skill  │──────────────▶│ (flatten)      │
│ src/client/wego│  wego bindings│ src/runtime    │
└────────────────┘               └────────────────┘
```

## Install

**AppImage (recommended):** download `wego-<version>-x86_64.AppImage` from
[Releases](https://github.com/wzr666/wego/releases), `chmod +x`, run it.
Then install the CLI for your agents:

```bash
npm install -g wego-browser   # or: clone this repo and `npm link`
# point the CLI at the AppImage so it can auto-launch the browser:
echo 'export WEGO_ELECTRON="$HOME/Applications/wego-0.1.0-x86_64.AppImage"' >> ~/.bashrc
```

**From source:**

```bash
git clone https://github.com/wzr666/wego && cd wego
npm ci          # pinned Electron (devDependency) — reproducible
npm start       # launch the browser
npm link        # optional: put `wego-browser` on PATH
```

## Quick start

Requirements: Linux with a display (Wayland or X11), Node.js ≥ 22.
From source, `npm ci` provides Electron 38; otherwise install Electron
(`electron` on PATH) or set `WEGO_ELECTRON` to the binary/AppImage.

```bash
# from this directory
npm start                    # launch the browser
npm link                     # optional: put `wego-browser` on PATH

# drive it from any agent or shell
wego-browser nodejs <<'EOF'
const task = await taskSpace("research example");
const page = task.page("p1");
await page.goto("https://example.com");
console.log(await page.snapshot());
await task.finish({ keep: [] });
EOF
```

`wego-browser nodejs` auto-launches the browser if it is not running.

CLI subcommands: `nodejs` (run a script), `skill` (print the full agent usage
guide), `launch`, `doctor`, `version`, `help`.

The agent skill lives in `skills/wego-browser/` (install it into your agent's
skills directory); `skill-body/SKILL.md` is the versioned usage guide that
`wego-browser skill` prints.

## What works (verified end-to-end on Wayland/KDE)

- Frameless window with custom min/max/close controls; drag the chrome
  background to move, double-click to maximize.
- HiDPI zoom: `Ctrl +/-/0` page zoom (global: applies to all tabs and
  persists across navigations), `Ctrl+Shift +/-/0` whole-UI zoom; both persist
  (`~/.wego/settings.json`), also adjustable via the `appZoom` bridge method.
- Settings panel (⚙ button or `Ctrl+,`): UI zoom, default page zoom, default
  search engine (DuckDuckGo/Bing/Google/百度 — drives omnibox keyword
  search), download directory, and session-restore toggle. Changes apply
  instantly and persist to `~/.wego/settings.json`.

- Task spaces: create / resume-by-name / claim / list, numeric ids, ownership
  (`user`/`agent`) and control state; user-control gating returns
  `WEGO_TASK_SPACE_USER_IN_CONTROL` and blocks tabs, snapshot, and raw CDP.
- Handoff / takeover (`task.handOff()`, `takeOverTaskSpace(id)`), agent
  progress text, `finish({ keep })` semantics.
- Shared profile: all Default-profile spaces share `persist:default`, so
  agent spaces inherit your logins. Extra profiles
  (`wego-browser profiles create <name>`) get isolated cookie/storage
  partitions; bind a space with `taskSpace(name, { profile: "Profile 2" })`.
- Chrome onboarding: `wego-browser profiles import-chrome` decrypts and
  imports your desktop Chrome cookies (libsecret/GNOME or KWallet/KDE
  keyring) — verified to carry real login state. Target another ego profile
  with `--profile "Profile 2"` or another Chrome profile dir with
  `--chrome-dir`.
- Spaces persist across browser restarts (`~/.wego/spaces.json`): names,
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
- There is no TCP debug endpoint: raw CDP tunnels over the `0600` bridge
  socket. `WEGO_DEBUG_PORT` re-enables Chromium's unauthenticated 127.0.0.1
  DevTools server for local development — never set it on shared machines.

## Layout

```
src/browser/   Electron main: window.js (orchestrator), views.js (tab views),
               findbar.js (overlay), ipc.js (UI dispatch), persistence.js,
               spaces.js (state machine), bridge.js, snapshot/, chrome-import.js
src/client/    wego bindings client (Unix socket; raw CDP tunneled over it)
src/runtime/   agent SDK: TaskSpace/Page, selectors, refs, input, CDP sessions,
               driver/ (Download/FileChooser, mouse/keyboard namespaces)
src/cli/       wego-browser CLI (nodejs/skill/launch/doctor/profiles/...)
skill-body/    usage guide printed by `wego-browser skill`
skills/        entry agent skill + install reference
docs/          bridge protocol contract, roadmap
fixtures/      local test pages; scripts/smoke.mjs end-to-end check
```

`docs/protocol.md` is the binding contract between the browser and the SDK.
