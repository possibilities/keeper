## Description

From audit findings F2 (kept) and F4 (merged into F2), same root cause: the
`dispatch_mint_gate` DELETE inside `foldDispatchCleared`.

Evidence path (audited commit f6c264a8):
- `src/reducer.ts` `foldDispatchCleared` — line 4336 (`DELETE FROM dispatch_mint_gate WHERE dispatch_key = ? AND attempt_id IS NULL`, legacy branch) and line 4361 (`... AND attempt_id = ?`, exact-attempt branch). The fold mutates a producer-owned durable table that the `refold-equivalence` test deliberately neither wipes nor asserts.

Two deliverables, one commit:
1. Add a comment at the fold's `dispatch_mint_gate` DELETE stating WHY the exact-attempt DELETE is re-fold-safe (attempt id is the unique `Dispatched` event id, so a historical clear's attempt id can never equal a currently-live gate row's) and WHY the legacy-null DELETE is bounded-acceptable (transitional; worst case one un-suppressed re-mint, which `evictStaleDispatchMintGate` reaps).
2. Add a re-fold test (alongside the existing `refold-equivalence` coverage) pinning that a live `attempt_id IS NULL` gate row is NOT clobbered by an unrelated historical tokenless `DispatchCleared` for the same `dispatch_key` — or, if that exposure is intentionally accepted, a test documenting it explicitly.

Files: `src/reducer.ts` (fold comment), the reducer re-fold / `refold-equivalence` test file (new assertion).

## Acceptance

- [ ] The mint-gate DELETE in `foldDispatchCleared` carries the re-fold-safety comment (both branches explained).
- [ ] A re-fold test pins the legacy-null gate-row behavior under a full cursor=0 replay.
- [ ] No production behavior change; existing tests stay green.

## Done summary
Documented the exact-attempt-vs-legacy-null re-fold safety rationale at both dispatch_mint_gate DELETE sites in foldDispatchCleared and added a re-fold test pinning the legacy-null gate-row behavior under a full cursor=0 replay.
## Evidence
