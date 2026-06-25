## Description

**Size:** M
**Files:** plugins/plan/src/runtime_status.ts, plugins/plan/src/verbs/resolve_task.ts, plugins/plan/src/verbs/worker_resume.ts, plugins/plan/src/verbs/reconcile.ts, plugins/plan/CLAUDE.md, plugins/plan/test/src-api-spine.test.ts

### Approach

Make the plan verbs honor a `KEEPER_PLAN_WORKTREE` env override (set by task
`.1`) so a worktree-mode worker's `target_repo`, `primary_repo`, AND
`state_repo` all resolve to the lane. Add a small env-reading helper
mirroring the existing `clockOverride`/`getActor` precedent
(`plugins/plan/src/store.ts:358-361`, `:423-424`); treat empty-string as
absent (fall through to the existing 3-level fallback). `target_repo` flows
through `expectedWorkerCwd` (`runtime_status.ts:10`) — apply the override
there. CRITICAL: `primary_repo`/`state_repo` are NOT computed via
`expectedWorkerCwd` — they are inline `realpathOr(epicDef.primary_repo||projPath)`
at `resolve_task.ts:110`, `worker_resume.ts:106-109`, `reconcile.ts:292-295`
— apply the override at all three so state writes (`keeper plan done`/`block`,
which route to `PRIMARY_REPO`) land in the lane. `expectedCloserCwd`
(`runtime_status.ts:24`) has NO production caller — find the closer's REAL
repo-resolution seam (the closer either relies solely on `launchCwd`, already
overridden by `.1`, or re-resolves via `reconcile`/`expectedWorkerCwd`) and
wire the override at the actual seam; do NOT patch a dead function. Update the
`runtime_status.ts` purity docstring (the Python-parity note is stale — the
TS dispatcher is the sole runtime) and add `KEEPER_PLAN_WORKTREE` to
`plugins/plan/CLAUDE.md` "Environment variables".

### Investigation targets

**Required** (read before coding):
- plugins/plan/src/runtime_status.ts:10-29 — expectedWorkerCwd + expectedCloserCwd (and its callers, or lack thereof)
- plugins/plan/src/verbs/resolve_task.ts:108-128 — inline target_repo/primary_repo, emit site
- plugins/plan/src/verbs/worker_resume.ts:105-109, 176-177 — inline primary_repo/state_repo, emit site
- plugins/plan/src/verbs/reconcile.ts:290-314 — stateRepo + the scanRepos set (source-commit scan)
- plugins/plan/src/store.ts:358-361, 423-424 — clockOverride/getActor env-helper precedent

**Optional** (reference as needed):
- plugins/plan/template/agents/worker.md.tmpl:55 — brief identity check (target_repo must match TARGET_REPO env)

### Risks

- Overriding only `expectedWorkerCwd` leaves `primary_repo`/`state_repo` on main -> state writes still collide. Must cover all three.
- Patching `expectedCloserCwd` (no caller) would be a silent no-op — find the real closer seam.
- Reading env in the documented-pure helper breaks its purity contract — follow the impure-helper precedent and correct the docstring.
- Brief identity mismatch (worker.md.tmpl:55) if any resolution runs without the env in scope.

### Test notes

Pure unit only — NO real git. Mirror plugins/plan/test/src-api-spine.test.ts:63-77:
set/restore `process.env.KEEPER_PLAN_WORKTREE` around assertions; verify
target_repo + primary_repo + state_repo all resolve to the lane when set, and
fall through to the 3-level fallback when unset/empty.

## Acceptance

- [ ] With `KEEPER_PLAN_WORKTREE` set, `target_repo`, `primary_repo`, and `state_repo` all resolve to the lane in resolve_task / worker_resume / reconcile.
- [ ] Empty / unset `KEEPER_PLAN_WORKTREE` -> byte-identical to today's 3-level fallback.
- [ ] The closer's actual repo-resolution seam honors the override (no dead-function patch).
- [ ] `KEEPER_PLAN_WORKTREE` documented in plugins/plan/CLAUDE.md; the stale purity docstring corrected.
- [ ] Pure-unit tests cover set + unset; no real-git test.

## Done summary
Plan verbs honor KEEPER_PLAN_WORKTREE: resolve-task/worker-resume/reconcile resolve target_repo, primary_repo, and state_repo to the lane when set, falling through to the 3-level fallback when empty/unset. Closer stays cwd-bound via resolveProject (no dead-function patch). Docstring corrected, CLAUDE.md updated, pure-unit tests added.
## Evidence
