keeper — event-sourced Claude Code control-data daemon (Bun + bun:sqlite).

The hook plugin writes one `events` row per Claude Code hook invocation; the
`keeperd` daemon folds those events into the `jobs`/`epics` projections and
serves them read-only over a UDS subscribe socket. For the system map — event
log, reducer, worker threads, wire protocol — see `README.md` `## Architecture`.

**AGENTS.md symlink** — `AGENTS.md` is a symlink to this file
(`ln -s CLAUDE.md AGENTS.md`). Edit this file in place; never `rm`+recreate it.

**Plugin layout** — the repo root is itself the Claude plugin, loaded via
`claude --plugin-dir ~/code/keeper`. There is exactly ONE manifest
(`./.claude-plugin/plugin.json`) and ONE `./hooks/hooks.json` — never duplicate
either under a subtree, and never restore the retired `~/.claude/plugins/keeper`
symlink alongside the `--plugin-dir` load (double-registers the hook,
double-writes every event).

## Design stance

**Design the server for the ideal architecture; do not nickel-and-dime against
client churn.** The server (event log, reducer, projections, schema, RPC
surface) is the durable source of truth; clients (the `keeper` CLI subcommands,
future consumers) are cheap to change. Schema bumps, column renames, and enum
widenings are routine — never bend the server to preserve a lossy or misleading
shape because consumers already read it. If the event log knows a fact, the
projection surfaces it natively (full enum, raw timestamp); collapsing to a
binary or a derived label is the renderer's job, and only if it ever needs to.

## Event-sourcing invariants

- **Cursor + projection advance in the SAME `BEGIN IMMEDIATE` transaction.** Each
  fold writes the projection (`jobs` / `epics` / `usage` / `git_status` /
  `profiles` / `file_attributions` / `dispatch_failures`) AND bumps
  `reducer_state.last_event_id` in one transaction. A crash mid-fold rolls back
  both; boot drain re-folds idempotently. This is the exactly-once-per-event
  guarantee — never split the two writes across transactions.
- **Re-fold determinism is sacred.** Every projection-driving fact lives in the
  immutable event log; nothing is written straight to `jobs`/`epics`. A re-fold
  from scratch (rewind cursor, `DELETE FROM` the projections, re-drain) must
  reproduce byte-identical rows — so all derived arrays/links are built from
  stable total-order sorts (never append), and NOTHING inside a fold may read
  wall-clock (`Date.now()`), env vars, the filesystem (`stat()`), or probe
  process liveness. Use the event's own `ts` for any time comparison. Hook-side
  derivers that stamp the sparse `events` columns are pure functions of the
  payload and are shared with the migration backfill so a re-derive converges.
- **Schema defaults match the zero-event projection.** Keep schema defaults and
  the reducer's no-op / seed branches in sync, so a re-fold from an empty table
  reproduces the same rows.
- **A malformed `data` blob folds to a safe value and the cursor still advances.**
  Never throw inside the fold transaction — a throw rolls back the cursor and
  wedges the reducer.
- **One drain code path serves boot and steady-state** (`drainToCompletion` loops
  `drain()` until it returns 0); one event per transaction so the WAL writer lock
  releases between events. Boot may pass a stateless `DrainOptions` to gate a real
  OS-level post-COMMIT yield (the bounce-window mitigation — WAL has no writer
  FIFO fairness, so without a true sleep a contending hook's `busy_timeout` retry
  loses the race and dead-letters). The sleep lives in `drain` AFTER `applyEvent`
  returns, never inside a fold. A forked boot drain is forbidden; pacing is one
  shared loop with a per-call knob. End-of-boot checkpoint is
  `wal_checkpoint(PASSIVE)`, never TRUNCATE (TRUNCATE waits on writers and starves
  a contending hook).
- **Sole-writer rules.** The hook is the sole writer of *hook* events and of
  per-pid NDJSON dead-letter files. Main is the sole writer of *synthetic*
  events (`TranscriptTitle`, `ApiError`, `InputRequest`, `EpicSnapshot` /
  `TaskSnapshot` / `EpicDeleted` / `TaskDeleted`, `UsageSnapshot` /
  `UsageDeleted`, `Killed`, `GitSnapshot` / `GitRootDropped` / `Commit`,
  `DispatchFailed` / `DispatchCleared`), of the `dead_letters` operational
  sidecar, and of the dead-letter replay path. The server-worker writes only
  the `approval` field on external `.planctl` JSON (atomic temp+rename) and
  bridges `replay_dead_letter`, `set_autopilot_paused`, and `retry_dispatch` to
  main — it never writes the event log itself. Producer workers (including the
  autopilot reconciler) feed the log only via main's writable connection; they
  never write the DB.
- **Producer-only liveness probing.** The boot seed sweep and the exit-watcher
  worker are the ONLY places that probe liveness (`kill(pid,0)`, kqueue, pidfd,
  `(pid, start_time)` recycle check). Folds NEVER re-probe — a re-probe inside a
  fold would break re-fold determinism.
