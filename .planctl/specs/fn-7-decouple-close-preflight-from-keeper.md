## Overview

`planctl close-preflight` builds its `commit_groups` field — the commit set the `/plan:close` quality-auditor reviews — by scanning git for each task's `Task:` trailer. This epic moves that scan in-process: a new shared module `planctl/commit_lookup.py` performs the `git log --grep` + `git interpret-trailers --parse` archaeology over the epic's `touched_repos`, and `run_close_preflight` consumes it. The dead `keeper-py` package dependency (declared in `pyproject.toml`, imported nowhere) is pruned at the same time. End state: the planctl Python package has zero `import keeper` and zero subprocess to the `keeper` CLI — `close-preflight`'s envelope (`commit_groups: [{repo, shas}]`, `COMMIT_LOOKUP_FAILED` fail-loud) is byte-identical to today.

## Quick commands

- `uv run pytest tests/test_close_preflight.py -q` — the rewired close-preflight suite passes
- `grep -rn '"keeper"' planctl/ ; echo "exit=$?"` — exit 1 (no `keeper` subprocess literal anywhere in planctl Python)
- `grep -rn "keeper-py\|keeper_py" pyproject.toml uv.lock ; echo "exit=$?"` — exit 1 (dependency fully pruned)
- `uv run ty check && uv run ruff check .` — types + lint clean after the prune

## Acceptance

- [ ] `commit_groups` is assembled by `planctl/commit_lookup.py` (native git), not a `keeper` subprocess
- [ ] `close-preflight` envelope shape and `COMMIT_LOOKUP_FAILED` semantics are unchanged for the auditor
- [ ] `keeper-py` removed from `pyproject.toml` (3 stanzas) and `uv.lock`; `uv sync` no longer needs `../keeper`
- [ ] all four stale `keeper find-task-commit` docstrings/doc-lines rewritten present-tense (no backward-facing advice)
- [ ] worker-runbook keeper references left untouched (out of scope)

## Early proof point

Task that proves the approach: `.1` — the native scan must reproduce keeper's grouping + fail-loud parity under the rewired tests. If it fails: keep the `keeper find-task-commit` subprocess in `_commit_groups` and ship only the `commit_lookup.py` module + unit tests, deferring the rewire.

## References

- `../keeper/cli/find-task-commit.ts` and `../keeper/src/commit-work/trailers.ts` (`loadTrailers` / `hasRealTaskTrailer`) — the reference implementation whose two-stage semantics the native port reproduces. This logic originated in Python (jobctl's `run_find_task_commit.py`).
- `planctl/run_worker_resume.py:42-69` (`_find_source_commit_sha`) — the existing `git log --grep ... --fixed-strings` idiom the native scan generalizes.
- **Reverse dependency — `fn-6`** (reconcile verdict verb, open / all tasks todo): its `.1` task plans a native-git trailer finder in `run_reconcile.py`; it should import `planctl/commit_lookup.py` rather than reimplement. Advisory only — no shared files, no hard dep edge. The module's API (return-data / raise-typed-exception, no `sys.exit`) is the load-bearing seam fn-6 consumes.
- **Plan 2 (follow-up, to be planned after this lands):** a public `planctl find-task-commit` verb wrapping `commit_lookup.py`, migration of the worker runbook (`skills/work/SKILL.md`) off `keeper find-task-commit`, and removal of keeper's verb. Deliberately not scaffolded yet — it will be planned against the real `commit_lookup.py` API once this epic is done.
