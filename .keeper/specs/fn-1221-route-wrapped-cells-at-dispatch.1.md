## Description

**Size:** M
**Files:** src/worker-cell.ts, src/reconcile-core.ts, src/autopilot-worker.ts, cli/dispatch.ts, test/worker-cell.test.ts, test/autopilot-worker.test.ts, test/dispatch-cli.test.ts

### Approach

Two coupled fixes restoring the wrapped-dispatch path the architecture promises.

**Thread the capability model.** The pure reconcile compose already reads the TASK's {model, tier} but the launch records only the orchestrator session model; re-thread the task's capability model onto the planned launch (a dedicated field distinct from the session model — the pure compose stays I/O-free and embedded-only) so the producer's route probe is bound to the model the cell actually names. The manual dispatch CLI already holds the task's model from the epics projection; bind its probe identically.

**Resolve routed wrapped candidates.** In the shared seam's compose-reject arm, a route verdict of routed for a wrapped candidate composes the host cell path from the uniform workers/<model>-<effort> naming convention (path composition only — never embedded-axis validation, which is exactly what threw) and falls through to the existing manifest-absent and shadow probes, returning ok with the cell dir when they pass. An absent-matrix or genuinely-unknown model keeps the out-of-matrix reject; zero serving providers keeps no-route; a routed-but-unrendered cell surfaces as worker-cell-missing with the regen hint. Both callers then thread the LATE-resolved dir into the actual launch (spec pluginDir and the worker command argv) — verify the byte-pinned argv position (--plugin-dir after --name) is composed from the resolved value on both paths.

Behavior parity is the bar: native cells, cell-less rows, and all existing sticky reason strings byte-identical; new behavior only for the wrapped-candidate arm. All new tests inject fixture matrices via the config-dir override — never the host file — and the embedded-default pins stay green.

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but the repo moves. NOTE: src/autopilot-worker.ts reads as binary to plain grep — use `grep -a` or Read.*

**Required** (read before coding):
- src/worker-cell.ts:221-296 — WorkerCellResult, WorkerCellRoute (routed|no-route), defaultRouteProbe, and resolveWorkerCell's reject arm (the "any other verdict leaves out-of-matrix standing" behavior to replace with compose-and-continue)
- src/reconcile-core.ts:1825-1856 — the pure compose site and PlannedLaunch fields (model = session model; tier present; the capability model is the missing thread); the PlannedLaunch doc block ~:919-933
- src/autopilot-worker.ts:3595-3660 — the producer's resolveWorkerCell call (probeRoute bound to plan.model — the wrong model today), the assertNever reject switch whose reason strings are byte-pinned, and how the launch spec receives pluginDir afterward
- cli/dispatch.ts — the plan branch's task-cell read and its resolveWorkerCell call site (bind the probe to the task model; thread the resolved dir into the spec)
- plugins/plan/src/subagents_config.ts workerCellDir convention + src/reconcile-core.ts KEEPER_ROOT seam — the path composition the routed arm reuses
- test/wrapped-cell-e2e.slow.test.ts — extend its resolve coverage so a routed wrapped model asserts an ok cell-dir resolution end-to-end (the gap that let this ship)

### Risks

- The late-resolved dir must reach BOTH the LaunchSpec and the byte-pinned worker command composition — resolving in the seam but launching with the stale null replays the bug one layer down
- The routed arm must not re-validate against embedded axes anywhere in its path composition, or the fix self-defeats

### Test notes

Seam units (fixture matrix injected): routed wrapped + rendered cell → ok(cell dir); routed + missing manifest → missing with dir; no provider → no-route; absent matrix → out-of-matrix stands; native/cell-less unchanged. Producer: a wrapped-model work row dispatches with the resolved --plugin-dir (spec + argv), sticky pins unchanged. CLI parity: same via the dispatch harness. Slow e2e: the resolve stage asserts ok-resolution for the wrapped fixture model.

## Acceptance

- [ ] With a fixture matrix serving a wrapped model whose cell is rendered, dispatch resolution returns ok with that cell dir and the launch carries it in both the spec and the worker-command argv, on the producer and CLI paths alike
- [ ] A routed wrapped model with an unrendered cell surfaces worker-cell-missing naming the dir; zero providers surfaces worker-cell-no-route; an absent matrix leaves out-of-matrix — each with the existing byte-pinned reason shapes
- [ ] Native cells, cell-less rows, and every existing resolution/sticky test pass unmodified; the full fast suites are green
- [ ] The slow wrapped e2e asserts a successful wrapped-cell resolution through the shared seam

## Done summary
Wrapped capability cells now dispatch: the shared seam resolves a routed wrapped candidate to its rendered workers/<model>-<effort> cell (manifest + shadow guards intact), and the task's capability model is threaded onto the launch so the producer and dispatch CLI bind the route probe to the cell's model and launch the late-resolved --plugin-dir in both the spec and the byte-pinned argv. Native cells, cell-less rows, and every existing sticky-reason pin stay byte-identical.
## Evidence
