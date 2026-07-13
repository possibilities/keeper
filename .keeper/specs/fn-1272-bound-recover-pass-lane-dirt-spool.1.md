## Description

Fix F3 (with TG1 folded in). In src/autopilot-worker.ts the recover-pass
dirty-teardown branch (~L7168) calls gitBackupThenForceRemoveWorktree,
and the tracker's consider({state:"destroyable"}) (src worktree-git tracker,
~L1514) returns destroy:true on every post-grace cycle, so a lane wedged in
remove-failed re-enters the backup-then-force path each reconcile cycle. In
src/worktree-git.ts backupThenForceRemoveWorktree mints a fresh snapshotId
(timestamp + uuid) dir, writes staged/unstaged patches + copies untracked
dirt, appends one index.ndjson line, and on remove-failed returns without
removing snapshotDir (only the backup try/catch and backup-failed rm it) —
so each wedged cycle accretes a duplicate snapshot + index line unboundedly.

Bound it: reuse a stable per-lane snapshot id (or skip re-snapshotting once
a snapshot for this lane path already exists) so a persistently un-removable
lane produces at most one snapshot + index record. Preserve the existing
page-once distress and positive-evidence level-clear semantics, and keep a
genuinely re-tearable lane's teardown unchanged.

Files: src/autopilot-worker.ts (recover-pass dirty-teardown branch),
src/worktree-git.ts (backupThenForceRemoveWorktree / remove-failed path).

## Acceptance

- [ ] A lane stuck in remove-failed yields at most one dirt snapshot + one
      index.ndjson record across repeated recover cycles.
- [ ] remove-failed no longer leaves an orphaned snapshot per cycle; the
      page-once distress + level-clear behavior is unchanged.
- [ ] A regression test drives repeated force-remove failures over multiple
      recover cycles and asserts the spool stays bounded (folds in TG1).

## Done summary
Bounded the recover-pass lane-dirt spool: backupThenForceRemoveWorktree now derives a stable per-lane snapshot id and reuses an existing snapshot dir instead of minting a fresh one each cycle, so a lane wedged in remove-failed accretes at most one snapshot + one index.ndjson record across repeated recover cycles. Page-once distress and level-clear semantics unchanged; added a regression test driving 3 repeated force-remove-failure cycles asserting the bound.
## Evidence
