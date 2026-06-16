## Description

**Size:** M
**Files:** src/db.ts, keeper/api.py, src/reducer.ts, src/daemon.ts, src/restore-worker.ts

Persist each live agent's tmux `window_index` onto a `jobs` column so the DB-only restore derivation (T3) can reproduce original left-to-right window order without reading restore.json.

### Approach

Add a nullable `jobs.window_index INTEGER` column via `addColumnIfMissing`; bump `SCHEMA_VERSION` 70→71 and add `71` to `SUPPORTED_SCHEMA_VERSIONS` (same commit). The restore-worker already captures window_index per-pulse via its tmux snapshot (`TmuxPaneSnapshotMessage` → main); route that into a CHANGE-GATED synthetic event (hash-gated like the restore.json write) that main emits and the reducer folds onto `jobs.window_index`. Keep the restore.json `current` mirror writing window_index too (the dumb fallback). The fold is a pure integer copy keyed by `job_id`; a job not in the latest snapshot keeps its last value (or nulls on prune — match the existing cache-prune semantics). NO wall-clock / liveness in the fold.

### Investigation targets

**Required** (read before coding):
- src/restore-worker.ts:129,361,691 — per-pulse `window_index` capture + the `TmuxPaneSnapshotMessage` post to main
- src/daemon.ts — where main receives the restore-worker's snapshot message (trace `TmuxPaneSnapshot`)
- src/daemon.ts:1246-1254 raw boot-append INSERT (29-col list) / :3515 prepared insertEvent — the synthetic-event emit pattern + the two column lists that must stay in sync
- src/reducer.ts:6768 — fold switch `default: break` (a new event type folds as no-op unless given an arm; window_index needs an arm)
- src/db.ts:50 `SCHEMA_VERSION`, :3389 `addColumnIfMissing`
- keeper/api.py:259 `SUPPORTED_SCHEMA_VERSIONS`

**Optional**:
- src/collections.ts:599 — if `window_index` should be exposed on the `jobs` collection descriptor
- test/restore-worker.test.ts — snapshot-pulse test patterns

### Risks

- Event volume: gate emission on a layout-change hash so window reordering doesn't flood the log; mirror restore.json's existing write-gate.
- Re-fold determinism: the fold must key on the event payload only (job_id → index), never re-probe tmux; the producer (restore-worker/main) owns the probe.
- Column-list sync: if a NEW event type is added, confirm it needs no new events column (rides the payload blob) so the raw + prepared insert column lists stay aligned.

### Test notes

Reducer test: a layout event folds window_index onto the right jobs rows; a re-fold from scratch reproduces identical values. Verify a killed job retains its last-known window_index (needed at restore time when tmux is dead). `freshDb()` in-process.

## Acceptance

- [ ] `jobs.window_index` column added; `SCHEMA_VERSION`=71 and `71` in `SUPPORTED_SCHEMA_VERSIONS` (same commit).
- [ ] A change-gated synthetic event carries window_index from the restore-worker snapshot into the DB; reducer folds it deterministically.
- [ ] A killed job's last-known window_index survives on its jobs row.
- [ ] restore.json `current` mirror still carries window_index (fallback intact).
- [ ] `bun run test:full` green.

## Done summary

## Evidence
