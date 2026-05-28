## Description

**Size:** M
**Files:** `src/db.ts`, `src/collections.ts`, `test/db.test.ts`, `test/server-worker.test.ts`, `test/collections.test.ts`, `README.md`

### Approach

Single coherent migration + descriptor + tests + docs commit. Lands after fn-633 ships (hard epic dep wires this).

**Step 1 — Schema additions in `src/db.ts`:**

- Bump `SCHEMA_VERSION` from 31 to 32 at line 56.
- Add `default_visible INTEGER NOT NULL GENERATED ALWAYS AS (CASE WHEN status='open' OR approval!='approved' THEN 1 ELSE 0 END) VIRTUAL` to the `CREATE_EPICS` literal as the 17th column (after `queue_jump`). The CASE wrap is load-bearing: `status` is TEXT-nullable, and the bare OR can return NULL — violating NOT NULL.
- Write a NEW helper `addGeneratedColumnIfMissing(db, table, column, def)` parallel to existing `addColumnIfMissing` (lines 764-777). The only difference: use `PRAGMA table_xinfo(${table})` instead of `PRAGMA table_info(${table})`. Generated columns are invisible to `table_info`. Mirror the existing helper's JSDoc style and idempotence contract.
- Add a v31 → v32 migration block in `migrate()` that calls `addGeneratedColumnIfMissing(db, "epics", "default_visible", "INTEGER NOT NULL GENERATED ALWAYS AS (CASE WHEN status='open' OR approval!='approved' THEN 1 ELSE 0 END) VIRTUAL")`. No data backfill (VIRTUAL is computed on read). No `storedVersion < 32` gate needed for the ADD COLUMN itself — `addGeneratedColumnIfMissing` is idempotent.
- Add `CREATE INDEX IF NOT EXISTS idx_epics_default_visible ON epics(default_visible, sort_path, epic_id) WHERE default_visible = 1` to the existing `CREATE_EPICS_INDEXES` block at lines 419-432. The unconditional always-run pattern (set up by fn-628) handles fresh and migrated DBs uniformly.
- Update the fn-628 JSdoc forecast comment at lines 426-428 to reflect that the forecast is now realized — strike the "if future growth makes the filter dominant, a follow-up can materialize..." sentence and replace with prose naming the new partial index + linking to this epic.
- The unconditional `ANALYZE epics; ANALYZE jobs; ANALYZE events;` block at the BOTTOM of `migrate()` (lines 2742-2744 per fn-628) re-runs on every boot — no extra version-guarded ANALYZE needed.

**Step 2 — Descriptor update in `src/collections.ts`:**

- Replace `EPICS_DESCRIPTOR.defaultClause` at lines 271-274 from `{ sql: "(status = ? OR approval != ?)", params: ["open", "approved"] }` to `{ sql: "default_visible = 1", params: [] }`. Use the LITERAL `1` (not `default_visible = ?` with params=[1]) — avoids any partial-index matcher quirk around constant folding of bound parameters.
- Rewrite the descriptor comment block immediately above `defaultClause` — the existing rationale ("crosses two columns, so it lives in defaultClause rather than defaultFilter") is obsolete with single-column equality. Describe the new shape: a VIRTUAL generated column computed by SQLite, served by a partial index, eliminating the OR-predicate scan.
- Add `"default_visible"` to `EPICS_DESCRIPTOR.columns` array in column-order (after `queue_jump`). It rides on the wire as display-only; clients can see it but should not filter/sort by it (the column reflects implementation, not domain).
- Do NOT add `default_visible` to `sortable`, `filters`, or `jsonColumns`. It's a derived implementation detail.

**Step 3 — Reducer:** UNCHANGED. The `EpicSnapshot` fold INSERT at `src/reducer.ts:572-583` correctly lists 13 columns (without `default_visible`); SQLite computes the VIRTUAL column on every read. Attempting to write `default_visible` in any INSERT/UPDATE would throw "cannot INSERT into generated column" — schema-enforced safety. Pinned by a negative test (see Test notes).

