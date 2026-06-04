keeper — event-sourced Claude Code control-data daemon (Bun + bun:sqlite).

The hook plugin writes one `events` row per Claude Code hook invocation; the
`keeperd` daemon folds those events into the `jobs`/`epics` projections and
serves them read-only over a UDS subscribe socket. For the system map — event
log, reducer, worker threads, wire protocol — see `README.md` `## Architecture`.

**AGENTS.md symlink** — `AGENTS.md` is a symlink to this file
(`ln -s CLAUDE.md AGENTS.md`). Edit this file in place; never `rm`+recreate it.

**Plugin layout** — the repo root is itself the Claude plugin, loaded via
`claude --plugin-dir ~/code/keeper`. There is exactly ONE manifest
(`./.claude-plugin/plugin.json`) and ONE `./hooks/hooks.json` — never duplicate
either under a subtree, and never restore the retired `~/.claude/plugins/keeper`
symlink alongside the `--plugin-dir` load (double-registers the hook,
double-writes every event).

## Design stance

**Design the server for the ideal architecture; do not nickel-and-dime against
client churn.** The server (event log, reducer, projections, schema, RPC
surface) is the durable source of truth; clients (the `keeper` CLI subcommands,
future consumers) are cheap to change. Schema bumps, column renames, and enum
widenings are routine — never bend the server to preserve a lossy or misleading
shape because consumers already read it. If the event log knows a fact, the
projection surfaces it natively (full enum, raw timestamp); collapsing to a
binary or a derived label is the renderer's job, and only if it ever needs to.

## Event-sourcing invariants

- **Cursor + projection advance in the SAME `BEGIN IMMEDIATE` transaction.** Each
  fold writes the projection (`jobs` / `epics` / `usage` / `git_status` /
  `profiles` / `file_attributions` / `dispatch_failures`) AND bumps
  `reducer_state.last_event_id` in one transaction. A crash mid-fold rolls back
  both; boot drain re-folds idempotently. This is the exactly-once-per-event
  guarantee — never split the two writes across transactions.
- **Re-fold determinism is sacred.** Every projection-driving fact lives in the
  immutable event log; nothing is written straight to `jobs`/`epics`. A re-fold
  from scratch (rewind cursor, `DELETE FROM` the projections, re-drain) must
  reproduce byte-identical rows — so all derived arrays/links are built from
  stable total-order sorts (never append), and NOTHING inside a fold may read
  wall-clock (`Date.now()`), env vars, the filesystem (`stat()`), or probe
  process liveness. Use the event's own `ts` for any time comparison. Hook-side
  derivers that stamp the sparse `events` columns are pure functions of the
  payload and are shared with the migration backfill so a re-derive converges.
- **Schema defaults match the zero-event projection.** Keep schema defaults and
  the reducer's no-op / seed branches in sync, so a re-fold from an empty table
  reproduces the same rows.
- **A malformed `data` blob folds to a safe value and the cursor still advances.**
  Never throw inside the fold transaction — a throw rolls back the cursor and
  wedges the reducer.
- **One drain code path serves boot and steady-state** (`drainToCompletion` loops
  `drain()` until it returns 0); one event per transaction so the WAL writer lock
  releases between events. Boot may pass a stateless `DrainOptions` to gate a real
  OS-level post-COMMIT yield (the bounce-window mitigation — WAL has no writer
  FIFO fairness, so without a true sleep a contending hook's `busy_timeout` retry
  loses the race and dead-letters). The sleep lives in `drain` AFTER `applyEvent`
  returns, never inside a fold. A forked boot drain is forbidden; pacing is one
  shared loop with a per-call knob. End-of-boot checkpoint is
  `wal_checkpoint(PASSIVE)`, never TRUNCATE (TRUNCATE waits on writers and starves
  a contending hook).
