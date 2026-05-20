keeper — event-sourced Claude Code control-data daemon (Bun + bun:sqlite).

## What this is

Keeper writes one row per Claude Code hook invocation into a SQLite `events`
log (the hook plugin), then folds those events into a `jobs` projection via a
long-running Bun reducer daemon (`keeperd`). V1 was reducer-only; V2 adds the
first read surface: a **read-only NDJSON-over-UDS subscribe server** running as
keeperd's second Worker thread. A client sends a `query` and gets back an
ordered page of jobs that doubles as a live subscription — frozen membership,
live cells. The server is just another reader (own read-only connection, own
`data_version` poll); the client **write path stays forbidden** — no mutations,
no reactor, no socket-driven writes. Consumers may still read the `jobs` table
directly. See `README.md` for the elevator pitch, install, and non-goals; this
file is the in-codebase map for AI agents working in the repo.

**AGENTS.md symlink** — `AGENTS.md` is a symlink to this file
(`ln -s CLAUDE.md AGENTS.md`).

## Directory layout

- `src/` — daemon + reducer + SQLite layer.
  - `src/daemon.ts` — `keeperd` entry point (`import.meta.main` guard). Boot
    drain → spawn both workers (wake + server) → steady-state wake loop →
    SIGTERM clean exit. Exports `drainToCompletion(db, batchSize)` so tests
    drive boot drain without spawning the workers.
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
  - `src/server-worker.ts` — Worker thread; owns the read-only UDS subscribe
    server. Own read-only connection + `data_version` poll, a `keeperd.lock`
    PID-liveness ownership lock, and an NDJSON-over-UDS listener that serves
    `query → result` then fans changes out as per-entity `patch` frames. On each
    tick `diffTick` runs a SECOND pass: it groups subscriptions by filter
    signature, runs ONE descriptor-parameterized COUNT+membership-token per
    distinct filter, and emits a `meta` frame when a subscription's `total` or
    membership token moved (a row entered/left the filtered set) — backpressure-
    skipping a pending conn without advancing its `lastTotal`/`lastToken`, same
    discipline as the patch path. `runQuery` / `diffTick` route by collection
    name through a `CollectionDescriptor` (`src/collections.ts`) — no
    `jobs`-specific table / column / filter literal remains in either; a shared
    `resolveFilter` builds the WHERE once and threads it to both the page SELECT
    and the count so they can't drift. `isMainThread`-guarded.
  - `src/collections.ts` — the collection registry that namespaces the read
    surface. A `CollectionDescriptor` holds everything collection-specific
    (table, served columns, pk, the per-row `version` column the diff fires on,
    the sort allowlist + default sort, the filter-key → SQL-column map, and
    `jsonColumns` — the set of JSON-TEXT columns `decodeRow` parses into real
    values at the read boundary; no collection registers one today, so it is
    dormant generic infrastructure);
    `REGISTRY` / `getCollection` resolve a wire `collection` name to its
    descriptor, `selectByIds(db, descriptor, ids)` is the
    descriptor-parameterized by-id read (it `decodeRow`s its rows, so the diff
    path and the page SELECT agree on the decoded shape), and `countAndToken(db, descriptor,
    whereClause, params)` is the descriptor-parameterized count-query — the
    filtered-set `COUNT(*)` plus a `group_concat(pk)` membership token (ordered
    by pk, empty-set normalized to `total=0`/`token=""`) that the `meta` signal
    diffs on. `jobs` is the first/only descriptor today (its `filters` include
    the pk `job_id` for detail-page single-item subscribe). The descriptor is
    the SOLE identifier-injection gate: only its constants are interpolated into
    SQL; wire filter keys are resolved by map lookup, never interpolated.
  - `src/protocol.ts` — the wire protocol: `query` / `result` / `patch` / `meta`
    frame shapes (every frame names a `collection`; `result` / `patch` are
    generic over `Row`; `result` carries `total` — the filtered-set size; `patch`
    carries `row`; `meta` is a membership-staleness signal carrying the new
    `total` but no row; `query.collection` is required), NDJSON line framing
    (buffer-until-`\n` + max-line cap), and the page/diff helpers shared by the
    server worker.
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
| `src/server-worker.ts` | Worker default body | UDS subscribe server: query → result (+ `total`) + live patches + `meta` staleness signal, routed by collection |
| `src/collections.ts` | `getCollection()` / `selectByIds()` / `countAndToken()` | collection registry + descriptor-parameterized by-id read + count/membership-token query |
| `src/protocol.ts` | `encodeFrame()` / `LineBuffer` / frame types | NDJSON wire protocol (collection-namespaced `query`/`result`/`patch`/`meta` frames) |
| `plugin/hooks/events-writer.ts` | `main()` | one event row per hook |

## State machine

The reducer (`projectJobsRow` in `src/reducer.ts`) keys everything by
`session_id` (== `job_id` in v1):

- `SessionStart` → `INSERT OR IGNORE` a new job row (schema default
  `state='stopped'` — the zero-event reading).
- `UserPromptSubmit` → `state = 'working'` (skipped when already `ended`). Also
  carries `session_title` in its `data` blob: when present and **different from
  the persisted `title`**, the reducer `UPDATE`s `title` (last-write-wins
  against the persisted value). Unchanged title → no write (re-fold determinism:
  compare against the persisted `title`, not an accumulator). Runs
  event-agnostically (no `ended` guard).
