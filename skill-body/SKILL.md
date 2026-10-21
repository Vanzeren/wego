[ego-browser:skill] ego-browser usage guide v0.1.0 (linux)

---
version: "0.1.0"
date: "2026-10-21"
---

# ego-browser

Call `help()` or `help("page.click")` inside a script to print signatures and
uncommon options of APIs named below; it prints by itself, so do not wrap it in
`console.log`. For installation or connection problems, read
`references/install.md` in the ego-browser Skill directory.

## Run browser scripts

Pass the script to `ego-browser nodejs`. On Linux and macOS shells (Bash, Zsh)
use a heredoc:

```bash
ego-browser nodejs <<'EOF'
const task = await taskSpace("inspect example page");
const page = task.page("p1");
await page.goto("https://example.com");

console.log({ taskSpaceId: task.spaceId, page: page.label });
console.log(await page.snapshot());
EOF
```

When a sandbox blocks heredoc input, use `-e` instead. Use single quotes around
the code and double quotes for JavaScript strings; single quotes within the code
require shell quoting:

```bash
ego-browser nodejs -e '
const task = await taskSpace("inspect example page");
await task.page("p1").goto("https://example.com");
console.log(task.spaceId);
'
```

For longer scripts, write a UTF-8 `.mjs` file and redirect it:

```bash
ego-browser nodejs < /absolute/path/round-01.mjs
```

Only Bash/Zsh-style shells are supported here; there is no PowerShell or cmd
form on Linux.

### Later rounds with a script file

Each run is a new process, and earlier rounds have already run. Write a new,
complete file for every round (`round-01.mjs`, `round-02.mjs`, ...) instead of
editing the previous one, which would replay old steps. Keep one goal's files in
a new directory named for the goal plus the date and time, such as
`~/ego/laptop-prices-20261021-1405/`, and only run files written in this
conversation. Create files with your file tool, not shell redirection with
locale-dependent encodings.

### When the script fails to parse

`SyntaxError: await is only valid in async functions and the top level bodies of
modules` almost always means the shell damaged the script before Node received
it; top-level `await` itself is supported. Do not wrap the code in an async
IIFE, open a new task space, or resend the same command. Switch to the `.mjs`
file form above.

The script always runs in Node.js, not in the web Page. Browser helpers and
Node.js APIs belong in the script; Page globals such as `window`, `document`,
`location`, and DOM APIs do not. Put browser-side JavaScript inside
`page.evaluate()`. Do not import Playwright or launch another browser.

The Node.js runtime uses ESM. When a script needs local files, load built-ins
with dynamic imports such as `await import("node:fs/promises")`. The script
does not run in your shell's working directory, so use absolute paths for every
file it reads or writes. It also does not inherit your shell's environment
variables: `process.env` will not contain values you set before running
`ego-browser`, so write every input directly into the script.

ego-browser deliberately exposes a small custom API. It is not Playwright, even
where method names and options look similar. Use only the TaskSpace, Page,
mouse, and keyboard APIs explicitly listed in this Skill. Do not
infer Playwright methods such as `locator()`, `getByRole()`, `context()`,
`expect()`, or `route()`. When the listed API does not cover an operation, use
the documented `page.evaluate()` or `page.cdp()` escape hatches instead of
guessing another method.

When the user explicitly asks for ego-browser, start with a real browser command
and diagnose the CLI or installation only if it fails.

## Spaces, rounds, and pages

- Use exactly one TaskSpace for the entire user goal. Create it once, print its
  `spaceId`, and resume that same space in later rounds. Use multiple spaces
  only when the user explicitly requests them.
- Task space names are unique. `taskSpace(name)` resumes your own space with
  that name instead of creating a second one. If the name belongs to a
  user-owned space, it fails with `EGO_TASK_SPACE_NAME_IN_USE`: ask the user
  whether to work in that space (then `claimTaskSpace(id)`), or pick another
  name.
