## Description

**Size:** S
**Files:** `src/db.ts`, `test/db.test.ts`, `README.md`

### Approach

Add two new always-run, table-scoped index blocks in `src/db.ts` following the `CREATE_SUBAGENT_INVOCATIONS_INDEXES` precedent at line 413:

```ts
const CREATE_EPICS_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_epics_sort_path ON epics(sort_path, epic_id)",
];
const CREATE_JOBS_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_jobs_created_state ON jobs(created_at DESC, job_id, state)",
];
```

**The jobs index shape is the corrected one** — `(created_at DESC, job_id, state)`, NOT the originally-spec'd `(state, created_at DESC, job_id)`. Practice-scout verified via EQP against bun:sqlite that the `state`-leading shape produces `SCAN jobs / USE TEMP B-TREE FOR ORDER BY` (the planner cannot use a `NOT IN`-predicated column as an index entry — negation can't be translated to a usable index range). With `created_at DESC` leading + `state` trailing: `SCAN jobs USING COVERING INDEX idx_jobs_created_state` — sort eliminated, no row-lookup heap fetch.

In `migrate()` (`src/db.ts:623+`), add the new loops alongside the existing `CREATE_EVENTS_INDEXES` and `CREATE_SUBAGENT_INVOCATIONS_INDEXES` loops:

```ts
for (const sql of CREATE_EPICS_INDEXES) {
  db.run(sql);
}
for (const sql of CREATE_JOBS_INDEXES) {
  db.run(sql);
}
```

Then add `db.run("ANALYZE epics"); db.run("ANALYZE jobs");` immediately after — Task B will add `ANALYZE events` for the planctl block. ANALYZE runs unconditionally on every `migrate()` so stats refresh on every daemon boot; the cost on these small tables is negligible (epics ~682 rows, jobs ~1010 rows).

Append both new index names to the index-name allowlist at `test/db.test.ts:83-89` (Task B will append two more, so coordinate via the hard `deps: [1]` ordering).

Add tests per the established two-test-per-index pattern at `test/db.test.ts:981-1025` (`idx_jobs_plan_ref` precedent):

