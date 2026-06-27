## Description

**Size:** S
**Files:** plugins/plan/src/verbs/reconcile.ts, plugins/plan/src/verbs/resolve_task.ts, plugins/plan/src/verbs/worker_resume.ts, plugins/plan/CLAUDE.md, plugins/plan/test/saga-reconcile.test.ts, plugins/plan/test/saga-worker-resume.test.ts, plugins/plan/test/saga-validate-resolve.test.ts

### Approach

Remove `worktreeOverride()` (reads KEEPER_PLAN_WORKTREE) from the `primaryRepo`/`stateRepo` resolution in
the three plan verbs — plan STATE always lives in the primary repo, never the lane worktree. Mirror the
already-correct pattern in close_finalize.ts:428-430: `primaryRepo = realpathOr((epicDef.primary_repo) || projPath)`.
`stateRepo` is a plain alias of `primaryRepo` (reconcile.ts:297, worker_resume.ts:111), so fixing primaryRepo
fixes it automatically — verify the alias remains. PRESERVE the lane `targetRepo` resolution (it correctly
uses `worktreeOverride()` via `expectedWorkerCwd` for lane isolation) — do NOT touch that.

Verify worktree-mode epics carry `primary_repo` = main so the fix actually fires: removing the override
leaves `primaryRepo = epicDef.primary_repo || projPath`; if a verb ran from the lane cwd with a null
`primary_repo`, `projPath` would still be the lane (no-op fix). Confirm worktree epics always have
`primary_repo` populated (they do at scaffold) and/or the verbs' project context is main.

Fix the doc drift: plugins/plan/CLAUDE.md ## Environment variables KEEPER_PLAN_WORKTREE entry — narrow
from "target/primary/state all resolve to the lane (resolve-task/worker-resume/reconcile)" to **target_repo only**.

### Investigation targets

**Required:**
- plugins/plan/src/verbs/reconcile.ts:291-297 (primaryRepo + stateRepo alias), resolve_task.ts:109-114, worker_resume.ts:105-111 — the three to fix
- plugins/plan/src/verbs/close_finalize.ts:428-430 — the correct pattern to mirror
- plugins/plan/src/runtime_status.ts:13-35 — `worktreeOverride` (KEEP for `expectedWorkerCwd`/targetRepo)
- plugins/plan/CLAUDE.md ## Environment variables — the KEEPER_PLAN_WORKTREE entry to narrow

### Risks

- projPath fallback: if any verb runs with cwd=lane and a null-`primary_repo` epic, state still resolves to the lane → fix is a silent no-op. Verify primary_repo is populated for worktree epics.
- No 4th `worktreeOverride()` caller for primary/state (grep confirms exactly these 3 verbs + expectedWorkerCwd).

### Test notes

Fast in-process tier: plugins/plan/test/saga-{reconcile,validate-resolve,worker-resume}.test.ts via `runCli`
with a per-call `env` override `{ KEEPER_PLAN_WORKTREE: "/lane" }`; assert `primary_repo` (and `state_repo`)
resolve to the MAIN repo while `target_repo` follows the lane.

## Acceptance

- [ ] `worktreeOverride()` removed from primaryRepo/stateRepo in reconcile.ts, resolve_task.ts, worker_resume.ts (mirror close_finalize.ts)
- [ ] Lane `target_repo` resolution preserved (still uses the override via expectedWorkerCwd)
- [ ] With KEEPER_PLAN_WORKTREE set, the 3 verbs resolve plan-state to the primary repo, target to the lane (fast-tier tests)
- [ ] plugins/plan/CLAUDE.md KEEPER_PLAN_WORKTREE entry narrowed to target_repo only
- [ ] `ty` clean; `bun test` green; committed via keeper commit-work

## Done summary
Removed KEEPER_PLAN_WORKTREE override from primaryRepo/stateRepo resolution in reconcile/resolve-task/worker-resume so plan state always resolves to the primary repo (mirrors close_finalize); target_repo still follows the lane. Narrowed the CLAUDE.md doc and added fast-tier coverage.
## Evidence
