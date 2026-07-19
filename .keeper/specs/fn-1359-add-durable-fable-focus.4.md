## Description

**Size:** S
**Files:** README.md, docs/install.md, docs/problem-codes.md

### Approach

Consolidate current Claude account-routing guidance around Fable focus, using the accepted vocabulary and linking machine inspection, status, and board presentation. Document stable slot identity versus display ordinal, filter-then-prefer routing, normal-balancing fallback, non-Fable soft avoidance, lifetime semantics, continuation inheritance, safe retries, and the fact that interactive model changes cannot move a running process.

Add an operator runbook for guarded current-reset activation and idempotent clear. It must explain that expected-boundary mismatch, stale evidence, or an elapsed reset leaves policy unchanged; examples use placeholders rather than embedding a live rollout date. Prune claims that every launch always uses purely dynamic balancing or that Keeper exposes no account-routing control.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `docs/install.md:73-109` — current Claude routing and no-config guidance.
- `docs/problem-codes.md` — typed failure/recovery table conventions.
- `README.md` — concise front-door style and link discipline.
- `docs/adr/0092-durable-fable-focus-routing.md` — authoritative current behavior.
- `CONTEXT.md:95-100` — account-routing vocabulary.

**Optional** (reference as needed):
- `docs/testing.md:1-31` — named-gate conventions if a new operator gate is actually introduced.

### Risks

- Forward-facing docs cannot narrate old behavior or hard-code the one-cycle rollout date.
- `Drain` remains the event-fold term; operational prose should use Fable focus consistently.
- Examples must not expose account emails, credentials, raw session IDs, or assume `c1` remains slot 2.

### Test notes

Run documentation/source lint through commit-work and verify every documented command against descriptor/help output. Do not add a testing-doc update unless implementation actually introduces a named gate.

### Detailed phases

1. Rewrite the install runbook and prune obsolete routing claims.
2. Add problem codes, recovery, retry safety, and guarded activation examples.
3. Tighten the README front door and verify links/commands/lint.

### Alternatives

Keeping activation knowledge only in the epic rollout would leave future operators without a durable runbook. Duplicating the full policy in README would violate its lean front-door role.

### Non-functional targets

- Current-state prose only; rationale stays in ADR 0092.
- Examples use stable route/slot terminology and bounded PII-free JSON fields.

### Rollout

Documentation lands with the feature. The live current-cycle activation remains an operator action after the epic's `landed` milestone.

## Acceptance

- [ ] The install guide defines Fable focus, stable route identity, fallback, avoidance, lifetimes, continuation behavior, inspection, activation, and rollback in current-state prose.
- [ ] Problem-code documentation covers invalid policy, unavailable delivery, stale/missing reset evidence, expected-boundary mismatch, elapsed boundary, and uncertain acknowledgement recovery.
- [ ] README exposes the inspectable feature concisely and links to the operational guide without duplicating it.
- [ ] Every example is PII-free, uses a stable slot or route rather than a mutable ordinal, and avoids a hard-coded live reset date.
- [ ] Documented commands match generated help and repository documentation lint passes.

## Done summary
Consolidated Claude account-routing docs around Fable focus: rewrote docs/install.md's routing runbook (route identity, fallback, avoidance, lifetimes, continuation inheritance, inspection, guarded activation, rollback), added Fable focus problem codes/recovery table to docs/problem-codes.md, and linked the guide from README.
## Evidence
