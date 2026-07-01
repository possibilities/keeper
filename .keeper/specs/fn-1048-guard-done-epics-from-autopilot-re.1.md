## Description

**Size:** S
**Files:** src/readiness.ts, test/readiness.test.ts, README.md, CLAUDE.md (optional)

### Approach

Make a `status:done` epic absorbing in the autopilot readiness pipeline: any
of its tasks must resolve `{tag:"completed"}` so the reconciler never emits a
`work::` dispatch for a finished epic. Implement by extending
`isTaskTerminalCompleted` (src/readiness.ts:722-733) so its terminal gate is
satisfied when the task's OWN parent epic is `status === "done"` (mirroring
the existing close-row literal at :1077) OR the current `worker_phase ===
"done"` — while keeping the three existing task-scope liveness clauses
(`anyEmbeddedJobWorking` / `anyEmbeddedJobHasRunningSubagent` /
`embeddedMonitorOccupies`) so a still-live worker keeps holding the per-root
mutex (preserves the fn-671 invariant). Resolve the epic per-task via the
prebuilt `epicsById` map (src/readiness.ts:584), NOT the ambient `epic`
param, because the function is shared with predicate 8 (`dep-on-task`, :886)
which judges possibly-cross-epic upstream tasks — passing the ambient epic
would misjudge cross-epic deps and break re-fold determinism. A
`task.epic_id === null` (or absent-from-map) lookup falls back to
`worker_phase`-only and never throws. Do NOT bolt close-scope liveness onto
the task path — the close-row verdict (:1077) already holds the root mutex
independently while a closer winds down.

### Investigation targets

**Required** (read before coding):
- src/readiness.ts:722-733 — `isTaskTerminalCompleted`, the gate to extend
- src/readiness.ts:791-806 — predicate 1 (task terminal-completed) call site
- src/readiness.ts:874-893 — predicate 8 (`dep-on-task`) call site; SAME shared function, possibly cross-epic upstream
- src/readiness.ts:1060-1084 — existing close-row `epic.status === "done"` short-circuit; mirror the literal
- src/readiness.ts:584 — where `epicsById` is built (first pass); thread it into the terminal check
- src/readiness.ts:1-49 — header predicate-taxonomy JSDoc (rank-ordered); add the epic-done case at the right rank
- test/readiness.test.ts:55,76,134,220,234 — `makeTask` / `makeEpic` / `makeEmbeddedJob` / `run` / `runWithNow` fixture builders
- test/readiness.test.ts:301,400,420,501,521 — fn-671 liveness guardrail tests that MUST stay green

**Optional** (reference as needed):
- src/types.ts:858-883 (`Epic.status` free-form string|null), :960-998 (`Task.epic_id` nullable)
- README.md `## Architecture` readiness prose (~line 928) — the invariant-sentence anchor

### Risks

- **Shared-function misuse**: resolving the epic from the ambient param instead of per-task `epicsById` breaks cross-epic `dep-on-task` (an upstream in a done epic gets misjudged) and makes re-fold board-order dependent. Cover both call sites in tests.
- **fn-671 regression**: adding close-scope liveness to the task path would break :301/:400/:420/:501/:521. Keep exactly the three existing task-scope liveness clauses; only OR-in `epic.status === "done"` at the gate condition.
- **Reopened done epic**: a done epic is now terminal for dispatch; adding follow-up work to it requires reopening (status → open, e.g. `refine-context --invalidate`) first. Intended — note it in the docs, don't special-case it.

### Test notes

Add to test/readiness.test.ts (pure in-process — no daemon / worker / socket):
- **Core**: `makeEpic({ status: "done", tasks: [makeTask({ worker_phase: "open" })] })` → assert `snap.perTask.get(id)` equals `{ tag: "completed" }` (today it reads `ready`).
- **Liveness still gates**: same done epic but the task carries an embedded working job → stays `{ tag: "running", … job-running }`, NOT `completed` — proves the fn-671 clauses still hold.
- **Cross-epic dep-on-task**: a kept `status:open` epic whose task depends on a task living in a `status:done` epic — the upstream is judged terminal by ITS OWN epic, so the dependent is unblocked (not misjudged by the ambient epic).
- All existing fn-671 tests stay green.

## Acceptance

- [ ] Any task whose parent epic is `status:done` resolves `{tag:"completed"}` in `computeReadiness` regardless of `worker_phase` — the fn-367-shaped case yields no `work` verb
- [ ] The done-epic terminal gate still honors the three task-scope liveness clauses (a live worker on a done-epic task stays `running:*` and holds the per-root mutex)
- [ ] `isTaskTerminalCompleted` resolves each task's own epic via `epicsById` (predicate-8 `dep-on-task` judges the upstream by its own epic; `epic_id` null/absent → `worker_phase`-only, no throw)
- [ ] fn-671 regression tests (test/readiness.test.ts:301/400/420/501/521) stay green
- [ ] readiness header predicate taxonomy documents the epic-done terminal case at the correct rank; README `## Architecture` readiness prose states the "a done epic never re-dispatches work" invariant (revised in place — no fn-ids/dates/past-tense)
- [ ] `bun test`, lint, and typecheck are green

## Done summary
Made a status:done epic absorbing in the readiness pipeline: isTaskTerminalCompleted now OR-in the task's own epic status===done (resolved per-task via epicsById), so a done epic never re-dispatches work:: while the three fn-671 liveness clauses still hold a live worker's per-root mutex.
## Evidence
