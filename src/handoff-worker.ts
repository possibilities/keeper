/**
 * The `keeper handoff` DISPATCH worker — the process-manager reactor half of the
 * fire-and-forget handoff feature (the enqueue half is `cli/handoff.ts` →
 * `request_handoff` RPC → the `handoffs` projection). It runs the level-triggered
 * dispatch loop server-side: a `data_version` pulse wakes a cycle, each cycle
 * selects actionable `handoffs` rows and launches a fresh handoff-ee worker into
 * the INITIATOR's tmux session via keeper agent (keeper's sole launch transport),
 * borrowing the autopilot's mint-before-launch protocol (capture the events
 * watermark, mint a durable `HandoffDispatching` marker, AWAIT the ack, THEN
 * launch). The fold is the pure decider; this worker is the only thing that
 * reads wall-clock / probes liveness / spawns — a fold that spawns is a re-fold
 * time-bomb.
 *
 * **Boot-recovery is the headline risk.** Unlike the boot-truncated
 * `pending_dispatches`, the `handoffs` projection SURVIVES a daemon restart, so
 * a crash between the `HandoffDispatching` ack and the launch leaves a phantom
 * `dispatching` row. The `claimed_at` lease + the level-triggered bind check
 * ("does a `handoff::<id>` SessionStart exist?") is the ONLY thing preventing
 * BOTH a stuck row AND a double-dispatch. Each cycle, before dispatching:
 *   - `bound` / terminal (`failed`) → skip.
 *   - a row with a live bind (a `handoff::<id>` SessionStart exists) → skip.
 *   - `requested` (never dispatched) → dispatch.
 *   - `dispatching` with a STALE lease (claimed_at older than the TTL) and NO
 *     bind → re-dispatch. A FRESH `dispatching` row is left alone (its launch
 *     is still in flight); lease expiry NEVER un-registers an already-bound
 *     worker (the bind check runs first).
 *
 * **Never-bound breaker.** Each `HandoffDispatching` bumps the row's
 * `never_bound_count` (fold-side, from the event); K=3 consecutive dispatches
 * without an intervening bind flips the row to sticky `failed` (mirrors the
 * autopilot's `NEVER_BOUND_EXPIRE_THRESHOLD`). A permanent launch failure
 * (keeper agent exit 1/2/3, a thrown launch) takes a DIFFERENT path: it mints a
 * terminal `HandoffLaunchFailed` event + a dead-letter immediately.
 *
 * Worker contract: `isMainThread`-guarded body (a plain import is inert + the
 * pure deciders are exported, drivable with no Worker or spawn); own read-only
 * `openDb` (`prepareStmts:false`); typed `{ kind }` worker→main /
 * `{ type }` main→worker messages; the worker NEVER writes keeper.db — every
 * mutation round-trips through main as a synthetic event. ALL wall-clock / TTL
 * comparisons live HERE (the producer); `claimed_at` is event-ts-derived so the
 * fold stays byte-identical on re-fold.
 */

import type { Database } from "bun:sqlite";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { parseTriple } from "./agent/triple";
import { openDb } from "./db";
import { resolveDispatchLaunchConfig } from "./dispatch-launch-config";
import {
  keeperAgentLaunch,
  type LaunchResult,
  type LaunchSpec,
} from "./exec-backend";
import { watchLoop } from "./wake-worker";

/**
 * Default poll cadence for the `data_version` wake loop (ms). The dispatch
 * decision is cheap; the loop just rides the same pulse the rest of the daemon
 * already emits. Overridable via workerData (tests).
 */
const DEFAULT_POLL_MS = 1000;

