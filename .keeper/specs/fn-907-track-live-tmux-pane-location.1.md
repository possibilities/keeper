## Description

**Size:** M
**Files:** src/db.ts, keeper/api.py, test/git-live-projection.test.ts

The schema foundation: new columns, the `tmux_projection_state` control table, the live-only
reclassification, the rewind wiring, and the one-time birth-session backfill. No producer/fold
logic here — just the migration + registries the other tasks build on.

### Approach

In `src/db.ts`, add a `< 83` step inside the single `.immediate()` migration txn:
add `jobs.backend_exec_generation_id` (TEXT) and `jobs.backend_exec_birth_session_id` (TEXT)
via `addColumnIfMissing`; `CREATE TABLE IF NOT EXISTS tmux_projection_state` (singleton
`id=1` CHECK, `floor INTEGER NOT NULL DEFAULT 0`, `seed_required INTEGER NOT NULL DEFAULT 0`,
`updated_at REAL NOT NULL`) mirroring `CREATE_GIT_PROJECTION_STATE`; seed its row + set
`seed_required = 1`; one-time backfill `UPDATE jobs SET backend_exec_birth_session_id =
backend_exec_session_id` (the frozen value IS the birth env for every existing row). Add
`CREATE_TMUX_PROJECTION_STATE` to the fresh-schema CREATE block (~db.ts:1831) so a brand-new DB
that never runs the migration step still gets the table. Add `backend_exec_session_id` +
`window_index` to `LIVE_ONLY_JOBS_COLUMNS`; add their zeroing to `rewindLiveProjection`'s UPDATE;
add a parallel reset of `tmux_projection_state` (floor=0, seed_required=1) to `rewindLiveProjection`.
Add `tmux_projection_state` floor/seed accessors (`readTmuxProjectionFloor` / `raiseTmuxProjectionFloor`
/ `readTmuxProjectionSeedRequired` / `setTmuxProjectionSeedRequired`) beside the git twins
(db.ts:1329-1380). Bump `SCHEMA_VERSION = 83` (db.ts:48). Add `83` to `SUPPORTED_SCHEMA_VERSIONS`
in `keeper/api.py` (same commit — `test/schema-version.test.ts` enforces). Update the exact-membership
assertion in `test/git-live-projection.test.ts:109-119` from 3 cols to 5.

NO cursor rewind-and-redrain: the two columns become live-only (boot-seeded, not replayed), so
history is never re-folded for them — the backfill + boot-seed cover the existing rows. This
deliberately avoids re-arming the `computeRepoBashWindows` O(history) re-fold time-bomb.

### Investigation targets

**Required** (read before coding):
- src/db.ts:1206 — `CREATE_GIT_PROJECTION_STATE` (mirror shape)
- src/db.ts:1281 — `LIVE_ONLY_JOBS_COLUMNS` (add 2)
- src/db.ts:1305 — `rewindLiveProjection` (extend zeroing + add tmux floor reset)
- src/db.ts:1329-1380 — git floor/seed accessors (mirror as tmux twins)
- src/db.ts:1831 — fresh-schema CREATE block (must add CREATE_TMUX_PROJECTION_STATE)
- src/db.ts:48 — `SCHEMA_VERSION`; latest migration step `if (preMigrateStoredVersion < 82)` ~db.ts:4443
- keeper/api.py:~414 — `SUPPORTED_SCHEMA_VERSIONS` frozenset
- test/git-live-projection.test.ts:109-119 — exact-membership `.toEqual` (must become 5 cols); :142-153 floor-accessor tests (mirror)

**Optional** (reference as needed):
- src/db.ts:4270-4278 — v79 floor-init block (template for the new floor-seed step)
- src/db.ts:3359-3366 — the original `backend_exec_*` column adds (addColumnIfMissing shape)

### Risks

- `backend_exec_session_id` is deterministic-replayed TODAY; flipping it live-only must NOT
  leave it in the byte-identical charter — confirm refold-equivalence blanks/excludes it.
- Forgetting the fresh-schema CREATE block leaves a brand-new DB without `tmux_projection_state`.
- The membership `.toEqual` is a hard array equality — order matters; match the registry order.

### Test notes

Mirror `test/git-live-projection.test.ts` floor-accessor tests for the tmux twins; assert a
fresh `freshDb()` has `tmux_projection_state` and the two new jobs columns; assert
`SUPPORTED_SCHEMA_VERSIONS` includes 83. Run `test/schema-version.test.ts`.

## Acceptance

- [ ] v83 migration adds both columns + `tmux_projection_state` (singleton, seed_required=1),
      backfills birth_session from the current session, and is present in BOTH the migration
      ladder and the fresh-schema CREATE block.
- [ ] `LIVE_ONLY_JOBS_COLUMNS` = the 3 git counters + `backend_exec_session_id` + `window_index`;
      `rewindLiveProjection` zeroes all five AND resets `tmux_projection_state`.
- [ ] tmux floor/seed accessors exist beside the git twins.
- [ ] `SCHEMA_VERSION = 83` and `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS` includes 83.
- [ ] `test/git-live-projection.test.ts` membership assertion updated to 5 cols; `bun test
      test/git-live-projection.test.ts test/schema-version.test.ts` green.

## Done summary

## Evidence
