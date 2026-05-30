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
  epic's `epics.job_links` — each `epics.job_links` entry carries the widened
  `JobLinkEntry` shape `{kind, job_id, title, state, last_api_error_at,
  last_api_error_kind}` with `(title, state, last_api_error_at,
  last_api_error_kind)` enriched off the linked `jobs` row via the
  shared `enrichJobLink` helper inside the open transaction, AND the
  symmetric `syncJobLinksOnJobWrite` fan-out from a jobs-write whose
  `jobs.epic_links !== '[]'` — re-stamping each linked epic's matching
  `job_links` entry with fresh enrichment so a `state` flip on
  UserPromptSubmit / Stop / SessionEnd / Killed / RateLimited|ApiError, a
  title update on TranscriptTitle, or a paired
  `(last_api_error_at, last_api_error_kind)` set/clear propagates
  to every epic that references the session, AND the schema-v31
  `projectGitStatus`/`retractGitStatus`/`projectCommit` fan-out from a
  `GitSnapshot` / `GitRootDropped` / `Commit` event — `git_status` rows
  carry the file-centric `dirty_files` JSON array with per-(session, file)
  `attributions[]` computed by joining the event log against the
  producer-frozen `mtime_ms` on each dirty-file entry, the renamed
  per-job `jobs.git_unattributed_to_live_count` (formerly
  `jobs.git_orphan_count` — dirty files no live session is on the hook
  for) and the redefined strict-mystery `jobs.git_orphan_count` (dirty
  files with zero attribution after the inference pass) are stamped onto
  every enumerated job and re-fanned via `syncJobIntoEpic` so the
  embedded `jobs[]` arrays carry the counts, and the new
  `file_attributions` projection table (one row per
  `(project_dir, file_path, session_id)` carrying `last_mutation_at` +
  `last_commit_at`) is maintained inside the SAME `BEGIN IMMEDIATE` —
  `Commit` folds update `last_commit_at` (never delete rows; a re-edit
  re-arms attribution by re-stamping `last_mutation_at`), and the
  `GitRootDropped` clear walks the SAME canonical `git_status.jobs`
  enumeration the last write fanned over and zeroes the per-job columns
  symmetrically — so an unrelated project's jobs running in another
  worktree stay untouched. Producer-side `stat()` is forbidden inside
  the reducer's transaction; mtimes are computed at snapshot build time
  in the git worker, embedded in the payload, and consumed pure-SQL by
  the attribution pass so re-fold determinism holds. AND the schema-v33
  (fn-639) `profiles` projection table   (one row per Claude profile
  directory, keyed by `config_dir TEXT NOT NULL PRIMARY KEY` with the
  `''` sentinel collapsing default `~/.claude` — NOT NULL is load-
  bearing, SQLite treats multiple NULL PK rows as distinct so a nullable
  PK + `INSERT OR IGNORE` would NOT dedupe) is maintained by two reducer
  fan-outs inside the SAME `BEGIN IMMEDIATE`: the SessionStart arm
  `INSERT OR IGNORE`s a visible row for every unique `config_dir` (quiet
  or not — `last_rate_limit_*` populated only after the first rate-limit
  fan-out lands, not on the seed), and the
  dual-case `RateLimited`/`ApiError` arm gated on `kind === "rate_limit"`
  reads the session's `jobs.config_dir` in-transaction (null-guarded via
  the `syncIfPlanRef` read-then-write precedent — a missing jobs row
  skips quietly; cursor still advances) then UPSERTs `last_rate_limit_at`
  + `last_rate_limit_session_id` against the same
  `COALESCE(config_dir,'')` expression as the seed so a NULL-config
  session's rate limit lands on the exact `''` row it seeded. Last-
  write-wins on `last_rate_limit_at` follows the event log's append-
  only id ordering (no `max()` guard — events fold in id order).
  Schema v35 (fn-642) also stamps a derived `profile_name` column
  (`projectBasename(config_dir)`) on every `profiles` row via the same
  helper at SessionStart seed time AND on the dual-case UPSERT, with a
  one-time version-guarded backfill of pre-v35 rows on migrate — so
  byte-identical derivation is preserved across seed, UPSERT, backfill,
  and re-fold. The `profile_name` column is the join key against
  `usage.id` for the schema-v35 bidirectional usage↔profiles rate-limit
  fan-out.) AND the schema-v35 (fn-642) bidirectional `usage`↔`profiles`
  rate-limit fan-out: the `RateLimited`/`ApiError(kind='rate_limit')`
  arm, after the existing `profiles` UPSERT, runs a pure
  `UPDATE usage SET last_rate_limit_at=?, last_rate_limit_session_id=?,
  last_event_id=<event.id>, updated_at=? WHERE id =
  projectBasename(config_dir)` — pure UPDATE, never UPSERT (a rate-limit
  must NOT mint a phantom usage row for a profile agentuse isn't
  tracking; `usage` is canonical for "tracked profiles"). The reverse
  direction lives in `projectUsageRow`: the existing UPSERT carves
  `last_rate_limit_at` + `last_rate_limit_session_id` OUT of the
  `ON CONFLICT(id) DO UPDATE SET` clause (mirroring the `EpicSnapshot`
  carve-out so a re-snapshot can't clobber the rate-limit annotation),
  then a post-UPSERT
  `SELECT last_rate_limit_at, last_rate_limit_session_id FROM profiles
  WHERE profile_name = <usage.id> AND profile_name != ''` re-stamps the
  pair from the matching profiles row — NULL-safe when no row matches
  (a later RateLimited fans them in via the forward path). Both
  directions guard `profile_name != ''` so the `''` sentinel (default
  `~/.claude`, basename `""`) never cross-contaminates the join. The
  `last_event_id` bump on the forward UPDATE is load-bearing — it is
  the descriptor's `version` column; without the bump the wire diff
  would not fire and the UI wouldn't refresh.) AND the schema-v36
  `jobs.profile_name` stamp: the SessionStart jobs UPSERT — the only arm
  that writes `jobs.config_dir` — also stamps the derived
  `projectBasename(config_dir)` onto `jobs.profile_name` so the usage
  surface's "recent sessions" log (`scripts/usage.ts`) labels each job by
  profile natively, no client-side join. Unlike the `profiles` seed's
  `''`-collapse, the value tracks `config_dir`'s OWN nullability — a NULL
  `config_dir` (default `~/.claude`) derives a NULL `profile_name` —
  and the `ON CONFLICT DO UPDATE` mirrors `config_dir`'s
  `COALESCE(excluded.profile_name, jobs.profile_name)` so a NULL-config
  resume never clobbers a seeded name. The v35→v36 migrate adds the
  nullable column and runs a one-time version-guarded backfill deriving
  `profile_name` from each existing row's `config_dir` via the same
  helper (byte-identical so a from-scratch re-fold converges).) AND the
  schema-v37 (fn-643) `dead_letters` OPERATIONAL sidecar fan-outs — a
  pair of arms that live OUTSIDE the reducer's projection writes because
  the table is NOT a reducer projection. The import arm runs in main
  (NOT inside `BEGIN IMMEDIATE` against the event cursor): on every
  dead-letter-watcher message AND once at boot, main scans
  `~/.local/state/keeper/dead-letters/`, reads each per-pid NDJSON file,
  parses each line via `parseDeadLetterLine`, and `INSERT OR IGNORE INTO
  dead_letters` keyed by `dl_id` — `OR IGNORE` makes the import
  idempotent under re-scan (drop-overrun re-scans, boot re-scans, live
  re-scans all converge on the same set). The replay arm runs in main
  when the server-worker bridges a `replay_dead_letter` RPC: in ONE
  `BEGIN IMMEDIATE` main picks the oldest `waiting` row, appends a plain
  REAL `events` row with the row's preserved `bindings` + `ts` + real
  pid, captures the new `events.id`, and flips the dead-letter row's
  `status` to `recovered` while stamping `recovered_at` + `replayed_event_id`.
  The appended event then folds through the normal id-ordered drain on
  the next wake — re-fold determinism is preserved because the event log
  carries the recovered event with a fresh, higher id (re-fold from
  `last_event_id = 0` replays it in order), and the `dead_letters`
  sidecar is excluded from the re-fold reset (`DELETE FROM jobs;
  DELETE FROM epics` MUST NOT touch `dead_letters` — dead letters are
  the audit log of events that NEVER MADE IT into the event log to be
  folded, so a re-fold cannot reproduce them).) and bumps
  `reducer_state.last_event_id` in one transaction. A crash mid-fold rolls
  back both; boot drain re-folds idempotently. This is the
  exactly-once-per-event guarantee — never split the two writes across
  transactions.
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
- **The hook is the sole writer of *hook* events AND of per-pid NDJSON
  dead-letter files; main is the sole writer of *synthetic* events AND of
  the `dead_letters` operational sidecar AND of the delayed-real-event
  replay path; the server-worker writes the `approval` field on external
  `.planctl` JSON files (via atomic temp+rename) AND bridges
  `replay_dead_letter` calls to main (it does not write the event log
  itself — it routes the call to main, which owns every event-log write)
  and nothing else.**
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
  `extractSkillName`, `planVerbRefFromSpawnName`, `extractPlanctlInvocation`,
  `extractBashMutation`
  — the planctl deriver gated on PostToolUse:Bash and parsing the
  authoritative `planctl_invocation` envelope from
  `data.tool_response.stdout`; the bash-mutation deriver gated on
  PostToolUse:Bash and parsing the command shape) stamp the
  ten sparse `events` columns (`slash_command`, `skill_name`, the
  six-column planctl envelope `planctl_op` / `planctl_target` /
  `planctl_epic_id` / `planctl_task_id` / `planctl_subject_present` /
  `planctl_queue_jump` — the last lifted from the optional `queue_jump`
  field on the envelope, set by `/plan:queue` and absent elsewhere — and
  the schema-v31 pair `bash_mutation_kind` + `bash_mutation_targets`
  naming the filesystem-mutation shape and the affected paths for the
  reducer's git-attribution pass) at hook
  write time — all pure functions of the hook payload, shared with the
  schema-migration backfill so a re-derive on stored events reproduces the
  same column values. The reducer's `syncJobIntoEpic` fan-out maintains the
  embedded `jobs` arrays from each `plan_ref`-bearing jobs write; the
  parallel `syncPlanctlLinks` fan-out maintains `jobs.epic_links` +
  `epics.job_links` from each `planctl_op != NULL` event by re-deriving
  from scratch against the touched session's full planctl footprint (never
  delta-merging, so re-fold idempotence holds). As of schema v30 (fn-595),
  `syncPlanctlLinks` also projects `epics.queue_jump` (INTEGER 0/1,
  default 0) from the `planctl_queue_jump` envelope column — lifted with
  `?? false` so envelopes predating the field fold to `0` deterministically.
  When `queue_jump = 1` AND the epic has no `created_by_closer_of` (root
  epic), `cascadeSortPath` takes the `!`-prefix branch and stamps a
  `!<padded-epic-number>` `sort_path`, floating queue-jumped roots above
  all other roots in the dashctl board's default `sort_path ASC` page.
  Non-root queue-jumped epics still project `queue_jump = 1` for symmetry
  but inherit the parent's prefix via the cascade — no double-prefix.
  The schema v30 ALTER adds `queue_jump INTEGER NOT NULL DEFAULT 0` to
  `epics`; the `EpicSnapshot` ON CONFLICT carve-out adds `queue_jump`
  to the file-content-snapshot UPDATE-omit list alongside `tasks` /
  `jobs` / `job_links` / `created_by_closer_of` / `sort_path` /
  `resolved_epic_deps` (schema v34 / fn-637.3 — see the
  `syncResolvedEpicDeps` fan-out below), so envelope-derived state is
  never stomped by a re-observed snapshot. AND the schema-v34 (fn-637.3)
  `syncResolvedEpicDeps` forward stamp + reverse fan-out: each
  `EpicSnapshot` rebuilds the consumer's `epic_dep_edges` rows (the
  raw-token reverse index keyed on `(consumer_id, dep_token)`) and
  stamps the enriched `resolved_epic_deps` JSON array on the consumer's
  `epics` row, then runs the reverse pass — `SELECT consumer_id FROM
  epic_dep_edges WHERE dep_token IN (B.epic_id, "fn-" || B.epic_number)`
  picks every downstream consumer whose raw-token entries could match
  upstream `B`, and re-stamps each one's `resolved_epic_deps` from
  scratch against the post-write `epics` index — so a completing
  upstream's downstream consumers flip from `blocked-incomplete` to
  `satisfied` in the SAME fold, and a bare-id ambiguity disambiguates
  as soon as a new same-number epic lands. `EpicDeleted` fires the same
  reverse pass against the deleted upstream's raw tokens so a deleted
  epic re-stamps downstream consumers as `dangling`. The resolver is the
  same `epic-deps#resolveEpicDep` the readiness side runs (no fold-time
  wall-clock — the event's own `ts` is injected for the diagnostic
  timestamp), and the readiness/board read side is fully projection-
  driven (predicate 9 in `src/readiness.ts` and the board summary pill
  in `scripts/board.ts` read `epic.resolved_epic_deps` directly; no live
  resolver call on the read path). The producer workers feed
  the log only via main's writable connection; they never write the DB.
  Synthetic events covered by this rule: `TranscriptTitle` (transcript
  worker), `EpicSnapshot` / `TaskSnapshot` / `EpicDeleted` / `TaskDeleted`
  (plan worker — these now carry `approval` round-tripped from the file;
  the `EpicSnapshot` ON CONFLICT clause carves out `job_links` +
  `resolved_epic_deps` alongside the existing `tasks` / `jobs` carve-outs
  so an approval-RPC round-trip cannot wipe the link projection or the
  schema-v34 cross-epic dep resolution), `Killed` (boot seed sweep + live
  exit-watcher worker, gated by main's `(pid, start_time)` verifier before
  insert), `GitSnapshot` / `GitRootDropped` / `Commit` (git worker — the
  schema-v31 file-centric `GitSnapshot` payload carries per-file
  `{path, xy, mtime_ms}` with the producer-stamped mtime frozen in for
  the reducer's attribution pass, and `Commit` fires on every HEAD-oid
  change carrying `{project_dir, commit_oid, parent_oid, files,
  committer_session_id}` for the discharge fold), `UsageSnapshot` /
  `UsageDeleted` (usage worker), `ApiError` / `InputRequest` (transcript
  worker). The RPC handlers' `.planctl` writes are not projection writes;
  the watcher round-trips them back as `EpicSnapshot`/`TaskSnapshot` events
  that the reducer folds — so re-fold determinism extends to `approval`.
