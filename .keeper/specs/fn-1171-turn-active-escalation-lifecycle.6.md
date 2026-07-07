## Description

**Size:** M
**Files:** src/daemon.ts, test/daemon.test.ts

### Approach

Extend the turn-active discipline to the tier-1 resolver and verify the escalation sequencing unstarves end-to-end. `classifyResolverOutcome` (hard-keyed to `resolve`) gates the resolver→deconflict sequencing on a terminal resolver verdict; audit its liveness arm — if it rides the same stopped-counts-live rule, a stopped-idle resolver never reads terminal and the deconflict dispatch is starved by the same bug this epic fixes. Move its liveness arm to turn-activity, instance-scope its job selection on `instance_event_id` where the callers hold it, and extend the classifier suites with the stopped-idle-resolver → terminal case proving a deconflict dispatch follows.

Second audit strand: same-name relaunch. A re-block while an old idle session lingers (autoclose off) launches a second session named `unblock::<task>`. Verify by test that the bus registry and the jobs fold tolerate duplicate spawn names — two job rows, distinct job_ids and instances, no cross-adoption — and that turn-active occupancy plus instance scoping keep both guards and stage-3 correct with the pair coexisting. If a genuine collision defect surfaces, document it in the Done summary and surface it as a finding rather than widening this task's scope.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:8608-8642 — runResolverDispatchSweep, the resolve launch + sequencing context
- src/daemon.ts — classifyResolverOutcome (locate it; it is the hard-keyed twin of classifyEscalationOutcome) and its liveness arm
- src/daemon.ts:1979-2025 — the turn-active classifier shape tasks 1 and 3 established, the template to mirror

**Optional** (reference as needed):
- src/reducer.ts:8132-8172 — the binding seam (task 2 already stamps resolve sessions; this task consumes, not writes, the stamp)
- test/daemon.test.ts:5260-5420 — classifier + dispatch suites to extend

### Risks

- Changing resolver terminal detection changes WHEN deconflict dispatches (sooner, on resolver idle) — the sequencing gates (resolver_dispatched_at set AND terminal verdict) must still hold; the suite must cover the live-resolver-defers case unchanged.

### Test notes

Stopped-idle resolver classifies terminal and deconflict sweep proceeds; working resolver still defers; duplicate-name pair coexists with correct per-instance classification.

## Acceptance

- [ ] A stopped-idle resolver session reads as a terminal verdict and no longer blocks the deconflict dispatch sequencing; a working resolver still defers it
- [ ] Resolver job selection is instance-scoped where the caller holds an instance anchor
- [ ] A duplicate-spawn-name pair (old idle + fresh dispatch, same task) is proven harmless by test, or the defect is documented as a finding with a failing-case description

## Done summary
Moved classifyResolverOutcome to turn-active occupancy (a stopped-idle resolver reads terminal so the deconflict dispatch sequences instead of starving) and instance-scoped resolveJobsForEpic on the sticky close instance_event_id; left epicHasActiveResolver on pane-liveness for the recover-pass MERGE_HEAD guard. Proved the duplicate-spawn-name pair harmless via turn-active guards (one live occupant) + instance-scoped stage-3 (independent per-instance classification).
## Evidence
