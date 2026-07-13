## Overview

The recover-pass bounded lane teardown re-invokes the backup-then-force
remove path on every post-grace reconcile cycle for a lane genuinely
wedged in force-remove. Each invocation mints a fresh snapshot dir plus
an index.ndjson line and re-copies the lane's untracked dirt, and the
remove-failed result never cleans that snapshot up (only backup-failed
does), so a persistently un-removable lane grows the lane-dirt spool
unboundedly even after it has paged the human once. This is a degrade-path
resource + IO leak; the fix bounds it to one snapshot per wedged lane.

## Acceptance

- [ ] A lane stuck in the recover-pass remove-failed state produces at most
      one dirt snapshot + one index.ndjson record across repeated cycles,
      not one per cycle.
- [ ] The page-once distress and positive-evidence level-clear behavior is
      unchanged; a genuinely re-tearable lane still gets torn down.
- [ ] A regression test exercises repeated force-remove failures across
      multiple recover cycles and asserts the spool stays bounded.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1  | culled | — | Narrowed ladder-absorb refusal (two byte-identical steps at main's version) is documented and needs a malformed duplicate ladder entry SCHEMA_STEPS discipline cannot author; theoretical. |
| F2  | culled | — | epic_lane_teardown.ts vs worktree-git.ts spool duplication is deliberate (plan plugin cannot import daemon src) and documented; formats identical, drift speculative, spool is human-recovery backup. |
| F3  | kept   | .1 | autopilot-worker.ts:7170 re-runs backupThenForceRemoveWorktree every post-grace cycle (tracker L1514 destroyable->destroy:true); remove-failed leaves snapshotDir on disk, so a wedged lane accretes a snapshot + index line + re-copied dirt per cycle unboundedly. |
| F4  | culled | — | 'create Phantom-working' comment clarity nitpick; ADR 0031 constraint already conveyed, comment-only remedy. |
| TG1 | merged-into-F3 | .1 | TG1 (multi-cycle remove-failed re-snapshot test) folds into F3: proving the spool stays bounded across repeated force-remove failures IS F3's acceptance, same root cause. |
| TG2 | culled | — | Ladder duplicate-at-shared-version test is tied to culled F1; auditor gates it on a decision that does not matter. |
| TG3 | culled | — | ensureLaneNodeModulesLink ENOTDIR path already handled in code; missing edge-case test is low-impact coverage. |

## Out of scope

- The deliberate spool-helper duplication between the plan plugin and daemon src (F2) — a documented tradeoff, not corrected here.
- The identity-keyed ladder-absorb narrowing (F1) and its edge test (TG2) — accepted, documented behavior.