- **Producer-only liveness probing.** The seed sweep and the exit-watcher
  worker are the ONLY places that probe process liveness (`kill(pid,0)`,
  kqueue `EVFILT_PROC|NOTE_EXIT`, pidfd_open + epoll, `(pid, start_time)`
  recycle check). The reducer's `Killed` fold NEVER re-probes — it compares
  the event payload's `(pid, start_time)` against the persisted row only.
  A liveness re-probe inside a fold would break re-fold determinism (a
  from-scratch re-fold would see different OS state than the original run).
  The same rule scopes the Stop fold's bounded sub-agent guard
  (`MAX_STOP_YIELD_GAP_SEC`, fn-638.1): the staleness check compares the
  Stop event's own `ts` against the surviving running sub-agent row's `ts`
  (both unix-SECONDS, from the immutable event log via
  `subagent_invocations`) against a compile-time constant — NEVER
  `Date.now()`, NEVER a config / `meta`-row source. A fold-time comparison
  rooted in the event's own `ts` is the determinism boundary; any OS-clock
  read inside a fold would re-fold differently.
- **PRAGMAs are connection-local** — `applyPragmas` runs on every `openDb`,
  including each worker's read-only connection and the hook's fresh per-invocation
  connection. Without `busy_timeout` a connection defaults to 0 and contention
  surfaces as `SQLITE_BUSY` instead of a wait.
