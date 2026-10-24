# Changelog

All notable changes to wego are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Preserve non-ASCII bridge/CDP payloads when UTF-8 characters span socket
  chunks instead of silently inserting replacement characters.
- Return an adopted `Page` from `waitForEvent("popup")`, make string-value
  `selectOption()` work, and surface in-page selection exceptions.
- Keep user and unknown-origin Pages during `finish()`; claimed/taken-over
  spaces no longer close all pre-existing tabs during routine cleanup.
- Clamp UI zoom to the validated 50%–200% range so zooming at the upper bound
  no longer throws `WEGO_INVALID_ARGUMENT`.
- Enumerate OOPIF targets on cold tabs, isolate explicit/auto-attach child
  sessions, restrict frame detach permissions, and clean debugger listeners
  and session state on renderer detach.
- Reject inherited bridge method names and prototype-property setting keys
  instead of treating them as valid APIs or preferences.
- Make space restoration atomic for corrupt payloads, keep restored id
  allocation monotonic, resolve agent-name collisions deterministically, and
  block takeover of user-owned spaces.
- Use a scoped Firefox-compatible identity on `accounts.google.com` so Google
  OAuth can proceed, restoring the normal UA on every non-Google request and
  navigation instead of changing cookies or disabling security features.
- Preserve host-only versus domain scope when importing Chrome cookies,
  preventing duplicate Google/OpenAI OAuth state and `CookieMismatch` after
  import into Electron.

## [0.1.0] — 2026-10-23

First public-ready state. wego is a Linux browser that shares your logged-in
session with AI agents in isolated, watchable task spaces — a Linux-native
sibling of ego-lite with its own product direction.

### Added

- Electron 38 browser shell: frameless window, tab strip, omnibox with
  keyword search, spaces sidebar, find bar (Ctrl+F), HiDPI zoom.
- Task spaces: create/resume-by-name/claim, ownership and control states,
  handoff/takeover, agent progress text, persistent across restarts.
- wego-browser CLI + Node SDK (`globalThis.ego` bindings + v2 TaskSpace/Page
  helpers): snapshot with accessibility-tree refs, click/fill/type/press/
  hover/select, waits (URL/load/selector/function/networkidle/popup/
  download/file chooser), screenshots, raw CDP, file upload, clipboard paste
  (text/html), downloads registry.
- Cross-origin OOPIF snapshots: frames merged with disjoint ref blocks and
  frameId-tagged refs; actions dispatch on the frame's own session.
- Site learnings: per-host notes + executable tools under
  `~/.wego/learnings/` (user-local, never committed).
- Profiles: shared Default profile (agents inherit your logins), extra
  isolated profiles, Chrome cookie import (libsecret/KWallet, v10/v11).
- Settings panel (⚙ / Ctrl+,): UI zoom, page zoom, search engine
  (DuckDuckGo/Bing/Google/百度), download directory, session restore toggle.
- Bridge: NDJSON JSON-RPC over `~/.wego/bridge.sock` (0600, inside 0700 dir).
- Raw CDP tunnels over the bridge socket via an in-process virtual endpoint
  (webContents.debugger flatten sessions) — no TCP debug port exists.

### Security

- No unauthenticated CDP TCP listener (WEGO_DEBUG_PORT is a documented,
  dev-only escape hatch).
- Page-session CDP is scoped: Target.getTargets/attachToTarget can't escape
  the tab's own subtree; chrome/settings/findbar internals are unreachable.
- Sandboxed renderers, no page-reachable IPC, CSP on internal pages,
  sender-verified ui:action channel.
- Chrome cookie DB staged under the 0700 state dir, 0600 copies.

### Reliability

- Two full audit rounds (47 fixes): deterministic hybrid pointer input
  (real CDP events foreground, synthetic covered), session reattach with
  full re-arm, popup adoption chain, download/waiter/poll lifecycle leaks,
  orphan-tab and ref-block collision fixes.
- 131 unit tests + end-to-end smoke (snapshot, OOPIF click, paste, file
  chooser, popups) — `npm test`, `npm run smoke`.

### Known limitations

- Linux only (Wayland and X11 verified on KDE).
- OOPIF support is one frame level deep; selector-based actions don't cross
  into OOPIFs (use refs from a snapshot).
- Covered (background) tabs receive synthetic input events
  (`isTrusted: false`); bring the space to the foreground for sites that
  require trusted events.
- Chrome import covers cookies only (no bookmarks/extensions/history).
- Multi-window (one window per space) is deferred by design.
