## Description

**Size:** M
**Files:** src/commit_lookup.ts (new), src/verbs/reconcile.ts (new), src/verbs/find_task_commit.ts (new), src/verbs/worker_resume.ts (new), src/cli.ts, test/ additions

### Approach

The git-reading quartet. commit_lookup.ts: per-repo two-stage scan — `git log --grep="Task: <id>" -F --pretty=%H` prefilter then per-sha `%B` piped through `git interpret-trailers --parse` confirming an exact Task trailer match; touched_repos tri-state; single broken repo → stderr note + skip; AllReposBrokenError only when all broken; clean miss → empty result; pure (returns or throws, never emits). find-task-commit: flat keeper envelope {success, commits:[{sha,repo}]} with the typed error set. reconcile: the OTHER trailer technique — `git log --format=%H%x1f%(trailers:key=Task,valueonly=true)` with unit-separator split and exact equality; _GitError fail-closed (ANY unexpected git failure → tooling_error verdict); raw-run variant for expected-non-zero (unborn HEAD); state_head_visible via cat-file blob against the state repo; the pure verdict truth table; read-only emit. worker resume: tolerant git state reads (status --short, diff HEAD --stat), source-commit probe returning null on any failure, brief regeneration via the landed brief module, work marker, stderr Note: lines, plain emit_error shape. bun units include the 4-way trailer round-trip: commits written by the Python engine and by the bun engine, each read back through both engines' lookup paths.

### Investigation targets

**Required** (read before coding):
- planctl/commit_lookup.py and run_reconcile.py — both trailer techniques, fail-closed contract, truth table
- planctl/run_find_task_commit.py and run_worker_resume.py — envelopes and tolerances
- tests/test_reconcile.py, test_find_task_commit.py, test_worker_resume.py — the pins (real_git/real_roots markers; one python_only in worker_resume)
- src/commit.ts — the trailer format the landed writer produces (the round-trip's other half)

### Risks

The two trailer techniques produce the same logical answer via different git invocations — porting one and reusing it for both breaks real_git tests that pin exact git behavior. Fail-closed means fail-closed: a missing git binary must yield tooling_error, never a clean verdict.

### Test notes

PLANCTL_BIN=dist/planctl-bun against the three test files green (--run-slow for real_git portions); 4-way round-trip in bun units.

## Acceptance

- [ ] All four surfaces green in their test files via the compiled binary
- [ ] Both trailer techniques ported; 4-way round-trip proven; fail-closed verified

## Done summary

## Evidence
