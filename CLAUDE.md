keeper — event-sourced Claude Code control-data daemon (Bun + bun:sqlite).

The keeper plugin ships two `PreToolUse(Bash)` hooks: the events-writer appends one
per-pid NDJSON line per Claude Code hook invocation (lock-free, no SQLite open), and
the branch-guard hard-denies subagent git branch create/switch. The `keeperd`
daemon's events-log ingester lands each events-writer line as one `events` row, folds
those events into the `jobs`/`epics` projections, and serves them read-only over a
UDS subscribe socket. The `events` table is the
canonical fold source, so re-fold determinism holds by construction. System map,
rationale, and incident history: `README.md` `## Architecture` and `.keeper/` specs.

## Repo facts

- **`AGENTS.md` is a symlink to this file.** Edit in place; never `rm`+recreate.
- **Two Claude plugins live as peers under `plugins/`** — `plugins/keeper/` (the
  events-writer HOOK plugin + `keeper:await` skill) and `plugins/plan/` (the
  plan plugin behind `keeper plan`, carrying the `plan:*` skills).
  agentwrap loads both from one `plugin_scan_dirs` entry pointing at `plugins/`.
  Each plugin has exactly ONE manifest at its own `<plugin>/.claude-plugin/plugin.json`
  and the keeper plugin exactly ONE `plugins/keeper/hooks/hooks.json` — never
  duplicate either, never add a `~/.claude/plugins/keeper` symlink (it
  double-registers the hook). The daemon, `cli/`, `src/`, and the compiled `keeper`
  binary STAY at the repo root; only the plugin surfaces live under `plugins/`.
- **Forward-facing advice only** in comments and docs: state current behavior and
  invariants, not change history (which lives in the diff). Full rule:
  `promptctl render code-comment-style`.

## Event-sourcing invariants

- **Cursor + projection advance in ONE `BEGIN IMMEDIATE` transaction** — the fold
  writes the projection AND bumps `reducer_state.last_event_id` together. Splitting
  them breaks the exactly-once-per-event guarantee.
- **Re-fold determinism is sacred** — for the **deterministic-replayed** projection
  class (the sacred default: `jobs`/`epics`/`commit_trailer_facts`/…). A from-scratch
  re-fold must reproduce byte-identical PROJECTION rows. Inside a fold: build derived arrays from stable
  total-order sorts (never append), and NEVER read wall-clock (`Date.now()`), env
  vars, the filesystem, or process liveness — use the event's `ts`. Only producers
  probe it. The guarantee scopes to the projection columns: the steady-state
  retention pass (`src/compaction.ts`) NULLs the redundant transcript bodies of a
  SHED CLASS no fold reads. fn-836 (v74) seeded it with the four PostToolUse
  mutation tools (`tool_input.file_path` promoted to `events.mutation_path`; the
  fold reads the column, never the shed body); fn-837 widened it to a POSITIVE
  cheap-column allow-list (`RETENTION_SHED_CLASS_PREDICATE`) spanning the
  fold-unread tool/Bash/Agent/Pre+PostToolUseFailure/Subagent*/BackendExecSnapshot/
  Notification classes (a new/unlisted type defaults to KEPT). Those payload bodies
  are intentionally non-reconstructable — forensic transcript depth defers to
  Claude Code's own `transcript_path` `.jsonl`. Every KEEP-SET body a fold actually
  reads stays inline in `events.data` forever (the keep-set IS the complement of
  the shed allow-list — `keeper plan` Bash, legacy Agent, PreToolUse:Agent, snapshot /
  session / prompt folds, …), so the projection re-fold stays byte-identical.
- **Never throw inside a fold.** Malformed `data` folds to a safe value and the
  cursor still advances; a throw rolls back the cursor and wedges the reducer. Schema
  defaults match the zero-event projection, so an empty re-fold reproduces the rows.
