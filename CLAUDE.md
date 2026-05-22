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
directly. V3 adds a second producer worker (`plan-worker`) that folds the
configured roots' `.planctl/{epics,tasks}` trees into a single new read-only
`epics` projection — each epic embeds its tasks as a JSON-array `epics.tasks`
column (schema v7; the standalone `tasks` collection + table were collapsed
away) — served over the same socket as an additional collection, read-only end
to end, same fence as `jobs`. The plan trees are filesystem-synchronized: file
deletions retract projection state via synthetic tombstone events (live), and a
boot reconciliation sweep retracts anything deleted while the daemon was down.
See `README.md` for the
elevator pitch, install, and non-goals; this file is the in-codebase map for AI
agents working in the repo.

**AGENTS.md symlink** — `AGENTS.md` is a symlink to this file
(`ln -s CLAUDE.md AGENTS.md`).

## Directory layout

- `src/` — daemon + reducer + SQLite layer.
  - `src/daemon.ts` — `keeperd` entry point (`import.meta.main` guard). Boot
    drain → spawn all four workers (wake + server + transcript + plan) →
    steady-state wake loop → SIGTERM clean exit. Exports
    `drainToCompletion(db, batchSize)` so tests drive boot drain without spawning
    the workers. Main is also the SOLE `events` producer for synthetic rows: a
    `transcript-title` message from the transcript worker becomes a synthetic
    `TranscriptTitle` event; a `plan-epic`/`plan-task` message from the plan
    worker becomes a synthetic `EpicSnapshot`/`TaskSnapshot` event; and a
    `plan-epic-deleted`/`plan-task-deleted` tombstone message from the plan worker
    becomes a synthetic `EpicDeleted`/`TaskDeleted` event — each inserted
    on the existing WRITABLE connection (via `stmts.insertEvent`), then
    `pumpWakes()` folds it. Main never writes `jobs`/`epics` directly; the
    title, the plan snapshots, and the plan tombstones all flow through the event
    log.
  - `src/reducer.ts` — the fold. `drain(db, batchSize)` reads unfolded events
    and folds each via `applyEvent`, which wraps the projection write + cursor
    advance in ONE `BEGIN IMMEDIATE` transaction. Exports `DEFAULT_BATCH_SIZE`.
    Seeds `jobs.title` from `spawn_name` at SessionStart and folds titles by
    precedence (`{spawn:1, payload:2, transcript:3}`, NULL=0) — a higher-priority
    source wins, a lower one never clobbers, comparing persisted
    `(title, title_source)` in-txn for re-fold determinism. The synthetic
    `TranscriptTitle` event folds at the priority-3 `'transcript'` source. The
    synthetic `EpicSnapshot` event folds as an idempotent upsert into the `epics`
    projection (snapshot-replace by `epic_id` carried in `session_id`); the
    synthetic `TaskSnapshot` event folds into its PARENT epic's embedded `tasks`
    JSON-array via a read-modify-write — parse the stored array, splice the
    element by `task_id`, re-sort by a stable key (`task_number, task_id`),
    re-stringify, write once (all in JS inside the open transaction, no JSON1),
    bumping the epic's `last_event_id`/`updated_at` so the change `patch`es the
    parent. The synthetic `EpicDeleted`/`TaskDeleted` tombstone events fold as
    retractions (`retractPlanRow`): `EpicDeleted` is a `DELETE FROM epics`,
    `TaskDeleted` splices the element out of the parent epic's array — both
    idempotent no-ops on a missing target. A malformed stored array folds to `[]`
    INSIDE the transaction (never throw — a throw rolls back the cursor and wedges
    the reducer). All plan folds are re-fold deterministic, same as the title path.
  - `src/db.ts` — schema bootstrap (`events`, `jobs`, `epics`,
    `reducer_state`, `meta`), connection-local PRAGMAs (`applyPragmas`), prepared
    statements, and `openDb(path, { readonly })` / `resolveDbPath()` /
    `resolveConfig()` / `resolvePlanRoots()` (the plan-worker root resolver, fed
    by `~/.config/keeper/config.yaml` with a `KEEPER_CONFIG` override and a
    default `~/code`) / `resolveClaudeProjectsRoot()` (the transcript-worker watch
    root resolver, reading the SEPARATE `claude_projects_root` key from the SAME
    config doc — tilde-expanded, NOT existence-filtered, default
    `~/.claude/projects`; the two config keys fall back INDEPENDENTLY, so a
    malformed one never disturbs the other). Owns `SCHEMA_VERSION` (currently 7: v4 added
    `events.spawn_name` + `jobs.title_source`; v5 added `jobs.transcript_path`;
    v6 added the `epics` + `tasks` plan-projection tables; v7 collapsed the
    standalone `tasks` table into an embedded `epics.tasks` JSON-array column —
    a version-guarded (`schema_version < 7`) non-idempotent migration: ADD COLUMN
    `epics.tasks` → backfill via `json_group_array(json_object(...))` ordered
    `task_number, task_id` to MATCH the reducer fold sort → `DROP TABLE IF EXISTS
    tasks`, all in one transaction) and the forward-only `migrate()` block.
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
    producer. Recursively watches the EXTERNAL transcript tree (the
    `claude_projects_root` resolved on main via `resolveClaudeProjectsRoot()` and
    passed as `workerData.watchRoot`, default `~/.claude/projects`) via
    `@parcel/watcher` (keeper's first runtime dep, a
    native FSEvents-backed addon), forward-tails each changed JSONL with a
    deterministic line stream (byte-offset map keyed by path + partial-line
    buffer + read-to-EOF + truncation guard + malformed-skip + change-only emit,
    decoding through a per-file `StringDecoder('utf8')` so a multi-byte char
    split across a read boundary never corrupts), and on each `custom-title`
    line posts `{ kind: "transcript-title", sessionId, title }` to main. The
    worker is READ-ONLY and never writes the DB — main turns the message into a
    synthetic `TranscriptTitle` event (see State machine). On boot, AFTER
    `seedFromDb` seeds the change-gate AND after the watcher subscription resolves,
    it runs a one-shot **startup current-title fold** (`scanJobsForTitles` →
    `TranscriptLineStream.scanFile`): for each live job with a non-null
    `jobs.transcript_path` (schema v5, scoped via the projection — NOT a recursive
    watch-root enumeration), it scans that session's transcript from offset 0 to a
    once-snapshotted size, reusing the bounded-chunk / `StringDecoder` /
    partial-line / malformed-skip read path, and emits ONLY the current (last)
    `custom-title` per file. This makes a `custom-title` set while the daemon was
    down survive a restart (the live tail anchors each file at EOF on first sight
    and would otherwise miss it). The seeded `lastEmitted` change-gate suppresses
    an already-folded title (no duplicate event on restart); `scanFile` uses a
    transient decoder/buffer (it does NOT touch `pathState`), so the live tail's
    EOF-anchoring is unaffected and the scan runs to completion before any async
    watcher callback fires (no race). Per-file errors skip-and-log; the scan is
    non-fatal (never trips the subscribe `.catch` → `fatalExit`). The pure
    `TranscriptLineStream` core + `seedFromDb` + `scanJobsForTitles` are exported
    and drivable with no Worker or watcher; the watcher subscription is the owned
    external resource it `unsubscribe()`s in its shutdown handler.
    `isMainThread`-guarded. **Drop-recovery carve-out (fn-566):** macOS FSEvents
    can drop events under congestion and signals it through the subscribe
    callback's `err` arg (message "...must be re-scanned") — the live tail would
    silently miss that change (no future event for the missed file). On a matched
    drop (`isDropError` in `src/rescan.ts`, matching the substring `must be
    re-scanned` so all three FSEvents variants recover) the callback SCHEDULES a
    debounced, single-flight RE-SCAN (a `RescanScheduler`) that re-runs
    `scanJobsForTitles` (routing through `scanFile`'s transient decoder — NEVER
    `onChange`, which would re-anchor offsets and lose the recovered change),
    reusing the warm `lastEmitted` change-gate so an unchanged file emits nothing.
    This is NOT a self-heal — the subscription stays live, the worker never
    re-subscribes, and a re-scan throw is swallowed to stderr (never `fatalExit`);
    a non-drop `err` keeps the old swallow-and-log. The timer is cleared in the
    shutdown handler before `unsubscribe()` and the scan re-checks `shuttingDown`.
  - `src/plan-worker.ts` — Worker thread; the SECOND producer (after transcript)
    and keeperd's fourth worker. Watches each configured project root (from
    `resolvePlanRoots()`) for `.planctl/{epics,tasks}/*.json` via ONE recursive
    `@parcel/watcher` subscribe per root with aggressive POSITIVE ignore globs
    (`node_modules`, `.git`, `dist`, … — NOT a negated glob, which parcel
    mishandles; the `.planctl/{epics,tasks}/*.json` filter is an in-callback
    `classifyPlanPath` check). Treats every watch event as "go look": `fstat` +
    size-bound + safe-parse the CURRENT file, route on path+existence not
    `event.type` (planctl writes atomically via `os.replace`). On a changed file
    it posts a `{ kind: "plan-epic" }`/`{ kind: "plan-task" }` snapshot message to
    main, change-gated against the last-emitted serialized snapshot so a restart
    full-scan doesn't re-emit. **Delete retraction (fn-568):** on a file that has
    VANISHED (`onDelete`), it posts a tombstone message
    (`{ kind: "plan-epic-deleted" }`/`{ kind: "plan-task-deleted" }`) so main folds
    a synthetic `EpicDeleted`/`TaskDeleted` and the projection retracts (the epic
    row dropped, or the task element spliced out of its parent's array); a task
    tombstone recovers its parent `epicId` from the last-emitted snapshot in the
    change-gate (the file is already gone), then drops the path's change-gate
    entry. **Boot reconciliation (fn-568):** a file deleted while the daemon was
    DOWN never fired a live `onDelete`, so AFTER every configured root's boot scan
    has run, a one-shot sweep retracts any projection row whose backing file is no
    longer on disk — reusing the SAME tombstone path so the retraction folds
    through the synthetic-event pipeline identically. READ-ONLY (own read-only
    connection for the
    `seedFromDb` restart-seed; never writes the DB — main is the sole writer). The
    pure `PlanScanner` core + `seedFromDb` are exported and drivable with no Worker
    or watcher; each subscription is an owned external resource `unsubscribe()`d in
    the shutdown handler. `isMainThread`-guarded. **Drop-recovery carve-out
    (fn-566):** same as the transcript worker — on a matched FSEvents drop
    (`isDropError`, "...must be re-scanned") each per-root callback SCHEDULES a
    debounced, single-flight re-scan via a PER-ROOT `RescanScheduler`
    (`src/rescan.ts`; each callback closes over its own `root`) that re-runs
    `scanRoot(root, scanner)` for the affected root only, reusing the warm
    `PlanScanner.lastEmitted` change-gate so unchanged files emit nothing. Not a
    self-heal (the subscription stays live, never re-subscribes; a throw is
    swallowed to stderr, never `fatalExit`); a non-drop `err` keeps the old
    swallow-and-log. Each scheduler is cleared in the shutdown handler BEFORE
    `unsubscribe()` and the scan re-checks `shuttingDown`.
  - `src/collections.ts` — the collection registry that namespaces the read
    surface. A `CollectionDescriptor` holds everything collection-specific
    (table, served columns, pk, the per-row `version` column the diff fires on,
    the sort allowlist + default sort, the filter-key → SQL-column map, and
    `jsonColumns` — the set of JSON-TEXT columns `decodeRow` parses into real
    values at the read boundary; `epics` registers `tasks` here so each served
    epic carries a decoded `tasks: Task[]` array, fail-soft to `[]` on a
    NULL/parse failure);
    `REGISTRY` / `getCollection` resolve a wire `collection` name to its
    descriptor, `selectByIds(db, descriptor, ids)` is the
    descriptor-parameterized by-id read (it `decodeRow`s its rows, so the diff
    path and the page SELECT agree on the decoded shape), and `countAndToken(db, descriptor,
    whereClause, params)` is the descriptor-parameterized count-query — the
    filtered-set `COUNT(*)` plus a `group_concat(pk)` membership token (ordered
    by pk, empty-set normalized to `total=0`/`token=""`) that the `meta` signal
    diffs on. `REGISTRY` holds two descriptors — `jobs` (pk `job_id`) and `epics`
    (pk `epic_id`, default sort `epic_number asc` — stable creation order, so a
    task edit never reorders the page); the plans surface added `epics` as a
    descriptor-only entry with zero `server-worker.ts` edits, proving the
    namespacing. Each `filters` map includes the pk for detail-page single-item
    subscribe. The
    descriptor is the SOLE identifier-injection gate: only its constants are
    interpolated into SQL; wire filter keys are resolved by map lookup, never
    interpolated — load-bearing for `epics`, whose `project_dir` /
    `target_repo` hold opaque foreign-process JSON bound as filter VALUES, never
    as identifiers. `jobs`'s served `columns` include `title` + `title_source`,
    and `epics` serves `title` + `epic_number` + the embedded `tasks` array as
    read-only display (all OUT of `sortable`/`filters` where they are
    display-only).
  - `src/protocol.ts` — the wire protocol: `query` / `result` / `patch` / `meta`
    frame shapes (every frame names a `collection`; `result` / `patch` are
    generic over `Row`; `result` carries `total` — the filtered-set size; `patch`
    carries `row`; `meta` is a membership-staleness signal carrying the new
    `total` but no row; `query.collection` is required), NDJSON line framing
    (buffer-until-`\n` + max-line cap), and the page/diff helpers shared by the
    server worker.
  - `src/types.ts` — `Event`, `Job`, `Epic`, `Task`, `ReducerState` row shapes
    (`Job` carries `transcript_path` — display/debug only, never sorted/filtered;
    `Epic` is the sole plan-projection row, folded from the synthetic
    `EpicSnapshot`/`TaskSnapshot`/`EpicDeleted`/`TaskDeleted` events; `Task` is no
    longer a standalone projection row — it is the ELEMENT shape of `Epic.tasks`,
    the embedded JSON array).
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
  collections, plan-worker, smoke, integration, events-writer).

