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
sessions spawned by `keeper plan` — a `(plan_verb, plan_ref)` pair derived at
SessionStart from the spawn name. The verb is the strict whitelist `{plan,
work, close}` and the ref is the targeted plan entity (epic id like
`fn-575-foo`, or task id like `fn-575-foo.3`); both stay NULL for sessions not
spawned through `keeper plan`. The pair is fill-once: a resume preserves an
already-bound pair, but a row that was minted with a NULL pair (an
out-of-order `UserPromptSubmit` fork-seed landing before the session's
SessionStart) COALESCE-heals to the spawn name's pair when the SessionStart
folds, so a worker binds to its task regardless of fold order. A
`handoff::<slug>` spawn name (fn-946) is a SEPARATE spawn-name class, NOT a
plan_verb: the `<slug>` is the handoff's human-authored, host-global-unique id,
matched by its own anchored `[a-z0-9-]+` regex, and binds the `handoffs`
job→job edge — it MUST NOT populate `(plan_verb, plan_ref)` and never widens
the `{plan, work, close}` whitelist. Two paired stoppage annotations ride alongside
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
latest-non-NULL-wins via `COALESCE` on resume), `events.worktree` (schema v94 /
fn-997 — the `KEEPER_PLAN_WORKTREE_BRANCH` lane branch the producer injects,
captured the same SessionStart way and folded set-once onto `jobs.worktree` as
the durable per-job worktree marker), a five-column
plan-invocation envelope (`plan_op`, `plan_target`,
`plan_epic_id`, `plan_task_id`, `plan_subject_present`) stamped
on every `PostToolUse:Bash` row whose `data.tool_response.stdout` parses
as JSON carrying a top-level `plan_invocation` key — the authoritative
envelope `keeper plan` writes on every mutating call — and (schema v48 / fn-668)
three terminal-multiplexer backend-exec coordinates
(`events.backend_exec_type`, `events.backend_exec_session_id`,
`events.backend_exec_pane_id`) captured by the hook on EVERY event as pure
synchronous `process.env` reads (no fork, no fs, no PPID-walk). The backend is
tmux, read via `TMUX` (`KEEPER_TMUX_SESSION` for the session name, which a
keeper-managed launch injects via `-e`, and `TMUX_PANE` for the pane). The pane id
is a two-step read: native `TMUX_PANE` first, else the keeper-owned carrier
`KEEPER_TMUX_PANE` (the launcher strips `TMUX`/`TMUX_PANE` so Claude emits truecolor,
copying the pane id into the carrier first). `backend_exec_type` +
`backend_exec_pane_id` fold onto the `jobs` row latest-non-NULL-wins via
`COALESCE`. As of schema v83 (fn-907) the FROZEN launch session does NOT track
a pane the human relocates out-of-band, so it folds onto the forensic
`jobs.backend_exec_birth_session_id` (the launch coordinate, written once) — the
LIVE `jobs.backend_exec_session_id` is owned by the `TmuxTopologySnapshot`
live-only fold instead (see the projection-class taxonomy). A human-created tmux
session carries no `KEEPER_TMUX_SESSION`; its live session name lands via that
same real-time control-worker topology feed. The generic `backend_exec_*` naming keeps a further backend slotting in
without a schema change. Consumers can find
`/plan:work` calls, `Skill` invocations, every Task-tool subagent
lifecycle, every session's profile attribution, every `keeper plan`
mutation, AND the terminal location each live session lives in cheaply
without JSON-scanning the event `data` blob. The
`plan_*` columns feed the creator/refiner classifier (see
[Architecture](#architecture)) — `op === "create"` and `op === "scaffold"`
both classify as creators (scaffold is the canonical epic-create path on
this codebase). As of epic fn-695 the classifier reads the deduped UNION of
these stdout-scrape rows AND the durable `Commit`-event trailer facts
(`Planctl-Op` / `Planctl-Target` / `Session-Id`), so an edge still forms when
this column lands NULL because the `keeper plan` stdout was piped / `grep`'d /
truncated (the fn-635 failure). The `plan_*` columns remain the SOLE
driver of the `file_attributions` plan-source rows (schema v46 / fn-666) —
the commit channel feeds ONLY the creator/refiner edge. The non-`config_dir` signals are partial-indexed
on `WHERE col IS NOT NULL`. The plan columns ride three partial indexes
sharing the `WHERE plan_op IS NOT NULL` predicate: `idx_events_plan_session`
on `(session_id, id)` for the per-session ordered scan, plus the Tier 2
`idx_events_plan_epic` on `(plan_epic_id, session_id, id)` and
`idx_events_plan_target` on `(plan_target, session_id, id)` for the
reducer's `syncPlanLinks` ORPHAN-path cross-session sweep — the sweep is a UNION
of `plan_epic_id IN (...)` and `plan_target IN (...)` so the planner
SEARCHes both indexes (a cross-column `OR` would have to scan one). The normal
per-session-merge path no longer runs this sweep; it re-derives only the
triggering session via `idx_events_plan_session`, so per-event cost is
independent of board size.
`events.config_dir` rides without its own index — it is read off
`jobs.config_dir` (a steady-state attribution column), not the event log.

The architecture is deliberately small. Keeper is built on Bun + `bun:sqlite`
with a single third-party runtime dependency: `@parcel/watcher` (a native
FSEvents-backed file watcher), used by the transcript-title worker, the plan
worker, and the usage / dead-letter / events-ingest watchers. It is where keeper
watches files instead of polling `data_version` — because those files (transcript
JSONL written by Claude Code, `.keeper` JSON written by `keeper plan`) are written
by *another* process, so there is no keeper `data_version` to poll for them and the
same-process-write blind spot that rules watchers out for keeper's own DB does not
apply. The **git-worker is the exception (fn-921): it is POLL-ONLY** — a two-tier
metadata poll (cheap `stat()` of each watched root's `.git` `HEAD`/`index`/
`logs/HEAD`/`packed-refs` + worktree mtime at ~300ms; on a detected delta it runs
the same git scan + `emitSnapshot`) replaced its `@parcel/watcher` subscription.
The poll producer arms unconditionally at worker start, so a watcher-load hang or a
mute FSEvents stream can never again leave the git surface frozen with no producer
(the 2026-06-23 wedge). The daemon detects new
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
without paying the per-event sleep for minutes. To bound peak WAL during a large
drain it also issues a `wal_checkpoint(PASSIVE)` between batches whenever the WAL
crosses a size/event threshold (PASSIVE never blocks the per-event transaction).

**Two boot gates, not one (fn-897).** The READ-ONLY subscribe socket comes up
right after `migrate()` — BEFORE the boot drain — so the control plane is
reachable while the reducer is still catching up. STATE-CHANGING surfaces stay
gated behind drain-reaches-head + git-seed + ephemeral-truncate: the autopilot
actuator arms only after that point, and a mutating RPC issued during the drain
is rejected with a `server_booting` error. Reads are served throughout, and every
reply carries a **boot-status header** (`rev` / `head_event_id` / `catching_up` /
the coarse `git_seed_required` boolean / the per-root `git_unseeded_roots` set) so
a client can tell it is seeing provisional catch-up state and never caches an empty
mid-drain projection as ground truth. The unseeded git surface reads as "unknown",
never "clean" — **per-root** (fn-905): while `seed_required` is set, readiness forces
`{kind:"unknown"}` ONLY for rows whose `effectiveRoot` (`target_repo ?? project_dir`)
lacks a `git_status` row above the floor, so a stale/failed root darks only its own
rows while a seeded sibling root still dispatches. The board latches
`git_unseeded_roots` and renders the SAME per-root gate the autopilot dispatches
against; the coarse `git_seed_required` boolean drives `catching_up` and holds
`keeper await git-clean` at `waiting`. `seed_required` self-clears in steady state
once every gated root is seeded — via the boot-seed and main's above-floor
`GitSnapshot` fold, never a git-worker write. A QUIET repo (no file activity) is
cleared by the git-worker's heartbeat force-emit, and a genuinely STUCK surface is
recovered without a manual bounce by the supervisor-side seed-liveness watchdog
(fn-921): it re-runs the boot-seed on main a capped number of times, then
`fatalExit → LaunchAgent restart` as the last resort (a mute git-worker — no
liveness pulse — escalates straight to restart). The gated read key is normalized to
the toplevel write key (`resolveGitToplevel`) at every non-fold read site — the
git-status seed gate AND the autopilot worktree lane geometry (`classifyWorktreeRepos`
resolves each epic's `target_repo`/`project_dir` to one toplevel before placing
lanes) — so a subdir/symlink `target_repo` un-darks / lanes correctly; the reducer's
own self-clear keeps the raw key (it cannot shell out to git, and the keys agree for
the common case).

The end-of-boot WAL checkpoint is `TRUNCATE`. With the early read socket now
attached during the drain, main's writer is no longer the SOLE connection — but
the server's reader is autocommit and idle between queries, so TRUNCATE usually
still collapses the WAL; if a poll-tick read happens to pin a frame, TRUNCATE
degrades to busy/PASSIVE semantics (it returns a busy status row, never throws)
and the steady-state PASSIVE heartbeat reclaims the space on its next cadence — an
accepted, documented degrade. (An external read-only attachment degrades the same
way.) Steady-state checkpoints stay `PASSIVE` (writer-skipping), never `TRUNCATE`:
live workers and background readers run concurrently there, and PASSIVE skips them
without blocking.

Keeper also exposes an **NDJSON-over-UDS subscribe + RPC server** as a second
Worker thread. The read surface is **namespaced by collection**: a client names
a collection in its `query` (sort/limit/offset/filter) and gets back an ordered
page that doubles as a live subscription. Nine collections register today —
`jobs` (the first and default), `epics` (the read-only plans surface — each
epic embeds its tasks as a JSON array, so there is no separate `tasks`
collection), `subagent_invocations` (the per-job timeline of Task-tool
subagent calls — one row per `PreToolUse:Agent` paired with its later
`PostToolUse:Agent` via `events.tool_use_id`, carrying lifecycle status
`running | ok | failed | unknown | superseded` and a populated `duration_ms`
on close (NULL on rows that never observed a SubagentStop — `superseded`
peers + lifecycle-swept `unknown` orphans)), `git` (per-watched-worktree
git status — watch gate is `.keeper present || dirty || ahead of upstream > 0`,
recomputed each reconcile (epic fn-690); branch, ahead/behind, and a file-centric `dirty_files` list where
each entry carries a per-file `attributions[]` array with `source` badges
(`tool` / `bash` / `inferred` / `plan`) naming every session that mutated the file
since its last commit; a session is attributed iff it has mutated the file
AND has not committed it more recently than its last mutation, so commit
discharges attribution and a re-edit reinstates it; as of schema v45 /
fn-664.2 the discharge is content-aware — a commit only discharges a
session's claim when its captured `(blob_oid, committed_mode)` matches
the file's current `(worktree_oid, worktree_mode)`, so a
stage→re-edit→commit file (committed bytes != worktree bytes) STAYS
attributed; the strict `orphan_files` bucket holds dirty files with
zero attribution after the inference pass), `usage` (one row per agentusage profile observed
at `~/.local/state/agentusage/<id>.json` — target, multiplier, session+week
percent and reset timestamps; schema v35 (fn-642) adds the colocated
`last_rate_limit_at` + `last_rate_limit_session_id` columns, populated
server-side by a bidirectional fan-out against the matching `profiles`
row so a single-collection client sees both quota and rate-limit state
together; schema v41 (fn-651) adds `rate_limit_lifts_at` — the soonest
`resets_at` among windows at >=100% used (when a rate-limited profile
actually unblocks, folded from agentusage's top-level `lift_at`) — and
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
expanded-row cron detail section), and `tmux_client_focus` (schema v89, fn-952 —
the live-only singleton (`id = 1`) the persistent `tmux -C` control worker UPSERTs
with the current real (non-control) client's focused session/window/pane; an empty
/ never-populated table (no-tmux env, or a worker that never connects) serves
`rows: []` so the `keeper jobs` first-paint gate still clears, and the banner
renders `[focus: none]`). The
surface is built so additional collections register without touching the
wire protocol or the diff machinery. Page membership is frozen at query time,
but each row's cells stream `patch` frames as the reducer folds new events.
The `result` page also carries a `total` (the filtered-set size, ignoring
limit/offset) and the server emits a third frame, `meta`, when that set
changes — a row enters or leaves the filter — so a paginated client can render
"showing X of N" and a non-disruptive "set changed, refresh" nudge without the
list reflowing under the cursor.

The membership `total`/token is `COUNT(*)` + `group_concat(pk)` over the
filtered set — so an UNBOUNDED, never-compacted table re-pages its whole history
to every subscriber on each membership change (the 2026-06-23 server-worker CPU
peg, fn-921: `subagent_invocations` grew to ~5k rows / ~1MB and each new subagent
flipped the token → every board/dash client refetched the full collection). A
descriptor may declare a `recencyBound` (`<column> >= ?`) that floors EVERY
non-pk query of that collection to a recent window (`subagent_invocations`: 1
day on `ts`; `epics_recent_done`: 1800s on `updated_at`, the duration a done epic
stays visible for the autopilot close-row reap). The floor threads through ONE
`ResolvedFilter`, so the token, the
page, and `COUNT(*)` all scope to the same window and stay in agreement — it is a
WHERE floor, NOT a `LIMIT` (which would trim the page but not the count and break
render's count/stuck). The cutoff is wall-clock at query-resolve time (the live
serve path only — never a fold, so the re-fold charter is untouched), pinned once
per memo seed so concurrent identical queries share it. A pk detail subscribe is
exempt (a per-identity timeline read resolves any age). A `meta` membership change
thus re-pages only the bounded recent set, not the full backlog.

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
epic folds to `status='done'`, so a completed epic can't stay armed. A SIXTH
mutating RPC (fn-946) is `request_handoff` — the `keeper handoff` enqueue:
through the same main-bridge it mints a `HandoffRequested` synthetic event →
the durable `handoffs` projection, the fire-and-forget hand-off of a contextful
brief to a fresh worker (a separate keeperd worker dispatches it via a
mint-before-launch transactional outbox). RPC handlers — via the
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
  directly. The six write verbs (`replay_dead_letter`, `retry_dispatch`, the
  fn-751 autopilot pair `set_autopilot_mode` / `set_epic_armed`,
  `set_autopilot_paused`, and the fn-946 `request_handoff`) APPEND a
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
- **No general plan write path through the socket** — keeper *reads* plan
  state into the single `epics` projection, each epic embedding its tasks as a
  JSON array, each epic also embedding its plan/close-verb jobs as a JSON
  array, and each task element embedding its own work-verb jobs as a nested
  JSON array (a fourth, read-only producer worker watches the configured
  roots' `.keeper/{epics,tasks}` trees; jobs fan in from the reducer's own
  jobs-side writes whenever a SessionStart spawn name parses as
  `{plan|work|close}::<ref>`). The socket carries no plan mutations: every field
  of every `.keeper` file is read-only end to end, the same fence as `jobs`.
- **No multi-session-per-job lineage** — v1 holds `job_id === session_id` (one
  session per job).
- **No kernel watchers on keeper's own DB** (`fs.watch` / FSEvents / kqueue) —
  `data_version` polling is the change-detection primitive for keeper's SQLite.
  The watchers keeper does run (`@parcel/watcher`, on the *external* transcript
  tree at the configured `claude_projects_root` and on the configured plan
  `roots`) are the scoped exception: those files are written by another process,
  so the same-process-write blind spot does not apply. The git surface, by
  contrast, is now POLL-ONLY (fn-921 — a two-tier `.git`-metadata `stat()` poll),
  NOT watched: a watcher-load hang / mute stream was the 2026-06-23 freeze class,
  and a metadata poll is cheap enough to make the watcher unnecessary there.
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
     `.keeper/{epics,tasks}` trees, folding them into the single `epics`
     collection (tasks embedded per epic). Default (no config): the single root `~/code`.
   - `claude_projects_root` — the single tree the transcript worker watches for
     session JSONL (to fold `custom-title` renames). Default: `~/.claude/projects`.
     Override only if your Claude Code transcripts live elsewhere.
   - `keeper_agent_path` — absolute path to the keeper CLI entry (`cli/keeper.ts`)
     that the launcher re-execs as `keeper agent …`: keeperd's server-side
     autopilot reconciler and the manual `keeper dispatch` both launch a worker
     into a managed window through the in-binary `keeper agent <claude|codex|pi>`
     subcommand (which owns the tmux window). The `KEEPER_AGENT_PATH` env var wins,
     else this config key, else the derived default (this binary's own
     `cli/keeper.ts`, symlink-resolved). A leading `~` is expanded at resolve time
     (`execvp` does not expand `~`); the resolved path is absolute and symlink-
     resolved so the detached pane's re-exec survives keeperd's stripped LaunchAgent
     PATH. The launcher is an in-binary subcommand, not an external dependency:
     keeperd probes its launchability at boot (logging the resolved launcher argv;
     a prominent warning if `bun` + `cli/keeper.ts` are not launchable). The
     managed-session name is hardcoded (`autopilot`), NOT configurable; each
     dispatch opens a new window inside that shared background session. A
     keeper-created window stays open after its work stops — keeper closes no
     windows; the operator garbage-collects completed windows by hand.
   - `dispatch_prompt_prefix` — a global prompt prefix for `keeper dispatch`
     FREE-FORM dispatches (`--prompt`/`--prompt-file`). When set (e.g. `/hack`),
     a free-form prompt launches as `<prefix> <prompt>` (single space) — handy
     for wrapping every ad-hoc dispatch in a skill. A non-empty string only;
     absent/empty leaves it unset (no prefix). Plan-form (`<verb>::<id>`)
     dispatches are never prefixed, and `keeper dispatch --no-prefix` bypasses
     it for one invocation.
   - `handoff_prompt_prefix` — the sibling prefix for `keeper handoff`
     dispatches (fn-946). When set (e.g. `/hack`), the dispatcher boots each
     handoff-ee with `<prefix> <framing> <brief>` — the stored (raw, unprefixed)
     brief INLINE as the launch prompt, framed as the session's REQUEST, so the
     handoff-ee runs the FULL `/hack` workflow (investigate, then park at the
     confirm beat) instead of executing the brief blind. The doc's 64KB cap and
     the 96KB argv cap (`PROMPT_MAX_BYTES`) are COUPLED — framing + prefix are a
     small constant, so the inline prompt always fits. The prefix is applied at
     this ONE site, the launch prompt — never to the stored doc body. A non-empty
     string only; absent/empty leaves it unset (the launch prompt is the bare
     framing + brief, no skill boot). `keeper handoff show <slug>` prints the
     stored brief for inspection only — the handoff-ee no longer reads it back.
   - `usage_scraper_uv_path` / `usage_scraper_project_dir` — the runtime for the
     usage-scraper PRODUCER worker (the in-keeper agentusage producer). The first
     is an absolute path to the `uv` binary (e.g. `/opt/homebrew/bin/uv`); the
     second is an absolute path to the agentusage project directory (the repo
     holding `pyproject.toml` + `agentusage/scrape_cli.py`). The worker shells out
     `<uv> run --directory <project_dir> python -m agentusage.scrape_cli …` to the
     stateless Python scrape util. Both keys have NO default and are independent
     best-effort: absent/empty/garbage on either leaves the runtime unresolved, so
     the worker is NOT spawned (keeperd boots normally — this is the rollback
     switch: unset a key and restart and the worker un-arms). Both MUST be
     absolute — keeperd's LaunchAgent PATH is stripped, so a bare `uv` would not
     resolve. **Python prereq:** the agentusage project must be an `uv`-managed
     project whose env carries `pexpect` + `pyte` (the scrape engine), resolvable
     by that absolute `uv` path; run `<uv> run --directory <project_dir> python -m
     agentusage.scrape_cli --target claude --profile default` once by hand to
     confirm it prints the discriminated JSON contract before gating the worker on.
     Like `keeper_agent_path`, the absolute path survives the stripped LaunchAgent
     PATH.

   ```sh
   mkdir -p ~/.config/keeper
   cat > ~/.config/keeper/config.yaml <<'YAML'
   roots:
     - ~/code
     - ~/src
   claude_projects_root: ~/.claude/projects
   # keeper_agent_path: ~/code/keeper/cli/keeper.ts   # launcher re-exec entry
   # usage_scraper_uv_path: /opt/homebrew/bin/uv      # absolute uv binary
   # usage_scraper_project_dir: ~/code/agentusage     # the scrape util's project
   YAML
   ```

   A `~`-prefixed value is expanded to `$HOME`. For `roots`, a non-existent root
   is skipped (the others keep watching); for `claude_projects_root` a not-yet-
   existing path is returned as-is (the worker tolerates a late-appearing tree).
   All keys fall back independently — a missing/malformed one never disturbs
   the others; a missing or malformed config falls back to every default
   (`roots: [~/code]`, `claude_projects_root: ~/.claude/projects`,
   `keeper_agent_path:` the derived `cli/keeper.ts`). Unknown config keys are
   silently ignored.

4. **Load the plugins via the arthack launcher's `plugin_scan_dirs`.** Both
   Claude plugins live as peers under `plugins/`: `plugins/keeper/` (the
   events-writer hook + the branch-guard hook that hard-denies subagent git
   branch create/switch via the `PreToolUse` deny JSON + the sidecar-writer hook
   that owns the `~/docs` metadata sidecar AND its git state on
   `PostToolUse(Write|Edit|MultiEdit|Bash)` (commits every doc write/edit/delete) +
   the docs-pusher hook that pushes `~/docs` to its remote once per turn on `Stop`,
   + the
   `keeper:await` /
   `keeper:dispatch` / `keeper:autopilot` gateway skills + the `keeper:pair`
   pairing skill,
   manifest at
   `plugins/keeper/.claude-plugin/plugin.json`, command paths in
   `plugins/keeper/hooks/hooks.json`) and `plugins/plan/` (the plan plugin
   behind `keeper plan` + the `plan:*` skills, a native plugin loaded by the
   launcher). The launcher's `plugin_scan_dirs` points at `~/code/keeper/plugins`,
   scans the parent, and appends one `--plugin-dir` per manifest-bearing child —
   so a fresh session auto-loads BOTH plugins from this repo. No symlink step. A
   `~/.claude/plugins/keeper` symlink double-registers the hook (every
   invocation writes two `events` rows, with no runtime dedup guard) — there
   must be none.

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

   **Scheduling priority.** The plist runs keeperd at `ProcessType=Standard`
   with `Nice=-5`, NOT the throttled `Background` class. keeperd is the most
   latency-sensitive process on the host — it folds every hook event in real
   time — so it must keep scheduling priority under host CPU contention rather
   than starving first. (`Interactive` is deliberately avoided: it removes all
   throttling and can starve the human's foreground work.) `ProcessType` is read
   at SPAWN, and `Nice` is read from the plist REGISTRATION, so after editing
   re-register the service with a bootout + bootstrap cycle (a
   `launchctl kickstart -k` alone re-spawns the process but keeps the cached
   registration, so a newly-added `Nice` does not take):

   ```sh
   launchctl bootout gui/$(id -u)/arthack.keeperd
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/arthack.keeperd.plist
   ```

   Then confirm with `ps -o pid,nice,comm -p <keeperd-pid>` that keeperd is
   running at nice `-5`.

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
   the state paths for any test that exercises the real state surface, while the
   template-DB helper in `test/helpers/template-db.ts`
   (`freshMemDb()` / `freshDbFile()`) serves pure in-process unit tests that only
   need a migrated schema — it migrates one `:memory:` DB per file-process,
   `serialize()`s it once, and deserializes a per-test clone (~0.2ms) instead of
   re-running the 63-version `migrate()` ladder on every `openDb(":memory:")`,
   which keeps the whole `bun test` suite fast. The suite is a SINGLE fast
   pure-in-process tier: no test boots a real daemon / Worker thread / UDS socket /
   subprocess / git / tmux, and — because a synchronous spin defeats every
   in-process timeout — no test may hang or sync-spin; there is no watchdog, and
   production is the integration safety net (see CLAUDE.md `## Test isolation`). A
   third helper, `retryUntil` (`test/helpers/retry-until.ts`), polls until an
   async condition holds and is the canonical replacement for a
   fixed `Bun.sleep` deadline race. `bun run test` routes through the concurrency
   gate `scripts/test-gate.ts` (fn-904), which caps per-run parallelism
   (`KEEPER_TEST_PARALLEL`, default 5) and adds `--no-orphans` so concurrent agent
   runs coexist by bounding each run rather than a host-wide lock; git-boundary
   surfaces are tested through a pure seam (producers against synthetic
   porcelain/snapshot fixtures, commit/push against a faked runner), never real
   git. The
   restore worker (epic fn-677) writes
   `~/.local/state/keeper/restore.json` as a dumb single-tier
   `{schema_version, current}` live mirror — a DISASTER FALLBACK only, since the
   live crash-restore set is now derived at read time from `keeper.db`'s
   producer-stamped `close_kind` / `window_index` columns (fn-817), not from
   this file. Overridable via `KEEPER_RESTORE_FILE` for tests. The Agent Bus
   relay worker (epic fn-875) owns two more state paths, both under the same
   state dir and both override-able: `KEEPER_BUS_DB` (its own writable SQLite
   file, default `~/.local/state/keeper/bus.db` — separate from `keeper.db`,
   running its own `PRAGMA user_version` ladder) and `KEEPER_BUS_SOCK` (its
   dedicated relay UDS socket, default `~/.local/state/keeper/bus.sock` — a
   different path and protocol from the subscribe server's `keeperd.sock`). It
   also spills long inbound message bodies under `~/.local/state/keeper/bus/`;
   the state dir created in step 2 covers all of them (no extra `mkdir`). Set
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
   breakdowns carry `plan_*` counters (calls, touched epics, swept sessions,
   trailer-fact rows + load ms) that attribute the `syncPlanLinks` fan-out. On
   the normal per-session-merge path `swept_sessions` is 1 (only the triggering
   session is re-derived); a count growing with board size means the orphan
   full-sweep path fired.
   Steady folds stay silent, so a quiet `server.stderr` is the fold-latency
   all-clear.

   Example clients ship under the unified `keeper` CLI — `keeper board` /
   `keeper jobs` / `keeper autopilot` / `keeper git` / `keeper usage` /
   `keeper dash` (subscribe; the readiness clients go through
   `src/readiness-client.ts`) — see
   [Example clients](#example-clients).

10. **(Optional) Provision the tmux control plane** — `keeper setup-tmux`
    rebuilds the deprecated `dash` dashboard on its OWN dedicated
    `tmux -L dash` server (board + autopilot/jobs/git/builds/usage panes, all in
    `~/code/keeper`) and provisions only the human `work` session on the default
    server (one shell window, stamped with `KEEPER_TMUX_SESSION`). `autopilot`
    is daemon-minted on demand, so it is not created here — but it is still swept
    and torn down by `--kill-sessions`. It rebuilds the dash server on every run,
    never attaches or `switch-client`s (safe inside or outside tmux), and leaves
    an existing `work` session untouched. `--kill-sessions` tears the
    `work`/`autopilot` default-server sessions down first, prompting only when
    they hold busy panes. The same run also symlinks the tmux guard drop-in
    (`tmux/keeper-guard.conf` → `~/.config/tmux/conf.d/zz-keeper-guard.conf`),
    idempotently and fail-open, so a keeper-managed session
    (`autopilot`/`pair`/`panels`/`agentbus`) prompts before a keyboard-triggered
    window/split creation — it only activates if your `tmux.conf` sources
    `conf.d/*.conf`, and it refuses to clobber a real (non-symlink) file there.
    Attach the dashboard with `tmux -L dash attach`:

    ```sh
    keeper setup-tmux                 # rebuild dash server, ensure work session
    keeper setup-tmux --kill-sessions # tear down work/autopilot first, then rebuild
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
event stream on stdout and exits when its condition holds — a plan
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
library code, not a runnable script). All six snapshot-capable viewers (`board`, `jobs`,
`git`, `autopilot`, `usage`, `builds`) resolve their output mode through a
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
  `({dir}) {epic_number} {title} [#dep,#dep] [validated]? [armed]?
  [started]? [ready|completed|blocked:<reason>]` (the
  `[validated]` pill appears ONLY when the epic is validated; its absence
  encodes `unvalidated`. `[armed]` / `[started]` are likewise omit-default —
  present only when the epic is explicitly armed / has been started) —
  followed by indented task lines
  (the `{epic_number} {title}` label falls back to `{epic_id}` when BOTH
  are null — a pre-`EpicSnapshot` stub row in the partial-projection
  window between the `EpicSnapshot` and `TaskSnapshot` folds — so the
  header stays legible and identifiable instead of collapsing to a near-
  blank `({dir})` line — under fn-708's omit-default an unvalidated stub
  no longer even carries a trailing `[unvalidated]` pill; the row is
  never hidden, fn-700)
  (epics reorder through readiness's `orderEpicsForScheduling` seam:
  STARTED epics — any associated job OR any task advanced off `todo`,
  marked by a `[started]` pill — sort ahead of unstarted ones, then
  `epic_number ASC` creation order within each tier (`epic_id` final
  tiebreak). "Prefer the started epic" is a pure read-time computation;
  no priority/ordering signal lives in epic/board state, and the per-root
  single-task mutex self-bounds it — no aging/floor)
  (with omit-default `[<runtime>]? [worker-done]?
  [ready|completed|blocked:<reason>]` pills — the two native fields
  consolidated per fn-708: the plan runtime enum elides its `todo`
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
  pill reflects the plan's `last_validated_at` timestamp on the epic file
  (flipped by `keeper plan validate --epic <id>`); its absence encodes
  `unvalidated`. The `[ready] / [completed] /
  [blocked:<reason>]` pill is a pure-function readiness verdict computed
  from the three-collection snapshot (see `src/readiness.ts`); a
  blocked row is followed by a `   (reason: <reason>)` continuation
  line so the human reads the cause without scanning the upstream rows.
  A `runtime-blocked` task the daemon block-escalation producer has
  notified the planner about (a `block_escalations` latch row is armed)
  renders `[blocked:escalated]` instead of `[blocked:runtime-blocked]`
  (fn-941) — "escalation pending / planner notified", read coarsely off
  the latch row's PRESENCE, not its internal pending/requested/attempted
  state; the `blocked:` prefix keeps it in the amber warn family.
  The `BlockReason` vocabulary splits epic-dep failures into two cousins:
  `dep-on-epic <id>` (amber / warn — the upstream IS in the snapshot
  but its close verdict isn't `completed`; for an in-snapshot upstream
  this clears only once it is done AND its closer idle) and `dep-on-epic-dangling
  <id>` (red / error — the upstream id failed to resolve at all,
  meaning either a full-id miss, a bare `fn-N` miss, or an ambiguous
  bare-id with no same-project disambiguator). The dangling case
  surfaces the plan's fn-600 cross-project bare-id dep contract: a
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
  exiting (`--watch` forces the old live passthrough). The board also renders
  the `keeper handoff` relationship (fn-946): UNLIKE the epic-anchored
  creator/refiner edges, a handoff is a job→job edge folded from
  `HandoffRequested` + the callee's `handoff::<id>` `SessionStart` bind, so it
  has no epic header to sit under and renders off each job's own
  `handoff_links` array — a `handoff-from` line on the initiator's row
  (pointing at the handoff-ee) and a `handoff-to` line on the handoff-ee's row
  (pointing back at the initiator). The dash mirrors it as a relation badge.

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
  body is byte-stable. The same banner COMPOSES a persistent
  `[focus <session>:<win> %<pane>]` pill (schema v89, fn-952 — `[focus: none]`
  when no real client is focused or no worker has connected) from the
  `tmux_client_focus` singleton, stamped on the same pre-byte-compare path so a
  pane/window switch updates it even when the job rows stay byte-stable; the
  ~1.5 s flash-restore timer rebuilds BOTH pills. Each job row also carries an optional trailing
  `[p<pane>]` pane pill (schema v48 / fn-668) — the terminal-multiplexer
  backend-exec pane coordinate lifted off the three live
  `jobs.backend_exec_{type,session_id,pane_id}` columns by the shared
  `projectJobRow` helper, so the CLI list and the TUI both surface which
  pane each live session runs in (the row is already grouped under its
  `--- <session> ---` heading). Plain text (no SGR baked in) so sidecars
  and non-TTY output stay clean; a missing pane drops the pill entirely,
  so rows with no backend coords show nothing at all (never `undefined`,
  never a placeholder). There is no `<tab>` slot. The head line also carries
  an always-visible `[⑂ <lane>]` worktree pill (schema v94 / fn-997) — the
  durable `jobs.worktree` lane branch with the `keeper/epic/` prefix stripped
  (`keeper/epic/fn-986` → `[⑂ fn-986]`, rib `keeper/epic/fn-986--fn-986.2` →
  `[⑂ fn-986--fn-986.2]`), via `worktreeLaneSeg`; a NULL / serial job drops it
  entirely (no empty bracket). Unlike the collapse-controlled pane pill it stays
  on the head line — it's a stable launch-context identity, not live coordinates.
  There is NO backfill: jobs already running when v94 landed folded their
  `SessionStart` before the `worktree` column existed, so they keep
  `jobs.worktree=NULL` for life and show no pill — expected, not a bug (the marker
  binds only on a fresh post-v94 `SessionStart`). When the row is
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
  `yolo`/`armed` mode, the armed count, the global concurrency cap (`max N`),
  the per-root count (`per-root N`, always rendered — NULL/unset reads the
  default 1), and the durable worktree-mode state (`worktree:on`/`worktree:off`),
  and exposes these control RPCs:

  - `keeper autopilot play` / `keeper autopilot pause` — flip the autopilot
    pause flag on the daemon via `set_autopilot_paused`. The RPC appends an
    `AutopilotPaused{paused}` synthetic event onto main's writable
    connection FIRST (the reducer folds it into the singleton
    `autopilot_state` projection — the banner-truth substrate added in
    schema v47 / fn-667), THEN flips the in-memory worker gate + relays to
    the autopilot worker. The daemon RESUMES its last durable paused state
    across a restart: after the boot drain reaches head, main reads the
    durable `autopilot_state.paused` column and seeds the in-memory
    `autopilotPaused` flag (and the worker's boot flag) from it — so an
    intentional `play` survives a restart (boots PLAYING). A fresh board
    with no `AutopilotPaused` history boots PAUSED via the
    `AutopilotCapSet` boot-append's INSERT default (`paused=1`); the daemon
    no longer force-pauses at boot.
  - `keeper autopilot retry <verb::id>` — clear a sticky `dispatch_failures`
    row via `retry_dispatch`. The RPC bridges through main, which appends a
    `DispatchCleared` synthetic event; the reducer DELETEs the failure +
    never-bound counter + `pending_dispatches` row on the next drain and the
    reconciler is free to re-attempt. There is no auto-retry — a failed
    dispatch is sticky and visible in the `--- failed ---` section until a
    human runs `retry`. `verb` is one of `work|close|approve`: `approve` is
    accepted SOLELY to clear a resurrected/phantom `approve` pending (the
    reconciler never dispatches `approve` itself — fn-870).
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
  keeper autopilot retry approve::fn-1-x # clear a resurrected/phantom approve pending (fn-870)
  ```

  The `keeper:autopilot` gateway skill maps natural-language operator intent
  onto these RPCs (including the capture→drive→restore take-over window) for
  the human-invoked control path.

- `dispatch.ts` — a manual escape hatch that fires ONE `claude` worker into a
  tmux window by hand, the client-side complement to the server-side
  reconciler above: where `autopilot` is the daemon's level-triggered
  dispatcher, `keeper dispatch` is a one-shot human-driven launch that goes
  through a direct in-binary `keeper agent` launch with NO daemon RPC, NO
  synthetic event, and NO reducer/migration touch — so re-fold determinism and
  the five-surface RPC-write invariant hold by construction. Two
  mutually-exclusive modes: a **plan form** (`work::<id>` / `close::<id>`) that
  resolves the canonical `/plan:<verb> <id>` prompt + cwd from the daemon's
  `epics` projection (read-only, via `cli/control-rpc.ts`'s one-shot
  `queryCollection`) and bakes `--name <verb>::<id>` so the SessionStart hook
  binds a board-visible `jobs` row, and a **free form** (`--prompt` /
  `--prompt-file`) for an arbitrary prompt. The plan-form resolver FAILS LOUD on
  a resolved cwd that no longer exists on disk (typically a renamed-away repo
  dir): it exits 1 with `cwd-missing: <path>` instead of launching a worker into
  a stale path that silently never runs — the server-side reconciler mirrors
  this, marking the task blocked-with-reason via a sticky `cwd-missing`
  `dispatch_failures` row (no new projection column; unrelated epics keep
  dispatching). The on-disk stat lives in the PRODUCER paths only (the CLI
  resolver + the autopilot launch arm), never in a fold, so re-fold determinism
  holds. Remediation for both: `keeper plan mv-repo <old> <new>` rewrites the
  board's `primary_repo` / `target_repo` / `touched_repos`, then re-dispatch (or
  `keeper autopilot retry`). In free form `--name` is OPTIONAL and
  a pure pass-through — when supplied it is forwarded verbatim as `claude --name
  <value>` (no keeper-side labeling/correlation/tab-renaming); when omitted no
  `--name` is passed at all. (Note: keeper's SessionStart hook still scrapes any
  `claude --name` keeper-wide, so a `verb::id`-shaped free-form `--name` can
  still bind to that plan row; excluding dispatch names from keeper's
  correlation/renaming is a deeper hook change, not done here.) The target tmux
  session resolves `--session` > `$KEEPER_TMUX_SESSION` > `$TMUX`-gated current
  session > the managed `work`. The plan form runs a best-effort race
  guard (a pending dispatch, an unpaused autopilot, or a live job for the key
  refuses unless `--force`; the read↔launch TOCTOU is inherent and accepted for
  a manual hatch).

  ```sh
  keeper dispatch work::fn-1-foo.2                       # plan form → current/work session
  keeper dispatch close::fn-1-foo --session work         # plan form, explicit session
  keeper dispatch work::fn-1-foo.2 --dry-run             # print the launch plan, launch nothing
  keeper dispatch --prompt 'investigate the flaky X test'         # free form, no --name
  keeper dispatch --prompt 'investigate X' --name scratch         # --name forwarded to claude verbatim
  keeper dispatch work::fn-1-foo.2 --force               # skip the race guard
  keeper dispatch --name scratch --prompt 'look at X' --no-prefix  # bypass dispatch_prompt_prefix
  ```

  When `dispatch_prompt_prefix` is configured (e.g. `/hack`), a FREE-FORM prompt
  launches as `<prefix> <prompt>` (single space) so every ad-hoc dispatch wraps
  in that skill; the NUL/96 KB prompt guard runs on the final prefixed prompt,
  `--dry-run` reflects it, and `--no-prefix` bypasses it for one invocation.
  Plan-form dispatches are never prefixed.

  The `keeper:dispatch` gateway skill maps natural-language operator intent
  onto this command (surfacing the plan-form race-guard refusal and asking
  rather than auto-pausing) for the human-invoked launch path.

- `git.ts` — single-collection subscribe client over the `git`
  collection (watched-worktree status — membership gate
  `.keeper present || dirty || ahead of upstream > 0`, recomputed each
  reconcile (epic fn-690): branch, ahead/behind,
  and a file-centric layout — one line per dirty file followed by its
  per-session `attributions[]`, each rendered with a colored source
  badge (`tool` = direct Edit/Write/MultiEdit, `bash` = derived from a
  Bash mutation event, `inferred` = time-bracketed against the
  session's Bash intervals, `plan` = lifted from a `keeper plan`
  invocation envelope's `files[]` — so `.keeper/{epics,tasks}/*.json`
  and `.keeper/specs/*.md` attribute to the session that ran
  `keeper plan scaffold/done/...`); a single file can carry multiple
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
  agentusage profile observed at `~/.local/state/agentusage/<id>.json`:
  target, multiplier, session+week percent + reset timestamps, plus the
  schema-v35 colocated `last_rate_limit_at` +
  `last_rate_limit_session_id` and the schema-v41 `rate_limit_lifts_at` +
  `last_usage_fold_at`). Each row's stack carries a `limited lifts in
  <rel>` line whenever a non-codex row has a known FUTURE lift
  (`rate_limit_lifts_at`, schema v41 / fn-651) — `limited lifts now`
  within the ±30s rounding gap; a past/NULL lift omits the line. As of
  fn-754 the gate is the future lift itself, NOT the fired-time
  `last_rate_limit_at`, so a depleted-but-quiet row (weekly 100%,
  agentusage paused polling until its lift) still surfaces its countdown
  instead of going blank. A v41 `stale Nm` line surfaces under any row
  whose stale anchor — `max(last_usage_fold_at, rate_limit_lifts_at)`
  (fn-754) — is older than the renderer's `STALENESS_THRESHOLD_MS`
  cutoff (currently ~15m); anchoring to the lift keeps a deliberately-
  idle producer (paused with a known resume time) from being misread as
  dead. Driven only off that anchor, never `updated_at` (a rate-limit
  fold bumps that) and never agentusage's own `status` (which tracks its
  scrape failures rather than keeper's ingestion health) — so a wedged
  usage worker becomes visible instead of silently frozen. A stale row
  carrying an `error_type` also renders an `error`-family line: the
  projected `error_kind` becomes a short label — `format` (panel drift),
  `panel` (panel missing), `scrape` (scrape crash), `upstream` (endpoint
  throttle), `runner` (keeper-side runner fault) — while the body keeps the
  full `<type>: <message>` and a ticking age. A null or unrecognized
  `error_kind` degrades to the generic `error` label so the detail is never
  hidden. Untracked
  profiles (rate-limited but with no agentusage usage row) do not render.
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

- `dash.ts` — the unified keeper TUI (fn-780; reworked into the robot job-card
  screen in fn-841): a live, read-only, full-screen SINGLE COLUMN of compact
  CARDS — one per job (project · title · status) — that replaces the old
  header+PLAN+AGENTS layout. Each card is a rounded structure-gray bordered box
  (project name in the border title) with three interior lines: `<rail><robot>
  <status> · <role> · ◉<subagents>` / `<title>` / `<age> · <session:pane>`.
  **Status is dual-encoded:** a Nerd Font md-robot face plus a colored left rail,
  resolved fresh per card from a six-rung ladder where annotations outrank the
  base state — api-error (robot_angry, red) → awaiting permission/input
  (robot_confused, yellow) → working (robot, blue) → ended (robot_happy, green
  dim) → stopped (robot_outline, gray dim) → killed (robot_dead, red dim). The
  rail is the ONLY color channel; the border is always structure-gray (OpenTUI
  0.3.0 has no `titleColor`, so the project name in the border inherits border
  color). Cards group into three urgency BANDS — needs-you / in-motion / idle —
  each fenced by a dim inline-titled rule (an empty band collapses); within a
  band, cards sort by live tmux `window_index` ASC (the window's left-to-right
  VISUAL position; an unknown index sorts last, then `created_at`/`job_id`) so
  the board matches the operator's tmux window order and a live card never
  teleports on a metadata tick. The robots make the board calm when idle and the
  few jobs that need attention pop.
  **Keybinds:** `j`/`k`/`↓`/`↑` drive a focus cursor keyed on `job_id` (survives
  a re-sort) that swaps the focused card to a HEAVY cyan border and
  `scrollChildIntoView`s it; `q`/Ctrl-C quit. (`t` is wired but inert against
  today's live-only feed — see Data sources.)
  **Data sources:** ONE `subscribeReadiness` connection. The `jobs` subscription
  uses the descriptor's live-only default scope (`state not_in [ended, killed]`)
  capped at a bounded first page (`jobsLimit: 50`, `created_at DESC`) so the
  snapshot stays under the 1 MiB NDJSON line cap regardless of job-history
  growth — an unbounded fetch over the full history overruns the line and
  closes the connection before the first snapshot (the `0 jobs` failure). The
  `t` toggle / `showTerminal` plumbing is retained but inert against this
  live-only feed; revealing ended/killed awaits a future bounded terminal page.
  The dash no longer subscribes `autopilot_state` / `armed_epics` (the card
  screen reads neither).
  **Frame shape:** a fresh `@opentui/core` app under `src/dash/` — a pure
  view-model builder (`src/dash/view-model.ts`, OpenTUI-free, fast-tier tested)
  plus a materializer (`src/dash/app.ts`) that holds one `BoxRenderable` per
  `job:<id>` in a stable `Map<rowKey, RowHandle>` and MUTATES border + child Text
  content in place every frame (structural detach-then-append only when the keyed
  band order changes — never add/remove per frame, which would force a full Yoga
  re-layout). Colors resolve via `RGBA.fromIndex` so the hue tracks the terminal
  theme. The robot codepoints live in a DASH-LOCAL map; the board/jobs
  `fa-classic` glyph theme is untouched. Reactive render mode (no
  `renderer.start()`); one coarse 30s interval refreshes the age cells.
  **TTY-only:** the gate fires in `cli/dash.ts` BEFORE any OpenTUI import — a
  non-TTY stdout exits 1 with `keeper dash: requires a TTY` (no snapshot mode,
  no `keeper-meta:` line). Reconnect-forever with the connection state shown
  in-TUI (a pre-paint `connecting…` / `reconnecting…` census line, then the body
  frozen at last-good once a snapshot has painted). Read-only end to end — no RPC
  frame is written, no DB opened. Every exit path (q, Ctrl-C, SIGHUP, stdin-EOF,
  the ~2s `ppid === 1` poll, onFatal, uncaughtException/unhandledRejection)
  routes through one idempotent teardown that `renderer.destroy()`s BEFORE
  exiting, so the terminal is never stranded in alt-screen/raw mode.

  ```sh
  keeper dash                 # live robot job-card screen on a TTY
  keeper dash --sock /tmp/x   # socket override
  echo | keeper dash          # non-TTY → 'keeper dash: requires a TTY', exit 1
  ```

  The dash is keeper's OpenTUI host surface.

  Named launch-config lives in TWO purpose-scoped files under `~/.config/keeper/`,
  read ONLY by the dep-free `src/agent/config.ts` island (the launcher import graph
  never reaches `src/db.ts`): `presets.yaml` is the CATALOG of available presets —
  each a named `{harness, model?, effort?, thinking?, role?}` triple
  (`presets.<name>`) — and `panel.yaml` is the panel SELECTIONS — named panels
  (`panels.<name>`, each an ordered list of catalog preset names) plus an optional
  `default:` naming the panel a bare `keeper pair panel start` assembles.
  `KEEPER_CONFIG_DIR` is the single env seam that derives both paths.
  `keeper agent --x-preset <name> [args...]` applies one preset — harnessless, the
  harness comes from the preset — and `keeper agent presets resolve <name>` emits
  the resolved preset/panel JSON. Per-field resolution is `explicit flag > effort
  env > preset > per-harness yaml > native default`, so a preset never overrides an
  explicit `--model`/`--effort` and a partial preset layers over the yaml; with no
  `--x-preset` the launch is byte-identical to a no-preset run. The posture is
  REQUIRED + validated: any preset referenced by name (`keeper pair --preset`,
  `keeper dispatch --preset`, `keeper agent --agentwrap-preset`) and EVERY panel op
  hard-fail (exit 2) on a missing or invalid `presets.yaml`/`panel.yaml`, with a
  message naming the file, the bad name, and the sorted available names (and a
  migration hint naming any leftover `~/.config/agentwrap/presets.yaml`). Panel
  members are claude|codex only (pi is rejected at load). Presets are producer-side
  launch config, never a fold input — no RPC writes one and both files are
  re-parsed per dispatch (no watcher), so an edit lands without a daemon bounce.
  The autopilot worker launch is the SOLE fail-open carve-out: it resolves its
  `--model`/`--effort` from a `worker` preset, COALESCING per-field onto the
  `WORKER_MODEL`/`WORKER_EFFORT` constants (`sonnet`/`max`) and SWALLOWING a missing
  or malformed catalog's `ConfigError` to those constants, so the daemon never
  crashes on bad config.

- `await.ts` — the blocking wait-for-condition client (fn-647; conditions
  + AND grammar widened in fn-713, `monitor-running` added in fn-718,
  `server-up` + `reason=unreachable` added in fn-750.2, give-up made
  opt-in via `--connect-timeout` in fn-757). Non-TUI: emits a
  Monitor-shaped event
  stream on stdout — exactly one `[keeper-await] armed …` line after the
  on-board check, then exactly one terminal `[keeper-await] met …` or
  `[keeper-await] failed …` line — and exits when its condition holds.
  Seven conditions: `complete <id>` (epic/task pops off the board),
  `started <id>` (work has begun at least once — a monotonic milestone
  keyed on job-presence OR `runtime_status` in {in_progress, done} OR
  `worker_phase=done`, NOT the flapping liveness `running` verdict; a
  popped-off target reads `met` since it was necessarily started), and
  `unblocked <id>` (workable now) are plan-id forms auto-detecting
  epic vs task by the `.N` suffix; `git-clean` blocks until the cwd's git
  root has `dirty_count=0 AND orphaned_count=0` (no `git_status` row for
  the root counts as clean); `agents-idle` blocks until no OTHER session
  (`job_id != CLAUDE_CODE_SESSION_ID`) with `state=working` has a cwd
  inside the cwd's git root; `server-up` blocks until keeperd is reachable
  and serving, firing `met` on the first snapshot — it reconnects FOREVER
  (permanently give-up-exempt) so it survives a daemon bounce, takes
  no id, has no plan pre-check, CANNOT be ANDed with another
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
  `single-task-per-epic` / `single-task-per-root` round-robin-allocator
  block reasons (every other blocker still blocks). By default every condition reconnects
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
  keeper await started fn-646-keeper-cli-opentui-port.1    # task begun
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
  serializes concurrent invocations in the same worktree on
  `<git rev-parse --path-format=absolute --git-dir>/keeper-commit-work.lock`
  via an `FD_CLOEXEC` `flock(2)`,
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

- `show-job.ts` — emit ONE job's full `jobs` metadata row as a pretty JSON
  envelope (`{success, job, resolution}`), read-only. Resolve it by the cheapest
  signal: `--session-id <id>`, `--session <title>` (the Claude session title —
  current title or any `name_history` entry, case-insensitive), `--cwd <dir>`
  (git-toplevel containment; `--cwd-exact` for strict equality), or `--pane %N`.
  With no flag it auto-detects: your own job inside a Claude session (via
  `$CLAUDE_CODE_SESSION_ID`), else the single live agent in your current tmux
  WINDOW (split a shell pane beside it), else the job whose cwd contains yours.
  Ambiguity is explicit — one-live-wins, else a candidate list + exit 1, with
  `--latest` to collapse to the most-recent. A read failure (`{success:false,
  error}`) is distinct from `not_found`; `--raw` leaves JSON-TEXT columns as TEXT.

  ```sh
  keeper show-job --session-id <id> | jq .job.title  # explicit id lookup
  keeper show-job --session "<claude --name title>"  # by session title
  keeper show-job                                     # auto-detect (session/tmux/cwd)
  ```

`setup-tmux` is a one-shot provisioner (epic fn-803), not a subscribe client.
It drives tmux directly via `Bun.spawnSync` — its own provisioning lifecycle,
unrelated to the managed dispatch path — and writes nothing to git or the event
log.

- `setup-tmux.ts` — stand up the human's tmux control plane. Rebuilds the
  deprecated `dash` dashboard every run on its OWN dedicated `tmux -L dash`
  server — torn down wholesale with `tmux -L dash kill-server` and recreated
  (board main pane + autopilot/jobs/git/builds/usage splits, `main-vertical`,
  each pane a `zsh -ic '…; exec $SHELL'` triple sized to the real
  client/terminal, the new-session stamped `-e TMUX=` so a bare `tmux` inside a
  dash pane doesn't misroute to the default server) — and provisions only the
  human `work` session on the default server (one shell window, stamped
  `KEEPER_TMUX_SESSION=work` so hook attribution matches daemon-minted
  sessions). `autopilot` is daemon-minted on demand on the default server, so
  setup-tmux does not create it — but it is still swept for busy panes and torn
  down by `--kill-sessions`. An existing `work` session is never touched; it
  NEVER attaches or `switch-client`s, so it is safe inside or outside tmux.
  `--kill-sessions` tears the `work`/`autopilot` default-server sessions down
  first, prompting y/N only when they hold busy (non-shell foreground) panes —
  non-TTY stdin with busy panes aborts (exit 1) having killed nothing; the dash
  server is always rebuilt regardless of the flag, and a dash rebuild failure is
  fail-open (warns and continues so `work` is still provisioned). When the human
  `work` session is ABSENT (the first run after a crash), it offers to relaunch
  the last tmux-server generation's crashed agents for it — ONE combined y/N
  TTY-only prompt naming each absent session and its own candidate count (never
  auto-restores; counts and absence probes computed BEFORE `ensureWorkSessions`
  so minting `work` on the default server doesn't shift the generation window),
  spawning `restore-agents --apply --session <name> --last-generation` per
  offered session on `y` (continue-on-error — one failure doesn't abort the
  other). The reconciler-managed `autopilot` session is never offered. A present
  session, zero candidates, or a non-TTY skips that session's offer. Reading
  `keeper.db` read-only for the candidate counts is the only DB dependency; the
  relaunch is a spawned subprocess (`restore-agents`), so `setup-tmux` owns no
  launch transport. The dash panes connect to the daemon over its UDS
  (`KEEPER_SOCK`), independent of the tmux socket, so the `-L dash` move needs no
  pane-command change. The same run also idempotently symlinks the tmux guard
  drop-in (`tmux/keeper-guard.conf` → `~/.config/tmux/conf.d/zz-keeper-guard.conf`)
  in its own fail-open inner try/catch — `mkdir -p`s the `conf.d` parent, leaves
  a correct existing symlink untouched, relinks a wrong/missing target, and
  refuses to clobber a real (non-symlink) file. It only activates if your
  `tmux.conf` sources `conf.d/*.conf`; the drop-in `confirm-before`-wraps
  keyboard-triggered window/split creation in a keeper-managed session
  (`autopilot`/`pair`/`panels`/`agentbus`) — a deterrent, not a hard lock.

  ```sh
  keeper setup-tmux                 # rebuild dash server, ensure work session
  keeper setup-tmux --kill-sessions # tear down work/autopilot first (confirm if busy)
  ```

## Uninstall

Reverse of install:

```sh
launchctl bootout gui/$(id -u)/arthack.keeperd
rm ~/Library/LaunchAgents/arthack.keeperd.plist
# If installed: the rotation sidecar.
launchctl bootout gui/$(id -u)/arthack.keeperd.logrotate
rm ~/Library/LaunchAgents/arthack.keeperd.logrotate.plist
# Remove the tmux guard drop-in symlink (tmux has no live config-unload, so it
# stays effective in running tmux servers until they restart or re-source).
rm ~/.config/tmux/conf.d/zz-keeper-guard.conf
# The sitter scanners now live in ~/code/sitter; uninstall them per that repo's README.
# Stop loading the plugins: remove the `plugin_scan_dirs` entry pointing at
# `~/code/keeper/plugins` from whatever entrypoint launches `claude` (e.g. the
# arthack launcher). This unloads both the keeper and plan plugins.
# Optional — drops all captured state, including the events log:
rm -rf ~/.local/state/keeper
```

## Architecture

The `events` table is a durable append-only log (with ten sparse
top-level signals partial-indexed for cheap cross-session lookup —
`slash_command`, `skill_name`, `tool_use_id`, the five-column
`plan_*` envelope, and the schema-v31 pair `bash_mutation_kind` +
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

The keeper plugin also ships a second, daemon-independent `PreToolUse(Bash)` hook,
the **branch-guard** (`plugins/keeper/plugin/hooks/branch-guard.ts`): a pure-payload
hard-deny that blocks a SUBAGENT (a `/plan:work` worker, detected by `agent_id` /
`agent_type` presence) from git branch create/switch/worktree-add so workers stay on
the current branch. It denies via the `PreToolUse` JSON envelope
(`hookSpecificOutput.permissionDecision:"deny"`) and STILL exits 0 — exit 0 is
required for the deny to be honored. It makes no subprocess/fs/git/DB calls, fails
open, and never touches non-subagent sessions (the human's interactive claude and the
`/plan:work` orchestrator both run with no `agent_id`). The autopilot worktree
producer — which shells `git worktree add` / branch / merge directly inside
keeperd — is NOT a subagent and carries no `agent_id`, so the branch-guard never
fires for it; it STILL hard-blocks a `/plan:work` worker subagent from creating
or switching branches, so workers stay on the lane worktree the producer placed
them in.

A **third**, daemon-independent `PostToolUse(Write|Edit|MultiEdit|Bash)` hook, the
**sidecar-writer** (`plugins/keeper/plugin/hooks/sidecar-writer.ts`), owns the
`~/docs` metadata sidecar AND its git state (relocated out of arthack's
`post_tool_use.ts` so the keeper plugin is the single owner of `~/docs`
control-data). On a Write to a
`~/docs/*.md` (the dir is overridable via `KEEPER_DOCS_DIR` for tests) it
create-or-merges the doc's `.yaml` sidecar — stamping `path`/`type`/`created`/
`session-id`/`cwd`/`resume` and best-effort `git-branch`/`git-commit` — preserving
an existing `created`. On a `gh gist create <doc>.md …` it parses the gist URL out
of the tool-response (bounded `https?://gist.github.com/[^\s"'<>]+`, never the old
greedy `\S+` that swallowed the JSON tail) and upserts `gist-url:` into the matching
sidecar. After the sidecar write — and on an Edit/MultiEdit to a doc, and on a
`rm`/`mv`/`git rm` delete of one — it **commits** the dirty `~/docs` paths inline:
pathspec-scoped, a mechanical `docs: write|update|delete <relpath>` subject, via the
dep-free committer `src/doc-commit.ts` (`commitDocsPaths` — a hook-context port of
`plugins/plan/src/commit.ts` with a tightened retry cap, a per-call git subprocess
timeout, `-c commit.gpgsign=false`, and mid-operation/detached-HEAD skip guards; a
hook MUST NOT import the plan plugin). The commit is fail-open — a `CommitFailed`
logs to stderr and the hook still exits 0 (the sidecar write already succeeded). It
**NEVER touches the `.md` body** — machine metadata lives only in the
sidecar now — writes the sidecar atomically (tempfile + rename), fails open (exit 0
on any error, including `uncaughtException`/`unhandledRejection`), and is dep-free
(`node:fs`/`node:os`/`node:path` + the pure `src/derivers.ts` tokenizer +
`src/sidecar.ts` + `src/doc-commit.ts`, never `bun:sqlite`/`src/db.ts`). Its
strip-signature detector +
sidecar parse/merge logic live in `src/sidecar.ts`, shared with the one-shot
`~/docs` migration so the strip regex never drifts.

A **fourth**, daemon-independent `Stop` hook, the **docs-pusher**
(`plugins/keeper/plugin/hooks/docs-pusher.ts`), pushes `~/docs` to its remote on a
debounced cadence — Stop fires once per turn, which IS the debounce (no persistent
timer state). It guards a mid-operation repo and a detached/unborn HEAD, then checks
ahead-of-upstream with the purely LOCAL `git rev-list --count @{u}..HEAD` (using
`@{u}`, not a hardcoded `origin/main`, so it survives a non-main branch; NO
`git fetch` per turn). Nothing-ahead and no-upstream are clean no-ops. It serializes
concurrent sessions with a `.git/keeper-push.lock` `wx`/O_EXCL lockfile (skip if
held) and pushes with `--no-progress`, `GIT_TERMINAL_PROMPT=0`, and a subprocess
timeout. On a non-fast-forward / auth / network failure it LOGs the classified error
(`classifyPushError` substrings re-derived inline from `src/commit-work/push.ts`,
which is async/dep-heavy and NOT hook-portable) to `.git/keeper-push.log` and
SKIPs — **never auto-rebase, never `--force`**. It **ALWAYS exits 0**: a `Stop` hook
that exits 2 would BLOCK Claude from stopping, so every path swallows + logs. Fully
self-contained dep-free (`node:fs`/`node:os`/`node:path` + `Bun.spawnSync`, no `src/`
import; `KEEPER_DOCS_PUSH_LOG` overrides the skip-log for tests). It only PUSHES —
the sidecar-writer owns the commits — so the two hooks together make keeper the sole
reliable owner of `~/docs` git state.

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
`.keeper/{epics,tasks}/*.json` files with `@parcel/watcher`, safe-parses each
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
plan repo root, bounded by a 1s timeout and fail-closed (any git
failure reads as not-in-HEAD). When the predicate returns false, the
path lands in a per-scanner `pending` set and NO `EpicSnapshot` /
`TaskSnapshot` is emitted — so the reducer never folds an uncommitted
epic and the autopilot dispatch gate (`src/readiness.ts`
`computeReadiness`) cannot observe it. As of fn-759 the cheap in-memory
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
`.keeper` files in ~50ms — the realtime complement to the best-effort
FSEvents subscription, closing the up-to-60s fold lag the heartbeat used to
impose. It ALSO watches each plan repo's `.git/logs/HEAD` reflog with
`@parcel/watcher` (a commit always appends there) to close the
no-DB-write commit tail, where the in-HEAD transition fires no DB
write and no `recheck-pending` post — the broad recursive watch IGNORES
`.git` (`IGNORE_GLOBS`), so the per-repo reflog watch is the only FSEvents
commit signal. As of fn-737 the worker reconciles those external reflog
watches against the UNION of its live `pending` repo set AND every repo that
holds a `.keeper` tree under the configured roots (`discoverProjectRoots`),
not just the pending ones — fn-705 armed a watch only while a repo held a
pending path, so a commit in a plan repo with NO pending path (a
steady-state `.keeper` change whose file-write FSEvent was a no-op or
coalesced) had no realtime signal and fell to the git-worker's 60s heartbeat
(task fn-737 measured that as the dominant fold-latency tail). The widening is
bounded — the watch count is the number of plan-tracked repos under the
roots, and since the broad watch ignores `.git` these per-repo `.git/logs`
watches don't overlap it (no fseventsd bad-state). On the reflog append the
worker runs the repo-SCOPED gated pending recheck PLUS a change-gated
`RescanScheduler` re-scan of that repo's `.keeper` dir (the latter recovers a
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
nor drives a synthetic event from anything but a parsed `.keeper` file, so
re-fold determinism is intact. Every drain trigger re-runs the in-HEAD probe
and a still-uncommitted path stays in `pending` (no fn-627 regression — the
fn-629 gate is preserved exactly, only the realtime drain triggers are new).
A freshly-committed path emits its snapshot and leaves the set, with no
permanent strand. The gate trusts the plan's commit-at-the-seam contract: every
mutating verb's `output.emit()` owns the write→commit transaction inline, so
the file is in HEAD by the time the envelope `success: true` lands on stdout. As of schema v14, the `epics` projection adds
`last_validated_at` (TEXT, nullable) — the validation timestamp `keeper plan` writes
via `keeper plan validate --epic <id>` and the board client renders as a
`[validated]` pill at the non-null (validated) value, omitting it otherwise
per fn-708's omit-default rule (absence ≡ `unvalidated`). As of schema v22, `jobs.config_dir` captures `CLAUDE_CONFIG_DIR` from the
SessionStart environment, projecting the arthack-claude profile a session
ran under (latest-non-NULL-wins via `COALESCE(excluded.config_dir,
jobs.config_dir)` on the SessionStart ON CONFLICT branch, so a resume
SessionStart that captures NULL preserves the prior attribution).
As of schema v85 (fn-936), the `epics` projection carries NO static
priority/ordering machinery: `EPICS_DESCRIPTOR.defaultSort` is
`epic_number asc` (tie-break `epic_id`) — plain creation order, a neutral
seed. Clients (board, autopilot, the `keeper autopilot` viewer) consume that
order through readiness's `orderEpicsForScheduling` seam, which applies Rule #1
("prefer the started epic") as a PURE read-time reorder: started epics
(`isEpicStarted` — any associated job OR any task off `todo`) sort ahead of
unstarted ones, then `epic_number ASC` (`epic_id` tiebreak) within each tier.
No priority is persisted — it is recomputed each call from task/job activity,
and the per-root single-task mutex self-bounds it (hard-categorical, no aging).
v85 dropped
the `sort_path` / `queue_jump` / `created_by_closer_of` `epics` columns, the
`events.plan_queue_jump` column, the `[slotted-after-closer]` board pill, and
the `/queue` surface (`/plan:next` + `keeper plan epic queue-jump`). As of
schema v87 (fn-946) the deterministic-replayed `handoffs` projection lands —
the durable record of a `keeper handoff` enqueue (`HandoffRequested` → one row
per `handoff_id`, carrying the ≤64KB doc inline, plus the dispatcher's
transactional-outbox lifecycle `requested`→`dispatching`→bound) — and v88 adds
the `jobs.handoff_links` column (APPEND-via-ALTER, default `'[]'`), the per-job
home for the rendered job→job handoff edge (`handoff-from` written by the
`HandoffRequested` fold onto the initiator, `handoff-to` by the callee's
`handoff::<id>` `SessionStart` bind fold). Both re-fold byte-identically from a
pre-feature log (empty / `'[]'`). As of schema v96 (fn-1003) the handoff id is a
required human-authored, host-global-unique slug (`handoff::<slug>`,
reject-on-collision) and `handoffs` gains the nullable `target_dir` column
(APPEND-via-ALTER) — the absolute directory the handoff-ee launches in (NULL ≡
keeperd's cwd); a pre-v96 `HandoffRequested` event carries no `target_dir`, so a
from-scratch re-fold leaves it NULL (re-fold-safe). As of
schema v31, the `git` collection is
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
site changed. As of schema v46 / fn-666, the `keeper plan` invocation
envelope's `files[]` array (every `.keeper/{epics,tasks}/*.json` and
`.keeper/specs/*.md` `keeper plan` wrote during the op) is lifted into a
new sparse `events.plan_files TEXT` column by `extractPlanInvocation`
(Array.isArray + per-element string filter + runaway-size guard; NULL
on miss / non-array / empty / oversized), and the reducer's
`plan_op != null` fold seam mints one `source='plan'`
`file_attributions` row per path under `project_dir = state_repo` (the
absolute repo path, extracted in-fold from the stored envelope) +
`event.session_id` + the repo-relative path + `event.ts` + the verb
(`scaffold` / `done` / …) as `op`. The
`file_attributions.source` CHECK includes `'plan'`; pass-2's
inferred-guard reads `source IN ('tool','bash','plan')` so a `'plan'`-source
file does NOT also get a spurious inferred attribution; pass-3 renders
`'plan'` as an honest badge. Discharge flows through the SAME `foldCommit` path as
`'tool'`/`'bash'`/`'inferred'` — a `chore(plan)` commit clears
the row via the same `last_commit_at` UPDATE; no per-source branch.
Fixes the 559-orphan spike (`.keeper/{epics,tasks}/*.json` and
`.keeper/specs/*.md` were strict-mystery orphans the instant they
flashed dirty, since `keeper plan` writes them outside any Claude
Write/Edit / bash mutation deriver match). This envelope `files[]` scrape
remains the SOLE driver of the `'plan'`-source `file_attributions` rows — epic
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
would clobber the link the consumer (`keeper plan pick_target_job`) relies
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
`keeper plan` on every `chore(plan)` commit) onto the `Commit` payload, and
`foldCommit` — when all three axes are non-null and the target parses —
TRIGGERS the per-session creator/refiner edge rebuild by calling
`syncPlanLinks(committer_session_id, …)`. As of schema v67 (fn-807)
`foldCommit` ALSO records each trailer-bearing `Commit` into the indexed
`commit_trailer_facts` projection in the same transaction (the wider
all-three-axes-non-null condition, NOT the narrower parse-the-target trigger
gate); `syncPlanLinks` reads that projection ONCE per call rather than
re-scanning every `Commit` blob per swept session. `foldCommit` never writes
the `epic_links` / `job_links` cells itself: `syncPlanLinks` stays the
SINGLE writer and re-derives the edge from the deduped UNION of the
legacy stdout scrape AND this durable commit-trailer fact. The motivating
failure (fn-635) piped `keeper plan` stdout through `grep`, NULLing
`events.plan_op` so the scrape-only edge never formed; the commit
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
`'plan'`-source attributions, 288 in production) to the same event-relevant
union. Pass 1 (explicit attribution) was the dominant GitSnapshot cost,
not pass 4: its tool-mutation arms, bash exact-match scan, and
git-rm/git-mv deletion scan run inside a per-dirty-file loop, so fn-787
hoists the two snapshot-invariant scans (bash + deletion) and the two
tool prepared statements ONCE per snapshot — mirroring the pass-2
`computeRepoBashWindows` hoist — and matches each file in JS. fn-892 then
makes those two hoisted scans INCREMENTAL: a per-`Database` `WeakMap` memo
(`buildExplicitAttribHoist`) scans only `bash_mutation_kind IS NOT NULL AND
id > maxId` (and the git-rm/git-mv subset), appends the freshly-parsed rows
into the cached `bashByToken` / `deletionRows` structures, and bumps `maxId`
— so steady-state pass-1 cost is O(rows since the last fold), independent of
history length, instead of re-scanning the whole `events` table every
`GitSnapshot`. A cold entry's first scan is `id > 0` = the whole history
once, preserving boot-seed full fidelity. The memo is sound because the log
below head is append-only (retention only NULLs fold-unread bodies, never
the `bash_mutation_kind` / `bash_mutation_targets` columns these scans read)
and the consumer is newest-wins `(ts, id)` order-insensitive, so an
incremental append is byte-identical to a full rescan — proven by the
`test/refold-equivalence.test.ts` differential re-fold (git floor lowered to
0) and a warm-cache-vs-cold-rescan equivalence test. The memo lives only in
process memory on the live-only git surface; it is NOT a projection, never
persisted, and re-derives for free on a fresh connection.
Re-fold determinism is preserved: both the persisted set and
the bound read only event-derived state (this snapshot's
`dirty_files`, `file_attributions` populated by passes 1-3, and the
prior `git_status.jobs` blob). Per-job project-wide counters
(`git_orphan_count` / `git_unattributed_to_live_count`) broadcast onto
the bounded set only — informational-only columns (readiness reads
`git_status` scalars + per-file `dirty_files[].attributions[]`, not
the per-job columns), so the narrowed broadcast is a cosmetic shrink.
`GitRootDropped` retracts symmetrically. As of schema v79 (fn-868) the entire
git surface — `git_status`, `file_attributions`, and the three git-derived `jobs`
counters (`git_dirty_count` / `git_unattributed_to_live_count` /
`git_orphan_count`) — is a **LIVE-ONLY (live-producer-fed) projection**, NOT
replayed from history. A monotonic `events.id` SKIP-FLOOR
(`git_projection_state.floor`) no-ops every `GitSnapshot` / `Commit` / discharge
git fold for `id <= floor`, and a **boot-seed producer** (`src/git-boot-seed.ts`)
re-derives the surface for the GATED roots (open-epic `project_dir` + task
`target_repo`, via `gatedGitRoots` — not the full historical `jobs.cwd` sweep)
before the daemon serves; live events above the floor keep it current and clear
`seed_required` once every gated root is seeded (the per-root self-heal, fn-905).
To keep a reboot fast (fn-921) the boot-seed prunes a candidate whose path no
longer exists BEFORE the 2s toplevel resolve (a dead `/Volumes/Scratch/*` repo
never burns the timeout) and pre-warms the attribution memo ONCE outside the
per-root fold loop so the cold `id > 0` scan doesn't run under the seed budget.
The carve-out exists because the
`projectGitStatus` git fold historically re-scanned the WHOLE event log per
`GitSnapshot` (the pass-1 bash + git-rm/git-mv scans, now memoized incrementally
by fn-892; `computeRepoBashWindows`'s pass-2 self-join stays bounded by
`MAX_BASH_WINDOW_SEC`) — an O(history)-per-event fold whose replay cost grew
without bound (the fn-856 incident: a 4.3M-event re-fold projected to ~6 days).
The memo keeps a LIVE fold incremental but does NOT make the surface re-fold
safe — it stays live-only because a cold re-fold's first scan is still the whole
history and the producer-fed git counters are deliberately charter-excluded.
The general rule it codifies: any projection whose per-event fold cost grows with
history length is a replay time-bomb — model it live-only or constant-bounded,
never O(history)-per-event. The re-fold byte-identical determinism described
throughout this section is therefore scoped to the **deterministic-replayed**
projections (the sacred default — `jobs`/`epics`/`commit_trailer_facts`/…); the
git surface is DELIBERATELY excluded from that charter via the central
`LIVE_ONLY_PROJECTIONS` / `LIVE_ONLY_JOBS_COLUMNS` registry (`src/db.ts`), and a
rewinding migration RESETS its floor + sets `seed_required` (via
`rewindLiveProjection`) rather than replaying it — the live surface is never
wiped-and-replayed alongside the deterministic ones. As of schema v83 (fn-907)
the same live-producer-fed class covers a SECOND surface: the two tmux
location columns on `jobs` — `backend_exec_session_id` (the pane's CURRENT tmux
session) and `window_index` (its left-to-right visual position). The persistent
`tmux -C` control worker (epic fn-968 — the tenth worker) reads the whole-server
pane set over its existing framed re-read and mints one authoritative
`TmuxTopologySnapshot` event; a live-only fold keyed on
`(generation_id, pane_id)` overwrites those two columns in real time on any
out-of-band `break-pane`/`move-window`, gated above
`tmux_projection_state.floor` (a singleton `floor` + `seed_required` mirroring
`git_projection_state`, boot-seeded after the drain before the actuator gate).
Both columns join `LIVE_ONLY_JOBS_COLUMNS` and are charter-excluded; the FROZEN
launch session is demoted to a forensic `backend_exec_birth_session_id`, and
crash-restore + dash grouping COALESCE `backend_exec_session_id` onto the birth
column so an unresolved live session never shrinks the restorable set or
mis-groups a card. The **ephemeral** class
(fn-870, `EPHEMERAL_PROJECTIONS` — currently just `pending_dispatches`) is a third
charter exclusion: in-flight runtime state that IS folded by the boot drain but
`truncateEphemeralProjections` empties AFTER the drain and BEFORE serving, so the
runtime set is rebuilt from current reality at boot rather than replayed (NOT in
the re-fold wipe list, NOT byte-identical). As of
schema v32 (fn-634, narrowed at v63/fn-756), `epics` adds
`default_visible` as a VIRTUAL generated column SQLite computes from
`CASE WHEN status='open' THEN 1 ELSE 0 END`,
materializing the descriptor's default scope as a single
0/1 derived value; a partial composite index
`idx_epics_default_visible ON epics(default_visible, epic_number, epic_id)
WHERE default_visible = 1` serves the default no-wire-filter query as
a covering SEARCH (no SCAN, no temp B-tree for the
`epic_number ASC, epic_id ASC` ORDER BY — fn-936 reshaped it off the
dropped `sort_path`) — collapsing the Tier 4
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
`resolved_epic_deps` alongside `tasks` / `jobs` / `job_links` so a
file-content re-observation can't wipe the projection-derived dep resolution.
As of schema v35 (fn-642, corrected at v42/fn-662), the `usage`
projection colocates the Claude rate-limit annotation:
`last_rate_limit_at` + `last_rate_limit_session_id` are populated
server-side by a bidirectional fan-out against the matching `profiles`
row, joined on the derived `profile_name = projectBasename(config_dir)`
column (`profiles.profile_name = usage.id`). The forward direction
lives in the `RateLimited` / `ApiError(kind='rate_limit')` arm — a
pure UPDATE against `usage WHERE id = <profile_name>` (never UPSERT, so
a rate-limit on a profile agentusage isn't tracking does NOT mint a
phantom usage row). The reverse direction lives in `projectUsageRow`:
the existing UPSERT carves the two rate-limit columns OUT of the
`ON CONFLICT(id) DO UPDATE SET` clause (so a re-snapshot can't clobber
the annotation), then a post-UPSERT SELECT against `profiles` pulls
the current state forward. The shared directional mapping helper pair
(`usageIdForProfileName` / `profileNameForUsageId` in
`src/epic-deps.ts`, schema v42/fn-662) translates keeper's `''`
default-profile sentinel (default `~/.claude`, basename `""`) to
agentusage's `"default"` usage id at the join boundary in both directions:
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
tmux session gets its LIVE session name filled later by the control-worker's
`TmuxTopologySnapshot` feed, epic fn-968), `TMUX_PANE` → `backend_exec_pane_id` (raw; no fork, no fs, no
PPID-walk; absent env ⇒ NULL coords, never a bogus `type`). The pane id is a
two-step read: native `TMUX_PANE` first, else the keeper-owned carrier
`KEEPER_TMUX_PANE` (the launcher strips `TMUX`/`TMUX_PANE` to let Claude emit
truecolor, copying the pane id into the carrier first so window renaming
survives the strip; the carrier-fed fallback stamps coord-identical tmux rows).
And the reducer's
`applyEvent` arm folds `type` + `pane_id` onto
`jobs.backend_exec_{type,pane_id}` latest-non-NULL-wins via
`COALESCE`, so a re-fold from cursor=0 reproduces byte-identical rows. The
generic `backend_exec_*` naming keeps a further backend slotting in with only
the hook's env-name table changing. As of schema v83 (fn-907) the frozen
`KEEPER_TMUX_SESSION` env folds onto the forensic
`jobs.backend_exec_birth_session_id` (the launch coordinate), and the LIVE
`jobs.backend_exec_session_id` is a live-only column the `TmuxTopologySnapshot`
fold owns — both display-only on `JOBS_DESCRIPTOR`. Crash-restore + dash grouping
read `COALESCE(backend_exec_session_id, backend_exec_birth_session_id)` so an
unresolved live session falls back to the launch session. The four backend
`jobs.backend_exec_*` columns
(`type`, `session_id`, `birth_session_id`, `pane_id`) are display-only on
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
As of schema v94 (fn-997), each job carries a durable `worktree` marker
recording the git lane BRANCH it ran in (`keeper/epic/<id>` for a
base/inheriting/closer lane, `keeper/epic/<id>--<task>` for a forked rib). The
branch is captured exactly like `config_dir`: the producer injects it as the
`KEEPER_PLAN_WORKTREE_BRANCH` launch env (a third always-emitted `--x-tmux-env`
beside the path env `KEEPER_PLAN_WORKTREE`, so a serial launch reusing a tmux
session overwrites any stale branch), the hook reads pure `process.env` at
`SessionStart` into `events.worktree` (empty/whitespace/unset → NULL), and the
reducer's SessionStart `INSERT … ON CONFLICT … COALESCE(excluded.worktree,
jobs.worktree)` arm folds it set-once onto `jobs.worktree` — so a resume
(emitting NULL) preserves the first-launch branch and a from-scratch re-fold
reproduces byte-identical rows. The BRANCH is stored, not the lane PATH: the
path `~/worktrees/<base>-<dirhash>--<slug>` embeds a provision-time dirhash and
is torn down at finalize, while the branch is a stable joinable identity that
survives `git worktree remove`/`move`. `jobs.worktree` is display-only on
`JOBS_DESCRIPTOR`; the shared `projectJobRow` helper lifts it into a `[⑂ <branch
minus keeper/epic/>]` lane pill (NULL → no pill). keeper-py's
`SUPPORTED_SCHEMA_VERSIONS` frozenset gains `94` (whitelist-only; keeper-py never
reads the `worktree` column).
As of schema v47 (fn-667), the autopilot pause/playing flag is event-sourced
into a new singleton `autopilot_state` projection table (`id INTEGER PRIMARY
KEY CHECK (id = 1)`, `paused INTEGER NOT NULL`, plus `last_event_id` /
`created_at` / `updated_at` per the standard projection discipline). Main
mints `AutopilotPaused{paused:boolean}` synthetic events via the
`set_autopilot_paused` RPC bridge, which appends the event FIRST then
flips the in-memory worker gate only on a successful insert — so the gate
and the projection cannot diverge on partial failure. The daemon does NOT
re-pause at boot: after the boot drain reaches head it READS the durable
`autopilot_state.paused` column and seeds the in-memory `autopilotPaused`
flag (and the autopilot worker's boot flag) from it, so the daemon resumes
its last durable state — an intentional `play` survives a restart (boots
PLAYING). On a fresh board with no `AutopilotPaused` history the singleton
materializes from the `AutopilotCapSet` boot-append's INSERT path
(`VALUES (1, 1, …)` → `paused=1`), so the daemon defaults to PAUSED and a
viewer subscribing the instant the socket opens still reads a real row,
never an empty surface. The reducer's `foldAutopilotPaused` arm UPSERTs on
the singleton id and preserves `created_at` through subsequent flips
(mirrors `foldDispatchFailed`'s "first observation" semantic). A
from-scratch re-fold reproduces the row byte-identically (no `Date.now`,
no env reads, no `jobs` SELECT — `created_at` and `updated_at` both derive
from `event.ts`); removing the boot-time `AutopilotPaused` re-arm keeps
that byte-identity intact because real `paused` history folds the durable
value and the `AutopilotCapSet` INSERT carries the no-history default. The
`keeper autopilot` viewer subscribes the singleton via
`subscribeCollection({collection: "autopilot_state"})` and drives its
`[paused]` / `[playing]` banner from the folded `paused` column —
replacing the pre-fn-667 hardcoded `state.paused = true` which made the
banner ALWAYS read `[paused]` even while the worker was actively
dispatching (the divergence bug this epic fixes). keeper-py's
`SUPPORTED_SCHEMA_VERSIONS` frozenset
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
behavior and satisfies the NOT NULL constraint for the daemon's
`AutopilotCapSet` boot re-arm INSERT (the cap arm binds no `mode`). Main mints
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
(fn-770) the per-root round-robin allocator inside `computeReadiness`. The
reconcile worker computes the eligible-epic closure (`computeEligibleEpics`)
ONCE per cycle — only when `mode === 'armed'` (yolo pays no BFS) — and passes
the SAME Set to both `computeReadiness` (a trailing-optional `eligibleEpicIds?:
Set<string>`, threaded into `applyPerRootRoundRobinAllocator`) and the
`work`-gate. The allocator's discretionary fill is eligibility-aware: an
ELIGIBLE epic's ready task claims a free root slot BEFORE an earlier-sorted
INELIGIBLE sibling can (pass-2a fills eligible epics on every root first, pass-2b
the residual), fixing the armed-mode deadlock where an unarmed epic captured the
sole per-root slot in sort order and the `work`-gate then suppressed the armed
epic that lost (net: the armed epic never dispatched). The param is ABSENT
(`undefined`) in yolo — single unfiltered fill — and PROVIDED (even empty:
armed-but-nothing-armed) in armed mode; the discriminator is `!== undefined`,
never `.size === 0`. Pass-1 physical occupancy (live workers + launch-window
fallback roots) stays eligibility-blind so an eligible task never preempts a live
worker, and close rows settle with the same eligibility gate (an ineligible
`ready` close neither claims nor demotes) so a finalizer is never starved. The
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
The scalar autopilot CONFIG settings are RUNTIME-settable through ONE generic
RPC. `set_autopilot_config` takes a PARTIAL patch of the scalar config columns
(today just `max_concurrent_jobs`, extensible without a new RPC) and round-trips
a single `AutopilotConfigSet` synthetic event; `foldAutopilotConfigSet` UPSERTs
the `autopilot_state` singleton setting ONLY the patched columns and PRESERVING
the rest (`paused` / `mode` / any unpatched config column) — the same
preserve-siblings discipline every singleton fold follows. The concurrency cap is
NO LONGER config-file-frozen: `max_concurrent_jobs` is dropped from
`resolveConfig`/`KeeperConfig`, its default becomes the in-memory
`DEFAULT_MAX_CONCURRENT_JOBS` (`null` = unlimited), and the daemon's old
`AutopilotCapSet` boot-append is REMOVED (the `AutopilotCapSet` fold arm survives
for historical replay only — never minted). A fresh board simply has NO
`autopilot_state` row: the reconciler + viewer resolve `max_concurrent_jobs ??
DEFAULT` and the in-memory boots-paused default carries `paused`, so the row
materializes lazily on the first pause/play/mode/config event (its INSERT path
defaults `paused=1`). The reconcile worker reads the cap FRESH from the projection
each cycle (`loadReconcileSnapshot` → `state.maxConcurrentJobs`, refreshed before
`reconcile` reads it), so `keeper autopilot config max_concurrent_jobs N` takes
effect on the next tick and survives a restart. No schema bump: the
`max_concurrent_jobs` column already exists (v60).
As of schema v65 (fn-784), the nullable `jobs.active_since REAL` column is a
"most-recent-activity-started" recency stamp — `event.ts` written ONLY on the
rising edge into `working` (the UserPromptSubmit arm's `state != 'working'`
guard, NOT `active_since IS NULL`), so it advances on a genuine
stopped/terminal→working restart and HOLDS through mid-run churn (the explicit
`ELSE active_since` branch). The migration adds the column NULL with NO backfill
— backfilling from `updated_at` ("last touched") would conflate it with "run
started" and is non-deterministic; a never-prompted job stays NULL. It seeded
the original `keeper dash` AGENTS timeline ordering; the robot job-card dash
orders cards by live tmux `window_index` within session bands and no longer reads
it, so the column is now display/sort metadata only. keeper-py's
`SUPPORTED_SCHEMA_VERSIONS` frozenset gains `65` (whitelist-only; keeper-py does
not read `active_since`).
As of schema v67 (fn-807), the `commit_trailer_facts` reducer projection
(`event_id` PK; `committer_session_id` / `plan_op` / `plan_target` /
`plan_epic_id` / `committed_at_ms`) is the de-blobbed read path for the
commit-trailer channel of `syncPlanLinks`: `foldCommit` writes one row per
trailer-bearing `Commit` in its own transaction, and the loader reads the table
`ORDER BY event_id ASC` instead of re-scanning every `Commit` blob once per
swept session. It derives from `Commit` events ALONE, so the v66→v67 migration
backfills it (through the same `extractCommit` + `parsePlanRef` JS path the fold
uses) WITHOUT a cursor rewind, and a from-scratch re-fold reproduces it
byte-identically. (Commit is keep-set, so its body is always inline in
`events.data`; the v67 backfill's historical `COALESCE` over the
since-shed `event_blobs` table now resolves the inline value during the
0→latest ladder walk that transiently recreates the table.) keeper-py's
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
keeper-py does not read either column). As of schema v83 (fn-907) `window_index`
becomes a LIVE-ONLY column re-derived by the `TmuxTopologySnapshot` fold (keyed
on `(generation_id, pane_id)`) so it tracks an out-of-band `move-window` live;
the `WindowIndexSnapshot` fold is retained as an explicit no-op arm (a historical
event must not re-route into the projection, preserving the deterministic re-fold
of the OTHER columns).
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
embedded fact to occupy
a per-epic / per-root allocator slot while a stopped session's backgrounded suite
is still running, with the embedded job's `updated_at` (bumped by the
monitors-only Stop write) as the staleness lease anchor.
keeper-py's `SUPPORTED_SCHEMA_VERSIONS` frozenset gains `59`
(whitelist-only; keeper-py reads neither `jobs.monitors` nor the embedded
occupancy fact).
As of schema v50 (fn-678), the new `pending_dispatches` projection table
(keyed by `(verb, id)`) is the durable launch-window occupancy signal that
replaced the fn-674 live tab-name probe. A `Dispatched` synthetic
event UPSERTs a row (`dir`, `dispatched_at`, `last_event_id`); a
`SessionStart` fold DELETEs by the same key (discharge-on-bind) when the
session binds its `(plan_verb, plan_ref)` pair — on the spawn-INSERT or on a
NULL->non-NULL heal of a fork-seed row, but never on a genuine resume whose
pair was already bound (that must not clear a re-pending dispatch); a
`DispatchExpired` synthetic event DELETEs the key when the TTL sweep fires.
The SAME discharge-on-bind fold that DELETEs the pending row SEEDS the bound
worker's `state='stopped'`, `plan_verb`-bearing `jobs` row, which readiness reads
as the `bound-pending` occupancy continuation (fn-924) — so the per-epic/per-root
mutex hold passes unbroken from `dispatch-pending` (pre-bind) to `bound-pending`
(bound, not-yet-active) to a `running` verdict (first activity), closing the
launch-window leak where a same-root sibling co-dispatched during the discharge.
`DispatchFailed` also DELETEs the pending row so a failed dispatch does not
block the failure as permanently occupied. As of fn-870, `pending_dispatches`
is an EPHEMERAL projection (`EPHEMERAL_PROJECTIONS`): it is folded by the boot
drain like any projection (the global cursor must advance for the deterministic
ones), but `truncateEphemeralProjections` runs AFTER the drain and BEFORE serving
so the in-flight set starts EMPTY every boot — the autopilot re-derives genuine
in-flight launches from live `jobs`/tmux panes. It is therefore NOT replayed from
history and is DELIBERATELY EXCLUDED from the byte-identical re-fold charter (the
prior "re-fold reproduces the table byte-identically" claim no longer holds, and
must not: a rewinding migration's full re-fold would otherwise RESURRECT weeks-old
phantoms that consume the dispatch budget + per-root mutex — the v76→v79 jam where
5 phantoms BLOCKED-by-`dispatch_failures` starved all dispatch). keeper-py's
`SUPPORTED_SCHEMA_VERSIONS` frozenset gains `50` (whitelist-only).

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
the reap never threw (no-self-heal). That broad pause/boot reap is gone; keeper
closes no managed windows automatically — the operator garbage-collects
completed windows by hand.
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
As of schema v76 (fn-846), a never-bound circuit breaker closes the original
pile-up amplifier: a worker the reconciler dispatches that SPAWNS but never
BINDS (no `SessionStart` for its `(verb, id)` pair) used to TTL-expire,
re-dispatch, and expire again forever. The new `dispatch_never_bound`
projection table (keyed `(verb, id)`) folds a per-pair consecutive-
`DispatchExpired`-without-bind counter: `foldDispatchExpired` increments it (the
`pending_dispatches` DELETE that releases the re-dispatch slot is UNCHANGED, so
the count lives on its own row, not the deleted pending row), and at K=3 mints a
sticky `dispatch_failures(reason='never-bound')` the EXISTING `failedKeys` arm
suppresses — no readiness or retry-worker change. A successful bind (the
discharge-on-bind gate) and a `DispatchCleared` (`keeper autopilot retry`) each
reset the counter to zero, so a bind between expires never trips the breaker and
a "bound-then-died" worker (the exit-watcher's path) never counts toward
never-bound. The bump/reset fold purely from the `DispatchExpired` + bind +
`DispatchCleared` event stream (no wall clock), so a from-scratch re-fold of
`dispatch_never_bound` is byte-identical (empty table on a pre-v76 log).
fn-870 hardened two failure modes in this lifecycle. (1) The TTL sweep
(`selectExpiredPendingDispatches`) now expires an aged `pending_dispatches` row
UNCONDITIONALLY on `dispatch_failures` membership — the prior `WHERE df.verb IS
NULL` guard was a "suppressed sweep" deadlock: a pending that tripped the
never-bound breaker (which mints a sticky `dispatch_failures` row) could NEVER be
expired, so it held its launch-window slot + per-root mutex forever (the root
cause of the v76→v79 jam). The expiry DELETE is idempotent with a concurrent
`DispatchFailed` fold, so re-including those rows cannot corrupt the projection.
(2) To keep the now-unconditional sweep from re-tripping the breaker,
`foldDispatchExpired` SKIPS the counter arm when the key already has a
`dispatch_failures` row — an expiry of an already-failed key is a slot release,
not a target failure. fn-870 also widens `foldDispatchCleared` to DELETE the
`pending_dispatches` row alongside the failure + counter, so an operator clear
immediately frees the slot. keeper-py's `SUPPORTED_SCHEMA_VERSIONS` frozenset
gains `76` (whitelist-only; keeper-py reads neither `dispatch_never_bound` nor
`dispatch_failures`).
As of schema v77 (fn-856), the plan-link classifier is ungated from the
`/plan:plan` time-window model: a session that never invokes `/plan:plan` used
to have zero windows, so every plan op it made was silently dropped — leaking
three populations (closers that scaffold their follow-up epic via
`close-finalize`, pre-first-opener scaffolds, and `/plan:defer` /
direct-CLI edits). The measured cost on the live DB: `epics.job_links` empty for
~1013/1020 epics and `created_by_closer_of` set for 0/1020 (the
`[slotted-after-closer]` pill had never once fired). The classifier now links
EVERY epic-mutating op as creator/refiner regardless of timing, keeping only the
read-only (`subject_present=false`) gate, with per-session (not per-window)
creator-suppression and a `(ts, event_id)` total-order sort for re-fold
determinism. Because the fold output changed, the migration REWINDS the cursor
and wipes the canonical projection list (same set as v42) so the corrected
derive repopulates every epic; a from-scratch re-fold reproduces byte-identical
`epics.job_links` / `created_by_closer_of` rows. keeper-py's
`SUPPORTED_SCHEMA_VERSIONS` frozenset gains `77` (whitelist-only; keeper-py reads
`jobs` / `epics` over the socket, not the classifier internals).
As of schema v80 (fn-881), the plan-link classifier EXCLUDES the worker's `done`
op and the closer's `close` op: since v77 every epic-mutating op grafts, so each
epic carried one `creator` plus a pile of `refiner` edges that were actually every
autopiloted `/plan:work` worker (`keeper plan done`) and the `/plan:close` closer
(`keeper plan epic close`) — redundant with the task rows and self-evident from the
job title's `work::` / `close::` spawn-name prefix. `classifyEntry` now returns
null for `op === "done"` / `op === "close"` (after the read-only gate, before the
creator/refiner branches), so `refiner` means only genuine plan-shaping edits
(`refine-apply`, `epic set-*`, deps, direct CLI). Because
the fold output changed, the migration MIRRORS the v77 rewind/wipe block but RAISES
the git skip-floor instead of resetting it to 0 (preserving the v79 git carve-out so
the cursor-0 re-fold drain no-ops historical git folds), so the deterministic link
projections re-fold byte-identically and `created_by_closer_of` lineage stays intact.
keeper-py's `SUPPORTED_SCHEMA_VERSIONS` frozenset gains `80` (whitelist-only).
As of schema v81 (fn-888), `syncPlanLinks` re-derives `epics.job_links` with an
idempotent per-SESSION replace-by-key merge (the shared `mergeJobLinkSlice` helper)
instead of the old per-epic full cross-session sweep, so the fold's per-event cost is
independent of sessions-per-epic AND board size — disarming the O(board)-per-event
replay time-bomb (the old sweep re-derived a touched epic over EVERY session that had
ever touched it, an O(touched_epics × swept_sessions) fan-out that turned a
cursor-rewinding migration into a ~15-min socket-down catch-up with a 3–4 GB WAL). The
new logic is byte-identical to the old PER EVENT, so the fold change (task .1) lands
WITHOUT a rewind or storm. This bump's rewind-and-redrain (task .2) is justified by
convergence + self-validation, NOT defensiveness: it CONVERGES every historical
`epics.job_links` cell under the new code path, and it is SELF-VALIDATING — the
cursor-0 re-fold that previously took ~15 min now completes in ~1–2 min under the
constant-bounded fold, proving the time-bomb is disarmed. The migration MIRRORS the v80
rewind/wipe block exactly: cursor→0, the deterministic projection list wiped (`jobs` /
`epics` / …), `commit_trailer_facts` DELIBERATELY preserved (a derive INPUT rebuilt
byte-identically from id 0 by the `INSERT OR IGNORE` `foldCommit`), the git skip-floor
RAISED to `max(events.id)` (not reset to 0 — that re-arms the v79 git time-bomb), and
the ephemeral / autopilot tables replicated so the re-fold cannot resurrect a phantom
`pending_dispatches` dispatch jam. keeper-py's `SUPPORTED_SCHEMA_VERSIONS` frozenset
gains `81` (whitelist-only; keeper-py reads `jobs` / `epics` over the socket, not the
fold internals).
As of schema v41 (fn-651), the `usage` projection tells the truth about
WHEN a rate-limited profile unblocks AND whether its numbers are fresh.
Two additive nullable columns ride the existing `UsageSnapshot`
percentage path. `rate_limit_lifts_at TEXT` is folded from the agentusage
envelope's new top-level `lift_at` field — agentusage computes it as the
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
(agentusage paused polling a maxed account until its lift, freezing the
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
fan-out rides alongside: every `plan_op != NULL` event AND (epic fn-695,
schema v54) every `Commit` event carrying the `Planctl-Op` / `Planctl-Target`
/ `Session-Id` trailers triggers the `syncPlanLinks` helper, which
re-derives the triggering session's `jobs.epic_links` from its `keeper plan`
footprint — the deduped UNION of the legacy stdout-scrape rows and the durable
commit-trailer facts — and merges that session's slice into each touched epic's
`epics.job_links`. Ops are classified unconditionally (no time window): every
epic-mutating op links as creator (`epic-create` OR `scaffold` with an
epic-shaped target — scaffold is the canonical epic-create path on this
codebase) or refiner (any other epic-touching mutation), gated by the read-only
`subject_present` skip AND the v80 (fn-881) autopilot-op exclusion that drops
the worker's `done` and the closer's `close` op so `refiner` means only genuine
plan-shaping edits. The classifier sorts on a `(ts, event_id)` total order so
per-session creator-suppression (a session that scaffolds AND refines the same
epic emits ONE creator edge) is deterministic on `ts`-ties. The per-epic
`epics.job_links` update is an idempotent per-SESSION replace-by-key merge
(the shared `mergeJobLinkSlice` helper, also used by the `syncJobLinksOnJobWrite`
reverse fan-out): drop every entry whose `job_id` is the triggering session,
splice that session's freshly-derived + enriched slice, preserve every OTHER
session's entry verbatim, re-sort on the locked `(kind, job_id)` total order.
Preserving other sessions' entries verbatim is byte-identical to the old full
re-derive because the enrichment-freshness invariant holds — every jobs-write
that changes an enriched display column (`title` / `state` / `last_*`) already
fans out via `syncJobLinksOnJobWrite` to re-stamp the matching entry — so the
merge's per-event cost is independent of how many sessions ever touched the epic
AND of board size (a static source-text guard in `test/refold-equivalence.test.ts`
pins the invariant). An ORPHAN invocation (no backing `jobs` row — a session
with no SessionStart yet) has no per-session pre-state to diff, so it retains the
full cross-session sweep (the path choice is deterministic per event id).
The commit-trailer side reads the indexed `commit_trailer_facts` projection
(schema v67, fn-807) — `foldCommit` writes one fact row per trailer-bearing
`Commit` in its own transaction — the normal path reading only the triggering
session's slice via `idx_commit_trailer_facts_session`, the orphan path loading
the whole projection ONCE (instead of re-scanning every `Commit` blob per swept
session, the fold fan-out the projection retired).
`syncPlanLinks` stays the SINGLE writer of both cells; `foldCommit` only
triggers the rebuild, never writes the edge directly. The commit channel
makes the edge survive any stdout pipe / `grep` / truncation that NULLs
`plan_op` (the fn-635 failure) plus client + server reboots. Both fan-outs run INSIDE the same `BEGIN IMMEDIATE` transaction
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

A **fifth** Worker thread is the usage CONSUMER: it watches the flat leaf
usage state directory (`~/.local/state/agentusage/`, one `<id>.json` per
account) with `@parcel/watcher`, safe-parses each changed file, and posts a
`usage-snapshot` message to main (and a `usage-deleted` tombstone when a file
vanishes). The envelopes it folds are written by the in-keeper usage-scraper
PRODUCER worker (below). Main — again the sole writer — turns each
into a synthetic `UsageSnapshot` (or `UsageDeleted`) events row and pumps a
wake; the reducer folds it as an idempotent upsert into the flat `usage`
projection (one row per profile; deletes via tombstone). As of schema v23
the `usage` table lands alongside the existing collections, indexed via
the same descriptor + REGISTRY entry pattern as `git`. Freshness fields
(`fetched_at` / `next_fetch_at` / `last_successful_fetch_at` /
`last_skipped_fetch_at`) are read-and-discarded at the worker boundary and
excluded from both the change-gate and the projection schema, so the ~90s
agentusage fetch loop produces zero events when no content moved. Like the
transcript + plan producers, this is read-only / write-free, feeding the
log only via main, and the watcher subscription is released in the
worker's own shutdown handler. The producer also self-recovers from a
*dropped-events* FSEvents overrun via a debounced single-flight re-scan
of the existing change-gated boot-scan path.

Feeding that consumer is the usage-scraper PRODUCER worker (`src/usage-scraper-worker.ts`):
keeperd both produces AND consumes the per-account Claude/Codex usage data. It is
wired like the builds poller (a non-watcher, config-gated poll producer, NOT a
`@parcel/watcher` member) and is gated on a resolvable runtime — an absolute `uv`
binary path (`usage_scraper_uv_path`) plus the agentusage project dir
(`usage_scraper_project_dir`); an unresolved runtime leaves the worker un-spawned
(a warning, never a `fatalExit`). When spawned it runs N concurrent per-account
async loops sharing a global profile-gate (launches ≥60s apart) and a per-target
mutex, on a 60–180s jitter cadence. Each cycle re-resolves the account's
tier→multiplier and runs the idle/cooldown gates, then shells out via the scrape
runner —
`<uv> run --directory <agentusage> python -m agentusage.scrape_cli …` — to the
stateless Python scrape util, which `pexpect`-spawns the real `claude`/`codex` TUI
(direct, with `CLAUDE_CONFIG_DIR` set — no `keeper agent`, no hook, no job),
`pyte`-renders the `/usage`|`/status` panel, parses it, and prints one
discriminated `{ok|error}` JSON object. The worker assembles the envelope
(producer-side wall-clock owns `multiplier`, `next_fetch_at`, `last_*_fetch_at`,
and the fresh-derived `lift_at`) and atomically writes the `<id>.json` envelope (+
`<id>.error.json` sidecar + `events.jsonl` audit line) the consumer above folds.
The whole cycle is no-throw: a scrape/IO failure writes a `stale` envelope and an
`.error.json`, never crash-loops. The tier→multiplier re-resolves on its own ~60s
sub-cadence INDEPENDENT of cooldown/idle parking: the no-scrape sleeps
(cooldown/idle/restart) are capped at that poll so a depleted account that parks
for days still re-resolves its multiplier every minute (post-scrape backoffs —
notably the /usage rate-limit retry — stay long, never capped), and a multiplier
change vs the on-disk envelope breaks BOTH gates early to force a scrape. An mtime
memo keeps the multi-MB `.claude.json` re-read free, and a redundant parked re-write
(already idle at the same multiplier) is suppressed so a long park doesn't grow the
log. It writes ONLY this on-disk surface (its
read-only keeper.db handle is the worker-contract convention; main stays the sole
event writer). A singleton `scraper.lock` FileLock on the state dir means two
producers never race the same files, so the worker simply un-arms if a lock is
held. `KEEPER_AGENTUSAGE_ROOT` moves the producer + consumer + the vendored
picker's ledger off the real state dir together (the test-isolation seam).

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
divergence) and stamps `dispatch-pending` at a late per-row rank. When the
worker's `SessionStart` binds its `(plan_verb, plan_ref)` pair it discharges the
pending row — including the fold-order case where the worker's
`UserPromptSubmit` folded first and minted a NULL-pair fork-seed row, which
COALESCE-heals on the SessionStart (so the slot never strands). **fn-924 closes
the launch-window leak across that discharge:** the bind drops the
`dispatch-pending` signal, but the worker's `running` hold only engages at FIRST
ACTIVITY (its first `UserPromptSubmit` flips the `jobs` row `stopped → working`),
so a same-root sibling used to slip through the ~sub-second gap and race the one
shared working tree (pinned 2026-06-23 via event-replay). The SAME atomic
SessionStart fold that discharges the pending row SEEDS a `state='stopped'`,
`plan_verb`-bearing `jobs` row, so a read-time `bound-pending` per-row verdict
(ranked immediately after `dispatch-pending`) takes over the hold the instant
`dispatch-pending` vanishes — every snapshot shows EITHER `dispatch-pending` OR
`bound-pending` (or, once active, a `running` verdict), never a gap. The
disambiguator against over-holding a stopped-after-working / dead worker is
`jobs.active_since` (carried free on the embedded element, JSON-cell-only): it is
NULL only until the first `stopped → working` edge, so `bound-pending` fires
exclusively for a never-yet-active bound worker. Both `dispatch-pending` and
`bound-pending` pre-consume a per-epic AND per-root slot in the round-robin
allocator (`isLiveWorkOccupant` → auto-covers `isRootOccupant`), so the
allocator grants only the REMAINING `N − occupied` slots — demoting a same-epic
OR same-root ready sibling once the slots fill. A pending row matching no
snapshot row occupies its root via its own `dir` column (root-fallback). The pre-existing same-`(verb, id)` `liveTabKeys.has(key)`
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
serial wait still covers the intra-cycle race and stays in place. A SECOND
main-thread heartbeat producer rides the same gate-armed `setInterval` shape: the
**block-escalation producer** (`runBlockEscalationSweep`,
`BLOCK_ESCALATION_SWEEP_INTERVAL_MS`, 60s, fn-941). When a plan task is stamped
`runtime_status='blocked'` the `TaskSnapshot` fold arms the deterministic-replayed
`block_escalations` escalate-once latch (v86); each sweep walks the `pending` rows
(`selectPendingBlockEscalations`, a current-state working set), re-checks the task
is still blocked (cancellation guard), reads `blocked_reason` from the plan state
file (producer-side fs read, never a fold), and escalates to the task's
`planner@<epic>` over the Agent Bus — gated by a DENYLIST (every category escalates
except `TOOLING_FAILURE` and an absent/unparseable reason) and COALESCED per
recipient (one send per planner per cycle). A surface-and-stop skip (the DENYLIST
branch) additionally mints a sticky `DispatchFailed` on `work::<task>` ONCE, so the
existing `failedKeys` reconcile arm DURABLY suppresses cold re-dispatch independent
of the transient `runtime_status='blocked'` flag and `block_escalations` latch (both
deleted on leave-blocked) — a `TOOLING_FAILURE` is permanent, not transient, and
requires human recovery. Cleared only by `retry_dispatch` (the human-cleared
`failedKeys` contract: `keeper plan unblock` flips the board, `keeper autopilot
retry work::<task>` clears the guard so the resolved task re-dispatches). It mints
`BlockEscalationRequested`
(latch `pending→requested`), spawns a short-lived one-way CLI helper ASYNC (`keeper
bus chat send` with the body via stdin so the free-text reason is never
shell-interpolated, + `keeper bus wake` on `queued_for_wake`), then mints
`BlockEscalationAttempted{outcome}` (latch `requested→attempted`) — escalate-once
per block instance, fail-open per `runWake`'s injectable-deps discipline. The
planner then resolves the blocker, unblocks on the board (`keeper plan unblock`),
and resumes the work via two ordered paths. PRIMARY: the `/plan:work` orchestrator
session that stamped the block ends its turn but stays reachable (its `keeper bus
watch` inbox armed); the planner bus-sends `work::<task>` a resume directive, and
that live session re-enters its Phase 2b warm-resume to continue the original
worker subagent in-context. FALLBACK: a miss on that send (`not_connected`/
`unknown_target`) means the orchestrator session is gone, so the board-unblock lets
the autopilot cold-re-dispatch a fresh worker — gated against double-dispatch by
the live-pane occupancy gate (`isOccupyingJob`), which suppresses re-dispatch while
the worker pane lives. The reconciler boots PAUSED (the in-memory
worker gate is seeded `true` from `workerData.paused`, and the daemon's
boot drain unconditionally appends an `AutopilotPaused{paused:true}`
synthetic event so the durable `autopilot_state` singleton projection
also boots paused — schema v47 / fn-667; safe-by-default after restart
is maintained by the boot-append re-arm event, not by flag volatility)
and flips on the `set_autopilot_paused` RPC, which appends an
`AutopilotPaused{paused}` event FIRST then flips the worker gate only
on a successful insert (so the gate and the projection cannot diverge
on partial failure). The terminal-surface mechanics live in
`src/exec-backend.ts`. keeper launches in-binary: both the autopilot reconciler
dispatch and the manual `keeper dispatch` re-exec the `keeper agent
<claude|codex|pi>` subcommand (which owns the tmux window) — the in-binary
launcher is the sole launch path (keeperd probes its launchability at boot). tmux
is used DIRECTLY only for the pane ops
(`createTmuxPaneOps` — `focusPane`, `listPanes`/`renameWindow` for the renamer);
keeper closes no managed windows automatically, so there is no sweep-close
path. Crash-recovery restore (`restore-agents.ts`) and bus wake both ride the
SAME in-binary launcher in resume mode (`agentwrapLaunch` with a `resumeTarget` —
agentwrap get-or-creates the recorded session and re-attaches via
`--resume <target>`), so there is ONE launch transport, not a second
shell-wrapper replay. Each reconciler dispatch opens as a new window in the
hardcoded managed session (`autopilot`); the pane ops run a cheap
per-call `has-session` probe and mint via `new-session -d` only when the
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

The **`cli/pair.ts` codex pre-launch trust-seed** writes codex's own config dir
(`${CODEX_HOME:-~/.codex}/config.toml`) — the only partner that needs a seeder.
Before a codex pair/panel partner launches as an interactive TUI,
`ensureCodexDirTrust` (`src/codex-trust.ts`, a dep-free leaf) seeds
`[projects."<realpath(cwd)>"] trust_level = "trusted"` so the detached window does
not hang on codex's directory-trust prompt. It is exact-header idempotent (trust
is NOT inherited), takes an O_EXCL lock + post-acquire re-check for concurrent
launches, and FAIL-OPEN (never throws, never blocks the launch;
`KEEPER_CODEX_TRUST_LOG` overrides the log path). A **pi** partner has the
analogous directory-trust prompt but gets NO seeder: the launch passes pi's
per-run `-na` (`--no-approve`) flag, which ignores the cwd's project-local `.pi/`
resources and so never triggers the prompt. pi's `trust.json` is a shared profile
path (state-sharing), so a seeder would collide there — `-na` replaces it.

keeper closes no managed windows automatically: a keeper-created window stays
open after its work stops — the operator garbage-collects completed windows by
hand. The pending-dispatch row discharges on `SessionStart` or the 120s TTL
sweep (above). The close-row
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

The reconciler also carries a durable **worktree mode** (the `worktree_mode`
column on the `autopilot_state` singleton, default OFF — byte-identical to today
when off, set at runtime via fn-953's generic `set_autopilot_config` patch with
NO new RPC, and read fresh each cycle). It is entirely mechanical and lives
ONLY in the producer path (`runReconcileCycle`), never in a fold — a fold may
not read git/fs, so worktree→lane assignment is re-derived each cycle from the
epic task DAG + live git rather than persisted in a projection. When OFF, the
producer asserts the target repo is on its resolved default branch before
dispatch. When ON, it shapes each epic's tasks into git worktrees off a pure,
deterministic topology module (a total function of `depends_on`): a maximal
linear chain shares ONE worktree (no merge), the first child of a fork inherits
the parent's worktree while every other child FORKS a sub-worktree off the
parent's committed tip, a fan-in task sequentially pairwise-merges its incoming
lane branches (never octopus) before it dispatches, and a synthetic `__close__`
sink pinned to the epic base makes the closer run where every lane has merged
in; the base then merges into the default branch once the producer observes the
closer JOB finished AND the MAIN `epics` projection reports the epic done. The
closer writes `status:done` to the PRIMARY repo (plan state always = primary,
never the lane), so finalize keys off the durable `jobs` projection
(`closerJobFinished`, re-fold-safe + restart-safe) as the producer-observable
trigger, then confirms real completion against the main `epics` projection
(`isEpicDone`) — never a lane-read. A crashed closer that committed code but not
`done` leaves the epic not-done in the main projection, so finalize no-ops and
retries rather than pushing incomplete work to default.
Lane branch names are deterministic (`keeper/epic/<id>` base, `keeper/epic/<id>--<task>`
ribs — the FLAT `--` separator keeps a rib from being a path-prefix of the base
ref, which git would otherwise reject as a directory/file ref conflict the moment a
forked epic provisions its first rib). Before `confirmRunning` mints the durable
`Dispatched`, the producer
lazily ensures the lane worktree exists, runs any pre-merges, asserts HEAD
(ON → worktree HEAD equals the derived branch and the worktree is registered;
OFF → repo on its default branch), and sets the launch cwd to the worktree path.
Both HEAD assertions fail as sticky `DispatchFailed` (cleared by `retry_dispatch`),
never `fatalExit`. Every merge takes the base worktree's own per-worktree
`<--git-dir>/keeper-commit-work.lock` flock, serializing it against a
`commit-work` in that SAME worktree (disjoint lanes take distinct locks). A
pre-merge whose source ref does not resolve (a *phantom* lane never created
because its task's work landed on the default branch — mixed-mode board history)
is a lossless `missing-source` no-op: nothing to merge, so the pre-merge is
skipped and the close still proceeds (probed before any lock/merge-base, so a
real merge/is-ancestor failure is never masked). A genuine content conflict still
aborts (`git merge --abort`) + fails loud + stops (no merge-to-default, no
teardown).
The merge-to-default + push at close run in the shared MAIN checkout, so finalize
DEGRADES GRACEFULLY rather than stomping it: before the merge it probes the
checkout (`mergeReadiness` — `git status --porcelain` + the current branch, which
reports `HEAD` mid-rebase) and prechecks the push for fast-forwardability against
the CACHED `origin/<default>` ref (`remotePushFastForwardable`, never a fetch). A
dirty / off-branch / mid-rebase tree or a non-fast-forward remote is a clean
SKIP-AND-RETRY keyed on a DISTINCT `worktree-finalize-*` reason that mints NO
sticky `DispatchFailed` — finalize stops and the next cycle retries once the tree
settles, never an un-clearable close and never an auto-fetch/rebase/force. (A
genuine divergent-CONTENT conflict still fails loud + sticky, above — only the
human's-WIP-blocks-the-merge case degrades.) Finalize is idempotent: a re-run
after a partial post-merge/post-push crash sees the base already an ancestor of
default (no-op merge), an up-to-date push, and resumes teardown (an already-gone
worktree removal no-ops).
Crash/restart recovery is producer-only: detect `MERGE_HEAD` in each KEEPER lane
(pass-1 is filtered to `keeper/epic/*` branches — a foreign linked worktree such
as another tool's `.claude/worktrees/<name>` lane is never abort-merged or
pruned, so a vanished foreign dir can't ENOENT the sweep) → abort →
`git worktree prune --expire now` → retry, plus a deterministic done-but-unmerged
`keeper/epic/*` scan decoupled from the recent-done window. Pass-2 runs the SAME
shared-checkout prechecks as finalize (dirty / off-branch / non-fast-forward →
skip), but surfaces them as `worktree-recover-*` reasons so the level-triggered
auto-clear lifts the block the moment the tree settles. A recover merge
conflict still fails LOUD and blocks ONLY its own `close::<epic>` key (per-key
`failedKeys`) — but it is LEVEL-TRIGGERED, never a sticky board-jam: each cycle
re-derives "is this lane still blocked?" from live git and AUTO-CLEARS the sticky
row (a synthetic `DispatchCleared`, the same fold arm `retry_dispatch` mints) the
moment the git resolves — junk branch deleted, conflict merged, or epic reaped —
so a human just fixes the git, never `retry_dispatch`. The auto-clear is SCOPED to
recover-reason rows (`worktree-recover*`) so a normal close-sink (`finalizeEpic`)
failure sharing the `close::<epic>` key is never clobbered. A successful close
prunes its now-merged lane branches — every rib (`keeper/epic/<id>--<task>`) THEN
the base (`git branch -D`), each AFTER its worktree teardown and each gated on
is-ancestor-of-default so an unmerged/diverged ref is NEVER force-deleted — so a
DONE epic leaves no recover-able base branch and no leaked rib behind. Each epic's
`target_repo`/`project_dir` are RESOLVED to git toplevels ONCE in the producer
snapshot-build (`classifyWorktreeRepos` + the nullable `memoizedNullableGitToplevel`,
a fresh per-cycle memo) before the lane geometry compares + places lanes, so the
gate and dispatch never re-derive from raw strings — a single-repo epic whose raw
roots differ only by subdir/symlink/trailing-slash is NO LONGER falsely rejected.
Two distinct sticky rejects survive: `worktree-multi-repo` (the tasks resolve to >1
distinct toplevel — genuinely unsupported for v1) and `worktree-repo-unresolved` (a
required root resolved null; re-resolves next cycle via the per-cycle memo). Those,
plus toggling the mode while a STARTED open epic is in flight (`isEpicStarted`), are
rejected loud in worktree mode (both reject kinds cleared by `retry_dispatch`); a
drained / unstarted-open / zero-epic board toggles freely, so the operator's own
interactive session no longer trips the guard (`keeper autopilot worktree on`
has a `--force` escape hatch for the started-epic guard). `commit-work` pins every
git op to the resolved worktree root (`git rev-parse --show-toplevel`, `cwd:` on
every spawn) and strips `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/`GIT_COMMON_DIR`
from each spawn's env, so a concurrent producer prune/add can never make a lane
commit land on the default branch via a perturbed git-dir resolution. It skips its
push leg whenever it runs inside a linked git worktree (submodule false-positive
guarded), so per-lane branches never reach origin — autopilot pushes once at
merge-to-default — and, defense-in-depth, re-checks linkage + HEAD immediately
before the push and aborts loudly rather than push the default/protected branch
from a linked worktree.

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
prints the plan (using the human-facing `buildResumeCommand` DISPLAY form),
`--apply` relaunches each survivor into its recorded `backend_exec_session_id`
via keeper's SOLE launch transport — `agentwrapLaunch` in resume mode
(`src/exec-backend.ts`), the same seam `keeper bus wake` uses — pacing launches
0.5s apart. agentwrap builds the `claude --x-tmux … --resume <target>`
invocation off an absolute `keeper agent` launcher prefix (alias-independent, and
a session name with shell metacharacters is handled safely), get-or-creates the
session itself, and holds the pane open after claude exits. `src/resume-descriptor`
now exposes ONLY the DISPLAY form (`buildResumeCommand`, the bare `claude --resume`
string `scripts/resume.ts` prints); `resumeTarget` is the shared key both the
wake and restore paths resolve. cwd is set on the `agentwrapLaunch` spawn
(agentwrap reads its own `process.cwd()`), not interpolated into a launch body.
`--snapshot-current` emits the BARE agentwrap resume argv per candidate
(shell-quoted, byte-aligned with what `--apply` spawns — no `tmux new-window`
wrapper, since agentwrap mints its own window).
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

The window_index this worker mirrors into `restore.json` rides straight off each
job's `jobs` projection row, kept fresh by the control-worker's
`TmuxTopologySnapshot` fold (see the tenth worker) — the restore worker no longer
probes tmux for topology. It retains a SINGLE event-log channel on its ~1s timer
wake, UNGATED by a live tmux job (epic fn-819): a `tmux display-message -p
'#{pid}'` probe reads the tmux SERVER pid (the backend "generation" handle), and
on a change — pid-hash-gated, boot-seeded from the last logged event so a
keeperd restart against an unchanged server is silent — the worker mints a
`BackendExecStart` event carrying `backend_type` + `generation_id`. It is
ungated precisely because the post-crash state has no live job, yet the
freshly-respawned server is the generation crash-restore must scope to. The
reducer folds `BackendExecStart` via an explicit NO-OP arm (the boundary lives
in the event-log `id` order, read at restore time, NOT a projection column — no
schema bump). That single post is the worker's only worker→main channel and only
event-log contribution — the restore-file write path remains a pure consumer
side-file. Write failures are swallowed to stderr (next pulse retries); only an
unhandled throw out of the watch loop escalates to `onerror`/`close` →
fatalExit.

A **tenth** Worker thread is the tmux control-mode worker (epic fn-952, extended
by fn-968): a persistent `tmux -C` control client parked on an anchor session,
gated on `hasLiveTmuxJob` (no live tmux job ⇒ nothing to observe, so it stays
disconnected and re-checks on a ~1s connect-gate poll). On connect it bootstraps
the no-output flags and, debouncing the control-mode notification burst into one
framed re-read, issues `list-clients` + `list-panes -a` over the SAME persistent
connection (a framed command, NOT a subprocess) and parses both in one pass. From
that single re-read it emits BOTH live-only surfaces: a `TmuxClientFocusSnapshot`
(the current real (non-control) client's focused session/window/pane, UPSERTing
the `tmux_client_focus` singleton) AND — as of fn-968, this worker is now the SOLE
topology producer — a `TmuxTopologySnapshot` carrying `{generation_id,
panes:[{pane_id, session_name, window_index}]}`, deduped via the shared
`hashTopology` so a steady topology never re-posts within a connection. The
topology emit is gated on `hasLiveTmuxJob` and posts NOTHING on a null generation,
read fault, or empty pane set (a wiping empty snapshot would clobber every live
job location — unlike focus, which posts `status:"none"`). Main mints both events;
the `TmuxTopologySnapshot` fold (schema v83, fn-907) is the SOLE owner of the two
live location columns, matching each live tmux job by `pane_id`, verifying/adopting
`generation_id` (the recycled-`%N` guard), and overwriting
`jobs.backend_exec_session_id` + `jobs.window_index` only with present non-NULL
values, gated above `tmux_projection_state.floor`. The earlier
`WindowIndexSnapshot` + `TmuxPaneSnapshot` folds are explicit reducer no-ops (a
historical event of either type must not re-route into the projection, so the
OTHER `jobs` columns still re-fold byte-identically). A `%exit` / EOF triggers a
backoff reconnect (a fresh generation re-read on every connect); a flapping server
escalates to `fatalExit` after the consecutive-failure cap.

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

A **twelfth** Worker thread is the Agent Bus relay (epic fn-875): a local
inter-agent message bus that is PHYSICALLY OUT of keeper.db's blast radius. It
opens keeper.db READ-ONLY (for `jobs` identity reads — session_id, title,
`name_history`, start_time — never a write) and owns its OWN writable `bus.db`
plus a DEDICATED Unix-domain socket at `~/.local/state/keeper/bus.sock`
(`KEEPER_BUS_SOCK`). That bus socket is SEPARATE from the subscribe server's
`keeperd.sock` above — a different path, a different wire protocol
(op-discriminated NDJSON pub/sub, not the collection query/subscribe surface),
and a different purpose (agent-to-agent relay, not projection streaming). Agents
register by pid, then send to each other by current name, session id,
ANY former name, or a role address `planner@<epic_id>` (resolved server-side
through the epic's `job_links` creator edge → job_id → channel, reusing the
job-keyed identity tiers and `PublishOutcome` vocabulary — no new result code or
schema) — append-only `name_history` makes a since-dead name resolve
deterministically to the same agent, symmetric for reach and reply. Presence is
tri-state (fn-886): identity resolution and connectivity are SEPARATE axes — a
name resolves to a known agent, but delivery is gated on that agent having an
OPEN socket. A directed send is synchronous and honest: the server resolves +
fans out and replies a single result frame
(`{type:"ack",op:"publish",result,recipients}`) whose `result` is `delivered`
(open socket, full frame accepted), `queued_for_wake` (a `planner@<epic_id>` role
send whose creator is known-but-offline — durably persisted on `messages` and
replayed recipient-keyed on that creator's resubscribe, fn-918), `not_connected`
(any OTHER known identity with no open socket — delivered to no one, never
silently queued), `unknown_target`, `ambiguous_target`, or `delivery_failed`
(connected but the write was partial), and `messages.status` records that true
outcome. The CLI exits 0 on the two successes (`delivered`, `queued_for_wake`)
and fails loud (exit 1, stderr) on every other result — a non-delivery is never a
silent exit-0. A `queued_for_wake` send can be RESUMED now by the CLIENT-SIDE
`keeper bus wake "planner@<epic_id>"` verb (fn-918): it resolves the epic's
creator from the trusted `job_links` edge and resumes it into a dedicated
`agentbus` tmux session via keeper's SOLE launch transport — `agentwrapLaunch` in
resume mode (the same seam crash-restore uses): agentwrap builds the
`claude --x-tmux … --resume <target>` invocation off an absolute
`keeper agent` launcher prefix (alias-independent, shell-metacharacter-safe),
mints/owns the window, and holds the pane open after claude exits — so there is
ONE launch transport, not a separate shell-wrapper. Single-flighted per session,
liveness- and cooldown-gated, fail-open. The relay itself NEVER spawns — wake is entirely the
CLI verb — and the resumed `agentbus` window stays OPEN after the planner stops,
like every keeper-created window: keeper closes no windows automatically, so the
operator garbage-collects it by hand. Liveness is socket-close, NOT a heartbeat: a peer's
death closes its fd → kernel FIN → the relay drops the channel, with no periodic
liveness timer; boot rehydration still drops dead pids. `keeper bus list` is
informational only, never a send precondition (there is no `resolve` subcommand —
agents send blindly by current-or-former name). The server
resolves the connecting peer's pid via `LOCAL_PEERPID` and OVERWRITES any
client-claimed `from` with that peer-resolved identity (anti-spoof), enriching it
from keeper.db `jobs` only when the live process's start_time matches the row's —
a `(pid, start_time)` guard so an OS-recycled pid carrying a dead agent's
lingering row is never bound (a mismatch/unreadable probe fails closed and the
ancestry walk climbs to the true parent); the socket is mode 0600. The wire envelope carries a `namespace` axis (`chat` is the first
tenant; the core routes tenant-agnostically). Per-client send queues are bounded
so a slow/dead subscriber is evicted rather than blocking the relay, and a
malformed/oversized frame is dropped without affecting other subscribers. It
adds NO keeper event type, projection, RPC surface, or schema-version bump — so
keeper's re-fold determinism and tightly-scoped-write invariants hold by
construction; `bus.db` runs its OWN `PRAGMA user_version` ladder (NEVER keeper's
`migrate()`). Like the restore/renamer workers it carries no `onmessage`
handler — it posts NOTHING to main and writes ONLY its own `bus.db`; only an
unhandled throw escalates via `onerror`/`close` → fatalExit (the documented
fallback is a sibling `--bus-only` LaunchAgent). The bus inbox watcher is armed
per interactive session as a Claude Code Monitor (`keeper bus watch`, via the
keeper plugin's `experimental.monitors` manifest); that Monitor is INVISIBLE to
the hook stream, so it does NOT populate `jobs.monitors` — which is correct, bus
presence is the `bus.db` registry, not the hook-fed projection.

A **thirteenth** Worker thread is the handoff dispatcher (epic fn-946):
level-triggered on `PRAGMA data_version`, it picks an actionable
`requested`/stale-`dispatching` `handoffs` row (selection is
`handoff_id`-lexicographic — the `handoff_id` is the human-authored slug, so the
order is slug-alphabetical, not temporal; there is no created-at column to order
on), mints a durable `HandoffDispatching` marker via main (the
mint-before-launch transactional outbox — a `handoff-dispatching-request`
relayed for the synthetic-event write, ACK-correlated) BEFORE it spawns the
fire-and-forget handoff-ee worker into the initiator's tmux session, so a
daemon restart mid-dispatch never double-launches (the level-triggered bind
check asks "does a `handoff::<id>` SessionStart exist?" before re-dispatching)
and never strands the handoff. The dispatch side-effect lives in the worker,
NOT the fold — the fold is the pure decider.

The thirteen workers are fully independent; main supervises all thirteen
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
`autopilot`, `git`, `usage`, `builds`, `await` — so all example clients
ship as one binary instead of N standalone scripts.

The sitter scanners (performance, builds, helptailing) — read-only out-of-process observers of `keeper.db` and buildbot state — now live in their own repo at `~/code/sitter`. They import nothing from keeper and observe purely through durable contracts (read-only SQLite at a whitelisted schema version, NDJSON telemetry, their own private state tree). See `~/code/sitter` for the daemon set, its launchd jobs, and its architecture.

**events.data read-contract (post-shed).** As of schema v74 (fn-836) the
`event_blobs` side table is GONE. The conflated `events.data` blob served two
roles fused in one column — (1) the typed fold INPUT a fold reads via the
`extract*()` functions, and (2) a redundant transcript archive — and the shed
split them. The v74 migration restored every **keep-set** body back inline (the
explicit ALLOW-list of event types whose body a live fold reads — GitSnapshot,
Commit, UserPromptSubmit, PreToolUse:Agent, Stop, the Usage/window/build/dispatch
snapshots, etc.) and dropped the table; the **shed class** — PostToolUse
`tool_response` bodies for the four mutation tools (Write/Edit/MultiEdit/
NotebookEdit) — carries NULL `events.data`, its lone fold field
(`tool_input.file_path`) promoted to the `events.mutation_path` column and
SEEK'd through the partial index `idx_events_mutation_path WHERE mutation_path IS
NOT NULL`. So every fold-path read now resolves straight from `events.data` (no
`COALESCE`, no `LEFT JOIN event_blobs`): the drain SELECT, the subagent
PreToolUse:Agent bridge, the v67 Commit-trailer backfill (a historical-ladder
read that still runs against the transiently-recreated table during a 0→latest
walk), and `search-history`'s UserPromptSubmit `$.prompt`.

Re-fold determinism now scopes to the **projection columns**: a from-scratch
re-fold reproduces byte-identical projection rows because every keep-set body is
inline and every shed-class file_path is in `mutation_path`. The shed bodies
themselves are intentionally **non-reconstructable** — that transcript depth
defers to Claude Code's own `transcript_path` `.jsonl` (retained per CC's
`cleanupPeriodDays`). The authoritative per-site keep/shed classification gate
lives in `test/refold-equivalence.test.ts`. The DROP lands at the migration TAIL
so the historical v57 create + v67 read still run against a live table on a fresh
walk; it is UNCONDITIONAL (the `approvals` v12→v13 precedent) so the v57 ladder
step never resurrects the table on a post-shed restart.

Forward growth is bounded by the steady-state **retention pass** (`src/compaction.ts`,
`retainColdPayloads`) — keeper's first retention. A slack daemon timer NULLs the
cold tail of shed-class bodies IN PLACE, running STRICTLY outside the fold on
main's writable connection, paced (≤500 rows/batch, ≤20 batches/pass). The
shed-set is a POSITIVE allow-list over CHEAP HEADER COLUMNS only
(`RETENTION_SHED_CLASS_PREDICATE`: `hook_event`/`tool_name`/`plan_op`/
`subagent_agent_id`, no json parse) — a new/unlisted event type defaults to KEPT
(fail-safe). fn-837 widened it from the four mutation tools to every class no fold
reads: PostToolUse Write/Edit/MultiEdit/NotebookEdit/Read/WebFetch/Skill/ToolSearch,
non-`keeper-plan` PostToolUse:Bash (`keeper plan` Bash KEEPS — `state_repo` is fold-read),
modern PostToolUse:Agent (`subagent_agent_id IS NOT NULL`; legacy NULL-id Agent
KEEPS — its `agentId` is fold-read), non-Agent PreToolUse / PostToolUseFailure tool
bodies (PreToolUse:Agent is the subagent bridge; failure:Agent has the legacy
`agentId` fallback), and SubagentStart/SubagentStop/BackendExecSnapshot/Notification
(cheap-column folds). The full `RETENTION_SHED_PREDICATE` is that class allow-list
AND a mutation-tool-specific backfill guard (the lone `json_extract`, only ever
biting the four mutation tools that still owe a `mutation_path` promotion); it also
gates past the recent window AND strictly below the fold cursor. After each batch
`PRAGMA incremental_vacuum` returns the freed overflow pages to the file tail (a
no-op unless the file was born `auto_vacuum=INCREMENTAL`, baked by `reclaimDb`
above). Because no fold reads a shed-class body (and the mutation tools' file_path
is already promoted), retention-then-refold stays byte-identical.

ROW growth is bounded by a SECOND, much narrower pass (`deleteNoopSnapshotRows`,
fn-934.5): the body-NULL pass reclaims body bytes but never the per-row overhead,
so the cold tail of THREE classes is PHYSICALLY DELETEd — `BackendExecSnapshot` /
`TmuxPaneSnapshot` / `WindowIndexSnapshot`, the retired-to-explicit-no-op fold arms
(`src/reducer.ts`). A row is safe to DELETE (not just NULL) only when its absence
cannot change any projection: deleting a row skips its fold arm AND drops it from
every producer/memo scan on a re-fold, so it is deletable ONLY when the arm is a
no-op AND it carries no producer-scanned cheap column (`mutation_path` /
`bash_mutation_*` for the git surface, `background_task_id` for `computeMonitors`,
`plan_op` for the plan-link folds). These three qualify; the rest of the shed class
does NOT — its bodies are fold-unread but its ARMS (SubagentStart/Stop/Turn, modern
PostToolUse:Agent, Pre/PostToolUse, Notification mutate `jobs`/`subagent_invocations`
order-dependently) and cheap columns are load-bearing (empirically a broad delete
diverges the re-fold). The delete predicate is a SINGLE named constant
(`NOOP_SNAPSHOT_DELETE_PREDICATE`) PINNED by a guarding test so it can never silently
widen; the same batched + `id < cursor` + cold-watermark + `incremental_vacuum`
discipline as the NULL pass, in keeper's OWN writer process. The charter is now:
physical row deletion is restricted to the no-op-arm snapshot classes, and re-fold
determinism holds over the SURVIVING rows. The data-loss sentinel
(`countAbsentBlobs`) reuses the SAME cheap-column class predicate inside its `NOT()`
— flagging only a NULL body OUTSIDE the shed class (a missing keep-set body), never
the intentional shed NULLs, and never an absent no-op-snapshot ROW (a gone row
carries no record, so it never surfaces as a NULL body), and never re-parsing an
already-NULL body.

The event-sourcing invariants above are the rationale; their terse imperative
form — the fold/migration/write-scoping guardrails and the "DO NOT widen them"
list — lives in [CLAUDE.md](./CLAUDE.md).

## Inspect

```sh
# Recent jobs (state: working|stopped|ended|killed; title_source: NULL=unset, 'spawn'=from --name, 'payload'=from prompt, 'transcript'=from live custom-title; plan_verb / plan_ref derived from a plan-shaped spawn name at SessionStart, NULL otherwise; config_dir captures CLAUDE_CONFIG_DIR at SessionStart with latest-non-NULL-wins via COALESCE on resume; active_since (v65) is the dash AGENTS recency key, stamped to event.ts on the rising edge into 'working' (NULL on a never-prompted job); last_api_error_(at,kind) and last_input_request_(at,kind) are paired stoppage annotations stamped on ApiError / InputRequest folds; both clear on the next UPS/SessionStart revival OR PreToolUse/PostToolUse tool event (gated on column-is-not-NULL), and that tool-event clear also un-stops a stopped row back to working):
sqlite3 ~/.local/state/keeper/keeper.db \
  'SELECT job_id, state, title, title_source, plan_verb, plan_ref, config_dir, active_since, last_api_error_at, last_api_error_kind, last_input_request_at, last_input_request_kind, last_event_id FROM jobs ORDER BY updated_at DESC LIMIT 10'

# Plan-spawned jobs only — indexed via the partial `idx_jobs_plan_ref WHERE plan_ref IS NOT NULL` so this lands the index, not a scan:
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT job_id, plan_verb, plan_ref, state, title FROM jobs WHERE plan_verb = 'close' ORDER BY updated_at DESC LIMIT 10"

# All Skill-tool plan:plan invocations across sessions — uses the partial idx_events_skill_name index:
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT session_id, datetime(ts,'unixepoch','localtime'), skill_name FROM events WHERE skill_name LIKE 'plan:%' ORDER BY id DESC LIMIT 20"

# All `keeper plan` invocations across sessions — uses the composite partial idx_events_plan_session index; the WHERE predicate must match the index predicate syntactically for SQLite to land the index:
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT session_id, datetime(ts,'unixepoch','localtime'), plan_op, plan_target FROM events WHERE plan_op IS NOT NULL ORDER BY id DESC LIMIT 20"

# Every session that has touched a given epic — UNION mirrors the reducer's syncPlanLinks cross-session sweep; the left branch uses the partial idx_events_plan_epic index, the right branch uses the partial idx_events_plan_target index (SQLite picks ONE index per cross-column OR, so the OR form was rewritten to UNION to reach both):
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT session_id FROM events WHERE plan_op IS NOT NULL AND plan_epic_id = 'fn-628-contention-review-tier-2-index-pack' UNION SELECT session_id FROM events WHERE plan_op IS NOT NULL AND plan_target = 'fn-628-contention-review-tier-2-index-pack'"

# Recent per-job Task-tool subagent timeline — one row per PreToolUse:Agent paired with its PostToolUse:Agent (and lifecycle Start/Stop), status running|ok|failed|unknown|superseded, duration_ms populated on SubagentStop (NULL on rows never closed — superseded peers + lifecycle-swept unknown orphans):
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT job_id, turn_seq, subagent_type, status, duration_ms, prompt_chars, tool_use_id FROM subagent_invocations ORDER BY job_id ASC, turn_seq ASC LIMIT 20"

# All Task-tool invocations across the event log — uses the partial idx_events_tool_use_id index:
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT COUNT(*) FROM events WHERE tool_use_id IS NOT NULL"

# Jobs that created or refined an epic during a /plan:plan window (creator/refiner classifier output — jobs.epic_links is the per-session fan-out written by syncPlanLinks from the deduped UNION of the plan_op stdout scrape AND the durable Commit-event Planctl-Op/Target/Session-Id trailers, epic fn-695, so an edge survives a stdout pipe that NULLs plan_op):
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT job_id, plan_verb, plan_ref, epic_links FROM jobs WHERE json_array_length(epic_links) > 0 ORDER BY updated_at DESC LIMIT 10"

# Epics by inbound-link density — every job whose `keeper plan` footprint (stdout scrape ∪ durable commit-trailer facts, epic fn-695) created or refined the epic during a /plan:plan window (epics.job_links is the symmetric per-epic fan-out; as of schema v25 each entry embeds the linked job's title/state/last_api_error_(at,kind)/last_input_request_(at,kind) denormalized off the jobs row at the reducer's write boundary, so renderers + predicates no longer need a live-jobs join):
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT epic_id, epic_number, title, json_array_length(job_links) AS n FROM epics WHERE json_array_length(job_links) > 0 ORDER BY n DESC, epic_number ASC LIMIT 10"
# Unnest job_links to see each link's embedded display payload (schema v25: kind, job_id, title, state, last_api_error_at, last_api_error_kind, last_input_request_at, last_input_request_kind):
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT e.epic_id, json_extract(l.value, '\$.kind') AS kind, json_extract(l.value, '\$.job_id') AS job_id, json_extract(l.value, '\$.title') AS title, json_extract(l.value, '\$.state') AS state, json_extract(l.value, '\$.last_api_error_at') AS last_api_error_at, json_extract(l.value, '\$.last_api_error_kind') AS last_api_error_kind, json_extract(l.value, '\$.last_input_request_at') AS last_input_request_at, json_extract(l.value, '\$.last_input_request_kind') AS last_input_request_kind FROM epics e, json_each(e.job_links) l ORDER BY e.epic_number ASC, kind ASC, job_id ASC LIMIT 20"

# Killed sessions specifically (proven-dead from outside the hook stream — SIGKILL, terminal-pane closure, reboot):
sqlite3 ~/.local/state/keeper/keeper.db \
  'SELECT job_id, state, pid, start_time FROM jobs WHERE state = "killed" ORDER BY updated_at DESC LIMIT 10'

# Plans projection — epics (each embedding its tasks AND its plan/close-verb jobs as JSON arrays) folded from the configured `.keeper` roots. The natural sort is `epic_number ASC` (matches the `EPICS_DESCRIPTOR` default — plain creation order, a neutral seed; fn-936 v85 dropped the old `sort_path` ordering); the default-scope query (`WHERE default_visible = 1`, schema v32) uses the partial composite idx_epics_default_visible:
sqlite3 ~/.local/state/keeper/keeper.db \
  'SELECT epic_id, epic_number, title, status, last_validated_at, json_array_length(jobs) AS epic_jobs_n FROM epics ORDER BY epic_number ASC, epic_id ASC LIMIT 10'
# Default-scope epics — what the board sees by default: every open epic. Schema v32 (fn-634, narrowed at v63/fn-756) materializes the predicate `status='open'` as the VIRTUAL generated column `default_visible` and a partial composite index `idx_epics_default_visible ON epics(default_visible, epic_number, epic_id) WHERE default_visible = 1` serves it as a covering SEARCH (no SCAN, no temp B-tree). The literal `= 1` is load-bearing for the partial-index match:
sqlite3 ~/.local/state/keeper/keeper.db \
  'SELECT epic_id, epic_number, title, status FROM epics WHERE default_visible = 1 ORDER BY epic_number ASC, epic_id ASC LIMIT 10'
# Tasks live inside epics.tasks now — unnest with json_each to list them per epic. Schema v19 surfaces BOTH the plan-native runtime status (`runtime_status`: todo|in_progress|done|blocked, ingested from `.keeper/state/tasks/<task_id>.state.json`) AND the derived worker-phase binary (`worker_phase`: open|done, derived from `worker_done_at`) — outer ORDER BY follows the default `epic_number` order:
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT e.epic_id, json_extract(t.value, '\$.task_id') AS task_id, json_extract(t.value, '\$.task_number') AS task_number, json_extract(t.value, '\$.title') AS title, json_extract(t.value, '\$.runtime_status') AS runtime_status, json_extract(t.value, '\$.worker_phase') AS worker_phase FROM epics e, json_each(e.tasks) t ORDER BY e.epic_number ASC, task_number ASC LIMIT 10"
# Work-verb jobs per task — double-unnest epics.tasks then each task's embedded jobs sub-array:
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT e.epic_id, json_extract(t.value, '\$.task_id') AS task_id, json_extract(j.value, '\$.job_id') AS job_id, json_extract(j.value, '\$.state') AS state FROM epics e, json_each(e.tasks) t, json_each(json_extract(t.value, '\$.jobs')) j ORDER BY e.epic_number ASC, task_id ASC LIMIT 10"

# Git projection — one row per watched worktree (membership gate `.keeper present || dirty || ahead of upstream > 0`, recomputed each reconcile, epic fn-690). dirty_files is a JSON array; each entry carries {path, xy, mtime_ms, worktree_oid, worktree_mode, attributions:[{session_id, source, last_mutation_at, last_commit_at}, ...]} (schema v31 file-centric shape — per-(session, file) attribution with source badges tool|bash|inferred|plan (the plan badge is minted by the reducer's plan_op fold from the envelope's files[] array so .keeper/ JSONs+specs no longer orphan) and commit-discharge timestamps; schema v44/v45 — fn-664 — adds the producer-frozen worktree_oid + worktree_mode so foldCommit can gate discharge on content equality):
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT project_dir, branch, ahead, behind, json_extract(dirty_files, '\$[0]') AS first_dirty FROM git_status LIMIT 5"

# file_attributions — one row per (project_dir, file_path, session_id) carrying the discharge-rule facts (last_mutation_at vs last_commit_at; a row is live-attributed iff last_commit_at IS NULL OR last_commit_at < last_mutation_at) plus the per-file worktree_oid + worktree_mode the v45 content-aware discharge gate reads back at commit time. Indexed for both per-file and per-session scans:
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT project_dir, file_path, session_id, last_mutation_at, last_commit_at, worktree_oid, worktree_mode FROM file_attributions ORDER BY last_mutation_at DESC LIMIT 20"

# Usage projection — one row per agentusage profile observed at ~/.local/state/agentusage/<id>.json (freshness fields are excluded by design — keeper has no freshness signal yet):
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
live file stays large after a logical shed of payload bytes until a `VACUUM
INTO` rebuild reclaims the freelist). Steps (DB path shown for the default
`~/.local/state/keeper/keeper.db`):

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

### `keeper reclaim` — offline size-reclaim (fn-847)

`keeper reclaim` wraps `reclaimDb` (the `VACUUM INTO` rebuild with
`auto_vacuum=INCREMENTAL` baked + `quick_check` gate) into a single guarded
operator command. The retention shed (`## Compaction`) frees pages onto the live
file's freelist, but an in-place online `VACUUM` is deliberately never run (it
rewrites the whole multi-GB DB under the writer lock), so the physical reclaim is
this OFFLINE op — run with the daemon STOPPED. The command:

1. **Refuses while the daemon is up.** It reads the keeperd ownership lock
   (`<sock>.lock`) and, if the recorded pid is alive, exits 1 — a live daemon
   connection racing the atomic swap corrupts the DB. The guard is load-bearing.
2. Keeps a **pre-reclaim snapshot** (verified `VACUUM INTO` copy) as the rollback.
3. Runs `reclaimDb` into `<db>.reclaim`.
4. **Self-verifies BEFORE the swap** — the reclaimed file opens clean, carries the
   same `schema_version`, bakes `auto_vacuum=2`, and reproduces IDENTICAL per-table
   row counts (every `events` row + every projection). On any mismatch the original
   DB is left untouched and the snapshot kept (a lost/extra row is caught while the
   original is still recoverable).
5. Atomically `mv`s the verified output over the live DB and drops the stale
   `-wal`/`-shm` sidecars.

Operator runbook (default `~/.local/state/keeper` paths; `keeper reclaim
--agent-help` prints the full step list):

```sh
keeper autopilot pause                                # level-triggered on data_version
launchctl bootout gui/$(id -u)/arthack.keeperd        # stop the daemon (releases the DB)
keeper reclaim                                        # snapshot → reclaim → self-verify → swap
launchctl bootstrap gui/$(id -u) <keeperd plist>      # restart
keeper await server-up                                # wait until serving
sqlite3 -readonly ~/.local/state/keeper/keeper.db 'PRAGMA auto_vacuum;'   # 2
ls -lh ~/.local/state/keeper/keeper.db                # ~0.6 GB
keeper search-history <a known term>                  # forensics intact (re-fold byte-identical)
keeper autopilot play                                 # re-enable
```

If post-restart verification fails, stop the daemon, `mv` the pre-reclaim snapshot
back over `keeper.db`, restart, and triage with autopilot left paused. Never delete
the snapshot until verification passes. `--dry-run` prints the runbook only.

### One-time event_blobs shed reclaim (fn-836.4)

The v74 migration LOGICALLY drops `event_blobs` (restoring keep-set bodies inline
first), but the freed pages stay on the live file's freelist until a `VACUUM
INTO` rebuild reclaims them — an in-place online `VACUUM` is deliberately never
run (it rewrites the whole multi-GB DB under the writer lock). So the physical
reclaim is a ONE-TIME OFFLINE op, run with the daemon stopped, that also bakes
`auto_vacuum=INCREMENTAL` into the new file so the steady-state retention pass
(fn-836.5) can return freed overflow pages to the OS via `PRAGMA
incremental_vacuum`. `reclaimDb(dbPath, outputPath)` in `src/backup.ts` does the
`VACUUM INTO` (with the pragma baked) + `quick_check` gate + perms match;
`reclaimInstructions(...)` prints the full checkpoint → reclaim → atomic `mv` →
restart → verify procedure. Keep the pre-shed snapshot as the rollback until the
restarted COALESCE-free binary verifies `event_blobs` is gone.

### One-time widened-shed catch-up reclaim (fn-837.2)

fn-837 widened the steady-state retention predicate from the four mutation tools to
every fold-unread class (see `## Compaction` above). That makes a ~600k-row
historical backlog newly eligible, but the steady-state 300s timer (≤20 batches ≈
≤10k rows/pass) would take 5+ hours to drain it, and per-batch `incremental_vacuum`
lags so the FILE won't shrink without a full `VACUUM INTO`. So the prompt reclaim is
a TWO-STEP offline op: a catch-up drain (online) then a daemon-stopped VACUUM.

`bun scripts/reclaim-db.ts` runs the catch-up drain — `drainColdPayloads` in
`src/compaction.ts` loops the SAME paced retention pass (≤500 rows/tx, elevated
per-pass batch cap, NEVER one giant UPDATE) until a pass sheds nothing; idempotent
and resumable, safe to run while keeperd is UP (it is the daemon's own paced pass,
just driven to completion). It then reprints the offline reclaim runbook. Run with
`--dry-run` to print the runbook only.

The runbook (`reclaimInstructions(...)` in `src/backup.ts`, the single source of
truth) sequences: pause autopilot FIRST (it is level-triggered on `PRAGMA
data_version`, which the VACUUM bumps) → catch-up drain → precheck free disk + stop
the daemon → snapshot → `wal_checkpoint(FULL)` → `reclaimDb` `VACUUM INTO` (bakes
`auto_vacuum=INCREMENTAL` + `quick_check` gate) → atomic `mv` + clear stale
`-wal`/`-shm` → restart → `keeper await server-up` → verify DB ~0.6 GB,
`PRAGMA auto_vacuum=2`, search-history forensics intact → re-enable autopilot. Keep
the pre-reclaim snapshot as the rollback until verification passes.
