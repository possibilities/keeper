## Description

**Size:** M
**Files:** src/account-observation.ts, src/account-routing-config.ts, src/account-observation-refresh.ts, src/account-router.ts, test/account-observation.test.ts, test/account-observation-refresh.test.ts, test/account-router.test.ts, test/agent-account-routing.test.ts

### Approach

Make the normalized cswap parser the single account-admission boundary. A row still needs a positive slot, `usageStatus: ok`, canonical valid measurement provenance, structurally valid scoped/base windows, and the required session/week meters; age and clock skew remain provenance rather than vetoes, with `usageFetchedAt` canonical when both provider freshness fields are present. Bump the transient observation schema, remove the independent route-age eligibility path, and make routing/scoring consume raw reported utilization without turning elapsed reset timestamps into zero.

Preserve the existing five-minute Capacity observation freshness gate, 30–35-second exact-argv observer cadence, bounded parsing, atomic publication, non-`ok` issue mapping, reservation pressure, no-duplicate-launch behavior, and fail-closed malformed/unsupported paths. Remove only the duplicate Measurement-age and reset reinterpretation policy.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/account-observation.ts:188 — the cswap state-of-world parser and route/account-issue XOR boundary.
- src/account-observation.ts:280 — per-account status, provenance, age, and window admission.
- src/account-observation.ts:464 — sidecar validation and schema invariants.
- src/account-observation.ts:638 — distinct observation and route freshness helpers.
- src/account-routing-config.ts:9 — transient observation schema and freshness/cadence constants.
- src/account-observation-refresh.ts:36 — observed-at timestamp and parser invocation.
- src/account-router.ts:203 — reset reinterpretation shared by eligibility and scoring.
- src/account-router.ts:243 — shared route eligibility used by automatic, explicit, inspection, and focus paths.
- test/account-observation.test.ts:100 — provider-status and old-measurement parser fixtures.
- test/account-router.test.ts:99 — fail-closed observation and route eligibility fixtures.

**Optional** (reference as needed):
- test/account-observation-refresh.test.ts:82 — exact one-call refresh and publication behavior.
- test/agent-account-routing.test.ts:486 — end-to-end routed-launch sidecar fixture.

### Risks

A partial removal can leave automatic and explicit selection disagreeing, so all callers must share one eligibility projection. Preserve required provenance even though age no longer vetoes, reject malformed scoped data that makes Fable intent ambiguous, and invalidate old semantic sidecars through the schema version rather than attempting compatibility. Do not alter the live observer cadence or subprocess security boundary.

### Test notes

Cover a fresh `ok` response with arbitrarily old and future-skewed measurement provenance, canonical precedence when both timestamp fields exist, immediate fresh non-`ok` revocation, malformed/missing provenance and quota windows, stale observation rejection, old sidecar rejection, raw exhausted utilization after elapsed reset, and agreement among automatic routing, explicit selection, inspection, scoring, and reservation behavior. Run only the named account observation/refresh/router/agent-routing test files.

## Acceptance

- [ ] A fresh `usageStatus: ok` row with valid required quota data remains an admitted Account route regardless of how old or future-skewed its valid measurement timestamp is.
- [ ] A fresh non-`ok` row, malformed or missing required provenance/windows, an unsupported schema, and a stale Capacity observation remain unavailable with bounded PII-free diagnostics.
- [ ] A sidecar written under the prior eligibility semantics is rejected until the current observer publishes the new transient schema.
- [ ] An exhausted raw quota meter remains exhausted after its reported reset time until a later claude-swap response changes its utilization.
- [ ] Automatic routing, explicit Account selection, inspection, conservation scoring, and reservation pressure derive from one shared admitted-route projection.
- [ ] The named account observation, refresh, router, and routed-launch test files pass.

## Done summary

## Evidence
