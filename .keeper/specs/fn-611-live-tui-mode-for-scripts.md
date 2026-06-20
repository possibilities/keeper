## Overview

Turn the three keeper scripts (`autopilot.ts`, `board.ts`, `git.ts`) into
real terminal UIs under a new `--live` flag: alt-screen + raw-mode stdin
+ per-line ANSI diff + in-memory frame history with keyboard navigation.
Replaces the existing `--clear` flag outright (no backwards-compat shim).
A shared `src/live-shell.ts` module owns the TUI primitives (alt-screen
enter/exit, cursor hide/show, raw-mode lifecycle, escape-sequence
parser, ring-buffer history, banner row, per-line differ); each script
plugs in at its existing emit seam. As a precursor, `git.ts` migrates
off its hand-rolled `Bun.connect` socket loop onto a generic
single-collection subscribe helper extracted from `subscribeReadiness`,
so all three scripts share one subscription contract before the
live-shell wraps them.

## Quick commands

- `bun scripts/board.ts --live` — combined epics+jobs board as a TUI
- `bun scripts/autopilot.ts --live` — autopilot command list as a TUI
- `bun scripts/git.ts --live` — git worktree status as a TUI
- `bun test test/live-shell.test.ts` — TUI primitive tests
- `bun run lint && bun run typecheck` — full repo gate

## Acceptance

- [ ] `--live` enters alt-screen, hides the cursor, puts stdin in raw mode; `dispose()` restores all three synchronously.
- [ ] Per-line ANSI diff: only changed rows emit `\x1b[<row>;1H\x1b[2K<line>`; no `\x1b[2J` between frames in steady state.
- [ ] Keyboard nav works: `←/h/k` prev, `→/l/j` next, `g` oldest, `G`/`End`/`Esc` return to live, `q`/`Ctrl-C` quit.
- [ ] Banner row reserved at row 1; blank when live, `frame N of M — press G to return to live` when scrolled back.
- [ ] While scrolled back, new snapshots silently append to history (banner's `M` count updates); they do not auto-snap to live.
- [ ] Non-TTY (`!process.stdout.isTTY` or `!process.stdin.isTTY`) silently behaves exactly as if `--live` was not passed — no ANSI, no stderr notice.
- [ ] `--clear` is gone from `parseArgs`, the help const, the top-of-file JSDoc, and every `clearMode` branch in all three scripts.
- [ ] `git.ts` no longer holds its own `Bun.connect` loop — uses the same subscribe contract as `autopilot.ts` and `board.ts`.
- [ ] All three scripts' renderer functions return `string[]`; the helper differ consumes lines, not a joined string.
- [ ] `bun run lint && bun run typecheck && bun test` pass.
- [ ] README `## Example clients` section (lines 258–347) reflects `--live` semantics; no `--clear` stub remains.

## Early proof point

Task that proves the approach: `<epic_id>.2` — the shared `src/live-shell.ts`
module + its `test/live-shell.test.ts` suite. If `createLiveShell` can't
own a fake-stdout-sink contract clean enough to assert per-line ANSI byte
streams in isolation, the wire-up task (`<epic_id>.3`) inherits the mess.
Recovery if it fails: shrink the module surface (e.g. drop ring-buffer
nav, ship `--live` as in-place redraw only) and reopen a follow-up epic
for keyboard nav.

## References

- `src/readiness-client.ts:252` — `subscribeReadiness` factory (template for the new single-collection helper)
- `scripts/git.ts:267-301` — current hand-rolled socket loop (target of the migration)
- `scripts/autopilot.ts:365-379`, `scripts/board.ts:612-643`, `scripts/git.ts:215-229` — the three emit seams
- `README.md:258-347` — docs surface

## Best practices

- **Alt-screen lifecycle:** enter (`\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l`) BEFORE `setRawMode(true)`; teardown reverses (`setRawMode(false)` + `stdin.pause()` then `\x1b[?25h\x1b[?1049l\x1b[0m`). Order is load-bearing — wrong order leaves the parent terminal wedged.
- **`dispose()` must be synchronous** so `process.on('exit')`, `uncaughtException`, and `unhandledRejection` safety-nets can call it. Async cleanup would skip in those paths.
- **Batch one `process.stdout.write` per frame** — build the full diff into a string and emit once. Per-row writes flicker and burn syscalls.
- **Wrap each frame in DEC 2026 synchronized output mode** (`\x1b[?2026h` … `\x1b[?2026l`) — supported terminals paint atomically; unsupported ignore silently. Free anti-tearing.
- **Debounce SIGWINCH ~100ms** then full-clear and re-render. Don't try to ANSI-diff through a resize. Listen on `process.stdout.on('resize', ...)` (not raw `SIGWINCH`) so `columns`/`rows` are guaranteed-fresh in the handler.
- **StdinBuffer pattern for escape sequences:** accumulate bytes, classify CSI/SS3/OSC by completion rules, flush bare `\x1b` after a ~10ms timeout. Otherwise either arrow keys are lost (no timeout) or bare Escape is swallowed forever (no flush).
- **Save `wasRaw = process.stdin.isRaw`** before flipping, restore to that exact value on teardown — protects nested-TUI invocations.
- **`process.stdin.pause()` immediately before `setRawMode(false)`** — prevents buffered Ctrl-D from closing the parent shell over SSH.

## Docs gaps

- **`README.md` lines 258–347 (`## Example clients`)** — replace every `--clear` reference with `--live`; shift the behavioral prose from "clears the terminal each frame" to the alt-screen + per-line diff + keyboard nav model. Update both the prose and the two-line shell-example blocks per script. Posture is replace, not append — no `--clear` stub, no "previously `--clear`" callout.

## Snippet context

Bundles inherited or curated for this epic:
- `sketch/scripts-live-tui` — author-tier sketch capturing the design (no snippets curated into the bundle; the bundle ref is the breadcrumb)
