## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts (or a new compaction module), test/ (compaction + re-fold), keeper internals

### Approach

Add a daemon-side compaction pass that relocates COLD `data` blobs out of
`events` into `event_blobs`: for events past a cold watermark (e.g. whose
file attribution has discharged AND/or older than a retention window —
pick a conservative, well-defined predicate), per paced batch `INSERT INTO
event_blobs(event_id, data) SELECT id, data FROM events WHERE <cold> AND
data IS NOT NULL` then `UPDATE events SET data = NULL WHERE <same batch>`,
in one transaction so the blob is never in neither place. The blob VALUE is
preserved (COALESCE reads it back from .1), so re-fold stays byte-identical.
Relax `data` to nullable if not already. Handle the `idx_events_tool_attr`
correctness boundary: the file-attribution scan only matters for events
whose attribution can still be LIVE (undischarged / recent dirty files), so
the cold predicate MUST NOT compact any blob the attribution scan could
still need — keep the recent/undischarged window inline (the index then
still covers the only rows the scan reads), OR move the index/scan onto the
COALESCE'd value. Run the pass paced (never block the drain / writer lock;
PASSIVE checkpoint, not TRUNCATE), and only reclaim space (VACUUM/checkpoint)
outside the hot path. Make absent-in-both-places observable (a bug counter),
distinct from legitimate compaction. NEVER delete an events row.

### Investigation targets

**Required** (read before coding):
- Task .1's COALESCE read sites + the event_blobs schema
- src/db.ts:389 `data TEXT NOT NULL` (relax to nullable); :452 idx_events_tool_attr (correctness boundary)
- src/reducer.ts:1593-1607 — file-attribution scan: which events it can read (drives the cold predicate / inline-window decision)
- src/git-worker.ts discharge + file_attributions semantics — what "discharged / cold" means for an event's blob
- CLAUDE.md: PASSIVE checkpoint never TRUNCATE; producer workers feed the log only via main; re-fold determinism

### Risks

- A too-aggressive cold predicate could NULL a blob the file-attribution scan still needs → orphan-attribution regression (the reliability mission's zero-orphaned-files streak). Keep the live/undischarged window inline; prove the predicate is conservative.
- Compaction is a NEW write path on `events` — must respect single-writer (run via main's writable connection, paced, never inside a fold) and never break re-fold (value preserved).
- VACUUM in WAL mode needs a following checkpoint to actually reclaim; don't TRUNCATE in the hot path.

### Test notes

Test: (a) compact a cold batch → events.data NULL, event_blobs has it, reducer reads identical via COALESCE; (b) re-fold over the compacted DB = byte-identical projections vs pre-compaction; (c) the file-attribution scan still finds attributions for live/undischarged events after a compaction run; (d) absent-in-both-places folds safe + increments the bug counter. Measure DB size before/after.

## Acceptance

- [ ] Compaction relocates cold blobs (INSERT into event_blobs + UPDATE events.data=NULL) atomically per batch; no events row ever deleted
- [ ] Cold predicate provably excludes any blob the file-attribution scan could still need (live/undischarged window stays inline); idx_events_tool_attr correctness preserved
- [ ] From-scratch re-fold over a compacted DB = byte-identical projections
- [ ] Runs paced via main's writable connection, never inside a fold, never blocks the drain; PASSIVE checkpoint, space reclaimed outside the hot path
- [ ] `events` table + DB measurably smaller after a run; absent-in-both-places is a counted bug, not silent
- [ ] `data` column relaxed to nullable

## Done summary
Added daemon-side cold-blob compaction relocator: v57->v58 stop-the-world rebuild relaxes events.data to nullable (temp-new-table + foreign_keys OFF to avoid the FK-rewrite trap), src/compaction.ts paces atomic INSERT-into-event_blobs + UPDATE events.data=NULL per batch with a recent-retention watermark, absent-in-both bug counter, and PASSIVE checkpoint; reducer's explicit-attribution scan now reads both events.data (indexed) and event_blobs (relocated) so re-fold stays byte-identical. Validated on the real 1.6 GB prod DB: 30k blobs relocated, rows preserved, lossless COALESCE readback.
## Evidence
