# 16. Stale-aware, board-visible shared-checkout catch-up

## Status

Accepted. Supersedes in part the best-effort-resync consequence of
[ADR 8](0008-plumbing-base-default-merge.md).

## Context

ADR 8 made the base→default merge working-tree-free: a git plumbing pipeline
advances `refs/heads/<default>` without ever running `git merge` in the shared
checkout. That decision left one loose end — decision-B, the post-ref-advance
resync of the shared working tree. As originally shipped it was gated on an
idle-clean-on-default probe and, when eligible, ran `git reset --hard <newTip>`;
a dirty or off-branch checkout was "the human's to resync" and the skip was
silent and treated as cosmetic. Two problems fell out of that stance:

1. The idle-clean gate meant ANY uncommitted edit — however unrelated to the
   merge — skipped the resync entirely, so the shared checkout silently trailed
   landed history. Everything served off the working tree (selector policy,
   skills, worker templates, the daemon's own source at next boot) then went
   stale with no signal.
2. `reset --hard` has no path-level safety — it could only run over a pristine
   tree, so it was gated off precisely when a human had work to protect.

## Decision

The post-ref-advance resync is now STALE-AWARE, and a resync that does not bring
the checkout current is BOARD-VISIBLE rather than silently cosmetic.

- **Catch-up primitive.** `git update-index -q --really-refresh` then
  `git read-tree -m -u <preMergeTip> <newTip>`, both trees passed explicitly
  (`preMergeTip` is the CAS `<old>`; `<newTip>` the merged value — post-CAS HEAD
  already names the new tip and would be the wrong `$H`). This is the plumbing
  form of `pull --ff-only`'s twoway_merge: stale (unmodified) paths advance,
  locally-edited untouched paths carry forward byte-identical, and a single path
  both upstream-changed AND locally-edited aborts the ENTIRE op with no writes.
- **Gate.** On-default AND no `MERGE_HEAD` (the old status-clean gate is gone — an
  uncommitted edit no longer skips the catch-up). It runs under the common-dir
  flock; the `--really-refresh` immediately before read-tree settles the stat
  cache, closing the racy-clean window (a full second on APFS) so a same-second
  human edit trips the safe abort instead of being silently clobbered.
- **Best-effort.** Every subprocess non-zero exit is swallowed and the merge
  result stays `merged` — the ref advance already landed, so no catch-up failure
  can change the merge outcome, throw, or block the advance.
- **Board-visible.** When the catch-up does not bring the checkout current
  (skipped off-default / mid-merge, or aborted on a colliding edit), a per-repo
  `shared-checkout-desync` needs-human distress row is seeded; it level-clears
  once a later reconcile cycle observes the on-default checkout content-carrying
  the default tip.

## Alternatives considered

- **Keep `reset --hard`, widen its gate to run over a dirty tree.** Rejected:
  reset --hard has no path-level safety and would clobber the human's unrelated
  edits wholesale. read-tree's twoway_merge is the only primitive that advances
  stale paths while preserving edits and aborting atomically on a true collision.
- **`git checkout <newTip> -- <paths>` / `checkout -f` / hand-written blobs.**
  Rejected: pathspec checkout silently overwrites unstaged edits, and hand-rolled
  writers reopen the CVE-2021-21300 path-traversal class. read-tree routes every
  write through git's symlink / path-traversal protections and leaves sparse
  skip-worktree paths untouched.
- **Serialize the human-editor race with the flock.** Rejected: the flock
  serializes daemon-vs-daemon only; the human-editor race is closed by the
  refresh + read-tree's atomic abort, not the lock.

## Consequences

- An on-default checkout with no conflicting edits is caught up in the same merge
  call — stale paths advance, human edits are preserved — so the served working
  tree no longer silently trails landed history.
- A genuine edit-vs-merge collision aborts the catch-up with zero writes and
  leaves the `shared-checkout-desync` row standing as the honest signal to
  resolve; the row is not retry-clearable and survives teardown + daemon restarts.
- The catch-up never runs mid-merge or off-default, so a half-merged or borrowed
  checkout is never disturbed.
- No `SCHEMA_VERSION` change: the desync signal is a live-only distress row,
  event-seeded on the skip/abort and cleared by a per-cycle content probe.