/**
 * The `claimed_at` lease window (ms). A `dispatching` row whose `claimed_at` is
 * OLDER than this AND that has no bind is re-dispatchable — the prior launch is
 * presumed lost (a crash between the ack and a successful bind). Set generously
 * above the launch+boot round-trip (keeper agent mint + `claude` cold start +
 * SessionStart fold) so a merely-slow boot is NEVER re-dispatched while it is
 * still coming up; the bind check is the authoritative "already up" gate, the
 * lease is only the floor for "presumed lost". Unit: MILLISECONDS — `claimed_at`
 * is unix-SECONDS (an event ts), so the comparison converts.
 */
export const HANDOFF_LEASE_TTL_MS = 180_000;

/**
 * Durable-ack wait ceiling for the `HandoffDispatching` mint (ms). The worker
 * AWAITS main's durable insert before launching; if the ack never lands in this
 * window (or shutdown races it) the dispatch aborts WITHOUT launching — strictly
 * preferable to a fire-and-forget that could double-launch. Mirrors the
 * autopilot's `DISPATCHED_ACK_TIMEOUT_MS`.
 */
export const HANDOFF_DISPATCHING_ACK_TIMEOUT_MS = 10_000;

/**
 * Never-bound circuit-breaker threshold: K CONSECUTIVE `HandoffDispatching`
 * events for one handoff WITHOUT an intervening bind flips the row to sticky
 * `failed`. A successful bind resets the counter (fold-side). Mirrors the
 * autopilot's `NEVER_BOUND_EXPIRE_THRESHOLD`. The fold owns the flip; this
 * constant is exported so the worker's decision table (and tests) agree on K.
 */
export const NEVER_BOUND_HANDOFF_THRESHOLD = 3;

/**
 * One `handoffs` row's dispatch-relevant fields, as the worker reads them off
 * its read-only connection. `claimed_at` is unix-seconds (an event ts) or null;
 * `bound` is the level-triggered bind result (a `handoff::<id>` SessionStart
 * exists) the worker probes per-cycle, NOT a persisted column.
 */
export interface HandoffDispatchRow {
  handoff_id: string;
  status: string;
  doc: string;
  target_session: string | null;
  /** Resolved ABSOLUTE launch directory, or null/empty → keeperd's cwd. The
   *  per-row launch cwd (`dispatchOneHandoff` coalesces it against the global). */
  target_dir: string | null;
  /** Unix-seconds the dispatcher stamped on its last `HandoffDispatching`. */
  claimed_at: number | null;
  never_bound_count: number;
  /** Capture contract requested by the handoff caller (SQLite INTEGER boolean). */
  capture: number;
  /** Direct launch-config overrides (both present together when validated). */
  model: string | null;
  effort: string | null;
  /** Serialized `harness::model::effort` launch triple request. */
  preset: string | null;
  /** Durable result-envelope path the handoff-ee alone writes when capturing. */
  envelope_path: string | null;
}

/** The action the decision table picks for one handoff row. */
export type HandoffAction =
  /** Mint a fresh `HandoffDispatching` + launch (a never-dispatched row). */
  | { kind: "dispatch"; handoff_id: string }
  /** Re-mint + re-launch (a stale, unbound `dispatching` row). */
  | { kind: "redispatch"; handoff_id: string }
  /** Leave it alone (bound, terminal, or a fresh in-flight dispatch). */
  | { kind: "skip"; handoff_id: string; reason: string };

/**
 * Pure boot-recovery decision for ONE handoff row at a fixed `nowMs` (unix
 * MILLISECONDS) given whether it is currently bound (a `handoff::<id>`
 * SessionStart exists). The single source of truth for the dispatch lifecycle —
 * drivable with synthetic rows + an injected clock, NO real spawn. NEVER throws.
 *
 * Order is load-bearing: the bind check fires FIRST so a lease-expired-but-bound
 * worker is never re-dispatched (lease expiry must not un-register a live
 * handoff-ee). Terminal `failed` and an unknown status are inert.
 */
