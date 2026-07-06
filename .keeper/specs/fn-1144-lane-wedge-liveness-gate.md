## Overview

Autopilot's per-lane `worktree-lane-wedge` needs_human distress escalation
fires as a false positive on healthy, actively-running workers: a running
task's fan-in base lane is naturally dirty with uncommitted WIP, and once it
stays not-losslessly-cleanable past the 5-minute grace it pages the operator
for a condition that self-heals the instant the worker commits. This gates the
escalation on owning-worker liveness+progress in the producer, so only a dead
or stalled worker's wedge pages a human. The sibling `shared-checkout-wedge`
(minted from a different producer, `src/daemon.ts`, and currently neutered in
the worker recover block) has the same theoretical false positive and is a
separate follow-up, not part of this task.

## Quick commands

```
grep -an "LANE_WEDGE_GRACE_SEC|laneWedged|emitSharedWedgeDistress" src/autopilot-worker.ts
bun test test/autopilot-worker.test.ts
```

## Acceptance

- [ ] A graced lane wedge whose owning worker is alive+progressing stays a
  quiet self-clearing note (no needs_human row); a dead/stalled worker's lane
  still escalates.
- [ ] `immediate` abort-failed lanes still escalate at once; the premerge
  level-clear path is untouched; the liveness probe stays producer-side.
