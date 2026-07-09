## Description

**Size:** S
**Files:** plugins/plan/model-selector.yaml, plugins/plan/skills/model-guidance/references/gpt-5.3-codex-spark.md, plugins/plan/skills/model-guidance/references/gpt-5.5.md, plugins/plan/test/consistency-model-selector.test.ts

### Approach

The research backfill landed before the epic retargeted from gpt-5.5 to gpt-5.3-codex-spark, so the guidance config may anchor research for the wrong model. Reconcile the config to the retargeted intent, working from whatever state the prior backfill actually left: gpt-5.3-codex-spark ends with a real researched reference file (provenance header with date and sources, strengths/weaknesses/when-to-pick, per the established per-model reference shape — author it through the model-guidance flow if absent) and a hash-anchored research entry, and its guidance block reads as trickle-posture selection advice (route only genuinely-bounded mechanical work until cell-review cohorts justify promotion). gpt-5.5 ends as a tolerated guidance-only extra: no research entry; drop its reference file if one was added by the prior pass (or leave it orphaned only if the gate tolerates unreferenced files — prefer removal for a clean references/ tree). The gate's tolerance semantics (extra research entries allowed, hash parity always enforced) are landed behavior to rely on, not to change here.

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/model-selector.yaml — the research: map and both model guidance blocks as the prior task left them (inspect actual state first; the prior backfill may have targeted gpt-5.5, spark, or both)
- plugins/plan/skills/model-guidance/references/ — which reference files exist post-backfill
- plugins/plan/scripts/model-guidance-check.ts — the landed tolerance + hash-parity behavior the reconciliation must keep green
- plugins/plan/skills/model-guidance/SKILL.md — the research→cache→distill flow for authoring the spark reference if missing

### Risks

- The guidance prose rides inside every selector prompt — keep the spark block short; raw research stays in the reference file

### Test notes

Gate green via `bun plugins/plan/scripts/model-guidance-check.ts --check` and the consistency test; extend assertions only if they pin the old target.

## Acceptance

- [ ] The guidance config anchors hash-valid research for gpt-5.3-codex-spark with a trickle-posture guidance block distilled from a provenance-headed reference, and carries no research entry for gpt-5.5
- [ ] The model-guidance drift gate and the plan fast suite pass

## Done summary

## Evidence
