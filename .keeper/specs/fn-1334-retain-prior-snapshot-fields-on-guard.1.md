## Description

Traces to finding F2 (evidence: `bin/.local/bin/restic-backup:192-209`
and `bin/.local/bin/restic-backup-silverbird:190-207`). The snapshot
query is wrapped in `guard "$STATS_DEADLINE_SECONDS"`, but its failure
branch is `elif [[ "$LAST_BACKUP_SUCCESS" == "false" ]]`, so on a
successful backup where the guard fails (timeout on the new 90s deadline,
or any non-clean exit) the three snapshot vars fall through to their empty
initializers and are written blank to the state file. Mirror the adjacent
stats branch (`else` at `restic-backup:216`), which was correctly widened
to fall back to `prev_snapshot_*` on any guard failure. Apply the same
one-branch change to both scripts to keep them in sync.

Files:
- `bin/.local/bin/restic-backup` (snapshot guard-failure branch)
- `bin/.local/bin/restic-backup-silverbird` (same branch)

## Acceptance

- [ ] The snapshot guard-failure branch falls back to `prev_snapshot_time` / `prev_snapshot_age` / `prev_count` on any guard failure, not only when the backup failed.
- [ ] Change applied identically to both `restic-backup` and `restic-backup-silverbird`.
- [ ] Prior snapshot fields are retained (not blanked) on a successful backup whose snapshot query times out.

## Done summary

## Evidence
