## Description

**Size:** S
**Files:** plist/arthack.keeperd.plist, README.md, CLAUDE.md, AGENTS.md

### Approach

**`plist/arthack.keeperd.plist`** — LaunchAgent template, mirrors the shape of `arthack.jobctl.run-server.plist`:
- `Label`: `arthack.keeperd`
- `ProgramArguments`: absolute path to `bun` (e.g. `/opt/homebrew/bin/bun` on Apple Silicon) + absolute path to `src/daemon.ts`
- `RunAtLoad`: true
- `KeepAlive`: dict — `SuccessfulExit = false`, `ThrottleInterval = 10` (prevent restart-storm)
- `ProcessType`: `Background` (lower CPU priority class)
- `StandardOutPath`: `~/.local/state/keeper/server.stdout` (absolute, expanded)
- `StandardErrorPath`: `~/.local/state/keeper/server.stderr`
- `EnvironmentVariables.PATH`: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` (launchd does not source shell rc; bun must be findable)
- `WorkingDirectory`: `~/code/keeper`

Per the user's locked decision: **no `install` verb.** Treat the plist as a template; README explains how to symlink it into `~/Library/LaunchAgents/` and `launchctl bootstrap` it manually.

**`README.md`** — sections:
- **What keeper is** — 2-paragraph elevator pitch (event-sourced control-data daemon; Bun + bun:sqlite; tails Claude Code hook events into a minimal jobs projection).
- **What keeper is NOT** (explicit non-goals) — no RPC surface, no UI, no multi-machine, no name scraping, no transcript tailing, no plans/planctl_mutations, no multi-session-per-job lineage, no UDS server, no kernel watchers.
- **Install** — step-by-step:
  1. `git clone … && cd keeper && bun install`
  2. `mkdir -p ~/.local/state/keeper`
  3. `ln -s "$PWD/plugin" ~/.claude/plugins/keeper` (Claude Code auto-discovery)
  4. `ln -s "$PWD/plist/arthack.keeperd.plist" ~/Library/LaunchAgents/`
  5. `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/arthack.keeperd.plist`
  6. Verify with `launchctl print gui/$(id -u)/arthack.keeperd | head` and `sqlite3 ~/.local/state/keeper/keeper.db '.tables'`.
- **Uninstall** — reverse of install: `launchctl bootout`, remove symlinks, optionally `rm -rf ~/.local/state/keeper`.
- **Architecture (1-paragraph)** — events table (durable log) + reducer + jobs projection + wake worker on `PRAGMA data_version`. Link to CLAUDE.md for the in-codebase map.
- **Inspect** — `sqlite3 ~/.local/state/keeper/keeper.db 'SELECT * FROM jobs ORDER BY updated_at DESC LIMIT 10'`.

**`CLAUDE.md`** — internal codebase map for AI agents working in the repo: directory layout, key modules and their entry points (`src/daemon.ts`, `src/reducer.ts`, `src/wake-worker.ts`, `src/db.ts`, `src/types.ts`, `plugin/hooks/events-writer.ts`), event-sourcing invariants (cursor + projection advance in same tx; defaults match zero-event projection), and the "DO NOT" list (no UDS, no kernel watchers, no third-party deps in hook).

**`AGENTS.md`** — symlink to `CLAUDE.md` per arthack convention (`ln -s CLAUDE.md AGENTS.md`).

### Investigation targets

**Required** (read before coding):
- `/Users/mike/code/arthack/system/launchagents/Library/LaunchAgents/arthack.jobctl.run-server.plist` — canonical LaunchAgent template
- `/Users/mike/code/arthack/apps/jobctl/CLAUDE.md` — internal-map example
- `/Users/mike/code/arthack/apps/hookctl/CLAUDE.md` — adjacent internal map

**Optional** (reference as needed):
- `/Users/mike/docs/jobctl-and-hooks-tracker-primer.md` — onboarding doc for the old system; not edited in v1 but worth a "see also: keeper" once keeper ships (deferred).

### Risks

- `launchctl` paths differ by macOS version. Use `gui/$(id -u)` form (modern, post-Catalina); avoid the older `launchctl load -w` form.
- `~/Library/LaunchAgents/` plist must be owned by the user and mode `644` — symlinking is fine; macOS silently ignores wrong ownership.
- `EnvironmentVariables.PATH` MUST include `/opt/homebrew/bin` on Apple Silicon (Intel = `/usr/local/bin`). README should note both.

### Test notes

- `plutil -lint plist/arthack.keeperd.plist` exits 0.
- README install steps work cleanly on a fresh checkout (manual verification — not automated in v1).
- CLAUDE.md links resolve.

## Acceptance

- [ ] `plist/arthack.keeperd.plist` passes `plutil -lint`
- [ ] README covers: what keeper is, explicit non-goals, install, uninstall, architecture pointer, inspect commands
- [ ] CLAUDE.md exists with codebase map
- [ ] `AGENTS.md` is a symlink to `CLAUDE.md`
- [ ] Install steps in README produce a working keeper (manually verified end-to-end on this machine)

## Done summary

## Evidence
