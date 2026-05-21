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
    drain → spawn all three workers (wake + server + transcript) → steady-state
    wake loop → SIGTERM clean exit. Exports `drainToCompletion(db, batchSize)` so
    tests drive boot drain without spawning the workers. Main is also the SOLE
    `events` producer for synthetic rows: a `transcript-title` message from the
    transcript worker becomes a synthetic `TranscriptTitle` event inserted on the
    existing WRITABLE connection (via `stmts.insertEvent`), then `pumpWakes()`
    folds it — main never writes `jobs` directly, the title flows through the
    event log.
  - `src/reducer.ts` — the fold. `drain(db, batchSize)` reads unfolded events
    and folds each via `applyEvent`, which wraps the projection write + cursor
    advance in ONE `BEGIN IMMEDIATE` transaction. Exports `DEFAULT_BATCH_SIZE`.
    Seeds `jobs.title` from `spawn_name` at SessionStart and folds titles by
    precedence (`{spawn:1, payload:2, transcript:3}`, NULL=0) — a higher-priority
    source wins, a lower one never clobbers, comparing persisted
    `(title, title_source)` in-txn for re-fold determinism. The synthetic
    `TranscriptTitle` event folds at the priority-3 `'transcript'` source.
  - `src/db.ts` — schema bootstrap (`events`, `jobs`, `reducer_state`, `meta`),
    connection-local PRAGMAs (`applyPragmas`), prepared statements, and
    `openDb(path, { readonly })` / `resolveDbPath()`. Owns `SCHEMA_VERSION`
    (currently 5: v4 added `events.spawn_name` + `jobs.title_source`; v5 added
    `jobs.transcript_path`) and the forward-only `migrate()` block.
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
  - `src/transcript-worker.ts` — Worker thread; the priority-3 transcript-title
    producer. Recursively watches the EXTERNAL transcript tree
    (`~/.claude/projects`) via `@parcel/watcher` (keeper's first runtime dep, a
    native FSEvents-backed addon), forward-tails each changed JSONL with a
    deterministic line stream (byte-offset map keyed by path + partial-line
    buffer + read-to-EOF + truncation guard + malformed-skip + change-only emit,
    decoding through a per-file `StringDecoder('utf8')` so a multi-byte char
    split across a read boundary never corrupts), and on each `custom-title`
    line posts `{ kind: "transcript-title", sessionId, title }` to main. The
    worker is READ-ONLY and never writes the DB — main turns the message into a
    synthetic `TranscriptTitle` event (see State machine). The pure
    `TranscriptLineStream` core + `seedFromDb` are exported and drivable with no
    Worker or watcher; the watcher subscription is the owned external resource it
    `unsubscribe()`s in its shutdown handler. `isMainThread`-guarded.
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
    `jobs`'s served `columns` include `title` + `title_source` (read-only
    display/provenance — both OUT of `sortable`/`filters`).
  - `src/protocol.ts` — the wire protocol: `query` / `result` / `patch` / `meta`
    frame shapes (every frame names a `collection`; `result` / `patch` are
    generic over `Row`; `result` carries `total` — the filtered-set size; `patch`
    carries `row`; `meta` is a membership-staleness signal carrying the new
    `total` but no row; `query.collection` is required), NDJSON line framing
    (buffer-until-`\n` + max-line cap), and the page/diff helpers shared by the
    server worker.
  - `src/types.ts` — `Event`, `Job`, `ReducerState` row shapes (`Job` carries
    `transcript_path` — display/debug only, never sorted/filtered).
  - `src/version.ts` — `VERSION` constant.
- `plugin/` — the Claude Code hook plugin (symlink target for
  `~/.claude/plugins/keeper`).
  - `plugin/hooks/events-writer.ts` — the hook. Reads the payload on stdin,
    writes one `events` row, ALWAYS exits 0. On `SessionStart` ONLY it scrapes
    the parent claude argv's `--name`/`-n` into `events.spawn_name` via a
    `Bun.spawnSync(["ps",…])` of `process.ppid` (`spawnNameFromPpid`, wrapped
    try/catch → null so it never breaks exit-0; the `nameFromArgs` flag parser
    is exported + unit-tested). `main()` is `import.meta.main`-guarded so a
    plain import (tests) is inert.
  - `plugin/hooks/hooks.json` — maps every tracked hook event to the writer.
  - `plugin/.claude-plugin/plugin.json` — plugin manifest.
- `plist/arthack.keeperd.plist` — LaunchAgent template (no install verb; see
  README for the manual symlink + `launchctl bootstrap`).