- **Sole-writer rules.** The hook is the sole writer of *hook* events and of
  per-pid NDJSON dead-letter files. Main is the sole writer of *synthetic*
  events (`TranscriptTitle`, `ApiError`, `InputRequest`, `EpicSnapshot` /
  `TaskSnapshot` / `EpicDeleted` / `TaskDeleted`, `UsageSnapshot` /
  `UsageDeleted`, `Killed`, `GitSnapshot` / `GitRootDropped` / `Commit`,
  `DispatchFailed` / `DispatchCleared`, `Dispatched` / `DispatchExpired`,
  `AutopilotPaused`, `BackendExecSnapshot`), of the
  `dead_letters` operational sidecar, and of the dead-letter replay path. The
  server-worker writes only the `approval` field on external `.planctl` JSON
  (atomic temp+rename) and bridges `replay_dead_letter`,
  `set_autopilot_paused`, and `retry_dispatch` to main — it never writes the
  event log itself. The restore-worker (epic fn-677) is the sole writer of
  `~/.local/state/keeper/restore.json` — a pure CONSUMER derived side-file
  that is NOT a projection, NOT in the event log, and never feeds either; the
  worker carries no `onmessage` handler and writes nothing through main —
  and under last-non-empty-wins (epic fn-689) an empty descriptor does NOT
  overwrite a prior populated snapshot, so the file survives reboot /
  seed-sweep zeroing for `scripts/restore-agents.ts` to read. Test
  isolation env-var list extends accordingly: `KEEPER_RESTORE_FILE` joins
  `KEEPER_DB` / `KEEPER_DEAD_LETTER_DIR` / `KEEPER_DROP_LOG` as a path that
  must be sandbox-overridden in every spawn test so the user's real
  `restore.json` is never touched. Producer workers (including the autopilot
  reconciler) feed the log only via main's writable connection; they never
  write the DB.
- **Producer-only liveness probing.** The boot seed sweep and the exit-watcher
  worker are the ONLY places that probe liveness (`kill(pid,0)`, kqueue, pidfd,
  `(pid, start_time)` recycle check). Folds NEVER re-probe — a re-probe inside a
  fold would break re-fold determinism.
- **PRAGMAs are connection-local** — `applyPragmas` runs on every `openDb` (each
  worker's read-only connection, the hook's fresh per-invocation connection).
  Without `busy_timeout` a connection defaults to 0 and contention surfaces as
  `SQLITE_BUSY` instead of a wait.
- **Migrations are forward-only** via `meta(schema_version)` + the ALTER slot in
  `migrate()`. Non-idempotent steps (backfill, destructive DROP) MUST be
  version-guarded. The daemon is the SOLE migrator; the hook opens with
  `{ migrate: false, prepareStmts: false }` and tolerates a behind-schema
  live DB by intersecting its known `events` columns with the live shape via
  `PRAGMA table_info('events')` once per invocation (fn-669) — a column the
  live DB lacks is omitted from the INSERT and lands NULL after migration,
  identical to the deriver's zero-event value. Turns the schema-bump deploy
  race from a total-drop window into a lossless-degraded one. **When you
  bump `SCHEMA_VERSION`, add the new version to keeper-py's
  `SUPPORTED_SCHEMA_VERSIONS` frozenset in `keeper/api.py` in the SAME
  change** — the Python reader (used by `jobctl commit-work` and
  `planctl render-approve-context`) is a hard whitelist, not a floor/ceiling,
  and gates loud on any unrecognized version, failing *every* `commit-work`
  on the host until updated. Additive bumps keeper-py never reads still must
  be listed; `test/schema-version.test.ts` enforces it.
