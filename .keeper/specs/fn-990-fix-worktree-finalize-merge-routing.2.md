## Description

**Size:** S
**Files:** src/autopilot-worker.ts, src/worktree-git.ts

### Approach

`finalizeEpic` is the ONLY path that tears down the base branch + base worktree
(autopilot-worker.ts:2659-2710); recover pass-3 (:2997-3018) is ribs-only
(`if (!rib.isRib) continue`). Make base teardown an INDEPENDENT
is-ancestor-gated sweep that runs whenever a `keeper/epic/<id>` base branch is
an ancestor of the default branch (provably merged) — NOT conditional on
whether THIS run did the merge — so a crash between merge and teardown is swept
on the next cycle. Add it to BOTH finalize and recover (recover's pass-3 gains a
base sweep alongside ribs). Mirror the existing rib teardown ordering: remove
the worktree filesystem → gitPruneWorktrees → gitDeleteBranch, is-ancestor-gated
(gitIsAncestorOf), prune-before-delete, NEVER `git branch -D` without the gate
and NEVER `git branch --contains`. Enumerate candidates from live git
(gitListEpicBaseBranches / gitListEpicLaneBranches) so the sweep works without a
laneOrder snapshot (recover has none); laneOrder is optional augmentation.
Recover must ACCUMULATE a WorktreeRecoveryFailure on a dirty base teardown and
continue (never throw) — matching recover's contract; finalize returns its
hard/retry result.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:2659-2710 — finalize teardown (rib + base; the ordering + is-ancestor gate to mirror)
- src/autopilot-worker.ts:2970-3026 — recover pass-3 (ribs-only; add the base sweep here)
- src/worktree-git.ts — gitRemoveWorktree ({kind:"dirty"|…}), gitDeleteBranch, gitPruneWorktrees, gitIsAncestorOf, gitListEpicBaseBranches / gitListEpicLaneBranches

### Risks

- Crash between merge and teardown: gating on is-ancestor-of-LOCAL-default is safe — the merge commit is on local default (content preserved), and the push either landed or is retried next cycle (re-pushing an already-merged default is a ff no-op). Do NOT gate on origin ancestry (may be unresolved/stale).
- Idempotency: each step must be re-entrant — worktree-list probe before remove, ref-exists probe before delete, prune always safe.
- An UNMERGED base (not an ancestor of default) is LEFT for a human — never force-delete.

### Test notes

Pure: after a merge the base branch + base worktree are removed; an unmerged
base is LEFT. Slow real-git: a full lane cycle leaves ZERO orphan
`keeper/epic/<id>` base branch or `~/worktrees` dir (the orphan class found on
disk this session).

## Acceptance

- [ ] the merge path removes the base worktree AND deletes the base branch once it is an ancestor of the default branch
- [ ] base teardown is an independent is-ancestor-gated sweep — it sweeps a crash-orphaned base even when this cycle performed no merge
- [ ] recover gains base teardown (not just ribs), accumulating a failure on a dirty base rather than throwing
- [ ] an unmerged base is left intact (never force-deleted)
- [ ] slow real-git lifecycle leaves no orphan base branch or worktree dir

## Done summary

## Evidence
