## Description

**Size:** M
**Files:** src/daemon.ts, test/daemon.test.ts

### Approach

The AUDIT_READY escalation gate defers while the owning orchestrator is live, then routes to
the unblock:: path once it is dead past grace — but the unblocker cannot advance an audit
handoff. Route the dead-orchestrator AUDIT_READY case to a work:: dispatch instead: a fresh
/plan:work orchestrator reconciles an AUDIT_READY-parked task into its audit-gate phase
(gate-check short-circuits on a persisted passing finding and resumes the worker to mark
done). Non-AUDIT_READY categories keep their existing routing. The dispatch must carry the
normal autopilot owner tuple so wrapped legs launch.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:1426-1442 — AUDIT_READY category, orchestrator grace, and the liveness read
- src/daemon.ts:1399 — the audit-category routing comment describing the extension point
- test/daemon.test.ts — escalation-routing test seams (deterministic, no real processes)

### Risks

- The #50 collision guard reasons about autopilot-dispatchable keys; a daemon-minted work:: resume must not fight it.
- Respect escalation caps (turn-active counting) so the resume does not amplify under churn.

## Acceptance

- [ ] a dead-orchestrator AUDIT_READY block past grace produces a work:: dispatch with a proper owner tuple
- [ ] a live orchestrator still defers; non-audit categories keep their existing route
- [ ] daemon gates green

## Done summary

## Evidence
