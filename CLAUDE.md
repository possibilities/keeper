keeper — event-sourced Claude Code control-data daemon (Bun + bun:sqlite).

The hook plugin writes one `events` row per Claude Code hook invocation; the
`keeperd` daemon folds those events into the `jobs` (and `epics`) projections and
serves them read-only over a UDS subscribe socket. For the system map — the
event log, reducer, the five worker threads, and the wire protocol — see
`README.md` `## Architecture`.

**AGENTS.md symlink** — `AGENTS.md` is a symlink to this file
(`ln -s CLAUDE.md AGENTS.md`). Edit this file in place; never `rm`+recreate it.

## Event-sourcing invariants

- **Cursor + projection advance in the SAME `BEGIN IMMEDIATE` transaction.** Every
  fold writes the projection (`jobs`/`epics`) and bumps
  `reducer_state.last_event_id` in one transaction. A crash mid-fold rolls back
  both; boot drain re-folds idempotently. This is the exactly-once-per-event
  guarantee — never split the two writes across transactions.
- **Schema defaults match the zero-event projection.** Keep schema defaults and
  the reducer's no-op / seed branches in sync, so a re-fold from an empty table
  reproduces the same rows.
- **One drain code path serves boot and steady-state** (`drainToCompletion` loops
  `drain()` until it returns 0). Do not add a separate boot path.
- **Drain folds one event per transaction** so the WAL writer lock releases
  between events and hook inserts never starve.
- **A malformed `data` blob (or stored JSON array) skips/folds to a safe value and
  the cursor still advances** — never throw inside the fold transaction; a throw
  rolls back the cursor and wedges the reducer.
- **The hook is the sole writer of *hook* events; main is the sole writer of
  *synthetic* events.** Every projection-driving fact lives in the immutable event
  log — never written straight to `jobs`/`epics` — so a re-fold from scratch
  (rewind cursor, `DELETE FROM jobs`/`epics`, re-drain) reproduces byte-identical
  rows, including `epics` rows with their embedded `tasks` arrays (built from a
  stable sort, never append). The producer workers feed the log only via main's
  writable connection; they never write the DB. Synthetic events covered by
  this rule: `TranscriptTitle` (transcript worker), `EpicSnapshot` /
  `TaskSnapshot` / `EpicDeleted` / `TaskDeleted` (plan worker), `Killed`
  (boot seed sweep + live exit-watcher worker, gated by main's
  `(pid, start_time)` verifier before insert).
- **Producer-only liveness probing.** The seed sweep and the exit-watcher
  worker are the ONLY places that probe process liveness (`kill(pid,0)`,
  kqueue `EVFILT_PROC|NOTE_EXIT`, pidfd_open + epoll, `(pid, start_time)`
  recycle check). The reducer's `Killed` fold NEVER re-probes — it compares
  the event payload's `(pid, start_time)` against the persisted row only.
  A liveness re-probe inside a fold would break re-fold determinism (a
  from-scratch re-fold would see different OS state than the original run).
- **PRAGMAs are connection-local** — `applyPragmas` runs on every `openDb`,
  including each worker's read-only connection and the hook's fresh per-invocation
  connection. Without `busy_timeout` a connection defaults to 0 and contention
  surfaces as `SQLITE_BUSY` instead of a wait.
- **Migrations are forward-only** via the `meta(schema_version)` row + the ALTER
  slot in `migrate()`. Idempotent steps may run unguarded; a non-idempotent step
  (data backfill, destructive DROP) MUST be version-guarded so a re-run can't
  corrupt an already-migrated schema. Bump `SCHEMA_VERSION` only when adding an
  ALTER; never reduce it, never branch.

## DO NOT

- **No client mutations, no reactor, no write path through the socket.** The UDS
  server is read-only subscribe: a client may `query` and receive `result` +
  `patch` + `meta` frames, nothing more. The socket never carries a write/command
  into keeper, and consumers read the projections from SQLite directly. *Why:*
  keeper is a pure read fold over an append-only log — a write path would break
  the single-writer invariant the whole design rests on.
