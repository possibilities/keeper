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
 *   3. Spawn FOUR worker threads (all AFTER migrate + boot drain, so their
 *      read-only `openDb` connections never race a missing/un-migrated DB):
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
 *   4. Steady state: every wake triggers a full drain loop. Wakes that arrive
 *      mid-drain coalesce into the next pass via a single "wake pending" flag —
 *      no event is missed (drain always re-reads from the cursor) and drain is
 *      never invoked re-entrantly. A `transcript-title` message inserts the
 *      synthetic event then pumps a wake to fold it.
 *   5. SIGTERM: post `{ type: "shutdown" }` to ALL FOUR workers, await their
 *      `close` events against a short deadline, terminate them, close the db,
 *      exit 0. This is the ONLY clean exit. The server worker releases its
 *      socket + lock and the transcript + plan workers unsubscribe their
 *      watchers inside their own shutdown handlers (those resources are
 *      process/thread-owned, so `terminate()` alone would leak them).
 *
 * Crash policy (single recovery path): ANY unrecoverable error — either worker's
 * `error` event, an unhandled rejection, or a fold throw that escapes the
 * per-event guard — calls `process.exit(1)`. The LaunchAgent
 * `KeepAlive.SuccessfulExit = false` then restarts us. We deliberately keep ONE
 * well-tested recovery path rather than attempting in-process self-heal — no
 * in-process respawn of either worker.
 */

import type { Database } from "bun:sqlite";
import { openDb, resolveDbPath, resolvePlanRoots } from "./db";
import type { PlanMessage, PlanWorkerData } from "./plan-worker";
import { DEFAULT_BATCH_SIZE, drain } from "./reducer";
import type { ServerWorkerData } from "./server-worker";
import type {
  TranscriptTitleMessage,
  TranscriptWorkerData,
} from "./transcript-worker";
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

  // Step 2 — boot drain. MUST finish before the worker spawns: otherwise the
  // worker would fire wakes against a writer connection still iterating boot
  // drain (harmless, drain is idempotent, but wasteful).
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
  // the external transcript tree (`~/.claude/projects`) and posts a
  // `transcript-title` message whenever it tails a `custom-title` line — making
  // the daemon an event PRODUCER for the first time. `dbPath` is the only
  // required field; `watchRoot` defaults to `~/.claude/projects` worker-side
  // (overridden by the e2e test to a hermetic tmp dir).
  const transcriptWorker = new Worker(
    new URL("./transcript-worker.ts", import.meta.url).href,
    {
      workerData: {
        dbPath,
        ...(process.env.KEEPER_WATCH_ROOT
          ? { watchRoot: process.env.KEEPER_WATCH_ROOT }
          : {}),
      } satisfies TranscriptWorkerData,
    } as WorkerOptions & { workerData: unknown },
  );

  // Main stays the SOLE writer: a worker `transcript-title` message becomes a
  // synthetic `TranscriptTitle` events row inserted on the existing WRITABLE
  // connection, then a wake pump folds it (priority-3 'transcript' title). The
  // insert is synchronous on the main thread and so cannot interleave with the
  // synchronous drain inside pumpWakes. Column order matches `stmts.insertEvent`:
  // ts, session_id, pid, hook_event, event_type, tool_name, matcher, cwd,
  // permission_mode, agent_id, agent_type, stop_hook_active, data,
  // subagent_agent_id, spawn_name. The title rides in `data.session_title` (the
  // same field the reducer's title rule reads); everything else is NULL.
  transcriptWorker.onmessage = (
    ev: MessageEvent<TranscriptTitleMessage | undefined>,
  ): void => {
    const msg = ev.data;
    if (!msg || msg.kind !== "transcript-title") {
      return;
    }
    stmts.insertEvent.run(
      Date.now() / 1000, // ts (unix seconds as REAL, matching the hook)
      msg.sessionId, // session_id (== job_id)
      null, // pid
      "TranscriptTitle", // hook_event (synthetic; reducer maps → 'transcript')
      "transcript_title", // event_type
      null, // tool_name
      null, // matcher
      null, // cwd
      null, // permission_mode
      null, // agent_id
      null, // agent_type
      null, // stop_hook_active
      JSON.stringify({ session_title: msg.title }), // data
      null, // subagent_agent_id
      null, // spawn_name
    );
    // Our own INSERT bumps data_version, so the wake worker would re-drain
    // anyway — but pump directly so the title folds without a poll-cycle delay.
    wakePending = true;
    pumpWakes();
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
        roots: resolvePlanRoots(),
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
  // `transcript-title` branch exactly; column order matches `stmts.insertEvent`:
  // ts, session_id, pid, hook_event, event_type, tool_name, matcher, cwd,
  // permission_mode, agent_id, agent_type, stop_hook_active, data,
  // subagent_agent_id, spawn_name. Everything other than session_id/hook_event/
  // event_type/data is NULL.
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
      });
    } else if (msg.kind === "plan-task") {
      hookEvent = "TaskSnapshot";
      data = JSON.stringify({
        epic_id: msg.epicId,
        task_number: msg.number,
        title: msg.title,
        target_repo: msg.targetRepo,
        status: msg.status,
      });
    } else {
      return;
    }
    stmts.insertEvent.run(
      Date.now() / 1000, // ts (unix seconds as REAL, matching the hook)
      msg.id, // session_id (the entity pk: epic_id / task_id)
      null, // pid
      hookEvent, // hook_event (synthetic; reducer folds into epics/tasks)
      "plan_snapshot", // event_type
      null, // tool_name
      null, // matcher
      null, // cwd
      null, // permission_mode
      null, // agent_id
      null, // agent_type
      null, // stop_hook_active
      data, // data (the full snapshot blob)
      null, // subagent_agent_id
      null, // spawn_name
    );
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

    // Bun surfaces worker exit via the "close" event. Await ALL FOUR workers'
    // close (the server worker releases its socket + lock and the transcript +
    // plan workers unsubscribe their watchers in their own shutdown handlers —
    // that teardown must land, or the socket / native watches leak into the next
    // boot), raced against a single shared deadline so a wedged worker can't
    // block our clean shutdown forever.
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
