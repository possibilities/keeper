keeper — event-sourced Claude Code control-data daemon (Bun + bun:sqlite). Rationale and history
live in `docs/adr/`, `.keeper/` specs, and git history; `README.md` is a lean front door; this
file is imperative guardrails only.

## Docs discipline (rule #0)

- **Docs prune, never append-only.** Doc edits consolidate and delete as readily as they add;
  CLAUDE.md gains a line only for a rule an agent would otherwise get wrong.
  `bun scripts/lint-claude-md.ts` gates its size + bans re-narration — keep it green.
- **Forward-facing advice only** — state current behavior, never change history: no fn-ids,
  version numbers, dates, or past-tense provenance in CLAUDE.md, README, `CONTEXT.md`, or code
  comments. History and rationale have exactly one home — `docs/adr/`, alongside commit messages.
  Typed homes: vocabulary → `CONTEXT.md`, resolved decisions → `docs/adr/`.

## Repo facts

- **`AGENTS.md` is a symlink to this file.** Edit in place; never `rm`+recreate.
- **Three peers live under `plugins/`** — `plugins/keeper/` (hooks + `keeper:*` skills) and `plugins/plan/`
  (behind `keeper plan`, `plan:*` skills) are claude-plugins, each with exactly ONE `<plugin>/.claude-plugin/plugin.json`
  (keeper exactly ONE `hooks/hooks.json`); `plugins/prompt/` is the engine behind `keeper prompt` and carries NO
  `.claude-plugin` manifest. `plugins/plan/` also renders the `subagents.yaml` model × effort matrix as per-cell
  `work`-plugin manifests under `workers/<model>-<effort>/`, ADDED via `--plugin-dir` — ADDITIVE atop the full plugins.yaml (keeper+plan+arthack) every launch inherits (docs/plugin-composition-map.md). Never duplicate a manifest, never add a
  `~/.claude/plugins/keeper` symlink (double-registers the hook); the daemon, `cli/`, `src/`, and the `keeper` binary stay at the repo root.
- **The Agent Bus inbox watcher is a session Monitor** in `plugins/keeper/monitors.json` — STRICTLY
  separate from `hooks.json`; never fold in.
- **A `keeper bus chat send` MUST NOT join the live registry** (`send_only:true`); only a subscribed `keeper bus watch` channel establishes bus presence (`CONTEXT.md`).

## Event-sourcing invariants

- **Cursor + projection advance in ONE `BEGIN IMMEDIATE` transaction** — the fold writes the projection AND bumps `reducer_state.last_event_id` together.
- **Never throw inside a fold.** Malformed `data` folds to a safe value and the cursor still
  advances. Schema defaults must match the zero-event projection.
- **Re-fold determinism is sacred** for the deterministic-replayed projection class
  (`jobs`/`epics`/`commit_trailer_facts`/…). Inside a fold, build derived arrays from stable
  total-order sorts (never append), and NEVER read wall-clock, env vars, the filesystem, or process
  liveness — use the event's `ts`. Only producers probe those.
- **Never wipe-and-replay the live-only projections.** A rewinding migration wipes ONLY the
  deterministic-replayed ones; rewind the live-only git surface via `rewindLiveProjection`, not `DELETE`.
- **A fold whose per-event cost grows with history OR board size is a re-fold time-bomb.** Model
  such work live-only, constant-bounded, an incremental id-watermark memo, or an idempotent per-key
  replace-merge; on the subscribe serve path bound an unbounded collection with `recencyBound`.

## Hook rules