- **Migrations are forward-only** via the `meta(schema_version)` row + the ALTER
  slot in `migrate()`. Idempotent steps may run unguarded; a non-idempotent step
  (data backfill, destructive DROP) MUST be version-guarded so a re-run can't
  corrupt an already-migrated schema. Bump `SCHEMA_VERSION` only when adding an
  ALTER; never reduce it, never branch. **When you bump `SCHEMA_VERSION`, add
  the new version to keeper-py's `SUPPORTED_SCHEMA_VERSIONS` frozenset in
  `keeper/api.py` in the SAME change.** The Python reader (used by
  `jobctl commit-work`) gates loud on any unrecognized version and will fail
  *every* `commit-work` on the host until updated — it is a hard whitelist,
  NOT a floor/ceiling, so an additive bump keeper-py never reads (e.g. a
  `usage`-only column) still must be listed. The `test/schema-version.test.ts`
  assertion enforces this: it reads `SCHEMA_VERSION` and fails the build unless
  the frozenset's max covers it. Current version: **v38** (fn-645 — additive
  nullable `usage` columns for the agentuse envelope's status / subscription /
  error axes; keeper-py reads neither `usage` nor `profiles`, so the bump is
  whitelist-only with no reader logic change. v37, fn-643: `dead_letters`
  operational sidecar table for hook-INSERT failure recovery — the slot stamps
  the version-bump but adds no data backfill, the table populates exclusively
  from the daemon's import scan against the per-pid NDJSON dead-letter files).
  The daemon is the SOLE migrator; the
  hook (`plugin/hooks/events-writer.ts`) opens with `{ migrate: false }` and
  never runs schema convergence. A hook arriving against a missing/stale schema
  fails its INSERT and — as of v37 — writes a per-pid NDJSON dead-letter file
  to `~/.local/state/keeper/dead-letters/` so the dropped event becomes
  recoverable via the `replay_dead_letter` RPC instead of silently lost; the
  hook still exits 0 per the "never block Claude" contract. Silent event
  loss is no longer the default failure mode — visible-but-recoverable is.

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
  `epics`) directly: projection changes round-trip through the plan-worker
  file watcher and the synthetic-event path, so a from-scratch re-fold
  sees every approval change exactly as it was observed. The concrete RPCs
  are `set_task_approval`, `set_epic_approval`, and `replay_dead_letter`
  (schema v37 / fn-643 — the server-worker bridges the call to main,
  which appends a plain real event with the dead-letter row's preserved
  bindings/ts and flips the audit row to `recovered` in ONE
  `BEGIN IMMEDIATE`; the server-worker itself does NOT write the event
  log, and the `dead_letters` write IS a sidecar-table write but it is
  EXPLICITLY scoped — only `replay_dead_letter` may touch it, only via
  main's bridge, and the same transaction appends the real event so the
  flip and the recovery are atomic on the log side). The protocol shape,
  the dispatch registry, and the writer lifecycle are built as a generic
  foundation, not welded to these three handlers.
