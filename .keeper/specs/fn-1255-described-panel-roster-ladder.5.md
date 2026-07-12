## Description

**Size:** M
**Files:** CONTEXT.md, docs/install.md, docs/problem-codes.md, docs/plugin-composition-map.md, plugins/plan/README.md, plugins/plan/CLAUDE.md, plugins/plan/skills/panel/references/panel.md, template/agents/panel-runner.md.tmpl

### Approach

Sweep every surface that restates the retired count/diversity strength heuristic or the
flat-list panel schema, in forward-facing present-tense prose. CONTEXT.md: rewrite the
"Panel strength" entry — an authored band from the closed vocabulary plus a rich
description, read live from the roster at choose time (keep the concept-only register and an
Avoid line; fold the band vocabulary into this entry rather than minting a separate one) —
and verify the "Panel" and "Default panel" entries carry no derivation language.
docs/install.md: rewrite the panel walkthrough for the object schema, the committed
panel-selector.yaml + structural gate, the /plan:panel-guidance install flow, and the richer
presets-list surface — prune the flat-list framing entirely. docs/problem-codes.md: revise
the providers-check rows whose examples address members by the flat schema.
docs/plugin-composition-map.md: add the panel-guidance skill and panel-selector.yaml surface
mirroring the model-selector treatment. plugins/plan/README.md: update the presets-list
enumeration text and add a /plan:panel-guidance row parallel to /plan:model-guidance, with a
pointer from the /plan:panel row to the roster. plugins/plan/CLAUDE.md: at most one line
naming the roster's owner skill and gate command, parallel to the model-guidance row.
skills/panel/references/panel.md: replace any restated strength heuristic with the
read-the-roster-live framing. template/agents/panel-runner.md.tmpl: update the sentence
describing panel.yaml's member shape, then regenerate rendered agents via `keeper prompt
render-plugin-templates` and confirm the panel-runner consistency pins still hold.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- CONTEXT.md:134-138 — the Panels-and-launch-triples glossary block (Panel strength at :136)
- docs/install.md:82-116 — the panel walkthrough being rewritten
- docs/problem-codes.md:129-146 — providers-check member-addressing rows

**Optional** (reference as needed):
- docs/plugin-composition-map.md:97,113-114 — the model-selector treatment to mirror
- plugins/plan/README.md:171,193,196 — presets text and the skill-table rows
- plugins/plan/test/consistency-skills.test.ts:579-592 — the rendered panel-runner pins to keep green

### Risks

- CLAUDE.md files are size-gated and prune-first — one line in plugins/plan/CLAUDE.md, no
  schema narration; keep `bun scripts/lint-claude-md.ts` green.

### Test notes

`keeper prompt render-plugin-templates` then the plan consistency suite; root lint-claude-md
gate; grep the repo for the retired heuristic phrasing ("member count and harness
diversity") to prove the sweep is complete.

## Acceptance

- [ ] No repo doc, skill reference, or agent template teaches member-count/diversity-derived panel strength; the glossary defines Panel strength as the authored band plus description read live from the roster.
- [ ] Rendered plan agents regenerate cleanly and the plan consistency suite is green.
- [ ] The root lint-claude-md gate stays green.

## Done summary
Swept CONTEXT.md, docs/install.md, docs/plugin-composition-map.md, plugins/plan/CLAUDE.md, plugins/plan/README.md, the panel skill reference, and the panel-runner template to describe the authored strength-band + description panel roster instead of the retired member-count/harness-diversity heuristic; pruned CONTEXT.md back under its 140-line cap.
## Evidence
