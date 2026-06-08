keeper — event-sourced Claude Code control-data daemon (Bun + bun:sqlite).

The hook plugin writes one `events` row per Claude Code hook invocation; the
`keeperd` daemon folds those events into the `jobs`/`epics` projections and
serves them read-only over a UDS subscribe socket. System map, rationale, and
incident history: `README.md` `## Architecture` and the `.planctl/` epic specs.

## Repo facts

- **`AGENTS.md` is a symlink to this file.** Edit in place; never `rm`+recreate.
- **The repo root is the Claude plugin**, loaded via `claude --plugin-dir
  ~/code/keeper`. Exactly ONE manifest (`./.claude-plugin/plugin.json`) and ONE
  `./hooks/hooks.json` — never duplicate either, and never restore the retired
  `~/.claude/plugins/keeper` symlink (double-registers the hook).

## Design stance

The server (event log, reducer, projections, schema, RPC surface) is the durable
source of truth; clients are cheap to change. Schema bumps and column renames are
routine — design for the ideal shape, don't bend the server to preserve a lossy
shape because a consumer reads it.

## Event-sourcing invariants

- **Cursor + projection advance in ONE `BEGIN IMMEDIATE` transaction.** Each fold
  writes the projection AND bumps `reducer_state.last_event_id` together. Never
  split them — that's the exactly-once-per-event guarantee.
- **Re-fold determinism is sacred.** Nothing is written straight to the
  projections; every fact lives in the immutable event log. A from-scratch
  re-fold must reproduce byte-identical rows. So inside a fold: build derived
  arrays from stable total-order sorts (never append), and NEVER read wall-clock
  (`Date.now()`), env vars, the filesystem, or process liveness — use the event's
  own `ts` for time. Hook-side derivers are pure functions of the payload.
- **Never throw inside a fold.** A malformed `data` blob folds to a safe value and
  the cursor still advances; a throw rolls back the cursor and wedges the reducer.
- **Schema defaults match the zero-event projection**, so a re-fold from empty
  reproduces the same rows.
- **Only producers probe liveness** (boot seed sweep, exit-watcher). Folds never
  probe.

## Hook rules

- **Always exit 0.** A non-zero exit can fail-closed the human's session. On a
  failed INSERT, write a per-pid NDJSON dead-letter and still exit 0. Losing one
  row is acceptable; wedging the agent is not.
- **No third-party deps.** Keep the hook's imports to `bun:sqlite` + local files
  (cold start budget).
- **The hook never migrates** — it opens `{ migrate: false }` and tolerates a
  behind-schema DB by intersecting its known `events` columns with the live shape
  (missing column lands NULL).
- **Scraping is scoped.** On `SessionStart` only: parent claude `--name`/`-n` +
  `CLAUDE_CONFIG_DIR` (single-level ppid, no walking). On every event: `ZELLIJ*`
  env reads (synchronous, no fork/fs). No other scraping, no env read in a fold.

## Migrations

- **Forward-only** via `meta(schema_version)`; non-idempotent steps are
  version-guarded. The **daemon is the sole migrator.**
- **When you bump `SCHEMA_VERSION`, add the version to `SUPPORTED_SCHEMA_VERSIONS`
  in `keeper/api.py` in the SAME commit** — it's a hard whitelist; an unlisted
  version fails every keeper-py read on the host. `test/schema-version.test.ts`
  enforces this.

## Writes are tightly scoped — DO NOT widen them

- **No general write path into the reducer.** The socket carries `query` (read)
  and `rpc` (mutate). RPC may write ONLY four surfaces, each of which round-trips
  through a synthetic event so a re-fold sees it: (1) the `approval` field, written
  to the gitignored runtime sidecar `.planctl/state/{epics,tasks}/<id>.state.json`
  (fn-732 — NOT the committed def), (2) `replay_dead_letter`, (3) `retry_dispatch`,
  (4) `set_autopilot_paused`. RPC handlers MUST NOT write `jobs`/`epics`/etc directly.
