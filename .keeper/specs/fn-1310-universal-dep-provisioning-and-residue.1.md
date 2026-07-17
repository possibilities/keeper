## Description

**Size:** S
**Files:** src/worktree-git.ts, src/autopilot-worker.ts, src/baseline-worker.ts, test/worktree-git.test.ts

### Approach

Extract the lane dependency-symlink provisioning into one exported seam in the worktree-git module and invoke it at every site where keeper creates a worktree — task lanes (already provisioned), epic bases, the baseline worker's fresh worktrees, and the recover pass's worktrees. The seam records exactly what it plants (link path, link type, target) so the teardown task can classify by byte-identity against the same definition. Enumerate the creation sites by finding every worktree-add call path rather than trusting this spec's file list.

### Investigation targets

*Verify before relying — planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/worktree-git.ts:1533-1566 — the existing lane provisioning to extract into the seam
- src/baseline-worker.ts — the baseline worktree creation site missing provisioning (the red-baseline signature's origin)
- src/autopilot-worker.ts — base/recovery worktree creation sites

### Risks

- A worktree-creation site with meaningfully different needs (bare repo probe, ephemeral clone) should skip provisioning explicitly, not accidentally.

## Acceptance

- [ ] Every keeper-created worktree that runs suites receives identical provisioning through the one seam
- [ ] A baseline suite run in a fresh worktree hits no missing-dependency failures
- [ ] The seam exposes its planted-artifact definition for the identity test

## Done summary

## Evidence
