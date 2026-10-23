# Roadmap

wego is usable daily today. This file tracks direction, not promises.
Known limitations live in the
[CHANGELOG](CHANGELOG.md#known-limitations); design rationale lives in
[AGENTS.md](AGENTS.md) and [docs/protocol.md](docs/protocol.md).

## Now (0.1.x — hardening)

- Bug reports from real daily use; keep the 131-test suite + smoke gate green.
- AppImage release automation (manual `npm run dist` today).
- First-run onboarding polish (import Chrome cookies prompt).

## Next (0.2)

- Bookmarks UI + Chrome bookmark import (cookie import already shipped).
- Selector-based actions crossing into OOPIFs (refs already work).
- Multi-window: optionally detach a space into its own window.
- Site-learnings trust hardening: first-seen hash markers and change warnings
  for executable tools under `~/.wego/learnings/`.
- CLI auto-discovery of an installed AppImage (drop the WEGO_ELECTRON export).

## Later / ideas

- Update channel (getBrowserVersion already reports `updateAvailable: false`;
  the wire is there, the feed isn't).
- Profile management UI (CLI + bridge exist today).
- ego-lite skill ecosystem compatibility statement — the `ego` bindings
  surface is intentionally close to ego-lite's; formal compatibility testing.

## Non-goals (explicit)

- Windows/macOS ports. wego exists because ego-lite doesn't do Linux;
  cross-platform Electron would follow "for free" but is untested and
  unsupported — contributions welcome, no maintainer commitment.
- Headless-only operation. The whole point is sharing a *visible* browser
  with the user; use Playwright for headless fleets.
- A plugin marketplace. Learnings are user-local by design (privacy);
  sharing conventions may emerge, a hosted registry won't.

## Done highlights (0.1.0)

Cross-origin OOPIF snapshots with frame-tagged refs; deterministic hybrid
input (real CDP foreground / synthetic covered); popup adoption;
CDP-over-bridge tunnel (no TCP debug port); Chrome cookie import;
persistent spaces; settings panel; 131 tests + e2e smoke.