- `test/` — `bun test --isolate` suites (db, reducer, wake-worker, daemon,
  smoke, integration, events-writer).

## Module entry points

| Module | Entry | Role |
|---|---|---|
| `src/daemon.ts` | `runDaemon()` (via `import.meta.main`) | process lifecycle |
| `src/reducer.ts` | `drain()` / `applyEvent()` | fold events → jobs |
| `src/db.ts` | `openDb()` / `resolveDbPath()` | schema + PRAGMAs + stmts |
| `src/wake-worker.ts` | Worker default body | `data_version` poll → wake |
| `src/server-worker.ts` | Worker default body | UDS subscribe server: query → result (+ `total`) + live patches + `meta` staleness signal, routed by collection |
| `src/transcript-worker.ts` | Worker default body / `TranscriptLineStream` | watch external transcript tree → tail `custom-title` → post `transcript-title` (priority-3 producer) |
| `src/collections.ts` | `getCollection()` / `selectByIds()` / `countAndToken()` | collection registry + descriptor-parameterized by-id read + count/membership-token query |
| `src/protocol.ts` | `encodeFrame()` / `LineBuffer` / frame types | NDJSON wire protocol (collection-namespaced `query`/`result`/`patch`/`meta` frames) |
| `plugin/hooks/events-writer.ts` | `main()` | one event row per hook |

## State machine

The reducer (`projectJobsRow` in `src/reducer.ts`) keys everything by
`session_id` (== `job_id` in v1):

- `SessionStart` → `INSERT OR IGNORE` a new job row (schema default
  `state='stopped'` — the zero-event reading). Also **seeds the title** from the
  event's `spawn_name` (the parent claude process's `--name`/`-n`, scraped by
  the hook): when present, the insert sets `title = spawn_name` /
  `title_source = 'spawn'` (priority 1); when NULL, `title`/`title_source` stay
  NULL (priority 0) and Tier 0 below seeds at the first prompt. The OR IGNORE
  no-ops on a duplicate SessionStart, so the seed lands only on first insert.
- `UserPromptSubmit` → `state = 'working'` (skipped when already `ended`). Also
  carries `session_title` in its `data` blob — the **priority-2 `'payload'`
  title source**. The reducer writes by **precedence** (`{spawn:1, payload:2,
  transcript:3}`, NULL `title_source` = 0): it `UPDATE`s `title` + `title_source`
  iff the incoming priority outranks the persisted one **or** ties it with a
  changed value. A lower-priority source never clobbers a higher one. Unchanged
  same-priority title → no write (re-fold determinism: compare against the
  persisted `(title, title_source)` read in-txn, not an accumulator). Runs
  event-agnostically (no `ended` guard).
- `TranscriptTitle` (**synthetic**, inserted by keeperd's main thread, not the
  hook) → carries `session_title` in its `data` blob — the **priority-3
  `'transcript'` title source** (the live transcript `custom-title` / `/rename`).
  Folds through the SAME precedence write as `UserPromptSubmit`, so it beats
  `payload`(2)/`spawn`(1) and a later/stale `payload` never clobbers it. It
  triggers no lifecycle write (the `default` branch ignores it for `state`).
- `Stop` → `state = 'stopped'` (skipped when already `ended`).
- `SessionEnd` → `state = 'ended'`, sticky thereafter (always lands).
- Everything else (PreToolUse, PostToolUse, Notification, Subagent*, unknown
  forward-compat events) → no jobs write; the cursor still advances.

**V3: keeperd is now also a producer.** V1/V2 the hook was the sole `events`
writer; V3 adds the transcript worker → main pipeline, where main inserts the
synthetic `TranscriptTitle` events above. The hook remains the only writer of
*hook* events; main is the only writer of *synthetic* events.

`mode` and `title_history` were retired in schema v3 — `events.permission_mode`
is still recorded, but it is no longer projected into `jobs`, and titles are a
single live value with no history array. Schema v4 added `events.spawn_name`
(the hook's SessionStart spawn-name scrape) and `jobs.title_source` (title
provenance/precedence), both nullable with no backfill. Schema v5 added
`jobs.transcript_path` (the absolute path to the session's transcript JSONL,
seeded from a SessionStart payload — display/debug only), nullable, NULL-backfill
on old rows.

## Event-sourcing invariants

- **Cursor + projection advance in the SAME transaction.** Every fold updates
  `jobs` and bumps `reducer_state.last_event_id` inside one `BEGIN IMMEDIATE`
  (`db.transaction`). A crash mid-fold rolls back both; boot drain re-folds
  idempotently. This is the exactly-once-per-event guarantee — never split the
  two writes across transactions.
