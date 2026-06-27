## Description

Addresses F2 (+ merged F3). The diff introduced fn-id provenance into
non-test source comments, violating CLAUDE.md rule #0 ("no fn-ids ... in
comments and docs"):
- src/autopilot-worker.ts:614 — "fn-988: every git-tracked project dir ..."
- src/autopilot-worker.ts:3449 — "fn-988: the recover sweep's KNOWN-ROOTS set ..."
- src/autopilot-worker.ts:2695 — "the fn-973 pileup + the rib leak"
- src/autopilot-worker.ts:2901 — "(no fn-987 regression)"

Drop the ticket ids; the surrounding prose already states current behavior,
so the invariant survives without the provenance reference.

## Acceptance

- [ ] No fn-id (fn-988 / fn-973 / fn-987) remains in the four cited autopilot-worker.ts comments.
- [ ] Each comment still states the current invariant in forward-facing terms; no behavior change.

## Done summary

## Evidence
