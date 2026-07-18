## Description

**Size:** M
**Files:** src/daemon.ts, src/db.ts, test/daemon.test.ts

### Approach

Generalize the audit-gate deferral into a category-agnostic owner-live decision consumed by the block-escalation sweep: for every escalatable category, while the owning work orchestrator session is live (or within the existing grace), the daemon defers — the in-session ladder owns the incident. On witnessed owner death without a terminal resolution, the sweep re-dispatches the owning work verb (an attachment attempt) up to a small durable bound (about two); exhausted, it falls back to dispatching one legacy unblock session (the proving-period rung); that session's decline or death flows into the existing page-once path. The attempt count and lease state live durably on the block-escalation latch via an additive forward-only column (ladder version assigned at merge — never hardcode the next number); per-epic serialization, TOOLING_FAILURE/unparseable suppression, and both audit categories' existing handling are preserved byte-for-byte. The deferral decision stays a pure injected-deps function like its precedent so the sweep tests stay in-process.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:1457 — auditReadyEscalationDecision, the pure deferral precedent (owner liveness + grace) being generalized
- src/daemon.ts:1605 — runBlockEscalationSweep and its injected BlockEscalationSweepDeps contract
- src/daemon.ts:1682 — routeBlockedCategory and the surface_and_stop / repair / unblock routing table
- src/db.ts — addColumnIfMissing migration helper + the block_escalations table shape
- test/daemon.test.ts — how the sweep and decision are exercised with synthetic rows and injected dispatchers

**Optional** (reference as needed):
- src/reducer.ts:6138-6152 — foldBlockEscalationAttempted latch advance/reset semantics the attempt bound composes with

### Risks

- Double-handling window: if the daemon dispatches a legacy unblock while a live orchestrator is mid-ladder, two actors work one incident — owner liveness must gate every dispatch arm, not just the first
- The schema ladder is a singleton resource; a sibling epic in this arc also appends a step — the dependency chain sequences them, and the spec must not pin a version number

### Test notes

In-process sweep tests: live-owner defer for each category, witnessed-death attachment re-dispatch with bound exhaustion, fallback dispatch exactly once, page-once un-regressed, suppression categories untouched. Poll with retryUntil, sandboxed state, named gates only.

## Acceptance

- [ ] Every escalatable category defers while its owning orchestrator is live and never dispatches an escalation session during that window
- [ ] Witnessed owner death triggers bounded owning-verb re-dispatch, then exactly one legacy unblock fallback, then the existing single page — with the attempt state durable across daemon restarts
- [ ] Suppression and audit categories behave exactly as before
- [ ] The sweep and decision suites pass in-process via named gates

## Done summary

## Evidence
