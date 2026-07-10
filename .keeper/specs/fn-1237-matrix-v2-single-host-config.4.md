## Description

**Size:** M
**Files:** plugins/plan/src/models.ts, plugins/plan/src/verbs/selection_brief.ts, plugins/plan/src/verbs/close_preflight.ts, plugins/plan/scripts/model-guidance-check.ts, plugins/plan/scripts/audit-policy-check.ts, test/helpers/sandbox-env.ts, plugins/plan/test/consistency-model-selector.test.ts, plugins/plan/test/consistency-audit-policy.test.ts, plugins/plan/test/saga-assign-cells.test.ts, plugins/plan/test/saga-selection-brief.test.ts, plugins/plan/test/src-models.test.ts, plan test fixtures

### Approach

Plan verbs resolve their axes from the required v2 host matrix: models.ts (configuredModels /
configuredEfforts / effortsAxis / modelsAxis / workerAgentFor) reads the v2 loader with subagent_models as
the model axis — the embedded/base-compose path in models.ts dies here. The stamped worker-agent shape
`plan:worker-<model>-<tier>` must stay byte-identical for existing capability tokens (claim, worker_resume,
resolve_task persist it to task JSON — in-flight tasks must re-validate cleanly). selection_brief embeds the
host matrix.yaml verbatim where it embedded subagents.yaml, retaining the MATRIX_MISSING loud error;
close_preflight retargets its loader import. Gates split integrity from coverage: model-guidance-check
`--check` drops the axis-coverage directions and keeps structural config validation + research-hash parity
(host-blind, green on a matrix-less host); its `--state` mode swaps its axes source to the v2 host matrix
with semantics otherwise UNCHANGED — the model-guidance-v2 follow-up epic owns the state-lattice/coverage UX,
so keep this a minimal source swap. audit-policy-check validates tier keys against the canonical effort
vocabulary constant instead of reading any host file. sandboxEnv gains KEEPER_CONFIG_DIR (per-test tmp config
dir; helper to seed the committed claude-only fixture) so no test can read the live ~/.config/keeper; every
plan disk-mode test pins it.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/src/models.ts:147-180 — the axes + workerAgentFor surface to retarget
- plugins/plan/src/verbs/claim.ts:361, worker_resume.ts:179, resolve_task.ts:133 — worker_agent stamp sites (shape must not change)
- plugins/plan/src/verbs/selection_brief.ts:236-255 — the subagents.yaml embed + MATRIX_MISSING precedent
- plugins/plan/src/verbs/close_preflight.ts — its loadSubagentsMatrixFromDisk usage
- plugins/plan/scripts/model-guidance-check.ts:286-297, 480-493 — the FromDisk entry points and coverageErrors split
- plugins/plan/scripts/audit-policy-check.ts:178-190 — the subagents.yaml efforts anchor to replace with the canonical constant
- test/helpers/sandbox-env.ts:50 — the six-path sandbox builder gaining the config dir

**Optional** (reference as needed):
- plugins/plan/src/host_matrix.ts:117 — CANONICAL_EFFORTS (the vocabulary constant audit-policy validates against)
- plugins/plan/test/consistency-model-selector.test.ts:147-160 — the disk-mode all-fresh assertion to pin on fixtures

### Risks

- Scope creep into the follow-up epic's --state semantics — this task is an axes-source swap only
- A missed disk-mode test silently reading the live host matrix — the sandboxEnv addition plus a sweep of plan tests is the guard

### Test notes

Run the gate scripts with KEEPER_CONFIG_DIR at an empty tmpdir and assert --check green (integrity-only
proof); assert a verb touching the axes with no matrix emits the typed error envelope; assert worker_agent
byte-stability for opus/sonnet across the cutover; saga suites green under pinned fixtures.

## Acceptance

- [ ] Every plan verb resolves model/effort axes from the v2 host matrix; a verb touching the axes with no matrix present emits the typed loud error envelope
- [ ] A task's stamped worker_agent for existing capability tokens is byte-identical to the pre-change shape
- [ ] The selection brief embeds the host matrix.yaml (MATRIX_MISSING when absent) instead of subagents.yaml
- [ ] model-guidance-check --check and audit-policy-check pass on a host with no matrix — structure + research-hash parity and canonical-vocabulary tier checks only — and --state runs against the v2 host matrix axes with otherwise-unchanged semantics
- [ ] sandboxEnv sandboxes KEEPER_CONFIG_DIR and the plan suite passes with it pinned at fixtures, never reading the live config dir

## Done summary

## Evidence
