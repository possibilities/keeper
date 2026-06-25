## Description
**Size:** M
**Files:** src/autopilot-worker.ts, src/worktree-git.ts

### Approach
Two producer-side fixes in the autopilot worker.

BUG 3 (finalize never triggers — the chicken-and-egg): finalize is collected only when the close-row verdict is `completed` (src/autopilot-worker.ts:1277-1281,1523), and a close-row is `completed` IFF `epic.status === "done"` (src/readiness.ts predicate 1). But the daemon's `epics` projection folds from the MAIN worktree's `.keeper/` files (src/plan-worker.ts) — and once task .2 lands, the epic-close (status=done) commit is on the LANE, invisible to the main projection. So finalize is gated on a done-status only the lane has, and never fires. Decouple the finalize trigger from the main-worktree projection: trigger finalize off a producer-observable signal that the closer completed on the lane (the closer JOB reached done AND the lane base branch carries the close commit), then merge lane->default (which brings the done-state to main, so the projection THEN sees done) + push + teardown. Keep producer-only and re-fold-safe; document the chosen trigger.

BUG 4 (recover pass-1 touches non-keeper worktrees): recoverWorktrees pass-1 (src/autopilot-worker.ts:2285-2319) enumerates ALL registered linked worktrees and abort-merges each; a non-keeper `.claude/worktrees/<name>` lane whose dir is gone -> ENOENT posix_spawn 'git'. Filter pass-1 to keeper-managed lanes only — reuse the `keeper/epic/*` branch predicate already in listEpicBaseBranches (src/worktree-git.ts:391-405) and/or the `~/worktrees/<repo>--<slug>` path (worktreePathFor). Pass-2 (src/autopilot-worker.ts:2347-2350) is already safe.

### Investigation targets
**Required:**
- src/autopilot-worker.ts:1277-1281,1523,1492-1494 — completedRowIds + worktreeFinalize collection
- src/autopilot-worker.ts:2147-2215 — finalizeEpic (merge + push + teardown)
- src/readiness.ts:7-12 — close-row "completed" = epic.status==="done"
- src/plan-worker.ts:21-28 — epics projection folds from the MAIN worktree's `.keeper/` files (the chicken-and-egg source)
- src/autopilot-worker.ts:2285-2319 — recoverWorktrees pass-1; :2347-2350 pass-2 (already safe)
- src/worktree-git.ts:391-405 — listEpicBaseBranches keeper/epic prefix predicate (reuse for BUG 4)
**Optional:**
- src/worktree-plan.ts:126-148 — baseBranch / worktreePathFor lane derivations

### Risks
- BUG 3 is the architectural crux. A trigger off closer-job-done must stay idempotent + crash-safe (a restart between closer-done and merge must re-trigger) and re-fold-safe; finalize must stay producer-only (no fold reads git/fs).
- Depends on task .2 (BUG 2): design the trigger against commits-land-on-the-lane behavior.

### Test notes
- Fast tier: recoverWorktrees + runReconcileCycle are exported and driven git-free (test/autopilot-worker.test.ts) — assert pass-1 skips a non-keeper `.claude/worktrees` entry, and that finalize triggers off the closer-complete signal without a main-projection done-status.
- Real-git slow test (allowlist) for end-to-end close->merge->teardown if it genuinely exercises git.

## Acceptance
- [ ] an epic whose closer completes on the lane finalizes (lane merges to default + pushed + worktrees torn down + epic reaches done) WITHOUT first needing the main-worktree projection to see done
- [ ] the finalize trigger is producer-only, idempotent, and crash/restart-safe
- [ ] recover pass-1 skips non-keeper `.claude/worktrees` lanes; only keeper/epic lanes are touched
- [ ] fast-tier tests cover both the finalize trigger and the recover filter; bun run test:full green

## Done summary

## Evidence
