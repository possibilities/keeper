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
spawned through planctl. The `killed` state is the sibling terminal state to
`ended`: reached not from a SessionEnd hook but from synthetic `Killed` events
emitted by the boot seed sweep and the live exit-watcher worker, which prove a
session's `(pid, start_time)` is gone from the OUTSIDE (SIGKILL'd,
terminal-pane-closed, machine reboot, hook crash). Both terminal states are
revivable — a fresh `claude --resume` re-opens either one to `stopped`.

The event log also indexes two sparse signals that surface across every
session — `events.slash_command` (the leading `/foo:bar` token of a
`UserPromptSubmit` prompt) and `events.skill_name` (the canonical name of a
Skill-tool invocation, e.g. `plan:plan` or `arthack:check`) — so consumers can
find `/plan:work` and `Skill` invocations cheaply without JSON-scanning the
event `data` blob. Both are partial-indexed on `WHERE col IS NOT NULL`.

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
page that doubles as a live subscription. Two collections register today —
`jobs` (the first and default) and `epics` (the read-only plans surface — each
epic embeds its tasks as a JSON array, so there is no separate `tasks`
collection; both the epic and each embedded task carry an `approval` field
valued `"approved" | "rejected" | "pending"`, surfaced as a pill in the
autopilot client). The surface is built so additional collections register
without touching the wire protocol or the diff machinery. Page membership is frozen at query time,
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
resources* through a dedicated writer owned by the server-worker. The two
concrete RPCs are `set_task_approval` and `set_epic_approval`; each writes
the top-level `approval` field on the target `.planctl/{epics,tasks}/<id>.json`
file via atomic temp+rename under a per-file single-flight lock. The change
is observed by `@parcel/watcher` and round-trips through the plan worker as
an `EpicSnapshot` / `TaskSnapshot` event, so the reducer's `epics` projection
and the `events` log keep their canonical-owner writers and re-fold
determinism extends to approval (rewind cursor + re-drain reproduces approval
state byte-identically). RPC handlers MAY write `.planctl` files, never
reducer projections directly (see [CLAUDE.md](./CLAUDE.md)'s DO NOT list).
Four example clients ship in `scripts/` (`jobs.ts`, `epics.ts`,
`autopilot.ts`, and `approve.ts`); see [Example clients](#example-clients)
for usage.

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
  `{plan|work|close}::<ref>`). The socket carries plan mutations *scoped to
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

4. **Symlink the plugin into Claude Code** for hook auto-discovery:

   ```sh
   ln -s "$PWD/plugin" ~/.claude/plugins/keeper
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

7. **Verify** the agent is loaded and the projection is live:

   ```sh
   launchctl print gui/$(id -u)/arthack.keeperd | head
   sqlite3 ~/.local/state/keeper/keeper.db '.tables'
   lsof -U | grep keeperd.sock   # the subscribe server's UDS listener
   ```

   Start a Claude Code session and confirm rows appear in `jobs` (see
   [Inspect](#inspect)).

   The subscribe server binds a Unix-domain socket at
   `~/.local/state/keeper/keeperd.sock` by default (a sibling of `keeper.db`).
   Override the path with the `KEEPER_SOCK` environment variable. Two example
   clients ship in `scripts/` (see [Example clients](#example-clients)).

## Example clients

Four scripts under `scripts/` demonstrate the subscribe + RPC protocols.
`jobs.ts`, `epics.ts`, and `autopilot.ts` are read-only subscribe clients
(clones of the same connection/coalescing/reconnect plumbing, differing only
in their render layer); `approve.ts` is the first RPC client (single-shot
`rpc` → `rpc_result`, no subscription). Run any with `bun scripts/<name>.ts
--help`.

- `jobs.ts` — primitive list UI over the `jobs` collection: pages 10 live jobs
  and renders a YAML frame per change, each row a single collapsed line
  (`{basename(cwd)} · {title} · {state}`). Reconnects across keeperd restarts;
  Ctrl-C unsubscribes cleanly.

  ```sh
  bun scripts/jobs.ts                # default scope: live jobs
  bun scripts/jobs.ts --state ended  # see terminal jobs explicitly
  ```

- `epics.ts` — primitive list UI over the `epics` collection: pages 10 open
  epics and renders each epic with its embedded tasks as a nested
  `epic:`/`tasks:` mapping block per frame.

  ```sh
  bun scripts/epics.ts               # default scope: open epics + nested tasks
  bun scripts/epics.ts --status done # see closed epics
  ```

- `autopilot.ts` — live epic-block view with per-epic and per-task approval
  pills over a single `Bun.connect` socket subscribed to the `epics`
  collection. Approval state is read directly off `epic.approval` and each
  embedded `task.approval`, so there is no second subscription. By default
  the view filters out epics whose `approval === "approved"`; pass
  `--show-approved` to include them. Renders each epic as a YAML block —
  `- epic: <epic_id> [<pill>]` over either `tasks: []` or a nested
  `- <task_id> [<pill>]` per task. Pills are `[pending]` / `[approved]` /
  `[rejected]`; a missing or invalid `approval` renders as `[pending]` (the
  safe-value invariant). The byte-compare emit gate means a pill flip
  reframes but a title edit or status flip alone does not.

  ```sh
  bun scripts/autopilot.ts                  # default: pending/rejected epics only
  bun scripts/autopilot.ts --show-approved  # include approved epics
  ```

- `approve.ts` — the RPC client. Single-shot: opens a `Bun.connect`, sends
  one `rpc` frame for `set_task_approval` or `set_epic_approval`, awaits the
  `rpc_result` (or `error`), and exits. No subscription, no reconnect loop.
  Approval is now a first-class planctl field, so the three valid values are
  `approved`, `rejected`, and `pending` — there is no `clear` (set to
  `pending` instead).

  ```sh
  bun scripts/approve.ts epic <epic_id> approved
  bun scripts/approve.ts epic <epic_id> pending            # reset to pending
  bun scripts/approve.ts task <epic_id> <task_id> rejected
  ```

The three subscribe scripts mirror each emitted frame to per-pid `/tmp`
sidecar files (full JSON state + rendered YAML) for out-of-band inspection.
The shared subscribe-loop logic lives in each script verbatim — extract a
shared module once the duplication starts costing more than the copy.

## Uninstall

Reverse of install:

```sh
launchctl bootout gui/$(id -u)/arthack.keeperd
rm ~/Library/LaunchAgents/arthack.keeperd.plist
rm ~/.claude/plugins/keeper
# Optional — drops all captured state, including the events log:
rm -rf ~/.local/state/keeper
```

## Architecture

The `events` table is a durable append-only log; the reducer folds it into the
`jobs` projection while advancing the `reducer_state` cursor in the same
transaction (exactly-once-per-event). A Worker thread on its own read-only
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
hardcoded — `jobs` is the first such collection. On each `data_version` tick the
server re-reads its watched rows, diffs the per-row version column, and pushes
`patch` frames to subscribed clients. The same tick also runs a second pass: it
groups subscriptions by filter signature, runs one `COUNT(*)` + membership-token
query per distinct filter (the token is a `group_concat` over the matching pk
identities, ordered by pk so it's stable and fingerprints membership, not cell
values), and emits a `meta` frame to any subscription whose `total` or token
moved — the count/staleness signal, sharing one query across same-filter clients
exactly as the patch pass shares one re-read per collection.

A **third** Worker thread is the transcript-title producer: it watches the
external transcript tree (the `claude_projects_root` from
`~/.config/keeper/config.yaml`, default `~/.claude/projects`) with
`@parcel/watcher`, forward-tails each changed JSONL from a stored byte-offset, and on a
`custom-title` line posts a `transcript-title` message to main. Main — the sole
writer — turns that into a synthetic `TranscriptTitle` events row on its writable
connection and pumps a wake; the reducer folds it as the priority-3 `transcript`
title.

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
tombstones retract). As of schema v11 each epic also embeds its plan/close-verb
jobs as a `jobs` JSON array, and each task element embeds its own work-verb
jobs as a nested `jobs` sub-array — fanned in from the reducer's jobs-side
writes whenever a SessionStart spawn name parses as `{plan|work|close}::<ref>`,
so the single `epics` collection serves epic + tasks + associated sessions in
one subscribe. File deletions are filesystem-synchronized: a live delete fires
a tombstone, and a boot-reconciliation sweep retracts anything deleted while
the daemon was down. It is
the second instance of the same producer archetype as the transcript worker:
read-only / write-free, feeding the log only via main. Both producers also
self-recover from a *dropped-events* FSEvents overrun: on the recoverable
"...must be re-scanned" watcher error they schedule a debounced, single-flight
re-scan of their existing change-gated boot-scan path (per affected root for the
plan worker), recovering the missed change in-process without a daemon restart
and without re-subscribing.

A **fifth** Worker thread is the exit-watcher: it owns a kqueue (macOS) or
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

The five workers are fully independent; main supervises all five lifecycles
but routes none of their traffic, and any worker's `error` event escalates
the whole process to a clean restart — with that single scoped exception, the
recoverable drop signal on the transcript and plan watchers, which
deliberately does NOT escalate (a re-scan throw is swallowed, never reaching
the restart path).

For the in-codebase module map, event-sourcing invariants, and the "DO NOT"
list, see [CLAUDE.md](./CLAUDE.md).

## Inspect

```sh
# Recent jobs (state: working|stopped|ended|killed; title_source: NULL=unset, 'spawn'=from --name, 'payload'=from prompt, 'transcript'=from live custom-title; plan_verb / plan_ref derived from a planctl-shaped spawn name at SessionStart, NULL otherwise):
sqlite3 ~/.local/state/keeper/keeper.db \
  'SELECT job_id, state, title, title_source, plan_verb, plan_ref, last_event_id FROM jobs ORDER BY updated_at DESC LIMIT 10'

# Planctl-spawned jobs only — indexed via the partial `idx_jobs_plan_ref WHERE plan_ref IS NOT NULL` so this lands the index, not a scan:
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT job_id, plan_verb, plan_ref, state, title FROM jobs WHERE plan_verb = 'close' ORDER BY updated_at DESC LIMIT 10"

# All Skill-tool plan:plan invocations across sessions — uses the partial idx_events_skill_name index:
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT session_id, datetime(ts,'unixepoch','localtime'), skill_name FROM events WHERE skill_name LIKE 'plan:%' ORDER BY id DESC LIMIT 20"

# Killed sessions specifically (proven-dead from outside the hook stream — SIGKILL, terminal-pane closure, reboot):
sqlite3 ~/.local/state/keeper/keeper.db \
  'SELECT job_id, state, pid, start_time FROM jobs WHERE state = "killed" ORDER BY updated_at DESC LIMIT 10'

# Plans projection — epics (each embedding its tasks AND its plan/close-verb jobs as JSON arrays) folded from the configured `.planctl` roots:
sqlite3 ~/.local/state/keeper/keeper.db \
  'SELECT epic_id, epic_number, title, status, json_array_length(jobs) AS epic_jobs_n FROM epics ORDER BY epic_number ASC LIMIT 10'
# Tasks live inside epics.tasks now — unnest with json_each to list them per epic:
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT e.epic_id, json_extract(t.value, '\$.task_id') AS task_id, json_extract(t.value, '\$.task_number') AS task_number, json_extract(t.value, '\$.title') AS title, json_extract(t.value, '\$.status') AS status FROM epics e, json_each(e.tasks) t ORDER BY e.epic_number ASC, task_number ASC LIMIT 10"
# Work-verb jobs per task — double-unnest epics.tasks then each task's embedded jobs sub-array:
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT e.epic_id, json_extract(t.value, '\$.task_id') AS task_id, json_extract(j.value, '\$.job_id') AS job_id, json_extract(j.value, '\$.state') AS state FROM epics e, json_each(e.tasks) t, json_each(json_extract(t.value, '\$.jobs')) j ORDER BY e.epic_number ASC, task_id ASC LIMIT 10"

# Raw event log tail (synthetic EpicSnapshot/TaskSnapshot/EpicDeleted/TaskDeleted rows appear here too):
sqlite3 ~/.local/state/keeper/keeper.db \
  'SELECT id, hook_event, session_id FROM events ORDER BY id DESC LIMIT 10'

# How far the reducer has folded:
sqlite3 ~/.local/state/keeper/keeper.db 'SELECT * FROM reducer_state'
```
