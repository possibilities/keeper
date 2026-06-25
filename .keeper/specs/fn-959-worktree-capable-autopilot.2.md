## Description

**Size:** M
**Files:** src/worktree-plan.ts (new), test/worktree-plan.test.ts (new)

### Approach

A pure module mapping an epic's task DAG to a worktree topology — NO fs, NO
git, no wall-clock. Toposort `epic.tasks` (Kahn; ties broken by the existing
`(task_number, task_id)` order; FAIL LOUD on a cycle). Per node: its primary
parent is the first parent in sort order; if the primary's worktree is
unclaimed the node INHERITS it (linear chain → one worktree), else it FORKS a
fresh sub-worktree. Add a synthetic `__close__` node depending on all leaf
tasks, pinned to the base. Emit, per task, the derived `{worktreePath, branch,
preMerges, assertBranch}` extending `PlannedLaunch` — `preMerges` = the lane
branches that must merge into this node's branch before it runs (exactly the
DAG edges crossing a worktree boundary). Branch names are a pure function of
stable ids only: base `keeper/epic/<epic_id>`, rib `keeper/epic/<epic_id>/<task_id>`.
Worktree paths resolve to a SIBLING dir outside the repo tree.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:512-538 (PlannedLaunch interface to extend), :1077-1095 (current cwd derivation this replaces in worktree mode).
- src/types.ts ~:847-881 (Task.depends_on, task_number, task_id), Epic.tasks deterministic sort.
- test/autopilot-worker.test.ts (pure-seam DI test style), test/helpers/ (synthetic seeding helpers).

**Optional**:
- src/readiness.ts:821-840 (predicate 8 dep-on-task — the same depends_on semantics the topology consumes).

### Risks

- Multiple roots / multiple sinks / disconnected DAG: first root inherits base, extra roots fork off base, `__close__` collects all sinks. Handle uniformly.
- A branch can only be checked out in one worktree — the inheritance rule must never assign two live nodes the same branch concurrently (the cap-1 lane in the mutex task enforces the runtime half).

### Test notes

Fast-tier ONLY, synthetic DAGs: linear chain (one worktree, zero merges),
diamond (P,A,J base + B rib + one pre-merge), wide fan-out, multi-root,
cycle (throws), single task. Assert byte-identical re-derivation.

## Acceptance

- [ ] Deterministic worktree/branch assignment from `depends_on`; linear chains share one worktree with zero merges; forks get ribs; fan-ins list their pre-merges.
- [ ] Synthetic `__close__` sink pinned to base depends on all leaves.
- [ ] Branch/path names are pure functions of stable ids; re-derivation is byte-identical; cycles fail loud.
- [ ] Pure module (no fs/git/clock); fast-tier unit tests cover chain/diamond/fan-out/multi-root/cycle/single.

## Done summary
Added src/worktree-plan.ts: a pure, deterministic DAG->worktree topology (Kahn toposort, (task_number, task_id) tiebreak, fail-loud on cycle) deriving per-task {branch, worktreePath, preMerges, assertBranch} plus a synthetic __close__ sink pinned to base. Fast-tier tests cover chain/diamond/fan-out/multi-root/cycle/single + byte-identical re-derivation (11/11 green).
## Evidence