- Never use a new TaskSpace to recover from a stuck, blocked, timed-out, or
  unexpected Page. Recover within the existing space; if it cannot continue,
  stop and ask the user.
- Every invocation starts a new Node.js process. Task spaces, tabs, and Page
  labels persist; JavaScript variables do not.
- A new task space starts with Page `p1`; navigate it instead of opening
  another Page.
- Reuse a Page with `goto()` instead of opening a new Page for every URL.
- All time values are milliseconds.

```js
// Later round: use the space id and Page label printed earlier.
const resumed = await taskSpace(7);
const source = resumed.page("p1");
await source.goto("https://example.com/releases");
```

Do not inspect or select profiles unless the user explicitly requests a
particular profile. Profiles are created outside the agent surface
(`ego-browser profiles create <name>`, or `ego-browser profiles` to list).
A profile applies only when creating a space; pass its `id` once:

```js
// New space bound to a non-default profile; cookies/storage are isolated
// from the Default profile. Resuming the same name keeps its profile.
const task = await taskSpace("work-scrape", { profile: "Profile 2" });
```

Omit `profile` for the Default profile shared with the user's own browsing.

Supported TaskSpace API:

- State: `spaceId`, `name`, `ownership`, `page(label)`, `userPage()`
- Pages: `await task.pages()`, `await task.tabs()`, `newPage()`,
  `adopt(desc, { as? })`, `release(label)`
- Control: `waitForControl(options)`, `handOff()`, `finish({ keep })`
- Advanced: `cdp(method, params)`

Pages receive permanent labels such as `p1`, `p2`, and `p3`. Reuse or close
Pages as the task proceeds.

`task.newPage()` creates another blank Page when multiple Pages must stay open.
Navigate it separately with `page.goto()`.

`task.page(label)` only refers to a Page that already exists; it never creates
one. Use labels printed by earlier output or by `await task.pages()`, and call
`await task.newPage()` to create one.

`await task.tabs()` returns every tab in the space as
`{ label?, page, targetId, title, url, active, openedBy }`. A tab without a
label is unmanaged; adopt it before operating:

```js
const active = (await task.tabs()).find((item) => item.active);
if (active && !active.label) {
  const page = await task.adopt(active);
  console.log({ page: page.label, url: await page.url() });
}
```

`release(label)` returns an unknown-origin Page to the user without closing its
tab. Close agent-created Pages with `page.close()`. Treat `openedBy: "unknown"`
as user-owned when deciding whether a Page may be closed.

## Page operations

ego-browser provides the following Page API:

- State and observation: `label`, `spaceId`, `openedBy`, `targetId`, `url()`,
  `title()`, `info()`, `snapshot()`, `screenshot()`
- Navigation and waits: `goto()`, `reload()`, `waitForURL()`,
  `waitForEvent()`, `waitForSelector()`, `waitForLoadState()`,
  `waitForFunction()`, `waitForTimeout()`
- Elements: `click()`, `dblclick()`, `hover()`, `dragAndDrop()`, `fill()`,
  `selectOption()`, `focus()`, `press()`, `setInputFiles()`,
  `waitForFileChooser()`, `close()`
- Dialogs: `acceptDialog(promptText?)`, `dismissDialog()`
- Pointer: `mouse.click()`, `mouse.move()`, `mouse.down()`, `mouse.up()`,
  `mouse.wheel()`
- Keyboard: `keyboard.down()`, `keyboard.up()`, `keyboard.press()`,
  `keyboard.type()`, `keyboard.insertText()`
- Page code and protocols: `evaluate(fnOrString, argument)`,
  `fetch(url, options)`, `cdp(method, params)`

`page.evaluate()` callbacks run only inside the Page; they cannot read variables
or Node.js modules from the surrounding script. Define browser-side helpers
inside the callback or pass one JSON-serializable value as its second argument.

Work efficiently:

- Each time you observe, collect only the cheapest page state sufficient to
  choose the next action. Use a snapshot for semantic or locator ground truth
  and a screenshot for visual confirmation; do not request both by default.
