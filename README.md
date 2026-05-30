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
latest-non-NULL-wins via `COALESCE` on resume), and a five-column
planctl-invocation envelope (`planctl_op`, `planctl_target`,
`planctl_epic_id`, `planctl_task_id`, `planctl_subject_present`) stamped
on every `PostToolUse:Bash` row whose `data.tool_response.stdout` parses
as JSON carrying a top-level `planctl_invocation` key — the authoritative
envelope planctl writes on every mutating call. Consumers can find
`/plan:work` calls, `Skill` invocations, every Task-tool subagent
lifecycle, every session's profile attribution, AND every planctl-CLI
mutation cheaply without JSON-scanning the event `data` blob. The
`planctl_*` columns drive the creator/refiner classifier (see
[Architecture](#architecture)) — `op === "create"` and `op === "scaffold"`
both classify as creators (scaffold is the canonical epic-create path on
this codebase). The non-`config_dir` signals are partial-indexed
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
and the boot drain re-converges idempotently after any downtime or crash.

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
peers + lifecycle-swept `unknown` orphans)), `git` (per-worktree planctl-backed
git status — branch, ahead/behind, and a file-centric `dirty_files` list where
each entry carries a per-file `attributions[]` array with `source` badges
(`tool` / `bash` / `inferred`) naming every session that mutated the file
since its last commit; a session is attributed iff it has mutated the file
AND has not committed it more recently than its last mutation, so commit
discharges attribution and a re-edit reinstates it; the strict
`orphan_files` bucket holds dirty files with zero attribution after the
inference pass), `usage` (one row per agentuse profile observed
at `~/.local/state/agentuse/<id>.json` — target, multiplier, session+week
percent and reset timestamps; schema v35 (fn-642) adds the colocated
`last_rate_limit_at` + `last_rate_limit_session_id` columns, populated
server-side by a bidirectional fan-out against the matching `profiles`
row so a single-collection client sees both quota and rate-limit state
together), and `profiles` (schema v33, fn-639 — one
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
(`keeper board`, `keeper autopilot`, `keeper git`, `keeper usage`,
`keeper await`, plus the single-shot `keeper approve` RPC client); see
[Example clients](#example-clients) for usage.

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
  nudge ("re-query if you care"), not a live insert/remove/reorder feed.
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

3. **(Optional) Configure roots.** `~/.config/keeper/config.yaml` carries two
   INDEPENDENT keys:

   - `roots` — the project roots the plan worker watches for
     `.planctl/{epics,tasks}` trees, folding them into the single `epics`
     collection (tasks embedded per epic). Default (no config): the single root `~/code`.
   - `claude_projects_root` — the single tree the transcript worker watches for
     session JSONL (to fold `custom-title` renames). Default: `~/.claude/projects`.
     Override only if your Claude Code transcripts live elsewhere.

   ```sh
   mkdir -p ~/.config/keeper
   cat > ~/.config/keeper/config.yaml <<'YAML'
   roots:
     - ~/code
     - ~/src
   claude_projects_root: ~/.claude/projects
   YAML
   ```

   A `~`-prefixed value is expanded to `$HOME`. For `roots`, a non-existent root
   is skipped (the others keep watching); for `claude_projects_root` a not-yet-
   existing path is returned as-is (the worker tolerates a late-appearing tree).
   The two keys fall back independently — a missing/malformed one never disturbs
   the other; a missing or malformed config falls back to both defaults.

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
   the hook have tables to INSERT into. If the hook fires against a missing
   schema (e.g. you started a Claude Code session before the LaunchAgent
   booted the daemon for the first time) the INSERT fails, the hook's outer
   try/catch logs to stderr, and the process exits 0 — the event is lost but
   the session is not blocked. The manual recovery is `launchctl bootstrap`
   above; subsequent sessions write normally.

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
   Override the path with the `KEEPER_SOCK` environment variable. Set
   `KEEPER_TRACE_SERVER=1` to enable verbose server-worker diagnostic logging
   — `[srv-ts]` stage timings, frame byte counts, connection lifecycle — on
   `server.stderr`; off by default (the rare `[server-worker]` error class is
   always logged). The plist's `EnvironmentVariables` block carries
   `KEEPER_TRACE_SERVER=0`; flip to `1` then
   `launchctl kickstart -k gui/$UID/arthack.keeperd` to enable. Example
   clients ship under the unified `keeper` CLI — `keeper board` /
   `keeper autopilot` / `keeper git` / `keeper usage` (subscribe; the
   readiness clients go through `src/readiness-client.ts`) and
   `keeper approve` (RPC) — see [Example clients](#example-clients).

## Example clients

The unified `keeper` CLI exposes the example subscribe + RPC clients as
typed subcommands (wired through `cli/keeper.ts`, the package.json
`bin` — a single dispatcher entrypoint that fans into all subcommands).
`keeper board` is the read-only subscribe client (combined epics + jobs
view on one connection); `keeper autopilot` is its dispatch-oriented
sibling (flat command list plus a `===`-delimited "ready" block);
`keeper git` watches the `git` worktree collection; `keeper usage`
watches the `usage` collection; `keeper await` is the blocking
wait-for-condition client (emits a Monitor-shaped `armed`/`met`/`failed`
event stream on stdout and exits when an epic/task completes or
unblocks); `keeper approve` is the RPC client (single-shot `rpc` →
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

- `board.ts` — combined "board" UI over the `epics`, `jobs`, and
  `subagent_invocations` collections. Subscribes to all three on a single
  connection and emits one combined frame per change, led by `---`, with
  a `~~~` divider between the epics body and the jobs body (and a second
  `~~~` inside the jobs body splitting ambient sessions from
  planner/worker/closer rows). Uses server-default scope for all three:
  epics are scoped via the descriptor's `defaultClause` — schema v32
  (fn-634) materializes the predicate "open OR not-yet-approved" as the
  VIRTUAL generated column `default_visible` and serves it from the
  partial index `idx_epics_default_visible WHERE default_visible = 1`
  as a covering SEARCH — jobs live only (`working + stopped`),
  `subagent_invocations` full per-job timeline. Each epic renders as a header line —
  `({dir}) {epic_number} {title} [#dep,#dep] [validated|unvalidated]
  [slotted-after-closer]? [ready|completed|blocked:<reason>]` — followed by indented task lines
  (the optional `[slotted-after-closer]` pill — schema v29, active/cyan
  bucket — appears only when the epic was minted by another epic's
  closer session, i.e. `epics.created_by_closer_of != null`; its
  presence is also what slots the row directly below its parent under
  the default `sort_path ASC` ordering)
  (with `[{runtime_status}] [{worker_phase}] [{approval}]
  [ready|completed|blocked:<reason>]` pills — three native vocabularies
  side-by-side: the planctl runtime enum `todo|in_progress|done|blocked`,
  the derived worker-phase binary `open|done`, and approval
  `approved|rejected|pending`) and a final "Quality audit and close"
  line for the epic itself. Sub-agent invocations nest one indent
  level under their owning job row as `{type}: {desc} [<status>]`,
  stamping the raw 5-value projection enum
  `running|ok|failed|unknown|superseded` verbatim (no renderer-side
  collapse or hiding — `superseded` is promoted natively by the
  projection so the full audit trail of re-entrant attempts is visible).
  The `[validated]` / `[unvalidated]` pill reflects planctl's
  `last_validated_at` timestamp on the epic file (flipped by
  `planctl validate --epic <id>`). The `[ready] / [completed] /
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
  the bare-id render. The board's epic-header summary pill uses the
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
  optional stoppage-annotation pills that stack after `[state]` in
  lifecycle order: `[failed:<kind>]` (red /
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
  `warn`) so future kinds need no code change. Pills NOT in
  `PILL_COLORS` render uncolored on purpose — the eye picks
  `pending` / `todo` / `unvalidated` / `unknown` / `open` and the role
  labels (`planner|worker|closer|creator|refiner`) out by absence of
  color.
  The banner status line carries a persistent `[dead-letter:N]` warn pill
  (schema v37, fn-643) when the `dead_letters` collection has waiting rows;
  the `r` keypress fires the `replay_dead_letter` RPC (single-shot
  `rpc` → `rpc_result`), recovering the OLDEST waiting row — the daemon
  appends a plain real event and flips the audit row to `recovered` in one
  transaction. The board flashes `[replaying…]` immediately, then
  `[recovered <dl_id>]` / `[nothing to replay]` / `[replay failed: …]`
  for ~1.5 s before the persistent `[dead-letter:N]` pill resumes; on
  success the dropped session reappears in the next frame and `N` drops
  by one.
  The byte-compare emit gate keeps the stream quiet when row churn
  doesn't surface in the render. Reconnects across keeperd restarts;
  Ctrl-C unsubscribes cleanly. Every emitted frame is mirrored to three
  per-pid `/tmp` sidecar files (combined JSON state, frame text, unified
  diff vs. the previous emit); when stdout/stdin are both TTYs the
  client enters a real TUI (alt-screen + ring-buffered frame history
  with keyboard navigation) AND indexes the sidecars so past frames
  remain inspectable. The keymap is `←/h/k` previous frame, `→/l/j`
  next, `g` jump to oldest, `G`/`End`/`Esc` snap to live, `q`/`Ctrl-C`
  quit; under non-TTY (piped, redirected, CI) the TUI gate collapses
  to plain stream output.

  ```sh
  keeper board            # combined board, default scope
  ```

- `autopilot.ts` — dispatch-oriented sibling of `board.ts`. Subscribes
  through the same `src/readiness-client.ts` helper and renders a
  four-section frame (`--- current ---`, `--- queued ---`,
  `--- predicted ---`, `--- completed ---`) of every dispatch fired so
  far this run (plus prior-run rehydrated `--- current ---` rows via
  `hydrateDispatchLog`). Fires on verdict edges: a row flipping to
  `ready` spawns a Ghostty window running `cd <target_repo> && claude
  '/plan:work|close <id>'`; a row flipping to `blocked:job-pending`
  spawns the matching `/plan:approve`. The launch goes through
  validated `$SHELL` (`-l -i`, `/bin/zsh` fallback) with `exec $SHELL
  -l -i` chained after claude exits so a dropped session leaves a
  usable shell. Each launch records its Ghostty window id in
  `~/.local/state/keeper/dispatch.log` (a `kind:"window"` row) and
  auto-closes the window via osascript the moment the dispatch reaches
  `--- completed ---` (terminal job state or post-fulfillment
  disappearance), so parked "process exited" surfaces don't accumulate.
  Re-dispatch is gated by durable `dispatchedKeys` / `fulfilledKeys`
  sets seeded from `dispatch.log`. Alt-screen TUI when stdout is a TTY;
  keymap `←/h/k` / `→/l/j` / `g` / `G/Esc` / `space` pause / `v` toggle
  commands / `c` copy / `q` quit. SIGINT tears down the renderer (alt-
  screen exit, raw mode off) then disposes the subscribe helper.

  ```sh
  keeper autopilot            # four-section dispatch frame, default scope
  keeper autopilot --dry-run  # log dispatches without spawning Ghostty
  ```

- `git.ts` — single-collection subscribe client over the `git`
  collection (planctl-backed worktree status: branch, ahead/behind,
  and a file-centric layout — one line per dirty file followed by its
  per-session `attributions[]`, each rendered with a colored source
  badge (`tool` = direct Edit/Write/MultiEdit, `bash` = derived from a
  Bash mutation event, `inferred` = time-bracketed against the
  session's Bash intervals); a single file can carry multiple
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
  `last_rate_limit_session_id`). Each row's stack carries the colocated
  rate-limit line when set; untracked profiles (rate-limited but with no
  agentuse usage row) do not render. Per-frame sidecars
  (`/tmp/keeper-usage.<pid>.{state,frame,diff}.<n>.*`, indexed via a meta
  sidecar) carry the row set so the JSON sidecar captures the full input
  to the rendered frame. SIGINT disposes the subscription handle and
  prints sidecar paths on exit.

  ```sh
  keeper usage                # all profiles
  keeper usage --sock /tmp/x  # socket override
  ```

- `await.ts` — the blocking wait-for-condition client (fn-647). Non-TUI:
  emits a Monitor-shaped event stream on stdout — exactly one
  `[keeper-await] armed …` line after the on-board check, then exactly
  one terminal `[keeper-await] met …` or `[keeper-await] failed …` line
  — and exits when the named epic/task completes (pops off the board) or
  unblocks. Auto-detects epic vs task by the `.N` suffix; "unblocked"
  deliberately excludes autopilot's `single-task-per-epic` /
  `single-task-per-root` concurrency mutexes (every other blocker still
  blocks). Exit codes: 0 met, 1 not-found/usage/connection, 3 timeout
  (SIGTERM), 4 deleted, 5 stuck (only under `--fail-on-stuck`).

  ```sh
  keeper await complete fn-646-keeper-cli-opentui-port.1   # task done
  keeper await unblocked fn-650-some-epic                  # epic ready
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
connection polls `PRAGMA data_version` at ~50ms and posts contentless wake
messages; each wake triggers a drain to completion. On macOS, FSEvents/kqueue
drop same-process writes and miss WAL writes entirely, so `data_version`
polling — not a file watcher — is the correct change-detection primitive.

A **second** Worker thread runs the read-only UDS subscribe server. It mirrors
the wake worker's archetype — its own read-only connection, its own
`data_version` poll — but instead of waking the reducer it owns an external
endpoint: a Unix-domain socket (guarded by a PID-liveness lock file) speaking
NDJSON. The surface is namespaced by collection: each query names a collection,
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
exactly as the patch pass shares one re-read per collection.

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
tombstones retract). As of schema v14, the `epics` projection adds
`last_validated_at` (TEXT, nullable) — the validation timestamp planctl writes
via `planctl validate --epic <id>` and the board client renders as a
`[validated|unvalidated]` pill. As of schema v22, `jobs.config_dir` captures `CLAUDE_CONFIG_DIR` from the
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
the transaction). The git-worker also emits a new `Commit` synthetic
event on every HEAD-oid change (carrying `{project_dir, commit_oid,
parent_oid, files, committer_session_id}` — the committer is resolved
deterministically from a `Session-Id:` commit trailer stamped by the
`plugin/bin/git` PATH wrapper when `CLAUDE_CODE_SESSION_ID` is set, or
falls back to a global discharge when the trailer is absent), and the
reducer's `Commit` fold updates `file_attributions.last_commit_at`
(never deletes rows) so a re-edit re-arms attribution by re-stamping
`last_mutation_at`. `GitRootDropped` retracts symmetrically. As of
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
As of schema v35 (fn-642), the `usage` projection colocates the
Claude rate-limit annotation: `last_rate_limit_at` +
`last_rate_limit_session_id` are populated server-side by a
bidirectional fan-out against the matching `profiles` row, joined on
the derived `profile_name = projectBasename(config_dir)` column
(`profiles.profile_name = usage.id`). The forward direction lives in the
`RateLimited` / `ApiError(kind='rate_limit')` arm — a pure UPDATE
against `usage WHERE id = <profile_name>` (never UPSERT, so a
rate-limit on a profile agentuse isn't tracking does NOT mint a
phantom usage row). The reverse direction lives in `projectUsageRow`:
the existing UPSERT carves the two rate-limit columns OUT of the
`ON CONFLICT(id) DO UPDATE SET` clause (so a re-snapshot can't clobber
the annotation), then a post-UPSERT SELECT against `profiles` pulls
the current state forward. Both directions guard `profile_name != ''`
so the `''` sentinel (default `~/.claude`, basename `""`) never
cross-contaminates the join. The `profile_name` derivation is
byte-identical at the SessionStart seed, the dual-case UPSERT, and the
v34→v35 one-time migrate backfill — re-fold determinism converges.
The colocation drops `scripts/usage.ts`'s "Rate limits by profile"
block: each tracked profile's usage stack now carries a `rate-limited
<rel>` line off the same row; untracked profiles render no rate-limit
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
fan-out rides alongside: every `planctl_op != NULL` event triggers the
`syncPlanctlLinks` helper, which re-derives per-session `jobs.epic_links` and
per-epic `epics.job_links` from the session's planctl-CLI footprint
classified against its `/plan:plan` windows (creator = `epic-create` OR
`scaffold` mutation inside a window — scaffold is the canonical
epic-create path on this codebase; refiner = any other epic-touching
mutation inside a window). Both fan-outs run INSIDE the same `BEGIN IMMEDIATE` transaction
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

The seven workers are fully independent; main supervises all seven lifecycles
but routes none of their traffic, and any worker's `error` event escalates
the whole process to a clean restart — with that single scoped exception, the
recoverable drop signal on the transcript, plan, usage, and dead-letter
watchers, which deliberately does NOT escalate (a re-scan throw is swallowed,
never reaching the restart path).

Readiness is a client-side library today, not a server-side collection.
`src/readiness.ts` is the shared verdict pipeline consumed by
`scripts/board.ts` and `scripts/autopilot.ts` via the
`src/readiness-client.ts` helper, which subscribes to the three input
collections (`epics`, `jobs`, `subagent_invocations`) and runs
`computeReadiness` per emit. Each per-collection state carries a stable
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

# Jobs that created or refined an epic during a /plan:plan window (creator/refiner classifier output — jobs.epic_links is the per-session fan-out written by syncPlanctlLinks):
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT job_id, plan_verb, plan_ref, epic_links FROM jobs WHERE json_array_length(epic_links) > 0 ORDER BY updated_at DESC LIMIT 10"

# Epics by inbound-link density — every job whose planctl-CLI footprint created or refined the epic during a /plan:plan window (epics.job_links is the symmetric per-epic fan-out; as of schema v25 each entry embeds the linked job's title/state/last_api_error_(at,kind)/last_input_request_(at,kind) denormalized off the jobs row at the reducer's write boundary, so renderers + predicates no longer need a live-jobs join):
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

# Git projection — one row per planctl-backed worktree. dirty_files is a JSON array; each entry carries {path, xy, mtime_ms, attributions:[{session_id, source, last_mutation_at, last_commit_at}, ...]} (schema v31 file-centric shape — per-(session, file) attribution with source badges tool|bash|inferred and commit-discharge timestamps):
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT project_dir, branch, ahead, behind, json_extract(dirty_files, '\$[0]') AS first_dirty FROM git_status LIMIT 5"

# file_attributions — one row per (project_dir, file_path, session_id) carrying the discharge-rule facts (last_mutation_at vs last_commit_at; a row is live-attributed iff last_commit_at IS NULL OR last_commit_at < last_mutation_at). Indexed for both per-file and per-session scans:
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT project_dir, file_path, session_id, last_mutation_at, last_commit_at FROM file_attributions ORDER BY last_mutation_at DESC LIMIT 20"

# Usage projection — one row per agentuse profile observed at ~/.local/state/agentuse/<id>.json (freshness fields are excluded by design — keeper has no freshness signal yet):
sqlite3 ~/.local/state/keeper/keeper.db \
  'SELECT * FROM usage ORDER BY target, id'

# Profiles projection — schema v33 (fn-639). One row per Claude profile directory keyed by config_dir (the CLAUDE_CONFIG_DIR env value captured at SessionStart; the '' sentinel collapses default ~/.claude). Quiet profiles render with NULL last_rate_limit_at; a rate_limit stamps (last_rate_limit_at, last_rate_limit_session_id) keyed on the same COALESCE(config_dir,'') expression as the SessionStart seed so a NULL-config session's rate limit lands on the exact '' row it seeded:
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT config_dir, datetime(last_rate_limit_at,'unixepoch','localtime') AS last_rl_at, last_rate_limit_session_id FROM profiles ORDER BY config_dir ASC"

# dead_letters operational sidecar — schema v37 (fn-643). One row per unrecoverable hook INSERT failure imported from ~/.local/state/keeper/dead-letters/<pid>.ndjson. status flips waiting → recovered when the human triggers the replay_dead_letter RPC; recovered rows keep replayed_event_id pointing at the appended real event. NOT a reducer projection — re-folding the event log never touches this table:
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT dl_id, status, datetime(dl_written_at,'unixepoch','localtime') AS written, datetime(recovered_at,'unixepoch','localtime') AS recovered, replayed_event_id FROM dead_letters ORDER BY dl_written_at ASC LIMIT 20"

# Waiting dead-letter count (what board.ts's [dead-letter:N] pill renders):
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT count(*) FROM dead_letters WHERE status = 'waiting'"

# Raw event log tail (synthetic EpicSnapshot/TaskSnapshot/EpicDeleted/TaskDeleted rows appear here too):
sqlite3 ~/.local/state/keeper/keeper.db \
  'SELECT id, hook_event, session_id FROM events ORDER BY id DESC LIMIT 10'

# How far the reducer has folded:
sqlite3 ~/.local/state/keeper/keeper.db 'SELECT * FROM reducer_state'
```
