## Description

**Size:** S
**Files:** README.md, docs/install.md, docs/problem-codes.md

### Approach

Consolidate Claude account-routing operations around independent Fable and Non-Fable Account focuses. Explain stable route versus mutable `cN` input, proven intent classification, complete precedence, matching-target preference, Fable soft avoidance, visible fallback, independent delivery health, permanent/absolute lifetimes, full board sections, inspection/status fields, and Pi/Codex isolation.

Add a guarded activation runbook using placeholders and a fixed-deadline check: inspect current policy/capacity, require target present and eligible, require `now < deadline`, set absolute focus, then verify `show`, accounts check, status, and board. Document inspect-first recovery for uncertain acknowledgement and no-mutation behavior after missed/refused activation. Keep the request's live date in the epic rollout rather than forward-facing docs.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `docs/adr/0100-independent-scoped-account-focus.md` — authoritative current policy and precedence.
- `docs/install.md:63-158` — current single-focus operating guide to consolidate.
- `docs/problem-codes.md:171-186` — focus diagnostics and recovery table.
- `README.md` — lean front-door link and summary style.
- `CONTEXT.md:95-99` — Account-focus vocabulary.

**Optional** (reference as needed):
- Generated `keeper agent --help` and JSON inspection output — command examples must match the implemented contract.

### Risks

- Forward-facing docs must not hard-code the request-time deadline or narrate prior behavior.
- `c2` is not the second account in zero-based display syntax; examples should prefer stable `claude-swap:2`.
- Fable and Non-Fable focus, model fallback, and Account route fallback must remain distinct terms.

### Test notes

Verify every command against generated help and machine output, run documentation/source lint through commit-work, and update no testing guide unless implementation actually adds a named gate.

### Detailed phases

1. Rewrite install operations around the dual-focus model and guarded activation/rollback.
2. Consolidate shared and scope-specific problem codes and retry guidance.
3. Tighten the README front door, links, examples, and terminology.

### Alternatives

Duplicating a complete Fable and Non-Fable runbook would drift. Keeping the new behavior only in ADR/specs would leave operators without safe activation and recovery guidance.

### Non-functional targets

- Current-state advice only; decision rationale remains in ADR 0100.
- Examples are PII-free and use stable routes for durable intent.

### Rollout

Documentation lands with the feature. Live activation remains a post-land operator action guarded by the epic's fixed deadline.

## Acceptance

- [ ] README and install docs describe both independent focuses, their matching scopes, precedence, fallback, delivery, status, board, and rollback in current-state prose.
- [ ] The operating guide distinguishes stable route `claude-swap:2` from display ordinal `c1` and never calls literal `c2` the second account.
- [ ] Problem-code guidance covers invalid/elapsed policy, ineligible guarded activation, unavailable delivery, visible fallback, and uncertain acknowledgement without duplicating shared recovery text.
- [ ] Guarded activation examples use placeholders, preserve concurrent human policy, and never imply that a missed deadline starts a new relative window.
- [ ] Documented commands match generated help, links resolve, and documentation lint passes.

## Done summary

## Evidence
