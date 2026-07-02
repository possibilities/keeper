## Description

**Size:** M
**Files:** plugins/plan/skills/plan/SKILL.md, plugins/plan/skills/defer/SKILL.md, plugins/plan/agents/repo-scout.md, plugins/plan/agents/docs-gap-scout.md, plugins/plan/template/agents/practice-scout.md.tmpl

### Approach

Four surgical edits, doc rule #0 (prune, don't append). (1) 5f (:440-442): upgrade "declare
a dep only when files overlap" to the hard rule — tasks whose Files lists share any file
MUST carry a dep edge; one-line rationale: parallel same-file tasks conflict at worktree
fan-in; worktree lanes defer, not prevent. Echo in the 5d bullet (:373-374); mirror in
defer's task-shaping text if present. (2) Phase 6: add the same-session portfolio clause —
epic-scout cannot see overlaps between epics that have no commits yet; when scaffolding
multiple epics in one session, derive file overlap from the specs themselves and wire
depends_on_epics for colliding epics; adjust the 2c assumption line (:187-188) to match.
(3) Fixture coupling: one line each in repo-scout.md Test Patterns (:81-84) and
docs-gap-scout.md — when a change edits content that recorded fixtures/goldens/vendored
corpora pin, flag the fixture surface as a likely-update target, including cross-repo
coupling. (4) Phase 2b: state the fan-out cap (four scouts, the max for one parallel
block) and interrupt-rebrief guidance (bounded sweeps; on interruption, re-brief bounded
rather than resume wide). Re-render practice-scout if its template text changes.

### Investigation targets

**Required** (read before coding):
- The five files at the cited lines — current post-fn-1077/1078 text (lines may have shifted; find the semantic anchors)

### Risks

- The prune discipline cuts both ways: these additions must displace weaker text, not stack on it.

### Test notes

Render consistency + skill-id lint green; no behavioral tests (guidance prose).

## Acceptance

- [ ] All four edits landed at their seams; additions displace rather than stack; renders regenerated
- [ ] A reviewer can quote the hard rule, the same-session clause, the fixture line, and the cap from the current files

## Done summary
Editorial pass: 5f now states the hard same-file dep rule (echoed in 5d/5e/2c), Phase 6 carries the same-session multi-epic overlap clause, repo-scout and docs-gap-scout flag recorded-fixture/golden coupling (cross-repo included), and Phase 2b states the four-scout fan-out cap with bounded interrupt-rebrief. Defer left unchanged (single-task, no inter-task dep text to mirror).
## Evidence
