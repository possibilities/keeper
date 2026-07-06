## Description

**Size:** S
**Files:** src/worktree-git.ts, src/autopilot-worker.ts

### Approach

Add an exported `shortBranchName(ref: string): string` to src/worktree-git.ts:
strip a single leading `refs/heads/` and return the remainder; a ref without the
prefix passes through unchanged. Pure — no IO, no clock, never throws. Then route
the three existing inline strips through it: `isKeeperLaneEntry` and
`epicIdFromKeeperLaneEntry` in src/worktree-git.ts, and the lane-base readiness
probe (`probeLaneBaseReadiness`) in src/autopilot-worker.ts, importing the helper
there. No behavior change — the abbreviated result must be byte-identical to each
site's current inline strip. This kills the duplicated pattern whose drift caused
a clean-lane-reads-off-branch bug.

### Investigation targets

*Verify before relying — file:line accurate at authoring time, but the repo moves.*

**Required** (read before coding):
- src/worktree-git.ts `currentBranch` (~line 385) — the abbreviated form the helper
  must match; place `shortBranchName` right after it
- src/worktree-git.ts `isKeeperLaneEntry` (~line 1186) — inline strip to replace
- src/worktree-git.ts `epicIdFromKeeperLaneEntry` (~line 1205) — inline strip to replace
- src/autopilot-worker.ts `probeLaneBaseReadiness` (~line 4874, the `gitMergeReadiness`
  call) — inline strip to replace; add the import from ./worktree-git

## Acceptance

- [ ] `shortBranchName` is exported from src/worktree-git.ts, pure, and the three
      former inline strips all call it (no remaining inline `refs/heads/` slice in
      those three functions)
- [ ] `bun test test/worktree-git.test.ts test/autopilot-worker.test.ts` is green

## Done summary

## Evidence