**Step 4 — Tests** (see Test notes below for full list).

**Step 5 — README.md revisions** (in-place, not append):
- Schema narrative paragraph ~lines 574-586: add a v32 sentence naming `default_visible` (VIRTUAL generated column, expression, partial index). Match the per-version one-sentence pattern from sort_path/queue_jump.
- EPICS_DESCRIPTOR.defaultClause comment ~lines 262-274: rewrite — obsolete rationale removed.
- board.ts description ~line 356 and SQL example ~line 745: update prose to match new column shape; name `idx_epics_default_visible` in any query example that exercises it.

### Investigation targets

**Required** (read before coding):
- `src/db.ts:56` — `SCHEMA_VERSION` (currently 31 from fn-633; bump to 32)
- `src/db.ts:419-432` — `CREATE_EPICS_INDEXES` block (Tier 2 fn-628); new index lands here; JSDoc forecast at 426-428 must be updated
- `src/db.ts:505-524` — `CREATE_EPICS` table literal (16 columns; default_visible becomes 17th)
- `src/db.ts:764-777` — existing `addColumnIfMissing` (do NOT modify; mirror its shape in the new helper)
- `src/db.ts:830-848` — fn-633's `renameColumnIfPresent` helper (precedent for shape + idempotence docs of a new migration helper)
- `src/db.ts:881-889` — invariant comment ("schema convergence is shape-driven; PRAGMA-driven idempotent ALTERs run every boot")
- `src/db.ts:2719-2744` — Tier 2 always-run index + ANALYZE block at bottom of migrate()
- `src/db.ts:2746-2748` — SCHEMA_VERSION stamp pattern
- `src/collections.ts:192-286` — `EPICS_DESCRIPTOR` (columns at ~204, sortable at ~218, filters at ~245, defaultClause at 271-274, jsonColumns at 285)
- `src/collections.ts:271-274` — `defaultClause` to swap
- `src/reducer.ts:572-583` — `EpicSnapshot` fold INSERT (UNCHANGED; do NOT add default_visible to the column list)
- `test/db.test.ts:614-711` — synthesize-old-DB migration test pattern; update column expectations + version stamp expectation
- `test/db.test.ts:1042-1072` — fn-628 EQP regression for `idx_epics_sort_path`; rewrite to test the new default path + add a sibling test for the explicit-status path
- `test/db.test.ts:1287` — fn-628 task .2 semantic-equivalence precedent (UNION vs OR); mirror pattern for default_visible vs OR
- `test/server-worker.test.ts:398-433` — `resolveFilter` test pins the OR-form SQL literally; update to new shape
- `test/collections.test.ts:537-549` — pins `EPICS_DESCRIPTOR.defaultClause` literally; update
- `test/collections.test.ts:617-648` — 4-corner runQuery semantics test (should pass UNCHANGED — semantics preserved by construction; confirm no rewrite needed)
- `README.md` ~lines 262-274, 356, 574-586, 745 (per docs-gap-scout)
- CLAUDE.md "Migrations are forward-only" + "Schema defaults match the zero-event projection" + "DO NOT" — confirm Tier 4.1 respects all three

**Optional** (reference as needed):
- sqlite.org/gencol.html — generated column rules; PRAGMA table_info exclusion of generated columns; STORED/VIRTUAL distinction
- sqlite.org/lang_altertable.html — ADD COLUMN ... STORED is rejected; VIRTUAL is allowed
- sqlite.org/partialindex.html — partial index matching rules; syntactic match requirement
- `scripts/srv-ts-stats.ts` (dd89af8) — aggregator for post-task Evidence

### Risks

