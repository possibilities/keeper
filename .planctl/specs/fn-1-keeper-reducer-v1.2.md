## Description

**Size:** M
**Files:** src/db.ts, src/types.ts

### Approach

`src/types.ts` exports the shared `Event`, `Job`, and `ReducerState` interfaces (used by both daemon and hook — a real perk over the old Python-Python design). `src/db.ts` exports `openDb(path, { readonly?: boolean })` that:
1. Opens a `bun:sqlite` `Database` with the given flags
2. Sets connection-local PRAGMAs: `journal_mode = WAL`, `synchronous = NORMAL`, `busy_timeout = 5000`, `foreign_keys = ON`, `temp_store = MEMORY`
3. On a writer connection only, runs DDL for `events`, `jobs`, `reducer_state`, and `meta(schema_version)` — all `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`. Forward-only ALTER block keyed on `meta.schema_version` for future migrations.
4. Returns the `Database` plus a `Stmts` object of prepared statements (insert event, select events > cursor, upsert job, advance cursor).

`events` schema is 15 columns lifted near-verbatim from `hooks-tracker.py:66-81` (id, ts, session_id, pid, hook_event, event_type, tool_name, matcher, cwd, permission_mode, agent_id, agent_type, stop_hook_active, data, subagent_agent_id). Indexes per the bundle brief: `(session_id)`, `(hook_event)`, `(event_type)`, `(tool_name)`, `(ts)`, `(pid, hook_event, tool_name)`, partial `(subagent_agent_id) WHERE subagent_agent_id IS NOT NULL`. `jobs` is the minimal projection from the brief (job_id PK == session_id, created_at, cwd, pid, mode default 'act', state default 'stopped', last_event_id, updated_at). `reducer_state` is the singleton `id INTEGER PRIMARY KEY CHECK(id=1), last_event_id INTEGER NOT NULL DEFAULT 0, updated_at REAL`.

`KEEPER_DB` env var overrides the default `~/.local/state/keeper/keeper.db` path (lift this pattern from `hooks-tracker.py:38-58`; DROP the `RUNNING_IN_PRISE` gate and the `PIPE_SOCK_PATH` socket — those are out of v1).

### Investigation targets

**Required** (read before coding):
- `/Users/mike/code/arthack/apps/hookctl/hooks/hooks-tracker.py:66-81` — canonical events DDL
- `/Users/mike/code/arthack/apps/hookctl/hooks/hooks-tracker.py:285-290` — INSERT shape
- `/Users/mike/code/arthack/apps/hookctl/hooks/hooks-tracker.py:38-58` — env-var override pattern (lift only `KEEPER_DB`; drop prise/UDS gates)

**Optional** (reference as needed):
- [bun:sqlite docs](https://bun.com/docs/runtime/sqlite) — Database API + prepared statements

### Risks

- `PRAGMA busy_timeout` is **connection-local** — it must be set on every `openDb()` call. The hook process opens its own connection per invocation and will silently default to 0 otherwise.
- `bun:sqlite` does NOT auto-enable WAL or foreign keys; must set explicitly each open.
- Schema migrations are forward-only via ALTER blocks; no destructive migrations in v1.

### Test notes

- A small unit test on a tmp-path DB: `openDb()` creates schema, second `openDb()` is a no-op, all indexes present (verify via `sqlite_master`). Reducer-state row initializes to `(1, 0, …)`.

## Acceptance

- [ ] `openDb()` creates `events`, `jobs`, `reducer_state`, `meta` if missing
- [ ] All indexes from the brief are present
- [ ] Connection-local PRAGMAs (journal_mode, busy_timeout, foreign_keys, synchronous, temp_store) set on every open
- [ ] `readonly: true` flag opens a read-only connection (used by the wake worker)
- [ ] `reducer_state` row `(1, 0, ts)` exists after first open
- [ ] `KEEPER_DB` env var overrides default path
- [ ] Unit test asserts schema shape on a tmp DB

## Done summary

## Evidence
