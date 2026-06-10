## Description

**Size:** S
**Files:** planctl/cli.py

### Approach

Click renders the top-level help from the group docstring + per-command short_helps (first sentence of each command docstring or explicit short_help=). Tighten: shrink the group docstring to 1-2 lines; ensure each verb's listing line is a single crisp clause (set explicit short_help= where the derived first sentence is long instead of editing command docstrings — fn-22 owns docstring provenance edits); keep verb names and semantics untouched. Mind the Click rules: do not restructure command docstrings, only the group docstring and short_help kwargs.

### Investigation targets

**Required** (read before coding):
- planctl/cli.py — group definition and command registrations
- `planctl --help` current output — which listing lines wrap or carry prose

### Risks

tests/test_*skill_consistency* and others may assert verb presence in help — grep tests for help-output assertions first.

### Test notes

`uv run pytest tests/ --run-slow` green; ruff/format/ty green; `planctl --help | wc -l` <= ~28.

## Acceptance

- [ ] `planctl --help` <= ~28 lines, every verb listed once with a one-clause description
- [ ] Command docstrings untouched (short_help kwargs only); tests + lint matrix green
- [ ] Done summary reports lines/chars deleted

## Done summary

## Evidence
