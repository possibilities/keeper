## Description

**Size:** S
**Files:** plugins/plan/skills/model-guidance/SKILL.md, plugins/plan/README.md

### Approach

Rewrite the skill's invocation flow around the `--state` envelope: questions scale with ambiguity (at most two AskUserQuestion calls, often one, sometimes zero) and no flow requires typing a model name — every choice is derived from the configured axes. Flow: run `--state` first. With actionable gaps, Q1 is a single-select scope with detected counts and value names baked into the labels ("Fill gaps — N: names" recommended and listed first / "Refresh specific values…" / "Wipe & regenerate — git-recoverable", never the default). "Refresh specific" triggers Q2 as a SEPARATE AskUserQuestion call: multiSelect over the NON-fresh axis values with each option's state in its description; AskUserQuestion caps four options per question, so if non-fresh exceeds four, degrade to a prose list (at that scale fill-gaps or all is the right scope anyway); an empty multiSelect is a cancel. All-fresh: one gentle question defaulting to "Nothing, exit". Exactly one missing/stub value: collapse to a single "fill that value — proceed?" beat, no menu. Arg contract: blank → the interactive state-driven flow; an axis value name → scoped run skipping Q1 (validate against BOTH axes, fail loud listing configured values on a miss; if the named value is already fresh, confirm before spending the research pass); `missing` → non-interactive fill of all missing and stub values; `all` → full wipe-and-re-research behind exactly one confirm. Reserved words (`missing`, `all`) are matched before the axis-value check and documented so future axis values avoid them. The skill is the ONLY writer of `status: researched`, stamped solely after a real research → cache → distill → re-hash pass; any placeholder written to keep the gate green stamps `status: stub`. The running agent may upgrade a value from fresh to stale using its own knowledge of current model aliases (the deterministic layer cannot see alias re-points) — never the reverse direction. Extend the distill/re-hash steps to author the efforts-axis provenance stamp. Frontmatter: add AskUserQuestion to allowed-tools (the grant pattern exists in the prompt skill) and rewrite the argument-hint to the new contract. Update the /plan:model-guidance row in the README.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/skills/model-guidance/SKILL.md — the rewrite target (argument-hint at :4; When-to-invoke and the research flow at :22-50)
- plugins/plan/skills/prompt/SKILL.md — the AskUserQuestion allowed-tools grant pattern
- plugins/plan/test/consistency-skills.test.ts:43-85,413 — frontmatter helpers and the AskUserQuestion pin pattern

**Optional** (reference as needed):
- plugins/plan/README.md:170-171 — the command-table rows

### Risks

- Over-prompting: blank arg with everything fresh must truly report-and-exit — zero questions, zero writes.

### Test notes

Consistency-skills frontmatter checks must pass; if a frontmatter pin for this skill's allowed-tools is cheap in the existing style, add it.

## Acceptance

- [ ] The skill body derives its scope from the state envelope with at most two questions, offers fill-gaps / refresh-specific / wipe scopes, never defaults to wipe, and never requires the human to type a model name
- [ ] The documented arg contract is: blank interactive, axis-value scoped with loud failure on non-axis values, missing non-interactive fill, all wiped only behind one confirm
- [ ] AskUserQuestion is in the skill's allowed-tools, the argument-hint reflects the new contract, and the README row matches
- [ ] Fast suite green

## Done summary
Rewrote the model-guidance skill to derive its scope from the model-guidance-check --state envelope: at most two AskUserQuestion calls (fill-gaps / refresh-specific / wipe, never defaulting to wipe, never typing a model name), a blank / axis-value / missing / all arg contract, and sole-writer status:researched discipline. Added a frontmatter pin test and refreshed the README row.
## Evidence
