## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, src/plan-worker.ts, src/rpc-handlers.ts, src/collections.ts, src/board-render.ts, src/types.ts, src/daemon.ts, keeper/api.py, scripts/approve.ts (delete), test/db.test.ts, test/schema-version.test.ts, test/reducer.test.ts, test/collections.test.ts, test/board.test.ts, test/rpc-handlers.test.ts, test/protocol.test.ts, test/plan-worker.test.ts

### Approach

With the gates already collapsed in `.1`, remove the now-dead approval
data surface. This is the schema-migration keystone — isolated here so the
virtual-column surgery and re-fold-determinism risk are contained.

### Detailed phases

1. **Schema v63 migration (`src/db.ts`).** Bump `SCHEMA_VERSION` 62→63
   (:61). Add a version-guarded step that, in ONE `BEGIN IMMEDIATE`,
   follows the v55→v56 playbook (db.ts:5682-5766) IN REVERSE: drop
   `idx_epics_default_visible` → drop the `default_visible` VIRTUAL column
   (guard on `PRAGMA table_xinfo`, NOT `table_info`) → re-add via
   `addGeneratedColumnIfMissing` with the new expression `CASE WHEN status
   IS NOT NULL AND status='open' THEN 1 ELSE 0 END` → recreate the partial
   index → `dropColumnIfPresent(db,'epics','approval')` (:1995) → `PRAGMA
   quick_check`. Update the `CREATE_EPICS` literal (:819, :831) so a
   fresh-from-empty DB byte-matches the migrated shape (no `approval`
   column; new `default_visible` expr). The v12→v13 approval backfill
   becomes dead but is left in place (forward-only history).
2. **keeper/api.py.** Add `63` to `SUPPORTED_SCHEMA_VERSIONS` (:232-267)
   plus the matching doc-comment line — SAME COMMIT (test/schema-version
   enforces `max(frozenset) >= SCHEMA_VERSION`). No reader logic touches
   `approval`, so nothing else changes Python-side.
3. **reducer.ts.** Remove `approval` from `CREATE_EPICS`-fed EpicSnapshot
   fold + UPSERT (`approval = excluded.approval`, ~:833-857), the
   embedded-task element (~:1008-1045), and the `snapshot.approval ??
   "pending"` default. Remove `approval` from every epic-deps SELECT
   (~:6359-6799). Confirm NO surviving fold SELECTs the dropped column (a
   stale read throws → wedges the reducer) and any approval-bearing
   synthetic-event handler degrades to a tolerated no-op, never deleted.
4. **plan-worker.ts.** Delete `taskApprovalCache`/`epicApprovalCache`,
   `primeTaskApproval`/`primeEpicApproval`, the sidecar approval read,
   `coerceApproval`, and the sidecar→def→pending ladder (~:169, :224,
   :499-501, :899-928, :1235-1252, :1618-1632). KEEP the
   `worker_done_at → worker_phase` derivation (:2140) intact.
5. **rpc-handlers.ts.** Delete `setTaskApprovalHandler`/
   `setEpicApprovalHandler`, their validation, `rewriteSidecarApproval`/
   `sidecarPathFromDef`, and the `registerRpc` lines (~:13-302, :805-806).
   Delete `scripts/approve.ts`. Drop the `clear-rejected-approval` handler
   in `daemon.ts` (~:3229-3478).
6. **collections.ts / board-render.ts / types.ts.** Remove the `approval`
   column/filter and the `default_visible`-driven approval predicate from
   collections (~:235, :281-285, :316-322); delete the `[approval]` board
   pill (board-render.ts:295-449); drop `Epic.approval`/`Task.approval`
   from types.ts (~:1049-1058, :1319-1324).

### Investigation targets

**Required** (read before coding):
- src/db.ts:61, :819, :831, :1995 (dropColumnIfPresent), :5682-5766 (v55→v56 virtual-col playbook) — the migration template
- keeper/api.py:232-267 — SUPPORTED_SCHEMA_VERSIONS frozenset
- src/reducer.ts:833-857, :1008-1045, :6359-6799 — approval fold/UPSERT/SELECTs
- test/db.test.ts:410-457 — column-shape parity test template for the v63 assertion

**Optional** (reference as needed):
- src/plan-worker.ts:169, :499-501, :899-928, :1618-1632 — caches + ladder
- src/rpc-handlers.ts:13-302, :805-806 — handlers + registration
- src/daemon.ts:3229-3478 — clear-rejected-approval handler

### Risks

- **Re-fold determinism**: the new `default_visible` expression and dropped column must match the zero-event `CREATE_EPICS` shape exactly, or a from-empty re-fold diverges. Add a v63 parity test (fresh vs migrated `table_xinfo(epics)`).
- **Fold throw on dropped column**: any missed SELECT of `approval` inside a fold throws and wedges the reducer. Audit exhaustively (grep `approval` in reducer.ts + epic-deps.ts).
- Must land AFTER `.1` is deployed (dep encoded) — otherwise readiness reads a dropped column.

### Test notes

Add a v63 test asserting `epics` has no `approval` column and `table_xinfo` shows the rewritten `default_visible` expr (mirror db.test.ts:410-457). Delete the entire `set_task_approval`/`set_epic_approval` suite (rpc-handlers.test.ts:145-361) and the protocol.test.ts approval cases. Reshape reducer/collections/board fixtures that asserted `approval: "pending"` defaults.

## Acceptance

- [ ] `SCHEMA_VERSION === 63`; `63 ∈ SUPPORTED_SCHEMA_VERSIONS`; `test/schema-version.test.ts` green.
- [ ] Post-migrate `PRAGMA table_info(epics)` has no `approval`; `default_visible` = `CASE WHEN status IS NOT NULL AND status='open' THEN 1 ELSE 0 END`; `PRAGMA quick_check` clean.
- [ ] Fresh-from-empty `epics` shape byte-matches the migrated shape (v63 parity test).
- [ ] No `approval` symbol remains in src/ outside historical migration code; `set_{task,epic}_approval` RPCs unregistered; `scripts/approve.ts` deleted.
- [ ] `bun test` fully green; a manual re-fold from empty reproduces identical `epics` rows.

## Done summary
Dropped the keeper approval data surface: schema v63 migration drops epics.approval and rewrites default_visible to status-only; removed approval from the reducer fold/UPSERT/epic-deps SELECTs, plan-worker caches/ladder/coerceApproval, the set_{task,epic}_approval RPC handlers + scripts/approve.ts, the collections filter/column, board pills, and types. v12->v13 ADD COLUMN is now <63-version-guarded so a post-v63 boot never resurrects the column. Full bun suite green; from-empty re-fold reproduces identical epics rows.
## Evidence
