## Description

**Size:** M
**Files:** src/daemon.ts, src/dispatch-failure-key.ts, src/dispatch-failure-pill.ts, test/daemon.test.ts, test/dispatch-failure-key.test.ts, test/dispatch-failure-pill.test.ts, CLAUDE.md

### Approach

Two visibility gaps let a 19-hour crash-loop run with needs_human=0:

(1) Named watchdog verdicts. `decideServeLivenessWatchdog` returns a structured verdict
naming WHICH trigger fired (accept-stall-server | accept-stall-bus | busy-lag) instead of a
bare escalate; the producer's escalation line prints the trigger plus both probe ages and the
lag-breach count. Pure seam stays pure (same SWD_BASE perturb-one-axis test shape).

(2) Crash-loop distress signal. A durable restart ledger — a small state-dir sidecar file of
recent boot timestamps, window-aged and length-capped, written by main at boot (survives the
crash it measures; NOT a fold, NOT keeper.db). A pure decideCrashLoop(nowMs, bootTimestamps,
threshold, windowMs) verdict; thresholds set against the real launchd cadence (plist ships
ThrottleInterval 10 + KeepAlive{SuccessfulExit:false}) — a wedge-restart cycle is ~60-120s, so
e.g. >=8 boots inside 30 minutes is unambiguous. On trip, after migrate+boot-drain when the
synthetic-event path is live, mint ONE sticky DispatchFailed row (handleDispatchFailedMint
shape) under a synthetic verb key that is neither work nor close (routes as unknown through
routeDispatchFailure — never enters real failedKeys suppression), with a new *_REASON constant,
DISPLAY_RULES entry, route arm, and pill mapping so it surfaces in needs_human. Clear is
LEVEL-TRIGGERED (resolved during planning): when a boot computes the rate back under threshold,
mintDispatchClearedEvent drops the row — the recover-row idiom. A post-fix healthy boot that
inherits a hot ledger honestly reports recent distress, then self-clears as the window ages.
fatalExit stays the SOLE recovery path and must exit non-zero (SuccessfulExit:false gates the
respawn) — verify, do not change, that contract.

Revise the CLAUDE.md no-self-heal/watchdog carve-out line in place to reflect the named
verdict + distress signal (one-liner discipline; lint-claude-md gates size).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:1769-1799 — decideServeLivenessWatchdog (extend to structured verdict)
- src/daemon.ts:7254-7328 — watchdog producer: probe stamps, static escalation string, fatalExit call
- src/daemon.ts:5470-5510 — handleDispatchFailedMint (the sticky-row mint shape to clone)
- src/daemon.ts:3288-3336 — mintDispatchClearedEvent (the sole legal clear)
- src/dispatch-failure-key.ts — vocabulary + DISPLAY_RULES + routeDispatchFailure + assertNever tripwire; precedents INSTANT_DEATH_BREAKER_REASON, SLOT_RECLAIMED_REASON_PREFIX
- test/daemon.test.ts:915-983 — SWD_BASE pure-verdict test pattern to copy for decideCrashLoop

**Optional** (reference as needed):
- src/dispatch-failure-pill.ts — classifyDispatchFailure pill collapse
- src/backstop-telemetry.ts — rate-limited alarm + counter split, if a per-boot telemetry record is worth emitting alongside
- plist/arthack.keeperd.plist:66-72 — the real ThrottleInterval/KeepAlive values

### Risks

- A corrupt/unreadable ledger file must not become new fatalExit fuel: treat parse failure as
  empty-ledger (fail-open quiet) and overwrite on next write.
- The mint must be idempotent across the crash-loop's own restarts (the DispatchFailed fold
  UPSERTs on (verb,id) — one row, not 585).

### Test notes

Pure tests: decideCrashLoop threshold/window/aging axes, ledger parse-failure fail-open, and
the structured watchdog verdict axes. Vocabulary/pill/route tests for the new reason. No test
writes the real state dir — sandbox via sandboxEnv.

## Acceptance

- [ ] A watchdog escalation log line names the tripped trigger and carries both probe ages and the lag-breach count
- [ ] A sustained crash-loop mints exactly one sticky distress row visible in needs_human, and the row auto-clears once the boot rate falls back under threshold
- [ ] The restart ledger is durable across crashes, window-aged, size-bounded, and read by no fold
- [ ] The new reason routes as unknown (never collides with work/close failedKeys) and carries vocabulary, display-rule, route, and pill coverage with assertNever compiling
- [ ] bun test and lint-claude-md green

## Done summary
Serve-liveness watchdog now returns a structured verdict naming the tripped trigger (accept-stall-server|accept-stall-bus|busy-lag) and the escalation logs both probe ages plus the lag-breach count. A durable window-aged restart ledger (state-dir sidecar, no fold) level-triggers one sticky needs_human crash-loop distress row on a synthetic unknown-routed key, self-clearing when the boot rate recovers; the boot orphan-GC exempts it.
## Evidence