- **Plans are READ-ONLY except `approval`.** The plan worker folds
  `.planctl/{epics,tasks}` snapshots into `epics`; the only writable field is
  `approval`. fn-732 moved `approval` out of the committed def into the gitignored
  runtime sidecar (`.planctl/state/{epics,tasks}/<id>.state.json`) so keeper folds
  it GATE-FREE (no commit on the critical path — eliminating the approve-fold lag).
  The fold resolves approval via a PERMANENT ladder — **sidecar → committed def →
  `pending`** — so approval stays resolvable on a keeper that predates a sidecar,
  and the parallel-change deploy order (reader-first) is non-fragile. NEVER gate
  away the def-fallback; it's the safety net the whole epic depends on. The
  `set_{task,epic}_approval` RPC writes the sidecar (create-if-absent; task RMW
  preserves the sidecar's status/claim fields; traversal-guarded).
- **Sole-writer rules.** The hook writes hook events + per-pid dead-letters. Main
  writes all synthetic events + the `dead_letters` sidecar + the replay path.
  Workers feed the log only via main; they never write the DB themselves.
- **The babysitter is a pure read-only external scanner.** `cli/keeper-watch.ts`
  opens `keeper.db` read-only and only observes — no event-log write, no
  synthetic events, no RPC. Its SECOND read-only input is keeper's own
  `backstop.ndjson` self-telemetry (read via `KEEPER_BACKSTOP_LOG`), consumed the
  same no-write/no-RPC way — never a DB write, synthetic event, or RPC. Its own
  seen-state, the liveness `heartbeat.json` it stamps as the last action on every
  completed tick, and the escalation follow-up prompt files live outside the DB
  under `~/.local/state/keeper-watch/`. A SEPARATE launchd dead-man
  (`cli/keeper-watchdog.ts`) reads ONLY that heartbeat and pages on staleness; it
  is standalone (no `keeper.db`, no keeperd, no `keeper-watch` dependency) so it
  still runs when the thing it watches has died.

## No kernel watchers on keeper's OWN DB

`fs.watch`/FSEvents/kqueue drop same-process and WAL writes on macOS. Detect
DB changes via `PRAGMA data_version` polling on a read-only connection (optionally
woken faster by a same-process `postMessage({type:"kick"})` after a drain).
Carve-outs are fine: `@parcel/watcher` on EXTERNAL trees (transcripts, `.planctl`,
`.git/logs/HEAD`) and kqueue/pidfd on EXTERNAL process descriptors (exit-watcher).

## No in-process self-heal

Any unrecoverable error (including a worker's `error` event) calls `fatalExit` →
`process.exit(1)`; the LaunchAgent restarts the single recovery path. Never
respawn a worker in-process. **Carve-out:** closing a stale/EPIPE UDS client
connection (the fn-723 reaper: EPIPE-evict, stuck-pending TTL, max-conn cap) is
connection hygiene, not self-heal — it touches only the server-worker's `conns`
Set + the socket, never respawns a worker, never writes the DB, never emits a
synthetic event.

## Worker contract

- **`isMainThread` guard** — a plain import of the module is inert.
- **Own `openDb` connection** (read-only for readers); never share main's.
- **Typed messages** — `{ kind }` worker→main, `{ type }` main→worker. The UDS
  client connection lifecycle (evict/cap, fn-723) is the server-worker's own
  socket-handler concern — distinct from this `{type}`/`{kind}` worker↔main
  message bus.
- **Supervisor-owned lifecycle** — main spawns after migrate+boot-drain and is the
  only one that terminates (`shutdown` → await close → terminate). A worker owning
  an external resource MUST release it in its own shutdown handler.

## Test isolation

Every test that spawns the real hook MUST sandbox ALL FIVE state paths under the
per-test tmpdir: `KEEPER_DB`, `KEEPER_DEAD_LETTER_DIR`, `KEEPER_DROP_LOG`,
`KEEPER_RESTORE_FILE`, `KEEPER_BACKSTOP_LOG`. Never `{ ...process.env, KEEPER_DB }`
— it strands the others at production defaults and pollutes the real feed. Build
the env via the shared `sandboxEnv(...)` in `test/helpers/sandbox-env.ts`, which
applies the state paths LAST (after any caller `extra`/undefined-clear) so a
caller can't re-strand one: pass `clearAmbientIds: true` for CLI-spawn tests
(clears `CLAUDE_CODE_SESSION_ID`/`JOBCTL_*`), `includeZellij: true` to add the
sixth `KEEPER_ZELLIJ_EVENTS_DIR` (fn-684) for hook-spawn tests.

## Autopilot

The server-side reconciler dispatches workers against ready plan work. It **boots
paused** and is level-triggered on `PRAGMA data_version`. An unpaused autopilot
that "does nothing" is almost always a readiness gate firing correctly — the gates
live in `src/readiness.ts` (`computeReadiness`) and decide which verdicts occupy
the per-epic / per-root mutex. Common gates: won't dispatch against an uncommitted
epic, into a dirty repo, during the launch→SessionStart blind window, or against a
taskless epic. To inspect, read `src/readiness.ts` and `src/autopilot-worker.ts`;
the `[paused]` banner in `keeper autopilot` is authoritative.

**Global cap (`max_concurrent_jobs`)** counts root-occupants (planner-exempt,
and now approve-exempt) before per-epic dispatch; the budget governs only
`work`/`close` launches. `approve`-verb launches are exempt at both launch
sites — they skip the budget gate and never decrement it — so a backlog of
pending-approval rows can't deadlock the very approvers that would drain it.

**Completion reap (`autoclose_windows`, default `true`, fn-727).** When a row
reaches the `{tag:"completed"}` verdict (worker done + approved + idle), the
reconcile cycle closes its zellij surfaces via `ExecBackend.reapSurfaces`
(pane-close on the surviving live-probe path — NOT the retired `closeByTabId`
tab-coord mechanism): a completed task reaps `work::<id>` + `approve::<id>`, a
completed close-row reaps `close::<id>` + `approve::<id>`; pending / rejected /
worker-ended-unapproved windows stay open. Deliberately does NOT gate on
`is_exited` (the approver is live at approval). See `src/autopilot-worker.ts`
(`isCompletionReapCandidate`, `reapCompletionSurfaces`) + `src/exec-backend.ts`
(`reapSurfaces`).

## Out of scope

prise/env-var integration, multi-session lineage, harness_meta.
