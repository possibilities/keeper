## Description

**Size:** S
**Files:** skills/plan/SKILL.md

### Approach

Two in-place revisions; add no new sections, no second paragraphs restating existing ones. (1) In 5e's gotcha-routing paragraph (~line 430): gotcha-derived Approach warnings and Acceptance callouts state the constraint in present tense WITHOUT ticket/epic ids, and specs must NOT emit doc-update acceptance items ("[ ] docstring updated", "[ ] CLAUDE.md bullet added") unless the doc change is itself the task's deliverable or the doc carries a rule an agent would otherwise get wrong — comment/docstring hygiene is the worker's standing discipline, not a per-spec checkbox. (2) In 5g (~lines 468-480): revise the `## Docs gaps` bullet template and the line-480 omission rule so entries may be prune/delete-shaped (e.g. `**<doc path>**: prune <what> — content now redundant`), with the "tracking surface, not an acceptance gate" clause absorbed into the revised sentence rather than duplicated.

### Investigation targets

**Required** (read before coding):
- skills/plan/SKILL.md:425-435 — the 5e gotcha pipe paragraph to amend
- skills/plan/SKILL.md:462-482 — the 5g Docs gaps template + omission rules
- CLAUDE.md (repo root) "Doc & comment style" — the house rule these amendments must obey

### Risks

The skill file is read verbatim by every future planning run — a clumsy sentence here propagates into every spec. Revise existing sentences instead of appending qualifiers; total section growth should be near-zero.

### Test notes

No automated test covers plan/SKILL.md prose; verify by re-reading the two revised passages aloud for self-consistency with the epic's canonical block.

## Acceptance

- [ ] 5e forbids ticket/epic ids in spec constraints and default doc-update acceptance items, via in-place revision
- [ ] 5g Docs gaps supports prune/delete entries; "tracking surface" clause appears exactly once
- [ ] No new H2/H3 added to the skill; net line growth <= 5 lines
- [ ] Neither revised passage contains backward-facing phrasing

## Done summary

## Evidence
