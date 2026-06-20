## Description

**Size:** M
**Files:** src/compaction.ts (or new backfill module), src/reducer.ts, src/db.ts, src/daemon.ts, tests

Backfill `mutation_path` over ALL historical mutation rows (including those already
relocated to `event_blobs`), then flip the git-attribution scan to read the column and
delete ARM B. After this, the fold no longer reads `event_blobs` for attribution
(the table still exists; .4 drops it).

### Approach

Online, compaction-paced backfill mirroring `compactColdBlobs`: collect a batch of ids
read-only, then `UPDATE events SET mutation_path = <guarded extract>` under a brief
`BEGIN IMMEDIATE`, `PRAGMA wal_checkpoint(PASSIVE)` BETWEEN batches (not inside), batch
≤500 rows, ≤20 batches/pass, busy_timeout 5000, synchronous=NORMAL, cache_size -131072
on the backfill connection, do NOT hold cursors across batches (checkpoint starvation).
The extract MUST read `COALESCE(events.data, event_blobs.data)` so already-relocated
rows are covered, using the IDENTICAL guarded SQL ARM B uses
(`CASE WHEN json_valid(...) THEN json_extract(...,'$.tool_input.file_path') END`) so
malformed→NULL is byte-identical. Persist a crash-safe resume watermark in `meta`
(written in the SAME BEGIN IMMEDIATE as the UPDATE); the completion gate is "zero
mutation rows with `mutation_path IS NULL AND data-or-blob yields a valid file_path`"
(distinguishes done-null/malformed from pending). When complete AND the .1 harness is
green: flip ARM A's query (reducer.ts:1287-1292) from `json_extract(data,...)` to the
`mutation_path` column, DELETE ARM B (relocatedStmt, reducer.ts:1294-1305) and its merge
arm, and drop reliance on the expression index `idx_events_tool_attr` (the new partial
index serves it). The drain SELECT keeps its COALESCE for now (event_blobs still exists).

### Investigation targets

**Required** (read before coding):
- src/compaction.ts:188 (compactColdBlobs), :242 (BEGIN IMMEDIATE), :109/:118 (batch/max-batches), :158 (computeColdWatermark), :256 (moreLikely), :274 (countAbsentBlobs — header-only IS NULL probe, NEVER COALESCE for nullness)
- src/reducer.ts:1287-1305 (ARM A flip / ARM B delete), :1442-1447 (why ALL historical rows must be backfilled)
- src/daemon.ts:3185-3247 (runCompactionPass + compactionTimer pacing to mirror)
- src/db.ts:421 (idx_events_tool_attr)

**Optional** (reference as needed):
- src/refold-progress.ts (cursor/MAX(id) poller pattern)

### Risks

- Relocated rows: if the backfill reads only `events.data` (NULL for relocated), mutation_path stays NULL and the discharged-mutation re-fold scan breaks. MUST COALESCE both sides.
- Completion gate must not confuse "legitimately null (malformed/no file_path)" with "not yet backfilled" — gate on the guarded-extract-yields-a-value predicate, not on `mutation_path IS NULL` alone.
- Do not flip ARM A until backfill is provably complete AND the harness is green — a premature flip with NULL columns silently drops attributions.

### Test notes

Backfill idempotence + resume-after-restart (watermark) test. Post-flip .1 differential
harness MUST be byte-identical (this is the determinism gate for the flip). Poll, don't sleep.

## Acceptance

- [ ] Every historical Write/Edit/MultiEdit/NotebookEdit row whose payload (events.data OR event_blobs.data) yields a valid file_path has mutation_path set; backfill is paced, resumable via a crash-safe meta watermark
- [ ] ARM A reads the mutation_path column; ARM B (relocatedStmt) is deleted; the new partial index serves the attribution scan
- [ ] .1 differential re-fold harness is byte-identical AFTER the flip (full-corpus run)
- [ ] No multi-second GitSnapshot attribution folds (ARM B's rowid-join gone)
- [ ] `bun run test:full` green

## Done summary
Backfilled events.mutation_path over all historical mutation rows (paced, crash-safe-resumable, COALESCE both inline + relocated event_blobs bodies) and flipped the git-attribution scan onto the mutation_path column, deleting ARM B (the event_blobs rowid-join). The .1 differential re-fold harness stays byte-identical; full tier green.
## Evidence
