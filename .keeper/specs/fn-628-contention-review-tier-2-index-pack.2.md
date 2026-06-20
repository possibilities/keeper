## Description

**Size:** M
**Files:** `src/db.ts`, `src/reducer.ts`, `test/db.test.ts`, `README.md`

### Approach

Two coupled changes that ship together: (a) add two new partial indexes on `events.planctl_*` columns, and (b) rewrite the `syncPlanctlLinks` cross-session sweep query from cross-column OR to UNION so both new indexes actually get used at the hot path.

**Indexes** — add a new always-run const block in `src/db.ts` (placement preference: a new `CREATE_EVENTS_PLANCTL_INDEXES` array near the existing `CREATE_V14_INDEXES` at line 351, since both depend on the v14 planctl columns; either always-run table-scoped or appended to `CREATE_V14_INDEXES` itself works — pick whichever matches convention better on inspection):

```ts
const CREATE_EVENTS_PLANCTL_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_events_planctl_epic ON events(planctl_epic_id, session_id, id) WHERE planctl_op IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_events_planctl_target ON events(planctl_target, session_id, id) WHERE planctl_op IS NOT NULL",
];
```

The exact `WHERE planctl_op IS NOT NULL` predicate matches the existing `idx_events_planctl_session` and satisfies SQLite's partial-index Rule 2: any comparison on a column declared `IS NOT NULL` in the index satisfies the predicate, so consumer queries don't need verbatim text.

In `migrate()`, run the new block in a for-loop and add `db.run("ANALYZE events");` after.

**Query rewrite** — at `src/reducer.ts:2371-2378`, change the cross-session sweep from:

```sql
SELECT DISTINCT session_id
  FROM events
 WHERE planctl_op IS NOT NULL
   AND (planctl_epic_id IN (...) OR planctl_target IN (...))
```

to:

```sql
SELECT session_id
  FROM events
 WHERE planctl_op IS NOT NULL AND planctl_epic_id IN (...)
UNION
SELECT session_id
  FROM events
 WHERE planctl_op IS NOT NULL AND planctl_target IN (...)
```

`UNION` (not `UNION ALL`) naturally dedups via temp B-tree — identical session_id set to the prior `SELECT DISTINCT ... OR ...` form. Practice-scout's EQP verified: this yields `COMPOUND QUERY` with `SEARCH events USING INDEX idx_events_planctl_epic (planctl_epic_id=?)` on the left and `SEARCH events USING INDEX idx_events_planctl_target (planctl_target=?)` on the right — both new indexes used, not just one.

The query lives inside the reducer's `BEGIN IMMEDIATE` transaction; the UNION rewrite changes WHAT is queried but not WHEN — re-fold determinism is preserved because the result set is identical to the OR form. Add an explicit semantic-equivalence test (see Test notes) as a regression guard.

**Stale-comment fix** — at `src/reducer.ts:2533-2537`, the comment claims the v14 partial composite `idx_events_planctl_session ON events(session_id, id) WHERE planctl_op IS NOT NULL` "serves this filter cheaply since planctl_epic_id is itself guaranteed non-NULL whenever planctl_op is non-NULL." That's over-optimistic — a `session_id`-leading composite cannot serve a `planctl_epic_id = ?` equality lookup. Update the comment to name `idx_events_planctl_epic` as the actual index serving the per-epic queue_jump scan at line 2543. Drift fix lands with the index that displaces it.

**Per-session ordered load preserved.** The query at `src/reducer.ts:2389-2395` (`WHERE session_id = ? AND planctl_op IS NOT NULL ORDER BY id ASC`) stays on `idx_events_planctl_session` — the v14 index isn't superseded. Add an EQP regression test confirming it still uses that index.

Append `idx_events_planctl_epic` and `idx_events_planctl_target` to the `test/db.test.ts:83-89` allowlist (post-Task A edit).

Update `README.md`:
- Lines 57-62 ("partial-indexed" sentence): rewrite to name the actual final planctl index set (`idx_events_planctl_session` + `idx_events_planctl_epic` + `idx_events_planctl_target`).
- Lines ~690-720 example queries: add inline `# … uses the partial … index` comments naming the new partial indexes on any documented `syncPlanctlLinks`-adjacent queries.

### Investigation targets

**Required** (read before coding):
- `src/reducer.ts:2371-2378` — cross-session sweep; THE query to rewrite
- `src/reducer.ts:2389-2395` — per-session ordered load; STAYS on `idx_events_planctl_session`, verify post-change EQP unchanged
- `src/reducer.ts:2533-2547` — per-epic queue_jump scan + stale comment to update
- `src/db.ts:349-353` — `CREATE_V14_INDEXES` + the existing v14 `ANALYZE events` precedent
- `src/db.ts:351` — `idx_events_planctl_session` partial-index pattern to mirror
- `test/db.test.ts:83-89` — allowlist to append (post-Task A)
- `test/db.test.ts:981-1025` — EQP regression test pattern
- `README.md:57-62` — partial-indexed prose to rewrite
- CLAUDE.md "Event-sourcing invariants" — confirm UNION rewrite preserves re-fold determinism

**Optional** (reference as needed):
- SQLite OR optimization (sqlite.org/optoverview.html §4.2) — explains why cross-column OR doesn't decompose to UNION rowid-merge
- SQLite partial-index docs (sqlite.org/partialindex.html §3 Rule 2) — explains the `IS NOT NULL` predicate matching

