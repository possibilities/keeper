## Description

**Size:** S
**Files:** tests/test_worker_resume.py, planctl/run_worker_resume.py (only if the envelope is genuinely wrong), planctl/brief.py (reference)

### Approach

The brief feature (commit 5383bdc) swapped the resume envelope's inlined
`prompt`/spec prose for a single `brief_ref` handle (absolute path) plus a
one-line `nudge`. `run_worker_resume.py` already emits the new shape
(`brief_ref` + `nudge` + repos, content-blind). Part of
`tests/test_worker_resume.py` was migrated to expect that (it asserts
`brief_ref` is absolute/exists and `"prompt" not in payload`), but the 4
failing tests still assert the old field set (e.g. `payload.keys() >=
{'prompt','spec','task_id','tier'}`). First CONFIRM the new envelope is the
intended contract by reading `run_worker_resume.py` + `brief.py` + the
already-migrated assertions; the overwhelmingly likely fix is that the 4
tests are stale — update their expected key sets / field assertions to the
`brief_ref` + `nudge` envelope (drop `prompt`). Only touch
`run_worker_resume.py` if you find a genuine envelope regression (a field
the migrated tests rely on that the emitter doesn't produce). Run the file,
then the full suite, to confirm no collateral.

### Investigation targets

**Required** (read before coding):
- tests/test_worker_resume.py:87-100, :282-287 — the already-migrated brief_ref assertions (the target shape) vs the 4 stale ones
- planctl/run_worker_resume.py:1-10, :78-120 — the content-blind resume envelope (brief_ref + nudge) the emitter actually produces
- planctl/run_claim.py:368, :400 — `brief_ref = write_brief(...)`; the claim-path envelope the resume path is byte-uniform with

**Optional** (reference as needed):
- planctl/brief.py — assemble_brief / write_brief, the brief contract

## Acceptance

- [ ] `uv run pytest tests/test_worker_resume.py` — all 4 previously-failing tests pass.
- [ ] `uv run pytest` — full planctl suite green (no collateral regressions).
- [ ] The fix lands on the correct side: tests updated to the brief_ref envelope (default), OR a named envelope regression fixed in run_worker_resume.py with rationale in Done summary.

## Done summary

## Evidence
