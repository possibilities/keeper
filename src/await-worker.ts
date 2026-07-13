/**
 * Durable-await reactor. The worker owns condition probing and launch I/O, but
 * never writes keeper.db: every lifecycle transition round-trips through main
 * as a synthetic event so the awaits projection remains re-foldable.
 */

import type { Database } from "bun:sqlite";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import {
  type AwaitState,
  agentsIdleState,
  type DrainedHolder,
  type DrainedJob,
  drainedState,
  evaluateAwaitCondition,
  gitCleanState,
  landedState,
  type NeedsHumanSignal,
  needsHumanState,
} from "./await-conditions";
import { openDb } from "./db";
import {
  keeperAgentLaunch,
  type LaunchResult,
  type LaunchSpec,
} from "./exec-backend";
import { projectNeedsHuman } from "./needs-human";
import {
  DURABLE_AWAIT_CONDITION_KINDS,
  type DurableAwaitCondition,
} from "./protocol";
import { computeReadiness } from "./readiness";
import { computeLandedEpicIds } from "./readiness-client";
import { loadReadinessInputs } from "./readiness-inputs";
import type { GitStatus } from "./types";
import { watchLoop } from "./wake-worker";

const DEFAULT_POLL_MS = 1_000;
export const AWAIT_LEASE_TTL_MS = 180_000;
export const AWAIT_FIRING_ACK_TIMEOUT_MS = 10_000;
export const NEVER_BOUND_AWAIT_THRESHOLD = 3;

/** One await row as read from the worker's independent read-only connection. */
export interface AwaitDispatchRow {
  await_id: string;
  condition_spec: string;
  follow_up: string;
  target_session: string | null;
  target_dir: string | null;
  timeout_at: number | null;
  status: string;
  claimed_at: number | null;
  attempt_count: number;
  never_bound_count: number;
}

export type AwaitAction =
  | { kind: "fire" | "refire"; await_id: string }
  | { kind: "done"; await_id: string }
  | { kind: "timed_out"; await_id: string }
  | { kind: "failed"; await_id: string; reason: string }
  | { kind: "skip"; await_id: string; reason: string };

/**
 * Pure lifecycle decision. Waiting is intentionally not leased: only a met
 * condition claims a row into firing, so an intentionally long wait cannot
 * expire. The firing lease is reclaimed after a daemon crash between durable
 * intent and launch acknowledgement.
 */
export function decideAwaitAction(
  row: AwaitDispatchRow,
  condition: "met" | "waiting" | "unknown",
  nowMs: number,
  bound = false,
): AwaitAction {
  if (["done", "failed", "timed_out", "cancelled"].includes(row.status)) {
    return { kind: "skip", await_id: row.await_id, reason: row.status };
  }
  if (row.status === "waiting") {
    if (row.timeout_at !== null && nowMs >= row.timeout_at * 1000) {
      return { kind: "timed_out", await_id: row.await_id };
    }
    if (condition === "unknown") {
      return {
        kind: "failed",
        await_id: row.await_id,
        reason: "unknown durable await condition",
      };
    }
    if (
      condition === "met" &&
      row.never_bound_count >= NEVER_BOUND_AWAIT_THRESHOLD - 1
    ) {
      return {
        kind: "failed",
        await_id: row.await_id,
        reason: "await never bound after dispatch attempts",
      };
    }
    return condition === "met"
      ? { kind: "fire", await_id: row.await_id }
      : { kind: "skip", await_id: row.await_id, reason: "condition-waiting" };
  }
  if (row.status === "firing") {
    // A SessionStart carrying the stable `await::<id>` name is authoritative
    // proof the effect happened. Complete it instead of treating an old lease
    // as lost and opening another fresh session.
    if (bound) {
      return { kind: "done", await_id: row.await_id };
    }
    // The fold stamps this sticky state at the same K-attempt threshold. Keep
    // the producer defensive as well: a malformed/replayed row at the breaker
    // limit must terminalize, never spin another launch.
    if (row.never_bound_count >= NEVER_BOUND_AWAIT_THRESHOLD) {
      return {
        kind: "failed",
        await_id: row.await_id,
        reason: "durable await never-bound breaker tripped",
      };
    }
    if (
      row.claimed_at === null ||
      nowMs - row.claimed_at * 1000 >= AWAIT_LEASE_TTL_MS
    ) {
      if (row.never_bound_count >= NEVER_BOUND_AWAIT_THRESHOLD - 1) {
        return {
          kind: "failed",
          await_id: row.await_id,
          reason: "await never bound after dispatch attempts",
        };
      }
      return { kind: "refire", await_id: row.await_id };
    }
    return { kind: "skip", await_id: row.await_id, reason: "firing-fresh" };
  }
  return {
    kind: "failed",
    await_id: row.await_id,
    reason: `unknown await status: ${row.status}`,
  };
}

