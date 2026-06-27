## Overview

The new pre-merge non-fast-forward precheck treats an unresolved
`origin/<default>` tracking ref identically to a diverged one, and it runs
before the turn-key push probe. For a repo whose default branch was never
pushed (origin configured, no cached `origin/<default>` ref) finalize
degrades to a permanent skip-retry with a factually-wrong "origin ahead"
reason, and the turn-key probe that would admit a legitimate first push is
unreachable. This follow-up fixes that degrade-to-deadlock and its
misleading diagnostic, and clears fn-id provenance the diff introduced into
source comments (project rule #0).

## Acceptance

- [ ] A repo with origin + `@{push}` but no cached `origin/<default>` ref completes its first finalize push instead of jamming forever.
- [ ] The skip reason emitted on a genuinely-diverged remote stays accurate and is no longer emitted for the merely-absent-ref case.
- [ ] No fn-id provenance remains in the touched autopilot-worker.ts comments; surrounding prose still states current behavior.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | worktree-git.ts:563-564 returns false for an unresolved origin/<default>; the finalize FF check (autopilot-worker.ts:2593-2601) precedes the turn-key probe (2610-2617), so a never-pushed-default repo jams with a wrong reason. |
| F5 | merged-into-F1 | .1 | F5 (no end-to-end test for the never-pushed finalize path) is the coverage for F1's fix and lands in the same commit, so it folds into F1. |
| F2 | kept | .2 | Confirmed fn-988-stamped comments at autopilot-worker.ts:614 and :3449 violate rule #0 (no fn-ids in source comments). |
| F3 | merged-into-F2 | .2 | F3 (fn-973 provenance at :2695, fn-987 at :2901) shares F2's root cause — fn-id provenance in autopilot-worker.ts comments — so F3 folds into F2. |
| F4 | culled | — | Auditor-rated low-confidence and self-healing via the live-git teardown enumeration; no concrete impact substantiated. |

## Out of scope

- F4 (lane-path scheme mid-flight collision): culled as a low-confidence, self-healing transient.
- Any auto-fetch / rebase / force behavior on a shared checkout — the shared-checkout invariant stands; the fix only re-orders the existing probes and refines the absent-ref classification.
