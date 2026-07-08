## Description

**Size:** S
**Files:** src/daemon.ts, test/daemon.test.ts, plugins/keeper/skills/autopilot/SKILL.md, plugins/plan/skills/deconflict/SKILL.md

### Approach

Land the SAME carve-out on all three resolver-authority surfaces, in the same vocabulary:
a schema-version COLLISION is mechanically clear IFF scripts/rebase-schema-migration.ts
exits 0 on it — the resolver invokes the tool and composes its output; a tool REFUSAL, or
any schema SHAPE decision (what a column means, whether a rewind is right, a CREATE-literal
conflict), stays BLOCKED-for-human exactly as today. Surfaces: (1) buildResolverBrief's
guardrail array in src/daemon.ts — the "schema" bullet gains the collision-vs-shape
distinction and names the tool; (2) the autopilot skill's resolver bullet
("mechanically-clear conflicts only, else BLOCKED") gains the same clause; (3) the
deconflict skill's "no schema or migration edits" line is reconciled so tier-2 wording does
not contradict the tier-1 tool path. Update the buildResolverBrief unit tests for the new
brief text.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts buildResolverBrief + its guardrail array (~2225-2339 pre-refactor) and its tests in test/daemon.test.ts
- plugins/keeper/skills/autopilot/SKILL.md — the merge-conflict resolver bullet
- plugins/plan/skills/deconflict/SKILL.md — the schema-edits prohibition line
- scripts/rebase-schema-migration.ts — the exit contract the wording references

### Risks

- Charter drift: if the three surfaces phrase the carve-out differently, a resolver either over-refuses (tool never fires) or over-reaches (edits a rewinding step). Write once, paste thrice, adapt only surrounding grammar.

### Test notes

buildResolverBrief tests assert the brief carries the tool invocation and the
collision-vs-shape boundary; skill prose has no tests — read both files end-to-end after
editing for internal consistency.

## Acceptance

- [ ] All three surfaces name the tool, the exit-0-clear / refusal-BLOCKED boundary, and the shape-decision exclusion in consistent vocabulary
- [ ] buildResolverBrief tests updated and green; full fast suite green
- [ ] No surface still asserts an unconditional "schema = BLOCKED" or "no schema edits" without the carve-out

## Done summary

## Evidence