- **RPC writes are scoped to two surfaces — the `approval` field on
  `.planctl` files, and the delayed-real-event replay path (`dead_letters`
  + the `events` log via main).** `set_task_approval` and `set_epic_approval`
  write the top-level `approval` field (`"approved" | "rejected" | "pending"`)
  on the target task or epic JSON via atomic temp+rename in the same
  directory as the target. The change is observed by `@parcel/watcher`,
  lifted into an `EpicSnapshot` / `TaskSnapshot` event by the plan worker,
  and folded into the `epics` projection — re-fold determinism is preserved
  because the event log carries every approval transition. A missing or
  invalid `approval` value folds to `"pending"` per the "safe value"
  invariant. `replay_dead_letter` (schema v37 / fn-643) is the delayed-
  real-event surface: the server-worker bridges to main, which picks the
  oldest `waiting` `dead_letters` row, appends a plain real `events` row
  with the row's preserved `bindings` + `ts` + real pid, and flips the
  audit row to `recovered` in ONE `BEGIN IMMEDIATE`. The appended event
  is INDISTINGUISHABLE from a fresh hook insert — it folds through the
  normal id-ordered drain on the next wake — so re-fold determinism
  holds even though the write was triggered by an RPC: the event log is
  still the authoritative source of every projection-driving fact, and
  the `dead_letters` sidecar is excluded from the re-fold reset.
  *Why these are the only RPC-writable surfaces:* approval is the one
  piece of human state that has no Claude Code hook to attach it to;
  replay is the recovery path for events the hook tried to write and
  failed to insert. Every other planctl field is the planner's or
  worker's job, and every other event-log write belongs to the hook.
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
  `events.spawn_name`. The hook MAY ALSO read `process.env.CLAUDE_CONFIG_DIR`
  on `SessionStart` only, normalize it (`undefined`/`""` → NULL; strip trailing
  `/`), and freeze the result into that event's `events.config_dir` (projected
  onto `jobs.config_dir` by the reducer's SessionStart fold with latest-non
  -NULL-wins via `COALESCE`). FORBIDDEN: ongoing/periodic scraping, scraping on
  other hook events, PPID-walking, any multi-session lineage from process names,
  any env read beyond `CLAUDE_CONFIG_DIR`, and any env read inside the reducer
  fold (env reads at fold time break re-fold determinism).

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

