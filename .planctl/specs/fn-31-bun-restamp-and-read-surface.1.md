## Description

**Size:** M
**Files:** tests/test_query_verbs.py (new), tests/fixtures/golden/ (new, captured corpus + regeneration note)

### Approach

Author the engine-agnostic spec for the read surface before any bun code, proven against Python in both engines. seed_state + monkeypatch.chdir + run_cli only. Coverage: show (task and epic branches incl. task_summary and merged runtime), cat (raw markdown byte-out, --format ignored, no trailer, missing-spec error to stderr exit 1), list (tree human renderer — golden-pinned), ready (ready/in_progress/blocked classification with met/unmet deps), tasks (--epic/--status filters, sort order incl. unparseable-id-sorts-last), resolve-task (typed errors BAD_TASK_ID/TASK_NOT_FOUND/AMBIGUOUS_TASK_ID/NOT_A_PROJECT, tier as explicit null when unset, 3-level target_repo fallback, multi-project ambiguity via seed_state into two project dirs + set_roots), refine-context read path (envelope with epic_spec_md and tasks list, empty-string spec when absent, typed errors), validate whole-project (root checks, {valid,errors,warnings} envelope, exit 1 on invalid, no trailer) and validate --epic (None→timestamp stamp + second compact invocation line + commit, already-stamped pure no-op, frozen PLANCTL_NOW stamp equality). Golden fixtures for the list renderer and a representative integrity error/warning set captured from the real Python binary under LC_ALL=C, committed with a regeneration recipe in the module docstring.

### Investigation targets

**Required** (read before coding):
- planctl/run_show.py, run_cat.py, run_list.py, run_ready.py, run_tasks.py, run_resolve_task.py, run_refine_context.py, run_validate.py — the envelope shapes being pinned
- tests/test_readonly_verbs.py and tests/test_worker_verbs.py — established engine-agnostic idioms
- tests/conftest.py set_roots — the multi-root fixture mechanism under conformance

**Optional** (reference as needed):
- planctl/integrity.py — error strings for the validate-invalid fixtures
- planctl/api.py — task_sort_key/load helpers backing refine-context

### Risks

Golden capture from a live binary can embed absolute tmp paths — fixtures must be seeded at deterministic relative locations or the goldens parameterized; capture under frozen PLANCTL_NOW where timestamps appear.

### Test notes

Green three ways: default engine, PLANCTL_BIN=python planctl, full fast gate unchanged.

## Acceptance

- [ ] All eight query verbs covered incl. error paths, multi-root ambiguity, validate stamp state-machine, golden-pinned renderer output
- [ ] Green in default engine and against Python via PLANCTL_BIN; no existing test touched
- [ ] Golden corpus committed with documented regeneration

## Done summary
Authored tests/test_query_verbs.py: engine-agnostic spec for the read-surface verbs (show/cat/list/ready/tasks/resolve-task/refine-context/validate) with golden-pinned list renderer + integrity errors. Green in both engines; fast gate unchanged.
## Evidence
