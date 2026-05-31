## Overview

The keeper readiness per-root mutex (`applySingleTaskPerRootMutex` in
`src/readiness.ts`) lets an epic's synthetic close row claim the epic's
`project_dir` root whenever the close row is "running" — but the close
row's running state can be *inherited* from a task-level worker executing
in a DIFFERENT `target_repo` (the `evaluateCloseRow` predicate-5/6 fan-out
pools `epic.jobs` AND every `task.jobs`). The result is a phantom
`single-task-per-root` lock that starves unrelated ready tasks on the
epic's `project_dir` even though no real work runs there. End state: the
close row claims `project_dir` ONLY when its running-ness comes from an
epic-level source (planner / close-verb job / epic-level sub-agent); a
purely task-derived running state no longer locks the wrong root (the
contributing task already locks its own correct `target_repo` root in the
same pass).

## Quick commands

- `bun test test/readiness.test.ts`  # full readiness suite incl. new regression + negative controls

## Acceptance

- [ ] A close row running ONLY because of a cross-`target_repo` task worker (job OR sub-agent) no longer claims `epic.project_dir`.
- [ ] Epic-level running sources (planner-running, epic close-verb job, epic-level sub-agent) STILL claim `project_dir`.
- [ ] The confirmed fn-651 scenario (keeper-root sibling task stays `ready`, not `single-task-per-root`) is covered by a regression test.
- [ ] Pure client-side change: no schema bump, no keeper-py whitelist touch, no new Verdict variant; `effectiveRoot` unchanged.

## Early proof point

Task that proves the approach: `fn-N.1` — the regression test reproducing
the fn-651 cross-repo close-row scenario must go red on current code and
green after the gate. If it fails: the per-root claim cannot distinguish
epic-level from task-level running from the Verdict alone, so re-deriving
epic-level running-ness from `epic.jobs`/`job_links`/epic sub-agents at
claim time is the fallback (which is exactly shape (b)).

## References

- `src/readiness.ts:943-1011` — `applySingleTaskPerRootMutex` (defect site; pass-1 close claim 968-972)
- `src/readiness.ts:680-826` — `evaluateCloseRow` running sources: pred 3 (708), pred 5 (729-736), pred 6 (752-757)
- `cli/autopilot.ts:489-514` — `effectiveRoot` mirror; close command runs in `project_dir` (509), confirming only an epic-level close session legitimately occupies `project_dir`
- `fn-654` (harden autopilot zellij backend) — **reverse dependency**: it concerns autopilot dispatch correctness and has not started; it should land on a fixed dispatch surface. Consider wiring `fn-654` to depend on this epic.
- Real-world precedent: Atlantis #2200/#5594 (parent-scope lock key starves unrelated workspace — canonical phantom-lock bug); BullMQ `waiting-children` holds no resource lock.

## Best practices

- **Lock the resource where work executes, not where the owner nominally lives.** The close row holds no root while merely waiting on a child; only its own epic-level session occupies `project_dir`. [Atlantis #2200]
- **A "blocked-because-a-child-is-running" state must not authorize a self-resource claim.** [BullMQ waiting-children]
- **Keep the pass pure & order-deterministic:** reuse the existing null-guarded helpers, inject no clock/OS probe, and preserve `Set<string>` insertion (board-traversal) order — the fix only conditionally skips an existing `add`.

## Docs gaps

- **`src/readiness.ts` JSDoc** (`applySingleTaskPerRootMutex` ~919-1015 pass-1 close-claim prose, `evaluateCloseRow` ~680): revise in place to the scoped-attribution rule — the current text describes an unconditional `isLiveWorkOccupant` claim.
- **`cli/board.ts:217-224`**: the sentence "The close row uses the epic's `project_dir` directly (no per-row override)" should be revised/cross-referenced — the close row no longer *always* claims `project_dir`.
