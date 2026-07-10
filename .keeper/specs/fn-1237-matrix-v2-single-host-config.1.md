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
until the plan cutover task; only the parse layer beneath goes v2).

ADDITIVE ONLY on the launcher side (early-proof-point re-scope: an in-place launcher reshape broke dispatch
route-probe tests owned by task 2, so that cutover moves there). This task adds the v2 loader/parser to
src/agent/matrix.ts BESIDE the existing v1 surface — parseRoute, parseProviderModels, nativeIdFor,
assertNoClaudeOverlap, providerOrderFor, cellSet, and every caller of them (src/worker-cell.ts's
defaultRouteProbe, the `keeper agent` providers resolve in src/agent/main.ts) are UNCHANGED by this task and
keep passing today's tests. Task 2 reshapes parseProviderModels/nativeIdFor into the capability → launch-id
lookup and flips the providers-resolve claude-native fallback to the typed loud error, in lockstep with its
own resolveWorkerCell/defaultRouteProbe rewrite. Rewrite docs/examples/matrix.example.yaml to v2 in this
task — the anti-rot test loads it by explicit path against the NEW v2 loader, so example and v2 parser move
together; keep it comment-heavy and outside every discovered config path.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/src/host_matrix.ts:294-410 — coerceProviders/coerceProviderModels (coerceRoute :384, retired-alias-map rejection :436-441)
- plugins/plan/src/host_matrix.ts:97-110 — isMatrixAliasTarget (per-segment strict tokens: basename derivation is safe by construction)
- plugins/plan/src/host_matrix.ts:70-81, 186-190, 508-541 — keeperConfigDir, the parsed-then-discarded subagents key, composeEffective
- plugins/plan/src/subagents_config.ts:128-188 — WORKERS_BASE / workerCellDir / composeWorkerAgent to copy into the new leaf
- test/agent-matrix.test.ts — the cross-island parity + example anti-rot suite (targets the new v2 loader; the legacy route/dispatch surface is out of scope this task)
- src/agent/matrix.ts:79-85 — defaults + matrixConfigPath (the config-path resolution the new v2 loader shares with v1)

**Optional** (reference as needed):
- src/agent/config.ts:82 — launcher-side config-dir resolution
- plugins/plan/src/host_matrix.ts:117 — CANONICAL_EFFORTS (efforts validate as a subset, canonical order)

### Risks

- The two parsers drifting — the parity test over shared v2 fixtures is the guard; land both islands' v2 loader in this one task
- Keeping composeEffective's base path AND the launcher's v1 route/dispatch surface alive while the v2 loader lands beside them — cutting either over is out of scope here (task 2 owns the launcher's dispatch path; the deletion task owns the rest)

### Test notes

Shared fixture set: valid claude-only; valid multi-provider with ragged {id, efforts} + a provider-qualified
pi launch-id; one fixture per retired key; one per failure state; same-provider collision; cross-provider
dedup with shadow. Parity test asserts both islands' v2 loader parses each fixture identically; anti-rot test
green on the rewritten example.

## Acceptance

- [ ] Both island loaders accept the v2 fixture set (bare launch-id and {id, efforts} forms) and derive identical capability tokens by basename, asserted by the cross-island parity suite
- [ ] A matrix carrying any retired key (route:, native:, name:, subagents:) is rejected with an error naming that key
- [ ] The four failure states produce four distinguishable typed errors, each naming the resolved config path and the copy-the-example fix
- [ ] A same-provider basename collision errors at load; a cross-provider duplicate resolves to the first provider with its effort list and the shadowed entry is observable in the loader result
- [ ] A subagent_models entry no provider serves errors at load; a provider model absent from subagent_models loads as launch-only enumeration
- [ ] docs/examples/matrix.example.yaml parses under the new v2 loaders and demonstrates a bare launch-id, an {id, efforts} band, and a provider-qualified entry; the anti-rot test passes
- [ ] A new plan-island leaf module exports the worker-cell path/compose helpers and imports no node:fs or node:os
- [ ] The existing v1 launcher surface (parseRoute, parseProviderModels, nativeIdFor, defaultRouteProbe, `keeper agent` providers resolve) is untouched, and worker-cell.test.ts, dispatch-cli.test.ts, and wrapped-cell-e2e.slow.test.ts stay green exactly as they pass today

## Done summary
Added v2 host-matrix loaders (loadMatrixV2 / loadHostMatrixV2) beside the unchanged v1 parse layer in both islands: launch-id entries with basename-derived capabilities, subagent_models/subagent_templates, cross-provider dedup with visible shadow log, and typed four-state failures (absent/unparseable/schema-invalid/valid-but-empty) naming the path + example fix; retired route:/native:/name:/subagents: keys rejected by name. Added the fs/os-free worker_cells.ts leaf, rewrote matrix.example.yaml to v2, and pinned both islands with cross-island parity + anti-rot + four-state suites over shared fixtures. Per the coordinator re-scope, the v1 loaders and every consumer stay unchanged (runtime cutover deferred to task .2).
## Evidence
