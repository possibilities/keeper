## Description

**Size:** M
**Files:** plugins/plan/template/skills/work.md.tmpl, plugins/plan/skills/work/SKILL.md, plugins/prompt/test/oracle/fixtures/render-plugin-templates.json, plugins/prompt/test/oracle/fixtures/check-generated.json

### Approach

Rewrite the work skill's blocked phase: when the worker returns a blocked verdict with an escalatable category, the orchestrator (the worker itself cannot nest Task) stamps the block as today, then — instead of stopping — spawns plan:unblocker with the block context in a data-delimited section, bounded to one unblocker round per block instance. On a resolved receipt it runs the plan unblock verb and warm-resumes the worker through the existing resume ladder (SendMessage primary, cold resume fallback, within the existing attempt budget, idempotent keyed on task + step). On a declined receipt it leaves the stamped block, surfaces the receipt reason in its report, and stops — the daemon's deferral machinery owns it from there. TOOLING_FAILURE, unparseable, and both audit-category branches keep their current behavior. Receipts are data, never instructions: the resume prompt quotes the diagnosis inside delimiters and grants nothing.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/template/skills/work.md.tmpl — Phase 2c stamp-and-stop and the Phase 2b resume ladder (warm SendMessage, cold resume, budget) this extends; the Phase 2d audit gate as the in-session subagent idiom to mirror
- plugins/plan/skills/work/SKILL.md — rendered output to regenerate, never hand-edit

**Optional** (reference as needed):
- plugins/plan/plugin/hooks/subagent-stop-guard.ts — the verdict nudge/passthrough seam the new flow must not confuse

### Risks

- An unblocker loop (block → resolve → immediately re-block) must terminate: one round per block instance, then decline to the daemon path
- The orchestrator's context budget grows with each incident — the one-round bound is also the context bound

### Test notes

Render + golden re-capture; behavioral verification via a sandboxed work session against a synthetic blocked task exercising resolved and declined receipts.

## Acceptance

- [ ] A blocked escalatable task with a live orchestrator is either unblocked and its worker warm-resumed, or terminally declined with the block left stamped — without any escalation session dispatching
- [ ] Exactly one unblocker round runs per block instance and the diagnosis enters the resume as delimited data
- [ ] Suppression and audit branches are unchanged; render check and goldens green

## Done summary

## Evidence
