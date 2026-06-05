# keeper

## What keeper is

Keeper is an event-sourced control-data daemon for Claude Code agents. A small
TypeScript hook plugin writes one row per Claude Code hook invocation into a
SQLite `events` table — the durable, append-only log. A long-running Bun daemon
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
`UserPromptSubmit` / `SessionStart` revival (with `PreToolUse` /
`PostToolUse` gated on the column-is-not-NULL hot-path predicate for
`last_input_request_at`). The `killed` state is the sibling terminal state to
`ended`: reached not from a SessionEnd hook but from synthetic `Killed` events
emitted by the boot seed sweep and the live exit-watcher worker, which prove a
session's `(pid, start_time)` is gone from the OUTSIDE (SIGKILL'd,
terminal-pane-closed, machine reboot, hook crash). Both terminal states are
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
synchronous `process.env` reads (`ZELLIJ` / `ZELLIJ_SESSION_NAME` /
`ZELLIJ_PANE_ID`; no fork, no fs, no PPID-walk), folded onto
`jobs.backend_exec_{type,session_id,pane_id}` latest-non-NULL-wins via
`COALESCE`. Generic `backend_exec_*` naming lets a future
tmux/wezterm backend slot in without a schema change. Consumers can find
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
is `PASSIVE` (writer-skipping), never `TRUNCATE` (writer-blocking), so a
concurrent hook INSERT landing during the bounce window is never starved into
a dead-letter while the checkpoint completes.

Keeper also exposes an **NDJSON-over-UDS subscribe + RPC server** as a second
Worker thread. The read surface is **namespaced by collection**: a client names
a collection in its `query` (sort/limit/offset/filter) and gets back an ordered
page that doubles as a live subscription. Seven collections register today —
`jobs` (the first and default), `epics` (the read-only plans surface — each
epic embeds its tasks as a JSON array, so there is no separate `tasks`
collection; both the epic and each embedded task carry an `approval` field
valued `"approved" | "rejected" | "pending"`, surfaced as a pill in the
epics client), `subagent_invocations` (the per-job timeline of Task-tool
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
the OPERATIONAL sidecar table, one row per unrecoverable hook INSERT failure
imported from the per-pid NDJSON files the hook writes to
`~/.local/state/keeper/dead-letters/` when its bounded retry exhausts;
keyed by `dl_id` and idempotent under re-scan; status flips
`waiting → recovered` only when the human triggers the `replay_dead_letter`
RPC. It is NOT a reducer projection — re-folding the event log never touches
it, because dead letters are the audit log of events that NEVER made it into
the event log to be folded). The
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
resources* through a dedicated writer owned by the server-worker. The three
concrete RPCs are `set_task_approval` and `set_epic_approval` (each writes
the top-level `approval` field on the target `.planctl/{epics,tasks}/<id>.json`
file via atomic temp+rename under a per-file single-flight lock — the change
is observed by `@parcel/watcher` and round-trips through the plan worker as
an `EpicSnapshot` / `TaskSnapshot` event, so the reducer's `epics` projection
and the `events` log keep their canonical-owner writers and re-fold
determinism extends to approval) and `replay_dead_letter` (the scoped
synthetic-event-write recovery verb added by schema v37 / fn-643: the
server-worker bridges the call to main via the in-process message bus,
and main picks the oldest `waiting` row from `dead_letters`, appends a
plain real event with the row's preserved `bindings` + `ts`, and flips
`status` to `recovered` in ONE `BEGIN IMMEDIATE` — the recovered event
then folds through the normal id-ordered drain, and the audit row keeps
its `replayed_event_id` for posterity). RPC handlers MAY write
`.planctl` files and — via the scoped main-bridge — append real events
to the log AND flip the `dead_letters` audit row in one transaction;
never reducer projections directly (see [CLAUDE.md](./CLAUDE.md)'s DO
NOT list). Example clients ship under the unified `keeper` CLI
(`keeper board`, `keeper jobs`, `keeper autopilot`, `keeper git`,
`keeper usage`, `keeper await`, plus the single-shot `keeper approve`
RPC client); see [Example clients](#example-clients) for usage.

## What keeper is NOT

Keeper's read surface is intentionally narrow. Explicit non-goals:

- **No reactor, no general write path into the reducer** — the UDS server's
  QUERY surface is read-only (`query` → `result` + `patch` + `meta`); the
  reducer's `jobs` / `epics` projections and the `events` log have one
  canonical writer each (the hook for hook events; main for synthetic
  events). The socket DOES carry `rpc` frames, but RPC handlers may write
  only the `approval` field on external `.planctl/{epics,tasks}` JSON files
  (via `set_task_approval` / `set_epic_approval`, atomic temp+rename, server-
  worker-owned single-flight) — never the reducer's projections or the
  `events` log. The change round-trips through the plan-worker file watcher,
  so the reducer remains the sole writer of `epics`. Consumers may still
  read any of it directly from SQLite.
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
  `{plan|work|close|approve}::<ref>`). The socket carries plan mutations *scoped to
  the `approval` field only* — the `set_task_approval` / `set_epic_approval`
  RPCs write `approval` on the target `.planctl` file via atomic temp+rename,
  and the plan worker round-trips the change back as a snapshot event. Every
  other field of every `.planctl` file remains read-only end to end, same
  fence as `jobs`.
- **No multi-session-per-job lineage** — v1 holds `job_id === session_id` (one
  session per job).
