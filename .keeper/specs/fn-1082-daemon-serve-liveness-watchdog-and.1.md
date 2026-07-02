## Description

**Size:** M
**Files:** src/daemon.ts, src/server-worker.ts, src/bus-worker.ts, CLAUDE.md, test/ (new watchdog verdict test)

### Approach

A third instance of the pure-verdict watchdog pattern: every interval the main loop feeds a
verdict function (a) event-loop lag stats (monitorEventLoopDelay via node:perf_hooks — works
in Bun) and (b) the age of the last successful self-probe per socket, where the probe issues
a REAL bounded-timeout read — a status first-paint against keeperd.sock and a registry
list against bus.sock — because the observed wedge kept the send path alive while reads
died; connect-only probes pass through it. Verdict ok|escalate: escalate on lag p99 past
threshold for N consecutive intervals OR probe-age past its window; escalate calls fatalExit
(LaunchAgent restarts — the sole recovery path; never respawn a thread). Thresholds
conservative (avoid false restarts under legitimate load; boot grace period). Unlink both
socket paths at boot before serving if not already done. Add the one-sentence CLAUDE.md
carve-out beside the git seed-liveness precedent; lint-claude-md green.

### Investigation targets

**Required** (read before coding):
- src/daemon.ts:1341 + the 30s interval wiring at :1296 — the pattern to copy exactly
- src/server-worker.ts + src/bus-worker.ts — where a self-probe client can connect without deadlocking on its own serve thread (probe from main, sockets served by workers — confirm the thread topology makes self-probing sound)
- src/bus-worker.ts:19 — the boot-only fatalExit note this deliberately extends

### Risks

- A probe from the same process could hold a connection slot; keep it one short-lived connection per interval with a hard timeout and immediate close.
- False-positive restarts are expensive (mid-close daemon death) — require N consecutive failures, generous timeouts, and a boot grace window.

### Test notes

Verdict function fully covered in the fast tier with synthetic clock/lag/probe-age inputs
(ok, busy-not-wedged, lag-wedge, probe-stall-low-lag, boot-grace). The live probe is
production-only; no test boots a daemon.

## Acceptance

- [ ] Verdict function pure and covered on the full input matrix; escalate → fatalExit wired on the daemon interval
- [ ] Probes are real reads on both sockets with hard timeouts; boot grace honored; socket unlink-at-boot in place
- [ ] CLAUDE.md carve-out sentence landed; lint green; fast suite green

## Done summary
Added the serve-liveness watchdog: a pure verdict (decideServeLivenessWatchdog) fed each interval by real bounded-timeout reads on keeperd.sock + bus.sock (accept-stall detector) plus a main-loop lag histogram (busy-wedge belt), escalating a detected wedge straight to fatalExit; boot grace + N-consecutive guards prevent false restarts. Also added the unconditional bus.sock unlink-at-boot and the CLAUDE.md carve-out sentence.
## Evidence
