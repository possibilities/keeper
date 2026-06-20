## Overview

Tier 4.1 of the keeper contention review fix plan. Materialize a VIRTUAL generated column `default_visible` on the `epics` table to kill the OR-predicate scan that drives the diffTick `metaCount` tail. Live Tier 4 measurement after fn-622/fn-628/fn-631/fn-632 all shipped: `diffTick / metaCount p95 = 3105 ms` and `runQuery|epics|countAndToken max = 2723 ms` — typical countAndToken is sub-2ms but the tail goes to 2.7 s. The cause: `EPICS_DESCRIPTOR.defaultClause` is `(status = ? OR approval != ?)` with params `['open', 'approved']`, and SQLite can't satisfy that OR across two columns from any single-column index — countAndToken falls back to a SCAN of the full epics set ordered by pk. Tier 2's `idx_epics_sort_path` doesn't help (keyed on sort_path, not the WHERE columns).

Fix: materialize the OR result as a VIRTUAL generated column + a partial index keyed on `default_visible = 1`. The descriptor's defaultClause becomes single-column equality, which SQLite serves via the new partial index in a single SEARCH — no SCAN, no temp B-tree. Zero reducer changes (VIRTUAL means SQLite computes on read).

Three critical corrections from scouting (vs the original sketch):
1. **SCHEMA_VERSION 31 → 32**, NOT 30 → 31. fn-633 already claims v31 with uncommitted in-tree work; this epic serializes after fn-633 (hard dep). The `epic.depends_on_epics` field in this YAML wires it.
2. **VIRTUAL, not STORED.** SQLite hard constraint: `ALTER TABLE ADD COLUMN ... STORED` throws — only VIRTUAL is supported. At 682 rows the expression cost is trivial; the index does the work.
3. **NULL-safe expression via CASE.** `status` is TEXT-nullable (no NOT NULL constraint); the bare `(status='open' OR approval!='approved')` returns NULL when status IS NULL AND approval='approved', violating the NOT NULL constraint at write/scan time. Wrap with `CASE WHEN ... THEN 1 ELSE 0 END` — always returns 0/1, never NULL.

Plus a new migration helper (`addGeneratedColumnIfMissing` using `PRAGMA table_xinfo`) because `PRAGMA table_info` doesn't see generated columns — the existing `addColumnIfMissing` would re-attempt the ALTER every boot and throw "duplicate column" after the first run.

## Quick commands

- `bun test test/db.test.ts test/collections.test.ts test/server-worker.test.ts` — affected test suites green
- `bun test` — full project green
- `launchctl bootout gui/$UID/arthack.keeperd && launchctl bootstrap gui/$UID ~/Library/LaunchAgents/arthack.keeperd.plist` — restart daemon (`KEEPER_TRACE_SERVER=1` already live from ec6e936)
- `bun scripts/srv-ts-stats.ts` — re-aggregate measurements; capture the metaCount p95 drop in Evidence

## Acceptance

