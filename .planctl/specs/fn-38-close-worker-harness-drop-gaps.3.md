## Description

**RELOCATED — not active work.** This task originally held F5
(PARENT_SESSION_TEARDOWN recovery). It was pulled out of this epic because
the teardown cause is not understood and fixing it blind was rejected. The
work is relocated to the keeper investigation epic
**fn-814-trace-live-worker-window-teardowns**, which attributes the teardown
source before recommending a guard or tracing.

This task is a tombstone, blocked so autopilot never claims it. No work is
expected here.

## Acceptance

- [ ] None — relocated to fn-814-trace-live-worker-window-teardowns (keeper). This task is intentionally inert.

## Done summary
Relocated to keeper investigation epic fn-814-trace-live-worker-window-teardowns (F5 = parent-session-teardown recovery). No work performed in this task; marked done administratively — not blocked — so the epic's close-row gate clears and the closer can auto-dispatch once .2 lands.
## Evidence
