## Description

**Size:** M
**Files:** src/db.ts, keeper/api.py, src/types.ts, test/db.test.ts, src/dead-letter.ts, test/reducer.test.ts

### Approach

Add the columns end-to-end at the DB layer so events can carry them (defaulting NULL) before any producer or fold exists — a compiling, test-passing intermediate. Bump `SCHEMA_VERSION` 47→48. Add `backend_exec_{type,session_id,pane_id}` (nullable TEXT) to the `events` table and `backend_exec_{type,session_id,pane_id,tab_id,tab_name}` (nullable TEXT) to the `jobs` table: append to the `CREATE_EVENTS`/`CREATE_JOBS` literals AND a new v47→v48 migration block of `addColumnIfMissing` calls whose column literals byte-match the CREATE literals (the lockstep sparse-column ADD pattern; copy the shape of the v21→v22 config_dir block). Extend the `insertEvent` prepared statement's column list + `VALUES ($...)` and the hook's `insertBindings` map and the dead-letter bindings so the three event columns bind (NULL until T3). Extend `Event` and `Job` types in `src/types.ts`. Add 48 to `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS` in THIS change. Fix the `makeEvent` canary in `test/reducer.test.ts` (it hand-lists every events column twice) and add a v47→v48 migration test (byte-identical `PRAGMA table_info` fresh-vs-migrated).

### Investigation targets

**Required** (read before coding):
- src/db.ts:60 — SCHEMA_VERSION (47→48)
- src/db.ts:353-385 — CREATE_EVENTS literal; src/db.ts:613-640 — CREATE_JOBS literal
- src/db.ts:3214-3224 — v21→v22 config_dir migration block (copy this shape)
- src/db.ts:4676-4684 — version-stamp tail; src/db.ts:4717-4733 — insertEvent statement (column list + VALUES)
- plugin/hooks/events-writer.ts:593-623 — insertBindings map (add $backend_exec_* keys)
- src/dead-letter.ts — DeadLetterBindings (insertBindings drives dead-letter replay too)
- src/types.ts:284-295 (Event.config_dir), :454-466 (Job.config_dir) — extend alongside
- keeper/api.py:132 — SUPPORTED_SCHEMA_VERSIONS (add 48 — hard cross-language gate)
- test/reducer.test.ts:60-140 — makeEvent canary; test/db.test.ts (migration test pattern); test/schema-version.test.ts (enforces the keeper-py coverage)

### Risks

- Cross-language tripwire: bumping SCHEMA_VERSION without `keeper/api.py:132` += 48 fails `schema-version.test.ts` AND every `jobctl commit-work` on the host.
- Lockstep drift: a CREATE literal that doesn't byte-match its `addColumnIfMissing` literal makes fresh and migrated DBs diverge.
- Every synthetic-event `insertEvent.run({...})` call site in daemon.ts lists all columns explicitly — verify named bindings tolerate the new keys or those call sites need them too (T4 adds the new caller).

### Test notes

Add the v47→v48 migration test next to existing ones; run `test/schema-version.test.ts` to confirm the keeper-py coverage. No behavior yet — columns bind NULL.

## Acceptance

- [ ] `events` has 3 and `jobs` has 5 new nullable TEXT `backend_exec_*` columns; CREATE literals byte-match the migration `addColumnIfMissing` literals.
- [ ] SCHEMA_VERSION is 48 and `keeper/api.py` SUPPORTED_SCHEMA_VERSIONS includes 48.
- [ ] insertEvent + insertBindings + dead-letter bindings + `Event`/`Job` types carry the new columns; `makeEvent` canary updated.
- [ ] New v47→v48 migration test passes; `test/db.test.ts` + `test/schema-version.test.ts` green.

## Done summary

## Evidence
