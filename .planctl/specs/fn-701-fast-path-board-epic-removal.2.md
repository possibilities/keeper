## Description

**Size:** M
**Files:** src/daemon.ts, src/plan-worker.ts, src/rpc-handlers.ts, src/server-worker.ts, test/plan-worker.test.ts

### Approach

Close the no-pulse-to-drain gap so an approval that lands without an
immediate follow-on git pulse still converges promptly. The
`set_task_approval` / `set_epic_approval` handlers
(rpc-handlers.ts:243-312) run in the server-worker thread, so add a
worker->main->plan-worker bridge modeled on `replay_dead_letter` /
`retry_dispatch` (daemon.ts:1467+). On a successful approval write, the
server-worker signals main, which posts `{type:"kick"}` (reuse
`KickMessage`, server-worker.ts:132) to plan-worker. Add a `kick` branch to
plan-worker's `onmessage` that runs a GATED `recheckPending()` — NOT a
bypass. The approval write makes the file dirty/uncommitted; a bypass there
would re-open the fn-627 duplicate-dispatch incident. Null-guard the bridge
for the boot-race window (a kick arriving before `planWorker` is
constructed, daemon.ts:1376-1377), like the autopilot bridge, and wrap the
kick handler in try/catch (no in-process self-heal).

The kick is SUPPLEMENTARY; task `.1`'s commit signal remains the
load-bearing disappear-fix. The 60s heartbeat stays as the kick's
lost-wakeup net (plan-worker has no `data_version` poll to fall back on) —
removing it is the deferred scope-5 follow-up, not this task.

### Investigation targets

**Required** (read before coding):
- src/rpc-handlers.ts:243-312 — rewriteApprovalField + set{Task,Epic}ApprovalHandler (signal the kick on a successful write)
- src/daemon.ts:1402-1421 — kick site (serverWorker + tabNamerWorker); add plan-worker as a recipient
- src/daemon.ts:1467+ — replay_dead_letter/retry_dispatch bridge pattern (worker->main->worker), incl. the boot-race null-guard at daemon.ts:1376-1377
- src/server-worker.ts:132 — KickMessage; :2205 handleKick + :2654-2668 onmessage kick branch (reference idempotent handler)
- src/plan-worker.ts onmessage (~:1856+) — add the `kick` branch -> gated recheckPending()

**Optional:**
- src/daemon.ts:2165-2258 — git-worker->main relay (recheck-pending on commit/git-snapshot; confirm ordering is irrelevant, both idempotent)

### Risks

- The kick MUST be a gated recheck, not a bypass — an uncommitted approval must not emit (the autopilot dirty-repo + uncommitted-epic gates depend on it). This is the fn-627 regression risk; assert it in a test.
- Lost-wakeup: the kick is edge-triggered; the 60s heartbeat remains its level-triggered net. Do NOT remove it (scope 5 deferred).
- Bridge boot-race: a kick before `planWorker` exists must be tolerated (null-guard).

### Test notes

- Test: approval RPC -> kick reaches plan-worker -> `recheckPending` runs and an UNCOMMITTED approval file stays gated (does NOT emit).
- Test: after the file is committed, the task-`.1` commit-driven path emits.
- Sandbox all four state paths in spawn tests.

## Acceptance

- [ ] Approval RPC write signals plan-worker via a worker->main->plan-worker bridge (boot-race null-guarded)
- [ ] plan-worker `kick` handler runs a gated `recheckPending` (no bypass)
- [ ] An uncommitted approval does NOT emit on kick (fn-627 guard); a committed one emits via the task-`.1` path
- [ ] Kick handler is try/catch-wrapped (no self-heal)
- [ ] tests cover kick-delivers-gated-recheck and the uncommitted-no-emit guard

## Done summary

## Evidence
