## Description

**Size:** M
**Files:** src/agent/triple.ts, src/agent/matrix.ts, src/agent/main.ts, cli/descriptor.ts, test/agent-matrix.test.ts, test/agent-presets.test.ts, docs/problem-codes.md

### Approach

Introduce the launch-triple module in the launcher island (dep-free, no bun:sqlite reachability — the cold-start import guard must stay green): parseTriple/formatTriple validating exactly three ::-separated segments — harness in the registry, model a slash-joined matrix token (the alias-target charset), effort in the canonical vocabulary plus the na sentinel (na required when the harness has no second axis, forbidden otherwise); bare colons inside segments are unparseable by construction; segments are strictly strings with bounded length. slugifyTriple derives the display/file form via the existing slug primitive with a short stable hash suffix available for collision disambiguation — the raw triple stays the identity everywhere. Add enumerateTriples(matrix): every provider (routed or launch-only) fans its models (native id when aliased) over effortsFor(model) — hermes models emit na. Reshape keeper agent presets list --json to emit the virtual cube (triples grouped per harness with native ids and effective efforts, plus the four harness defaults) and presets resolve to accept a triple (echo its parse) or a panel name (deref members). Extend the providers-check doctor with a host-triple lint: parse defaults, worker, escalation, and panel members from the host files; a malformed triple is a tool fault, a well-formed triple absent from the enumerable cube is a drift finding on the existing exit-9 path; the auto-preset collision finding retires. Update descriptor help strings and the problem-codes JSON specs for the reshaped envelopes.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/agent/matrix.ts:79-104 isValidMatrixToken/isValidMatrixAliasTarget (model-segment charset), :439 presetNameFor (retires), :463 resolveModel
- src/agent/harness.ts:19 HARNESS_NAMES/isHarnessName, :34 KEEPER_EFFORTS, :157-172 descriptors with secondAxis, :221 mapKeeperEffortToAxis
- src/agent/main.ts:1378 runPresetsList, :1292 runPresetsResolve, :1646 runProvidersResolve, :1728 runProvidersCheck (+ providerCheckFindings in matrix.ts:507)
- src/slug.ts — slugify/validateSlug/SLUG_MAX_LEN; reuse, never a third slugifier
- docs/problem-codes.md:87-126 — the exact JSON envelope specs being reshaped

**Optional** (reference as needed):
- cli/descriptor.ts:349,1314,1326 — preset arg summary, exit-9 help, presets verb docs
- test/agent-presets.test.ts header — cold-start import-graph guard for the launcher island

### Risks

- The wrapped-worker template consumes the providers-resolve candidates envelope (preset_name field) — keep resolve emitting a launch reference per candidate (the triple) so that template's contract change lands in the prose task without a dead window
- Grammar leniency creep: reject, never best-effort-parse, a malformed triple

### Test notes

Table-drive the grammar: valid triples per harness (slashed pi native id, hermes na), rejects (2 or 4 segments, bare colon in a segment, unknown harness, na on claude, non-na absent for hermes, over-length). Enumeration fixture: routed + launch-only providers, aliased models, per-model overrides — assert cube contents and that route:false models appear here while absent from pecking order (schema behavior proven in task 1). Doctor fixture: host files with one well-formed off-cube triple (drift finding) and one malformed (fault).

## Acceptance

- [ ] A launch triple parses if and only if it has exactly three segments with a registered harness, a valid native-id model segment, and a vocabulary effort honoring the na-for-axisless rule, and every rejection names the offending segment
- [ ] presets list --json emits every enumerable triple including launch-only providers, with per-model effective efforts and the four harness defaults; presets resolve echoes a parsed triple or derefs a panel name
- [ ] providers check reports a well-formed host triple outside the cube as a drift finding and a malformed one as a fault, and no collision finding for auto-generated presets exists anywhere
- [ ] The launcher island import graph still never reaches the DB layer

## Done summary
Added src/agent/triple.ts (parseTriple/formatTriple/slugifyTriple, enumerateTriples, host-triple lint) as a dep-free launcher island; reshaped presets list/resolve to the virtual cube + triple grammar and providers check to lint host triples against the cube, retiring the auto-preset collision finding.
## Evidence