export function selectActionableAwaits(db: Database): AwaitDispatchRow[] {
  return db
    .query(
      `SELECT await_id, condition_spec, follow_up, target_session, target_dir,
              timeout_at, status, claimed_at, attempt_count, never_bound_count
         FROM awaits
        WHERE status IN ('waiting', 'firing')
        ORDER BY await_id ASC`,
    )
    .all() as AwaitDispatchRow[];
}

/**
 * The fresh worker's SessionStart stamps its launch name in `jobs.name_history`.
 * This is the durable bind check for an await effect: it lets a restarted
 * worker observe a successful launch before its terminal marker folds, rather
 * than relying on a stale firing lease. Malformed histories are ignored.
 */
export function isAwaitBound(db: Database, awaitId: string): boolean {
  const expected = `await::${awaitId}`;
  const rows = db
    .query("SELECT name_history FROM jobs WHERE name_history LIKE ?")
    .all(`%"${expected}"%`) as Array<{ name_history: string | null }>;
  return rows.some((row) => {
    try {
      const names = JSON.parse(row.name_history ?? "[]");
      return Array.isArray(names) && names.includes(expected);
    } catch {
      return false;
    }
  });
}

export interface AwaitFiringPayload {
  await_id: string;
}
export interface AwaitTerminalPayload {
  await_id: string;
  reason?: string;
}
export interface AwaitDispatchDeps {
  emitFiring(payload: AwaitFiringPayload): Promise<{ ok: boolean }>;
  emitTerminal(
    kind: "done" | "failed" | "timed_out",
    payload: AwaitTerminalPayload,
  ): void;
  launch(session: string, cwd: string, spec: LaunchSpec): Promise<LaunchResult>;
}
export type AwaitDispatchOutcome =
  | "launched"
  | "aborted-prelaunch"
  | "aborted-shutdown"
  | "failed"
  | "invalid-target";

/**
 * Durable intent before effect. `await_id` is the stable effect identity in the
 * launcher name; a lease-reclaim redelivery therefore names the same follow-up,
 * rather than creating a semantically distinct session.
 */
export async function dispatchOneAwait(
  row: AwaitDispatchRow,
  cwd: string,
  signal: AbortSignal,
  deps: AwaitDispatchDeps,
): Promise<AwaitDispatchOutcome> {
  if (row.target_session === null || row.target_session.length === 0) {
    deps.emitTerminal("failed", {
      await_id: row.await_id,
      reason: "await has no target_session to launch into",
    });
    return "invalid-target";
  }
  if (signal.aborted) return "aborted-shutdown";

  try {
    const ack = await deps.emitFiring({ await_id: row.await_id });
    if (!ack.ok) return "aborted-prelaunch";
  } catch {
    return "aborted-prelaunch";
  }
  if (signal.aborted) return "aborted-shutdown";

  const spec: LaunchSpec = {
    prompt: row.follow_up,
    claudeName: `await::${row.await_id}`,
  };
  const launchCwd =
    row.target_dir !== null && row.target_dir.length > 0 ? row.target_dir : cwd;
  const result = await deps.launch(row.target_session, launchCwd, spec).catch(
    (err): LaunchResult => ({
      ok: false,
      error: `launch threw: ${err instanceof Error ? err.message : String(err)}`,
    }),
  );
  if (!result.ok) {
    if (!result.retryable) {
      deps.emitTerminal("failed", {
        await_id: row.await_id,
        reason: result.error,
      });
    }
    return "failed";
  }
  deps.emitTerminal("done", { await_id: row.await_id });
  return "launched";
}

function stateKind(state: AwaitState): "met" | "waiting" {
  return state.kind === "met" ? "met" : "waiting";
}

