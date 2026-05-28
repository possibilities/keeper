/**
 * Keeper daemon — the long-running reducer process. Managed in production by a
 * LaunchAgent that re-runs `bun run src/daemon.ts` on any non-clean exit.
 *
 * Boot sequence (the locked design):
 *
 *   1. Open the writer connection (`openDb`). DDL + forward-only migration run
 *      inside `openDb`; the reducer_state cursor is seeded there too.
 *   2. Boot drain: `while (drain(db, BATCH) > 0) {}` — fold every unfolded event
 *      using the SAME code path as steady-state. After downtime this catches the
 *      projection up before the daemon goes live.
 *   3. Spawn SIX worker threads (all AFTER migrate + boot drain + seed sweep,
 *      so their read-only `openDb` connections never race a missing/un-migrated
 *      DB and the exit-watcher's data_version diff sees a settled projection):
 *      - the wake worker — opens its own read-only connection, polls
 *        `PRAGMA data_version`, and posts a contentless `{ kind: "wake" }`
 *        whenever another connection commits.
 *      - the server worker — owns the UDS read surface: its own read-only
 *        connection, the `keeperd.lock` ownership lock, an NDJSON listener, and
 *        its own `data_version` poll that fans `jobs` changes out as patches.
 *      - the transcript worker — watches the external transcript tree with
 *        `@parcel/watcher`, tails each session's JSONL for the `custom-title`
 *        line, and posts `{ kind: "transcript-title", sessionId, title }`. Main
 *        turns that into a synthetic `TranscriptTitle` events row (priority-3
 *        title) on its own writable connection — keeperd's first role as an
 *        event PRODUCER. Main stays the sole writer; the worker is read-only.
 *      - the plan worker — watches each project root's `.planctl/{epics,tasks}`
 *        trees with `@parcel/watcher` and posts `{ kind: "plan-epic" | "plan-task",
 *        … }` snapshot messages. Main turns each into a synthetic
 *        `EpicSnapshot` / `TaskSnapshot` events row on its writable connection —
 *        the second producer-worker instance. Main stays the sole writer; the
 *        worker is read-only.
 *      - the exit-watcher worker — owns a kqueue (macOS) / pidfd+epoll (Linux)
 *        fd via `bun:ffi`, polls `data_version` to keep its (jobs.pid) watch set
 *        in sync, and posts `{ kind: "exit", jobId, pid, startTime }` when a
 *        tracked pid exits or the post-register kill-0 probe finds it already
 *        dead. Main turns each into a synthetic `Killed` events row (after a
 *        strict `(pid, start_time)` match against the persisted row) on its
 *        writable connection — the third producer-worker instance. The kqueue/
 *        epoll fd is owned by the worker thread and released in its own
 *        shutdown handler.
 *      - the git worker — polls planctl-backed git worktrees via
 *        `git status --porcelain=v2 -z`, mines file-tool events from the DB,
 *        and posts `{ kind: "git-snapshot", ... }`. Main turns each into a
 *        synthetic `GitSnapshot` events row — the fourth producer-worker
 *        instance.
 *   4. Steady state: every wake triggers a full drain loop. Wakes that arrive
 *      mid-drain coalesce into the next pass via a single "wake pending" flag —
 *      no event is missed (drain always re-reads from the cursor) and drain is
 *      never invoked re-entrantly. A `transcript-title` / `exit` message
 *      inserts the synthetic event then pumps a wake to fold it.
 *   5. SIGTERM: post `{ type: "shutdown" }` to ALL SIX workers, await their
 *      `close` events against a short deadline, terminate them, close the db,
 *      exit 0. This is the ONLY clean exit. The server worker releases its
 *      socket + lock, the transcript + plan workers unsubscribe their watchers,
 *      and the exit-watcher releases its kqueue/pidfd fd — all inside their
 *      own shutdown handlers (those resources are process/thread-owned, so
 *      `terminate()` alone would leak them).
 *
 * Crash policy (single recovery path): ANY unrecoverable error — either worker's
 * `error` event, an unhandled rejection, or a fold throw that escapes the
 * per-event guard — calls `process.exit(1)`. The LaunchAgent
 * `KeepAlive.SuccessfulExit = false` then restarts us. We deliberately keep ONE
 * well-tested recovery path rather than attempting in-process self-heal — no
 * in-process respawn of either worker.
 */

import type { Database } from "bun:sqlite";
import {
  openDb,
  resolveClaudeProjectsRoot,
  resolveDbPath,
  resolvePlanRoots,
  resolveUsageRoot,
  runPlanctlApprovalMigration,
} from "./db";
import type { ExitMessage, ExitWatcherWorkerData } from "./exit-watcher";
import type { GitWorkerData, GitWorkerMessage } from "./git-worker";
import type { PlanMessage, PlanWorkerData } from "./plan-worker";
import { DEFAULT_BATCH_SIZE, drain } from "./reducer";
import { seedKilledSweep } from "./seed-sweep";
import type { ServerWorkerData } from "./server-worker";
import type {
  ApiErrorMessage,
  InputRequestMessage,
  TranscriptTitleMessage,
  TranscriptWorkerData,
} from "./transcript-worker";
import type { UsageMessage, UsageWorkerData } from "./usage-worker";
import type {
  ShutdownMessage,
  WakeMessage,
  WakeWorkerData,
} from "./wake-worker";

