## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, keeper/api.py, test/schema-version.test.ts

### Approach

Add the `event_blobs(event_id INTEGER PRIMARY KEY REFERENCES events(id),
data TEXT NOT NULL)` side table as a CREATE literal AND a v56→v57 migration
block (extend the tail ALTER slot after the v55→v56 rewrite, before the
`meta` version stamp). Bump `SCHEMA_VERSION` to 57 and add 57 to
`keeper/api.py` SUPPORTED_SCHEMA_VERSIONS in the SAME change (whitelist-only
— keeper-py never reads events.data). Then rewrite EVERY reducer read of
`events.data` to resolve via `COALESCE(events.data, event_blobs.data)` —
the drain hot SELECT (reducer.ts:7684), the file-attribution scan
(1593-1607), the syncPlanctlLinks reads (5156/5222), and the cwd/planctl_files
scans (3954/4359/4822/5060). NO compaction in this task: `event_blobs`
stays empty, so every COALESCE returns the inline value and behavior +
re-fold are byte-identical to today. This is the safe, provably-lossless
foundation. Decide and document the `data TEXT NOT NULL` question — keep it
NOT NULL for now (nothing NULLs it yet; task .2 relaxes it when compaction
lands) OR relax it here behind the migration; prefer keeping the write-path
column constraint until .2 actually needs NULL.

### Investigation targets

**Required** (read before coding):
- src/db.ts:374-452 — CREATE_EVENTS, `data TEXT NOT NULL` at 389, idx_events_tool_attr at 452
- src/db.ts:5311-5396 — the v55→v56 tail migration slot + meta stamp (extend here); :2155-2206 v6→v7 backfill precedent; :1641-1760 migration helpers
- src/reducer.ts:7684-7698 — drain hot SELECT (primary LEFT-JOIN target)
- src/reducer.ts:1593-1607 — file-attribution json_extract scan; :5156/:5222 syncPlanctlLinks; :3954/:4359/:4822/:5060 cwd/planctl_files scans
- keeper/api.py:198-225 — SUPPORTED_SCHEMA_VERSIONS frozenset; test/schema-version.test.ts (regex asserts max >= SCHEMA_VERSION)

**Optional**:
- plugin/hooks/events-writer.ts:515 — confirm the hook write path is NOT touched here

### Risks

- Missing a single `events.data` read site = a silent lossy read once .2 starts NULLing. Grep exhaustively for `.data` reads / `FROM events` SELECTs that project `data` and json_extract(data,...).
- The expression index `idx_events_tool_attr` is defined on `events.data`; it stays valid in this task (nothing NULLed yet) but task .2 must handle it — note the seam, don't break it here.
- Re-fold must stay byte-identical with event_blobs empty — add a test that rewinds + re-drains and diffs projections.

### Test notes

schema-version.test.ts must pass (57 in the frozenset). Add/extend a re-fold
determinism test over a populated fixture DB (empty event_blobs) asserting
byte-identical projections. Confirm idx_events_tool_attr still EXPLAIN-uses
the index for the attribution query.

## Acceptance

- [ ] `event_blobs` table created via CREATE literal + v56→v57 migration; SCHEMA_VERSION=57; keeper/api.py frozenset has 57; schema-version.test.ts green
- [ ] All reducer `events.data` reads go through COALESCE(events.data, event_blobs.data)
- [ ] event_blobs empty → behavior + from-scratch re-fold byte-identical to pre-change
- [ ] idx_events_tool_attr still serves the file-attribution scan (EXPLAIN-verified); the .2 seam for it is documented, not broken
- [ ] Hook write path untouched (single inline INSERT)

## Done summary
Added event_blobs(event_id PK, data) side table (schema v57, CREATE literal + v56->v57 migration, empty in .1) and rewrote reducer blob VALUE reads (drain SELECT + both commit-trailer scans) to resolve via COALESCE(events.data, event_blobs.data). Kept events.data NOT NULL and left the file-attribution scan WHERE on events.data to preserve idx_events_tool_attr — documented as the .2 seam. keeper/api.py SUPPORTED_SCHEMA_VERSIONS gains 57. Re-fold determinism + EXPLAIN tests added; behavior is byte-identical to pre-v57 with event_blobs empty.
## Evidence
