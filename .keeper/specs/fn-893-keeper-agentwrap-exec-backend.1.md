## Description

**Size:** M
**Files:** src/db.ts, src/daemon.ts, src/autopilot-worker.ts

Make `agentwrap` a selectable exec backend value and add the absolute
agentwrap-binary path config, threading both through the autopilot
restart-to-apply path. This is the wiring layer; the backend factory itself
lands in task .2.

### Approach

- **Valid value:** add `"agentwrap"` to `VALID_EXEC_BACKENDS` (src/db.ts:113) so `exec_backend: agentwrap` selects rather than warn-and-fall-back. Keep `DEFAULT_EXEC_BACKEND="tmux"` (src/exec-backend.ts:110 and its drift-paired mirror src/db.ts:108-109) in lockstep.
- **New config key:** add `agentwrap_path` → `agentwrapPath?: string` on `KeeperConfig`, mirroring the `dispatch_prompt_prefix` precedent (src/db.ts:174,217-221) — best-effort, independent, no default. Add a `KEEPER_AGENTWRAP_PATH` env override following the `resolveDbPath`/`resolveConfigPath` precedent (src/db.ts:50-62,151-158). Expand a leading `~` via `os.homedir()` AT RESOLVE TIME (execvp won't expand `~`); default to the resolved `~/.bun/bin/agentwrap` when unset.
- **Thread to the worker:** add `agentwrapPath?` to `AutopilotWorkerData` (src/autopilot-worker.ts:1275) and freeze it in alongside `execBackend` at src/daemon.ts:2960 (restart-to-apply, same as execBackend). Pass it into the `resolveExecBackend({backendType, agentwrapPath})` call at src/autopilot-worker.ts:1655-1660 (the deps type widens in task .2; here just plumb the value).

### Investigation targets

**Required:**
- src/db.ts:113 — `VALID_EXEC_BACKENDS`; :225-234 — `exec_backend` parse; :217-221 — `dispatch_prompt_prefix` precedent for the new string key; :50-62,151-158 — env-override + path-resolve precedents.
- src/db.ts:108-109 + src/exec-backend.ts:110 — the drift-paired `DEFAULT_EXEC_BACKEND` (keep in lockstep).
- src/daemon.ts:2948,2960 — `resolveConfig()` + the `AutopilotWorkerData` freeze site.
- src/autopilot-worker.ts:1275,1655-1660 — `AutopilotWorkerData` type + the `resolveExecBackend` call.

### Risks

- Forgetting `VALID_EXEC_BACKENDS` makes the whole feature silently no-op (warn-and-fall-back to tmux).
- `~` must be expanded in code — passing a `~`-prefixed path to spawn ENOENTs.
- Restart-to-apply: a config flip lags until the next daemon restart — document, don't try to hot-reload.

### Test notes

Config tests (test/config.test.ts / the db.test.ts config block): `exec_backend: agentwrap` now SELECTS (flip the existing "unknown value warns and falls back" assertions); `agentwrap_path` parses + the `KEEPER_AGENTWRAP_PATH` env override wins + `~` expands. Keep the tmux-default assertions green.

## Acceptance

- [ ] `exec_backend: agentwrap` is accepted (in `VALID_EXEC_BACKENDS`); unknown values still warn-and-fall-back to `tmux`; `tmux` stays default.
- [ ] `agentwrap_path` config + `KEEPER_AGENTWRAP_PATH` env override resolve to an absolute path with `~` expanded; defaults to `~/.bun/bin/agentwrap`.
- [ ] `agentwrapPath` + `execBackend` both travel the restart-to-apply path into `AutopilotWorkerData`.
- [ ] Config tests green; `tmux` default behavior unchanged.

## Done summary

## Evidence
