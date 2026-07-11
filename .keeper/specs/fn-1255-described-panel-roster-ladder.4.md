## Description

**Size:** M
**Files:** plugins/plan/skills/panel-guidance/SKILL.md, plugins/plan/test/consistency-skills.test.ts

### Approach

Author the slash-only static skill that owns the roster — modeled on model-guidance's
frontmatter and pass structure but compose-not-research: no research cache, no hash parity,
no references/ dir. Frontmatter: bare name `panel-guidance`, a description that triggers on
roster refresh intents, `disable-model-invocation: true`, and tight allowed-tools (Read,
Glob, Grep, Edit, Write, AskUserQuestion, plus Bash grants for the gate script, `keeper agent
presets list`, `keeper agent providers check`, and the install copy). Body teaches one pass:
read the live cube via `keeper agent presets list --json` and the capability blocks in
plugins/plan/model-selector.yaml (so panel descriptions never contradict model guidance);
author or refresh the 10-rung weak→max ladder under the committed policy (10 panels, 2–3
members, efforts high/xhigh/max only, closed band enum, at least one weak and one max rung,
default naming a defined panel) and the description discipline — near-uniform lengths with
"use for X, not Y" differentiators, weakness from model tier never from dropped effort,
honest single-family and same-family caveats, and the weak-band "skip the panel entirely"
semantics; write `plugins/plan/panel-selector.yaml`; run the structural gate; INSTALL the
committed roster verbatim to `~/.config/keeper/panel.yaml` (the skill is the sole resync
writer of the installed copy — byte-identical, `default` included); verify with `keeper
agent providers check` (the load-bearing cube check) and a presets-list read showing the
ladder; commit the pass scoped to the roster and any pinned tests. Also extend the skills
consistency suite with the new skill's pins (bare name, slash-only posture, tool grants,
directory presence) following the existing per-skill describe blocks.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/skills/model-guidance/SKILL.md:1-30 — frontmatter and pass framing to mirror (drop the research/card machinery)
- plugins/plan/test/consistency-skills.test.ts:226-263 — the per-skill pin pattern to extend

**Optional** (reference as needed):
- plugins/plan/CLAUDE.md — the skills-and-agents section's slash-only static-skill conventions
- docs/adr/0046-described-panel-roster-ladder.md — the decision the skill's prose implements

### Risks

- The install step writes outside the repo (~/.config/keeper); the skill must present it as
  the deliberate cutover write with the gate and providers check green first, never a silent
  side effect.

### Test notes

Consistency pins only — the skill body is prose; no runtime harness executes it in tests.

## Acceptance

- [ ] /plan:panel-guidance exists as a slash-only skill whose documented pass composes from the live cube and model-selector guidance, gates the committed roster, installs it verbatim to ~/.config/keeper/panel.yaml as sole resync writer, and verifies via providers check.
- [ ] The skills consistency suite pins the new skill (name, slash-only posture, tool grants, presence) and is green.

## Done summary

## Evidence
