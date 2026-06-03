## Description

**Size:** S
**Files:** src/daemon.ts (events-dir ensure on boot), src/db.ts (resolveZellijEventsDir, if not already landed by task 3), README.md (Install — dotfiles wiring contract)

### Approach

**Scope note (rescoped by the global-load design change).** This task originally loaded the plugin into keeper's own sessions imperatively (`zellij action start-or-reload-plugin`) and seeded `~/.cache/zellij/permissions.kdl` from keeper. That mechanism is RETIRED — the plugin is now loaded GLOBALLY by the human's dotfiles-managed `config.kdl` `load_plugins` block (out of scope for keeper code), so keeper no longer touches `src/exec-backend.ts` session-ensure for plugin loading and no longer writes `permissions.kdl`. The task title ("session load and permission preseed") still names the OUTCOME this task delivers — the plugin loaded into sessions, permissions seeded — only the mechanism moved to dotfiles + documentation.

keeper's remaining responsibilities:

1. **Ensure the events dir exists on daemon boot.** `mkdir -p` `resolveZellijEventsDir()` (env `KEEPER_ZELLIJ_EVENTS_DIR` wins, default `~/.local/state/keeper/zellij-events`) before the task-3 watcher subscribes — so the `load_plugins` `cwd` (= the plugin's `/host`) always resolves. zellij will not load a plugin whose `cwd` dir is missing. (If task 3 already added `resolveZellijEventsDir` to `src/db.ts`, reuse it.)
2. **Document the dotfiles wiring contract** in README Install: the `config.kdl` block `load_plugins { "file:$(keeper plugin-path)" { cwd "<events dir>" } }` and the `~/.cache/zellij/permissions.kdl` seed granting `ReadApplicationState` to the SAME byte-matching `file:` URL (background plugins cannot prompt — zellij#4982). Reference `keeper plugin-path` (task 2) as the single source of truth for the URL so the three-place path contract (committed file, config.kdl, permissions.kdl) stays byte-identical.

### Investigation targets

**Required** (read before coding):
- /Users/mike/code/keeper/src/daemon.ts:2044 — boot sequence + apConfig.zellijSession threading (the place to mkdir the events dir before worker spawn; confirm the retired per-session-load wiring is NOT added)
- /Users/mike/code/keeper/src/db.ts:356 — resolveDeadLetterDir pattern (resolveZellijEventsDir mirror, if task 3 didn't already add it)
- /Users/mike/src/zellij-org--zellij/zellij-utils/src/kdl/mod.rs:5068 — load_plugins `cwd` parse (the contract README documents)
- /Users/mike/code/keeper/README.md — Install section (where the dotfiles wiring lands)

**Optional** (reference as needed):
- /Users/mike/code/keeper/src/exec-backend.ts:744 — confirm NO plugin-load wiring is added at the session-ensure / resurrection seam (the retired path)

### Risks

- The events dir must exist before any session's plugin loads, or zellij silently fails the load — keeper boot `mkdir` covers daemon starts; a session whose plugin loads before keeperd's first boot is a non-issue (no consumer yet, and the plugin's append-create retries on the next delta).
- The permission URL in dotfiles must byte-match `keeper plugin-path` forever; task 2 pins that path. Document the byte-match requirement loudly.
- Long-lived existing sessions only acquire the plugin on their next zellij (re)start after the dotfiles config lands — acceptable.

### Test notes

Boot test (mirror the existing daemon boot tests, sandboxed `KEEPER_ZELLIJ_EVENTS_DIR`): assert the events dir is created on startup and is idempotent on re-boot. Assert NO `start-or-reload-plugin` argv is emitted on session-ensure (the retired path stays retired). Docs: eyeball that README Install renders the `load_plugins` + `permissions.kdl` contract referencing `keeper plugin-path`.

## Acceptance

- [ ] keeper ensures the events dir exists on daemon boot (idempotent), before the task-3 watcher subscribes
- [ ] keeper does NOT load the plugin or seed `permissions.kdl` — no `start-or-reload-plugin` argv, no `src/exec-backend.ts` session-ensure plugin code
- [ ] README Install documents the dotfiles contract: the `config.kdl` `load_plugins` block (`cwd` = events dir) + the `permissions.kdl` `ReadApplicationState` seed, both referencing `keeper plugin-path` (byte-match)
- [ ] Boot test covers events-dir creation + idempotent re-ensure, and asserts the retired keeper-side load path emits nothing

## Done summary

## Evidence
