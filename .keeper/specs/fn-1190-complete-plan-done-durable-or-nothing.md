## Overview

The durable-or-nothing done feature left two defects on the exact recovery
edge paths it exists to serve, both invisible to its suite because the fake
VCS models `git add` as a no-op. The commit-failure unwind restores the
working tree but leaves the done bytes staged in the shared index, and the
STATE_UNCOMMITTED self-heal blanks a task's recorded evidence. This epic
closes both so the "nothing" half of the guarantee holds and recovery loses
no data.

## Acceptance

- [ ] A failed mid-merge state commit leaves the git index at HEAD for the three state paths, not just the working tree.
- [ ] A `done` self-heal run without `--evidence` preserves the existing `## Evidence` section and runtime overlay evidence.
- [ ] Real-git (KEEPER_PLAN_RUN_SLOW) coverage proves the clean-index unwind and the evidence-preserving heal that the fake VCS cannot.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | onCommitFailure rewrites only working-tree bytes; commit.ts stages (git add) before the merge-refused pathspec commit and no unstage exists, so done bytes stay staged and a full-index merge-completion sweeps a durable half-stamp. |
| F2 | kept | .1 | heal preserves `## Done summary` via getTaskSection but unconditionally rebuilds evidenceText from the empty default, blanking `## Evidence` and the overlay on a `--evidence`-less self-heal. |

## Out of scope

- Any change to the happy-path commit sequence or the `emitMutating` seam beyond the unwind's index restore.
- Broadening the heal decision (`doneBackingCommitted` / `stateHeadVisible`) — the fail-safe refuse-on-unreadable-git behavior stands.
