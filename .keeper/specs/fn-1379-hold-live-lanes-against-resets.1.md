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
a bounded reason — rather than mutate. MERGE_HEAD handling is TRI-STATE, never a blanket
hold: a lane with a LIVE claim holds (defer, visible bounded reason); a
lane with a DEAD or absent claim carrying sole-owned keeper/epic residue
takes the existing flock-guarded abort self-heal exactly as before this
epic; an abort failure mints the per-lane wedge row exactly as before.
The hold must never suppress the wedge escalation or the
positive-evidence level-clear for unheld surfaces; a held lane's open
row simply persists unchanged until the hold lifts. Model the exclusion
as a producer-side probe (never a fold read); an inconclusive liveness
probe defers. Reuse the existing stopped-job liveness helper rather than
re-implementing it; latch deferral logging once per episode per lane;
keep unrelated fixes out of this epic's commits.

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
- [ ] Maintenance passes defer on live-claimed lanes and on lanes whose in-progress merge is owned by a live or inconclusive claim (tri-state: live/inconclusive claim holds; a dead sole-owned MERGE_HEAD residue keeps the flock-guarded abort+prune self-heal; an abort failure escalates an IMMEDIATE worktree-lane-wedge), proven by deterministic tests
- [ ] Deferral is visible (bounded log or reason), never a silent skip; the hold latch logs once per episode
- [ ] Sanctioned teardown of dead lanes still works, and the dead-residue abort self-heal plus wedge escalation remain regression-proven (the fn-1123.2 and fn-1095 guard tests stay present and asserting their documented direction)
## Done summary
Attribution: recoverWorktrees pass 1 called gitAbortInterruptedMerge unconditionally on every keeper lane's MERGE_HEAD, racing a live resolver's own in-progress merge (fn-4.5 lane's repeated 'reset: moving to HEAD' reflog entries under a live session); seedKilledSweep was ruled out (reaps process rows only, never touches git). Fix: replaced the unconditional abort with a producer-side lane-maintenance probe (createLaneMaintenanceProbe) that checks live dispatch claims and live/inconclusive stopped-job liveness for the lane's path/task. MERGE_HEAD handling is tri-state: a LIVE or inconclusive claim holds the lane (defers visibly, bounded reason, mutates nothing); a DEAD or absent claim takes the pre-existing sole-owned abort self-heal (merge --abort + prune) so crash residue still clears; an abort failure is recorded and the surviving MERGE_HEAD surfaces as the immediate worktree-lane-wedge escalation, never suppressed by the hold. Applied across every maintenance pass (recover, base-refresh, provision, sink-provision, finalize); deferrals are reported via WorktreeRecoveryOutcome.maintenanceDeferrals, logged once per (pass, lane) episode via a latch, and pruned when a lane stops deferring. Sanctioned teardown of dead/released-claim lanes is unaffected and regression-proven. Tests: deterministic coverage added in test/autopilot-worker.test.ts for the hold across every cycle pass and the mid-merge/tri-state cases; full suite green at HEAD (921b4de0d) per keeper baseline. Known gap: commits d4187d86b (tri-state hardening) and 921b4de0d (a pre-existing, unrelated stray commit already on this branch) were made in a prior session without the 'Task: fn-1379-hold-live-lanes-against-resets.1' trailer, so keeper's commit-trailer attribution (source_commits) only lists d8c4ba7ea and ef354ce87, which do carry the trailer and satisfy the source-commit requirement. History was not rewritten to backfill the trailer (amend/rebase of prior-session commits is disallowed). Two provider-leg delegation attempts to land a fresh trailered follow-up commit (harness pi, the sole resolved candidate for this cell) both terminated no_transcript after full waits, exhausting max_attempts with no fallback candidate, so the attribution gap on those two commits remains unresolved pending a working delegation path or an out-of-band trailer backfill.
## Evidence
