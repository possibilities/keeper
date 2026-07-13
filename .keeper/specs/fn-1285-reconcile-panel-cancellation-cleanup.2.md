## Description

**Size:** M
**Files:** src/pair/panel.ts, src/maintenance-worker.ts, src/agent/tmux-launch.ts, test/pair-panel.test.ts, test/agent-panel-cli.test.ts, test/maintenance-worker.test.ts, test/pair-panel.slow.test.ts, scripts/panel-smoke.ts, README.md, docs/install.md, docs/problem-codes.md

### Approach

Extend the existing panel maintenance pass to reconcile every Panel run whose cleanup status is pending or failed. Reuse the task-1 exact-control cancellation primitive, retry unresolved attempts in stable order, treat verified already-absent resources as progress, and atomically advance cleanup to settled only when no exact obligation remains. Maintenance must resume after daemon restart and preserve exact diagnostics on inaccessible, malformed, or failing controls.

Protect unresolved panel-owned controls from the generic tmux-run age/count garbage collector until cleanup settles; after settlement, retain only bounded audit metadata under the Panel run. Keep foreground cancellation bounded: it performs one immediate pass, while maintenance owns eventual convergence. Update status/cancel output, operations docs, problem-code semantics, and smoke survivor accounting so wrapper death alone can never satisfy the gate.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/maintenance-worker.ts:1-60` — worker contract and existing panel-prune ownership.
- `src/maintenance-worker.ts:220-270` — panel maintenance pass scheduling and injected result/log seams.
- `src/pair/panel.ts:1680-1806` — current terminal cleanup-failed short circuit and cancellation result shape.
- `src/pair/panel.ts:2090-2210` — panel pruning and retention rules that must not delete unresolved cleanup state.
- `src/agent/tmux-launch.ts:56-71` — tmux-run TTL/count limits.
- `src/agent/tmux-launch.ts:935-1019` — artifact GC eligibility and unknown-PID fallback.
- `scripts/panel-smoke.ts:119-153` — survivor inventory inputs.
- `scripts/panel-smoke.ts:253-280` — current wrapper-PID-only exact survivor verdict.

**Optional** (reference as needed):
- `test/maintenance-worker.test.ts` — injected worker cadence and pass-isolation patterns.
- `test/agent-panel-cli.test.ts:1567-1708` — prune gates and CLI outcome assertions.
- `test/pair-panel.slow.test.ts:154-218` — abort smoke whose separate reap must move into cancellation ownership.
- `docs/problem-codes.md:157-169` — published cleanup-failed recovery contract.

### Risks

A maintenance loop can spin or repeatedly spawn tmux commands during a persistent outage; use the worker's bounded cadence and only retain actionable unresolved controls. Pruning and tmux-run GC must agree with cleanup ownership or erase the sole exact target. A manifest write failure after successful teardown must be repairable by a later already-absent observation.

### Test notes

Cover restart from pending/failed, partial progress, no-progress retry, already-gone convergence, concurrent foreground and maintenance passes, missing/corrupt controls, GC pin/unpin, prune exclusion, manifest-write interruption, and eventual settled status. The slow abort test and smoke script must assert zero surviving wrapper PIDs, unresolved controls, and exact tmux windows from cancellation alone.

### Detailed phases

1. Extract one idempotent exact cleanup reconciliation seam shared by foreground cancel and maintenance.
2. Add maintenance discovery, bounded retry cadence, and atomic pending/failed-to-settled updates.
3. Pin unresolved controls against tmux-run GC and panel prune, then release them after settlement.
4. Update CLI/status/problem-code projection for cleanup_failed-until-settled semantics.
5. Strengthen fake and slow smoke gates to inventory all resource classes without manual reap.
6. Consolidate README and operations guidance around automatic reconciliation.

### Alternatives

Requiring operators to call cancel again was rejected because cleanup must survive the initiating client and host restart. Returning success after scheduling background cleanup was rejected because it would recreate the false-success contract.

### Non-functional targets

Reconciliation is idempotent, blast-bounded, and stable-order; it performs no name-based discovery and never busy-loops. Maintenance failures are isolated from unrelated integrity and prune passes. State remains inspectable until cleanup settles.

### Rollout

Maintenance begins reconciling new pending/failed records immediately. Legacy records without controls remain fail-closed and visible. Disabling or reverting maintenance leaves exact control state intact for foreground/operator retry.

## Acceptance

- [ ] The maintenance worker automatically retries every pending or failed Panel cleanup after initiating-process exit and daemon restart.
- [ ] A run transitions cleanup status to settled only after every registered exact resource is verified absent; normal teardown and autoclose races count as already-gone convergence.
- [ ] Unresolved controls are protected from tmux-run garbage collection and panel pruning until settlement, then compacted to bounded audit state.
- [ ] Foreground cancel/status reports cleanup_failed and exact unresolved identities while cleanup is pending or failed, then ordinary cancelled after settlement.
- [ ] Persistent failures remain bounded, retryable, and operator-visible without blocking unrelated maintenance passes.
- [ ] The real abort smoke proves zero surviving wrapper processes, unresolved exact controls, and Tmux windows without a separate test-side reap.
- [ ] README, install guidance, and problem-code documentation describe current automatic reconciliation behavior and recovery truthfully.

## Done summary

## Evidence
