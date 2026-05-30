## Description

**Size:** S
**Files:** keeper/api.py, tests/test_api.py

### Approach

Add `get_session_name_history() -> dict[str, list[str]]` to keeper-py,
mirroring `get_session_titles()` (api.py:218-241): `_resolve_db_path` →
`_open_readonly` → `_check_schema` → `SELECT job_id, name_history FROM jobs`
→ `json.loads` each cell into a list, defensively falling back to `[]` on a
malformed/empty cell (the `_dirty_paths_by_repo` pattern at 120-141) →
`finally: conn.close()`. Stdlib-only, read-only, raises
`KeeperDBMissing`/`KeeperSchemaError` like its siblings — no silent
fallback. (The SUPPORTED_SCHEMA_VERSIONS bump already landed in .1.)

Add a `GetSessionNameHistoryTest(unittest.TestCase)` in tests/test_api.py
mirroring `GetSessionTitlesTest` (176-217): extend the minimal `_build_jobs_db`
jobs table (163) with a `name_history` column, add a helper to insert a row
with a history array, and cover happy path (multi-name history returned in
order), empty-history → `[]`, missing-db-raises, unsupported-schema-raises.

### Investigation targets

**Required** (read before coding):
- keeper/api.py:218-241 — `get_session_titles()` (the exact sibling to mirror)
- keeper/api.py:120-141 — `_dirty_paths_by_repo` defensive `json.loads`-per-cell pattern
- keeper/api.py:62-117 — `_resolve_db_path` / `_open_readonly` / `_check_schema` (reuse verbatim)
- tests/test_api.py:154-221 — `_build_jobs_db`, `_add_job`, `GetSessionTitlesTest`, the `KEEPER_DB` env-override + temp-db pattern, `python -m unittest` runner

### Risks

- A malformed `name_history` cell must not raise — fall back to `[]` for that job (defensive, per `_dirty_paths_by_repo`).

### Test notes

`uv run python -m unittest tests.test_api -v` — all green, including the new class.

## Acceptance

- [ ] `get_session_name_history() -> dict[str, list[str]]` returns each job's ordered name history, `[]` for empty/malformed, raising KeeperDBMissing/KeeperSchemaError like siblings
- [ ] `GetSessionNameHistoryTest` added; `python -m unittest tests.test_api` green

## Done summary

## Evidence
