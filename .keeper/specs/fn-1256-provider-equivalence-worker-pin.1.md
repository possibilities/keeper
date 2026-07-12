## Description

**Size:** M
**Files:** plugins/plan/provider-equivalence.yaml, plugins/plan/src/provider_equivalence.ts, plugins/plan/scripts/model-guidance-check.ts, plugins/plan/test/consistency-provider-equivalence.test.ts, plugins/plan/test/fixtures/, src/commit-work/lint-matrix.ts, test/lint-matrix.test.ts

### Approach

Create the committed equivalence artifact and its enforcement. `provider-equivalence.yaml`
carries `schema_version: 1` and `mappings.claude_to_codex` / `mappings.codex_to_claude` —
per source model, per canonical effort, one `{model, effort}` target cell. The two
directions are authored independently and are never inverses. Seed a defensible v1 by
distilling the committed `model-selector.yaml` guidance blocks (capability-relative
when-to-pick prose is sufficient signal); /model-guidance owns refreshes thereafter.

A new strict plan-island parser (`provider_equivalence.ts`) rejects unknown keys at every
level, non-canonical efforts, and malformed target shapes — deliberately NOT the permissive
coercer pattern that ignores unknown top-level keys. Extend model-guidance-check.ts:
`--check` stays host-blind (structure; canonical five-rung efforts; cross-direction
opposite-family proxy: every claude_to_codex target model must be a codex_to_claude source
key and vice versa; no self-family targets; no duplicates); `--state` gains an `equivalence`
envelope classifying totality in BOTH directions against the live matrix's dispatchable
cells (model × effortsFor(model) for each subagent_models member, via loadHostMatrixV2) and
validating every target exists in the live matrix. Register a staged-path trigger in the
commit-work lint matrix so an edit to the map or parser runs the gate.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/scripts/model-guidance-check.ts:28-250 — gate structure, coerce/check/state split, report-or-exit shape to extend
- plugins/plan/src/host_matrix.ts:44-120 — EffectiveMatrix, effortsFor raggedness, CANONICAL_EFFORTS; the --state axis source
- plugins/plan/test/consistency-model-selector.test.ts — the drift-gate test pattern to copy (scratch KEEPER_CONFIG_DIR, fixtures matrix-claude-only.yaml)
- plugins/plan/model-selector.yaml:111-213 — the guidance blocks the v1 map distills from

**Optional** (reference as needed):
- src/commit-work/lint-matrix.ts — isModelGuidancePath-style predicates; test/lint-matrix.test.ts pins them
- plugins/plan/scripts/panel-guidance-check.ts — sibling committed-roster structural gate precedent

### Risks

- The host-blind opposite-family proxy (cross-direction source/target reference) is the one clever invariant — if it proves too strict for a future asymmetric roster, --state's provider-membership check is the authoritative fallback; keep the proxy's failure message naming both models
- Seeded v1 equivalences are judgment — mark map provenance so /model-guidance's refresh pass (task .2) can distinguish seeded from researched entries

### Test notes

Fixtures: one well-formed map and one deliberately-invalid (unknown key + same-family
target + missing effort) that MUST fail --check — the break-it-first proof. In-process
consistency test drives the pure cores over the committed files like the model-selector twin.

## Acceptance

- [ ] The committed map is total in both directions over the dispatchable cells and the gate passes
- [ ] --check rejects, with named reasons: an unknown key at any level, a non-canonical effort, a same-family or dangling cross-direction target, a duplicate source cell
- [ ] --state classifies a missing source cell (simulated matrix add) as a gap in the right direction
- [ ] The break-it-first fixture fails --check in the fast suite; the lint-matrix trigger fires on staged map/parser paths
- [ ] Fast suite green

## Done summary
Added plugins/plan/provider-equivalence.yaml (ADR 0047) with a strict directional {model,effort} parser (provider_equivalence.ts), total in both directions over the dispatchable cell set; extended model-guidance-check.ts's --check/--state to gate it host-blind plus against the live matrix; registered the map/parser as a lint-matrix staged-path trigger; break-it-first fixture + full consistency test suite.
## Evidence
