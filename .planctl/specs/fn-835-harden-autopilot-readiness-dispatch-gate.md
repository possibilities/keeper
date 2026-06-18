## Overview

Two pure read-time bugs in `computeReadiness` (`src/readiness.ts`) let the autopilot
reconciler misbehave, both surfaced by a real incident and verified by a multi-model
panel (one reproduced by driving the mutex directly):

1. **Dispatches `blocked` tasks.** `computeReadiness` never consults planctl
   `runtime_status`; it gates on `worker_phase`/deps/occupancy/pending only. A task
   marked `blocked` (e.g. after its worker was killed) still has `worker_phase=open`,
   so it computes as `ready` and the reconciler dispatches a worker that can't progress.
2. **Armed-mode close-row root starvation.** The per-root mutex's pass-2a settles
   close rows eligibility-blind, so an unarmed-but-`ready` close row (a done-but-open
   epic on a shared repo root) claims the root and demotes the eligible armed task to
   `blocked:single-task-per-root` — while the launcher SUPPRESSES that close launch.
   Net: armed mode dispatches NOTHING while such an epic sits done-but-unclosed.

Both fixes are pure/read-time (NOT in any fold) — re-fold determinism, never-throw, and
exactly-once-cursor are not in play. No schema bump.

## Quick commands

- `bun test test/readiness.test.ts test/autopilot-worker.test.ts`
- `bun run test:full`  (mandatory — readiness feeds the dispatcher)

## Acceptance

- [ ] A `runtime_status="blocked"` task is never dispatched (readiness returns a blocked verdict).
- [ ] In armed mode, an ineligible `ready` close row no longer starves an eligible same-root task.
- [ ] `bun run test:full` green.

## Early proof point

Task `.1` — the armed close-row test (fn-830 + fn-832 shapes on the keeper root). If it
fails, the eligibility predicate doesn't match the launcher's; re-mirror `autopilot-worker.ts:1000-1007`.

## References

- Panel reproduced bug 2 by driving `applySingleTaskPerRootMutex` with live fn-830 (done-but-open, keeper root) + fn-832 (armed) shapes: fn-830's close row claims the root, launch suppressed → nothing dispatches.
- `runtime_status` confirmed 0 occurrences in `src/readiness.ts` and `src/autopilot-worker.ts`.