- **PRAGMAs are connection-local** — `applyPragmas` runs on every `openDb` (each
  worker's read-only connection, the hook's fresh per-invocation connection).
  Without `busy_timeout` a connection defaults to 0 and contention surfaces as
  `SQLITE_BUSY` instead of a wait.
- **Migrations are forward-only** via `meta(schema_version)` + the ALTER slot in
  `migrate()`. Non-idempotent steps (backfill, destructive DROP) MUST be
  version-guarded. The daemon is the SOLE migrator; the hook opens with
  `{ migrate: false }`. **When you bump `SCHEMA_VERSION`, add the new version to
  keeper-py's `SUPPORTED_SCHEMA_VERSIONS` frozenset in `keeper/api.py` in the
  SAME change** — the Python reader (used by `jobctl commit-work`) is a hard
  whitelist, not a floor/ceiling, and gates loud on any unrecognized version,
  failing *every* `commit-work` on the host until updated. Additive bumps
  keeper-py never reads still must be listed; `test/schema-version.test.ts`
  enforces it.
- **Commit discharge is content-aware (schema v45 / fn-664.2).** The
  `GitSnapshot` payload's `dirty_files[]` carries per-file
  `{worktree_oid, index_oid, worktree_mode}` (the filter-correct
  `git hash-object` of the worktree bytes — WITHOUT `--no-filters`, so
  clean/CRLF filters match the stored blob — plus porcelain v2 `hI` / `mW`,
  both free off the parse), all frozen at producer time so a re-fold is
  deterministic. The `Commit` payload's `files[]` carries per-file
  `{path, blob_oid, committed_mode}` (the porcelain `mI` mode + new blob
  oid lifted off `git diff-tree -r --no-commit-id <oid>` — `null` on
  deletion / parse-miss). `foldCommit` reads back the file's stored
  `(worktree_oid, worktree_mode)` from its `file_attributions` row (written
  by the latest GitSnapshot fold's pass-1 / pass-2 UPSERT + post-pass
  refresh — pure event-derived, in-tx) and stamps `last_commit_at` ONLY
  when the four axes are all non-null AND `blob_oid === worktree_oid && committed_mode === worktree_mode`. The four discharge READ predicates
  (`projectGitStatus` passes 2/3/4) are byte-identical to pre-v45 — only
  the WRITE site changed. ANY null axis falls back to the legacy
  UNCONDITIONAL timestamp discharge (the same path historical events
  take, so a cursor=0 re-fold over the pre-v44/v45 log reproduces
  byte-identical projections). This fixes the stage→re-edit→commit
  orphan: the worktree diverged from the staged-then-committed bytes,
  the gate suppresses discharge, and the editing session keeps its
  attribution claim. Symmetric across per-session and global discharge
  (the worktree oid is a per-file fact, not per-session). A chmod-only
  dirty file (equal blob, different mode) is also caught — content-equality
  alone would have wrongly discharged it.

## DO NOT

- **No general write path into the reducer.** The socket carries `query` (read,
  unchanged and read-only) and `rpc` (mutate) frames — no reactor. RPC writes are
  scoped to exactly four surfaces: (1) the `approval` field on `.planctl` files
  (`set_task_approval` / `set_epic_approval`, atomic temp+rename), (2) the
  delayed-real-event replay path (`replay_dead_letter`), (3) the autopilot
  in-memory pause flag (`set_autopilot_paused`), and (4) the autopilot
  failure-clear path (`retry_dispatch`, which appends a `DispatchCleared`
  synthetic event and lets the reducer DELETE the matching `dispatch_failures`
  row on the next drain). RPC handlers MUST NOT write `jobs`/`epics`/
  `dispatch_failures` directly — approval changes round-trip through the
  plan-worker watcher → `EpicSnapshot`/`TaskSnapshot` → reducer, and retry
  round-trips through main → synthetic event → reducer, so a re-fold sees them
  all. *Why only these four:* approval is the one piece of human state with no
  hook to attach it to; replay recovers events the hook failed to insert;
  autopilot pause is human-intent state with no hook attachment point and is
  deliberately in-memory only (boots paused, never persisted); retry clears a
  sticky failure (no auto-retry — every cleared failure is an explicit human
  decision). Everything else is the planner's/worker's job or belongs to the
  hook.
- **No kernel file watchers ON KEEPER'S OWN SQLite DB** (`fs.watch`, FSEvents,
  kqueue, chokidar) — they drop same-process writes and miss WAL writes on macOS.
  Use `PRAGMA data_version` polling on a read-only autocommit connection as the
  only DB-change primitive. *Carve-out (files):* native `@parcel/watcher` on
  *external* trees written by other processes IS permitted (transcript files,
  `.planctl` trees); treat an event (or a drop-overrun `err`) as "go look," never
  as the data — always `fstat` + safe-parse. *Carve-out (processes):* kqueue
  `EVFILT_PROC|NOTE_EXIT` / `pidfd_open`+`epoll` on EXTERNAL process descriptors
  is permitted (exit-watcher), with a post-register `kill(pid,0)` probe and
  `(pid, start_time)` identity guarding pid recycling.
