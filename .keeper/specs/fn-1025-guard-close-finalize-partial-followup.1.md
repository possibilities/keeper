## Description

Finding F1 (Should Fix). The close-finalize partial_followup test at
plugins/plan/test/saga-close-finalize.test.ts:539-573 asserts env.outcome,
expected_tasks, actual_tasks, and epicStatus==open, but never asserts the
scaffolded follow-up stays a null ghost. The deliberate exclusion of
partial_followup from the arm block lives only in the comment at
plugins/plan/src/verbs/close_finalize.ts:638-644 and the structural fact
that the partial path never reaches the CLOSED_WITH_FOLLOWUP arm (line 645).
A refactor that armed all follow-ups would make an under-provisioned epic
autopilot-dispatchable with no test to catch it.

## Acceptance

- [ ] In the partial_followup test, after finalize, read epics/<followId>.json and expect last_validated_at toBeNull(), mirroring the positive-path assertions on the closed_with_followup tests.
- [ ] bun test stays green.

## Done summary

## Evidence
