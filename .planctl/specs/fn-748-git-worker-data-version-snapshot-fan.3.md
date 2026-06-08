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

## Evidence
