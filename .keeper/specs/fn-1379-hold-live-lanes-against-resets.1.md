## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/seed-sweep.ts, src/worktree-git.ts, test/autopilot-worker.test.ts

### Approach

Two phases in one task. First attribute: correlate the victim lane's
reflog timestamps with daemon activity to name the exact pass that
resets a live-claimed lane (recover cleanliness handling, the
base-freshness producer, and the seed sweep are the suspects, in that
order). Then hold: the identified pass (and any sibling with the same
shape) must check the task's live-claim state and defer — visibly, with
a bounded reason — rather than mutate; a lane with MERGE_HEAD present
is never reset by any maintenance pass regardless of claim state.
Model the exclusion as a producer-side probe (never a fold read); an
inconclusive liveness probe defers.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/autopilot-worker.ts — the recover pass's dirt/cleanliness handling and the base-freshness producer (both self-merge or restore lane state)
- src/seed-sweep.ts — boot/periodic seed rescans that touch worktrees
- the victim lane's reflog (agentbrain fn-4 .5 lane) — the defect signature to reproduce in the test fixture

### Risks

- The resetter may be plumbing shared by legitimate teardown paths — the hold must not break sanctioned teardown of truly dead lanes
- Attribution may implicate an external (non-keeper) writer; the early-proof recovery re-scopes to detection

### Test notes

Deterministic, through the pure git-boundary seam: a lane fixture with a
live claim and MERGE_HEAD must survive every maintenance pass untouched;
the deferral emits its reason; a dead-claim lane still gets normal
recover handling.

## Acceptance

- [ ] The resetting pass is named with correlated evidence in the task's Done summary
- [ ] Maintenance passes defer on live-claimed lanes and on any lane with an in-progress merge, proven by deterministic tests
- [ ] Deferral is visible (bounded log or reason), never a silent skip
- [ ] Sanctioned teardown of dead lanes still works (regression-proven)

## Done summary

## Evidence
