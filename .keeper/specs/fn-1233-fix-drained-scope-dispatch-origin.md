## Overview

The `keeper await drained` plan/inflight scope axis keys its keeper-dispatch
discriminator on `jobs.dispatch_origin`, but that column is not served on the
`jobs` collection wire, so at runtime `job.dispatch_origin` is `undefined` and
`isKeeperDispatched` returns false for EVERY running job — the discriminator is
inert in production. This follow-up sources `dispatch_origin` into the drained
running-job set so plan/inflight scope actually gates on keeper-dispatched work,
and adds integration coverage that drives the REAL wire projection (not the
`jobRow` fixture that injects the column directly and hid the defect).

## Acceptance

- [ ] `keeper await drained --scope inflight` reports waiting while a dispatched
      (autopilot/escalation) job is in the `working` state, and met only once it
      clears.
- [ ] `keeper await drained` (plan scope) holds while an escalation session
      (`dispatch_origin='escalation'`, `plan_verb=NULL`) is live, even when all
      plan/close rows read completed.
- [ ] The drained running-job set carries a real `dispatch_origin` value sourced
      through the actual server projection, not a test-only injected field.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | dispatch_origin absent from JOBS_DESCRIPTOR.columns; CLI reads it off the snap.jobs wire so it is always null and isKeeperDispatched is false for every job — plan/inflight discriminator dead in production. |
| F2 | merged-into-F1 | .1 | F2 (no test drives the real jobs-wire projection for dispatch_origin) is the coverage gap that hid F1; its fix re-adds that test, so F2 folds into F1's task. |
| F3 | merged-into-F1 | .1 | F3 (no e2e coverage that ownSessionId self-excludes the caller through the drained projection) shares F1's code path and only goes live once F1 lands, so F3 folds into F1's task. |

## Out of scope

- The heartbeat, `--probe`, adaptive idle-poll, exit-code, and docs work from the
  source epic — audited clean, no changes.
- `board` scope behavior — unaffected (it counts every working job with no
  dispatch-origin filter).
