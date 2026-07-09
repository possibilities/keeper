## Description

**Size:** M
**Files:** plugins/plan/src/verbs/apply_selection.ts, plugins/plan/src/verbs/assign_cells.ts, plugins/plan/src/verbs/selection_brief.ts, plugins/plan/src/descriptor.ts, plugins/plan/src/cli.ts, plugins/plan/src/integrity_gate.ts, plugins/plan/test/saga-apply-selection.test.ts, plugins/plan/test/cli-help.test.ts, docs/problem-codes.md

### Approach

`keeper plan apply-selection <epic_id> [--from-followup] [--degraded <reason>] --file -` becomes the one trusted apply seam for selector verdicts (ADR 0027). Guided mode reads the selector's raw JSON from stdin (JSON.parse, strict; tolerate exactly one optional fenced ```json block wrapper so skills can pipe the Task return verbatim; reuse the 1 MiB byte-cap + TTY-rejection discipline of the existing stdin readers), locates the epic's brief under `.keeper/state/selections/<epic_id>/` (`brief.json`, or `followup-brief.json` when `--from-followup` is passed; assert the in-file `from_followup` flag matches the invocation and fail `brief_missing` on absence or mismatch), then validates in layers, collect-all: shape (a `cells:` list of `{task_id, tier, model, rationale?, confidence?}`, unknown top-level keys rejected — an error-shaped `{"error": ...}` return fails shape validation), enum-clamp against the brief's `candidate_cells`, and exact coverage of the brief's `task_ids` (live) or ordinals `1..N` (follow-up).

Live branch: land through a shared core extracted from assign_cells — flock with the IN-LOCK todo-status re-read (a concurrently claimed task still rejects the batch), live configuredEfforts/Models check as the final axis gate (a brief-vs-live divergence surfaces as `cell_invalid`), cell mutate + `audit_required` stamp, committed selection sidecar, integrity gate, `emitMutating` auto-commit. `assign-cells` stays a public verb and routes through the same core — extract, never duplicate and never have one verb shell out to the other. apply-selection joins `INTEGRITY_GATE_VERBS`.

Follow-up branch: assemble and atomically write `followup-verdict.json` (gitignored sibling of the brief) in exactly the shape `loadSelectionVerdict` consumes — `{schema_version, cells: {"<ordinal>": {tier, model, rationale, confidence}}, selection: {...}}` — and self-emit a commit-free payload envelope carrying the staged absolute path as `verdict_path` (the close skill threads it to `close-finalize --selection-verdict`). The two branches keep their DIFFERENT emit paths: mutating auto-commit envelope (live) vs commit-free payload (follow-up); close-finalize's contract is untouched.

Provenance is synthesized by the verb, never transcribed from the model: `harness: subagent`, `model: plan:model-selector`, `config_hash`/`input_hash`/`shuffle_seed` pinned from the on-disk brief, `outcome: completed`, `verdict_raw` = the raw stdin text, `label_source: heuristic-guided` on every guided cell.

`--degraded <reason>` is live-only (reject the flag combined with `--from-followup`): no stdin read, enumerate the CURRENT todo set under the flock, re-assert each task's existing stamped cell (no second hardcode of the scaffold default), `label_source: heuristic-default`, `outcome: degraded:<reason>`, hashes pinned from the brief when one exists on disk else the literal sentinel `unavailable` (preserves the sidecar's non-empty invariant), `shuffle_seed`/`verdict_raw` null. Degraded mode must leave the board armable: it exits 0 whenever the sidecar write lands, and its failure modes never leave task JSONs half-written.

