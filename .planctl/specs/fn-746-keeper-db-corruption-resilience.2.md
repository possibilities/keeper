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

## Evidence
