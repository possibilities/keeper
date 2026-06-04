## Description

**Size:** S
**Files:** src/readiness.ts, test/readiness.test.ts, CLAUDE.md

### Approach

Widen `isLiveWorkOccupant` (readiness.ts:1026-1031) so its blocked-reason
disjunct also returns true for `git-uncommitted` and `git-orphans` — an
additive `||` branch placed AFTER the existing `running`/`job-pending`
checks, never outranking `running`. Match BOTH git reason kinds. This is
sound because predicate 6.5 (the only producer of those verdicts) is
`worker_phase==="done"`-gated (:638) and ranks below predicate 1
(`completed`, requires approved) and predicate 4 (`job-rejected`), so a git
verdict strictly implies the done+approval-pending window. `isRootOccupant`
(:1049-1054) delegates to `isLiveWorkOccupant`, so the per-epic mutex AND
the per-root TASK claim (pass-1 task loop, :1181) inherit the fix with no
logic edit there. Do NOT thread Task/Epic through the predicate — keep
occupancy a pure `f(verdict)`. Rewrite the now-wrong JSDoc that lists the
two git reasons as Excluded occupants (:1007-1031), the `isRootOccupant`
JSDoc (:1033-1054), and the ladder-header occupancy narration (:79-93).
Consolidate the CLAUDE.md "Autopilot dispatch gates" occupancy docs:
rewrite the "won't dispatch into a dirty repo" + fn-671 mutex bullets into
one canonical occupancy definition rather than appending a third (edit
CLAUDE.md in place — AGENTS.md is a symlink). Mirror the fn-671 comment
style documenting the "git verdict ⟹ done+pending window" implication.

### Investigation targets

**Required** (read before coding):
- src/readiness.ts:1026-1031 — isLiveWorkOccupant, the widening site
- src/readiness.ts:1049-1054 — isRootOccupant (delegates; JSDoc-only edit)
- src/readiness.ts:606-649 — predicate 6.5 done-gate + the two reason kinds
- src/readiness.ts:540-565 — predicate 1 (completed) + predicate 4 (job-rejected) ranking that makes the done-gate implication hold
- src/readiness.ts:1056-1095 — applySingleTaskPerEpicMutex (pass-1 occupancy via isLiveWorkOccupant)
- src/readiness.ts:1176-1186 — per-root pass-1 task loop (inherits via isRootOccupant)
- test/readiness.test.ts:190-200 — run() harness; 4th arg is the gitStatusByProjectDir map
- test/readiness.test.ts:612-647 — existing git-6.5 single-row tests (template)

**Optional** (reference as needed):
- src/autopilot-worker.ts:618-632 — verbForVerdict (verify git verdicts still map to null; no edit)
- CLAUDE.md "Autopilot dispatch gates" — the fn-671 + dirty-repo bullets

### Risks

- Ladder-coupling: occupancy now relies on 6.5's done-gate. Add a guard test asserting a NOT-done task in a dirty repo does NOT get a git verdict, so a future ladder reorder fails loudly instead of silently over-claiming.
- Do not add a new `BlockReason` variant — keeps `formatReasonShort` exhaustiveness and autopilot consumer enums frozen.

### Test notes

- done+pending+dirty task (git-uncommitted) holds the per-epic slot vs a depless ready sibling → sibling demoted to single-task-per-epic.
- Same at per-root scope across two epics on one root → cross-epic ready task demoted to single-task-per-root.
- git-orphans variant (unattributed_to_live_count>0) → occupies identically.
- Guard: a not-done task in a dirty repo → verdict is NOT a git reason (pins the done-gate).
- Regression: job-pending still occupies (unchanged).
- Optional mirror in test/autopilot-worker.test.ts: verbForVerdict(git-uncommitted/git-orphans) → null.

## Acceptance

- [ ] isLiveWorkOccupant returns true for git-uncommitted and git-orphans blocked verdicts; running/job-pending branches unchanged.
- [ ] A done+pending+dirty task demotes a depless ready sibling to single-task-per-epic and a cross-epic ready task on the same root to single-task-per-root (tests pass).
- [ ] Guard test pins predicate 6.5's done-gate.
- [ ] JSDoc (isLiveWorkOccupant, isRootOccupant), ladder header, and CLAUDE.md occupancy docs updated with no remaining contradictions.
- [ ] No schema/reducer/keeper-py change; no new BlockReason variant.

## Done summary
Widened isLiveWorkOccupant to treat git-uncommitted/git-orphans verdicts as mutex occupants so the whole done+approval-pending window holds the per-epic/per-root slot; added per-epic, per-root, git-orphans, and done-gate guard tests plus a verbForVerdict null mirror, and consolidated the CLAUDE.md occupancy docs.
## Evidence
