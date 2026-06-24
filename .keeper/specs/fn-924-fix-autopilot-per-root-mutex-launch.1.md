## Description

**Size:** M
**Files:** src/readiness.ts (+ test/readiness.test.ts); possibly src/reducer.ts,
src/autopilot-worker.ts, test/autopilot-worker.test.ts

### Approach

Close the per-root occupancy continuity gap so a worker holds its root from
dispatch through first activity. Lead with **direction B (read-time,
determinism-safe)**: extend the occupancy signal so a BOUND-but-not-yet-working
worker -- a `jobs` row at `state='stopped'` carrying a `plan_verb`/`plan_ref`
(created by the SessionStart fold at src/reducer.ts:6644, which in the SAME fold
DELETEs the pending_dispatches row at :6785-6804) -- counts as a root occupant,
via the central `isLiveWorkOccupant`/`isRootOccupant` seam
(src/readiness.ts:1048/1067). Do NOT edit `anyEmbeddedJobWorking`
(src/readiness.ts:1425) -- that would shift pred-5 verdict semantics everywhere.
Because discharge-on-bind and the stopped-jobs-row creation are ONE atomic
SessionStart fold, every snapshot shows EITHER the pending_dispatches row OR the
stopped+plan_verb jobs row -- never neither -- so counting the latter closes the
gap with no fold change and no version-fence.

The wrinkle to solve: disambiguate a FRESHLY-BOUND `stopped` worker (should
occupy) from a genuinely STOPPED/dead worker (must NOT over-hold the root) --
EmbeddedJob carries no bind marker beyond `state` today. Resolve via the available
signal scoped so a dead worker's terminal/exit verdict releases the root (the
occupancy predicate operates on a Verdict, so this likely means a new occupant-
class verdict at the right ladder rank, or having the mutex pass-1 read job state
directly -- the worker picks the cleanest seam).

Fallback if B can't disambiguate cleanly -- **direction A (convert-don't-delete)**:
the SessionStart fold transitions the pending_dispatches row to a "binding" status
instead of deleting it (released on state -> working or a terminal event), giving
an unambiguous hold. A edits a fold (keep it PURE) and MUST preserve the never-bound
breaker reset + resume-vs-spawn distinction currently coupled to discharge-on-bind
(src/reducer.ts:6785-6804). Lead B; fall back to A only if B is unworkable.

Verify the fix holds for BOTH the yolo single-pass (readiness.ts:1282) and the
armed two-pass (:1306-1328) -- a pass-1 occupancy fix covers both. And verify the
autopilot cap (src/autopilot-worker.ts:953-972, which shares isRootOccupant)
doesn't now over-count a transient bound-stopped job and starve dispatch.

### Investigation targets

**Required** (read before coding):
- src/readiness.ts:1048 isLiveWorkOccupant / :1067 isRootOccupant -- the occupancy seam (per-epic mutex + per-root mutex + autopilot cap all key on it)
- src/readiness.ts:1142 applySingleTaskPerRootMutex -- pass-1 claim :1177-1213, pass-2 tiebreak :1282 (yolo) / :1306-1328 (armed)
- src/readiness.ts:665 pred-5 own-progress-main (the running hold; gated on anyEmbeddedJobWorking :1425); :801 pred-10.5 dispatch-pending
- src/reducer.ts:6644 SessionStart jobs-row seed (state='stopped'); :6785-6804 discharge-on-bind DELETE + dispatch_never_bound coupling; :6884 stopped -> working on UserPromptSubmit
- src/autopilot-worker.ts:953-972 post-mutex root-occupant count (must mirror the mutex predicate)

**Optional** (reference as needed):
- src/autopilot-worker.ts:1142-1154 fallbackRoots -- launch-window-occupancy precedent
- src/readiness.ts:1339 effectiveRoot -- root keying (reuse, never re-implement)

### Risks

- Stopped-dead vs freshly-bound ambiguity (direction B) -- the core thing to get right; too narrow leaks, too broad over-holds/starves.
- Three consumers share isRootOccupant (per-epic mutex, per-root mutex, autopilot cap) -- a widening hits all three; verify the cap budget (cap - occupied, autopilot-worker.ts:971) doesn't over-count.
- Direction A only: never-bound breaker reset + resume-vs-spawn distinction are coupled to discharge-on-bind -- must be preserved.
- Re-fold determinism (deterministic-replayed class): B is read-time (safe); A edits a fold (keep pure -- no wall-clock, no liveness probe).

### Test notes

- Readiness unit test (fast tier): hand-rolled verdict map (test/readiness.test.ts:186-192 helpers); add a "bound-but-stopped, plan_verb-bearing job occupies its root" case near the existing isRootOccupant tests (:229-259, incl. the dispatch-pending-occupies case :247); makeEmbeddedJob({state:'stopped', ...}) fixtures (:115).
- Autopilot integration (slow tier, test/autopilot-worker.test.ts): two ready same-root tasks never co-dispatch across the bind -> first-activity window; cap not starved.
- Refold-determinism guard MUST stay green: test/refold-equivalence.test.ts:826 (pending_dispatches empty at serve).
- `bun run test:full` mandatory (touches readiness/reducer/autopilot paths).

## Acceptance

- [ ] a bound-but-not-yet-working worker (stopped jobs row + plan_verb) counts as a root occupant via isRootOccupant
- [ ] two ready same-root tasks never co-dispatch across the dispatch -> bind -> running window (readiness unit test pins it)
- [ ] a genuinely stopped/dead worker does not over-hold the root
- [ ] never-bound breaker + resume-vs-spawn distinction unaffected
- [ ] autopilot cap not starved by the widened occupancy
- [ ] holds for both yolo single-pass and armed two-pass
- [ ] test/refold-equivalence.test.ts green (re-fold determinism)
- [ ] `bun run test:full` green

## Done summary
Close the per-root mutex launch-window leak: a new read-time bound-pending verdict holds a freshly-bound worker's root (stopped + plan_verb jobs row, active_since IS NULL) across the bind -> first-activity handoff, with the active_since gate preventing a stopped-after-working/dead worker from over-holding. Carried jobs.active_since free on the embedded epics.jobs element (JSON-cell-only, fix-forward); SCHEMA_VERSION 83->84.
## Evidence
