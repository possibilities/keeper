## Description

**Size:** S
**Files:** src/agent/modal-host.ts, src/agent/modal-overlay.ts, test/agent-modal-overlay.test.ts (or a new test/agent-modal-host.test.ts)

### Approach

Add a `TERMINAL_INPUT_RESET` constant —
`\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[?25h`
(mouse + SGR mouse + focus + bracketed-paste reporting OFF; cursor ON) — and
write it to stdout inside `restore()` (modal-host.ts:151) BEFORE `setRawMode(false)`,
wrapped fail-open like the existing try/catch. `restore()` is already idempotent
(the `restored` flag) and is invoked on every exit path — normal child exit
(the `restore()` at ~338), `uncaughtException` (~182), and the SIGTERM/SIGHUP
forwards — so the reset fires exactly once on normal exit, child-exit-while-open,
crash, and signal. This is standard PTY-host hygiene (what `reset(1)` /
tmux-on-detach do): the host owns clearing the modes the child leaves on, because
`overlay?.destroy()` only reverses OpenTUI's own modes. ALSO reconcile mode state
across the open↔close transition in modal-overlay.ts (OpenTUI's `suspend()` on
close disables mouse the child may still want; the SIGWINCH redraw should let the
child re-assert, but verify the child's mouse/focus survive a modal open→close
cycle and re-emit if not). Leave the no-flag / stub path byte-identical.

### Investigation targets

**Required** (read before coding):
- src/agent/modal-host.ts:151-166 — `restore()` (emits zero escape sequences today; add the reset write here)
- src/agent/modal-host.ts:174-189 — `onUncaught` crash path; ~330-338 — child-exit path; both call `restore()` after `overlay?.destroy()`
- src/agent/modal-overlay.ts:39-40,348 — the existing `FOCUS_REPORTING_OFF` (`?1004l`) written only on modal-OPEN (the constant style to mirror; the only mouse/focus disable in the codebase today)
- src/agent/modal-overlay.ts:336-374 — `open_()` / `close()` transition (mouse/focus reconciliation across resume/suspend)

**Optional** (reference as needed):
- test/agent-modal-overlay.test.ts — the OpenTUI serial test harness + how the host seam (termWrite / stdinHandoff) is faked

## Acceptance

- [ ] `restore()` writes `TERMINAL_INPUT_RESET` (mouse `?1000l/?1002l/?1003l` + SGR `?1006l` + focus `?1004l` + bracketed paste `?2004l` OFF; cursor `?25h` ON) to stdout before un-raw, fail-open
- [ ] The reset fires on every exit path: normal exit, child-exit-while-open, crash (`uncaughtException`), and signal (SIGTERM/SIGHUP)
- [ ] After a real `--agentwrap-modal` session exits, the shell prompt shows no mouse-motion / focus escape spillage
- [ ] Mouse/focus reporting the child needs survives a modal open→close cycle (no mid-session desync)
- [ ] A regression test asserts the reset bytes are written on each exit path; the no-flag / stub path is unchanged

## Done summary

## Evidence
