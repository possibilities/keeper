## Description

**Size:** M
**Files:** src/exec-backend.ts, src/reconcile-core.ts, cli/dispatch.ts, test/exec-backend.test.ts, test/agent-launch-config.test.ts, test/agent-launch-handle.test.ts

Inject the wrapped-cell marker env at the wrapped-cell work launch boundary so the
guard (task 2) and the detection surface (task 4) have a producer-set signal to key
on. Two env values, carried as always-emit `--x-tmux-env` carriers (empty string when
the launch is not a wrapped cell, so a reused tmux session overwrites a stale marker):
`KEEPER_WRAPPED_CELL` (the effective `<model>::<effort>`) and `KEEPER_WRAPPED_ENVELOPE`
(the standardized provider-leg result-envelope path, per-task/per-attempt, consumed by
task 4's detection and task 3's `--output` target).

### Approach

The marker's presence must equal effective-cell wrappedness — the cell's driver is
`wrapped` (the model is not natively served by claude), NOT whether the `worker_provider`
pin translated the cell. A pre-assigned gpt/codex cell is wrapped with a null constraint,
so keying off the constraint silently misses it. Extract or reuse one shared wrappedness
predicate consumed by the autopilot producer (`src/reconcile-core.ts`), the manual path
(`cli/dispatch.ts`), and matching the template renderer's `current_driver == "wrapped"`
notion — three sites drifting would skip the guard or wrongly gate a native worker.

Thread the two values through `src/exec-backend.ts` `buildKeeperAgentLaunchArgv` as new
always-emit carriers placed AFTER the existing escalation-role carrier (the argv ordering
is byte-pinned). Add `wrappedCell?` / `wrappedEnvelope?` to both `KeeperAgentLaunchOpts`-shaped
interfaces (~:110-168 and ~:1020-1065). Both dispatch producers resolve the cell/pin
independently by design, so the injection must land in both or hand-fired wrapped workers
escape the guard.

Do NOT couple the marker to the guard's behavior here — this task only ensures the signal
is present and correct; the guard reads it in task 2.

### Investigation targets

*Verify before relying — planner-verified at authoring time; the repo moves.*

**Required:**
- src/exec-backend.ts:1110-1214 — `buildKeeperAgentLaunchArgv`; the `KEEPER_ESCALATION_ROLE` carrier block is the pattern to follow.
- src/reconcile-core.ts:2085-2193 — the `verb === "work"` cell-compose region where `pluginDir` / wrappedness is resolved; thread the values into `launches.push({...})`.
- cli/dispatch.ts:687-943 — the manual `keeper dispatch work::` cell resolution; mirror the injection.
- src/reconcile-core.ts:264-286 — `workerCellPluginDir` and the wrappedness/driver derivation to reuse for the shared predicate.

**Optional:**
- CONTEXT.md — `Wrapped cell`, `Wrapper driver`, `Capability model` entries for the exact wrappedness definition.

### Risks

- The two new carriers change byte-pinned golden argvs in the exec-backend + launch-config + launch-handle tests; update the goldens deliberately, carrier order after escalation-role.
- A resume launch must carry the SAME `KEEPER_WRAPPED_ENVELOPE` (preserve progress) while a fresh retry must carry a fresh/cleared one (a stale prior-attempt envelope would let task 4's detection false-negative). Confirm the resume argv branch threads the intended path.

### Test notes

Unit-level: assert both carriers present with correct values for a wrapped cell, and
empty for a native cell, across both the autopilot and manual launch specs; assert the
shared wrappedness predicate returns true for a pre-assigned gpt cell with a null provider
constraint. Update the byte-pinned argv goldens. No daemon/subprocess.

## Acceptance

- [ ] A wrapped-cell work launch carries a non-empty `KEEPER_WRAPPED_CELL` and `KEEPER_WRAPPED_ENVELOPE`; a native-cell launch carries both as empty always-emit carriers.
- [ ] Marker presence tracks effective-cell wrappedness (true for a pre-assigned gpt cell with null provider constraint), via one predicate shared across the autopilot producer, the manual dispatch path, and consistent with the template renderer's driver notion.
- [ ] Both the autopilot (`src/reconcile-core.ts`) and manual (`cli/dispatch.ts`) launch paths inject the marker; neither omits it.
- [ ] The byte-pinned launch-argv goldens are updated with the new carriers ordered after the escalation-role carrier, suites green.

## Done summary
Inject the wrapped-cell marker (KEEPER_WRAPPED_CELL + KEEPER_WRAPPED_ENVELOPE) at the work launch boundary via a shared isWrappedCell predicate keyed on effective-cell driver, threaded through both the autopilot producer and the manual dispatch path as always-emit carriers. Native launches carry empty carriers; goldens updated, suites green.
## Evidence
