## Description

Source finding: F2 (no test for cross-session sweep in `syncPlanctlLinks`).

Evidence path: `src/reducer.ts:1192` (the `SELECT DISTINCT session_id ...
WHERE planctl_op IS NOT NULL AND (planctl_epic_id IN (...) OR
planctl_target IN (...))` sweep that expands the re-derive set when a
touched-epic's edge changed across sessions) and `test/reducer.test.ts`
(existing live fan-out tests cover same-session re-derive only). The
cross-session path is the "session A drops a refiner edge → session B's
classifier needs to re-derive against the new state" branch — without
coverage, a stale `job_links` entry could linger silently and a re-fold
from scratch would diverge from steady-state.

Add a reducer test that:

1. Seeds two sessions, both with planctl invocations referencing the
   same epic.
2. Drops a refiner edge in session A (via a follow-up invocation that
   re-classifies session A's window).
3. Folds the follow-up event.
4. Asserts session B's `epic_links` reach the correct post-state AND
   the touched epic's `job_links` no longer contains the stale
   session-A edge (while session B's job_links entries stay intact).

The test should fail if the cross-session sweep is short-circuited to
same-session only.

## Acceptance

- [ ] New test in `test/reducer.test.ts` covers the cross-session
      sweep branch of `syncPlanctlLinks`.
- [ ] Test fails if the cross-session expansion at `reducer.ts:1192`
      is short-circuited to same-session only.

## Done summary

## Evidence
