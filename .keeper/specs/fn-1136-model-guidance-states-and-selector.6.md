## Description

**Size:** S
**Files:** plugins/plan/skills/plan/SKILL.md, plugins/plan/test/consistency-skills.test.ts

### Approach

Wire the selection beat into the refine path: after the refine delta applies (both the epic route and the task route), and before the Phase 7 arm, run the live-epic selection beat over the re-ghosted epic — refine-context with invalidate already re-ghosted it, so the beat is race-free. The assign-cells full-set/todo-only contract means a refine re-selects EVERY remaining todo task's cell, not just newly added ones — state that plainly in the prose so it is discoverable. A refine leaving zero todo tasks skips the beat cleanly when the brief reports no todo tasks and proceeds straight to the arm. Rewrite the three stale statements claiming the refine path skips the beat or rejoins at Phase 7 — delete them, do not caveat them; forward-facing prose only. Extend the consistency selector-beat pin list to cover the refine copy. This file is also edited by fn-1133 in a different section; the epic dep sequences that — re-read the landed Phase 7 text before editing.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/skills/plan/SKILL.md:18,30,583-665,760-807 — the phase-map lines, the canonical Phase 6.5 beat, the refine route and its rejoin point
- plugins/plan/src/verbs/selection_brief.ts:193-194 — the no-todo-tasks error the skip path keys on
- plugins/plan/test/consistency-skills.test.ts:235-253 — the selector-beat pin list to extend

**Optional** (reference as needed):
- plugins/plan/skills/defer/SKILL.md:173-214 — the second beat copy, for phrasing parity

### Risks

- A refine can clobber a deliberate prior manual cell pick on an untouched todo task — accepted and disclosed in the prose, not silently.

### Test notes

Extend the consistency surface list to the refine copy; assert no remaining prose claims the refine path skips selection.

## Acceptance

- [ ] The refine path (epic and task routes) runs the selection beat over remaining todo tasks before re-arming, and skips cleanly when none remain
- [ ] The skill prose states that a refine re-selects all remaining todo cells, and no prose anywhere in the file still claims the refine path skips selection
- [ ] The consistency suite pins the refine beat copy and is green

## Done summary

## Evidence
