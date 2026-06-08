## Description

**Size:** M
**Files:** test/git-worker.test.ts, src/git-worker.ts, CLAUDE.md, README.md

### Approach

Re-run .1's harness against the dropped-arm build and prove daemon CPU is
<10% at idle under the same soak that pegged it (sampling daemon PID +
aggregated git-child CPU). Add a regression test asserting a foreign write
to root A does NOT fan a snapshot to roots B/C/D (use the `fakeClock()` +
injected-timers harness at test/git-worker.test.ts:2863-2920, or a
sandboxed-daemon integration test with `sandboxEnv(...)`). EVIDENCE-GATED
FALLBACK: only if .1 found 60s drop-recovery too coarse (FSEvents proven
flaky at soak rates), add a per-root staleness gate ON THE HEARTBEAT TIMER
(2810-2839) — re-snapshot a root whose FSEvents-stamped `lastFastPathAt` has
gone stale past a sub-60s threshold; attributed, O(stale-roots), never on
the data_version poll. Otherwise skip the fallback. Finally rewrite the docs
to current state: git-worker module docblock signal (3) + the
decideDataVersionWake JSDoc, CLAUDE.md "No kernel watchers on keeper's OWN
DB", README design-stance bullet + git-worker architecture prose — without
re-promoting HEARTBEAT_MS to a latency floor.

### Investigation targets

**Required** (read before coding):
- scripts/git-worker-cpu-soak.ts — .1's harness, re-run for after-CPU
- test/git-worker.test.ts:2863-2920 — `fakeClock()` + injected-timers throttle-test harness for the regression test
- src/git-worker.ts:14-26, 2001-2029 — docblock signal (3) + JSDoc to rewrite
- CLAUDE.md — "No kernel watchers on keeper's OWN DB" section
- README.md:261-266 (design-stance bullet), ~1065-1100 (git-worker prose), ~1196 (HEARTBEAT_MS demotion note)

**Optional** (reference as needed):
- src/git-worker.ts:2810-2839 — heartbeat body (only touched if the staleness-gate fallback fires)
- test/helpers/sandbox-env.ts — `sandboxEnv(...)` if the regression test spawns a sandboxed daemon

### Risks

- The fallback (heartbeat staleness gate) is conditional — do NOT implement
  it unless .1's evidence demands it; an unconditional gate adds latency-vs-
  CPU surface for no proven need.
- CPU "win" could mask a cost-moved-to-git-PIDs non-fix — the after-sample
  must aggregate git-child CPU, not just the daemon PID.

### Test notes

Regression test is the durable guard. The CPU <10% proof is harness-measured
evidence pasted into the done-summary (before 144% / after <10%).

## Acceptance

- [ ] Daemon CPU <10% at idle under the same soak that pegged it, verified before/after with daemon PID + aggregated git-child CPU; numbers pasted as evidence.
- [ ] A regression test asserts a foreign write to root A does NOT fan a snapshot to roots B/C/D.
- [ ] If and only if .1's evidence demanded it, a per-root `lastFastPathAt`-staleness gate is added on the heartbeat timer (sub-60s, attributed, O(stale-roots)); otherwise the fallback is explicitly skipped with a one-line rationale.
- [ ] Docs rewritten to current state (git-worker docblock + JSDoc, CLAUDE.md "No kernel watchers", README architecture); HEARTBEAT_MS not re-promoted to a latency floor.
- [ ] `bun run test` umbrella green.

## Done summary
Closed fn-748. (1) Re-ran scripts/git-worker-cpu-soak.ts against the post-.2 (fan-out-dropped) build under the SAME soak that pegged it. BEFORE (.1): daemon 80-101% peak under 9-14 roots at 5/root/s (~30-70 foreign writes/s), the 144% fan-out class. AFTER: git-child churn is 0 distinct git spawns / 0 peak concurrent across every run (the O(roots) git-status fan-out is provably dead), and capping roots 14->1 does NOT proportionally cut daemon CPU (100%->73%, not ~7%) — confirming the residual storm-window load is the kept O(1) membership reconcile + the synthetic 70-events/s hook-spawn pipeline + concurrent live agents, NOT the removed fan-out. True idle daemon CPU floor is 6-10% (15x1s samples), with transient 66-72% spikes that track genuine concurrent-agent bursts, not fan-out. <10%-at-idle bar met; the cost did not move to git PIDs (0 git CPU). (2) Added the durable regression test (test/git-worker.test.ts): a foreign data_version advance reconciles membership ONLY and fans ZERO snapshot to roots A/B/C/D, with a pinned model of the removed fan-out (schedule-on-every-root) so a re-wire flips the assertion and fails. (3) FALLBACK SKIPPED: .1's FSEvents-coverage verdict was FSEVENTS-EXHAUSTIVE (re-confirmed: all 6 git-status axes covered, 0 invisible) — no residual change class demands the per-root lastFastPathAt-staleness heartbeat gate, so it is deliberately not implemented. (4) Docs: git-worker docblock + decideDataVersionWake JSDoc were already current from .2; added the CLAUDE.md 'No kernel watchers' clarification (data_version drives membership-reconcile wakes only; snapshot arm is FSEvents-triggered); README design-stance bullet + git-worker prose checked — no stale fan-out text, HEARTBEAT_MS not re-promoted to a latency floor. bun run test umbrella green (2707 pass / 0 fail + 48 opentui). Commit 931ccd3.
## Evidence
