## Description

**Size:** S
**Files:** src/autopilot-worker.ts, src/dispatch-failure-key.ts, test/autopilot-worker.test.ts

### Approach

Stuck-sentinel rows are operator-ack-only by design (a self-tidying corrector is how the class hid for weeks), but the incident showed ack-rows outliving their referent: five of seven rows pointed at jobs already pruned from the projection — pure noise with nothing left to inspect. Reconcile the two principles: when the referenced job row no longer exists in the projection, the ack-row's evidentiary value is gone, so either garbage-collect it with a logged trace (preserving the evidence in the log surface) or prevent job pruning while an un-acked sentinel references it — decide in-code against the ADR-0013 rationale and amend that ADR with the choice. Live-job sentinel rows keep the operator-ack-only discipline unchanged.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/dispatch-failure-key.ts:355-388 — the sentinel key contract (retry_dispatch-only clear, synthetic id namespace, orphan-GC-exempt-by-retryability reasoning)
- docs/adr/0013 — the ack-only rationale being amended
- The jobs-projection prune path (locate where stopped rows leave the projection)

### Risks

- Over-eager GC re-creates the silent-tidy failure mode ADR-0013 exists to prevent — the trace must be loud enough to preserve the evidence trail.

### Test notes

Pure tests: a sentinel row whose job id resolves stays under ack-only; one whose job id is absent from the projection follows the chosen reconciliation (GC-with-trace or prune-block), asserted at the sweep seam.

## Acceptance

- [ ] No steady-state path leaves a sentinel row pointing at a job absent from the projection
- [ ] Live-job sentinel rows still clear only via operator ack
- [ ] The reconciliation choice is recorded as an ADR-0013 amendment
- [ ] keeper fast suite green

## Done summary

## Evidence
