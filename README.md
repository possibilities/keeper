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
on `WHERE col IS NOT NULL` (the planctl columns share a composite
`(session_id, id) WHERE planctl_op IS NOT NULL` index for the per-session
ordered scan); `events.config_dir` rides without its own index — it is
read off `jobs.config_dir` (a steady-state attribution column), not the
event log.

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
page that doubles as a live subscription. Five collections register today —
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
git status — branch, ahead/behind, dirty + orphaned file lists, per-live-job
dirty/planctl groupings), and `usage` (one row per agentuse profile observed
at `~/.local/state/agentuse/<id>.json` — target, multiplier, session+week
percent and reset timestamps). The
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
Three example clients ship in `scripts/` (`board.ts`, `autopilot.ts`,
and `approve.ts`); see [Example clients](#example-clients) for usage.

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
   Override the path with the `KEEPER_SOCK` environment variable. Three example
   clients ship in `scripts/` — `board.ts` and `autopilot.ts` (subscribe;
   both go through `src/readiness-client.ts`) and `approve.ts` (RPC) —
   see [Example clients](#example-clients).

## Example clients

Four scripts under `scripts/` demonstrate the subscribe + RPC protocols.
`board.ts` is the read-only subscribe client (combined epics + jobs view on
one connection); `autopilot.ts` is its dispatch-oriented sibling (flat
command list plus a `===`-delimited "ready" block); `git.ts` watches the
`git` worktree collection; `approve.ts` is the RPC client (single-shot
`rpc` → `rpc_result`, no subscription). The three subscribe clients share
helpers in `src/readiness-client.ts` — `subscribeReadiness` owns the
three-collection lifecycle (board + autopilot) and `subscribeCollection`
owns the single-collection lifecycle (git); both feed
`computeReadiness` / row-list callbacks (the pure verdict pipeline lives
in `src/readiness.ts` as library code, not a runnable script). All three
subscribe clients accept a `--live` flag that enters alt-screen mode
with per-line ANSI diff and keyboard navigation (←/h/k prev frame,
→/l/j next, g oldest, G/End/Esc return to live, q/Ctrl-C quit) — when
the script's stdout or stdin isn't a TTY (piped, redirected, or under
CI) `--live` silently behaves as if it wasn't set. Run any of them with
`bun scripts/<name>.ts --help`.

- `board.ts` — combined "board" UI over the `epics`, `jobs`, and
  `subagent_invocations` collections. Subscribes to all three on a single
  connection and emits one combined frame per change, led by `---`, with
  a `~~~` divider between the epics body and the jobs body (and a second
  `~~~` inside the jobs body splitting ambient sessions from
  planner/worker/closer rows). Uses server-default scope for all three:
  epics `{ status: "open", approval: { ne: "approved" } }`, jobs live
  only (`working + stopped`), `subagent_invocations` full per-job
  timeline. Each epic renders as a header line —
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
  Job/link rows also carry two optional stoppage-annotation pills that
  stack after `[state]` in lifecycle order: `[failed:<kind>]` (red /
  error bucket) when the session's last Claude-API request hit a
  terminal HTTP failure — the six rendered kinds are `rate_limit |
  authentication_failed | billing_error | server_error |
  invalid_request | unknown` — and `[awaiting:<kind>]` (yellow / warn
  bucket) when the session is stopped on a built-in interactive tool
  that fires no hook of its own (currently `[awaiting:ask_user_question]`,
  future-extensible). Both pills color through prefix fallbacks
  (`failed:*` → `error`, `awaiting:*` → `warn`), so future kinds need
  no code change.
  The byte-compare emit gate keeps the stream quiet when row churn
  doesn't surface in the render. Reconnects across keeperd restarts;
  Ctrl-C unsubscribes cleanly. Every emitted frame is mirrored to three
  per-pid `/tmp` sidecar files (combined JSON state, frame text, unified
  diff vs. the previous emit); `--live` enters a real TUI (alt-screen +
  per-line ANSI diff + ring-buffered frame history with keyboard
  navigation) AND indexes the sidecars so past frames remain
  inspectable. The keymap is `←/h/k` previous frame, `→/l/j` next, `g`
  jump to oldest, `G`/`End`/`Esc` snap to live, `q`/`Ctrl-C` quit; when
  stdout/stdin isn't a TTY (piped, redirected, CI) `--live` silently
  behaves as if it wasn't set.

  ```sh
  bun scripts/board.ts            # combined board, default scope
  bun scripts/board.ts --live     # alt-screen TUI with indexed sidecars
  ```

- `autopilot.ts` — dispatch-oriented sibling of `board.ts`. Subscribes
  through the same `src/readiness-client.ts` helper and emits two
  `===`-delimited blocks per frame, led by `---`. Block 1 is the flat
  ordered command list — two lines per task (`cd <target_repo> && claude
  '/plan:work <id>'` + `bun scripts/approve.ts <id>`) plus a virtual
  close pair per epic (`/plan:close` + approve) — in the same traversal
  order as `board.ts`. Block 2 lists only the pairs whose readiness
  verdict is `{ tag: "ready" }` — the same set surfaced by board's
  `[ready]` pills, prefixed by a one-line `#` header explaining that
  this is "any one of these can be dispatched next," NOT a parallel
  work queue (the single-root post-pass in `src/readiness.ts` keeps at
  most one ready row per project root). Byte-compares the combined body
  so a verdict transition with no task-set change still emits a new
  frame. Same three sidecar files + `--live` alt-screen TUI as
  `board.ts` (per-line ANSI diff, ring-buffered frame history, keymap
  `←/h/k`/`→/l/j`/`g`/`G`/`Esc`/`q`; non-TTY behaves as if `--live`
  wasn't set). SIGINT calls the live-shell's `dispose()` first
  (terminal restoration) then the helper's `dispose()` and exits 0.

  ```sh
  bun scripts/autopilot.ts            # two-block dispatch list, default scope
  bun scripts/autopilot.ts --live     # alt-screen TUI with indexed sidecars
  ```

- `git.ts` — single-collection subscribe client over the `git`
  collection (planctl-backed worktree status: branch, ahead/behind,
  dirty + orphaned file lists, and per-live-job dirty/planctl file
  groupings). Uses `subscribeCollection` from `src/readiness-client.ts`
  (the same lifecycle primitive that powers the readiness clients,
  scoped to one collection). Each frame is led by `---`; one block per
  non-empty worktree row, all-zero rows dropped. Same three per-pid
  `/tmp` sidecar files (JSON state, frame text, unified diff vs.
  previous) + `--live` alt-screen TUI (per-line ANSI diff, ring-
  buffered frame history, keymap `←/h/k`/`→/l/j`/`g`/`G`/`Esc`/`q`;
  non-TTY behaves as if `--live` wasn't set). `--project-dir <path>`
  filters to one worktree root. SIGINT calls the live-shell's
  `dispose()` first (terminal restoration) then the helper's
  `dispose()` and exits 0.

  ```sh
  bun scripts/git.ts                          # all worktrees
  bun scripts/git.ts --project-dir /path/to   # one worktree only
  bun scripts/git.ts --live                   # alt-screen TUI
  ```

- `usage.ts` — single-collection subscribe client over the `usage`
  collection (one row per agentuse profile observed at
  `~/.local/state/agentuse/<id>.json`: target, multiplier, session+week
  percent + reset timestamps). Uses `subscribeCollection` from
  `src/readiness-client.ts` (same lifecycle primitive as `git.ts`).
  Renders one `---`-delimited frame to stdout, one line per profile;
  byte-compares the rendered frame so fetch-only refresh cycles produce
  no visible re-render. Three per-pid `/tmp` sidecar files (JSON state,
  frame text, unified diff vs. previous) indexed via a meta sidecar.
  No `--live` / TUI yet (a later epic may promote this script when a
  freshness signal lands). SIGINT calls the helper's `dispose()` and
  prints sidecar paths on exit.

  ```sh
  bun scripts/usage.ts                # all profiles
  bun scripts/usage.ts --sock /tmp/x  # socket override
  ```

- `approve.ts` — the RPC client. Single-shot: opens a `Bun.connect`, sends
  one `rpc` frame for `set_task_approval` or `set_epic_approval`, awaits the
  `rpc_result` (or `error`), and exits. No subscription, no reconnect loop.
  Approval is a first-class planctl field, so the three valid values are
  `approved`, `rejected`, and `pending` — there is no `clear` (set to
  `pending` instead). The CLI infers epic vs. task from the id's shape
  (trailing `.N` marks a task).

  ```sh
  bun scripts/approve.ts <epic_id>                   # approved (default)
  bun scripts/approve.ts <epic_id> pending           # reset to pending
  bun scripts/approve.ts <epic_id>.<task_n> rejected # reject one task
  ```

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

The `events` table is a durable append-only log (with eight sparse
top-level signals partial-indexed for cheap cross-session lookup —
`slash_command`, `skill_name`, `tool_use_id`, and the five-column
`planctl_*` envelope; see [What keeper is](#what-keeper-is)); the reducer
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
path key like `"000003.000007"`). Both are reducer-derived inside
`syncPlanctlLinks` from the existing `job_links` + `jobs.plan_verb` /
`plan_ref` substrate; an `EpicSnapshot` carve-out preserves them across an
approval-RPC round-trip (alongside `tasks` / `jobs` / `job_links`). The
`EPICS_DESCRIPTOR.defaultSort` flips from `epic_number asc` to
`sort_path asc`, so a closer-created child epic slots directly below its
parent in the default page; `sort_path` overflows to `''` at the documented
ceiling `epic_number >= 1_000_000` (safe-fold; the reducer never throws
inside `BEGIN IMMEDIATE`). As of schema v25, each `epics.job_links`
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

The six workers are fully independent; main supervises all six lifecycles
but routes none of their traffic, and any worker's `error` event escalates
the whole process to a clean restart — with that single scoped exception, the
recoverable drop signal on the transcript and plan watchers, which
deliberately does NOT escalate (a re-scan throw is swallowed, never reaching
the restart path).

Readiness is a client-side library today, not a server-side collection.
`src/readiness.ts` is the shared verdict pipeline consumed by
`scripts/board.ts` and `scripts/autopilot.ts` via the
`src/readiness-client.ts` helper, which subscribes to the three input
collections (`epics`, `jobs`, `subagent_invocations`) and runs
`computeReadiness` per emit. A server-side `readiness` projection
(synthetic-event recompute, persisted verdict map, diffed over the wire
like the other collections) is a natural future extension and
intentionally out of scope here — the inputs are already on the wire,
so the helper-in-`src/` design preserves the option without paying its
cost today.

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

# Plans projection — epics (each embedding its tasks AND its plan/close-verb jobs as JSON arrays) folded from the configured `.planctl` roots. As of schema v29 the natural sort is `sort_path ASC` (matches the `EPICS_DESCRIPTOR` default), which slots closer-created children directly below their parent:
sqlite3 ~/.local/state/keeper/keeper.db \
  'SELECT epic_id, epic_number, sort_path, created_by_closer_of, title, status, last_validated_at, json_array_length(jobs) AS epic_jobs_n FROM epics ORDER BY sort_path ASC, epic_id ASC LIMIT 10'
# Tasks live inside epics.tasks now — unnest with json_each to list them per epic. Schema v19 surfaces BOTH the planctl-native runtime status (`runtime_status`: todo|in_progress|done|blocked, ingested from `.planctl/state/tasks/<task_id>.state.json`) AND the derived worker-phase binary (`worker_phase`: open|done, derived from `worker_done_at`) — same task, two complementary axes:
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT e.epic_id, json_extract(t.value, '\$.task_id') AS task_id, json_extract(t.value, '\$.task_number') AS task_number, json_extract(t.value, '\$.title') AS title, json_extract(t.value, '\$.runtime_status') AS runtime_status, json_extract(t.value, '\$.worker_phase') AS worker_phase FROM epics e, json_each(e.tasks) t ORDER BY e.sort_path ASC, task_number ASC LIMIT 10"
# Work-verb jobs per task — double-unnest epics.tasks then each task's embedded jobs sub-array:
sqlite3 ~/.local/state/keeper/keeper.db \
  "SELECT e.epic_id, json_extract(t.value, '\$.task_id') AS task_id, json_extract(j.value, '\$.job_id') AS job_id, json_extract(j.value, '\$.state') AS state FROM epics e, json_each(e.tasks) t, json_each(json_extract(t.value, '\$.jobs')) j ORDER BY e.sort_path ASC, task_id ASC LIMIT 10"

# Usage projection — one row per agentuse profile observed at ~/.local/state/agentuse/<id>.json (freshness fields are excluded by design — keeper has no freshness signal yet):
sqlite3 ~/.local/state/keeper/keeper.db \
  'SELECT * FROM usage ORDER BY target, id'

# Raw event log tail (synthetic EpicSnapshot/TaskSnapshot/EpicDeleted/TaskDeleted rows appear here too):
sqlite3 ~/.local/state/keeper/keeper.db \
  'SELECT id, hook_event, session_id FROM events ORDER BY id DESC LIMIT 10'

# How far the reducer has folded:
sqlite3 ~/.local/state/keeper/keeper.db 'SELECT * FROM reducer_state'
```
