## Overview

A task whose acceptance depends on the LIVE daemon running the epic's own fix is
structurally unverifiable mid-epic: task fan-in reaches the epic base lane, but base→main
deploy happens only at close-finalize, so no task can ever observe its own fix deployed.
Witnessed on the bus-wedge epic: a live-host acceptance line stamped done against harness
evidence while production still crash-looped, and a measurement task escalated BLOCKED on
the same trap — resolved only by manual operator lane-merges to main. Fix the guidance so
plans never mint that shape again, and document the sanctioned operator deploy procedure.

## Quick commands

- `keeper prompt render bundle/engineering-rules` — where cross-cutting planning rules surface

## Acceptance

- [ ] Plan-skill spec-writing guidance states that live-deployed-daemon verification belongs to the operator/await layer, never task acceptance
- [ ] The operator mid-epic deploy procedure (manual lane-merge to main) is documented on the operator surface

## References

- A sanctioned `keeper` mid-epic deploy verb was considered and deliberately deferred — guidance first; revisit only if the manual procedure recurs painfully.
