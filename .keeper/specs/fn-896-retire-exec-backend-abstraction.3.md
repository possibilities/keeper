## Description

**Size:** S
**Files:** src/db.ts, src/daemon.ts

Remove the `exec_backend` config toggle (the resolver that consumed it is gone
after .2) and add a fail-fast agentwrap-presence check at daemon boot, since
agentwrap is now a hard dependency with no fallback.

### Approach

- **Remove the toggle:** delete `VALID_EXEC_BACKENDS` (src/db.ts:115), the `execBackend` field on `KeeperConfig` (:141) + its parse + unknown-value warn (:247-256), and the threading at daemon.ts:2961. KEEP `DEFAULT_EXEC_BACKEND` (:109 — the persisted tag), `DEFAULT_AGENTWRAP_PATH`/`agentwrapPath`/`resolveAgentwrapPath` (:119,146,311), and daemon.ts:2966 (agentwrapPath threading). A stale `exec_backend:` key now falls into the existing silent-ignore (db.ts:122) — removing the typed field makes `tsc` catch any new code that sets it.
- **Boot check:** in daemon `main()`, after migrate + before serving (gated where launch is reachable, e.g. when the autopilot worker is wanted), `spawnSync` the resolved agentwrap path with `--version` (pass `PATH`), log the resolved ABSOLUTE path, and emit a prominent warning if missing/non-executable (name the path + an install hint). Do not hard-exit the whole daemon (it still serves reads/pane-ops) — a loud warning that pre-empts the per-launch ENOENT→never-bound spiral.

### Investigation targets

**Required:**
- src/db.ts:109,115,119,122,141,146,247-256,311-325 — the config surface (what to remove vs keep).
- src/daemon.ts:2948-2966 (resolveConfig + the AutopilotWorkerData freeze + agentwrapPath), and the main() boot sequence (migrate → drain → serve) for the check placement.
- The `want("autopilot")` gate so the check only blocks/warns where launch is actually reachable.

### Risks

- Do NOT remove `DEFAULT_EXEC_BACKEND` (persisted schema tag — non-toggle consumers in restore-worker.ts + execBackendEnvMeta).
- The boot check must pass `PATH` to spawnSync (a bare custom env drops PATH → false ENOENT).
- Restart-to-apply: agentwrapPath is frozen into AutopilotWorkerData at boot — unchanged.

### Test notes

config tests: drop the `execBackend`/`exec_backend` tests (config.test.ts:52-105); keep the `agentwrap_path`/`resolveAgentwrapPath` tests (:107-156); add a test that a config with a stale `exec_backend:` key boots clean. Boot-check unit/seam test (injected spawn) for the present/missing branches.

## Acceptance

- [ ] `exec_backend` toggle removed (VALID_EXEC_BACKENDS + field + parse + daemon threading); `DEFAULT_EXEC_BACKEND` + agentwrap_path kept; a stale `exec_backend:` key boots clean (silently ignored).
- [ ] keeperd boot validates the resolved agentwrap path, logs it, and warns prominently if missing — without hard-exiting the daemon.
- [ ] config + boot-check tests green.

## Done summary

## Evidence
