## Overview

An experiment-flagged (`--agentwrap-modal`) mode for `keeper agent` that hosts a
claude code agent in a Bun PTY under an OpenTUI host process. By default OpenTUI
is suspended and the child runs as a raw passthrough — indistinguishable from a
normal `keeper agent` launch. A reserved hotkey resumes OpenTUI and floats a
placeholder test modal over a dim scrim; Esc or a scrim click dismisses it and
returns input to the agent. MECHANICS-FIRST: the goal is to prove the host /
passthrough / hotkey / modal / dismiss / restore loop works and is reliable in
production. The faithful libghostty-vt grid backdrop (rendering the agent behind
the modal), kitty-graphics fidelity, dtach persistence, and a live backdrop are
explicit follow-ons, OUT OF SCOPE for this epic. The normal (no-flag) launch path
stays byte-identical.

## Quick commands

- `keeper agent claude --agentwrap-modal` then press the reserved hotkey to open the test modal; Esc / click the scrim to dismiss
- `keeper agent claude` (no flag) — unchanged baseline; must stay byte-identical
- `bun run test:opentui` — runs the OpenTUI serial test chain (the modal test lands here)

## Acceptance

- [ ] `keeper agent claude --agentwrap-modal` hosts claude in a Bun PTY; with the modal closed it is indistinguishable from a normal launch (colors/truecolor, resize, ctrl-c/ctrl-z)
- [ ] The reserved hotkey floats an OpenTUI test modal over a dim scrim; Esc or a scrim click dismisses and restores the agent
- [ ] The terminal is never left corrupted (raw mode / alt-screen / `?2026` pending) on ANY exit path, transition, or crash
- [ ] The normal `keeper agent` path (no flag) and the Codex tail are byte-identical
- [ ] The flag errors clearly for codex/pi and for non-interactive / non-TTY invocations

## Early proof point

Task that proves the approach: `.1` (PTY-host passthrough keystone). If it fails
(Bun's `terminal:` PTY API cannot cleanly host claude with working job control /
correct exit-code propagation): fall back to a `bun:ffi` `openpty` + `Bun.spawn`
wiring, or reconsider the host-owns-terminal model before building the modal.

## References

- Bun PTY API: `node_modules/bun-types/bun.d.ts:7010-7046` (`Bun.spawn({terminal})`), Terminal class `:7822-7859` (`write`/`resize`/`setRawMode`/`data`/`exit`)
- OpenTUI suspend/resume: `node_modules/@opentui/core/renderer.d.ts:539-541`; alpha scrim: `buffer.d.ts` `setCellWithAlphaBlending` + `renderables/FrameBuffer.d.ts`
- Host/teardown patterns to lift: `src/dash/app.ts:570-591` (renderer build), `:490-513` (keypress), `:475-486,682-702` (destroy/exitCleanly), `src/dash/exit-triggers.ts`
- Deferred faithful-backdrop substrate to borrow later: `/Users/mike/code/vtkeep` (MIT, ours) `pty.zig` POSIX termios traps + libghostty-vt grid + `emitRepaint`. Sibling OpenTUI app for idioms: `/Users/mike/code/agentrender`
- Spike findings (verified): alpha compositing supported; raw stdin only via suspend/resume; Bun has first-class PTY (no bun:ffi forkpty needed)

## Docs gaps

- **src/agent/dispatch.ts**: add `--agentwrap-modal` to `AGENTWRAP_HELP` (:66) under an "Experimental flags (opt-in):" subsection; update `USAGE` (:39) only if a new verb form is added
- **cli/keeper.ts**: revise the `agent` one-liner `USAGE` (:78) only if the launch shape description needs it
- **README.md**: note the experiment flag in the `keeper agent` entry (~1106) and generalize / parallel the OpenTUI frame-shape prose (~1273-1293) for the second OpenTUI host surface
- **CLAUDE.md**: one-line pointer only if a load-bearing invariant lands (e.g. "the modal host MUST restore terminal state before exit")

## Best practices

- **Use `Bun.spawn({terminal})`, not `bun:ffi` forkpty:** forkpty forks the JS heap/event loop (unsafe); Bun's managed PTY avoids struct-layout UB. [practice-scout]
- **Read the child exit code out-of-band:** `proc.exited` resolves to PTY-lifecycle status (0=EOF, 1=error), NOT the child's exit code — silent data-loss if relied on. [practice-scout]
- **stdin is a strict single-owner mutex:** remove keeper's passthrough listener BEFORE `resume()`, re-add AFTER `suspend()`; never both reading stdin (splits multi-byte escapes). [repo-scout + practice-scout]
- **Keep the `?2026` BSU/ESU window tight (per-frame, not whole modal period)** and skip it under tmux (`$TMUX` on the parent); a pending BSU on crash freezes the terminal. [practice-scout]
- **Restore termios on exit/uncaughtException/signals BEFORE `renderer.destroy()`; don't re-enter `?1049h`** (already alt-screen). Replicate `env:{...process.env}` on the PTY spawn or the TMUX-strip truecolor fix silently no-ops. [practice-scout + repo-scout]
