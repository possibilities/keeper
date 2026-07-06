## Overview

The fan-in lane pre-merge shipped a self-clearing `worktree-lane-premerge`
row for both the work-cell and the close-sink provision paths, but the
close-sink twin mints its row keyed on the repo toplevel instead of the lane
worktree path, so it can never match the reason-scoped level-clear and
lingers as operator noise until a manual `retry_dispatch`. This follow-up
fixes the mis-keyed emit so the close-sink row self-clears like its work
twin, and adds the regression test the current sink coverage misses.

## Acceptance

- [ ] A non-primary close-sink premerge failure mints its row keyed on the sink lane worktree path, and the row self-clears once the lane resolves.
- [ ] A test exercises a real close-sink premerge failure (not the dead retry:true shape) and asserts both the emitted dir and the self-clear.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | autopilot-worker.ts:3006 mints the close-sink premerge row with dir:sink.repoDir; laneFailuresToClear (:566) clears only rows whose dir is a resolved lane PATH, so it never self-clears — fix `dir: provisioned.dir ?? sink.repoDir`. |
| F2 | merged-into-F1 | .1 | F2 (no real close-sink premerge test — existing test drives the dead retry:true shape) is the regression guard for F1's fix; folded into F1's task. |
| F3 | culled | — | The wt.retry/provisioned.retry branches (2820/2995) are dead but defensively guard the interface's documented retry?:boolean provision contract; speculative-generality cleanup, no user impact. |

## Out of scope

- Removing the dead `retry === true` provision branches (F3) — they defensively guard a documented interface return; deferred to a natural next touch.
- The work-cell premerge path, which is already correctly keyed on the lane path and covered.
