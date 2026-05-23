## Description

**Size:** M
**Files:** src/db.ts, src/collections.ts, src/types.ts, test/db.test.ts, test/collections.test.ts

### Approach

Add the `approvals` sidecar table at schema v11 and register it as the
third read-only collection. This task is independent of the RPC layer
(Task .1) — the table can be created and read-served before any write
path exists; humans can hand-INSERT rows for testing.

Four moves:
1. In `src/db.ts`: add `CREATE_APPROVALS = "CREATE TABLE IF NOT EXISTS
   approvals (approval_id TEXT PRIMARY KEY, epic_id TEXT NOT NULL,
   task_key TEXT NOT NULL, status TEXT CHECK(status IN ('approved',
   'rejected')) NOT NULL, updated_at REAL NOT NULL, UNIQUE(epic_id,
   task_key))"`. Run it in `migrate()` (CREATE TABLE IF NOT EXISTS is
   idempotent — no version-guarded backfill needed). Bump `SCHEMA_VERSION`
   from 10 to 11. Add a v10→v11 comment block in `migrate()` matching the
   existing per-version comments (the empty table on bootstrap matches the
   zero-event projection; humans seed it via the future `set_approval`
   RPC).
2. In `src/types.ts`: add `Approval` interface — `{ approval_id: string;
   epic_id: string; task_key: string; status: "approved" | "rejected";
   updated_at: number }`.
3. In `src/collections.ts`: add `APPROVALS_DESCRIPTOR` mirroring the
   `EPICS_DESCRIPTOR` template. `pk: "approval_id"`; `version: "updated_at"`
   (a REAL via `unixepoch('now','subsec')` written by the future
   `set_approval` RPC); `columns` include all five fields;
   `sortable: ["updated_at", "approval_id"]`; `defaultSort: { column:
   "updated_at", dir: "desc" }`; `filters: { approval_id: "approval_id",
   epic_id: "epic_id", status: "status" }`; NO `defaultFilter` (autopilot
   subscribes to all rows); NO `jsonColumns` (no embedded arrays). Register
   in `REGISTRY` as the third entry.
4. Tests: v10→v11 schema-bump in `test/db.test.ts` (assert schema_version
   stamps as 11; approvals table exists with the right PRAGMA table_info
   shape; CHECK constraint rejects bad status via direct INSERT;
   UNIQUE(epic_id, task_key) rejects duplicates; idempotent on re-open).
   Descriptor roundtrip in `test/collections.test.ts`: hand-INSERT a row,
   `runQuery` against `approvals`, assert `result.rows` carries the row
   with expected shape; filter by `epic_id` and by `status`; verify
   `countAndToken` is stable across re-query.

The `approval_id` column is a real bare-name pk populated by the writer as
`epic_id || ':' || task_key` (in Task .3). Keeping it a bare-name column
(not a compound expression in `descriptor.pk`) honors the
`src/collections.ts:18-22` injection invariant — only trusted constants
are interpolated into SQL — and avoids the `WHERE epic_id || ':' ||
task_key IN (?,?,?)` pessimization the gap analysis flagged.

### Investigation targets

**Required** (read before coding):
- src/db.ts:34 — `SCHEMA_VERSION` constant; bump to 11
- src/db.ts:286-298 — `CREATE_EPICS` is the closest template for `CREATE_APPROVALS` (CREATE TABLE IF NOT EXISTS, single-table simple schema)
- src/db.ts:412-705 — `migrate()`; the v10→v11 block lands after the v9→v10 block (around line 695-700 by the time this task lands)
- src/db.ts:564-583 — the "CREATE_* literal + addColumnIfMissing lockstep" convention; for a fresh table this means the literal alone (no ALTER) — but mirror the per-version comment style
- src/collections.ts:147-187 — `EPICS_DESCRIPTOR`; the literal template for `APPROVALS_DESCRIPTOR`
- src/collections.ts:194-197 — `REGISTRY` Map; one new entry
- src/collections.ts:18-22 — the injection invariant (`descriptor.pk` is interpolated as a bare identifier; a compound expression would NOT survive this)
- src/types.ts — wherever `Epic` / `Task` are exported; `Approval` lives alongside
- test/db.test.ts:877-1116 — the v8→v9 or v9→v10 schema-bump test is the closest template for v10→v11
- test/collections.test.ts — existing descriptor roundtrip patterns