- **No third-party deps in the hook.** Keep `plugin/hooks/events-writer.ts`'s
  import graph to `bun:sqlite` + local files only — Bun cold start is ~30ms and
  the SessionEnd hook has a 1.5s timeout budget.
- **The hook must always exit 0.** A non-zero exit can fail-closed the human's
  session. Losing one event row is acceptable; wedging the agent is not. On a
  failed INSERT the hook writes a per-pid NDJSON dead-letter file (recoverable via
  `replay_dead_letter`) and still exits 0. Never let a parse/DB failure propagate;
  log to stderr only.
- **Test isolation: never spread `...process.env` for state-bearing vars.** Every
  test that spawns the real hook MUST route through a shared sandboxed base-env
  helper overriding ALL three state paths (`KEEPER_DB`, `KEEPER_DEAD_LETTER_DIR`,
  `KEEPER_DROP_LOG`) under the per-test `tmpDir`. A bare `{ ...process.env,
  KEEPER_DB: ... }` strands the other two at production defaults and pollutes the
  user's real `~/.local/state/keeper/` feed. Apply the sandbox AFTER any
  `undefined`-clears-key loop so a caller can't re-open the leak.
- **No in-process self-heal.** Any unrecoverable error (including any worker's
  `error` event) calls `fatalExit` → `process.exit(1)`; the LaunchAgent restarts
  the single recovery path. Never respawn a worker in-process. The producer
  workers' FSEvents drop-recovery re-scan is data recovery, not self-heal — the
  subscription stays live and a re-scan throw is swallowed to stderr.
- **Plans are READ-ONLY except the `approval` field.** The plan worker watches the
  `.planctl/{epics,tasks}` trees plus the `.planctl/state/tasks/` runtime-status
  sidecar and folds snapshots into `epics`. The only permitted plan write is the
  `approval` RPC pair above; no other field is RPC-writable and the socket carries
  no other plan command surface.
- **Scraping is scoped, not general.** Transcript tailing lives in the daemon's
  transcript worker only (never the hook). The hook MAY scrape the parent claude
  process's `--name`/`-n` and read `CLAUDE_CONFIG_DIR` — but ONLY on
  `SessionStart`, ONLY single-level `process.ppid` (no PPID-walking), frozen into
  that one event. FORBIDDEN: periodic/other-event scraping, multi-session lineage,
  any other env read, and any env read inside a fold.
- **Out of scope:** prise/env-var integration, multi-session lineage, harness_meta.

## Worker contract

Every keeper Worker thread follows the same durable contract:

- **`isMainThread` guard** — a plain `import` of the worker module is inert.
- **Own `openDb` connection** (read-only for readers); never shares main's.
- **Typed message protocol** — `{ kind }` for worker→main, `{ type }` for
  main→worker.
- **Supervisor-owned lifecycle** — main spawns each worker after migrate + boot
  drain and is the only one that terminates it (`{ type: "shutdown" }`, await
  `close`, then `terminate`). A worker owning an external resource (socket, lock
  file, watcher subscription, re-scan timer, kqueue/pidfd fd) MUST release it in
  its own shutdown handler — `terminate()` alone leaks it.
- **No in-process self-heal** — a worker's `error` event escalates to `fatalExit`.

## Autopilot dispatch gates

Operational behavior of the server-side reconciler (`src/autopilot-worker.ts`).
An unpaused autopilot that "does nothing" is almost always one of these gates
firing correctly — check them before concluding it is broken:

- **Won't dispatch into a dirty repo.** `computeReadiness` predicate 6.5
  (`src/readiness.ts`, block reason `git-uncommitted`) suppresses every dispatch
  whose target repo has `git_status.dirty_count > 0` — so a spawned worker can
  never commit unrelated uncommitted changes. The target is usually keeper
  itself, dirtied by your own edits or a not-yet-committed `.planctl` approval
  chore. Confirm: `git status` + `SELECT project_dir, dirty_count FROM
  git_status`.
- **Level-triggered on `PRAGMA data_version`.** The worker reconciles only on a
  DB write (a hook event, a fold). `set_autopilot_paused {paused:false}` (play)
  additionally kicks one cycle, and one cycle runs at boot — but absent those, a
  quiescent DB leaves ready work undispatched until the next incidental write.
- **The `[paused]` banner in `keeper autopilot` is NOT authoritative.** There is
  no `get_autopilot_paused` query; the viewer always opens showing `[paused]`
  regardless of the worker's real flag. To confirm the real state, watch for a
  dispatch (a new live `jobs` row / `dispatch_failures`), not the banner.
- **Boots paused (safety default), one-at-a-time stagger.** The flag is in-memory
  only and never persisted; `confirmRunning` serializes launches, so dispatch is
  paced, not a burst.