## Module entry points

| Module | Entry | Role |
|---|---|---|
| `src/daemon.ts` | `runDaemon()` (via `import.meta.main`) | process lifecycle |
| `src/reducer.ts` | `drain()` / `applyEvent()` | fold events → jobs / epics (tasks embedded in `epics.tasks`) |
| `src/db.ts` | `openDb()` / `resolveDbPath()` / `resolvePlanRoots()` / `resolveClaudeProjectsRoot()` | schema + PRAGMAs + stmts + plan-root + transcript-root config |
| `src/wake-worker.ts` | Worker default body | `data_version` poll → wake |
| `src/server-worker.ts` | Worker default body | UDS subscribe server: query → result (+ `total`) + live patches + `meta` staleness signal, routed by collection |
| `src/transcript-worker.ts` | Worker default body / `TranscriptLineStream` / `scanJobsForTitles` | watch external transcript tree → tail `custom-title` (+ boot scan via `jobs.transcript_path`) → post `transcript-title` (priority-3 producer) |
| `src/plan-worker.ts` | Worker default body / `PlanScanner` | watch external `.planctl/{epics,tasks}` trees → safe-parse → post `plan-epic`/`plan-task` snapshots + `plan-epic-deleted`/`plan-task-deleted` tombstones + boot reconciliation (second producer) |
| `src/collections.ts` | `getCollection()` / `selectByIds()` / `countAndToken()` | collection registry (`jobs`/`epics`, the latter embedding `tasks`) + descriptor-parameterized by-id read + count/membership-token query |
| `src/protocol.ts` | `encodeFrame()` / `LineBuffer` / frame types | NDJSON wire protocol (collection-namespaced `query`/`result`/`patch`/`meta` frames) |
| `plugin/hooks/events-writer.ts` | `main()` | one event row per hook |