export function decideHandoffAction(
  row: HandoffDispatchRow,
  bound: boolean,
  nowMs: number,
): HandoffAction {
  const { handoff_id } = row;
  // A live bind wins over everything — already up, nothing to do. This MUST
  // precede the lease check so a stale `dispatching` row that has since bound is
  // not re-dispatched.
  if (bound) {
    return { kind: "skip", handoff_id, reason: "bound" };
  }
  // Sticky terminal: the never-bound breaker tripped or a launch permanently
  // failed. Never re-dispatched (cleared only by a fresh enqueue, a new row).
  if (row.status === "failed" || row.status === "bound") {
    return { kind: "skip", handoff_id, reason: row.status };
  }
  if (row.status === "requested") {
    return { kind: "dispatch", handoff_id };
  }
  if (row.status === "dispatching") {
    // A dispatching row with no bind: re-dispatch ONLY once the lease has
    // expired (the prior launch is presumed lost). A FRESH dispatching row is
    // still booting — leave it alone.
    if (row.claimed_at == null) {
      // Defensive: a dispatching row should always carry claimed_at (the fold
      // stamps it). A missing stamp is treated as expired so the row can't wedge.
      return { kind: "redispatch", handoff_id };
    }
    const ageMs = nowMs - row.claimed_at * 1000;
    if (ageMs >= HANDOFF_LEASE_TTL_MS) {
      return { kind: "redispatch", handoff_id };
    }
    return { kind: "skip", handoff_id, reason: "dispatching-fresh" };
  }
  // Unknown status — inert (defense-in-depth; the fold owns the status vocab).
  return { kind: "skip", handoff_id, reason: `unknown-status:${row.status}` };
}

/**
 * The `HandoffDispatching` mint payload the worker hands to main. `claimed_at`
 * is stamped from the event ts ON MAIN (never here) so re-fold stays
 * byte-identical — the worker only names the handoff. Carried in `events.data`.
 */
export interface HandoffDispatchingPayload {
  handoff_id: string;
}

/** Durable-ack reply shape for {@link HandoffDispatchDeps.emitDispatching}. */
export interface HandoffDispatchingAck {
  /** True once main's `HandoffDispatching` INSERT is durable. */
  ok: boolean;
}

/**
 * The permanent-launch-failure payload: mints a terminal `HandoffLaunchFailed`
 * event (flips the row to `failed`) AND a dead-letter on main. `reason` is the
 * surfaced launch error. Distinct from the never-bound breaker (which trips
 * fold-side off `never_bound_count`).
 */
export interface HandoffLaunchFailedPayload {
  handoff_id: string;
  reason: string;
}

/**
 * Injected side-effect seam for {@link dispatchOneHandoff} — pure-with-deps so a
 * test drives the whole dispatch path (mint, launch, fail) with NO real spawn or
 * clock. Mirrors the autopilot's `ConfirmRunningDeps` shape.
 */
export interface HandoffDispatchDeps {
  /** Mint the durable `HandoffDispatching` marker and AWAIT the insert ack. */
  emitDispatching(
    payload: HandoffDispatchingPayload,
  ): Promise<HandoffDispatchingAck>;
  /** Launch the handoff-ee into `session` via keeper agent. */
  launch(session: string, cwd: string, spec: LaunchSpec): Promise<LaunchResult>;
  /** Mint a terminal `HandoffLaunchFailed` event + a dead-letter (permanent). */
  emitLaunchFailed(payload: HandoffLaunchFailedPayload): void;
  /** Compose the launch-only `/hack ` prefix with the raw stored Brief. */
  buildPrompt(doc: string): string;
  /** Resolve the `dispatch.handoff` launch pin (ADR 0040). Returns `{}` when the
   *  row is absent — handoff carries NO compiled default, so an absent row yields a
   *  flagless launch (byte-identical to the prior behavior); a present row makes
   *  handoff pinnable. Production: {@link resolveDispatchLaunchConfig}("handoff"). */
  resolveDispatchConfig(): {
    harness?: string;
    model?: string;
    effort?: string;
  };
}

