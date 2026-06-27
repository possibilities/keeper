## Description

**Size:** M
**Files:** src/worktree-plan.ts, src/worktree-git.ts, src/autopilot-worker.ts, test/worktree-plan.test.ts, test/worktree-git.test.ts, test/autopilot-worker.test.ts, plugins/plan/test/<new>-worktree-fork.test.ts, README.md

### Approach

Rename ribBranchFor (src/worktree-plan.ts:132) from `keeper/epic/<id>/<task>` to the FLAT `keeper/epic/<id>--<task>`, so a rib is NEVER a path-prefix of the base ref `keeper/epic/<id>` — this closes the git directory/file ref conflict that jams the first forked epic. The base ref name stays UNCHANGED (minimal churn). Then update EVERY base-vs-rib consumer in lockstep (the missed-consumer class is what has broken worktrees repeatedly). Prune ribs (branches + worktrees) at teardown. Add a real-git base+rib+fan-in slow test — the existing 1-lane lifecycle test structurally cannot catch R1.

### Investigation targets

**Required** (read before coding):
- src/worktree-plan.ts:132 ribBranchFor (rename) + :224,243 the two `branchOf.set(taskId, ribBranchFor(...))` call sites in deriveWorktreePlan + :23-24,64-65,126-134 doc comments hardcoding the old `<id>/<task>` shape + :145-149 worktreePathFor slug (`--` now appears twice in the path; still collision-free — confirm + update doc).
- **src/worktree-git.ts:451-476 listEpicBaseBranches — THE #1 LANDMINE.** It splits base from rib by `rest.includes("/")` (:470) and recovers epicId as the whole `rest`. With `--` ribs the rest has NO `/`, so every rib would be mis-enumerated as a base and MERGED INTO THE DEFAULT BRANCH. Switch the discriminator to `--` (base = no `--`, rib = has `--`) and recover epicId by splitting on `--`. Update doc :440-449.
- src/worktree-git.ts:417,430-437 KEEPER_EPIC_BRANCH_PREFIX + isKeeperLaneEntry (prefix-only classify still holds for both base + rib; update the doc narrating the old shape :410-428).
- Confirm-safe (verify, likely no change): src/autopilot-worker.ts:1956-1991 parentBranchFor (map-based), :2374-2379 closeKeyEpicId (base has no `--`), src/worktree-git.ts:493-512 epicBaseHasDoneState (base only).
- Teardown: finalizeEpic (src/autopilot-worker.ts:2557-2580) deletes ONLY baseBranch (:2578-2579) — add rib pruning here (delete the epic's rib branches + their worktrees, is-ancestor-gated; reuse removeWorktree + deleteBranch).
- Exact-string test assertions to update: test/worktree-plan.test.ts:107-108,146-182,199,204-205,248-250; test/worktree-git.test.ts:144,151,198,234; test/autopilot-worker.test.ts:4943,5000.
- plugins/plan/test/worktree-lifecycle.test.ts — mirror its raw-git harness (its own git()/gitQuiet() helpers, GIT_* save/restore, tolerant afterEach) for the new fork test.

### Risks

- listEpicBaseBranches:470 is the make-or-break: a wrong base-vs-rib split mis-merges ribs to the default branch. The slow test MUST include a real rib so this is exercised end-to-end (the 1-lane test cannot).
- worktreePathFor slug now contains `--` twice (`<repo>--<epic>--<task>`) — confirm collision-free + legible; update the doc.
- Keep the rename inside the worktree-plan.ts seam — no consumer may reconstruct the old slashed rib form.

### Test notes

- Pure tier (root test/, fake runners) for any base-vs-rib classification logic.
- Real-git slow test in plugins/plan/test/ (KEEPER_PLAN_RUN_SLOW, describe.skipIf(!SLOW_ENABLED)): provision a base + >=2 ribs + a fan-in (mirror the worktree-lifecycle raw-git harness), commit on each, assert NO directory/file collision, the fan-in merges, and teardown prunes BOTH the base AND the ribs (no leak). This is the test that would have caught R1.
- Default `bun test` stays pure; typecheck + lint green (root). Update the README branch-naming + rib-pruning lines (forward-facing only).

## Acceptance

- [ ] ribBranchFor returns a flat `keeper/epic/<id>--<task>` that is never a path-prefix of the base ref; a forked epic provisions all ribs with no git directory/file collision.
- [ ] listEpicBaseBranches splits base from rib by `--` (no rib mis-enumerated or mis-merged); every other base-vs-rib consumer is updated in lockstep.
- [ ] Teardown prunes rib branches + worktrees; nothing leaks; a re-run of the same epic does not collide.
- [ ] A real-git base+rib+fan-in slow test passes (opt-in); the default `bun test` stays pure; exact-string test assertions updated; README updated; typecheck + lint green.

## Done summary

## Evidence