## State machine

The reducer (`projectJobsRow` in `src/reducer.ts`) keys everything by
`session_id` (== `job_id` in v1):

- `SessionStart` → upsert (`INSERT … ON CONFLICT(job_id) DO UPDATE`). On a NEW
  row the insert lands (schema default `state='stopped'` — the zero-event
  reading) and **seeds the title** from the event's `spawn_name` (the parent
  claude process's `--name`/`-n`, scraped by the hook): when present, the insert
  sets `title = spawn_name` / `title_source = 'spawn'` (priority 1); when NULL,
  `title`/`title_source` stay NULL (priority 0) and Tier 0 below seeds at the
  first prompt. On a DUPLICATE SessionStart — a **resume** (a genuinely-ended
  session can only return via a fresh `claude --resume` process, which fires
  SessionStart `source=resume`, even with no interaction) — the conflict branch
  **re-opens** a terminal row (`CASE`: `'ended' → 'stopped'`; a non-ended row's
  state is left untouched, so a mid-session `compact`/`clear` SessionStart never
  knocks a live job backwards) and refreshes `pid` (a resume is a new OS
  process). `title`/`title_source` are NOT touched on conflict (precedence-owned —
  a resume never re-seeds the spawn name over a higher source), and
  `created_at`/`cwd`/`transcript_path` are set-once identity.
