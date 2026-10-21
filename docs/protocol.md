# ego-lite Linux — Bridge Protocol

The bridge is the Linux equivalent of ego-lite's closed-source native layer.
The Electron main process exposes it over a Unix domain socket; the
`ego-browser` CLI client (`src/client/ego.js`) consumes it and presents the
`globalThis.ego` surface documented in `docs/native-api.md`.

## Transport

- Socket path: `$EGO_BRIDGE_SOCK`, else `~/.ego-lite/bridge.sock`.
- Newline-delimited JSON (NDJSON). One message per line, UTF-8.
- Request:  `{"id": <int>, "method": <string>, "params": <object>}`
- Success:  `{"id": <int>, "result": <any>}`
- Failure:  `{"id": <int>, "error": {"message": <string>, "error_code": <string>}}`
- Server push (no `id`): `{"event": <string>, ...payload}`

`error_code` values follow ego-lite: `EGO_BROWSER_UNAVAILABLE`,
`EGO_INVALID_ARGUMENT`, `EGO_PROFILE_NOT_FOUND`, `EGO_SNAPSHOT_FAILED`,
`EGO_TASK_SPACE_INACTIVE`, `EGO_TASK_SPACE_NOT_FOUND`,
`EGO_TASK_SPACE_NOT_SELECTED`, `EGO_TASK_SPACE_USER_IN_CONTROL`,
`EGO_TASK_SPACE_NAME_IN_USE`, `EGO_WEB_CONTENTS_UNAVAILABLE`,
`EGO_OPERATION_FAILED`, `EGO_CDP_CHANNEL_UNAVAILABLE`, `EGO_CDP_SEND_FAILED`.

Argument validation failures use `EGO_INVALID_ARGUMENT`.

## Methods

All task-space methods take the numeric space `id` explicitly in `params`.
(The client-side `ego.useTaskSpace(id)` stores the selection locally and adds
`id` to every call — the bridge never holds per-connection state.)

### Meta

- `ping()` → `"pong"`
- `getBrowserVersion()` → `{ currentVersion: string, updateAvailable: false, cdpEndpoint: string }`
  - `cdpEndpoint`: WebSocket URL of the Chromium browser-level CDP endpoint
    (e.g. `ws://127.0.0.1:PORT/devtools/browser/<id>`). Raw CDP and SDK
    sessions go directly over this endpoint, not through the bridge.
- `listProfiles()` → `{ profiles: [{ id, name, isDefault }] }`
  - `Default` always exists and maps to the shared `persist:default` session
    partition (logins carry over between all Default-profile spaces). Extra
    profiles persist in `~/.ego-lite/profiles.json` and get isolated
    partitions (`persist:profile-<id>`).
- `createProfile({ name })` → `{ id, name }` — CLI/UI extension; not exposed
  through the `ego.*` agent bindings.
- `importChromeCookies({ profileId?, chromeDir? })` → `{ imported, failed,
  undecryptable, expired, total, profileId }` — decrypts desktop Chrome
  cookies (libsecret/KWallet keyring) and injects them into the session
  partition of `profileId` (default `Default`). `chromeDir` overrides the
  Chrome profile directory. `EGO_PROFILE_NOT_FOUND` on unknown profileId.

### Task spaces

- `listTaskSpaces()` → `{ taskSpaces: [{ id, taskId, name, createdBy: "user"|"agent", ownership: "user"|"agent", control: "user"|"agent", profileId, profileName, recentTabTitles: string[] }] }`
- `createTaskSpace({ name, profileId? })` → `{ id, taskId, name }`
  - `profileId` omitted, `"default"`, or `"Default"` ⇒ Default profile.
    Unknown id ⇒ `EGO_PROFILE_NOT_FOUND`. Other errors:
    `EGO_INVALID_ARGUMENT` (bad name/profileId type),
    `EGO_TASK_SPACE_NAME_IN_USE` (an agent-owned
    space with this name already exists; that case instead RESUMES the space
    and returns its descriptor — name collision with a *user-owned* space
    returns the error).
- `claimTaskSpace({ id, name? })` → `{ id, taskId, name }`
  - Errors: `EGO_TASK_SPACE_NOT_FOUND` (`"Task space not found: <id>"`).
- `closeTaskSpace({ id })` → `"<id> task space closed."` (destroys tabs+space)
- `completeTaskSpace({ id })` → `"<id> task space completed."` (space stays,
  ownership flips to user)
- `handOffTaskSpace({ id })` → `"<id> has been handed off to the user."`
- `takeOverTaskSpace({ id })` → `"<id> has been taken over by the agent."`
- `setAgentTaskState({ id, state })` → `"<id> state updated."`
- `animationHighlightMouseToPosition({ id, x, y })` → `"<id> mouse highlight shown."`

### Tabs (task-space scoped; `{ id, ... }`)

- `createTab({ id, url })` → `{ targetId, index }`
- `listTabs({ id })` → `{ tabs: [{ index, targetId, url, title, active }] }`
- `closeTab({ id, targetId })` → `{ closed: true }`
- `activateTab({ id, targetId })` → `{ activated: true }`

Tab mutation while `control === "user"` fails with
`EGO_TASK_SPACE_USER_IN_CONTROL`.

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
  - Rejects with `EGO_SNAPSHOT_FAILED` / `EGO_TASK_SPACE_USER_IN_CONTROL` /
    `EGO_WEB_CONTENTS_UNAVAILABLE`.

### Clipboard

- `paste({ id, targetId?, text?, html? })` → `"<id> pasted."`
  - Writes the clipboard, performs a native paste at the current focus of the
    addressed tab (active tab by default), then restores the user's previous
    clipboard. One of `text`/`html` is required. Gated by user control.

### CDP

- `getCDPEndpoint()` → `{ webSocketDebuggerUrl, httpEndpoint }`

Raw CDP does NOT flow over the socket. The client connects to
`webSocketDebuggerUrl` and uses flatten sessions
(`Target.attachToTarget {flatten:true}`). User-control gating for raw CDP is
enforced client-side by `src/client/ego.js` via bridge state.

## Server-push events

- `{ event: "spaceChanged", spaceId }` — ownership/control/tab-list/title changed.
- `{ event: "taskState", spaceId, state }` — agent progress text changed.

Clients may ignore pushes; all state is re-readable via methods.

## In-page snapshot registry contract

The snapshot engine (`src/browser/snapshot/`) installs a registry in the page's
MAIN world before/while capturing:

```js
globalThis.__egoSnapshot = {
  token: string,                    // changes on every document navigation
  getRefElement(refId): Element|null, // null = stale/unknown ref
  getDocumentToken(): string,       // === token of the top document
}
```

The SDK resolves `@N` refs by `Runtime.evaluate`-ing
`__egoSnapshot.getRefElement(N)` with `returnByValue:false` to obtain an
`objectId`, then works via `DOM.*`/`Input.*` on the page CDP session. A `null`
return or token mismatch ⇒ ref stale ⇒ caller must re-snapshot.
