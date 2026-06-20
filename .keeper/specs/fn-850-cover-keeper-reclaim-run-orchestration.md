## Overview

The `keeper reclaim` command's `run()` glue performs the one irreversible
operation in the feature — the atomic same-fs swap of the live DB plus the
stale `-wal`/`-shm` sidecar drop — yet has no end-to-end test against a real
temp DB. The individual helpers are covered; the orchestration that strings
them into a destructive swap is not. This follow-up locks the happy path and
the daemon-up refusal so a future edit can't silently break the swap.

## Acceptance

- [ ] An end-to-end test drives `run()` against a real temp DB and asserts the
      live file is swapped to the reclaimed copy with `-wal`/`-shm` dropped.
- [ ] A test asserts the daemon-up refusal path (exit 1, original DB untouched).

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | culled | — | Unreadable-lock-is-down in cli/reclaim.ts:148-163 is a deliberate, documented choice; auditor marks no change required. |
| F2 | culled | — | Daemon-up guard keeps the daemon down for the whole run; concurrent prune of the rollback snapshot is unrealistic (advisory only). |
| F3 | culled | — | COUNT(*) scan cost in readTableRowCounts is an offline one-shot perf trait; auditor marks no change needed. |
| F4 | kept | .1 | cli/reclaim.ts:183-265 — the irreversible swap + sidecar-drop happy path has no end-to-end run() test. |
| F5 | merged-into-F4 | .1 | F5 (daemon-up refusal, cli/reclaim.ts:192-202) shares F4's root cause (no run()-level coverage) and lands in the same test commit as F4. |
| F6 | culled | — | schema_version-mismatch branch of verifyReclaim is auditor-flagged low value and near-unreachable under the single-migrator invariant. |

## Out of scope

- The `daemonUp` unreadable-lock edge case (F1) — deliberate documented behavior.
- Rollback-snapshot retention semantics (F2) — advisory runbook nudge only.
- `readTableRowCounts` COUNT(*) scan cost (F3) — offline one-shot perf trait.
- The schema_version-mismatch branch of `verifyReclaim` (F6) — low value, hard to induce.
