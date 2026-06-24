keeper — event-sourced Claude Code control-data daemon (Bun + bun:sqlite).

The keeper plugin ships four hooks: the events-writer appends one per-pid NDJSON
line per Claude Code hook invocation (lock-free, no SQLite open), the branch-guard
hard-denies subagent git branch create/switch, the sidecar-writer owns the
`~/docs` metadata sidecar AND its git state (PostToolUse, never touches the `.md`
body — create-or-merges the `.yaml` then commits the doc write/edit/delete), and
the docs-pusher pushes `~/docs` to its remote once per turn (Stop, when local is
ahead of `@{u}`, fail-open). The `keeperd`
daemon's events-log ingester lands each events-writer line as one `events` row, folds
those events into the `jobs`/`epics` projections, and serves them read-only over a
UDS subscribe socket. The `events` table is the
canonical fold source, so re-fold determinism holds by construction. System map,
rationale, and incident history: `README.md` `## Architecture` and `.keeper/` specs.

## Repo facts

- **`AGENTS.md` is a symlink to this file.** Edit in place; never `rm`+recreate.
- **Two Claude plugins live as peers under `plugins/`** — `plugins/keeper/` (the
  events-writer HOOK plugin + the `keeper:await` / `keeper:dispatch` /
  `keeper:autopilot` / `keeper:pair` skills) and `plugins/plan/` (the
  plan plugin behind `keeper plan`, carrying the `plan:*` skills).
  The in-binary `keeper agent` launcher loads both from one `plugin_scan_dirs`
  entry pointing at `plugins/`.
  Each plugin has exactly ONE manifest at its own `<plugin>/.claude-plugin/plugin.json`
  and the keeper plugin exactly ONE `plugins/keeper/hooks/hooks.json` — never
  duplicate either, never add a `~/.claude/plugins/keeper` symlink (it
  double-registers the hook). The daemon, `cli/`, `src/`, and the compiled `keeper`
  binary STAY at the repo root; only the plugin surfaces live under `plugins/`.
- **The keeper plugin auto-arms the Agent Bus inbox watcher** via
  `experimental.monitors` in its manifest → `plugins/keeper/monitors.json`
  (`keeper bus watch`, `when:"always"`). It is a session Monitor, STRICTLY
  separate from `hooks.json` — never fold it into the hooks file. That Monitor is
  invisible to the hook stream, so it does NOT populate `jobs.monitors` (correct —
  bus presence is the `bus.db` registry, not the hook-fed projection).
- **The bus relay NEVER spawns — wake is the client-side `keeper bus wake` CLI
  verb** (`cli/bus.ts` → `src/bus-wake.ts`, fn-918). A `planner@<epic>` send to a
  known-but-offline creator persists `queued_for_wake` on `messages` (no bus.db
  schema bump); `keeper bus wake` resumes that creator via `claude --resume` into
  the dedicated `agentbus` tmux session — single-flighted per session, liveness-
  and cooldown-gated, fail-open. It runs in the CLI process, NEVER the bus socket /
  a daemon RPC / `src/wake-worker.ts` (the unrelated `data_version` pump — a
  name-collision hazard). `agentbus` is a managed session keeper SPAWNS into; its
  stopped tracked windows are autoclosed by the reaper's managed-session arm
  (`src/reaper-worker.ts`) past an idle grace, alongside `pair`/`panels`.
