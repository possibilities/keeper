## Overview

The fan-in/recover lossless-cleanability probe treats keeper's own ADR-0074 dependency
plant (the `node_modules` symlink `ensureWorktreeDepLink` provisions in every keeper-created
worktree) as untracked work product a merge could overwrite, so an epic base lane carrying
only the plant wedges `worktree-lane-wedge` past the recovery grace and the close stalls
until an operator hand-removes the symlink. `isWorktreeDepPlant` (worktree-git.ts) is
documented as the SOLE plant-identity definition, but only the teardown residue classifier
consults it. End state: a byte-identical plant never blocks a fan-in or recover merge —
the probe recognizes it via the same seam teardown uses, and the lane self-heals.

## Quick commands

- `bun test ./test/worktree-isolation.test.ts` — the fan-in cleanability suite including the plant-recognition cases.

## Acceptance

- [ ] a lane whose only untracked entry is a byte-identical dep plant is judged losslessly cleanable by the fan-in/recover probe
- [ ] a retargeted or replaced plant (non-byte-identical) still blocks as work product

## Early proof point

Task that proves the approach: `.1`. If it fails: keep the wedge but name the plant in the distress reason so the operator action is one obvious `rm`.

## References

- docs/adr/0074 (universal symlink provisioning; teardown byte-identity rule)
- ~/docs/keeper-phase2-backlog.md item #13 (live evidence: fn-2 lane wedge `worktree-lane-wedge:16bnqzb`, 07-19 04:4x)
