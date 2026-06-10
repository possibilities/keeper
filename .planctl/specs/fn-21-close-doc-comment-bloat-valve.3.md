## Description

**Size:** S
**Files:** agents/close-planner.md, agents/quality-auditor.md, agents/docs-gap-scout.md, README.md

### Approach

Three agent prompts plus two README table lines. (1) close-planner.md:43 — replace the cull rule so leaving code alone means NOT adding a comment as consolation: cull unless the only-comment remedy states a non-obvious constraint the code cannot show (then it is a genuine fix and may be kept). Also rewrite the backward-facing sentence at line 12 in present tense ("You do three jobs in sequence: ..."). (2) quality-auditor.md — add a "Comment/doc bloat" finding category to Phase 3 (extend the existing line-88 "Commented code" item rather than duplicating it): flags provenance comments (ticket ids, incident dates), narration blocks restating code, redundant comments restating identifiers, and append-only doc growth introduced by the epic's diff; use actionable finding names (e.g. PROVENANCE_COMMENT, NARRATION_BLOCK, REDUNDANT_COMMENT, DOC_APPEND_ONLY); add a misclassification guard — never flag protected functional comments (lint/type suppressions, license headers); wire the category into the report-shape template (~149-189) and rules list (~191-197). (3) docs-gap-scout.md — alongside the existing "Prune, don't append" rule (~line 110), allow Likely Updates Needed entries that recommend pruning/deleting doc content, and instruct flagging an oversized/narrative CLAUDE.md as itself a docs gap. (4) README.md agent-table rows for quality-auditor/docs-gap-scout: one-line description refresh only if posture visibly changed.

### Investigation targets

**Required** (read before coding):
- agents/close-planner.md:12,40-60 — the sentence and cull-rule context
- agents/quality-auditor.md:84-143,149-197 — category sections, report template, rules list
- agents/docs-gap-scout.md:105-115 — prune rule + CLAUDE.md scope rule

**Optional** (reference as needed):
- README.md:155-170 — agent table rows

### Risks

Three surfaces stating overlapping rules invites wording drift — echo the epic spec's canonical block (planctl cat the epic), do not invent parallel formulations. quality-auditor double-reporting: the new category must absorb, not duplicate, the existing dead-comment item.

### Test notes

`uv run pytest tests/` green (no prose tests cover these agents; the suite guards regressions elsewhere).

## Acceptance

- [ ] close-planner cull rule culls comment-only remedies unless the comment states a non-obvious constraint; line-12 sentence is present-tense
- [ ] quality-auditor has the bloat category with actionable finding names, protected-comment guard, and report-template + rules wiring; no duplicate dead-comment item
- [ ] docs-gap-scout permits prune/delete gap entries and flags bloated CLAUDE.md files as gaps
- [ ] README table diffs limited to <= 2 lines
- [ ] No edited passage contains ticket/epic ids or backward-facing phrasing

## Done summary

## Evidence
