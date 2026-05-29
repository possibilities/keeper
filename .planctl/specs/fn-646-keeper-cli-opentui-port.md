## Overview

The four keeper TUIs (`board`, `git`, `usage`, `autopilot`) live as
standalone `scripts/*.ts` files on a hand-rolled alt-screen renderer
(`src/live-shell.ts`). This epic unifies them under one typed `keeper`
CLI — `keeper board`, `keeper git`, `keeper usage`, `keeper autopilot` —
and ports the renderer from the bespoke per-line-ANSI-diff engine onto
OpenTUI (`@opentui/core`). The end state: a `cli/` tree (typed + linted
from birth) with a `cli/keeper.ts` dispatcher wired as a package.json
`bin`, an OpenTUI-backed live-shell that preserves the exact caller
handle (`pushFrame`/`refreshLive`/`setStatus`/`dispose`) and the exact
on-screen UI (dim banner, frame-history nav, `c`-copy, `q`-quit;
ScrollBox only for tall-frame overflow), and `scripts/` left for the
genuine one-shots (`approve.ts`, `srv-ts-stats.ts`, both out of scope).

The UI is reproduced, not redesigned. The server (event log, reducer,
projections, RPC, `readiness-client`) is untouched — this is a
client-layer refactor, explicitly cheap per the Design stance.

## Quick commands

- `bun install` — pulls `@opentui/core` (pre-built native binary; Bun-only)
- `keeper git` — simplest TUI; the renderer's early proof point
- `keeper board && keeper usage && keeper autopilot` — all four render UI-identical to the old `bun scripts/<name>.ts`
- `bun test --isolate` — core state-machine tests survive verbatim; paint tests run against `createTestRenderer`
- `keeper` / `keeper bogus` — top-level help / unknown-subcommand path
- `bun run lint && bun run typecheck` — now cover the new `cli/` tree

## Acceptance

- [ ] All four TUIs invoke as `keeper <subcommand>` and render the exact same UI as before (banner shape, frame-history nav, `c`-copy, `q`-quit, status chrome).
- [ ] `src/live-shell.ts` is replaced by an OpenTUI-backed renderer with a byte-identical caller-handle surface; the four mains change only their arg-plumbing and entry guard.
- [ ] `@opentui/core` is in the import graph of the CLI/renderer only — never `plugin/hooks/events-writer.ts`.
- [ ] The renderer-agnostic core (history/overlay/status/esc-parser/non-TTY) is extracted and keeps its existing tests; paint tests run on `createTestRenderer`.
- [ ] `bun run typecheck` and `bun run lint` cover `cli/` and pass.

## Early proof point

Task that proves the approach: `.2` — the OpenTUI renderer plus the
`keeper git` cutover. If it fails (OpenTUI can't reproduce the banner +
frame-history nav + ScrollBox-overflow faithfully, or the caller handle
can't be preserved): fall back to keeping `src/live-shell.ts` as-is and
scope the epic down to just the CLI-unification (dispatcher + `bin` +
relocation) without the renderer swap.

## References

- `README.md` `## Architecture` + "Example clients" (~341-554) — the system map and the invocation paths that flip to `keeper <sub>`.
- OpenTUI docs (knowctl topic `opentui`): renderer lifecycle, keyboard, ScrollBox, Text/StyledText, testing.
- `fn-643` (overlap) — dead-letter recovery touches `scripts/board.ts` (task .5 board warn-count/replay keypress todo, .4 in-progress). Board cutover (`.4` here) must reconcile or sequence after it.
- `fn-645` (overlap) — usage envelope status/error touches `scripts/usage.ts` with a ticking-relative-stamp refresh loop that re-threads through OpenTUI `refreshLive`.

## Docs gaps

- **README.md**: flip every `bun scripts/<name>.ts` invocation (prose + `sh` fences ~341-554) to `keeper <subcommand>`; revise line ~513 ("SIGINT calls the live-shell's dispose()") to not leak the internal module name; reconcile the stale `--live` flag reference (the scripts pass `enabled:true` unconditionally today — no main-level `--live` flag exists).
- **CLAUDE.md / AGENTS.md** (symlink): swap identifier mentions at lines ~16-17 (clients), ~123 (`scripts/usage.ts`), ~216 (`scripts/board.ts`) to the `keeper` subcommands; optional one-liner pointing at `cli/keeper.ts`.
- **package.json**: the `"bin": {"keeper": "cli/keeper.ts"}` entry is itself the machine-readable entry-point doc.

## Best practices

- **Own teardown explicitly:** OpenTUI does NOT hook `process.exit`/unhandled rejections — a hard exit without `renderer.destroy()` leaves the terminal in raw/alt mode. Set `exitOnCtrlC:false` AND drop `SIGINT` from `exitSignals` (independent guards); call `destroy()` in the shell's idempotent `dispose()` and keep the existing safety-net listeners load-bearing.
- **Keep the ScrollBox unfocused:** it captures arrow keys only when focused. Set `autoFocus:false`, never call `.focus()`, drive scroll via `scrollTo(0)` on frame switch, and own all keys via `renderer.keyInput` — otherwise the frame-history keymap silently dies.
- **Mutate, don't rebuild:** set `TextRenderable.content` in place (O(1), marks dirty); add/remove children only when the row count changes; `viewportCulling:true`; do NOT call `renderer.start()` (on-demand render is correct for keypress-driven UIs).
- **No ANSI passthrough:** OpenTUI renders embedded ANSI as literal garbage and there is no `StyledText.fromANSI()`. Strip + re-apply via the `t` template / `TextAttributes` / `fg(hex)` (hex, not SGR codes).
- **Tests:** `createTestRenderer` from `@opentui/core/testing` — pass explicit width/height (CI reports `columns=0`), `exitSignals:[]`, `OTUI_USE_CONSOLE=false`, and `destroy()` every test (leaked native fds → flaky).
