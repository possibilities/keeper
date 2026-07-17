## Description

**Size:** S
**Files:** src/reducer.ts, test/reducer-projections.test.ts

### Approach

Make the fold-side timestamp-to-ISO helper total: guard the conversion so NaN, non-finite, negative-beyond-epoch-range, and otherwise invalid event timestamps produce a deterministic fallback (derived only from the input value, never wall-clock) instead of throwing RangeError inside a fold. Every fold-side caller keeps its current output byte-identically for valid inputs — re-fold determinism is sacred, so the change is purely additive on the invalid domain. Audit the helper's callers to confirm all are fold-side and none needs throwing semantics.

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but the repo moves.*

**Required** (read before coding):
- src/reducer.ts:9589 — the unguarded conversion helper
- src/reducer.ts:9688, 9751 — fold-side callers observed at authoring time; enumerate any others before changing the contract

### Risks

- The fallback string must be deterministic from the input alone; any wall-clock or locale dependence breaks re-fold equivalence.

### Test notes

Table-drive the invalid domain (NaN, Infinity, -Infinity, out-of-range magnitudes, non-number data reaching the helper) through a real fold via freshMemDb; assert the cursor advances and the projection carries the fallback. Assert byte-identical output for a valid-timestamp corpus.

## Acceptance

- [ ] Folding an event with each class of invalid timestamp completes, advances the cursor, and never dead-letters on conversion
- [ ] A valid-timestamp corpus converts byte-identically to the prior behavior
- [ ] Focused fold tests cover the full invalid-domain table

## Done summary

## Evidence