- **No kernel watchers on keeper's own DB** (`fs.watch` / FSEvents / kqueue) —
  `data_version` polling is the change-detection primitive for keeper's SQLite.
  The watchers keeper does run (`@parcel/watcher`, on the *external* transcript
  tree at the configured `claude_projects_root` and on the configured plan
  `roots`) are the scoped exception: those files are written by another process,
  so the same-process-write blind spot does not apply.
- **No caught-up barrier** and no in-process self-heal — a crash exits non-zero
  and the LaunchAgent restarts the single, well-tested recovery path. The one
  scoped exception is a *recoverable* FSEvents dropped-events signal on the
  external watchers (the producer workers' "...must be re-scanned" error): rather
  than escalate, the affected worker schedules a debounced, single-flight re-scan
  of its existing change-gated boot-scan path, recovering the missed change
  without a restart and without re-subscribing. That is data recovery, not
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
   - `zellij_session` — the zellij session name keeperd's server-side
     autopilot reconciler lazily ensures (and reuses) for every tab it spawns.
     Default: `autopilot`. Each dispatch opens as a new tab inside that shared
     background session.

   ```sh
   mkdir -p ~/.config/keeper
   cat > ~/.config/keeper/config.yaml <<'YAML'
   roots:
     - ~/code
     - ~/src
   claude_projects_root: ~/.claude/projects
   zellij_session: autopilot
   YAML
   ```

   A `~`-prefixed value is expanded to `$HOME`. For `roots`, a non-existent root
   is skipped (the others keep watching); for `claude_projects_root` a not-yet-
   existing path is returned as-is (the worker tolerates a late-appearing tree).
   All keys fall back independently — a missing/malformed one never disturbs
   the others; a missing or malformed config falls back to every default
   (`roots: [~/code]`, `claude_projects_root: ~/.claude/projects`,
   `zellij_session: autopilot`). Unknown keys are silently ignored — a legacy
   `exec_backend: ghostty` carried over from a pre-fn-654 config has no effect.

   (The legacy `KEEPER_WATCH_ROOT` env var is retired; if still set, the daemon
   logs a one-line deprecation warning and ignores it.)

4. **Load the keeper plugin via the arthack launcher** (`--plugin-dir`). The
   repo root carries `.claude-plugin/plugin.json` (canonical manifest) and
   `hooks/hooks.json` (events-writer command paths). The arthack launcher
   appends `--plugin-dir ~/code/keeper` for every profile, so a fresh
   session auto-loads the hook (and any future `skills/`) from this repo.
   No symlink step.

   **Migration from the retired `~/.claude/plugins/keeper` symlink:** if
   you have one from a prior install, REMOVE IT before the next session —
   otherwise the launcher load and the symlink double-register the hook
   and every invocation writes two `events` rows. There is no runtime
   dedup guard (keeper's "no in-process self-heal" stance).

   ```sh
   rm -f ~/.claude/plugins/keeper
   ```

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

   **The daemon must boot at least once before the hook can write events.**
   The hook opens its sqlite connection with `{ migrate: false }` — the
   daemon is the sole migrator (see CLAUDE.md "Migrations are forward-only").
   On a fresh install the LaunchAgent runs the daemon at login, which creates
   the DB and runs `migrate()` to converge the schema; only after that does
   the hook have tables to INSERT into. Two failure modes, two outcomes:

   1. **No `events` table at all** (fresh install, pre-daemon-boot, or a
      corrupt DB). The hook's `PRAGMA table_info('events')` probe returns
      empty, the INSERT cannot run, the hook writes a per-pid NDJSON
      dead-letter file (recoverable via `replay_dead_letter`), logs to
      stderr, and exits 0 — the event is captured for replay but the
      session is not blocked. The manual recovery is `launchctl bootstrap`
      above; subsequent sessions write normally.
   2. **`events` table behind by a column** (the daemon hasn't yet applied
      a fresh `ALTER TABLE` from the latest commit). The hook intersects
      its known column set with the live one and INSERTs a narrowed shape
      via `$col` named bindings — the not-yet-migrated column is simply
      omitted and lands NULL after the daemon next runs `migrate()`,
      identical to the deriver's zero-event value. The hook writes a
      stderr line naming the dropped columns for observability but the
      row LANDS — no dead-letter. fn-669 added this; before it, a
      schema-bump deploy race total-dropped every hook INSERT in the
      window between the hook's new code and keeperd's next restart.

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

8. **Verify** the agent is loaded and the projection is live:

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
   diagnostic feeds clean. The restore worker (epic fn-677, two-tier
   rework fn-702) writes `~/.local/state/keeper/restore.json` (the
   Chrome-style "restore previous session" snapshot — agents + zellij
   metadata for `scripts/restore-agents.ts` to replay against) as a
   **two-tier descriptor** `{schema_version: 2, last_session, current}`:
   `current` is the continuous live mirror (may be empty — the fn-689
   empty-skip floor is retired), and `last_session` is the FROZEN restore
   source written only at boot-promote and the `>0→0` collapse edge, so a
   reboot that reseeds a smaller set still offers the full pre-crash set
   from `last_session`. Overridable via `KEEPER_RESTORE_FILE` for tests. Set
   `KEEPER_TRACE_SERVER=1` to enable verbose server-worker diagnostic logging
   — `[srv-ts]` stage timings, frame byte counts, connection lifecycle — on
   `server.stderr`; off by default (the rare `[server-worker]` error class is
   always logged). The plist's `EnvironmentVariables` block carries
   `KEEPER_TRACE_SERVER=0`; flip to `1` then
   `launchctl kickstart -k gui/$UID/arthack.keeperd` to enable.

   Example clients ship under the unified `keeper` CLI — `keeper board` /
   `keeper jobs` / `keeper autopilot` / `keeper git` / `keeper usage`
   (subscribe; the readiness clients go through
   `src/readiness-client.ts`) and `keeper approve` (RPC) — see
   [Example clients](#example-clients).

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
`git-clean`, other agents going `agents-idle`, or any AND-combination
like `keeper await git-clean and agents-idle`); `keeper approve` is the
RPC client (single-shot `rpc` →
`rpc_result`, no subscription). The
subscribe clients share helpers in `src/readiness-client.ts` —
`subscribeReadiness` owns the three-collection lifecycle (board +
autopilot) and `subscribeCollection` owns the single-collection
lifecycle (git, usage); both feed `computeReadiness` / row-list
callbacks (the pure verdict pipeline lives in `src/readiness.ts` as
library code, not a runnable script). The subscribe clients render an
alt-screen TUI when stdout AND stdin are both TTYs, with per-frame
state/diff sidecars and keyboard navigation (←/h/k prev frame, →/l/j
next, g oldest, G/End/Esc return to live, q/Ctrl-C quit) — when stdout
or stdin isn't a TTY (piped, redirected, or under CI) the TUI gate
collapses to plain stream output. Run any of them with
`keeper <subcommand> --help`, or `keeper` for top-level help.

- `board.ts` — epics-only "board" UI over the `epics`,
  `subagent_invocations`, and `jobs` collections (the latter as a
  passive feed for the per-task / per-link rendering nested inside each
  epic block). Subscribes through the shared `subscribeReadiness`
  helper and emits one epics-only frame per change, led by `---`. Uses
  server-default scope: epics are scoped via the descriptor's
  `defaultClause` — schema v32 (fn-634) materializes the predicate
  "open OR not-yet-approved" as the VIRTUAL generated column
  `default_visible` and serves it from the partial index
  `idx_epics_default_visible WHERE default_visible = 1` as a covering
  SEARCH — `subagent_invocations` full per-job timeline, `jobs` live
  only (`working + stopped`). The flat bottom jobs list and the
  `[dead-letter:N]` banner (with the `r` replay-dead-letter key) moved
  to `keeper jobs` in fn-658 — see the `jobs.ts` bullet below. Both the
  board and `keeper jobs` follow the OMIT-DEFAULT pill convention
  (fn-708): a pill renders only at its non-resting value, so the
  ABSENCE of a pill encodes the field's one default — `no [approval]`
  ⇒ `pending`, `no runtime pill` ⇒ `todo`, `no [worker-done]` ⇒ `open`,
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
  (with omit-default `[<runtime>]? [worker-done]? [<approval>]?
  [ready|completed|blocked:<reason>]` pills — the three native fields
  consolidated per fn-708: the planctl runtime enum elides its `todo`
  default, renders `in_progress` / `done` verbatim, and relabels
  `blocked` → `[rt:blocked]` so it never collides with the verdict
  `[blocked:*]` family; the derived worker-phase binary never renders
  `open` and surfaces its `done` survivor as the LABELED `[worker-done]`
  (never bare `[done]`, and only when the verdict doesn't already pin it
  — i.e. not `completed`/`job-pending`/`git-uncommitted`/`git-orphans`);
  and approval elides `pending`, dropping `[rejected]`/`[approved]`
  when the adjacent verdict already names it (`blocked:job-rejected` /
  `completed`)) and a final "Quality audit and close" line for the epic
  itself (its `[status]` pill is dropped — the board filter pins it to
  `open` — and its approval follows the same omit-default + verdict-aware
  suppression, so the close row usually collapses to just the title plus
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
  but its close verdict isn't `completed`) and `dep-on-epic-dangling
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
  former resting defaults `pending` / `todo` / `unvalidated` / `open`
  no longer render at all under fn-708's omit-default rule, so they need
  no colorizer carve-out).
  The byte-compare emit gate keeps the stream quiet when row churn
  doesn't surface in the render. Reconnects across keeperd restarts;
  Ctrl-C unsubscribes cleanly. Every emitted frame is mirrored to three
  per-pid `/tmp` sidecar files (epics JSON state, frame text, unified
  diff vs. the previous emit); when stdout/stdin are both TTYs the
  client enters a real TUI (alt-screen + ring-buffered frame history
  with keyboard navigation) AND indexes the sidecars so past frames
  remain inspectable. The keymap is `←/h/k` previous frame, `→/l/j`
  next, `g` jump to oldest, `G`/`End`/`Esc` snap to live, `c` copies
  the current frame + sidecar paths to the clipboard, `q`/`Ctrl-C`
  quit; under non-TTY (piped, redirected, CI) the TUI gate collapses
  to plain stream output.

  ```sh
  keeper board            # epics-only board, default scope
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
  never a placeholder). The dead `backend_exec_tab_{id,name}` columns
  that once fed a `<tab>` slot were dropped in fn-710 (T2). When the row is
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
  and never crashes the render. Same sidecar / TUI / non-TTY
  contract as board.

  ```sh
  keeper jobs             # live jobs list, default scope
  ```

- `autopilot.ts` — thin viewer + control surface over the server-side
  autopilot reconciler (the autopilot worker thread inside keeperd; see
  `## Architecture`). All dispatch decision, launch, confirmation, dedup,
  and (config-gated) reap live in the daemon; the CLI carries no dispatch
  logic of its own. It subscribes through `src/readiness-client.ts` and the
  `dispatch_failures` collection, renders a three-section frame
  (`--- current ---` from `jobs` correlated by `plan_verb`+`plan_ref`,
  `--- predicted ---` from `computeReadiness`, `--- failed ---` from the
  `dispatch_failures` projection) plus a paused/playing banner, and
  exposes three control RPCs:

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

  Alt-screen TUI when stdout is a TTY; keymap `←/h/k` / `→/l/j` / `g` /
  `G/Esc` / `space` pause / `c` copy / `q` quit. SIGINT tears down the
  renderer (alt-screen exit, raw mode off) then disposes the subscribe
  helper.

  ```sh
  keeper autopilot                       # viewer: current / predicted / failed + paused state
  keeper autopilot play                  # un-pause the reconciler
  keeper autopilot pause                 # pause the reconciler (default at boot)
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
  `planctl scaffold/done/approve/...`); a single file can carry multiple
  attribution rows when several live sessions edited it without an
  intervening commit, and the strict `orphan_files` bucket is rendered
  as a separate trailing block for dirty files with zero attribution). Uses `subscribeCollection` from `src/readiness-client.ts`
  (the same lifecycle primitive that powers the readiness clients,
  scoped to one collection). Each frame is led by `---`; one block per
  non-empty worktree row, all-zero rows dropped. Same three per-pid
  `/tmp` sidecar files (JSON state, frame text, unified diff vs.
  previous) + alt-screen TUI when stdout/stdin are both TTYs (ring-
  buffered frame history, keymap `←/h/k`/`→/l/j`/`g`/`G`/`Esc`/`q`;
  under non-TTY the TUI gate collapses to plain stream output).
  `--project-dir <path>` filters to one worktree root. SIGINT tears
  down the renderer (alt-screen exit, raw mode off) then disposes the
  subscribe helper and exits 0.

  ```sh
  keeper git                          # all worktrees
  keeper git --project-dir /path/to   # one worktree only
  ```

- `usage.ts` — single-collection subscribe client (schema v35 / fn-642
  colocated the rate-limit annotation onto the `usage` row, dropping the
  prior dual-collection `usage` + `profiles` split). One
  `subscribeCollection` call over the `usage` collection (one row per
  agentuse profile observed at `~/.local/state/agentuse/<id>.json`:
  target, multiplier, session+week percent + reset timestamps, plus the
  schema-v35 colocated `last_rate_limit_at` +
  `last_rate_limit_session_id` and the schema-v41 `rate_limit_lifts_at` +
  `last_usage_fold_at`). Each row's stack carries the colocated
  rate-limit line when set — as of schema v41 (fn-651) that line is a
  forward-looking lift countdown (`rate-limited for <rel>` when the
  lift instant is known and still in the future, `rate-limited n/a`
  when it is absent or already past — never a "<rel> ago" countdown
  and never a fallback to the fired-time). A v41 `stale Nm` line also
  surfaces under any row whose `last_usage_fold_at` is older than the
  renderer's `STALENESS_THRESHOLD_MS` cutoff (currently ~15m) —
  driven only off that stamp, never `updated_at` (a rate-limit fold
  bumps that) and never agentuse's own `status` (which tracks its
  scrape failures rather than keeper's ingestion health) — so a wedged
  usage worker becomes visible instead of silently frozen. Untracked
  profiles (rate-limited but with no agentuse usage row) do not render.
  Per-frame sidecars
  (`/tmp/keeper-usage.<pid>.{state,frame,diff}.<n>.*`, indexed via a meta
  sidecar) carry the row set so the JSON sidecar captures the full input
  to the rendered frame. SIGINT disposes the subscription handle and
  prints sidecar paths on exit.

  ```sh
  keeper usage                # all profiles
  keeper usage --sock /tmp/x  # socket override
  ```

- `await.ts` — the blocking wait-for-condition client (fn-647; conditions
  + AND grammar widened in fn-713). Non-TUI: emits a Monitor-shaped event
  stream on stdout — exactly one `[keeper-await] armed …` line after the
  on-board check, then exactly one terminal `[keeper-await] met …` or
  `[keeper-await] failed …` line — and exits when its condition holds.
  Four conditions: `complete <id>` (epic/task pops off the board) and
  `unblocked <id>` (workable now) are planctl-id forms auto-detecting
  epic vs task by the `.N` suffix; `git-clean` blocks until the cwd's git
  root has `dirty_count=0 AND orphaned_count=0` (no `git_status` row for
  the root counts as clean); `agents-idle` blocks until no OTHER session
  (`job_id != CLAUDE_CODE_SESSION_ID`) with `state=working` has a cwd
  inside the cwd's git root. `git-clean` / `agents-idle` take no id and
  are project-scoped to the cwd's repo. Multiple conditions joined by the
  literal `and` token block until ALL hold simultaneously (level-
  triggered, glitch-free); only the subscriptions a condition needs are
  opened. "unblocked" deliberately excludes autopilot's
  `single-task-per-epic` / `single-task-per-root` concurrency mutexes
  (every other blocker still blocks). Exit codes: 0 met, 1
  not-found/usage/connection/`no-git-root`, 3 timeout (SIGTERM), 4
  deleted, 5 stuck (only under `--fail-on-stuck`).

  ```sh
  keeper await complete fn-646-keeper-cli-opentui-port.1   # task done
  keeper await git-clean                                   # repo clean
  keeper await git-clean and agents-idle                   # both, ANDed
  ```

- `approve.ts` — the RPC client. Single-shot: opens a `Bun.connect`, sends
  one `rpc` frame for `set_task_approval` or `set_epic_approval`, awaits the
  `rpc_result` (or `error`), and exits. No subscription, no reconnect loop.
  Approval is a first-class planctl field, so the three valid values are
  `approved`, `rejected`, and `pending` — there is no `clear` (set to
  `pending` instead). The CLI infers epic vs. task from the id's shape
  (trailing `.N` marks a task).

  ```sh
  keeper approve <epic_id>                   # approved (default)
  keeper approve <epic_id> pending           # reset to pending
  keeper approve <epic_id>.<task_n> rejected # reject one task
  ```

The next four subcommands are keeper's git-coordination verbs (epic
fn-715, the native TypeScript port of the retired Python `jobctl`). Unlike
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

- `find-task-commit.ts` — emit the commit(s) carrying a matching
  `Task: <id>` trailer as a pretty JSON envelope (planctl consumes this as a
  fail-loud contract). Pre-filters with `git log --grep -F`, then confirms a
  real trailer via `git interpret-trailers`. Repo scope derives from the
  epic's `touched_repos` (or `--repos` override), defaulting to the cwd repo.

  ```sh
  keeper find-task-commit fn-700-foo.1        # pretty {success, commits:[...]}
  ```

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

## Uninstall

Reverse of install:

```sh
launchctl bootout gui/$(id -u)/arthack.keeperd
rm ~/Library/LaunchAgents/arthack.keeperd.plist
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
un-memoized `runQuery` + `encodeFrame` path.

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
arms do the projection work.

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
dispatch gates) cannot observe it. Critically, the gate lives at the
**producer**, not the reducer: re-fold determinism is non-negotiable
(the reducer must never read git / fs / wallclock), so the predicate
fires once at fold-time on the producer side, never inside the
`BEGIN IMMEDIATE` transaction. A `git commit` does not change the file's
worktree bytes so FSEvents will not re-fire on commit; the `pending` set is
drained by the same gated `recheckPending()` from FOUR triggers. As of fn-705
the plan producer is realtime end to end, mirroring the eighth-worker
(autopilot) model: it polls `PRAGMA data_version` on its own read-only
connection (`PLAN_DB_POLL_MS`, 100ms — the cadence the sibling producers
share) so every keeper DB write, the close→approve fold included, drives a
single-flight gated rescan that drains `pending` + re-ingests changed
`.planctl` files in ~50ms — the realtime complement to the best-effort
FSEvents subscription, closing the up-to-60s fold lag the heartbeat used to
impose. It ALSO watches each watched repo's `.git/logs/HEAD` reflog with
`@parcel/watcher` (a commit always appends there) to close the
brand-new/never-seen-repo tail, where the in-HEAD transition fires no DB
write and no `recheck-pending` post — the worker reconciles those external
reflog watches against its live `pending` repo set. The two remaining drain
triggers are main's `recheck-pending` post on every `GitSnapshot` / `Commit`
it writes, and the heartbeat — DEMOTED from a 60s latency floor to a 5s
should-never-fire paranoia backstop (`RECONCILE_HEARTBEAT_MS`); a
`"heartbeat"`-tagged backstop emit is now a loud ALARM that every fast path
missed a change (or a `.planctl` file is genuinely abandoned-uncommitted),
never normal operation. The poll is a TRIGGER only — it never writes the DB
nor drives a synthetic event from anything but a parsed `.planctl` file, so
re-fold determinism is intact. Every drain trigger re-runs the in-HEAD probe
and a still-uncommitted path stays in `pending` (no fn-627 regression — the
fn-629 gate is preserved exactly, only the realtime drain triggers are new).
A freshly-committed path emits its snapshot and leaves the set, with no
permanent strand. The gate trusts planctl's commit-at-the-seam contract
(`~/code/planctl/docs/reference/commit-at-mutation-boundary.md` §3): every
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
`plan_ref` substrate; an `EpicSnapshot` carve-out preserves them across an
approval-RPC round-trip (alongside `tasks` / `jobs` / `job_links`). The
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
(`scaffold` / `done` / `approve` / …) as `op`. The
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
`syncPlanctlLinks(committer_session_id, …)`. `foldCommit` never writes
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
the fn-679 bound collapses the ITERATED set from the entire
undischarged set under `project_dir` (dominated by non-discharging
planctl attributions, 288 in production) to the same event-relevant
union — pulling 4-7s GitSnapshot folds well under the 1.5s hook
budget. Re-fold determinism is preserved: both the persisted set and
the bound read only event-derived state (this snapshot's
`dirty_files`, `file_attributions` populated by passes 1-3, and the
prior `git_status.jobs` blob). Per-job project-wide counters
(`git_orphan_count` / `git_unattributed_to_live_count`) broadcast onto
the bounded set only — informational-only columns (readiness reads
`git_status` scalars + per-file `dirty_files[].attributions[]`, not
the per-job columns), so the narrowed broadcast is a cosmetic shrink.
`GitRootDropped` retracts symmetrically. As of
schema v32 (fn-634), `epics` adds `default_visible` as a VIRTUAL
generated column SQLite computes from
`CASE WHEN status='open' OR approval!='approved' THEN 1 ELSE 0 END`,
materializing the descriptor's cross-column default scope as a single
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
scratch. End-to-end: completing (done+approved) an upstream re-stamps
every downstream consumer's entries to `satisfied` in the SAME fold,
and a bare-id ambiguity disambiguates as soon as a new same-number
epic lands. The readiness/board READ surface is fully projection-driven
— predicate 9 in `src/readiness.ts` and the board summary pill in
`scripts/board.ts` consume `epic.resolved_epic_deps` directly (the
prior fn-637 stopgap that streamed completed (done+approved) epics over
a resolver-only subscription so the live readiness pass could see them
is gone — `subscribeReadiness` is back to four collections, predicate 9
no longer calls `resolveEpicDep`, and the `BlockReason` surface
autopilot consumes — `dep-on-epic` with `cross_project`,
`dep-on-epic-dangling` — is byte-for-byte preserved off the projection
shape). The `EpicSnapshot` ON CONFLICT carve-out widens to include
`resolved_epic_deps` alongside `tasks` / `jobs` / `job_links` /
`created_by_closer_of` / `sort_path` / `queue_jump` so a file-content
re-observation (e.g. an approval-RPC round-trip) can't wipe the
projection-derived dep resolution.
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
`events` row and (folded onto) the `jobs` projection. The hook reads
three pure synchronous `process.env` values on EVERY event —
`ZELLIJ` → `backend_exec_type` (currently the only recognized backend),
`ZELLIJ_SESSION_NAME` → `backend_exec_session_id`,
`ZELLIJ_PANE_ID` → `backend_exec_pane_id` (raw, e.g. `"11"`; no
fork, no fs, no PPID-walk; absent env ⇒ NULL coords, never bogus
`type='zellij'`) — and the reducer's `applyEvent` arm folds the three
onto `jobs.backend_exec_{type,session_id,pane_id}` latest-non-NULL-wins
via `COALESCE`, so a re-fold from cursor=0 reproduces byte-identical
rows. Generic `backend_exec_*` naming lets a
future tmux/wezterm backend slot in without a schema change — only the
hook's env-name table changes. The three live `jobs.backend_exec_*` columns
(`type`, `session_id`, `pane_id`) are display-only on
`JOBS_DESCRIPTOR` (like `profile_name` — read by the renderer, never
a `sortable` / `filters` / `jsonColumns` key); the shared
`projectJobRow` + `renderJobsBody` helpers append an optional trailing
`[p<pane>]` pane pill, gracefully showing nothing when the pane is
absent. The pill surfaces identically on `keeper jobs` (CLI list mode)
and the TUI (the view-shell's shared `renderBody` callback). Two further
`jobs.backend_exec_tab_{id,name}` columns once carried a daemon-resolved
`<tab>` slot; that feed was retired and the columns dropped in fn-710
(schema v55), leaving only the three hook-fed coords above.
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
dead per the CLAUDE.md "snapshot paradox" — a dead monitor must never
linger), and SessionEnd / Killed clear the column to `'[]'` as part of the
terminal write. A from-scratch cursor=0 re-fold reproduces the column
byte-identically. The expanded `keeper jobs` row renders the live set as
a two-line per-entry block inside the same collapse-controlled region as
the backend-coords pill and sub-agent lines (wire order: backend pill →
monitors → sub-agents): a primary `[<kind>] <description-or-id>` line plus,
when the entry has a command, an indented continuation line carrying the
command's first non-empty line. keeper-py's `SUPPORTED_SCHEMA_VERSIONS`
frozenset gains `51` (whitelist-only; keeper-py reads neither
`jobs.monitors` nor `background_tasks`).
As of schema v50 (fn-678), the new `pending_dispatches` projection table
(keyed by `(verb, id)`) is the durable launch-window occupancy signal that
replaced the fn-674 live zellij tab-name probe. A `Dispatched` synthetic
event UPSERTs a row (`dir`, `dispatched_at`, `last_event_id`); a
`SessionStart` fold DELETEs by the same key (discharge-on-bind); a
`DispatchExpired` synthetic event DELETEs the key when the TTL sweep fires.
`DispatchFailed` also DELETEs the pending row so a failed dispatch does not
block the failure as permanently occupied. A from-scratch re-fold reproduces
the table byte-identically (no fold-time wall clock; `dispatched_at` derives
from the event's own `ts`; no `Dispatched` events in the pre-v50 log →
empty table on historical replay). keeper-py's `SUPPORTED_SCHEMA_VERSIONS`
frozenset gains `50` (whitelist-only).
As of schema v42 (fn-661), the new `dispatch_failures` projection table
(keyed by `(verb, ref)` — the same `verb::id` correlation key the autopilot
reconciler uses to dedup against `jobs`) carries the sticky failure record
for the server-side reconciler. It is folded purely from the event log: a
`DispatchFailed` synthetic event UPSERTs a row (`failed_at`, `reason`,
`source` — `launch` / `confirm_timeout` / `precheck`); a `DispatchCleared`
synthetic event DELETEs by the same key. No auto-retry; the only way to
clear a row is the `retry_dispatch` RPC (human-driven), which routes through
the server-worker → main → `DispatchCleared` mint. A from-scratch re-fold
reproduces the table byte-identically (no fold-time wall clock; the event's
own `ts` lands in `failed_at`). The pre-fn-661 standalone `keeper autopilot`
loop (with `isLiveSessionInRoot` / `zellij query-tab-names` dedup) is
retired; the CLI collapses to a thin viewer + the `play` / `pause` / `retry`
controls. keeper-py's `SUPPORTED_SCHEMA_VERSIONS` frozenset gains `42`
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
percentage path owns them outright. The renderer compares
`last_usage_fold_at` against the wall clock to surface a staleness
warning when ingestion has wedged, and renders the rate-limit line as
a "rate-limited for `<rel>`" countdown off `rate_limit_lifts_at`
(`n/a` when absent or already in the past — never a confusing
"`<rel>` ago" countdown).
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
two pairs are stamped together on `ApiError` / `InputRequest` folds
and cleared on the next `UserPromptSubmit` / `SessionStart` revival
(`PreToolUse` / `PostToolUse` also clear `last_input_request_*`,
gated on the column-is-not-NULL hot-path predicate — these arms fire
50+ times per turn so the gate keeps the UPDATE cold when nothing is
awaiting). Each epic also embeds its plan/close/approve-verb (epic-form)
jobs as a `jobs` JSON array, and each task element embeds its own
work/approve-verb (task-form) jobs as a nested `jobs` sub-array — fanned in
from the reducer's jobs-side writes whenever a SessionStart spawn name
parses as `{plan|work|close|approve}::<ref>`
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
codebase; refiner = any other epic-touching mutation inside a window).
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
read-only / write-free, feeding the log only via main. Both producers also
self-recover from a *dropped-events* FSEvents overrun: on the recoverable
"...must be re-scanned" watcher error they schedule a debounced, single-flight
re-scan of their existing change-gated boot-scan path (per affected root for the
plan worker), recovering the missed change in-process without a daemon restart
and without re-subscribing.

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
matches the persisted row, then turns the exit into a synthetic `Killed`
events row and pumps a wake; the reducer folds it to the `killed` state.
This is the live-side counterpart to the boot-time seed sweep that runs
between `migrate → drainToCompletion` and worker spawn: the sweep covers
downtime (zombie rows already on disk), the exit-watcher covers steady state
(processes that die while the daemon is up). It is the third producer-worker
instance — read-only / write-free, feeding the log only via main — and its
kqueue/pidfd fd is owned by the worker thread, released in its own shutdown
handler.

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
`pending_dispatches` projection (schema v50, fn-678): before calling
`launch()`, `confirmRunning` mints a `Dispatched` synthetic event (outbox
ordering — intent before side-effect); the reducer folds it into a
`pending_dispatches` row keyed `(verb, id)`; `loadReconcileSnapshot` reads
the table each cycle and populates `liveTabKeys: Set<DispatchKey>`; a fifth
suppression arm fires when `liveTabKeys.has(key)` is true, sitting alongside
the `isOccupyingJob` arm. `reconcile()` stays pure — it reads the synchronous
Set, never the backend, so re-fold determinism is preserved. The row
discharges when `SessionStart` folds (reducer DELETE) or via a producer-side
TTL sweep on the 60s heartbeat (120s ceiling, `DispatchExpired`) — closing
the launch → SessionStart blind window without any live zellij probe (the
`verb::id` tab name is now a cosmetic label only). The reconciler boots PAUSED (the in-memory
worker gate is seeded `true` from `workerData.paused`, and the daemon's
boot drain unconditionally appends an `AutopilotPaused{paused:true}`
synthetic event so the durable `autopilot_state` singleton projection
also boots paused — schema v47 / fn-667; safe-by-default after restart
is maintained by the boot-append re-arm event, not by flag volatility)
and flips on the `set_autopilot_paused` RPC, which appends an
`AutopilotPaused{paused}` event FIRST then flips the worker gate only
on a successful insert (so the gate and the projection cannot diverge
on partial failure). The terminal-surface mechanics live behind the
`ExecBackend` (`src/exec-backend.ts`) — two ops: `launch` and
`focusPane`. `ensureLaunched` (session-agnostic) get-or-creates the
target session with its own per-call mint + orphan reap and launches an
unnamed tab — `restore-agents.ts` is the consumer. Zellij is the only
backend; each reconciler dispatch opens as a new tab in the
lazily-created `zellij_session`. The session is FRESH-MINTED on every
keeper-initiated `attach -b --forget` (fn-675) — `--forget` deletes any
saved/serialized session before connecting, so a stale/EXITED corpse is
rebuilt from scratch rather than resurrected from a degraded
`session-layout.kdl` cache (the bar-less-mint failure mode that motivated
the change). `--forget` is a harmless no-op when no saved session exists,
and `ensureSession` short-circuits before the attach when the target is
already LIVE — so it never runs against a live session. Launch failure or a bounded single-attempt
confirm timeout posts a `DispatchFailedMessage` to main; main — again the
sole writer — turns it into a synthetic `DispatchFailed` events row and pumps
a wake, and the reducer folds it into the new `dispatch_failures` projection.
There is NO auto-retry — a failed dispatch is sticky and visible in `keeper
autopilot`'s `--- failed ---` section until the human runs `keeper autopilot
retry <verb::id>`, which routes through the server-worker's `retry_dispatch`
RPC → main → a synthetic `DispatchCleared` events row → the reducer DELETEs
the matching `dispatch_failures` row on the next drain. The only durable
autopilot-owned state is the event-sourced `dispatch_failures` and
`pending_dispatches` projections; a from-scratch re-fold reproduces both
byte-identically.

A **ninth** Worker thread is the restore-snapshot worker (epic fn-677,
two-tier rework fn-702): a pure CONSUMER that opens its own read-only
connection, polls `PRAGMA data_version` via the shared `watchLoop`
primitive, and on every change reads the `jobs` + `epics` projections
through the same `runQuery` read seam the autopilot worker uses. It builds
a stable `{captured_at, sessions}` TIER of the live (`working` / `stopped`)
jobs grouped by zellij `backend_exec_session_id` and rewrites
`~/.local/state/keeper/restore.json` via `atomicWriteFile` as a **two-tier
descriptor** — `{schema_version: 2, last_session, current}`, the browser
"restore previous session" model (Chrome "Current Session" / "Last
Session"):

- **`current`** — the continuous live mirror. Rewritten on every content
  change (MAY be empty: the fn-689 last-non-empty empty-skip floor is
  RETIRED). NOT the restore source.
- **`last_session`** — the FROZEN restore source, written ONLY at two
  discrete seams. (1) **Boot-promote:** the first pulse reads the persisted
  FILE — not the seed-swept `jobs` table, which `seedKilledSweep` has
  already emptied by the time the worker spawns, so the file is the only
  pre-crash evidence — and lifts its populated tier forward by precedence
  `current ‖ last_session ‖` (v1) legacy top-level `sessions`. (2) **The
  `>0→0` collapse edge:** when the live set drains to empty, the worker
  freezes the high-water peak (the full pre-collapse count tracked since
  the set was last empty, NOT the last survivor) into `last_session`; the
  epoch resets only on a successful write, so a freeze-write failure
  retries on the next empty pulse. A partial collapse (survivors remain,
  never reaching 0) freezes nothing by design — it relies on the next
  boot-promote to capture the survivors.

The write gate hashes the WHOLE two-tier file (excluding each tier's
`captured_at` so an informational timestamp doesn't churn the hash), so a
`last_session` freeze forces a write even when `current` is byte-stable.
This fixes the observed 8→2 reboot incident: a reboot that reseeds a
smaller live set still offers the full pre-crash set from the frozen
`last_session`. The file is a derived side-file — NOT a projection, NOT in
the event log — so the worker sidesteps the event-sourcing invariants
entirely (no DB `SCHEMA_VERSION` bump, no reducer arm, no `keeper/api.py`
whitelist change; only the side-file's own `RESTORE_SCHEMA_VERSION` bumps
1→2). The worker carries no `onmessage` handler — it never posts to main,
never writes the DB. Write failures are swallowed to stderr (next pulse
retries); only an unhandled throw out of the watch loop escalates to
`onerror`/`close` → fatalExit. The `scripts/restore-agents.ts` util is the
sole reader; it resolves the restore source `last_session ‖ current ‖`
(v1) legacy `sessions`, and its `--apply` mode relaunches the surviving
agents via the exact `claude --resume` shape `scripts/resume.ts` emits,
deduplicated against jobs still live in the projection. The schema bump is
the load-bearing coupling: the moment the worker writes
`schema_version: 2`, the OLD reader treats it as "future" and refuses, so
the v2 writer and v2 reader ship in the same commit.

The ten workers are fully independent; main supervises all ten
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
helper-driven verdict stream to render the `--- predicted ---` /
`--- failed ---` sections; the dispatch decision itself does NOT run
client-side anymore. Each per-collection state carries a stable
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
`autopilot`, `git`, `usage`, `await`, `approve` — so all example clients
ship as one binary instead of N standalone scripts.

For the in-codebase module map, event-sourcing invariants, and the "DO NOT"
list, see [CLAUDE.md](./CLAUDE.md).

## Inspect

```sh
# Recent jobs (state: working|stopped|ended|killed; title_source: NULL=unset, 'spawn'=from --name, 'payload'=from prompt, 'transcript'=from live custom-title; plan_verb / plan_ref derived from a planctl-shaped spawn name at SessionStart, NULL otherwise; config_dir captures CLAUDE_CONFIG_DIR at SessionStart with latest-non-NULL-wins via COALESCE on resume; last_api_error_(at,kind) and last_input_request_(at,kind) are paired stoppage annotations stamped together on ApiError / InputRequest folds and cleared on the next UPS/SessionStart revival — last_input_request_* also clear on PreToolUse/PostToolUse, gated):
sqlite3 ~/.local/state/keeper/keeper.db \
  'SELECT job_id, state, title, title_source, plan_verb, plan_ref, config_dir, last_api_error_at, last_api_error_kind, last_input_request_at, last_input_request_kind, last_event_id FROM jobs ORDER BY updated_at DESC LIMIT 10'

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
# Default-scope epics — what the board sees by default: every open OR not-yet-approved epic. Schema v32 (fn-634) materializes the predicate as the VIRTUAL generated column `default_visible` and a partial composite index `idx_epics_default_visible ON epics(default_visible, sort_path, epic_id) WHERE default_visible = 1` serves it as a covering SEARCH (no SCAN, no temp B-tree). The literal `= 1` is load-bearing for the partial-index match:
sqlite3 ~/.local/state/keeper/keeper.db \
  'SELECT epic_id, epic_number, sort_path, title, status, approval FROM epics WHERE default_visible = 1 ORDER BY sort_path ASC, epic_id ASC LIMIT 10'
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
