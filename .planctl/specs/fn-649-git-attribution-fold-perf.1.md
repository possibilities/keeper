## Description

**Size:** M
**Files:** src/db.ts, test/db.test.ts

### Approach

Three changes, all in the DB layer:

1. **Expression index (the big win)** — add to the schema-create AND a
   forward migrate slot (idempotent `CREATE INDEX IF NOT EXISTS`):
   `CREATE INDEX idx_events_tool_file_path ON
   events(json_extract(data,'$.tool_input.file_path')) WHERE
   hook_event='PostToolUse' AND tool_name IN
   ('Write','Edit','MultiEdit','NotebookEdit');`
   `findExplicitAttributions` Q1 (`reducer.ts:~1215`) matches this
   expression exactly → index SEEK instead of a 51k-row json_extract scan
   (3.56s → 0ms, verified). Confirm the query's `json_extract` arg string
   is byte-identical to the index expression (SQLite requires an exact
   match to use an expression index).

2. **Q3 composite index** — the inferred-attribution self-join
   (`findInferredAttributions` reducer.ts:~1356) scans all 53k
   `PreToolUse` rows via `idx_events_hook_event`. Add `(hook_event,
   tool_name)` (or `(hook_event, tool_name, tool_use_id)`) so the `pre`
   side narrows to `PreToolUse:Bash`. Smaller win (0.19s today) but
   compounding — verify the new plan with EXPLAIN.

3. **applyPragmas reorder** (`db.ts:1038`) — set `busy_timeout` FIRST,
   then `journal_mode=WAL`, then `synchronous`. The WAL-mode pragma needs a
   brief write lock; today it runs with `busy_timeout=0` and fails instantly
   under contention (the `open:SQLITE_BUSY` drops, `wait=0ms`). To keep the
   hook inside its 1.5s SessionEnd budget, parameterize: `openDb(path, {
   busyTimeoutMs })` default 5000, hook passes 1200 (and can drop its later
   `PRAGMA busy_timeout=1200` override).

### Investigation targets

**Required** (read before coding):
- src/db.ts:1038-1041 — applyPragmas (pragma order)
- src/db.ts — schema CREATE INDEX block + migrate() (where to add indexes)
- src/reducer.ts:1181-1292 — findExplicitAttributions (Q1 exact json_extract
  string the index must match)
- src/reducer.ts:1327-1389 — findInferredAttributions (Q3 self-join)
- plugin/hooks/events-writer.ts — the busy_timeout override + openDb call

### Risks

- Expression-index match is string-exact: if the query's `json_extract`
  path arg differs by a byte from the index, SQLite silently falls back to
  the scan. Add an EXPLAIN-QUERY-PLAN assertion in the test.
- Index maintenance cost on INSERT is negligible (one-at-a-time hook
  writes), but note it.
- Indexes don't change fold results → re-fold determinism unaffected
  (no rewind needed, unlike fn-648).

### Test notes

Test that EXPLAIN QUERY PLAN for Q1 uses idx_events_tool_file_path (seek,
not scan); that a seeded DB returns the same attribution rows with/without
the index (result-invariance); that applyPragmas issues busy_timeout before
journal_mode (order assertion or a contention smoke test).

## Acceptance

- [ ] idx_events_tool_file_path created (schema + idempotent migrate); Q1
  EXPLAIN shows a SEEK.
- [ ] Q3 composite index added; PreToolUse self-join no longer full-scans.
- [ ] applyPragmas sets busy_timeout first; openDb parameterizes it; hook
  passes its 1200ms budget.
- [ ] Attribution results unchanged (result-invariance test); db.test.ts
  green.

## Done summary

## Evidence