- **Projection-class taxonomy + skip-floor** (Marten's "Live projection lifecycle";
  central registry `LIVE_ONLY_PROJECTIONS` / `LIVE_ONLY_JOBS_COLUMNS` in `src/db.ts`).
  Three classes: **deterministic-replayed** (the sacred default above — byte-identical
  re-fold), **live-producer-fed** (the git surface: `git_status`, `file_attributions`,
  and the three `jobs` git-counters — NOT replayed from history; boot-seeded then kept
  current by incremental folds ABOVE a skip-floor; DELIBERATELY excluded from the
  byte-identical charter), and **control** (`reducer_state`, plus
  `git_projection_state`'s `floor` + `seed_required`). The skip-floor
  (`git_projection_state.floor`, a monotonic `events.id`) makes every git fold no-op
  for `id <= floor` — the gate lives INSIDE `applyEvent` by event type, never in the
  drain SQL (the global cursor must still advance for the deterministic projections).
  Above the floor a live fold stays pure (no git/clock/fs reads — those belong to the
  producer only). **Boot-producer contract:** capture `floor = max(events.id)` BEFORE
  the git scan, set `seed_required`, scan + populate the surface, then persist the
  floor + clear `seed_required` atomically; a crash mid-seed leaves `seed_required` set
  so the next boot re-seeds. The boot-seed runs AFTER drain, BEFORE serving.
- **A fold whose per-event cost grows with history is a re-fold time-bomb.** Any
  projection whose per-event fold cost scales with history length (the git fold's
  `computeRepoBashWindows` self-joins the whole log per `GitSnapshot` — the ~6-day
  fn-856 replay over 4.3M events) is a replay time-bomb: model it **live-only or
  constant-bounded**, never O(history)-per-event.

## Hook rules

- **Two hooks, two contracts.** The keeper plugin ships TWO `PreToolUse(Bash)` hooks:
  the events-writer (logs every invocation, NEVER blocks) and the branch-guard
  (`plugins/keeper/plugin/hooks/branch-guard.ts` — hard-blocks a subagent, detected by
  `agent_id`/`agent_type` presence, from git branch create/switch/worktree-add so
  workers stay on the current branch; ordinary git, file-restore, and non-subagent
  sessions pass).
- **Always exit 0.** A non-zero exit can fail-closed the human's session. On a HARD
  append failure the events-writer writes a per-pid dead-letter and still exits 0
  (losing one row is acceptable; wedging the agent is not). The branch-guard ALSO
  exits 0 — it denies via the `PreToolUse` JSON envelope
  (`hookSpecificOutput.permissionDecision:"deny"`), NOT a non-zero exit, so the
  exit-0 rule holds for both. Never "fix" the branch-guard to drop the deny or to
  exit non-zero: exit 0 is REQUIRED for the deny JSON to be honored, and a non-zero
  exit would fail-close the session.
- **No third-party deps, and NO `bun:sqlite`/`src/db.ts`.** The hook never opens
  SQLite — a stray `db.ts` symbol re-drags the 6.5k-line module and erases the
  cold-start win. Keep imports to `node:fs`/`node:os`/`node:path`, the dep-free
  `src/dead-letter.ts` serializers, and the pure `src/derivers.ts`/`exec-backend.ts`
  helpers. It never opens the DB, so it never migrates or probes schema.
- **Scraping is scoped.** On `SessionStart` only: parent claude `--name`/`-n` +
  `CLAUDE_CONFIG_DIR` (single-level ppid, no walking). On every event:
  `TMUX`/`TMUX_PANE`/`KEEPER_TMUX_SESSION`/`KEEPER_TMUX_PANE` env reads
  (synchronous, no fork/fs). No other scraping, no env read in a fold.

## Migrations

- **Forward-only** via `meta(schema_version)`; non-idempotent steps are
  version-guarded. The **daemon is the sole migrator.** Runtime downgrade guard:
  `migrate()` throws BEFORE its transaction opens when the stored `schema_version`
  exceeds the binary's `SCHEMA_VERSION`, so an old binary never downgrades a newer DB.
- **When you bump `SCHEMA_VERSION`, add the version to `SUPPORTED_SCHEMA_VERSIONS`
  in `keeper/api.py` in the SAME commit** — a hard whitelist; an unlisted version
  fails every keeper-py read. `test/schema-version.test.ts` enforces this.
- **Never wipe-and-replay the LIVE-ONLY projections.** A rewinding migration's
  wipe list enumerates ONLY the deterministic-replayed projections (they re-fold
  byte-identically from the rewound cursor). The live-only git surface is NOT in
  that list: rewinding it RESETS its skip-floor to 0 + sets `seed_required`
  (via `rewindLiveProjection` in `src/db.ts`, not a bare
  `DELETE FROM git_status`) so the boot-seed producer re-derives it. Wiping the live
  tables WITHOUT resetting the floor leaves the surface permanently empty (every
  historical `GitSnapshot` self-gates below the stale floor).

## Writes are tightly scoped — DO NOT widen them

- **No general write path into the reducer.** The socket carries `query` (read) and
  `rpc` (mutate). RPC may write ONLY five surfaces, each round-tripping through a
  synthetic event so a re-fold sees it: `replay_dead_letter`, `retry_dispatch`,
  `set_autopilot_paused`, `set_autopilot_mode`, `set_epic_armed`. RPC handlers MUST
  NOT write `jobs`/`epics`/etc directly (folds still mutate their own projections).
- **Plans are READ-ONLY.** The plan worker folds `.keeper/{epics,tasks}` snapshots
  into `epics`; every field is read-only end to end. No RPC writes a plan field.
- **Sole-writer rules.** The hook writes ONLY per-pid NDJSON files, never the DB. The
  events-log ingester is the sole writer of hook-sourced `events` rows; main writes
  all synthetic events + `dead_letters` + the replay path; workers feed via main.

## Process & DB-watch invariants

- **No kernel watchers on keeper's OWN DB.** `fs.watch`/FSEvents/kqueue drop
  same-process and WAL writes on macOS — detect DB changes via `PRAGMA data_version`
  polling on a read-only connection only. Carve-out: `@parcel/watcher` on EXTERNAL
  trees and kqueue/pidfd on EXTERNAL process descriptors are fine.
- **No in-process self-heal.** Any unrecoverable error calls `fatalExit` →
  `process.exit(1)`; the LaunchAgent restarts the single recovery path. Never respawn
  a worker in-process. Carve-out: closing a stale/EPIPE UDS client connection is
  connection hygiene, not self-heal.

## Worker contract

- **`isMainThread` guard** — a plain import of the module is inert.
- **Own `openDb` connection** (read-only for readers); never share main's.
- **`prepareStmts:false` on connections that use no prepared statements** — every
  worker destructures `{db}` only (main is the sole `stmts` consumer), so preparing
  statements at open is wasted cost and a needless schema-dependence at the raciest
  moment of boot.
- **Bounded initial-open retry for the transient boot class** — `openDb` retries the
  raciest boot-open failures (a fresh `Database` per attempt, sync backoff, bounded
  count) and still fails loud after exhaustion. This is boot robustness, not
  self-heal — `no such table` is retryable ONLY at initial open on a known-migrated
  path; everywhere else it is fatal.
- **Typed messages** — `{ kind }` worker→main, `{ type }` main→worker.
- **Supervisor-owned lifecycle** — main spawns after migrate+boot-drain and is the
  only one that terminates (`shutdown` → await close → terminate). A worker owning an
  external resource MUST release it in its own shutdown handler.

## Test isolation

Every test that spawns the real hook MUST sandbox ALL FIVE state paths under the
per-test tmpdir: `KEEPER_DB`, `KEEPER_DEAD_LETTER_DIR`, `KEEPER_DROP_LOG`,
`KEEPER_RESTORE_FILE`, `KEEPER_BACKSTOP_LOG`. Never `{ ...process.env, KEEPER_DB }`
— it strands the others at production defaults and pollutes the real feed. Build the
env via the shared `sandboxEnv(...)` in `test/helpers/sandbox-env.ts`.

**Two test helpers, two jobs.** `sandboxEnv` is for process-spawn isolation (any
test launching the real hook/daemon/CLI subprocess). The template-DB helper in
`test/helpers/template-db.ts` (`freshDb()` / `freshDbFile()`) is for pure IN-PROCESS
unit tests needing a migrated schema — a fast `Database.deserialize` clone instead
of re-running the full `migrate()` ladder. Keep a real `openDb` only when the test
EXERCISES migration (`db.test.ts`) or owns a subprocess.

**Two tiers.** Default `bun test` runs the FAST tier only and skips process-level
integration files. **`bun run test:full` is mandatory before landing any change
touching daemon / worker / db / hook / git process paths or any slow-tier file** —
the fast run does NOT cover those. When in doubt, run `test:full`.

**Poll, don't sleep.** Any assertion waiting on async worker/daemon state uses
`retryUntil` (`test/helpers/retry-until.ts`), never a fixed `Bun.sleep` — a fixed
sleep can silently resolve under host contention and flake the suite.

## Autopilot

The server-side reconciler dispatches workers against ready plan work. It **boots
paused** and is level-triggered on `PRAGMA data_version`. An unpaused autopilot that
"does nothing" is almost always a readiness gate firing correctly — the gates live in
`src/readiness.ts` (`computeReadiness`) and the `[paused]` banner is authoritative.
Close-row completion is liveness-gated in `src/readiness.ts` (done AND closer idle),
not reap-side; the completion reap inherits done-AND-idle from that verdict.
For modes, caps, the cooldown, and completion-reap, read `src/autopilot-worker.ts`,
`src/readiness.ts`, and README. Two distinct reapers, do not conflate: the
autopilot completion-reap closes done plan rows, while the exit-watcher's
dead-pid re-probe (`reprobeLoop` in `src/exit-watcher.ts`, ~60s, age-gated on
`created_at >= 5 min`) mints a synthetic `Killed` for a job whose worker pid is
verifiably gone — the kernel-arm-miss backstop, not a tmux/window reaper.
The never-bound circuit breaker (`dispatch_never_bound`, v76) folds a per-`(verb,
id)` consecutive-`DispatchExpired`-without-bind counter in `foldDispatchExpired`;
at K=3 it mints a sticky `dispatch_failures(reason='never-bound')` the existing
`failedKeys` arm suppresses. A bind (discharge-on-bind) and a `DispatchCleared`
(`keeper autopilot retry`) each reset it — bump/reset come PURELY from the event
stream (never wall-clock), and it joins the re-fold wipe list, so re-fold stays
byte-identical. Do NOT carry the count on the `pending_dispatches` row: that row
is DELETEd on expire to release the re-dispatch slot.

## Out of scope

prise/env-var integration, multi-session lineage, harness_meta.
