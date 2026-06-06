## Description

**Size:** M
**Files:** src/view-shell.ts, cli/usage.ts, test/view-shell.test.ts

Make `keeper board|jobs|git|autopilot|usage` exit (closing their socket)
when their parent/pane/TTY dies — the load-bearing fix for orphan
accumulation (a server can't reap an alive orphan).

### Approach

Factor the teardown body out of `installSigintHandler`'s SIGINT closure
(src/view-shell.ts:538-560) into a shared `exitCleanly(onDispose)` and arm
THREE additional triggers that all call it: `process.on("SIGHUP")`;
`process.stdin` `'end'`/`'error'` (call `process.stdin.resume()` so EOF
fires on pty close); and a ~2s `process.ppid === 1` poll (the ONLY trigger
that catches zellij's detach-keeps-pty-open case). Guard against
false-exit: capture initial ppid at startup and only treat `ppid===1` as
death if it WASN'T 1 at launch (a legitimately detached launch). Handle
non-TTY runs (don't mis-arm stdin logic). Teardown must be idempotent
(dispose() already is; guard the exit/log so overlapping triggers don't
double-fire). Cover cli/usage.ts:1011 — it has its OWN raw SIGINT handler
and a 3-handle teardown; either route it through the shared installer or
duplicate the three new triggers into its closure.

### Investigation targets

**Required** (read before coding):
- src/view-shell.ts:538-560 — installSigintHandler (the seam; SIGINT-only today).
- cli/usage.ts:983-1022, :1011 — own SIGINT + 3-handle (tick + 2 subscribe) teardown.
- src/readiness-client.ts:1104-1132 — dispose() idempotency + swallow-write-throw (CALL it, don't edit).
- test/view-shell.test.ts:405-478 — capture-process.on-handler + stub-exit test pattern to mirror for SIGHUP/ppid.
- src/exit-watcher-ffi.ts:198-211 — isPidAlive/kill(0) idiom (reference; NO FFI needed viewer-side).

### Risks

- **Zellij `on_force_close "detach"`**: terminal-detach keeps the pane pty OPEN → no SIGHUP, stdin stays open → ONLY the ppid===1 poll catches the reparent. The poll is load-bearing, not a fallback — make sure it actually fires.
- ppid===1 false-positive at launch (legit detached launch) → guard with the captured-initial-ppid check.
- Non-TTY / piped runs → self-exit logic must not mis-fire or fail to arm.
- usage.ts divergent handler → easy to miss; its 3-handle teardown doesn't fit the shell's single-onDispose shape.

### Test notes

Mirror test/view-shell.test.ts:405-478: capture the registered SIGHUP
handler, stub process.exit, invoke, assert dispose + idempotency. Add a
ppid-poll test with a faked ppid. Assert a live (ppid≠1, TTY-attached)
viewer does NOT exit.

## Acceptance

- [ ] SIGHUP, stdin-EOF, and a ~2s ppid===1 poll each trigger a clean exit (dispose → socket close) — for all viewers incl. usage.ts.
- [ ] Launch-time ppid guard prevents false-exit of a legitimately-launched viewer; non-TTY handled; teardown idempotent across overlapping triggers.
- [ ] No new edit to readiness-client.ts (only calls existing dispose) → no fn-721 overlap.
- [ ] `bun test test/view-shell.test.ts` green; lint + typecheck clean.

## Done summary

## Evidence