- **Bus presence = a SUBSCRIBED channel; a pure send is EPHEMERAL (fn-921).** A
  `keeper bus chat send`/`broadcast` registers with `send_only:true` (`cli/bus.ts`
  `registerFrame(true)`): `opRegister` binds the authoritative `from` identity on
  `conn.entry` ONLY — it does NOT join the live `registry`, run `takeoverVictim`,
  `upsertChannel`, or `publishControl("join")`, and `opDeregister` skips the
  shared-`(pid, start_time)` `deleteChannel`. Without this a transient send TAKES
  OVER (evicts) the agent's live `watch` channel — same identity — AND leaves a
  `sock=null` ghost that reads `not_connected`/absent-from-`list` (the 2026-06-23
  unreachable-live-agent bug). Only `keeper bus watch` (`send_only:false`,
  `runWatch`'s reconnect loop re-subscribes after a bounce) owns a durable,
  subscribable, list-visible channel. fn-918 wake-on-send is unaffected — it is
  recipient-side (`queued_for_wake` for an offline creator), never the sender's
  registration. The `(pid, start_time)` identity guards BOTH the deregister path
  (`deleteChannel`) AND the enrich path: `enrichPeerFromJobs` probes the live pid's
  start_time ONCE per matched row and binds the keeper.db `jobs` identity ONLY on a
  verbatim match (fn-933) — a mismatch/unreadable probe fails closed (returns null,
  the ancestry walk climbs to the true parent), so an OS-recycled pid carrying a
  dead agent's lingering row never misattributes the sender.
- **Forward-facing advice only** in comments and docs: state current behavior and
  invariants, not change history (which lives in the diff). Full rule:
  `keeper prompt render code-comment-style`.

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
  central registries `LIVE_ONLY_PROJECTIONS` / `LIVE_ONLY_JOBS_COLUMNS` /
  `EPHEMERAL_PROJECTIONS` in `src/db.ts`).
  Four classes: **deterministic-replayed** (the sacred default above — byte-identical
  re-fold), **live-producer-fed** (TWO surfaces: the git surface — `git_status`,
  `file_attributions`, and the three `jobs` git-counters — and the tmux LIVE-LOCATION
  surface — `jobs.backend_exec_session_id` + `jobs.window_index`, re-derived by the
  `TmuxTopologySnapshot` fold keyed on `(generation_id, pane_id)` and gated above
  `tmux_projection_state.floor`. NOT replayed from history; boot-seeded then kept
  current by incremental folds ABOVE a skip-floor; DELIBERATELY excluded from the
  byte-identical charter. The frozen `KEEPER_TMUX_SESSION` env folds onto the forensic
  `jobs.backend_exec_birth_session_id`, which crash-restore + dash grouping COALESCE
  onto when the live session is unresolved; the retired `WindowIndexSnapshot` +
  `TmuxPaneSnapshot` folds are explicit no-op arms so the OTHER columns still re-fold
  byte-identically), **ephemeral** (`EPHEMERAL_PROJECTIONS` — currently just
  `pending_dispatches`, the in-flight launch-window set; folded by the boot drain like
  any projection so the global cursor advances, but `truncateEphemeralProjections`
  runs AFTER the drain and BEFORE the actuator + mutating-RPC gate opens (fn-897 — the
  read socket is already serving by then, but no consumer ACTS on the phantom because
  the actuator stays gated) so the runtime set starts empty every boot;
  the autopilot re-derives genuine in-flight launches from live `jobs`/tmux panes, so
  empty-at-boot is correct and subsumes clearing any phantom a rewinding migration's
  full re-fold would resurrect — the v76→v79 dispatch jam, and the same hazard any later
  cursor-rewind migration carries (e.g. the v80/fn-881 classifier-exclusion rewind);
  DELIBERATELY excluded from the byte-identical charter, NOT in the re-fold wipe list),
  and **control**
  (`reducer_state`, plus `git_projection_state`'s and `tmux_projection_state`'s
  `floor` + `seed_required`). The skip-floor
  (`git_projection_state.floor`, a monotonic `events.id`) makes every git fold no-op
  for `id <= floor` — the gate lives INSIDE `applyEvent` by event type, never in the
  drain SQL (the global cursor must still advance for the deterministic projections).
  Above the floor a live fold stays pure (no git/clock/fs reads — those belong to the
  producer only). **Boot-producer contract:** capture `floor = max(events.id)` BEFORE
  the git scan, set `seed_required`, scan the GATED roots (open-epic `project_dir` +
  task `target_repo`, derived by `gatedGitRoots` in `src/gated-roots.ts` — NOT the
  full historical `jobs.cwd` sweep, so a stale `/Volumes/Scratch` root never gates),
  populate the surface, then persist the floor + clear `seed_required` once every
  gated root is seeded (best-effort for a root the seed missed); a crash mid-seed
  leaves `seed_required` set so the next boot re-seeds. **Cold-boot perf (fn-921):**
  two costs made the seed exhaust at 0/10. (1) `discoverSeedRoots` PRUNES a
  candidate whose path no longer EXISTS (`pathExists`/`existsSync`) BEFORE the 2s
  `resolveGitToplevel` spawn — an unmounted `/Volumes/Scratch/*` repo would
  otherwise burn the resolve timeout for nothing; the probe is producer-side, never
  inside a fold. (2) `seedGitProjection` PRE-WARMS the per-`Database`
  `GitAttribMemo` (`warmGitAttribMemo`) ONCE before the per-root loop so the cold
  `id > 0` attribution scan runs OUTSIDE a lock-held fold racing the budget; the
  memo is a pure optimization (NEVER a fold input), so warming early leaves the
  byte-identical re-fold untouched. The whole-scan budget was widened 30s→60s given
  the per-root bulkhead already protects correctness. **Self-clearing in steady
  state:** for a root the boot-seed missed/failed, MAIN's above-floor `GitSnapshot`
  fold (`projectGitStatus`) clears `seed_required` once `allGatedRootsSeeded` holds —
  the live producer's emit folded by main, never a git-worker write. The
  "never a retry loop" rule has ONE bounded exception (fn-921): a SUPERVISOR-side
  seed-liveness watchdog (`decideGitSeedWatchdog` in `daemon.ts`) recovers a STUCK
  surface (`seed_required` held + no GitSnapshot progress past a threshold) without
  a manual bounce — it re-runs the boot-seed on MAIN a CAPPED number of times, then
  `fatalExit → LaunchAgent restart` as the last resort; a MUTE git-worker (no
  liveness pulse past the threshold) escalates straight to restart. It never trips
  mid-boot (no pulse yet ⇒ "ok") and never crash-loops a DETERMINISTIC-stuck (the
  key-mismatch fix below removes the only such case). **Gated-root key
  reconciliation (fn-921):** the readiness READ key is the raw `effectiveRoot`; the
  boot-seed + live git-worker WRITE the `git_status` row under
  `resolveGitToplevel(root)`. A subdir/symlink `target_repo` mismatches → the root
  never clears `seed_required` and stays forced-`unknown` forever. Non-fold callers
  (boot-seed, server-worker, autopilot) pass a memoized `resolveGitToplevel` to
  `allGatedRootsSeeded`/`unseededGatedRoots` so the read key normalizes to the write
  key; the REDUCER fold passes NO resolver (it cannot shell out to git — the
  identity default is byte-identical for the common `effectiveRoot === toplevel`
  case). The boot-seed runs AFTER drain, BEFORE the autopilot
  actuator + mutating-RPC gate opens (fn-897 split serving into TWO gates: the
  READ socket opens right after migrate during the drain; the boot-seed + drain
  reaching head + ephemeral-truncate gate the actuator + mutating RPCs). **Unseeded
  git reads as UNKNOWN, never CLEAN — PER-ROOT** (fn-905): while `seed_required` is
  set the readiness gate forces `{kind:"unknown"}` ONLY for rows whose `effectiveRoot`
  (`target_repo ?? project_dir`, keyed identically to the per-root mutex) lacks a
  `git_status` row above the floor — `unseededGatedRoots` derives the set. A
  stale/failed root darks only ITS own rows; a seeded sibling root still dispatches
  (bulkhead). The set rides `BootStatus.git_unseeded_roots` so the board renders the
  SAME per-root gate the autopilot dispatches against; the coarse `seed_required`
  boolean (still on `BootStatus.git_seed_required`) drives `catching_up` and holds
  `keeper await git-clean` at `waiting`. A consumer must never treat the empty
  surface a not-yet-seeded root produces as a clean repo.
