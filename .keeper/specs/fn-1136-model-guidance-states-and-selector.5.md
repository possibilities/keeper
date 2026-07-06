## Description

**Size:** S
**Files:** plugins/plan/skills/close/SKILL.md, plugins/plan/README.md, plugins/plan/test/consistency-skills.test.ts

### Approach

Orchestrate the pre-select beat in the close skill between followup submit and finalize: run the stored-followup selection brief, spawn plan:model-selector blind (BRIEF_REF only, no model= kwarg, no spec prose in the prompt), validate the verdict (enum-clamp against the envelope's candidate_cells; exact ordinal coverage), and hand the verdict file to close-finalize. One repair retry with a VALIDATION_ERRORS block on the first failure, then degrade: call finalize WITHOUT a verdict — the verb writes the degraded sidecar — so the beat can never block or fail the close. Mirror the defer Phase 4b prose contract for the beat's wording. The consistency suite forbids a specific literal word in this skill file — check the forbidden-needle test and phrase around it. Extend the consistency selector-beat pin so the close copy cannot drift silently (pin the brief invocation, the blind spawn, and the degrade wording), and update the /plan:close README row to narrate the interposed beat.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/skills/close/SKILL.md:19,146-159 — the finalize saga phase to interpose
- plugins/plan/skills/defer/SKILL.md:173-214 — the Phase 4b copy-source for beat prose
- plugins/plan/test/consistency-skills.test.ts:235-253,301-337 — the selector-beat pin list to extend, the blind-spawn assertions, and the forbidden-needle check on this file

**Optional** (reference as needed):
- plugins/plan/README.md:170 — the /plan:close row

### Risks

- The close flow runs unattended — the degrade path must be the default posture on ANY ambiguity, never a retry loop.

### Test notes

Extend the selector-handoff consistency test surface list; assert the close skill's beat carries the blind-spawn and degrade invariants.

## Acceptance

- [ ] The close skill runs the stored-followup selection beat between submit and finalize, spawns the selector blind, and degrades to a verdict-less finalize after one repair retry — the close outcome never blocks on selection
- [ ] The consistency suite pins the close beat copy and stays green, including the existing forbidden-literal check
- [ ] The README close row narrates the interposed beat

## Done summary

## Evidence
