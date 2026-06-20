## Overview

Tier 2 of the keeper contention review fix plan. F6 (read-side indexes for epics + jobs default queries) and F7 (writer-side partial indexes for `events.planctl_*` columns) — both narrowly scoped, EXPLAIN-measurable, and verified by practice-scout against Bun 1.3.14 / SQLite 3.51.0 before scaffolding. Two tasks: A for F6 client-served paths, B for F7 reducer-side `syncPlanctlLinks` fan-out (with an OR → UNION query rewrite bundled in so both new partial indexes actually get used at the hot-path sweep, not just the colder per-epic scan).

**Hard correction from the original review spec**, validated by practice-scout EQP against bun:sqlite: the jobs index ships as `(created_at DESC, job_id, state)` — NOT the originally-proposed `(state, created_at DESC, job_id)`. SQLite cannot use a `NOT IN`-predicated leading column as an index entry (negation can't be translated to a usable index range), so a `state`-leading index would land but never be picked by the planner. Putting `created_at DESC` as the leader serves the ORDER BY directly; trailing `state` makes the index covering for the filter applied during scan.

## Quick commands

- `bun test test/db.test.ts` — full db + index regression suite green
- `sqlite3 ~/.local/state/keeper/keeper.db "EXPLAIN QUERY PLAN <query>"` — manual EQP capture before/after `launchctl kickstart -k`
- After both tasks ship: `launchctl kickstart -k gui/$UID/arthack.keeperd` — applies new indexes on next daemon boot (CREATE INDEX IF NOT EXISTS runs in `migrate()`)

## Acceptance

- [ ] `idx_epics_sort_path` eliminates `USE TEMP B-TREE FOR ORDER BY` on the default epics query (`(status='open' OR approval!='approved') ORDER BY sort_path ASC, epic_id ASC`)
- [ ] `idx_jobs_created_state ON jobs(created_at DESC, job_id, state)` eliminates `USE TEMP B-TREE FOR ORDER BY` on the default jobs query and is COVERING (state trailing)
- [ ] `idx_events_planctl_epic` AND `idx_events_planctl_target` BOTH used by the `syncPlanctlLinks` cross-session sweep — via UNION form, EQP shows `COMPOUND QUERY` with both `SEARCH ... USING INDEX` branches
- [ ] Per-epic scan at `src/reducer.ts:2543` shows `SEARCH events USING INDEX idx_events_planctl_epic (planctl_epic_id=?)`
- [ ] EQP before/after captured in each task's Evidence section
- [ ] UNION rewrite preserves re-fold determinism (semantic-equivalence test passes)
- [ ] `ANALYZE epics; ANALYZE jobs; ANALYZE events;` run unconditionally on every `migrate()` boot
- [ ] SCHEMA_VERSION stays at 30 (no ALTER, no version-stamp bump needed)
- [ ] README.md prose + example-query comments name the new indexes accurately
- [ ] Stale comment at `src/reducer.ts:2533-2537` updated to name `idx_events_planctl_epic` and remove the over-optimistic v14-index claim
- [ ] `bun test` green

## Early proof point

Task that proves the approach: `<epic>.1` (F6 read-side indexes). Once that lands, `sqlite3 ~/.local/state/keeper/keeper.db "EXPLAIN QUERY PLAN SELECT epic_id FROM epics WHERE (status='open' OR approval!='approved') ORDER BY sort_path ASC, epic_id ASC"` should show `SCAN epics USING INDEX idx_epics_sort_path` instead of today's `SCAN epics / USE TEMP B-TREE`. If somehow the index lands but the planner doesn't pick it: confirm `ANALYZE` ran during `migrate()` (it should run unconditionally after the new blocks). If still not picked — investigate whether the OR-predicate's selectivity statistics blocked the planner choice, document the EQP, and consider a materialized `default_visible` column in a follow-up rather than escalating Tier 2 scope.

## References

- `/Users/mike/docs/2026-05-27-keeper-syncing-api-daemon-contention-review.md` — F6 + F7 in the original Carmack-style audit
- `/Users/mike/docs/2026-05-27-keeper-review-followup-response.md` — reviewer's revised priority that orders these as P1
- `fn-622-contention-review-tier-1-fix-pack` — Tier 1 fix pack (closed + approved)
- SQLite partial-index docs: sqlite.org/partialindex.html §3 Rule 2
- SQLite OR optimization: sqlite.org/optoverview.html §4.2 (why cross-column OR doesn't decompose to UNION rowid-merge)

## Docs gaps

- **README.md lines 57-62**: rewrite the "partial-indexed" sentence to name the actual final planctl-index set after Tier 2 lands (`idx_events_planctl_session` + `idx_events_planctl_epic` + `idx_events_planctl_target`)
- **README.md lines ~690-720 area**: existing inline-comment pattern `# <desc> — uses the partial <idx_name> index` — add comments naming `idx_epics_sort_path` on epics `ORDER BY sort_path` example queries; name the planctl partial indexes on any `syncPlanctlLinks`-adjacent example queries that are documented

## Best practices

- **Gate at the EQP-verified shape, not the intuitive one.** Practice-scout's verification flipped the proposed `(state, created_at DESC, job_id)` to `(created_at DESC, job_id, state)`. SQLite cannot translate a `NOT IN` predicate into a usable index-entry range on the leading column; the ORDER BY column has to lead. Always run EQP on the actual consumer query before locking the index shape.
- **`ANALYZE <table>` after creating indexes is critical** — without seeded stats the planner may not pick the new index until auto-stats accumulate. v14 precedent (`src/db.ts:349`) sets the pattern; Tier 2 runs ANALYZE unconditionally so stats refresh on every daemon boot.
- **Partial-index WHERE clause matching follows Rule 2.** Any comparison on a column declared `IS NOT NULL` in the index satisfies it — the consumer query's predicate doesn't need to match the index's predicate verbatim. The existing `idx_events_planctl_session` already uses this pattern successfully.
- **Cross-column OR doesn't decompose into UNION rowid-merge** — SQLite picks one index and SCANs it. Use an explicit `UNION` rewrite when both partial indexes need to be SEARCHed (not SCANned). UNION dedups via temp B-tree, equivalent to `SELECT DISTINCT` over the OR.
- **`CREATE INDEX IF NOT EXISTS` is ~0.0025 ms per call** when the index exists. Cost-free to run on every `migrate()`. Forward-only, idempotent, no version-stamp bump required.
- **Capture EQP before AND after in Evidence.** Index work without a verified plan transition is faith-based; with EQP, it's measurable. Use contains-match regex on the index name to keep tests robust to Bun/SQLite output drift.
