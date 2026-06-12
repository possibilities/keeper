## Description

**Size:** M
**Files:** CLAUDE.md, AGENTS.md, README.md, test pins only if proven wrong against Python

### Approach

Drive the broadened gate: PLANCTL_BIN=dist/planctl-bun against the full set of now-eligible files — the five prior conformance modules plus test_creation_verbs.py, test_refine_apply.py, test_epic_rm.py, test_multi_repo_create_validate.py, test_envelope_shape.py, test_seed_state.py, and the unpoisoned portions of test_task_set_tier/test_resolve_task/test_refine_context/test_run_epic_queue_jump/test_cross_project_epic_deps — serially and with -n, plus the --run-slow conformance pass covering test_scaffold.py and the real_git residue. Evaluate whether the gate row can collapse to the full-suite `PLANCTL_BIN=... uv run pytest tests/ [--run-slow]` shape with remaining close-saga surfaces and python_only skipping visible — if the skip noise is acceptable, collapse it; record what still fails-by-design (close-saga verbs) so the row stays truthful. Fix fallout in src/. Docs: authority statements and gate rows revised in place, mirrors together.

### Investigation targets

**Required** (read before coding):
- CLAUDE.md + AGENTS.md authority bullets and gate rows; README.md:16/:34/:55

### Risks

The full-suite collapse may surface close-saga test files that error (not skip) against the bun binary — if so, keep an explicit file list this wave and leave the collapse to the close-saga epic.

## Acceptance

- [ ] Broadened gate green (serial, -n, and --run-slow passes); residue documented as skips, not failures
- [ ] Docs revised in place, mirrors in sync, gate rows truthful

## Done summary

## Evidence
