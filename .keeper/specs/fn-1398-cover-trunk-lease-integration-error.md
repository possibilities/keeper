## Overview

The trunk-lease hardening epic relocated three error-emission branches
into `integrateRepoUnderLease` (the `TRUNK_LEASE_REQUEST_FAILED` and
`TRUNK_LEASE_PENDING` typed-exits plus the `acquireLock`-null lock-contention
exit) but the new saga suite never exercises them: `makeFakeTrunkDeps`
always returns `requestLease: {ok:true}` and no case sets `lockOk:false`.
This follow-up completes that task's stated coverage mission with three
focused saga cases over the already-built harness, so a regression in the
restructured typed-exit wiring is caught.

## Acceptance

- [ ] The three relocated trunk-lease error exits each have a dedicated saga case asserting the exact emitted error code.
- [ ] The new cases reuse the existing `makeFakeTrunkDeps` harness (no new real-git/daemon round-trips).

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | culled | — | Daemon commit 5d5d9f092 reviewed inline: residue-mint dedup is transition-gated and daemon.test-covered; the commit sits only on the un-fanned-in per-task sublane (not the scanned epic lane), a pre-fan-in timing condition that self-heals on preflight re-run — not a builder defect. |
| F2 | kept | .1 | Relocated TRUNK_LEASE_REQUEST_FAILED / TRUNK_LEASE_PENDING / lock-contention exits in integrateRepoUnderLease are uncovered; harness already supports the injection. |
| F3 | culled | — | Narration-block comment nit; only remedy is trimming an inline comment, no keep-bar criterion met. |

## Out of scope

- Any change to the trunk-lease integration production code — it ships clean; this is test-coverage only.
- The daemon-side residue-mint dedup (task .2 / commit 5d5d9f092) — reviewed clean during the close audit.
- Any close-preflight commit-set-builder change — the missing commit was a pre-fan-in sublane condition, not a builder bug.
