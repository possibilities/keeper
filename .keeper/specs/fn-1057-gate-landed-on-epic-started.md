## Overview

`keeper await landed <epic>` fires a spurious immediate met for a never-started epic: the lane-merged producer's absent-implies-merged inference treats a lane that was NEVER cut the same as one torn down after a true merge. Gate the absent branch on evidence the epic ever started, so landed HOLDS for a not-yet-started epic (live repro: a freshly scaffolded dep-blocked epic read "lane merged to default" within a second of arming).

## Quick commands

- `bun test test/autopilot-worker.test.ts test/await-conditions.test.ts`

## Acceptance

- [ ] A never-started epic with an absent lane produces NO merged-lane entry; a started epic whose lane was merged-and-torn-down still does; probe-failure arms stay conservative; worktree-off degrade untouched
