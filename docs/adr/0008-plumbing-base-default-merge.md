# 8. Working-tree-free plumbing base→default merge

## Status

Accepted.

## Context

In worktree mode autopilot lands each done epic by merging its base branch
(`keeper/epic/<id>`) into the repo default branch. That merge ran `git merge
--no-edit` + `git push` IN the shared repo toplevel checkout — the human's
interactive working copy on the default branch — so it depended on that
checkout's working-tree state. A precondition probe (`mergeReadiness`) degraded a
dirty, off-default, mid-merge, or would-clobber checkout into a retry-skip that
minted no visible row, stranding a done epic unmerged while the checkout stayed
dirty. Worse, a conflicting merge left the checkout mid-merge (`MERGE_HEAD` +
unresolved paths), and every subsequent board-wide plan-state commit then failed
("cannot do a partial commit during a merge") — the incident that motivated this.
The coupling was fundamental: the merge borrowed the human's working tree as its
merge arena, so any state left there blocked or corrupted the daemon's merge.

## Decision

The base→default merge is now WORKING-TREE-FREE — a git plumbing pipeline that
never runs `git merge` in the shared checkout and never reads or writes its tree:

1. `git merge-tree --write-tree <default-tip> <base-tip>` computes the merged tree
   off the two tips (tree-vs-tree), driving conflict off the exit code (0 clean,
   1 conflict → the existing sticky escalation, >1 → a hard-error arm). A pure
   fast-forward short-circuits before merge-tree and advances the ref to the base
   tip with no merge commit.
2. `git commit-tree` mints a true 2-parent merge commit with a pinned identity and
   dates pinned to the base-tip committer date (never wall-clock), so a
   crash-retry re-derives the same commit OID.
3. `git update-ref refs/heads/<default> <new> <old>` compare-and-swaps the ref: a
   stale `<old>` (a concurrent local advance) is a transient retry-skip, never a
   strand. The push rides the existing turn-key / non-ff / origin-containment
   gating unchanged.

The pipeline is git-version-gated (`merge-tree --write-tree` needs git ≥ 2.38); an
older git degrades to a distinct transient skip, since worktree mode is
default-off. `mergeReadiness` is excised from the base merge (it stays live for the
fan-in lane pre-merge, which does run a real working-tree merge in an isolated
lane), so the base merge no longer inspects the shared checkout's state at all.

## Alternatives considered

- **A detached daemon-owned worktree for the merge.** Rejected: git forbids two
  worktrees on the same branch, so a daemon worktree collides with the human's main
  checkout, and a detached-HEAD worktree still needs the same CAS ref write to
  advance `refs/heads/<default>` — added cost and teardown for no gain.
- **Keep the working-tree merge but harden the precondition skips.** Rejected: the
  silent stall is inherent — any precondition that defers on a dirty/off-branch
  checkout strands the epic, and no hardening removes the dependency on the tree.

## Consequences

- The merge no longer depends on or touches the human's working tree, so a dirty,
  off-default, or mid-merge shared checkout no longer blocks or corrupts it.
- No local merge hooks run, and `merge-tree --write-tree` is blind to dirty /
  would-clobber-untracked state — accepted, since that state no longer blocks it.
- The ref advance desyncs the shared checkout. A best-effort resync fast-forwards
  an idle-clean-on-default checkout onto the merged commit; a dirty/off-branch
  checkout is the human's to resync, and the resync never blocks the merge.
- The commit-work merge lock is re-pinned to `--git-common-dir` (the merge now
  advances the shared ref, not one checkout); in the main checkout it coincides with
  `--git-dir`, so a main-checkout `keeper commit-work` still serializes against the
  merge while a linked lane's commit-work stays isolated.
- A concurrent local ref advance is a clean transient retry (CAS mismatch), and a
  crash-retry re-derives the same merge commit OID, so the retry is idempotent.
- The now-inert shared-checkout distress signals are neutered in a follow-up.
