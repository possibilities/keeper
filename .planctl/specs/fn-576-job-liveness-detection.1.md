## Description

**Size:** M
**Files:** src/db.ts, plugin/hooks/events-writer.ts, src/daemon.ts, test/reducer.test.ts, test/daemon.test.ts, test/db.test.ts

### Approach

Bump `SCHEMA_VERSION` 8→9 in `src/db.ts`; add an ALTER block calling `addColumnIfMissing(events, "start_time", "TEXT")` and `addColumnIfMissing(jobs, "start_time", "TEXT")`. Both columns nullable; both default null. Update `Stmts.insertEvent` prepared statement (`src/db.ts:533-538`) to include the new column. Update every positional call site: hook (`plugin/hooks/events-writer.ts:206-222`), transcript-title synthetic (`src/daemon.ts:232-248`), plan-snapshot synthetic (`src/daemon.ts:334-350`), and all test seeders (`test/reducer.test.ts:70-92`, `test/daemon.test.ts:36-41` + `151-167`). Pass `null` for `start_time` everywhere except where it is intentionally captured (task 3 fills the hook side). Strongly consider converting `insertEvent` from positional to named bindings as part of this task to immunize future column-shift drift (gap-analyst integration risk).

### Investigation targets

**Required** (read before coding):
- `src/db.ts:29` — `SCHEMA_VERSION` constant
- `src/db.ts:339-373` — `migrate()` ALTER slot
- `src/db.ts:533-538` — `Stmts.insertEvent` prepared statement (positional shape)
- `plugin/hooks/events-writer.ts:174-222` — hook `insertEvent` call site
- `src/daemon.ts:225-355` — synthetic emit sites (transcript-title ~232-248; plan snapshots ~334-350)

**Optional** (reference as needed):
- `src/db.ts:324-330` — `applyPragmas` (precedent for connection-local pragma rules)
- `test/reducer.test.ts:49-98` — `insertEvent` helper shape
- `test/daemon.test.ts:36-41, 151-167` — daemon test seeders

### Risks

Positional column-shift is silent — a missed call site corrupts data without throwing. Strongest mitigation is converting to named binding inside this task so future columns can be added without touching every caller.

### Test notes

All existing reducer + daemon + integration tests must continue to pass with `start_time=null` defaults. Add a fresh-DB migration unit test that verifies both columns appear after a v8→v9 bump and that re-running the migration is idempotent.

## Acceptance

- [ ] `SCHEMA_VERSION` bumped to 9; `migrate()` adds both `events.start_time` and `jobs.start_time` as nullable TEXT
- [ ] `Stmts.insertEvent` threaded through with the new column at every call site (hook + synthetic emitters + test seeders)
- [ ] All existing tests pass with `start_time=null`
- [ ] New migration unit test verifies v8→v9 + idempotent re-run

## Done summary
Schema v9 adds events.start_time + jobs.start_time as nullable TEXT, with idempotent ADD COLUMN ALTERs. Converted Stmts.insertEvent from positional to named bindings () across the hook, both daemon synthetic emitters, and every test seeder — future column additions are now localized edits instead of column-shift hazards. Added a v8→v9 migration test + fresh-DB shape assertion.
## Evidence