function isKnownCondition(
  kind: unknown,
): kind is DurableAwaitCondition["condition"] {
  return (
    typeof kind === "string" &&
    (DURABLE_AWAIT_CONDITION_KINDS as readonly string[]).includes(kind)
  );
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Evaluate the complete server-evaluable condition vocabulary from one DB snapshot. */
export function evaluateDurableAwaitConditions(
  db: Database,
  raw: string,
): "met" | "waiting" | "unknown" {
  let spec: unknown;
  try {
    spec = JSON.parse(raw);
  } catch {
    return "unknown";
  }
  if (!Array.isArray(spec) || spec.length === 0) return "unknown";

  const inputs = loadReadinessInputs(db);
  if (inputs.readinessDegraded) return "waiting";
  const readiness = computeReadiness(
    inputs.epics,
    inputs.jobs,
    inputs.subagentInvocations,
    inputs.gitStatusByProjectDir,
    Number.NEGATIVE_INFINITY,
    inputs.pendingDispatches,
    undefined,
    inputs.unseededRoots,
    inputs.maxConcurrentPerRoot,
  );
  const autopilot = db
    .query("SELECT paused, worktree_mode FROM autopilot_state WHERE id = 1")
    .get() as { paused?: number; worktree_mode?: number } | undefined;
  const gitRows = db.query("SELECT * FROM git_status").all() as GitStatus[];
  const dispatchFailures = db
    .query("SELECT verb, id, reason, dir FROM dispatch_failures")
    .all() as Array<Record<string, unknown>>;
  const deadLetters = db.query("SELECT 1 FROM dead_letters").all().length;
  const blockEscalations = db
    .query("SELECT 1 FROM block_escalations")
    .all().length;
  const needsHuman = projectNeedsHuman({
    dispatchFailures,
    deadLetters,
    blockEscalations,
    parkedQuestionEpicIds: inputs.epics
      .filter((epic) => epic.question !== null)
      .map((epic) => epic.epic_id),
    epicIds: inputs.epics.map((epic) => epic.epic_id),
  });
  const landed = computeLandedEpicIds(
    autopilot?.worktree_mode === 1,
    (
      db.query("SELECT epic_id FROM lane_merged").all() as Array<{
        epic_id: string;
      }>
    ).map((row) => row.epic_id),
    inputs.epics,
  );
  const runningJobs: DrainedJob[] = [...inputs.jobs.values()]
    .filter(
      (job) =>
        inputs.harnessActivityByJobId.get(job.job_id)?.status !== "quiescent",
    )
    .map((job) => ({
      jobId: job.job_id,
      dispatchOrigin: job.dispatch_origin,
      label: job.title ?? job.job_id,
    }));
  const pendingDispatches: DrainedHolder[] = inputs.pendingDispatches.map(
    (pending) => ({
      kind: "pending",
      id: `${pending.verb}::${pending.id}`,
      label: `${pending.verb}::${pending.id}`,
    }),
  );

  for (const segment of spec) {
    if (
      segment === null ||
      typeof segment !== "object" ||
      Array.isArray(segment)
    ) {
      return "unknown";
    }
    const condition = segment as DurableAwaitCondition;
    if (!isKnownCondition(condition.condition)) return "unknown";
    const target = asNonEmptyString(condition.target);
    let state: AwaitState;
    switch (condition.condition) {
      case "complete":
      case "unblocked":
      case "started":
        if (target === null) return "unknown";
        state = evaluateAwaitCondition(
          {
            epics: inputs.epics,
            snapshot: readiness,
            priorPresence: true,
            reQueryHit: true,
            escalatedTaskIds: new Set<string>(),
            autopilotPaused: autopilot?.paused === 1,
          },
          {
            id: target,
            kind: /\.\d+$/.test(target) ? "task" : "epic",
            condition: condition.condition,
          },
        );
        break;
      case "git-clean":
        if (target !== null) return "unknown";
        {
          const root = asNonEmptyString(condition.git_root);
          if (root === null) return "unknown";
          state = gitCleanState(root, gitRows);
        }
        break;
      case "agents-idle": {
        const root = asNonEmptyString(condition.git_root);
        if (root === null) return "unknown";
        state = agentsIdleState(
          root,
          null,
          inputs.jobs.values(),
          inputs.harnessActivityByJobId,
        );
        break;
      }
      case "drained": {
        const scope = condition.scope;
        if (
          scope !== undefined &&
          scope !== "plan" &&
          scope !== "inflight" &&
          scope !== "board"
        ) {
          return "unknown";
        }
        state = drainedState({
          scope: scope ?? "plan",
          perTask: readiness.perTask,
          perCloseRow: readiness.perCloseRow,
          openEpicCount: inputs.epics.filter((epic) => epic.status !== "done")
            .length,
          pendingDispatches,
          runningJobs,
          ownSessionId: null,
          catchingUp: false,
          dispatchFailureReasons: dispatchFailures.map((row) =>
            String(row.reason ?? ""),
          ),
        });
        break;
      }
      case "landed":
        if (target === null) return "unknown";
        state = landedState(target, landed);
        break;
      default: {
        const since = condition.since;
        if (since !== undefined && typeof since !== "string") return "unknown";
        state = needsHumanState(
          condition.condition as NeedsHumanSignal,
          needsHuman,
          {
            dispatchFoldOpened: true,
            ...(typeof since === "string" ? { since } : {}),
          },
        );
      }
    }
    if (stateKind(state) !== "met") return "waiting";
  }
  return "met";
}

export interface AwaitWorkerData {
  dbPath: string;
  launcherArgvPrefix?: readonly string[];
  cwd?: string;
  pollMs?: number;
}
export type AwaitOutboundMessage =
  | { kind: "await-firing-request"; id: number; payload: AwaitFiringPayload }
  | {
      kind: "await-terminal";
      terminal: "done" | "failed" | "timed_out";
      payload: AwaitTerminalPayload;
    };
export type AwaitIncomingMessage =
  | { type: "await-firing-ack"; id: number; ok: boolean }
  | { type: "shutdown" };

function main(): void {
  if (!parentPort) {
    console.error("[await-worker] no parentPort — not running as a Worker");
    process.exit(1);
  }
  const data = workerData as AwaitWorkerData | undefined;
  if (!data || typeof data.dbPath !== "string") {
    console.error("[await-worker] missing dbPath in workerData");
    process.exit(1);
  }
  const { db } = openDb(data.dbPath, {
    readonly: true,
    prepareStmts: false,
    bootRetry: true,
  });
  const port = parentPort;
  const shutdownController = new AbortController();
  let shutdown = false;
  let nextAckId = 1;
  const pendingAcks = new Map<
    number,
    { resolve: (ack: { ok: boolean }) => void; reject: (error: Error) => void }
  >();

  port.on("message", (message: AwaitIncomingMessage | undefined) => {
    if (!message) return;
    if (message.type === "shutdown") {
      shutdown = true;
      shutdownController.abort();
      for (const [id, pending] of pendingAcks) {
        pendingAcks.delete(id);
        pending.reject(new Error("await worker shutting down"));
      }
      return;
    }
    if (message.type === "await-firing-ack") {
      const pending = pendingAcks.get(message.id);
      if (pending) {
        pendingAcks.delete(message.id);
        pending.resolve({ ok: message.ok });
      }
    }
  });

  const deps: AwaitDispatchDeps = {
    emitFiring: (payload) =>
      new Promise<{ ok: boolean }>((resolve, reject) => {
        if (shutdownController.signal.aborted) {
          reject(new Error("await worker shutting down"));
          return;
        }
        const id = nextAckId++;
        const timer = setTimeout(() => {
          if (pendingAcks.delete(id)) {
            reject(new Error("await firing acknowledgement timed out"));
          }
        }, AWAIT_FIRING_ACK_TIMEOUT_MS);
        pendingAcks.set(id, {
          resolve: (ack) => {
            clearTimeout(timer);
            resolve(ack);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        port.postMessage({
          kind: "await-firing-request",
          id,
          payload,
        } satisfies AwaitOutboundMessage);
      }),
    emitTerminal: (terminal, payload) => {
      port.postMessage({
        kind: "await-terminal",
        terminal,
        payload,
      } satisfies AwaitOutboundMessage);
    },
    launch: (session, cwd, spec) =>
      keeperAgentLaunch({
        noteLine: (line) => console.error(line),
        launcherArgvPrefix: data.launcherArgvPrefix ?? [],
        session,
        cwd,
        label: spec.claudeName ?? "await",
        spec,
      }),
  };

  let cycleRunning = false;
  let wakePending = false;
  const driveCycle = async (): Promise<void> => {
    if (cycleRunning) {
      wakePending = true;
      return;
    }
    cycleRunning = true;
    try {
      do {
        wakePending = false;
        if (shutdown) return;
        for (const row of selectActionableAwaits(db)) {
          if (shutdown) return;
          const condition =
            row.status === "waiting"
              ? evaluateDurableAwaitConditions(db, row.condition_spec)
              : "waiting";
          const action = decideAwaitAction(
            row,
            condition,
            Date.now(),
            row.status === "firing" && isAwaitBound(db, row.await_id),
          );
          if (action.kind === "done") {
            deps.emitTerminal("done", { await_id: row.await_id });
          } else if (action.kind === "timed_out") {
            deps.emitTerminal("timed_out", { await_id: row.await_id });
          } else if (action.kind === "failed") {
            deps.emitTerminal("failed", {
              await_id: row.await_id,
              reason: action.reason,
            });
          } else if (action.kind === "fire" || action.kind === "refire") {
            await dispatchOneAwait(
              row,
              data.cwd ?? process.cwd(),
              shutdownController.signal,
              deps,
            );
          }
        }
      } while (wakePending && !shutdown);
    } catch (error) {
      console.error("[await-worker] cycle threw (non-fatal):", error);
    } finally {
      cycleRunning = false;
    }
  };

  void driveCycle();
  watchLoop(
    db,
    () => void driveCycle(),
    () => shutdown,
    data.pollMs ?? DEFAULT_POLL_MS,
  )
    .then(() => {
      try {
        db.close();
      } catch {
        // best effort while exiting
      }
      process.exit(0);
    })
    .catch((error) => {
      console.error("[await-worker] watch loop crashed:", error);
      try {
        db.close();
      } catch {
        // best effort while exiting
      }
      process.exit(1);
    });
}

if (!isMainThread) {
  main();
}
