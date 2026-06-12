keeper — event-sourced Claude Code control-data daemon (Bun + bun:sqlite).

The hook plugin appends one per-pid NDJSON line per Claude Code hook invocation
(lock-free, no SQLite open); the `keeperd` daemon's events-log ingester lands each
line as one `events` row, folds those events into the `jobs`/`epics` projections,
and serves them read-only over a UDS subscribe socket. The `events` table is the
canonical fold source, so re-fold determinism holds by construction. System map,
rationale, and incident history: `README.md` `## Architecture` and `.planctl/` specs.

## Repo facts

- **`AGENTS.md` is a symlink to this file.** Edit in place; never `rm`+recreate.
- **The repo root is the Claude plugin** (`claude --plugin-dir ~/code/keeper`). The
  HOOK plugin has exactly ONE manifest (`./.claude-plugin/plugin.json`) and ONE
  `./hooks/hooks.json` — never duplicate either, and never add a
  `~/.claude/plugins/keeper` symlink (it double-registers the hook).
- **Forward-facing advice only** in comments and docs: state current behavior and
  invariants, not change history (which lives in the diff). Full rule:
  `promptctl render code-comment-style`.

## Event-sourcing invariants

- **Cursor + projection advance in ONE `BEGIN IMMEDIATE` transaction** — the fold
  writes the projection AND bumps `reducer_state.last_event_id` together. Splitting
  them breaks the exactly-once-per-event guarantee.
- **Re-fold determinism is sacred.** A from-scratch re-fold must reproduce
  byte-identical rows. Inside a fold: build derived arrays from stable total-order
  sorts (never append), and NEVER read wall-clock (`Date.now()`), env vars, the
  filesystem, or process liveness — use the event's `ts`. Only producers probe it.
- **Never throw inside a fold.** Malformed `data` folds to a safe value and the
  cursor still advances; a throw rolls back the cursor and wedges the reducer. Schema
  defaults match the zero-event projection, so an empty re-fold reproduces the rows.

## Hook rules

- **Always exit 0.** A non-zero exit can fail-closed the human's session. On a HARD
  append failure the hook writes a per-pid dead-letter and still exits 0 (losing one
  row is acceptable; wedging the agent is not).
- **No third-party deps, and NO `bun:sqlite`/`src/db.ts`.** The hook never opens
  SQLite — a stray `db.ts` symbol re-drags the 6.5k-line module and erases the
  cold-start win. Keep imports to `node:fs`/`node:os`/`node:path`, the dep-free
  `src/dead-letter.ts` serializers, and the pure `src/derivers.ts`/`exec-backend.ts`
  helpers. It never opens the DB, so it never migrates or probes schema.
- **Scraping is scoped.** On `SessionStart` only: parent claude `--name`/`-n` +
  `CLAUDE_CONFIG_DIR` (single-level ppid, no walking). On every event: `ZELLIJ*`
  plus `TMUX`/`TMUX_PANE`/`KEEPER_TMUX_SESSION` env reads (synchronous, no
  fork/fs). No other scraping, no env read in a fold.

## Migrations

- **Forward-only** via `meta(schema_version)`; non-idempotent steps are
  version-guarded. The **daemon is the sole migrator.** Runtime downgrade guard:
  `migrate()` throws BEFORE its transaction opens when the stored `schema_version`
  exceeds the binary's `SCHEMA_VERSION`, so an old binary never downgrades a newer DB.
- **When you bump `SCHEMA_VERSION`, add the version to `SUPPORTED_SCHEMA_VERSIONS`
  in `keeper/api.py` in the SAME commit** — a hard whitelist; an unlisted version
  fails every keeper-py read. `test/schema-version.test.ts` enforces this.

## Writes are tightly scoped — DO NOT widen them

- **No general write path into the reducer.** The socket carries `query` (read) and
  `rpc` (mutate). RPC may write ONLY five surfaces, each round-tripping through a
  synthetic event so a re-fold sees it: `replay_dead_letter`, `retry_dispatch`,
  `set_autopilot_paused`, `set_autopilot_mode`, `set_epic_armed`. RPC handlers MUST
  NOT write `jobs`/`epics`/etc directly (folds still mutate their own projections).
- **Plans are READ-ONLY.** The plan worker folds `.planctl/{epics,tasks}` snapshots
  into `epics`; every field is read-only end to end. No RPC writes a plan field.
