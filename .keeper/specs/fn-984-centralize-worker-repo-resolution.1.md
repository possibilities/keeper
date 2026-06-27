## Description

**Size:** M
**Files:** plugins/plan/src/runtime_status.ts, plugins/plan/src/verbs/claim.ts, plugins/plan/src/verbs/resolve_task.ts, plugins/plan/src/verbs/worker_resume.ts, plugins/plan/src/verbs/reconcile.ts, plugins/plan/test/saga-*.test.ts

### Approach

Extract one canonical resolver in runtime_status.ts — e.g. `resolveWorkerRepos(task, epic, proj)` returning `{ targetRepo, primaryRepo }`, where targetRepo is override-aware (`worktreeOverride() || task.target_repo || epic.primary_repo || proj`) and primaryRepo is ALWAYS `epic.primary_repo || proj` (never the lane). Keep `expectedWorkerCwd` as the override reader the seam calls (so the KEEPER_PLAN_WORKTREE doc reference stays valid), but make the raw 3-level chain PRIVATE to the module so no verb re-derives it. Route the four runtime emitters through the seam. Normalize ONCE inside the seam: pick `realpathOr` (used by 3 of the 4 today) and fold claim's `resolveExpand` into it — without changing the value the worker's pwd check compares against.

### Investigation targets

**Required** (read before coding):
- plugins/plan/src/runtime_status.ts:13-47 — expectedWorkerCwd / worktreeOverride / expectedCloserCwd; home of the new seam.
- plugins/plan/src/verbs/claim.ts:200-205 — current `resolveExpand(expectedWorkerCwd(...))` + primary_repo.
- plugins/plan/src/verbs/resolve_task.ts:109-115, worker_resume.ts:105+, reconcile.ts:291-294 — the other three emitters (realpathOr).
- plugins/plan/test/saga-claim.test.ts:130 (+ saga-worker-resume / saga-validate-resolve / saga-reconcile) — the override tests to mirror and keep green.

**Optional** (confirm exclusion):
- plugins/plan/src/verbs/{close_preflight,show,scaffold,refine_apply,mv_repo,task_set_target_repo}.ts — CONFIRM these stay on persisted/raw resolution and are NOT routed through the override seam.

### Risks

- Over-routing: close_preflight / show / scaffold / refine_apply / mv_repo / task_set_target_repo read or persist target_repo; routing them through the lane override would write a lane path into plan state or the audit brief — a NEW bug in the other direction. Explicitly exclude them.
- Normalization drift: claim's resolveExpand vs the others' realpathOr must converge on ONE without changing the worker's pwd-match value.

### Test notes

Mirror the existing saga-* override cases against the centralized seam: every routed consumer honors KEEPER_PLAN_WORKTREE (target_repo -> lane) and keeps primary_repo on the primary repo even with the override set. Default `bun test` stays pure. typecheck + lint green.

## Acceptance

- [ ] runtime_status.ts exposes one resolver returning {targetRepo (override-aware), primaryRepo}; the raw 3-level fallback is private to the module.
- [ ] claim, resolve_task, worker_resume, reconcile all call it; no verb re-derives the fallback chain.
- [ ] close_preflight, show, scaffold, refine_apply, mv_repo, task_set_target_repo are confirmed NOT routed (persistence/report paths).
- [ ] saga-claim / saga-worker-resume / saga-validate-resolve / saga-reconcile pass unchanged; typecheck + lint green.

## Done summary
Centralized worker repo resolution into one runtime seam (resolveWorkerRepos in runtime_status.ts); claim/resolve_task/worker_resume/reconcile route through it, the 3-level fallback is now module-private, and the six persistence verbs stay unrouted. Existing override tests green, default bun test stays pure.
## Evidence