- **Commit discharge is content-aware (schema v45 / fn-664.2).** The
  `GitSnapshot` payload's `dirty_files[]` carries per-file
  `{worktree_oid, index_oid, worktree_mode}` (the filter-correct
  `git hash-object` of the worktree bytes — WITHOUT `--no-filters`, so
  clean/CRLF filters match the stored blob — plus porcelain v2 `hI` / `mW`,
  both free off the parse), all frozen at producer time so a re-fold is
  deterministic. The `Commit` payload's `files[]` carries per-file
  `{path, blob_oid, committed_mode}` (the porcelain `mI` mode + new blob
  oid lifted off `git diff-tree -r --no-commit-id <oid>` — `null` on
  deletion / parse-miss). `committer_session_id` is the take-last
  canonical UUID lifted from a `Session-Id:` trailer (the historical
  source — preferred), falling back to `Job-Id:` (fn-670 / T1, the
  jobctl-stamped trailer — `job_id === session_id` is a keeper
  invariant, so `Job-Id:` carries the same UUID) when `Session-Id:` is
  absent or malformed; `null` when both are absent / malformed (global
  discharge). The hand-edited trailer wins per take-last policy if it
  disagrees with the coalesced fallback. `foldCommit` reads back the
  file's stored `(worktree_oid, worktree_mode)` from its
  `file_attributions` row (written by the latest GitSnapshot fold's
  pass-1 / pass-2 UPSERT + post-pass refresh — pure event-derived,
  in-tx) and stamps `last_commit_at` ONLY when the four axes are all
  non-null AND `blob_oid === worktree_oid && committed_mode === worktree_mode`. The four discharge READ predicates
  (`projectGitStatus` passes 2/3/4) are byte-identical to pre-v45 — only
  the WRITE site changed. ANY null axis falls back to the legacy
  UNCONDITIONAL timestamp discharge (the same path historical events
  take, so a cursor=0 re-fold over the pre-v44/v45 log reproduces
  byte-identical projections). This fixes the stage→re-edit→commit
  orphan: the worktree diverged from the staged-then-committed bytes,
  the gate suppresses discharge, and the editing session keeps its
  attribution claim. Symmetric across per-session and global discharge
  (the worktree oid is a per-file fact, not per-session). A chmod-only
  dirty file (equal blob, different mode) is also caught — content-equality
  alone would have wrongly discharged it. **Commit-trailer fact set (schema
  v54 / fn-695).** The same `Commit` payload also freezes three planctl
  trailers the git-worker lifts off the commit message — `Planctl-Op`,
  `Planctl-Target`, and a v4-UUID `Session-Id` (stamped by planctl on every
  `chore(planctl)` commit; omitted when `PLANCTL_SESSION_ID` is absent and
  the commit still lands). When all three are non-null and the target
  parses, `foldCommit` ALSO triggers the per-session creator/refiner edge
  rebuild (`syncPlanctlLinks(committer_session_id, …)`) — it NEVER writes
  the `epic_links` / `job_links` cells itself; `syncPlanctlLinks` stays the
  single writer and re-derives the edge from the deduped UNION of the legacy
  `planctl_op` stdout scrape AND this durable commit-trailer fact (so an edge
  survives a stdout pipe / `grep` / truncation that NULLs `planctl_op` — the
  fn-635 failure — plus client + server reboots). Pre-fn-695 `Commit` events
  lack the three trailers, so the commit channel is a no-op over the
  historical log and a from-scratch re-fold stays byte-identical.
- **Task→committing-session link (schema v49 / fn-670 T2).** The git-
  worker also parses `Task:` trailers (multi-valued, take-all per
  `parseTaskTrailers`, validated against `TASK_TRAILER_RE` —
  `fn-N-slug.M`) and freezes them as `task_ids: string[]` on the same
  Commit event payload. The reducer's `foldCommit` per-session arm,
  gated on BOTH `committer_session_id != null` AND
  `task_ids.length > 0`, stamps a new `last_commit_for_task_at` field
  (producer-time `committed_at_ms / 1000`) on the embedded job
  element whose `job_id == committer_session_id` under each named
  task element inside the parent epic's `tasks[].jobs[]` — bumping
  `last_event_id` / `updated_at` and re-sorting via
  `sortEmbeddedJobs`. The field rides FREE in the opaque JSON-TEXT
  `tasks` cell on `epics` (NO new real column — v48→v49 is a
  whitelist-only schema bump, listed in `keeper/api.py`'s
  `SUPPORTED_SCHEMA_VERSIONS` in the same change). **Clobber guard:**
  `buildEmbeddedJob` reads the prior element's field forward across
  every `syncJobIntoEpic` re-sync (the OLD-element carve-out — the
  same pattern that preserves `worker_phase` / `runtime_status` /
  `tier`), because the field is a Commit-event fact, NOT a jobs-row
  fact; without the carve-out, every job-tick would clobber the link
  the consumer (`planctl pick_target_job`) relies on. The
  commit-before-claim edge case (no embedded job element yet under
  the named task) loses the link deterministically rather than
  shelling a job element foldCommit doesn't otherwise own — a real
  worker's SessionStart precedes its own commit by definition, and
  the cursor=0 re-fold replays events in id order so the ordering
  reverses anyway. Re-fold determinism is preserved: pre-fn-670
  Commit events lack the `task_ids` field; `extractCommit` defaults
  to `[]` so the link write is a no-op over the historical log, and
  a from-scratch re-fold reproduces byte-identical `epics` rows.
