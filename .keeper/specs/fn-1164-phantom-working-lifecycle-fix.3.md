## Description

**Size:** M
**Files:** src/reducer.ts, src/daemon.ts, src/dispatch-failure-key.ts, src/exit-watcher.ts, README.md, test/reducer-lifecycle.test.ts

### Approach

The universal net: a producer-side sweep that detects the contradiction "board says
working, session is demonstrably idle" and makes it loud. Two tiers per ADR 0013.
Tier one (self-heal): a plan job whose task is already marked worker-done while the
row still reads working, with stale events (~10 min), a live pid, and no fresh
in-flight subagent — a logical contradiction — mints a corrective synthetic
quiescence event (a new PascalCase kind, e.g. StopReconciled) that folds the row to
stopped. Tier two (detect-only): any working row with stale events (~60 min) and a
live pid mints visibility only, never a correction. Both tiers mint a sticky
anomaly distress row keyed in the dispatch-failure-key registry, change-gated
(first appearance + reason-change + bounded still-stuck re-emit, O(1) per
condition), surviving the heal, cleared ONLY by operator retry_dispatch ack — never
level-cleared. The row should note implausible event-clock skew when observed.

The sweep follows the producer discipline: pure predicate with injected
clock/liveness probes (the exit-watcher reprobe template), read-only DB access with
the shared NOTADB tolerance, wall-clock never entering the fold; the corrective
event and distress row are minted by main (insertEvent + pumpWakes), NON-FATAL on
mint failure. The corrective event must NOT be Killed (the exit-watcher is the sole
Killed producer; killed fails the stopped-only autoclose gate; killing mislabels
completed work). Its fold arm is a quiescing transition that is exempt from stamp
REJECTION (like terminal arms — so a far-future-pinned row is still healable) while
still advancing the stamp and respecting the terminal WHERE guard. Note
worker-done-ness is NOT a jobs column — source it from the tasks/epics projection
on the same read-only connection. Autoclose and readiness are consumers and stay
untouched: verify the healed row (stopped) flows to autoclose eligibility by test,
not by widening any gate. Add the sentinel to the README System map producers line
in place.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- docs/adr/0013-jobs-lifecycle-stamp-and-stuck-sentinel.md — layer 3 of the contract, tiers and clear semantics
- src/exit-watcher.ts:264-320 — ReprobeRow + the pure reap-predicate with injected probes (the structural template; also the sole-Killed-producer boundary)
- src/daemon.ts:7280, :7343 — mintCrashLoopDistress / mintSharedWedgeDistress (the distress mint + pumpWakes pattern to reuse)
- src/dispatch-failure-key.ts — the key registry; add the sentinel's key + predicate beside the existing synthetic keys
- src/seed-sweep.ts:148 — insertKilledEvent (the synthetic-event INSERT shape to mirror for the new kind)
- src/reducer.ts:8425-8480 — the Killed fold arm (the corrective-event fold template) and the shared stamp helper from task 1
- src/reducer.ts:490 and the plan/tasks projection — where worker-done actually lives (it is NOT on jobs)

**Optional** (reference as needed):
- src/autoclose-worker.ts:407-420 — the stopped-only candidate gate (verification anchor, not a change site)
- src/notadb-tolerance.ts — the shared poll-tolerance helper
- test/exit-watcher.test.ts — clause-by-clause pure-predicate test style to mirror
- CLAUDE.md worker contract + "no kernel watchers on keeper's own DB" — binding if the sweep lands as a Worker thread rather than an in-daemon pass

### Risks

- False-positive corrective stop on a live session: the tier-one predicate must require the worker-done contradiction, a conservative min-age, and the fresh-subagent exclusion; a real resume after a heal simply re-activates under the stamp gate (newer ts wins).
- Sticky-until-ack diverges from the glossary's level-cleared distress row — mirror the worktree-merge-conflict sticky's retry_dispatch-only clear, and keep the row orphan-GC-exempt so nothing tidies it silently.
- Non-plan free-form jobs have no worker-done signal — tier two covers them by design as detect-only; do not widen tier one to guess.
- Double-producer risk with the exit-watcher's dead-pid reap: tier one requires a LIVE pid, keeping the two producers disjoint.

### Test notes

Drive the pure predicate clause-by-clause with injected probes (dead pid, live pid,
fresh subagent, missing worker-done, young events, stale events, clock skew). Prove
the end-to-end heal in memory: seed the phantom shape (Stop then stale straggler
under the old arms is now impossible — instead seed a genuinely wedged working row),
run the predicate, fold the corrective event, assert stopped and that the row now
passes the autoclose candidate filter's WHERE shape. Assert change-gating (repeat
polls emit nothing new), stickiness across condition recovery, and the
retry_dispatch clear. No real daemon/worker/socket in tests.

## Acceptance

- [ ] The worker-done-but-working contradiction with stale events, a live pid, and no fresh subagent is healed to stopped via a synthetic quiescence event that is not Killed, and the healed row satisfies the autoclose candidate condition
- [ ] A working row with stale events and no worker-done signal produces a visible anomaly record only — state untouched
- [ ] Anomaly records are change-gated, survive the condition's recovery, and clear only on operator retry ack
- [ ] A live session with a fresh in-flight subagent or recent events is never corrected
- [ ] The README system map names the sentinel among the producers; the full fast suite is green

## Done summary
Add the two-tier producer-side stuck-state sentinel (self-heal worker-done-but-working via a StopReconciled corrective quiescence; detect-only for very-stale live-pid rows) with a sticky retry_dispatch-cleared anomaly distress row; StopReconciled folds stamp-rejection-exempt like terminal arms.
## Evidence
