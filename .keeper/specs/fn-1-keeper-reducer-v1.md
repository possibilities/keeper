## Overview

Keeper is a fresh Bun/TypeScript event-sourced control-data daemon for Claude Code agents, living in its own repo (`~/code/keeper`) and coexisting with — not replacing — the existing arthack jobctl/hookctl system. A TypeScript Claude Code hook plugin writes one row per hook invocation into a SQLite `events` table; a long-running Bun daemon (managed by LaunchAgent) tails the table via a Worker thread polling `PRAGMA data_version` and folds new events into a minimal `jobs` projection table. V1 is deliberately **reducer only** — no RPC surface, no UDS server, no caught-up barrier — but the architecture is designed to admit those later without rework.

## Quick commands

- `bun install && bun run typecheck && bun test --isolate` — green in the fresh repo
- `bun run src/daemon.ts` — daemon runs, drains existing events, listens for wakes (manual smoke; the LaunchAgent runs the same command in production)
- `sqlite3 ~/.local/state/keeper/keeper.db 'SELECT job_id, state, mode, last_event_id FROM jobs ORDER BY updated_at DESC LIMIT 10'` — proves the projection is live after Claude Code sessions fire hooks

## Acceptance

- [ ] Hook writes one row per Claude Code hook invocation to `events` (15 columns, all relevant indexes present)
- [ ] Daemon boot-drains all unfolded events before going live; same code path serves boot and steady-state
- [ ] Reducer folds events into `jobs` with the exact state machine: `SessionStart → INSERT OR IGNORE`, `UserPromptSubmit → working`, `Stop → stopped`, `SessionEnd → ended` (sticky), `mode` updates on any event carrying `permission_mode`
- [ ] Cursor (`reducer_state.last_event_id`) advances in the SAME transaction as every jobs write — exactly-once-per-event under crash
- [ ] Wake worker uses its own read-only `bun:sqlite` connection polling `PRAGMA data_version` at ~50ms cadence; posts contentless wake messages
- [ ] Hook always exits 0 (never blocks Claude); failures log to stderr only
- [ ] Worker crash → daemon `process.exit(1)` → LaunchAgent restarts (single recovery path)
- [ ] Schema migrations are forward-only via a `meta(schema_version)` row + ALTER blocks at boot
- [ ] No install verb; README documents the manual symlink + `launchctl bootstrap` steps and the plist template lives at `plist/arthack.keeperd.plist`
- [ ] Explicitly dropped from scope: prise/env-var integration, multi-session-per-job lineage, plans/planctl_mutations, name scraping, harness_meta, transcript tailing, UDS fan-out, kernel watchers

## Early proof point

Task that proves the approach: `fn-1-keeper-reducer-v1.7` (end-to-end integration test). If it fails: the wake-worker → reducer path is the most novel piece — fall back to driving `drain()` directly from a periodic `setInterval` (slow but correct) while debugging the Worker / `data_version` integration.

## References

- `/Users/mike/code/arthack/apps/hookctl/hooks/hooks-tracker.py` — reference (NOT template) for events DDL, hook main body, reducer state-machine outline
- `/Users/mike/code/arthack/apps/jobctl/` — reference for what to drop (UDS server, in-memory Store, RPC verbs, snapshot pump, 12 namespaces — all out of v1 scope)
- `/Users/mike/code/arthack/system/launchagents/Library/LaunchAgents/arthack.jobctl.run-server.plist` — canonical LaunchAgent template
- `/Users/mike/docs/jobctl-and-hooks-tracker-primer.md` — onboarding doc for the old system
- [bun:sqlite docs](https://bun.com/docs/runtime/sqlite)
- [Bun Workers docs](https://bun.com/docs/runtime/workers)
- [SQLite PRAGMA reference](https://sqlite.org/pragma.html) — `data_version`, `busy_timeout`, journal modes
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)

## Docs gaps

- **`/Users/mike/code/keeper/README.md`**: create fresh — what keeper is, explicit non-goals, install/uninstall, architecture, inspect commands (covered by task 8)
- **`/Users/mike/code/keeper/CLAUDE.md`**: create fresh — internal codebase map for AI agents, event-sourcing invariants, "DO NOT" list (covered by task 8)
- **`/Users/mike/docs/jobctl-and-hooks-tracker-primer.md`**: add a "See also: keeper" callout — **deferred to post-v1** (the two systems coexist; the primer doesn't need to know about keeper until keeper ships)

## Best practices

- **`PRAGMA busy_timeout` is connection-local — set on every open:** the hook opens a fresh connection per invocation; without `busy_timeout = 5000` it defaults to 0 and any writer contention with the daemon surfaces as `SQLITE_BUSY` instead of a wait. [SQLite WAL docs]
- **Use `BEGIN IMMEDIATE` for write transactions:** a `BEGIN` that starts read-only and later upgrades to write bypasses `busy_timeout` and fails with `SQLITE_BUSY`. Pair with `db.transaction(fn)` for atomicity. [berthub.eu]
- **Update projection + advance cursor in the same transaction:** the textbook "exactly once per event" pattern; rollback covers both on crash and boot drain re-folds idempotently
- **Each Bun Worker needs its own `Database` connection:** handles are thread-affine and not structured-cloneable; pass the path string, open fresh in the worker
- **`data_version` is connection-local and reflects what *that* connection can see:** stay in autocommit (no `BEGIN`) in the watcher worker, or the counter freezes for that connection
- **FSEvents/kqueue drop same-process writes on macOS:** confirmed in 2026 — `PRAGMA data_version` polling is the correct primitive on darwin, not `chokidar` or `fs.watch`. WAL writes go to `.db-wal`, which naive watchers miss entirely. [Watchexec FSEvents notes]
- **Use absolute paths in LaunchAgent `ProgramArguments`:** launchd does not source shell rc, so `bun` won't be found by name; hard-code `/opt/homebrew/bin/bun` and set `EnvironmentVariables.PATH` explicitly
- **`KeepAlive` as a dict with `SuccessfulExit = false`, `ThrottleInterval = 10`:** bare `KeepAlive = true` produces a restart storm on misconfig; the dict form respects clean `exit(0)` and the throttle prevents log-spam
- **Keep the hook's import graph minimal:** Bun cold start is ~30ms; importing only `bun:sqlite` + project-local files keeps every hook invocation tight (matters at scale and on the SessionEnd 1.5s timeout)
- **`chmod 600` on the DB + WAL files:** they may contain sensitive context from Claude Code sessions

## Snippet context

Bundles inherited or curated for this epic:
- `sketch/keeper-reducer-v1` — author-tier sketch handoff (architecture brief covering runtime choice, data shapes, reducer logic, wake mechanism, boot flow, and explicit non-goals)