- **A fold whose per-event cost grows with history — OR with board / projection
  size — is a re-fold time-bomb.** Any projection whose per-event fold cost scales
  with history length (the git fold's pass-1 explicit-attribution `buildExplicitAttribHoist`
  ran two UNBOUNDED full-history `events` scans per `GitSnapshot` — a bash exact-match
  scan + a git-rm/git-mv deletion scan, the dominant steady-state reducer cost until
  fn-892 made them incremental via a per-`Database` `WeakMap` memo that scans only
  `id > maxId` and appends; `computeRepoBashWindows` pass-2 is already bounded by
  `MAX_BASH_WINDOW_SEC`; fn-934 likewise made `computeMonitors`' Stop-fold
  provenance lookup — a full-session `background_task_id` rescan on EVERY Stop —
  an `id > maxId` per-`Database` `WeakMap` memo accumulating first-observed
  provenance per `(session, task_id)`, byte-identical to the unbounded scan
  WITHOUT a lookback window that would silently drop a long-lived monitor)
  OR with the board / projection size (the old `syncPlanLinks`
  re-derived a touched epic over EVERY session that ever touched it —
  O(touched_epics × swept_sessions) per plan event, the fn-888 ~15-min socket-down
  catch-up) is a replay time-bomb: model it **live-only, constant-bounded, an
  incremental id-watermark memo, or an idempotent per-key replace-merge** (fn-888
  swapped the full session-sweep for a per-session `mergeJobLinkSlice` whose cost is
  independent of how many sessions touched the epic; fn-892 swapped the pass-1
  full-history scans for an `id > maxId` append memo on the live-only git surface),
  never O(history)/O(board)-per-event. The same time-bomb shape exists on the
  SUBSCRIBE serve path: the per-tick membership token is `group_concat(pk)` +
  `COUNT(*)` over the whole filtered set, so registering an UNBOUNDED,
  never-compacted collection re-pages its full history to every subscriber on each
  membership change (the fn-921 `subagent_invocations` CPU peg). Bound such a
  collection with the descriptor's `recencyBound` (`<col> >= now - window`, a WHERE
  floor that threads through ONE `ResolvedFilter` so token/page/`COUNT(*)` agree —
  NOT a `LIMIT`, which breaks render's count/stuck); it is a live serve-path read
  (wall-clock at query-resolve, never a fold), exempt only for a pk detail
  subscribe.

