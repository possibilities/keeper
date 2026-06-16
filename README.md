# keeper

## What keeper is

Keeper is an event-sourced control-data daemon for Claude Code agents. A small
TypeScript hook plugin appends one per-pid NDJSON line per Claude Code hook
invocation (lock-free — it never opens SQLite, fn-736); the daemon's events-log
ingester tails those per-pid files and lands each line as one row in the SQLite
`events` table — the durable, append-only log. A long-running Bun daemon
(`keeperd`, managed by a macOS LaunchAgent) tails that table and folds new
events into a minimal `jobs` projection: one row per session, carrying the live
`state` (`working` / `stopped` / `ended` / `killed`), a human-readable `title`
(seeded from the session's spawn name at SessionStart, refined by the prompt
payload and the live transcript `custom-title`, with a `title_source` recording
its provenance and precedence: `spawn` < `payload` < `transcript`), and — for
sessions spawned by planctl — a `(plan_verb, plan_ref)` pair derived at
SessionStart from the spawn name. The verb is the strict whitelist `{plan,
work, close}` and the ref is the targeted planctl entity (epic id like
`fn-575-foo`, or task id like `fn-575-foo.3`); both stay NULL for sessions not
spawned through planctl. Two paired stoppage annotations ride alongside
the `stopped` state: `(last_api_error_at, last_api_error_kind)` (schema
v24) marks a stoppage caused by a terminal Claude-API HTTP failure the
human hasn't picked up since, and `(last_input_request_at,
last_input_request_kind)` (schema v25) marks a stoppage awaiting a human
answer to a built-in interactive tool that fires no hook of its own
(currently `ask_user_question`, future-extensible). Both pairs paired-NULL
together: stamped on the matching reducer fold, cleared on the next
`UserPromptSubmit` / `SessionStart` revival. They ALSO clear on the next
`PreToolUse` / `PostToolUse` tool event — a tool after a stop proves the
session resumed (the CLI internally retried the transient API error, or the
human answered the in-tool question), so the same fold that NULLs the pair
also un-stops the row back to `working` (`state` and `active_since` both gated
on the literal `state = 'stopped'`, so it never resurrects an `ended`/`killed`
row and never churns `active_since` when the subagent-suppressed api-error case
left state at `working`). Each clear is gated on its own
column-is-not-NULL hot-path predicate, keeping the UPDATE cold on the 50+/turn
tool path. The `killed` state is the sibling terminal state to
`ended`: reached not from a SessionEnd hook but from synthetic `Killed` events
from three producers — the boot seed sweep, the exit-watcher's kernel arm, and
the exit-watcher's periodic dead-pid re-probe (the slow backstop for a kernel
arm that missed or raced) — each of which proves a session's `(pid,
start_time)` is gone from the OUTSIDE (SIGKILL'd, terminal-pane-closed, machine
reboot, hook crash). Both terminal states are
revivable — a fresh `claude --resume` re-opens either one to `stopped`.

The event log also indexes nine sparse signals that surface across every
session — `events.slash_command` (the leading `/foo:bar` token of a
`UserPromptSubmit` prompt), `events.skill_name` (the canonical name of a
Skill-tool invocation, e.g. `plan:plan` or `arthack:check`),
`events.tool_use_id` (the Anthropic-assigned `toolu_*` id stamped on every
`Pre/PostToolUse` row whose payload carries a non-empty `data.tool_use_id`
— the bridge that lets the reducer pair a `PreToolUse:Agent` with its later
`PostToolUse:Agent`), `events.config_dir` (the `CLAUDE_CONFIG_DIR` env
value captured by the hook on `SessionStart` — the arthack-claude profile
directory the session ran under, projected onto `jobs.config_dir` with
latest-non-NULL-wins via `COALESCE` on resume), a five-column
planctl-invocation envelope (`planctl_op`, `planctl_target`,
`planctl_epic_id`, `planctl_task_id`, `planctl_subject_present`) stamped
on every `PostToolUse:Bash` row whose `data.tool_response.stdout` parses
as JSON carrying a top-level `planctl_invocation` key — the authoritative
envelope planctl writes on every mutating call — and (schema v48 / fn-668)
three terminal-multiplexer backend-exec coordinates
(`events.backend_exec_type`, `events.backend_exec_session_id`,
`events.backend_exec_pane_id`) captured by the hook on EVERY event as pure
synchronous `process.env` reads (no fork, no fs, no PPID-walk), folded onto
`jobs.backend_exec_{type,session_id,pane_id}` latest-non-NULL-wins via
`COALESCE`. The backend is tmux, read via `TMUX` (`KEEPER_TMUX_SESSION` for the
session name, which a keeper-managed launch injects via `-e`, and `TMUX_PANE`
for the pane). The pane id is a two-step read: native `TMUX_PANE` first, else
the keeper-owned carrier `KEEPER_TMUX_PANE` (claudewrap strips `TMUX`/`TMUX_PANE`
so Claude emits truecolor, copying the pane id into the carrier first). A
human-created tmux session carries no `KEEPER_TMUX_SESSION`, so its session name
lands via the restore-worker's pane-snapshot poller (epic fn-789). The generic `backend_exec_*` naming keeps a further backend slotting in
without a schema change. Consumers can find
`/plan:work` calls, `Skill` invocations, every Task-tool subagent
lifecycle, every session's profile attribution, every planctl-CLI
mutation, AND the terminal location each live session lives in cheaply
without JSON-scanning the event `data` blob. The
`planctl_*` columns feed the creator/refiner classifier (see
[Architecture](#architecture)) — `op === "create"` and `op === "scaffold"`
both classify as creators (scaffold is the canonical epic-create path on
this codebase). As of epic fn-695 the classifier reads the deduped UNION of
these stdout-scrape rows AND the durable `Commit`-event trailer facts
(`Planctl-Op` / `Planctl-Target` / `Session-Id`), so an edge still forms when
this column lands NULL because the planctl stdout was piped / `grep`'d /
truncated (the fn-635 failure). The `planctl_*` columns remain the SOLE
driver of the `file_attributions` planctl-source rows (schema v46 / fn-666) —
the commit channel feeds ONLY the creator/refiner edge. The non-`config_dir` signals are partial-indexed
on `WHERE col IS NOT NULL`. The planctl columns ride three partial indexes
sharing the `WHERE planctl_op IS NOT NULL` predicate: `idx_events_planctl_session`
on `(session_id, id)` for the per-session ordered scan, plus the Tier 2
`idx_events_planctl_epic` on `(planctl_epic_id, session_id, id)` and
`idx_events_planctl_target` on `(planctl_target, session_id, id)` for the
reducer's `syncPlanctlLinks` cross-session sweep — the sweep is a UNION
of `planctl_epic_id IN (...)` and `planctl_target IN (...)` so the planner
SEARCHes both indexes (a cross-column `OR` would have to scan one).
`events.config_dir` rides without its own index — it is read off
`jobs.config_dir` (a steady-state attribution column), not the event log.

The architecture is deliberately small. Keeper is built on Bun + `bun:sqlite`
with a single third-party runtime dependency: `@parcel/watcher` (a native
FSEvents-backed file watcher), used by the transcript-title worker and the plan
worker. It is the one place keeper watches files instead of polling
`data_version` — because those files (transcript JSONL written by Claude Code,
`.planctl` JSON written by planctl) are written by *another* process, so there is
no keeper `data_version` to poll for them and the same-process-write blind spot
that rules watchers out for keeper's own DB does not apply. The daemon detects new
events in its own DB by polling SQLite's `PRAGMA data_version` on a read-only
connection from a Worker thread (the only reliable change-detection primitive on
macOS for keeper's DB — see [Architecture](#architecture)), then drains the log
into the projection one short transaction per event. The reducer cursor advances in the same
transaction as every projection write, so the fold is exactly-once-per-event
and the boot drain re-converges idempotently after any downtime or crash. The
boot drain runs with WAL autocheckpointing OFF (so per-event commits never
absorb a synchronous checkpoint that would hold the writer lock for seconds)
and inserts a short OS-level yield AFTER each fold's COMMIT — a bounded
event-count budget (~500 events × 5 ms ≈ 2.5 s) so the bounce window stays
small under a normal backlog, and a from-scratch re-fold catches up to head
without paying the per-event sleep for minutes. The end-of-boot WAL checkpoint
is `TRUNCATE`: it runs before any worker thread spawns, so main's writer is the
only connection attached and there is nothing to block on. Emptying the WAL means
every worker's first `openDb` reads the main file with no WAL frames to scan and
no `-shm` recovery path to walk — closing a boot-race failure surface under load.
(If an external read-only attachment is present, `wal_checkpoint` returns a busy
status row rather than throwing, degrading to a `busy_timeout`-bounded PASSIVE
pause; boot proceeds.) Steady-state checkpoints stay `PASSIVE` (writer-skipping),
never `TRUNCATE`: live workers and background readers run concurrently there, and
PASSIVE skips them without blocking.

Keeper also exposes an **NDJSON-over-UDS subscribe + RPC server** as a second
Worker thread. The read surface is **namespaced by collection**: a client names
a collection in its `query` (sort/limit/offset/filter) and gets back an ordered
page that doubles as a live subscription. Eight collections register today —
`jobs` (the first and default), `epics` (the read-only plans surface — each
epic embeds its tasks as a JSON array, so there is no separate `tasks`
collection), `subagent_invocations` (the per-job timeline of Task-tool
subagent calls — one row per `PreToolUse:Agent` paired with its later
`PostToolUse:Agent` via `events.tool_use_id`, carrying lifecycle status
`running | ok | failed | unknown | superseded` and a populated `duration_ms`
on close (NULL on rows that never observed a SubagentStop — `superseded`
peers + lifecycle-swept `unknown` orphans)), `git` (per-watched-worktree
git status — watch gate is `.planctl present || dirty || ahead of upstream > 0`,
recomputed each reconcile (epic fn-690); branch, ahead/behind, and a file-centric `dirty_files` list where
each entry carries a per-file `attributions[]` array with `source` badges
(`tool` / `bash` / `inferred` / `planctl`) naming every session that mutated the file
since its last commit; a session is attributed iff it has mutated the file
AND has not committed it more recently than its last mutation, so commit
discharges attribution and a re-edit reinstates it; as of schema v45 /
fn-664.2 the discharge is content-aware — a commit only discharges a
session's claim when its captured `(blob_oid, committed_mode)` matches
the file's current `(worktree_oid, worktree_mode)`, so a
stage→re-edit→commit file (committed bytes != worktree bytes) STAYS
attributed; the strict `orphan_files` bucket holds dirty files with
zero attribution after the inference pass), `usage` (one row per agentuse profile observed
at `~/.local/state/agentuse/<id>.json` — target, multiplier, session+week
percent and reset timestamps; schema v35 (fn-642) adds the colocated
`last_rate_limit_at` + `last_rate_limit_session_id` columns, populated
server-side by a bidirectional fan-out against the matching `profiles`
row so a single-collection client sees both quota and rate-limit state
together; schema v41 (fn-651) adds `rate_limit_lifts_at` — the soonest
`resets_at` among windows at >=100% used (when a rate-limited profile
actually unblocks, folded from agentuse's top-level `lift_at`) — and
`last_usage_fold_at`, a freshness stamp equal to the event `ts` of the
last *successful* usage fold and never bumped by an idle/stale snapshot
or the rate-limit fan-out; both ride the percentage path and are carved
out of the rate-limit UPDATE so the two folds cannot clobber each
other), and `profiles` (schema v33, fn-639 — one
row per Claude profile directory, keyed by `config_dir`, correlating the
last `rate_limit` ApiError with each profile; schema v35 adds the
derived `profile_name = basename(config_dir)` join key against
`usage.id`; the
`''` sentinel collapses default `~/.claude` so a single PK groups every
NULL-`CLAUDE_CONFIG_DIR` session), and `dead_letters` (schema v37, fn-643 —
the OPERATIONAL sidecar table, one row per unrecoverable hook write failure
(fn-643 covered the SQLite-INSERT path; fn-736 repurposed it as the events-log
APPEND-failure fallback) imported from the per-pid NDJSON files the hook writes to
`~/.local/state/keeper/dead-letters/` when its bounded retry exhausts;
keyed by `dl_id` and idempotent under re-scan; status flips
`waiting → recovered` only when the human triggers the `replay_dead_letter`
RPC. It is NOT a reducer projection — re-folding the event log never touches
it, because dead letters are the audit log of events that NEVER made it into
the event log to be folded), and `scheduled_tasks` (schema v68, fn-813 — one
row per cron a Claude session armed via the `CronCreate` tool, keyed by the
composite `(job_id, cron_id)`; folded from the `CronCreate` / `CronDelete`
`PostToolUse` pair, a CronCreate upserts an `active` row (a re-created id
resurrects) and a CronDelete flips it to `deleted`; carries the payload's
pre-rendered `human_schedule`, the `recurring` / `durable` boolean lifts, and a
deterministically truncated `prompt_summary`; served to the jobs TUI's
expanded-row cron detail section). The
surface is built so additional collections register without touching the
wire protocol or the diff machinery. Page membership is frozen at query time,
but each row's cells stream `patch` frames as the reducer folds new events.
The `result` page also carries a `total` (the filtered-set size, ignoring
limit/offset) and the server emits a third frame, `meta`, when that set
changes — a row enters or leaves the filter — so a paginated client can render
"showing X of N" and a non-disruptive "set changed, refresh" nudge without the
list reflowing under the cursor.

The QUERY surface is read-only: the server is just another reader on its own
read-only connection, polling `data_version` like the reducer-wake worker.
**Mutation is a separate, scoped path:** the same socket carries `rpc` request
frames that dispatch to registered server-side handlers, which write *external
resources* through a dedicated writer owned by the server-worker. The concrete
RPCs are `replay_dead_letter` (the scoped
synthetic-event-write recovery verb added by schema v37 / fn-643: the
server-worker bridges the call to main via the in-process message bus,
and main picks the oldest `waiting` row from `dead_letters`, appends a
plain real event with the row's preserved `bindings` + `ts` — binding the
intersection of those bindings with `INGEST_EVENTS_COLUMNS`, the SAME live
events-column list the NDJSON ingester uses (fn-762 repointed replay off the
stale fn-643 list, so a recovered row carries the newer v48/v51 columns instead
of silently dropping them) — and flips `status` to `recovered` in ONE
`BEGIN IMMEDIATE`. The recovered event then folds through the normal id-ordered
drain, and the audit row keeps its `replayed_event_id` for posterity. A
`status='poison'` row (a line the ingester could not parse — see the failure
modes below) is structurally unreachable here: the picker filters on
`status='waiting'`. Three more verbs mint a synthetic
event through the same main-bridge: `retry_dispatch` (clears a sticky
`dispatch_failures` row via a `DispatchCleared` event) and the fn-751 autopilot
control pair — `set_autopilot_mode` (`AutopilotMode` → the `autopilot_state`
singleton's `yolo`/`armed` mode column) and `set_epic_armed` (`EpicArmed` → the
`armed_epics` presence table). The fn-751 pair is APPEND-ONLY (no main→worker
relay): the level-triggered reconciler re-reads mode + armed from the projection
each cycle, woken by the fold's `data_version` bump. fn-774 gives `armed_epics`
a SECOND writer — a fold-side prune (NOT an RPC) that deletes the row when an
epic folds to `status='done'`, so a completed epic can't stay armed. RPC handlers — via the
scoped main-bridge — append real events to the log AND flip the `dead_letters`
audit row in one transaction; never reducer projections directly (see
[CLAUDE.md](./CLAUDE.md)'s DO NOT list). Example clients ship under the unified
`keeper` CLI (`keeper board`, `keeper jobs`, `keeper autopilot`, `keeper git`,
`keeper usage`, `keeper await`); see [Example clients](#example-clients) for
usage.

## What keeper is NOT

Keeper's read surface is intentionally narrow. Explicit non-goals:

- **No reactor, no general write path into the reducer** — the UDS server's
  QUERY surface is read-only (`query` → `result` + `patch` + `meta`); the
  reducer's `jobs` / `epics` projections and the `events` log have one
  canonical writer each (the hook for hook events; main for synthetic
  events). The socket DOES carry `rpc` frames, but RPC handlers write only a
  tightly-scoped set of external surfaces — never the reducer's projections
  directly. The write verbs (`replay_dead_letter`, `retry_dispatch`, and the
  fn-751 autopilot pair `set_autopilot_mode` / `set_epic_armed`) APPEND a
  synthetic event through the scoped main-bridge so the reducer — still the sole
  projection writer — folds it on the next drain. Consumers may still read any of
  it directly from SQLite.
- **No live membership stream** — `meta.total` signals that the filtered set's
  size or membership *changed*, but it does NOT deliver the new members. Frozen
  membership stands: the live page never reflows. `meta` is a count/staleness
  nudge ("re-query if you care"), not a live insert/remove/reorder feed. The
  server may COALESCE meta emission — at most one nudge per
  `META_MIN_INTERVAL_MS` per subscription (fn-697) — so a burst of folds
  collapses into fewer client-refetch rounds; a throttled-away move is never
  lost (the latest membership state always converges on a later tick, with the
  server poll loop as the convergence backstop). Patches (the cell stream) are
  never throttled, so this never delays a live cell update.
- **No UI** — `sqlite3` is the inspection surface.
- **No multi-machine** — single host, single DB file.
- **No general name scraping; no transcript tailing in the hook** — the hook
  reads hook payloads only, with one scoped exception: on `SessionStart` it
  scrapes the parent claude process's `--name`/`-n` spawn name (via a single `ps`
  of its immediate parent) so a job row reads a non-NULL `title` from the first
  event. That capture is one-shot, in-hook, and frozen into the event;
  ongoing/periodic scraping and PPID-walking remain out. Transcript tailing is
  permitted in the *daemon* (keeperd's transcript worker tails the external
  transcript tree on a watch to supply the priority-3 `transcript` title) but
  stays forbidden in the hook.
- **No general plan write path through the socket** — keeper *reads* planctl
  state into the single `epics` projection, each epic embedding its tasks as a
  JSON array, each epic also embedding its plan/close-verb jobs as a JSON
  array, and each task element embedding its own work-verb jobs as a nested
  JSON array (a fourth, read-only producer worker watches the configured
  roots' `.planctl/{epics,tasks}` trees; jobs fan in from the reducer's own
  jobs-side writes whenever a SessionStart spawn name parses as
  `{plan|work|close}::<ref>`). The socket carries no plan mutations: every field
  of every `.planctl` file is read-only end to end, the same fence as `jobs`.
- **No multi-session-per-job lineage** — v1 holds `job_id === session_id` (one
  session per job).
- **No kernel watchers on keeper's own DB** (`fs.watch` / FSEvents / kqueue) —
  `data_version` polling is the change-detection primitive for keeper's SQLite.
  The watchers keeper does run (`@parcel/watcher`, on the *external* transcript
  tree at the configured `claude_projects_root` and on the configured plan
  `roots`) are the scoped exception: those files are written by another process,
  so the same-process-write blind spot does not apply.
- **No caught-up barrier** and no in-process self-heal — a crash exits non-zero
  and the LaunchAgent restarts the single, well-tested recovery path. Two scoped
  exceptions handle a watcher that misbehaves without escalating. (1) A
  *recoverable* FSEvents dropped-events signal on the external watchers (the
  producer workers' "...must be re-scanned" error): the affected worker schedules
  a debounced, single-flight re-scan of its existing change-gated boot-scan path,
  recovering the missed change without re-subscribing on THIS path — the live
  subscription stays up. (2) A *silently-mute* subscription (one that stops
  delivering entirely): the heartbeat backstop replaces it — `await
  unsubscribe()` then a fresh `subscribe()` with identical options, sequential
  and bounded, generation-guarded so a stale in-flight callback no-ops, and
  flap-guarded so a still-mute replacement can't churn. The plan worker has many
  roots, so it flags the affected root(s) and the next reconcile replaces ONLY
  those subscriptions; the transcript worker has one static subscription and no
  reconcile loop, so the heartbeat drives the single replace directly. Either
  way the change-gate / byte offsets survive, so no phantom re-folds emit. Both
  are data recovery, not
  process self-heal — no worker is respawned; every other unrecoverable error
  still exits non-zero for the LaunchAgent to restart.

These are designed to be addable later without rework, but none ship in v1.

## Install

Keeper has no `install` verb. Wire it up manually:

1. **Clone and install dependencies** (Bun must already be on your machine):

   ```sh
   git clone <repo-url> ~/code/keeper
   cd ~/code/keeper
   bun install
   ```

2. **Create the state directory** (launchd does not pre-create it):

   ```sh
   mkdir -p ~/.local/state/keeper
   ```

3. **(Optional) Configure roots.** `~/.config/keeper/config.yaml` carries
   INDEPENDENT keys:

   - `roots` — the project roots the plan worker watches for
     `.planctl/{epics,tasks}` trees, folding them into the single `epics`
     collection (tasks embedded per epic). Default (no config): the single root `~/code`.
   - `claude_projects_root` — the single tree the transcript worker watches for
     session JSONL (to fold `custom-title` renames). Default: `~/.claude/projects`.
     Override only if your Claude Code transcripts live elsewhere.
   - `exec_backend` — the terminal multiplexer keeperd's server-side autopilot
     reconciler dispatches workers into. `tmux` is the sole backend and the
     default; any other value warns and falls back to `tmux`. The managed-session
     name is hardcoded (`autopilot`), NOT configurable; each dispatch opens a new
     window inside that shared background session. The window-reaper worker
     closes a managed window ONLY once its work is verifiably complete (stopped
     past a short debounce with a completed readiness verdict — gone within
     ~1-2s); every other window stays open for inspection.
   - `max_concurrent_jobs` — the global cap on concurrent autopilot worker
     jobs. A positive integer enforces the cap; omit or set non-positive
     (the default) to leave it unlimited. The cap bounds only `work`/`close`
     launches.

   ```sh
   mkdir -p ~/.config/keeper
   cat > ~/.config/keeper/config.yaml <<'YAML'
   roots:
     - ~/code
     - ~/src
   claude_projects_root: ~/.claude/projects
   exec_backend: tmux
   max_concurrent_jobs: 3
   YAML
   ```

   A `~`-prefixed value is expanded to `$HOME`. For `roots`, a non-existent root
   is skipped (the others keep watching); for `claude_projects_root` a not-yet-
   existing path is returned as-is (the worker tolerates a late-appearing tree).
   All keys fall back independently — a missing/malformed one never disturbs
   the others; a missing or malformed config falls back to every default
   (`roots: [~/code]`, `claude_projects_root: ~/.claude/projects`,
   `exec_backend: tmux`). Unknown config keys are silently ignored.

4. **Load the keeper plugin via the arthack launcher** (`--plugin-dir`). The
   repo root carries `.claude-plugin/plugin.json` (canonical manifest) and
   `hooks/hooks.json` (events-writer command paths). The arthack launcher
   appends `--plugin-dir ~/code/keeper` for every profile, so a fresh
   session auto-loads the hook (and any future `skills/`) from this repo.
   No symlink step. A `~/.claude/plugins/keeper` symlink double-registers the
   hook (every invocation writes two `events` rows, with no runtime dedup
   guard) — there must be none.

5. **Symlink the LaunchAgent template** into `~/Library/LaunchAgents/`:

   ```sh
   ln -s "$PWD/plist/arthack.keeperd.plist" ~/Library/LaunchAgents/
   ```

   The plist hard-codes absolute paths for `bun`, the repo, and the state dir.
   Edit `plist/arthack.keeperd.plist` first if your username, checkout path, or
   architecture differ. On **Apple Silicon** bun lives at `/opt/homebrew/bin/bun`;
   on **Intel** Macs it is `/usr/local/bin/bun` — fix both `ProgramArguments` and
   `EnvironmentVariables.PATH` accordingly. The plist in
   `~/Library/LaunchAgents/` must be owned by you and mode `644` (symlinking a
   `644` file is fine; macOS silently ignores a plist with wrong ownership).

6. **Bootstrap the daemon** (modern, post-Catalina form — do not use the old
   `launchctl load -w`):

   ```sh
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/arthack.keeperd.plist
   ```

   **The daemon does the schema work, but the hook no longer needs it to be
   booted to capture events.** Since fn-736 the hook does NOT open SQLite at
   all — it appends a per-pid NDJSON line under the events-log dir
   (`KEEPER_EVENTS_LOG`, default `~/.local/state/keeper/events-log`) and exits.
   The daemon is still the sole migrator and the sole writer of `events` rows:
   on a fresh install the LaunchAgent runs the daemon at login, which creates
   the DB, runs `migrate()` to converge the schema, and starts the events-log
   ingester. Failure / skew modes, all lag-not-loss:

   1. **Daemon not booted yet** (fresh install, pre-`launchctl bootstrap`).
      The hook's NDJSON appends pile up in the events-log dir; nothing is lost.
      The first daemon boot runs a boot ingest that drains every backed-up
      per-pid file into `events` (from its durable byte-offset, exactly-once),
      then folds. The manual recovery is the `launchctl bootstrap` above.
   2. **`events` table behind by a column** (the daemon hasn't yet applied a
      fresh `ALTER TABLE` from the latest commit). This is now handled
      DAEMON-side and race-free: the ingester intersects each record's bindings
      with the live `events` columns at INSERT time (post-migrate), so a
      not-yet-known column is simply omitted and lands NULL after the next
      `migrate()` — identical to the deriver's zero-event value. The hook,
      knowing nothing about the live schema, just appends every binding.
   3. **Hard append failure** (ENOSPC / EACCES / EROFS on the events-log dir).
      The hook writes a per-pid NDJSON dead-letter file (recoverable via
      `replay_dead_letter`), logs to stderr, and exits 0 — the event is
      captured for replay but the session is never blocked.
   4. **Poison line in an events-log file** (a `\n`-terminated line the ingester
      cannot parse — corrupt JSON, a non-object, a nested/non-finite binding).
      Pre-fn-762 the ingester STOPPED at it and the file's byte-offset stuck
      there forever, silently wedging every later line behind it. Now the
      ingester PARKS the poison line as a `dead_letters` row with
      `status='poison'` (deterministic `dl_id` keyed on the file inode + byte
      offset, `ON CONFLICT DO NOTHING` so a re-scan never duplicates it),
      committed in the SAME `BEGIN IMMEDIATE` as the surrounding events INSERTs +
      the offset advance, then ADVANCES past it — one scan drains a multi-poison
      file and still ingests every valid line after the bad one. A poison row is
      non-replayable by construction (replay filters `status='waiting'`); each
      parked line emits an `events-ingest-poison` backstop record for
      observability. A torn TAIL (bytes after the last `\n`, no terminator) is
      NOT poison and still blocks — a later append can complete it. A transient
      DB failure during the transaction rolls EVERYTHING back (offset included)
      and the next scan retries — block, never advance.

   **Upgrade-from-pre-trace-gate note:** if you are re-bootstrapping over an
   existing install whose `server.stderr` predates the `KEEPER_TRACE_SERVER`
   gate (the file may be hundreds of megabytes of `[srv-ts]` lines), run this
   one-time truncate FIRST to reclaim the disk space:

   ```sh
   truncate -s 0 ~/.local/state/keeper/server.stderr
   ```

   This is the only manual operator action required by the trace-gate upgrade;
   normal runtime growth is now bounded by the rare `[server-worker]` error
   class plus the weekly rotation sidecar (next step).

7. **Install the rotation sidecar** so `server.stderr` doesn't grow unbounded
   over weeks even with `KEEPER_TRACE_SERVER=0`:

   ```sh
   cp plist/arthack.keeperd.logrotate.plist ~/Library/LaunchAgents/
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/arthack.keeperd.logrotate.plist
   ```

   The sidecar is a user-LaunchAgent that runs Sunday 04:00 weekly,
   `truncate`s `server.stderr`, and `launchctl kickstart`s the daemon so the
   new process opens a fresh fd at offset 0. macOS `newsyslog` is not used
   (it needs SIGHUP-reopen or daemon termination per rotation — neither is
   wired up). Weekly daemon restart is the cost; expect a one-time
   reconnect across your subscribe clients each Sunday at 04:00. Inspect with
   `launchctl print gui/$(id -u)/arthack.keeperd.logrotate`.

8. **Install the sitter scanners** (optional) — the read-only sitter set (performance, builds, helptailing) now lives in its own repo at `~/code/sitter`; see that repo's `README.md` for launchd install/uninstall.

9. **Verify** the agent is loaded and the projection is live:

   ```sh
   launchctl print gui/$(id -u)/arthack.keeperd | head
   sqlite3 ~/.local/state/keeper/keeper.db '.tables'
   lsof -U | grep keeperd.sock   # the subscribe server's UDS listener
   ```

   Start a Claude Code session and confirm rows appear in `jobs` (see
   [Inspect](#inspect)).

   The subscribe server binds a Unix-domain socket at
   `~/.local/state/keeper/keeperd.sock` by default (a sibling of `keeper.db`).
   Override the path with the `KEEPER_SOCK` environment variable. The hook
   also honors `KEEPER_DROP_LOG` (path to the diagnostic drop-log NDJSON,
   default `~/.local/state/keeper/hook-drops.ndjson`) and
   `KEEPER_DEAD_LETTER_DIR` (directory for per-pid dead-letter NDJSON
   recovery files, default `~/.local/state/keeper/dead-letters/`) — tests
   that spawn the real hook MUST override both to keep production
   diagnostic feeds clean. The daemon also honors `KEEPER_BACKSTOP_LOG`
   (path to the backstop-telemetry sidecar NDJSON, default
   `~/.local/state/keeper/backstop.ndjson`; epic fn-720) — the append-only
   feed every change-propagation backstop writes a uniform record to when
   it fires, tagged with whether it actually RESCUED a missed fast path.
   Main is the SOLE writer (workers `postMessage` rescue/rollup records up);
   it is a pure consumer-side side-file — never read by the reducer, never
   feeds a projection — so a write failure is best-effort/swallowed.
   `scripts/backstop-stats.ts` aggregates it into per-(backstop,class)
   rescue count, rescue RATE (rescues ÷ total fires, from the rollup
   denominator), staleness p50/p95/p99, and per-rescue
   `{ts, staleness_ms, change_to_rescue_ms}` samples (which the performance sitter
   windows by a `ts` watermark — classifying on `change_to_rescue_ms`, the true
   latency — so an old resolved rescue never re-fires). Spawn-tests MUST override this
   path too (alongside `KEEPER_DB` / `KEEPER_DROP_LOG` /
   `KEEPER_DEAD_LETTER_DIR` / `KEEPER_RESTORE_FILE`) so the suite never
   writes the user's real state dir — build the sandboxed env via the shared
   `sandboxEnv(...)` in `test/helpers/sandbox-env.ts` rather than restating the
   path list at each spawn site (it sets the state paths LAST so a caller can't
   strand one). The
   suite carries TWO complementary test helpers (fn-769): `sandboxEnv` isolates
   the state paths for any test that launches a real subprocess (hook / daemon /
   CLI), while the template-DB helper in `test/helpers/template-db.ts`
   (`freshDb()` / `freshDbFile()`) serves pure in-process unit tests that only
   need a migrated schema — it migrates one `:memory:` DB per file-process,
   `serialize()`s it once, and deserializes a per-test clone (~0.2ms) instead of
   re-running the 63-version `migrate()` ladder on every `openDb(":memory:")`,
   which is what made the default `bun test` fast (the slow process-level files
   are tiered behind `bun run test:full`; see CLAUDE.md `## Test isolation`). A
   third helper, `retryUntil` (`test/helpers/retry-until.ts`), polls until an
   async worker/daemon condition holds and is the canonical replacement for a
   fixed `Bun.sleep` deadline race. The restore worker (epic fn-677) writes
   `~/.local/state/keeper/restore.json` as a dumb single-tier
   `{schema_version, current}` live mirror — a DISASTER FALLBACK only, since the
   live crash-restore set is now derived at read time from `keeper.db`'s
   producer-stamped `close_kind` / `window_index` columns (fn-817), not from
   this file. Overridable via `KEEPER_RESTORE_FILE` for tests. Set
   `KEEPER_TRACE_SERVER=1` to enable verbose server-worker diagnostic logging
   — `[srv-ts]` stage timings, frame byte counts, connection lifecycle — on
   `server.stderr`; off by default (the rare `[server-worker]` error class is
   always logged). The plist's `EnvironmentVariables` block carries
   `KEEPER_TRACE_SERVER=0`; flip to `1` then
   `launchctl kickstart -k gui/$UID/arthack.keeperd` to enable.
   `KEEPER_TRACE_SERVER` governs the server worker only; reducer fold latency
   has its own always-on, threshold-gated diagnostics that need no flag. A fold
   over `SLOW_FOLD_LOG_MS` logs one `[fold-slow]` line splitting `lock_wait_ms`
   (BEGIN-IMMEDIATE contention) from `work_ms` (the projection work that held
   the lock) — one read tells you whether a slow fold was starved or busy. The
   slow event types each emit a per-pass `[*-breakdown]` line above their own
   `*_FOLD_BREAKDOWN_MS` gate: `[gitfold-breakdown]` (GitSnapshot per-pass +
   pass-1 per-arm split), `[commitfold-breakdown]`, `[subagentfold-breakdown]`,
   `[ptufold-breakdown]` (PostToolUse), and `[pretufold-breakdown]` (PreToolUse
   — covers the `/plan:plan` opener fold). The commit / PostToolUse / PreToolUse
   breakdowns carry `planctl_*` counters (calls, touched epics, swept sessions,
   trailer-fact rows + load ms) that attribute the `syncPlanctlLinks` fan-out.
   Steady folds stay silent, so a quiet `server.stderr` is the fold-latency
   all-clear.

   Example clients ship under the unified `keeper` CLI — `keeper board` /
   `keeper jobs` / `keeper autopilot` / `keeper git` / `keeper usage` /
   `keeper dash` (subscribe; the readiness clients go through
   `src/readiness-client.ts`) — see
   [Example clients](#example-clients).

10. **(Optional) Provision the tmux control plane** — `keeper setup-tmux`
    stands up the `dash` dashboard session (board + autopilot/jobs/git/builds/
    usage panes, all in `~/code/keeper`) and ensures the `autopilot`,
    `background`, and `foreground` work sessions exist (one shell window each,
    stamped with `KEEPER_TMUX_SESSION`). It rebuilds `dash` on every run, never
    attaches or `switch-client`s (safe inside or outside tmux), and leaves
    existing work sessions untouched. `--kill-sessions` tears all four down
    first, prompting only when the work sessions hold busy panes:

    ```sh
    keeper setup-tmux                 # rebuild dash, ensure work sessions
    keeper setup-tmux --kill-sessions # tear down all four first, then rebuild
    ```

## Example clients

The unified `keeper` CLI exposes the example subscribe + RPC clients as
typed subcommands (wired through `cli/keeper.ts`, the package.json
`bin` — a single dispatcher entrypoint that fans into all subcommands).
`keeper board` is the read-only subscribe client (epics-only view);
`keeper jobs` is its sibling (the bottom jobs list with the
`[dead-letter:N]` banner and the `r` replay-dead-letter key — the two
moved out of `keeper board` in fn-658 so each TUI owns one frame
shape); `keeper autopilot` is its dispatch-oriented sibling (flat
command list plus a `===`-delimited "ready" block); `keeper git`
watches the `git` worktree collection; `keeper usage` watches the
`usage` collection; `keeper await` is the blocking
wait-for-condition client (emits a Monitor-shaped `armed`/`met`/`failed`
event stream on stdout and exits when its condition holds — a planctl
epic/task going `complete` or `unblocked`, the cwd's repo going
`git-clean`, other agents going `agents-idle`, keeperd coming back up via
`server-up` (reconnect-forever; the escape hatch for a slow cold boot),
the caller's own background
monitor finishing via `monitor-running <selector>`, or any AND-combination
like `keeper await git-clean and agents-idle`). The
subscribe clients share helpers in `src/readiness-client.ts` —
`subscribeReadiness` owns the three-collection lifecycle (board +
autopilot) and `subscribeCollection` owns the single-collection
lifecycle (git, usage); both feed `computeReadiness` / row-list
callbacks (the pure verdict pipeline lives in `src/readiness.ts` as
library code, not a runnable script). All five snapshot-capable viewers (`board`, `jobs`,
`git`, `autopilot`, `usage`) resolve their output mode through a
three-way TTY gate (fn-772, shared `src/snapshot.ts` / `src/view-shell.ts`
seam); `keeper dash` is a TTY-ONLY exception outside this gate (no snapshot
mode — a non-TTY stdout exits 1, see the `dash.ts` bullet below): (1) **TTY
stdout** → today's alt-screen live TUI, byte-for-byte
unchanged, with per-frame state/diff sidecars and keyboard navigation
(←/h/k prev frame, →/l/j next, g oldest, G/End/Esc return to live,
q/Ctrl-C quit); (2) **non-TTY stdout** (piped, redirected, or under CI) →
**snapshot mode**: the viewer waits deterministically for the current
fully-folded frame (a stream-readiness latch holds multi-stream views
until every subscribed stream delivers its first frame), prints that
frame as plain text plus a metadata block ending in one single-line,
machine-parseable `keeper-meta: {…}` JSON record (the LAST line of
stdout in every mode), then EXITS — no spinner spam, no unbounded
stream, no hung tool call; (3) **`--watch`** → force the live subscribe
stream even when piped (today's old non-TTY passthrough, never exits).
The trigger precedence is flag (`--snapshot` / `--watch`) > env
(`CI` / `TERM=dumb` force snapshot even under a pty) >
`process.stdout.isTTY !== true`. Exit codes: `0` a frame was emitted
(an empty-but-healthy projection counts), `1` no frame before the
`--timeout <s>` (~2s default) escape (`keeper-meta.status` distinguishes
`timeout` vs `daemon-unreachable`; the `keeper-meta:` line with
`frame:null` still lands on stdout, the human diagnostic on stderr),
`2` CLI misuse (`--snapshot`+`--watch`, or a bad `--timeout`). This is a
pure client-side change — no schema bump, no `api.py` whitelist, no
event-log/reducer/hook touch. Run any of them with
`keeper <subcommand> --help`, or `keeper` for top-level help.

- `board.ts` — epics-only "board" UI over the `epics`,
  `subagent_invocations`, and `jobs` collections (the latter as a
  passive feed for the per-task / per-link rendering nested inside each
  epic block). Subscribes through the shared `subscribeReadiness`
  helper and emits one epics-only frame per change, led by `---`. Uses
  server-default scope: epics are scoped via the descriptor's
  `defaultClause` — schema v63 (fn-756) materializes the predicate
  `status='open'` as the VIRTUAL generated column
  `default_visible` and serves it from the partial index
  `idx_epics_default_visible WHERE default_visible = 1` as a covering
  SEARCH — `subagent_invocations` full per-job timeline, `jobs` live
  only (`working + stopped`). The flat bottom jobs list and the
  `[dead-letter:N]` banner (with the `r` replay-dead-letter key) moved
  to `keeper jobs` in fn-658 — see the `jobs.ts` bullet below. Both the
  board and `keeper jobs` follow the OMIT-DEFAULT pill convention
  (fn-708): a pill renders only at its non-resting value, so the
  ABSENCE of a pill encodes the field's one default —
  `no runtime pill` ⇒ `todo`, `no [worker-done]` ⇒ `open`,
  `no [validated]` ⇒ `unvalidated`, `no [state]` ⇒ `stopped`, `no
  subagent pill` ⇒ `ok`. The convention is documented in each view's
  `--help` (`keeper board --help` / `keeper jobs --help`). Each
  epic renders as a header line —
  `({dir}) {epic_number} {title} [#dep,#dep] [validated]?
  [slotted-after-closer]? [ready|completed|blocked:<reason>]` (the
  `[validated]` pill appears ONLY when the epic is validated; its absence
  encodes `unvalidated`) — followed by indented task lines
  (the `{epic_number} {title}` label falls back to `{epic_id}` when BOTH
  are null — a pre-`EpicSnapshot` stub row in the partial-projection
  window between the `EpicSnapshot` and `TaskSnapshot` folds — so the
  header stays legible and identifiable instead of collapsing to a near-
  blank `({dir})` line — under fn-708's omit-default an unvalidated stub
  no longer even carries a trailing `[unvalidated]` pill; the row is
  never hidden, fn-700)
  (the optional `[slotted-after-closer]` pill — schema v29, active/cyan
  bucket — appears only when the epic was minted by another epic's
  closer session, i.e. `epics.created_by_closer_of != null`; its
  presence is also what slots the row directly below its parent under
  the default `sort_path ASC` ordering)
  (with omit-default `[<runtime>]? [worker-done]?
  [ready|completed|blocked:<reason>]` pills — the two native fields
  consolidated per fn-708: the planctl runtime enum elides its `todo`
  default, renders `in_progress` / `done` verbatim, and relabels
  `blocked` → `[rt:blocked]` so it never collides with the verdict
  `[blocked:*]` family; the derived worker-phase binary never renders
  `open` and surfaces its `done` survivor as the LABELED `[worker-done]`
  (never bare `[done]`, and only when the verdict doesn't already pin it
  — i.e. not `completed`/`job-pending`/`git-uncommitted`/`git-orphans`))
  and a final "Quality audit and close" line for the epic
  itself (its `[status]` pill is dropped — the board filter pins it to
  `open` — so the close row usually collapses to just the title plus
  its `[id] <verdict>` reference line). Sub-agent invocations nest one
  indent level under their owning job row as `{type}: {desc} [<status>]?`,
  stamping the raw projection enum verbatim BUT following omit-default —
  `ok` (and a null/empty status) renders NO pill (absence ≡ `ok`); the
  non-resting `running|failed|unknown|superseded` states render (no
  hiding — `superseded` is promoted natively by the projection so the
  full audit trail of re-entrant attempts is visible). The `[validated]`
  pill reflects planctl's `last_validated_at` timestamp on the epic file
  (flipped by `planctl validate --epic <id>`); its absence encodes
  `unvalidated`. The `[ready] / [completed] /
  [blocked:<reason>]` pill is a pure-function readiness verdict computed
  from the three-collection snapshot (see `src/readiness.ts`); a
  blocked row is followed by a `   (reason: <reason>)` continuation
  line so the human reads the cause without scanning the upstream rows.
  The `BlockReason` vocabulary splits epic-dep failures into two cousins:
  `dep-on-epic <id>` (amber / warn — the upstream IS in the snapshot
  but its close verdict isn't `completed`; for an in-snapshot upstream
  this clears only once it is done AND its closer idle) and `dep-on-epic-dangling
  <id>` (red / error — the upstream id failed to resolve at all,
  meaning either a full-id miss, a bare `fn-N` miss, or an ambiguous
  bare-id with no same-project disambiguator). The dangling case
  surfaces planctl's fn-600 cross-project bare-id dep contract: a
  stored `fn-100` on `epic.depends_on_epics` resolves cwd-then-global
  against the in-snapshot epics index built inside `computeReadiness`,
  and an unresolvable id is a structural problem (typo, deleted
  upstream, missed project root) — distinct from "upstream is still
  cooking". When the resolver lands a cross-project match the renderer
  prefixes the pill `dep-on-epic <project>::<id>` (e.g.
  `[blocked:dep-on-epic arthack::fn-633-git-attribution]`) so the
  cross-project provenance reads at a glance; intra-project deps keep
  the bare-id render. A close-row-specific reason `epic-no-tasks` (amber /
  warn) fires on the "Quality audit and close" row of an epic with ZERO
  tasks (the partial-projection window between the `EpicSnapshot` and
  `TaskSnapshot` folds) so the autopilot never dispatches a closer
  against an epic with no work — `verbForVerdict` returns `null` for the
  blocked verdict (fn-700). The board's epic-header summary pill uses the
  same shared `resolveEpicDep` so the summary and the row pill agree:
  `[#N]` intra-project, `[arthack::#N]` cross-project,
  `[?#N]` dangling. Ambiguous-bare-id resolutions (2+ matches with no
  same-project disambiguator) emit one
  `{ts, kind:"ambiguous-dep-resolution", consumer_epic, upstream,
  matches: string[]}` line per occurrence to
  `~/.local/state/keeper/readiness-diagnostics.jsonl` so the human
  sees which candidates collided; the line is appended atomically
  (POSIX O_APPEND under PIPE_BUF) so board.ts and autopilot.ts can
  write concurrently without flock. Job/link rows also carry two
  optional stoppage-annotation pills that stack after the (omit-default)
  `[state]` pill in lifecycle order: `[failed:<kind>]` (red /
  error bucket) when the session's last Claude-API request hit a
  terminal HTTP failure — the six rendered kinds are `rate_limit |
  authentication_failed | billing_error | server_error |
  invalid_request | unknown` — and `[awaiting:<kind>]` (yellow / warn
  bucket) when the session is stopped on a built-in interactive tool
  that fires no hook of its own (currently `[awaiting:ask_user_question]`,
  future-extensible). The colorizer (`PILL_COLORS` in
  `scripts/board.ts`) routes tokens through five buckets — `active`
  (cyan) for in-motion, `success` (green) for terminal-positive,
  `error` (red) for structural failure (including
  `dep-on-epic-dangling` via both an exact-match entry and a
  `blocked:dep-on-epic-dangling` prefix branch that wins over the
  generic `blocked:*` → `warn` fallback), `warn` (yellow) for
  blocked/waiting, `faded` (dim) for historical — and prefix fallbacks
  (`failed:*` → `error`, `awaiting:*` → `warn`,
  `blocked:*` → `warn`, `running:*` → `active`, `task-repo:*` →
  `warn`) so future kinds need no code change. The two fn-708
  de-ambiguated tokens are colored: `[worker-done]` → `success` (green,
  the same family as bare `[done]`) and `[rt:blocked]` → `warn` (yellow,
  the same family as bare `[blocked]`). Pills NOT in `PILL_COLORS` render
  uncolored on purpose — the eye picks `unknown` and the role labels
  (`planner|worker|closer|creator|refiner`) out by absence of color (the
  former resting defaults `todo` / `unvalidated` / `open`
  no longer render at all under fn-708's omit-default rule, so they need
  no colorizer carve-out).
  The byte-compare emit gate keeps the stream quiet when row churn
  doesn't surface in the render. Reconnects across keeperd restarts;
  Ctrl-C unsubscribes cleanly — and so do SIGHUP, parent-death (a
  ~2s `ppid === 1` poll), and controlling-TTY loss (stdin EOF), so an
  orphaned viewer self-exits within ~2s instead of running headless
  forever (fn-723). Every emitted frame is mirrored to three
  per-pid `/tmp` sidecar files (epics JSON state, frame text, unified
  diff vs. the previous emit); when stdout/stdin are both TTYs the
  client enters a real TUI (alt-screen + ring-buffered frame history
  with keyboard navigation) AND indexes the sidecars so past frames
  remain inspectable. The keymap is `←/h/k` previous frame, `→/l/j`
  next, `g` jump to oldest, `G`/`End`/`Esc` snap to live, `c` copies
  the current frame + sidecar paths to the clipboard, `q`/`Ctrl-C`
  quit; under non-TTY (piped, redirected, CI) the TUI gate resolves to
  snapshot mode (fn-772) — board is a 2-stream view, so the latch holds
  until both streams fold before printing one frame + `keeper-meta:` and
  exiting (`--watch` forces the old live passthrough).

  ```sh
  keeper board            # epics-only board, default scope
  keeper board | tail -1  # one-shot snapshot; last line is parseable keeper-meta JSON
  ```

- `jobs.ts` — live jobs-list sibling of `board.ts` (fn-658). Renders the
  bottom jobs list as a two-stack frame led by `---`: jobs with NO
  `plan_verb` (ambient sessions) on top, jobs WITH `plan_verb`
  (planner/worker/closer — epic-bound work) below, joined by a `~~~`
  divider. The empty-side drop rule applies: a partition with zero rows
  yields just the other one with no divider; both empty yields an empty
  body (the frame is just the `---` lead). Each row is followed by its
  nested sub-agent collapse lines (one per `(job_id, subagent_type)`
  group via `collapseSubagentsByName` — `(×N)` and `N stuck`
  annotations surface the folded count and any non-surviving `running`
  rows). The banner status line carries a persistent `[dead-letter:N]`
  warn pill (schema v37, fn-643) when the `dead_letters` collection has
  waiting rows; the `r` keypress fires the `replay_dead_letter` RPC
  (single-shot `rpc` → `rpc_result`), recovering the OLDEST waiting
  row — the daemon appends a plain real event and flips the audit row
  to `recovered` in one transaction. Jobs flashes `[replaying…]`
  immediately, then `[recovered <dl_id>]` / `[nothing to replay]` /
  `[replay failed: …]` for ~1.5 s before the persistent
  `[dead-letter:N]` pill resumes; on success the dropped session
  reappears in the next frame and `N` drops by one. The pill is
  re-stamped on every snapshot BEFORE the body byte-compare
  short-circuit, so the count tracks reality even when the rendered
  body is byte-stable. Each job row also carries an optional trailing
  `[p<pane>]` pane pill (schema v48 / fn-668) — the terminal-multiplexer
  backend-exec pane coordinate lifted off the three live
  `jobs.backend_exec_{type,session_id,pane_id}` columns by the shared
  `projectJobRow` helper, so the CLI list and the TUI both surface which
  pane each live session runs in (the row is already grouped under its
  `--- <session> ---` heading). Plain text (no SGR baked in) so sidecars
  and non-TTY output stay clean; a missing pane drops the pill entirely,
  so rows with no backend coords show nothing at all (never `undefined`,
  never a placeholder). There is no `<tab>` slot. When the row is
  expanded in insert mode, a per-job Monitors section (schema v51 /
  fn-682, enriched fn-718) lists the live background shells the
  session is running, parsed off the `jobs.monitors` JSON-array
  column. Each entry renders on up to two lines:

  ```
  [<kind>] <description-or-id>
      <command first non-empty line>
  ```

  where `<kind>` is the three-way provenance pill `monitor` /
  `bash-bg` / `ambient`, the primary label is the entry's
  `description` (falling back to its id when empty), and the indented
  continuation line carries the command/script — emitted ONLY when
  the entry has a non-empty `command` (a 1KB+ multi-line heredoc
  collapses to its first non-empty line so the row stays one terminal
  line tall). An entry with no command renders a single line.
  `status` is never shown — it is empirically always `"running"`
  (fn-708 J7). The section sits BETWEEN the backend-coords pill and
  the sub-agent lines inside the collapse-controlled region; an empty
  / missing / malformed `monitors` blob produces no Monitors lines
  and never crashes the render. After the sub-agent lines a per-job
  scheduled-tasks (cron) section (schema v68 / fn-813) lists the
  session's live crons, bucketed per frame from the `scheduled_tasks`
  collection's `state.rows` (NOT `byId` — the composite
  `(job_id, cron_id)` identity would otherwise collapse a multi-cron
  session to one row). Each cron renders on one line:

  ```
  [<marker>] <human_schedule-or-cron>: <prompt_summary>
  ```

  where `<marker>` is `recurring` / `one-shot`, upgraded client-side to
  `spent` (a one-shot on an exited session) or `expired` (a recurring on
  an exited session) — job state (`ended` / `killed`) is the liveness
  authority for that marking, since the fold never flips a row's status.
  `deleted` crons are filtered out; survivors sort by `ts` asc with a
  `cron_id` tiebreak. The schedule falls back to the raw `cron` string
  when `human_schedule` is empty, and the trailing `: <prompt>` is
  omitted when the (untrusted, fold-truncated) `prompt_summary` is empty.
  `durable` is stored but not rendered. The section sits AFTER the
  sub-agents (established expanded-row order: backend pill → Monitors →
  sub-agents → scheduled tasks); a job with no crons emits no lines.
  Same sidecar / TUI / non-TTY snapshot
  (fn-772) / `--watch` contract as board (jobs is single-stream, so its
  latch is just the first frame) — including the SIGHUP / parent-death /
  TTY-loss self-exit (fn-723), so an orphaned jobs viewer exits within ~2s.

  ```sh
  keeper jobs             # live jobs list (TTY); non-TTY → one snapshot + exit
  keeper jobs | tail -1   # last line is the parseable keeper-meta JSON record
  ```

- `autopilot.ts` — thin viewer + control surface over the server-side
  autopilot reconciler (the autopilot worker thread inside keeperd; see
  `## Architecture`). All dispatch decision, launch, confirmation, dedup,
  and (config-gated) reap live in the daemon; the CLI carries no dispatch
  logic of its own. It subscribes through `src/readiness-client.ts`, the
  `dispatch_failures` collection, the `autopilot_state` singleton, and the
  `armed_epics` presence table; it renders a multi-section frame
  (`--- current ---` from `jobs` correlated by `plan_verb`+`plan_ref`,
  `--- failed ---` from the `dispatch_failures` projection, `--- armed ---`
  from `armed_epics`) plus a banner showing the paused/playing pill, the
  `yolo`/`armed` mode, the armed count, and the concurrency cap, and exposes
  these control RPCs:

  - `keeper autopilot play` / `keeper autopilot pause` — flip the autopilot
    pause flag on the daemon via `set_autopilot_paused`. The RPC appends an
    `AutopilotPaused{paused}` synthetic event onto main's writable
    connection FIRST (the reducer folds it into the singleton
    `autopilot_state` projection — the banner-truth substrate added in
    schema v47 / fn-667), THEN flips the in-memory worker gate + relays to
    the autopilot worker. Boots paused: the daemon's boot drain
    unconditionally appends `AutopilotPaused{paused:true}` BEFORE
    `serverWorker` spawns, so a restart returns to safe-by-default paused
    via the boot-append re-arm (not via a "never persisted" volatility
    guarantee — the flag IS persisted as of v47; the safe-by-default is
    maintained by the boot re-arm event the reducer folds before any
    viewer can subscribe).
  - `keeper autopilot retry <verb::id>` — clear a sticky `dispatch_failures`
    row via `retry_dispatch`. The RPC bridges through main, which appends a
    `DispatchCleared` synthetic event; the reducer DELETEs the row on the
    next drain and the reconciler is free to re-attempt. There is no
    auto-retry — a failed dispatch is sticky and visible in the `--- failed
    ---` section until a human runs `retry`.
  - `keeper autopilot mode <yolo|armed>` — set the autopilot mode via
    `set_autopilot_mode` (fn-751, schema v62). **yolo** (the default) works
    every ready epic; **armed** works ONLY explicitly-armed epics plus their
    transitive upstream dep-closure. The RPC APPENDS an `AutopilotMode`
    synthetic event onto main's writable connection (folded into the
    `autopilot_state` singleton's `mode` column) and pumps a wake — NO relay:
    the level-triggered reconciler re-reads mode from the projection each
    cycle. Mode is durable user intent (persisted), so it survives restart and
    there is no boot re-arm.
  - `keeper autopilot arm <epic-id>` / `keeper autopilot disarm <epic-id>` —
    add/remove an epic from the armed set via `set_epic_armed` (fn-751). The
    RPC appends an `EpicArmed{epic_id, armed}` event (folded into the
    `armed_epics` presence table: `armed:true` → row present, `armed:false`
    → row deleted), same APPEND-ONLY/no-relay contract as `mode`. The
    `epic_id` is appended without an existence check to dodge the fold-lag
    race where a freshly-planned epic isn't yet in the `epics` projection,
    with ONE carve-out (fn-774): arming (`armed:true`) an epic already folded
    to `status='done'` is REJECTED main-side — a completed epic can't be
    (re)armed, and a `done` epic is definitionally folded so the fold-lag
    tolerance is intact (`disarm` and a not-yet-folded arm both still append).
    In armed mode the banner shows `· N armed` (or `· nothing
    armed` distinctly when the set is empty), and the `--- armed ---` section
    lists the explicitly-armed epic ids.

  Alt-screen TUI when stdout is a TTY; keymap `←/h/k` / `→/l/j` / `g` /
  `G/Esc` / `space` pause / `c` copy / `q` quit. Non-TTY stdout → snapshot
  mode (fn-772): autopilot is the widest view (4 streams — readiness,
  `dispatch_failures`, `autopilot_state`, `armed_epics`), so the latch
  holds until ALL FOUR fold before printing one composite frame +
  `keeper-meta:` and exiting; `--watch` forces the live passthrough. SIGINT
  tears down the renderer (alt-screen exit, raw mode off) then disposes the
  subscribe helper — as do SIGHUP, parent-death (a ~2s `ppid === 1` poll),
  and controlling-TTY loss (stdin EOF), so an orphaned viewer self-exits
  within ~2s (fn-723). The four control verbs (`play`/`pause`/`mode`/`arm`/
  `disarm`/`retry`) are unaffected — the snapshot gate is viewer-only.

  ```sh
  keeper autopilot                       # viewer: current / failed / armed + mode banner
  keeper autopilot | tail -1             # non-TTY → one snapshot + parseable keeper-meta JSON
  keeper autopilot play                  # un-pause the reconciler
  keeper autopilot pause                 # pause the reconciler (default at boot)
  keeper autopilot mode armed            # work only armed epics + their upstream closure
  keeper autopilot mode yolo             # back to work-everything (default)
  keeper autopilot arm fn-1-foo          # add fn-1-foo to the armed set
  keeper autopilot disarm fn-1-foo       # remove fn-1-foo from the armed set
  keeper autopilot retry work::fn-1-x.3  # clear a sticky DispatchFailed
  ```

- `git.ts` — single-collection subscribe client over the `git`
  collection (watched-worktree status — membership gate
  `.planctl present || dirty || ahead of upstream > 0`, recomputed each
  reconcile (epic fn-690): branch, ahead/behind,
  and a file-centric layout — one line per dirty file followed by its
  per-session `attributions[]`, each rendered with a colored source
  badge (`tool` = direct Edit/Write/MultiEdit, `bash` = derived from a
  Bash mutation event, `inferred` = time-bracketed against the
  session's Bash intervals, `planctl` = lifted from a planctl-CLI
  invocation envelope's `files[]` — so `.planctl/{epics,tasks}/*.json`
  and `.planctl/specs/*.md` attribute to the session that ran
  `planctl scaffold/done/...`); a single file can carry multiple
  attribution rows when several live sessions edited it without an
  intervening commit, and the strict `orphan_files` bucket is rendered
  as a separate trailing block for dirty files with zero attribution). Uses `subscribeCollection` from `src/readiness-client.ts`
  (the same lifecycle primitive that powers the readiness clients,
  scoped to one collection). Each frame is led by `---`; one block per
  non-empty worktree row, all-zero rows dropped. Same three per-pid
  `/tmp` sidecar files (JSON state, frame text, unified diff vs.
  previous) + alt-screen TUI when stdout/stdin are both TTYs (ring-
  buffered frame history, keymap `←/h/k`/`→/l/j`/`g`/`G`/`Esc`/`q`;
  under non-TTY the TUI gate resolves to snapshot mode — fn-772's early
  proof point: single-stream `git`, so the latch is the first frame; one
  frame + `keeper-meta:` then exit 0, `--watch` forces live passthrough).
  `--project-dir <path>` filters to one worktree root. SIGINT tears
  down the renderer (alt-screen exit, raw mode off) then disposes the
  subscribe helper and exits 0 — as do SIGHUP, parent-death (a ~2s
  `ppid === 1` poll), and controlling-TTY loss (stdin EOF), so an
  orphaned viewer self-exits within ~2s (fn-723).

  ```sh
  keeper git                          # all worktrees (TTY); non-TTY → one snapshot + exit 0
  keeper git --project-dir /path/to   # one worktree only
  keeper git --snapshot | tail -1     # forced one-shot from a TTY; last line is keeper-meta JSON
  keeper git --watch | head           # forced live stream even when piped (never exits)
  ```

- `usage.ts` — single-collection subscribe client (schema v35 / fn-642
  colocated the rate-limit annotation onto the `usage` row, dropping the
  prior dual-collection `usage` + `profiles` split). One
  `subscribeCollection` call over the `usage` collection (one row per
  agentuse profile observed at `~/.local/state/agentuse/<id>.json`:
  target, multiplier, session+week percent + reset timestamps, plus the
  schema-v35 colocated `last_rate_limit_at` +
  `last_rate_limit_session_id` and the schema-v41 `rate_limit_lifts_at` +
  `last_usage_fold_at`). Each row's stack carries a `limited lifts in
  <rel>` line whenever a non-codex row has a known FUTURE lift
  (`rate_limit_lifts_at`, schema v41 / fn-651) — `limited lifts now`
  within the ±30s rounding gap; a past/NULL lift omits the line. As of
  fn-754 the gate is the future lift itself, NOT the fired-time
  `last_rate_limit_at`, so a depleted-but-quiet row (weekly 100%,
  agentuse paused polling until its lift) still surfaces its countdown
  instead of going blank. A v41 `stale Nm` line surfaces under any row
  whose stale anchor — `max(last_usage_fold_at, rate_limit_lifts_at)`
  (fn-754) — is older than the renderer's `STALENESS_THRESHOLD_MS`
  cutoff (currently ~15m); anchoring to the lift keeps a deliberately-
  idle producer (paused with a known resume time) from being misread as
  dead. Driven only off that anchor, never `updated_at` (a rate-limit
  fold bumps that) and never agentuse's own `status` (which tracks its
  scrape failures rather than keeper's ingestion health) — so a wedged
  usage worker becomes visible instead of silently frozen. Untracked
  profiles (rate-limited but with no agentuse usage row) do not render.
  Per-frame sidecars
  (`/tmp/keeper-usage.<pid>.{state,frame,diff}.<n>.*`, indexed via a meta
  sidecar) carry the row set so the JSON sidecar captures the full input
  to the rendered frame. SIGINT disposes the subscription handle and
  prints sidecar paths on exit — and so do SIGHUP, parent-death (a ~2s
  `ppid === 1` poll), and controlling-TTY loss (stdin EOF), so an
  orphaned usage viewer self-exits within ~2s (fn-723); usage wires the
  shared `armViewerExitTriggers` despite keeping its own raw SIGINT
  teardown. Non-TTY stdout → snapshot mode (fn-772): single-stream, so the
  latch is the first frame; usage is the open-coded outlier (own
  frameCount / emitFrame / sidecar / exit path) but reuses the SHARED
  `keeper-meta:` trailer helper so the record shape never drifts from the
  other four. `--watch` forces the live passthrough.

  ```sh
  keeper usage                # all profiles (TTY); non-TTY → one snapshot + exit
  keeper usage --sock /tmp/x  # socket override
  keeper usage | tail -1      # last line is the parseable keeper-meta JSON record
  ```

- `dash.ts` — v1 of the unified keeper TUI (fn-780): a minimal, read-only
  OPENING SCREEN unifying the at-a-glance value of `keeper board` + `keeper
  jobs` + `keeper autopilot` into one frame — a header strip (autopilot
  play/pause + mode + armed-count, dead-letter count, connection marker), a
  **PLAN** region (one row per open epic in server `sort_path` order: armed
  marker, `epic_number title` label, the per-epic readiness verdict, and an
  `N/M` completed-task count that counts ONLY `completed` perTask verdicts and
  is hidden at zero tasks), and an **AGENTS** region (EVERY non-terminal session
  — working AND stopped — on one unified "most-recent-activity-started"
  timeline; sorted `COALESCE(active_since, created_at)` DESC with a `job_id`
  tiebreak, so a session rises the moment it starts a run and re-promotes to the
  top on a genuine restart; needs-you no longer affects ordering. Each row's
  leading glyph is the per-job rolled-up board icon
  (working→sync, sub-agent→cogs/warn, monitor→eye/warn, idle→circleO), computed
  uniformly for plan-linked and ad-hoc jobs via the shared readiness rollup;
  label `title → plan_ref → job_id`, trailing elapsed band replaced by
  `awaiting` / `failed` when the session is blocked on a human).
  **Data sources:** the readiness collections
  ride one `subscribeReadiness` connection; `autopilot_state` and `armed_epics`
  ride their own `subscribeCollection` subs (the readiness conn subscribes them
  internally but does NOT expose them on the snapshot, so the header needs the
  two extra subs). **Frame shape:** a fresh `@opentui/core` app under `src/dash/`
  — a pure view-model builder (`src/dash/view-model.ts`, OpenTUI-free, fast-tier
  tested) plus a thin materializer (`src/dash/app.ts`) that diffs role-tagged
  segment rows into a stable `Map<rowKey, TextRenderable>` (structural add/remove
  only on a row-set change; `setContent` otherwise) and colors each segment via
  `RGBA.fromIndex` so the hue tracks the terminal theme. Reactive render mode (no
  `renderer.start()`); one coarse 30s interval refreshes the elapsed cells.
  **TTY-only:** the gate fires in `cli/dash.ts` BEFORE any OpenTUI import — a
  non-TTY stdout exits 1 with `keeper dash: requires a TTY` (no snapshot mode,
  no `keeper-meta:` line). Reconnect-forever with the connection state shown
  in-TUI (a pre-paint `connecting…` / `reconnecting…` line, then a header marker
  with the body frozen at last-good once a snapshot has painted). Read-only end
  to end — no RPC frame is written, no DB opened. q / Ctrl-C quit; j/k/arrows
  scroll the focused ScrollBox; every exit path (q, Ctrl-C, SIGHUP, stdin-EOF,
  the ~2s `ppid === 1` poll, onFatal, uncaughtException/unhandledRejection)
  routes through one idempotent teardown that `renderer.destroy()`s BEFORE
  exiting, so the terminal is never stranded in alt-screen/raw mode.

  ```sh
  keeper dash                 # live screen on a TTY (header + PLAN + AGENTS)
  keeper dash --sock /tmp/x   # socket override
  echo | keeper dash          # non-TTY → 'keeper dash: requires a TTY', exit 1
  ```

- `await.ts` — the blocking wait-for-condition client (fn-647; conditions
  + AND grammar widened in fn-713, `monitor-running` added in fn-718,
  `server-up` + `reason=unreachable` added in fn-750.2, give-up made
  opt-in via `--connect-timeout` in fn-757). Non-TUI: emits a
  Monitor-shaped event
  stream on stdout — exactly one `[keeper-await] armed …` line after the
  on-board check, then exactly one terminal `[keeper-await] met …` or
  `[keeper-await] failed …` line — and exits when its condition holds.
  Six conditions: `complete <id>` (epic/task pops off the board) and
  `unblocked <id>` (workable now) are planctl-id forms auto-detecting
  epic vs task by the `.N` suffix; `git-clean` blocks until the cwd's git
  root has `dirty_count=0 AND orphaned_count=0` (no `git_status` row for
  the root counts as clean); `agents-idle` blocks until no OTHER session
  (`job_id != CLAUDE_CODE_SESSION_ID`) with `state=working` has a cwd
  inside the cwd's git root; `server-up` blocks until keeperd is reachable
  and serving, firing `met` on the first snapshot — it reconnects FOREVER
  (permanently give-up-exempt) so it survives a daemon bounce, takes
  no id, has no planctl pre-check, CANNOT be ANDed with another
  condition (rejected at parse time), and CANNOT be combined with
  `--connect-timeout`; `monitor-running <selector>` blocks
  until the matching background monitor in the CALLER'S OWN session
  (`job_id == CLAUDE_CODE_SESSION_ID`) is no longer running — the selector
  is `cmd:<full command>`, `kind:<monitor|bash-bg|ambient>`, or a bare
  token (= `cmd:<token>`), exact-matched against the v51 `jobs.monitors`
  projection (a no-match at arm time refuses with `reason=no-match` exit 1
  rather than firing an instant `met`). `git-clean` / `agents-idle` take no
  id and are project-scoped to the cwd's repo; `monitor-running` takes one
  selector and needs no git root. Multiple conditions joined by the
  literal `and` token block until ALL hold simultaneously (level-
  triggered, glitch-free); only the subscriptions a condition needs are
  opened. "unblocked" deliberately excludes autopilot's
  `single-task-per-epic` / `single-task-per-root` concurrency mutexes
  (every other blocker still blocks). By default every condition reconnects
  FOREVER — a plain `keeper await <cond>` survives an arbitrarily long
  keeperd bounce and never emits `reason=unreachable` (fn-757; the shared
  driver's give-up policy is opt-in, and `server-up` always relied on the
  default-off behavior). The opt-in `--connect-timeout <dur>` flag re-arms
  the bounded continuous-unpainted give-up (fn-750.1; the `GiveUpPolicy`
  machinery stays) for non-interactive / CI callers: a daemon down /
  mid-bounce / half-up past the deadline fires `failed reason=unreachable …
  advice=<…>` exit 1 instead of blocking — distinct from `reason=connect`
  (a query-shape rejection keeperd returned). It is orthogonal to
  `--timeout` (the condition deadline); set it `<= --timeout` and the first
  to fire wins. `--connect-timeout` is rejected with `server-up` at parse
  time. Exit codes: 0 met, 1
  not-found/`no-match`/usage/connection/`no-git-root`/`unreachable`
  (`unreachable` only with `--connect-timeout`), 3
  timeout (SIGTERM), 4 deleted, 5 stuck (only under `--fail-on-stuck`).

  ```sh
  keeper await complete fn-646-keeper-cli-opentui-port.1   # task done
  keeper await git-clean                                   # repo clean
  keeper await server-up                                   # daemon serving
  keeper await monitor-running cmd:bun run dev             # my dev server done
  keeper await git-clean and agents-idle                   # both, ANDed
  keeper await complete fn-1-foo --connect-timeout 30s     # opt-in give-up
  ```

The next four subcommands are keeper's git-coordination verbs (epic
fn-715). Unlike
every reader above, `commit-work` is the FIRST keeper subcommand that WRITES
to git — it never touches the event log; it reads `file_attributions`
through a fresh read-only `openDb({readonly:true})` connection and stages /
commits only that session's attributed files. The other three are read-only.

- `commit-work.ts` — stage the calling session's attributed dirty files,
  run the polyglot lint matrix, commit with a `Job-Id:` trailer, and push.
  Discovers session-attributed files via the `file_attributions` reader,
  gitignore-filters them (`git check-ignore`), stages pathspec-scoped
  (`git add -A -- <files>`, never tree-wide — deletions stage as removals),
  serializes concurrent invocations on
  `$GIT_COMMON_DIR/keeper-commit-work.lock` via an `FD_CLOEXEC` `flock(2)`,
  then runs the lint matrix (ruff/ty/cli-boundaries/shellcheck/zig/lua/
  hadolint/npm-lint + a `tsc --noEmit` arm) where exit-code is the sole
  pass/fail signal. Emits a compact two-line NDJSON envelope (commit line +
  push line); `--preview-files` lists the staged set with no lock and no
  commit.

  ```sh
  keeper commit-work --preview-files          # list attributed dirty files
  keeper commit-work "test(scope): msg"       # stage → lint → commit → push
  ```

  **Escape hatch — if `commit-work` won't stage the full file set, drop to
  git directly.** `commit-work` scopes to session-touched files; if it leaves
  out a file you need in the commit (or stages the wrong set), don't fight it
  — commit with plain `git` instead. Stage only the files you're committing,
  by explicit path (`git add <path> …` — never `git add -A` / `git add .`),
  then `git commit` and `git push`. This is a temporary escape hatch we'll
  repair; for now you're empowered to use git directly whenever `commit-work`
  can't cover what you need.

- `session-state.ts` — emit the current session's git context (branch, head
  sha, porcelain status, recent log) plus its on-hook dirty file list as a
  pretty JSON envelope. Purely informational — no lock, no commit; a DB
  hiccup degrades `session_files` to `[]` rather than throwing.

  ```sh
  keeper session-state                        # {branch, head_sha, session_files, ...}
  ```

- `show-session-files.ts` — emit a session's on-hook dirty files grouped by
  repo (`{files_by_repo, cwd_repo}`) as a pretty JSON envelope. A thin
  exclusion-agnostic pass-through over the attribution reader;
  `--session-id` is required.

  ```sh
  keeper show-session-files --session-id <id> # {files_by_repo, cwd_repo}
  ```

`setup-tmux` is a one-shot provisioner (epic fn-803), not a subscribe client.
It drives tmux directly via `Bun.spawnSync` — deliberately OUTSIDE the
ExecBackend seam — and writes nothing to git or the event log.

- `setup-tmux.ts` — stand up the human's tmux control plane. Rebuilds the
  `dash` dashboard session every run (board main pane + autopilot/jobs/git/
  builds/usage splits, `main-vertical`, each pane a `zsh -ic '…; exec $SHELL'`
  triple sized to the real client/terminal) and ensures the `autopilot`,
  `background`, and `foreground` work sessions exist (one shell window each,
  stamped `KEEPER_TMUX_SESSION=<name>` so hook attribution matches daemon-minted
  sessions). Existing work sessions are never touched; it NEVER attaches or
  `switch-client`s, so it is safe inside or outside tmux. `--kill-sessions`
  tears all four sessions down first, prompting y/N only when the work sessions
  hold busy (non-shell foreground) panes — non-TTY stdin with busy panes aborts
  (exit 1) having killed nothing. When the `foreground` session is ABSENT (the
  first run after a crash), it offers to relaunch the last tmux-server
  generation's crashed `foreground` agents — a y/N TTY-only prompt (never
  auto-restores; computed BEFORE any session-creating call so the fresh server
  doesn't shift the generation window), spawning
  `restore-agents --apply --session foreground --last-generation`. A present
  `foreground` session, zero candidates, or a non-TTY skips the offer. Reading
  `keeper.db` read-only for the candidate count is the only DB dependency; the
  relaunch is a spawned subprocess, so `setup-tmux` still imports no ExecBackend.

  ```sh
  keeper setup-tmux                 # rebuild dash, ensure work sessions
  keeper setup-tmux --kill-sessions # tear down all four first (confirm if busy)
  ```

## Uninstall

Reverse of install:

```sh
launchctl bootout gui/$(id -u)/arthack.keeperd
rm ~/Library/LaunchAgents/arthack.keeperd.plist
# If installed: the rotation sidecar.
launchctl bootout gui/$(id -u)/arthack.keeperd.logrotate
rm ~/Library/LaunchAgents/arthack.keeperd.logrotate.plist
# The sitter scanners now live in ~/code/sitter; uninstall them per that repo's README.
# Stop loading the plugin: remove `--plugin-dir ~/code/keeper` from
# whatever entrypoint launches `claude` (e.g. the arthack launcher).
# Optional — drops all captured state, including the events log:
rm -rf ~/.local/state/keeper
```

## Architecture

The `events` table is a durable append-only log (with ten sparse
top-level signals partial-indexed for cheap cross-session lookup —
`slash_command`, `skill_name`, `tool_use_id`, the five-column
`planctl_*` envelope, and the schema-v31 pair `bash_mutation_kind` +
`bash_mutation_targets` stamped on `PostToolUse:Bash` rows whose
command parses as a filesystem-mutating shape; see [What keeper is](#what-keeper-is)); the reducer
folds it into the `jobs` projection while advancing the `reducer_state`
cursor in the same transaction (exactly-once-per-event). A Worker thread on its own read-only
connection polls `PRAGMA data_version` at ~25ms and posts contentless wake
messages; each wake triggers a drain to completion. On macOS, FSEvents/kqueue
drop same-process writes and miss WAL writes entirely, so `data_version`
polling — not a file watcher — is the correct change-detection primitive.

The hook no longer INSERTs into `events` directly (fn-736 — that opened SQLite
on every fire, importing the 6.5k-line `src/db.ts` and serializing under WAL:
60→343ms at 1→16 concurrent writers). Instead the hook **appends a per-pid
NDJSON line** under the events-log dir (`KEEPER_EVENTS_LOG`, default
`~/.local/state/keeper/events-log`) and exits; an **events-log ingester** Worker
(mirroring the dead-letter-worker) watches that dir and posts a contentless
go-look hint, and MAIN reads each per-pid file from its durable byte-offset and
`INSERT`s the rows (+ offset advance) in one `BEGIN IMMEDIATE`. Two distinct
cursors live side by side: the NEW ingest byte-offset (NDJSON→`events`, per-pid
file, in the `event_ingest_offsets` table) and the UNCHANGED
`reducer_state.last_event_id` (`events`→projections). The NDJSON append itself
does NOT bump `data_version`, but the ingester's own `events` INSERT (on MAIN's
writer connection) DOES — so the downstream `data_version` pollers wake for free;
the only new file-watch trigger is the ingester worker's hint. The `events`
table stays the canonical fold source, so re-fold determinism is preserved by
construction. Skew is lag-not-loss: a new-hook/old-daemon window backs up NDJSON
(drained at the next daemon boot ingest); an old-hook/new-daemon window INSERTs
directly while the ingester finds an empty dir.

A **second** Worker thread runs the read-only UDS subscribe server. It mirrors
the wake worker's archetype — its own read-only connection, its own
`data_version` poll — but instead of waking the reducer it owns an external
endpoint: a Unix-domain socket (guarded by a PID-liveness lock file) speaking
NDJSON. Its **primary fast path** is not the poll, though: after main drains a
fold to completion it posts a `{type:"kick"}` message to this worker (in-process
postMessage, strictly post-COMMIT), so the server runs its diff immediately
instead of waiting up to a full poll interval — collapsing the second of the two
serial `data_version` polls that the hook→fold→patch pipeline used to cross. The
`data_version` poll is retained as the level-triggered backstop for any
lost-wakeup; the kick handler is idempotent (the diff is version-gated, so a
kick+poll double-fire emits nothing the second time). The surface is namespaced by collection: each query names a collection,
and everything collection-specific (which table to read, which columns to serve,
which column the diff fires on) is described by a registry entry rather than
hardcoded — `jobs` is the first such collection; `epics` and
`subagent_invocations` register alongside it. On each `data_version` tick the
server runs a two-pass diff: first a cheap `(pk, version)` probe over the union
of watched ids — no row body, no JSON decode — to find which rows advanced past
each connection's `lastSent`, then (only when something changed) a second SELECT
that fetches and JSON-decodes just the changed rows and pushes `patch` frames to
subscribed clients. The same tick also runs a second pass: it
groups subscriptions by filter signature, runs one `COUNT(*)` + membership-token
query per distinct filter (the token is a `group_concat` over the matching pk
identities, ordered by pk so it's stable and fingerprints membership, not cell
values), and emits a `meta` frame to any subscription whose `total` or token
moved — the count/staleness signal, sharing one query across same-filter clients
exactly as the patch pass shares one re-read per collection. That meta EMISSION
is throttled per subscription to at most one nudge per `META_MIN_INTERVAL_MS`
(fn-697 lever 1): a total/token move within the interval is deferred — but
`lastTotal`/`lastToken`/`lastMetaEmittedAt` advance ONLY on an actual emit, so
the membership delta persists and the next eligible tick (a kick or the poll
loop's convergence tick) emits the latest state. The throttle lives on
`SubState` (not `diffTick`-local) so the `handleKick` and `pollLoop` wake paths
share one window; it gates ONLY the meta pass — the patch pass above stays
immediate. This coalesces a fold burst's ~21-subscriber refetch storm into
fewer rounds without ever delaying a cell patch or losing the final membership
state. The query-ANSWER seam coalesces the same way (fn-698): a
per-server-instance, single-`worldRev` result memo means N connections issuing
an identical `query` (same collection + resolved filter + sort + limit +
offset) at the same `worldRev` run ONE `runQuery` SELECT + ONE
`JSON.stringify(rows)` between them, then each connection gets a pre-serialized
`result` line assembled by concatenating its own envelope (`id`/`rev`/`total`)
around the shared `rows` blob — byte-identical to `encodeFrame`, no
wire-protocol change; the memo's `entries` map is replaced wholesale the
instant `worldRev` advances, and any memo-path throw degrades to the
un-memoized `runQuery` + `encodeFrame` path. The server also reaps dead
connections so its single-threaded diff loop never serializes against orphaned
viewers (fn-723): a write that returns `< 0` (EPIPE/ECONNRESET on a diff
write) evicts the connection from `conns`, and a connection whose pending
write buffer stays stuck past a TTL is reaped too — the case `diffTick` can't
EPIPE on because it skips backpressured conns. A `MAX_CONNECTIONS` cap (64)
hard-bounds the set: at the cap the open handler FIRST runs a synchronous
reapable-conn sweep (the same stuck-pending / idle zero-sub / subscribed
dead-peer classifications, freeing `conns` in place so the recheck sees a true
size) and accepts the new connection if that recovered a slot; only a cap STILL
held AFTER the sweep rejects with a `max_connections` error frame then closes it
(reject-new, not LRU-evict — a live board subscriber is never evicted, the idle
sweep exempts subscribed conns and dead-peer only evicts dead-pid ones). Every
cap-hit logs a one-line conn-state census (pending / zero-sub / subscribed-live /
subscribed-dead); the loud "reaper regressed" alarm now fires only on the
cap-held-after-sweep reject — the genuine anomaly. There is NO ping/pong heartbeat — it was descoped
(a faithfully-ponging orphan is indistinguishable from a quiet live viewer);
the load-bearing fix for the orphan class is the client-side self-exit below.

A **third** Worker thread is the transcript-title producer: it watches the
external transcript tree (the `claude_projects_root` from
`~/.config/keeper/config.yaml`, default `~/.claude/projects`) with
`@parcel/watcher`, forward-tails each changed JSONL from a stored byte-offset,
and minted three classes of synthetic event from matched lines: a
`custom-title` line becomes a `TranscriptTitle` (folded as the priority-3
`transcript` title), a Claude-API HTTP error line becomes an `ApiError`
(folded to stamp `(last_api_error_at, last_api_error_kind)` and flip
`state → 'stopped'`), and an assistant turn whose `content[]` carries a
`{type:"tool_use", name:"AskUserQuestion"}` becomes an `InputRequest`
(folded to stamp `(last_input_request_at, last_input_request_kind)` and
flip `state → 'stopped'` — this is the only signal for built-in
interactive tools that fire no hook of their own). Main — the sole
writer — turns each producer message into the matching events row on
its writable connection and pumps a wake; the reducer's terminal-guarded
arms do the projection work. The 60s heartbeat / FSEvents-drop backstop
re-scans every `jobs.transcript_path` row, but a per-path `{size, mtimeMs}`
stat memo (separate from the live-tail offset state, written only after a
successful stat+scan, cleared on ENOENT) skips any file unchanged since its
last scan — so the backstop no longer re-reads hundreds of MB/min of static
transcripts, while the fn-720 rescued accounting is byte-identical.

A **fourth** Worker thread is the plan producer: it watches each configured
project root (from `~/.config/keeper/config.yaml`, default `~/code`) for
`.planctl/{epics,tasks}/*.json` files with `@parcel/watcher`, safe-parses each
changed file, and posts a `plan-epic`/`plan-task` snapshot message to main (and a
`plan-epic-deleted`/`plan-task-deleted` tombstone when a file vanishes). Main
— again the sole writer — turns each into a synthetic
`EpicSnapshot`/`TaskSnapshot` (or `EpicDeleted`/`TaskDeleted`)
events row and pumps a wake; the reducer folds an `EpicSnapshot` as an idempotent
upsert into the single `epics` projection and a `TaskSnapshot` into its parent
epic's embedded `tasks` JSON array (a task change `patch`es the parent epic;
tombstones retract).
As of fn-629, the producer carries the **observation gate** that closes
the autopilot-dispatch-against-uncommitted-epic window (the fn-627
duplicate-incident shape). `PlanScanner` takes an `isTracked(path) =>
boolean` predicate fed by the live worker as `isPathInHead` — a
`git cat-file -e HEAD:<relpath>` shell-out scoped to the resolved
planctl repo root, bounded by a 1s timeout and fail-closed (any git
failure reads as not-in-HEAD). When the predicate returns false, the
path lands in a per-scanner `pending` set and NO `EpicSnapshot` /
`TaskSnapshot` is emitted — so the reducer never folds an uncommitted
epic and the autopilot dispatch gate (see CLAUDE.md § Autopilot
dispatch gates) cannot observe it. As of fn-759 the cheap in-memory
**change-gate runs BEFORE this probe**: `onChange` first compares the
new serialization against the per-id `lastEmitted` it already holds, and
on a match suppresses with NO `isTracked` fork — so the ~99% of scans
that re-read unchanged files (the 5s heartbeat, boot, the drop-rescan)
no longer spawn a `git cat-file -e` per file (the fork storm that starved
the realtime pipeline to ~227s staleness). The probe fires ONLY on
changed / first-seen snapshots; gated paths still never earn a
`lastEmitted` entry, so an uncommitted file is re-probed every scan
(the fn-627/fn-629 post-commit-drain pin) rather than wrongly shortcut.
The one accepted semantic shift: in-HEAD-ness is re-verified only when
content changes — an unchanged file's HEAD-membership regression (a
branch switch) has no observable effect, since the change-gate suppresses
re-emits regardless. Critically, the gate lives at the
**producer**, not the reducer: re-fold determinism is non-negotiable
(the reducer must never read git / fs / wallclock), so the predicate
fires once at fold-time on the producer side, never inside the
`BEGIN IMMEDIATE` transaction. A `git commit` does not change the file's
worktree bytes so FSEvents will not re-fire on commit; the `pending` set is
drained by the same gated `recheckPending()` from FOUR triggers. As of fn-705
the plan producer is realtime end to end, mirroring the eighth-worker
(autopilot) model: it polls `PRAGMA data_version` on its own read-only
connection (`PLAN_DB_POLL_MS`, 100ms — the cadence the sibling producers
share) so every keeper DB write, the close fold included, drives a
single-flight gated rescan that drains `pending` + re-ingests changed
`.planctl` files in ~50ms — the realtime complement to the best-effort
FSEvents subscription, closing the up-to-60s fold lag the heartbeat used to
impose. It ALSO watches each planctl repo's `.git/logs/HEAD` reflog with
`@parcel/watcher` (a commit always appends there) to close the
no-DB-write commit tail, where the in-HEAD transition fires no DB
write and no `recheck-pending` post — the broad recursive watch IGNORES
`.git` (`IGNORE_GLOBS`), so the per-repo reflog watch is the only FSEvents
commit signal. As of fn-737 the worker reconciles those external reflog
watches against the UNION of its live `pending` repo set AND every repo that
holds a `.planctl` tree under the configured roots (`discoverPlanctlDirs`),
not just the pending ones — fn-705 armed a watch only while a repo held a
pending path, so a commit in a planctl repo with NO pending path (a
steady-state `.planctl` change whose file-write FSEvent was a no-op or
coalesced) had no realtime signal and fell to the git-worker's 60s heartbeat
(task fn-737 measured that as the dominant fold-latency tail). The widening is
bounded — the watch count is the number of planctl-tracked repos under the
roots, and since the broad watch ignores `.git` these per-repo `.git/logs`
watches don't overlap it (no fseventsd bad-state). On the reflog append the
worker runs the repo-SCOPED gated `recheckPending(root)` PLUS a change-gated
`scanPlanctlDir` re-scan of that repo's `.planctl` dir (the latter recovers a
committed change that was never gated into `pending`); neither writes the DB.
The two remaining drain
triggers are main's `recheck-pending` post on every `GitSnapshot` / `Commit`
it writes, and the heartbeat — DEMOTED from a 60s latency floor to a 5s
should-never-fire paranoia backstop (`RECONCILE_HEARTBEAT_MS`); when the
heartbeat actually re-converges a change a fast path dropped it is a
genuine RESCUE, never normal operation. Epic fn-720 generalized that
single plan-worker ALARM into a UNIFORM backstop-telemetry channel across
every change-propagation backstop (plan/git/transcript heartbeats, the
FSEvents-drop rescan, the autopilot `confirmRunning` ceiling, and the
pending-dispatch TTL sweep): each fire emits a structured
`{kind:"backstop-rescue", class:"missed-wake"|"timeout", backstop, worker,
fast_path, rescued, staleness_ms, last_fast_path_at}` record (plus periodic
`backstop-rollup` denominator records) to the `KEEPER_BACKSTOP_LOG`
sidecar via main-the-sole-writer, so a missed-wake rescue is COUNTABLE
(rescue rate = rescues ÷ total fires) rather than only stderr-visible. The
loud human stderr ALARM stays for genuine rescues but is rate-limited
per-key so `server.stderr` can't flood — the NDJSON record + counters are
NEVER rate-limited, so the metric stays complete. It is observability-only:
zero behavior change, no synthetic events, no schema/keeper-py bump, no
reducer change. The poll is a TRIGGER only — it never writes the DB
nor drives a synthetic event from anything but a parsed `.planctl` file, so
re-fold determinism is intact. Every drain trigger re-runs the in-HEAD probe
and a still-uncommitted path stays in `pending` (no fn-627 regression — the
fn-629 gate is preserved exactly, only the realtime drain triggers are new).
A freshly-committed path emits its snapshot and leaves the set, with no
permanent strand. The gate trusts planctl's commit-at-the-seam contract: every
mutating verb's `output.emit()` owns the write→commit transaction inline, so
the file is in HEAD by the time the envelope `success: true` lands on stdout. As of schema v14, the `epics` projection adds
`last_validated_at` (TEXT, nullable) — the validation timestamp planctl writes
via `planctl validate --epic <id>` and the board client renders as a
`[validated]` pill at the non-null (validated) value, omitting it otherwise
per fn-708's omit-default rule (absence ≡ `unvalidated`). As of schema v22, `jobs.config_dir` captures `CLAUDE_CONFIG_DIR` from the
SessionStart environment, projecting the arthack-claude profile a session
ran under (latest-non-NULL-wins via `COALESCE(excluded.config_dir,
jobs.config_dir)` on the SessionStart ON CONFLICT branch, so a resume
SessionStart that captures NULL preserves the prior attribution).
As of schema v29, the `epics` projection gains `created_by_closer_of` (TEXT,
nullable — the closer→child link's `plan_ref`, i.e. the closed-epic id whose
`/plan:plan` closer session minted this child epic via `epic-create`) and
`sort_path` (TEXT NOT NULL DEFAULT '' — a zero-padded-6 dotted materialized-
path key like `"000003.000007"`). As of schema v30 (fn-595), `epics` adds
`queue_jump` (INTEGER NOT NULL DEFAULT 0) projected from the
`planctl_queue_jump` envelope column on `/plan:queue` scaffold events;
when set on a root epic, `cascadeSortPath` stamps a `!`-prefixed
`sort_path` so queue-jumped epics sort above all other root epics in the
default `sort_path ASC` page. Both are reducer-derived inside
`syncPlanctlLinks` from the existing `job_links` + `jobs.plan_verb` /
`plan_ref` substrate; an `EpicSnapshot` carve-out preserves them across a
file-content re-observation (alongside `tasks` / `jobs` / `job_links`). The
`EPICS_DESCRIPTOR.defaultSort` flips from `epic_number asc` to
`sort_path asc`, so a closer-created child epic slots directly below its
parent in the default page; `sort_path` overflows to `''` at the documented
ceiling `epic_number >= 1_000_000` (safe-fold; the reducer never throws
inside `BEGIN IMMEDIATE`). As of schema v31, the `git` collection is
rebuilt around per-(session, file) attribution: `events` gains
`bash_mutation_kind` + `bash_mutation_targets` (hook-side derived columns
that name the mutation shape and the affected paths on every
`PostToolUse:Bash` row whose command parses as a filesystem mutation —
kinds cover `pkg-install` / `pkg-uninstall` / `fs-remove` / `fs-move` /
`fs-copy` / `fs-mkdir` / `git-tree-mutate` plus `git-rm` (delete
semantics) and `git-mv` (rename semantics, capturing BOTH source and
destination); the reducer's attribution pass layers three match modes
against these tokens — exact, directory-prefix for `git rm -r dir/`,
and a hand-rolled dependency-free fnmatch (`*`→`[^/]*`, `?`→`[^/]`,
anchored, no `**`/nested quantifiers, ReDoS-safe) with the `__TREE__`
sentinel rejected up-front so a no-pathspec event can never glob-match
a real file),
`jobs` gains `git_unattributed_to_live_count` (the renamed former
`git_orphan_count` — dirty files no live session is on the hook for) and
redefines `git_orphan_count` to the strict mystery sense (dirty files
with zero attribution after the inference pass), and a new
`file_attributions` table carries one row per `(project_dir, file_path,
session_id)` with `last_mutation_at` + `last_commit_at` so the discharge
rule is indexable. The producer worker `stat`s every dirty file at
snapshot build time and embeds `mtime_ms` in the `GitSnapshot` payload;
the reducer's attribution pass joins the event log against those
frozen-in-payload mtimes inside `BEGIN IMMEDIATE` (never `stat`s inside
the transaction). As of schema v44 / fn-664, the producer additionally
freezes per-file `{worktree_oid, index_oid, worktree_mode}` into every
`dirty_files[]` entry — the filter-correct
`git hash-object --stdin-paths` (one batched spawn per snapshot,
WITHOUT `--no-filters` so clean/CRLF filters match the stored blob)
plus porcelain v2 `hI` / `mW` lifted free off the parse — and the
reducer's `projectGitStatus` pass-1 / pass-2 UPSERT + post-pass refresh
stamp `worktree_oid` + `worktree_mode` onto every `file_attributions`
row for the file (per-file facts; every attribution row for the same
`(project_dir, file_path)` converges on the snapshot's freshest pair).
The git-worker also emits a new `Commit` synthetic event on every
HEAD-oid change (carrying `{project_dir, commit_oid, parent_oid, files,
committer_session_id, task_ids}` where `files` is
`Array<{path, blob_oid, committed_mode}>` — `blob_oid` and
`committed_mode` lifted off `git diff-tree -r --no-commit-id -z <oid>`).
`committer_session_id` is resolved from THREE possible trailer sources
(take-last canonical UUID): the historical `Session-Id:` trailer stamped
by the `plugin/bin/git` PATH wrapper when `CLAUDE_CODE_SESSION_ID` is
set (preferred), then `Job-Id:` (fn-670 / T1 — the `commit-work`
trailer; `job_id === session_id` is a keeper invariant, so the value is
the same UUID), and finally `null` (global discharge) when both are
absent or malformed. A hand-edited `Session-Id:` wins by take-last
policy if it disagrees with the coalesced fallback. `task_ids` is the
collect-all `Task:` trailer values (multi-valued by design — one
commit may close more than one task); empty `[]` on the common path
(no `Task:` trailer, or all values malformed). The reducer's `Commit`
fold updates `file_attributions.last_commit_at` (never deletes rows) so
a re-edit re-arms attribution by re-stamping `last_mutation_at`. As of schema v45 / fn-664.2, that discharge is
content-aware: `foldCommit` stamps `last_commit_at` ONLY when the four
axes are all non-null AND `blob_oid === worktree_oid &&
committed_mode === worktree_mode` (the commit truly captured the
current worktree bytes + mode). On any null axis it falls back to
today's unconditional timestamp discharge (re-fold determinism over
pre-v44/v45 events). The stage→re-edit→commit orphan is the bug the
gate fixes: the worktree diverges from the staged-then-committed bytes,
the gate suppresses discharge, and the editing session keeps its
attribution claim. Symmetric across per-session and global discharge
(the worktree axes are per-file facts). A chmod-only dirty file with
equal blob but differing mode is also caught — oid-equality alone would
have wrongly discharged it. The four discharge READ predicates
(passes 2 / 3 / 4) are byte-identical to pre-v45 — only the WRITE
site changed. As of schema v46 / fn-666, the planctl-CLI invocation
envelope's `files[]` array (every `.planctl/{epics,tasks}/*.json` and
`.planctl/specs/*.md` planctl wrote during the op) is lifted into a
new sparse `events.planctl_files TEXT` column by `extractPlanctlInvocation`
(Array.isArray + per-element string filter + runaway-size guard; NULL
on miss / non-array / empty / oversized), and the reducer's
`planctl_op != null` fold seam mints one `source='planctl'`
`file_attributions` row per path under `project_dir = state_repo` (the
absolute repo path, extracted in-fold from the stored envelope) +
`event.session_id` + the repo-relative path + `event.ts` + the verb
(`scaffold` / `done` / …) as `op`. The
`file_attributions.source` CHECK widens to include `'planctl'` via a
row-preserving table rebuild; pass-2's inferred-guard widens to
`source IN ('tool','bash','planctl')` so a planctl file does NOT also
get a spurious inferred attribution; pass-3 renders `'planctl'` as a
honest badge. Discharge flows through the SAME `foldCommit` path as
`'tool'`/`'bash'`/`'inferred'` — a `chore(planctl)` commit clears
the row via the same `last_commit_at` UPDATE; no per-source branch.
Fixes the 559-orphan spike (`.planctl/{epics,tasks}/*.json` and
`.planctl/specs/*.md` were strict-mystery orphans the instant they
flashed dirty, since planctl writes them outside any Claude
Write/Edit / bash mutation deriver match). This envelope `files[]` scrape
remains the SOLE driver of the planctl `file_attributions` rows — epic
fn-695 added a SECOND, independent use of the commit channel (the
creator/refiner edge below) but did NOT touch the attribution mint; the
two are orthogonal. As of schema v49 / fn-670
T2, the same `Commit` fold also stamps a deterministic task→committing-
session link: when BOTH `committer_session_id` is non-null AND
`task_ids[]` is non-empty, the per-session arm writes a new
`last_commit_for_task_at` field (producer-time `committed_at_ms / 1000`)
on the embedded job element whose `job_id == committer_session_id`
under each named task element inside the parent epic's
`tasks[].jobs[]`. The link rides FREE in the opaque JSON-TEXT `tasks`
cell on `epics` (no new real column — the v48→v49 bump is whitelist-
only on `keeper/api.py`'s `SUPPORTED_SCHEMA_VERSIONS`). `buildEmbeddedJob`
preserves the field across every `syncJobIntoEpic` re-sync via the
OLD-element carve-out — without that guard, a later jobs-row write
would clobber the link the consumer (`planctl pick_target_job`) relies
on to prefer the committing session over a stale empty re-claim.
Commit-before-claim (no embedded job element yet under the named task)
drops the link rather than shelling a job element foldCommit doesn't
otherwise own; a real worker's SessionStart always precedes its own
commit by definition, and a cursor=0 re-fold replays events in id
order so the ordering inverts anyway. Pre-fn-670 Commit events lack
`task_ids`; `extractCommit` defaults to `[]` so the link write is a
no-op over the historical log, and a re-fold reproduces byte-identical
`epics` rows. As of schema v54 / fn-695, the git-worker ALSO freezes the
`Planctl-Op` / `Planctl-Target` / `Session-Id` trailers (stamped by
planctl on every `chore(planctl)` commit) onto the `Commit` payload, and
`foldCommit` — when all three axes are non-null and the target parses —
TRIGGERS the per-session creator/refiner edge rebuild by calling
`syncPlanctlLinks(committer_session_id, …)`. As of schema v67 (fn-807)
`foldCommit` ALSO records each trailer-bearing `Commit` into the indexed
`commit_trailer_facts` projection in the same transaction (the wider
all-three-axes-non-null condition, NOT the narrower parse-the-target trigger
gate); `syncPlanctlLinks` reads that projection ONCE per call rather than
re-scanning every `Commit` blob per swept session. `foldCommit` never writes
the `epic_links` / `job_links` cells itself: `syncPlanctlLinks` stays the
SINGLE writer and re-derives the edge from the deduped UNION of the
legacy stdout scrape AND this durable commit-trailer fact. The motivating
failure (fn-635) piped planctl stdout through `grep`, NULLing
`events.planctl_op` so the scrape-only edge never formed; the commit
channel reconstructs it from the `Session-Id`-stamped commit, surviving
client + server reboots and any stdout mangling. Whitelist-only schema
bump (v53→v54 — the union rides free in the existing JSON cells;
`keeper/api.py`'s `SUPPORTED_SCHEMA_VERSIONS` adds 54 in the same change).
Pre-fn-695 `Commit` events lack the trailer fields, so the commit channel
is a no-op over the historical log and a from-scratch re-fold reproduces
byte-identical `epics` / `jobs` rows. The pass-4 fan-out persists ONLY `dirty > 0` sessions
into `git_status.jobs` (fn-656.1) AND iterates only `sessionDirtyCount`
∪ `priorSessions` (fn-679 bound — the currently-dirty attributed set
built from this snapshot's `dirty_files` ∪ the zero-out-transition set
parsed from the prior `git_status.jobs`). The clearing UPDATE +
`syncIfPlanRef` fire for every session in that bounded union —
including ones leaving the dirty set via `priorSessions` — so a session
zeroes out exactly once on the transition snapshot before dropping
from the persisted JSON. The push guard collapses the persisted set
from a monotonically ratcheting one to the currently-dirty set, and
the fn-679 bound collapses the ITERATED pass-4 set from the entire
undischarged set under `project_dir` (dominated by non-discharging
planctl attributions, 288 in production) to the same event-relevant
union. The dominant GitSnapshot cost is pass 1 (explicit attribution),
not pass 4: its tool-mutation arms, bash exact-match scan, and
git-rm/git-mv deletion scan run inside a per-dirty-file loop, so fn-787
hoists the two snapshot-invariant scans (bash + deletion) and the two
tool prepared statements ONCE per snapshot — mirroring the pass-2
`computeRepoBashWindows` hoist — and matches each file in JS, keeping
steady-state folds under the realtime bar. Re-fold determinism is preserved: both the persisted set and
the bound read only event-derived state (this snapshot's
`dirty_files`, `file_attributions` populated by passes 1-3, and the
prior `git_status.jobs` blob). Per-job project-wide counters
(`git_orphan_count` / `git_unattributed_to_live_count`) broadcast onto
the bounded set only — informational-only columns (readiness reads
`git_status` scalars + per-file `dirty_files[].attributions[]`, not
the per-job columns), so the narrowed broadcast is a cosmetic shrink.
`GitRootDropped` retracts symmetrically. As of
schema v32 (fn-634, narrowed at v63/fn-756), `epics` adds
`default_visible` as a VIRTUAL generated column SQLite computes from
`CASE WHEN status='open' THEN 1 ELSE 0 END`,
materializing the descriptor's default scope as a single
0/1 derived value; a partial composite index
`idx_epics_default_visible ON epics(default_visible, sort_path, epic_id)
WHERE default_visible = 1` serves the default no-wire-filter query as
a covering SEARCH (no SCAN, no temp B-tree for the
`sort_path ASC, epic_id ASC` ORDER BY) — collapsing the Tier 4
diffTick/metaCount p95 tail. As of schema v33 (fn-639), a new
`profiles` projection table (one row per Claude profile directory keyed
by `config_dir TEXT NOT NULL PRIMARY KEY`; the `''` sentinel collapses
default `~/.claude`) is maintained by two reducer fan-outs inside the
existing `BEGIN IMMEDIATE`: the SessionStart arm `INSERT OR IGNORE`s a
visible row for every unique `config_dir` (quiet or not — `last_rate_limit_*`
stay NULL until the first rate_limit lands), and the dual-case
`RateLimited`/`ApiError(kind='rate_limit')` arm UPSERTs
`last_rate_limit_at` + `last_rate_limit_session_id` against the same
`COALESCE(config_dir,'')` expression as the seed so a NULL-config session's
rate limit lands on the exact `''` row it seeded (worker count unchanged
— no new producer thread; the fan-outs ride the existing reducer arms).
As of schema v34 (fn-637), the `epics` projection adds
`resolved_epic_deps` (a nullable JSON-TEXT array — `null` for
not-yet-computed, `[]` for computed-no-deps, populated for resolved
entries) carrying the enriched, resolved state of each token in the
consumer epic's `depends_on_epics`: per-entry
`{dep_token, resolved_epic_id, epic_number, project_basename,
cross_project, state}` where `state` is the tri-state
`satisfied | blocked-incomplete | dangling`. A companion
`epic_dep_edges (consumer_id, dep_token)` reverse-index table keys every
raw token off the consumer's source array. Both are maintained by the
reducer's schema-v34 `syncResolvedEpicDeps` forward-stamp + reverse
fan-out inside the same `BEGIN IMMEDIATE` as the triggering
`EpicSnapshot` / `EpicDeleted` fold: the forward pass rebuilds the
consumer's `epic_dep_edges` rows from scratch and stamps
`resolved_epic_deps` using the shared `epic-deps#resolveEpicDep` (no
fold-time wall clock — the event's own `ts` is injected for the
diagnostic timestamp), and the reverse pass picks every downstream
consumer whose raw tokens could match the just-written upstream (via
`SELECT consumer_id FROM epic_dep_edges WHERE dep_token IN (B.epic_id,
"fn-" || B.epic_number)` — the indexed reverse lookup, never a
`json_each` scan) and re-stamps each one's `resolved_epic_deps` from
scratch. End-to-end: completing (done) an upstream re-stamps
every downstream consumer's entries to `satisfied` in the SAME fold,
and a bare-id ambiguity disambiguates as soon as a new same-number
epic lands. The readiness/board READ surface is fully projection-driven
— predicate 9 in `src/readiness.ts` and the board summary pill in
`scripts/board.ts` consume `epic.resolved_epic_deps` directly (the
prior fn-637 stopgap that streamed completed (done) epics over
a resolver-only subscription so the live readiness pass could see them
is gone — `subscribeReadiness` is back to four collections, predicate 9
no longer calls `resolveEpicDep`, and the `BlockReason` surface
autopilot consumes — `dep-on-epic` with `cross_project`,
`dep-on-epic-dangling` — is byte-for-byte preserved off the projection
shape). The `EpicSnapshot` ON CONFLICT carve-out widens to include
`resolved_epic_deps` alongside `tasks` / `jobs` / `job_links` /
`created_by_closer_of` / `sort_path` / `queue_jump` so a file-content
re-observation can't wipe the projection-derived dep resolution.
As of schema v35 (fn-642, corrected at v42/fn-662), the `usage`
projection colocates the Claude rate-limit annotation:
`last_rate_limit_at` + `last_rate_limit_session_id` are populated
server-side by a bidirectional fan-out against the matching `profiles`
row, joined on the derived `profile_name = projectBasename(config_dir)`
column (`profiles.profile_name = usage.id`). The forward direction
lives in the `RateLimited` / `ApiError(kind='rate_limit')` arm — a
pure UPDATE against `usage WHERE id = <profile_name>` (never UPSERT, so
a rate-limit on a profile agentuse isn't tracking does NOT mint a
phantom usage row). The reverse direction lives in `projectUsageRow`:
the existing UPSERT carves the two rate-limit columns OUT of the
`ON CONFLICT(id) DO UPDATE SET` clause (so a re-snapshot can't clobber
the annotation), then a post-UPSERT SELECT against `profiles` pulls
the current state forward. The shared directional mapping helper pair
(`usageIdForProfileName` / `profileNameForUsageId` in
`src/epic-deps.ts`, schema v42/fn-662) translates keeper's `''`
default-profile sentinel (default `~/.claude`, basename `""`) to
agentuse's `"default"` usage id at the join boundary in both directions:
forward `''` → `'default'` colocates a default-account rate limit onto
`usage.default`; reverse `'default'` → `''` pulls the `''` profile
row's annotation onto `usage.default` on a re-snapshot. The mapping
is one-way at each direction (`''` never maps to `''`), so a
pathological literal `usage.id=''` stays non-joinable — the
cross-contamination the original v35 `!= ''` guard prevented is now
structurally impossible by mapping direction, and the `'default'`
literal lives in exactly one place (the helper). The `profile_name`
derivation is byte-identical at the SessionStart seed, the dual-case
UPSERT, and the v34→v35 one-time migrate backfill — re-fold
determinism converges. The colocation drops `scripts/usage.ts`'s
"Rate limits by profile" block: each tracked profile's usage stack
(including the default account) now carries a `rate-limited <rel>`
line off the same row; untracked profiles render no rate-limit
annotation.
As of schema v37 (fn-643), keeper recovers dropped hook events instead
of silently losing them. The hook's `events` INSERT gains a bounded retry
on `SQLITE_BUSY` / `SQLITE_LOCKED`; on final failure it writes a per-pid
NDJSON dead-letter file to `~/.local/state/keeper/dead-letters/` carrying
a self-describing record (`dl_id`, all derived insert bindings, and the
SessionStart-scraped `spawn_name` / `start_time` / `config_dir`) and
still exits 0 (the "never block Claude" contract). The daemon imports
those files into the new `dead_letters` operational sidecar table at
boot AND live via a seventh worker (the dead-letter watcher), keyed by
`dl_id` so re-scans never duplicate. Import is OPERATIONAL, not a fold:
the table is NOT a reducer projection and the from-scratch re-fold reset
(`UPDATE reducer_state SET last_event_id = 0; DELETE FROM jobs;
DELETE FROM epics`) MUST NOT touch it — dead letters are the audit log
of events that never made it into the event log to be folded.
Recovery is a deliberate one-at-a-time human action: the board renders
the count as a persistent `[dead-letter:N]` warn pill in its banner;
the `r` keypress fires the `replay_dead_letter` RPC, which routes
board → socket → server-worker → main and lets main append a plain
real event (full bindings, real pid, preserved `ts`) AND flip the row
to `recovered` in ONE `BEGIN IMMEDIATE`. The recovered event then folds
through the normal id-ordered drain; the dropped session reappears in
the board (with its full lifecycle, since the original event log carried
nothing for it) and `N` drops by one. The schema bump is v36→v37; fn-642
(`profile_name` jobs column) occupies the v35→v36 slot ahead of this
work.
As of schema v48 (fn-668), each Claude session's terminal-multiplexer
backend-exec coordinates are materialized as first-class columns on the
`events` row and (folded onto) the `jobs` projection. The hook reads pure
synchronous `process.env` values on EVERY event for the tmux backend:
`TMUX` → `backend_exec_type='tmux'`, `KEEPER_TMUX_SESSION` → `backend_exec_session_id`
(present only on keeper-managed launches, injected via `-e`; a human-created
tmux session gets it filled later by the restore-worker pane poller, epic
fn-789), `TMUX_PANE` → `backend_exec_pane_id` (raw; no fork, no fs, no
PPID-walk; absent env ⇒ NULL coords, never a bogus `type`). The pane id is a
two-step read: native `TMUX_PANE` first, else the keeper-owned carrier
`KEEPER_TMUX_PANE` (claudewrap strips `TMUX`/`TMUX_PANE` to let Claude emit
truecolor, copying the pane id into the carrier first so window renaming
survives the strip; the carrier-fed fallback stamps coord-identical tmux rows).
And the reducer's
`applyEvent` arm folds the three onto
`jobs.backend_exec_{type,session_id,pane_id}` latest-non-NULL-wins via
`COALESCE`, so a re-fold from cursor=0 reproduces byte-identical rows. The
generic `backend_exec_*` naming keeps a further backend slotting in with only
the hook's env-name table changing. The three live `jobs.backend_exec_*` columns
(`type`, `session_id`, `pane_id`) are display-only on
`JOBS_DESCRIPTOR` (like `profile_name` — read by the renderer, never
a `sortable` / `filters` / `jsonColumns` key); the shared
`projectJobRow` + `renderJobsBody` helpers append an optional trailing
`[p<pane>]` pane pill, gracefully showing nothing when the pane is
absent. The pill surfaces identically on `keeper jobs` (CLI list mode)
and the TUI (the view-shell's shared `renderBody` callback). There is no
`<tab>` slot: the three hook-fed coords above are the whole backend-coords
surface.
keeper-py's `SUPPORTED_SCHEMA_VERSIONS` frozenset gains `48`
(whitelist-only; keeper-py reads `jobs` / `git_status` / `meta`, not
the `backend_exec_*` columns).
As of schema v47 (fn-667), the autopilot pause/playing flag is event-sourced
into a new singleton `autopilot_state` projection table (`id INTEGER PRIMARY
KEY CHECK (id = 1)`, `paused INTEGER NOT NULL`, plus `last_event_id` /
`created_at` / `updated_at` per the standard projection discipline). Main
mints `AutopilotPaused{paused:boolean}` synthetic events (steady-state via
the `set_autopilot_paused` RPC bridge, which appends the event FIRST then
flips the in-memory worker gate only on a successful insert — so the gate
and the projection cannot diverge on partial failure; boot via the daemon's
boot drain, which unconditionally appends `AutopilotPaused{paused:true}`
BEFORE `serverWorker` spawns, so a viewer subscribing the instant the
socket opens reads a real `paused=1` row, never an empty surface). The
reducer's `foldAutopilotPaused` arm UPSERTs on the singleton id and
preserves `created_at` through subsequent flips (mirrors
`foldDispatchFailed`'s "first observation" semantic). A from-scratch
re-fold reproduces the row byte-identically (no `Date.now`, no env reads,
no `jobs` SELECT — `created_at` and `updated_at` both derive from
`event.ts`). The `keeper autopilot` viewer subscribes the singleton via
`subscribeCollection({collection: "autopilot_state"})` and drives its
`[paused]` / `[playing]` banner from the folded `paused` column —
replacing the pre-fn-667 hardcoded `state.paused = true` which made the
banner ALWAYS read `[paused]` even while the worker was actively
dispatching (the divergence bug this epic fixes). Trade-off: ~1 extra
event per daemon restart (the boot-append re-arm), accepted in exchange
for re-fold determinism (no migration seed → `created_at` derived purely
from the event log). keeper-py's `SUPPORTED_SCHEMA_VERSIONS` frozenset
gains `47` (whitelist-only; keeper-py reads neither `autopilot_state`
nor `AutopilotPaused`).
As of schema v62 (fn-751), the autopilot gains an explicit mode enum plus a
per-epic armed flag. A NOT NULL `autopilot_state.mode TEXT DEFAULT 'yolo'`
column rides the SAME singleton row as `paused` / `max_concurrent_jobs`:
`yolo` (the backward-compatible default) works every ready epic until none
remain; `armed` works ONLY explicitly-armed epics PLUS their transitive
upstream dependency closure (arming an epic pulls in the prerequisites it
can't complete without, instead of deadlocking on them). The `DEFAULT 'yolo'`
makes the zero-event / pre-existing-row projection identical to today's
behavior and satisfies the NOT NULL constraint for the daemon's boot re-arm
INSERTs (the paused / cap arms bind no `mode`). Main mints
`AutopilotMode{mode:'yolo'|'armed'}` synthetic events; the reducer's
`foldAutopilotMode` arm UPSERTs on the singleton id setting ONLY `mode` and
PRESERVING `paused` + `max_concurrent_jobs` on conflict (the three arms share
`id = 1`, so each preserves the others' columns — a mode flip never clobbers
the live pause flag or the cap, and the sibling folds were extended to
preserve `mode`). A new `armed_epics` PRESENCE table (`epic_id TEXT PRIMARY
KEY`, plus `last_event_id` / `created_at` / `updated_at`) carries the per-epic
armed flag: `EpicArmed{epic_id,armed}` synthetic events fold via
`foldEpicArmed` — `armed:true` → `INSERT OR REPLACE` the row, `armed:false` →
`DELETE` the row (a row's presence means armed). fn-774 adds a SECOND writer of
this table: the `EpicSnapshot` fold prunes the row when an epic folds to
`status='done'` (`epicIsCompleted`) — a completed epic drops off the armed set
(reconcile closure + `[armed]` board pill) rather than lingering. The prune sits
OUTSIDE the EpicSnapshot ON-CONFLICT scalar-change carve-out (mirroring the
`epic_tombstones` clear) so it fires on every `done` snapshot and a from-scratch
re-fold leaves zero rows for any epic that ever completed. The reconcile worker reads
both `mode` and the armed set from the projection snapshot every cycle (no
relay, no in-memory cache) so the state survives restart for free. The mode
suppression lives in two places: a per-row `work`-gate in `reconcile()`, AND
(fn-770) the per-root mutex inside `computeReadiness`. The reconcile worker
computes the eligible-epic closure (`computeEligibleEpics`) ONCE per cycle —
only when `mode === 'armed'` (yolo pays no BFS) — and passes the SAME Set to
both `computeReadiness` (a new trailing-optional `eligibleEpicIds?:
Set<string>`, threaded into `applySingleTaskPerRootMutex`) and the `work`-gate.
The mutex's discretionary pass-2 ready-tiebreak became eligibility-aware: an
ELIGIBLE epic's ready task claims a free root BEFORE an earlier-sorted INELIGIBLE
sibling can, fixing the armed-mode deadlock where an unarmed epic captured the
single per-root slot in sort order and the `work`-gate then suppressed the armed
epic that lost the mutex (net: the armed epic never dispatched). The param is
ABSENT (`undefined`) in yolo — byte-identical legacy single-pass — and PROVIDED
(even empty: armed-but-nothing-armed) in armed mode; the discriminator is
`!== undefined`, never `.size === 0`. Pass-1 physical occupancy (live workers +
launch-window fallback roots) stays eligibility-blind so an eligible task never
preempts a live worker, and close rows stay always-eligible IN THE MUTEX
(mode-exempt) so a finalizer is never starved by the per-root tiebreak. The
`work`-gate is RETAINED — a pass-2b ineligible task can still win a root with no
eligible contender and surface `ready`, and the gate is the only thing that
stops that ineligible winner from launching. fn-773 ADDS a narrowed
armed-mode CLOSE-DISPATCH gate at the same reconcile site (the mutex layer above
stays untouched): in armed mode a `close::` launch fires iff the epic is in the
armed dep-closure (`eligible.has`) OR in-flight (`isEpicInFlight`: a live
`close::<epic>`/`work::<task>` job or surface), so a disarmed-MID-FLIGHT epic
still finishes, closes, and reaps while a COLD close-candidate autopilot never
touched and never armed is suppressed instead of burning repeated closers
(2026-06-10: an unarmed epic burned closers while only a sibling was armed).
Completion-reap stays fully mode-exempt. Both folds
are re-fold-deterministic (no `Date.now`, no env reads — `created_at` /
`updated_at` both derive from `event.ts`; a malformed / unknown-enum payload
folds to a safe no-op with the cursor still advancing), and both projection
tables join the rewind-and-redrain DELETE list so a from-scratch re-fold
rebuilds them byte-identically. The `keeper autopilot` viewer subscribes
`mode` next to the play/pause pill and renders the armed-epics section; the
board flags armed epics with an `[armed]` pill (both subscribe the new
`armed_epics` collection over the UDS socket). keeper-py's
`SUPPORTED_SCHEMA_VERSIONS` frozenset gains `62` (whitelist-only; keeper-py
reads neither `autopilot_state` nor `armed_epics`).
As of schema v65 (fn-784), the nullable `jobs.active_since REAL` column is the
"most-recent-activity-started" recency key for the `keeper dash` AGENTS unified
timeline (`COALESCE(active_since, created_at)` DESC). It is stamped to
`event.ts` ONLY on the rising edge into `working` (the UserPromptSubmit arm's
`state != 'working'` guard, NOT `active_since IS NULL`), so it re-promotes a
job on a genuine stopped/terminal→working restart and HOLDS through mid-run
churn (the explicit `ELSE active_since` branch). The migration adds the column
NULL with NO backfill — backfilling from `updated_at` ("last touched") would
conflate it with "run started" and is non-deterministic; a never-prompted job
stays NULL and sorts by `created_at`. keeper-py's `SUPPORTED_SCHEMA_VERSIONS`
frozenset gains `65` (whitelist-only; keeper-py does not read `active_since`).
As of schema v67 (fn-807), the `commit_trailer_facts` reducer projection
(`event_id` PK; `committer_session_id` / `planctl_op` / `planctl_target` /
`planctl_epic_id` / `committed_at_ms`) is the de-blobbed read path for the
commit-trailer channel of `syncPlanctlLinks`: `foldCommit` writes one row per
trailer-bearing `Commit` in its own transaction, and the loader reads the table
`ORDER BY event_id ASC` instead of re-scanning every `Commit` blob once per
swept session. It derives from `Commit` events ALONE, so the v66→v67 migration
backfills it (through the same `extractCommit` + `parsePlanRef` JS path the
fold uses, `COALESCE`-ing relocated cold blobs) WITHOUT a cursor rewind, and a
from-scratch re-fold reproduces it byte-identically. keeper-py's
`SUPPORTED_SCHEMA_VERSIONS` frozenset gains `67` (whitelist-only; keeper-py
does not read the projection). Any future rewind-and-redrain that wipes the
link projections MUST also `DELETE FROM commit_trailer_facts`.
As of schema v68 (fn-813), the `scheduled_tasks` side table is the read path
for the crons a Claude session arms via the `CronCreate` tool. It folds from
the `CronCreate` / `CronDelete` `PostToolUse` pair gated strictly on
`hook_event='PostToolUse'` (a `PostToolUseFailure` never mints a row): a
CronCreate UPSERTs an `active` row keyed by the composite `(job_id, cron_id)`
(`INSERT ... ON CONFLICT DO UPDATE`, never `OR REPLACE`/`OR IGNORE`, so a
re-created id resurrects and a re-fold update is never silently dropped), and a
CronDelete flips the matching row to `deleted` (an unmatched id is a no-op). The
row stores the payload's pre-rendered `human_schedule` (no cron-string parsing),
the `recurring` / `durable` INTEGER lifts of the payload booleans, and a
deterministically truncated first-line `prompt_summary` (untrusted freeform
text, kept opaque). `status` derives PURELY from event order — the fold never
reads wall-clock — so a from-scratch re-fold reproduces identical rows; the
spent/expired marking on the jobs-TUI render is the only place `Date.now()` /
job-liveness drives display. `ScheduleWakeup` events are deliberately NOT folded
(high-churn, consumed-on-fire). keeper-py's `SUPPORTED_SCHEMA_VERSIONS`
frozenset gains `68` (whitelist-only; keeper-py does not read the projection).
As of schema v70 (fn-817), the producer-stamped `jobs.close_kind TEXT` column
records WHY a session died, classified by a main-side tmux liveness probe at the
two `Killed` producer sites (boot seed-sweep + main's exit-watcher handler):
`server_gone` / `pid_died` (crash-killed → restore) vs.
`window_gone_server_alive` (the human closed the window → don't restore) vs.
`unknown` (probe failure → still crash-eligible). The reducer's `Killed` fold
copies it verbatim (an opaque string; no liveness in the fold), and the
DB-derived crash-restore set reads it per row instead of a frozen `restore.json`
snapshot. NULL default, no cursor rewind — a historical `Killed` carries no
`close_kind`, so a from-scratch re-fold reproduces the NULL zero-event default.
As of schema v71 (fn-817), the nullable `jobs.window_index INTEGER` column
captures the live tmux `#{window_index}` (a window's left-to-right VISUAL
position, not its `@N` identity) so the DB-only restore derivation replays
windows in original visual order. The restore worker probes it per pulse and
posts a layout-hash-gated `WindowIndexSnapshot` event; the reducer folds it as a
pure integer copy keyed by `job_id` (no liveness, no probe in the fold), and a
killed job KEEPS its last-known value so the index survives to restore time when
the original tmux server is dead. NULL default, no cursor rewind. keeper-py's
`SUPPORTED_SCHEMA_VERSIONS` frozenset gains `70` and `71` (whitelist-only;
keeper-py does not read either column).
As of schema v51 (fn-682), the new `jobs.monitors` JSON-array column is the
live per-job view of the background shells a session is running — the
plugin-armed chatctl bus, an agent-armed `keeper await`, a backgrounded
`bun test`. It folds purely from each Stop event's `data.background_tasks`
snapshot (`type:"shell"` allowlist, stable-sorted by id, capped at 50
defensively): every entry carries a three-way `kind` provenance label
recomputed from an in-fold scan of the immutable `events` log — `monitor`
when an earlier PostToolUse:Monitor in the session minted the id,
`bash-bg` when an earlier PostToolUse:Bash with `run_in_background` minted
it, `ambient` for anything else (plugin/harness-armed before the session
existed). The scan is gated on `id < currentEventId` and rides the partial
composite `idx_events_background_task_id (session_id, background_task_id,
id, tool_name) WHERE background_task_id IS NOT NULL` covering index, so
the fold stays index-backed and pure: no wallclock, no env, no fs probe,
no liveness check. As of fn-718 (task 1) each entry also carries
`command` / `description`, lifted straight off the same Stop
`background_tasks[]` snapshot (defensive string coerces — a non-string
folds to `""`) and threaded through `computeMonitors` alongside the
provenance `kind`; the provenance SELECT is UNCHANGED (it still reads only
`(background_task_id, tool_name)`), so the covering index is unaffected.
`status` is deliberately NOT projected — empirically always `"running"`
(fn-708 J7). This is NOT a `SCHEMA_VERSION` bump: `jobs.monitors` is opaque
JSON-TEXT and keeper-py does not read it, so the v51 whitelist entry is
unchanged. Snapshot-replace (NOT append): each Stop's snapshot IS
the new value, an empty / missing snapshot is AUTHORITATIVE (drop-when-
dead — a dead monitor must never linger), and SessionEnd / Killed clear the
column to `'[]'` as part of the
terminal write. A from-scratch cursor=0 re-fold reproduces the column
byte-identically. The expanded `keeper jobs` row renders the live set as
a two-line per-entry block inside the same collapse-controlled region as
the backend-coords pill and sub-agent lines (wire order: backend pill →
monitors → sub-agents): a primary `[<kind>] <description-or-id>` line plus,
when the entry has a command, an indented continuation line carrying the
command's first non-empty line. keeper-py's `SUPPORTED_SCHEMA_VERSIONS`
frozenset gains `51` (whitelist-only; keeper-py reads neither
`jobs.monitors` nor `background_tasks`). The top-level `jobs.monitors`
column is the render-layer view; readiness consumes a *provenance-filtered*
derivative of it carried onto the embedded job (see schema v59 below) — so
v51 is no longer purely display-only.

As of schema v59 (fn-719 task 1), a provenance-filtered
`has_live_worker_monitor` occupancy fact rides onto the embedded
`epics.tasks[].jobs[]` element so the autopilot's readiness pipeline can see
it (the top-level `jobs.monitors` column from v51 is a render-only
projection `src/readiness.ts` never reads, and the embedded job shape
readiness operates on did not carry it). The boolean is derived by
`hasLiveWorkerMonitor(jobs.monitors)`: `true` iff ANY entry is a
WORKER-LAUNCHED monitor (`kind in {monitor, bash-bg}`) — `ambient`
session-watchers (the plugin-armed chatctl bus, a never-claimed background
shell) NEVER count, because they were not launched by the work session's
own turn and must not occupy the autopilot mutex. It is stamped at the Stop
fold's `jobs.monitors`-write site (the only seam that refreshes the monitor
set, and hoisted ABOVE the sub-agent guard — so a mid-Task-yield Stop that
refreshes monitors but skips the `state='stopped'` UPDATE still keeps the
embedded fact honest), then PRESERVED across later job-tick re-syncs by the
`buildEmbeddedJob` OLD-element carve-out (the fn-670 T2
`last_commit_for_task_at` precedent). A SessionEnd / Killed terminal write
clears `jobs.monitors` to `'[]'`, and an explicit terminal stamp forces the
embedded fact to `false` (the carve-out would otherwise preserve a stale
`true` forward) — so a terminal job auto-resolves the fact for free. The
field rides FREE inside the existing opaque JSON-TEXT `tasks` cell: NO new
real column, a whitelist-only v58→v59 bump. The bump is FIX-FORWARD (no
cursor rewind — the v53→v54 / fn-695 precedent): the field is purely
additive with a safe absent ≡ `false` default (`buildEmbeddedJob`
nullish-coalesces a pre-v59 stored element's missing field to `false`), and
the next Stop event re-stamps the real value, so an existing row needs no
backfill. Every input is event-derived (no fold-time wall clock / env / fs /
liveness probe), so a from-scratch cursor=0 re-fold reproduces byte-identical
`epics` rows. A later readiness change (epic fn-719 task 2) reads the
embedded fact to hold
the per-epic / per-root mutex while a stopped session's backgrounded suite
is still running, with the embedded job's `updated_at` (bumped by the
monitors-only Stop write) as the staleness lease anchor.
keeper-py's `SUPPORTED_SCHEMA_VERSIONS` frozenset gains `59`
(whitelist-only; keeper-py reads neither `jobs.monitors` nor the embedded
occupancy fact).
As of schema v50 (fn-678), the new `pending_dispatches` projection table
(keyed by `(verb, id)`) is the durable launch-window occupancy signal that
replaced the fn-674 live tab-name probe. A `Dispatched` synthetic
event UPSERTs a row (`dir`, `dispatched_at`, `last_event_id`); a
`SessionStart` fold DELETEs by the same key (discharge-on-bind); a
`DispatchExpired` synthetic event DELETEs the key when the TTL sweep fires.
`DispatchFailed` also DELETEs the pending row so a failed dispatch does not
block the failure as permanently occupied. A from-scratch re-fold reproduces
the table byte-identically (no fold-time wall clock; `dispatched_at` derives
from the event's own `ts`; no `Dispatched` events in the pre-v50 log →
empty table on historical replay). keeper-py's `SUPPORTED_SCHEMA_VERSIONS`
frozenset gains `50` (whitelist-only).

The producer side of this lifecycle is hardened independently of the reducer,
schema, and `keeper/api.py` (`SCHEMA_VERSION` stays 59). The mint is
DURABLE-ack'd: `confirmRunning` AWAITS main's `Dispatched` insert
(an id-correlated `dispatched-ack{id, ok}` reply, bounded by a
`DISPATCHED_ACK_TIMEOUT_MS` floor) BEFORE calling `launch()`, so outbox
ordering — intent committed before side-effect — is load-bearing rather than
fire-and-forget; on `ok:false` or ack-timeout the worker aborts without
launching (any phantom row clears via the TTL sweep), closing the
SessionStart-drains-before-`dispatched` double-dispatch race. The ack sits
AHEAD of the reducer drain: main replies the moment `insertEvent.run`
returns (the ack promises INSERT durability only — never the fold), THEN pumps
the reducer in its own guarded block, so a slow or throwing pump can neither
delay the worker's launch nor flip the already-sent ack. Outbox ordering holds
— the insert precedes the launch; the ack sits ahead of the drain. The launch
outcome is now three-way (`ConfirmOutcome`): a launch-failure
(`launch.ok===false`) still mints `DispatchFailed`; a clean bind before the
ceiling is `"ok"`; but a ceiling hit (60s) with `launch.ok===true` is
`"indoubt"` — the launch succeeded and the bind is merely late, so NO
`DispatchFailed` is minted, the `pending_dispatches` row is KEPT, and the
120s TTL sweep (`PENDING_DISPATCH_TTL_MS > ceilingMs`, an invariant pinned by
a test) emits `DispatchExpired` only if the bind truly never lands. On
`set-paused` (boot-pause included via the same relay), the worker reaped stale
launch-window surfaces by intersecting `list-panes -a -j` with OPEN
`pending_dispatches` rows — a discharged row = live worker, never reaped — and
the reap never threw (no-self-heal). That broad reap (`ExecBackend.reapSurfaces`)
was deleted in epic fn-789; the fn-802 window-reaper is its narrow,
completion-gated successor (a single `killWindow`, never a sweep).
As of schema v42 (fn-661), the new `dispatch_failures` projection table
(keyed by `(verb, ref)` — the same `verb::id` correlation key the autopilot
reconciler uses to dedup against `jobs`) carries the sticky failure record
for the server-side reconciler. It is folded purely from the event log: a
`DispatchFailed` synthetic event UPSERTs a row (`failed_at`, `reason`,
`source` — `launch` / `precheck`); a `DispatchCleared`
synthetic event DELETEs by the same key. `confirm_timeout` is not a
`DispatchFailed` source: a confirm-poll ceiling hit with `launch.ok===true` is
the `"indoubt"` outcome that mints NO `DispatchFailed` — it keeps the
`pending_dispatches` row and lets the TTL sweep emit `DispatchExpired` — so
the only `DispatchFailed` sources are a hard `launch.ok===false` and a
precheck refusal. No auto-retry; the only way to
clear a row is the `retry_dispatch` RPC (human-driven), which routes through
the server-worker → main → `DispatchCleared` mint. A from-scratch re-fold
reproduces the table byte-identically (no fold-time wall clock; the event's
own `ts` lands in `failed_at`). The `keeper autopilot` CLI is a thin viewer
plus the `play` / `pause` / `retry` controls; the reconcile loop runs
server-side in the daemon. keeper-py's `SUPPORTED_SCHEMA_VERSIONS` frozenset
gains `42`
(whitelist-only; keeper-py reads `jobs` / `git_status` / `meta`, not
`dispatch_failures`).
As of schema v41 (fn-651), the `usage` projection tells the truth about
WHEN a rate-limited profile unblocks AND whether its numbers are fresh.
Two additive nullable columns ride the existing `UsageSnapshot`
percentage path. `rate_limit_lifts_at TEXT` is folded from the agentuse
envelope's new top-level `lift_at` field — agentuse computes it as the
soonest `resets_at` among windows at >=100% used, the effective unblock
instant; null when not over any limit. `last_usage_fold_at REAL` is the
unix-seconds freshness stamp equal to the event `ts` of the last
SUCCESSFUL usage fold (`status === "active"` OR any per-window percent
non-null), NEVER bumped by an idle/stale snapshot or the rate-limit
(`RateLimited` / `ApiError(kind='rate_limit')`) fan-out — the
determinism boundary is the event ts, never `Date.now()` inside a fold,
and the COALESCE-preserve in the UPSERT keeps a prior successful stamp
through later idle/stale folds so a wedged ingestion path's last-good
stamp survives until a real successful fold replaces it. Both columns
are symmetric to the v35 rate-limit columns: a rate-limit fold's
`UPDATE usage SET ...` excludes both (so a stale rate-limit event
cannot clobber a fresh percentage fold's lift / freshness), and the
percentage path owns them outright. The renderer compares the stale
anchor — `max(last_usage_fold_at, rate_limit_lifts_at)` (fn-754) —
against the wall clock to surface a staleness warning when ingestion
has wedged, anchoring to the lift so a deliberately-idle producer
(agentuse paused polling a maxed account until its lift, freezing the
fold stamp) is not misread as dead, and renders a `limited lifts in
`<rel>`` countdown off `rate_limit_lifts_at` (`limited lifts now`
within the ±30s gap; omitted when the lift is absent or already past —
never a confusing "`<rel>` ago" countdown).
As of schema v25, each `epics.job_links`
entry embeds the linked job's `title` / `state` / `last_api_error_at` /
`last_api_error_kind` / `last_input_request_at` /
`last_input_request_kind` denormalized off the live `jobs` row at the
reducer's write boundary (via the shared `enrichJobLink` helper) —
renderers (board) and predicates (readiness) read everything off
`epics.job_links` with no live-jobs join, so terminal sessions and
off-page live sessions no longer fall through to a degraded render
line. A symmetric jobs-write fan-out (`syncJobLinksOnJobWrite`)
re-stamps the enriched fields on every linked epic whenever a jobs
row changes
`(title, state, last_api_error_at, last_api_error_kind,
last_input_request_at, last_input_request_kind)`, keeping the
projection in lockstep with the session's last-known lifecycle. The
two stoppage pairs follow the single canonical clearing contract above
(stamp on `ApiError` / `InputRequest`; clear + un-stop to `working` on
the next `UserPromptSubmit` / `SessionStart` revival OR `PreToolUse` /
`PostToolUse` tool event, each gated on its column-is-not-NULL hot-path
predicate so the 50+/turn tool path stays cold). Each epic also embeds its plan/close-verb (epic-form)
jobs as a `jobs` JSON array, and each task element embeds its own
work-verb (task-form) jobs as a nested `jobs` sub-array — fanned in
from the reducer's jobs-side writes whenever a SessionStart spawn name
parses as `{plan|work|close}::<ref>`
(the `syncJobIntoEpic` helper), so the single `epics` collection serves epic
+ tasks + associated sessions in one subscribe. As of schema v14 a second
fan-out rides alongside: every `planctl_op != NULL` event AND (epic fn-695,
schema v54) every `Commit` event carrying the `Planctl-Op` / `Planctl-Target`
/ `Session-Id` trailers triggers the `syncPlanctlLinks` helper, which
re-derives per-session `jobs.epic_links` and per-epic `epics.job_links` from
the session's planctl-CLI footprint — the deduped UNION of the legacy
stdout-scrape rows and the durable commit-trailer facts — classified against
its `/plan:plan` windows (creator = `epic-create` OR `scaffold` mutation
inside a window — scaffold is the canonical epic-create path on this
codebase; refiner = any other epic-touching mutation inside a window). The
commit-trailer side reads the indexed `commit_trailer_facts` projection
(schema v67, fn-807) ONCE per call — `foldCommit` writes one fact row per
trailer-bearing `Commit` in its own transaction — instead of re-scanning every
`Commit` blob once per swept session (the fold fan-out the projection retired).
`syncPlanctlLinks` stays the SINGLE writer of both cells; `foldCommit` only
triggers the rebuild, never writes the edge directly. The commit channel
makes the edge survive any stdout pipe / `grep` / truncation that NULLs
`planctl_op` (the fn-635 failure) plus client + server reboots. Both fan-outs run INSIDE the same `BEGIN IMMEDIATE` transaction
as the triggering event's projection write + cursor advance, so the embedded
arrays + link projections are pure functions of the event log and a
from-scratch re-fold reproduces them byte-identically. File deletions are filesystem-synchronized: a live delete fires
a tombstone, and a boot-reconciliation sweep retracts anything deleted while
the daemon was down. It is
the second instance of the same producer archetype as the transcript worker:
read-only / write-free, feeding the log only via main. Both producers self-
recover from a *dropped-events* FSEvents overrun (the recoverable "...must be
re-scanned" watcher error) without a daemon restart: they schedule a debounced,
single-flight re-scan of their existing change-gated boot-scan path (per
affected root for the plan worker), recovering the missed change in-process —
the live subscription stays up, no re-subscribe. The plan worker also self-
recovers from a *silently-mute* subscription (one that stops delivering
entirely): the heartbeat backstop flags exactly the affected root(s) and the
next reconcile replaces ONLY that root's subscription — `await unsubscribe()`
then a fresh `subscribe()` with identical options, sequential and bounded per
cycle, keyed per root so a healthy root is never re-armed. The replace touches
only the watcher stream; the PlanScanner change-gate survives, so no phantom
re-folds emit.

The transcript worker self-recovers from a *silently-mute* subscription the
same way, scaled to its single static watch: it has no reconcile loop, so a
heartbeat rescue (the slow `scanJobsForTitles` backstop re-folded a title the
live tail missed) drives the replace directly — `await unsubscribe()` then a
fresh `subscribe()` with the identical options, sequential and non-fatal (a
re-subscribe failure leaves the tree unwatched until the next heartbeat
re-fires, never exits). A monotonic generation guard makes a stale in-flight
callback (the parcel/watcher #190 window) inert, a missing watch root defers
the re-arm to the next heartbeat instead of erroring, and a one-heartbeat flap
guard suppresses a re-arm while a fresh replacement is still proving itself.
The replace swaps only the `subscription` variable; the line stream's byte
offsets are untouched, so the post-re-arm rescan re-anchors nothing and emits
no phantom titles.

A **fifth** Worker thread is the usage producer: it watches the agentuse
daemon's flat leaf state directory (`~/.local/state/agentuse/`, one
`<id>.json` per profile) with `@parcel/watcher`, safe-parses each changed
file, and posts a `usage-snapshot` message to main (and a `usage-deleted`
tombstone when a file vanishes). Main — again the sole writer — turns each
into a synthetic `UsageSnapshot` (or `UsageDeleted`) events row and pumps a
wake; the reducer folds it as an idempotent upsert into the flat `usage`
projection (one row per profile; deletes via tombstone). As of schema v23
the `usage` table lands alongside the existing collections, indexed via
the same descriptor + REGISTRY entry pattern as `git`. Freshness fields
(`fetched_at` / `next_fetch_at` / `last_successful_fetch_at` /
`last_skipped_fetch_at`) are read-and-discarded at the worker boundary and
excluded from both the change-gate and the projection schema, so the ~90s
agentuse fetch loop produces zero events when no content moved. Like the
transcript + plan producers, this is read-only / write-free, feeding the
log only via main, and the watcher subscription is released in the
worker's own shutdown handler. The producer also self-recovers from a
*dropped-events* FSEvents overrun via a debounced single-flight re-scan
of the existing change-gated boot-scan path.

A **sixth** Worker thread is the exit-watcher: it owns a kqueue (macOS) or
pidfd+epoll (Linux) fd via `bun:ffi`, polls `data_version` to keep its watch
set in sync with the candidate `jobs` rows (`state IN ('working','stopped')
AND pid IS NOT NULL`), and posts an `exit` message whenever a tracked pid
exits or the post-register kill-0 probe finds it already dead. Main — the
sole writer — verifies the message's `(pid, start_time)` snapshot still
matches the persisted row, runs a main-side tmux liveness probe to classify the
death into a `close_kind` (`server_gone` / `pid_died` crash-like vs.
`window_gone_server_alive` user-close vs. `unknown` probe-failure; schema v70,
fn-817), then turns the exit into a synthetic `Killed` events row carrying that
`close_kind` and pumps a wake; the reducer folds it to the `killed` state and
copies `close_kind` verbatim, so the DB-derived crash-restore set can later tell
a crash from a deliberate close per row. This is the live-side counterpart to
the boot-time seed sweep that runs
between `migrate → drainToCompletion` and worker spawn: the sweep covers
downtime (zombie rows already on disk), the exit-watcher covers steady state
(processes that die while the daemon is up). It is the third producer-worker
instance — read-only / write-free, feeding the log only via main — and its
kqueue/pidfd fd is owned by the worker thread, released in its own shutdown
handler.

The exit-watcher carries a THIRD synthetic-`Killed` producer alongside the
kernel arm: a periodic dead-pid **re-probe** (`reprobeLoop`, ~60s tick). The
kernel arm (kqueue `EV_ONESHOT` / pidfd `EPOLLONESHOT`) occasionally misses or
races, and the boot seed sweep runs once per boot — so a non-terminal row whose
worker pid is verifiably dead could otherwise sit forever. On each slow tick the
re-probe queries the candidate set, and for each pid-bearing row older than a
launch-race age gate (`created_at >= 5 min`, mirroring the sitter's
`STUCK_JOB_MIN_AGE_SECS`) runs the pure `selectDeadReprobeCandidates` predicate:
`kill(pid,0)`-dead → reap; alive-but-recycled (`(pid, start_time)` start_time
mismatch via `readOsStartTime`) → reap; probe failure / NULL start_time → leave
alone (conservative, mirroring the seed sweep). It posts the SAME exit message
the kernel arm posts — main's verifier and the reducer's `Killed` fold (terminal
guard + `(pid, start_time)` match) are unchanged, so a resume between probe and
fold is a safe no-op. The age gate keys on `created_at`, NOT `updated_at` (late
git-count/title/monitor writes reset `updated_at` on a stopped row); each reap
logs one forensic stderr line with `(jobId, pid, start_time, reason)`.

A **seventh** Worker thread is the dead-letter watcher (schema v37, fn-643):
it watches `~/.local/state/keeper/dead-letters/` with `@parcel/watcher` and
posts a contentless `{kind: "dead-letter-changed"}` message to main on every
change. Main owns the actual `dead_letters` write — scans the dir, reads
each NDJSON file, parses each line, and `INSERT OR IGNORE`s into
`dead_letters` keyed by `dl_id` (idempotent under re-scan). The worker
holds no DB connection (main is the sole writer of operational rows too),
just the watcher subscription, released in its own shutdown handler.
Missing-dir tolerance: a fresh machine has no `dead-letters/` tree until
the hook hits its first drop; the worker tolerates absence at spawn and
the watch installs lazily once main first imports. Like the other
external-tree watchers it self-recovers from FSEvents drop-overruns via
the shared debounced re-scan scheduler. Distinct from the other six
producers it does NOT mint synthetic `events` rows — the import is a
direct operational-table write — and it is NOT a fold.

An **eighth** Worker thread is the autopilot reconciler (schema v42, fn-661):
a server-side, level-triggered, change-driven control loop that owns dispatch
decision, launch, confirmation, dedup, and (config-gated) reap. It polls
`PRAGMA data_version` on its own read-only connection like the other
projection consumers, but on each wake it re-runs `computeReadiness` from
scratch and reconciles desired-vs-observed against the live `jobs` projection
— never an edge trigger. Dedup is primarily keeperd job presence
(correlated by `--name` → `plan_verb`+`plan_ref`), backed by the durable
`pending_dispatches` projection (schema v50, fn-678; durable-ack +
three-way outcome + reap-on-pause hardening, fn-724): before calling
`launch()`, `confirmRunning` AWAITS main's durable `Dispatched` insert — it
posts the dispatch payload and BLOCKS on an id-correlated
`dispatched-ack{id, ok}` reply (a `DISPATCHED_ACK_TIMEOUT_MS` floor sized above
busy_timeout + a boot-drain so boot dispatches don't false-abort), so outbox
ordering (intent committed before side-effect) is load-bearing rather than
fire-and-forget; on `ok:false` or ack-timeout it ABORTS without launching (no
double-dispatch — a phantom row clears via the TTL sweep), closing the
SessionStart-drains-before-`dispatched` race (fn-627 class). fn-762: main
replies the ack the moment the `Dispatched` INSERT commits — the ack promises
INSERT durability only, not the fold — and runs the reducer pump AFTERWARD in
its own guarded block, so a slow or throwing pump can't delay the worker's
launch or flip the already-sent ack. Outbox ordering is unchanged (insert still
precedes launch); only the ack moves ahead of the drain. The reducer folds
the `Dispatched` event into a `pending_dispatches` row keyed `(verb, id)`;
`loadReconcileSnapshot` reads the table each cycle. As of fn-721 those rows
feed `computeReadiness` directly as the `dispatch-pending` mutex occupant —
NOT a standalone `reconcile()` suppression arm outside the mutex: a launched
but not-yet-SessionStart-bound worker has no `jobs` row, so readiness reads
the pending rows (via the shared `projectPendingDispatches` helper, the same
input the board's `subscribeReadiness` consumes — no board/autopilot
divergence) and stamps `dispatch-pending` at a late per-row rank that holds
BOTH the per-epic and per-root mutex (`isLiveWorkOccupant` → auto-covers
`isRootOccupant`), demoting a same-epic OR same-root ready sibling. A pending
row matching no snapshot row occupies its root via its own `dir` column
(root-fallback). The pre-existing same-`(verb, id)` `liveTabKeys.has(key)`
suppression arm (sitting alongside the `isOccupyingJob` arm) is PRESERVED for
same-key re-dispatch — orthogonal to the cross-sibling demotion the occupant
does. `reconcile()` stays pure — it reads the synchronous pending-rows
snapshot, never the backend, so re-fold determinism is preserved
(`dispatch-pending` is a read-time client verdict, NOT a folded one).
**fn-735 adds a fold-lag-immune in-process re-dispatch cooldown as the
suppression source of truth** — every other dedup arm (`failedKeys`,
`isOccupyingJob`, `liveTabKeys`, the `dispatch-pending` occupant) reads a
PROJECTION, so when the reducer lags 15-60s+ behind reality all of them are
blind to a dispatch that already fired and the same `verb::id` is re-launched
(the observed two-`close::fn-651`-workers / infinite-re-approve class). The
cooldown is an in-memory `Map<verb::id, unix-seconds>` on `ReconcileState`
(the optimistic-in-flight-set pattern, cf. Kubernetes
`UIDTrackingControllerExpectations`): `runReconcileCycle` STAMPS the key at
dispatch — BEFORE the confirm await, so it covers BOTH the `ok` and the slow-
cold-boot `indoubt` outcomes (the headline bug) — and `reconcile` reads it (a
read-only gate at BOTH dispatch sites, above the fn-728 budget gate, so it
covers work/close alike) to suppress re-dispatch
for `REDISPATCH_COOLDOWN_S`. fn-762 set that window to 200s, STRICTLY GREATER
than `PENDING_DISPATCH_TTL_MS / 1000` (120) + the `PENDING_DISPATCH_SWEEP`
granularity (60): the 2026-06-09 incident triple-dispatched one worktree
because the cooldown CO-EXPIRED with the 120s TTL while fold lag still outlived
both — the window must outlast the WHOLE round-trip (pending row surviving a
full TTL, then the sweep tick that clears the phantom), not merely the TTL. The
load-bearing ordering chain is `ceilingMs (60s) < PENDING_DISPATCH_TTL_MS
(120s) < REDISPATCH_COOLDOWN_S (200s)` (a shorter window re-introduces
over-dispatch at expiry, k8s #129795). It is dispatch-side scheduling ONLY:
in-memory, never written to the event log / projections / reducer / RPC
surface, boots EMPTY on restart (safe — autopilot boots paused and the first
cycle rebuilds suppression from the live projection), and is mutated ONLY in
the cycle glue (`reconcile` stays pure — it never writes the Map). A definitive
launch failure (`launch.ok===false` → `DispatchFailed`) or a PRE-LAUNCH abort
(`aborted-prelaunch` — ack reject / `{ok:false}` / shutdown racing the ack:
nothing launched) CLEARS the entry so `failedKeys` owns stickiness and a human
`retry_dispatch` re-dispatches without waiting out the cooldown; `ok`,
`indoubt`, and a POST-LAUNCH abort (`aborted-postlaunch` — a mid-poll shutdown
after the launch fired, when a ghost worker may exist) all KEEP it. The
`indoubt` outcome RE-STAMPS the entry ONCE at resolution (the dispatch-time
stamp is up to `ceilingMs` stale by then; a single refresh restarts the
window — never compounding across cycles, the perpetual-suppression trap). Each
cycle prunes expired entries (`sweepRedispatchCooldown`, mirroring
`server-worker.ts`'s `reapStuckPending`, wrapped so a sweep throw can't bounce
the daemon). **The cooldown covers all verbs, dispatch-side, in-memory.**
The row discharges when `SessionStart` folds (reducer DELETE) or via a producer-side
TTL sweep on the heartbeat (`PENDING_DISPATCH_TTL_MS`, 120s,
`DispatchExpired`) — so both the launch → SessionStart blind window and the
`dispatch-pending` occupancy self-clear without any live multiplexer probe (the
`verb::id` window name is a cosmetic label only). SAFETY SEAM: the fn-721
occupant closes the cross-cycle double-dispatch window; `confirmRunning`'s
serial wait still covers the intra-cycle race and stays in place. The reconciler boots PAUSED (the in-memory
worker gate is seeded `true` from `workerData.paused`, and the daemon's
boot drain unconditionally appends an `AutopilotPaused{paused:true}`
synthetic event so the durable `autopilot_state` singleton projection
also boots paused — schema v47 / fn-667; safe-by-default after restart
is maintained by the boot-append re-arm event, not by flag volatility)
and flips on the `set_autopilot_paused` RPC, which appends an
`AutopilotPaused{paused}` event FIRST then flips the worker gate only
on a successful insert (so the gate and the projection cannot diverge
on partial failure). The terminal-surface mechanics live behind the
`ExecBackend` (`src/exec-backend.ts`) — `launch`, `focusPane`,
`ensureLaunched`, `listPanes`/`renameWindow` (the renamer), and `killWindow`
(the reaper's only kill op; there is no general `reapSurfaces` close path).
`ensureLaunched` (session-agnostic) get-or-creates the
target session with its own per-call mint and launches an
unnamed window — `restore-agents.ts` is the consumer. tmux is the sole backend,
resolved via `resolveExecBackend`; each reconciler dispatch opens as a new
window in the hardcoded managed session (`autopilot`). Each op runs a cheap
per-call `has-session` probe and mints via `new-session -d` only when the
session is absent, so a stale/EXITED corpse is rebuilt rather than resurrected;
a probe short-circuits before any mint when the target is already LIVE. The confirm step
is now three-way (`ConfirmOutcome`, fn-724): a hard launch failure
(`launch.ok===false`) posts a `DispatchFailedMessage` to main — which, again
the sole writer, turns it into a synthetic `DispatchFailed` events row, pumps
a wake, and lets the reducer fold it into the `dispatch_failures` projection;
a clean SessionStart bind before the 60s ceiling is `"ok"`; but a ceiling hit
with `launch.ok===true` is `"indoubt"` — the launch SUCCEEDED and the bind is
merely late, so NO `DispatchFailed` is minted (the prior `confirm_timeout`
write-off that produced ghost workers is gone), the `pending_dispatches` row
is KEPT, `inFlight` releases, and the 120s TTL sweep
(`PENDING_DISPATCH_TTL_MS > ceilingMs (60s)`, an invariant pinned by a test)
emits `DispatchExpired` only if the bind truly never lands.

keeper closes a managed window ONLY through the window-reaper worker (epic
fn-802), and only when the work is VERIFIABLY complete: an autopilot-dispatched
`work`/`close` job stopped for over 60s with a `{tag:"completed"}` readiness
verdict. Every other window — pending, live, working, or worker-ended-incomplete
— stays open for inspection until the human closes it. The launch-window
pause-ghost reap and the `autoclose_windows` config key were deleted outright in
epic fn-789 (the broad `reapSurfaces` close path no longer exists on
`ExecBackend`); the reaper is its narrow, evidence-gated successor (`killWindow`
on a single managed pane, never a `list-panes` sweep-and-close). The
pending-dispatch row still discharges on `SessionStart` or the 120s TTL sweep
(above), independent of the reaper. The close-row
readiness verdict still rides the fn-764 wind-down read: the default epics read
scopes to `status='open'`, so a SECOND bounded read (`filter:{status:"done"}`,
sorted `updated_at` DESC, limited to a small window — never O(all done history),
the fn-748 anti-pattern) keeps a freshly-done epic observed through its
done→idle wind-down for the close-row's liveness gate in `src/readiness.ts`.

There is NO auto-retry — a failed dispatch is sticky and visible in `keeper
autopilot`'s `--- failed ---` section until the human runs `keeper autopilot
retry <verb::id>`, which routes through the server-worker's `retry_dispatch`
RPC → main → a synthetic `DispatchCleared` events row → the reducer DELETEs
the matching `dispatch_failures` row on the next drain. The only durable
autopilot-owned state is the event-sourced `dispatch_failures` and
`pending_dispatches` projections; a from-scratch re-fold reproduces both
byte-identically.

The crash-restore set is derived RETROSPECTIVELY from `keeper.db` at READ TIME
(`src/restore-set.ts`, epic fn-817) — there is no frozen snapshot to read and no
daemon round-trip, which is exactly the disaster-recovery moment restore exists
for (a read-only `keeper.db` connection works with keeperd DOWN). The default
`deriveRestoreSet` derivation is membership-by-`close_kind`: each `killed` row
carries its OWN producer-stamped `close_kind` and membership is a per-row
predicate over it (no per-row "this is where the crash happened" anchor). Epic
fn-819 adds a generation BOUNDARY the restore-worker records — a
`BackendExecStart` synthetic event minted on a tmux-server-pid change (see the
ninth worker below) — and the generation-scoped `deriveLastGenerationSet`
(`restore-agents --last-generation`) bounds candidates to the PREVIOUS session
generation ("the session you just lost") rather than the whole crash-like pool.
It runs the SAME membership/filters, then keeps only candidates whose `Killed`
event sits at or after the KILL-ANCHORED generation boundary
(`B_boundary = MAX(events.id) WHERE hook_event='BackendExecStart' AND id <= K_max`,
where `K_max` is the most-recent candidate `Killed` rowid). Anchoring on the
settled kills (not "the current generation") is load-bearing: boot ordering mints
the dead-generation kills BEFORE the restore-worker posts the new boundary, so a
naive "after the most-recent start" bound would exclude the very agents to
restore. When no `BackendExecStart` precedes the kills (fresh / pre-feature DB)
it FALLS BACK to the most-recent `Killed` burst, never the full 7-day pool. The
boundary is cut by `events.id` rowid ORDER, never `ts` (boot-sweep `Killed`
events all share one `Date.now()` instant). A candidate is a `state='killed'` job whose death
was crash-like — `close_kind ∈ {server_gone, pid_died}` (tmux server gone, or the
pane process died), or `close_kind ∈ {unknown, NULL}` resolved via a BURST
HEURISTIC (the boot seed-sweep emits its `Killed` events back-to-back, so a
contiguous cluster of `Killed` `event_id`s is a crash signature; an isolated one
is a routine close — clustered by `event_id` rowid ORDER, never `ts`, since
boot-sweep `Killed` events are all `Date.now()`-stamped at boot).
`close_kind = window_gone_server_alive` (the human deliberately closed the
window) is EXCLUDED always, even inside a burst. After membership, filters drop
rows with no `backend_exec_session_id`, autopilot workers (`plan_verb='work'`,
reconciler-managed), `job_id`s already occupying a LIVE backend (the UUID-liveness
idempotence guard against a double-spawn race, computed from the same DB read),
and rows idle beyond a cutoff (counted and SURFACED, never silently dropped).
Candidates sort by captured `window_index` (left-to-right tmux VISUAL position;
NULL sinks to the tail by `created_at` then `job_id`), so restore replays windows
in original order. Each candidate's `resume_target` is the `job_id` UUID, never a
mutable session name — a RENAMED session restores correctly.

`scripts/restore-agents.ts` is a thin presenter over that ordered set: its dry-run
prints the plan, `--apply` relaunches each survivor into its original backend
session via `ExecBackend.ensureLaunched` using the shared `buildResumeCommand` /
`resumeTarget` substrate (`src/resume-descriptor`) that keeps the three
resume-command producers byte-identical, pacing window creation 0.5s apart. tmux
is the sole exec backend, so every candidate routes through one resolved instance.
`--last-generation` swaps the candidate source to `deriveLastGenerationSet`
(the kill-anchored generation window above) and composes with `--apply` +
`--session`; the plan/render/apply path is otherwise identical.

A **ninth** Worker thread is the restore-snapshot worker (epic fn-677; freeze
machinery RETIRED in fn-817): a pure CONSUMER that opens its own read-only
connection, polls `PRAGMA data_version` via the shared `watchLoop` primitive, and
on every change reads the `jobs` + `epics` projections through the same `runQuery`
read seam the autopilot worker uses. It rewrites
`~/.local/state/keeper/restore.json` via `atomicWriteFile` as a DUMB single-tier
`{schema_version, current}` live mirror — `current` is the continuous mirror of
the live (`working` / `stopped`) jobs grouped by `backend_exec_session_id`, each
bucket carrying a `backend` tag (`tmux`, v3), rewritten on every content change
(MAY be empty). This file is the DISASTER FALLBACK only, read by
`scripts/restore-agents.ts --snapshot-current`; the two-tier `last_session` freeze
model (boot-promote + the `>0→0` collapse edge + high-water peak) is GONE, since
per-row `close_kind` membership replaces "which set was live before the crash"
with nothing to freeze. The write gate is an in-memory `lastHash` over the file
(sans `current.captured_at`). The file is a derived side-file — NOT a projection,
NOT in the event log — so the mirror itself needs no `SCHEMA_VERSION` bump, no
reducer arm, no `keeper/api.py` change (the `close_kind` v70 / `window_index` v71
column bumps that power the DB-derived set are separate, and carry their
`SUPPORTED_SCHEMA_VERSIONS` entries; see the Architecture schema history).

Riding the SAME data_version pulse, the worker self-gates on ANY live tmux job
and spawns ONE `tmux list-panes` probe feeding two consumers: the WINDOW-ORDER
capture, which posts a layout-hash-gated `WindowIndexSnapshot` event so the
reducer stamps each job's live `#{window_index}` onto the `jobs.window_index`
column (a killed job keeps its last value, so visual order survives to restore
time when the original tmux server is dead); and the PANE-FILL post, which mints
the sole `TmuxPaneSnapshot` synthetic event (fill-only) when a live tmux job
carries a NULL `backend_exec_session_id`. A THIRD post (epic fn-819) rides the
same pulse but is UNGATED by a live tmux job: a `tmux display-message -p
'#{pid}'` probe reads the tmux SERVER pid (the backend "generation" handle), and
on a change — pid-hash-gated, boot-seeded from the last logged event so a
keeperd restart against an unchanged server is silent — the worker mints a
`BackendExecStart` event carrying `backend_type` + `generation_id`. It is
ungated precisely because the post-crash state has no live job, yet the
freshly-respawned server is the generation crash-restore must scope to. The
reducer folds `BackendExecStart` via an explicit NO-OP arm (the boundary lives
in the event-log `id` order, read at restore time, NOT a projection column — no
schema bump). Those three posts are the worker's only worker→main channel and
only event-log contribution — the restore-file write path remains a pure
consumer side-file. Write failures are swallowed to stderr (next pulse retries);
only an unhandled throw out of the watch loop escalates to `onerror`/`close` →
fatalExit.

An **eleventh** Worker thread is the tmux window-renamer (epic fn-801): a
pure EXTERNAL ACTUATOR that opens its own read-only connection, polls
`PRAGMA data_version` via the shared `watchLoop` primitive, and on every
change names each tmux WINDOW hosting a live Claude session after that
session's job title — the latest-appeared Claude in a window wins. It reads
the `jobs` projection through the same `runQuery` read seam, narrows to live
(`working` / `stopped`) tmux jobs carrying both a pane id and a non-empty
title, and gates on an INPUT-side dedup hash of the candidate set so the
constant data_version churn of active sessions (every hook event bumps it)
can't spawn tmux dozens of times per second — an unchanged candidate picture
skips the `list-panes` sweep entirely, and a quiescent board never spawns
tmux at all. On a changed set it sweeps panes via the exec-backend's
`listPanes` (a `null`/degraded tmux skips the cycle), joins panes to
candidates by pane id, groups by window, picks the winner (max `created_at`;
tie → higher `job_id`, a deterministic tiebreak so equal-aged sessions don't
flicker the name), and fires `renameWindow` ONLY where the swept window name
differs from the winning title. Every `rename-window` permanently suppresses
that window's automatic-rename, so a matching name is never re-issued and the
suppression is deliberately left in place (tmux fighting back on every
activity tick is worse than a stale name on a dead window). A TOCTOU rename
failure (the window closed between sweep and rename) is a logged non-fatal
skip; the pulse never throws. Like the restore worker it carries no
`onmessage` handler — it NEVER posts to main and NEVER writes the DB; only an
unhandled throw out of the watch loop escalates via `onerror`/`close` →
fatalExit. Human windows get useful tab names for free; autopilot's managed
windows (deliberately launched unnamed) finally get labels.

A **twelfth** Worker thread is the tmux window-reaper (epic fn-802): a pure
EXTERNAL ACTUATOR that opens its own read-only connection and drives a
single-flight cycle from BOTH `PRAGMA data_version` pulses (via the shared
`watchLoop`) AND a coarse ~20s periodic tick — the tick is LOAD-BEARING, not
telemetry, because the 60s completion threshold elapsing writes NOTHING to the
DB, so no pulse fires on aging alone and time itself must wake the cycle. Each
cycle loads the SAME `loadReconcileSnapshot` the autopilot reconciler uses
(including the merged recently-done epics read that makes close-row `completed`
verdicts observable), runs `computeReadiness` at unix-seconds now, and selects
the rows passing the FULL predicate: managed session (`autopilot`) AND a
`work`/`close` verb with a `plan_ref` AND `state='stopped'` for over 60s AND a
non-null pane id AND a non-null pid AND a `{tag:"completed"}` verdict looked up
BY VERB (work → `perTask`, close → `perCloseRow` — never both maps, so an
approve row's `perTask` verdict can't leak through). Immediately before each
kill it re-runs the full predicate against a FRESH snapshot and requires the
SAME job to still pass (the CWE-367 TOCTOU mitigation: a resume that flipped the
verdict aborts the kill), then fires `killWindow` on the stable `%N` pane handle
(rename-proof against the concurrent renamer) and stamps an in-memory ~10min
per-job cooldown so a SIGHUP-absorbing process or an already-gone window doesn't
re-spawn tmux every cycle. It writes NOTHING to the DB and posts NOTHING to main
— row terminalization flows through the existing exit-watcher → synthetic
`Killed` mint (pid + start_time match), the SOLE truth of the death; the kill is
never assumed to have sufficed. The cooldown is in-memory only, so a restart
re-derives and re-kills once (an idempotent no-op against a closed window). One
stderr audit line per attempt is the only trace it leaves.

The twelve workers are fully independent; main supervises all twelve
lifecycles but routes none of their traffic, and any worker's `error`
event escalates the whole process to a clean restart — with that single
scoped exception, the recoverable drop signal on the transcript, plan,
usage, and dead-letter watchers, which deliberately does NOT escalate
(a re-scan throw is swallowed, never reaching the restart path).

**`@parcel/watcher` load ordering (as of fn-701).** Five of the workers
(transcript, plan, git, usage, dead-letter) each run their own
`import("@parcel/watcher")`. Spawned back-to-back, their FIRST dlopens of the
native N-API addon race and crash with `symbol 'napi_register_module_v1' not
found` — residual [Bun #15942](https://github.com/oven-sh/bun/issues/15942)
many-worker-spawn fragility (Bun v1.3.5 fixed the original main+worker
double-load case, but the daemon's bun 1.3.14 still crash-looped at boot).
The operational rule: main **pre-warms** the addon with a synchronous
`require("@parcel/watcher")` (`prewarmWatcherAddon` in `src/daemon.ts`) BEFORE
the spawn block, forcing a single serialized first dlopen so the addon is
already registered when each worker imports it. This is dlopen-only — each
worker still owns its own subscription and `napi_env`; pre-warm shares no
watcher. The repro check showed pre-warm ALONE closes the race (no spawn
staggering needed). A genuine permanent load failure (missing `node_modules`,
ABI mismatch) logs a loud boot assertion (bun version + context) and takes the
single recovery path (`fatalExit` → launchd restart) — never a silent loop.

Readiness is a client-side library, not a server-side collection.
`src/readiness.ts` is the shared verdict pipeline consumed both by
`scripts/board.ts` (via the `src/readiness-client.ts` helper, which
subscribes to the three input collections `epics` / `jobs` /
`subagent_invocations` and runs `computeReadiness` per emit) and by the
in-daemon autopilot reconciler worker (which subscribes to the same
collections on its own read-only connection and runs `computeReadiness`
against them on every `data_version` wake). The `scripts/autopilot.ts`
viewer subscribes only to the `dispatch_failures` collection plus the
helper-driven verdict stream to render the `--- failed ---` section;
the dispatch decision itself does NOT run client-side anymore. Each per-collection state carries a stable
constant `subId` (`${idPrefix}-<collection>`) that the helper sends on
every `query` frame and uses to route inbound `patch`/`meta` frames
back to the originating state via a `bySubId` map — collection lookup
is the legacy-server fallback. Freshness is patch-driven: the poll
loop is slow-flight detection only (1 s lifecycle warning, 5 s
reconnect), no steady-poll refetch backstop. A server-side `readiness`
projection (synthetic-event recompute, persisted verdict map, diffed
over the wire like the other collections) is a natural future
extension and intentionally out of scope here — the inputs are already
on the wire, so the helper-in-`src/` design preserves the option
without paying its cost today.

The unified `keeper` CLI is a single dispatcher entrypoint (`cli/keeper.ts`,
the package.json `bin`) that fans into every subcommand — `board`,
`autopilot`, `git`, `usage`, `await` — so all example clients
ship as one binary instead of N standalone scripts.

The sitter scanners (performance, builds, helptailing) — read-only out-of-process observers of `keeper.db` and buildbot state — now live in their own repo at `~/code/sitter`. They import nothing from keeper and observe purely through durable contracts (read-only SQLite at a whitelisted schema version, NDJSON telemetry, their own private state tree). See `~/code/sitter` for the daemon set, its launchd jobs, and its architecture.

**event_blobs read-contract.** The cold-blob compaction relocator (fn-717)
MOVEs an old event's payload out of `events.data` (NULLing the hot column) and
into the `event_blobs` side table, keyed by `event_id`. Relocation is lossless
only because every fold-path read of the blob VALUE resolves it back via
`COALESCE(events.data, event_blobs.data)` over a `LEFT JOIN event_blobs` — so a
from-scratch re-fold of a compacted DB reproduces byte-identical projections.
The contract: **every fold-path read of `events.data` either COALESCEs the
payload column, or documents why it cannot.** The COALESCE wraps the SELECT
projection ONLY, never a WHERE/filter column — the relocator never touches the
indexed scalars folds filter on (`tool_use_id`, `session_id`, `tool_name`,
`hook_event`, generated `bash_mutation_*` columns), and wrapping them would
defeat their indexes. The one documented exception is the tool-mutation
attribution scan in `reducer.ts` (`findExplicitAttributions`), whose
`json_extract` predicate is covered by the `idx_events_tool_attr` /
`idx_event_blobs_tool_attr` expression indexes; it splits into two
index-preserving arms (inline `events.data` SEEK + relocated `event_blobs.data`
join, partitioned by `events.data IS NULL`) that together equal the COALESCE'd
scan without regressing to a full table scan. Both arms are prepared ONCE per
snapshot (the pass-1 hoist) and SEEK per dirty file — bun:sqlite does not cache
`prepare()`, so per-file recompilation was pure overhead. Migration-internal reads
(`migrate()`) and the relocator's own reads (`compaction.ts`) run off the
fold path and are exempt. The authoritative per-site enumeration lives in the
comment above that two-arm scan in `src/reducer.ts`.

For the in-codebase module map, event-sourcing invariants, and the "DO NOT"
list, see [CLAUDE.md](./CLAUDE.md).

## Inspect

```sh
# Recent jobs (state: working|stopped|ended|killed; title_source: NULL=unset, 'spawn'=from --name, 'payload'=from prompt, 'transcript'=from live custom-title; plan_verb / plan_ref derived from a planctl-shaped spawn name at SessionStart, NULL otherwise; config_dir captures CLAUDE_CONFIG_DIR at SessionStart with latest-non-NULL-wins via COALESCE on resume; active_since (v65) is the dash AGENTS recency key, stamped to event.ts on the rising edge into 'working' (NULL on a never-prompted job); last_api_error_(at,kind) and last_input_request_(at,kind) are paired stoppage annotations stamped on ApiError / InputRequest folds; both clear on the next UPS/SessionStart revival OR PreToolUse/PostToolUse tool event (gated on column-is-not-NULL), and that tool-event clear also un-stops a stopped row back to working):
sqlite3 ~/.local/state/keeper/keeper.db \
  'SELECT job_id, state, title, title_source, plan_verb, plan_ref, config_dir, active_since, last_api_error_at, last_api_error_kind, last_input_request_at, last_input_request_kind, last_event_id FROM jobs ORDER BY updated_at DESC LIMIT 10'

# Planctl-spawned jobs only — indexed via the partial `idx_jobs_plan_ref WHERE plan_ref IS NOT NULL` so this lands the index, not a scan:
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT job_id, plan_verb, plan_ref, state, title FROM jobs WHERE plan_verb = 'close' ORDER BY updated_at DESC LIMIT 10"

# All Skill-tool plan:plan invocations across sessions — uses the partial idx_events_skill_name index:
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT session_id, datetime(ts,'unixepoch','localtime'), skill_name FROM events WHERE skill_name LIKE 'plan:%' ORDER BY id DESC LIMIT 20"

# All planctl-CLI invocations across sessions — uses the composite partial idx_events_planctl_session index; the WHERE predicate must match the index predicate syntactically for SQLite to land the index:
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT session_id, datetime(ts,'unixepoch','localtime'), planctl_op, planctl_target FROM events WHERE planctl_op IS NOT NULL ORDER BY id DESC LIMIT 20"

# Every session that has touched a given epic — UNION mirrors the reducer's syncPlanctlLinks cross-session sweep; the left branch uses the partial idx_events_planctl_epic index, the right branch uses the partial idx_events_planctl_target index (SQLite picks ONE index per cross-column OR, so the OR form was rewritten to UNION to reach both):
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT session_id FROM events WHERE planctl_op IS NOT NULL AND planctl_epic_id = 'fn-628-contention-review-tier-2-index-pack' UNION SELECT session_id FROM events WHERE planctl_op IS NOT NULL AND planctl_target = 'fn-628-contention-review-tier-2-index-pack'"

# Recent per-job Task-tool subagent timeline — one row per PreToolUse:Agent paired with its PostToolUse:Agent (and lifecycle Start/Stop), status running|ok|failed|unknown|superseded, duration_ms populated on SubagentStop (NULL on rows never closed — superseded peers + lifecycle-swept unknown orphans):
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT job_id, turn_seq, subagent_type, status, duration_ms, prompt_chars, tool_use_id FROM subagent_invocations ORDER BY job_id ASC, turn_seq ASC LIMIT 20"

# All Task-tool invocations across the event log — uses the partial idx_events_tool_use_id index:
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT COUNT(*) FROM events WHERE tool_use_id IS NOT NULL"

# Jobs that created or refined an epic during a /plan:plan window (creator/refiner classifier output — jobs.epic_links is the per-session fan-out written by syncPlanctlLinks from the deduped UNION of the planctl_op stdout scrape AND the durable Commit-event Planctl-Op/Target/Session-Id trailers, epic fn-695, so an edge survives a stdout pipe that NULLs planctl_op):
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT job_id, plan_verb, plan_ref, epic_links FROM jobs WHERE json_array_length(epic_links) > 0 ORDER BY updated_at DESC LIMIT 10"

# Epics by inbound-link density — every job whose planctl-CLI footprint (stdout scrape ∪ durable commit-trailer facts, epic fn-695) created or refined the epic during a /plan:plan window (epics.job_links is the symmetric per-epic fan-out; as of schema v25 each entry embeds the linked job's title/state/last_api_error_(at,kind)/last_input_request_(at,kind) denormalized off the jobs row at the reducer's write boundary, so renderers + predicates no longer need a live-jobs join):
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT epic_id, epic_number, title, json_array_length(job_links) AS n FROM epics WHERE json_array_length(job_links) > 0 ORDER BY n DESC, sort_path ASC LIMIT 10"
# Unnest job_links to see each link's embedded display payload (schema v25: kind, job_id, title, state, last_api_error_at, last_api_error_kind, last_input_request_at, last_input_request_kind):
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT e.epic_id, json_extract(l.value, '\$.kind') AS kind, json_extract(l.value, '\$.job_id') AS job_id, json_extract(l.value, '\$.title') AS title, json_extract(l.value, '\$.state') AS state, json_extract(l.value, '\$.last_api_error_at') AS last_api_error_at, json_extract(l.value, '\$.last_api_error_kind') AS last_api_error_kind, json_extract(l.value, '\$.last_input_request_at') AS last_input_request_at, json_extract(l.value, '\$.last_input_request_kind') AS last_input_request_kind FROM epics e, json_each(e.job_links) l ORDER BY e.sort_path ASC, kind ASC, job_id ASC LIMIT 20"

# Killed sessions specifically (proven-dead from outside the hook stream — SIGKILL, terminal-pane closure, reboot):
sqlite3 ~/.local/state/keeper/keeper.db \
  'SELECT job_id, state, pid, start_time FROM jobs WHERE state = "killed" ORDER BY updated_at DESC LIMIT 10'

# Plans projection — epics (each embedding its tasks AND its plan/close-verb jobs as JSON arrays) folded from the configured `.planctl` roots. As of schema v29 the natural sort is `sort_path ASC` (matches the `EPICS_DESCRIPTOR` default), which slots closer-created children directly below their parent — an unfiltered query uses idx_epics_sort_path; the default-scope query (`WHERE default_visible = 1`, schema v32) uses the partial composite idx_epics_default_visible:
sqlite3 ~/.local/state/keeper/keeper.db \
  'SELECT epic_id, epic_number, sort_path, created_by_closer_of, title, status, last_validated_at, json_array_length(jobs) AS epic_jobs_n FROM epics ORDER BY sort_path ASC, epic_id ASC LIMIT 10'
# Default-scope epics — what the board sees by default: every open epic. Schema v32 (fn-634, narrowed at v63/fn-756) materializes the predicate `status='open'` as the VIRTUAL generated column `default_visible` and a partial composite index `idx_epics_default_visible ON epics(default_visible, sort_path, epic_id) WHERE default_visible = 1` serves it as a covering SEARCH (no SCAN, no temp B-tree). The literal `= 1` is load-bearing for the partial-index match:
sqlite3 ~/.local/state/keeper/keeper.db \
  'SELECT epic_id, epic_number, sort_path, title, status FROM epics WHERE default_visible = 1 ORDER BY sort_path ASC, epic_id ASC LIMIT 10'
# Tasks live inside epics.tasks now — unnest with json_each to list them per epic. Schema v19 surfaces BOTH the planctl-native runtime status (`runtime_status`: todo|in_progress|done|blocked, ingested from `.planctl/state/tasks/<task_id>.state.json`) AND the derived worker-phase binary (`worker_phase`: open|done, derived from `worker_done_at`) — outer ORDER BY uses the idx_epics_sort_path index:
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT e.epic_id, json_extract(t.value, '\$.task_id') AS task_id, json_extract(t.value, '\$.task_number') AS task_number, json_extract(t.value, '\$.title') AS title, json_extract(t.value, '\$.runtime_status') AS runtime_status, json_extract(t.value, '\$.worker_phase') AS worker_phase FROM epics e, json_each(e.tasks) t ORDER BY e.sort_path ASC, task_number ASC LIMIT 10"
# Work-verb jobs per task — double-unnest epics.tasks then each task's embedded jobs sub-array:
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT e.epic_id, json_extract(t.value, '\$.task_id') AS task_id, json_extract(j.value, '\$.job_id') AS job_id, json_extract(j.value, '\$.state') AS state FROM epics e, json_each(e.tasks) t, json_each(json_extract(t.value, '\$.jobs')) j ORDER BY e.sort_path ASC, task_id ASC LIMIT 10"

# Git projection — one row per watched worktree (membership gate `.planctl present || dirty || ahead of upstream > 0`, recomputed each reconcile, epic fn-690). dirty_files is a JSON array; each entry carries {path, xy, mtime_ms, worktree_oid, worktree_mode, attributions:[{session_id, source, last_mutation_at, last_commit_at}, ...]} (schema v31 file-centric shape — per-(session, file) attribution with source badges tool|bash|inferred|planctl (planctl added in schema v46 / fn-666 — minted by the reducer's planctl_op fold from the envelope's files[] array so .planctl/ JSONs+specs no longer orphan) and commit-discharge timestamps; schema v44/v45 — fn-664 — adds the producer-frozen worktree_oid + worktree_mode so foldCommit can gate discharge on content equality):
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT project_dir, branch, ahead, behind, json_extract(dirty_files, '\$[0]') AS first_dirty FROM git_status LIMIT 5"

# file_attributions — one row per (project_dir, file_path, session_id) carrying the discharge-rule facts (last_mutation_at vs last_commit_at; a row is live-attributed iff last_commit_at IS NULL OR last_commit_at < last_mutation_at) plus the per-file worktree_oid + worktree_mode the v45 content-aware discharge gate reads back at commit time. Indexed for both per-file and per-session scans:
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT project_dir, file_path, session_id, last_mutation_at, last_commit_at, worktree_oid, worktree_mode FROM file_attributions ORDER BY last_mutation_at DESC LIMIT 20"

# Usage projection — one row per agentuse profile observed at ~/.local/state/agentuse/<id>.json (freshness fields are excluded by design — keeper has no freshness signal yet):
sqlite3 ~/.local/state/keeper/keeper.db \
  'SELECT * FROM usage ORDER BY target, id'

# Profiles projection — schema v33 (fn-639). One row per Claude profile directory keyed by config_dir (the CLAUDE_CONFIG_DIR env value captured at SessionStart; the '' sentinel collapses default ~/.claude). Quiet profiles render with NULL last_rate_limit_at; a rate_limit stamps (last_rate_limit_at, last_rate_limit_session_id) keyed on the same COALESCE(config_dir,'') expression as the SessionStart seed so a NULL-config session's rate limit lands on the exact '' row it seeded. v42 (fn-662): the v35 bidirectional fan-out now colocates the '' row's annotation onto usage.default via the shared usageIdForProfileName/profileNameForUsageId mapping in src/epic-deps.ts, so a default-account rate limit renders on `keeper usage`:
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT config_dir, datetime(last_rate_limit_at,'unixepoch','localtime') AS last_rl_at, last_rate_limit_session_id FROM profiles ORDER BY config_dir ASC"

# dead_letters operational sidecar — schema v37 (fn-643). One row per unrecoverable hook INSERT failure imported from ~/.local/state/keeper/dead-letters/<pid>.ndjson. status flips waiting → recovered when the human triggers the replay_dead_letter RPC; recovered rows keep replayed_event_id pointing at the appended real event. NOT a reducer projection — re-folding the event log never touches this table:
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT dl_id, status, datetime(dl_written_at,'unixepoch','localtime') AS written, datetime(recovered_at,'unixepoch','localtime') AS recovered, replayed_event_id FROM dead_letters ORDER BY dl_written_at ASC LIMIT 20"

# Waiting dead-letter count (what board.ts's [dead-letter:N] pill renders):
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT count(*) FROM dead_letters WHERE status = 'waiting'"

# Raw event log tail (synthetic EpicSnapshot/TaskSnapshot/EpicDeleted/TaskDeleted/DispatchFailed/DispatchCleared rows appear here too):
sqlite3 ~/.local/state/keeper/keeper.db \
  'SELECT id, hook_event, session_id FROM events ORDER BY id DESC LIMIT 10'

# How far the reducer has folded:
sqlite3 ~/.local/state/keeper/keeper.db 'SELECT * FROM reducer_state'
```

## Backup & restore

The event log + projections in `keeper.db` are the system's source of truth, so
a corrupt image (the 2026-06-07 `database disk image is malformed` incident on
the now ~2 GB DB) is a catastrophe if it's unrecoverable. Three layers guard it
(epic `fn-746`):

1. **Detect** — a producer-side `PRAGMA quick_check` integrity probe runs every
   15 min on a short-lived read-only connection and pages (Telegram, the
   `Keeper` topic) the moment corruption is structurally detectable
   (`src/integrity-probe.ts`). A healthy probe is silent.
2. **Recover** — a daily verified snapshot via `VACUUM INTO`
   (`src/backup.ts`): the daemon writes a freelist-compacted, standalone copy of
   the live DB to `~/.local/state/keeper/backups/keeper-<YYYYMMDDTHHMMSS>.db`,
   immediately re-opens it read-only and runs the FULL `PRAGMA integrity_check`,
   and only keeps it if it passes — a snapshot that fails verification is
   deleted (restoring a corrupt snapshot would propagate the corruption). The
   newest 3 snapshots are retained; a backup failure pages (recovery degraded).
   `VACUUM INTO` holds only a read transaction on the source, so it never takes
   the writer lock or starves a concurrent hook INSERT — it is safe while the
   daemon is up.

Both the integrity probe and the backup (plus the `fn-753` boot-time catch-up
backup) run on a dedicated **maintenance worker thread** (`src/maintenance-worker.ts`,
epic `fn-765`), NOT on main's fold thread. bun:sqlite is synchronous, so a
`VACUUM INTO` on the ~2 GB DB or a bounded `quick_check` would otherwise stall
main's event loop for its full duration — blocking folds and the events-log
ingest and feeding fold lag. The worker calls the same `backupDb` /
`runIntegrityProbe` bodies against their own short-lived read-only connections
and relays the outcome to main, which keeps the logging + paging side effects.
Compaction stays on main (it writes via the writer connection, the sole-writer
rule).

Take a snapshot by hand at any time (safe while keeperd is running):

```sh
bun scripts/backup-db.ts   # prints the verified snapshot path + restore steps
```

### Restore a snapshot over a corrupt DB

The `VACUUM INTO` snapshot is a fully-defragmented copy, so restoring it doubles
as the offline size reclamation that online `VACUUM` deliberately defers (the
live file stays large after cold-blob compaction). Steps (DB path shown for the
default `~/.local/state/keeper/keeper.db`):

```sh
# 1. Stop the daemon so nothing holds the writer lock or a stale WAL.
launchctl stop <keeperd label>          # or kill the keeperd process

# 2. Move the corrupt live DB aside (keep it for forensics) and drop the stale
#    WAL/SHM sidecars — they belong to the OLD file.
mv ~/.local/state/keeper/keeper.db ~/.local/state/keeper/keeper.db.corrupt-$(date +%Y%m%dT%H%M%S)
rm -f ~/.local/state/keeper/keeper.db-wal ~/.local/state/keeper/keeper.db-shm

# 3. Move the newest verified snapshot into place as the new live DB.
mv ~/.local/state/keeper/backups/keeper-<stamp>.db ~/.local/state/keeper/keeper.db

# 4. Re-verify in place, then restart the daemon (it re-opens WAL on first write).
sqlite3 -readonly ~/.local/state/keeper/keeper.db 'PRAGMA integrity_check;'
launchctl start <keeperd label>
```

Because the entire system folds deterministically from the immutable `events`
table, a restored DB re-derives byte-identical projections; no projection state
is lost that the event log doesn't already carry.
