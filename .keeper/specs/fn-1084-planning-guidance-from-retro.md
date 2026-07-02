## Overview

Four guidance gaps in the plan skill and scout briefs caused real damage today: same-file
parallel tasks produced both fan-in merge conflicts, same-session multi-epic file overlap was
structurally invisible to epic-scout (no commits exist yet at scaffold time), recorded
fixtures pinning deliberately-changed behavior broke 68 tests without any task accounting for
them, and an unbounded scout fan-out died on account session limits. One editorial task fixes
all four at their exact seams. Worktree lanes defer same-file conflicts to fan-in; they do not
prevent them — the dep edge is the fix, and the guidance must say so.

## Quick commands

- Scaffold a toy epic with two tasks listing the same file and no dep: the planner guidance now forbids it (review the 5f text)

## Acceptance

- [ ] Phase 5f states the hard rule (same-file tasks carry a dep edge) with the fan-in rationale; 5d/5e echo it
- [ ] Phase 6 carries the same-session multi-epic clause: reason about shared files across the portfolio from the specs and wire depends_on_epics where they collide
- [ ] repo-scout and docs-gap-scout briefs flag recorded-fixture/golden coupling (including cross-repo) as a likely-update surface
- [ ] Phase 2b states the fan-out cap and interrupt-rebrief guidance

## Early proof point

Task `.1` — a single editorial pass, verified by re-reading the four seams.

## References

- plugins/plan/skills/plan/SKILL.md:440-442 (5f soft text), :373-374 (5d echo), :535-586 (Phase 6), :81-85 (Phase 2b), :187-188 (2c assumption)
- plugins/plan/agents/repo-scout.md:81-84 (Test Patterns fixtures line), plugins/plan/agents/docs-gap-scout.md
- plugins/plan/template/agents/practice-scout.md.tmpl — managed; edit template + re-render
- Evidence: inventory items 1/2/3/5/6

## Docs gaps

- **plugins/plan/skills/defer/SKILL.md**: mirror the 5f rule if it carries its own task-shaping text
