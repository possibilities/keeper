## Overview

Model routing has blind spots today: the model-guidance skill cannot tell hand-authored stub guidance from researched guidance (the parity gate checks bytes, not provenance), its blank invocation means "refresh everything", and two task-creating paths — close follow-ups and plan refines — never run the content-blind cell selector at all; the close-planner's own template cannot even emit a scaffold-valid task. End state: a fail-closed `--state` classifier drives a ≤2-question scope flow in the skill; every task-creating path births or assigns selector-chosen {tier, model} cells with a committed provenance sidecar; close follow-ups pre-select against the stored follow-up plan so cells precede arming with no dispatch race.

## Quick commands

- `bun plugins/plan/scripts/model-guidance-check.ts --state | jq .` — per-value guidance states
- `cd plugins/plan && bun test` — fast suite (drift gate, consistency pins, saga tests)

## Acceptance

- [ ] `--state` classifies every configured axis value fail-closed; `--check` behavior unchanged; drift gate green
- [ ] model-guidance derives its scope from detected state via at most two questions; blank arg is interactive; wipe always confirms; no flow requires typing a model name
- [ ] Close follow-ups mint tasks born with selector-chosen cells, or template defaults plus a degraded sidecar when selection fails; arming is never blocked by selection
- [ ] Plan refines re-select remaining todo cells before re-arming; zero-todo refines skip cleanly
- [ ] The close-planner template emits scaffold-valid tasks (tier and model, full enums), pinned by a consistency test

## Early proof point

Task that proves the approach: ordinal 4 (stored-followup brief + finalize verdict input). If the stored-document brief proves unworkable, fall back to a post-finalize best-effort selection upgrade in the close skill (verb untouched) and re-scope the close-skill task accordingly.

## References

- docs/adr/0006-validation-marker-arm-exclusive-latch.md — the arm-seam contract the finalize changes must respect
- `fn-1126-launcher-worker-cell-resolver` (dependency) — its launch-time resolver is what makes assigned cells honored on manual dispatch; this epic populates the cells it reads
- `fn-1133-arm-exclusive-validation-marker-latch` (dependency + overlap) — owns the arm-exclusivity contract the finalize seam sits on; also edits skills/plan/SKILL.md in a different section, so the refine-beat task stacks on its landed text
- skills/defer/SKILL.md Phase 4b — the canonical selection-beat prose the close and refine copies mirror
- Post-epic action (interactive, not a task): run /plan:model-guidance in fill-gaps scope with the human present — real sonnet web research with URL sources, re-distill both model blocks' comparative when-to-pick language, efforts review + stamp

## Docs gaps

- **plugins/plan/README.md**: /plan:model-guidance and /plan:close rows plus selection-brief / close-finalize verb prose (rides the skill-rewrite and close-beat tasks)
- **docs/plugin-composition-map.md**: the model-selector.yaml note broadens (efforts provenance, --state mode)
- **CONTEXT.md**: the "Tier" glossary entry blurs the effort-vs-model two-axis split — sharpen opportunistically (non-blocking)

## Best practices

- **Fail-closed totality:** every provenance input maps to exactly one state with no throw path; fresh requires positive evidence (exact status enum plus hash parity) [RFC 9111 / Saltzer-Schroeder fail-safe defaults]
- **String-strict provenance parsing:** YAML 1.1 coercions (the Norway problem, date coercion) classify as stub, never as fresh; parse only the first comment block, not byte-0-anchored [gray-matter / YAML prior art]
- **Destructive scope UX:** wipe is never a default or a multiSelect row; non-interactive contexts never fail open into a wipe [clig.dev]
- **Untrusted selector output:** enum-clamp every cell against the closed axes; degrade to in-axis defaults; record degrades in the committed sidecar [OWASP deny-by-default]
