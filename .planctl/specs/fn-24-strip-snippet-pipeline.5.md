## Description

**Size:** S
**Files:** skills/plan/SKILL.md, CLAUDE.md

### Approach

In skills/plan/SKILL.md: delete Phase 1a (the leading --bundle/--snippets wire-format strip — dead routing once /arthack:sketch no longer emits the line; renumber/reflow Phase 1 accordingly) and the Phase 4 "plan sketch" parenthetical describing the --bundle re-entry. Sweep remaining snippet/bundle pipeline prose from the skill (scaffold YAML schema examples must not show snippets:/bundles: keys as a documented surface — the fields persist as a dormant seam but are no longer advertised). In CLAUDE.md: append epic set-snippets, epic set-bundles, task set-snippets, task set-bundles and scaffold --snippets/--bundles flags to the "Removed verbs (do not re-add)" guardrail list (one-line comma-separated style), and drop real_sketch from the slow-bucket marker list. Present-tense prose only.

### Investigation targets

**Required** (read before coding):
- skills/plan/SKILL.md:49,344-345 — Phase 1a block + Phase 4 parenthetical
- CLAUDE.md:29 — Removed verbs guardrail; CLAUDE.md:42 — slow-bucket marker list

**Optional** (reference as needed):
- skills/plan/SKILL.md Phase 5h YAML example — check for snippets/bundles keys to unadvertise

### Risks

- Deleting Phase 1a while any caller still emits a leading --bundle line would leak it into planning subjects — deps on tasks 1 and 4 guarantee both emitters are gone first.

### Test notes

grep SKILL.md for "--bundle", "save-bundle", "Snippets in bundle" returns nothing; planctl suite still green (no code change expected).

## Acceptance

- [ ] Phase 1a routing and the Phase 4 parenthetical are gone; skill reads coherently end-to-end
- [ ] Removed-verbs guardrail lists the four set-verbs + scaffold flags; real_sketch dropped from the marker list
- [ ] No backward-facing prose introduced

## Done summary

## Evidence
