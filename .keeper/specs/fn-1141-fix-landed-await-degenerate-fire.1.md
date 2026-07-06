## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/readiness-client.ts, src/await-conditions.ts, test/autopilot-worker.test.ts

### Approach

Root-cause first: determine WHY `landed` went terminal-true for an open,
zero-merged multi-repo epic. The await consumer (`landedState`) is pure membership
over `landedEpicIds`, so the epic was actually IN that set — trace back:
`landedEpicIds` ← `computeLandedEpicIds` (worktree ON → the `lane_merged`
projection ids) ← `computeMergedLaneEntries` / `laneMergedInRepo`. The prime
suspects are the `laneMergedInRepo` guards at epic start: the DEFINITIVELY-ABSENT
arm (absent ∧ started ∧ `laneCarriesLandedWork` → MERGED) and the `clustered`
multi-repo per-group path — one of these read MERGED with zero real merged work.
Separately determine whether the observed board `branch_name: "main"` is the
detector consuming the wrong field vs a projection/scaffold defaulting artifact
(the string `branch_name` is not in non-test src, so locate the actual field/
projection first). The fix lands wherever the trivial-true originates — the
detector guard or the projection — NOT a new operator surface.

Fix so that: `landed` is never trivially-true when the epic's recorded/lane branch
resolves equal to the default branch; for a clustered multi-repo epic it fires
only once EVERY `worktree` group's lane is merged into its repo's default; the
started-gate and never-started-absent-lane waiting behavior are preserved; and
worktree-off still degrades to `complete` semantics.

### Investigation targets

*Verify before relying — file:line planner-verified at authoring time; use `grep -a`/ripgrep on src/autopilot-worker.ts.*

**Required** (read before coding):
- src/autopilot-worker.ts:2090 `laneMergedInRepo` (the guard block 2077-2126: absent∧started∧laneCarriesLandedWork, present∧ancestor; the clustered per-group probe) — prime suspect for the degenerate MERGED verdict
- src/autopilot-worker.ts:2029 `computeMergedLaneEntries` (how `epicHasStarted` + `laneCarriesLandedWork` are derived per epic, and the clustered multi-repo aggregation — does it require ALL groups?)
- src/readiness-client.ts:493 `computeLandedEpicIds` (worktree ON → lane_merged ids; OFF → done-epic degrade) and :1926 the wiring into `landedEpicIds`
- src/await-conditions.ts:1202 `landedState` (pure membership — the contract/consumer, not the bug)
- the actual epic `branch_name` field/projection source (NOT in non-test src under that literal — locate it) to resolve the detector-vs-projection fork

### Risks

- The started-gate guards exist specifically to avoid spurious `landed` on fresh/in-flight epics — the fix must tighten the degenerate hole WITHOUT regressing the legitimate merged-and-torn-down (absent-lane) case that those guards already handle.
- Multi-repo: fixing the aggregation must not make a genuinely all-merged clustered epic stop firing.

### Test notes

Pure in-process fast tier. Regression cases: (1) degenerate — epic open, lane branch == default / zero merged work at start → must NOT be in landedEpicIds; (2) multi-repo partial — one group merged, one not → must NOT fire; (3) multi-repo all-merged → fires; (4) worktree-off degrade → `complete` semantics. Model via the existing lane-merged / readiness fakes.

## Acceptance

- [ ] A red regression test reproduces the degenerate fire (open epic, zero lanes merged → `landed` must NOT fire), and the fix turns it green
- [ ] `landed` never resolves terminal-true when the epic's lane/recorded branch equals the default branch
- [ ] A clustered multi-repo epic fires `landed` only when every per-repo group is merged; a partial merge does not fire; an all-merged one does
- [ ] The started-gate and never-started-absent-lane waiting behavior are unchanged (merged-and-torn-down still reads landed)
- [ ] The Done summary names whether the root cause was detector-side or projection-side
- [ ] `bun test test/autopilot-worker.test.ts` is green

## Done summary

## Evidence
