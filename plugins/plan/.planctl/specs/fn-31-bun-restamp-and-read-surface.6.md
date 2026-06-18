## Description

**Size:** M
**Files:** src/verbs/ task_set_tier.ts, task_set_description.ts, task_set_acceptance.ts, task_set_target_repo.ts, task_reset.ts, epic_set_branch.ts, epic_set_title.ts, epic_set_primary_repo.ts, epic_set_touched_repos.ts, epic_invalidate.ts, epic_queue_jump.ts, epic_add_dep.ts, epic_add_deps.ts, epic_rm_dep.ts (all new), src/cli.ts, test/ additions

### Approach

Fourteen verbs on the shared pipeline from the restamp task — per-verb code is gate + apply callbacks, never a re-implementation of the sequence. Non-restamp writes (set-tier with the TASK_TIERS gate, set-branch, set-title) go straight through the mutating seam. Warn-and-write pair (set-primary-repo/set-touched-repos): _validateRepoPath warnings into the envelope + WARN: stderr, exit 0, then restamp. set-description/set-acceptance ride readFileOrStdin + patchTaskSection. set-target-repo uses the pre-restamp hook to recompute epic.touched_repos from the union of direct-child target_repos. task reset clears runtime to todo under the task lock, empties the Done summary/Evidence sections, nulls worker_done_at, honors --cascade via findDependents. invalidate/queue-jump implement the short-circuit pattern (readonly envelope when already null/true, no commit; else write + mutating emit with queue_jump=true riding the invocation for queue-jump). add-dep resolves via resolveEpicGlobally (ambiguous → error), normalizes fn-N to the full slug, and uses the rollback hook on introduced cycles. add-deps implements the assert-all classifier with the exact error-priority order, --skip-invalid diversion to SKIPPED_* result statuses, ALREADY_PRESENT/WIRED idempotency, pre-write detectCycles over the global+local graph, write only when new edges exist. rm-dep is the idempotent remove + restamp.

### Investigation targets

**Required** (read before coding):
- tests/test_restamp_verbs.py — the pins these verbs satisfy
- planctl/run_epic_add_deps.py — classifier priority and results envelope
- planctl/run_task_set_target_repo.py and run_task_reset.py — the two hook consumers
- src/validation_restamp.ts — the landed pipeline and hook contract

**Optional** (reference as needed):
- planctl/run_epic_invalidate.py / run_epic_queue_jump.py — short-circuit branches
- planctl/run_epic_add_dep.py — rollback mechanics

### Risks

Drift across fourteen similar verbs is the failure mode the shared pipeline exists to prevent — any verb that needs an escape hatch beyond the two sanctioned hooks signals a pipeline design gap; fix the pipeline, don't fork.

### Test notes

test_restamp_verbs.py green against the compiled binary incl. the fail-forward and rollback cases; fast gate untouched.

## Acceptance

- [ ] All fourteen verbs green in tests/test_restamp_verbs.py via dist/planctl-bun
- [ ] Restamp members share one pipeline; the two hooks are the only special cases
- [ ] add-deps classifier order and result statuses exact; short-circuit branches produce zero commits

## Done summary
Ported the 14 epic/task editing verbs (setter family, dep editors, short-circuit invalidate/queue-jump) onto the shared restamp pipeline in planctl-bun. All 29 restamp conformance tests green against the compiled binary, serial and parallel; authority statement + gate rows + README scope phrases updated.
## Evidence
