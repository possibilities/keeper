## Overview

Four tests in planctl `tests/test_worker_resume.py` are red on main —
`test_worker_resume_happy_path`, `_missing_files_block`, `_json_envelope`,
`_tier_set_emits_stderr_note`. Root cause is the out-of-band worker brief
feature (commit 5383bdc, epic fn-5-content-blind-orchestrator), which made
the claim/resume envelope carry a `brief_ref` handle instead of inlining the
`prompt` prose. The test file is half-migrated (some assertions already
expect `brief_ref` and `"prompt" not in payload`; the failing ones still
expect the old `prompt`/field set), so test and envelope are out of sync.
NOT related to the fn-756 approval strip.

## Quick commands

- `cd ~/code/planctl && uv run pytest tests/test_worker_resume.py -q` → green
- `cd ~/code/planctl && uv run pytest -q` → full suite green

## Acceptance

- [ ] All 4 `test_worker_resume.py` tests pass and the full planctl suite is green, with the resume envelope contract (brief_ref vs prompt) consistent between `run_worker_resume.py` and the tests.
