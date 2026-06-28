## Description

F2 (README.md:3196-3200): the `## Architecture` worktree section still
describes the REMOVED finalize mechanism as current — "finalize keys off ...
a `git show` of the lane base's spec (`epicBaseHasDoneState`)" and "the closer
commits `status:done` on the LANE ... finalize no-ops". `epicBaseHasDoneState`
is deleted (grep confirms it survives only in README:3198); finalize now gates
on the MAIN projection via `isEpicDone` (autopilot-worker.ts:2565). Per
CLAUDE.md rule #0 (docs prune, never append-only), rewrite this paragraph to
the projection-done gate — remove the lane-spec narrative, do not append.

## Acceptance

- [ ] README worktree section describes the projection-done (isEpicDone) finalize gate
- [ ] No reference to epicBaseHasDoneState or the lane-spec git-show mechanism remains

## Done summary
Rewrote README worktree finalize paragraph to describe the isEpicDone main-projection done-gate, removing the deleted epicBaseHasDoneState lane-spec git-show narrative.
## Evidence
