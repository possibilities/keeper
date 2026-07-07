## Description

**Size:** S
**Files:** plugins/keeper/skills/await/SKILL.md, plugins/keeper/skills/query/SKILL.md, plugins/keeper/skills/autopilot/SKILL.md, plugins/prompt/corpus/snippets/engineering/orient.md.tmpl

### Approach

Align every sibling advice surface to the final vocabulary tasks 3 and 4 shipped — revise in place, forward-facing prose only. await SKILL.md: the condition-derivation table, the pre-check-exempt condition list, and the armed/met event-shape enumeration gain the six per-signal tokens plus umbrella needs-human and the since:<signature> idiom; verify the escalated-but-paused note still reads true now that await sources dispatch failures from the snapshot fold. autopilot SKILL.md: the needs_human parenthetical currently naming three of six members aligns to the full set (leave its snapshot-TUI --watch note alone — different surface). query SKILL.md: verify the collection-allowlist prose — the raw dispatch_failures query verb survives (only status's out-of-band call site was removed), so this is likely a no-change verification. The orient snippet template: its needs_human enumeration is already stale (missing parked_questions and instant_death_wall) — bring it to the full six, and extend its keeper watch delta enumeration with the new types; then regenerate the baked snippet index through the prompt-render bake flow — the index is generated, never hand-edited.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/keeper/skills/await/SKILL.md:43-53 (condition-derivation table), :90-92 (pre-check-exempt list), :197-199 (armed/met event shapes), :168-173 (escalated-but-paused note to verify)
- plugins/keeper/skills/autopilot/SKILL.md:105 (the 3-of-6 parenthetical); :111 (the --watch TUI note to leave alone)
- plugins/keeper/skills/query/SKILL.md:100-124 (needs-human and collection-allowlist prose to verify)
- The orient snippet template under the prompt corpus (locate via grep for the needs_human enumeration) and the recent snippet-index rebuild commit for the regeneration flow
- The final token and delta-type names as shipped by tasks 3 and 4

**Optional** (reference as needed):
- scripts/vendor-corpus.ts — the corpus check gate that validates the regenerated index

### Risks

- Hand-editing the baked index instead of regenerating it breaks the corpus drift gate.
- Copying the plan's placeholder token names instead of the shipped ones bakes stale vocabulary into agent-facing advice.

### Test notes

Corpus/bake check green after the index regeneration; skill lints green; a grep sweep for the old 3-of-6 and 4-of-6 needs_human enumerations returns only historical files (commit messages excluded).

## Acceptance

- [ ] await, autopilot, and query skill prose enumerate the final condition and delta vocabulary with no stale subset enumerations
- [ ] The orient snippet lists all six needs_human members and the extended watch delta set, and its baked index is regenerated through the bake flow
- [ ] All prose is forward-facing and the corpus and skill lint gates pass

## Done summary

## Evidence
