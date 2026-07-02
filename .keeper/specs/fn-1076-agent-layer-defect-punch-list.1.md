## Description

**Size:** M
**Files:** plugins/plan/skills/{defer,plan,hack}/SKILL.md, plugins/plan/agents/{close-planner,epic-scout,docs-gap-scout}.md, plugins/plan/template/agents/practice-scout.md.tmpl, plugins/plan/plugin/hooks/subagent-stop-guard.ts

### Approach

Mechanical corrections against the CLI as source of truth. Collapse the three divergent
scaffold error-code lists (plan/SKILL.md:523, defer/SKILL.md:170, close-planner.md:204) to one
statement that cites `keeper plan scaffold --agent-help` and enumerates only codes the code
emits — the phantom ref_invalid dies. Drop the phantom `reason` field from plan/SKILL.md:553
(epic_add_deps.ts:151-170 emits {dep_id,status}; the SKIPPED_* status values are the signal).
Model-ref sweep: replace the pinned claude-sonnet-4-6 in epic-scout.md:4, docs-gap-scout.md:4,
practice-scout.md.tmpl:4 with the current scout model choice (verify against subagents.yaml
conventions — scouts may simply say opus or inherit); fix "the Opus 4.7 default" at
plan/SKILL.md:375 to name the behavior not the model generation; de-hardcode the panel pair at
hack/SKILL.md:86 ("Opus 4.8 + GPT-5.5") to describe the config-driven panel (panel.yaml)
illustratively. Standardize plan:* citation style to the slashed form used everywhere else.
Fix the subagent-stop-guard.ts:41 comment misattribution (nudges are the worker Phase 2b's,
not work.md.tmpl's). Where a disable-model-invocation denial can carry text keeper controls,
make the denial/description name the slash redirect (e.g. "use /plan:close"); where the text
is harness-owned, add the redirect line to the skill description instead. Re-render generated
outputs after template edits.

### Investigation targets

**Required** (read before coding):
- The scaffold error-code emitter in plugins/plan/src (verify the canonical list)
- plugins/plan/src/verbs/epic_add_deps.ts:151-170
- plugins/plan/subagents.yaml — the models axis, for scout model wording

### Risks

- Some corrections touch generated files — edit the .tmpl source and re-render, never the output.

### Test notes

grep-verifiable: ref_invalid, claude-sonnet-4-6, "Opus 4.7" all zero; plan suite green.

## Acceptance

- [ ] One error-code statement, no phantom codes or fields anywhere in plan skills/agents
- [ ] Model refs current and config-driven in wording; citation style consistent
- [ ] Comment misattribution fixed; renders regenerated

## Done summary
Swept plan-plugin skills/agents/hook: collapsed the three scaffold error-code lists to the real emitter set (killed phantom ref_invalid), dropped the phantom {dep_id,status,reason} field to {dep_id,status}, de-pinned scout model to opus, de-hardcoded the panel model pair to config-driven wording, and fixed the subagent-stop-guard nudge attribution.
## Evidence