## Hook rules

- **Four hooks, four contracts.** The keeper plugin ships TWO `PreToolUse(Bash)`
  hooks — the events-writer (logs every invocation, NEVER blocks) and the branch-guard
  (`plugins/keeper/plugin/hooks/branch-guard.ts` — hard-blocks a subagent, detected by
  `agent_id`/`agent_type` presence, from git branch create/switch/worktree-add so
  workers stay on the current branch; ordinary git, file-restore, and non-subagent
  sessions pass) — plus the `PostToolUse(Write|Edit|MultiEdit|Bash)` sidecar-writer
  (`plugins/keeper/plugin/hooks/sidecar-writer.ts` — owns the `~/docs` metadata
  sidecar AND its git state: on Write to a `~/docs/*.md` it create-or-merges the doc's
  `.yaml` sidecar, on `gh gist create` it upserts `gist-url:` into the matching
  sidecar, and on every doc write/edit/delete it commits the dirty `~/docs` paths
  inline — pathspec-scoped, mechanical `docs: write|update|delete <relpath>` subject,
  fail-open so a commit failure never blocks. It NEVER touches the `.md` body — machine
  metadata lives only in the sidecar. The dep-free committer is `src/doc-commit.ts`
  (`commitDocsPaths`, a hook-context port of `plugins/plan/src/commit.ts` — a hook MUST
  NOT import the plan plugin). The strip-signature + sidecar parse/merge logic is the
  dep-free `src/sidecar.ts`, shared with the one-shot migration so the strip regex
  never drifts) — plus the `Stop` docs-pusher
  (`plugins/keeper/plugin/hooks/docs-pusher.ts` — pushes `~/docs` once per turn when
  local is ahead of `@{u}`, fully self-contained dep-free: a LOCAL ahead-count
  `git rev-list --count @{u}..HEAD` — NEVER `git fetch` per turn — a `.git/`
  `wx`/O_EXCL lockfile to serialize concurrent sessions, and on non-fast-forward / auth
  / network a LOG to `.git/keeper-push.log` + SKIP — never rebase, never `--force`).
  `KEEPER_DOCS_DIR` overrides `~/docs` for tests (both hooks honor it);
  `KEEPER_DOCS_PUSH_LOG` overrides the pusher's skip-log.
