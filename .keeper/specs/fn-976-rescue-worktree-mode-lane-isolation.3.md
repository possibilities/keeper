## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/readiness.ts, test/autopilot-worker.test.ts

### Approach

Stop the re-dispatch loop where a task whose worker blocked with
`TOOLING_FAILURE` (or ended without completing) gets relaunched every cycle.
Today readiness suppresses only on projection `runtime_status=="blocked"`
(`readiness.ts:987`), which lags the block event, and the in-memory
`redispatchCooldown` (`REDISPATCH_COOLDOWN_S=200`) does not cover a
long-running-then-ended worker. Add a DURABLE suppression arm that outlives
the transient blocked status: when the daemon observes a `TOOLING_FAILURE`
block (the block-escalation skip-branch, `daemon.ts:579` /
`shouldEscalateBlockedCategory`), mint a sticky `DispatchFailed` on
`work::<task_id>` reusing the existing `emitDispatchFailed`/`failedKeys`
machinery (cleared only by `retry_dispatch`) — do NOT add a projection
column. Add a once-only guard so the 60s block-escalation sweep does not
re-emit each tick (skip if `failedKeys` already holds the key). The new arm
slots into the reconcile suppression stack (`autopilot-worker.ts:1368-1386`)
alongside `failedKeys`/cooldown. Must NOT break recovery: `keeper plan
unblock` + `retry_dispatch` (and the bus-resume path) must clear the guard so
a resolved task re-dispatches. Bounded / never-perpetual (mirror the
`failedKeys` human-cleared contract, not an unbounded suppressor).

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:1368-1386 — the reconcile suppression-arm stack
- src/autopilot-worker.ts:434-438, 753-758, 941, 380 — failedKeys / emitDispatchFailed / DispatchFailedPayload / worktreeRecoverDispatchId key pattern
- src/daemon.ts:469-583 — BLOCK_ESCALATION_SKIP_CATEGORY / parseBlockedCategory / shouldEscalateBlockedCategory / selectPendingBlockEscalations (the trigger source)
- src/readiness.ts:987-999 — pred 10.6 runtime-blocked (the fold-lag-exposed gate this complements)

**Optional** (reference as needed):
- src/autopilot-worker.ts:128-227 — the cooldown design-rationale comment (bounded, never-perpetual)

### Risks

- Perpetual-suppression trap: the guard must be clearable (`retry_dispatch` / unblock), never an unbounded freeze.
- The trigger must outlive the transient `runtime_status=="blocked"` / `block_escalations` latch (both deleted on leave-blocked).
- Idempotency: avoid re-emitting the sticky row on every 60s sweep.
- File overlap with task `.1` in src/autopilot-worker.ts — depends on `.1` (serialized).
- Cross-agent: another session edits the reaper / `backend_exec_*` in autopilot-worker.ts — coordinate before landing.

### Test notes

Pure seam only — NO real git. In test/autopilot-worker.test.ts drive
`reconcile` with a snapshot where a task's last worker blocked
`TOOLING_FAILURE` and assert no re-dispatch (the durable arm fires) even when
the projection still shows in_progress; assert `retry_dispatch` clears it and
the task re-dispatches.

## Acceptance

- [ ] A `TOOLING_FAILURE` block durably suppresses re-dispatch of that task even while the projection still shows in_progress / not-yet-blocked.
- [ ] The suppression is per-task (does not block sibling tasks) and bounded (cleared by `retry_dispatch` / unblock).
- [ ] The sticky signal is minted once, not re-emitted on every escalation sweep.
- [ ] No new projection column; reuses `emitDispatchFailed`/`failedKeys`.
- [ ] Existing unblock / `retry_dispatch` recovery flow still re-dispatches a resolved task; pure-seam tests cover suppress + clear.

## Done summary
Durable TOOLING_FAILURE re-dispatch guard: the daemon block-escalation sweep mints a once-only sticky DispatchFailed on work::<task> for surface-and-stop blocks, so the existing failedKeys reconcile arm suppresses re-dispatch independent of the transient runtime_status=blocked latch; cleared by retry_dispatch. No new projection column.
## Evidence
