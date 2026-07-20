## Description

**Size:** M
**Files:** plugins/plan/plugin/hooks/commit-guard.ts, cli/commit-work.ts, plugins/plan/src/vcs.ts, docs/

### Approach

The plan commit-guard hard-denies main-context commit-work while a task is
`in_progress_uncommitted` (commit-guard.ts:40,52 — passes only when `agent_id` is
present), and even when an operator can commit, attribution is impossible: a
hand-written `Task:` trailer returns `forbidden_trailer` (cli/commit-work.ts:1358),
`--task-id` requires a bound work job (:1279), and `commitsForTask` greps exactly
that mechanical trailer (plugins/plan/src/vcs.ts:399-445) — so close-preflight's
commit set omits operator remediation commits entirely (live specimen: fn-1379.1's
d4187d86b+921b4de0d invisible to the close). Give the free-form operator shape a
sanctioned path: guard admission keyed on the operator session's own live claim of
the exact task (never a blanket main-context allow), and an attribution route that
mints the mechanical trailer for that claimed task without requiring a bound work
job. Laundering through a subagent and KEEPER_PLAN_GUARD_BYPASS stay forbidden;
the guard's fail-closed posture for unclaimed main-context commits is preserved.

### Investigation targets

*Verify before relying — the repo moves.*

**Required** (read before coding):
- plugins/plan/plugin/hooks/commit-guard.ts:40,52 — the deny predicate and the agent_id pass
- cli/commit-work.ts:1279,1358 — the --task-id bound-job requirement and forbidden_trailer rejection
- plugins/plan/src/vcs.ts:399-445 — commitsForTask trailer grep (the attribution consumer)
- ~/docs/keeper-phase2-backlog.md entries #66 (both layers) — the two live specimens and the phase-13 operator's correct refusal

### Risks

- The admission must not weaken the guard for arbitrary main-context sessions — key it on a live, exact-task claim, nothing broader
- Hook rules: commit-guard is a plan-plugin hook — no bun:sqlite/src/db.ts imports; envelope-deny only, always exit 0

### Test notes

Guard tests: unclaimed main-context deny preserved; claimed-exact-task operator admitted;
trailer minted matches commitsForTask's grep; forged trailer still rejected. Named gates only.

## Acceptance

- [ ] An operator session with a live claim of task T lands a commit through commit-work that close-preflight attributes to T (commitsForTask finds it)
- [ ] A main-context commit without that claim is still denied; hand-written Task: trailers are still rejected
- [ ] Docs name the sanctioned operator ritual; guard + attribution suites green via named gates

## Done summary

## Evidence
