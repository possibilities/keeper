## Description

**Size:** M
**Files:** src/worktree-git.ts (mergeReadiness, listEpicBaseBranches, enumeration), src/autopilot-worker.ts (teardown, recover, reposForRecovery), test/worktree-git.test.ts, test/autopilot-worker.test.ts, plugins/plan/test/worktree-*.test.ts

### Approach

- FM-B (would-clobber): in mergeReadiness (src/worktree-git.ts:451-468) KEEP the benign-untracked-is-clean behavior (`--untracked-files=no`, fn-987) but add a targeted would-clobber probe before the merge — the intersection of `git ls-files --others --exclude-standard` (main's untracked) ∩ `git ls-tree -r --name-only <lane-base>` (the incoming tracked paths). A non-empty intersection → NOT-ready / skip-retry (distinct reason), so `git merge` never hard-aborts on a would-overwrite. Do NOT use `git merge-tree` (it doesn't see untracked) and do NOT flip to `--untracked-files=normal` (re-wedges on benign `.env` — fn-987 regression).
- FM-D (orphan ribs): teardown (src/autopilot-worker.ts:2600-2636) + recover must enumerate ALL of an epic's refs/worktrees — `git for-each-ref refs/heads/keeper/epic/<id>` AND `refs/heads/keeper/epic/<id>--*` (ribs) + their worktrees — not just the current laneOrder; is-ancestor-gated, prune-before-branch-delete, NEVER `git branch --contains`. Update listEpicBaseBranches (:557 rib exclusion) so recover can SEE ribs for cleanup — but keep the base-vs-rib distinction on the MERGE path (a rib must never be merged to default).
- FM-C (recover discovery): reposForRecovery (:2880-2899) must source candidate repos from live keeper refs / known roots, not ONLY snapshot epics, so a done-but-unmerged base in a repo with no visible epic is still swept.

### Investigation targets

**Required** (read before coding):
- src/worktree-git.ts:451-468 mergeReadiness (:460 `--untracked-files=no`; the :442-444 benign-untracked rationale to PRESERVE) + :536-563 listEpicBaseBranches (:557 rib exclusion) + :515-523 isKeeperLaneEntry.
- src/autopilot-worker.ts:2600-2636 teardown/prune + :2716 / :2484 gitListWorktrees + :2880-2899 reposForRecovery (+ call site :3667) + the WorktreeRecoveryFailure shape + :3672-3680 emit.
- gitIsAncestorOf (the prune gate); samePath / stripTrailingSlash (src/worktree-git.ts:770-781).

**Optional**:
- `git for-each-ref` glob is one level (`keeper/epic/<id>--*`); `%(upstream:track)` = `[gone]` for orphan detection.

### Risks

- Benign-untracked: do NOT flip to `--untracked-files=normal` (re-wedges finalize on `.env` / editor temp — fn-987 regression). Use the targeted intersection only.
- Base-vs-rib: ribs must be ENUMERATED for cleanup but NEVER merged as bases — keep the merge path's base-only selection while widening the CLEANUP enumeration.
- New skip/degrade reasons in the correct family (finalize vs recover).

### Test notes

- Pure (test/worktree-git.test.ts): mergeReadiness with a would-clobber intersection → not-ready; benign untracked-only → ready (fn-987 preserved); the merge path still selects bases only.
- Pure (test/autopilot-worker.test.ts): teardown prunes an orphan rib NOT in laneOrder; recover sweeps an out-of-snapshot done base.
- Slow (plugins/plan/test/worktree-*.test.ts): real-git would-clobber → skip; orphan rib pruned; out-of-snapshot base swept.
- typecheck + lint green.

## Acceptance

- [ ] mergeReadiness flags a would-clobber untracked file (lane-incoming ∩ main-untracked) as not-ready/skip; a benign untracked-only tree still finalizes (no fn-987 regression).
- [ ] teardown + recover prune EVERY `keeper/epic/<id>` + `--*` rib (branch + worktree), is-ancestor-gated, prune-before-delete, no `--contains`.
- [ ] recover discovery sweeps done-but-unmerged bases beyond the snapshot.
- [ ] the merge path still selects bases only (a rib is never merged to default).
- [ ] pure + slow tests; typecheck + lint green.

## Done summary
Added a would-clobber merge gate (incoming tracked paths ∩ main untracked) that degrades finalize + recover to distinct non-sticky skip-retries while keeping benign-untracked finalizing; widened teardown + recover to prune EVERY rib (laneOrder ∪ live-git, is-ancestor-gated, prune-before-delete, never --contains) with merge staying bases-only; and gave reposForRecovery knownRoots so out-of-snapshot done bases are swept.
## Evidence