- **Always exit 0.** A non-zero exit can fail-closed the human's session. On a HARD
  append failure the events-writer writes a per-pid dead-letter and still exits 0
  (losing one row is acceptable; wedging the agent is not). The branch-guard ALSO
  exits 0 — it denies via the `PreToolUse` JSON envelope
  (`hookSpecificOutput.permissionDecision:"deny"`), NOT a non-zero exit, so the
  exit-0 rule holds for both. Never "fix" the branch-guard to drop the deny or to
  exit non-zero: exit 0 is REQUIRED for the deny JSON to be honored, and a non-zero
  exit would fail-close the session. The `Stop` docs-pusher's exit-0 is EXTRA
  load-bearing: a Stop hook that exits 2 BLOCKS Claude from stopping, so every push
  path (failure, mid-op, detached HEAD, hung git via subprocess timeout, non-repo
  docs dir) swallows + logs and exits 0 — never escalate a push error to a non-zero
  exit.
- **No third-party deps, and NO `bun:sqlite`/`src/db.ts`.** The hook never opens
  SQLite — a stray `db.ts` symbol re-drags the 6.5k-line module and erases the
  cold-start win. Keep imports to `node:fs`/`node:os`/`node:path`, the dep-free
  `src/dead-letter.ts` serializers, and the pure `src/derivers.ts`/`exec-backend.ts`/
  `src/sidecar.ts`/`src/doc-commit.ts` helpers (`src/doc-commit.ts` is itself dep-free
  — `node:path` + `Bun.spawnSync` only). The docs-pusher is fully self-contained (no
  `src/` import — it does NOT import the async/dep-heavy `src/commit-work/push.ts`;
  only its `classifyPushError` substrings are re-derived inline). It never opens the
  DB, so it never migrates or probes schema.
- **Scraping is scoped.** On `SessionStart` only: parent claude `--name`/`-n` +
  `CLAUDE_CONFIG_DIR` (single-level ppid, no walking). On every event:
  `TMUX`/`TMUX_PANE`/`KEEPER_TMUX_SESSION`/`KEEPER_TMUX_PANE` env reads
  (synchronous, no fork/fs). The frozen `KEEPER_TMUX_SESSION` env maps to the
  forensic `jobs.backend_exec_birth_session_id` (the launch coordinate), NOT the
  LIVE `jobs.backend_exec_session_id` — that live location is owned by the keeperd
  `TmuxTopologySnapshot` timer-poll producer, never the hook env. No other
  scraping, no env read in a fold.

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
- **Sole-writer rules.** The events-writer hook writes ONLY per-pid NDJSON files,
  never keeper's DB; the sidecar-writer + docs-pusher write ONLY the `~/docs` repo
  (its sidecars + commits/pushes), never keeper's DB. The
  events-log ingester is the sole writer of hook-sourced `events` rows; main writes
  all synthetic events + `dead_letters` + the replay path; workers feed via main.
- **The cli/pair.ts codex pre-launch trust-seed is the ONLY keeper surface that
  writes codex's own config dir** (`${CODEX_HOME:-~/.codex}/config.toml`). Before a
  codex pair/panel partner launches as an interactive TUI, `ensureCodexDirTrust`
  (`src/codex-trust.ts`, dep-free leaf) seeds `[projects."<realpath(cwd)>"]
  trust_level = "trusted"` so the detached window does not hang on codex's
  directory-trust prompt — exact-header idempotent (trust is NOT inherited), O_EXCL
  lock + post-acquire re-check for concurrent launches, and FAIL-OPEN (never throws,
  never blocks the launch; `KEEPER_CODEX_TRUST_LOG` overrides the log path).

## Process & DB-watch invariants

- **No kernel watchers on keeper's OWN DB.** `fs.watch`/FSEvents/kqueue drop
  same-process and WAL writes on macOS — detect DB changes via `PRAGMA data_version`
  polling on a read-only connection only. Carve-out: `@parcel/watcher` on EXTERNAL
  trees and kqueue/pidfd on EXTERNAL process descriptors are fine.
- **No in-process self-heal.** Any unrecoverable error calls `fatalExit` →
  `process.exit(1)`; the LaunchAgent restarts the single recovery path. Never respawn
  a worker in-process. Carve-out: closing a stale/EPIPE UDS client connection is
  connection hygiene, not self-heal. Carve-out: the fn-921 git seed-liveness
  watchdog may re-run the boot-seed on MAIN a CAPPED number of times before it
  escalates to `fatalExit` — a supervisor-side re-arm of MAIN's own producer, never
  a worker respawn.
