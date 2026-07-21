## Description

**Size:** M
**Files:** cli/session-runtime.ts, cli/session.ts, cli/statusline-sink.ts, cli/descriptor.ts, src/session-runtime.ts, plugins/keeper/pi-extension/status-footer.ts, integrations/pi-codex-pool/src/index.ts, integrations/pi-codex-pool/src/state.ts, test/session-runtime.test.ts, test/statusline-sink.test.ts, test/keeper-cli.test.ts, integrations/pi-codex-pool/test/provider-pool.test.ts

### Approach

Add the schema-v1 `keeper session runtime [<session-reference>]` leaf under the existing Session command group. Preserve the current coalesced telemetry path for reducer cost, but atomically publish a separate exact latest sample carrying source time, proven subject scope, Harness-native/job/agent identities when available, model, effort axis, raw context values, and route provenance; explicit fallback to jobs data must be labeled coalesced rather than current.

Extend the Keeper-marked Pi companion to publish bounded, private, PII-free route observations whenever scoped selection, retry, fallback, or retirement changes the actual route. The runtime reader may expose only opaque alias and quota scope; the launch-time initial alias remains a hint, and unsupported/nested sources return an explicit unavailable or parent/job scope instead of inferred identity.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `cli/session.ts:20-70` — lazy Session leaf registration and help ordering.
- `cli/session-state.ts:178-260` — shared Session-reference resolution and ambient fallback.
- `cli/statusline-sink.ts:46-230` — bounded parsing, atomic leaf writes, timestamps, and current 5% coalescing.
- `plugins/keeper/pi-extension/status-footer.ts:96-121` — launch-time-only alias display that must not masquerade as actual routing.
- `plugins/keeper/pi-extension/status-footer.ts:305-347` — Pi runtime telemetry publication seam.
- `integrations/pi-codex-pool/src/state.ts:816-1049` — authoritative scoped route selection and `routeFor()` behavior.

**Optional** (reference as needed):
- `src/statusline-worker.ts:115-205` — coalesced worker/event boundary that should remain bounded.
- `src/reducer.ts:11190-11220` — latest-non-null jobs Projection semantics.
- `src/types.ts:640-755` — existing telemetry field vocabulary.

### Risks

Frequent exact samples must not amplify reducer events or create unbounded route/session cardinality. Atomic route publication must remain fail-open for model serving, and no supported output may serialize credentials, raw provider errors, full environment values, or unproven nested identity.

### Test notes

Use injected clocks and temporary private roots. Prove within-bucket context/token changes update exact runtime while preserving the existing coalesced event gate; prove ambiguous Session references fail through the standard envelope; prove a Pi retry changes the reported actual scoped route; and exercise secret canaries plus bounded route eviction.

### Detailed phases

1. Define the independent runtime schema, subject/freshness enums, and daemon-optional exact reader.
2. Split exact latest publication from coalesced event publication without changing jobs fold semantics.
3. Carry proven Pi Session identity and publish actual scoped route transitions from the companion.
4. Register the Session leaf and add contract, compatibility, and sanitation tests.

### Alternatives

Reading `keeper show-job` alone is insufficient because it lacks telemetry observation time, remains coalesced, and cannot report the actual post-retry Pi route. Replacing the jobs Projection with exact high-frequency events would increase fold cost without improving board behavior.

### Non-functional targets

Exact leaves and route observations remain bounded, owner-private, atomic, fail-open, and independent of keeper.db writes. The read performs no provider refresh and completes from local state with deterministic ordering.

### Rollout

The command is additive. Existing statusline rendering, `show-job`, query collections, and jobs telemetry remain byte/behavior compatible; old Sessions without exact leaves return explicit coalesced or unavailable provenance.

## Acceptance

- [ ] `keeper session runtime` emits a standard schema-v1 envelope for ambient and explicit shared Session references and rejects missing or ambiguous references consistently.
- [ ] The envelope distinguishes subject scope, exact/coalesced source, observation and generation time, unavailable values, model, effort/thinking axis, raw context percentage/tokens/window, and proven route attribution.
- [ ] Context and token movement within one existing 5% projection bucket updates the exact runtime read without increasing coalesced jobs event publication.
- [ ] A Pi Codex retry, fallback, scope switch, or retirement updates the proven actual scoped route, while the launch-time initial alias remains labeled only as a hint.
- [ ] Nested or unsupported runtime sources never present parent/job telemetry as agent-local and never substitute zero for unavailable measurements.
- [ ] Runtime and route artifacts remain bounded, private, atomic, fail-open, and free of credential/provider identity and raw-error canaries.
- [ ] Targeted Session, statusline, CLI registration, and Codex pool tests pass without a real daemon, subprocess, or fixed sleep.

## Done summary

## Evidence
