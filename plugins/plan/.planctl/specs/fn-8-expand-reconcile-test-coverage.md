## Overview

Two behavioral gaps remain in `tests/test_reconcile.py` after fn-6 shipped: the
comma-split `Task:` trailer parsing branch and the multi-repo source scan path
are both untested. If either regresses, the reconcile verb emits a wrong verdict
(`not_started` instead of `done`) and the orchestrator spuriously resumes a
finished worker.

## Acceptance

- [ ] A test exercises the `Task: fn-N.1, fn-N.2` single-line comma-separated
      trailer and asserts both task ids are matched by `_find_source_commits`
- [ ] A test exercises a cross-repo setup (`target_repo != state_repo`) and
      asserts a commit in `target_repo` with the correct `Task:` trailer produces
      a `done` verdict
- [ ] All existing tests continue to pass

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F4 | kept | .1 | Real parsing gap on comma-split trailer; wrong verdict if this branch regresses |
| F5 | kept | .2 | Supported cross-repo feature with zero test coverage; wrong verdict on any cross-project task |
| F1 | culled | — | Doc style nit, no user impact; present-tense context makes forward intent clear |
| F2 | culled | — | Intentional behavior, never consumed on tooling_error path, no user impact |
| F3 | culled | — | Mirror of run_resolve_task AMBIGUOUS path which is already tested |

## Out of scope

- AMBIGUOUS_TASK_ID test coverage (mirrors a path already tested in run_resolve_task)
- source_commits schema doc annotation (intentional behavior, no user impact)
- CLAUDE.md tombstone phrasing fix (style nit only)
