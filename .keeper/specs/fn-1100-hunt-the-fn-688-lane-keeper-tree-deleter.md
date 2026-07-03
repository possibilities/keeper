## Overview

The stale worktree lane keeper-qzvs8i--keeper-epic-fn-688-port-promptctl-into-keeper-prompt
twice accumulated working-tree-only deletions of the ENTIRE .keeper tree (1,879 files,
deletions only, zero untracked/modified) — restored clean by hand once, re-dirtied within
hours. Its branch also tracks near main-tip oddly for a lane that should be long dead.
Something is actively running destructive filesystem or git operations with cwd (or paths)
inside that lane. Two sticky rows (worktree-recover + worktree-finalize for fn-688) hold its
teardown visible; a third sticky row (close::fn-884-docs-metadata-sidecar-migration,
worktree-provision-failed branch collision) is same-era debris. Find the deleter, end it,
tear the lane down for good, clear all three rows.

## Quick commands

- `git -C /Users/mike/worktrees/keeper-qzvs8i--keeper-epic-fn-688-port-promptctl-into-keeper-prompt status --porcelain | head` — the recurrence check
- `keeper find-file-history .keeper/specs` — who touches plan state, by session

## Acceptance

- [ ] The deleting process/mechanism is identified with evidence and stopped at its source
- [ ] The fn-688 lane and branch are torn down; the two fn-688 sticky rows and the fn-884 row are cleared and stay cleared
