## Description

**Size:** M
**Files:** src/types.ts, src/account-focus-arm.ts, src/account-observation.ts, src/account-focus.ts, src/fable-focus.ts, src/rpc-handlers.ts, src/server-worker.ts, src/daemon.ts, src/agent/main.ts, test/account-focus-arm.test.ts, test/account-focus.test.ts, test/fable-focus.test.ts, test/rpc-handlers.test.ts, test/daemon.test.ts, test/agent-account-routing.test.ts

### Approach

Make daemon main the authority for arming either focus. For every non-null Fable or Non-Fable config patch, resolve the scope's canonical target meter from one fresh, healthy, validated Capacity observation; refuse missing, stale, malformed, absent-route, absent-meter, or exactly-full evidence before appending any event. Preserve the public focus input and launch-leaf policy shape, but attach a bounded internal arming-evidence member to the `AutopilotConfigSet` Synthetic event so the resulting event-owned `policy_id` and trusted predecessor can be handed to the lifecycle producer without accepting client-supplied quota facts.

Keep null operator clears unconditional and keep sibling fields independently atomic. New failure responses must remain bounded and PII-free, and all lifetime forms—including permanent, absolute, current-reset, and cycle-end—use the same below-full arm gate.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/account-observation.ts:350-465` — canonical trusted route/window admission and utilization normalization.
- `src/account-observation.ts:704-812` — strict observation validation and completed-observation freshness authority.
- `src/account-focus.ts:101-303` — shared policy normalization, materialization, validation, and half-open lifetime behavior.
- `src/fable-focus.ts:39-160` — Fable-specific lifetime construction and strict policy compatibility.
- `src/daemon.ts:11119-11207` — generic config event append, synchronous drain, and exact focus-leaf publication.
- `src/reducer.ts:7314-7368` — downstream materialization and independent-field preservation that arming metadata must not destabilize.

**Optional** (reference as needed):
- `src/agent/main.ts:1767-1821` — existing focus mutation client and bounded error path.
- `test/account-observation.test.ts:244-303` — provider-owned observation trust behavior.
- `docs/adr/0110-policy-fenced-account-focus-lifecycle-clearing.md` — accepted arming and transition contract.

### Risks

- Validating only in the CLI would let another generic-config caller bypass the 100%/unavailable guard; daemon main is the linearization point.
- Adding evidence to the public policy or leaf would make rollback and launch delivery brittle; keep it internal to the event/producer handoff.
- A two-field config patch may arm each scope from different meters but must use one coherent observation and preserve all-or-nothing validation.
- Existing policies and historical events have no arming evidence and require an explicit compatibility path rather than fabricated quota history.

### Test notes

Use injected observations and clocks. Cover both scopes, every lifetime kind, utilization at 0, interior fractions, exactly 1, missing route/meter, stale/future/unhealthy/malformed observations, simultaneous two-focus set, sibling preservation, null manual clear, event evidence bounds, client-forged extras, error propagation, and no-event-on-refusal. Keep correctness tests in-process with no real provider, worker, socket, or daemon.

### Detailed phases

1. Add scope-neutral pure arming-evidence resolution over validated Capacity observations and canonical `model:Fable` / `week` meter selection.
2. Extend the internal config-event construction with bounded arming evidence while leaving public RPC input and persisted policy/leaf grammar stable.
3. Enforce atomic fail-closed validation in daemon main and return typed PII-free refusal details through the existing config mutation bridge.
4. Prove historical events, manual clears, mixed-scope patches, and existing routing/leaf readers remain compatible.

### Alternatives

A client-only preflight is insufficient because it is stale and bypassable. Persisting quota data in the deterministic Projection is unnecessary; the immutable creation event and bounded producer state carry the evidence. Requiring generic route eligibility instead of the named meter is rejected because focus arming has a narrower, scope-specific invariant.

### Non-functional targets

- No additional provider subprocess or refresh is triggered by a set request; use the current validated sidecar.
- Evidence and errors remain bounded, versioned where persisted, control-safe, and PII-free.
- The Fold remains pure and older `AutopilotConfigSet` events re-fold byte-identically.
- A refused set performs no event append, Projection mutation, or launch-leaf publication.

### Rollout

Existing focus policies remain readable and routeable. Only newly attempted set mutations acquire the fail-closed arm gate and internal evidence. A pre-land binary can ignore the additive internal event member while continuing to Fold the ordinary focus patch.

## Acceptance

- [ ] Every non-null Fable and Non-Fable focus set is authorized from fresh, healthy, structurally valid evidence for its exact target route and canonical meter.
- [ ] Missing, stale, malformed, absent, or exactly-full evidence returns a bounded error and leaves all durable focus intent unchanged.
- [ ] Zero and interior utilization can arm every supported lifetime kind, and the immutable creation event carries the exact trusted predecessor needed by the lifecycle producer.
- [ ] Public focus command/RPC input and persisted launch-leaf policy grammar do not accept caller-supplied quota evidence.
- [ ] Manual null clears, independent sibling patches, guarded reset construction, and legacy event re-fold behavior remain compatible.
- [ ] Named arming, focus, RPC, daemon, agent-routing, and observation tests pass using deterministic in-process fixtures.

## Done summary

## Evidence