- **Planctl-written files attribute honestly (schema v46 / fn-666).** The
  planctl CLI's stdout `planctl_invocation` envelope carries a
  repo-relative `files[]` array naming every `.planctl/{epics,tasks}/*.json`
  and `.planctl/specs/*.md` it wrote during the op. The deriver
  (`extractPlanctlInvocation`) lifts it into `events.planctl_files`
  (JSON-array TEXT, NULL on miss / non-array / empty / runaway-size), and
  the reducer's `planctl_op != null` fold seam mints one
  `source='planctl'` `file_attributions` row per path under
  `project_dir = state_repo` (the envelope's absolute repo path, extracted
  in-fold from `event.data`) + `event.session_id` + the repo-relative path
  + `last_mutation_at = event.ts` + `op = event.planctl_op`. The pass-2
  inferred-guard widens to `source IN ('tool','bash','planctl')` so a
  planctl file does NOT also get a spurious inferred attribution; the
  pass-3 render whitelist accepts `'planctl'` so the source badge
  surfaces honestly. Discharge flows through the same `foldCommit` path
  as `'tool'`/`'bash'`/`'inferred'` (a `chore(planctl)` commit clears
  the attribution row via the same `last_commit_at` UPDATE) — no
  per-source branch. Without this mint, `.planctl/` files orphaned the
  instant they flashed dirty (the 559-orphan spike documented in
  fn-666's epic spec). The stdout envelope remains the SOLE driver of this
  `file_attributions` mint — epic fn-695 moved only the creator/refiner edge
  off the envelope onto the durable commit-trailer union (see the v54 / fn-695
  callout on the content-aware discharge bullet above); the two uses of the
  envelope/commit channels are orthogonal and this attribution path is
  unchanged.

## DO NOT

- **No general write path into the reducer.** The socket carries `query` (read,
  unchanged and read-only) and `rpc` (mutate) frames — no reactor. RPC writes are
  scoped to exactly four surfaces: (1) the `approval` field on `.planctl` files
  (`set_task_approval` / `set_epic_approval`, atomic temp+rename), (2) the
  delayed-real-event replay path (`replay_dead_letter`), (3) the autopilot
  failure-clear path (`retry_dispatch`, which appends a `DispatchCleared`
  synthetic event and lets the reducer DELETE the matching `dispatch_failures`
  row on the next drain), and (4) the autopilot pause flag
  (`set_autopilot_paused`, which appends an `AutopilotPaused{paused}` synthetic
  event FIRST — so the reducer folds it into the singleton `autopilot_state`
  projection on the next drain and the viewer's banner reflects truth — THEN
  flips the in-memory worker gate + relays to the autopilot worker only on a
  successful insert; schema v47, fn-667). RPC handlers MUST NOT write
  `jobs`/`epics`/`dispatch_failures`/`autopilot_state` directly — approval
  changes round-trip through the plan-worker watcher →
  `EpicSnapshot`/`TaskSnapshot` → reducer, retry round-trips through main →
  synthetic event → reducer, and pause round-trips through main → synthetic
  event → reducer, so a re-fold sees them all. *Why only these four:* approval
  is the one piece of human state with no hook to attach it to; replay
  recovers events the hook failed to insert; retry clears a sticky failure (no
  auto-retry — every cleared failure is an explicit human decision); pause is
  human-intent control state event-sourced through the same fold path as every
  other projection (boots paused via the daemon's boot-append re-arm, fn-667
  — the in-memory `autopilotPaused` is retained as the worker-relay + boot-race
  guard but is no longer the source of viewer truth). Everything else is the
  planner's/worker's job or belongs to the hook.
- **No kernel file watchers ON KEEPER'S OWN SQLite DB** (`fs.watch`, FSEvents,
  kqueue, chokidar) — they drop same-process writes and miss WAL writes on macOS.
  Use `PRAGMA data_version` polling on a read-only autocommit connection as the
  only *external* DB-change primitive — the one detection mechanism for a write
  another connection made. *Complementary same-process wake (fn-694 lever B,
  extended fn-699):* main may `postMessage({type:"kick"})` to a reader worker
  straight after `drainToCompletion` returns (post-COMMIT) so it runs its
  reconcile without waiting for the next poll tick — sent to BOTH the
  server-worker (runs `diffTick`) and the tab-namer worker (runs its rename
  tick). The kick is an in-process message bus signal, NOT a file/DB watcher —
  it does not observe the DB; it is fired by main precisely because main just
  folded. The `data_version` poll remains the level-triggered backstop (the
  kick is edge-triggered and subject to a lost-wakeup race); each kick handler
  is idempotent (the diff / rename is version- or convergence-gated) so a
  kick+poll double-fire is a harmless no-op. *Carve-out (files):* native `@parcel/watcher` on
  *external* trees written by other processes IS permitted (transcript files,
  `.planctl` trees, the zellij-events plugin feed dir at
  `~/.local/state/keeper/zellij-events/` written by the fn-684 wasm bridge
  plugin — one append-only `<session>.ndjson` per zellij session); treat an
  event (or a drop-overrun `err`) as "go look," never as the data — always
  `fstat` + safe-parse. *Carve-out (processes):* kqueue
  `EVFILT_PROC|NOTE_EXIT` / `pidfd_open`+`epoll` on EXTERNAL process descriptors
  is permitted (exit-watcher), with a post-register `kill(pid,0)` probe and
  `(pid, start_time)` identity guarding pid recycling.
