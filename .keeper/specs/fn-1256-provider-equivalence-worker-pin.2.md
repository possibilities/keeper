## Description

**Size:** S
**Files:** plugins/plan/skills/model-guidance/SKILL.md, plugins/plan/CLAUDE.md, plugins/plan/README.md

### Approach

Fold the equivalence map into /model-guidance's ownership, revising scope statements rather
than bolting on paragraphs. The skill's research pass gains an equivalence step: after
distilling a model's guidance block, author/refresh its equivalence entries in BOTH
directions, flagging only genuinely contested cells (several defensible targets) for the
human. The argument contract and --state-driven interactive flow classify equivalence gaps
alongside notes/card gaps (a matrix axis change surfaces new unmapped cells as gaps the flow
offers to fill). State the alias re-point rule: a re-pointed launch id stales the affected
equivalence entries exactly as it stales the notes. Update plugins/plan/CLAUDE.md's
drift-gate row and README's model-guidance row to name both artifacts. Forward-facing prose
only — describe present behavior, no provenance narration.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/skills/model-guidance/SKILL.md — the full flow being extended (state envelope, argument contract, research pass, status-stamp discipline, commit rules)
- plugins/plan/provider-equivalence.yaml + plugins/plan/src/provider_equivalence.ts (from task .1) — the artifact and states the skill drives

**Optional** (reference as needed):
- plugins/plan/CLAUDE.md — Model-guidance drift gate table row
- plugins/plan/README.md — model-guidance skill row

### Risks

- SKILL.md consistency tests may pin phrasing (the hand_tuned reconciliation note names a consistency test) — run the plan suite after edits

### Test notes

Doc-shaped task: `bun plugins/plan/scripts/model-guidance-check.ts --check` and the plan
fast suite green; no runtime surface.

## Acceptance

- [ ] The skill's scope, when-to-invoke, state-envelope, and pass sections cover the equivalence map in both directions, including the contested-cell flag and the alias re-point staleness rule
- [ ] plugins/plan/CLAUDE.md and README name the second gated artifact accurately in one line each
- [ ] Plan suite green

## Done summary
Fold the provider-equivalence map into model-guidance's ownership: scope statement, when-to-invoke, state envelope, and research pass now cover both-direction equivalence authoring, contested-cell flagging, and alias re-point staleness; CLAUDE.md and README name both gated artifacts.
## Evidence
