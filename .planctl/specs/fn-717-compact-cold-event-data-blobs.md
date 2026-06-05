## Overview

`keeper.db` has grown to ~1.6 GB; the `events` table is dominated by ~1 GB
of `PostToolUse` `data` blobs (~12 KB each, tens of thousands of rows) that
are cold the moment their file attribution discharges, yet stay inline in the
hot, heavily-indexed `events` table forever — bloating every B-tree scan the
drain does and degrading fold cache behavior. This epic relocates COLD `data`
blobs into a companion `event_blobs(event_id, data)` side table and NULLs the
hot column, so the `events` table stays lean while the blob is still
losslessly recoverable via `COALESCE(events.data, event_blobs.data)`.

**Design constraint that shapes everything (the hook contract).** The hook is
the SOLE writer of hook events, opens `{ migrate: false }`, writes each event
as a SINGLE `INSERT INTO events`, must always exit 0, and dead-letters on
failure (`plugin/hooks/events-writer.ts`). So `data` CANNOT be split off at
write time — a second INSERT into a side table would break the
single-statement, always-exit-0 contract. Therefore new events keep writing
`data` inline on `events` (hook untouched), and a daemon-side COMPACTION pass
relocates cold blobs out after the fact. All reads go through
`COALESCE(events.data, event_blobs.data)`. The fold already tolerates null
`data` (every extractor short-circuits on null/empty), so a relocated blob
folds identically whether read inline or via the join — re-fold determinism
holds because the blob's VALUE is preserved, only its location moves.

Scope: the schema + read plumbing (task .1) and the compaction relocator
(task .2). Full event-log PRUNING (deleting old events entirely) plus
projection-snapshot + boot-from-snapshot is explicitly OUT of scope here — a
larger, separate future epic; this epic only relocates blobs, it never
deletes an `events` row.

## Quick commands

- `bun test test/schema-version.test.ts test/daemon.test.ts test/integration.test.ts`
- Re-fold determinism: rewind cursor + re-drain over a populated DB, assert byte-identical projections before/after compaction
- `du -h ~/.local/state/keeper/keeper.db` before/after a compaction run + `wal_checkpoint(PASSIVE)` / VACUUM

## Acceptance

- [ ] `event_blobs(event_id INTEGER PRIMARY KEY REFERENCES events(id), data)` exists; v56→v57 migration adds it; `keeper/api.py` SUPPORTED_SCHEMA_VERSIONS gains 57 in the SAME change (schema-version.test.ts passes)
- [ ] The hook is UNCHANGED — still a single `INSERT INTO events` with `data` inline; new events are never split at write time
- [ ] Every reducer read of `events.data` (drain SELECT + json_extract scans + cwd/planctl_files scans) resolves the blob via `COALESCE(events.data, event_blobs.data)` and is lossless
- [ ] The `idx_events_tool_attr` expression index (on `events.data`) still serves the file-attribution scan correctly for every event whose attribution can still be live (see task .2 — recent/undischarged events stay inline)
- [ ] A from-scratch re-fold reproduces byte-identical projections whether a blob lives inline or in `event_blobs`
- [ ] After a compaction run, the `events` table is measurably smaller and DB space is reclaimed; no `events` row is ever deleted
- [ ] A missing blob (neither inline nor in side table — a bug, not legitimate compaction) folds to the same safe value as a malformed blob and the cursor still advances (never throws in-fold)

## Early proof point

Task that proves the approach: `.1` (schema + COALESCE read plumbing, NO
compaction yet). With `event_blobs` empty, every read is `COALESCE(data,
NULL) = data` and behavior + re-fold must be byte-identical to today. If that
foundation isn't provably lossless and re-fold-stable, stop before writing the
compaction relocator.

## References

- `plugin/hooks/events-writer.ts:515` — hook KNOWN_COLUMNS includes `data`; sole-writer single-INSERT must-exit-0 contract (the reason this is read-side compaction, not a write-time split)
- `src/db.ts:61` SCHEMA_VERSION=56→57; `:389` `data TEXT NOT NULL` (relax/keep-inline decision); `:452` idx_events_tool_attr expression index on events.data; `:2155-2206` v6→v7 collapse precedent; `:5311-5394` v55→v56 tail slot (extend after, before meta stamp at 5396); migration helpers `:1641`/`:1689`/`:1711`/`:1760`
- `src/reducer.ts:7684-7698` drain hot SELECT (eager `data` read — LEFT-JOIN target); `:1593-1607` file-attribution json_extract scan; `:5156`/`:5222` syncPlanctlLinks data reads; `:3954`/`:4359`/`:4822`/`:5060` cwd/planctl_files data scans; many guarded JSON.parse sites already null-tolerant
- `keeper/api.py:198-225` SUPPORTED_SCHEMA_VERSIONS frozenset (keeper-py does NOT read events.data — whitelist-only bump)
- CLAUDE.md: re-fold determinism sacred; malformed `data` folds safe + cursor advances; migrations forward-only + keeper-py mirror

## Best practices

- **Split cold blobs to a companion table, never delete facts:** the side table keeps the blob recoverable; the event log stays canonical.
- **PASSIVE checkpoint / careful VACUUM to reclaim, never TRUNCATE in the hot path:** TRUNCATE waits on writers and starves a contending hook.
- **Distinguish legitimately-compacted from unexpectedly-absent:** a relocated blob is in `event_blobs`; a blob in NEITHER place is a bug — fold safe but make it observable, don't silently treat data loss as compaction.

## Architecture

Write path (unchanged): hook → `INSERT INTO events(... data ...)` inline.
Read path: reducer reads `COALESCE(events.data, event_blobs.data)`.
Compaction (task .2, daemon-side, paced): for cold/discharged events older
than a watermark, `INSERT INTO event_blobs SELECT id, data ...` then `UPDATE
events SET data = NULL` — atomic per batch, blob value preserved, row kept.

## Snippet context

No bundle/snippets attached: keeper has no promptctl snippet corpus for the
schema/reducer internals this touches; the file:line refs are the durable
context.
