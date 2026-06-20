## Overview

The single-task-per-root and single-task-per-epic mutexes in
`src/readiness.ts` walk `epicsArr` in array order and let the FIRST
non-completed verdict claim the slot, while only `ready` verdicts get
demoted on subsequent collisions. When a `ready` task iterates BEFORE
a `job-running` task in the same root, the ready task wins the slot
and autopilot dispatches it — even though the other task already has
live work running.

Witnessed 2026-05-27 in keeper: fn-624.1 (ready) dispatched by autopilot
while fn-626.1 (manually-started `work`, same root `/Users/mike/code/keeper`)
was already `working`. Two `work` jobs in the same root.

Fix the iteration-order sensitivity in both mutexes and add the missing
symmetric test for the ready-first ordering.

## Acceptance

- [ ] Both mutex functions are order-independent: a `job-running`/`sub-agent-running`/`working` task LATER in `epicsArr` blocks a `ready` task EARLIER in `epicsArr` within the same root (root mutex) and same epic (epic mutex).
- [ ] New regression tests cover the ready-first ordering for both functions.
- [ ] All existing readiness tests continue to pass.