- **No third-party deps in the hook.** Keep `plugin/hooks/events-writer.ts`'s
  import graph to `bun:sqlite` + local files only — Bun cold start is ~30ms and
  the SessionEnd hook has a 1.5s timeout budget.
- **The hook must always exit 0.** A non-zero exit can fail-closed the human's
  session. Losing one event row is acceptable; wedging the agent is not. On a
  failed INSERT the hook writes a per-pid NDJSON dead-letter file (recoverable via
  `replay_dead_letter`) and still exits 0. Never let a parse/DB failure propagate;
  log to stderr only. A column-narrowed INSERT (`known ∩ live` via
  `PRAGMA table_info`, fn-669) is a SUCCESS path — the row lands with the
  not-yet-migrated column NULL'd — NOT a dead-letter. The dead-letter path
  still fires for genuine failures (missing `events` table, corrupt DB, real
  BUSY exhaustion).
- **Test isolation: never spread `...process.env` for state-bearing vars.** Every
  test that spawns the real hook MUST route through a shared sandboxed base-env
  helper overriding ALL four state paths (`KEEPER_DB`, `KEEPER_DEAD_LETTER_DIR`,
  `KEEPER_DROP_LOG`, `KEEPER_RESTORE_FILE`) under the per-test `tmpDir`. A bare
  `{ ...process.env, KEEPER_DB: ... }` strands the others at production defaults
  and pollutes the user's real `~/.local/state/keeper/` feed. Apply the sandbox
  AFTER any `undefined`-clears-key loop so a caller can't re-open the leak.
