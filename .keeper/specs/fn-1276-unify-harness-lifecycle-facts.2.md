## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, src/collections.ts, src/readiness-inputs.ts, test/reducer-projections.test.ts, test/collections.test.ts

### Approach

Add a deterministic-replayed Dispatch-claim projection keyed by dispatch target and guarded by a distinct monotonically ordered Dispatch-attempt identity. Claim acquisition, exact bind, resume acknowledgement, release, and supersession must validate the expected attempt atomically; duplicates are idempotent and stale attempts cannot mutate the current row.

Keep boot-truncated `pending_dispatches` as a launch-window memo rather than treating it as durable ownership. Interpret pre-change events deterministically as legacy-unfenced, preserve the zero-event default, and append one merge-time-numbered schema step with the required fingerprint update.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/reducer.ts:8068-8088,8260-8305` — current key-only SessionStart attribution and pending-row consumption.
- `src/autopilot-worker.ts:2100-2130` — current `Dispatched` intent payload.
- `src/db.ts:5522-5555,6195-6208` — boot-truncated pending rows versus deterministic projection classes.
- `src/collections.ts:482-528,731-750,1025-1056` — landed composite live-key machinery for pending and subagent collections.
- `docs/adr/0055-harness-activity-dispatch-claims-and-resource-holds.md` — accepted attempt/claim invariants and legacy policy.

**Optional** (reference as needed):
- `test/reducer-projections.test.ts:2630-2776` — consume-once, manual exclusion, and re-fold attribution fixtures.
- `docs/adr/0013-canonical-generation-identity.md` — Generation terminology and recycle protection that must remain distinct.

### Risks

Claims cross deterministic and live-only projection classes; folding wall-clock expiry or process liveness would violate replay. A schema ladder collision is resolved at merge time, never by preselecting a version. Legacy inference must not fabricate ownership that can consume a new exact claim.

### Test notes

Cover two attempts for one target with delayed old start, duplicate exact events, stale completion/release, concurrent acquisition order, restart/re-fold, empty database defaults, and legacy rows. Assert cursor and projection advance atomically and composite-key subscriptions publish the correct row.

### Detailed phases

1. Define attempt and claim event contracts plus deterministic target/attempt ordering.
2. Add the projection schema, indexes, zero-event defaults, migration step, and fingerprint.
3. Fold acquire/bind/ack/release/supersede with expected-attempt comparisons and no throws.
4. Expose claims through the shared readiness-input snapshot without collapsing them into pending dispatches.
5. Prove idempotency, stale rejection, composite-key live updates, and re-fold determinism.

### Alternatives

Extending the `(verb, ref)` pending UPSERT was rejected because replacement destroys attempt identity and the table is boot-truncated. Tmux Generation was rejected as the claim fence because multiple attempts can share one server boot.

### Non-functional targets

Per-event fold cost is constant-bounded by indexed target lookup. No reducer reads wall-clock, environment, filesystem, or process state. The new projection remains safe under duplicate and malformed event data.

### Rollout

The migration is additive and its version is assigned at merge time. Existing consumers continue using compatibility paths until later tasks bind and consume claims; rollback leaves unused claim rows without requiring a downgrade.

## Acceptance

- [ ] A durable Dispatch claim identifies one current Dispatch attempt per target and survives daemon restart and deterministic re-fold.
- [ ] Claim mutations validate the expected attempt atomically; exact duplicates are idempotent and stale/concurrent losers leave the current claim unchanged.
- [ ] A delayed old start cannot consume or replace a newer pending attempt.
- [ ] Legacy unfenced history is interpreted deterministically without guessing an attempt identity or claiming newer work.
- [ ] The additive migration, indexes, schema fingerprint, zero-event defaults, and composite-key subscription behavior pass isolated database tests.

## Done summary
Added a deterministic-replayed Dispatch-claim projection keyed by target and fenced by a monotonic Dispatch-attempt identity: acquire/bind/ack/release/supersede folds validate the expected attempt atomically, duplicates are idempotent, stale/concurrent losers leave the current claim unchanged, legacy pre-change history is interpreted as unfenced, and the additive migration/indexes/fingerprint/zero-event defaults/composite-key subscriptions are covered by isolated tests.
## Evidence
