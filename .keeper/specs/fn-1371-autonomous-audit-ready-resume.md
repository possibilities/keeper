## Overview

An audited-green task whose orchestrator died cannot resume without an operator today, for two
compounding reasons. A wrapped worker cannot park its own task AUDIT_READY — the wrapped-guard
allowlist permits `keeper plan done` but denies the task-bound `keeper plan block`, so workers
fall back to TOOLING_FAILURE. And when the parking orchestrator dies, the daemon's AUDIT_READY
escalation routes to the plan:unblocker, which correctly declines (it clears typed root causes,
it is not the audit orchestrator); only an operator `keeper dispatch work:: --force` re-enters
the work skill's audit gate. End state: a wrapped worker self-parks AUDIT_READY under a narrow
reason-prefix-gated allowance, and a dead-orchestrator AUDIT_READY block dispatches a work::
audit-gate resume autonomously.

## Quick commands

- `bun test ./test/wrapped-guard.test.ts ./test/grant-guard.test.ts ./test/daemon.test.ts` — guard allowance + escalation-routing suites green.

## Acceptance

- [ ] a wrapped worker can park its OWN launch-bound task with `keeper plan block --reason "AUDIT_READY: …"`; any other block target/reason stays denied
- [ ] an AUDIT_READY block whose orchestrator is dead past grace dispatches a work:: resume, not the unblocker
- [ ] guard + daemon gates green

## Early proof point

Task that proves the approach: `.1`. If it fails: land `.2` alone (the daemon-side resume already unjams the dead-orchestrator case end-to-end).

## References

- ~/docs/keeper-phase2-backlog.md items #48, #54 (live evidence: fn-1358.1's three exhausted resume paths, 07-19 01:2x)