- `Stop` → `state = 'stopped'` (skipped when already `ended`).
- `SessionEnd` → `state = 'ended'`, sticky thereafter (always lands).
- Everything else (PreToolUse, PostToolUse, Notification, Subagent*, unknown
  forward-compat events) → no jobs write; the cursor still advances.

`mode` and `title_history` were retired in schema v3 — `events.permission_mode`
is still recorded, but it is no longer projected into `jobs`, and titles are a
single live value with no history array.

## Event-sourcing invariants

- **Cursor + projection advance in the SAME transaction.** Every fold updates
  `jobs` and bumps `reducer_state.last_event_id` inside one `BEGIN IMMEDIATE`
  (`db.transaction`). A crash mid-fold rolls back both; boot drain re-folds
  idempotently. This is the exactly-once-per-event guarantee — never split the
  two writes across transactions.
- **Defaults match the zero-event projection.** A row inserted by
  `SessionStart` reads `state='stopped'`, `title=NULL` before any further event.
  Keep schema defaults and the reducer's no-op branches in sync.
- **One drain code path serves boot and steady-state.** `drainToCompletion`
  loops `drain()` until it returns 0; the boot catch-up and every wake use it.
  Do not add a separate boot path.
- **Drain folds one event per transaction** (batched read, per-event commit) so
  the WAL writer lock is released between events and hook inserts never starve.
- **A malformed `data` blob skips-and-logs** (`extractPermissionMode`); the
  cursor still advances so one bad row never wedges the reducer.
- **PRAGMAs are connection-local** — `applyPragmas` runs on every `openDb`,
  including the wake worker's and the server worker's own read-only connections.
  The hook opens a fresh connection per invocation; without `busy_timeout` it
  would default to 0 and any contention surfaces as `SQLITE_BUSY` instead of a
  wait.
- **`data_version` polling is every reader's change primitive** — not just the
  wake worker. The server worker re-reads its watched `jobs` rows on each
  `data_version` tick and diffs `last_event_id` to emit patches; the SAME tick
  also runs a per-filter COUNT+membership-token to emit `meta` staleness signals
  (frozen membership is unchanged — `meta` reports the count moved, it does not
  stream the new members). Like the wake worker the poll connection must stay in
  autocommit (no `BEGIN`), or `data_version` freezes for that connection. Never a
  `fs.watch`/FSEvents file watcher (see DO NOT).
- **Schema migrations are forward-only** via the `meta(schema_version)` row +
  the ALTER slot in `migrate()`. Steps must be idempotent — `addColumnIfMissing`
  / `dropColumnIfPresent` converge on the table's actual shape, so even a DROP is
  safe to re-run (it no-ops once gone). Bump `SCHEMA_VERSION` only when adding an
  ALTER; never reduce the version, never branch.

## DO NOT

- **No client mutations, no reactor, no write path through the socket.** The
  UDS server is **read-only subscribe**: a client may `query` and receive `result`
  + `patch` frames, nothing more. The socket never carries a write/command into
  keeper, the server never acts on `jobs` it serves, and consumers may still read
  the `jobs` projection from SQLite directly. (V1 had no socket at all; V2 added
  the read surface but kept the no-write-path fence.)
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
- **No in-process self-heal.** Any unrecoverable error — including either
  worker's `error` event — calls `fatalExit` → `process.exit(1)` → the
  LaunchAgent restarts the single recovery path. Do not respawn either worker
  in-process.
- **No prise/env-var integration, multi-session lineage, plans/planctl_mutations,
  name scraping, harness_meta, or transcript tailing** — all explicitly out of
  scope.

## Worker contract

Every keeper Worker thread follows the same durable contract — the pattern to
copy for the many workers to come:

- **`isMainThread` guard.** A plain `import` of the worker module is inert; the
  worker body only runs when spawned as a `Worker`.
- **Own `openDb` connection.** A worker never shares the main thread's
  connection. It calls `openDb` itself (read-only for readers) so `applyPragmas`
  runs connection-local and the connection's lifecycle is the worker's.
- **Typed message protocol.** Main↔worker traffic is small typed envelopes —
  `{ kind }` for worker→main events (e.g. `{ kind: "wake" }`), `{ type }` for
  main→worker commands (e.g. `{ type: "shutdown" }`).
- **Supervisor-owned lifecycle.** Main spawns the worker after migrate + boot
  drain, and is the only one that terminates it (post `{ type: "shutdown" }`,
  await `close`, then `terminate`). The worker does not decide when to die.
- **No in-process self-heal.** A worker's `error` event escalates to the
  supervisor's `fatalExit`; the LaunchAgent restarts the process. Workers never
  respawn themselves or each other.

Two archetypes:

- **Sensor worker** (like `wake-worker`): a thin read-only poller with no
  external endpoint and no durable state of its own — it observes and notifies.
- **Subsystem worker** (like `server-worker`): owns an external endpoint (the
  UDS) plus its own state (subscriptions, lock file, partial-write buffers). It
  must release its external resources inside its own shutdown handler —
  `terminate()` alone would leak the process-owned socket and lock.
