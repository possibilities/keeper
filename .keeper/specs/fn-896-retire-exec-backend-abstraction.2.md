## Description

**Size:** M
**Files:** src/exec-backend.ts, src/autopilot-worker.ts, cli/dispatch.ts

Reverse-dependency-order step 2: make the agentwrap launch THE direct launch
path for autopilot + manual dispatch, then DELETE the `ExecBackend` interface,
`resolveExecBackend`, and the in-process tmux-LAUNCH body (the pane ops +
restore replay extracted in .1 survive).

### Approach

- **Promote agentwrap launch:** turn the `createAgentwrapBackend` launch body (`agentwrapLaunchInto`:1170, `buildAgentwrapLaunchArgv`:956, `parseAgentwrapStdout`:1005, `mapAgentwrapExit`:1065) into the direct launch function keeper calls. It composes the `.1` pane-ops seam for pane delegation. Preserve `LaunchResult`/`LaunchSpec`, the `retryable` discriminant, and `AGENTWRAP_CAPTURE_TIMEOUT_MS=30s`.
- **Repoint launch callers:** autopilot-worker.ts confirmRunning (:1133-1139) + its backend resolve (:1728-1734) stop reading `data.execBackend`/`resolveExecBackend` — construct the agentwrap launch directly (with `agentwrapPath`). cli/dispatch.ts (:378-384) calls the agentwrap launch directly (drop `backendType`).
- **Delete the abstraction:** remove `ExecBackend` (:101-152), `resolveExecBackend` + its fallback arm (:1270-1292), `ResolveExecBackendDeps` (:624), and the tmux-LAUNCH internals now unused by anything (`createTmuxBackend.launch`/`ensureLaunched`, plus `ensureSessionFor`/`launchInto`/`buildTmuxNewWindowArgs`/`buildTmuxNewSessionArgs`/`buildTmuxHasSessionArgs` IF the `.1` restore seam no longer routes through them — keep whatever the restore seam needs). Let `tsc` confirm zero stale references before deleting the interface.
- Drop `execBackend` from `AutopilotWorkerData` (:1322/1339); keep `agentwrapPath` (:1346).

### Investigation targets

**Required:**
- src/exec-backend.ts:101-152 (interface), :1138-1254 (createAgentwrapBackend + the launch body + internal tmux), :1270-1292 (resolveExecBackend + fallback arm), :67-90 (LaunchResult/LaunchSpec — keep).
- src/autopilot-worker.ts:1133-1162 (confirmRunning + retryable routing — keep verbatim), :1728-1734 (backend resolve — replace with direct construct), :1322,1339,1346 (AutopilotWorkerData).
- cli/dispatch.ts:72-97 (LaunchFn type), :378-384 (the resolve seam).

### Risks

- The `retryable` split (transient→keep pending/never-bound counter; permanent→sticky DispatchFailed) MUST survive byte-for-behavior — a miscode trips/suppresses the breaker wrongly.
- Delete the interface LAST, after tsc shows zero references; no tombstone no-op, no `any` stopgaps.
- Keep the byte-pinned drift-guard comments + fixture intact (don't move them).
- Determinism: launch is producer-side, never in a fold — zero re-fold impact.

### Test notes

Remove the createTmuxBackend.launch tests (exec-backend.test.ts:281-461) + the resolveExecBackend routing tests (:839-936,:1467-1513). Keep the agentwrap-launch tests (:1133-1391) + the byte-pinned fixture. Shrink the worker-test fakes (renamer/reaper/restore/autopilot) to the kept pane-op subset. Slow-tier autopilot/daemon tests run under `bun run test:full` (task .4 gate).

## Acceptance

- [ ] autopilot + dispatch launch via the agentwrap path directly; `ExecBackend`, `resolveExecBackend`, and the unused tmux-launch internals are deleted; `tsc` clean.
- [ ] `LaunchResult`/`LaunchSpec`/`retryable` routing + the 30s timeout + drift-guards preserved exactly.
- [ ] `execBackend` dropped from `AutopilotWorkerData`; `agentwrapPath` kept; interface-fakes shrunk.
- [ ] exec-backend + autopilot launch tests green.

## Done summary
Collapsed the pluggable exec-backend abstraction: deleted ExecBackend/resolveExecBackend/createTmuxBackend, promoted the agentwrap launch to a standalone agentwrapLaunch (keeper's sole transport) that autopilot + cli/dispatch call directly. Kept the direct tmux pane-ops + restore-replay seams, the retryable routing, the 30s timeout, and the byte-pinned drift guards; shrank the worker-test fakes.
## Evidence
