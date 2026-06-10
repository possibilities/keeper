## Overview

In armed mode, the autopilot eligibility gate is WORK-ONLY, so a close-ready
epic that was never armed and has no live worker still gets `close::`
dispatches (2026-06-10: unarmed planctl fn-12 burned repeated closer workers
while only fn-15 was armed). Narrow the close-dispatch verdict so cold
close-candidates autopilot never touched are suppressed, while a
disarmed-mid-flight epic (live job, live surface, or armed dep-closure
membership) still finishes, closes, and reaps.

## Quick commands

- `bun test test/autopilot-worker.test.ts` — pure reconcile unit tests
- `bun run test:full` — mandatory gate (daemon/worker path; fast tier does not cover it)

## Acceptance

- [ ] In armed mode a close-ready epic that is NOT in the eligible closure, has NO occupying job, and NO live `close::`/`work::` surface gets no close dispatch; an in-flight epic (any of those signals) still closes; completion-reap and yolo mode unchanged
