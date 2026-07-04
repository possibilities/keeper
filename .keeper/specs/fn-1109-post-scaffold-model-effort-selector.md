## Overview

Per-task effort+model selection moves out of the planner's inline scaffold-time choice into a dedicated selector agent that runs after scaffold, inside the ghost window. The planner stamps a mechanical default (xhigh/opus); a detached `keeper agent run` selector leg — driven by researched guidance in a repo-committed `plugins/plan/model-selector.yaml` — overwrites the cells via a new batch verb `keeper plan assign-cells`, which also writes a git-committed selection sidecar capturing everything the selector saw and set. Transitional by design: heuristic-guided strong-model selection generating a durable dataset (label_source-tagged, hash-anchored) until historical usage data can replace the heuristics.

## Quick commands

- `bun test` in `plugins/plan/` — fast suite including saga-assign-cells + the model-selector coverage/hash gate
- `cd $(mktemp -d) && keeper plan init && keeper plan scaffold --file - <<<'<minimal 2-task yaml>' && keeper plan assign-cells <epic> --file - <<<'<cell yaml>'` — verb round-trip: cells overwritten, sidecar committed at `.keeper/state/selections/<epic>.json`
- `bun plugins/plan/scripts/model-guidance-check.ts --check` — config↔axes coverage + research-cache hash parity

## Acceptance

- [ ] A scaffolded epic's tiers/models can be batch-overwritten during the ghost window by `keeper plan assign-cells`, with cells validated against the subagents.yaml axes and the write landing in one auto-commit together with a selection sidecar
- [ ] `/plan:plan` and `/plan:defer` stamp mechanical default cells at scaffold and run the selector beat before arming; every selector failure mode degrades to the defaults and the epic still arms
- [ ] `plugins/plan/model-selector.yaml` holds the selector's own {harness, model} plus per-effort and per-model guidance, owned by the `model-guidance` skill with its research cache committed under the skill's references/
- [ ] A drift gate asserts config↔axes coverage and config↔research-cache hash parity in the fast test suite
- [ ] Every selector run (success or degrade) leaves a schema-versioned, provenance-anchored sidecar recoverable via git for offline analysis

## Early proof point

Task that proves the approach: ordinal 1 (the assign-cells verb — the write-path contract everything else consumes). If it fails: fall back to a `set_cells` delta section on refine-apply and re-scope task 3's orchestrator prose to call refine-apply instead.

## References

- `fn-1106-keeper-domain-knowledge-layer` (overlap) — its tasks .5/.6 edit `plugins/plan/skills/plan/SKILL.md` and `plugins/plan/CLAUDE.md`, the same files task 3 here edits; sequenced behind it to avoid conflicting edits to landed text. Softer contact: shared drift-gate infrastructure conventions (`scripts/vendor-corpus.ts`).
- `keeper agent run` envelope contract: uniform 9-key JSON written atomically to `--output` on every outcome; verdict rides in `message`; branch on `outcome`, not exit code.
- Config-surface contrast: `~/.config/keeper/presets.yaml` is user-personal launch config; `model-selector.yaml` is deliberately repo-committed, skill-authored, drift-gated content (versioned provenance for the transitional dataset).
- Launcher-side worker-cell plugin resolution (manual `keeper dispatch` gap) is explicitly out of scope — deferred until fn-1103 lands.

## Docs gaps

- **plugins/plan/README.md**: add assign-cells verb entry; revise the "chosen at plan/refine time" sentences to include the select beat; extend the `.keeper/` layout tree with `state/selections/`; skill-inventory row for model-guidance
- **plugins/plan/CLAUDE.md**: Removed-verbs rationale wording; Running-Things row for the model-guidance drift gate
- **plugins/plan/subagents.yaml**: header cross-reference to model-selector.yaml so the axis source-of-truth stays singular
- **docs/problem-codes.md**: typed errors minted by assign-cells
- **docs/plugin-composition-map.md**: one-line mention of model-selector.yaml in the plan plugin's config surfaces

## Best practices

- **Position-bias counterbalancing:** shuffle candidate cell order per task and record the seed in the sidecar — first-position preference exceeds 80% in some judge models [aclanthology 2025.ijcnlp-long.18]
- **Untrusted-verdict validation:** enum-clamp model/effort to the configured axes and require the exact task-id set before any write — schema validation cannot express in-epic membership [structured-output practice]
- **Single bounded repair retry:** feed validation errors back once, then fall back to defaults; never loop [structured-output practice]
- **Hash-anchored two-layer capture:** config_hash + input_hash + label_source tags make the dataset joinable and filterable by config era for DSPy-style optimization [DSPy/MLflow tracing guidance]
- **Fail-open on selection only:** degrade skips the selection, never the validation or scrubbing around the sidecar write [AWS REL05-BP01]