- **fn-633 hard dep:** SCHEMA_VERSION v31 is claimed by fn-633's uncommitted work. This epic must serialize after fn-633 closes. The `epic.depends_on_epics: [fn-633-git-per-session-file-attribution]` in the scaffold YAML wires this.
- **`PRAGMA table_xinfo` vs `table_info`:** the new `addGeneratedColumnIfMissing` helper MUST use `table_xinfo`. Using `table_info` would re-attempt ALTER on every boot after the first migration, throwing "duplicate column" — the daemon would fail to start on second boot. Boot-twice idempotence test pins this.
- **NULL-safe expression:** the CASE-wrap is load-bearing. `status` is TEXT-nullable per the schema (no NOT NULL constraint). The bare `(status='open' OR approval!='approved')` returns NULL when status IS NULL AND approval='approved' — violates NOT NULL at write/scan time. CASE always returns 0/1.
- **Literal `default_visible = 1` (not parameterized):** SQLite's partial-index matcher requires the query's WHERE term to imply the partial index's WHERE clause. Literal-1 matches literal-1 exactly. A parameterized `default_visible = ?` with `params=[1]` MIGHT work via constant folding but isn't guaranteed across SQLite versions. Literal is safer; the descriptor types support `params: []`.
- **Existing test pins on OR-form SQL:** `test/server-worker.test.ts:398-433` and `test/collections.test.ts:537-549` literally pin the OR clause. They WILL break with the descriptor switch — must be updated in-task.
- **EpicSnapshot fold's INSERT column list:** must NOT include `default_visible`. SQLite would throw "cannot INSERT into generated column". The current 13-column INSERT at `src/reducer.ts:572-583` is already correct (predates the new column). Don't accidentally add it during this task. Negative test pins this contract.
- **Both indexes coexist:** `idx_epics_sort_path` (Tier 2) still serves the explicit-status path. Both regressions get tested.
- **`scripts/board.ts:56` has a stale prose comment** (`AND` instead of `OR` in the default-filter description). Flagged but OUT OF SCOPE for this task — fix in a separate commit.

### Test notes

All tests in `test/db.test.ts` unless noted otherwise.

**Updated tests (existing):**
- `:1042-1072` EQP regression: REWRITE — assert `WHERE default_visible = 1 ORDER BY sort_path ASC, epic_id ASC` uses `idx_epics_default_visible` (SEARCH not SCAN; no TEMP B-TREE)
- `:614-711` synthesize-old-DB migration: bump expected version to "32"; switch to `PRAGMA table_xinfo` for the column-list check; add `default_visible` to the expected ordered column list
- `test/server-worker.test.ts:398-433` resolveFilter SQL pin: update expected clause to `"WHERE default_visible = 1"` with empty params
- `test/collections.test.ts:537-549` defaultClause literal pin: update to `{sql: "default_visible = 1", params: []}`
- `test/collections.test.ts:617-648` 4-corner runQuery semantics: verify passes UNCHANGED

**New tests (in test/db.test.ts):**
- **Presence:** query `sqlite_master`, assert `idx_epics_default_visible` exists; query `PRAGMA table_xinfo(epics)`, assert `default_visible` column present
- **EQP for explicit-status path (sibling to the rewritten one):** assert `WHERE status='done' ORDER BY sort_path ASC, epic_id ASC` STILL uses `idx_epics_sort_path` — fn-628 coverage preserved
- **Semantic equivalence:** for a seeded fixture with cross-product of (status, approval) values, assert `SELECT epic_id FROM epics WHERE default_visible = 1 ORDER BY epic_id` returns the SAME ordered set as `SELECT epic_id FROM epics WHERE (status='open' OR approval!='approved') ORDER BY epic_id` — mirrors fn-628.2's UNION-vs-OR pattern at `:1287`
- **Generated-column semantics (6 corners):** insert epics with (status, approval) values: (open, approved) → default_visible=1; (open, pending) → 1; (closed, approved) → 0; (closed, pending) → 1; (NULL, approved) → 0; (NULL, pending) → 1. The CASE-wrap guarantees never-NULL output.
- **Migration backfill:** synthesize a v31-shape DB (manually create epics table with 16 columns including queue_jump but NO default_visible), insert a few rows, set `meta.schema_version='31'`, then call `openDb()` → migrate() → assert (a) version stamp = "32", (b) `default_visible` column exists per `PRAGMA table_xinfo`, (c) the pre-existing rows now report correct `default_visible` values per their (status, approval) per the 6-corners semantics.
- **Boot-twice idempotence:** call `migrate()` twice on the same already-migrated DB; assert no exception thrown. Specifically pins that `addGeneratedColumnIfMissing` no-ops on second call (would throw "duplicate column" with `table_info` instead of `table_xinfo`).
- **Write-protection (negative test):** attempt `INSERT INTO epics(epic_id, default_visible, ...) VALUES(...)`; assert SQLite throws "cannot INSERT into generated column" or equivalent. Pins the schema-enforced safety.

