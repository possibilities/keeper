## Description

**Size:** S
**Files:** apps/claudectl/claudectl/search_helpers.py

### Approach

Repoint claudectl's last hooks-tracker reader at keeper, completing the
retirement (T4 + T5). Rewrite `load_all_session_names` (search_helpers.py:84)
to call `keeper.api.get_session_name_history()` instead of querying
`hooks-tracker.db`'s `job_name_history` table — strict, propagating
`KeeperDBMissing`/`KeeperSchemaError`, exactly mirroring how
`load_session_names` was repointed to `get_session_titles` (the shipped T1
pattern in the same file). The function already returns
`dict[session_id, list[str]]`, which is `get_session_name_history`'s shape —
a clean drop-in for `resolve_identifier` (helpers.py:429,528-530), which
matches a typed identifier against any historical name.

Since this removes the last `HOOKS_TRACKER_DB` user, also delete the
now-dead `HOOKS_TRACKER_DB` constant (search_helpers.py:20) and clean the
two stale references: the `run_list_sessions.py:93` comment and the
`run_show_statusline.py:124` docstring line — finishing T5 of the
retirement. Verify no functional `hooks-tracker` references remain in
claudectl.

### Investigation targets

**Required** (read before coding):
- apps/claudectl/claudectl/search_helpers.py:84 — `load_all_session_names` (the body to repoint); :20 `HOOKS_TRACKER_DB` constant (delete once unused)
- apps/claudectl/claudectl/search_helpers.py — the already-shipped `load_session_names` → `keeper.api.get_session_titles` repoint (strict, no try/except) is the exact pattern to mirror
- apps/claudectl/claudectl/helpers.py:429,528-530 — `resolve_identifier` consuming `load_all_session_names`
- apps/claudectl/claudectl/run_show_statusline.py:124, run_list_sessions.py:93 — stale hooks-tracker doc/comment references to clean

### Risks

- Strict propagation changes behavior on a keeper-less host (raises instead of `{}`) — consistent with the T1 decision; intended.
- Depends on .2 shipping (the reader must exist and `keeper.api` resolve from arthack — it already does via the whitelisted external import).

### Test notes

`uv run claudectl show-session <an-old-name>` resolves via history;
`grep -rn hooks-tracker apps/claudectl/claudectl/` returns nothing functional.

## Acceptance

- [ ] `load_all_session_names` reads `keeper.api.get_session_name_history`, strict, no hooks-tracker query
- [ ] `HOOKS_TRACKER_DB` constant + the two stale doc/comment references removed
- [ ] `resolve_identifier` still resolves a session by a historical name; no functional `hooks-tracker` reference remains in claudectl

## Done summary

## Evidence
