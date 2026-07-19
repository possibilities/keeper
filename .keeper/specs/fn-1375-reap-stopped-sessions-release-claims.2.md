## Description

**Size:** M
**Files:** src/daemon.ts, src/reconcile-core.ts, src/autopilot-worker.ts, src/reducer.ts, docs/problem-codes.md, test/autopilot-worker.test.ts, test/dispatch-failure-pill.test.ts

### Approach

Per ADR 0095 decisions 3-4. First, the dead-session claim release: a
producer-planned, capped sibling of the ownerless orphaned-claim
release selecting acquired claims whose owning session carries terminal
evidence (killed or ended) and whose attempt has settled-or-absent
Provider-leg ownership; release rides the existing
DispatchClaimReleased restriction machinery, and the fold re-checks
every condition so a late bind, supersede, or leg enrollment is a
no-op. The never-bound deadline formula, batch caps, and jitter from
ADR 0085 stay untouched; claims with live or unsettled legs stay fenced
per ADR 0071. Second, total withhold visibility: every reconciler
decline of a ready target routes through the withholds map (stable code
plus bounded cycle-stable detail), including occupancy-pass signals and
a probe-degraded sentinel for degraded-tmux cycles; register new codes
in the problem-codes withhold table. Deliberately no durable withhold
projection.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:969 — planOrphanedClaimReaper (the 0085 shape to mirror; note its dispatch_failures-row exclusion) + :1039 planOwnerlessOrphanedClaimReleases + :1070 orphanedClaimIsReleaseable
- src/reducer.ts:5785 — foldDispatchExpired (df-row guard at :5813-5823) and the DispatchClaimReleased fold restriction checks
- src/autopilot-worker.ts:432 — updateWithholdFrameState (the rate-limited change-gated emitter to route everything through)
- src/reconcile-core.ts:144-167 — WithholdReasonCode + withhold factory; :1675 dispatchTargetWithholdCode; :2040 degraded-probe early-out (silent today)

**Optional** (reference as needed):
- docs/problem-codes.md — the withhold-reasons table
- src/daemon.ts:950 — orphanedClaimJitterMs (stable per-attempt jitter)
- test/autopilot-worker.test.ts:228 — planOrphanedClaimReaper table; :190 updateWithholdFrameState

### Risks

- Double-release, or releasing a claim whose session revives: terminal session evidence means killed or ended, never stopped; every release condition re-checks in the fold.
- Reason-string churn: new withhold details must be cycle-stable (no ages or timestamps) or last_event_id churns every cycle.
- The 0085 sweep's dispatch_failures-row exclusion is deliberate; the dead-session class needs its own selection, not a loosening of that filter.

### Test notes

Deterministic producer/fold tables; 0085 regression tables must stay
green untouched. Named gates only.

## Acceptance

- [ ] An acquired claim owned by a terminally dead session (killed or ended evidence) with settled-or-absent Provider-leg ownership is released by the producer sweep within one bounded window, and a claim with live or unsettled leg ownership is never released — both proven by deterministic tables including late-bind and leg-enrollment fold no-ops.
- [ ] The never-bound deadline formula and its regression tables are unchanged and green.
- [ ] Every reconciler decline of a ready target surfaces a stable withhold code with a cycle-stable detail, including occupancy-pass signals, and a degraded tmux-probe cycle emits a distinct sentinel reason instead of silence.
- [ ] The problem-codes withhold table documents each new code.
- [ ] The named focused gates and the typecheck are green.

## Done summary

## Evidence
