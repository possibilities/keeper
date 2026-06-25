## Overview

The started-first scheduling order shipped in fn-949 is a no-op on a real
board: `isEpicStarted` (src/readiness.ts:106) marks an epic started whenever
`epic.jobs[]` is non-empty, but `syncJobIntoEpic` (src/reducer.ts:5413)
embeds the planning-time `plan::<ref>` job (parsePlanRef classifies a
bare epic ref as `kind=epic`) into `epics.jobs[]` for every planned epic.
Since essentially every epic is created via a `plan` session, every planned
epic reports `isEpicStarted === true` and the started/unstarted tiering
collapses — the autopilot never actually prefers in-progress epics. This
fixes the predicate so a planned-but-unworked epic is correctly NOT started,
restoring the scheduling benefit the epic promised.

## Acceptance

- [ ] A freshly-planned, never-worked epic (only a stopped `plan_verb='plan'`
      epic-form job, all tasks `runtime_status='todo'`) reports
      `isEpicStarted === false`.
- [ ] Genuine worker activity (a `close`/`approve` epic job, any task-form
      job, a task `runtime_status` off `todo`, or a `job_links` provenance
      entry) still reports `isEpicStarted === true`.
- [ ] The started-first reorder demonstrably tiers a planned-only epic behind
      a genuinely in-progress one through `orderEpicsForScheduling`.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | src/readiness.ts:106 marks started on any epic.jobs entry; reducer.ts:5413 syncJobIntoEpic embeds the plan::<ref> planner job into epics.jobs[] for every planned epic, collapsing the started tier to a no-op. |
| F2 | merged-into-F1 | .1 | F2 (missing 'plan-only epic is NOT started' test) is the test side of F1's same root cause; the F1 fix must add this assertion, so F2 folds into F1's task. |

## Out of scope

- No change to the comparator/total-order in `orderEpicsForScheduling` (the
  stable sort itself was audited correct); only the `isEpicStarted` signal.
- No change to the `[started]` board pill rendering or the omit-default
  convention.
