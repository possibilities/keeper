## Overview

Bounding the post-backup restic monitoring added a 90s guard to the
`restic snapshots` call in both backup scripts, but only the stats branch
was widened to retain prior values on any guard failure. The snapshot
branch still preserves prior values only when the backup itself failed, so
a successful backup whose snapshot query hits the deadline writes blank
`LAST_SNAPSHOT_TIME` / `SNAPSHOT_AGE_HOURS` / `SNAPSHOT_COUNT_7D` into the
state file that backup-monitor reads. This corrects that asymmetry.

## Acceptance

- [ ] On a successful backup where the guarded `restic snapshots` call
      times out or otherwise fails, prior snapshot fields are retained
      rather than written blank.
- [ ] Both `restic-backup` and `restic-backup-silverbird` handle the
      snapshot guard-failure path symmetrically with the stats branch.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | culled | — | restic-backup:213 --mode raw-data shift is spec-directed and intentional; the flag self-documents, no fix warranted |
| F2 | kept | .1 | restic-backup:192-209 guards snapshots on the new 90s deadline but retains prior only on backup-failure, so success+timeout writes blank snapshot fields where the adjacent stats else retains prior |
| F3 | culled | — | restic-backup:51-89 duplicated guard() is consistent with the repo's standalone-script duplication convention; no user impact |

## Out of scope

- Extracting the duplicated `guard()` into a shared helper (F3) — consistent with the repo's standalone-script convention.
- The `--mode raw-data` size-metric semantic shift (F1) — spec-directed and intentional.
