## Description

**Size:** S
**Files:** src/worker-cell.ts, src/reconcile-core.ts, src/autopilot-worker.ts, cli/dispatch.ts, test/dispatch-cli.test.ts, test/autopilot-worker.test.ts, docs/plugin-composition-map.md

### Approach

Extract launcher-owned worker-cell resolution into one shared dep-light seam so every plan-work launch path resolves a task's per-cell plugin identically. The resolver takes {model, tier} and returns pluginDir-or-reject as DATA: it runs the pure KEEPER_ROOT-anchored compose (catching the out-of-matrix throw) plus the two impure pre-launch guards (missing cell manifest; shadowed stray work plugin). Autopilot's reconcile producer consumes it with its existing reject→sticky DispatchFailed mapping and retry_dispatch clear kept exactly as today; the manual dispatch plan-form branch consumes it and fails loud with a non-zero exit on any reject (a synchronous human CLI has no reconcile loop to clear a sticky), threading pluginDir into the launch spec — the transport already emits `--plugin-dir` and must not change. The session-orchestrator {model, effort} axis stays strictly distinct from the task cell. Resume-mode and cell-free callers (bus wake, tabs restore/dump, merge-resolver, handoff) stay byte-untouched. Align the plugin-composition doc's dispatch claim with the now-true behavior.

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but the repo moves. reconcile-core.ts and autopilot-worker.ts contain a NUL byte: use `grep -a` / `rg -a` or plain matches silently vanish.*

**Required** (read before coding):
- src/reconcile-core.ts:199-215 — workerCellPluginDir pure compose (KEEPER_ROOT seam :164-181, cwd-independent by design); :1629-1640 pure reconcile's try/catch reject-as-data; :273-295 buildPlannedLaunchSpec
- src/autopilot-worker.ts:2291-2341 — the inlined reject→sticky mapping + missing-manifest + shadowed-work-plugin guards to extract (findShadowingWorkManifest exported :357; workerCellPluginDir re-exported :237)
- cli/dispatch.ts:572-608 — the plan-form branch that never resolves the cell; :675-680 the spec build lacking pluginDir; :517 resolveWorkerLaunchConfig is the SESSION axis, not the task cell (distinction documented at src/reconcile-core.ts:219-223); :50 dispatch already imports from ../src/autopilot-worker
- test/dispatch-cli.test.ts:130-147 — plan-form spec assertions to extend with pluginDir + reject-exit coverage
- test/autopilot-worker.test.ts:1323-1376, :3123-3138, :3521-3544 — the existing cell-resolution/reject/guard suites that must stay green through the extraction

**Optional** (reference as needed):
- src/exec-backend.ts:116, :972-974 — LaunchSpec.pluginDir + argv emit (do not touch); test/exec-backend.test.ts:650, :692 argv pins
- docs/plugin-composition-map.md:49 — the dispatch claim to align

## Acceptance

- [ ] `keeper dispatch work::<task>` launches the worker with the task's resolved per-cell plugin, and exits non-zero with a clear message when the cell is out-of-matrix, its manifest is missing, or a stray work plugin shadows it — never launching an orchestrator without a spawnable work:worker
- [ ] Autopilot cell resolution is behavior-unchanged: same sticky reject reasons cleared only by retry_dispatch, byte-identical launch argv for valid cells, and the existing guard suites pass unmodified
- [ ] Both launch paths resolve through one shared seam with no duplicated guard logic, with new tests pinning dispatch's pluginDir threading and reject exit
- [ ] The plugin-composition doc describes manual dispatch's cell behavior accurately

## Done summary

## Evidence
