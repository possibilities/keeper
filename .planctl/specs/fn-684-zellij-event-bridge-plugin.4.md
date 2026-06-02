## Description

**Size:** M
**Files:** src/exec-backend.ts, src/daemon.ts (session-ensure path), a permissions-seed helper

### Approach

Weave a headless plugin load into keeper's own session-ensure so the plugin is scoped to keeper's sessions (NOT the human's global `config.kdl`). On session create AND on resurrection, run `zellij --session <s> action start-or-reload-plugin file:<abs .wasm>` (idempotent, one instance per session; do NOT use `launch-or-focus-plugin`, which spawns a visible pane). Use the stable committed `.wasm` path from task 2. Before/at load, seed `~/.cache/zellij/permissions.kdl` with `"file:<abs .wasm>" { ReadApplicationState }` when absent — the URL must byte-match the committed path exactly, or the headless plugin silently never gets permission (#4982, cannot prompt). Ensure the events dir exists (`mkdir -p`) so the task-3 watcher has a dir to subscribe to. If task 1's spike chose `/host` transport, ensure keeper ensures the session with the cwd (or a layout `cwd`) that lands `/host` on the events dir; if it chose `/tmp`, no cwd wiring is needed.

### Investigation targets

**Required** (read before coding):
- /Users/mike/code/keeper/src/exec-backend.ts:381 — buildZellijNewTabArgs; :744 session-layout resurrection / ensureSession seam
- /Users/mike/code/keeper/src/daemon.ts:2044 — apConfig.zellijSession threading
- /Users/mike/src/zellij-org--zellij — `zellij action start-or-reload-plugin` CLI + permissions.kdl format

**Optional** (reference as needed):
- /Users/mike/code/keeper/src/exec-backend.ts — the custom socket-dir / session-name handling for the action invocation env

### Risks

- The permission URL must equal the `.wasm` path forever; task 2 pins that path.
- Long-lived existing sessions only acquire the plugin on their next ensure/reload — acceptable; new sessions get it immediately.
- Double-instantiation (#5177) is defended at the plugin layer (task 1, append-only); the load wiring just must not itself launch twice.

### Test notes

Injected-spawn test (no real zellij, mirror `test/backend-worker.test.ts`): assert the `start-or-reload-plugin` argv is emitted on session-ensure with the correct abs path, the `permissions.kdl` seed is written/idempotent, the events dir is created, and a repeated ensure does not double-load.

## Acceptance

- [ ] keeper loads the plugin headless into its own sessions (create + resurrection) via `start-or-reload-plugin`, one instance per session, no visible pane
- [ ] `permissions.kdl` is seeded for the exact committed `.wasm` URL when absent; the headless plugin gets `ReadApplicationState` with no prompt
- [ ] The events dir is ensured before the watcher subscribes; transport-cwd wiring matches task 1's spike outcome
- [ ] Injected-spawn test covers argv, permission seed, dir creation, and idempotent re-ensure

## Done summary

## Evidence
