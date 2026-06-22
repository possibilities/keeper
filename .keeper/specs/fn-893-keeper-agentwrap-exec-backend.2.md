## Description

**Size:** M
**Files:** src/exec-backend.ts, src/autopilot-worker.ts

The core: a `createAgentwrapBackend` factory that launches via the agentwrap
CLI, parses its one-line JSON, maps its exit-code taxonomy to keeper's
launch/retry outcomes, and reuses the tmux backend's pane operations — all
WITHOUT changing the hook-based binding/lease contract.

### Approach

- **Selection branch:** in `resolveExecBackend` (src/exec-backend.ts:766-777) add a `backendType==="agentwrap"` branch returning `createAgentwrapBackend(deps)` (widen `ResolveExecBackendDeps` with `agentwrapPath`). Every other tag still → `createTmuxBackend`.
- **Pure argv builder:** add `buildAgentwrapLaunchArgv(opts)` (exported, DB-free, in src/exec-backend.ts so it's byte-pin testable) producing `[<abs-agentwrap>, "claude", "--agentwrap-tmux", "--agentwrap-tmux-detached", "--agentwrap-tmux-session", <session>, "--agentwrap-tmux-env", "KEEPER_TMUX_SESSION="+<session>, ...model/effort/name flags, <prompt>]`. NOTE the current `launch(argv,…)` receives a fully shell-wrapped argv (`buildLaunchArgv` → `[shell,-l,-i,-c,'…exec claude…']`) — the agentwrap backend does NOT use that shape; it builds the unwrapped agentwrap invocation from the structured launch inputs (verb/id/cwd/name/model/effort/prompt). Thread those structured inputs to the backend (the autopilot call site at src/autopilot-worker.ts:1087-1093 + buildWorkerCommand:249-262 currently pre-wrap — the agentwrap path needs the unwrapped pieces).
- **launch/ensureLaunched:** run the argv via `runCapture` (reuse exec-backend.ts:516-560; consider a longer `captureTimeoutMs` than the 5000ms tmux default since agentwrap does session-create + handoff — it's deps-overridable). Delegate session-create entirely to agentwrap (`--agentwrap-tmux-session`); SKIP keeper's `ensureSessionFor` for this backend (agentwrap mints with C.UTF-8 + TERM/COLORTERM, landed). Pass the session name = `MANAGED_EXEC_SESSION` ("autopilot") so `listPanes`/`killWindow` still find panes.
- **JSON parse (defensive):** scan stdout lines, take the line that `JSON.parse`es to an object with `schema_version` (agentwrap emits exactly one line, but be robust); wrap in try/catch. `schema_version!==1` → permanent fail. Empty / no-JSON / malformed → INTERNAL fail. Keeper DISCARDS the returned `paneId` (binding is hook-based) — parse is only to confirm the window was created.
- **Exit-code → outcome map (ONE central fn):** `0`→ok (poll for SessionStart bind, as today); `3`(noop)→permanent fail, NO retry; `4`(retryable)→transient fail (let the pending row expire via the normal `DispatchExpired` path so it re-dispatches); `1`/`2`→hard fail (loud; `2` = keeper built bad argv, never retry). A `runCapture` null/timeout-kill → transient. Widen `LaunchResult` (src/exec-backend.ts:49) to carry a `retryable`/`permanent` discriminant, and route it through `confirmRunning` (src/autopilot-worker.ts:1045-1157) so the existing pending_dispatches / DispatchExpired / never-bound machinery does the right thing — a permanent (3/1/2) must NOT silently feed the K=3 never-bound counter as a transient would. Binding contract UNCHANGED.
- **Shared pane ops:** `focusPane`/`listPanes`/`renameWindow`/`killWindow` are identical to the tmux backend (they operate on tmux pane ids) — share them, don't reimplement.

### Investigation targets

**Required:**
- src/exec-backend.ts:60-97 (`ExecBackend`), :49 (`LaunchResult`), :493-502 (`ResolveExecBackendDeps`), :511-560 (`createTmuxBackend`/`runCapture`), :572 (`ensureSessionFor` — skipped here), :766-777 (`resolveExecBackend`), :114 (`MANAGED_EXEC_SESSION`).
- src/autopilot-worker.ts:1045-1157 (`confirmRunning` + the indoubt/ceiling + Dispatched/DispatchExpired path), :1087-1093 (launch call site), :249-262 (`buildWorkerCommand`), :670-676 (`buildLaunchArgv`).
- CLAUDE.md "Autopilot" section — the never-bound circuit breaker (K=3 consecutive DispatchExpired-without-bind) so the 3-vs-4 mapping doesn't mis-trip it.

### Risks

- **The exit-code→lease mapping is the load-bearing fork.** A noop(3) folded as ok holds a pending slot until TTL and re-anchors cooldown → phantom; a transient(4) routed as sticky DispatchFailed writes off a recoverable launch; a permanent(3/1/2) that feeds the never-bound counter trips the breaker wrongly. Map onto the EXISTING outcome vocabulary; do not invent a new lease state.
- **No re-fold/determinism impact** — launch is producer-side, never in a fold. State it; don't touch event-sourcing invariants.
- The structured-launch-input rethread (unwrapped vs shell-wrapped argv) must not regress the tmux backend's existing wrapped-argv path.
- Cross-repo contract drift (JSON shape, exit codes) — guarded by the fixture in task .4.

### Test notes

exec-backend unit tests via `makeSpawnStub` (test/exec-backend.test.ts:51-76): assert the agentwrap argv shape; feed canned one-line JSON stdout → ok + bind-poll; feed each exit code 0/1/2/3/4 + a timeout-kill and assert the outcome class (ok / permanent / transient); `schema_version:2` → permanent; empty stdout → INTERNAL. A table-driven exit-map test. Slow-tier autopilot-worker tests exercise the confirmRunning routing — `bun run test:full` (task .4 runs the full gate).

## Acceptance

- [ ] `resolveExecBackend` returns `createAgentwrapBackend` for `backendType==="agentwrap"`; tmux for everything else.
- [ ] `buildAgentwrapLaunchArgv` emits the exact landed-contract invocation; agentwrap is spawned by absolute path; session-create is delegated to agentwrap (no keeper `ensureSessionFor`).
- [ ] One-line JSON parsed defensively (line-by-line, try/catch, `schema_version` checked); returned paneId discarded; binding stays hook-based.
- [ ] Exit codes 0/1/2/3/4 + timeout map through a single central fn to ok / permanent-no-retry / transient-retry, routed through `confirmRunning` without changing the pending_dispatches/DispatchExpired/never-bound contract.
- [ ] `focusPane`/`listPanes`/`renameWindow`/`killWindow` shared with the tmux backend; exec-backend unit tests (argv, JSON, exit-map, timeout) green.

## Done summary

## Evidence
