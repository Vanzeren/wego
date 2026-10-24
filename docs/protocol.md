# wego — Bridge Protocol

The bridge is wego's native layer (originally modeled on ego-lite's
closed-source bridge).
The Electron main process exposes it over a Unix domain socket; the
`wego-browser` CLI client (`src/client/wego.js`) consumes it and presents the
`globalThis.ego` surface; the agent-facing API is documented in
`skill-body/SKILL.md`.

## Transport

- Socket path: `$WEGO_BRIDGE_SOCK`, else `~/.wego/bridge.sock`.
- Newline-delimited JSON (NDJSON). One message per line, UTF-8.
- Request:  `{"id": <int>, "method": <string>, "params": <object>}`
- Success:  `{"id": <int>, "result": <any>}`
- Failure:  `{"id": <int>, "error": {"message": <string>, "error_code": <string>}}`
- Server push (no `id`): `{"event": <string>, ...payload}`

`error_code` values (originally following ego-lite's taxonomy): `WEGO_BROWSER_UNAVAILABLE`,
`WEGO_INVALID_ARGUMENT`, `WEGO_PROFILE_NOT_FOUND`, `WEGO_SNAPSHOT_FAILED`,
`WEGO_TASK_SPACE_INACTIVE`, `WEGO_TASK_SPACE_NOT_FOUND`,
`WEGO_TASK_SPACE_NOT_SELECTED`, `WEGO_TASK_SPACE_USER_IN_CONTROL`,
`WEGO_TASK_SPACE_NAME_IN_USE`, `WEGO_WEB_CONTENTS_UNAVAILABLE`,
`WEGO_OPERATION_FAILED`, `WEGO_CDP_CHANNEL_UNAVAILABLE`, `WEGO_CDP_SEND_FAILED`.

Argument validation failures use `WEGO_INVALID_ARGUMENT`.

## Methods

All task-space methods take the numeric space `id` explicitly in `params`.
(The client-side `ego.useTaskSpace(id)` stores the selection locally and adds
`id` to every call — the bridge never holds per-connection state.)

### Meta

- `ping()` → `"pong"`
- `focusWindow()` → `"focused."` — raise and focus the browser window (agents
  can surface results without the user hunting for the window).
- `getBrowserVersion()` → `{ currentVersion: string, updateAvailable: false }`
- `listProfiles()` → `{ profiles: [{ id, name, isDefault }] }`
  - `Default` always exists and maps to the shared `persist:default` session
    partition (logins carry over between all Default-profile spaces). Extra
    profiles persist in `~/.wego/profiles.json` and get isolated
    partitions (`persist:profile-<id>`).
- `createProfile({ name })` → `{ id, name }` — CLI/UI extension; not exposed
  through the `ego.*` agent bindings.
- `importChromeCookies({ profileId?, chromeDir? })` → `{ imported, failed,
  undecryptable, expired, total, profileId }` — decrypts desktop Chrome
  cookies (libsecret/KWallet keyring) and injects them into the session
  partition of `profileId` (default `Default`). `chromeDir` overrides the
  Chrome profile directory. `WEGO_PROFILE_NOT_FOUND` on unknown profileId.

### Task spaces

- `listTaskSpaces()` → `{ taskSpaces: [{ id, taskId, name, createdBy: "user"|"agent", ownership: "user"|"agent", control: "user"|"agent", profileId, profileName, recentTabTitles: string[] }] }`
- `createTaskSpace({ name, profileId? })` → `{ id, taskId, name }`
  - `profileId` omitted, `"default"`, or `"Default"` ⇒ Default profile.
    Unknown id ⇒ `WEGO_PROFILE_NOT_FOUND`. Other errors:
    `WEGO_INVALID_ARGUMENT` (bad name/profileId type),
    `WEGO_TASK_SPACE_NAME_IN_USE` (an agent-owned
    space with this name already exists; that case instead RESUMES the space
    and returns its descriptor — name collision with a *user-owned* space
    returns the error).
- `claimTaskSpace({ id, name? })` → `{ id, taskId, name }`
  - Errors: `WEGO_TASK_SPACE_NOT_FOUND` (`"Task space not found: <id>"`),
    `WEGO_TASK_SPACE_NAME_IN_USE` (another agent-owned space has `name`).
- `closeTaskSpace({ id })` → `"<id> task space closed."` (destroys tabs+space)
- `completeTaskSpace({ id })` → `"<id> task space completed."` (space stays,
  ownership flips to user)
- `handOffTaskSpace({ id })` → `"<id> has been handed off to the user."`
- `takeOverTaskSpace({ id })` → `"<id> has been taken over by the agent."`
  - Only agent-owned spaces can be taken over. User-owned spaces return
    `WEGO_TASK_SPACE_USER_IN_CONTROL`; use `claimTaskSpace` instead.
- `setAgentTaskState({ id, state })` → `"<id> state updated."`
- `animationHighlightMouseToPosition({ id, x, y })` → `"<id> mouse highlight shown."`

### Tabs (task-space scoped; `{ id, ... }`)

- `createTab({ id, url })` → `{ targetId, index }`
- `listTabs({ id })` → `{ tabs: [{ index, targetId, url, title, active }] }`
- `closeTab({ id, targetId })` → `{ closed: true }`
- `activateTab({ id, targetId })` → `{ activated: true }`

Tab mutation while `control === "user"` fails with
`WEGO_TASK_SPACE_USER_IN_CONTROL`.

### Snapshot

- `snapshot({ id, targetId?, options? })` → `{ content: string, refs: Ref[] }`
  - `targetId` omitted ⇒ the space's active tab.
  - `options`: `{ scope?: "full_page"|"only_within_viewport"|"subtree",
    root?: number, interactiveOnly?: boolean, includeActionMarks?: boolean,
    includeStableLocator?: boolean, maxResultLength?: number }`
  - `scope:"subtree"` requires `root` = a `refId` from a previous snapshot.
    With `rootFrameId` (set by the SDK when the root ref has a `frameId`),
    the capture runs inside that OOPIF target instead of the top document.
  - `Ref`: `{ refId: number, role: string, name: string,
    loc?: string, framePath?: string, frameId?: string }`
    (`loc` only when a unique stable locator exists; `framePath` like `"0/2"`
    for same-origin iframe descent, omitted for the top document; `frameId`
    is the OOPIF's CDP target id when the node lives in a cross-origin
    iframe).
  - Cross-origin OOPIFs are captured from their own CDP targets and merged
    under their iframe line; their refIds come from disjoint blocks
    (100000+) so they never collide with top-document refs. Ref resolution
    for `frameId` refs happens on a session attached to that frame target.
  - Rejects with `WEGO_SNAPSHOT_FAILED` / `WEGO_TASK_SPACE_USER_IN_CONTROL` /
    `WEGO_INVALID_ARGUMENT` (unknown or destroyed `targetId`) /
    `WEGO_WEB_CONTENTS_UNAVAILABLE` (contents destroyed mid-capture).

### Zoom

- `appZoom({ scope: "ui"|"page", dir: -1|0|1 })` → `{ uiZoom, pageZoomLevel }`
  - `ui`: scales the whole chrome UI (zoomFactor ladder, ×1.1 steps, clamped
    to 0.5–2.0).
    `page`: browser-style layout zoom on the active tab (Chromium zoom-level
    ladder, 0.5 steps; per-origin persistence is native). `dir: 0` resets.
    Same code path as the `Ctrl +/-/0` (page) and `Ctrl+Shift +/-/0` (UI)
    shortcuts. Settings persist in `~/.wego/settings.json`.

### Clipboard

- `paste({ id, targetId?, text?, html? })` → `"<id> pasted."`
  - Writes the clipboard, performs a native paste at the current focus of the
    addressed tab (active tab by default), then restores the user's previous
    clipboard. One of `text`/`html` is required. Gated by user control.
  - Rejects with `WEGO_INVALID_ARGUMENT` for an unknown or destroyed
    `targetId`, and with `WEGO_OPERATION_FAILED` (`paste did not reach the
    page`) when the paste never lands in the page within the 400ms delivery
    window (clipboard is still restored).

### CDP

- `cdpMessage(message)` → `{ accepted: true }`
  - `message` is one raw CDP message object: `{ id?, method, params?, sessionId? }`
    (`id` integer, `method` non-empty string, `sessionId` string; violations
    are `WEGO_INVALID_ARGUMENT`).
  - The bridge acknowledges immediately. CDP responses and events are pushed
    back on the same connection as `{ event: "cdp", message }` lines, in the
    exact shape the Chromium DevTools WebSocket would have delivered:
    `{ id, result, sessionId? }` | `{ id, error, sessionId? }` |
    `{ method, params, sessionId? }`.

Raw CDP tunnels over the authenticated bridge socket — there is NO TCP debug
endpoint. Each bridge connection gets one virtual browser-level session on
the first `cdpMessage` (flatten sessions: `Target.attachToTarget
{ flatten:true }`; `flatten:false` is rejected). Emulated browser-level
methods: `Target.getTargets` (task-space tabs plus their OOPIF `iframe`
targets), `Target.setDiscoverTargets` (drives `targetCreated` /
`targetInfoChanged` / `targetDestroyed` pushes), `Target.attachToTarget`,
`Target.detachFromTarget`, `Browser.getVersion`. All other domains run on
virtual page/frame sessions backed by the tab's in-process
`webContents.debugger` (`src/browser/cdp-server.js`). When a tab's debugger
drops (renderer crash), the server synthesizes `Target.detachedFromTarget`
for every virtual session on that tab. User-control gating for raw CDP is
enforced client-side by `src/client/wego.js` via bridge state.

Dev escape hatch: `WEGO_DEBUG_PORT=<port>` at launch re-enables Chromium's
UNAUTHENTICATED DevTools TCP server on 127.0.0.1 — local debugging only,
never on shared machines.

## Server-push events

- `{ event: "spaceChanged", spaceId }` — ownership/control/tab-list/title changed.
- `{ event: "taskState", spaceId, state }` — agent progress text changed.
- `{ event: "cdp", message }` — CDP response/event for this connection's
  virtual CDP session (see the CDP section).

Clients may ignore pushes; all state is re-readable via methods.

## In-page snapshot registry contract

The snapshot engine (`src/browser/snapshot/`) installs a registry in the page's
MAIN world before/while capturing:

```js
globalThis.__wegoSnapshot = {
  token: string,                    // changes on every document navigation
  getRefElement(refId): Element|null, // null = stale/unknown ref
  getDocumentToken(): string,       // === token of the top document
}
```

The SDK resolves `@N` refs by `Runtime.evaluate`-ing
`__wegoSnapshot.getRefElement(N)` with `returnByValue:false` to obtain an
`objectId`, then works via `DOM.*`/`Input.*` on the page CDP session. A `null`
return or token mismatch ⇒ ref stale ⇒ caller must re-snapshot.
