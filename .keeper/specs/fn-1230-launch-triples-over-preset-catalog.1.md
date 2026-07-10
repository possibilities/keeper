## Description

**Size:** M
**Files:** src/agent/matrix.ts, plugins/plan/src/host_matrix.ts, plugins/plan/test/src-subagents-config.test.ts, test/agent-matrix.test.ts, docs/examples/matrix.example.yaml

### Approach

Extend the matrix.yaml schema identically in BOTH firewalled parsers (no shared code — parity by test): (1) model entries accept a long form `{name, native?, efforts?}` discriminated by a required `name` key, alongside the bare scalar token; the legacy one-pair alias map (`capability: native-id`) retires with a fail-loud error naming the long form. (2) `efforts` gains per-provider and per-model overrides — most-specific wins by CLOBBER (model over provider over top-level), absent key inherits, a present-but-empty list is a fail-loud validation error, every override must be a subset of the canonical effort vocabulary, and accepted lists NORMALIZE to canonical ascending order so downstream render order is stable regardless of declaration order. Expose `effortsFor(model)` from each parser. (3) providers accept `route: true|false` (strict boolean, default true); `route: false` excludes the provider from the wrapped-cell pecking order and the capability cell set while keeping its models enumerable for launch; `route: false` on the claude provider is a load error; the claude-overlap XOR check applies to routed providers only. All new keys are additive: an absent/empty host matrix still returns null and falls back to embedded claude-only defaults byte-identically. Scalar values are validated as strings (typeof check) so YAML coercions fail loud.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/agent/matrix.ts:37-63 — Matrix/MatrixProvider/WrapperDriver shapes; :107 ALLOWED_MATRIX_KEYS; :234-253 model entry parsing (one-pair alias to retire); :357 assertNoClaudeOverlap; :391 providerOrderFor; :423 cellSet
- plugins/plan/src/host_matrix.ts:121 loadHostMatrix + coerce helpers — the plan island's own parser; mirror every rule
- plugins/plan/test/src-subagents-config.test.ts:158 — cross-island parity test: ONE fixture roster into both parsers; extend ACCEPTED and REJECTED rosters with long-form, override, empty-list, out-of-subset, route-flag, and claude-route:false cases
- test/agent-matrix.test.ts — mkdtemp + real-file loadMatrix patterns; also anti-rot-tests docs/examples/matrix.example.yaml as a golden

**Optional** (reference as needed):
- src/agent/harness.ts:34 — KEEPER_EFFORTS canonical vocabulary and order (the subset + normalization anchor)
- docs/adr/0033-launch-triples-over-named-preset-catalog.md — decision wording for route and overrides

### Risks

- Parser drift between islands is the failure mode this task exists to prevent — every accepted AND rejected fixture must run through both parsers in the parity test
- Unknown-key posture: new keys must be in each island's allowed-key set or existing hosts fail loud on files that used to load

### Test notes

Extend test/agent-matrix.test.ts (launcher) and the parity test (both islands) with: long-form + native alias, provider-level override, model-level override beating provider, empty-list rejection, out-of-subset rejection, declaration-order normalization, route:false exclusion from providerOrderFor/cellSet, route:false-on-claude rejection, non-string scalar rejection. Update docs/examples/matrix.example.yaml to exercise the new shape and keep its anti-rot test green.

## Acceptance

- [ ] Both matrix parsers accept the model long form and per-provider/per-model effort overrides with clobber-inherit-normalize semantics, and reject empty lists, out-of-subset tokens, the legacy one-pair alias, non-string scalars, and route:false on claude — with the parity test proving identical accept/reject behavior on shared fixtures
- [ ] effortsFor(model) resolves the most-specific effort list in both islands and returns canonical-order lists
- [ ] A route:false provider's models are absent from the pecking order and capability cell set while remaining present in the parsed matrix for enumeration
- [ ] An absent or empty host matrix still yields the embedded claude-only fallback unchanged
- [ ] The committed matrix example demonstrates overrides and the route flag and its anti-rot test passes

## Done summary

## Evidence