1. **Presence test:** open a fresh `openDb(dbPath)`, query `sqlite_master WHERE type='index' AND name=?` for each new name, assert one row.
2. **EQP regression test:** seed ~50 dummy rows + `ANALYZE` + `EXPLAIN QUERY PLAN <consumer query>` + assert a contains-match regex on the index name. For the jobs query, assert `SCAN jobs USING COVERING INDEX idx_jobs_created_state` (the COVERING is load-bearing — confirms trailing `state` made the index covering for the `NOT IN` filter). For the epics query, assert `SCAN epics USING INDEX idx_epics_sort_path` (NOT covering — `status`/`approval` aren't in the index; the WHERE applies as filter during the in-order scan).

Use contains-match regex (e.g. `/SCAN epics USING (COVERING )?INDEX idx_epics_sort_path/`) — robust to Bun/SQLite minor-version output drift.

Update `README.md` example queries near line ~690-720 to add inline comments naming `idx_epics_sort_path` on the epics `ORDER BY sort_path` examples, matching the existing inline-comment pattern (`# <desc> — uses the partial <idx_name> index`).

### Investigation targets

**Required** (read before coding):
- `src/db.ts:413-415` — `CREATE_SUBAGENT_INVOCATIONS_INDEXES`, the table-scoped always-run block precedent
- `src/db.ts:329, 351, 371` — `CREATE_V10_INDEXES`/`CREATE_V14_INDEXES`/`CREATE_V17_INDEXES`, version-gated alternative pattern (NOT used here — these are always-run because the indexed columns all exist at v30)
- `src/db.ts:349` — existing `ANALYZE` precedent inside the v14 block
- `src/db.ts:623+` — `migrate()` body and the for-loop pattern for running index blocks
- `src/collections.ts:240` — `EPICS_DESCRIPTOR.defaultSort = { column: "sort_path", dir: "asc" }`
- `src/collections.ts:262-265` — `EPICS_DESCRIPTOR.defaultClause = "(status = ? OR approval != ?)"`
- `src/collections.ts:120, 130` — `JOBS_DESCRIPTOR.defaultSort = { created_at desc }`, `defaultFilter = { state: not_in ["ended", "killed"] }`
- `src/server-worker.ts:475-545` — `runQuery()` builds the SELECT; this is the consumer path
- `test/db.test.ts:83-89` — index-name allowlist to append
- `test/db.test.ts:981-1025` — the `idx_jobs_plan_ref` EQP regression test, the pattern to mirror
- `README.md` lines ~690-720 — existing query examples + inline `# … uses the partial … index` comments to mirror

**Optional** (reference as needed):
- CLAUDE.md "Migrations are forward-only" + "Schema defaults match the zero-event projection" invariants — confirms `CREATE INDEX IF NOT EXISTS` requires no version bump
- SQLite partial-index docs §3 Rule 2 (for context; F7 uses partial indexes, this task does not)

### Risks

- **Jobs index shape is the new-spec one, not the original.** Wrong shape ships → index lands but planner never picks it → EQP test fails on landing. Mitigated by the explicit Acceptance criterion and the EQP regression test asserting `USING COVERING INDEX`.
- **OR-predicate on epics still applies as filter during the in-order index scan.** EQP shows `SCAN epics USING INDEX idx_epics_sort_path` — temp B-tree gone, but still a full index scan because the WHERE columns aren't in the index. Acceptable at 682 rows. If future epic counts grow significantly and the OR-predicate filter becomes the bottleneck, a follow-up can materialize `default_visible` as a derived integer column — DO NOT preemptively add it.
- **ANALYZE cost on epics + jobs is negligible** (sub-ms on tables under 1.1k rows). Task B's `ANALYZE events` is the larger one (~100ms on 110k rows) but still bounded and rare (daemon boots only).
- **Test/db.test.ts:83-89 allowlist coordination with Task B.** Hard `deps: [1]` ordering on Task B avoids the merge surface — Task A's two names land first, Task B's two names land after.

### Test notes

Per-index tests follow the `idx_jobs_plan_ref` precedent. Seed-row count must be ≥50 and `ANALYZE` must run on the test DB before EXPLAIN — without enough rows/stats, the planner picks a scan even when the index exists.

For `idx_jobs_created_state`, seed jobs with a mix of `state` values (some `ended`/`killed`, most other states) + varying `created_at` timestamps; assert `SCAN jobs USING COVERING INDEX idx_jobs_created_state`.

For `idx_epics_sort_path`, seed epics with a mix of `(status, approval, sort_path)` rows; assert `SCAN epics USING INDEX idx_epics_sort_path` and explicit absence of `USE TEMP B-TREE` (regex: `!/USE TEMP B-TREE/`).

## Acceptance

- [ ] `CREATE_EPICS_INDEXES` and `CREATE_JOBS_INDEXES` new always-run table-scoped const arrays in `src/db.ts` (following `CREATE_SUBAGENT_INVOCATIONS_INDEXES` precedent at line 413)
- [ ] `idx_epics_sort_path ON epics(sort_path, epic_id)` and `idx_jobs_created_state ON jobs(created_at DESC, job_id, state)` (note: `created_at DESC` LEADING, `state` TRAILING — corrected shape per practice-scout EQP)
- [ ] `migrate()` runs both new blocks in for-loops alongside existing `CREATE_EVENTS_INDEXES` / `CREATE_SUBAGENT_INVOCATIONS_INDEXES`
- [ ] `db.run("ANALYZE epics"); db.run("ANALYZE jobs");` run unconditionally after the new blocks
- [ ] `test/db.test.ts:83-89` index-name allowlist includes `idx_epics_sort_path` and `idx_jobs_created_state`
- [ ] Presence test (sqlite_master query) + EQP regression test (seed + ANALYZE + EXPLAIN + contains-match assertion) added for each index
- [ ] EQP for jobs query asserts `SCAN jobs USING COVERING INDEX idx_jobs_created_state` (COVERING is load-bearing)
- [ ] EQP for epics query asserts `SCAN epics USING INDEX idx_epics_sort_path` AND absence of `USE TEMP B-TREE`
- [ ] Before/after EQP plan strings captured in Evidence
- [ ] `README.md` example queries gain inline `# … uses the … index` comments naming `idx_epics_sort_path`
- [ ] SCHEMA_VERSION unchanged at 30
- [ ] `bun test` green

## Done summary

## Evidence