Failure envelopes use the collect-all details-array discipline so callers can relay them as VALIDATION_ERRORS: `verdict_invalid` (unparseable stdin, wrong shape, unknown keys, error-shaped return), `brief_missing` (guided invocation with no or mismatched brief), `cell_invalid` (axis/membership/coverage, from the shared core), plus the standard `epic_not_found`. Register the new codes in docs/problem-codes.md in this same change and revise the cell_invalid row's verb attribution.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/src/verbs/assign_cells.ts:1-33 — the batch/full-set/todo-only contract and bad_yaml/cell_invalid priority discipline; :300-412 the flock body to extract (in-lock todo re-read, mutate, sidecar); :414-455 the integrity-gate + emit tail
- plugins/plan/src/verbs/close_finalize.ts:861-1000 — loadSelectionVerdict and parseSelectionProvenance: the exact verdict-document shape and fail-closed constraints the follow-up branch must satisfy
- plugins/plan/src/verbs/selection_brief.ts:116-124 — module-private selectionBriefPath (export it or add a shared path helper); :307-356 the brief fields (from_followup, candidate_cells, hashes, task_ids)
- plugins/plan/src/descriptor.ts:342-350 — the assign-cells PLAN_COMMANDS entry to mirror; registration order is alphabetical and cli.ts value-parses flags separately
- plugins/plan/src/integrity_gate.ts:31-43 — INTEGRITY_GATE_VERBS canonical list
- plugins/plan/test/cli-help.test.ts:29,90 — EXPECTED_TOP_LEVEL pins the verb list; every descriptor verb gets an auto leaf-help render test

**Optional** (reference as needed):
- plugins/plan/src/verbs/selection_review_submit.ts — closest stdin-validating write-a-file sibling (validate-against-brief, single failure code, schema-versioned write)
- plugins/plan/src/submit_common.ts:76 readPayloadCapped and src/yaml_input.ts:64 readYamlBytes — the byte-cap/TTY stdin discipline to reuse (JSON path wants the plain-text reader, not the YAML one)
- plugins/plan/test/saga-assign-cells.test.ts — harness patterns: runCli with input, withProject, scaffoldEpic, firstJsonPayload
- plugins/plan/agents/model-selector.md:55-81 — the selector output contract the stdin parser accepts

### Risks

- The two branches have deliberately different emit paths (mutating auto-commit vs commit-free payload); forcing one envelope shape onto both breaks either the commit contract or the single-JSON conformance guard.
- Hoisting the todo-status check out of the flock silently overwrites a concurrently claimed task's cell — the in-lock re-read is the core's guarantee, keep it there.
- The extraction must leave assign-cells byte-identical in behavior (its saga suite is the regression net).

### Test notes

New saga-apply-selection.test.ts (in-process harness, fake VCS, stdin via runCli input): guided live apply (cells land, sidecar provenance brief-pinned, auto-commit fires), guided follow-up apply (the staged file round-trips through a real in-process close-finalize call — follow-up tasks born with the selected cells), --degraded with and without a brief on disk, verdict_invalid/brief_missing/cell_invalid collect-all envelopes, fenced-block stripping, in-lock non-todo rejection, --degraded+--from-followup rejection. cli-help EXPECTED_TOP_LEVEL gains the verb (alphabetical). Existing saga-assign-cells suite stays green unmodified except for any import-path fallout from the core extraction.

## Acceptance

- [ ] `keeper plan apply-selection --help` exits 0 and documents the epic-id positional plus --file, --from-followup, and --degraded (live-only)
- [ ] Piping a valid selector verdict for a live epic overwrites every todo task's tier/model, writes a committed selection sidecar with brief-pinned hashes and label_source heuristic-guided, and auto-commits — the same board effect as the equivalent assign-cells batch
- [ ] Piping a valid ordinal verdict with --from-followup stages a verdict document that close-finalize --selection-verdict consumes without degrading, so follow-up tasks are born with the selected cells
- [ ] --degraded <reason> exits 0 with no stdin, re-asserts each todo task's current stamped cell, and writes a degraded:<reason> sidecar with label_source heuristic-default, whether or not a brief exists on disk
- [ ] An unparseable, error-shaped, unknown-key, out-of-axis, or coverage-violating verdict exits 1 with one structured failure envelope (verdict_invalid, brief_missing, or cell_invalid) whose details name every violation in one pass
- [ ] assign-cells and apply-selection route through one shared core with no duplicated flock/mutate/sidecar logic, apply-selection is an INTEGRITY_GATE_VERBS member, and the plan plugin fast suite is green
- [ ] docs/problem-codes.md registers the new codes in this same change

## Done summary
Added the apply-selection verb: validates a model-selector verdict against the on-disk brief, lands cells live through a core shared with assign-cells, or stages a follow-up verdict document close-finalize consumes. Provenance pinned from the brief; new verdict_invalid/brief_missing codes registered.
## Evidence
