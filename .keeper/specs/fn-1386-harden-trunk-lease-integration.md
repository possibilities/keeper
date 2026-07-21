## Overview

Two correctness/coverage gaps survive the close audit of the owner-mediated
trunk-integration work, both in the trunk-lease merge path. The verb-side
merge-under-lease orchestration (the code that merges an epic branch into
local default) ships with no unit coverage and a documented recovery-path
behavior that diverges from its skill contract; separately the daemon's
residue sweep appends a synthetic event every tick a conflict persists.
This follow-up adds the missing coverage, reconciles the lease-release
contract, and stops the event-log churn.

## Acceptance

- [ ] Verb-side trunk merge-under-lease path is covered by saga-level tests behind a pure git seam, including the conflict-retains-lease and off-branch/dirty/residue/tip-drift/release-fail typed exits.
- [ ] The ancestor re-grade path and the SKILL.md recovery contract agree: either the re-grade adopts and releases a lingering active lease, or SKILL.md is amended to state daemon-reclaim is the intended cleanup.
- [ ] The daemon residue sweep mints a DispatchFailed event only on a residue-state transition, not on every tick a MERGE_HEAD persists.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept   | .1 | No test references integrateRepoUnderLease/integrateEpicBases; only daemon runTrunkLeaseSweep + pure decideTrunkIntegrationFence are exercised. Trunk-merge orchestration and typed exits (close_finalize.ts:742-944) uncovered. |
| F2 | kept   | .1 | close_finalize.ts:1034 ancestor `continue` skips integrateRepoUnderLease so no lease is adopted/released, contradicting SKILL.md:88/275 "adopts and releases the still-live trunk lease before close"; self-heals via daemon reclaim but the doc is false. |
| F3 | culled | —  | daemon runTrunkLeaseGit omits the GIT_* env strip that verb-side trunkGit does (close_finalize.ts:590-597), but the daemon is never lane-launched and every call is a read-only probe that defers on misdirection — defensive-consistency only. |
| F4 | kept   | .2 | daemon.ts:4858 residueRecorded is per-tick, so recordResidue->handleDispatchFailedMint appends a DispatchFailed event every INCIDENT_CLAIM_SWEEP_INTERVAL_MS (3s) a MERGE_HEAD persists — event-log growth re-folded forever against the history-growing-fold time-bomb invariant. |

## Out of scope

- The daemon GIT_* env-strip consistency nit (F3, culled) — read-only probes that defer on misdirection, no user impact.
- Any change to the incident-claim or trunk-lease store hardening, which the audit found exemplary.
