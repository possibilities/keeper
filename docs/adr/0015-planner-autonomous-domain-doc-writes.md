# 15. Planner-autonomous domain-doc writes at plan time

## Status

Accepted

## Context

The domain-docs layer shipped with human-gated creation as one of its anti-bloat defenses: every glossary or decision-record write was offered and confirmed before landing. In practice the plan-time confirm beat added a round-trip without changing outcomes — the planner's pre-scaffold judgment, the commit-work domain-docs lint, and the read-tier prune flags already bound what can land — while stale glossaries reached worker briefs whenever a confirm lagged the scaffold.

## Decision

At plan time — the pre-scaffold beat of a planning flow — planners write and commit merited `CONTEXT.md` and `docs/adr/` updates autonomously; the planner's judgment is the gate. A question is asked first only for a genuine edge case: a contentious term, a definition contradicting a live glossary entry, or a decision the human has not actually resolved. Interactive design conversations keep the offer-first cadence, and workers remain declared-deliverable-only writers.

## Consequences

Worker briefs always carry the glossary as sharpened by the plan that produced them. Creation authority widens to the plan flow, so the bloat backstops are now the mechanical ones — the commit-gate lint, the entry tests, and the prune reaps — rather than a per-write human confirm; the pain ledger and close audits are where over-production would surface.
