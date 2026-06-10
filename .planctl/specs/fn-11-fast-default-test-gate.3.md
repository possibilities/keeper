## Description

**Size:** S
**Files:** pyproject.toml, CLAUDE.md, tests/ (only if pruning fires)

### Approach

Measure the triaged fast gate empirically: `time uv run pytest tests/ -q`
at `-n 0`, `-n 2`, `-n 4`, `-n auto`, each 3 runs, on the loaded dev
machine. Pick the fastest stable shape; consider `--dist=loadscope` if
module-scoped fixture reuse shows up in the numbers. Worker bring-up
costs 2-5s under load, so a now-cheap suite may beat `-n auto` at a small
fixed `-n` or serial. Keep `--timeout=30` (it guards the slow bucket via
the same addopts; do not split configs).

Update docs: replace the CLAUDE.md Running Things `Test` row in place
with the fast row and a full-suite row (`uv run pytest tests/ --run-slow`);
revise the pyproject `[tool.pytest.ini_options]` inline comment to
describe the current shape (present-tense, no backward-facing prose).

If the measured fast gate still exceeds ~5s under load after tuning,
apply the sanctioned second lever: prune/parametrize-sample redundant
matrices (the 14-verb restamp suite in test_validate_marker.py is the
named candidate — sample representative verbs, keep the canonical-list
assertion against VALIDATION_RESTAMP_VERBS so a new verb still gets
coverage). Name every pruned test and the value lost in the Done summary.
Do not prune if the target is already met.

### Investigation targets

**Required** (read before coding):
- pyproject.toml:18-29 — current addopts + the inline comment to revise
- CLAUDE.md Running Things table — the row to replace in place

**Optional** (reference as needed):
- tests/test_validate_marker.py — the restamp matrix structure, only if pruning fires
- planctl/validation_restamp.py — VALIDATION_RESTAMP_VERBS canonical list

### Risks

- Tuning on a momentarily-quiet machine picks a worker count that
  regresses under real load — take the 3-run spread under typical
  multi-agent load, not a best case.
- Pruning the restamp matrix could drop the one verb that regresses
  later — keep at least the canonical-list completeness assertion.

### Test notes

Final numbers in the Done summary: fast-gate wall time (median of 3 under
load) at the chosen `-n`, total tests run/skipped, spawn count. Both
gates green at the chosen config.

## Acceptance

- [ ] Worker count chosen from measured medians (numbers recorded), addopts updated
- [ ] Fast gate <5s best-effort confirmed on the loaded dev machine (or the gap + pruning decision documented)
- [ ] CLAUDE.md Running Things has fast + full rows; pyproject comment matches reality
- [ ] Any pruning names each removed test and the value lost

## Done summary

## Evidence
