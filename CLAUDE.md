keeper — event-sourced Claude Code control-data daemon (Bun + bun:sqlite). System map, rationale,
and incident history live in `README.md` `## Architecture` and `.keeper/` specs; this file is
imperative guardrails only.

## Docs discipline (rule #0)

- **Docs prune, never append-only.** Doc edits consolidate and delete as readily as they add;
  CLAUDE.md gains a line only for a rule an agent would otherwise get wrong.
  `bun scripts/lint-claude-md.ts` gates its size + bans re-narration — keep it green.
- **Forward-facing advice only** in comments and docs: state current behavior, never change
  history. No fn-ids, version numbers, dates, or past-tense provenance here.

## Repo facts

- **`AGENTS.md` is a symlink to this file.** Edit in place; never `rm`+recreate.
- **Two plugins live as peers under `plugins/`** — `plugins/keeper/` (hooks + `keeper:*` skills) and
  `plugins/plan/` (behind `keeper plan`, `plan:*` skills). Each has exactly ONE manifest at
  `<plugin>/.claude-plugin/plugin.json` (keeper exactly ONE `hooks/hooks.json`); never duplicate
  either, never add a `~/.claude/plugins/keeper` symlink (double-registers the hook). The daemon,
  `cli/`, `src/`, and the `keeper` binary stay at the repo root.
- **The Agent Bus inbox watcher is a session Monitor** in `plugins/keeper/monitors.json` — STRICTLY
  separate from `hooks.json`; never fold in.
- **Bus presence = a SUBSCRIBED `keeper bus watch` channel; a pure `keeper bus chat send` is
  EPHEMERAL** (`send_only:true`): a send MUST NOT join the live registry — only `watch` does.

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

- **Four hooks under `plugins/keeper/plugin/hooks/`** — events-writer (logs every Bash invocation,
  NEVER blocks), branch-guard (`PreToolUse(Bash)`, hard-denies a SUBAGENT — `agent_id` present — from git
  branch create/switch/worktree-add; the in-daemon worktree producer shells git with no `agent_id`, so it
  is NOT gated), sidecar-writer (`PostToolUse`, owns the `~/docs` sidecar + git state, NEVER the `.md`
  body), docs-pusher (`Stop`, pushes `~/docs` once per turn).
- **Always exit 0** — a non-zero exit can fail-closed the human's session. The branch-guard denies via the
  `PreToolUse` JSON envelope (`permissionDecision:"deny"`), NOT a non-zero exit; a `Stop` hook exiting 2 BLOCKS stopping (docs-pusher swallows + logs).
- **No third-party deps, and NO `bun:sqlite`/`src/db.ts` in a hook.** Keep imports to `node:*` + the
  dep-free `src/{dead-letter,derivers,exec-backend,sidecar,doc-commit}.ts` helpers; never the plan plugin.
- **A `~/docs` hook may spawn a bounded git subprocess** against the `~/docs` repo only — never a keeper-DB write, never `git fetch`/rebase/force-push.

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
- **Plans are READ-ONLY.** The plan worker folds `.keeper/{epics,tasks}` snapshots into `epics`; no RPC writes a plan field. **Board-orient before acting** with `keeper status`; get per-task detail (tier/model/title/deps) via `keeper query epics --json | jq '.data[]'` — never hand-parse a `keeper plan <verb>` read.
- **Sole-writer rules.** The events-writer hook writes ONLY per-pid NDJSON files; the sidecar-writer + docs-pusher
  write ONLY the `~/docs` repo. The events-log ingester is the sole writer of hook-sourced `events` rows; main
  writes all synthetic events + `dead_letters` + the replay path, workers feed via main. The codex trust-seed
  (`src/codex-trust.ts`) is the ONLY keeper surface writing codex's config dir, fail-open. `keeper statusline-sink`
  is the SOLE writer of the statusLine leaf files `statusline-worker` reads (never the DB/socket); `keeper agent
  panel start` the SOLE writer of `~/.local/state/keeper/panels/` (durable per-slug panel state, no daemon/hook).
