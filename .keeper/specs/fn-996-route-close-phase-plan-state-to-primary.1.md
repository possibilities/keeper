## Description

**Size:** S
**Files:** plugins/plan/src/verbs/close_preflight.ts, plugins/plan/agents/quality-auditor.md, plugins/plan/agents/close-planner.md, plugins/plan/test/* (new + updated)

### Approach

Two coordinated changes so the whole close-orchestrator chain
(preflight -> audit -> verdict -> followup) resolves plan-state to primary while
the close runs from a lane.

1. **close-preflight self-resolves plan-state to primary.** `runClosePreflight`
already computes `primaryRepo` from `epicDef.primary_repo` (close_preflight.ts:124-126)
and already uses it for the commit scan (`findCommitGroups`, :157) and the brief
write (`writeBriefArtifact(primaryRepo, …)`, :195). The ONLY lane-leaking reads are
the task done-state merge: `loadTasksForEpic(ctx, …)` (:130) + `doneSummary(ctx.dataDir, …)`
(:192) use the cwd-resolved `ctx` (= the lane). Build a primary-rooted context once
via `contextForRoot(primaryRepo)` (project.ts:62-70) and use IT for ALL plan-state
reads in preflight (the done-state merge AND any other state-bound read). PREFER the
holistic shape — resolve one primary ctx and route every state op through it — over a
surgical one-line move: the recurring failure in this saga is fixing one seam and
missing a sibling, so a single primary-rooted state ctx is the robust shape. Keep the
`--project` branch (:110-112) working for the non-worktree path; when cwd==primary,
`contextForRoot(primaryRepo)` is identical to the cwd ctx (a no-op). Keep the def load
as-is (epic/task JSON are committed, so identical in lane + primary) and the
commit-scan / brief-write on primary (already are). Do NOT route preflight through
`resolveWorkerRepos` — runtime_status.ts:63-65 forbids it (its targetRepo half would
persist a lane path into `brief.primary_repo`); use the primary half / contextForRoot.

2. **audit/verdict/followup submit get `--project "$PRIMARY_REPO"` from their
callers.** The submit verbs already self-resolve correctly when given `--project`
(submit_common.ts:160-180), the CLI wiring exists (cli.ts:605,636,667), and the
agents already hold `PRIMARY_REPO` (quality-auditor.md:17, close-planner.md:19). Add
`--project "$PRIMARY_REPO"` to the three submit invocations: quality-auditor.md:206
(audit submit), close-planner.md:114 (verdict submit), close-planner.md:199 (followup
submit). Pure prompt-file edits — no TS change to the submit verbs. The brief they
read is now in primary (preflight writes it there), so the chain is coherent. Verify
the exact line anchors before editing (markdown can drift).

### Investigation targets

**Required** (read before coding):
- plugins/plan/src/verbs/close_preflight.ts:110-160, :185-196 (the cwd `ctx` resolve, the primaryRepo compute :124-126, the state-merge reads :130/:192, the brief write :195 already primary)
- plugins/plan/src/project.ts:62-70 (`contextForRoot` — build a primary-rooted ctx)
- plugins/plan/src/verbs/submit_common.ts:143-192 (resolveAuditContext: `--project` branch :160-180, briefPath lookup :185 — confirm `--project` makes them primary-correct)
- plugins/plan/src/runtime_status.ts:63-77 (the resolveWorkerRepos landmine note + the primary half)
- plugins/plan/agents/quality-auditor.md:17,206 + close-planner.md:19,114,199 (PRIMARY_REPO already held; the 3 submit invocations to flag)
- plugins/plan/skills/close/SKILL.md (confirm the skill CANNOT pass --project to preflight — primary_repo is preflight's OUTPUT, pinned from the success envelope)

### Risks

- preflight's commit scan + brief write MUST stay on primary (already are) AND only the state read moves — all must agree on primary after the fix.
- Do NOT touch close-finalize / epic-close / scaffold (already primary; pinned by exhaustiveness / truth-table tests — don't perturb the saga order).
- The non-worktree path (cwd==primary, or `--project` given) must be unchanged — contextForRoot(primaryRepo) is a no-op when primaryRepo==cwd.
- State stays on primary — never write plan-state to the lane (the invariant this fix HONORS).

### Test notes

Pure tier (plugins/plan/test/, no real git): set up a "primary" tmp project carrying
DONE runtime state in `state/tasks/*.state.json`, and a separate "lane" dir holding
ONLY the committed defs (epic/task JSON, no `state/`). Run close-preflight from the
lane (cwd=lane, epicDef.primary_repo -> the primary) -> assert it reads done-state from
primary -> ready-to-close (NOT TASKS_NOT_DONE), and the brief lands in primary.
Regression-lock the submits: audit-submit / verdict-submit with `--project=primary`
from cwd=lane finds the brief (no BRIEF_MISSING). Reuse the saga-close-preflight /
audit-submit harnesses + the `KEEPER_PLAN_WORKTREE` lever (runtime_status.ts:16-19).
Slow tier (KEEPER_PLAN_RUN_SLOW, real git): a real lane worktree of a repo whose
primary carries the done-state -> close-preflight from the lane -> ready-to-close.
Extend worktree-lifecycle.test.ts.

## Acceptance

- [ ] close-preflight reads task done-state from epic.primary_repo (via a primary-rooted ctx) when cwd is a lane -> a done epic reads ready-to-close, not TASKS_NOT_DONE
- [ ] preflight's commit scan + brief write stay on primary (unchanged); all plan-state reads route through the primary ctx
- [ ] the 3 submit invocations pass `--project "$PRIMARY_REPO"` (quality-auditor + close-planner prompts); submits find/write artifacts in primary from a lane (no BRIEF_MISSING)
- [ ] preflight is NOT routed through resolveWorkerRepos
- [ ] non-worktree path unchanged; close-finalize / epic-close / scaffold untouched
- [ ] pure test: preflight-from-lane reads primary state; slow test: real lane worktree -> ready-to-close

## Done summary

## Evidence
