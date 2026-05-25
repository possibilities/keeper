keeper — event-sourced Claude Code control-data daemon (Bun + bun:sqlite).

The hook plugin writes one `events` row per Claude Code hook invocation; the
`keeperd` daemon folds those events into the `jobs` (and `epics`) projections and
serves them read-only over a UDS subscribe socket. For the system map — the
event log, reducer, the five worker threads, and the wire protocol — see
`README.md` `## Architecture`.

**AGENTS.md symlink** — `AGENTS.md` is a symlink to this file
(`ln -s CLAUDE.md AGENTS.md`). Edit this file in place; never `rm`+recreate it.

## Design stance

**Design the server for the ideal architecture; do not nickle-and-dime against
client churn.** The server (event log, reducer, projections, schema, RPC
surface) is the durable artifact and the source of truth; clients (board.ts,
the other `scripts/*.ts` UIs, autopilot, future consumers) are cheap to change.
When a question is "should the projection carry richer state X?" the answer
is decided by what makes the projection most honest and expressive — never
by counting how many client call sites would need to update an enum check,
rename a column reference, or absorb a new variant. Schema bumps, column
renames, and enum widenings are routine; bending the server to preserve a
lossy or misleading shape because consumers already read it is the cost we
refuse. Concretely: if the event log already knows a fact, the projection
surfaces it natively (full enum, raw timestamp, etc.) rather than collapsing
it into a binary or a derived label for the renderer's convenience —
collapsing is the renderer's job iff it ever needs to, and even then "show
the native value" is the default.

## Event-sourcing invariants

- **Cursor + projection advance in the SAME `BEGIN IMMEDIATE` transaction.** Every
  fold writes the projection (`jobs`/`epics`/`subagent_invocations`, including the
  `syncJobIntoEpic` fan-out from a `plan_ref`-bearing jobs write into the parent
  epic's embedded `jobs` array or the target task element's nested `jobs`
  sub-array, AND the `syncPlanctlLinks` fan-out from a `planctl_op != NULL`
  event re-deriving the touched session's `jobs.epic_links` and every touched
  epic's `epics.job_links`) and bumps `reducer_state.last_event_id` in one
  transaction. A crash mid-fold rolls back both; boot drain re-folds
  idempotently. This is the exactly-once-per-event guarantee — never split
  the two writes across transactions.
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
  *synthetic* events; the server-worker writes the `approval` field on
  external `.planctl` JSON files (via atomic temp+rename) and nothing else.**
  Every projection-driving fact lives in the immutable event log — never
  written straight to `jobs`/`epics` — so a re-fold from scratch (rewind
  cursor, `DELETE FROM jobs`/`epics`, re-drain) reproduces byte-identical
  rows, including `epics` rows with their embedded `tasks` arrays and the
  embedded `jobs` arrays at both the epic level and nested inside each task
  element (all built from stable sorts — `(task_number, task_id)` for tasks,
  `(created_at desc, job_id asc)` for jobs — never append), AND the
  per-session `jobs.epic_links` + per-epic `epics.job_links` link projections
  (sorted ASC on `(kind, target)` and `(kind, job_id)` respectively — total
  -order tiebreakers, never append). Hook-side derivers (`slashCommandFromPrompt`,
  `extractSkillName`, `planVerbRefFromSpawnName`, `extractPlanctlInvocation`
  — the last one gated on PostToolUse:Bash and parsing the authoritative
  `planctl_invocation` envelope from `data.tool_response.stdout`) stamp the
  seven sparse `events` columns (`slash_command`, `skill_name`, and the
  five-column planctl envelope `planctl_op` / `planctl_target` /
  `planctl_epic_id` / `planctl_task_id` / `planctl_subject_present`) at hook
  write time — all pure functions of the hook payload, shared with the
  schema-migration backfill so a re-derive on stored events reproduces the
  same column values. The reducer's `syncJobIntoEpic` fan-out maintains the
  embedded `jobs` arrays from each `plan_ref`-bearing jobs write; the
  parallel `syncPlanctlLinks` fan-out maintains `jobs.epic_links` +
  `epics.job_links` from each `planctl_op != NULL` event by re-deriving
  from scratch against the touched session's full planctl footprint (never
  delta-merging, so re-fold idempotence holds). The producer workers feed
  the log only via main's writable connection; they never write the DB.
  Synthetic events covered by this rule: `TranscriptTitle` (transcript
  worker), `EpicSnapshot` / `TaskSnapshot` / `EpicDeleted` / `TaskDeleted`
  (plan worker — these now carry `approval` round-tripped from the file;
  the `EpicSnapshot` ON CONFLICT clause carves out `job_links` alongside
  the existing `tasks` / `jobs` carve-outs so an approval-RPC round-trip
  cannot wipe the link projection), `Killed` (boot seed sweep + live
  exit-watcher worker, gated by main's `(pid, start_time)` verifier before
  insert). The RPC handlers' `.planctl` writes are not projection writes;
  the watcher round-trips them back as `EpicSnapshot`/`TaskSnapshot` events
  that the reducer folds — so re-fold determinism extends to `approval`.
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

