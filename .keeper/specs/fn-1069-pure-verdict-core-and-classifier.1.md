## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/reconcile-core.ts (new), src/worktree-plan.ts, src/reducer.ts

### Approach

Move-only extraction, zero behavior change. Create src/reconcile-core.ts and move the pure verdict closure out of src/autopilot-worker.ts: reconcile (~:1933), attachWorktreeGeometry (~:3202), recoverFailureDispatchId (~:638), prepareWorktreeGeometry, and the pure helpers reconcile pulls (verbForVerdict, isOccupyingJob, isInCooldown, isFinalizerGuarded, closerJobFinished, dispatchKey, buildPlannedLaunchSpec), together with the reconcile-side types (ReconcileState ~:1085, PlannedLaunch ~:1136, ReconcileDecision ~:1278, ReconcileSnapshot ~:749, WorktreeLaunchInfo ~:1208, EpicWorktreeGeometry ~:2985). computeDeferredEpicIds stays behind — it is async and shells git; it is the impure snapshot feeder, not verdict logic. Signatures stay byte-identical; every moved symbol is re-exported from autopilot-worker.ts so the test import block (test/autopilot-worker.test.ts:32-101) does not change. The row types the snapshot references (LaneMergedEntry, WorktreeRepoStatusEntry) move out of reducer.ts into the pure side and are re-exported from reducer.ts. Hoist the one env read on the pure path: deriveWorktreePlan → worktreePathFor currently reaches homedir() (worktree-plan.ts:39,165-170); give the pure seam an injected worktrees-root argument (probed by the producer/snapshot side) and keep a convenience wrapper for existing callers. reconcile-core.ts must import nothing from autopilot-worker.ts (no back-import cycle). Purge fn-id provenance comments in the code being moved, rewriting real WHY as present-tense statements. Prune the autopilot-worker.ts file-header JSDoc to describe only what remains.

### Investigation targets

**Required** (read before coding):
- test/autopilot-worker.test.ts:32-101 — the import block that must not change
- src/autopilot-worker.ts:1933-2305 — reconcile and its 12 launch gates + 8-term close conjunction; map every helper it calls before moving anything
- src/worktree-plan.ts:39,165-170 — the homedir drag being hoisted
- src/autopilot-worker.ts:2437-2581 — computeDeferredEpicIds, to confirm what stays behind

**Optional** (reference as needed):
- src/armed-closure.ts, src/readiness.ts — already-clean modules the core imports as-is (do not move)

### Risks

A hidden impurity in a helper (wall-clock, env, fs) discovered mid-move: hoist it behind an argument like homedir, or leave that helper behind — do not weaken the boundary. Re-export shape must preserve type-only exports correctly (export type vs export).

### Detailed phases

1. Map the exact pure closure and its imports (read, no edits). 2. Move types. 3. Move functions. 4. Wire re-exports. 5. Hoist homedir via injected root. 6. Full suite green. 7. Comment/JSDoc hygiene pass on moved code.

### Alternatives

If the helper closure is more tangled than mapped, fall back to moving only reconcile + attachWorktreeGeometry + recoverFailureDispatchId and their types, and note the residue for the boundary task.

### Test notes

`bun test` fully green with test/autopilot-worker.test.ts unchanged is the whole proof. No new tests in this task.

## Acceptance

- [ ] src/reconcile-core.ts exists holding the pure closure; computeDeferredEpicIds and all drivers remain in autopilot-worker.ts
- [ ] Every moved symbol re-exported; test/autopilot-worker.test.ts and all other test files untouched and green
- [ ] No back-import from reconcile-core.ts to autopilot-worker.ts; homedir no longer reachable on the pure path
- [ ] Moved code carries no fn-id provenance comments

## Done summary

## Evidence
