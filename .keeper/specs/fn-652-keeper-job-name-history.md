## Overview

Add a per-job `name_history` attribute to keeper's `jobs` projection — an
ordered list (oldest→newest, current title last) of the distinct titles a
job has had — and expose it via keeper-py so claudectl can resolve a
session by any name it ever carried. Keeper today projects only the current
`title` (+ `title_source`); there is no history, which is the last thing
blocking claudectl from retiring its dependency on the old hooks-tracker
SQLite db (`load_all_session_names`). The epic spans two repos: the keeper
attribute + reader land in keeper; the claudectl repoint lands in arthack
via a per-task `target_repo`.

Design: `name_history TEXT NOT NULL DEFAULT '[]'` on `jobs` (JSON array,
same convention as `epic_links`), appended-to in the reducer whenever
`title` advances to a new distinct value (deduped, ordered, capped at the
most-recent 20), seeded at the SessionStart spawn title. A v38→v39 schema
bump carries a guarded backfill seeding each existing titled job's current
`title` as `[title]`. keeper-py gains `get_session_name_history()` and the
SCHEMA_VERSION whitelist bump (must land with the schema bump or
`commit-work` fails host-wide). The UDS `collections.ts` surface is
intentionally NOT touched — claudectl reads keeper.db directly via keeper-py.

## Quick commands

- `cd /Users/mike/code/keeper && bun test test/schema-version.test.ts test/db.test.ts`
- `cd /Users/mike/code/keeper && uv run python -m unittest tests.test_api -v`
- `uv run python -c "from keeper.api import get_session_name_history as g; h=g(); print(len(h), next(iter(h.items()), None))"`

## Acceptance

- [ ] `jobs.name_history` exists (schema v39), reducer appends distinct titles deterministically, existing rows backfilled with their current title
- [ ] `keeper.api.get_session_name_history() -> dict[session_id, list[str]]` returns each job's ordered name history; SUPPORTED_SCHEMA_VERSIONS includes 39; drift-guard + Python tests green
- [ ] claudectl `load_all_session_names` reads keeper (strict), the last hooks-tracker reader in claudectl is gone

## Early proof point

Task that proves the approach: `.1` (schema + reducer append + whitelist bump). If the reducer append can't be made re-fold-deterministic from the persisted cell, fall back to deriving name_history lazily in keeper-py from the event log instead of a projected column.

## References

- claudectl hooks-tracker retirement context: arthack `apps/claudectl/claudectl/search_helpers.py` `load_all_session_names` (the consumer this unblocks), `helpers.py:429` `resolve_identifier`
- Sibling already shipped: `keeper.api.get_session_titles()` + claudectl `load_session_names` repoint (the exact pattern tasks .2/.3 mirror)
- No epic-scout run — check for open keeper epics also bumping SCHEMA_VERSION / touching src/db.ts before merge
