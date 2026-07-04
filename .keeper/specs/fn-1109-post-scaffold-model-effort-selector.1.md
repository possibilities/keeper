## Description

**Size:** M
**Files:** plugins/plan/src/verbs/assign_cells.ts, plugins/plan/src/cli.ts, plugins/plan/src/validation_restamp.ts, plugins/plan/src/selection_sidecar.ts, plugins/plan/test/saga-assign-cells.test.ts, docs/problem-codes.md

### Approach

New batch mutating verb `keeper plan assign-cells <epic_id> --file -`: reads a YAML cell set (per-task `{task_id, tier, model, rationale?, confidence?, label_source}` plus a `selection:` provenance block), asserts everything, mutates all task JSONs, writes the selection sidecar, and lands both in ONE auto-commit. Batch-only by contract — no single-task form, ever; this is what keeps it outside the removed `task set-tier` incremental-verb class. The behavioral contract:

- Validation (assert-all, collect-all): tier/model membership against `configuredEfforts()`/`configuredModels()`; the cell set must cover every `todo` task of the epic exactly once (full-set contract — choosing the default is an explicit cell); unknown, duplicate, or missing task ids and cells targeting non-`todo` tasks all reject the whole batch under a new typed `cell_invalid` code slotted into the standard failure-priority chain, with a recovery entry. No partial writes on any failure.
- Mutation inside the epic flock region returning the {kind} sentinel so emit/restamp run outside the lock; joins the canonical restamp-verbs list so `last_validated_at` re-stamps after the post-write integrity check.
- Sidecar: schema-versioned JSON at `.keeper/state/selections/<epic_id>.json` — fields: schema_version, epic_id, created_at (via the store clock seam), selector {harness, model}, config_hash, input_hash, shuffle_seed (nullable), outcome (`completed` or `degraded:<reason>`), verdict_raw (the selector's message text, nullable on degrade), cells (the applied set with rationale/confidence/label_source per task). Written with the touched-path-recording atomic-write helper so it lands INSIDE the same auto-commit as the cell writes — this is the deliberate divergence from the briefs precedent, which stays out of commits. Re-runs on todo tasks are legal and REPLACE the sidecar (idempotent re-select, no append).
- Degrade support: an invocation whose cells all equal the current stamped values is valid and still writes the sidecar (the orchestrator's failure path calls the verb with defaults + `label_source: heuristic-default` + a degraded outcome so failures are captured as data).
- The verb never reads model-selector.yaml — axis validation comes from the embedded subagents matrix only, keeping the guidance config off the verb/embed path.

Emit one success envelope via the standard mutating-emit seam; typed failures via the standard failure-envelope seam. Sidecar lives under `.keeper/state/` (pure producer artifact, sibling of briefs/) — NEVER under `.keeper/epics|tasks/`, which the daemon plan worker folds.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/src/verbs/refine_apply.ts:315-352 — the tier/model membership-validation seam to mirror (accumulated tierErrors/modelErrors)
- plugins/plan/src/verbs/refine_apply.ts:768-779 — restampEpicOrFail post-write gate; the end-to-end verb shape (YAML read, priority-ordered failure codes, flock sentinel) throughout this file is THE exemplar
- plugins/plan/src/validation_restamp.ts:28 — VALIDATION_RESTAMP_VERBS canonical membership list
- plugins/plan/src/store.ts — atomicWriteJson (records touched-path for the auto-commit) vs plugins/plan/src/brief.ts (atomicWriteRaw, deliberately commit-bypassing; understand the divergence)
- plugins/plan/src/cli.ts:890-908 — dispatch switch + readPositionalSkipping/readOption arg pattern; verb metadata list ~:150-200 needs the new entry
- plugins/plan/test/saga-refine-apply.test.ts + plugins/plan/test/harness.ts — withProject/runCli/firstJsonPayload conformance-suite pattern

**Optional** (reference as needed):
- plugins/plan/src/models.ts:136-145 — configuredEfforts/configuredModels
- plugins/plan/src/yaml_input.ts — readYamlBytes/parseYamlInput/YamlInputError
- plugins/plan/src/emit.ts — emitMutating/emitFailureEnvelope/recoveryForPlanCode
- docs/problem-codes.md — keyed-recovery registry shape for the cell_invalid entry

### Risks

- Sidecar and cell writes must be one commit — using the wrong write helper silently drops the sidecar from the auto-commit; test asserts both paths appear in the same commit's tree
- The full-set + todo-only contract must hold under a concurrently-claimed task (flock region re-reads task state inside the lock before mutating)

### Test notes

saga-assign-cells.test.ts in the fast in-process tier: happy path (cells overwritten + sidecar present + single envelope + restamp), every cell_invalid variant (unknown id, duplicate, missing coverage, non-todo target, out-of-axis tier/model), degrade-shape invocation (identical cells, sidecar records degraded outcome), re-run replaces sidecar. Real-git auto-commit assertions belong behind the slow gate only if the fake-VCS seam cannot express same-commit membership.

## Acceptance

- [ ] `keeper plan assign-cells <epic> --file -` batch-overwrites tier/model on every todo task of a ghost epic and lands cells plus a selection sidecar in one auto-commit, emitting exactly one JSON envelope
- [ ] The verb rejects — with a typed, recovery-carrying `cell_invalid` failure and zero writes — any cell set with an unknown, duplicate, or missing task id, a non-todo target, or an out-of-axis tier/model
- [ ] A degrade-shaped invocation (cells equal to current values, degraded outcome) succeeds and records `label_source: heuristic-default` provenance in the sidecar; a re-run replaces the sidecar rather than appending
- [ ] The epic's validation marker is re-stamped after a successful assign-cells, and the verb appears in the canonical restamp-verb list and the problem-codes registry
- [ ] The fast plan suite passes with the new saga conformance tests included

## Done summary
Added the keeper plan assign-cells batch verb: overwrites tier/model on every todo task of a ghost epic (assert-all validation with a typed cell_invalid code + restamp) and writes a schema-versioned, git-committed selection sidecar at .keeper/selections/<epic>.json, both landing in one auto-commit.
## Evidence
