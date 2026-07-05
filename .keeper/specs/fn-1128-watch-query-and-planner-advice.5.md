## Description

**Size:** S
**Files:** plugins/keeper/skills/query/SKILL.md, plugins/keeper/skills/watch/SKILL.md, plugins/keeper/skills/autopilot/SKILL.md, plugins/plan/skills/hack/SKILL.md, plugins/plan/skills/plan/SKILL.md, plugins/plan/skills/plan/references/operator-orchestration.md

### Approach

Fan-in verification and wording-consistency sweep after the four authoring tasks land. Run the full gates: `bun run test:full` (root incl. skill-id and retired-name lints, plan, python, prompt suites) and `bun scripts/vendor-corpus.ts --check`. Then a cross-surface audit, fixing wording-only drift: (1) the three manual-piloting surfaces (hack preamble clause, plan-side etiquette bullet, watch pilot rung) all reference the autopilot take-over window and never fork its wording; (2) blocked-worker mechanics are single-sourced in the operator-orchestration reference with reference-shaped mentions elsewhere, and both caveats (TOOLING_FAILURE silence; creator-edge durability) appear at every site that teaches the handshake (hack, plan reference, watch rung 2); (3) the NOT-for boundary web is mutually consistent — watch↔autopilot reciprocal exclusions, query's exclusions against hack/debug/autopilot, and dispatch/handoff correctly named where referenced; (4) render-cite inventory unchanged outside watch/query's two POINTER refs, and hack's six BAKE guards intact; (5) no retired vocabulary, forward-facing prose everywhere. If the audit finds a contradiction that wording-only edits cannot fix, escalate BLOCKED: DESIGN_CONFLICT naming the two surfaces rather than silently picking one.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- The six files in the Files list, as landed by the four upstream tasks
- plugins/plan/CLAUDE.md — the never-fork-wording and forward-facing doc discipline this sweep enforces
- test/lint-retired-name.test.ts — the banned-vocabulary gate

**Optional** (reference as needed):
- docs/skill-authoring.md — the authoring method the audit checks against

### Risks

- None structural — this task edits wording only; genuine contradictions escalate instead of being papered over.

### Test notes

`bun run test:full`; `bun scripts/vendor-corpus.ts --check` — both green on the final tree, re-run after any fix.

## Acceptance

- [ ] `bun run test:full` and the vendored-corpus drift check are green on the final tree
- [ ] The consistency audit is documented in the Done summary: piloting surfaces reference-not-restate, blocked mechanics single-sourced with both caveats present at every teaching site, the NOT-for web mutually consistent, render-cite and BAKE-guard inventories unchanged
- [ ] Any wording drift found is fixed and the affected gates re-run green

## Done summary

## Evidence