- **The socket carries `query` (subscribe / read) AND `rpc` (mutate) frames; no
  reactor, no general write path into the reducer.** The UDS server's QUERY
  surface is unchanged and remains read-only — a client `query` returns
  `result` + `patch` + `meta` frames over the reducer-fed projections, and
  consumers may still read those projections from SQLite directly. The
  `rpc` frame type lets a client invoke a registered handler that writes
  *external resources* — concretely, the `approval` field on the relevant
  `.planctl/{epics,tasks}/<id>.json` file via atomic temp+rename under a
  per-file single-flight lock owned by the server-worker; the reply is an
  `rpc_result` (or an `error` with code `unknown_method` / `bad_params` /
  `rpc_failed`). RPC handlers MUST NOT write reducer projections (`jobs` /
  `epics`), sidecar tables, or the `events` log directly: projection changes
  round-trip through the plan-worker file watcher and the synthetic-event
  path, so a from-scratch re-fold sees every approval change exactly as it
  was observed. The concrete RPCs are `set_task_approval` and
  `set_epic_approval`; the protocol shape, the dispatch registry, and the
  writer lifecycle are built as a generic foundation, not welded to those
  two handlers.
- **The `approval` field is RPC-writable on `.planctl` files; everything else
  is not.** `set_task_approval` and `set_epic_approval` write the top-level
  `approval` field (`"approved" | "rejected" | "pending"`) on the target
  task or epic JSON via atomic temp+rename in the same directory as the
  target. The change is observed by `@parcel/watcher`, lifted into an
  `EpicSnapshot` / `TaskSnapshot` event by the plan worker, and folded into
  the `epics` projection — re-fold determinism is preserved because the
  event log carries every approval transition. A missing or invalid
  `approval` value folds to `"pending"` per the "safe value" invariant.
  *Why this is the only RPC-writable field:* approval is the one piece of
  human state that has no Claude Code hook to attach it to; every other
  planctl field is the planner's or worker's job.
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
- **Plans are READ-ONLY *except for the `approval` field***. The plan worker
  watches the configured roots' `.planctl/{epics,tasks}` trees AND the
  `.planctl/state/tasks/` sidecar tree (planctl's `LocalFileStateStore`
  writes `<task_id>.state.json` files there carrying the runtime status
  `todo|in_progress|done|blocked`) and folds snapshots into the `epics`
  projection — a task-state-file change re-emits the task's `TaskSnapshot`
  with a fresh `runtime_status` field composed against the sibling task
  definition. Each epic embeds its tasks as a JSON array — both carrying
  `approval` — its plan/close-verb jobs as a JSON array, and each task
  element embeds its own work-verb jobs as a nested JSON array — no peer
  `tasks` or `epic_jobs` collection or table — served over the same
  socket. Jobs fan into the embedded arrays from the reducer's jobs-side writes
  via the `syncJobIntoEpic` helper, which runs INSIDE the same `BEGIN IMMEDIATE`
  transaction as the jobs write + cursor advance, so the embedded arrays are a
  pure function of the event log and a from-scratch re-fold reproduces them
  byte-identically. PERMITTED: the `set_task_approval` / `set_epic_approval`
  RPCs write the `approval` field of a target `.planctl` file via atomic
  temp+rename; the change round-trips through `@parcel/watcher` →
  `EpicSnapshot`/`TaskSnapshot` → reducer, so re-fold determinism extends to
  approval. FORBIDDEN: any other plan write — no other field is RPC-writable,
  no general plan mutation path exists, and the socket carries no plan
  command surface beyond those two scoped approval RPCs.
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
