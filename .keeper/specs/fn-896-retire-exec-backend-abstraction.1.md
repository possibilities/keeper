## Description

**Size:** M
**Files:** src/exec-backend.ts, src/reaper-worker.ts, src/renamer-worker.ts, cli/jobs.ts, scripts/restore-agents.ts

Reverse-dependency-order step 1: extract the tmux operations that SURVIVE the
collapse — the pane helpers (kill/list/rename/focus) and the spec-less restore-
replay launch — into standalone direct seams that do NOT go through the
`ExecBackend` interface or `resolveExecBackend`. Repoint their callers. The
interface + resolver are NOT removed yet (task .2) — this step stays additive
so the tree keeps compiling.

### Approach

- **Pane-ops seam:** group the kept tmux pane ops into a direct factory (e.g. `createTmuxPaneOps(deps)` returning `focusPane`/`listPanes`/`renameWindow`/`killWindow`), reusing the kept pure builders (`buildTmuxSelectWindowArgs`:407, `buildTmuxSelectPaneArgs`:413, `buildTmuxListPanesArgs`:440, `buildTmuxRenameWindowArgs`:589, `buildTmuxKillWindowArgs`:604) + `makeRunCapture`:204 + `localeDefaultedEnv`:461 + `classifyCloseKind`:530. Repoint reaper-worker.ts:306/272 (killWindow), renamer-worker.ts:319/271/280 (listPanes/renameWindow), cli/jobs.ts:717/726 (focusPane), and the autopilot read-time `listPanes` probe (autopilot-worker.ts:1869/1455) to this seam instead of `resolveExecBackend(...)`.
- **Restore-replay seam:** extract the spec-less tmux replay launch (today the `createAgentwrapBackend.ensureLaunched` tmux fallback at exec-backend.ts:1244-1246, built on `ensureSessionFor`:666 + `launchInto`:691 + `buildTmuxNewSessionArgs`:342 + `buildTmuxNewWindowArgs`:377) into a direct `restoreReplayLaunch(session, argv, cwd, deps)` fn. Repoint scripts/restore-agents.ts:601-603 to it. This is the ONE surviving tmux launch — keep it verbatim in behavior.
- Keep `DEFAULT_EXEC_BACKEND`, `MANAGED_EXEC_SESSION`, `execBackendEnvMeta`, and the byte-pinned drift-guard comments exactly in place (no move/rename).

### Investigation targets

**Required:**
- src/exec-backend.ts:331-606 (pure tmux builders), :644-783 (createTmuxBackend internals — ensureSessionFor/launchInto/launch/ensureLaunched), :1156 (the internal tmux backend createAgentwrapBackend constructs), :1244-1246 (spec-less restore fallback).
- src/reaper-worker.ts:272,306; src/renamer-worker.ts:271,280,319; cli/jobs.ts:717,726; src/autopilot-worker.ts:1455,1869 — the pane-op callers.
- scripts/restore-agents.ts:271-291,601-603 — the restore replay loop + buildResumeLaunchArgv argv shape.

### Risks

- The restore replay is crash-only recovery — a regression is invisible until the next crash. Preserve its exact tmux-launch behavior; cover it with the existing restore-agents test.
- Keep `execBackendEnvMeta` + `DEFAULT_EXEC_BACKEND` dep-free (hook imports them).
- Additive only — do NOT delete the interface/resolver here (task .2).

### Test notes

Repoint the pane-op/restore worker tests (reaper/renamer/jobs/restore-agents) to the new seams; keep them green. The full ExecBackend-interface fakes can stay for now (shrink in .2). `bun test test/exec-backend.test.ts` + the worker tests green.

## Acceptance

- [ ] A direct tmux pane-ops seam + a direct `restoreReplayLaunch` seam exist; reaper/renamer/jobs/autopilot-probe/restore call them, not `resolveExecBackend`.
- [ ] The interface + resolver still exist (removed in .2); the tree compiles and all pane-op + restore tests pass.
- [ ] `DEFAULT_EXEC_BACKEND`/`execBackendEnvMeta`/drift-guard comments unmoved + dep-free.

## Done summary
Extracted the kept tmux pane-ops (createTmuxPaneOps) + restore-replay launch (restoreReplayLaunch) as direct seams; repointed reaper/renamer/jobs/autopilot-probe/restore to them. Interface + resolver kept for .2; tree compiles, full suite green.
## Evidence