- **The git-worker is POLL-ONLY (fn-921).** It no longer holds an
  `@parcel/watcher` subscription: a two-tier metadata poll (cheap `stat()` of `.git`
  `HEAD`/`index`/`logs/HEAD`/`packed-refs` + worktree mtime at ~300ms,
  `readGitMetaSignature`/`decideGitPoll`) drives the per-root `RescanScheduler` on a
  detected delta. The poll producer arms UNCONDITIONALLY at worker start — NOT inside
  a watcher `import().then()` — so a watcher-load hang / mute stream can never again
  leave the producer with no timers armed (the 2026-06-23 silent freeze). The OTHER
  watcher workers (transcript / plan / usage / dead-letter / events-ingest) still
  dlopen `@parcel/watcher`, so it stays a dependency + the main-thread pre-warm
  remains. A QUIET repo with `seed_required` set is cleared by the heartbeat's
  force-emit (`emitForUnseededGatedRoots` — a forced snapshot bypasses the semantic
  dedupe so an unchanged payload still lands above the floor).
- **A `~/docs` hook may spawn a bounded git subprocess.** The sidecar-writer's inline
  committer and the Stop docs-pusher each shell out to `git` (timeout-bounded
  `Bun.spawnSync`) against the `~/docs` repo only — these are external-tree git calls,
  NOT a keeper-DB write, so the no-DB-write hook rule and the kernel-watcher carve-out
  both still hold. The push flush is debounced by the `Stop` cadence itself (once per
  turn — no persistent timer state) and serialized across concurrent sessions by a
  `.git/keeper-push.lock` `wx`/O_EXCL lockfile; a hung git is killed by the per-call
  subprocess timeout. NO `git fetch` per turn — the ahead-check is the local
  `@{u}..HEAD` count.

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
- **Supervisor probes git-worker liveness (fn-921).** `onerror`/`close` only catch a
  crash, not an alive-but-stuck worker. The poll-only git-worker posts a
  `git-liveness` pulse per poll tick (a pure side channel, never folded); main's
  seed-liveness watchdog reads the time since the last pulse (MUTE check) together
  with `seed_required` + GitSnapshot progress to decide reseed-vs-restart.
- **A worker may own resources beyond a read-only keeper.db connection** — the
  Agent Bus relay (`src/bus-worker.ts`) holds two new classes: a SECOND owned
  SQLite file (`bus.db`, writable, its OWN `PRAGMA user_version` ladder — NEVER
  keeper's `openDb`/`migrate`) and an OUTWARD-facing UDS socket (`bus.sock`, mode
  0600, lock-before-bind). Both are external resources under the rule above: the
  worker's own shutdown handler releases them (close the bus.db connection, close
  the listener, drop the lock). The keeper.db connection it ALSO opens stays
  read-only — a worker writing keeper.db is still forbidden.
- **Usage is a PRODUCER + a CONSUMER, two distinct workers.** The
  `usage`-watcher CONSUMER (`@parcel/watcher`, a `WATCHER_WORKERS` member) folds
  the `~/.local/state/agentusage/<id>.json` envelopes into the `usage` projection
  via main; the usage-scraper PRODUCER (`src/usage-scraper-worker.ts`) WRITES those
  envelopes. The producer is a non-watcher, config-gated poll producer modeled on
  `builds-worker` (N per-account loops, global profile-gate + per-target mutex,
  60–180s jitter, no-throw cycle), gated on a resolvable runtime
  (`usage_scraper_uv_path` + `usage_scraper_project_dir` — both absolute, NO
  default, un-spawn + warn when unresolved, NEVER `fatalExit`). Each cycle shells
  out `<uv> run --directory <agentusage> python -m agentusage.scrape_cli …` to the
  stateless Python scrape util (it owns the `pexpect`+`pyte`+panel parsers; keeper
  owns the orchestration + the vendored picker). It writes ONLY its on-disk
  surface (envelope + `.error.json` + `events.jsonl`); main stays the sole event
  writer. `KEEPER_AGENTUSAGE_ROOT` sandboxes the state dir + picker ledger for
  tests.

