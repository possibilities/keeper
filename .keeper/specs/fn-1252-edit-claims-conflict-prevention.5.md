## Description

**Size:** M
**Files:** plugins/plan/skills/plan/SKILL.md, plugins/plan/template/agents/repo-scout.md.tmpl, plugins/plan/template/agents/epic-scout.md.tmpl, plugins/plan/template/agents/gap-analyst.md.tmpl, the rendered agent leaves (regenerated), plugins/prompt/test/oracle/fixtures/render-plugin-templates.json (regenerated), plugins/plan/README.md, plugins/plan/CLAUDE.md

### Approach

Bring every authoring and advice surface into lockstep with the mechanical reality
the prior tasks built — no surface may still state the uniform overlap-to-edge rule
or instruct hand-authoring the Files: line. Plan SKILL.md: Phase 5d/5e author
edit_claims in the scaffold YAML (kind and certainty semantics, canonical resource
tokens for known singletons — schema-ladder foremost — and claim-narrowness
guidance), drop the hand-authored Files: template line (derived now), restate the 5f
rule as gate-enforced with --allow-overlap as the deliberate escape, and rebuild
Phase 6 around the tiered model: run overlap-sweep post-scaffold, wire hard hits via
epic add-deps, fold soft hits into References, replacing the same-session-sibling
eyeball rule. epic-scout template: extract write targets from structured claims
(falling back to prose Files: for legacy epics), and tier its Overlaps bucket into
hard/soft so the planner's wiring follows the tier. repo-scout template: add a
"Likely Write Surface" partition (path + evidence + confidence, confidence mapping
to expected/possible) distinct from read-oriented investigation targets, so the
planner seeds claims from verified scout output. gap-analyst template: update the
inter-epic-overlap rule in lockstep with the tiered model. Edit .tmpl sources only,
regenerate the rendered leaves and the golden fixture; forward-facing prose
throughout (state the system as it is — no "formerly" narration). Worker-facing
templates keep consuming the Files: line (it still renders) — touch them only if
their wording asserts hand-authorship.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/skills/plan/SKILL.md:376, :442, :543-577 — the three rule sites being rebuilt (5d files bullet, 5f hard rule, Phase 6 wiring + sibling eyeball rule)
- plugins/plan/template/agents/epic-scout.md.tmpl and repo-scout.md.tmpl and gap-analyst.md.tmpl — the source templates (the rendered .md leaves are managed; never hand-edit)
- plugins/prompt — the render/bake pipeline and its check_generated gate; how render-plugin-templates.json regenerates

**Optional** (reference as needed):
- plugins/plan/template/_partials/worker-implement-native.md — worker Files: consumption wording (verify current state; this file was dirty from prior epic work at plan time)
- plugins/plan/test/ consistency tests that pin skill/agent text

### Risks

- The fixture and worker partials carried uncommitted prior-epic edits at plan time — verify current tree state before regenerating; regeneration must reflect landed sources, not clobber in-flight work
- Consistency/bake tests pin rendered text — regenerate leaf + fixture in the same change or the gate goes red

### Test notes

check_generated / bake gates green after regeneration; a grep over plugins/plan for
the retired rule phrasings ("share even one path MUST", hand-authored Files:
instructions, unconditional overlap wiring) returns only historical docs (ADRs).

## Acceptance

- [ ] The plan skill instructs authoring edit_claims (kinds, certainty, canonical resource tokens) and no longer instructs hand-authoring a Files: line
- [ ] Phase 6 guidance runs the overlap sweep and wires hard hits as epic deps while folding soft hits into References; the same-session eyeball rule is replaced by the sweep
- [ ] epic-scout, repo-scout, and gap-analyst templates carry the tiered model consistently; repo-scout's report gains the Likely Write Surface partition
- [ ] Rendered leaves and the golden fixture are regenerated in the same change; template/bake/consistency gates are green
- [ ] No plan-plugin guidance surface still states the uniform overlap-to-edge rule

## Done summary

## Evidence
