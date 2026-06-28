## Overview

In worktree mode the plan close orchestrator is dispatched into the epic's LANE
worktree, but the close-phase verbs read PLAN STATE (task done-flips + the
brief/audit/verdict/followup artifacts) from the lane's `.keeper/`, where it does
not exist: `.keeper/.gitignore` is `state/`, so the runtime overlay AND the close
artifacts live ONLY in the primary repo (the plan-state-on-primary invariant) — the
epic/task JSON defs + specs ARE committed, so they fool a cwd-based resolver into
picking the lane. So `close-preflight` from the lane returns TASKS_NOT_DONE and the
close stalls before the audit; the submits then fail BRIEF_MISSING; the producer
finalize never fires.

This routes every close-phase verb's plan-state resolution to the primary repo
(`epic.primary_repo`) regardless of cwd. The CODE/diff reads are ALREADY
primary-keyed (verified — the close agents read via `git -C <primary> show`, which
works against the shared worktree object store), so this is a pure STATE-side fix:
the close keeps running in the lane but reads/writes ALL plan-state in primary. End
state: a close running in the lane reads done-state + reads/writes its artifacts in
primary and completes; the worker `done` flip resolves to primary too (the sibling
seam the workers hit). The autopilot producer-finalize then merges the lane.

## Quick commands

- `cd plugins/plan && bun test` — pure tier (no real git)
- `cd plugins/plan && KEEPER_PLAN_RUN_SLOW=1 bun test` — opt-in slow real-git tier

## Acceptance

- [ ] close-preflight resolves task done-state to epic.primary_repo when cwd is a lane (a done epic reads ready-to-close, never TASKS_NOT_DONE)
- [ ] audit/verdict/followup submit find + write their artifacts in primary (no BRIEF_MISSING) when run from a lane
- [ ] the worker `done` flip resolves the task state file to primary when run from a lane
- [ ] the plan-state-on-primary invariant is HONORED — state always resolves to primary, never written to the lane
- [ ] no regression: close-finalize / epic-close / scaffold stay primary; the non-worktree (cwd==primary / --project) close path is unchanged
- [ ] default `bun test` stays the pure fast tier; new real-git tests are opt-in (KEEPER_PLAN_RUN_SLOW)

## Early proof point

Task `.1` (close-preflight self-resolving state to primary via a primary-rooted
context) — it is the verb that directly blocks fn-986's close and proves the
primary-state resolution approach. If it fails: resolve the owning project lane-blind
via `findProjectsWithEpic(epicId)` (the claim/resolve-task pattern) instead of
`contextForRoot(primaryRepo)`.

## References

- A repo-scout enumerated EVERY close-phase verb's plan-state resolution and verified
  the seam: `.keeper/.gitignore`=`state/` makes the runtime overlay + close artifacts
  primary-only, while committed defs fool a cwd resolver into the lane. close-preflight
  (close_preflight.ts:110-151), audit/verdict/followup submit (submit_common.ts:143-192),
  and the worker `done` flip (done.ts:65 via resolveEpicGlobally's cwd short-circuit,
  discovery.ts:235-252) all resolve to the lane; close-finalize (close_finalize.ts:418,
  `--project`) is the correct model. The code/diff reads are already primary-keyed
  (close-planner reads `git -C <primary> show`; findCommitGroups takes primaryRepo).
  Extends the fn-984 worktree-state pattern (resolveWorkerRepos / lane-blind
  findProjectsWith* in runtime_status.ts / discovery.ts) to the close phase.
- OUT OF SCOPE: re-enabling worktree mode + finalizing the stalled fn-986 canary
  (operator handles post-land); the dedicated-finalizer redesign / dispatching the
  closer to primary entirely (a viable future simplification, since the diff reads are
  already primary — but a producer change, deferred).