- **Defaults match the zero-event projection.** A row inserted by
  `SessionStart` reads `state='stopped'` before any further event; `title` /
  `title_source` read NULL when the event carried no `spawn_name`, or
  `spawn_name` / `'spawn'` when it did (the SessionStart seed is the one
  non-NULL initial title). Keep schema defaults and the reducer's no-op /
  seed branches in sync.
- **One drain code path serves boot and steady-state.** `drainToCompletion`
  loops `drain()` until it returns 0; the boot catch-up and every wake use it.
  Do not add a separate boot path.
- **Drain folds one event per transaction** (batched read, per-event commit) so
  the WAL writer lock is released between events and hook inserts never starve.
- **A malformed `data` blob skips-and-logs** (`extractPermissionMode`); the
  cursor still advances so one bad row never wedges the reducer.
- **The hook is the sole writer of *hook* events; main is the sole writer of
  *synthetic* events.** Since V3 keeperd's main thread inserts synthetic
  `TranscriptTitle` rows (from the transcript worker's `transcript-title`
  message) on its existing writable connection via `stmts.insertEvent`, then
  `pumpWakes()`. A synthetic event id is allocated after the session's
  SessionStart in practice, so it folds at priority 3 over the lower-tier title.
  Because the title lives in the immutable event log — never written straight to
  `jobs` — a re-fold from scratch (rewind cursor, `DELETE FROM jobs`, re-drain)
  reproduces the identical `(title, title_source)`: synthetic events replay
  deterministically just like hook events. The transcript worker stays read-only;
  it never writes the DB.
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
- **No kernel file watchers ON KEEPER'S OWN SQLite DB** (`fs.watch`, FSEvents,
  kqueue, chokidar). They drop same-process writes and miss WAL writes on macOS.
  For the DB, `PRAGMA data_version` polling on a read-only connection is the only
  correct change primitive — stay in autocommit (no `BEGIN`) in the watcher, or
  `data_version` freezes for that connection. **Carve-out (V3):** native watching
  of *external* transcript files in keeperd (`src/transcript-worker.ts`, via
  `@parcel/watcher`) IS permitted — those files are written by *other* processes
  (Claude Code), so the same-process-write blind spot does not apply, and there
  is no `data_version` for a foreign file tree. Treat a watcher event as "go
  look", never as the data: always `fstat` + forward-tail from the stored
  byte-offset. This carve-out is for the external transcript tree ONLY — never
  point a file watcher at keeper's own DB.
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
  or harness_meta** — all explicitly out of scope.
- **Transcript tailing is scoped to the daemon, never the hook (V3).** keeperd's
  transcript worker MAY tail external transcript JSONL on a watch to produce
  priority-3 `TranscriptTitle` events. FORBIDDEN: transcript reading in the hook
  (`plugin/hooks/events-writer.ts` stays payload-only, `bun:sqlite` + local
  imports, exit-0) and any transcript use beyond the live `custom-title` title
  supplement.
- **Name scraping is scoped, not general.** The hook MAY scrape the parent
  claude process's `--name`/`-n` spawn name via `ps` — but ONLY on
  `SessionStart`, ONLY single-level `process.ppid` (no PPID-walking), and the
  result is frozen into the immutable `events.spawn_name` of that one event
  (the reducer seeds `jobs.title` from it). FORBIDDEN: ongoing/periodic name
  scraping, scraping on any other hook event, PPID-walking up the process tree,
  and any multi-session lineage inferred from process names. A future
  transcript-supplement source is a separate (priority-3) writer in the daemon,
  not more hook-side scraping.

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

Three archetypes:

- **Sensor worker** (like `wake-worker`): a thin read-only poller with no
  external endpoint and no durable state of its own — it observes and notifies.
- **Subsystem worker** (like `server-worker`): owns an external endpoint (the
  UDS) plus its own state (subscriptions, lock file, partial-write buffers). It
  must release its external resources inside its own shutdown handler —
  `terminate()` alone would leak the process-owned socket and lock.
- **Producer worker** (like `transcript-worker`): observes an external source (a
  watched file tree) and posts typed `{ kind }` messages that main turns into
  synthetic `events` rows — it FEEDS the log but never writes the DB itself
  (read-only or no DB connection at all; the write stays on main's connection).
  Like the subsystem worker it owns an external resource (the watcher
  subscription) it must release in its own shutdown handler. The
  source-of-truth-stays-on-main discipline keeps the event log re-fold
  deterministic.
