## Overview

A worktree lane cut before its cross-epic upstream landed carries a base missing the upstream's files; workers then hit DEPENDENCY_BLOCKED with nothing on the board naming the cause (the merge-gate only defers cuts, by construction it cannot see a lane already cut stale). Add a producer-side stale-base probe alongside the merge-gate probes plus a self-clearing per-(epic,repo) distress row via the established grace-tracker idiom — detection and loud surfacing only, never auto-remediation, never touching the cut-deferral logic.

## Quick commands

- `bun test test/autopilot-worker.test.ts test/dispatch-failure-key.test.ts` — probe, tracker, and key-family suites

## Acceptance

- [ ] A cut lane whose epic has a satisfied same-resolved-repo upstream whose landed work is missing from the lane base is flagged with exactly one self-clearing per-(epic,repo) distress row past a grace watermark; inconclusive probes never flag; the row clears when the lane is re-based or torn down; the merge-gate's cut-deferral behavior is byte-identical
