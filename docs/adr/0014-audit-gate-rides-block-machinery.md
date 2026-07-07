# 14. Per-task audit gate rides the block machinery

## Status

Accepted

## Context

Selected high-risk tasks earn an automated review between worker completion and the done-stamp, so dependents never build on unreviewed drift. The worker stamps its own `done` (a one-way latch), both stop-guards treat `done` as terminal, `keeper plan block` hard-errors on a done task, and autopilot dispatches dependents on the same data-version tick a `done` lands. Three shapes were weighed: a new `awaiting_audit` reconcile verdict (widest contract ripple — pinned enum, both stop-guards, the generated work template, a new ready latch and verb), a post-done audit that mints fix tasks (near-zero contract change but a real dependent-dispatch race that defeats the gate), and reusing the existing block machinery.

## Decision

An audit-flagged worker finishes implementation and, instead of stamping done, blocks itself with an `AUDIT_READY` reason. `blocked` is already terminal to both stop-guards and already holds dependents. The orchestrator observes the reason category, spawns the task-scoped auditor content-blind, and on a clean or mild result unblocks and cold-resumes the worker to stamp its own done; a verified-severe finding survives one refute pass and rewrites the reason to `AUDIT_SEVERE`, escalating through the existing block-escalation path. The escalation producer treats `AUDIT_READY` as self-handled while the orchestrator lives and pages only after a grace period.

## Consequences

No new reconcile verdict, verb, or RPC; dependents cannot race the gate. The cost is a semantic widening of `blocked` — a routine gate state, not only a stuck state — carried by the reason-category convention, and audit availability now depends on the orchestrator session surviving the audit window, with the grace-period escalation as the recovery path.