- **No in-process self-heal.** Any unrecoverable error (including any worker's
  `error` event) calls `fatalExit` → `process.exit(1)`; the LaunchAgent restarts
  the single recovery path. Never respawn a worker in-process. The producer
  workers' FSEvents drop-recovery re-scan is data recovery, not self-heal — the
  subscription stays live and a re-scan throw is swallowed to stderr.
- **Plans are READ-ONLY except the `approval` field.** The plan worker watches the
  `.planctl/{epics,tasks}` trees plus the `.planctl/state/tasks/` runtime-status
  sidecar and folds snapshots into `epics`. The only permitted plan write is the
  `approval` RPC pair above; no other field is RPC-writable and the socket carries
  no other plan command surface.
- **Scraping is scoped, not general.** Transcript tailing lives in the daemon's
  transcript worker only (never the hook). The hook MAY scrape the parent claude
  process's `--name`/`-n` and read `CLAUDE_CONFIG_DIR` — but ONLY on
  `SessionStart`, ONLY single-level `process.ppid` (no PPID-walking), frozen into
  that one event. The hook ALSO reads `ZELLIJ` / `ZELLIJ_SESSION_NAME` /
  `ZELLIJ_PANE_ID` (schema v48 / fn-668) on EVERY event as pure synchronous
  `process.env` reads (no fork, no fs, no PPID-walk) and freezes the captured
  coordinates onto the events row; the reducer's COALESCE fold lifts them onto
  `jobs` from the row payload alone, NEVER re-reads env. FORBIDDEN: any OTHER
  periodic/other-event scraping, multi-session lineage, any other env read, and
  any env read inside a fold.
- **Out of scope:** prise/env-var integration, multi-session lineage, harness_meta.

## Worker contract

Every keeper Worker thread follows the same durable contract:

- **`isMainThread` guard** — a plain `import` of the worker module is inert.
- **Own `openDb` connection** (read-only for readers); never shares main's.
- **Typed message protocol** — `{ kind }` for worker→main, `{ type }` for
  main→worker. Two reader workers accept a `{type:"kick"}` message from main as
  a supplementary fast-path wake (fn-694 lever B, extended fn-699): the
  server-worker (second thread, runs `diffTick`) and the tab-namer worker
  (twelfth thread, runs its rename reconcile tick). Main posts it after
  `drainToCompletion` returns so the worker reconciles immediately. The kick
  handler is in the no-self-heal path, so the tick is wrapped in try/catch
  (log+continue, never propagate) — an uncaught throw there would crash the
  worker and bounce the daemon. Each worker's `data_version` poll is the
  stall-recovery backstop, not the primary fast path.
- **Supervisor-owned lifecycle** — main spawns each worker after migrate + boot
  drain and is the only one that terminates it (`{ type: "shutdown" }`, await
  `close`, then `terminate`). A worker owning an external resource (socket, lock
  file, watcher subscription, re-scan timer, kqueue/pidfd fd) MUST release it in
  its own shutdown handler — `terminate()` alone leaks it.
- **No in-process self-heal** — a worker's `error` event escalates to `fatalExit`.

*Carve-out (out-of-process producers, fn-684).* Not every producer is a Bun
postMessage worker. The fn-684 zellij bridge plugin is a Rust wasm module the
human's dotfiles load into every zellij session; it runs INSIDE the zellij
server (a different process from keeperd) under WASI sandbox, and it pushes
data to keeper by appending NDJSON lines to its pinned `/host` mount (=
`~/.local/state/keeper/zellij-events/<session>.ndjson`). Its keeperd-side
counterpart is the `zellij-events-worker` (a normal `@parcel/watcher`
producer-archetype Worker thread) plus the main-side `scanZellijEventsDir`
ingestion, both of which still follow the rules above. The plugin itself is
not bound by the Bun-thread contract — but it inherits two adjacent
disciplines: lines are flushed per complete NDJSON record (the consumer holds
a carry-buffer for trailing partial bytes), and the file is opened
`O_APPEND` so a #5177 double-load shares one append stream instead of
corrupting it. Sole-writer rules are preserved: the plugin is the sole writer
of the `.ndjson` files, and main remains the sole writer of the synthetic
`BackendExecSnapshot` events it mints from those lines.

