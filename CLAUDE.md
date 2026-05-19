keeper — event-sourced Claude Code control-data daemon (Bun + bun:sqlite).

## What this is

Keeper writes one row per Claude Code hook invocation into a SQLite `events`
log (the hook plugin), then folds those events into a `jobs` projection via a
long-running Bun reducer daemon (`keeperd`). V1 is reducer-only: no RPC, no UDS,
no UI — consumers read the `jobs` table directly. See `README.md` for the
elevator pitch, install, and non-goals; this file is the in-codebase map for AI
agents working in the repo.

**AGENTS.md symlink** — `AGENTS.md` is a symlink to this file
(`ln -s CLAUDE.md AGENTS.md`).

## Directory layout

- `src/` — daemon + reducer + SQLite layer.
  - `src/daemon.ts` — `keeperd` entry point (`import.meta.main` guard). Boot
    drain → spawn wake worker → steady-state wake loop → SIGTERM clean exit.
    Exports `drainToCompletion(db, batchSize)` so tests drive boot drain without
    spawning the worker.
  - `src/reducer.ts` — the fold. `drain(db, batchSize)` reads unfolded events
    and folds each via `applyEvent`, which wraps the projection write + cursor
    advance in ONE `BEGIN IMMEDIATE` transaction. Exports `DEFAULT_BATCH_SIZE`.
  - `src/db.ts` — schema bootstrap (`events`, `jobs`, `reducer_state`, `meta`),
    connection-local PRAGMAs (`applyPragmas`), prepared statements, and
    `openDb(path, { readonly })` / `resolveDbPath()`. Owns `SCHEMA_VERSION` and
    the forward-only `migrate()` block.
  - `src/wake-worker.ts` — Worker thread; own read-only connection polling
    `PRAGMA data_version` at ~50ms, posts contentless `{ kind: "wake" }`
    messages. `isMainThread`-guarded so a plain import is inert.
  - `src/types.ts` — `Event`, `Job`, `ReducerState` row shapes.
  - `src/version.ts` — `VERSION` constant.
- `plugin/` — the Claude Code hook plugin (symlink target for
  `~/.claude/plugins/keeper`).
  - `plugin/hooks/events-writer.ts` — the hook. Reads the payload on stdin,
    writes one `events` row, ALWAYS exits 0.
  - `plugin/hooks/hooks.json` — maps every tracked hook event to the writer.
  - `plugin/.claude-plugin/plugin.json` — plugin manifest.
- `plist/arthack.keeperd.plist` — LaunchAgent template (no install verb; see
  README for the manual symlink + `launchctl bootstrap`).
- `test/` — `bun test --isolate` suites (db, reducer, wake-worker, daemon,
  smoke, integration).

## Module entry points

| Module | Entry | Role |
|---|---|---|
| `src/daemon.ts` | `runDaemon()` (via `import.meta.main`) | process lifecycle |
| `src/reducer.ts` | `drain()` / `applyEvent()` | fold events → jobs |
| `src/db.ts` | `openDb()` / `resolveDbPath()` | schema + PRAGMAs + stmts |
| `src/wake-worker.ts` | Worker default body | `data_version` poll → wake |
| `plugin/hooks/events-writer.ts` | `main()` | one event row per hook |

## State machine

The reducer (`projectJobsRow` in `src/reducer.ts`) keys everything by
`session_id` (== `job_id` in v1):

- `SessionStart` → `INSERT OR IGNORE` a new job row (schema defaults
  `mode='act'`, `state='stopped'` — the zero-event reading).
- `UserPromptSubmit` → `state = 'working'` (skipped when already `ended`).
- `Stop` → `state = 'stopped'` (skipped when already `ended`).
- `SessionEnd` → `state = 'ended'`, sticky thereafter (always lands).
- ANY event carrying `permission_mode` → `mode = 'plan' | 'act'`, layered on
  top of whatever lifecycle write ran.
- Everything else (PreToolUse, PostToolUse, Notification, Subagent*, unknown
  forward-compat events) → no jobs write; the cursor still advances.

## Event-sourcing invariants

- **Cursor + projection advance in the SAME transaction.** Every fold updates
  `jobs` and bumps `reducer_state.last_event_id` inside one `BEGIN IMMEDIATE`
  (`db.transaction`). A crash mid-fold rolls back both; boot drain re-folds
  idempotently. This is the exactly-once-per-event guarantee — never split the
  two writes across transactions.
- **Defaults match the zero-event projection.** A row inserted by
  `SessionStart` reads `mode='act'`, `state='stopped'` before any further
  event. Keep schema defaults and the reducer's no-op branches in sync.
- **One drain code path serves boot and steady-state.** `drainToCompletion`
  loops `drain()` until it returns 0; the boot catch-up and every wake use it.
  Do not add a separate boot path.
- **Drain folds one event per transaction** (batched read, per-event commit) so
  the WAL writer lock is released between events and hook inserts never starve.
- **A malformed `data` blob skips-and-logs** (`extractPermissionMode`); the
  cursor still advances so one bad row never wedges the reducer.
- **PRAGMAs are connection-local** — `applyPragmas` runs on every `openDb`. The
  hook opens a fresh connection per invocation; without `busy_timeout` it would
  default to 0 and any contention surfaces as `SQLITE_BUSY` instead of a wait.
- **Schema migrations are forward-only** via the `meta(schema_version)` row +
  the ALTER slot in `migrate()`. Bump `SCHEMA_VERSION` only when adding an
  ALTER; never reduce, never branch.

## DO NOT

- **No UDS server / no RPC verbs.** Keeper has no socket. Consumers read the
  `jobs` projection from SQLite directly.
- **No kernel file watchers** (`fs.watch`, FSEvents, kqueue, chokidar). They
  drop same-process writes and miss WAL writes on macOS. `PRAGMA data_version`
  polling on a read-only connection is the only correct change primitive.
  Stay in autocommit (no `BEGIN`) in the watcher, or `data_version` freezes for
  that connection.
- **No third-party deps in the hook.** Keep `plugin/hooks/events-writer.ts`'s
  import graph to `bun:sqlite` + local files only — Bun cold start is ~30ms and
  the SessionEnd hook has a 1.5s timeout budget.
- **The hook must always exit 0.** Never let a parse/DB failure propagate a
  non-zero exit — that can fail-closed the user's session. Losing one event row
  is acceptable; wedging the agent is not. Log to stderr only.
- **No in-process self-heal.** Any unrecoverable error → `process.exit(1)` →
  the LaunchAgent restarts the single recovery path. Do not respawn the worker
  in-process.
- **No prise/env-var integration, multi-session lineage, plans/planctl_mutations,
  name scraping, harness_meta, or transcript tailing** — all explicitly out of
  v1 scope.
