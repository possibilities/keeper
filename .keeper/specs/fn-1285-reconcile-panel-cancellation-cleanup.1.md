## Description

**Size:** M
**Files:** src/pair/panel.ts, src/agent/run-capture.ts, src/agent/main.ts, src/agent/dispatch.ts, test/pair-panel.test.ts, test/agent-run-capture.test.ts, test/panel-lifecycle-integration.test.ts

### Approach

Extend each durable Panel member attempt with a caller-known, panel-owned Run-control association keyed by exact `member#attempt`, while retaining backward readability for manifests without it. Pre-register the association before spawning; have `keeper agent run` publish the canonical `RunControlArtifact` to that location immediately after exact tmux launch. If publication fails after launch, reuse exact teardown immediately and fail the attempt rather than admitting an unowned window.

Split the monotonic result/cancellation outcome from durable Panel cleanup status (`pending`, `failed`, `settled`). Cancellation first persists intent and freezes further member registration, then consumes every registered attempt's exact control—including result-bearing attempts—before terminating its outer supervisor. A bounded foreground pass treats exact already-absent as success, retains every unresolved identity without guessing a target, and returns `cleanup_failed` until all owned resources are positively absent.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/pair/panel.ts:159-203` — durable attempt and manifest shapes that need optional control association and cleanup status.
- `src/pair/panel.ts:579-627` — Panel-leg argv construction and caller-known output/title/session inputs.
- `src/pair/panel.ts:1654-1806` — tombstone, wrapper signalling, result skip, and current cancellation settlement.
- `src/agent/run-capture.ts:39-95` — canonical Run-control artifact schema and constructor.
- `src/agent/run-capture.ts:108-191` — exact teardown and control cancellation state machine to reuse.
- `src/agent/main.ts:1223-1285` — result-before-teardown ordering and control-state finalization.
- `src/agent/main.ts:1469-1531` — fresh-run control publication immediately after launch.
- `docs/adr/0051-panel-run-ownership-and-task-cancellation.md` — accepted two-axis state, registration, and exact-cleanup contract.

**Optional** (reference as needed):
- `test/pair-panel.test.ts:1038-1163` — cancellation ordering, unresolved identities, recycled PID, and idempotency fixtures.
- `test/agent-run-capture.test.ts:919-1013` — exact control identity, already-gone, and unresolved-cancelling coverage.
- `test/panel-lifecycle-integration.test.ts:223-305` — fake lifecycle gate whose manual reap currently conceals the defect.

### Risks

The launch-to-control publication interval can create an unowned window unless the panel pre-registers the location and the launcher fails closed with immediate exact teardown. Duplicate members and retries require ordinal attempt identity rather than title or launch triple. Cancellation, result publication, normal reap, and wrapper termination can race; all paths must preserve result data while converging through the same exact-control state machine.

### Test notes

Use injected writers, process identities, and tmux argv recorders. Cover cancel before launch, cancel during control publication, duplicate attempts, result-before-teardown, control write failure, malformed/missing/legacy controls, identity mismatch, already-gone, exact teardown failure, concurrent cancel calls, and no registration after tombstone. Prove `panelCancel` itself consumes exact controls; no test-side reap helper may supply the invariant.

### Detailed phases

1. Add optional attempt control association and orthogonal cleanup status with backward-compatible manifest parsing.
2. Add a caller-owned control publication input to `agent run` while preserving the canonical artifact schema and exact failure teardown.
3. Freeze registration on durable cancellation intent and reorder cancellation around exact control consumption before supervisor termination.
4. Make foreground cancellation emit exact unresolved diagnostics and truthful exit/status behavior.
5. Replace manually disconnected reap assertions with cancellation-owned exact-cleanup tests.

### Alternatives

Copying a random launcher control after discovering it was rejected because cancellation can land before discovery and tmux-run GC can remove the only exact identity. A signal handler remains optional defense-in-depth but cannot establish Panel-run ownership or truthful settlement.

### Non-functional targets

All manifest and control writes are same-directory atomic replaces. Exact tmux commands remain argv arrays with bounded execution and socket-qualified targets. Cancellation work is deterministic over stable `member#attempt` order and never shell-interpolates artifact content.

### Rollout

Older manifests parse with missing associations and fail closed when cancellation cannot identify an exact resource. New attempts cannot proceed past a failed control publication. No DB schema or fold changes are introduced.

## Acceptance

- [ ] Every newly launched Panel member attempt has a durable panel-owned association to one canonical Run-control artifact before capture waiting begins.
- [ ] Control publication failure after tmux launch performs immediate exact teardown and leaves no admitted unowned attempt.
- [ ] Cancellation persists intent before effects, prevents late registration, and consumes all attempt controls including result-bearing attempts before supervisor termination.
- [ ] Cleanup status remains independent of the monotonic cancelled outcome and reaches `settled` only after every exact resource is positively absent.
- [ ] A bounded unresolved pass returns nonzero `cleanup_failed` with exact `member#attempt` diagnostics and preserves retryable controls.
- [ ] Missing, malformed, legacy, or ownership-mismatched controls never trigger title-, PID-, index-, or session-derived window teardown.

## Done summary

## Evidence