### Risks

- **UNION vs OR semantic drift.** UNION dedups via temp B-tree; the original `SELECT DISTINCT ... OR ...` also dedups. For a SELECT-only-`session_id` projection, results are identical. Add an explicit semantic-equivalence test (seed varied event mix, run both forms, assert identical session_id sets).
- **Re-fold determinism.** The reducer's `BEGIN IMMEDIATE` discipline requires that re-folding from cursor-rewind reproduces byte-identical projections. UNION preserves the input set; downstream `syncPlanctlLinks` logic consumes the session_id set the same way. Confirm with the existing golden re-fold test, if present; otherwise add one against a small fixture.
- **CREATE INDEX during boot briefly locks events.** Hook inserts wait via `busy_timeout = 5000`. LaunchAgent boot rarely overlaps with hot hook traffic, but operators should know — the ~100ms CREATE INDEX + ANALYZE on a 110k-row events table is bounded.
- **Partial-index maintenance cost.** Practice-scout measured ~12.6% insert overhead on the subset of inserts where `planctl_op IS NOT NULL` (~10% of events). Bounded and acceptable; hook insert path otherwise unchanged.
- **Stale-comment fix coupling.** Updating the comment without the new index would mislead the next reader; updating the index without the comment would leave drift. Both must land in this commit.

### Test notes

Three new EQP regression tests + one semantic-equivalence test:

1. **Cross-session sweep (UNION form):** seed `events` with ≥50 rows where some have only `planctl_epic_id` matching an IN list, some have only `planctl_target` matching, some have both. ANALYZE. EXPLAIN QUERY PLAN of the new UNION query. Assert contains-match for `COMPOUND QUERY`, `SEARCH events USING INDEX idx_events_planctl_epic`, and `SEARCH events USING INDEX idx_events_planctl_target` — all three substrings present.

2. **Per-epic queue_jump scan at reducer.ts:2543:** seed similarly. EXPLAIN of `SELECT EXISTS(SELECT 1 FROM events WHERE planctl_op IS NOT NULL AND planctl_epic_id = ? AND planctl_queue_jump = 1)`. Assert `SEARCH events USING INDEX idx_events_planctl_epic (planctl_epic_id=?)`.

3. **Per-session ordered load at reducer.ts:2389-2395 (regression guard):** EXPLAIN of `SELECT ... FROM events WHERE session_id = ? AND planctl_op IS NOT NULL ORDER BY id ASC`. Assert still `SEARCH events USING INDEX idx_events_planctl_session` — confirms the v14 index isn't displaced.

4. **UNION semantic equivalence:** seed varied event mix, run both the old OR form and the new UNION form against the same fixture, assert identical session_id sets (sort + dedup, then deep-equal). This is the re-fold-determinism guard.

## Acceptance

- [ ] `idx_events_planctl_epic ON events(planctl_epic_id, session_id, id) WHERE planctl_op IS NOT NULL` and `idx_events_planctl_target ON events(planctl_target, session_id, id) WHERE planctl_op IS NOT NULL` land via `CREATE INDEX IF NOT EXISTS` in a new `CREATE_EVENTS_PLANCTL_INDEXES` block (or appended to `CREATE_V14_INDEXES`; final placement decided on inspection)
- [ ] `migrate()` runs the new block + `db.run("ANALYZE events");`
- [ ] `src/reducer.ts:2371-2378` cross-session sweep rewritten from `SELECT DISTINCT ... OR ...` to `... UNION ...`
- [ ] `src/reducer.ts:2533-2537` stale comment updated to name `idx_events_planctl_epic` and remove the over-optimistic v14-index claim
- [ ] `test/db.test.ts:83-89` allowlist includes both new index names
- [ ] EQP test for cross-session UNION sweep asserts `COMPOUND QUERY` with both `SEARCH ... USING INDEX idx_events_planctl_epic` and `SEARCH ... USING INDEX idx_events_planctl_target` substrings present
- [ ] EQP test for per-epic scan at reducer.ts:2543 asserts `SEARCH events USING INDEX idx_events_planctl_epic (planctl_epic_id=?)`
- [ ] EQP regression test for the per-session ordered load at reducer.ts:2389-2395 confirms it still uses `idx_events_planctl_session` (no displacement)
- [ ] UNION semantic-equivalence test passes: identical session_id set vs prior OR form against a varied event-mix fixture
- [ ] Before/after EQP plan strings captured in Evidence for ALL three reducer-side queries
- [ ] `README.md:57-62` partial-indexed prose names the final index set (`idx_events_planctl_session` + `idx_events_planctl_epic` + `idx_events_planctl_target`)
- [ ] SCHEMA_VERSION unchanged at 30
- [ ] `bun test` green; re-fold determinism preserved

## Done summary
Add idx_events_planctl_epic + idx_events_planctl_target partial composite indexes (both WHERE planctl_op IS NOT NULL); rewrite syncPlanctlLinks cross-session sweep from cross-column OR to UNION so the planner SEARCHes both indexes via COMPOUND QUERY (was SCANning idx_events_planctl_session); per-epic queue_jump scan now SEARCHes idx_events_planctl_epic; per-session ordered load unchanged on idx_events_planctl_session (regression-guarded); 5 new EQP + semantic-equivalence tests pass. EQP before/after evidence in transcript.
## Evidence
