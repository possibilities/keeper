## Description

**Size:** M
**Files:** src/commit-work/private-index.ts, src/commit-work/repo-state.ts, cli/commit-work.ts, docs/problem-codes.md, test/commit-work.test.ts, test/slow/commit-work-publication-realgit.test.ts

### Approach

ADR 0068 decision 5. The private-index publication compare ignores
exactly the classifier's excluded prefix (.keeper) so runtime state
churn cannot trip surface_changed — while the whole-tree hook/config
mutation defense stays intact. A HEAD advance whose delta does not
intersect the frozen selection triggers a bounded internal
re-freeze-and-retry on the moved tip (jittered, capped, then the
existing typed refusal); the moved ref is never rolled back, and a
genuine selection overlap refuses exactly as today. The shared-checkout
jam gate stays repo-scoped; its refusal envelope gains concrete
recovery hints (the distress row id and its clear condition).
Reconcile the problem-codes wording for surface_changed, ref_conflict,
and commit_state_indeterminate with the new semantics.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/commit-work/private-index.ts:762,800-824 — the whole-tree compare + verifyFrozenSelectedSurface; where selection scoping lands
- src/commit-work/surface.ts:153 — EXCLUDED_PREFIX; mirror, do not fork
- src/commit-work/repo-state.ts:139-168 — sharedCheckoutJamActive; envelope hints, not path-scoping
- test/slow/commit-work-publication-realgit.test.ts — the real-git publication proof surface for retry-under-drift

**Optional** (reference as needed):
- docs/adr/0063 — "a ref race refuses rather than rolls another writer back" + the commit_hook_mutated defense both stay whole
- docs/adr/0068-commit-work-vacated-claims-and-honest-drift.md — decision 5

### Risks

- The .keeper exemption must not create a lane for smuggling tracked-file mutations past the freeze — exempt by prefix on UNTRACKED runtime paths, never weaken the frozen selected-set verification.
- Retry-under-contention can thrash: bound retries with jitter and surface the final refusal with the attempt count.

### Test notes

Real-git slow tests: HEAD advanced by a non-overlapping commit →
publish succeeds on retry; overlapping commit → typed refusal;
.keeper churn during lint → no surface_changed. Fast tests for the
envelope hint fields. problem-codes rows reconciled.

## Acceptance

- [ ] Excluded-prefix churn during the critical section no longer produces surface_changed
- [ ] A non-overlapping HEAD advance publishes via bounded internal retry without rolling back any ref; genuine overlap still refuses with the attempt count
- [ ] The jam refusal envelope names the blocking distress row and its clear condition
- [ ] problem-codes wording matches the new CAS semantics and the touched suites pass plus the fast gate

## Done summary

## Evidence
