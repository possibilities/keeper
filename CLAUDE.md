keeper — event-sourced Claude Code control-data daemon (Bun + bun:sqlite). Rationale and history
live in `docs/adr/`, `.keeper/` specs, and git history; `README.md` is a lean front door; this
file is imperative guardrails only.

## Docs discipline (rule #0)

- **Docs prune, never append-only.** Doc edits consolidate and delete as readily as they add;
  CLAUDE.md gains a line only for a rule an agent would otherwise get wrong.
  `bun scripts/lint-claude-md.ts` gates its size + bans re-narration — keep it green.
- **Forward-facing advice only** — state current behavior, never change history: no fn-ids,
  version numbers, dates, or past-tense provenance in CLAUDE.md, README, `CONTEXT.md`, or code
  comments. History and rationale have exactly one home — `docs/adr/`, alongside commit
  messages; vocabulary lives in `CONTEXT.md`.

## Repo facts

- **`AGENTS.md` is a symlink to this file.** Edit in place; never `rm`+recreate — distinct
  from a harness's shared-source leaf, healed by deleting the source, never the leaf.
- **Three peers live under `plugins/`** — `plugins/keeper/` (hooks + `keeper:*` skills) and `plugins/plan/`
  (behind `keeper plan`, `plan:*` skills) are claude-plugins, each with exactly ONE `<plugin>/.claude-plugin/plugin.json`
  (keeper exactly ONE `hooks/hooks.json`); `plugins/prompt/` is the engine behind `keeper prompt` and carries NO
  `.claude-plugin` manifest. `plugins/plan/` also renders the required host matrix as per-cell `work` manifests
  under `workers/<model>-<effort>/`, added via `--plugin-dir` ATOP the full plugins.yaml (keeper+plan+arthack)
  every launch inherits. Never duplicate a manifest or add a
  `~/.claude/plugins/keeper` symlink (double-registers); daemon, `cli/`, `src/`, `keeper` binary stay at repo root.
- **The Agent Bus inbox watcher is a session Monitor** in `plugins/keeper/monitors.json` — STRICTLY
  separate from `hooks.json`; never fold in.
- **A `keeper bus chat send` MUST NOT join the live registry** (`send_only:true`); only a subscribed `keeper bus watch` channel establishes bus presence.

## Event-sourcing invariants

- **Cursor + projection advance in ONE `BEGIN IMMEDIATE` transaction** — the fold writes the projection AND bumps `reducer_state.last_event_id` together.
- **Never throw inside a fold.** Malformed `data` folds safely and the cursor advances. Schema
  defaults match the zero-event projection.
- **Re-fold determinism is sacred** for the deterministic-replayed projection class
  (`jobs`/`epics`/`commit_trailer_facts`/…). Inside a fold, build derived arrays from stable
  total-order sorts (never append), and NEVER read wall-clock, env vars, the filesystem, or process
  liveness — use the event's `ts`. Only producers probe those.
- **Never wipe-and-replay the live-only projections.** A rewinding migration wipes ONLY the
  deterministic-replayed ones; rewind the live-only git surface via `rewindLiveProjection`, not `DELETE`.
- **A history- or board-growing fold cost is a re-fold time-bomb.** Model it live-only,
  constant-bounded, as an incremental id-watermark memo, or idempotent per-key replace-merge; bound
  unbounded subscribe-serve collections with `recencyBound`.

## Hook rules

