## Description

Originating finding F1 (src/readiness.ts:106) with merged test finding F2.
Evidence path: `isEpicStarted` returns `true` on any non-empty
`epic.jobs?.length`, and `syncJobIntoEpic` (src/reducer.ts:5413, via
`parsePlanRef` classifying a bare epic ref as `kind=epic` —
src/derivers.ts:409) embeds the planning-time `plan::<ref>` session's job
into `epics.jobs[]`. That job persists (state `stopped`) after planning,
so virtually every planned epic carries an epic-form `plan` job and
`isEpicStarted` returns `true` universally — collapsing the started/unstarted
tiering to a no-op.

Fix `isEpicStarted` so a planning-time `plan`-verb epic-form job does NOT
count as "real worker activity". The started signal should key on genuine
activity — a `close`/`approve` epic job, a task-form job, a task
`runtime_status` off `todo`, or a `job_links` provenance entry — but treat
an epic whose ONLY epic-form job is a `plan` verb (with no other activity)
as NOT started. Update the JSDoc to match the corrected semantics
(the current JSDoc claims any epic-form `plan`/`close`/`approve` job marks
started — that line is the bug, stated as intent).

## Acceptance

- [ ] An epic whose only epic-form job is `plan_verb='plan'` (all tasks
      `runtime_status='todo'`, no task jobs, no `job_links`) reports
      `isEpicStarted === false` — new test pinning this (closes F2).
- [ ] An epic with a `plan_verb='close'` (or `approve`) epic-form job still
      reports `isEpicStarted === true` (existing test preserved).
- [ ] Task-form jobs, `runtime_status` off `todo`, and `job_links` entries
      each still independently mark started (existing tests preserved).
- [ ] `orderEpicsForScheduling` tiers a plan-only epic behind a genuinely
      started one.
- [ ] `isEpicStarted` stays pure and null-safe (no throw on malformed
      fields); existing null-safety tests preserved.

## Done summary
Fixed isEpicStarted to skip the planning-time plan-verb epic-form job so a planned-but-unworked epic reads unstarted, restoring the started-first scheduling tier. Added tests pinning plan-only-not-started, non-plan-job-started, and a plan-only-tiers-behind-in-progress reorder.
## Evidence
