## Description

**Size:** M
**Files:** src/types.ts, src/account-focus.ts, src/fable-focus.ts, src/account-routing-config.ts, src/db.ts, src/reducer.ts, src/rpc-handlers.ts, src/server-worker.ts, src/daemon.ts, src/autopilot-projection.ts, src/collections.ts, test/account-focus.test.ts, test/fable-focus.test.ts, test/db.test.ts, test/reducer-projections.test.ts, test/refold-equivalence.test.ts, test/rpc-handlers.test.ts, test/daemon.test.ts, test/collections.test.ts

### Approach

Introduce shared Account-focus primitives for stable route identity, event-owned policy identity, permanent/absolute lifetime validation, effective-state evaluation, bounded atomic leaf publication, and delivery diagnostics. Keep Fable reset/cycle construction behind its existing compatibility facade. Add one nullable `non_fable_focus` JSON cell to `autopilot_state` and one independent versioned owner-only launch leaf; do not rewrite or combine the existing Fable cell/leaf.

Extend the generic config Synthetic-event patch with one atomically validated Non-Fable field and no new mutating RPC. The fold consumes only event payload, prior row, event id, and event time; malformed structured input is a no-op rather than a clear. Mutation acknowledgement waits until the Non-Fable Projection and leaf share the exact policy identity. Boot republication and one leaf's publication failure leave the sibling policy and leaf untouched.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/fable-focus.ts:49-227` — strict normalization, event-owned policy identity, and compatibility semantics to generalize without drifting.
- `src/fable-focus.ts:229-270,370-463` — half-open lifetime evaluation and owner-only atomic leaf contract.
- `src/db.ts:63-86,4478-4486,6321-6330` — rebuild lists, existing focus migration, and singleton schema.
- `src/reducer.ts:7055-7074,7131-7134,7231-7244` — generic config field map and defensive structured-policy fold.
- `src/rpc-handlers.ts:486-520,626-637` — strict RPC patch validation.
- `src/daemon.ts:9392-9424,10725-10729,11262-11269` — publication verification, acknowledgement, and boot behavior.
- `src/autopilot-projection.ts:107-123` — nullable policy projection parser.

**Optional** (reference as needed):
- `test/fable-focus.test.ts:76-319` — atomic validation, deadline, delivery, and refusal patterns.
- `test/db.test.ts:866-935` — fresh/upgrade defaults and exact boot republication.
- `docs/adr/0100-independent-scoped-account-focus.md` — failure-isolation and compatibility decision.

### Risks

- A schema/rebuild-list omission could clear a focus during migration or rewind.
- Generalizing `fable-focus.ts` must preserve every existing serialized Fable policy and leaf byte contract.
- Separate leaves must never be published by a helper that deletes or replaces its sibling.
- The migration step version is assigned at merge time; do not hard-code a provisional version in tests or prose.

### Test notes

Cover fresh and upgrade schema, null defaults, set/preserve/clear of either field, two-field events, malformed payload cursor advance, full re-fold identity, mixed policy generations, boot republication, one-leaf write failure, read-your-write acknowledgement, secure modes, PII/control rejection, and half-open permanent/absolute state. Use injected clocks/filesystems and explicit test files.

### Detailed phases

1. Extract generic scope-neutral policy/lifetime/leaf primitives while retaining Fable exports as compatibility wrappers.
2. Add the merge-time schema step, fresh schema, rebuild lists, types, collection decoding, and pure projection.
3. Extend generic RPC/event/fold handling with the independent Non-Fable field.
4. Publish and verify the sibling launch leaf on mutation and boot without touching Fable delivery.
5. Prove migration, replay, mixed-version, and failure-isolation behavior.

### Alternatives

Copying the Fable module would duplicate security and lifetime parsers. Combining both policies in one JSON cell or leaf would make independent updates and failure isolation impossible. The shared primitives plus compatibility facade preserve one implementation without changing Fable storage.

### Non-functional targets

- No fold reads wall-clock, filesystem, environment, capacity, or process state.
- Each leaf remains bounded, `0600`, PII-free, no-follow on insecure paths, and independently replaceable.
- Effective-state functions are pure for one `{delivery, observation, now}` input.

### Rollout

New and upgraded installations start with Non-Fable focus off. This task performs no live activation and leaves the existing Fable policy/leaf unchanged.

## Acceptance

- [ ] Fresh and upgraded schemas expose nullable, independently preserved Fable and Non-Fable focus cells.
- [ ] Generic config atomically sets or clears either focus without adding a mutating RPC or changing the sibling field.
- [ ] Non-Fable permanent and absolute policies receive event-owned identity and deterministic half-open effective state.
- [ ] Non-Fable mutation and daemon boot publish an exact independent owner-only leaf before successful acknowledgement.
- [ ] Missing, malformed, unsupported, insecure, or unpublished Non-Fable delivery has a scoped diagnostic and never clears or disables valid Fable delivery.
- [ ] Malformed events safely advance the cursor, and full re-folds reproduce both policy cells byte-identically.
- [ ] Named account-focus, Fable-focus, schema, reducer, RPC, daemon, and collection tests pass.

## Done summary

## Evidence
