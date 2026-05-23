## Description

Cite F6 — "No explicit test for concurrent epic-level and task-level
jobs on same epic." Evidence path: `test/reducer.test.ts:2177-2244`
mixes arrival orderings but uses three disjoint epics (`fn-A` plan-only,
`fn-B.1` work-only, `fn-C`/`fn-C.5` work-only). No single epic carries
both `epic.jobs` (plan- or close-verb fan-out) AND a child
`task.jobs[*].jobs` (work-verb fan-out) simultaneously. The carve-out
tests at lines 2105 and 2131 cover each direction in isolation but
never the joint case.

Add ONE new test to `test/reducer.test.ts` that:

1. Fires an `EpicSnapshot` for `fn-DUAL` (or similar fresh epic id).
2. Fires a plan-verb `SessionStart` with `spawn_name: "plan::fn-DUAL"`
   (lands in `epic.jobs`).
3. Fires a `TaskSnapshot` for `fn-DUAL.1`.
4. Fires a work-verb `SessionStart` with
   `spawn_name: "work::fn-DUAL.1"` (lands in `epic.tasks[0].jobs`).
5. Drains; asserts `epic.jobs.length === 1` AND
   `epic.tasks[0].jobs.length === 1` with the correct `job_id`s.
6. Fires a second `EpicSnapshot` for `fn-DUAL` (ON CONFLICT path);
   drains; asserts BOTH arrays survive byte-identically (same length,
   same `job_id`s, same `last_event_id` on each embedded element).

Reuse the existing helpers (`insertEvent`, `drainAll`, `getEpic`,
`getEpicJobs`, `getTaskJobs`) — do not invent new fixtures. Keep the
test under ~50 lines.

## Acceptance

- [ ] New test added to `test/reducer.test.ts`, near the existing
      embedded-jobs tests (around lines 2105-2244 cluster).
- [ ] Test passes against current `src/reducer.ts` (no regression — this
      is a coverage-gap fill, not a bug-fix).
- [ ] `bun test test/reducer.test.ts` passes end-to-end.
- [ ] Test exercises both pre-`EpicSnapshot` and post-`EpicSnapshot`
      assertions on both arrays (proves the carve-out preserves BOTH
      directions jointly, not just each in isolation).

## Done summary

## Evidence
