## Description

**Size:** S
**Files:** src/tmux-control-worker.ts, test/tmux-control-worker.test.ts

### Approach

The escalate branch of the reconnect loop (src/tmux-control-worker.ts ~:667-684)
pins `attempts` at RECONNECT_MAX_ATTEMPTS, logs once, posts liveness, and sleeps at
max backoff — deliberately degrading focus observation instead of fatalExiting the
daemon. Existing coverage (test/tmux-control-worker.test.ts ~:308-438) proves only
the pure `decideReconnect` verdicts. Add a loop-level deterministic test through the
worker's existing seams (fake connect/clock/liveness sink — no real tmux, no real
Worker thread, per the test-isolation doctrine): drive the loop to the cap, assert
(a) no fatalExit, (b) liveness pulses continue while gated, (c) the once-only
degraded log line, (d) a subsequent made-progress connect resets attempts and
resumes normal cadence. If the loop needs a small seam extraction to be drivable,
extract the minimal pure step (mirror the decideReconnect precedent) rather than
spawning anything real.

### Test notes

Deterministic, in-process, fake clock via the existing interruptibleSleep/isStopping
seams; assert on injected sinks, never on wall time.

## Acceptance

- [ ] Loop-level test drives the reconnect loop to the cap and proves: no fatalExit, liveness pulses continue while gated, the degraded log line fires exactly once
- [ ] The same test proves a made-progress connect resets attempts and resumes normal cadence
- [ ] `bun test ./test/tmux-control-worker.test.ts` and `bun run typecheck` green

## Done summary

## Evidence