- **Eight hooks under `plugins/keeper/plugin/hooks/`** — events-writer (logs every Bash call, NEVER blocks), branch-guard (`PreToolUse(Bash)`, denies a SUBAGENT (`agent_id`) branch create/switch/worktree-add + mutating `git stash` (list/show/create allowed); daemon git stays ungated, no `agent_id`), escalation-guard (`PreToolUse(Bash)`, role-keyed on `KEEPER_ESCALATION_ROLE` — unblock/resolve diagnosis-only, deconflict/repair write-capable, interpreter/heredoc/redirect denied; FAILS CLOSED when marked, else inert), wrong-tree-guard (`PreToolUse(Write|Edit|MultiEdit|Bash)`, keyed on lane path `KEEPER_PLAN_WORKTREE` — denies a write outside its lane's `.git`-bounded tree (`file_path` + Bash vectors); `.keeper`/temp/home/own-lane allowed, `.git/config`+credentials denied; FAILS OPEN), wrapped-guard (`PreToolUse(Write|Edit|MultiEdit|NotebookEdit|Bash)`, keyed on `KEEPER_WRAPPED_CELL` — denies ALL source edits to a marked wrapped SUBAGENT (edit tools, in-tree Write, off-list Bash); FAILS CLOSED when marked, else inert), sidecar-writer (`PostToolUse`, owns the `~/docs` sidecar + git state, NEVER the `.md` body), docs-pusher (`Stop`, pushes `~/docs` once per turn), context-hint (`SessionStart`, node-only, surfaces the repo's `CONTEXT.md`). The two events-log writers—the hermes shim (self-seeds identity absent `KEEPER_JOB_ID`) and pi extension (`-e`)—are gated on it.
- **Always exit 0 / fail-open** — a non-zero exit can fail-close the session; a throwing shim/extension degrades to presence-only, NEVER crashing. The PreToolUse guards deny via the envelope (`permissionDecision:"deny"`), NOT a non-zero exit; a `Stop` hook exiting 2 BLOCKS stopping (docs-pusher swallows+logs). A shim NEVER writes host stdout; it logs failures privately.
- **No third-party deps, and NO `bun:sqlite`/`src/db.ts` in a hook or events-log writer.** Keep imports to `node:*` + dep-free `src/{dead-letter,derivers,exec-backend,sidecar,doc-commit,proc-starttime,hermes-shim-contract}.ts` helpers; never plan plugin (pi extension loads in ISOLATION via jiti — `node:*` + own contract copy, except `/rename` per-call `import()`). Attacker-influenced hook/shim payloads emit one size-bounded JSON line/record; no NDJSON/shell injection.
- **A `~/docs` hook may spawn a bounded git subprocess** — read-only probes are fine; no mutating git/DB write outside the `~/docs` repo, never `git fetch`/rebase/force-push there.

## Migrations

- **Forward-only** via `meta(schema_version)`; non-idempotent steps are version-guarded. The daemon
  is the SOLE migrator and never downgrades a DB stored above the binary's `SCHEMA_VERSION`.
- **A schema change appends one `SCHEMA_STEPS` entry** (`{version, kind, apply}`); `SCHEMA_VERSION`
  derives from the ladder tail, never hand-typed. Re-pin `SCHEMA_FINGERPRINT` on EVERY schema change;
  version stays PROVISIONAL until landed (fan-in renumbering unchanged).

## Writes are tightly scoped — DO NOT widen them

- **No general write path into the reducer.** The socket carries `query` (read) and `rpc` (mutate).
  RPC may write ONLY these eight synthetic-event surfaces: `replay_dead_letter`, `retry_dispatch`,
  `set_autopilot_paused`, `set_autopilot_mode`, `set_autopilot_config`, `set_epic_armed`, `request_handoff`,
  `request_await` — `set_autopilot_config` is GENERIC (a partial `autopilot_state` config patch; a future setting = a column + patch field, no new RPC). Never write `jobs`/`epics` directly.
- **Plans are READ-ONLY.** Plan worker folds `.keeper/{epics,tasks}` snapshots into `epics`; no RPC writes plan fields. **Board-orient** with `keeper status`; task detail via `keeper query tasks` — never hand-parse `keeper plan <verb>`.
- **Sole-writer rules.** The events-log per-pid NDJSON tree has a writer CLASS keyed on the keeper job id — the claude events-writer hook, hermes shell shim, and pi extension each write ONLY their own `<pid>.ndjson`, never the DB; `keeper agent` is SOLE writer of the births tree. sidecar-writer + docs-pusher write ONLY the `~/docs` repo. The events-log ingester is sole writer of hook-sourced `events` rows; main writes all synthetic events + `dead_letters` + the replay path (birth-ingest/codex-state producers feed it, never the DB), workers feed via main. `src/{codex,hermes}-trust.ts` are the ONLY writers of their config dirs, fail-open. `keeper statusline*` SOLE-write the statusLine leafs (never DB/socket); `keeper agent panel start` SOLE writer of `~/.local/state/keeper/panels/`. `keeper baseline` + the autopilot tip-triggered producer write the request spool, the baseline worker its result leafs; the plan CLI of the id ledger, max(scan,ledger)+1.

## Process & DB-watch invariants

- **No kernel watchers on keeper's OWN DB.** Detect DB changes by `PRAGMA data_version` polling a
  read-only connection. Carve-out: `@parcel/watcher` on EXTERNAL trees + kqueue/pidfd on EXTERNAL fds are fine. A transient `SQLITE_NOTADB` skips the tick via the shared `NotadbTolerance`, never an ad-hoc catch.
