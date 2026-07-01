## Description

**Size:** M
**Files:** src/exec-backend.ts, src/autopilot-worker.ts, src/resume-descriptor.ts, src/agent/passthrough.ts (verify), test/{autopilot-worker,exec-backend,resume-descriptor}.test.ts

### Approach

Add a `pluginDir` field to `LaunchSpec` (exec-backend.ts:78-116) and emit it as `--plugin-dir <abs>` in `buildKeeperAgentLaunchArgv` (:840) + `keeperAgentLaunch` passthrough (:1060); `--plugin-dir` is already a recognized passthrough (agent/passthrough.ts:85). Set it in `buildPlannedLaunchSpec` (autopilot-worker.ts:383) from the task's `(model,effort)` via the shared cell-path helper, resolving the keeper `plugins/plan/workers/<cell>` path **cwd-independently** (worktree/cross-repo workers run in another repo — re-introduce a root seam, per `0119d6bb`'s deleted `PLANCTL_ROOT`). Mirror onto the shell twin `buildWorkerCommand` (:306, lockstep drift-guard :371-382) and the resume path `buildResumeCommand` (resume-descriptor.ts:71). **Guards** (reuse `0119d6bb` shapes): compose validates `(model,effort)` against the matrix (reuse `workerAgentFor`'s throw, don't blind string-join — the `WORKER_MODEL=sonnet`/`WORKER_EFFORT=max` orchestrator defaults are NOT the task cell); a pre-launch dir-exists check fails loud with a "regenerate via keeper prompt render-plugin-templates" message. `/plan:work` STILL spawns the old `plan:worker-*` this task — the wired cell loads but is unused (green).

### Investigation targets

**Required** (read before coding):
- `git show 0119d6bb` — the removed `workPluginDir`/`checkWorkPluginManifest`/`WorkPluginCheck`/root-seam shape to reuse
- src/exec-backend.ts:78-116 (`LaunchSpec`, no pluginDir), :840-889 (`buildKeeperAgentLaunchArgv`), :1060-1119 (`keeperAgentLaunch`)
- src/autopilot-worker.ts:306-322 (`buildWorkerCommand`), :383-403 (`buildPlannedLaunchSpec`), :328-329 (WORKER_MODEL/EFFORT — do NOT conflate with task cell), dispatch site :2860-2878
- src/resume-descriptor.ts:71 (`buildResumeCommand`)

### Risks

- `0119d6bb` only touched the shell twins; the STRUCTURED `LaunchSpec` path (what keeper agent actually reads) is net-new — add `pluginDir` there or the flag rides a dead path.
- cwd-dependence: a worktree/cross-repo worker must still resolve the KEEPER plugins/plan/workers path (root seam).
- Resume parity: decide whether a cold resume that relaunches `/plan:work` re-supplies the cell `--plugin-dir` (a pure `--resume` re-attach may not need it); make all three resume producers consistent.

### Test notes

Flip `test/autopilot-worker.test.ts:822-836` (assert `--plugin-dir` PRESENT with the cell now) and the byte-for-byte `buildWorkerCommand` pins (:725,741); update `LaunchSpec` shape pins (:2233,2263) + exec-backend/resume-descriptor tests. Assert out-of-matrix compose throws and missing-cell pre-check fails loud.

## Acceptance

- [ ] `LaunchSpec` carries `pluginDir`; the structured argv path emits `--plugin-dir <abs cell path>`; shell twin + resume path mirror it in lockstep.
- [ ] The cell path resolves cwd-independently (worktree/cross-repo safe) via a shared helper + root seam.
- [ ] Out-of-matrix `(model,effort)` fails at compose; a missing cell dir fails loud pre-launch.
- [ ] Tree still green: `/plan:work` spawns the old agents; the wired cell loads but is unused.

## Done summary
Threaded the per-cell worker --plugin-dir through the structured LaunchSpec path (exec-backend + buildWorkerCommand twin), resolving the task's {model,tier} cell via a shared workerCellPluginDir helper + cwd-independent KEEPER_ROOT seam, with compose + missing-manifest guards; folded the plan worker model onto the keeper Task projection. /plan:work still spawns the old agents (green — cell loads but is unused).
## Evidence
