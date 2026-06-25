## Description

**Size:** M
**Files:** src/autopilot-worker.ts, test/autopilot-worker.test.ts

### Approach

Wire the topology + git driver into `runReconcileCycle` BEFORE `confirmRunning`
mints the durable Dispatched. When `worktree_mode` is ON: derive the launch
cwd from the topology (worktree path, deterministic), ensure the lane worktree
exists (lazily off the parent's committed tip), run any fan-in pre-merges
first, and set the launch cwd to the worktree. Re-point the CLOSER's cwd from
`projectDir` to the epic base worktree so the close commit lands on
`keeper/epic/<id>`; after the closer reaches done, merge the base into the
resolved default branch, push once, and tear down. Both HEAD assertions emit
sticky `DispatchFailed` (cleared by `retry_dispatch`, mirroring the
`cwd-missing` sticky): OFF → cwd repo on its default branch; ON → worktree HEAD
== derived branch AND worktree registered. Reject worktree mode loudly for
multi-repo epics (per-task `target_repo` spanning toplevels). The merge into a
base never runs while an agent is live in that base (the cap-1 lane + readiness
gate guarantee it).

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:1334-1400 (per-launch loop, dirExists→confirmRunning — the hook point), :1077-1095 (cwd derivation), :1199-1270 (confirmRunning, Dispatched mint), :1366-1374 (cwd-missing sticky DispatchFailed pattern to mirror).
- src/autopilot-worker.ts:1158-1179 (closer dispatch cwd=projectDir — re-point), :1109-1180 (finalizer guard + completion reap), :1568-1611.
- src/collections.ts:255 (DONE_EPICS_REAP_WINDOW_SEC=1800 — merge-to-default must not depend on this window; the recovery task backstops it).

### Risks

- The pure plan.cwd (baked into buildWorkerCommand) and the producer dirExists/ensure-worktree must agree on the worktree path, or dispatch mints a spurious cwd-missing failure.
- Closer re-point: the close commit (plan-done trailer, `.keeper/` edits) must land on the epic branch then reach default via the base merge — verify it does not double-commit on projectDir.
- Merge-to-default decoupled from the 1800s window: drive it from a producer step that survives the epic leaving the recent-done read (the recovery task owns the restart backstop).

### Test notes

Pure-seam DI tests (injected git driver + topology): ensure-worktree-before-Dispatched ordering, pre-merge-before-fan-in, closer-in-base-worktree, merge-to-default after closer-done, both HEAD-assertion sticky failures, multi-repo rejection. `bun run test:full` mandatory.

## Acceptance

- [ ] Worktree provisioned + pre-merges run BEFORE `confirmRunning` mints Dispatched; launch cwd is the worktree path.
- [ ] Closer runs in the epic base worktree; base merges into the resolved default branch after the closer reaches done, pushing once.
- [ ] Both HEAD assertions emit sticky DispatchFailed (never fatalExit), cleared by retry_dispatch.
- [ ] Multi-repo epics rejected loudly in worktree mode.
- [ ] OFF mode is byte-identical to today except the added on-default-branch assertion.

## Done summary
Wired the pure DAG->worktree topology + producer git driver into the autopilot reconcile cycle: reconcile stamps worktree geometry (or multi-repo reject) per launch when worktree_mode is ON; runReconcileCycle provisions the lane + pre-merges + asserts HEAD before Dispatched (re-pointing launch cwd to the worktree), OFF asserts on-default-branch, and a closer-done epic merges its base into the default branch + pushes once + tears lanes down. Both HEAD assertions and multi-repo rejection are sticky DispatchFailed cleared by retry_dispatch.
## Evidence
