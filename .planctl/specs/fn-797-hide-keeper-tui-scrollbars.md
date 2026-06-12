## Overview

Every keeper TUI (board, jobs, autopilot, git, builds, usage via the shared
live-shell scene; dash via its own scene) renders without a scrollbar.
Scrolling behavior is untouched — keys and mouse wheel route through
`scrollBy`/`scrollTop` independent of bar visibility — and the content
viewport reclaims the bar's column (yoga Display.None). The hide is
unconditional: no config flag.

## Quick commands

- `bun run test:opentui` — the only tier that exercises the live-shell and dash scenes (path-ignored from `bun test` and `test:full`)
- `bun run cli/keeper.ts board --watch` in a session with >1 screen of epics — eyeball: no bar column on the right edge

## Acceptance

- [ ] No scrollbar renders in any keeper TUI, including when content overflows the viewport
- [ ] Scrolling (j/k/arrows, mouse wheel, sticky scroll, frame-switch scroll reset) behaves exactly as before
- [ ] `bun run test:opentui` passes
