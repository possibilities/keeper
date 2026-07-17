## Overview

The dispatch-clear fold (`foldDispatchCleared`) now DELETEs from
`dispatch_mint_gate` — a producer-owned durable table the
`refold-equivalence` test deliberately excludes from its wipe/assert set.
On its face this reads as a violation of the repo's sacred re-fold
determinism invariant, and its safety rests on a non-obvious property
(attempt ids are unique `Dispatched` event ids, so a historical clear can
never match a currently-live gate row). This follow-up documents that
invariant in the fold and pins it with a re-fold test so a future
maintainer neither mistakes the DELETE for a bug nor silently regresses
the one residual legacy-null re-fold edge.

## Acceptance

- [ ] The `dispatch_mint_gate` DELETE in `foldDispatchCleared` carries a comment stating why the exact-attempt DELETE is re-fold-safe and why the legacy-null branch is bounded-acceptable.
- [ ] A re-fold test asserts that a live `attempt_id IS NULL` gate row survives an unrelated historical tokenless `DispatchCleared` (or documents the intentional transitional exposure).

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | culled | — | Advisory/borderline ADR flag; internal event-payload fence fields, public retry_dispatch wire unchanged, streak-survives-clear rationale already in commit messages. |
| F2 | kept | .1 | reducer.ts:4336/:4361 foldDispatchCleared DELETEs dispatch_mint_gate (a table refold-equivalence excludes); comment must state the attempt-id-uniqueness re-fold-safety invariant. |
| F3 | culled | — | Speculative-generality: runDispatchMintGate attemptId param (db.ts:5952) never passed non-null by the sole caller daemon.ts:10910; harmless dead knob. |
| F4 | merged-into-F2 | .1 | F4 (missing dispatch_mint_gate re-fold test) shares F2's root cause the mint-gate DELETE re-fold safety; the test backs F2's documented invariant. |

## Out of scope

- No behavior change to the fence design, the mint-gate window, or the clear producers — this is documentation plus a pinning test only.
- No `docs/adr` entry (F1 culled) and no removal of the `runDispatchMintGate` `attemptId` param (F3 culled).