**Optional** (reference as needed):
- src/collections.ts:214-240 — `selectByIds` interpolates `${descriptor.pk}`; confirms a bare-name pk is what the rest of the code expects
- src/collections.ts:315-334 — `countAndToken` ORDER BY `${descriptor.pk}`; same constraint

### Risks

- **fn-578 also bumps `SCHEMA_VERSION` to 10.** Phase 7 auto-wires this epic as depending on fn-578; this task lands at v11 strictly AFTER fn-578 lands at v10. If fn-578 has not landed when this task starts, surface in Done summary and wait — do NOT branch the version number.
- **Real-column pk vs compound expression.** The sketch originally proposed `epic_id || ':' || task_key` as `descriptor.pk`; the gap analysis flagged this as breaking the injection invariant. This task adopts the real-column path (`approval_id`) and the writer in Task .3 populates it as the compound string.
- **`updated_at` resolution.** Two UPSERTs in the same microsecond would tie on `version`, blocking the diff's `version > lastSent` test. `unixepoch('now','subsec')` from SQLite has sub-microsecond resolution (per the SQLite docs), so this is vanishingly unlikely in practice; document the constraint in `APPROVALS_DESCRIPTOR`'s doc-comment.

### Test notes

- Schema v10→v11 bump (mirror the existing template at `test/db.test.ts:877-1116`):
  - Build v10 shape (no approvals table); `INSERT INTO meta (key, value) VALUES ('schema_version', '10')`; close
  - `openDb()` again; assert `meta.schema_version == '11'`; assert `PRAGMA table_info(approvals)` lists the five columns with correct types and NOT-NULL flags; assert CHECK and UNIQUE are present via `sqlite_master.sql`
  - Close and re-open a SECOND time; assert no error, no version downgrade (idempotent)
- CHECK constraint: `INSERT INTO approvals (approval_id, epic_id, task_key, status, updated_at) VALUES ('a:b', 'a', 'b', 'invalid', 0)` throws
- UNIQUE: two INSERTs with the same `(epic_id, task_key)` but different `approval_id` throws on the second
- Descriptor roundtrip in `test/collections.test.ts`:
  - Hand-INSERT two rows via direct SQL
  - `runQuery(db, 0, { type: "query", collection: "approvals" })` returns both rows in `result.rows`, sorted by `updated_at desc`
  - Filter by `epic_id` and by `status` produces the expected subsets
  - `countAndToken` against the same query is stable across two calls

## Acceptance

- [ ] `src/db.ts` has `CREATE_APPROVALS`, `SCHEMA_VERSION = 11`, and a v10→v11 comment block in `migrate()`
- [ ] The `approvals` table is created on fresh DB and on migration from v10; PRAGMA table_info reflects the exact column shape (approval_id PK, epic_id NOT NULL, task_key NOT NULL, status CHECK, updated_at NOT NULL, UNIQUE)
- [ ] `src/types.ts` exports `Approval` interface
- [ ] `src/collections.ts` exports `APPROVALS_DESCRIPTOR` and adds it to `REGISTRY` as the third entry; `pk` is `approval_id` (a bare column name)
- [ ] `test/db.test.ts` has a v10→v11 schema-bump test mirroring the v8→v9 / v9→v10 template; passes on first open + idempotent on second open
- [ ] `test/collections.test.ts` has at least one roundtrip test for `APPROVALS_DESCRIPTOR` (insert via SQL → `runQuery` → result shape verified; filter + sort verified)
- [ ] `bun test` passes with no regressions

## Done summary
Added the approvals sidecar table at schema v12 (CHECK enum on status + UNIQUE(epic_id, task_key)) and registered APPROVALS_DESCRIPTOR as the third read-only collection. Bumped SCHEMA_VERSION to 12 since fn-578 took v11; the v11→v12 step is a non-rewind sidecar ADD so pre-existing projection rows survive intact.
## Evidence
