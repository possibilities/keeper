## Description

**Size:** M
**Files:** src/readiness.ts, src/readiness-inputs.ts, src/reconcile-core.ts, src/autopilot-worker.ts, src/reducer.ts, src/derivers.ts, src/subagent-invocations.ts, src/bus-wake.ts, src/await-conditions.ts, src/daemon.ts, test/readiness.test.ts, test/reconcile-core-depgraph.test.ts, test/autopilot-worker.test.ts, test/bus-wake.test.ts, test/await-conditions.test.ts, test/daemon.test.ts, test/status.test.ts

### Approach

Replace ad hoc active-work checks with the canonical Harness-activity result while preserving consumer-specific policy. Capacity and drained/idle views consume active/unknown activity plus launch/resume reservations; a quiescent parked claim consumes no compute capacity. Same-target dedupe and warm resume consume the durable Dispatch claim plus active collision evidence rather than stopped-pane liveness.

Make unblock/resume a durable request/accept flow scoped to the current attempt. If acknowledgement fails, revoke and fence the old attempt before admitting fresh dispatch; a timeout cannot directly free the target. Explicit bus infrastructure remains ambient regardless of how it was launched.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/readiness.ts:1360-1406` — current readiness capacity occupant.
- `src/reconcile-core.ts:1494-1590` — current stopped-live pane ownership and epic composition seam.
- `src/readiness-inputs.ts:77-160` — shared snapshot consumed by autopilot and autoclose.
- `src/bus-wake.ts:111-147` — stopped-live wake/dedup policy.
- `src/await-conditions.ts:1121-1136` — repo-idle turn-activity consumer.
- `src/daemon.ts:926-948` — audit ownership’s conservative stopped-live classification.

**Optional** (reference as needed):
- `src/derivers.ts` — background task provenance and ambient classification.
- `docs/adr/0017-turn-active-escalation-lifecycle.md` — intentional escalation-specific turn-active policy.
- `test/readiness.test.ts:257-297,904-1055` — existing running/pending/bound/root occupancy matrix.

### Risks

One classifier must not force one policy: escalation remains turn-active, launch reservations remain capacity holds, and Resource holds remain stricter than activity. Unknown evidence can reduce throughput; it must be visible and bounded by positive reconciliation, not silently downgraded. Late bus messages require attempt fencing at both routing and acceptance.

### Test notes

Cover active/quiescent/unknown across capacity, per-root policy, same-target dispatch, status, await, audit ownership, and bus wake. Reproduce the stopped bus-only session with terminal subagent and live pane: zero active capacity, parked claim retained, acknowledged resume allowed, and fresh dispatch forbidden until revocation. Cover a genuine surviving child and degraded evidence as active/unknown controls.

### Detailed phases

1. Thread Harness activity and Dispatch claims through the shared reconcile snapshot.
2. Migrate capacity, status, await, audit, and same-target consumers with explicit policy matrices.
3. Add durable resume-request and exact-attempt acceptance semantics.
4. Fence late/missed resumes and require revocation before replacement dispatch.
5. Remove redundant stopped-pane activity checks while retaining Resource-hold checks for cleanup.

### Alternatives

Releasing stopped owners after a grace was rejected because a late bus wake can race the replacement. Counting parked claims as active capacity was rejected because idle resumable sessions would starve unrelated work.

### Non-functional targets

Reconcile cost stays bounded by indexed claim lookup and existing recency-bounded collections. Every degraded or unknown path is reason-coded; no transcript text or opaque attempt token is exposed in ordinary status output.

### Rollout

Switch consumers only after attempt binding is live. Keep a compatibility branch for legacy-unfenced sessions that fails closed on same-target collision and cleanup until they terminate; do not modify other harness policies.

## Acceptance

- [ ] Readiness, capacity, status, await, audit, and autopilot consume one canonical Harness-activity result while retaining their documented consumer-specific policies.
- [ ] A quiescent parked claim consumes no active capacity; active and unknown evidence plus launch/resume reservations continue to hold safety gates.
- [ ] Same-target dispatch and bus wake are governed by exact Dispatch claims rather than live-pane inference.
- [ ] Resume request and acceptance are attempt-scoped and durable; missed acknowledgement cannot authorize fresh dispatch until the old attempt is revoked and fenced.
- [ ] The stopped bus-only/live-pane regression is classified quiescent-but-owned, while genuine children and degraded evidence remain active or unknown.
- [ ] Focused readiness, reconcile, bus-wake, await, daemon, and status suites pass without live daemon or tmux access.

## Done summary

## Evidence
