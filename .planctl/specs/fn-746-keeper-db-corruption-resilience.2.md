## Description

**Size:** M
**Files:** src/daemon.ts (checkpoint timer / config), src/compaction.ts or a new prune path, a backup script under cli/ or scripts/, docs

### Approach

Apply the resilience measures `.1` identified: (a) a `wal_checkpoint(PASSIVE)`
cadence (or tuned `wal_autocheckpoint`) so the WAL stays bounded on the 2 GB DB;
(b) a backup/snapshot path (e.g. `VACUUM INTO` or the SQLite backup API to a
timestamped copy) plus a DOCUMENTED restore procedure, so a future malformed
image is recoverable; (c) DB size management if `.1` shows unbounded growth —
confirm cold-blob compaction keeps pace, add pruning/`VACUUM` policy if needed.
Preserve the single-writer discipline (checkpoint/backup run producer-side, not
in a fold) and keep batches/locks short so hook INSERTs aren't starved.

### Investigation targets

**Required:**
- `.1` findings (WAL state, compaction pace, segfault cause)
- src/daemon.ts — where to add the checkpoint timer (mirror the sweep/compaction timers)
- src/compaction.ts — existing size-management; backup API options for bun:sqlite

### Risks

- `VACUUM` rewrites the whole 2 GB DB + holds a write lock — use `VACUUM INTO` (copy,
  no lock on the live DB) for backup; avoid in-place VACUUM on the hot DB.
- Checkpoint must not starve the writer — PASSIVE, on cadence.
- Restore procedure must be tested/documented, not assumed.

### Test notes

- Pin: backup produces a restorable copy (open it, integrity_check ok); checkpoint
  cadence bounds WAL growth in a load test.

## Acceptance

- [ ] WAL stays bounded under load (checkpoint cadence); measured.
- [ ] A backup/snapshot path produces a verified-restorable copy; restore documented.
- [ ] DB size management confirmed (compaction keeps pace, or pruning/VACUUM-INTO
  policy added); single-writer + determinism preserved.

## Done summary
RECOVERY half of fn-746 (the .1 detection probe's complement). (b) BACKUP/SNAPSHOT: new src/backup.ts backupDb() runs VACUUM INTO to a timestamped snapshot under ~/.local/state/keeper/backups/ on a DEDICATED read-only source connection -- VACUUM INTO holds only a read transaction on the source, so it NEVER takes the writer lock or starves a concurrent hook INSERT (safe while keeperd is up; unlike in-place VACUUM which write-locks the 2GB live DB). Every snapshot is VERIFIED immediately with the full PRAGMA integrity_check; one that fails is DELETED (never left masquerading as a good backup -- restoring it would propagate corruption). Wired as a 24h producer-side daemon timer beside the .1 probe / checkpoint / compaction timers (never in a fold, no synthetic event, no projection/reducer touch -- re-fold determinism + sole-writer untouched; cleared on shutdown), logging on success and PAGING (botctl Keeper topic) on failure. scripts/backup-db.ts operator util for an on-demand snapshot. (c) DB SIZE MANAGEMENT: the VACUUM INTO copy is freelist-compacted, so per .1's finding (live ~1.9GB file is freelist-poor because online VACUUM is deliberately deferred) the snapshot doubles as the SIZE-RECLAIMED image -- restoring it IS the offline VACUUM, off the hot path. (b-restore) DOCUMENTED restore procedure: restoreInstructions() single-source-of-truth string + README ## Backup & restore (stop daemon -> mv corrupt DB aside + rm stale WAL/SHM -> mv verified snapshot into place -> integrity_check -> restart). WAL cadence (a) was already handled by fn-744.2 (30s PASSIVE heartbeat + wal_autocheckpoint=1000) and confirmed bounded by .1, so no WAL change needed. 10 unit/e2e tests incl the restorable-copy PIN (snapshot opens + integrity_check ok + marker row matches source), the size-reclamation PIN (snapshot < bloated source), corrupt-snapshot-deleted, and pruning to the newest N.
## Evidence