- If an action does not produce the expected result, inspect the current page
  before deciding whether to retry. Do not blindly repeat it or immediately
  fall back to coordinates or raw CDP.
- Once the page clearly shows the requested result, stop; do not confirm the
  same result through multiple surfaces.

### Semantic pages: snapshot and selectors

Prefer snapshots and semantic selectors for ordinary DOM pages. Use screenshots
and coordinates only when useful DOM semantics are unavailable.

Before choosing an unfamiliar target, take a snapshot. When the current state
is sufficient to plan several actions on the same Page, complete them in one
script invocation, then observe the result once. Keep the action sequence, the
wait for its final expected state, and the next snapshot in the same script
invocation. Print the snapshot last so the next round can act on it directly.

Wait for the expected result: use `waitForURL()` for navigation,
`waitForSelector()` for element state, or `waitForFunction()` for application
state. Avoid fixed delays when an observable condition exists. A snapshot
captures the current moment; it does not wait for the page to become stable.
`page.snapshot()` captures the current viewport. For content outside it, use
`page.snapshot({ scope: "full_page" })`.

To focus on an iframe's subtree, reuse the ref printed on its `iframe` line:

```js
console.log(await page.snapshot({ scope: "subtree", root: "@12" }));
```

Use the refs returned by the subtree for actions inside the iframe.

```js
// Round 1: inspect and choose targets from this output.
const page = task.page("p1");
console.log(await page.snapshot());
```

```js
// Next round: act using the previous output, verify, then prepare the next round.
const page = task.page("p1");
await page.fill("@21", "user@example.com");
await page.click("loc=role:button[name='Sign in']");
await page.waitForSelector("loc=css:#account-home", { state: "visible" });
console.log(await page.snapshot());
```

Element actions accept:

- snapshot refs such as `@21` or `ref=21`
- `text=...` for page content
- `loc=css:`, `loc=role:`, and `loc=href:` locators
- `xpath=...`
- `css=...` or raw CSS selectors
- a `>> nth=N` suffix after a CSS, text, or href selector (`N` is `-1` or
  non-negative) to pick among several matches

Selector actions require exactly one match unless `nth=` disambiguates.
Unquoted text normalizes whitespace, ignores case, and matches a substring;
quoted text such as `text="Save changes"` is exact and case-sensitive.

Snapshot node names are accessibility roles. Use a ref now or `loc=...` to find
the element again. After the page changes (DOM updates, navigation, raw CDP),
refs go stale: take a new snapshot before acting. When a useful node has no
ref, construct a selector from its role, text, or surrounding context.

Select options by value, visible label, or zero-based index; pass `null` to
clear the current selection:

```js
await page.selectOption("select[name=month]", { label: "October" });
```

### Visual pages: screenshot, mouse, and keyboard

Use a screenshot with mouse and keyboard operations for canvas, rich-text,
spreadsheets, maps, and other interfaces that lack useful DOM semantics:

```js
const path = await page.screenshot({ path: "/absolute/path/before.png" });
await page.mouse.click(420, 260);
await page.mouse.wheel(0, 600);
await page.keyboard.insertText("hello\tworld");
console.log({ screenshot: path });
```

`path` must be absolute; relative paths are rejected. Omit `path` to write into
the system temporary directory and use the returned file path.

Inspect the screenshot with an image-viewing tool. Coordinates use CSS pixels;
keyboard names and `+`-separated chords follow Playwright syntax. Verify the
resulting page state after coordinate-based actions.

## Action receipts, popups, and dialogs

When an action is expected to open a new Page, start the wait before the action:

```js
const popupPromise = page.waitForEvent("popup");
await page.click('a[target="_blank"]');
const popupPage = await popupPromise;
await popupPage.waitForLoadState();
```

A synchronous JavaScript dialog may appear as a receipt or in `page.info()`.
Handle it before continuing:

```js
await page.acceptDialog("prompt response");
// Or: await page.dismissDialog();
```

## User control and completion

Stop when the user takes control or the space is inactive. Do not retry or
route around the stop. Permission prompts and other browser-owned prompts
require the user to handle them.

When the user must act in the browser, call `await task.handOff()`, end the
round, and explain what they should do. After the user confirms, resume the
same space:

```js
const task = await takeOverTaskSpace(7);
const userPage = task.userPage();
```

Claim a user-owned or inactive space only when the user explicitly asks. Find
its numeric id first; names may be duplicated. `listTaskSpaces()` entries
expose that id as `id`:

```js
const spaces = await listTaskSpaces();
console.log(spaces.filter((space) => space.ownership === "user"));

const task = await claimTaskSpace(7);
const userPage = task.userPage();
```

When the task succeeds, close the TaskSpace by default with
`await task.finish({ keep: [] })`. Call `finish()` exactly once and wait for it
to resolve before reporting completion. Put it last in the final round only;
do not operate any Page after it.

Keeping Pages is a rare exception: retain only necessary Pages when the user
explicitly asks, or when the result must remain in the browser for the user to
view.

```js
await task.finish({ keep: [] }); // Default: keep no agent-managed Pages.
await task.finish({ keep: ["p2"] }); // Exception: keep only the result Page.
```

Do not call `finish()` when the task stops for user control or an error.

## Files and requests

Set an existing file input with absolute paths:

```js
await page.setInputFiles("input[type=file]", ["/absolute/path/report.pdf"]);
```

If a click opens the file chooser instead, arm the wait before the click:

```js
const chooserPromise = page.waitForFileChooser({ timeout: 10_000 });
await page.click("button.upload");
const chooser = await chooserPromise;
await chooser.setFiles("/absolute/path/report.pdf"); // or chooser.cancel()
```

`chooser.isMultiple()` reports whether the input accepts several files; pass
an array to `setFiles()` for those. A chooser that no script waits for is
cancelled automatically, so pages never hang on a native dialog.

For a browser download, arm the event before the triggering action and save the
returned artifact to an absolute path in the same script:

```js
const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
await page.click("button.download");
const download = await downloadPromise;
console.log({
  url: download.url(),
  suggestedFilename: download.suggestedFilename(),
});
await download.saveAs("/absolute/path/report.pdf");
```

`download.saveAs()` waits for completion and creates missing parent
directories. Temporary download files are removed when the script round ends,
so call `saveAs()` before the script exits.

`page.fetch()` runs `window.fetch()` in the Page: relative URLs, cookies, and
service workers use that Page, and browser CORS still applies. It returns
`{ ok, status, statusText, url, headers, body }`:

```js
const response = await page.fetch("/api/items", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ limit: 20 }),
});
```

Use standard Node.js `fetch()` for background requests that do not need Page
browser semantics.

## Linux notes

- `keyboard.paste({ text, html? })` writes the clipboard, performs a native
  paste at the current focus, then restores the user's previous clipboard
  contents. `text` is the plain-text fallback when `html` is given.
- Cross-origin (OOPIF) iframe content appears in snapshots WITH refs, merged
  under the iframe line. Act on those nodes via their `@N` refs like any
  other node (actions run on the frame's own session). Selector forms
  (`css=`, `text=`, …) do not reach inside cross-origin frames — use refs
  from a snapshot. `scope: "subtree"` works on refs INSIDE the frame; on the
  cross-origin iframe element's own ref it returns the iframe line only.
- Chrome profile migration is not available on Linux. Logins from your desktop
  Chrome do not carry over; sign in again inside ego lite (or hand the space
  off to the user to sign in).
- The browser is launched with `electron <repo>`; set `EGO_ELECTRON` to point
  at a specific Electron binary and `EGO_BRIDGE_SOCK` to override the bridge
  socket path (`~/.ego-lite/bridge.sock` by default).

[ego-browser:skill] end of guide v0.1.0
