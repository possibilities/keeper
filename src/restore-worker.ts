/**
 * Restore-snapshot worker (epic fn-677 task .3). keeperd's TENTH Bun Worker
 * thread, joining the producer / consumer fleet (`wake-worker`, `server-worker`,
 * `transcript-worker`, `plan-worker`, `exit-watcher`, `git-worker`,
 * `usage-worker`, `dead-letter-worker`, `autopilot-worker`, `backend-worker`).
 *
 * On every `PRAGMA data_version` change (the same change-detection primitive
 * the wake worker and autopilot worker use), the worker reads the `jobs` +
 * `epics` projections off its own read-only connection via the shared
 * {@link runQuery} server-worker read seam, builds a pure
 * {@link buildRestoreDescriptor} snapshot of the live jobs grouped by zellij
 * `backend_exec_session_id`, stable-serializes it (sorted keys, ASCII-escaped
 * — same shape `serializePlanctlJson` produces), hashes the serialized bytes,
 * and rewrites `~/.local/state/keeper/restore.json` via `atomicWriteFile` ONLY
 * when the hash differs from the in-memory `lastHash`.
 *
 * The restore file is a derived side-file, NOT an event-log projection: it
 * sidesteps the event-sourcing invariants entirely (no schema bump, no
 * `keeper/api.py` whitelist change, no reducer arm). The worker is a PURE
 * CONSUMER — it never posts to main, never writes the DB, and never feeds the
 * event log. The `scripts/restore-agents.ts` util (T4) is the sole reader.
 *
 * Worker contract (see CLAUDE.md "Worker contract"):
 *  - `isMainThread` guard — a plain import is inert.
 *  - Own read-only `openDb` connection — `applyPragmas` runs inside `openDb`
 *    so `busy_timeout` is set on this connection too.
 *  - Typed message protocol: nothing worker→main (the worker carries no
 *    message kind — it has nothing to post), `{type:"shutdown"}` main→worker.
 *    Exit 0 clean / 1 crash.
 *  - Subsystem-style teardown: the read-only DB connection is closed in the
 *    shutdown handler before `process.exit(0)`.
 *
 * Write failure policy: any throw from `atomicWriteFile` (full disk, ENOTDIR
 * on the parent, EACCES on a parent the user removed) is SWALLOWED to stderr
 * and the worker keeps running. The restore file is purely informational; the
 * next data_version pulse will rewrite it. We do NOT fatalExit on a write
 * error — that would crash the daemon over a side-file concern, which violates
 * the "single recovery path" invariant for a non-critical surface.
 *
 * Hash stability: `captured_at` is INCLUDED in the serialized output (so the
 * restore-agents util can show a wall-clock timestamp) but EXCLUDED from the
 * hashed shape — otherwise every tick would churn the file. Same trick the
 * autopilot's snapshot does with its own informational timestamps.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import {
  atomicWriteFile,
  openDb,
  resolveRestorePath,
  serializePlanctlJson,
  sortObjectKeys,
} from "./db";
import { resumeTarget, tierForJobFromEpics } from "./resume-descriptor";
import { runQuery } from "./server-worker";
import type { Epic, Job } from "./types";
import { watchLoop } from "./wake-worker";

/**
 * Data the parent passes via `new Worker(url, { workerData })`. Only the DB
 * path crosses the boundary — the read-only connection is opened on the
 * worker thread, not handed across (handles are thread-affine).
 */
export interface RestoreWorkerData {
  dbPath: string;
  /**
   * Poll cadence in ms for the underlying `data_version` watch. Optional;
   * defaults to {@link watchLoop}'s default. Threaded through workerData
   * for parity with the other consumer workers.
   */
  pollMs?: number;
}

/** Message the parent sends to ask the worker to stop. */
export interface ShutdownMessage {
  type: "shutdown";
}

/**
 * Schema version of the restore-snapshot side-file. INDEPENDENT of the DB
 * `events`/projections schema version — see the epic spec's "Best practices"
 * block: a top-level `schema_version` on the side-file itself lets the
 * restore-agents util refuse to act on a future-version file rather than
 * trust garbage. Bump only when the on-disk descriptor shape changes in a
 * way restore-agents must adapt to.
 */
export const RESTORE_SCHEMA_VERSION = 1;

/**
 * Per-agent record under a session bucket. One per live (`working` / `stopped`)
 * job that carries a non-NULL `backend_exec_session_id`. The fields are the
 * exact substrate the `scripts/restore-agents.ts` util needs to rebuild the
 * `claude --resume` command via `buildResumeCommand`:
 *
 *  - `job_id` — the Claude session id, also the dedup key against live jobs at
 *    restore time.
 *  - `cwd` — directory to `cd` into before `claude --resume`; `null` when the
 *    SessionStart event never carried one.
 *  - `resume_target` — pre-resolved via {@link resumeTarget} (the latest
 *    session name, falling back to job_id). Pre-resolved at producer time so
 *    the restore-agents util doesn't have to know the rule.
 *  - `tier` — pre-resolved via {@link tierForJobFromEpics} against the
 *    epicsById map built once per pulse. `null` for non-work jobs or jobs
 *    whose epic isn't in the projection.
 *  - `plan_verb` / `plan_ref` — informational (the restore-agents util surfaces
 *    these in the dry-run label); ride straight off the jobs row.
 */
