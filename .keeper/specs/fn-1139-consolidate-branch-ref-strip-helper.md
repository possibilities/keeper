## Overview

Three sites inline the identical `refs/heads/` prefix strip to derive an
abbreviated branch name. Extract one shared, pure `shortBranchName` helper and
route all three through it — collapsing the duplicated-strip drift class that
already produced one production bug (a lane-readiness probe that compared a full
`refs/heads/...` ref against an abbreviated `currentBranch`, misclassifying every
clean lane off-branch). Pure refactor, no behavior change; the functional fix has
already landed.

## Quick commands

- `bun test test/worktree-git.test.ts test/autopilot-worker.test.ts` — both green

## Acceptance

- [ ] One exported `shortBranchName` helper exists in src/worktree-git.ts and all
      three former inline strips route through it, with the fast suites still green
