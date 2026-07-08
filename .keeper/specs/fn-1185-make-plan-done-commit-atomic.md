## Overview

`keeper plan done` can record the done projection/event even when its git commit of the
`.keeper` state files fails (e.g. "cannot do a partial commit during a merge" while the
shared checkout is mid-fan-in). The projection then says done with no durable commit backing
it, and every CLI path refuses to move the task in either direction — `done` (plain and
`--force`) says "already done", `block` says "done and cannot be blocked" — leaving the
board wedged until an operator hand-writes the state files and commit. The worker-side
auto-escalation also breaks: a task that cannot be stamped blocked never pages its planner.

## Quick commands

- `bun test test/plan-done*.test.ts` (or the suite owning the done path) — ordering + unwind covered

## Acceptance

- [ ] A `keeper plan done` whose state-file commit fails leaves NO durable "done" the CLI cannot back out of — either the projection reflects the failure or a sanctioned reconcile path exists
- [ ] The mid-merge shared-checkout window (MERGE_HEAD present) is handled deliberately: the done write retries, defers, or fails loudly WITHOUT the half-stamped state
- [ ] A regression test reproduces the failed-commit-after-event shape and proves the unwind

## Early proof point

Task ordinal 1. If the done path's event emission proves impossible to sequence after the
commit without breaking live consumers, stop and surface the alternative (a reconcile verb)
to the operator before restructuring.

## References

- Worker diagnosis (fn-1179.1 transcript): first attempt hit the mid-merge window, git commit failed, projection recorded done from the attempt's live event; plain and --force retries refused upstream of the override
- Operator reconciliation commits restoring the backing for the two wedged tasks (abdfba47, e1159bac) — the manual write this epic obsoletes
