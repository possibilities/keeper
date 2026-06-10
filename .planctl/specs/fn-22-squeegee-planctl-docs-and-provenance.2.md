## Description

**Size:** M
**Files:** planctl/*.py (≈239 fn-refs; top: cli.py ~32, run_scaffold.py ~31, models.py ~14; plus audit_artifacts.py, brief.py, bundle_ref.py, _util.py, api.py, commit_messages.py, validation_restamp.py, commit.py, discovery.py, global_state.py, integrity.py)

### Approach

Sweep every fn-NNN reference in planctl/*.py and classify per the epic Scrub standard: provenance → rewrite as present-tense fact without the id (or delete if the sentence carries nothing else); canonical-list annotations in commit_messages.py / validation_restamp.py → strip the fn prefix, keep the note if it states a constraint, NEVER touch the mapped verb-name string values; docstring format examples (api.py `fn-1-slug.3` and similar) → KEEP. Obey the protected-comment list and the Click-docstring rules from the epic spec (cli.py and run_*.py contain Click commands — their docstrings are --help text; provenance phrase removal only, no restructuring, preserve any backslash-b / backslash-f marker lines and first sentences).

### Investigation targets

**Required** (read before coding):
- The epic spec (planctl cat) — Scrub standard, protected list, Click rules
- docs/reference/planctl-bug-history.md — the sanctioned fn-id anchor list

### Risks

cli.py docstrings feed --help; a restructured paragraph silently changes user-facing output — provenance-phrase-only edits there, verified by diffing `--help` output for touched verbs.

### Test notes

`uv run pytest tests/ --run-slow` + ruff + ruff format --check + ty green; spot-diff `planctl scaffold --help` (or any touched verb) before/after.

## Acceptance

- [ ] Zero provenance fn-refs remain in planctl/*.py (data fn-refs — examples — may remain and are listed in the Done summary)
- [ ] commit_messages.py / validation_restamp.py verb values byte-identical; only comment prefixes changed
- [ ] --help output unchanged for every touched Click command
- [ ] Full slow suite + ruff + format + ty green
- [ ] Done summary reports lines and chars deleted

## Done summary

## Evidence