/** Outcome of {@link dispatchOneHandoff}, for the cycle log + tests. */
export type HandoffDispatchOutcome =
  | "launched"
  | "aborted-prelaunch"
  | "aborted-shutdown"
  | "failed"
  | "invalid-target";

/**
 * Dispatch ONE handoff: mint the durable `HandoffDispatching` marker
 * (outbox-ordered intent), AWAIT the ack, then launch into `target_session`.
 * The mint-before-launch ordering is the whole double-dispatch guard — a crash
 * after the ack but before the launch leaves a `dispatching` row the lease +
 * bind check recovers; a crash before the ack leaves a `requested` row the next
 * cycle re-dispatches. NEVER throws. Pure-with-injected-deps.
 *
 * `target_session` is validated before any side effect (gated-roots spirit): a
 * NULL/empty session can't be launched into and is a permanent failure (the
 * enqueue always resolves a session, so this is defense-in-depth). A thrown /
 * permanent launch failure mints `HandoffLaunchFailed`; a transient one is left
 * for the lease to re-dispatch (the `dispatching` row already landed).
 */
export async function dispatchOneHandoff(
  row: HandoffDispatchRow,
  cwd: string,
  signal: AbortSignal,
  deps: HandoffDispatchDeps,
): Promise<HandoffDispatchOutcome> {
  const session = row.target_session;
  if (session == null || session.length === 0) {
    // No session to launch into — permanent. The enqueue resolves a session, so
    // a null here is a corrupt row; fail it terminally rather than spin.
    deps.emitLaunchFailed({
      handoff_id: row.handoff_id,
      reason: "handoff has no target_session to launch into",
    });
    return "invalid-target";
  }
  if (signal.aborted) {
    return "aborted-shutdown";
  }
  // Mint the durable marker BEFORE the launch and AWAIT the ack. An ack reject
  // (timeout / shutdown) or `{ok:false}` (insert failed) aborts WITHOUT
  // launching — no `dispatching` row landed (or it will be swept), so the next
  // cycle re-dispatches the still-`requested` row. This closes the
  // double-dispatch window the same way the autopilot's `confirmRunning` does.
  let ack: HandoffDispatchingAck;
  try {
    ack = await deps.emitDispatching({ handoff_id: row.handoff_id });
  } catch {
    return "aborted-prelaunch";
  }
  if (!ack.ok) {
    return "aborted-prelaunch";
  }
  if (signal.aborted) {
    return "aborted-shutdown";
  }
  // Launch — ONLY after the durable `HandoffDispatching` ack. keeper agent owns the
  // tmux window; the prompt carries the raw Brief inline, with no inspection
  // round-trip.
  // Handoff becomes pinnable (ADR 0040): a present `dispatch.handoff` row adds
  // --model/--effort to the spec; an absent row resolves to `{}` and the launch
  // stays flagless (the prior default — LaunchSpec omits the flags when undefined).
  const handoffLaunch = resolveHandoffLaunchConfig(
    row,
    deps.resolveDispatchConfig(),
  );
  const capture = Boolean(row.capture);
  const spec: LaunchSpec = {
    prompt: deps.buildPrompt(row.doc),
    claudeName: `handoff::${row.handoff_id}`,
    ...(handoffLaunch.harness !== undefined
      ? { harness: handoffLaunch.harness }
      : {}),
    ...(handoffLaunch.preset !== undefined
      ? { preset: handoffLaunch.preset }
      : {}),
    ...(handoffLaunch.model !== undefined
      ? { model: handoffLaunch.model }
      : {}),
    ...(handoffLaunch.effort !== undefined
      ? { effort: handoffLaunch.effort }
      : {}),
    ...(capture && row.envelope_path != null && row.envelope_path !== ""
      ? { handoffEnvelope: row.envelope_path }
      : {}),
  };
  // PER-ROW launch cwd: the handoff's resolved `--cwd` (an absolute path the CLI
  // validated) wins; a NULL/empty value coalesces to the worker-global `cwd`
  // (`data.cwd ?? process.cwd()` = keeperd's cwd) BEFORE the spawn — exec-backend
  // treats `""` as undefined and would otherwise drop to keeperd's cwd anyway,
  // but coalescing here keeps the intent explicit.
  const launchCwd =
    row.target_dir != null && row.target_dir.length > 0 ? row.target_dir : cwd;
  const result = await deps.launch(session, launchCwd, spec).catch(
    (err): LaunchResult => ({
      ok: false,
      error: `launch threw: ${err instanceof Error ? err.message : String(err)}`,
    }),
  );
  if (result.ok === false) {
    if (result.retryable === true) {
      // TRANSIENT launch fail (keeper agent exit 4 / timeout-kill). Leave the
      // `dispatching` row in place — the lease re-dispatches it, and the
      // never-bound breaker bounds the retries before going sticky. NO terminal
      // mint here (that would write off a recoverable launch).
      return "failed";
    }
    // PERMANENT launch fail — a sticky terminal `HandoffLaunchFailed` + a
    // dead-letter. The reducer flips the row to `failed`; only a fresh enqueue
    // re-opens it.
    deps.emitLaunchFailed({
      handoff_id: row.handoff_id,
      reason: result.error,
    });
    return "failed";
  }
  return "launched";
}

