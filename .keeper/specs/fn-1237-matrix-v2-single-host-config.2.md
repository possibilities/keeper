## Description

**Size:** M
**Files:** src/reconcile-core.ts, src/worker-cell.ts, src/autopilot-worker.ts, test/autopilot-worker.test.ts, docs/problem-codes.md, root worker-cell/dispatch tests

### Approach

The autopilot producer loads the host matrix once per reconcile cycle (inside loadReconcileSnapshot, beside
the existing per-cycle probes) and attaches a serializable discriminated field to the snapshot: parsed axes
(subagent_models, per-capability effort lists, enough to compose cell dirs and agent names) when the file is
good, or `{state: absent|unparseable|invalid|empty, detail}` when it is not. The pure core's
workerCellPluginDir consumes snapshot data through the relocated fs-free helpers (task 1's leaf module)
instead of the embedded matrix — src/reconcile-core.ts drops its subagents_config import and the depgraph
test must pass WITHOUT modification (the proof of the injection approach). resolveWorkerCell takes the
matrix (or its failure discriminator) as a parameter: the autopilot passes the cycle snapshot — the route
probe consumes the SAME snapshot, closing the mid-cycle-edit inconsistency — while manual `keeper dispatch`
loads fresh at invocation and reports the same typed rejects. defaultRouteProbe's `matrix === null → routed`
branch is deleted: with no embedded baseline, a bad matrix maps to a new WorkerCellResult reject kind
carrying the four-state discriminator, composed into the existing DispatchFailed distress surface with a
byte-pinned reason string per state; dispatch parks, the daemon never exits (no fatalExit — LaunchAgent
respawn would crash-loop). Add the new failure code row to docs/problem-codes.md beside worker-cell-no-route.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.
NOTE: src/autopilot-worker.ts contains a NUL byte — use `grep -a` or `rg --text`, plain grep silently
matches nothing.*

**Required** (read before coding):
- src/reconcile-core.ts:28-30, 218-236 — the subagents_config import to drop and workerCellPluginDir to rework; :1861-1892 the launch compose call site
- src/worker-cell.ts:28-38, 176-190, 230-249, 263-268 — imports, composeWorkerCellDir, defaultRouteProbe, the WorkerCellResult union to extend
- src/autopilot-worker.ts:6934 — loadReconcileSnapshot (where the matrix field is populated); :7851-7868 driveCycle call site
- src/autopilot-worker.ts:3616-3690 — reject → byte-pinned sticky reason composition (worker-cell-invalid / -missing / work-plugin-shadowed / worker-cell-no-route)
- test/reconcile-core-depgraph.test.ts:39-84 — the closure pin that must stay green unchanged

**Optional** (reference as needed):
- src/autopilot-worker.ts:431-453 — resolveWorkerLaunchConfig: the presets.yaml launch-triple surface (ADR 0033) — a DISTINCT config; do not conflate, but its ConfigError-swallow shape is the fail-safe pattern precedent
- docs/problem-codes.md:89-145 — the distress/problem-code table the new row joins

### Risks

- Signature ripple through the byte-pinned autopilot-worker tests — extend reasons additively, keep existing strings byte-identical
- Accidentally reading the matrix inside the pure closure (fs import) — the depgraph test is the tripwire

### Test notes

Fixture matrices per failure state under a pinned KEEPER_CONFIG_DIR; assert one distress reason per state,
no worker launch, daemon loop continues; assert one cycle sees one snapshot (edit between probe points
cannot flip the verdict); manual-dispatch path asserts the same reject kinds.

## Acceptance

- [ ] With a valid v2 matrix on the snapshot, native and wrapped cells compose the same workers/<model>-<effort> plugin dirs as before the change (existing dispatch tests green against fixtures)
- [ ] Each of the four bad-matrix states mints a visible dispatch-failure distress row whose reason names the state; no worker launches and the daemon process does not exit
- [ ] The reconcile-core import-closure test passes without modification
- [ ] Manual keeper dispatch against a bad matrix reports the same typed reject, loading the matrix itself
- [ ] One reconcile cycle observes exactly one matrix snapshot: a file edit mid-cycle cannot produce differing verdicts within that cycle
- [ ] The problem-codes table lists the new failure code

## Done summary

## Evidence