- **Six hooks under `plugins/keeper/plugin/hooks/`** — events-writer (logs every Bash invocation, NEVER blocks), branch-guard (`PreToolUse(Bash)`, hard-denies a SUBAGENT — `agent_id` present — from git branch create/switch/worktree-add and every mutating `git stash`, list/show/create allowed; the in-daemon worktree producer shells git with no `agent_id`, so it is NOT gated), escalation-guard (`PreToolUse(Bash)` sibling, role-keyed on `KEEPER_ESCALATION_ROLE` — unblock/resolve diagnosis-only, deconflict/repair write-capable, interpreter/heredoc/redirect writes denied; FAILS CLOSED for a marked session, else inert), sidecar-writer (`PostToolUse`, owns the `~/docs` sidecar + git state, NEVER the `.md` body), docs-pusher (`Stop`, pushes `~/docs` once per turn), context-hint (`SessionStart`, node-only, surfaces the repo root's `CONTEXT.md` when present + non-empty). Two sibling events-log writers ride the SAME discipline — the hermes shell shim (`hooks/hermes-events-shim.ts`, registered by `src/hermes-trust.ts`; self-seeds an adopted identity when `KEEPER_JOB_ID` is absent) and the ephemeral pi in-process extension (`plugins/keeper/pi-extension/`, armed per-launch via `-e`, gated on `KEEPER_JOB_ID`).
- **Always exit 0 / fail-open** — a non-zero exit can fail-closed the human's session; a throwing shim/extension must degrade its harness to presence-only, NEVER crash or stall its turn. branch-guard and escalation-guard deny via the `PreToolUse` JSON envelope (`permissionDecision:"deny"`), NOT a non-zero exit; a `Stop` hook exiting 2 BLOCKS stopping (docs-pusher swallows + logs). A shim/extension NEVER writes host stdout (it is the harness's hook control channel) and logs every failure privately.
- **No third-party deps, and NO `bun:sqlite`/`src/db.ts` in a hook or events-log writer.** Keep imports to `node:*` + the dep-free `src/{dead-letter,derivers,exec-backend,sidecar,doc-commit}.ts` helpers; never the plan plugin (the pi extension loads in ISOLATION via jiti — `node:*` + its own contract copy only). Hook/shim payloads are attacker-influenced: emit each record as ONE JSON line (no NDJSON injection, no shell interpolation), size-bounded.
- **A `~/docs` hook may spawn a bounded git subprocess** — read-only probes (e.g. a `rev-parse` for sidecar provenance) against the session repo are fine; the hard line is NO mutating git or DB write outside the `~/docs` repo, and never `git fetch`/rebase/force-push even there.

## Migrations

- **Forward-only** via `meta(schema_version)`; non-idempotent steps are version-guarded. The daemon
  is the SOLE migrator and never downgrades a DB stored above the binary's `SCHEMA_VERSION`.
- **When you bump `SCHEMA_VERSION`, add the version to `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py`
  in the SAME commit** — a hard whitelist enforced by `test/schema-version.test.ts`.

## Writes are tightly scoped — DO NOT widen them

- **No general write path into the reducer.** The socket carries `query` (read) and `rpc` (mutate).
  RPC may write ONLY these seven surfaces, each round-tripping through a synthetic event:
  `replay_dead_letter`, `retry_dispatch`, `set_autopilot_paused`, `set_autopilot_mode`, `set_autopilot_config`,
  `set_epic_armed`, `request_handoff` — `set_autopilot_config` is GENERIC (a partial `autopilot_state` config patch; a future setting = a column + patch field, no new RPC). Never write `jobs`/`epics` directly.
- **Plans are READ-ONLY.** The plan worker folds `.keeper/{epics,tasks}` snapshots into `epics`; no RPC writes a plan field. **Board-orient before acting** with `keeper status`; get per-task detail via `keeper query tasks` — never hand-parse a `keeper plan <verb>` read.
- **Sole-writer rules.** The events-log per-pid NDJSON tree has a writer CLASS keyed on the keeper job id — the claude events-writer hook, hermes shell shim, and ephemeral pi extension each write ONLY their own `<pid>.ndjson`, never the DB; `keeper agent` is SOLE writer of the births tree. sidecar-writer + docs-pusher write ONLY the `~/docs` repo. The events-log ingester is sole writer of hook-sourced `events` rows; main writes all synthetic events + `dead_letters` + the replay path (birth-ingest/codex-state producers feed it, never the DB), workers feed via main. `src/{codex,hermes}-trust.ts` are the ONLY writers of those harnesses' config dirs, fail-open. `keeper statusline-sink` is SOLE writer of the statusLine leaf files (never DB/socket); `keeper agent panel start` SOLE writer of `~/.local/state/keeper/panels/`. `keeper baseline` is sole writer of the request spool, the baseline worker of its result leafs.
- **Profile-dir names are guarded — never hand-create `~/.claude-profiles/default`.**
  `assertProfileDirNameAllowed` fail-loud rejects (StateError→exit 1) the reserved set (`""`/`default`/`auto`, trimmed) + path-escape (separator/`..`/NUL, checked on RAW input) at every `mkdir` site.

