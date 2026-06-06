## Description

**Size:** S
**Files:** (measurement + report only — no production code; findings land in this task's Done summary/Evidence)

Re-measure the heavy pair against the locked baseline, confirm the
regression oracle, and record a GO/NO-GO verdict for the full 14-file
sweep with concrete numbers. This is the epic's deliverable.

### Approach

Run and capture timings:
- Oracle: `uv run pytest -q` — must be all-green (note the pass/skip
  counts; they shift from the 792/2 baseline as tests were added/converted).
- Heavy-pair full: `time uv run pytest -n0 -q tests/test_scaffold.py tests/test_set_snippets_bundles.py` (baseline ~48s).
- Heavy-pair fast-gate slice: `time uv run pytest -n0 -q -m "not integration" tests/test_scaffold.py tests/test_set_snippets_bundles.py` (proof target <5s).
- Optional: `-n auto` variants for parallel numbers.

Write into Done summary / Evidence: before/after timings, the final
pass/skip counts, any seed_state fidelity findings (did a converted test
reveal tree-shape drift? did the test_scaffold fallback fire?), and a
one-paragraph GO/NO-GO recommendation for the full sweep. GO if seed_state
proved faithful and the fast-gate slice hit target; NO-GO/qualified if
fidelity gaps or conversion friction surfaced — name them so the sweep epic
can encode them.

### Investigation targets

**Required** (read before coding):
- ~/docs/2026-06-06-fast-test-suites/planctl.md — the charter's baseline numbers to compare against
- This epic's tasks .1-.3 Done summaries — fidelity findings + whether the fallback fired

### Risks

- **Don't start the sweep.** This task STOPS at the verdict. The full
  sweep is a separate epic, planned only on a GO.

### Test notes

Pure measurement; the "test" is that the oracle is green and the numbers
are recorded honestly (including a NO-GO if that is what the data says).

## Acceptance

- [ ] `uv run pytest -q` confirmed all-green with final counts recorded.
- [ ] Before/after timings for the heavy pair (full + fast-gate slice) recorded in Evidence.
- [ ] A written GO/NO-GO verdict for the full sweep with named fidelity findings is in the Done summary.
- [ ] No sweep work started.

## Done summary

## Evidence