- `UserPromptSubmit` → `state = 'working'` (**also re-opens an `ended` job** — no
  terminal guard; a session can resume straight into a prompt with no
  SessionStart, or a spurious mid-session `SessionEnd(reason=other)` can be
  followed immediately by a prompt). Also
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
  A `TranscriptTitle` can now also emit at BOOT (not just from a live tail): the
  transcript worker's startup current-title fold (`scanJobsForTitles`, scoped via
  `jobs.transcript_path`) folds a `custom-title` set while the daemon was down,
  running after `seedFromDb` so an already-folded title is suppressed by the
  change-gate (no duplicate event on restart — re-fold determinism preserved).
- `Stop` → `state = 'stopped'` (skipped when already `ended` — keeps the terminal
  guard so a stray late `Stop` can't resurrect a still-ended job; after a real
  re-open the row is no longer `ended` and a normal post-resume `Stop` applies).
- `SessionEnd` → `state = 'ended'` (always lands). `ended` is the **resting state
  after an end, not a permanent trap**: a SessionStart or UserPromptSubmit
  re-opens it (see above). keeper has no process-liveness overlay (unlike
  jobctl's server, which keeps SQL `ended` sticky and un-ends from PID liveness)
  — the fold IS the live view, so the re-open lives in the reducer.
- `EpicSnapshot` / `TaskSnapshot` (**synthetic**, inserted by keeperd's main
  thread from the plan worker's `plan-epic`/`plan-task` messages, not the hook) →
  these do NOT touch `jobs`; they project into the SEPARATE `epics` table (there
  is no longer a `tasks` table — tasks are embedded). `EpicSnapshot`: the
  `session_id` carries `epic_id`, the `data` blob is the full state-on-disk
  snapshot, the fold is an **idempotent upsert** (snapshot-replace by `epic_id`,
  `last_event_id` bumped each fold). `TaskSnapshot`: the `session_id` carries
  `task_id` and the blob carries the parent `epic_id`; the fold is a
  **read-modify-write on the parent epic's embedded `tasks` array** — parse the
  stored array, splice the element by `task_id`, re-sort by the stable key
  (`task_number, task_id`), re-stringify, write once (JS, no JSON1), bumping the
  parent epic's `last_event_id`/`updated_at` so the task change `patch`es the
  epic. Building the array from a stable sort (never append) keeps re-fold
  deterministic — replay reproduces byte-identical `epics` rows (with embedded
  arrays). `tasks[].status` is the producer's derived value (`worker_done_at`
  present → `done`, else `open`). No lifecycle / title interaction with `jobs`.
- `EpicDeleted` / `TaskDeleted` (**synthetic** tombstones, inserted by main from
  the plan worker's `plan-epic-deleted`/`plan-task-deleted` messages — a live
  file delete OR a boot-reconciliation retraction) → `EpicDeleted` is a
  `DELETE FROM epics WHERE epic_id = ?` (the embedded array vanishes with the
  row); `TaskDeleted` is a read-modify-write splicing the element out of the
  parent epic's array by `task_id` (parent `epic_id` recovered into the blob),
  bumping `last_event_id` so the retraction `patch`es. Both are **idempotent
  no-ops on a missing target** and never throw inside the transaction (a malformed
  stored array folds to `[]`). Tombstones are the only replay-deterministic delete
  fold — a vanished file leaves no event, so a re-fold replays the create→delete
  sequence and reproduces the retracted state.
- Everything else (PreToolUse, PostToolUse, Notification, Subagent*, unknown
  forward-compat events) → no jobs write; the cursor still advances.

**V3: keeperd is now also a producer.** V1/V2 the hook was the sole `events`
writer; V3 adds the transcript worker → main pipeline (synthetic
`TranscriptTitle` events) and the plan worker → main pipeline (synthetic
`EpicSnapshot`/`TaskSnapshot` snapshots + `EpicDeleted`/`TaskDeleted` tombstones)
above. The hook remains the only writer of
*hook* events; main is the only writer of *synthetic* events (both producers feed
the log only via main's writable connection — they never write the DB
themselves).

`mode` and `title_history` were retired in schema v3 — `events.permission_mode`
is still recorded, but it is no longer projected into `jobs`, and titles are a
single live value with no history array. Schema v4 added `events.spawn_name`
(the hook's SessionStart spawn-name scrape) and `jobs.title_source` (title
provenance/precedence), both nullable with no backfill. Schema v5 added
`jobs.transcript_path` (the absolute path to the session's transcript JSONL,
seeded from a SessionStart payload — display/debug only), nullable, NULL-backfill
on old rows. Schema v6 added the `epics` + `tasks` plan-projection tables (new
tables via `CREATE TABLE IF NOT EXISTS`, so existing rows in other tables are
untouched — a clean forward-only step). Schema v7 collapsed the standalone
`tasks` table into an embedded `epics.tasks` JSON-array column: unlike the
idempotent ALTER steps before it, v7 is a non-idempotent data migration, so it is
**version-guarded** (`schema_version < 7`) and runs in one transaction —
ADD COLUMN `epics.tasks TEXT NOT NULL DEFAULT '[]'` → backfill the array from the
old `tasks` rows via `json_group_array(json_object(...))` ordered
`task_number, task_id` (the SAME order the reducer's fold re-sorts to, or a
migrated row would differ from a re-folded one) → `DROP TABLE IF EXISTS tasks`.

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
  message), synthetic `EpicSnapshot`/`TaskSnapshot` rows (from the plan worker's
  `plan-epic`/`plan-task` messages), and synthetic `EpicDeleted`/`TaskDeleted`
  tombstone rows (from the plan worker's `plan-epic-deleted`/`plan-task-deleted`
  messages) on its existing writable connection
  via `stmts.insertEvent`, then `pumpWakes()`. A synthetic `TranscriptTitle` id is
  allocated after the session's SessionStart in practice, so it folds at priority
  3 over the lower-tier title. Because every projection-driving fact lives in the
  immutable event log — never written straight to `jobs`/`epics` — a
  re-fold from scratch (rewind cursor, `DELETE FROM jobs`/`epics`,
  re-drain) reproduces the identical rows: "identical rows" now means `epics`
  rows with their embedded `tasks` arrays byte-for-byte reproduced (a
  create→delete→re-create sequence of snapshots and tombstones replays to the same
  array), since the array is built from a stable sort, never append. Synthetic
  events (titles, plan snapshots, AND plan tombstones)
  replay deterministically just like hook events. Both producer
  workers stay read-only; neither ever writes the DB.
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
  the ALTER slot in `migrate()`. Idempotent steps (`addColumnIfMissing` /
  `dropColumnIfPresent`) converge on the table's actual shape, so even a DROP is
  safe to re-run unguarded (it no-ops once gone). A **non-idempotent** step (a
  data backfill, a destructive DROP that depends on a one-time read) MUST be
  version-guarded — v7 is the first such step: it guards on `schema_version < 7`
  and sequences ADD COLUMN → backfill (`json_group_array`, ordered to match the
  reducer fold sort) → `DROP TABLE IF EXISTS tasks` in one transaction, so a
  re-run can't re-backfill an already-collapsed schema. Bump `SCHEMA_VERSION` only
  when adding an ALTER; never reduce the version, never branch.

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
  of *external* files in keeperd IS permitted for two trees written by *other*
  processes — the transcript files (`src/transcript-worker.ts`, written by Claude
  Code) and the `.planctl/{epics,tasks}` plan trees (`src/plan-worker.ts`, written
  by planctl) — both via `@parcel/watcher`. Those files are foreign-written, so
  the same-process-write blind spot does not apply, and there is no `data_version`
  for a foreign file tree. Treat a watcher event as "go look", never as the data:
  always `fstat` + (transcript) forward-tail from the stored byte-offset / (plan)
  size-bound + safe-parse the current file. This carve-out is for those external
  trees ONLY — never point a file watcher at keeper's own DB. **Drop-recovery
  sub-carve-out (fn-566):** the subscribe callback's `err` arg is itself a
  meta-event — macOS FSEvents reports a dropped-events overrun there ("...must be
  re-scanned"). A matched drop (`isDropError`) is also "go look": it schedules a
  debounced, single-flight re-scan of the affected tree via the existing
  change-gated boot-scan primitive (`scanJobsForTitles` / `scanRoot`), recovering
  the lost change WITHOUT a restart and without re-subscribing. A non-drop `err`
  stays swallow-and-log.
- **No third-party deps in the hook.** Keep `plugin/hooks/events-writer.ts`'s
  import graph to `bun:sqlite` + local files only — Bun cold start is ~30ms and
  the SessionEnd hook has a 1.5s timeout budget.
- **The hook must always exit 0.** Never let a parse/DB failure propagate a
  non-zero exit — that can fail-closed the user's session. Losing one event row
  is acceptable; wedging the agent is not. Log to stderr only.
- **No in-process self-heal.** Any unrecoverable error — including any of the
  four workers' `error` event — calls `fatalExit` → `process.exit(1)` → the
  LaunchAgent restarts the single recovery path. Do not respawn any worker
  in-process. **Scoped exception (fn-566):** a RECOVERABLE FSEvents
  dropped-events signal (the producer-worker subscribe callback's `err` carrying
  "...must be re-scanned") is deliberately NOT escalated — it schedules a
  debounced re-scan via the existing change-gated boot-scan primitive and the
  subscription stays live. This is data recovery, not process self-heal: no
  worker is respawned, no subscription re-subscribed, and a re-scan throw is
  swallowed to stderr (never reaches `fatalExit`). Every OTHER unrecoverable
  error still escalates as before; a non-drop watcher `err` still swallow-and-logs.
- **No prise/env-var integration, multi-session lineage, or harness_meta** — all
  explicitly out of scope.
- **Plans are READ-ONLY, like everything else keeper serves.** keeper *reads*
  planctl state — the plan worker (V3) watches the configured roots'
  `.planctl/{epics,tasks}` trees and folds snapshots into the single `epics`
  projection (each epic embedding its tasks as a JSON array — there is no peer
  `tasks` collection or table) served over the same socket. FORBIDDEN: any plan
  WRITE path — the socket never carries a plan mutation, keeper never writes a
  `.planctl` file, and no `planctl_mutations` / command surface exists. The fence
  is the same as `jobs`: read the projection, subscribe over the socket, never
  mutate. (This legitimizes the read-only plans projection that the original "no
  plans/planctl_mutations" ban predated — the ban is now scoped to the *write*
  path only.)
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
  respawn themselves or each other. (The producer workers' fn-566 drop-recovery
  re-scan is NOT an exception to this — it never respawns a worker or
  re-subscribes; it re-runs the change-gated boot scan in-place on a recoverable
  FSEvents drop. See the Producer-worker archetype.)

Three archetypes:

- **Sensor worker** (like `wake-worker`): a thin read-only poller with no
  external endpoint and no durable state of its own — it observes and notifies.
- **Subsystem worker** (like `server-worker`): owns an external endpoint (the
  UDS) plus its own state (subscriptions, lock file, partial-write buffers). It
  must release its external resources inside its own shutdown handler —
  `terminate()` alone would leak the process-owned socket and lock.
- **Producer worker** (`transcript-worker` AND `plan-worker` — two instances):
  observes an external source (a watched file tree) and posts typed `{ kind }`
  messages that main turns into synthetic `events` rows — it FEEDS the log but
  never writes the DB itself (read-only or no DB connection at all; the write
  stays on main's connection). Like the subsystem worker it owns an external
  resource (the watcher subscription — `plan-worker` holds an ARRAY of them, one
  per root) it must release in its own shutdown handler. The
  source-of-truth-stays-on-main discipline keeps the event log re-fold
  deterministic. `plan-worker` clones this contract verbatim: pure exported core
  (`PlanScanner` + `seedFromDb`), `isMainThread` guard, read-only restart-seed
  connection, change-gated emission, and per-root `unsubscribe()` teardown. Both
  producers also run a **one-shot boot scan** after their subscribe resolves to
  pick up files that pre-existed (or changed during) the daemon's downtime, gated
  by the same change-gate so an unchanged file is not re-emitted: `plan-worker`'s
  `scanRoot` enumerates `.planctl/{epics,tasks}/*.json`, while `transcript-worker`'s
  `scanJobsForTitles` scopes to live `jobs.transcript_path` (the per-session file,
  NOT a watch-root walk) and folds each session's current `custom-title`.
  **`plan-worker` extends the producer archetype with delete handling (fn-568):**
  beyond the additive snapshot path, its `onDelete` emits a RETRACTION tombstone
  (`plan-epic-deleted`/`plan-task-deleted`) when a watched file vanishes, and
  AFTER all roots' boot scans complete it runs a one-shot **boot-reconciliation
  sweep** that retracts any projection row whose backing file is gone (catching
  deletes that happened while the daemon was down — those fire no live `onDelete`).
  Both the live `onDelete` and the boot sweep route through the same tombstone
  message → synthetic `EpicDeleted`/`TaskDeleted` event → reducer retraction, so
  deletes stay re-fold deterministic just like the additive snapshots. Both
  producers ALSO run a **second post-subscribe behavior (fn-566): drop-recovery.**
  macOS FSEvents can drop events under congestion and reports it through the
  subscribe callback's `err` arg ("...must be re-scanned"); the lost change may
  never re-fire. On a matched drop (`isDropError` in `src/rescan.ts`) the callback
  schedules a debounced, single-flight re-scan (`RescanScheduler`) that RE-RUNS
  the same boot-scan primitive (`scanRoot(root)` per affected root for
  `plan-worker`; `scanJobsForTitles` for `transcript-worker`, routed through
  `scanFile`'s transient decoder, never the offset-advancing `onChange`), reusing
  the warm in-memory change-gate so recovery stays idempotent. The
  `RescanScheduler` (timer + `inFlight` single-flight + `pending` dirty bit) is an
  owned resource cleared in the shutdown handler BEFORE `unsubscribe()`, and the
  scan re-checks `shuttingDown` — the same teardown discipline as the watcher
  subscription. This is the producer-worker drop-recovery clause of the "no
  self-heal" contract: data recovery in-place, never a re-subscribe or respawn,
  and a re-scan throw is swallowed (never `fatalExit`).
