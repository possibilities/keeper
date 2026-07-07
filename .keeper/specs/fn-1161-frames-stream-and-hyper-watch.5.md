## Description

**Size:** S
**Files:** plugins/keeper/skills/autopilot/SKILL.md

### Approach

Add one named recipe — "Narrow to armed to solve a problem, then restore
yolo" — between the take-over-window section and the await-integration
section. The recipe is a problem-solving composition of mechanics the skill
already documents, cited rather than restated: capture the current
{paused, mode, armed} (the window's capture step), switch mode to armed and
arm the problem epic(s) — noting the armed set works with its transitive
upstream dep-closure per the existing mode table — drive the fix or let the
narrowed reconciler drain it, gate the restore on a keeper:await
complete/landed condition, then restore yolo and disarm. Add one worked
example in the Examples section's established voice showing a problem epic
narrowed, awaited, and the board returned to yolo. Forward-facing prose only;
no history narration; the watch skill will cite this recipe by name.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/keeper/skills/autopilot/SKILL.md:126-180 — the take-over window (capture → drive → restore) the recipe composes; :182-199 risk gradient + await integration the recipe slots between; :73-75 armed-mode dep-closure semantics to cite
- plugins/keeper/skills/autopilot/SKILL.md:213-291 — the Examples section voice to match

**Optional** (reference as needed):
- docs/skill-authoring.md — skill prose conventions

### Test notes

Prose-only change; verification is structural (section placement, citation
not restatement, example present). The board currently has zero open epics,
so the recipe cannot be integration-driven — acceptance is documentary.

## Acceptance

- [ ] The named recipe sits between the take-over-window and await-integration sections and composes capture, armed-narrowing, await-gated restore, and yolo/disarm by citing the existing sections
- [ ] One worked example in the Examples voice shows a problem epic narrowed and the board restored
- [ ] No mechanics already documented elsewhere in the skill are restated

## Done summary

## Evidence