- **No in-process self-heal.** Any unrecoverable error `fatalExit`s (non-zero exit; LaunchAgent
  respawn is sole recovery); never respawn a worker in-process (carve-outs: closing a stale/EPIPE
  UDS client, the git seed-liveness watchdog's capped boot-seed re-run before `fatalExit`, and the
  serve-liveness watchdog `fatalExit`ing a wedged serve path on a named trigger: accept-stall,
  busy-lag, serve-report-mute, serve-starvation; main clocks arrival, clock-jump guard resets on
  suspend/resume). A crash-loop is loud: main appends each boot to an append-only, boot_id-keyed
  NDJSON restart ledger (sidecar, NOT a fold; runtime-qualified count), minting ONE sticky
  distress row cleared once the boot rate recovers.
- **A `flock` single-instance gate tops `startDaemon()`** before `openDb`/`migrate`; its `FD_CLOEXEC` lock fd never leaves main.
- **`keeper tabs restore --apply` exits non-zero while autopilot is unpaused** (fail closed) unless `--force`.

## Worker contract

- **`isMainThread` guard** — a plain import of the module is inert.
- **Own `openDb` connection, read-only** (never share main's; `prepareStmts:false` when a connection
  prepares no statements). A worker writing keeper.db is forbidden.
- **Typed messages** — `{ kind }` worker→main, `{ type }` main→worker.
- **Supervisor-owned lifecycle** — main alone spawns (after migrate+boot-drain) and terminates. A
  worker owning an external resource (a second SQLite file, UDS socket, watcher subscription) MUST
  release it on shutdown.

## Test isolation

- **One fast pure-in-process tier.** `bun test` is the keeper fast suite (only `test:opentui` splits out); `bun run test:full` gates all three suites serially — root, plan, prompt — and `test:full:slow` injects `KEEPER_RUN_SLOW` / `KEEPER_PLAN_RUN_SLOW` to unlock the real-git/subprocess tiers. NO test boots a real daemon / Worker thread / UDS socket / subprocess / git / tmux — git-boundary DECISIONS go through a pure seam, never git's execution. No watchdog: a test must never hang or synchronously spin; production is the safety net.
- **Sandbox ALL state classes** under the per-test tmpdir for real-state tests:
  `KEEPER_DB`, `KEEPER_DEAD_LETTER_DIR`, `KEEPER_LANE_DIRT_SPOOL_DIR`, `KEEPER_DROP_LOG`, `KEEPER_RESTORE_FILE`, `KEEPER_BACKSTOP_LOG`,
  the Agent Bus pair `KEEPER_BUS_DB` / `KEEPER_BUS_SOCK`, and `KEEPER_CONFIG_DIR` — never
  `{ ...process.env, KEEPER_DB }`; build via `sandboxEnv(...)`. Pure tests use `freshMemDb()` /
  `freshDbFile()` over a full `migrate()`.
- **Test runs are lock-free** — `scripts/test-gate.ts` (`test` routes through it) caps `--parallel`
  (`KEEPER_TEST_PARALLEL`, default 5) + adds `--no-orphans`. Never add a host-wide lock — a hung holder wedges every runner.
- **Poll, don't sleep.** Any assertion waiting on async state uses `retryUntil`
  (`test/helpers/retry-until.ts`), never a fixed `Bun.sleep`.

## Autopilot

- **The reconciler resumes its last durable paused state** (PAUSED on a fresh board), level-triggered on
  `PRAGMA data_version`. An unpaused inert autopilot is almost always a correctly firing readiness
  gate (`src/readiness.ts` `computeReadiness`); the `[paused]` banner is authoritative. For
  modes, caps, cooldown, reaps, and the four reapers, read `src/autopilot-worker.ts`.
  Escalation caps: turn-active; `blocked:` rows count on needs-human.
