## Description

**Size:** S
**Files:** src/exit-watcher.ts, test/exit-watcher.test.ts

### Approach

The tier-two stale-working sentinel (working row + live pid + event age past the 1h floor) currently mints its retry-ack row for ANY session, so a parked-idle interactive human session generates recurring operator ack toil (30-minute re-emit windows). Carve interactive sessions out of tier-two ROW MINTING at the producer: a session with no plan linkage (plan_ref null, including adopted identities) is soft telemetry — its working/idle contradiction stays observable on the jobs/board surfaces but mints no needs-human ack-row. Plan-linked worker sessions keep full tier-two coverage, and tier-one self-heal stays untouched for everyone. Producer-side only — no reducer idle-stamping changes (re-fold-sensitive). Record the policy as an amendment in the ADR-0013/0024 sentinel lineage.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/exit-watcher.ts:597-664 — selectStuckSentinelVerdicts tier-two predicate, STUCK_TIER2_MIN_AGE_SECS, shouldEmitSentinel re-emit gate
- src/types.ts:316,363 — jobs.adopted, jobs.plan_ref (the discriminators)

**Optional** (reference as needed):
- docs/adr/0013, docs/adr/0024 — the lineage the amendment extends

### Risks

- A genuinely wedged adopted/interactive session loses its ack-row; accepted (self-noticed by its human) — the carve-out must be documented in the ADR amendment so the trade is on record.

### Test notes

Pure predicate tests: plan-linked working+stale row still verdicts tier-two; plan_ref-null and adopted rows do not; tier-one heal verdicts unchanged for all kinds.

## Acceptance

- [ ] A stale-working session without plan linkage produces no tier-two ack-row while a plan-linked one still does
- [ ] Tier-one self-heal behavior is unchanged for all session kinds
- [ ] The carve-out is recorded as an ADR amendment in the 0013/0024 lineage
- [ ] keeper fast suite green

## Done summary

## Evidence
