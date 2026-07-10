## Description

**Size:** S
**Files:** plugins/plan/skills/model-guidance/SKILL.md, plugins/plan/model-selector.yaml, CONTEXT.md, plugins/plan/CLAUDE.md

### Approach

Rewire the skill prose and the doc surfaces to the landed v2 semantics, forward-facing only. SKILL.md:
the When-to-invoke triggers become matrix-keyed (a model added to matrix.yaml's subagent_models; a
provider re-pointing an id upstream stays the human-judgment staleness case); the state-envelope section
documents the landed envelope byte-aligned (states, card_present, card_hash_parity, the reasons enum and
its empty-when-fresh rule) so the skill's jq reads keep working; the research pass becomes research →
fetch card → cache both → distill → re-hash, spelling out the card step (two-URL provenance: durable
discovery URL + resolved artifact URL; markdown-only conversion with the converter recorded; vendor
copyright retained; size-bounded; optional ETag/Last-Modified capture as a cheap re-research signal); a
card-only gap (reasons exactly [no-card] on a notes-researched model) takes a card-fetch-only pass rather
than full re-research; the interactive flow's gap row reads "Fill new values — N: <names>" when every gap
is missing-class and "Fill gaps" otherwise, and the state table names each gap's WHY from reasons; the
all-fresh gentle exit, the missing/all argument contract, and the researched/stub stamp discipline carry
over unchanged; the Verify section states --check as structure + notes-and-card hash parity, fully
offline. model-selector.yaml comments: the header names matrix.yaml's subagent_models as the axis source;
the research-map comment documents the card sub-mapping. CONTEXT.md: add a "Model card" entry (the
cached, provenance-headed, sha256-pinned vendor capability doc living beside the research notes, required
for fresh) that disambiguates the research notes `reference` from the card. plugins/plan/CLAUDE.md: the
model-guidance drift-gate Running-Things row gains the card-parity + matrix-axis wording — read the
wording fn-1237's docs task landed first and edit once, not twice.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/skills/model-guidance/SKILL.md — the full current flow (state envelope §, argument contract, the pass at ~96-118, Verify at ~133-146)
- plugins/plan/scripts/model-guidance-check.ts — the LANDED envelope field names and reasons enum (quote these, not the plan's wording)
- plugins/plan/model-selector.yaml:1-16 — the header comment block to repoint
- plugins/plan/CLAUDE.md — the Running-Things drift-gate row as fn-1237's sweep left it

**Optional** (reference as needed):
- docs/adr/0037-model-cards-pinned-as-served-markdown.md — contract rationale the prose should agree with
- CONTEXT.md — house glossary style (1-2 sentence entries, Avoid-synonym lines)

### Risks

- Envelope-doc drift — the SKILL prose must quote the landed field names; a mismatch breaks the skill's own jq recipes silently

### Test notes

bun scripts/lint-claude-md.ts green; rg for subagents.yaml across the four touched files hits nothing;
manual read-through: every jq snippet in SKILL.md names fields that exist in the landed --state output.

## Acceptance

- [ ] SKILL.md documents the landed --state envelope byte-aligned (card fields + reasons enum), the card fetch step with two-URL provenance, the card-only-gap shortcut, and the adaptive Fill-new-values label rule
- [ ] model-selector.yaml's comments name matrix.yaml subagent_models as the axis source and document the card sub-mapping
- [ ] CONTEXT.md defines Model card and distinguishes it from the research notes reference
- [ ] The plan CLAUDE.md drift-gate row reflects card hash parity and the matrix axis, and the CLAUDE.md lint passes
- [ ] No touched doc references subagents.yaml as a live axis source

## Done summary
Rewired model-guidance SKILL.md, model-selector.yaml comments (already landed), CONTEXT.md, and plugins/plan/CLAUDE.md's drift-gate row to the landed v2 card contract (matrix-keyed triggers, byte-aligned --state envelope, research->fetch card->cache->distill->re-hash pass, card-only-gap shortcut, adaptive Fill-new-values label).
## Evidence
