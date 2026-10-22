# Installing wego (Linux)

wego on Linux runs from a source checkout: an Electron browser shell plus
the `wego-browser` CLI. There is no installer package yet.

## Requirements

- Node.js >= 22 on PATH
- Electron >= 38 on PATH (`electron --version` must work), or set
  `WEGO_ELECTRON` to the binary
- A display: `DISPLAY` (X11) or `WAYLAND_DISPLAY` set

## Steps

1. Get the repository (clone it, or keep the directory you were given). The
   CLI only works from inside this checkout — it launches the browser with
   `electron <repo>`.

2. Put the CLI on PATH, either way:

   ```bash
   npm link          # from the repo root; exposes `wego-browser`
   ```

   or

   ```bash
   export PATH="$PATH:/path/to/repo/bin"
   ```

3. Verify the environment:

   ```bash
   wego-browser doctor
   ```

   Every line must be PASS (a SKIP for the bridge socket is fine when the
   browser is not running yet).

4. First launch:

   ```bash
   wego-browser launch
   ```

   This starts the browser and waits until its bridge is ready. The first
   launch migrates nothing: Chrome profile import is not available on Linux
   yet, so existing Chrome logins, cookies, and bookmarks do not carry over.
   Sign in to the sites you need inside wego — do it yourself in the
   browser window, or let the agent hand a Space off to you to log in.

## Notes

- Bridge socket: `~/.wego/bridge.sock` (override with `WEGO_BRIDGE_SOCK`).
- The `nodejs` subcommand auto-starts the browser when it is not running, so
  `wego-browser launch` is optional.
- If `wego-browser skill` fails with "skill guide not found", the CLI is being
  run from outside the repo layout; reinstall via `npm link` from the repo
  root.
