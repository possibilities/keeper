## Description

**Size:** S
**Files:** babysitters/performance/watch.ts, babysitters/agents/performance.md, README.md, test/keeper-watch.test.ts

### Approach

New pure detector `detectCloseLoop` as a sibling of detectDupDispatch,
structurally modeled on detectDuplicateLiveWorkers (group by plan_ref,
critical, fires immediately, fingerprint on plan_ref — NOT in
HELD_TICK_CATEGORIES / DELTA_GATE_CATEGORIES). Inputs: close-verb jobs
+ per-epic status, both from the live projections (stateless; the
epic-open condition self-clears the finding when the epic flips done).
Widen the sitter scan: add `plan_verb` to the JobRow SELECT (:1382) and
interface (:241-254); add a keyed epics read `SELECT epic_id, status
FROM epics WHERE epic_id IN (...)` for the plan_refs that have close
jobs (query by id so done rows are visible; the existing :1404 scalar
open-count read stays untouched). Predicate: count close jobs with
`created_at >= now − CLOSE_LOOP_WINDOW_SECS (86400)` per epic-form
plan_ref (parsePlanRef null/task-form → skip); fire critical when count
>= CLOSE_LOOP_MIN_COUNT (4) AND the epic row exists with
status='open'; missing epic row → degrade, no finding. New `close-loop`
member in the closed Category union; thresholds as module-scope
literals with rationale comments citing the fn-12 incident (8 jobs/6h)
and why N=4 (legit closes land in 1-2). detail enumerates the offending
job_ids + states as evidence (mirroring duplicate-live-workers). Docs
per epic Docs gaps (category enum + prose entry + README list).

### Investigation targets

**Required** (read before coding):
- babysitters/performance/watch.ts:680-715 — detectDuplicateLiveWorkers, the structural template
- babysitters/performance/watch.ts:266-403 — threshold block + dup-dispatch rationale comment (the close-loop comment should cross-reference it: rate arm vs state arm)
- babysitters/performance/watch.ts:241-254,1381-1383 — JobRow + jobs SELECT to widen
- babysitters/performance/watch.ts:148-171,179-189,205 — Category union, Finding contract, fingerprint
- src/derivers.ts:444-459 — parsePlanRef (epic-form vs task-form vs null)
- test/keeper-watch.test.ts:202+ — per-detector describe pattern, synthetic rows, injected nowSecs

### Risks

- The sitter must stay read-only with prepareStmts:false and within the pinned import surface (test/babysitter-build.test.ts) — the new epics read uses the existing readonly handle, no new imports
- Fingerprint hashes only (category, plan_ref): the finding re-fires only via FINGERPRINT_VERSION bumps or condition-clear; do not put counts in the fingerprint

### Test notes

describe("detectCloseLoop") with synthetic JobRow/epic-status arrays: 4 close jobs in-window + epic open → critical; 3 → none; 4 with epic done → none; 4 spread beyond 24h → none; task-form/null plan_ref skipped; missing epic row → none. Verify detectDupDispatch untouched.

## Acceptance

- [ ] All detector cases above pass; existing keeper-watch suite green
- [ ] close-loop NOT in HELD_TICK_CATEGORIES/DELTA_GATE_CATEGORIES (fires immediately like duplicate-live-workers)
- [ ] babysitters/agents/performance.md category enum + prose entry landed; README failure-class list updated
- [ ] Replaying the fn-12 incident shape (8 close jobs, epic open) through the detector yields one critical finding keyed on the plan_ref

## Done summary
Added detectCloseLoop: a state-based critical detector that fires when >=4 close-verb jobs accumulate against one still-open epic within 24h (the slow close-loop sibling of dup-dispatch's rate arm). Widened the jobs SELECT + JobRow with plan_verb, added a keyed epics read so done epics self-clear, and documented the new close-loop category in performance.md and README.
## Evidence