- [ ] `SCHEMA_VERSION` bumped 31 → 32 in `src/db.ts:56`
- [ ] `CREATE_EPICS` literal in `src/db.ts` adds `default_visible INTEGER NOT NULL GENERATED ALWAYS AS (CASE WHEN status='open' OR approval!='approved' THEN 1 ELSE 0 END) VIRTUAL` as column 17 (after `queue_jump`)
- [ ] New helper `addGeneratedColumnIfMissing(db, table, column, def)` in `src/db.ts` uses `PRAGMA table_xinfo` (not `table_info`); existing `addColumnIfMissing` UNCHANGED
- [ ] v31 → v32 migration step calls `addGeneratedColumnIfMissing(db, "epics", "default_visible", "INTEGER NOT NULL GENERATED ALWAYS AS (CASE WHEN status='open' OR approval!='approved' THEN 1 ELSE 0 END) VIRTUAL")`
- [ ] New partial index `idx_epics_default_visible ON epics(default_visible, sort_path, epic_id) WHERE default_visible = 1` added to `CREATE_EPICS_INDEXES` block at `src/db.ts:419-432`
- [ ] fn-628 JSdoc forecast at `src/db.ts:426-428` ("if future growth makes the filter dominant, a follow-up can materialize a derived default_visible integer column") updated to reference the shipped Tier 4.1 work
- [ ] `EPICS_DESCRIPTOR.defaultClause` in `src/collections.ts:271-274` refactored from `{sql: "(status = ? OR approval != ?)", params: ["open", "approved"]}` to `{sql: "default_visible = 1", params: []}` — LITERAL `1`, not parameterized (avoids partial-index matcher ambiguity)
- [ ] `default_visible` added to `EPICS_DESCRIPTOR.columns` array in matching order; NOT added to `sortable`, `filters`, or `jsonColumns`
- [ ] Descriptor comment block above `defaultClause` rewritten — the "crosses two columns, so it lives in defaultClause rather than defaultFilter" rationale is obsolete with single-column equality
- [ ] EpicSnapshot fold INSERT in `src/reducer.ts:572-583` UNCHANGED (lists 13 columns; SQLite computes `default_visible` automatically; including it in the INSERT column list would throw "cannot INSERT into generated column")
- [ ] `test/db.test.ts` migration-test column-list expectation (~`:672-692`) updated: bump expected version to "32" and add `default_visible` to the expected `PRAGMA table_xinfo` ordered column list (use `table_xinfo` here too — `table_info` won't see the new column)
- [ ] `test/db.test.ts` presence test added: query `sqlite_master` for `idx_epics_default_visible`, assert exists
- [ ] `test/db.test.ts` EQP regression rewritten (~`:1042-1072`): assert `WHERE default_visible = 1 ORDER BY sort_path ASC, epic_id ASC` uses `idx_epics_default_visible` (SEARCH not SCAN; no TEMP B-TREE)
- [ ] `test/db.test.ts` ADDITIONAL EQP regression: assert `WHERE status='done' ORDER BY sort_path ASC, epic_id ASC` STILL uses `idx_epics_sort_path` (preserves fn-628 coverage for explicit-status query)
- [ ] `test/db.test.ts` semantic equivalence test: assert `SELECT epic_id FROM epics WHERE default_visible = 1 ORDER BY epic_id` returns the SAME ordered set as `SELECT epic_id FROM epics WHERE (status='open' OR approval!='approved') ORDER BY epic_id` over a seeded fixture (mirrors fn-628 task `.2`'s UNION-vs-OR semantic equivalence test at `test/db.test.ts:1287`)
- [ ] `test/db.test.ts` generated-column semantics test: insert epics with 6 corners — (open, approved), (open, pending), (closed, approved), (closed, pending), (NULL, approved), (NULL, pending) — assert `default_visible` evaluates to (1, 1, 0, 1, 0, 1) respectively
- [ ] `test/db.test.ts` migration backfill test: synthesize a v31-shape DB, run `migrate()`, assert (a) version stamp = "32", (b) `default_visible` column present in `PRAGMA table_xinfo`, (c) existing rows have `default_visible` computed correctly per their (status, approval)
- [ ] `test/db.test.ts` boot-twice idempotence test: run `migrate()` twice on the same DB, assert no exceptions; specifically `addGeneratedColumnIfMissing` no-ops on second call
- [ ] `test/db.test.ts` write-protection regression: `INSERT INTO epics(epic_id, ..., default_visible) VALUES(...)` throws SQLite error ("cannot INSERT into generated column"); confirms the schema-enforced safety
- [ ] `test/server-worker.test.ts:398-433` updated — the test pins the literal OR SQL via `resolveFilter`; update expected clause to `"WHERE default_visible = 1"` with empty params
- [ ] `test/collections.test.ts:537-549` updated — pins `EPICS_DESCRIPTOR.defaultClause` literally; update to the new shape
- [ ] `test/collections.test.ts:617-648` 4-corner runQuery semantics test continues to pass UNCHANGED (semantics preserved by construction)
- [ ] README.md schema narrative paragraph (~574-586) extended with a v32 sentence naming `default_visible` (VIRTUAL generated column, expression, partial index) — match the existing one-sentence-per-new-column pattern from sort_path/queue_jump
- [ ] README.md `EPICS_DESCRIPTOR.defaultClause` comment block (~262-274) rewritten — drop "crosses two columns" rationale
- [ ] README.md `board.ts` description (~356) and SQL example (~745) updated to match new column shape; name `idx_epics_default_visible` in any relevant query example
- [ ] Re-fold determinism preserved: rewind cursor, `DELETE FROM epics`, drain — `default_visible` values byte-identical to steady-state (no test required beyond the existing re-fold golden — verify it still passes)
- [ ] EVIDENCE: with `KEEPER_TRACE_SERVER=1` still live, restart daemon, soak ~3 minutes under same realistic load, re-run `bun scripts/srv-ts-stats.ts`. Capture BEFORE numbers (already documented in the conversation log: `metaCount p95=3105 ms`, `countAndToken max=2723 ms`) and AFTER numbers in `## Evidence`. Expected: metaCount p95 drops by >10× (sub-100 ms), countAndToken per-query max drops correspondingly
- [ ] EQP before/after plan strings captured in Evidence (paste verbatim from sqlite3 CLI on the live DB after migration runs)
- [ ] `bun test` green

## Early proof point

Single task — the migration + descriptor + tests land together. The proof: with the daemon kickstarted on the new code, `bun scripts/srv-ts-stats.ts` after a 3-minute soak shows `diffTick / metaCount p95` dropped by >10× from the documented 3105 ms baseline. If metaCount p95 stays above 1 s: investigate whether the partial index is actually being used (run `EXPLAIN QUERY PLAN` against the live DB on the literal `WHERE default_visible = 1 ORDER BY sort_path, epic_id` query — expect `SEARCH epics USING (COVERING )?INDEX idx_epics_default_visible`), and whether the descriptor's defaultClause is actually being applied (grep server-worker logs for the resolved WHERE clause). If both check out but countAndToken stays slow, the next investigation is the `idx_epics_default_visible` definition itself (column order, partial predicate match).

## References

- `/Users/mike/docs/2026-05-27-keeper-syncing-api-daemon-contention-review.md` — original contention review
- `/Users/mike/docs/2026-05-27-keeper-review-followup-response.md` — reviewer's revised priority plan; default_visible materialization is the deferred-pending-measurement option this epic fulfills
- `fn-622-contention-review-tier-1-fix-pack` — Tier 1 (closed + approved)
- `fn-628-contention-review-tier-2-index-pack` — Tier 2 (closed + approved); this epic's index forecast at `src/db.ts:426-428` is the prophecy
- `fn-631-contention-review-tier-3-difftick-probe` — Tier 3 epic 1 (closed + approved)
- `fn-632-contention-review-tier-3-multi-sub` — Tier 3 epic 2 (closed + approved)
- `fn-633-git-per-session-file-attribution` — **HARD DEP** (epic.depends_on_epics wired). fn-633 claims SCHEMA_VERSION v31 with uncommitted in-tree work; Tier 4.1 takes v32, serializes after fn-633 closes
- sqlite.org/gencol.html — generated column rules; `PRAGMA table_info` excludes generated columns, `table_xinfo` includes them
- sqlite.org/lang_altertable.html — `ALTER TABLE ADD COLUMN ... STORED` is REJECTED; only VIRTUAL is supported via ALTER
- sqlite.org/partialindex.html — partial index matcher rules; literal WHERE clauses match cleanly

## Docs gaps

- **README.md schema narrative** (~lines 574-586): extend with a v32 sentence for `default_visible` matching the existing per-version one-sentence pattern (sort_path / queue_jump / created_by_closer_of)
- **README.md `EPICS_DESCRIPTOR.defaultClause` comment** (~lines 262-274): rewrite — the "crosses two columns" rationale is obsolete
- **README.md `board.ts` description** (~line 356) and SQL example (~line 745): update to reflect new column shape; name `idx_epics_default_visible` if a query example exercises it
- **`src/db.ts:426-428` (fn-628 JSdoc forecast)**: the comment forecasting `default_visible` as a future option becomes load-bearing prose for the shipped column — rewrite to describe what's shipped, link Tier 4.1 in the comment if naming conventions allow

## Best practices

- **VIRTUAL, not STORED.** SQLite's `ALTER TABLE ADD COLUMN ... STORED` is rejected outright; only VIRTUAL is addable. At 682 rows the per-read expression cost is negligible; the partial index does the work.
- **CASE-wrap for NULL safety.** `status` is TEXT-nullable in keeper's schema. `(status='open' OR approval!='approved')` returns NULL when status IS NULL AND approval='approved', violating any NOT NULL constraint on the generated column at write/scan time. `CASE WHEN ... THEN 1 ELSE 0 END` always returns 0/1.
- **`PRAGMA table_xinfo`, not `table_info`, for generated-column detection.** Generated columns are invisible to `table_info`. A migration helper that uses `table_info` would re-attempt ALTER every boot and throw "duplicate column" after the first run.
- **Literal `default_visible = 1`, not `default_visible = ?` with params=[1].** Avoids any SQLite partial-index matcher quirk around constant-folding bound parameters. The descriptor's `params: []` form is supported by the existing types.
- **Don't include the generated column in any INSERT/UPDATE statement.** SQLite throws "cannot INSERT into generated column" — schema-enforced safety. Pin it with a negative test so a future contributor doesn't accidentally "fix" the omission.
- **Both indexes coexist.** `idx_epics_sort_path` (Tier 2) still serves the explicit-status path that drops `defaultClause`; `idx_epics_default_visible` serves the default scope. Don't remove the former. Test both.
