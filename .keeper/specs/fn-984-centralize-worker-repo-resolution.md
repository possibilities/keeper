## Overview

Worktree mode failed repeatedly because every plan verb emitting a worker's `target_repo` independently rebuilt the override-aware resolution, and whichever consumer was missed silently dropped the `KEEPER_PLAN_WORKTREE` lane override (most recently `claim`, the /plan:work entry point — fixed by commit a4e54744). This epic collapses that resolution into ONE seam in `plugins/plan/src/runtime_status.ts` that every runtime emitter routes through, and adds an opt-in real-git test that drives the full lane cycle — coverage the pure fast tier structurally cannot provide. End state: one resolver returns the `{target_repo (override-aware), primary_repo}` pair, the raw fallback is private to that module, and a slow-tier test proves provision -> claim-in-lane -> commit-to-lane -> merge -> teardown.

## Quick commands

- `cd plugins/plan && bun test` — fast tier stays green (override regression net: saga-claim / saga-worker-resume / saga-validate-resolve / saga-reconcile)
- `cd plugins/plan && bun run test:slow` — runs the new real-git worktree-lifecycle test (KEEPER_PLAN_RUN_SLOW=1)
- `cd plugins/plan && bun run typecheck && bun run lint`

## Acceptance

- [ ] Exactly one resolver in runtime_status.ts returns the {target_repo (override-aware), primary_repo} pair; the raw 3-level fallback is private to that module.
- [ ] The four runtime emitters (claim, resolve_task, worker_resume, reconcile) route through it; no verb re-derives the fallback.
- [ ] The six persistence/report sites (scaffold, refine_apply, mv_repo, task_set_target_repo, close_preflight, show) are confirmed NOT routed — a lane path must never persist into plan state.
- [ ] The existing override tests pass unchanged and the default `bun test` stays pure (no real git).
- [ ] A slow-tier test drives the real lane cycle and asserts work lands on the lane, merges to main, and teardown is clean — including the polluted-GIT_*-env scenario.

## Early proof point

Task that proves the approach: `.1` (the seam + routed emitters with the existing override tests green). If it fails: the runtime-vs-persistence split or the normalization is wrong — re-confirm which sites are lane-aware before writing the slow test.

## References

- Builds on commit a4e54744 (the claim override fix this epic generalizes into one seam).
- Override semantics: plugins/plan/CLAUDE.md `## Environment variables` (KEEPER_PLAN_WORKTREE moves target_repo only; plan state stays primary).
- Closest existing real-git analogue: plugins/plan/test/src-commit.test.ts "worktree-lane isolation" (slow tier).

## Docs gaps

- **plugins/plan/CLAUDE.md**: extend the `## Running Things` `test:slow` row to cover the worktree-lifecycle test ONLY if the existing wording is too src-commit-specific. The root CLAUDE.md / README test-isolation invariant stays UNCHANGED — Task 2 lives in the plan plugin's already-carved-out slow tier, so the root "one pure tier" rule is not weakened.