export interface RestoreAgent {
  job_id: string;
  cwd: string | null;
  resume_target: string;
  tier: string | null;
  plan_verb: string | null;
  plan_ref: string | null;
}

/**
 * One session bucket in the restore descriptor. Agents are sorted by
 * `job_id` for stable serialization (so the hash gate doesn't false-positive
 * on a row-order shuffle from the underlying SELECT).
 */
export interface RestoreSession {
  agents: RestoreAgent[];
}

/**
 * The full on-disk descriptor. `captured_at` is INCLUDED in the serialized
 * file (informational — the util surfaces it in the dry-run header) but
 * EXCLUDED from the hashed shape (or every tick would churn the file). The
 * `sessions` field is an object keyed by zellij session name; alpha key
 * sort happens at serialize time via `sortObjectKeys`.
 */
export interface RestoreDescriptor {
  schema_version: number;
  captured_at: number;
  sessions: Record<string, RestoreSession>;
}

/**
 * Build the restore descriptor from the projection rows. PURE — no I/O, no
 * Date.now() (the `capturedAt` value is threaded in by the caller), no env
 * reads. Exported for unit reach: the tests drive this directly off a
 * seeded writer DB.
 *
 * Filtering:
 *  - Only `working` and `stopped` jobs survive — the same "live" cutoff
 *    `scripts/resume.ts` uses (and the broader set the restore-agents util
 *    deduplicates against).
 *  - Jobs whose `backend_exec_session_id` is NULL are OMITTED entirely.
 *    They aren't restorable into a backend session (nowhere to drop the
 *    `claude --resume` tab), and a sentinel bucket would muddle the
 *    descriptor for no consumer benefit.
 *  - `job_id` empty / unset jobs are dropped defensively (the producer
 *    invariant says this never happens, but a malformed row is folded to
 *    a safe value per CLAUDE.md's reducer policy — we mirror that here).
 *
 * Grouping: by `backend_exec_session_id`. Each bucket's `agents` array is
 * sorted ASCENDING by `job_id` so the serialized output is byte-stable
 * across SELECTs that may return rows in different order.
 *
 * Pre-resolution: `tierForJobFromEpics` runs once per agent against the
 * provided `epicsById` map, so the restore-agents util doesn't need to
 * re-fetch epics to rebuild the resume command — the tier rides the file.
 */
export function buildRestoreDescriptor(
  jobs: Job[],
  epicsById: Map<string, Epic>,
  capturedAt: number,
): RestoreDescriptor {
  const sessions: Record<string, RestoreSession> = {};
  for (const job of jobs) {
    if (job.state !== "working" && job.state !== "stopped") {
      continue;
    }
    if (job.backend_exec_session_id == null) {
      continue;
    }
    if (typeof job.job_id !== "string" || job.job_id === "") {
      continue;
    }
    const sessionId = job.backend_exec_session_id;
    const tier = tierForJobFromEpics(job, epicsById);
    const agent: RestoreAgent = {
      job_id: job.job_id,
      cwd: job.cwd,
      resume_target: resumeTarget(job),
      tier,
      plan_verb: job.plan_verb,
      plan_ref: job.plan_ref,
    };
    let bucket = sessions[sessionId];
    if (!bucket) {
      bucket = { agents: [] };
      sessions[sessionId] = bucket;
    }
    bucket.agents.push(agent);
  }
  for (const bucket of Object.values(sessions)) {
    bucket.agents.sort((a, b) =>
      a.job_id < b.job_id ? -1 : a.job_id > b.job_id ? 1 : 0,
    );
  }
  return {
    schema_version: RESTORE_SCHEMA_VERSION,
    captured_at: capturedAt,
    sessions,
  };
}

/**
 * Stable-serialize the descriptor for HASHING. Strips `captured_at` so the
 * informational timestamp doesn't churn the hash on every pulse, then runs
 * the same `sortObjectKeys` → `JSON.stringify(_, null, 2)` → ASCII-escape →
 * trailing-`\n` pipeline `serializePlanctlJson` uses for `.planctl` files.
 * Exported for unit reach (the tests drive the "did content change" gate
 * directly).
 *
 * The disk write itself goes through `serializeForWrite` (with the timestamp
 * intact); only the hash input strips it.
 */
export function serializeForHash(descriptor: RestoreDescriptor): string {
  const { captured_at: _capturedAt, ...rest } = descriptor;
  return serializePlanctlJson(rest);
}

/**
 * Stable-serialize the descriptor for DISK. Same pipeline as
 * {@link serializeForHash} but keeps `captured_at` so a human (or the
 * restore-agents util) can see when the snapshot was last written. The
 * `sortObjectKeys` pass in `serializePlanctlJson` alpha-sorts every nested
 * object's keys, including the `sessions` map's session-name keys, so the
 * output is byte-stable across SELECT order shuffles.
 */