/** Compose a fresh Handoff prompt without interpreting or normalizing its Brief. */
export function buildHandoffPrompt(doc: string): string {
  return `/hack ${doc}`;
}

/**
 * Resolve the handoff launch triple without trusting its read-only projection:
 * a valid row triple wins over the dispatch-table pin, direct model/effort wins
 * when both are present, and malformed/partial row values safely fall through.
 * Pure and NEVER throws so a corrupt row cannot crash the dispatch cycle.
 */
export function resolveHandoffLaunchConfig(
  row: Pick<HandoffDispatchRow, "preset" | "model" | "effort">,
  dispatchConfig: { harness?: string; model?: string; effort?: string },
): { harness?: string; preset?: string; model?: string; effort?: string } {
  if (row.preset != null && row.preset !== "") {
    const parsed = parseTriple(row.preset);
    if (parsed.ok) {
      return {
        harness: parsed.triple.harness,
        preset: row.preset,
      };
    }
  }
  if (
    row.model != null &&
    row.model !== "" &&
    row.effort != null &&
    row.effort !== ""
  ) {
    return {
      ...dispatchConfig,
      model: row.model,
      effort: row.effort,
    };
  }
  return { ...dispatchConfig };
}

/**
 * Read the dispatch-relevant `handoffs` rows that are NOT terminal — `requested`
 * or `dispatching`. (`bound` / `failed` rows are inert; the decision table skips
 * them anyway, but filtering here keeps the per-cycle scan small.) ORDER BY
 * `handoff_id` for a stable, deterministic dispatch order. Read-only.
 */
export function selectActionableHandoffs(db: Database): HandoffDispatchRow[] {
  return db
    .query(
      `SELECT handoff_id, status, doc, target_session, target_dir, claimed_at, never_bound_count,
              capture, model, effort, preset, envelope_path
         FROM handoffs
        WHERE status IN ('requested', 'dispatching')
        ORDER BY handoff_id ASC`,
    )
    .all() as HandoffDispatchRow[];
}

/**
 * The level-triggered bind check: does a `handoff::<id>` SessionStart exist? The
 * authoritative "the handoff-ee is up" signal — the BIND EVENT, not the tmux
 * window (a window can outlive its process). After the SessionStart bind fold
 * runs, the `handoffs` row's `callee_job_id` is non-null, so a single column
 * read answers it. Read-only; pure over the persisted projection.
 */
export function isHandoffBound(db: Database, handoffId: string): boolean {
  const row = db
    .query("SELECT callee_job_id FROM handoffs WHERE handoff_id = ?")
    .get(handoffId) as { callee_job_id: string | null } | undefined;
  return row?.callee_job_id != null && row.callee_job_id.length > 0;
}

