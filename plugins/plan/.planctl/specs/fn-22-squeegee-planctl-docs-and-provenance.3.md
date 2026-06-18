## Description

**Size:** M
**Files:** tests/*.py (top fn-comment carriers: test_global_state.py ~234, test_runtime_status.py ~82, test_validate.py ~55, test_claim.py, test_close_finalize.py, test_find_task_commit.py, test_next_skill_consistency.py, test_epic_add_deps.py)

### Approach

Trim pure-provenance comments from test fixtures per the epic Scrub standard. KEEP: fn-named regression-guard test NAMES that map to a docs/reference/planctl-bug-history.md anchor (verify each candidate against the doc before renaming — when it maps, the name stays); fixture DATA ids like `fn-1`/`fn-10` used as test inputs (e.g. the id-prefix collision test — that is data, not provenance); docstrings that state what a test proves (rewrite only to drop the ticket id, e.g. "fn-264 acceptance hinges on..." → "env var wins over module attr; tests must monkeypatch.setenv"). NEVER delete or disturb `@pytest.mark.*` lines while trimming adjacent comments (--strict-markers makes a typo'd marker a collection error). Protected-comment list applies.

### Investigation targets

**Required** (read before coding):
- The epic spec (planctl cat) — Scrub standard, protected list
- docs/reference/planctl-bug-history.md — anchor list for regression-guard names

### Risks

Over-trimming a regression-guard name severs the test-to-bug-history link the repo deliberately maintains — when a test name maps to a bug-history anchor, the name is sacred.

### Test notes

`uv run pytest tests/ --run-slow` green with identical collected-test COUNT before/after (proves no marker/collection damage); ruff + format green (ty excludes tests).

## Acceptance

- [ ] Pure-provenance fixture comments gone; regression-guard names and data ids intact
- [ ] Collected test count identical before/after; full slow suite green
- [ ] Done summary reports lines and chars deleted

## Done summary
Scrubbed pure-provenance fn-NNN ids from test module docstrings, fixture comments, and assertion messages across 45 test files; restated as present-tense facts. Kept fixture data ids, format-example ids, and bug-history-anchored guard names. Full slow suite green (795 passed, 2 skipped); collected count unchanged at 797. ~336 lines / ~24k chars removed.
## Evidence