export function serializeForWrite(descriptor: RestoreDescriptor): string {
  // Run the descriptor through sortObjectKeys explicitly so the test suite
  // can compare against the exact byte sequence the writer emits.
  // `serializePlanctlJson` does the same sort internally; the redundant call
  // is a no-op (sortObjectKeys is idempotent on already-sorted input).
  return serializePlanctlJson(sortObjectKeys(descriptor));
}

/** One restore pulse — read projections, build descriptor, gate, write. */
interface PulseState {
  lastHash: string | null;
  parentDirEnsured: boolean;
}

/**
 * Drive one restore pulse against the worker's read-only connection. PURE-ish
 * in the same shape as `loadReconcileSnapshot`: reads the projections via
 * the `read(collection)` helper (identical frame shape to the autopilot
 * worker's), builds the descriptor, hashes, writes on change.
 *
 * Exported for unit reach: tests drive this directly against a seeded writer
 * DB (re-opened read-only for the pulse).
 */
export function restorePulse(
  db: Parameters<typeof runQuery>[0],
  restorePath: string,
  state: PulseState,
  now: () => number = () => Date.now() / 1000,
): void {
  const read = (collection: string): Record<string, unknown>[] => {
    const frame = {
      type: "query" as const,
      collection,
      id: `restore-${collection}`,
      limit: 0,
    };
    const res = runQuery(db, 0, frame);
    return res.type === "result" ? (res.rows as Record<string, unknown>[]) : [];
  };

  const jobs = read("jobs") as unknown as Job[];
  const epics = read("epics") as unknown as Epic[];
  const epicsById = new Map<string, Epic>();
  for (const epic of epics) {
    epicsById.set(epic.epic_id, epic);
  }

  const descriptor = buildRestoreDescriptor(jobs, epicsById, now());
  const hashed = serializeForHash(descriptor);
  // `Bun.hash` returns a number — fine for an in-memory dedup key (we never
  // compare across daemon boots). Stringify so the equality check is by
  // value, not by Number coercion edge cases.
  const hash = String(Bun.hash(hashed));
  if (state.lastHash === hash) {
    return;
  }

  const serialized = serializeForWrite(descriptor);
  if (!state.parentDirEnsured) {
    try {
      mkdirSync(dirname(restorePath), { recursive: true });
      state.parentDirEnsured = true;
    } catch (err) {
      // mkdir is best-effort; the atomicWriteFile below will surface the
      // real failure (ENOENT/EACCES) if the dir really doesn't exist.
      console.error(
        `[restore-worker] mkdir parent dir failed (continuing): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  try {
    atomicWriteFile(restorePath, serialized);
    state.lastHash = hash;
  } catch (err) {
    // Per design contract: write failure is SWALLOWED to stderr. The next
    // data_version pulse re-runs this; lastHash stays unchanged so we
    // retry the write rather than silently skipping it forever.
    console.error(
      `[restore-worker] write failed (will retry next pulse): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Worker entrypoint. Opens its own read-only connection, wires the shutdown
 * message, runs an initial pulse to seed the file, then drives the watch
 * loop until told to stop.
 */
function main(): void {
  if (!parentPort) {
    console.error("[restore-worker] no parentPort — not running as a Worker");
    process.exit(1);
  }

  const data = workerData as RestoreWorkerData | undefined;
  if (!data || typeof data.dbPath !== "string") {
    console.error("[restore-worker] missing dbPath in workerData");
    process.exit(1);
  }

  const { db } = openDb(data.dbPath, { readonly: true });
  const restorePath = resolveRestorePath();
  const state: PulseState = { lastHash: null, parentDirEnsured: false };
  let shutdown = false;

  parentPort.on("message", (msg: ShutdownMessage | undefined) => {
    if (msg && msg.type === "shutdown") {
      shutdown = true;
    }
  });

  const closeDb = (): void => {
    try {
      db.close();
    } catch {
      // best-effort; we're exiting either way
    }
  };

  // Initial pulse before the watch loop's first sleep so a freshly-spawned
  // worker writes a settled `restore.json` immediately rather than after
  // the first data_version change. Mirrors the backend-worker's "one
  // immediate tick" pattern.
  try {
    restorePulse(db, restorePath, state);
  } catch (err) {
    // Defense-in-depth: restorePulse's internal try/catch already swallows
    // write errors, but a projection-read throw would escape here. Log +
    // continue — the next pulse re-tries.
    console.error(
      `[restore-worker] initial pulse threw (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  watchLoop(
    db,
    () => {
      try {
        restorePulse(db, restorePath, state);
      } catch (err) {
        // Same defense-in-depth as the initial pulse.
        console.error(
          `[restore-worker] pulse threw (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
    () => shutdown,
    data.pollMs,
  )
    .then(() => {
      closeDb();
      process.exit(0);
    })
    .catch((err) => {
      console.error("[restore-worker] watch loop crashed:", err);
      closeDb();
      process.exit(1);
    });
}

// Only run inside a real Worker; a plain import on the main thread (tests
// driving the pure descriptor builder / pulse) is inert.
if (!isMainThread) {
  main();
}
