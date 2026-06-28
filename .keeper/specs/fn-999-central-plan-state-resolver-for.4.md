## Description

**Size:** S
**Files:** plugins/plan/src/submit_common.ts, plugins/plan/src/verbs/{audit_submit,verdict_submit,followup_submit}.ts, plugins/plan/agents/{quality-auditor,close-planner}.md, plugins/plan/skills/close/SKILL.md, plugins/plan/CLAUDE.md, README, plugins/plan/test/*

### Approach

Remove the last B-discipline dependency: the close submits are safe today only because
the close skill passes `--project "$PRIMARY_REPO"`. Route `resolveAuditContext`
(submit_common.ts:160) through `resolvePlanStateContext` so audit/verdict/followup submit
find + write their artifacts in primary from a lane WITHOUT `--project`. Then:
- **Flip the deliberate test:** worktree-close-state.test.ts:186 currently asserts
  `audit submit` WITHOUT `--project` from a lane → BRIEF_MISSING. After this slice it must
  assert SUCCESS (auto-routed to primary) — a robustness improvement, not a regression.
- **Docs prune (rule #0, forward-facing):** reconcile the worker-agent docs that promise
  "state writes auto-route to PRIMARY_REPO" (now TRUE for all state verbs); downgrade the
  close/work-skill `--project` guidance from load-bearing to belt-and-suspenders; keep ONE
  forward-facing invariant in plugins/plan/CLAUDE.md (the STATE-vs-PATH rule) + note the
  central resolver as the single seam. Remove the four submits from the source-guard
  exempt-list (the list should now be empty of stateful verbs → the guard is fully strict).

### Investigation targets

**Required** (read before coding):
- plugins/plan/src/submit_common.ts:143-192 (resolveAuditContext → route via resolver); audit_submit.ts:55,67, verdict_submit.ts:76, followup_submit.ts:122 (artifact writes already key off brief.primary_repo)
- plugins/plan/skills/close/SKILL.md:46,133 (the --project invocations → now optional); agents/quality-auditor.md, close-planner.md (the submit invocations)
- plugins/plan/test/worktree-close-state.test.ts:186 (the BRIEF_MISSING assertion to flip)
- the worker-agent docs claiming auto-route (reconcile to reality)

### Risks

- The brief must already exist in primary (close-preflight writes it there) for the submits to find it — confirm the chain stays coherent.
- Keep `--project` working (authoritative) for the non-worktree path; the change makes it OPTIONAL, not removed.
- Docs: forward-facing only, no provenance/fn-ids; prune don't append.

### Test notes

audit/verdict/followup submit from a lane WITHOUT --project → find + write artifacts in primary (the flipped BRIEF_MISSING test → success). Confirm the non-worktree path (--project or cwd==primary) unchanged. Pure tier. After this slice the source-guard exempt-list is empty of stateful verbs (fully strict).

## Acceptance

- [ ] audit/verdict/followup submit route via resolvePlanStateContext; work from a lane without --project
- [ ] the BRIEF_MISSING-without-project test is flipped to expect success
- [ ] docs reconciled to the central-resolver reality (one forward-facing invariant; --project downgraded to belt-and-suspenders)
- [ ] source-guard exempt-list empty of stateful verbs → guard fully strict; pure tier green

## Done summary

## Evidence