- **No kernel file watchers ON KEEPER'S OWN SQLite DB** (`fs.watch`, FSEvents,
  kqueue, chokidar). *Why:* they drop same-process writes and miss WAL writes on
  macOS. Use `PRAGMA data_version` polling on a read-only connection as the only
  DB change primitive, and keep that connection in autocommit (no `BEGIN`) or
  `data_version` freezes for it. **Carve-out (files):** native watching of
  *external* trees written by *other* processes IS permitted — the transcript
  files (`src/transcript-worker.ts`) and the `.planctl/{epics,tasks}` trees
  (`src/plan-worker.ts`), both via `@parcel/watcher`. Foreign-written files have
  no same-process blind spot and no `data_version`. Treat a watcher event (and a
  matched FSEvents drop-overrun `err`, "...must be re-scanned") as "go look",
  never as the data: always `fstat` + safe-parse / forward-tail the current file.
  A drop schedules a debounced, single-flight re-scan of the affected tree via the
  change-gated boot-scan primitive — never re-subscribe, never point a watcher at
  keeper's own DB. **Carve-out (processes):** kqueue with
  `EVFILT_PROC | NOTE_EXIT` (macOS) and `pidfd_open` + `epoll_wait` (Linux) are
  permitted on EXTERNAL PROCESS DESCRIPTORS — the exit-watcher worker
  (`src/exit-watcher.ts` + `src/exit-watcher-ffi.ts`) uses them to learn when a
  tracked Claude Code session pid exits. This is distinct from the file-watcher
  ban: a process descriptor is not a file, has no same-process write blind spot,
  and is the only kernel-supported mechanism for "tell me when this pid exits"
  (the alternative is N/2-ms-of-latency polling). The producer must still
  perform a post-register `kill(pid, 0)` probe to close the EV_ADD/pidfd_open
  ESRCH race, and the `(pid, start_time)` two-field identity guards against
  pid recycling.
- **No third-party deps in the hook.** Keep `plugin/hooks/events-writer.ts`'s
  import graph to `bun:sqlite` + local files only — Bun cold start is ~30ms and
  the SessionEnd hook has a 1.5s timeout budget.
- **The hook must always exit 0.** *Why:* a non-zero exit can fail-closed the
  human's session. Losing one event row is acceptable; wedging the agent is not.
  Never let a parse/DB failure propagate; log to stderr only.
- **No in-process self-heal.** Any unrecoverable error — including any worker's
  `error` event — calls `fatalExit` → `process.exit(1)` and the LaunchAgent
  restarts the single recovery path. Do not respawn a worker in-process. The
  producer workers' FSEvents drop-recovery re-scan is data recovery, not
  self-heal: the subscription stays live, nothing re-subscribes, and a re-scan
  throw is swallowed to stderr.
- **No prise/env-var integration, multi-session lineage, or harness_meta** — out
  of scope.
- **Plans are READ-ONLY**, like everything keeper serves. The plan worker watches
  the configured roots' `.planctl/{epics,tasks}` trees and folds snapshots into
  the `epics` projection (each epic embeds its tasks as a JSON array — no peer
  `tasks` collection or table) served over the same socket. FORBIDDEN: any plan
  WRITE path — the socket never carries a plan mutation, keeper never writes a
  `.planctl` file, and no command surface exists.
- **Transcript tailing is scoped to the daemon, never the hook.** keeperd's
  transcript worker MAY tail external transcript JSONL to produce priority-3
  `TranscriptTitle` events. FORBIDDEN: transcript reading in the hook (it stays
  payload-only) and any transcript use beyond the live `custom-title` supplement.
- **Name scraping is scoped, not general.** The hook MAY scrape the parent claude
  process's `--name`/`-n` via `ps` — but ONLY on `SessionStart`, ONLY single-level
  `process.ppid` (no PPID-walking), frozen into that one event's
  `events.spawn_name`. FORBIDDEN: ongoing/periodic scraping, scraping on other
  hook events, PPID-walking, and any multi-session lineage from process names.

## Worker contract

Every keeper Worker thread follows the same durable contract:

- **`isMainThread` guard** — a plain `import` of the worker module is inert.
- **Own `openDb` connection** (read-only for readers); a worker never shares
  main's connection.
- **Typed message protocol** — `{ kind }` for worker→main events, `{ type }` for
  main→worker commands.
- **Supervisor-owned lifecycle** — main spawns each worker after migrate + boot
  drain and is the only one that terminates it (post `{ type: "shutdown" }`, await
  `close`, then `terminate`). A worker owning an external resource (socket, lock
  file, watcher subscription, re-scan timer, kqueue/pidfd fd) must release it
  in its own shutdown handler — `terminate()` alone leaks it. The exit-watcher
  worker specifically owns its kqueue (macOS) / pidfd+epoll (Linux) fd and any
  registered pidfds; all must be closed in the worker's shutdown handler.
- **No in-process self-heal** — a worker's `error` event escalates to `fatalExit`;
  workers never respawn themselves or each other.