- **Worktree mode** (durable `autopilot_state` column, default OFF, via `set_autopilot_config`) **is PRODUCER-ONLY**: lanes re-derived each cycle from the DAG + live git, never a fold. The `worktree_multi_repo` flag (default OFF, same RPC) CLUSTERS a >1-toplevel epic into per-repo lane groups — one plan-close on `primary_repo` gates every group's INDEPENDENT per-repo finalize. A content conflict escalates on the bare `worktree-merge-conflict` sticky — `close::<epic>` (finalizeEpic's close-sink or recover pass-2) or `work::<taskId>` (a lane's fan-in merge) — the STICKY class, distinct from the SELF-CLEARING `worktree-lane-premerge` guard below, which vets a base BEFORE any merge is attempted. The recover pass keys each transient degrade per-(epic,repo) on `close::worktree-recover:<epic>-<repoHash>` (null-epic pass-1 → slug); its `worktree-recover*` level-clear is POSITIVE-EVIDENCE-only — clears solely on a same-cycle merged/ancestor/absent resolution, else retained; tri-state probes DEFER on inconclusive. Closed/tombstoned dirt is recover-owned: after grace re-probes, spool then force; unsafe lanes page once until gone. Per-repo finalize failures key on the sibling `close::worktree-finalize:<epic>-<repoHash>` rows that never collide with recover rows; finalize DEGRADES a dirty/off-branch shared-checkout (or a lock/local-op timeout) into a non-sticky `retry` skip minting no row — but a MID-MERGE shared checkout (MERGE_HEAD) is classified DISTINCTLY: the recover pass self-heals a sole-owned `keeper/epic/*` residue via a flock-guarded `git merge --abort` (foreign/ambiguous/MERGE_AUTOSTASH residue NEVER aborted), and a persistent wedge mints a recover-level-cleared per-repo `shared-checkout-wedge` distress. A SIBLING per-repo `shared-checkout-desync` row (live variant) mints past a short grace when a landed base→default merge leaves the shared checkout TRAILING the tip, cleared ONLY when a per-cycle CONTENT probe sees index AND worktree at the default tip; the live `shared-checkout-dirty` sibling (repair-defer dirt) mints alike. Both are PAGING operator jams — a page-once sweep pages the human ONCE per row (`human_notified_at`, re-armed by the producer level-clear), yet clear ONLY via that level-trigger, NEVER `retry_dispatch`. The fan-in LANE pre-merge rides this per-LANE: an un-losslessly-mergeable base mints a SELF-CLEARING `work::<taskId>` `worktree-lane-premerge` row (positive-evidence level-clear BY LANE PATH); a persistent wedge or immediate `abort-failed` escalates to a per-LANE `worktree-lane-wedge` `daemon` distress row (orphan-GC-exempt, DISTINCT from shared-checkout). A genuine origin-ahead non-ff is NOT a retry skip: it mints a VISIBLE `worktree-finalize-non-fast-forward` sticky (outside `worktree-recover*`) for an operator to reconcile origin. On a sticky `worktree-merge-conflict` row two sweeps fire (each gated on its OWN `dispatch_failures` column, never a sibling latch table — only `retry_dispatch` clears it + re-arms markers): the `resolve::<epic>`/`resolve::<taskId>` (close/work) resolver worker FIRST (`resolver_dispatched_at`, mechanically-clear conflicts only, else BLOCKED), THEN ONE `deconflict::<epic>`/`deconflict::<taskId>` (close/work) session SEQUENCED behind it (`merge_escalated_at`, gated on a terminal resolver verdict — declined/BLOCKED/died — never while a resolver is live/undispatched). The human is paged EXACTLY once per row, at the deconflict session's OWN terminal decline/death (`human_notified_at`). A `SHARED_BASE_BROKEN` block routes to ONE write-capable `repair::<repo>` per (repo, fingerprint) sticky with baseline key + bounded digest; it lands a gated fix or green no-op, then unblocks/pings tasks. Died/declined, or stopped/dead without a verdict past dispatch grace, pages once (working never does); only `retry_dispatch` re-arms. The cross-epic merge-gate (a dependent GROUP's lane is NOT cut until every lane-cutting SAME-RESOLVED-REPO upstream is in LOCAL default) is per-(epic,repoDir), EPHEMERAL + producer-probed ONCE/cycle as a pure `reconcile` read, minting NO `dispatch_failures` row — an inconclusive/error probe DEFERS, an absent lane is absent-implies-merged (teardown deletes a base once ancestor-of-default); an orphaned/squash-merged upstream surfaces via `lane_merged`+`keeper await landed`. A plan session whose recorded cwd vanished under a live recycle-checked pid mints a DETECT-ONLY `stuck-sentinel: cwd-missing` needs_human sticky — never a kill. Base-freshness is producer-only: a quiescent, threshold-drifted lane's own linked base worktree merges local default into itself, never from the fold/reconcile core; a content conflict reuses the `worktree-merge-conflict` sticky → resolver → deconflict chain.
