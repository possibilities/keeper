## Description

Finding F2 (evidence: src/readiness.ts:1135). The `settleCloseRow`
doc block cites the launcher's close-dispatch gate by hard-coded line
span `autopilot-worker.ts:1000-1007`. The auditor verified the span is
accurate today, but a line-number cite rots silently on any edit to
autopilot-worker.ts, leaving the comment pointing a future reader at the
wrong code in a different file. Replace the line-span cite with a stable
symbol/condition reference (the `armedMode && !eligible?.has(epicId) &&
!isEpicInFlight(...)` close-dispatch gate) so the "mutex mirrors the
launcher" invariant stays verifiable without line-number maintenance.

## Acceptance

- [ ] readiness.ts:1135's comment names the close-dispatch gate by symbol/condition rather than `autopilot-worker.ts:1000-1007`.
- [ ] No behavior change; the comment still documents why the mutex mirrors the launcher gate.

## Done summary

## Evidence
