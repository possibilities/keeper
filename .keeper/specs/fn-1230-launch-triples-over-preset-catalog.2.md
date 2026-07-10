## Description

**Size:** M
**Files:** plugins/plan/src/subagents_config.ts, plugins/plan/src/models.ts, plugins/plan/src/verbs/selection_brief.ts, plugins/plan/src/verbs/selection_apply_core.ts, plugins/prompt/src/render_plugin_templates.ts, plugins/plan/subagents.yaml, plugins/plan/scripts/model-guidance-check.ts, plugins/plan/test/consistency-generated-guard.test.ts, plugins/plan/test/consistency-skills.test.ts

### Approach

Move every plan-island consumer of the flat global effort axis onto per-model effort lists so the worker-cell cube goes ragged cleanly: the render fan-out emits cells only for each model's effective efforts; tier validation (worker-agent compose, assign-cells apply, scaffold/refine validation paths that consult configured efforts) checks membership in that model's list; the selection brief enumerates candidates per model instead of a rectangular cartesian; the model-guidance drift gate covers the union of effort tokens across scopes. The embedded subagents.yaml stays the claude-only base (global efforts, no overrides needed) — its header comments describe the new host-override shape. Capability tokens remain the only model vocabulary on this island; triples never appear here. The drift-gate tests that assert the on-disk cell set equals the models-times-efforts product must assert the ragged product.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/prompt/src/render_plugin_templates.ts:512-598 — renderAgents 2-D fan-out and pluginEffectiveMatrix(:134); the fan loop moves to effortsFor
- plugins/plan/src/subagents_config.ts:138 workerCellDir, :156 composeWorkerAgent effort membership gate
- plugins/plan/src/verbs/selection_brief.ts:298-300 — candidate enumeration cartesian
- plugins/plan/src/verbs/selection_apply_core.ts:106-131 — validateSelectionCells two-list membership
- plugins/plan/src/models.ts:147-156 — configuredEfforts/configuredModels/workerAgentFor
- plugins/plan/test/consistency-generated-guard.test.ts:128 and consistency-skills.test.ts:518,784 — cartesian drift gates that must go ragged

**Optional** (reference as needed):
- plugins/plan/scripts/model-guidance-check.ts — one-guidance-block-per-effort gate; move to union-of-scopes
- plugins/plan/audit-policy.yaml:16 — tier_audit keyed by effort; confirm a narrowed model cannot strand a policy key (policy stays keyed on the global vocabulary)
- plugins/prompt/test/parity.test.ts + fixtures — render goldens; re-record deliberately if output shape shifts

### Risks

- A site left on the global axis silently accepts a tier the model cannot render — the ragged drift gates are the backstop, so land them with the change, not after
- Render goldens re-record must be a reviewed, deliberate diff, not a blind regenerate

### Test notes

With no host overrides configured the rendered cell set must be byte-identical to today (zero-behavior-change proof). Add a fixture override matrix producing a ragged set and assert renderer, brief, and apply all agree on it. cd plugins/plan && bun test covers the island plus parity.

## Acceptance

- [ ] With no host overrides, rendered cells, selection candidates, and validation behavior are unchanged from before this epic
- [ ] With a per-model override fixture, the renderer emits exactly the ragged cell set, the selection brief enumerates exactly those candidates, and assign-cells rejects a tier outside that model's list naming the model
- [ ] The drift-gate tests assert the ragged product and fail on any cell outside it
- [ ] Model-guidance checking covers the union of effort tokens across all scopes

## Done summary
Moved every plan-island effort consumer onto per-model effective effort lists (EffectiveMatrix.effortsFor): renderer, selection-brief candidates, the cell-write axis gate (naming the model), and workerAgentFor now fan out over the ragged {model × effort} cube; model-guidance effort coverage moved to the union of scopes. Zero behavior change with no host matrix.
## Evidence
