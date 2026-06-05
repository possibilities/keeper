## Description

**Size:** S
**Files:** keeper/api.py, keeper/__init__.py, keeper/tests/test_api.py

### Approach

Once the TS readers (tasks 2-3) replace every keeper-side use of
`get_session_dirty_files`, delete it plus its private helpers
`_live_dirty_paths` and `_git_root` from `keeper/api.py` — but FIRST grep to
confirm `_live_dirty_paths`/`_git_root` are not shared with the KEPT readers
(`get_epic`/`get_job`/`get_session_identity_for_pid`); keep any shared helper.
Confirm (via the earlier sweep — already established) that NO non-jobctl
caller imports `get_session_dirty_files` (planctl's render-approve-context
uses `get_epic`/`get_job`, not this), then drop it from `keeper/__init__.py`
`__all__`. Remove the `get_session_dirty_files` cases from
`keeper/tests/test_api.py`. Leave `SUPPORTED_SCHEMA_VERSIONS` and the rest of
the keeper-py surface untouched. Update the module docstring (lines 6-10) so
it no longer lists `get_session_dirty_files`.

### Investigation targets

**Required** (read before coding):
- ~/code/keeper/keeper/api.py:315-449 — the function + its private helpers (confirm helper sharing before deleting)
- ~/code/keeper/keeper/__init__.py:11-28 — the __all__ export list
- ~/code/keeper/keeper/tests/test_api.py — the cases to drop

### Risks

- `_live_dirty_paths`/`_git_root` may be shared — deleting a shared helper breaks the kept readers. Grep first.
- Removing from `__all__` while a sibling still imports it would break that consumer — the sweep says none do, but re-verify with `rg get_session_dirty_files ~/code`.

### Test notes

`python -m unittest` in keeper-py stays green after the case removals;
`rg get_session_dirty_files ~/code` returns only archival/historical hits.

## Acceptance

- [ ] `get_session_dirty_files` + any non-shared private helper removed; shared helpers kept.
- [ ] Dropped from `__all__`; no live importer remains (`rg` clean across ~/code).
- [ ] test_api.py cases removed, keeper-py unittest green, docstring updated.

## Done summary

## Evidence