/** workerData payload. */
export interface HandoffWorkerData {
  dbPath: string;
  /** The launcher argv prefix (`[bun, cli/keeper.ts, "agent"]`), resolved on main. */
  launcherArgvPrefix?: readonly string[];
  /** The repo cwd the handoff-ee launches in. Resolved on main (keeperd's cwd). */
  cwd?: string;
  /** Poll cadence for the data_version wake loop (ms). Tests override. */
  pollMs?: number;
}

/** worker→main: mint a durable `HandoffDispatching` + reply an ack. */
export interface HandoffDispatchingMessage {
  kind: "handoff-dispatching-request";
  /** Correlation id echoed on {@link HandoffDispatchingAckMessage}. */
  id: number;
  payload: HandoffDispatchingPayload;
}

/** main→worker: the durable-insert ack for a `handoff-dispatching-request`. */
export interface HandoffDispatchingAckMessage {
  type: "handoff-dispatching-ack";
  id: number;
  ok: boolean;
}

/** worker→main: mint a terminal `HandoffLaunchFailed` + a dead-letter. */
export interface HandoffLaunchFailedMessage {
  kind: "handoff-launch-failed";
  payload: HandoffLaunchFailedPayload;
}

/** main→worker shutdown signal. */
export interface HandoffShutdownMessage {
  type: "shutdown";
}

/** Outbound worker→main message union. */
export type HandoffOutboundMessage =
  | HandoffDispatchingMessage
  | HandoffLaunchFailedMessage;

/** Inbound main→worker message union. */
export type HandoffIncomingMessage =
  | HandoffDispatchingAckMessage
  | HandoffShutdownMessage;

