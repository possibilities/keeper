## Overview

Implement Rule #1 "prefer started epic" by extending keeper's shared
readiness/ordering layer (the follow-up to fn-936, which centralized
scheduling order behind `orderEpicsForScheduling`). A pure `isEpicStarted`
predicate plus a started-first stable sort in that one seam makes the
autopilot finish in-progress epics before opening new ones — and because the
board, the autopilot reconciler, and the `keeper autopilot` viewer all
already route through the seam, every view stays consistent automatically.
The priority is a pure read-time computation over task/job activity, never
persisted in epic/board state (fn-936 ensured that). A light `[started]`
board pill makes the reorder legible. Hard-categorical (no anti-starvation
guard) — the per-root mutex serializes same-root epics one-at-a-time, so
"prefer started" self-bounds to "finish A, then B, then C" in creation order.

## Quick commands

- `keeper plan board --snapshot` — started epics sort first; a `[started]` pill marks them.
- `bun run test:full` — readiness + autopilot + board paths.

## Acceptance

- [ ] A pure `isEpicStarted(epic)` predicate exists; an epic with any associated job OR any task `runtime_status != "todo"` is started; a fresh epic (no jobs, all-todo) is NOT (the resting `worker_phase` does not count); null-safe on every field.
- [ ] `orderEpicsForScheduling` is a stable total-order sort (started-first, `epic_number ASC` null-last, `epic_id` final tiebreak); pure; returns a fresh array.
- [ ] The composed reorder→mutex holds: a started epic's ready task wins a shared root over an unstarted same-root sibling; composes inner to armed-mode eligibility.
- [ ] All three consumers reorder via the seam; no ordering logic added in any consumer.
- [ ] A `[started]` board pill renders only when started (omit-default).
- [ ] Hard-categorical — no aging/floor/threshold.
- [ ] `bun run test:full` green.

## Early proof point

Proves the approach: the composed reorder→mutex test (a started epic beats a
lower-`epic_number` unstarted same-root sibling for the root slot). If it
fails, the seam reorder isn't reaching the per-root mutex tiebreak — re-check
that `loadReconcileSnapshot` orders before `computeReadiness`.

## References

- Follow-up to fn-936 (the `orderEpicsForScheduling` seam this fills).
- `src/board-render.ts:286` `armedPill` — the omit-default pill template to mirror for `[started]`.
- Starvation is bounded by the per-root single-task mutex (deliberate hard-categorical choice).
