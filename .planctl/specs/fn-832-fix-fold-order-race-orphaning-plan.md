## Overview

Autopilot worker jobs are sometimes orphaned from their plan task: the board
shows the task `[::blocked:dispatch-pending]` with no worker row even though a
worker process is live. Root cause is a fold-ordering race in the jobs
projection — when a worker's `UserPromptSubmit` event folds before its
`SessionStart`, the `UserPromptSubmit` fork-seed mints the `jobs` row first
(without `plan_verb`/`plan_ref`), so the later `SessionStart` takes its
`ON CONFLICT` resume branch, which never sets the pair (set-once-on-spawn-INSERT).
The job stays unbound forever: the `pending_dispatches` row never discharges
and the job never fans into `epics.tasks[].jobs[]`.

Fix forward-only in `src/reducer.ts` `projectJobsRow`: in the SessionStart
resume branch, COALESCE-fill `plan_verb`/`plan_ref` when the prior row's pair
is NULL, and widen the discharge-on-bind DELETE to fire on that NULL->non-NULL
heal transition. Pure fold change — no schema bump, no migration, no re-fold.
End state: a worker binds to its task regardless of `UserPromptSubmit` /
`SessionStart` fold order, and the board self-heals.

## Quick commands

- `bun run test:full` — mandatory; this touches the reducer/db fold path.
- `bun test test/reducer-plan.test.ts test/reducer-projections.test.ts` — fast inner loop on the two affected shards.

## Acceptance

- [ ] A worker whose `UserPromptSubmit` folds before its `SessionStart` ends bound to its task (`plan_verb`/`plan_ref` set, `pending_dispatches` discharged, no longer `dispatch-pending`).
- [ ] The existing set-once and resume-no-discharge invariants still hold, unmodified.
- [ ] `bun run test:full` is green.

## Early proof point

Task that proves the approach: `.1` — specifically the new ordering test in
`test/reducer-projections.test.ts` (UserPromptSubmit-with-pid then SessionStart)
asserting heal + discharge. If it fails: the gate is almost certainly reading
`plan_ref` AFTER the UPSERT (always non-NULL) instead of the PRE-UPSERT prior
value — re-key the gate on the widened `priorJob` SELECT.

## References

- Bug confirmed by deep investigation + a two-model panel (Opus 4.8 + GPT-5.5): the orphaned worker for `fn-823-…1` (job `d136d077`) had `plan_verb`/`plan_ref` empty; its `created_at` equals the `UserPromptSubmit` ts (proving the fork-seed minted the row).
- SQLite upsert semantics (practice-scout): `COALESCE(jobs.col, excluded.col)` is fill-if-null; the reversed order is always-overwrite. Use COALESCE in the SET list, NOT a `WHERE jobs.col IS NULL` guard (the guard would no-op the entire DO UPDATE, which must still update pid/state/etc unconditionally).
- Overlap heads-up (NOT a blocking dep): `fn-826`.1 edits `src/reducer.ts:5150-5180` (plan_invocation envelope reader) + `src/derivers.ts:442`, and `fn-831` rewrites the reducer minting path + a `source`-column migration. Different regions from `projectJobsRow`, low merge risk — whoever lands those after this should expect a trivial rebase in `src/reducer.ts`. Left unwired so this live-bug fix can land independently.

## Docs gaps

- **`src/reducer.ts` ~6227-6240**: revise (don't append) the stale `{plan|work|close|approve}` comment and the set-once / discharge-gate prose to describe the COALESCE-heal-on-resume behavior, forward-facing.
- **`src/readiness.ts:669`**: comment still references `approve::` — reconcile to the `(plan|work|close)` whitelist.
- **`test/reducer-projections.test.ts:1327`**: comment still says `{plan|work|close|approve}` — reconcile.
- **`README.md` :16-19, :2008, :2615**: prose on plan_verb/plan_ref derivation + discharge-on-bind describes pre-fix behavior; revise forward-facing (no "as of vN" note — this carries no schema change).
