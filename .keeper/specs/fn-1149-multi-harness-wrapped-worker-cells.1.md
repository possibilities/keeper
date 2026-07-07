## Description

**Size:** M
**Files:** src/agent/matrix.ts, src/agent/dispatch.ts, src/agent/main.ts, cli/agent.ts, cli/descriptor.ts, cli/keeper.ts, test/agent-matrix.test.ts, docs/problem-codes.md

### Approach

New dep-free `src/agent/matrix.ts` in the config island: parse `~/.config/keeper/matrix.yaml`
(honoring the KEEPER_CONFIG_DIR seam) into a typed shape — `efforts`, ordered `providers`
(each `{name, models}` where a model entry is a bare capability token or a one-pair
`capability: native-id` alias map), `subagents`, `wrapper_driver {model, effort}`, and
additive `defaults {stop_timeout_ms, max_attempts}` (defaults 7200000 / 2). Fail-loud
ConfigError on: malformed YAML, unknown top-level keys, a provider name not in
HARNESS_DESCRIPTORS, a model under claude AND another provider (ambiguous driver), or a
token violating the widened name charset (lowercase alnum, hyphen, underscore, dot; no
leading dot). An ABSENT file returns null so callers fall back to embedded defaults —
today's behavior must stay byte-identical. Export pure derivations: driverFor(model)
(claude membership = native, else wrapped), providerOrderFor(model) (roster order filtered
by membership, claude excluded), cellSet(), nativeIdFor(provider, model).

Two new verbs under `keeper agent providers`: `resolve <model> <effort>` emits a JSON
envelope with the cost-ordered candidates `[{harness, model_id, preset_name}]` plus the
defaults block; empty candidates for a wrapped model exits non-zero with a distinct
no_route code; bad tokens exit 2. `check` is the doctor: roster vs preset catalog vs
binary reachability drift, one line per finding. Both verbs register in the pure-data CLI
descriptor tree so the conformance gate stays green. Add the new exit codes to
docs/problem-codes.md.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/agent/config.ts:79-94 — KEEPER_CONFIG_DIR resolution + ConfigError posture to mirror
- src/agent/harness.ts:95-158 — HARNESS_DESCRIPTORS registry provider names validate against
- src/agent/dispatch.ts:294-355 — splitSubcommand routing where the providers verb slots
- cli/descriptor.ts and cli/keeper.ts — descriptor-tree registration pattern (landed fn-1142 infrastructure; a new subverb must register here, not just cli/agent.ts)

**Optional** (reference as needed):
- plugins/plan/src/subagents_config.ts:1-60 — the embed+disk dual-mode loader precedent
- test/agent-config.test.ts:38-167 — mkdtemp + KEEPER_CONFIG_DIR + .toThrow(ConfigError) test conventions
- docs/problem-codes.md — code-row table format

### Risks

- The descriptor conformance gate fails if the verbs are wired only in cli/agent.ts —
  registration in the shared descriptor tree is part of the deliverable.
- fn-1146 edits the same descriptor-tree files; the epic-level dependency serializes the
  epics, but read the tree as it stands when this task runs.

### Test notes

Fixture matrices under a sandboxed config dir: valid roster with aliases, absent file,
each fail-loud shape (unknown provider, claude overlap, dotted-leading token, unknown key).
Verify resolve ordering, alias resolution, and the no_route exit path.

## Acceptance

- [ ] A malformed or invalid matrix config makes agent verbs exit non-zero naming the
      offense; an absent file leaves every existing keeper agent behavior unchanged.
- [ ] providers resolve returns the cost-ordered candidate list with native model ids and
      honors per-provider aliases; an unroutable wrapped model exits with the distinct
      no_route code.
- [ ] A model listed under claude and another provider is rejected at load with a distinct error.
- [ ] providers check reports roster/preset/reachability drift and the CLI descriptor
      conformance gate stays green.
- [ ] The fast suite passes with the new sandboxed matrix tests.

## Done summary

## Evidence