- **Profile-dir names are guarded — never hand-create `~/.claude-profiles/default`.**
  `assertProfileDirNameAllowed` fail-loud rejects (StateError→exit 1) the reserved set (`""`/`default`/`auto`, trimmed) + path-escape (separator/`..`/NUL, checked on RAW input) at every `mkdir` site.

## Process & DB-watch invariants

- **No kernel watchers on keeper's OWN DB.** `fs.watch`/FSEvents/kqueue drop same-process and WAL
  writes on macOS — detect DB changes via `PRAGMA data_version` polling on a read-only connection.
  Carve-out: `@parcel/watcher` on EXTERNAL trees and kqueue/pidfd on EXTERNAL descriptors are fine.
- **No in-process self-heal.** Any unrecoverable error calls `fatalExit` → `process.exit(1)`; the
  LaunchAgent restarts the single recovery path. Never respawn a worker in-process (carve-outs:
  closing a stale/EPIPE UDS client, and the git seed-liveness watchdog's capped MAIN boot-seed
  re-runs before it escalates to `fatalExit`).
- **`restore-agents --apply` exits non-zero while autopilot is unpaused** (fail closed, never warn-and-continue) unless `--force` is passed.

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
  modes, caps, cooldown, reaps, and the four reapers, read `src/autopilot-worker.ts` + README.
- **Worktree mode** (durable `autopilot_state` column, default OFF, set via `set_autopilot_config` — no new RPC) **is PRODUCER-ONLY**: lanes re-derived each cycle from the DAG + live git, never a fold (see README). The multi-repo rollout flag `worktree_multi_repo` (default OFF, same generic `set_autopilot_config` RPC) CLUSTERS a >1-toplevel epic into per-repo lane groups — one plan-close on `primary_repo` gates every group's INDEPENDENT per-repo finalize. The recover pass keys each epic-tied failure per-(epic,repo) on `close::worktree-recover:<epic>-<repoHash>` (null-epic pass-1 → per-dir slug), and its level-triggered auto-clear MUST stay scoped to recover-reason rows (`worktree-recover*`); per-repo finalize failures key on the sibling `close::worktree-finalize:<epic>-<repoHash>` rows that never collide with recover rows or each other — a genuine `finalizeEpic` close-sink block (a content conflict) shares the `close::<epic>` key and must NEVER be auto-dismissed; finalize instead DEGRADES a dirty/off-branch shared-checkout (and the lock/local-op timeouts) into a non-sticky `retry` skip that mints no sticky row at all, so it is neither auto-cleared nor a sticky jam — but a genuine origin-ahead non-ff is NOT a retry skip: it mints a VISIBLE `worktree-finalize-non-fast-forward` sticky DispatchFailed (outside the `worktree-recover*` auto-clear prefix) that needs an operator to reconcile origin, and must NEVER be reverted back into a retry-skip. The daemon merge-escalation sweep that notifies `planner@<epic>` about a sticky `worktree-merge-conflict` close gates on a COLUMN of `dispatch_failures` (`merge_escalated_at`, NEVER a sibling latch table) and is READ-ONLY wrt the sticky row — it notifies once and never clears it; only `retry_dispatch` does. The cross-epic merge-gate (a dependent GROUP's lane is NOT cut until every satisfied SAME-RESOLVED-REPO upstream is an ancestor of LOCAL default) is per-(epic,repoDir), EPHEMERAL + producer-probed ONCE per cycle in `loadReconcileSnapshot` (`deferredEpicIds`, read as plain data by pure `reconcile`) and mints NO `dispatch_failures` row — every probe inconclusive/error DEFERS (a stale fork is permanent), a definitively-absent lane is absent-implies-merged (sound ONLY because teardown deletes a base via a true `git merge --no-edit` once an ancestor of default — NEVER `--squash`); a pre-existing orphaned/squash-merged upstream is a documented stuck-state the parked observability plan owns, never gated here.
