## Description
**Size:** M
**Files:** plugins/plan/src/verbs/, cli/escalation-brief.ts, src/daemon.ts, src/reducer.ts, src/db.ts, test/daemon.test.ts, test/reducer-projections.test.ts

### Approach

Give sessions a pull-based incident surface and a claim primitive. The claim and close-preflight envelopes gain a nullable incident field — kind, incident id, the incident-fenced clear identities (attempt id / instance event id), a brief ref, and a grant ref when one exists — derived read-only from the existing sticky dispatch-failure rows keyed to the owning verb and id. The plan plugin stays sqlite-free: the envelope builders populate the incident field via a bounded read-only subprocess invocation of the keeper CLI's incident read surface (the escalation-brief serve-by-incident-id growth this task lands, or an equivalent read verb), mirroring the plugin's existing bounded-subprocess idiom; no direct DB import into plugins/plan, and no new dispatch-time env injection — exec-backend.ts and reconcile-core.ts stay out of scope. New incident claim and release verbs ride the spool-request contract: the session-side CLI writes a bounded request leaf into a daemon-watched spool, the daemon producer validates claimant identity and liveness, mints the synthetic claim or release event, and the fold records the claim (claimant job identity, generation, freshness) on the incident row. This task lands the claim DATA semantics only — recording, producer-side liveness validation, and dead-claimant expiry by positive evidence; the recover pass and base-freshness CONSUMPTION of claims as an exclusion lock is task .4's surface (its acceptance already carries "recover and base-freshness honor claims"), so src/autopilot-worker.ts is deliberately not on this task's Files list. No RPC widening, no session DB writes; page-once state is untouched. The escalation-brief CLI learns to serve a brief by incident id so subagents keep one read surface.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/src/verbs/ — claim and close-preflight envelope builders (locate exact files; mirror the brief_ref / phase_resume field idiom)
- src/reducer.ts:4284-4312 — the dispatch-failure UPSERT that must preserve new claim columns exactly like the existing once-markers
- docs/adr/0070 and src/reducer.ts:10322-10441 — incident-fenced clear identities the envelope carries
- The baseline request-spool producer in src/daemon.ts — the spool-request pattern to mirror (session writes request leaf, producer validates and mints)
- cli/escalation-brief.ts — envelope shape and its dispatch_failures reads

**Optional** (reference as needed):
- src/autopilot-worker.ts recover pass-1 abort gating (hasActiveResolver) — the exclusion seam the claim lock replaces in task .4; read-only context here, never a surface this task edits

### Risks

- A claim honored without claimant liveness verification wedges recover forever on a dead claimant — the producer must verify pid/job liveness before treating a claim as exclusive, and stale claims must expire by positive evidence
- The spool is a new session-writable surface: requests must be size-bounded, validated, and idempotent per (incident, claimant)

### Test notes

In-process: envelope carries the incident for a synthetic sticky row; claim spool round-trip mints exactly one synthetic event per request; stale/dead-claimant claims expire; claim columns survive the dispatch-failure UPSERT. Fold determinism suites stay green.
## Acceptance

- [ ] Claim and close-preflight envelopes surface a nullable incident with fenced identities, brief ref, and grant ref, sourced from existing sticky rows
- [ ] Sessions can claim and release an incident through a spool-validated synthetic-event round-trip with no new RPC surface and no session DB write
- [ ] A live claim excludes the recover abort and base-freshness refresh for its surface; a dead claimant's claim expires on positive evidence
- [ ] Brief lookup by incident id works read-only; all touched suites green via named gates

## Done summary

## Evidence