function main(): void {
  if (!parentPort) {
    console.error("[handoff-worker] no parentPort — not running as a Worker");
    process.exit(1);
  }
  const data = workerData as HandoffWorkerData | undefined;
  if (!data || typeof data.dbPath !== "string") {
    console.error("[handoff-worker] missing dbPath in workerData");
    process.exit(1);
  }

  const { db } = openDb(data.dbPath, {
    readonly: true,
    prepareStmts: false,
    bootRetry: true,
  });
  const port = parentPort;
  const launcherArgvPrefix = data.launcherArgvPrefix ?? [];
  // keeperd's cwd is NOT a worker repo, but keeper agent reads its own
  // `process.cwd()` for the launch-script `cd`; a handoff-ee carries no plan ref,
  // so the launch dir is just "somewhere valid". Default to keeperd's cwd.
  const cwd = data.cwd ?? process.cwd();

  const shutdownController = new AbortController();
  let shutdown = false;

  // Durable `handoff-dispatching-ack` correlation: `emitDispatching` posts a
  // request keyed by a monotonic id and parks a resolver; main replies with the
  // matching id. The Promise also races the ack timeout + the shutdown signal —
  // both REJECT so `dispatchOneHandoff` aborts WITHOUT launching.
  let nextAckId = 1;
  const pendingAcks = new Map<
    number,
    {
      resolve: (ack: HandoffDispatchingAck) => void;
      reject: (err: Error) => void;
    }
  >();

  port.on("message", (msg: HandoffIncomingMessage | undefined) => {
    if (!msg) return;
    if (msg.type === "shutdown") {
      shutdown = true;
      shutdownController.abort();
      // Reject every parked ack so an in-flight dispatch resolves promptly
      // (as `aborted-prelaunch`) instead of hanging until its timeout.
      for (const [id, pending] of pendingAcks) {
        pendingAcks.delete(id);
        pending.reject(new Error("handoff worker shutting down"));
      }
      return;
    }
    if (msg.type === "handoff-dispatching-ack") {
      const pending = pendingAcks.get(msg.id);
      if (pending) {
        pendingAcks.delete(msg.id);
        pending.resolve({ ok: msg.ok });
      }
      return;
    }
  });

  const closeDb = (): void => {
    try {
      db.close();
    } catch {
      // best-effort; exiting either way
    }
  };

  const noteLine = (line: string): void => {
    console.error(line);
  };

  const deps: HandoffDispatchDeps = {
    emitDispatching: (payload) =>
      new Promise<HandoffDispatchingAck>((resolve, reject) => {
        if (shutdownController.signal.aborted) {
          reject(new Error("handoff worker shutting down"));
          return;
        }
        const id = nextAckId++;
        const timer = setTimeout(() => {
          if (pendingAcks.delete(id)) {
            reject(
              new Error(
                `handoff-dispatching-ack timeout after ${HANDOFF_DISPATCHING_ACK_TIMEOUT_MS}ms (handoff=${payload.handoff_id})`,
              ),
            );
          }
        }, HANDOFF_DISPATCHING_ACK_TIMEOUT_MS);
        pendingAcks.set(id, {
          resolve: (ack) => {
            clearTimeout(timer);
            resolve(ack);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
        port.postMessage({
          kind: "handoff-dispatching-request",
          id,
          payload,
        } satisfies HandoffDispatchingMessage);
      }),
    launch: (session, launchCwd, spec) =>
      keeperAgentLaunch({
        noteLine,
        launcherArgvPrefix,
        session,
        cwd: launchCwd,
        label: spec.claudeName ?? "handoff",
        spec,
      }),
    emitLaunchFailed: (payload) => {
      port.postMessage({
        kind: "handoff-launch-failed",
        payload,
      } satisfies HandoffLaunchFailedMessage);
    },
    buildPrompt: buildHandoffPrompt,
    resolveDispatchConfig: () => resolveDispatchLaunchConfig("handoff"),
  };

  // Single-flight cycle drive — coalesce a wake burst into one trailing re-run.
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
        if (shutdown) {
          return;
        }
        let rows: HandoffDispatchRow[];
        try {
          rows = selectActionableHandoffs(db);
        } catch (err) {
          console.error(
            "[handoff-worker] select threw (non-fatal):",
            err instanceof Error ? err.message : String(err),
          );
          break;
        }
        const nowMs = Date.now();
        for (const row of rows) {
          if (shutdown) {
            return;
          }
          const bound = isHandoffBound(db, row.handoff_id);
          const action = decideHandoffAction(row, bound, nowMs);
          if (action.kind === "skip") {
            continue;
          }
          // dispatch / redispatch are identical at the launch seam — both mint a
          // fresh `HandoffDispatching` (the fold bumps never_bound_count and the
          // breaker trips at K=3). Failures are funnelled to `HandoffLaunchFailed`
          // inside `dispatchOneHandoff`; this is just the per-row backstop.
          try {
            await dispatchOneHandoff(row, cwd, shutdownController.signal, deps);
          } catch (err) {
            console.error(
              `[handoff-worker] dispatch threw for ${row.handoff_id} (non-fatal):`,
              err instanceof Error ? err.message : String(err),
            );
          }
        }
      } while (wakePending && !shutdown);
    } catch (err) {
      console.error("[handoff-worker] cycle threw (non-fatal):", err);
    } finally {
      cycleRunning = false;
    }
  };

  // Kick one boot cycle (recover any phantom `dispatching` rows that survived a
  // restart) then ride the data_version pulse.
  void driveCycle();

  watchLoop(
    db,
    () => {
      void driveCycle();
    },
    () => shutdown,
    data.pollMs ?? DEFAULT_POLL_MS,
  )
    .then(() => {
      closeDb();
      process.exit(0);
    })
    .catch((err) => {
      console.error("[handoff-worker] watch loop crashed:", err);
      closeDb();
      process.exit(1);
    });
}

// Only run inside a real Worker; a plain import on the main thread (tests driving
// the pure deciders) is inert.
if (!isMainThread) {
  main();
}