## Process & DB-watch invariants

- **No kernel watchers on keeper's OWN DB.** Detect DB changes via `PRAGMA data_version` polling on a
  read-only connection. Carve-out: `@parcel/watcher` on EXTERNAL trees and kqueue/pidfd on EXTERNAL descriptors are fine. A transient `SQLITE_NOTADB` on that poll skips the tick via the shared `NotadbTolerance` helper, never an ad-hoc per-site catch.
- **No in-process self-heal.** Any unrecoverable error calls `fatalExit` (non-zero exit — the
  LaunchAgent respawn is the sole recovery path); never respawn a worker in-process (carve-outs:
  closing a stale/EPIPE UDS client, the git seed-liveness watchdog's capped MAIN boot-seed re-runs
  before it escalates to `fatalExit`, and the serve-liveness watchdog's bounded real-read socket
  probes that `fatalExit` a wedged serve path, NAMING which socket/mode tripped). A sustained crash-loop is loud, not invisible: main appends each boot to a durable restart ledger (state-dir sidecar, NOT a fold) and mints ONE sticky needs_human distress row, level-cleared once the boot rate recovers.
- **`keeper tabs restore --apply` exits non-zero while autopilot is unpaused** (fail closed, never warn-and-continue) unless `--force` is passed.

## Worker contract

- **`isMainThread` guard** — a plain import of the module is inert.
- **Own `openDb` connection, read-only** (never share main's; `prepareStmts:false` when a connection
  prepares no statements). A worker writing keeper.db is forbidden.
- **Typed messages** — `{ kind }` worker→main, `{ type }` main→worker.
- **Supervisor-owned lifecycle** — main spawns after migrate+boot-drain and is the only one that
  terminates. A worker owning an external resource (a second SQLite file, a UDS socket, a watcher
  subscription) MUST release it in its own shutdown handler.

## Test isolation

- **One fast pure-in-process tier.** `bun test` is the keeper fast suite (only `test:opentui` splits out); `bun run test:full` gates all four suites serially — root, plan, python, prompt — and `test:full:slow` injects `KEEPER_RUN_SLOW` / `KEEPER_PLAN_RUN_SLOW` to unlock the real-git/subprocess tiers. NO test boots a real daemon / Worker thread / UDS socket / subprocess / git / tmux — git-boundary DECISIONS go through a pure seam, never git's execution. There is no watchdog, so a test must never hang or synchronously spin; production is the integration safety net.
- **Sandbox ALL SIX state classes** under the per-test tmpdir for any test on the real state surface:
  `KEEPER_DB`, `KEEPER_DEAD_LETTER_DIR`, `KEEPER_DROP_LOG`, `KEEPER_RESTORE_FILE`, `KEEPER_BACKSTOP_LOG`,
  and the Agent Bus pair `KEEPER_BUS_DB` / `KEEPER_BUS_SOCK` — never `{ ...process.env, KEEPER_DB }`;
  build via `sandboxEnv(...)`. Pure unit tests use `freshMemDb()` / `freshDbFile()` over a full `migrate()`.
- **Test runs are lock-free** — `scripts/test-gate.ts` (the `test` script routes through it) caps
  `--parallel` (`KEEPER_TEST_PARALLEL`, default 5) + adds `--no-orphans`. Never add a host-wide lock — a hung holder wedges every runner.
- **Poll, don't sleep.** Any assertion waiting on async state uses `retryUntil`
  (`test/helpers/retry-until.ts`), never a fixed `Bun.sleep`.

## Autopilot

- **The reconciler resumes its last durable paused state** (PAUSED on a fresh board), level-triggered on
  `PRAGMA data_version`. An unpaused autopilot that "does nothing" is almost always a readiness gate
  firing correctly (`src/readiness.ts` `computeReadiness`); the `[paused]` banner is authoritative. For
  modes, caps, cooldown, reaps, and the four reapers, read `src/autopilot-worker.ts`.
