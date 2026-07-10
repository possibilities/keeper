## Description

**Size:** M
**Files:** src/agent/matrix.ts, plugins/plan/src/host_matrix.ts, plugins/plan/src/worker_cells.ts (new), docs/examples/matrix.example.yaml, test/agent-matrix.test.ts, plugins/plan/test (host-matrix coverage), shared v2 fixtures

### Approach

Reshape BOTH hand-rolled matrix parsers to the v2 schema in lockstep (the cross-island parity test is the
contract): top-level `efforts`, `subagent_templates` (non-empty relative paths, escape-validated: no
absolute, no `..`, no NUL — this replaces the render_to traversal guard downstream), `subagent_models`
(strict capability tokens), `providers` with model entries as bare launch-id strings or `{id, efforts}`
long form, `wrapper_driver`, `defaults`. Retired keys `route:`/`native:`/`name:`/`subagents:` are rejected
with an error NAMING the key. Capability = segment after the LAST `/` (whole string when slash-free),
validated non-empty + strict charset (reuse the per-segment alias-target validator). Same-provider duplicate
derived capability = load error; cross-provider duplicate = intended dedup — first provider in the roster
wins dispatch AND owns the capability's effort list, and the loader result exposes shadowed entries so
callers can log them. A `subagent_models` entry served by no provider = load error. Failure taxonomy is
four typed states — absent / unparseable / schema-invalid / valid-but-empty — each error carrying the
resolved config path and the copy-the-example fix; both islands express the same states through their
existing error types (ConfigError / the plan island's typed errors).

Create a NEW fs/os-free leaf module `plugins/plan/src/worker_cells.ts` holding copies of WORKERS_BASE,
workerCellDir, and the pure {model, effort} → worker-agent compose (over explicit axes) — relocated from
subagents_config.ts, which stays in place untouched this task (consumers cut over in dependent tasks; the
deletion task removes it). The new module must import no node:fs/node:os so the reconcile closure can adopt
it. Keep host_matrix's EffectiveMatrix export shape working (the subagents.yaml base-compose path survives
until the plan cutover task; only the parse layer beneath goes v2). Launcher side: reshape
parseProviderModels; nativeIdFor becomes the capability → launch-id lookup from the winning entry; the
`keeper agent` providers-resolve absent-matrix claude-native fallback flips to the typed loud error.
Rewrite docs/examples/matrix.example.yaml to v2 in this task — the anti-rot test loads it by explicit path,
so example and parser move together; keep it comment-heavy and outside every discovered config path.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/agent/matrix.ts:330-410 — parseProviderModels, the launcher long-form parser to reshape
- src/agent/matrix.ts:302-321, 497-517, 531-539, 589-605 — parseRoute / assertNoClaudeOverlap / providerOrderFor / cellSet: the route/pecking seams
- src/agent/matrix.ts:569 — nativeIdFor; :105-107 isValidMatrixAliasTarget; :79-85 defaults + matrixConfigPath
- plugins/plan/src/host_matrix.ts:294-410 — coerceProviders/coerceProviderModels (coerceRoute :384, retired-alias-map rejection :436-441)
- plugins/plan/src/host_matrix.ts:97-110 — isMatrixAliasTarget (per-segment strict tokens: basename derivation is safe by construction)
- plugins/plan/src/host_matrix.ts:70-81, 186-190, 508-541 — keeperConfigDir, the parsed-then-discarded subagents key, composeEffective
- plugins/plan/src/subagents_config.ts:128-188 — WORKERS_BASE / workerCellDir / composeWorkerAgent to copy into the new leaf
- test/agent-matrix.test.ts — the cross-island parity + example anti-rot suite
- src/agent/main.ts:1996-2020 — providers resolve fallback to flip loud

**Optional** (reference as needed):
- src/agent/config.ts:82 — launcher-side config-dir resolution
- plugins/plan/src/host_matrix.ts:117 — CANONICAL_EFFORTS (efforts validate as a subset, canonical order)

### Risks

- The two parsers drifting — the parity test over shared v2 fixtures is the guard; land both islands in this one task
- Keeping composeEffective's base path alive while re-shaping the parse layer beneath it (dependent tasks rely on it until the cutover)

### Test notes

Shared fixture set: valid claude-only; valid multi-provider with ragged {id, efforts} + a provider-qualified
pi launch-id; one fixture per retired key; one per failure state; same-provider collision; cross-provider
dedup with shadow. Parity test asserts both islands parse each fixture identically; anti-rot test green on
the rewritten example.

## Acceptance

- [ ] Both island loaders accept the v2 fixture set (bare launch-id and {id, efforts} forms) and derive identical capability tokens by basename, asserted by the cross-island parity suite
- [ ] A matrix carrying any retired key (route:, native:, name:, subagents:) is rejected with an error naming that key
- [ ] The four failure states produce four distinguishable typed errors, each naming the resolved config path and the copy-the-example fix
- [ ] A same-provider basename collision errors at load; a cross-provider duplicate resolves to the first provider with its effort list and the shadowed entry is observable in the loader result
- [ ] A subagent_models entry no provider serves errors at load; a provider model absent from subagent_models loads as launch-only enumeration
- [ ] docs/examples/matrix.example.yaml parses under the new loaders and demonstrates a bare launch-id, an {id, efforts} band, and a provider-qualified entry; the anti-rot test passes
- [ ] A new plan-island leaf module exports the worker-cell path/compose helpers and imports no node:fs or node:os
- [ ] keeper agent provider resolution with no matrix present emits the typed loud error instead of a claude-native fallback candidate

## Done summary

## Evidence
