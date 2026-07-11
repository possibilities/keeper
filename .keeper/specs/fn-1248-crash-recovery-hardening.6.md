## Description

**Size:** S
**Files:** src/maintenance-worker.ts, src/backup.ts, test/backup.test.ts

### Approach

Scope: reduce the daily full-copy backup I/O churn — the DB file-size shrink
(1.9 GB → offline VACUUM INTO + mv) is handled OUT OF BAND as an operator
maintenance window, NOT here. This task must NOT touch the immutable `events`
table and must NOT add a `SCHEMA_STEPS` entry (re-fold determinism is sacred).

Reproduce/confirm: `src/maintenance-worker.ts:212-215` runs a 24h
`BACKUP_INTERVAL_MS` → `runBackupPass` → `backupDb` full `VACUUM INTO` copy of the
DB, 3 retained (`src/backup.ts`). Evaluate and apply a churn reduction that keeps
restore safety: a longer/tunable cadence, and/or confirming steady-state retention
(`src/compaction.ts`) is actually returning pages (check `PRAGMA auto_vacuum` — an
`incremental_vacuum` is a no-op unless the DB was born INCREMENTAL; if it is not,
record that finding — it explains the bloat and defers real reclamation to the
offline window, which is fine). If a post-VACUUM `wal_checkpoint(TRUNCATE)` is
missing, add it (else freed pages just move into the WAL). Keep the
code-rendered backup runbook (`src/backup.ts`) as the single source of truth;
adjust prose in docs/install.md / README only if cadence changes.

Shares `src/maintenance-worker.ts` with task .4 (panel GC) — hence the dep edge,
to avoid a fan-in collision on that file.

### Investigation targets

*Verify before relying — planner-verified at authoring time, repo moves.*

**Required:**
- src/maintenance-worker.ts:212-215 — `BACKUP_INTERVAL_MS` / `runBackupPass`
- src/backup.ts:74,226 — `BACKUP_INTERVAL_MS`, `DEFAULT_BACKUP_RETENTION`; :755 `reclaimInstructions` (offline runbook, reference only)
- src/compaction.ts:396-400 — `incremental_vacuum` no-op unless born INCREMENTAL

**Optional:**
- docs/install.md (Backup & restore), README.md:16-17 — prose to revise only if cadence changes

### Risks

- Weakening cadence/retention could reduce restore safety — keep at least the current recoverability guarantee.
- Must stay entirely off the events table and the schema ladder (no migration).

### Test notes

Extend `test/backup.test.ts` for any cadence/checkpoint change; assert a backup still produces a restorable snapshot. Record the live `PRAGMA auto_vacuum` finding in Evidence.

## Acceptance

- [ ] Daily backup I/O churn is reduced (cadence and/or checkpoint) with restore safety preserved (a produced backup still restores).
- [ ] No change touches the immutable `events` table or adds a `SCHEMA_STEPS` entry.
- [ ] The live `PRAGMA auto_vacuum` mode is recorded, documenting whether online reclamation is even possible.

## Done summary

## Evidence