- **Sole-writer rules.** The hook writes ONLY per-pid NDJSON files, never the DB. The
  events-log ingester is the sole writer of hook-sourced `events` rows; main writes
  all synthetic events + `dead_letters` + the replay path; workers feed via main.

## Process & DB-watch invariants

- **No kernel watchers on keeper's OWN DB.** `fs.watch`/FSEvents/kqueue drop
  same-process and WAL writes on macOS — detect DB changes via `PRAGMA data_version`
  polling on a read-only connection only. Carve-out: `@parcel/watcher` on EXTERNAL
  trees and kqueue/pidfd on EXTERNAL process descriptors are fine.
- **No in-process self-heal.** Any unrecoverable error calls `fatalExit` →
  `process.exit(1)`; the LaunchAgent restarts the single recovery path. Never respawn
  a worker in-process. Carve-out: closing a stale/EPIPE UDS client connection is
  connection hygiene, not self-heal.

## Worker contract

- **`isMainThread` guard** — a plain import of the module is inert.
- **Own `openDb` connection** (read-only for readers); never share main's.
- **`prepareStmts:false` on connections that use no prepared statements** — every
  worker destructures `{db}` only (main is the sole `stmts` consumer), so preparing
  statements at open is wasted cost and a needless schema-dependence at the raciest
  moment of boot.
- **Bounded initial-open retry for the transient boot class** — `openDb` retries the
  raciest boot-open failures (a fresh `Database` per attempt, sync backoff, bounded
  count) and still fails loud after exhaustion. This is boot robustness, not
  self-heal — `no such table` is retryable ONLY at initial open on a known-migrated
  path; everywhere else it is fatal.
- **Typed messages** — `{ kind }` worker→main, `{ type }` main→worker.
- **Supervisor-owned lifecycle** — main spawns after migrate+boot-drain and is the
  only one that terminates (`shutdown` → await close → terminate). A worker owning an
  external resource MUST release it in its own shutdown handler.

## Test isolation

Every test that spawns the real hook MUST sandbox ALL FIVE state paths under the
per-test tmpdir: `KEEPER_DB`, `KEEPER_DEAD_LETTER_DIR`, `KEEPER_DROP_LOG`,
`KEEPER_RESTORE_FILE`, `KEEPER_BACKSTOP_LOG`. Never `{ ...process.env, KEEPER_DB }`
— it strands the others at production defaults and pollutes the real feed. Build the
env via the shared `sandboxEnv(...)` in `test/helpers/sandbox-env.ts`; pass
`includeZellij: true` for the sixth `KEEPER_ZELLIJ_EVENTS_DIR` on hook-spawn tests.

**Two test helpers, two jobs.** `sandboxEnv` is for process-spawn isolation (any
test launching the real hook/daemon/CLI subprocess). The template-DB helper in
`test/helpers/template-db.ts` (`freshDb()` / `freshDbFile()`) is for pure IN-PROCESS
unit tests needing a migrated schema — a fast `Database.deserialize` clone instead
of re-running the full `migrate()` ladder. Keep a real `openDb` only when the test
EXERCISES migration (`db.test.ts`) or owns a subprocess.

**Two tiers.** Default `bun test` runs the FAST tier only and skips process-level
integration files. **`bun run test:full` is mandatory before landing any change
touching daemon / worker / db / hook / git process paths or any slow-tier file** —
the fast run does NOT cover those. When in doubt, run `test:full`.

**Poll, don't sleep.** Any assertion waiting on async worker/daemon state uses
`retryUntil` (`test/helpers/retry-until.ts`), never a fixed `Bun.sleep` — a fixed
sleep can silently resolve under host contention and flake the suite.

## Autopilot

The server-side reconciler dispatches workers against ready plan work. It **boots
paused** and is level-triggered on `PRAGMA data_version`. An unpaused autopilot that
"does nothing" is almost always a readiness gate firing correctly — the gates live in
`src/readiness.ts` (`computeReadiness`) and the `[paused]` banner is authoritative.
Close-row completion is liveness-gated in `src/readiness.ts` (done AND closer idle),
not reap-side; the completion reap inherits done-AND-idle from that verdict.
For modes, caps, the cooldown, and completion-reap, read `src/autopilot-worker.ts`,
`src/readiness.ts`, and README.

## Out of scope

prise/env-var integration, multi-session lineage, harness_meta.
