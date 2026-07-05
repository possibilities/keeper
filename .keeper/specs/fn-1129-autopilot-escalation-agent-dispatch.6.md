## Description

**Size:** M
**Files:** src/daemon.ts, test/daemon.test.ts

### Approach

The block-escalation sweep stops messaging planner@ and dispatches unblock::<task> sessions, serialized per epic; a terminal stage notifies the human once when a session declines or dies. The latch, cancellation re-check, and category denylist stay exactly as they are — TOOLING_FAILURE/unparseable still suppress-and-stop with the existing work::<task> redispatch suppression, never dispatching an agent. The per-planner@ coalescing is replaced by per-epic serialization: at most one live unblock:: session per epic (live-job occupancy guard via the shared helper from the deconflict task); other pending siblings stay latched and re-sweep after the live session goes terminal — no starvation, no same-epic collision, and the brief's sibling list lets one session clear a shared root cause. Dispatch mirrors the deconflict closure (prompt `/plan:unblock <task_id>`, claudeName `unblock::<task_id>`, escalation launch config, producer-only, pause-gated), recording the staged latch outcomes from the substrate task: terminal dispatched, non-terminal dispatch-failed. The terminal stage watches dispatched rows whose unblock::<task> job reached decline/death and sends one botctl notification, stamping the latch's human-notified once-marker. A successful unblock flips the task out of blocked, which deletes the latch row via the existing leave-blocked fold, so the terminal stage never fires. buildBlockEscalationBody and notifyPlannerOfBlock are deleted; then audit notifyPlanner and the planner@ wake path for remaining callers — with both sweeps flipped, delete the dead plumbing (bus role-address resolution serving other consumers stays), or record the surviving callers in the Done summary if any remain.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:869-968 — runBlockEscalationSweep (BlockEscalationSweepDeps :796, coalescing :890-939, denylist + suppressRedispatch :904-927)
- src/daemon.ts:7355-7369 — notifyPlannerOfBlock and src/daemon.ts:724-758 — buildBlockEscalationBody (both deleted)
- src/reducer.ts:804-825 — latch arm/clear (leaving blocked deletes the row — the success path)
- The deconflict task's dispatch helper, cap, and stage-3 sweep in src/daemon.ts (same file; this task lands after it)
- src/daemon.ts:7274-7348 — notifyPlanner and src/bus-wake.ts — the orphan-audit surface for the build-forward deletion

**Optional** (reference as needed):
- test/daemon.test.ts — existing block-sweep tests; check for fixtures pinning the old verbatim message strings

### Risks

- A mass-block event is the herd case: per-epic serialization bounds same-epic fan-out and the global cap bounds cross-epic — both must hold under test.
- Deleting notifyPlanner while a caller remains breaks the bus wake path — audit before deleting.

### Test notes

Deps-injected: denylist still suppresses; per-epic serialization (a second sibling is not dispatched while the first is live, and dispatches after it terminates); dispatch-once per task; launch-fail re-sweeps; notify-once on decline and death; global cap holds across both escalation types.

## Acceptance

- [ ] A blocked task with an escalatable category dispatches exactly one unblock::<task> session; TOOLING_FAILURE/unparseable never dispatch an agent
- [ ] At most one live unblock session per epic, with pending siblings dispatching after the live one terminates — none starved
- [ ] An unblock session that declines or dies notifies the human exactly once
- [ ] buildBlockEscalationBody and notifyPlannerOfBlock are gone; planner@ notify/wake plumbing is deleted when no callers remain (or the surviving callers are recorded in the Done summary); fast suite green

## Done summary

## Evidence