- **Worktree mode** (durable `autopilot_state` column, default OFF, via `set_autopilot_config`) **is PRODUCER-ONLY**: lanes re-derived each cycle from the DAG + live git, never a fold. The `worktree_multi_repo` flag (default OFF, same `set_autopilot_config` RPC) CLUSTERS a >1-toplevel epic into per-repo lane groups — one plan-close on `primary_repo` gates every group's INDEPENDENT per-repo finalize. A content conflict — `finalizeEpic`'s close-sink OR recover pass-2 — escalates on the bare `close::<epic>` `worktree-merge-conflict` sticky (below, `retry_dispatch`-only clear). The recover pass keys each transient epic-tied degrade per-(epic,repo) on `close::worktree-recover:<epic>-<repoHash>`; its `worktree-recover*` level-clear is POSITIVE-EVIDENCE-only — an open row clears solely on a same-cycle resolution (merged / ancestor / absent), retained on no report or an inconclusive probe. Per-repo finalize failures key on the sibling `close::worktree-finalize:<epic>-<repoHash>` rows that never collide with recover rows or each other; finalize DEGRADES a dirty/off-branch shared-checkout (and lock/local-op timeouts) into a non-sticky `retry` skip minting no row — but a MID-MERGE shared checkout (MERGE_HEAD) is classified DISTINCTLY: the recover pass self-heals a sole-owned `keeper/epic/*` residue via a flock-guarded `git merge --abort` (foreign/ambiguous/MERGE_AUTOSTASH residue NEVER aborted; a failed/timed-out abort surfaces distinctly), and a wedge past a short grace mints a per-repo `shared-checkout-wedge` needs_human distress row (`daemon` verb, orphan-GC-exempt, un-retryable) whose ONLY clear is the recover level-trigger observing the checkout clean. A SIBLING per-repo `shared-checkout-desync` row (same daemon-verb/orphan-GC-exempt/un-retryable discipline, but EVENT-SEEDED — a LIVE producer, not the neutered wedge/dirty drain) fires when a base→default merge advances the ref yet its resync is skipped/aborted so the checkout TRAILS the tip; it mints past a short grace and clears ONLY on a per-cycle CONTENT probe seeing the on-default checkout carry the default tip (index and worktree both match HEAD). The fan-in LANE pre-merge rides this per-LANE: an un-losslessly-mergeable base mints a SELF-CLEARING `work::<taskId>` `worktree-lane-premerge` row (reason-scoped positive-evidence level-clear BY LANE PATH, even cap-gated); a persistent wedge or immediate `abort-failed` escalates to a per-LANE `worktree-lane-wedge` `daemon` distress row (orphan-GC-exempt). A genuine origin-ahead non-ff is NOT a retry skip: it mints a VISIBLE `worktree-finalize-non-fast-forward` sticky for an operator to reconcile origin. On a sticky `worktree-merge-conflict` close two sweeps fire (each gated on its OWN `dispatch_failures` column, NEVER a sibling latch table — only `retry_dispatch` clears it + re-arms markers): a `resolve::<epic>` resolver worker FIRST (`resolver_dispatched_at`, mechanically-clear conflicts only, else BLOCKED), THEN ONE `deconflict::<epic>` session SEQUENCED behind it (`merge_escalated_at`, requiring `resolver_dispatched_at` set AND a terminal resolver verdict declined/BLOCKED/died). The human is paged EXACTLY once, at the `deconflict::` session's OWN terminal decline/death (`human_notified_at`); a paused board defers every stage to play. A worker-confirmed `SHARED_BASE_BROKEN` block (baseline-gated: base red at HEAD independent of the diff) routes THE SAME WAY to ONE write-capable `repair::<repo>` session per (repo, fingerprint) sticky — full-gate-verified trunk commit (or green-at-HEAD no-op), then fan-out `keeper plan unblock` + bus ping to every affected task; a decline pages once, same `human_notified_at` discipline, parked until `retry_dispatch` re-arms it. DispatchFailed change-gates re-emits (first appearance + reason-change + a bounded still-stuck watermark; identical suppressed, clear immediate), so a stuck condition mints O(1) events. The cross-epic merge-gate (a dependent GROUP's lane is NOT cut until every lane-cutting SAME-RESOLVED-REPO upstream is in LOCAL default, satisfied by ancestry) is per-(epic,repoDir), EPHEMERAL + producer-probed ONCE/cycle (`deferredEpicIds`, pure-`reconcile` read), minting NO `dispatch_failures` row — an inconclusive/error probe DEFERS, an absent lane is absent-implies-merged (teardown deletes a base once ancestor-of-default, never `--squash`); an orphaned/squash-merged upstream surfaces via `lane_merged`+`keeper await landed`, un-remediated.
