## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/reconcile-core.ts, test/autopilot-worker.test.ts

### Approach

Recovery-only direct close per ADR 0052: a producer-side probe (mirroring the recover
pass — the pure reconcile core only reads the resulting snapshot fact) detects an epic
where (a) every task is done, (b) the epic lane is POSITIVELY an ancestor of the local
default branch (absence is never evidence; worktree-OFF epics never qualify), and (c) at
least one prior closer session finished without landing the terminal stamp. For such an
epic the close path lands the stamp directly by shelling the plan CLI's epic close verb
(the daemon never writes plan state) instead of dispatching another closer — single-flight
behind the same per-epic in-flight dedup the closer dispatch uses, guarded by
epicHasOccupyingJob (never stamp under a live closer — ADR 0031 hazard), recording an
explicit recovery marker so the audit bypass is visible and auditable. Subprocess
failure/timeout logs and retries next cycle (level-triggered); the stamp is idempotent
against an already-closed epic.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/reconcile-core.ts:2300 — the close-row dispatch site + okToPlan gate; per-epic inFlight dedup at :2325
- src/reconcile-core.ts:1919 — closerJobFinished; :1575 epicHasOccupyingJob
- src/autopilot-worker.ts:8547 — the recover pass producer step to mirror; :8568 epicRecoverVerdictById; :196 gitIsAncestorOf; :8462 emitLaneMerged / lane_merged projection
- plugins/plan/src/verbs/epic_close.ts and close_finalize.ts — the stamp semantics being emulated ("epic close is NEVER called twice"; confirm the already-done response is a safe no-op)

**Optional** (reference as needed):
- src/reconcile-core.ts:1355 — finalizeEpic's idempotent skip of an already-merged base
- test/reconcile-core-depgraph.test.ts — the import boundary the pure core must keep

### Risks

- Audit bypass creep: the trigger MUST require prior-closer-finished-without-stamp evidence;
  a done+merged epic with no closer history dispatches a normal closer (the audit pipeline
  is the default path, always).
- The daemon→plan-CLI shell is a new coupling: bound its runtime, never block the cycle on
  it, and treat a non-zero exit as retry-next-tick, not distress.

### Test notes

Pure-core tests via injected snapshot facts: recovery conditions met → stamp planned (not a
dispatch); missing any leg (task not done / no positive ancestor fact / no failed-closer
history / occupying closer live / worktree OFF) → normal closer dispatch; stamp single-flight
across cycles; degraded tick (task 1) → inert.

## Acceptance

- [ ] An all-done epic with positive lane-merged evidence and a prior closer that finished without stamping closes via the recovery stamp, with the recovery marker recorded
- [ ] Any epic missing one of the three recovery legs (or worktree OFF, or a live occupying closer) dispatches the normal closer — the audit pipeline remains the default path
- [ ] The stamp is single-flight, idempotent against already-closed, and a failed shell retries next cycle without wedging
- [ ] Pure-core import boundary preserved (probe is producer-side; reconcile reads a snapshot fact)

## Done summary
Recovery-only direct close: a producer-side probe (computeCloseRecoveryEligibleIds) proves an all-done epic's lane is positively an ancestor of local default, then the reconciler stamps the epic done directly via the plan CLI's epic close verb (recording an explicit CLOSE_RECOVERY_MARKER close_reason) instead of dispatching another closer, guarded single-flight + epicHasOccupyingJob, idempotent, and retrying on a failed/timed-out shell without wedging.
## Evidence
