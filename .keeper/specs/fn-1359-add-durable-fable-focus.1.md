## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, src/types.ts, src/rpc-handlers.ts, src/autopilot-projection.ts, src/collections.ts, src/daemon.ts, src/account-routing-config.ts, src/fable-focus.ts, test/db.test.ts, test/reducer-projections.test.ts, test/refold-equivalence.test.ts, test/rpc-handlers.test.ts, test/collections.test.ts, test/daemon.test.ts, test/fable-focus.test.ts

### Approach

Add one atomically validated Fable-focus patch to the existing generic config Synthetic-event path; do not add a mutating RPC. Persist stable `claude-swap:<slot>` identity, tagged lifetime, normalized UTC boundary, set timestamp, and the Fable-intent field needed by later continuation consumers. The fold consumes only event payload/prior row/event time, preserves unpatched settings, and exposes one pure effective-policy projector.

Publish the Projection as a versioned, mode-restricted, PII-free account-routing policy leaf after boot and every successful mutation so the cold launcher never imports SQLite. The Projection remains authoritative; missing, corrupt, unsupported, or unreachable delivery evaluates as `unavailable` and permits normal balancing with visible diagnostics. Expiration is half-open and derived from an injected clock; cycle completion uses the snapshotted target Fable reset and fresh observations without mutating inside a fold.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/rpc-handlers.ts:339-548` — strict generic config validation and unknown-key rejection.
- `src/reducer.ts:6772-7008` — partial config event extraction, pure fold, and preserve-unpatched behavior.
- `src/db.ts:6225-6268` — durable singleton schema and migration integration.
- `src/collections.ts:665-706` — served singleton columns must be declared explicitly.
- `src/account-routing-config.ts:13-23,44-89` — versioned account sidecars and stable managed-route identity.
- `src/daemon.ts:9108-9181` — main-thread mutation acknowledgement after append and fold.

**Optional** (reference as needed):
- `src/autopilot-projection.ts:12-122` — pure singleton coercion conventions.
- `src/account-observation.ts:344-388` — canonical reset timestamps and model-scoped windows.
- `test/db.test.ts:505-556` — migration ladder, fingerprint, and parity checks.

### Risks

- A structured policy must update atomically rather than expose partial target/mode/deadline combinations.
- The schema step version is assigned at merge time; never bake a provisional version into prose or tests outside the ladder fixture.
- Projection/leaf skew must not let a successful setter acknowledge stale delivery.
- Generic config defaults and zero-event projection state must remain identical.

### Test notes

Cover fresh and upgrade migration, malformed events that still advance the cursor, re-fold equivalence, unpatched-field preservation, boot republish, atomic write failure, unsupported leaf schema, before/at/after deadline, cycle completion, and PII/control-character rejection. Use in-process DBs, injected clocks/filesystems, and explicit test files only.

### Detailed phases

1. Define the pure tagged policy and effective-status model, validation, canonical serialization, and deadline/cycle evaluation.
2. Append the merge-time schema step and Projection/fold/query fields, including Fable lineage storage defaults.
3. Extend the generic config handler/event with one atomic focus patch and idempotent clear semantics.
4. Publish and rehydrate the versioned launch leaf with acknowledgement ordering and failure diagnostics.
5. Prove migration, replay, restart, and delivery behavior.

### Alternatives

A direct durable config file would keep launch reads simple but create a second control-data authority outside Keeper's event stream. A new RPC would duplicate the generic config mutation seam. Both are rejected by the repository's control-data invariants.

### Non-functional targets

- No provider or filesystem reads occur inside folds.
- Launch-leaf reads are bounded, dependency-free, and expose no credentials or account metadata beyond route identity.
- Policy evaluation is deterministic for one `{policy, observation, now}` input.

### Rollout

This task creates no live focus. Existing zero-event and upgraded installations remain policy-off until the explicit post-land operation.

## Acceptance

- [ ] One generic config mutation atomically sets or clears a valid Fable-focus policy without adding a mutating RPC.
- [ ] Fresh databases, upgrades, malformed-event folds, and full re-folds produce the same policy and Fable-intent defaults.
- [ ] Permanent, absolute, current-reset-derived, and cycle-end policy inputs have deterministic active, expired, completed, invalid, and unavailable effective states.
- [ ] A successful mutation is not acknowledged until the authoritative Projection and versioned launch leaf represent the same policy identity.
- [ ] Daemon restart republishes effective policy without changing its approved deadline or cycle boundary.
- [ ] Missing or malformed delivery permits normal routing while exposing an unavailable diagnostic and no PII.
- [ ] Named schema, reducer, RPC, collection, daemon, and policy tests pass.

## Done summary

## Evidence
