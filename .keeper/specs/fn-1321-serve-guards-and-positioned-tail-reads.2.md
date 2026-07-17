## Description

**Size:** S
**Files:** src/server-worker.ts, test/status.test.ts, docs/adr/0075-honest-replay-projections-and-rebuild-recipe.md

### Approach

The full-replay projection currently fires whenever positive fold-work
exists, however tiny the sample — a ~22-event quiet boot amortizes
cold-start costs into the rate and inflates the projection ~15x. Add a
minimum-sample floor to the PURE projection function: when the folded
event count is strictly below 1000, the full-replay leg reads null
("not measured"); at or above the floor it projects as today. The
catch-up leg stays unfloored — its pending-events multiplier is small
and bounded while full-replay's total-event-count multiplier amplifies
noise without bound; state that rationale in the docstring with the
exact boundary. Two existing suite fixtures fold 500 and 400 events
and assert non-null full-replay — re-author them to fold at or above
the floor (scale the hand-computed constants) rather than weakening
the floor. Amend ADR 0075's null-condition bullet IN PLACE so the null
contract stays single-sourced: null on missing/non-positive work OR a
below-floor sample. The function stays pure — no DB, no clock.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/server-worker.ts:2440-2489 — computeEventStoreStatus; eventsFolded at :2456; the workMs>0 guard on the full-replay leg at :2476-2481
- test/status.test.ts:192-290 — the pure-fn suite: null-honesty idiom (:193/:228/:245/:260/:275) and the two below-floor non-null fixtures (:204 folds 500, :245 folds 400) that must be re-authored
- docs/adr/0075-honest-replay-projections-and-rebuild-recipe.md — the Decision bullet to amend in place

**Optional** (reference as needed):
- src/server-worker.ts:2371-2412 — BootCatchupStats + readBootCatchupStats (where workMs comes from)

### Risks

- Forgetting the two pinned fixtures flips the suite red — re-author, never widen the floor to fit them
- The floor must gate ONLY the full-replay leg; flooring catch-up would hide real catch-up latency

### Test notes

New cases: below-floor (non-trivial workMs, eventsFolded 999) → null
full-replay + non-null catch-up; at-floor (1000) → projects; the
re-authored scaled fixtures keep their hand-computed expectations.

## Acceptance

- [ ] With positive fold-work and fewer than 1000 folded events the full-replay projection is null while the catch-up projection still derives from wall-clock
- [ ] At or above 1000 folded events the full-replay projection behaves exactly as before
- [ ] The projection function remains pure and its docstring states the boundary and the asymmetry rationale; ADR 0075's amended bullet carries the same contract
- [ ] The full fast correctness gates stay green

## Done summary
Added a 1000-folded-event floor to the pure computeEventStoreStatus full-replay projection (null below the floor, unchanged at/above it, catch-up unfloored); re-authored the two pinned suite fixtures at/above the floor, added a below-floor test case, and amended ADR 0075's null-condition bullet in place.
## Evidence
