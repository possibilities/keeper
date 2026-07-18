## Overview

Blocked tasks get handled where they happen: the /work orchestrator runs the unblocker agent in-session and warm-resumes its worker, while the daemon generalizes the audit-gate precedent — defer escalation while the owning orchestrator is live, act only on witnessed death — to every escalatable category, with a bounded attachment lease before the single human page. The legacy unblock:: session survives only as the witnessed-death fallback rung until retirement. This is the last epic before the hard operator review gate.

## Quick commands

- `bun test test/daemon.test.ts` — block-escalation sweep + deferral decision suites green
- `keeper prompt render-plugin-templates --project-root plugins/plan --check` — work skill render drift-free

## Acceptance

- [ ] A blocked task whose orchestrator is live is resolved (or terminally declined) in-session without any escalation session dispatching
- [ ] The daemon defers per owner liveness for every escalatable category, re-dispatches the owning work verb a bounded number of times on witnessed death, falls back to a legacy unblock session once, and pages exactly once per block instance
- [ ] TOOLING_FAILURE and unparseable categories keep their silent sticky suppression; the audit categories keep their existing gate

## Early proof point

Task that proves the approach: task 1. If generalizing the deferral breaks an existing audit-gate contract, keep AUDIT_READY on its bespoke path and generalize only the six semantic categories.

## References

- docs/adr/0089-in-session-escalation-subagents.md — attachment lease and page-once contract
- The audit-gate deferral (auditReadyEscalationDecision) — the in-tree precedent being generalized
- The work skill's existing resume ladder — warm resume via SendMessage, cold resume fallback, bounded attempts

## Docs gaps

- **CLAUDE.md autopilot section**: escalation-cap wording drifts once deferral generalizes — full rewrite belongs to the retirement epic; touch nothing here unless a statement becomes actively false

## Best practices

- **Untrusted receipts:** the unblocker's diagnosis enters the resume prompt as delimited data and never expands scope
- **Idempotent resume:** re-spawn keyed on task + step so a duplicate receipt cannot double-apply
- **Stable page fingerprint:** page-once keys on the block instance, never on attempt counters or timestamps