**EVIDENCE capture (post-merge, manual):**
- Restart daemon: `launchctl bootout gui/$UID/arthack.keeperd && launchctl bootstrap gui/$UID ~/Library/LaunchAgents/arthack.keeperd.plist` (KEEPER_TRACE_SERVER=1 already live from ec6e936)
- Soak 3 minutes under board + autopilot + git + usage load (same conditions as Tier 4 BEFORE measurement)
- Run `bun scripts/srv-ts-stats.ts`; paste AFTER numbers in `## Evidence`
- Capture EQP before/after plan strings via `sqlite3 ~/.local/state/keeper/keeper.db "EXPLAIN QUERY PLAN ..."`; paste verbatim

Expected outcomes (informational, not strict acceptance):
- `diffTick / metaCount p95` drops from 3105 ms baseline to sub-100 ms (>30× improvement)
- `runQuery|epics|countAndToken max` drops from 2723 ms baseline correspondingly
- EQP for `WHERE default_visible = 1 ORDER BY sort_path, epic_id` shows `SEARCH epics USING (COVERING )?INDEX idx_epics_default_visible`
- EQP for `WHERE status='done' ORDER BY sort_path, epic_id` still shows `SCAN epics USING INDEX idx_epics_sort_path` (or equivalent)

## Acceptance

- [ ] `SCHEMA_VERSION` bumped 31 → 32
- [ ] `CREATE_EPICS` literal includes `default_visible` as 17th column with the CASE-wrapped VIRTUAL expression
- [ ] New `addGeneratedColumnIfMissing(db, table, column, def)` helper added using `PRAGMA table_xinfo`; existing `addColumnIfMissing` UNCHANGED
- [ ] v31 → v32 migration step calls `addGeneratedColumnIfMissing` for `default_visible`
- [ ] `idx_epics_default_visible ON epics(default_visible, sort_path, epic_id) WHERE default_visible = 1` lands in `CREATE_EPICS_INDEXES` block at db.ts:419-432
- [ ] fn-628 JSdoc forecast at db.ts:426-428 rewritten to reflect the shipped Tier 4.1 work
- [ ] `EPICS_DESCRIPTOR.defaultClause` swapped to `{sql: "default_visible = 1", params: []}` (literal 1, not parameterized)
- [ ] `EPICS_DESCRIPTOR.columns` adds `"default_visible"` in column-order
- [ ] `default_visible` NOT added to `sortable`, `filters`, or `jsonColumns`
- [ ] Descriptor comment block above `defaultClause` rewritten — obsolete OR-rationale removed
- [ ] EpicSnapshot fold INSERT at `src/reducer.ts:572-583` UNCHANGED (does NOT include default_visible)
- [ ] Updated tests pass: `test/db.test.ts` migration column-list expectation, `test/db.test.ts:1042-1072` EQP regression (rewritten for new path), `test/server-worker.test.ts:398-433` resolveFilter SQL pin, `test/collections.test.ts:537-549` defaultClause literal pin
- [ ] New tests pass: presence, explicit-status EQP, semantic equivalence, 6-corner semantics, migration backfill, boot-twice idempotence, write-protection negative test
- [ ] README.md schema narrative ~574-586 extended; defaultClause comment ~262-274 rewritten; board.ts description + SQL example ~356, ~745 updated
- [ ] EVIDENCE: post-merge p50/p95/p99 from `bun scripts/srv-ts-stats.ts`; EQP before/after plan strings; expected `metaCount p95` drop >10× from 3105 ms baseline
- [ ] `bun test` green

## Done summary

## Evidence
