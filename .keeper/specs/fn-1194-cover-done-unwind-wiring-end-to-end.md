## Overview

The done durable-or-nothing fix added a `restoreIndexToHead` index unwind on
the mid-merge commit-failure path, but its verb-level wiring is unverified
under real git: the slow-tier test reconstructs the unwind by calling the
facade by hand, and the fast tier's fake `restoreIndexToHead` is a no-op — so
the fast tier provably cannot catch a regression of the exact staged-half-stamp
bug the epic closed. Add one end-to-end slow-tier case that drives the `done`
verb through the mid-merge refusal and asserts a clean index.

## Acceptance

- [ ] A slow-tier (`KEEPER_PLAN_RUN_SLOW`) case runs the `done` verb itself
      against a real mid-merge repo and asserts `git diff --cached` is empty
      after the commit-failure unwind.
- [ ] The case would fail if `onCommitFailure` dropped or mis-pathed the
      `restoreIndexToHead` call.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept   | .1 | Slow-tier test reconstructs the unwind and never drives runDone; fake restoreIndexToHead is a no-op, so verb-level index-reset wiring is unverified under real git. |
| F2 | culled | —  | Discarded GitResult on a reliable path-form reset that matches the block's best-effort convention; remedy is defensive logging for a theoretical failure. |
| F3 | culled | —  | F1/F2 audit labels in test titles/comment are cosmetic; each title carries the full behavioral description beside the label. |
| F4 | culled | —  | Malformed/array merged.evidence heal is a benign non-destructive asymmetry, an untested edge below the keep bar. |

## Out of scope

- Surfacing/logging a failed `restoreIndexToHead` GitResult (F2) — matches the block's best-effort convention.
- Rewording the F1/F2 provenance labels in test names (F3).
- A case for malformed/array `merged.evidence` (F4) — benign asymmetry.
