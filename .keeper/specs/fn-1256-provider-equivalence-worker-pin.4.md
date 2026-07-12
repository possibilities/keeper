## Description

**Size:** M
**Files:** src/provider-equivalence.ts, src/reconcile-core.ts, src/autopilot-worker.ts, src/worker-cell.ts, cli/dispatch.ts, src/exec-backend.ts, docs/problem-codes.md, test/autopilot-worker.test.ts, test/reconcile-core-depgraph.test.ts

### Approach

The behavioral contract: with `worker_provider` set, every cell-bearing `work` dispatch
whose assigned cell belongs to the other family launches the mapped equivalent cell; an
untranslatable cell refuses dispatch; nothing else changes. Mechanics: a small
launcher-island loader (`src/provider-equivalence.ts`, own parser of the committed map,
mirroring the dual matrix.yaml parser precedent — the depgraph test forbids a cross-island
import; add a cross-island parity test pinning both parsers) plus a pure
`applyProviderConstraint(cell, provider, map, matrix)`. `loadReconcileSnapshot` reads
`worker_provider` and loads/parses the map once per cycle; both ride `ReconcileSnapshot`
(the hostMatrix/worktreeMode pattern) so pure `reconcile()` translates at the cell-compose
site and `PlannedLaunch` carries assigned cell + effective cell + constraint. All three
resolution points must agree: the producer re-resolution consumes the effective cell, and
manual `keeper dispatch` applies the same helper before composeWorkerCellDir. Fail-closed
rejects are new typed kinds parallel to matrixReject/pluginDirReject with three distinct
reasons — no-map-entry, target-not-on-host, map-malformed — flowing to sticky
DispatchFailed (autopilot) and synchronous die() (CLI, no --force bypass); reason strings
name the cells and direction, never map internals beyond that. Session --model/--effort
floors stay untouched; only the cell/--plugin-dir translates. Exec boundary: three
always-emitted env carriers (`KEEPER_PLAN_DISPATCHED_MODEL`, `KEEPER_PLAN_DISPATCHED_TIER`,
`KEEPER_PLAN_DISPATCH_CONSTRAINT` — the worker_provider value that forced translation),
empty when unconstrained, mirroring KEEPER_PLAN_WORKTREE_BRANCH so a reused tmux session
never inherits a stale cell. The launch/forensics event data carries
{assigned, effective, constraint}. Document the new reject reasons in problem-codes.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/reconcile-core.ts:1933-1974 — cell compose (cellModel/cellTier read, workerCellPluginDir try/catch, PlannedLaunch push), :252 workerCellPluginDir, :287 buildWorkerCommand, ReconcileSnapshot fields (hostMatrix ~:640, worktreeMode ~:672), worktree post-pass :2061-2074
- src/autopilot-worker.ts:6913 loadReconcileSnapshot (config reads :7120-7161), :3451 runReconcileCycle with re-resolution at :3596 and compose from plan fields :3601-3605 — NOTE: grep needs -a on this file (binary byte)
- src/worker-cell.ts:157/:213/:239 — composeWorkerCellDir, closed WorkerCellResult union + assertNever, resolveWorkerCell
- cli/dispatch.ts:765-810 — cell-assignment refusal (no --force), resolveWorkerCell call, die() switch
- src/exec-backend.ts:1137-1166 — the always-emit-empty --x-tmux-env carrier pattern + contract docs :1018-1073
- src/agent/matrix.ts + plugins/plan/src/host_matrix.ts headers — the dual-parser precedent and its parity test

**Optional** (reference as needed):
- src/dispatch-failure-key.ts — assertNever; docs/problem-codes.md worker-cell reject section
- src/reconcile-core.ts:2033-2050 — close launches are cell-less (scope boundary)

### Risks

- The three-resolution-point agreement is the correctness crux: translating only inside reconcile() while the producer re-derives from assigned-cell fields silently un-translates — the PlannedLaunch must be the single carrier and the producer must consume it
- buildWorkerCommand is byte-pinned by golden tests; the env carriers and translated --plugin-dir move golden strings — update them deliberately
- A stale map at runtime (gate is offline) must fail closed per-cell, not crash the cycle: map parse failure is a launch reject, never a worker throw

### Test notes

Pure reconcile-core tests: translation applied/skipped per pin/family, each reject kind with
its reason, unconstrained pass-through byte-identical to today. Producer tests over the
golden launch strings. CLI dispatch tests via the existing sandboxed pattern. Depgraph test
still green (no cross-island import).

## Acceptance

- [ ] With the pin set, a work dispatch whose assigned cell is other-family launches the mapped cell's --plugin-dir and carries non-empty dispatched-cell env; same-family and NULL-pin dispatches are byte-identical to today with empty carriers
- [ ] Each of no-map-entry / target-not-on-host / map-malformed mints a sticky DispatchFailed (autopilot) or synchronous refusal (CLI) with a distinct reason naming the cells and direction; no fallback to the assigned provider under any failure
- [ ] Manual `keeper dispatch work::` and autopilot produce identical translation decisions for the same task and pin
- [ ] The launch event data records {assigned, effective, constraint}; problem-codes documents the new reasons
- [ ] Root fast suite green including updated golden strings and the depgraph boundary

## Done summary
Added the worker_provider dispatch-translation seam (ADR 0047): a dep-free launcher island (src/provider-equivalence.ts) parses the equivalence map, the pure applyProviderConstraint translates each cell-bearing work dispatch's assigned cell into the pinned family (composing the mapped --plugin-dir + three always-present KEEPER_PLAN_DISPATCHED_* exec carriers), and no-map-entry/target-not-on-host/map-malformed fail closed as sticky DispatchFailed (autopilot) or synchronous CLI refusal — never a fallback. Manual dispatch and autopilot share the helper for identical decisions; the launch event records {assigned, effective, constraint}.
## Evidence