## Autopilot dispatch gates

Operational behavior of the server-side reconciler (`src/autopilot-worker.ts`).
An unpaused autopilot that "does nothing" is almost always one of these gates
firing correctly — check them before concluding it is broken:

- **Won't dispatch against an uncommitted epic (fn-629).** The plan-worker
  producer (`src/plan-worker.ts`, the **fourth** Worker thread) gates
  `EpicSnapshot` / `TaskSnapshot` emission on a synchronous
  `git cat-file -e HEAD:<relpath>` check (the live worker passes
  `isPathInHead` into `PlanScanner`; the `.planctl/{epics,tasks}/<id>.json`
  is bounced into a per-scanner `pending` set instead of emitted when the
  path is not in HEAD). The reducer NEVER reads git/fs/wallclock — the
  gate lives entirely at the producer, per the event-sourcing invariants
  above. A `git commit` does not change the file's worktree bytes so
  FSEvents will not re-fire on commit; main posts `recheck-pending` on
  every `GitSnapshot` / `Commit` it writes, and the worker's
  `recheckPending()` re-runs `onChange` per pending path — a freshly
  committed path emits its snapshot and leaves pending, no permanent
  strand. This is the load-bearing harm-fix for the fn-627 duplicate-
  dispatch incident: an epic that planctl wrote but had not yet committed
  is never visible to `computeReadiness`, so the autopilot cannot
  dispatch a worker against it. The planctl side commits at the
  `output.emit()` seam (one transaction per mutating verb), so the gate
  trusts that an envelope `success: true` on stdout means the file is in
  HEAD.
- **Won't dispatch into a dirty repo.** `computeReadiness` predicate 6.5
  (`src/readiness.ts`, block reason `git-uncommitted`) suppresses every dispatch
  whose target repo has `git_status.dirty_count > 0` — so a spawned worker can
  never commit unrelated uncommitted changes. The target is usually keeper
  itself, dirtied by your own edits or a not-yet-committed `.planctl` approval
  chore. Confirm: `git status` + `SELECT project_dir, dirty_count FROM
  git_status`.
- **Won't dispatch the closer against a taskless epic (fn-700).** A keeper
  epic and its tasks fold as two separate single-event transactions
  (`EpicSnapshot`, then `TaskSnapshot`); between them the epic exists with
  ZERO tasks. `evaluateCloseRow` predicate 10's `for…of epic.tasks` loop is
  vacuously true over an empty list, so the close-row verdict would fall
  through to `ready` and a reconcile landing in that partial-projection
  window would dispatch a closer against an epic with no work (observed live
  on fn-698 — closer + worker dispatched ~8s apart; functionally an
  auth-bypass-on-empty-collection in a dispatch gate). `evaluateCloseRow`
  (`src/readiness.ts`) blocks it with block reason `epic-no-tasks` at a
  DELIBERATELY LATE rank 9.5 — after predicates 1–7, immediately before
  predicate 10 — so every more-specific verdict still wins (first-placement
  would mask `epic-not-validated` on a pre-`EpicSnapshot` stub and
  `planner-running` during active scaffolding). The autopilot side is
  non-dispatchable by construction: `verbForVerdict`
  (`src/autopilot-worker.ts`) returns `null` for every blocked reason except
  `job-pending`, and a test pins that lock. No reducer / schema / keeper-py
  change — the `Verdict` is computed client-side at read time, not folded.