/** Grace period for the worker to exit on shutdown before we close the db anyway. */
const WORKER_SHUTDOWN_DEADLINE_MS = 2000;

/**
 * Drain the projection to completion: loop `drain()` until it reports 0 newly
 * folded events. Shared by boot catch-up and every steady-state wake — the same
 * idempotent code path the design mandates. Each `drain()` call folds at most
 * `batchSize` events in their own transactions, so the writer lock is released
 * between batches and hook inserts are never starved.
 */
export function drainToCompletion(
  db: Database,
  batchSize = DEFAULT_BATCH_SIZE,
): void {
  while (drain(db, batchSize) > 0) {
    // keep folding until caught up
  }
}

/**
 * Run the daemon. Returns once the process is wired up and the steady-state
 * wake loop is running; the loop itself keeps the event loop alive until SIGTERM
 * or a crash. Exported (rather than executed at import) so a test can drive boot
 * drain in isolation via {@link drainToCompletion} without spawning the worker.
 */
function runDaemon(): void {
  process.title = "keeperd";

  const dbPath = resolveDbPath();
  const { db, stmts } = openDb(dbPath);

  // Step 1b — schema-v13 planctl approval migration (filesystem half). The
  // SQL half (ADD COLUMN `epics.approval` + DROP TABLE `approvals`) ran
  // inside `openDb`'s migrate(). This pass backfills `approval: "approved"`
  // onto every existing epic plan file lacking the field and overlays each
  // (about-to-be-dropped) approvals-table row onto the matching epic/task
  // plan file. MUST run before the plan worker spawns: a watcher callback
  // on a half-migrated tree would post a stale snapshot. Naturally
  // idempotent — a missing-field check skips already-migrated files, the
  // overlay reads from `approvals` (returns 0 rows after the DROP), and the
  // table-exists guard skips the SELECT entirely on a fresh-v13 DB.
  const planRoots = resolvePlanRoots();
  runPlanctlApprovalMigration(db, planRoots);

  // Step 2 — boot drain. MUST finish before the worker spawns: otherwise the
  // worker would fire wakes against a writer connection still iterating boot
  // drain (harmless, drain is idempotent, but wasteful). The pre-sweep drain
  // also brings the `jobs` projection up to the latest persisted lifecycle
  // BEFORE `seedKilledSweep` reads it — without this, a SessionEnd that
  // landed mid-boot would still look like a live row to the sweep.
  drainToCompletion(db);

  // Step 2a — seed sweep. Fold dead/recycled jobs to `killed` BEFORE the
  // workers spawn, so the projection is consistent the moment the UDS server
  // starts serving. See `seedKilledSweep` for the Q7 match rules; the
  // surrounding drain folds the synthetic Killed events the sweep just
  // emitted.
  seedKilledSweep(db);
  drainToCompletion(db);

  // Coalescing flag: every wake sets it; the run loop resets it before each
  // drain pass. A wake arriving mid-drain leaves the flag set, so the loop runs
  // one more pass. No event is ever missed because drain re-reads from the
  // cursor on every pass.
  let wakePending = false;
  let draining = false;
  let shuttingDown = false;

  /**
   * Process the wake signal. Re-entrancy guard (`draining`) ensures we never
   * call drain recursively if a wake lands while we're already inside the loop;
   * that wake just leaves `wakePending` set for the in-flight loop to pick up.
   */
  function pumpWakes(): void {
    if (draining) {
      return;
    }
    draining = true;
    try {
      while (wakePending && !shuttingDown) {
        wakePending = false;
        drainToCompletion(db);
      }
    } finally {
      draining = false;
    }
  }

  // Step 3 — spawn the wake worker. Bun uses the web Worker API; `workerData`
  // is a worker_threads option not in the DOM lib type, hence the cast.
  const worker = new Worker(new URL("./wake-worker.ts", import.meta.url).href, {
    workerData: { dbPath, pollMs: 50 } satisfies WakeWorkerData,
  } as WorkerOptions & { workerData: unknown });

  // Step 4 — each wake message triggers a (coalescing) drain pass.
  worker.onmessage = (ev: MessageEvent<WakeMessage | undefined>): void => {
    if (ev.data && ev.data.kind === "wake") {
      wakePending = true;
      pumpWakes();
    }
  };

  // Worker `error` event is NOT a message — it signals the worker thread itself
  // failed. Per the single-recovery-path policy: crash → exit 1 → launchd
  // restarts. Do NOT attempt to respawn the worker in-process.
  worker.onerror = (err: ErrorEvent): void => {
    console.error("[keeperd] wake worker error:", err.message ?? err);
    fatalExit();
  };

  // A worker `process.exit(1)` (e.g. its own fatalExit) fires `close`, NOT
  // `onerror` — so the steady-state crash path needs its own listener, or a
  // crashing worker leaves a zombie daemon and launchd is never notified. The
  // `!shuttingDown` guard makes this a no-op on the clean path (shutdown() sets
  // the flag before posting `{ type: "shutdown" }`), avoiding a double exit.
  worker.addEventListener("close", () => {
    if (!shuttingDown) fatalExit();
  });

  // Spawn the server worker in the SAME post-migration window: its read-only
  // `openDb` would fail loud against a missing/un-migrated DB. It binds the UDS,
  // acquires the ownership lock, and runs its own `data_version` poll — fully
  // decoupled from the reducer. `dbPath` is the only required field; sock/lock
  // paths default to `resolveSockPath()` worker-side (KEEPER_SOCK honored there).
  const serverWorker = new Worker(
    new URL("./server-worker.ts", import.meta.url).href,
    {
      workerData: { dbPath } satisfies ServerWorkerData,
    } as WorkerOptions & { workerData: unknown },
  );

  // Same crash policy as the wake worker: any thread failure → fatalExit → exit
  // 1 → launchd restart. No in-process respawn.
  serverWorker.onerror = (err: ErrorEvent): void => {
    console.error("[keeperd] server worker error:", err.message ?? err);
    fatalExit();
  };

  // Same crash-via-`close` gap as the wake worker: a server-worker
  // `process.exit(1)` fires `close`, not `onerror`. Without this the subscribe
  // server could silently vanish while the reducer kept running. `!shuttingDown`
  // makes it inert on the clean shutdown path.
  serverWorker.addEventListener("close", () => {
    if (!shuttingDown) fatalExit();
  });

  // Spawn the transcript worker in the SAME post-migration window. It watches
  // the external transcript tree and posts a `transcript-title` message whenever
  // it tails a `custom-title` line — making the daemon an event PRODUCER for the
  // first time. The watch root is resolved ON MAIN via `resolveClaudeProjectsRoot()`
  // (config `claude_projects_root` → absolute path, default `~/.claude/projects`)
  // and passed as the always-populated `workerData.watchRoot`, mirroring how the
  // plan worker receives `roots: resolvePlanRoots()`.
  if (process.env.KEEPER_WATCH_ROOT) {
    console.error(
      "[keeperd] KEEPER_WATCH_ROOT is deprecated and ignored; set `claude_projects_root` in ~/.config/keeper/config.yaml instead",
    );
  }
  const transcriptWorker = new Worker(
    new URL("./transcript-worker.ts", import.meta.url).href,
    {
      workerData: {
        dbPath,
        watchRoot: resolveClaudeProjectsRoot(),
      } satisfies TranscriptWorkerData,
    } as WorkerOptions & { workerData: unknown },
  );

  // Main stays the SOLE writer: a worker `transcript-title` message becomes a
  // synthetic `TranscriptTitle` events row inserted on the existing WRITABLE
  // connection, then a wake pump folds it (priority-3 'transcript' title). The
  // insert is synchronous on the main thread and so cannot interleave with the
  // synchronous drain inside pumpWakes. Bindings are named — see the comment on
  // `stmts.insertEvent` in `src/db.ts` for why. The title rides in
  // `data.session_title` (the same field the reducer's title rule reads);
  // everything else is NULL (synthetic — never carries a process identity).
  transcriptWorker.onmessage = (
    ev: MessageEvent<
      TranscriptTitleMessage | ApiErrorMessage | InputRequestMessage | undefined
    >,
  ): void => {
    const msg = ev.data;
    if (!msg) {
      return;
    }
    if (msg.kind === "transcript-title") {
      stmts.insertEvent.run({
        $ts: Date.now() / 1000, // unix seconds as REAL, matching the hook
        $session_id: msg.sessionId, // == job_id
        $pid: null,
        $hook_event: "TranscriptTitle", // synthetic; reducer maps → 'transcript'
        $event_type: "transcript_title",
        $tool_name: null,
        $matcher: null,
        $cwd: null,
        $permission_mode: null,
        $agent_id: null,
        $agent_type: null,
        $stop_hook_active: null,
        $data: JSON.stringify({ session_title: msg.title }),
        $subagent_agent_id: null,
        $spawn_name: null,
        $start_time: null,
        $slash_command: null,
        $skill_name: null,
        $planctl_op: null,
        $planctl_target: null,
        $planctl_epic_id: null,
        $planctl_task_id: null,
        $planctl_subject_present: null,
        $config_dir: null,
        $planctl_queue_jump: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
      });
      // Our own INSERT bumps data_version, so the wake worker would re-drain
      // anyway — but pump directly so the title folds without a poll-cycle delay.
      wakePending = true;
      pumpWakes();
      return;
    }
    if (msg.kind === "api-error") {
      // Synthetic `ApiError` event minted from the transcript-worker
      // signal — Claude Code wrote its `isApiErrorMessage: true` synthetic
      // assistant turn to the JSONL, naming the failure mode via a
      // bare-string `error` field (`rate_limit` / `authentication_failed` /
      // `billing_error` / `server_error` / `invalid_request`; anything
      // else routed through the matcher's `"unknown"` fallback). The
      // reducer's dual-case `RateLimited` / `ApiError` arm (schema v24)
      // folds this row by flipping `jobs.state` to `'stopped'` AND
      // stamping `(last_api_error_at, last_api_error_kind)` to the event
      // ts + the matched kind in a single compound UPDATE
      // (re-fold-deterministic). Everything other than `session_id` /
      // `hook_event` / `event_type` / `data` is NULL — synthetics never
      // carry a process identity. The matched kind rides in `data.kind`
      // (read by the reducer's `extractApiErrorKind`); the display text
      // rides alongside in `data.text` for downstream consumers. The
      // pre-v24 `RateLimited` event_type is still folded by the same arm
      // via the dual-case alias so the historical event log re-folds
      // byte-deterministically — we never re-mint it.
      stmts.insertEvent.run({
        $ts: Date.now() / 1000,
        $session_id: msg.sessionId,
        $pid: null,
        $hook_event: "ApiError",
        $event_type: "api_error",
        $tool_name: null,
        $matcher: null,
        $cwd: null,
        $permission_mode: null,
        $agent_id: null,
        $agent_type: null,
        $stop_hook_active: null,
        $data: JSON.stringify({ kind: msg.errorKind, text: msg.text }),
        $subagent_agent_id: null,
        $spawn_name: null,
        $start_time: null,
        $slash_command: null,
        $skill_name: null,
        $planctl_op: null,
        $planctl_target: null,
        $planctl_epic_id: null,
        $planctl_task_id: null,
        $planctl_subject_present: null,
        $config_dir: null,
        $planctl_queue_jump: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
      });
      wakePending = true;
      pumpWakes();
      return;
    }
    if (msg.kind === "input-request") {
      // Synthetic `InputRequest` event minted from the transcript-worker
      // signal — Claude Code used a built-in interactive tool that fires
      // no Pre/PostToolUse hook of its own (initially `AskUserQuestion`).
      // The reducer's `InputRequest` arm (schema v25) folds this row by
      // flipping `jobs.state` to `'stopped'` AND stamping
      // `(last_input_request_at, last_input_request_kind)` to the event
      // ts + the matched kind in a single compound UPDATE
      // (re-fold-deterministic). Everything other than `session_id` /
      // `hook_event` / `event_type` / `data` is NULL — synthetics never
      // carry a process identity. The matched kind rides in `data.kind`
      // (read by the reducer's `extractInputRequestKind`). Mirrors the
      // `api-error` branch above structurally; the transcript matcher
      // arrives in task .2 of fn-617 — until then no `InputRequest`
      // event ever lands and this branch is unreachable in practice,
      // but landing the mint + the reducer arm together preserves the
      // re-fold determinism invariant (an event log emitted by a
      // future task .2 must fold the same way under a re-fold from
      // scratch on this code).
      stmts.insertEvent.run({
        $ts: Date.now() / 1000,
        $session_id: msg.sessionId,
        $pid: null,
        $hook_event: "InputRequest",
        $event_type: "input_request",
        $tool_name: null,
        $matcher: null,
        $cwd: null,
        $permission_mode: null,
        $agent_id: null,
        $agent_type: null,
        $stop_hook_active: null,
        $data: JSON.stringify({ kind: msg.requestKind }),
        $subagent_agent_id: null,
        $spawn_name: null,
        $start_time: null,
        $slash_command: null,
        $skill_name: null,
        $planctl_op: null,
        $planctl_target: null,
        $planctl_epic_id: null,
        $planctl_task_id: null,
        $planctl_subject_present: null,
        $config_dir: null,
        $planctl_queue_jump: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
      });
      wakePending = true;
      pumpWakes();
      return;
    }
  };

  // Same crash policy as the other workers: any thread failure → fatalExit.
  transcriptWorker.onerror = (err: ErrorEvent): void => {
    console.error("[keeperd] transcript worker error:", err.message ?? err);
    fatalExit();
  };

  // Same crash-via-`close` gap: a transcript-worker `process.exit(1)` fires
  // `close`, not `onerror`. `!shuttingDown` makes it inert on clean shutdown.
  transcriptWorker.addEventListener("close", () => {
    if (!shuttingDown) fatalExit();
  });

  // Spawn the plan worker in the SAME post-migration window. It watches each
  // configured project root's `.planctl/{epics,tasks}` trees and posts a
  // `plan-epic`/`plan-task` snapshot message on each change — the second
  // producer-worker instance. `roots` come from `resolvePlanRoots()` (config →
  // absolute, existing dirs); an empty list means there is nothing to watch.
  const planWorker = new Worker(
    new URL("./plan-worker.ts", import.meta.url).href,
    {
      workerData: {
        dbPath,
        roots: planRoots,
      } satisfies PlanWorkerData,
    } as WorkerOptions & { workerData: unknown },
  );

  // Main stays the SOLE writer: a `plan-epic`/`plan-task` snapshot message
  // becomes a synthetic `EpicSnapshot`/`TaskSnapshot` events row inserted on the
  // existing WRITABLE connection, then a wake pump folds it (snapshot upsert into
  // the `epics`/`tasks` projection). The entity id rides in `session_id` (the
  // generic entity-key overload the reducer reads); the full snapshot rides in
  // `data` (the same field `extractPlanSnapshot` parses) with the producer's
  // pre-computed fields mapped to the projection's column names. Mirrors the
  // `transcript-title` branch exactly; bindings are named (see `stmts.insertEvent`
  // in `src/db.ts`). Everything other than session_id/hook_event/event_type/data
  // is NULL (synthetic — never carries a process identity).
  planWorker.onmessage = (ev: MessageEvent<PlanMessage | undefined>): void => {
    const msg = ev.data;
    if (!msg) {
      return;
    }
    let hookEvent: string;
    let data: string;
    if (msg.kind === "plan-epic") {
      hookEvent = "EpicSnapshot";
      data = JSON.stringify({
        epic_number: msg.number,
        title: msg.title,
        project_dir: msg.projectDir,
        status: msg.status,
        approval: msg.approval,
        depends_on_epics: msg.dependsOnEpics,
        last_validated_at: msg.lastValidatedAt,
      });
    } else if (msg.kind === "plan-task") {
      hookEvent = "TaskSnapshot";
      data = JSON.stringify({
        epic_id: msg.epicId,
        task_number: msg.number,
        title: msg.title,
        target_repo: msg.targetRepo,
        // Renamed from the legacy `status` field. The producer surfaces the
        // derived worker-phase binary (`worker_done_at` present → "done", else
        // "open") under its new name to free up `runtime_status` (sibling
        // below) for planctl's native enum.
        worker_phase: msg.workerPhase,
        // Planctl-native runtime status (`todo|in_progress|done|blocked`)
        // ingested from `.planctl/state/tasks/<task_id>.state.json`. Threads
        // through the synthetic-event pipeline so a re-fold reproduces it.
        runtime_status: msg.runtimeStatus,
        approval: msg.approval,
        depends_on: msg.dependsOn,
      });
    } else if (msg.kind === "plan-epic-deleted") {
      // Tombstone: the reducer deletes the `epics` row (embedded tasks vanish
      // with it). No payload beyond the pk in session_id.
      hookEvent = "EpicDeleted";
      data = "";
    } else if (msg.kind === "plan-task-deleted") {
      // Tombstone: the reducer splices the element out of the parent epic's
      // embedded array. The parent key rides in the `data` blob (the deleted
      // file is gone, so the producer recovered it from the change-gate).
      hookEvent = "TaskDeleted";
      data = JSON.stringify({ epic_id: msg.epicId });
    } else {
      return;
    }
    stmts.insertEvent.run({
      $ts: Date.now() / 1000, // unix seconds as REAL, matching the hook
      $session_id: msg.id, // the entity pk: epic_id / task_id
      $pid: null,
      $hook_event: hookEvent, // synthetic; reducer folds into epics/tasks
      $event_type: "plan_snapshot",
      $tool_name: null,
      $matcher: null,
      $cwd: null,
      $permission_mode: null,
      $agent_id: null,
      $agent_type: null,
      $stop_hook_active: null,
      $data: data, // the full snapshot blob
      $subagent_agent_id: null,
      $spawn_name: null,
      $start_time: null,
      $slash_command: null,
      $skill_name: null,
      $planctl_op: null,
      $planctl_target: null,
      $planctl_epic_id: null,
      $planctl_task_id: null,
      $planctl_subject_present: null,
      $config_dir: null,
      $planctl_queue_jump: null,
      $bash_mutation_kind: null,
      $bash_mutation_targets: null,
    });
    // Our own INSERT bumps data_version, so the wake worker would re-drain
    // anyway — but pump directly so the snapshot folds without a poll-cycle delay.
    wakePending = true;
    pumpWakes();
  };

  // Same crash policy as the other workers: any thread failure → fatalExit.
  planWorker.onerror = (err: ErrorEvent): void => {
    console.error("[keeperd] plan worker error:", err.message ?? err);
    fatalExit();
  };

  // Same crash-via-`close` gap: a plan-worker `process.exit(1)` fires `close`,
  // not `onerror`. `!shuttingDown` makes it inert on clean shutdown.
  planWorker.addEventListener("close", () => {
    if (!shuttingDown) fatalExit();
  });

  // Spawn the exit-watcher worker in the SAME post-migration window. It owns
  // a kqueue (macOS) / pidfd+epoll (Linux) fd via `bun:ffi`, polls
  // `data_version` to keep its watch set in sync with the candidate jobs
  // rows, and posts `{ kind: "exit", ... }` whenever a tracked pid exits or
  // the post-register kill-0 probe finds it already dead. Spawns AFTER seed
  // sweep + re-drain (above) so its initial candidate-set diff reads a
  // settled projection, not a half-folded one.
  const exitWorker = new Worker(
    new URL("./exit-watcher.ts", import.meta.url).href,
    {
      workerData: { dbPath, pollMs: 50 } satisfies ExitWatcherWorkerData,
    } as WorkerOptions & { workerData: unknown },
  );

  // Main stays the SOLE writer: an `exit` message becomes a synthetic
  // `Killed` events row inserted on the existing WRITABLE connection, then a
  // wake pump folds it. The verifier here re-reads the persisted row and
  // matches `(pid, start_time)` against the message's snapshot — STRICT when
  // the row carries a stored start_time, LOOSE pid-only when the row has
  // none (legacy / pre-schema-v9). A strict-mismatch is a race-recovered
  // stale event (the row was re-opened with a fresh process between
  // register and exit delivery, OR the producer races a SessionStart on the
  // same row); we silently skip it. The reducer's Killed fold ALSO
  // double-checks the match — this verifier is a producer-side optimization
  // that keeps the event log tight (no Killed rows that the reducer would
  // discard as stale).
  exitWorker.onmessage = (ev: MessageEvent<ExitMessage | undefined>): void => {
    const msg = ev.data;
    if (!msg || msg.kind !== "exit") {
      return;
    }
    // Re-read the row to confirm the message's pid + start_time still match
    // what's persisted. A non-matching row means the session was re-opened
    // (and the new process is presumably alive) — skip silently.
    const row = db
      .query("SELECT pid, start_time, state FROM jobs WHERE job_id = ?")
      .get(msg.jobId) as {
      pid: number | null;
      start_time: string | null;
      state: string;
    } | null;
    if (row == null) {
      // Row vanished — nothing to fold against.
      return;
    }
    if (row.state === "ended" || row.state === "killed") {
      // Already terminal — the reducer's Killed terminal-guard would no-op
      // anyway, but skip the event log churn.
      return;
    }
    // Strict-match when both sides carry a start_time; loose pid-only match
    // when EITHER side is NULL (the row is legacy / the message snapshot
    // didn't carry one — Q7 loose-accept rule). A strict mismatch is the
    // race-recovered case.
    const pidMatches = row.pid != null && row.pid === msg.pid;
    if (!pidMatches) {
      return;
    }
    const startMatches =
      row.start_time == null ||
      msg.startTime == null ||
      row.start_time === msg.startTime;
    if (!startMatches) {
      // Strict mismatch — silently skip (the producer raced a re-open).
      return;
    }
    stmts.insertEvent.run({
      $ts: Date.now() / 1000, // unix seconds as REAL, matching the hook
      $session_id: msg.jobId, // == job_id
      $pid: null,
      $hook_event: "Killed", // synthetic; reducer folds → 'killed'
      $event_type: "killed",
      $tool_name: null,
      $matcher: null,
      $cwd: null,
      $permission_mode: null,
      $agent_id: null,
      $agent_type: null,
      $stop_hook_active: null,
      $data: JSON.stringify({ pid: msg.pid, start_time: msg.startTime }),
      $subagent_agent_id: null,
      $spawn_name: null,
      $start_time: null,
      $slash_command: null,
      $skill_name: null,
      $planctl_op: null,
      $planctl_target: null,
      $planctl_epic_id: null,
      $planctl_task_id: null,
      $planctl_subject_present: null,
      $config_dir: null,
      $planctl_queue_jump: null,
      $bash_mutation_kind: null,
      $bash_mutation_targets: null,
    });
    // Our own INSERT bumps data_version, so the wake worker would re-drain
    // anyway — but pump directly so the Killed fold lands without a poll-
    // cycle delay.
    wakePending = true;
    pumpWakes();
  };

  // Same crash policy as the other workers: any thread failure → fatalExit.
  exitWorker.onerror = (err: ErrorEvent): void => {
    console.error("[keeperd] exit-watcher worker error:", err.message ?? err);
    fatalExit();
  };

  // Same crash-via-`close` gap: an exit-watcher `process.exit(1)` fires
  // `close`, not `onerror`. `!shuttingDown` makes it inert on clean shutdown.
  exitWorker.addEventListener("close", () => {
    if (!shuttingDown) fatalExit();
  });

  // Spawn the git worker after the plan/job projections are caught up. It is
  // event-driven (file watcher + DB data_version wake + 60s heartbeat — see
  // `git-worker.ts` header) and posts a snapshot only when the rendered view
  // changes; main persists each one as a synthetic `GitSnapshot` event so the
  // reducer's `git_status` row is replayable.
  const gitWorker = new Worker(
    new URL("./git-worker.ts", import.meta.url).href,
    {
      workerData: { dbPath } satisfies GitWorkerData,
    } as WorkerOptions & { workerData: unknown },
  );

  gitWorker.onmessage = (
    ev: MessageEvent<GitWorkerMessage | undefined>,
  ): void => {
    const msg = ev.data;
    if (!msg) return;
    let hookEvent: string;
    let data: string;
    if (msg.kind === "git-snapshot") {
      hookEvent = "GitSnapshot";
      const { kind: _kind, ...snapshot } = msg;
      data = JSON.stringify(snapshot);
    } else if (msg.kind === "git-root-dropped") {
      // Tombstone: the reducer DELETEs the `git_status` row whose primary key
      // is `project_dir`. No payload beyond the pk in `session_id` — matches
      // the EpicDeleted / TaskDeleted shape so re-fold reproduces the deletion.
      hookEvent = "GitRootDropped";
      data = "";
    } else if (msg.kind === "commit") {
      // Per-commit attribution event. The reducer's `foldCommit` arm reads
      // the payload's `files` + `committer_session_id` and updates
      // `file_attributions.last_commit_at` — discharging the committing
      // session's claim on each file, or globally clearing every session's
      // claim when the trailer was absent / malformed.
      hookEvent = "Commit";
      const { kind: _kind, ...commit } = msg;
      data = JSON.stringify(commit);
    } else {
      return;
    }
    stmts.insertEvent.run({
      $ts: Date.now() / 1000,
      $session_id: msg.project_dir,
      $pid: null,
      $hook_event: hookEvent,
      $event_type: "git_snapshot",
      $tool_name: null,
      $matcher: null,
      $cwd: msg.project_dir,
      $permission_mode: null,
      $agent_id: null,
      $agent_type: null,
      $stop_hook_active: null,
      $data: data,
      $subagent_agent_id: null,
      $spawn_name: null,
      $start_time: null,
      $slash_command: null,
      $skill_name: null,
      $planctl_op: null,
      $planctl_target: null,
      $planctl_epic_id: null,
      $planctl_task_id: null,
      $planctl_subject_present: null,
      $config_dir: null,
      $planctl_queue_jump: null,
      $bash_mutation_kind: null,
      $bash_mutation_targets: null,
    });
    wakePending = true;
    pumpWakes();
  };

  gitWorker.onerror = (err: ErrorEvent): void => {
    console.error("[keeperd] git worker error:", err.message ?? err);
    fatalExit();
  };

  gitWorker.addEventListener("close", () => {
    if (!shuttingDown) fatalExit();
  });

  // Spawn the usage worker in the SAME post-migration window. It watches the
  // agentuse daemon's flat leaf state dir (`~/.local/state/agentuse/`) and
  // posts `{kind: "usage-snapshot" | "usage-deleted", ...}` messages — the
  // fifth file-watcher producer-worker instance. Main turns each into a
  // synthetic `UsageSnapshot`/`UsageDeleted` events row on its writable
  // connection. The watch root is resolved on main via `resolveUsageRoot()`
  // and tolerates absence (agentuse may not have run yet).
  const usageWorker = new Worker(
    new URL("./usage-worker.ts", import.meta.url).href,
    {
      workerData: {
        dbPath,
        root: resolveUsageRoot(),
      } satisfies UsageWorkerData,
    } as WorkerOptions & { workerData: unknown },
  );

  // Main stays the SOLE writer: a `usage-snapshot`/`usage-deleted` message
  // becomes a synthetic `UsageSnapshot`/`UsageDeleted` events row inserted on
  // the existing WRITABLE connection, then a wake pump folds it. The agentuse
  // profile id rides in `session_id` (the generic entity-key overload the
  // reducer reads); the flattened snapshot rides in `data` for snapshots, an
  // empty string for tombstones. Everything other than session_id / hook_event /
  // event_type / data is NULL (synthetic — never carries a process identity).
  usageWorker.onmessage = (
    ev: MessageEvent<UsageMessage | undefined>,
  ): void => {
    const msg = ev.data;
    if (!msg) return;
    let hookEvent: string;
    let data: string;
    if (msg.kind === "usage-snapshot") {
      hookEvent = "UsageSnapshot";
      // Pre-flattened payload — the reducer never re-reads the on-disk file.
      // Object-literal slot order is documentation only here (reducer is
      // shape-tolerant); the load-bearing slot order lives in the worker's
      // change-gate via `buildUsageMessage`.
      data = JSON.stringify({
        target: msg.target,
        multiplier: msg.multiplier,
        session_percent: msg.session_percent,
        session_resets_at: msg.session_resets_at,
        week_percent: msg.week_percent,
        week_resets_at: msg.week_resets_at,
        sonnet_week_percent: msg.sonnet_week_percent,
        sonnet_week_resets_at: msg.sonnet_week_resets_at,
      });
    } else if (msg.kind === "usage-deleted") {
      // Tombstone: the reducer DELETEs the `usage` row whose primary key is
      // `id`. No payload beyond the pk in `session_id` — matches the
      // GitRootDropped / EpicDeleted shape so re-fold reproduces the deletion.
      hookEvent = "UsageDeleted";
      data = "";
    } else {
      return;
    }
    stmts.insertEvent.run({
      $ts: Date.now() / 1000,
      $session_id: msg.id, // the entity pk: agentuse profile id
      $pid: null,
      $hook_event: hookEvent,
      $event_type: "usage_snapshot",
      $tool_name: null,
      $matcher: null,
      $cwd: null,
      $permission_mode: null,
      $agent_id: null,
      $agent_type: null,
      $stop_hook_active: null,
      $data: data,
      $subagent_agent_id: null,
      $spawn_name: null,
      $start_time: null,
      $slash_command: null,
      $skill_name: null,
      $planctl_op: null,
      $planctl_target: null,
      $planctl_epic_id: null,
      $planctl_task_id: null,
      $planctl_subject_present: null,
      $config_dir: null,
      $planctl_queue_jump: null,
      $bash_mutation_kind: null,
      $bash_mutation_targets: null,
    });
    wakePending = true;
    pumpWakes();
  };

  usageWorker.onerror = (err: ErrorEvent): void => {
    console.error("[keeperd] usage worker error:", err.message ?? err);
    fatalExit();
  };

  usageWorker.addEventListener("close", () => {
    if (!shuttingDown) fatalExit();
  });

  /** Crash exit. Reserved for unrecoverable errors so launchd restarts us. */
  function fatalExit(): void {
    try {
      db.close();
    } catch {
      // best-effort; we're crashing either way
    }
    process.exit(1);
  }

  // Unrecoverable async errors that escape every guard also take the single
  // recovery path. (A fold throw inside drain bubbles here if it ever escapes
  // the reducer's per-event handling.)
  process.on("unhandledRejection", (reason) => {
    console.error("[keeperd] unhandled rejection:", reason);
    fatalExit();
  });
  process.on("uncaughtException", (err) => {
    console.error("[keeperd] uncaught exception:", err);
    fatalExit();
  });

  // Step 5 — clean shutdown. The ONLY path that exits 0; under
  // KeepAlive.SuccessfulExit = false a clean exit tells launchd NOT to restart.
  async function shutdown(): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    worker.postMessage({ type: "shutdown" } satisfies ShutdownMessage);
    serverWorker.postMessage({ type: "shutdown" } satisfies ShutdownMessage);
    transcriptWorker.postMessage({
      type: "shutdown",
    } satisfies ShutdownMessage);
    planWorker.postMessage({ type: "shutdown" } satisfies ShutdownMessage);
    exitWorker.postMessage({ type: "shutdown" } satisfies ShutdownMessage);
    gitWorker.postMessage({ type: "shutdown" } satisfies ShutdownMessage);
    usageWorker.postMessage({ type: "shutdown" } satisfies ShutdownMessage);

    // Bun surfaces worker exit via the "close" event. Await ALL SEVEN
    // workers' close (the server worker releases its socket + lock, the
    // transcript + plan + usage workers unsubscribe their watchers, and the
    // exit-watcher releases its kqueue/pidfd fd in their own shutdown
    // handlers — that teardown must land, or the socket / native watches /
    // kernel fd leak into the next boot), raced against a single shared
    // deadline so a wedged worker can't block our clean shutdown forever.
    const exited = (w: Worker): Promise<void> =>
      new Promise<void>((resolve) => {
        w.addEventListener("close", () => resolve());
      });
    await Promise.race([
      Promise.all([
        exited(worker),
        exited(serverWorker),
        exited(transcriptWorker),
        exited(planWorker),
        exited(exitWorker),
        exited(gitWorker),
        exited(usageWorker),
      ]),
      Bun.sleep(WORKER_SHUTDOWN_DEADLINE_MS),
    ]);

    try {
      worker.terminate();
    } catch {
      // best-effort if it already exited
    }
    try {
      serverWorker.terminate();
    } catch {
      // best-effort if it already exited
    }
    try {
      transcriptWorker.terminate();
    } catch {
      // best-effort if it already exited
    }
    try {
      planWorker.terminate();
    } catch {
      // best-effort if it already exited
    }
    try {
      exitWorker.terminate();
    } catch {
      // best-effort if it already exited
    }
    try {
      gitWorker.terminate();
    } catch {
      // best-effort if it already exited
    }
    try {
      usageWorker.terminate();
    } catch {
      // best-effort if it already exited
    }

    try {
      db.close();
    } catch {
      // best-effort
    }

    process.exit(0);
  }

  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
}

// Only boot the daemon when this file is the process entry point. A plain
// `import` (e.g. a test driving `drainToCompletion` against a tmp DB) must NOT
// spawn the worker or install signal handlers. Mirrors wake-worker's
// `isMainThread` guard.
if (import.meta.main) {
  runDaemon();
}
