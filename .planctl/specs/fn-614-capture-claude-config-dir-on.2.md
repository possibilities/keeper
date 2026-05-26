## Description

**Size:** M
**Files:** plugin/hooks/events-writer.ts, src/db.ts, src/types.ts, src/reducer.ts, src/daemon.ts, src/seed-sweep.ts, test/db.test.ts, test/events-writer.test.ts, test/reducer.test.ts, README.md, CLAUDE.md

### Approach

Land in this order so each commit compiles and tests pass:

1. **Schema (`src/db.ts`)** — bump `SCHEMA_VERSION` 21 → 22; add `config_dir TEXT` to `CREATE_EVENTS` and `CREATE_JOBS` literals; add a v21→v22 migration block after the existing v20→v21 block with two `addColumnIfMissing` calls and a comment mirroring the v3→v4 spawn_name step. Update `stmts.insertEvent` — both halves: the column list AND the `$placeholders` block.
2. **Types (`src/types.ts`)** — add `config_dir: string | null` to the `Event` interface; add `config_dir: string | null` to the `Job` interface; update any hand-built fixtures.
3. **Hook (`plugin/hooks/events-writer.ts`)** — add a pure exported helper `configDirFromEnv(env: NodeJS.ProcessEnv): string | null` that normalizes (`||` for `undefined`/`""` → null; strip trailing `/`); thread its result into the `SessionStart`-gated insertion as `$config_dir`. Every non-SessionStart event sends `null`.
4. **Reducer (`src/reducer.ts`)** — add `config_dir` to the column list and bindings array of the `SessionStart` INSERT (line 2024-2087); add `config_dir = COALESCE(excluded.config_dir, jobs.config_dir)` to the ON CONFLICT SET clause alongside the existing pid/start_time refreshes. Add `config_dir` to `drain()`'s SELECT column list (line 2467-2472) — easy miss, surfaces as `event.config_dir === undefined`.
5. **Synthetic-event sites** — `src/daemon.ts` lines 292, 334, 453, 562, 638: each named-binding `insertEvent.run({...})` gains `$config_dir: null`. `src/seed-sweep.ts:130-159`: positional INSERT — leave the column list unchanged (existing convention omits everything past `start_time`; schema default NULL covers it).
6. **Tests** — `test/db.test.ts`: v21→v22 migration test mirroring the v3→v4 spawn_name test at lines 243-329 (assert PRAGMA `table_info`, assert existing rows preserved as NULL, assert idempotent re-open). `test/events-writer.test.ts`: clone the SessionStart-vs-other-hook test at lines 136-228; add a fixture that sets `CLAUDE_CONFIG_DIR` in the launcher's env and asserts the row carries it; add a NULL case (env unset); add an empty-string-collapses-to-null case; add a trailing-slash-stripped case. Unit-test the pure `configDirFromEnv` helper for the three normalization cases. `test/reducer.test.ts`: re-fold determinism test mirroring the existing pattern (rewind cursor + DELETE projection + re-drain → byte-identical `jobs.config_dir`); a "latest non-NULL SessionStart wins" test (two SessionStarts on same session_id, second with NULL → first value preserved by COALESCE).
7. **Docs** — `README.md` line 25-46: bump "eight" → "nine" and splice `events.config_dir` into the sparse-signals enumeration. `README.md` line 448: add inline "As of schema v22..." clause. `README.md` line 525-527: extend the annotated SELECT to include `config_dir`. `CLAUDE.md` line 213-217: extend the "Name scraping is scoped, not general" rule to cover `CLAUDE_CONFIG_DIR` env-capture as the second permitted SessionStart-gated read.

### Investigation targets

**Required** (read before coding):
- `src/db.ts:233-261` (`CREATE_EVENTS`), `src/db.ts:378-396` (`CREATE_JOBS`), `src/db.ts:592-599` (v3→v4 canonical template), `src/db.ts:1755-1892` (insertion point for v21→v22 block), `src/db.ts:1922-1936` (`stmts.insertEvent` two halves)
- `plugin/hooks/events-writer.ts:372-422` — the existing `spawnInfo` pattern to mirror
- `src/reducer.ts:2024-2087` — SessionStart fold INSERT/ON CONFLICT
- `src/reducer.ts:2459-2484` — `drain()` SELECT list (easy miss)
- `src/reducer.ts:1181-1206` — `EmbeddedJobElement` shape (config_dir does NOT belong here, decided)
- `src/daemon.ts:292, 334, 453, 562, 638` — five synthetic-event sites needing `$config_dir: null`
- `src/seed-sweep.ts:130-159` — positional INSERT (no edit needed; convention is to omit)
- `test/db.test.ts:243-329` — v3→v4 migration-test template
- `test/events-writer.test.ts:136-228` — SessionStart-vs-other-hook test shape
- `test/reducer.test.ts:477, 903, 922, 1073, 1213, 1325, 2004, 2095` — re-fold determinism pattern

**Optional** (reference as needed):
- `README.md` line 25-46, 448, 525-527 — doc edit sites
- `CLAUDE.md` line 213-217 — name-scraping rule

### Risks

- **`drain()` SELECT column list** — separate hand-maintained list from `CREATE_EVENTS`; forgetting it silently folds NULL forever. Test must fail loudly if missed.
- **`stmts.insertEvent` two-halves edit** — column list AND `$placeholders` both need updating; missing one causes a positional shift that silently corrupts data on the next column add.
- **Re-fold determinism on the resume case** — second SessionStart with NULL config_dir must preserve the first non-NULL via COALESCE; test must cover this exact transition.
- **Pre-feature SessionStart events post-migration** — column is NULL; test must assert existing v21 rows are preserved as NULL after the migration runs.

### Test notes

Tests live under `test/` (NOT `tests/`). Run via `bun test`. Three test files touched: `test/db.test.ts`, `test/events-writer.test.ts`, `test/reducer.test.ts`. New fixtures may need to be added under `test/fixtures/` if existing ones don't cover the env-passing case.

## Acceptance

- [ ] `SCHEMA_VERSION === 22` and PRAGMA `table_info('events')` lists `config_dir TEXT` and PRAGMA `table_info('jobs')` lists `config_dir TEXT`.
- [ ] Existing v21 rows survive the migration with `config_dir IS NULL`.
- [ ] Hook write on SessionStart stamps the env value (with `||` and trailing-slash normalization applied) into `events.config_dir`; every other hook event stamps NULL.
- [ ] Reducer's SessionStart fold COALESCEs `excluded.config_dir` over `jobs.config_dir` — a second SessionStart with NULL preserves the prior non-NULL.
- [ ] All five `daemon.ts` synthetic-event sites carry `$config_dir: null`.
- [ ] `seed-sweep.ts` positional INSERT compiles and inserts rows with NULL `config_dir` via the schema default.
- [ ] Re-fold from scratch (rewind cursor + DELETE FROM jobs + re-drain) reproduces `jobs.config_dir` byte-identically.
- [ ] `bun test test/db.test.ts test/events-writer.test.ts test/reducer.test.ts` passes.
- [ ] README updates land (sparse-signals count, v22 clause, inspect query); CLAUDE.md "Name scraping" rule extension lands.

## Done summary

## Evidence