- **Won't release the mutex while the worker session is still alive (fn-671).**
  `computeReadiness` predicate 1 (`src/readiness.ts`) only collapses a task to
  `{tag:"completed"}` when `worker_phase==="done"` AND `approval==="approved"`
  AND no embedded job is `working` AND no running sub-agent is bound to any
  embedded job — administrative completion (planctl `done` + human approval)
  is orthogonal to process liveness, and they race. Until the Claude session
  Stop/SessionEnd lands AND every sub-agent finishes, the task stays at
  `running:job-running` / `running:sub-agent-running` / `running:sub-agent-stale`
  and occupies both the per-epic AND per-root mutex via `isLiveWorkOccupant` /
  `isRootOccupant` — so a dependent / sibling ready task on the same root is
  held at `single-task-per-root` until the prior worker truly winds down.
  Crash-robust on the main-job axis via the reducer's `Killed` arm
  (exit-watcher + boot `seedKilledSweep` unilaterally fire the exit signal on
  OS-level death). A sub-agent that dies silently without emitting
  SubagentStop has no `Killed`-equivalent backstop and surfaces as
  `sub-agent-stale` (still mutex-occupying — correctness over throughput);
  clear by autopilot pause + manual replay rather than auto-reaper.
- **Level-triggered on `PRAGMA data_version`.** The worker reconciles only on a
  DB write (a hook event, a fold). `set_autopilot_paused {paused:false}` (play)
  additionally kicks one cycle, and one cycle runs at boot — but absent those, a
  quiescent DB leaves ready work undispatched until the next incidental write.
- **The `[paused]` banner in `keeper autopilot` IS authoritative (schema v47 / fn-667).**
  The viewer subscribes the singleton `autopilot_state` projection — fed by
  the reducer's `AutopilotPaused` fold arm, mint-ordered ahead of every gate
  flip (the `set_autopilot_paused` RPC appends the event FIRST, then flips
  the in-memory worker gate only on a successful insert). The banner reads
  the row's `paused` column verbatim. A seed `paused: true` shows for the
  sub-ms window between viewer launch and the first subscribe edge; after
  that the banner is byte-honest with the worker's dispatch decision.
- **Boots paused (safety default), one-at-a-time stagger.** The flag is
  event-sourced — the daemon's boot drain unconditionally appends
  `AutopilotPaused{paused:true}` BEFORE `serverWorker` spawns, so a viewer
  subscribing the instant the socket opens reads a real `paused=1` row (not
  a hardcoded fallback). The in-memory `autopilotPaused` variable on main
  is retained as the autopilot-worker relay channel + the boot-race guard
  for the worker spawn ordering, but is no longer the viewer's source of
  truth. `confirmRunning` serializes launches, so dispatch is paced, not a
  burst.
- **Closes the launch → SessionStart blind window via the durable
  `pending_dispatches` projection (schema v50, fn-678).** Before calling
  `launch()`, `confirmRunning` mints a `Dispatched` synthetic event (outbox
  ordering: intent before side-effect). The reducer folds `Dispatched` into
  a `pending_dispatches` row keyed `(verb, id)`; `loadReconcileSnapshot`
  reads the table each cycle and populates `liveTabKeys: Set<DispatchKey>`.
  A fifth suppression arm in `reconcile()` fires when `liveTabKeys.has(key)`
  is true — alongside the `state.paused`, `state.inFlight`,
  `snapshot.failedKeys`, and `isOccupyingJob` arms — so a launched but
  not-yet-SessionStart-bound worker keeps its slot held without any live
  zellij probe. `reconcile()` stays pure: it reads the synchronous Set, never
  the backend. The row discharges when `SessionStart` folds (reducer DELETE),
  or via a producer-side TTL sweep on the 60s heartbeat (120s ceiling,
  `DispatchExpired`) when the bind never arrives — so a phantom row from a
  crash between mint and launch self-clears without human intervention. The
  tab name is now a purely cosmetic label as far as dispatch dedup and reap
  are concerned (fn-678 stands — neither path reads it); `ExecBackend`
  exposes `launch`, `closeByTabId`, `focusPane`, `resolveTabForPane`, and
  `renameTab` — the focus-safe `rename-tab-by-id` op used by the
  tab-namer worker (fn-680, the eleventh worker thread, the aesthetic
  side-effector) to converge live job tabs onto transcript-derived
  titles. Reap (`autoclose_windows`) uses `closeByTabId(session, tabId)`
  off `jobs.backend_exec_{session_id,tab_id}` (fn-668), not the tab name.