## Test isolation

Every test that spawns the real hook (or daemon/CLI) MUST sandbox ALL SIX state
classes under the per-test tmpdir: `KEEPER_DB`, `KEEPER_DEAD_LETTER_DIR`,
`KEEPER_DROP_LOG`, `KEEPER_RESTORE_FILE`, `KEEPER_BACKSTOP_LOG`, and the Agent Bus
pair `KEEPER_BUS_DB` / `KEEPER_BUS_SOCK` (its own DB + relay socket). Never
`{ ...process.env, KEEPER_DB }` — it strands the others at production defaults and
pollutes the real feed. Build the env via the shared `sandboxEnv(...)` in
`test/helpers/sandbox-env.ts`.

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

**No real git in the default tiers (fn-904).** A default-tier test MUST NOT spawn
real `git` (no `Bun.spawnSync(["git", …])`, no `initRepo`/`git init`). Test
keeper's DECISIONS at the git boundary with synthetic inputs, never git's
execution: extract a PURE seam (mirror `parsePorcelainV2` → `buildGitSnapshotFrom`,
`enumerateCommitsFromLog`, `parseCommitFiles` in `src/git-worker.ts` — the impure
`buildGitSnapshot` / `enumerateCommitsInDelta` keep their `gitOutput`/`hash-object`/
`lstat` calls at the producer call site, then delegate to the pure core so
production stays byte-identical) and drive it with synthetic payloads or with
golden `git log -z` / `diff-tree -z` strings CAPTURED FROM REAL GIT ONCE
(`test/fixtures/git-log-goldens.ts` — never hand-author them, or the stride parser
validates against a fabrication; re-capture on a format change). A producer whose
only git boundary is one call (the boot-seed's `readStatus` → `buildGitSnapshot`)
takes an INJECTABLE runner instead — `seedGitProjection`'s `buildSnapshotForRoot`
seam defaults to the real path; tests pass a synthetic `GitSnapshotPayload`
builder so the fold / floor / seed_required DECISIONS run git-free. The same
shape as the commit-work `GitRunner` and `cli/session-state.ts`'s
`buildSessionState({ gitRunner, attribution })` seam. A test whose
contract genuinely IS reading git's own state (fs ref resolution, the `git status`
probe, the boot-seed discovery-toplevel resolve, the wrapper-script trailer
injection) cannot be made synthetic — name it
`*.slow.test.ts` and add it to the fast-tier `--path-ignore-patterns` list (see
`test/git-worker-realgit.slow.test.ts`, `test/git-boot-seed-realgit.slow.test.ts`,
`test/git-wrapper.slow.test.ts`). The convention is guarded: `bun run test:hygiene`
(`scripts/lint-no-real-git.ts`) scans every top-level `test/*.test.ts` for a
real-git signature (a `git`-binary spawn, an `initRepo`/`gitInit`, a bare `git init`)
and FAILS on a non-allowlisted match — `scripts/test-real-git-allowlist.txt` is the
single source of truth for the slow/integration tier that legitimately keeps real
git (the three `*.slow.test.ts` files above plus the commit/plan integration
suites). Add a file there ONLY when its contract genuinely IS git's own execution.

