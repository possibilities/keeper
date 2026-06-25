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
- **Plans are READ-ONLY.** The plan worker folds `.keeper/{epics,tasks}` snapshots into `epics`; no RPC writes a plan field.
- **Sole-writer rules.** The events-writer hook writes ONLY per-pid NDJSON files; the sidecar-writer
  + docs-pusher write ONLY the `~/docs` repo. The events-log ingester is the sole writer of
  hook-sourced `events` rows; main writes all synthetic events + `dead_letters` + the replay path,
  workers feed via main. The codex pre-launch trust-seed (`src/codex-trust.ts`) is the ONLY keeper
  surface writing codex's own config dir, fail-open.

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

- **Sandbox ALL SIX state classes** under the per-test tmpdir for any test spawning the real
  hook/daemon/CLI: `KEEPER_DB`, `KEEPER_DEAD_LETTER_DIR`, `KEEPER_DROP_LOG`, `KEEPER_RESTORE_FILE`,
  `KEEPER_BACKSTOP_LOG`, and the Agent Bus pair `KEEPER_BUS_DB` / `KEEPER_BUS_SOCK` — never
  `{ ...process.env, KEEPER_DB }`; build via `sandboxEnv(...)`. Pure in-process unit tests use
  `freshMemDb()` / `freshDbFile()` instead of a full `migrate()`.
- **Two tiers.** Default `bun test` runs the FAST tier only. **`bun run test:full` is mandatory
  before landing any change touching daemon / worker / db / hook / git process paths or a slow file.**
- **Two independent test axes.** (1) Slow-tier: a too-slow case is EXTRACTED (plus its setup) into a
  `*.slow.test.ts` sibling while its file stays fast (path-ignored from the fast tier into `test:full`),
  never the whole file or `test.skip`. (2) No real git in default tiers — test git-boundary DECISIONS via a
  pure seam; a test whose contract genuinely IS git's execution must ALSO be allowlisted in `scripts/test-real-git-allowlist.txt` (`bun run test:hygiene`).
- **The host-wide test lock is un-bypassable** — `scripts/test-gate.ts` (parallelism cap + `flock`)
  and the `bunfig.toml` preload both apply it; every lock path fails open.
- **Poll, don't sleep.** Any assertion waiting on async worker/daemon state uses `retryUntil`
  (`test/helpers/retry-until.ts`), never a fixed `Bun.sleep`.

## Autopilot

- **The reconciler resumes its last durable paused state** (PAUSED on a fresh board), level-triggered on
  `PRAGMA data_version`. An unpaused autopilot that "does nothing" is almost always a readiness gate
  firing correctly (`src/readiness.ts` `computeReadiness`); the `[paused]` banner is authoritative. For
  modes, caps, cooldown, reaps, and the four reapers, read `src/autopilot-worker.ts` + README.
- **Worktree mode** (durable `autopilot_state` column, default OFF, set via `set_autopilot_config` — no new RPC) **is PRODUCER-ONLY**: lanes re-derived each cycle from the DAG + live git, never a fold (see README).
