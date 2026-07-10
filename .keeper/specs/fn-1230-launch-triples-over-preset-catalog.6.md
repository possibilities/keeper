## Description

**Size:** M
**Files:** plugins/keeper/skills/pair/SKILL.md, plugins/keeper/skills/dispatch/SKILL.md, plugins/plan/skills/panel/SKILL.md, plugins/plan/skills/panel/references/panel.md, plugins/plan/skills/hack/SKILL.md, plugins/plan/agents/panel-runner.md, plugins/plan/agents/panel-judge.md, plugins/plan/skills/model-guidance/references/gpt-5.3-codex-spark.md, plugins/prompt/corpus/claude/arthack/template/_partials/snippets/engineering/panel-strength.md.tmpl, plugins/prompt/corpus/claude/arthack/template/_partials/snippets/_index.yaml, plugins/plan/template/_partials/worker-implement-wrapped.md, docs/install.md, docs/plugin-composition-map.md, plugins/plan/README.md

### Approach

Rewrite every prose surface to teach the triple grammar, forward-facing only (no catalog history, no past-tense provenance — that lives in ADR 0033 and commits). The pair skill's partner-selection table teaches: compose a triple directly when harness+model+effort are known, or run the presets list to discover native ids and effective effort ranges; the panel reference's worked example becomes matrix.yaml + triple-membered panel.yaml; runner/judge agents attribute by triple + ordinal with updated example labels; the panel-strength snippet is edited at its corpus source and re-vendored so the panel and hack SKILL bake regions regenerate rather than being hand-edited; the index summary/tags follow the snippet. The wrapped-worker partial reads the reshaped providers-resolve envelope. Docs walkthroughs (install, composition map, plan README, model-guidance codex reference) describe overrides, route flag, slimmed presets.yaml, and the doctor's triple lint. Verify with the vendor drift check and the full prose-affecting test tier.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/keeper/skills/pair/SKILL.md:16,80-81,115-120,212-214 — every preset-catalog reference
- plugins/plan/skills/panel/references/panel.md:26-70 — the worked two-file example to rewrite
- plugins/plan/agents/panel-runner.md:82-103 and panel-judge.md:20,33 — member resolution + attribution labels
- plugins/prompt/corpus/.../snippets/engineering/panel-strength.md.tmpl + _index.yaml:290,296 — snippet source + coupled index; re-vendor via bun scripts/vendor-corpus.ts (check mode gates drift)
- plugins/plan/template/_partials/worker-implement-wrapped.md:13 — consumes the providers-resolve envelope reshaped in the grammar task

**Optional** (reference as needed):
- docs/install.md:60-82, docs/plugin-composition-map.md:87-126, plugins/plan/README.md:164-170
- plugins/keeper/skills/dispatch/SKILL.md:79-81 — preset row + worker-key wording

### Risks

- The hack and panel SKILL bake regions regenerate from the snippet — hand-editing them instead of the source re-drifts on the next vendor pass
- fn-1229 also edits a different corpus snippet: re-vendor from a merged tree, not a stale checkout

### Test notes

bun scripts/vendor-corpus.ts --check green; plugins/plan and plugins/prompt suites green (consistency + parity goldens); grep the swept surfaces for the retired vocabulary (catalog preset names, presets.yaml presets block) and assert only ADR/commit history retains it.

## Acceptance

- [ ] Every skill, agent, snippet, and doc surface describes launch selection exclusively in triple grammar, with the pair skill teaching both compose-directly and enumerate-then-pick flows
- [ ] The panel-strength snippet edit re-bakes both consuming SKILL files through the vendor pipeline with its drift check green
- [ ] The wrapped-worker partial's instructions match the reshaped providers-resolve envelope
- [ ] No prose outside docs/adr and commit history references the named preset catalog

## Done summary

## Evidence
