## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/worktree-git.ts

### Approach

`finalizeEpic` (autopilot-worker.ts:2522) no-ops because its merge gate
`gitEpicBaseHasDoneState` (:2544 → worktree-git.ts:683-702) reads the LANE
base's `.keeper/epics/<id>.json`, but the closer writes epic-`done` to the
PRIMARY repo (close-finalize chdir's to the primary repo; plan invariant:
plan state always = primary repo, never the lane). Replace that lane-read gate
with the SAME guard `recoverWorktrees` pass-2 already uses correctly: the epic
is done in the MAIN projection (`isEpicDoneById`, :3085/:3868) AND the lane
base is ahead of the default branch (real commits to merge, i.e. NOT an
ancestor of default). This AUGMENTS rather than merely swaps the check: the
projection-done half is what rejects a CRASHED closer — `closerFinishedIds`
(the finalize trigger, :1903-1904) fires for ANY finished closer job, even one
that committed code-but-not-`done`; only projection-done confirms real
completion. `finalizeEpic` today receives ONLY `info` (no db/isEpicDone
handle) — thread the projection-done probe in, mirroring recover's
`recover(repos, isEpicDone)` dep (:2737).

Then CONSOLIDATE finalize's merge sequence (mergeReadiness → push prechecks →
mergeBranchInto → push) and recover pass-2's identical sequence onto ONE shared
routine that returns a STRUCTURED discriminated result
(`off-branch | dirty | would-clobber | non-ff | not-turn-key | conflict |
push-failed | merged | not-ahead`) and stamps NO reason strings internally.
Each CALLER maps the discriminant to its own reason family: finalize →
`worktree-finalize-*` (OUTSIDE the `worktree-recover` prefix; retry vs sticky
per kind), recover → `worktree-recover-*` (INSIDE the prefix, auto-clearable).
Keep the optional `acquireLock` (recover is lock-aware at :2939, finalize
lock-less at :2620 — the shared routine takes an optional lock). Correct the
now-FALSE comments at worktree-git.ts:673-681 (`epicBaseHasDoneState`) and
autopilot-worker.ts:1873-1876 (`attachWorktreeGeometry`) that assert "the
closer commits done to the lane" — done lands on the primary repo. If
`epicBaseHasDoneState` has no caller left, remove it and its test.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:2522-2718 — finalizeEpic: the gate (:2544), merge (:2620), full sequence + teardown tail
- src/autopilot-worker.ts:2766-2968 — recoverWorktrees pass-2: the already-correct guard (isEpicDone :2862 + ancestor skip :2866), the parallel merge sequence to share
- src/autopilot-worker.ts:1873-1876, :1900-1965, :1660-1684 — finalize trigger (completedRowIds||closerFinishedIds), closerJobFinished, the stale lane-done comment
- src/autopilot-worker.ts:3085, :3868 — isEpicDoneById (the projection-done probe to thread into finalize)
- src/autopilot-worker.ts:407-412, :3321 — WORKTREE_RECOVER_REASON_PREFIX / isWorktreeRecoverReason / the auto-clear consumer (the boundary the consolidation must preserve)
- src/worktree-git.ts:683-702 — epicBaseHasDoneState (the broken lane-read to remove) + its stale comment
- src/worktree-git.ts:469 (mergeReadiness: off-branch|dirty|would-clobber|ready), :783 (gitMergeBranchInto: missing-source|already-merged|merged|conflict)

**Optional:**
- plugins/plan/src/verbs/close_finalize.ts:216-233 — confirms `done` lands on the primary repo

### Risks

- Reason-prefix boundary: the shared core must NOT stamp reason strings. A finalize block that leaked a `worktree-recover*` reason would be silently auto-dismissed by :3321 — a genuine close-sink jam must never be auto-cleared. Test must assert no finalize reason satisfies isWorktreeRecoverReason.
- Crash-closer regression: a gate of lane-ahead ALONE re-admits a crashed closer's incomplete work to default. The gate MUST be projection-done AND lane-ahead.
- Same-cycle ordering: recover runs first (:3860), finalize second (:2373); normally recover handles a done base and finalize then sees no base. They both act only when recover fails (conflict). If both emit DispatchFailed on the same `close::<epic>` key in one cycle, the STICKY finalize reason must win over the auto-clearable recover reason.

### Test notes

Pure fake-runner (test/autopilot-worker.test.ts, makeFinalizeInfo :4637,
recover harness :5300-5311): finalize fires when isEpicDone true + lane ahead →
merges; isEpicDone false (crashed closer) → no-op; done but lane not-ahead →
no merge; assert NO finalize-side reason satisfies isWorktreeRecoverReason.
Replace the slow-tier worktree-lifecycle.test.ts fake (done-on-lane :142-149 +
manual `git merge --no-ff` :166) with a drive of the REAL close-sink finalize:
done on PRIMARY (isEpicDone true) + lane carries real commits + NO done on the
lane — the exact config the old :2544 gate failed on.

## Acceptance

- [ ] finalizeEpic merges lane→default when the epic is done in the main projection AND the lane base is ahead of default
- [ ] a finished-but-not-done (crashed) closer does NOT trigger a merge — no incomplete work reaches default
- [ ] finalize and recover pass-2 share one merge routine returning a structured result; the shared core stamps no reason strings
- [ ] no finalize-side reason satisfies isWorktreeRecoverReason (asserted by a test)
- [ ] the slow-tier lifecycle test drives the real finalize with done-on-primary (not faked done-on-lane)
- [ ] stale "closer commits done to the lane" comments corrected to present-tense reality

## Done summary

## Evidence
