## Overview

A shared default-branch checkout left dirty (no MERGE_HEAD) silently retry-skips every epic's finalize with no loud surface — one dirty file once stalled four epics at once. Extend the mid-merge wedge grace-watermark idiom to the plain-dirty case: a sibling tracker mints ONE self-clearing per-repo needs_human distress row per continuous dirty episode, level-cleared when the recover pass observes the checkout clean. Finalize's deliberate non-sticky retry-skip stays exactly as is; the lane pre-merge path and merge-gate are out of scope.

## Quick commands

- `bun test test/autopilot-worker.test.ts test/dispatch-failure-key.test.ts` — tracker + key-family suites

## Acceptance

- [ ] A shared checkout dirty past the grace watermark mints exactly one per-repo, self-clearing, un-retryable distress row per continuous episode — distinct from the mid-merge wedge family — and it level-clears once the checkout is observed clean; transient dirt and finalize's retry-skip behavior are unchanged