## Known issue: autopilot Ghostty surface-init OOM ("Oh, no." windows)

Autopilot's `launchInGhostty` spawns Ghostty windows rapidly via AppleScript.
On Ghostty `tip` (macOS), a dispatch that loses a font-metrics race at window
creation dies with an **"Oh, no. The terminal failed to initialize"** window
(~100ms into init, *before* the PTY/`claude` command ever runs). The dispatch
is silently dropped — the verb never executes — so a `work`/`approve`/`close`
may need a manual re-run (pull its command from
`~/.local/state/keeper/dispatch.log`).

- **Root cause** (Ghostty bug, not keeper): `ghostty_surface_new()` →
  `error.OutOfMemory`. `renderer/size.zig` `GridSize.update` computes
  `columns = screen_px / cell_px` with only a min clamp; when `cellSize()` is
  ~0 during a fast spawn the dimensions saturate (`u16`) and
  `renderer/cell.zig:91` `alloc(CellBg=4B, cols*rows)` requests up to ~17GB.
  NOT memory exhaustion (fires at ~236MB RSS, RAM free). NOT a crash (no
  `.ghosttycrash`). Full trace folded into the `fn-640` epic spec.
- **`fn-640` (window autoclose) is window hygiene, NOT this fix** — and is
  reportedly still not closing windows even after shipping.
- **TODO (deferred):** instrumented Ghostty build to capture the exact
  `cols × rows` at failure, then file upstream (grid alloc needs an upper
  clamp). Build from `~/src/ghostty-org--ghostty` (zig 0.15.2): add a log at
  `renderer/cell.zig:89` + `GridSize.update`, `zig build`, run it (quits the
  single-instance GUI), burst windows to repro. Passive unified-log capture
  cannot get the size — init emits no size line (verified).
- **Ops:** kill the dead windows (titled `👻`, nothing else is) —
  `osascript -e 'tell application "Ghostty"' -e 'repeat with w in windows' -e 'if (name of w) contains "👻" then close window w' -e 'end repeat' -e 'end tell'`
  (loop it; closing mutates the list). Use `close window w`, not `close`
  (`-1708`). Count crashes:
  `/usr/bin/log show --last 24h --predicate 'subsystem == "com.mitchellh.ghostty"' | grep "error initializing surface"`
  (use `/usr/bin/log` — `log` is shell-shadowed).
