## Description

**Size:** S
**Files:** README.md, docs/install.md, docs/problem-codes.md

### Approach

Consolidate the operating guidance around the implemented Account-focus lifecycle. Explain the two meter mappings, fail-closed arming evidence, exact endpoint transitions, half-open lifetime clearing, bounded reconciliation latency, restart/gap behavior, policy-fenced stale-request safety, inspection outcomes, and manual clear as an operator override rather than the only retirement path. Keep README concise, put procedures in `docs/install.md`, and update `docs/problem-codes.md` only for concrete codes that actually exist.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `docs/install.md:106-145` — Account-focus model, trust boundary, and current lifetime explanation.
- `docs/install.md:211-275` — focus commands, inspection, rollback, and expired-policy operating guidance to consolidate.
- `README.md` — lean front-door placement for one concise lifecycle statement.
- `docs/problem-codes.md` — canonical operator diagnosis table; include only implemented refusal/repair codes.
- `docs/adr/0110-policy-fenced-account-focus-lifecycle-clearing.md` — authoritative lifecycle decision and terminology.

**Optional** (reference as needed):
- `docs/adr/0101-claude-swap-owned-measurement-trust.md` — measurement trust and no reset-time utilization inference.
- `CONTEXT.md` — exact Account focus and Focus quota transition vocabulary.

### Risks

- Appending another focus section would leave contradictory manual-clear and expired-visible advice; prune and consolidate instead.
- Documentation must distinguish routing's immediate half-open inactivity from the observer cadence that durably clears and removes intent.
- Problem-code prose can become fiction if it names planned rather than landed diagnostics.

### Test notes

Run the repository's documentation/source lint through `keeper commit-work`. Verify every command against current CLI help and every machine field/reason against implemented output; do not exercise the live daemon from a task lane.

### Detailed phases

1. Rewrite the Account-focus operating section around one shared lifecycle and two canonical meters.
2. Prune stale expired-policy/manual-only guidance and add concise set-refusal, inspection, recovery, and rollback examples.
3. Tighten README to one front-door statement and reconcile only actual problem codes.
4. Run documentation and source lint through the normal commit rail.

### Alternatives

A standalone new guide is rejected because `docs/install.md` already owns Account-focus operations. Duplicating the full lifecycle in README is rejected because README remains a lean front door.

### Non-functional targets

- Forward-facing current behavior only; no implementation provenance outside ADRs.
- No duplicated command blocks, stale fn ids, version numbers, or unbounded prose growth.
- PII-free examples use stable managed routes and canonical meter names.

### Rollout

Documentation describes the post-land contract and the required daemon restart remains at epic operator level, not task acceptance.

## Acceptance

- [ ] The operating guide explains both canonical quota meters, all automatic-clear conditions, fail-closed setting, gap/restart semantics, bounded reconciliation, inspection, and manual override without contradictory legacy advice.
- [ ] README contains a concise current-behavior summary and delegates procedures to the operating guide.
- [ ] Problem-code guidance matches only diagnostics the implementation exposes and gives a bounded operator recovery path.
- [ ] Commands, machine fields, glossary terms, and ADR links resolve against the landed implementation.
- [ ] Repository documentation and source lint pass through the standard commit rail.

## Done summary

## Evidence