**The host-wide test lock is un-bypassable; the cap rides the gate script.**
`bun run test` / `bun run test:full` route through `scripts/test-gate.ts`, which
caps per-run parallelism (`KEEPER_TEST_PARALLEL`, default 4) AND takes a host-wide
`flock` at `~/.local/state/keeper/test.lock` so concurrent agents serialize instead
of thrashing the CPU. A RAW `bun test` (any entry point) still takes that same
host-wide lock: a `bunfig.toml` `[test] preload` (`scripts/test-preload.ts`, and
the plan plugin's `plugins/plan/test/preload.ts` for its own suite) re-applies the
flock in-process, so an ad-hoc/agent run can never oversubscribe the host. Prefer
`bun run test` / `test:full` for the parallel cap; the lock itself is not
bypassable by going raw. The gate spawns its child with `KEEPER_TEST_GATED=1` so
the child's preload skips re-locking the lock the parent already holds (no
self-deadlock). `KEEPER_TEST_NO_GATE` skips the lock for both the gate and the
preload (the cap + ignore-list still apply); every lock path fails open on error or
timeout so a wedged holder can never block an agent.

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
`src/readiness.ts`, and README. Four distinct reapers, do not conflate: the
autopilot completion-reap closes done plan rows; the exit-watcher's
dead-pid re-probe (`reprobeLoop` in `src/exit-watcher.ts`, ~60s, age-gated on
`created_at >= 5 min`) mints a synthetic `Killed` for a job whose worker pid is
verifiably gone — the kernel-arm-miss backstop, not a tmux/window reaper; the
reaper's managed-session idle-grace arm (`src/reaper-worker.ts`) autocloses a
stopped tracked NON-plan job in a keeper-managed session (`pair`/`panels`/`agentbus`)
past `REAP_MANAGED_SESSION_IDLE_SEC`, allow-list gated so a human's hand-started
claude window is never reaped and opt-out via the `disable_autoclose` config list
(default empty); and the reaper's ORPHAN-process arm (fn-934, same worker,
`selectOrphanedProcessCandidates`) reaps RAW OS PROCESSES (not tmux windows) that
agent test activity orphaned on the host — gated on a CLOSED CONJUNCTION
(`uid==self` ∧ proc-info-ok ∧ `ppid==1` ∧ exe_path∈closed-allow-list minus the
`disable_orphan_reap` opt-out ∧ age>min ∧ pid∉keeper's-live-set), killing via a
net-new raw-pid actuator (`process.kill`) with a `(pid,start_time)` re-fingerprint
at the TOCTOU pre-kill re-check and two-phase SIGTERM→(next-tick)→SIGKILL via an
in-memory cooldown (no in-cycle blocking sleep); it matches the exe PATH not the
spoofable truncated NAME and NEVER throws (every probe/kill failure is a logged
non-fatal skip).
The never-bound circuit breaker (`dispatch_never_bound`, v76) folds a per-`(verb,
id)` consecutive-`DispatchExpired`-without-bind counter in `foldDispatchExpired`;
at K=3 it mints a sticky `dispatch_failures(reason='never-bound')` the existing
`failedKeys` arm suppresses. A bind (discharge-on-bind) and a `DispatchCleared`
(`keeper autopilot retry`) each reset it — bump/reset come PURELY from the event
stream (never wall-clock), and `dispatch_never_bound` joins the re-fold wipe list,
so re-fold stays byte-identical. **The per-root mutex hold is continuous across
the discharge (fn-924):** the launch-window occupancy passes unbroken from
`dispatch-pending` (open `pending_dispatches` row, pre-bind) to `bound-pending`
(the bound worker's seeded `state='stopped'`, `plan_verb`-bearing `jobs` row,
gated on `active_since IS NULL` so a stopped-after-working/dead worker doesn't
over-hold) to a `running` verdict (first activity). The SAME atomic SessionStart
fold both DELETEs the pending row AND seeds the stopped jobs row, so every
snapshot shows exactly one occupancy signal — never a gap a same-root sibling
could co-dispatch into. `bound-pending` is a READ-TIME readiness verdict (the
`active_since` mirror rides FREE on the embedded `epics.jobs` element, JSON-cell-
only — no fold change, no version-fence), so re-fold determinism is untouched. Do NOT carry the count on the `pending_dispatches`
row: that row is DELETEd on expire to release the re-dispatch slot, AND
`pending_dispatches` is EPHEMERAL (boot-truncated, never replayed — see the
projection-class taxonomy), so a counter on it would not survive boot. The TTL
sweep (`selectExpiredPendingDispatches`) expires an aged pending UNCONDITIONALLY on
`dispatch_failures` membership (fn-870 — a lease sweep gated on breaker state is a
"suppressed sweep" deadlock that held the slot + per-root mutex forever); to keep
the unconditional sweep from re-tripping the breaker, `foldDispatchExpired` SKIPS
the counter arm when the key already has a `dispatch_failures` row (an expiry of an
already-failed key is a slot release, not a target failure). `DispatchCleared` also
DELETEs the `pending_dispatches` row so an operator clear immediately frees the
slot.

## Out of scope

prise/env-var integration, multi-session lineage, harness_meta.
