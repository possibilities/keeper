/**
 * Server worker. Runs as keeperd's read-surface Worker thread: a UDS listener
 * speaking the NDJSON protocol from `src/protocol.ts`, its OWN read-only DB
 * connection, and the `<state-dir>/keeperd.sock.lock` pid-file ownership lock
 * (distinct from main's `keeperd.lock` single-instance flock).
 *
 * Three beats layer over the one-shot `query → result`: an independent
 * `data_version` poll (`pollLoop`) turns committed changes into per-entity
 * `patch` pushes via a state-based diff (`diffTick`) keyed on each connection's
 * `lastSent` + watched-set; each tick also runs a per-filter `countAndToken` and
 * emits a `meta` frame when a subscription's `total` or membership token moves
 * (a count/staleness signal, NOT a live membership stream — the page stays
 * frozen).
 *
 * An `rpc` frame routes through the process-global `RPC_REGISTRY` and runs the
 * handler against a dedicated WRITER connection. The two-connection split is
 * load-bearing: the reader's `data_version` poll only sees writes from OTHER
 * connections, so any SQL-mutating RPC writer MUST be distinct from the poll
 * reader.
 *
 * Conventions: `isMainThread`-guarded body; own read-only + writer-mode `openDb`
 * (handles are thread-affine; the parent hands only the path string), both
 * released in shutdown. Typed messages `{ kind }` worker→main, `{ type }`
 * main→worker. NO in-process self-heal — any unrecoverable error is
 * `process.exit(1)` and the LaunchAgent restarts.
 *
 * Lock file, not socket file, for ownership: AF_UNIX has no `SO_REUSEADDR`, so a
 * crash leaves a stale socket → `EADDRINUSE`. We acquire the lock (pid +
 * liveness) BEFORE the unlink-then-bind, so two instances never race the path: a
 * live pid refuses to boot, a dead pid is stale and we steal it.
 *
 * The worker releases the socket in its OWN shutdown handler: the socket is
 * bound to the PROCESS, not the thread, so `worker.terminate()` does NOT release
 * it — without this the socket leaks into the next boot.
 */

import type { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { createHistogram, monitorEventLoopDelay } from "node:perf_hooks";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { type BackstopMessage, buildTimeoutRecord } from "./backstop-telemetry";
import {
  type CollectionDescriptor,
  countAndToken,
  decodeRow,
  getCollection,
  liveKeyExpr,
  liveKeyOf,
  type Row,
  selectByIdsChunked,
  selectVersionsByIdsChunked,
} from "./collections";
import {
  DEFAULT_MAX_CONCURRENT_PER_ROOT,
  effectivePerRootCap,
  openDb,
  readGitProjectionFloor,
  resolveSockPath,
} from "./db";
import type {
  DeadLetterOperatorOutcome,
  DeadLetterOperatorRequest,
} from "./dead-letter";
import type {
  DispatchClearOutcome,
  RetryDispatchVerb,
} from "./dispatch-command";
import type { NormalizedFableFocusInput } from "./fable-focus";
import { unseededGatedRoots } from "./gated-roots";
import { memoizedGitToplevel } from "./git-toplevel";
import { NotadbTolerance } from "./notadb-tolerance";
import {
  type BootStatus,
  type ClientFrame,
  type ErrorFrame,
  type EventStoreStatus,
  encodeFrame,
  type FilterValue,
  LineBuffer,
  OversizedLineError,
  type PatchFrame,
  type QueryFrame,
  type RequestAwaitRpcParams,
  type ResultFrame,
  type RpcFrame,
  type RpcResultFrame,
  type ServerFrame,
} from "./protocol";
import type { RestartBootIdentity } from "./restart-ledger";
import { installRpcHandlers } from "./rpc-handlers";
import {
  type AsyncRpcHandler,
  BadParamsError,
  createRpcRegistry,
  isMutatingRpcMethod,
  type ReplayBridge,
  type RpcHandler,
  SlugConflictError,
} from "./rpc-runtime";

export type { AsyncRpcHandler, ReplayBridge, RpcHandler } from "./rpc-runtime";
export { BadParamsError, SlugConflictError } from "./rpc-runtime";

/**
 * Data the parent passes via `new Worker(url, { workerData })`. Only path
 * strings cross the boundary — the Database handle and the listener cannot.
 */
export type DaemonBootIdentity = RestartBootIdentity;

export interface ServerWorkerData {
  dbPath: string;
  sockPath?: string;
  lockPath?: string;
  /** Identity already synced to the restart ledger before the DB was opened. */
  bootIdentity: DaemonBootIdentity;
  /** Realtime poll cadence in ms (defaults to `DEFAULT_POLL_MS`, floored at 25). */
  pollMs?: number;
  /**
   * Worker-role discriminator. The bottom-of-file entrypoint runs `main()`
   * (bind socket, acquire lock, serve) ONLY when this is `"server"`. Other
   * worker modules (e.g. `src/autopilot-worker.ts`) import this module for
   * its pure `runQuery` export and run as `!isMainThread` themselves — the
   * gate stops their import from spawning a SECOND server that fights the
   * real one for the lock (`LockHeldError`) and crashes the daemon.
   */
  role?: "server";
}

/** Message posted to the parent when the listener is bound and serving. */
export interface ReadyMessage {
  kind: "ready";
}

/**
 * Periodic served-latency self-report to main (the serve-liveness watchdog's eyes
 * on what real clients experience). DURATIONS ONLY — never timestamps: a starved
 * serve loop's own clock is late by construction, so main stamps arrival on its own
 * monotonic clock and judges report staleness from that, never from anything here.
 *   - `dispatchP99Ms`: p99 of per-request dispatch latency over the window.
 *   - `busyMs`: total time spent dispatching in the window (occupancy).
 *   - `sampleCount`: dispatches measured — main floors the p99's trust on this.
 *   - `loopDelayP99Ms`: the worker's OWN event-loop-delay p99 (the queueing signal).
 */
export interface ServeHealthMessage {
  kind: "serve-health";
  dispatchP99Ms: number;
  busyMs: number;
  sampleCount: number;
  loopDelayP99Ms: number;
}

/** Message the parent sends to ask the worker to stop. */
export interface ShutdownMessage {
  type: "shutdown";
}

/**
 * Edge-triggered fast-path wake. Main posts this post-COMMIT so the server-worker
 * runs `diffTick` immediately instead of waiting for its next poll tick. The
 * level-triggered `pollLoop` is retained as the stall-recovery backstop; the
 * kick is purely additive and idempotent (diffTick is version-gated). Posted
 * strictly after the commit so the worker never reads a pre-commit
 * `data_version`.
 */
export interface KickMessage {
  type: "kick";
}

/**
 * Main→worker boot-complete signal (fn-897 B1). The server worker now spawns
 * right after `migrate()` — BEFORE the boot drain — so it serves reads while the
 * reducer is still catching up. Main posts this ONCE the boot drain has reached
 * head AND the git boot-seed + ephemeral-truncate have run (today's post-drain
 * spawn point). Until it arrives, the worker rejects every MUTATING rpc with a
 * `server_booting` error so no consumer can act on partial state. One-way and
 * idempotent (a duplicate just re-sets the latch true).
 */
export interface BootCompleteMessage {
  type: "boot-complete";
}

/**
 * Worker→main request bridge for the dead-letter replay RPC. The async-RPC
 * dispatch path posts this with a correlation `id` and awaits the matching
 * {@link ReplayResultMessage}. A specific kind (not a generic "rpc-request") so
 * each main-thread handler stays narrowly typed.
 *
 * Routed through main because main is the sole writer of the events log (the
 * determinism boundary): the replay appends a real event built from the
 * dead-letter row's bindings, and that write MUST land on main so the re-fold
 * sees one linear append history with no holes. Each request handles exactly
 * ONE oldest-first record; a no-waiting-rows outcome returns `recovered_dl_id:
 * null` (an ok ack, not an error).
 */
export interface ReplayRequestMessage {
  kind: "replay-request";
  id: string;
}

/**
 * Main→worker reply paired with a {@link ReplayRequestMessage}; `id` correlates
 * it to the request.
 * - `ok:true, recovered_dl_id: string` — one waiting row flipped to recovered.
 * - `ok:true, recovered_dl_id: null` — zero waiting rows; a clean no-op ack.
 * - `ok:false, error` — main's recovery transaction crashed; framed as
 *   `rpc_failed`.
 */
export interface ReplayResultMessage {
  type: "replay-result";
  id: string;
  ok: boolean;
  recovered_dl_id?: string | null;
  error?: string;
}

export interface ResolveDeadLetterRequestMessage {
  kind: "resolve-dead-letter-request";
  id: string;
  request: DeadLetterOperatorRequest;
}

export interface ResolveDeadLetterResultMessage {
  type: "resolve-dead-letter-result";
  id: string;
  ok: boolean;
  outcome?: DeadLetterOperatorOutcome;
  error?: string;
}

/**
 * Worker→main request bridge for `set_autopilot_paused`. Main flips its
 * in-memory `paused` flag (boots-paused, never persisted) AND relays a
 * `set-paused` command to the autopilot worker. Routed through main because the
 * flag is single-source-of-truth there and the server-worker has no direct line
 * to the autopilot worker.
 */
export interface SetAutopilotPausedRequestMessage {
  kind: "set-autopilot-paused-request";
  id: string;
  paused: boolean;
}

/** Main→worker reply paired with {@link SetAutopilotPausedRequestMessage}. */
export interface SetAutopilotPausedResultMessage {
  type: "set-autopilot-paused-result";
  id: string;
  ok: boolean;
  error?: string;
}

/**
 * Worker→main request bridge for `retry_dispatch`. Main appends a
 * `DispatchCleared` synthetic event so the reducer folds the failure row OUT of
 * `dispatch_failures` (the only legal clear path — a direct DELETE would break
 * re-fold determinism). The wire shape is the SPLIT `verb` / `id` pair, not the
 * composite key, so main's mint site stays a pure forward.
 */
export interface RetryDispatchRequestMessage {
  kind: "retry-dispatch-request";
  id: string;
  /** The dispatch verb half of the failed `${verb}::${id}` key. `approve` is
   *  accepted ONLY for the operator-clear path (fn-870). */
  verb: RetryDispatchVerb;
  /** The keeper plan id (epic id for `close`; task id for `work`). Handler-validated
   *  non-empty; main treats it as an opaque token. */
  dispatch_id: string;
  /** Break-glass: override the claimant-liveness fence ONLY. The attempt-identity
   *  CAS at the write site stays load-bearing under force. */
  force: boolean;
  /** The acting operator identity, stamped into the audit trail of an appended
   *  clear. Null when the CLI could not resolve a session. */
  caller_session: string | null;
}

/** Main→worker reply paired with {@link RetryDispatchRequestMessage}. */
export interface RetryDispatchResultMessage {
  type: "retry-dispatch-result";
  id: string;
  ok: boolean;
  error?: string;
  /** The typed clear verdict — present on every non-error reply so the CLI shows
   *  cleared / refused_live / refused_identity instead of a bare `ok`. */
  outcome?: DispatchClearOutcome;
}

/**
 * Worker→main request bridge for `set_autopilot_mode`. Main APPENDS an
 * `AutopilotMode` synthetic event (folded into `autopilot_state.mode`) and pumps
 * a wake. UNLIKE {@link SetAutopilotPausedRequestMessage}, NO relay to the
 * autopilot worker: the reconciler re-reads `mode` from the projection each
 * cycle. Mode is durable user intent, not a safety reset, so no in-memory flag
 * and no boot re-arm.
 */
export interface SetAutopilotModeRequestMessage {
  kind: "set-autopilot-mode-request";
  id: string;
  mode: "yolo" | "armed";
}

/** Main→worker reply paired with {@link SetAutopilotModeRequestMessage}. */
export interface SetAutopilotModeResultMessage {
  type: "set-autopilot-mode-result";
  id: string;
  ok: boolean;
  error?: string;
}

/**
 * Worker→main request bridge for `set_autopilot_config` — the GENERIC autopilot
 * config patch. Main APPENDS an `AutopilotConfigSet` synthetic event carrying the
 * partial patch (folded into the `autopilot_state` singleton, setting ONLY the
 * patched columns) and pumps a wake. Same APPEND-ONLY / no-relay contract as
 * {@link SetAutopilotModeRequestMessage}: the reconciler re-reads the config
 * columns from the projection each cycle. `patch` is the validated wire patch
 * (handler-validated; main JSON-stringifies it verbatim into `events.data`).
 */
export interface SetAutopilotConfigRequestMessage {
  kind: "set-autopilot-config-request";
  id: string;
  patch: {
    max_concurrent_jobs?: number | null;
    max_concurrent_per_root?: number | null;
    worktree_mode?: boolean;
    worktree_multi_repo?: boolean;
    worker_provider?: "claude" | "gpt" | null;
    drift_behind_threshold?: number | null;
    drift_age_threshold_days?: number | null;
    fable_focus?: NormalizedFableFocusInput | null;
  };
}

/** Main→worker reply paired with {@link SetAutopilotConfigRequestMessage}. */
export interface SetAutopilotConfigResultMessage {
  type: "set-autopilot-config-result";
  id: string;
  ok: boolean;
  error?: string;
  /** OPTIONAL stored-vs-effective advisory — set when the patch stores a per-root
   *  cap intent left dormant by the folded worktree mode (main derives it at reply
   *  time via `perRootStoredWhileOffNote`). Absent when there is nothing to note. */
  note?: string;
}

/**
 * Worker→main request bridge for `set_epic_armed`. Main APPENDS an `EpicArmed`
 * synthetic event (folded into the `armed_epics` PRESENCE table) and pumps a
 * wake — same APPEND-ONLY / no-relay contract as
 * {@link SetAutopilotModeRequestMessage}.
 */
export interface SetEpicArmedRequestMessage {
  kind: "set-epic-armed-request";
  id: string;
  epic_id: string;
  armed: boolean;
}

/** Main→worker reply paired with {@link SetEpicArmedRequestMessage}. */
export interface SetEpicArmedResultMessage {
  type: "set-epic-armed-result";
  id: string;
  ok: boolean;
  error?: string;
}

/**
 * Worker→main bridge request: APPEND a `HandoffRequested` synthetic event (the
 * SIXTH mutating RPC). Carries the stably-minted idempotency key + the spill-file
 * PATH (NOT the large doc — neither the socket frame nor this message inlines the
 * blob) + the raw initiator coords; main reads the doc back from `doc_path` and
 * resolves `initiator_job_id` best-effort by pane. Paired with
 * {@link RequestHandoffResultMessage}.
 */
export interface RequestHandoffRequestMessage {
  kind: "request-handoff-request";
  id: string;
  /** Agent-authored slug — main re-validates its format, probes the events log
   *  for a host-global collision, and freezes it as the `handoff_id` on success. */
  desired_slug: string;
  doc_path: string;
  title: string | null;
  target_session: string;
  /** Resolved ABSOLUTE launch directory (or null → keeperd cwd at launch). */
  target_dir: string | null;
  initiator_session: string | null;
  initiator_pane: string | null;
  capture: boolean;
  model: string | null;
  effort: string | null;
  preset: string | null;
}

/** Main→worker reply paired with {@link RequestHandoffRequestMessage}. */
export interface RequestHandoffResultMessage {
  type: "request-handoff-result";
  id: string;
  ok: boolean;
  error?: string;
  /** Set when `ok:false` is a slug collision (vs an ordinary failure), so the
   *  handler throws {@link SlugConflictError} → the distinct `slug_conflict`
   *  wire code → CLI exit 3. */
  conflict?: boolean;
}

/** Worker→main request to mint one durable-await request/cancel Event. */
export interface RequestAwaitRequestMessage {
  kind: "request-await-request";
  id: string;
  request: RequestAwaitRpcParams;
}

/** Main→worker reply paired with {@link RequestAwaitRequestMessage}. */
export interface RequestAwaitResultMessage {
  type: "request-await-result";
  id: string;
  ok: boolean;
  error?: string;
}

/**
 * The one not-cancellable refusal (ADR 0072): a foreign caller, an absent row,
 * and an already-settled row all collapse to this identical message so the
 * cancel path never becomes an existence oracle. Its wording enumerates the
 * possibilities without revealing which one applies.
 */
export const AWAIT_NOT_CANCELLABLE_MESSAGE =
  "await is not cancellable (unknown id, already settled, or not the arming session)";

/** The producer's verdict for one durable-await cancel request. `append` mints
 *  the compensating event (owner-blind fold does the status CAS); `noop`
 *  succeeds without a write (re-cancel of an already-cancelled row); `refuse`
 *  returns the uniform not-cancellable message. */
export type AwaitCancelDecision =
  | { kind: "append"; forcedBy: string | null }
  | { kind: "noop" }
  | { kind: "refuse" };

/**
 * Owner fence for a durable-await cancel (ADR 0072), enforced producer-side.
 * Pure: main reads the committed `awaits` row, then this decides. Authority is
 * the row's recorded arming session — never the caller's claim — OR an audited
 * `force` override; deny by default. Foreign caller, absent row, and terminal
 * (done/failed/timed_out) collapse to one uniform refusal; an already-cancelled
 * row is an idempotent no-op success for an authorized caller. A `force` cancel
 * stamps the acting identity so the compensating event records who overrode.
 */
export function decideAwaitCancel(
  row: { target_session: string | null; status: string } | undefined,
  callerSession: string | null,
  force: boolean,
): AwaitCancelDecision {
  const authorized =
    force ||
    (callerSession !== null &&
      row !== undefined &&
      row.target_session === callerSession);
  if (!authorized || row === undefined) return { kind: "refuse" };
  if (row.status === "cancelled") return { kind: "noop" };
  if (row.status !== "waiting") return { kind: "refuse" };
  return { kind: "append", forcedBy: force ? callerSession : null };
}

/**
 * Poll cadence (ms) for the realtime `data_version` loop. Mirrors the wake
 * worker's defaults — 50 ms is the sweet spot, floored at 25 ms to avoid
 * burning a core.
 */
export const DEFAULT_POLL_MS = 50;
const MIN_POLL_MS = 25;

/**
 * Minimum interval (ms) between `meta` membership-nudge emissions PER
 * subscription. A `meta{total,token}` move fires on essentially every fold and
 * drives a full client refetch, fanned serially to every subscriber — a fold
 * burst becomes a refetch storm without this throttle.
 *
 * The throttle COALESCES the EMISSION: a move within the window is deferred, but
 * the membership baseline and the emit clock advance ONLY on an actual emit, so
 * the delta persists and the next eligible `diffTick` emits the latest state (no
 * lost final update; `pollLoop` is the convergence safety net). Gates ONLY the
 * meta pass — `patch` frames (the correctness-critical cell stream) are NEVER
 * delayed.
 */
export const META_MIN_INTERVAL_MS = 150;

/**
 * Hard upper bound on how long the async-RPC bridge waits for a `replay-result`
 * reply from main before rejecting. Generous enough to absorb a brief drain
 * stall but tight enough that a wedged main surfaces as a typed `rpc_failed`
 * frame rather than hanging the keypress.
 */
const REPLAY_DEADLINE_MS = 5000;

/**
 * Bound on how long `shutdown()` waits for the poll loop to observe `stopping`
 * and exit before closing the DB. One cadence plus slack; the cap guarantees a
 * wedged loop can't block teardown forever (we exit right after the close
 * regardless).
 */
const POLL_DRAIN_DEADLINE_MS = 500;

/** Default page size when a `query` omits `limit`; the hard cap is the same. */
export const DEFAULT_LIMIT = 100;
/** Maximum page size — kept well below `MAX_IN_PARAMS` so a page is one query. */
export const MAX_LIMIT = 500;

/**
 * Hard upper bound on concurrent connections — the global backstop. Diff fan-out
 * scales with SUBSCRIBED conns only (a zero-sub conn carries no subs and never
 * enters a diff), so the real cost driver is `sub_live` — kept low by the reapers
 * (including {@link SUBSCRIBED_SILENCE_TTL_MS} for abandoned-but-alive subs) AND
 * bounded per tick by {@link MAX_SUBS_PER_TICK} so no accumulation can starve the
 * loop. This ceiling guards against a connection STORM (a reconnect-loop client)
 * filling the table. At the cap a NEW connection is REJECTED with a
 * `max_connections` frame then closed — reject-new, NOT LRU-evict: the oldest
 * conn is the legit long-lived board. The {@link PER_PID_MAX_CONNECTIONS}
 * per-client cap is the first wall (one client can't monopolize the table);
 * this global cap is the second. Hitting it AFTER a sweep is logged loudly
 * (un-gated) — it means every conn is genuinely live and busy.
 */
export const MAX_CONNECTIONS = 256;

/**
 * Per-peer-pid connection cap — admission control so a SINGLE misbehaving client
 * (a `keeper board` reconnect loop, a hung CLI re-dialing) cannot exhaust the
 * global {@link MAX_CONNECTIONS} table on its own. At accept, if the peer pid
 * already holds this many conns, a hygiene sweep runs and the new conn is
 * rejected if the count still holds. Generous enough for legit bursty usage (a
 * board sub + a few in-flight one-shot queries from one session) yet a hard wall
 * against a loop that opens hundreds. `null` peer pid (non-darwin / probe
 * failure) is exempt — it degrades to the global cap + the reapers.
 */
export const PER_PID_MAX_CONNECTIONS = 16;

/**
 * Ceiling (ms) a connection's outbound write may stay BACKPRESSURED before the
 * conn is reaped. `diffTick` SKIPS a conn with a non-empty `pending` buffer, so
 * a dead-but-backpressured socket never gets another write to EPIPE on and would
 * linger forever. NOT a write-side idle timer: a quiet receive-only subscriber
 * has `pending === null` and is never touched. Fires ONLY on a genuinely STUCK
 * buffer, which a live consumer drains in milliseconds.
 */
export const STUCK_PENDING_TTL_MS = 30_000;

/**
 * Ceiling (ms) a connection with ZERO subscriptions may sit idle before the idle
 * sweep evicts it — the belt-and-braces arm for a leak the EPIPE-evict and
 * stuck-pending TTL both miss: a one-shot query-only client that dies in a way
 * the kernel never reports (SIGKILL mid-frame, half-open socket) fires neither
 * the `close` handler nor `error`, never backpressures (so the stuck-pending TTL
 * is inert), and never enters a diff fanout (zero subs) — so it would sit in
 * `conns` forever, and bursty CLI churn fills the cap.
 *
 * STRICTLY a zero-sub sweep: a SUBSCRIBED connection (even a quiet board) is
 * NEVER idle-reaped. `lastActivityAt` is stamped at `open` and on every inbound
 * chunk, so a client mid-handshake or querying is never swept.
 */
export const IDLE_CONN_TTL_MS = 5 * 60_000;

/**
 * Subscribe-by-deadline ceiling (ms): a connection that has neither established
 * a subscription NOR engaged at all (sent zero complete frames — never queried,
 * never subscribed) within this window of `connectedAt` is force-closed. This is
 * the fast arm against a reconnect storm — a client that dials, parks a zero-sub
 * connection, and never speaks would otherwise wait out the 5-minute
 * {@link IDLE_CONN_TTL_MS}, and a burst refills the table far faster than that.
 *
 * Keyed on `connectedAt` (immutable) NOT `lastActivityAt`, so noise chunks can't
 * defer it; gated on `everEngaged`, so a slow cold-boot query is SAFE — engagement
 * flips true the instant the query FRAME arrives (well before the multi-second
 * response main computes), so the deadline never reaps a conn with work in flight.
 * It only targets connect-and-silent dead weight. Much shorter than the idle TTL
 * because an unengaged conn has, by definition, done nothing worth waiting for.
 */
export const UNENGAGED_CONN_TTL_MS = 30_000;

/**
 * Inbound-silence ceiling (ms) for a SUBSCRIBED connection before it is reaped as
 * abandoned-but-alive: subscribed, peer process still live, `everEngaged` — the
 * exact conn the dead-peer / unengaged / idle sweeps all miss (live pid, engaged,
 * subs > 0). A ghost of this shape (a half-open UDS FIN the kernel never surfaces,
 * a viewer whose event loop wedged, a non-keeper client that abandons its socket
 * without closing it) generates no backpressure during a DB-quiet window, so it
 * sits in `conns` forever while every diff tick pays its fan-out.
 *
 * Reaped on POSITIVE abandonment evidence, never on push-side silence: a live
 * `subscribeReadiness` viewer sends a heartbeat probe refetch every
 * {@link import("./readiness-client").HEARTBEAT_IDLE_MS} (15s) of inbound idleness,
 * so a healthy subscribed conn refreshes `lastActivityAt` at least that often even
 * on a silent board. This ceiling sits at 3x the client heartbeat — comfortably
 * past heartbeat jitter, backpressure, and round-trip slop — so it fires ONLY on a
 * conn whose engagement has genuinely ceased, never on a legitimately-quiet board.
 * Keyed on `lastActivityAt` (inbound), NOT the server's push cadence.
 */
export const SUBSCRIBED_SILENCE_TTL_MS = 45_000;

// ---------------------------------------------------------------------------
// DEBUG: timing instrumentation
// ---------------------------------------------------------------------------
//
// Diagnostic logs `[srv-ts] T=<epochMs> <event>`, gated by `KEEPER_TRACE_SERVER`
// AT THE CALL SITE (not inside `srvTs` — the template-literal `msg` allocates
// before any in-function gate). Read once at module load so V8/JSC elides the
// `if (TRACE)` branch when off. The rare `[server-worker]` error class is
// UN-gated.
const TRACE = process.env.KEEPER_TRACE_SERVER === "1";
// Per-frame byte threshold for `writeFrames` instrumentation; a non-numeric env
// value falls back to the default.
const TRACE_FRAME_BYTES_DEFAULT = 4096;
const TRACE_FRAME_BYTES = (() => {
  const raw = process.env.KEEPER_TRACE_FRAME_BYTES;
  if (raw === undefined || raw === "") return TRACE_FRAME_BYTES_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : TRACE_FRAME_BYTES_DEFAULT;
})();
let __nextConnId = 0;
function srvTs(msg: string): void {
  console.error(`[srv-ts] T=${Date.now()} ${msg}`);
}

/**
 * How often the worker posts a `serve-health` self-report to main. Several reports
 * per watchdog interval, so a couple of dropped reports never reads as a mute; the
 * mute threshold is multiple watchdog intervals, well above this.
 */
export const SERVE_HEALTH_REPORT_INTERVAL_MS = 12_000;

/**
 * Accumulates per-dispatch served-latency over a report window. The dispatch timing
 * that feeds `record` runs UNCONDITIONALLY (a ~20ns `performance.now()` pair, no env
 * gate — only the trace LOGGING stays behind `TRACE`), so the watchdog always has
 * eyes on what real clients experience. Backed by a native histogram (bounded memory
 * under a flood, unlike a growing array); busy-ms is summed alongside since a
 * histogram has percentiles but no sum. `drain()` reads and resets the window.
 */
export class ServeLatencyMeter {
  // Sub-ms dispatches matter for the tail, and the histogram floors at 1, so record
  // in MICROSECONDS and convert the p99 back to ms on drain.
  private readonly hist = createHistogram();
  private busyMs = 0;

  record(durMs: number): void {
    const safe = durMs > 0 ? durMs : 0;
    this.hist.record(Math.max(1, Math.round(safe * 1000)));
    this.busyMs += safe;
  }

  drain(): { dispatchP99Ms: number; busyMs: number; sampleCount: number } {
    const sampleCount = Number(this.hist.count);
    const dispatchP99Ms =
      sampleCount > 0 ? Number(this.hist.percentile(99)) / 1000 : 0;
    const busyMs = this.busyMs;
    this.hist.reset();
    this.busyMs = 0;
    return { dispatchP99Ms, busyMs, sampleCount };
  }
}

/**
 * Format a stage-timing line for the `[srv-ts]` log, funneling `runQuery` and
 * `diffTick` through ONE call so the awk-parseable shape stays locked:
 *
 *   op=<name> col=<col> [rows=<N>] [bytes=<B>] <stage1>=<ms> ... total=<ms>
 *
 * Stage values are pre-formatted by the caller; `total` is always appended last.
 */
function formatStages(args: {
  op: string;
  col: string;
  rows?: number;
  bytes?: number;
  stages: Array<[string, string]>;
  total: string;
}): string {
  let line = `op=${args.op} col=${args.col}`;
  if (args.rows !== undefined) line += ` rows=${args.rows}`;
  if (args.bytes !== undefined) line += ` bytes=${args.bytes}`;
  for (const [name, ms] of args.stages) {
    line += ` ${name}=${ms}`;
  }
  line += ` total=${args.total}`;
  return line;
}

/**
 * Per-subscription state on a connection. One `SubState` carries everything
 * that used to live as a top-level slot on `ConnState`:
 *
 * - `collection` is the subscription's collection name.
 * - `watched` is the frozen page membership (keyed by the collection's live key
 *   — `liveKeyOf`: the composite `(verb, id)` for `dispatch_failures`, the bare
 *   `pk` otherwise), seeded by the originating `query` and re-diffed on every
 *   `data_version` tick.
 * - `lastSent` maps that live key → the collection's version column as last
 *   pushed to this subscription, so the diff emits a `patch` exactly once per
 *   advance.
 * - `where` is the resolved filter (clause + bound params) the originating
 *   query was built from; reused on every tick for the membership COUNT+token
 *   so the count cannot drift from the page that produced it.
 * - `lastTotal` / `lastToken` are the filtered-set size + membership
 *   fingerprint last reflected to this subscription (seeded from the same read
 *   that produced the `result`'s `total`); the diff emits a `meta` frame only
 *   when either moves.
 * - `lastMetaEmittedAt` is the wall-clock (ms) of the last `meta` emission. The
 *   meta pass throttles to one emit per `META_MIN_INTERVAL_MS`; the baseline +
 *   this clock advance ONLY on an actual emit. Lives on `SubState` (not
 *   `diffTick`-local) because BOTH `handleKick` and `pollLoop` drive `diffTick`
 *   — a local clock would split the throttle window. Seeded to `0` so the first
 *   move always emits.
 */
export interface SubState {
  collection: string;
  watched: Set<string>;
  lastSent: Map<string, number>;
  where: ResolvedFilter;
  lastTotal: number;
  lastToken: string;
  lastMetaEmittedAt: number;
}

/**
 * One cached query answer, keyed in {@link ResultMemo} by its full query
 * signature (collection + resolved filter + sort + limit + offset) within a
 * single `worldRev` window. Shared read-only across every connection issuing
 * the same query at the same rev: the FIRST runs `runQuery` + ONE
 * `JSON.stringify(rows)`, the rest reuse this entry.
 *
 * - `rows` is the decoded row array runQuery returned — treated READ-ONLY by
 *   consumers (the per-conn SubState seed copies it via `new Set`/`new Map`,
 *   so sharing is safe).
 * - `rowsJson` is `JSON.stringify(rows)` computed ONCE; the per-conn result
 *   line concatenates the result envelope around it (no re-serialize).
 * - `total` / `token` / `where` mirror runQuery's `out` out-param so the
 *   SubState membership baseline seeds without a re-read.
 */
interface ResultMemoEntry {
  rows: Row[];
  rowsJson: string;
  total: number;
  token: string;
  where: ResolvedFilter;
}

/**
 * Per-server-instance, single-`worldRev` result memo (fn-698). Owned in the
 * `startServer` closure (like `conns`/`writerDb`) — NOT module-global — and
 * threaded into `handleData` → `dispatchLine` as an optional trailing param so
 * existing direct-`dispatchLine` tests (which omit it) keep the un-memoized
 * path. Holds entries for exactly ONE `worldRev` at a time: the instant the
 * read worldRev moves, `entries` is REPLACED with a fresh Map (clean reset —
 * no stale-rev entry can survive), so a line stamped rev-N+1 can never carry
 * rev-N rows. `entries` is capped at {@link MEMO_SIGNATURE_CAP} distinct
 * signatures per rev window; once full a NEW signature runs un-memoized rather
 * than evicting the already-cached hot board signature mid-burst.
 */
export interface ResultMemo {
  worldRev: number;
  entries: Map<string, ResultMemoEntry>;
  /**
   * fn-1311: the event-store block for this `worldRev` window, computed ONCE on
   * the reset that stamps the window (not per query) and baked into every memo
   * line built here. Block-global at a world-rev, so one read serves every
   * connection's cached line. `null` only on the fresh `-1` sentinel window.
   */
  eventStore: EventStoreStatus | null;
}

/** Distinct-signature cap per worldRev window (fn-698). */
const MEMO_SIGNATURE_CAP = 256;

/** Allocate a fresh per-server-instance result memo (worldRev sentinel `-1`). */
export function newResultMemo(): ResultMemo {
  // worldRev: -1 — a real `reducer_state.last_event_id` is always >= 0, so the
  // first query always trips the replace-on-mismatch reset and stamps the live
  // rev. Avoids a special-case "empty memo" branch.
  return { worldRev: -1, entries: new Map(), eventStore: null };
}

/**
 * Internal write-path sentinel for a pre-serialized result LINE (fn-698). NOT
 * a wire-protocol frame and NOT a member of the `ServerFrame` union — it never
 * crosses the socket as an object; `writeFrames` recognizes the `__line`
 * brand and writes the carried string verbatim (it is already a complete
 * NDJSON line, trailing `\n` included, byte-identical to
 * `encodeFrame(runQuery(...))`). Every other frame type still routes through
 * `encodeFrame`.
 */
export interface PreSerialized {
  __line: string;
}

/** Narrow a dispatch return element to the pre-serialized sentinel. */
function isPreSerialized(f: ServerFrame | PreSerialized): f is PreSerialized {
  return typeof (f as PreSerialized).__line === "string";
}

/**
 * Full query signature (fn-698 memo key) for a `query` frame against a known
 * descriptor: `collection + WHERE clause + bound params + sortCol + dir +
 * limit + offset`. The sort/dir/limit/offset resolution MIRRORS `runQuery`
 * exactly (same `sortable` allowlist + default-dir rule + `clampLimit` +
 * offset floor) so two frames that produce the same page produce the same key
 * and two that page differently never collide. The resolved filter is built by
 * the same `resolveFilter` map lookup runQuery uses (cheap — no SELECT). Unlike
 * `diffTick`'s coalescing key (which DELIBERATELY omits sort/limit/offset
 * because the membership COUNT ignores them), the memo's key INCLUDES them —
 * two subs sharing a filter but paging differently must NOT share a result.
 */
function querySignature(
  descriptor: CollectionDescriptor,
  frame: QueryFrame,
  where: ResolvedFilter,
): string {
  const sortCol =
    frame.sort && descriptor.sortable.has(frame.sort.column)
      ? frame.sort.column
      : descriptor.defaultSort.column;
  const dir =
    frame.sort?.dir === "asc" || frame.sort?.dir === "desc"
      ? frame.sort.dir
      : sortCol === descriptor.defaultSort.column
        ? descriptor.defaultSort.dir
        : "asc";
  const limit = clampLimit(frame.limit);
  const offset =
    typeof frame.offset === "number" && frame.offset > 0
      ? Math.floor(frame.offset)
      : 0;
  return JSON.stringify([
    descriptor.name,
    where.clause,
    where.params,
    sortCol,
    dir,
    limit,
    offset,
  ]);
}

/**
 * Build the per-connection {@link SubState} for a fresh `query` subscription.
 * Factored out so the memo-hit path (fn-698) and the un-memoized fallback
 * build it identically. `rows` is treated READ-ONLY — `new Set`/`new Map`
 * COPY the membership/version maps, so a shared cached `Entry.rows` array is
 * safe to seed from concurrently.
 */
function seedSubState(
  descriptor: CollectionDescriptor,
  collection: string,
  rows: Row[],
  baseline: { where: ResolvedFilter; total: number; token: string },
): SubState {
  return {
    collection,
    watched: new Set(rows.map((r) => liveKeyOf(descriptor, r))),
    lastSent: new Map(
      rows.map((r) => [
        liveKeyOf(descriptor, r),
        r[descriptor.version] as number,
      ]),
    ),
    where: baseline.where,
    lastTotal: baseline.total,
    lastToken: baseline.token,
    // Seeded to 0 so the FIRST membership move on this fresh sub always
    // emits (Date.now() - 0 >= META_MIN_INTERVAL_MS). The throttle only
    // bites on the SECOND+ move within the interval.
    lastMetaEmittedAt: 0,
  };
}

/**
 * fn-698 memo serve path. Returns the dispatch frames (a single
 * {@link PreSerialized} result line) when the query resolves to a registered
 * collection — seeding the per-conn SubState off the (possibly shared) cached
 * Entry — or `null` to signal "fall through to the un-memoized path"
 * (unknown collection: let runQuery mint the `unknown_collection` error so
 * behavior is identical, never cached).
 *
 * Single-`worldRev` discipline: if the read `worldRev` differs from the
 * holder's, REPLACE `entries` with a fresh Map and stamp the new rev FIRST —
 * no stale-rev entry survives, so a line stamped rev-N+1 can never carry
 * rev-N rows. On a MISS the entry is built (subject to the distinct-signature
 * cap) and the rows serialized ONCE; on a HIT the rows/total/token are served
 * with ZERO SELECT and ZERO countAndToken.
 *
 * Throwing is acceptable here — the caller wraps the whole block in try/catch
 * and degrades to the un-memoized path.
 */
function serveFromMemo(
  db: Database,
  conn: ConnState,
  frame: QueryFrame,
  worldRev: number,
  memo: ResultMemo,
  bootGate: BootGate,
): (ServerFrame | PreSerialized)[] | null {
  const descriptor = getCollection(frame.collection);
  if (!descriptor) {
    // Unknown collection: not memoizable — let the un-memoized path mint the
    // `unknown_collection` ErrorFrame so the response is byte-identical.
    return null;
  }

  // Replace-on-worldRev-mismatch reset: a clean wipe, so no entry keyed under a
  // prior rev can ever be served. Stamp the new rev BEFORE any entry write.
  if (memo.worldRev !== worldRev) {
    memo.entries = new Map();
    memo.worldRev = worldRev;
    // Refresh the window's event-store block once per rev (not per query), so
    // every memo line carries the steady-state block without paying a
    // `COUNT(*)` on each memo hit.
    memo.eventStore = readEventStoreStatus(db);
  }

  // Resolve the filter the same way runQuery does (cheap map lookup, no SELECT)
  // to build the signature key. On a miss runQuery re-resolves the identical
  // filter into `seed.where`, which is what the SubState baseline records.
  // Pin `nowSec` ONCE and thread it to BOTH the sigKey resolve here and the
  // `runQuery` miss below: a recency-bounded descriptor binds the cutoff from
  // the clock, so two resolves straddling a second boundary would otherwise key
  // the entry under one cutoff and seed it from another. One `nowSec` keeps the
  // sigKey, the cached `where`, and the page on the SAME window.
  const nowSec = Date.now() / 1000;
  const where = resolveFilter(descriptor, frame.filter, nowSec);
  const sigKey = querySignature(descriptor, frame, where);

  let entry = memo.entries.get(sigKey);
  if (!entry) {
    // Distinct-signature cap: when the rev window already holds the max number
    // of distinct signatures, a NEW signature runs un-memoized rather than
    // evicting an already-cached (hot) signature mid-burst. 21 identical
    // queries are ONE signature, so the hot board query is never shed.
    if (memo.entries.size >= MEMO_SIGNATURE_CAP) {
      if (TRACE)
        srvTs(
          `op=memo stage=cap-skip col=${descriptor.name} size=${memo.entries.size}`,
        );
      return null;
    }
    // MISS: one runQuery + one JSON.stringify, cached under the read worldRev.
    const seed = {} as { where: ResolvedFilter; total: number; token: string };
    const out = runQuery(db, worldRev, frame, seed, nowSec);
    if (out.type !== "result") {
      // A known descriptor returning a non-result is unexpected (runQuery only
      // errors on unknown_collection, handled above); don't cache — fall
      // through so the un-memoized path returns the same frame.
      return null;
    }
    const rowsJson = JSON.stringify(out.rows);
    entry = {
      rows: out.rows,
      rowsJson,
      total: seed.total,
      token: seed.token,
      where: seed.where,
    };
    memo.entries.set(sigKey, entry);
    if (TRACE)
      srvTs(
        `op=memo stage=miss col=${descriptor.name} rows=${out.rows.length} serialize-once bytes=${rowsJson.length} sigs=${memo.entries.size}`,
      );
  } else {
    if (TRACE)
      srvTs(
        `op=memo stage=hit col=${descriptor.name} rows=${entry.rows.length} bytes=${entry.rowsJson.length}`,
      );
  }

  // Seed the per-conn subscription off the cached (shared, read-only) Entry —
  // `new Set`/`new Map` copy, so sharing the rows array is safe.
  const subId = frame.id ?? null;
  conn.subs.set(
    subId,
    seedSubState(descriptor, descriptor.name, entry.rows, {
      where: entry.where,
      total: entry.total,
      token: entry.token,
    }),
  );

  // Per-conn pre-serialized line: the result envelope concatenated around the
  // ONE shared `rowsJson`, plus the window's event-store block and the current
  // boot/Drain header.
  const line = buildResultLine(
    frame.id,
    descriptor.name,
    worldRev,
    entry.total,
    entry.rowsJson,
    memo.eventStore,
    readBootStatus(db, bootGate),
  );
  return [{ __line: line }];
}

/**
 * Hand-concatenate a `result` LINE byte-identical to
 * `encodeFrame(runQuery(...))`. The insertion key order MUST match the
 * ResultFrame object literal runQuery builds: `type, [id], collection, rev,
 * total, rows`. `id` and `collection` are `JSON.stringify`-d (typed `string`,
 * not guaranteed escape-free); `rev`/`total` are unquoted numbers;
 * `rowsJson` is the UNMODIFIED `JSON.stringify(rows)` output spliced in around
 * the `"rows":` key. Trailing `\n` mirrors `encodeFrame`.
 */
function buildResultLine(
  id: string | undefined,
  collection: string,
  rev: number,
  total: number,
  rowsJson: string,
  eventStore: EventStoreStatus | null,
  boot: BootStatus,
): string {
  const idSeg = id !== undefined ? `,"id":${JSON.stringify(id)}` : "";
  // The event-store block trails the rows, mirroring the object-frame key order
  // `stampEventStore` produces (`event_store` before the boot header). It is
  // omitted only on the `-1` sentinel window, never a live serve.
  const esSeg =
    eventStore !== null ? `,"event_store":${JSON.stringify(eventStore)}` : "";
  const bootSeg = `,"boot":${JSON.stringify(boot)}`;
  return (
    `{"type":"result"${idSeg}` +
    `,"collection":${JSON.stringify(collection)}` +
    `,"rev":${rev}` +
    `,"total":${total}` +
    `,"rows":${rowsJson}${esSeg}${bootSeg}}\n`
  );
}

/**
 * Per-connection state, carried on `socket.data` (typed via the
 * `Bun.listen<ConnState>` generic).
 *
 * - `buffer` line-buffers decoded inbound chunks until a `\n` lands (NDJSON framing).
 * - `decoder` preserves UTF-8 codepoints split across socket chunks.
 * - `subs` maps the query's `id` (or `null` for the anonymous-sub sentinel
 *   used by legacy single-sub clients) to its `SubState`. A connection may
 *   carry any number of concurrent subscriptions, each with its own
 *   collection / watched-set / lastSent / where / lastTotal / lastToken; the
 *   anonymous slot replaces itself on each anonymous re-query (matching the
 *   "one active subscription" semantic for legacy clients), while id-keyed
 *   subs replace per-id and otherwise coexist. `diffTick` iterates the union
 *   `(sock, subId, sub)` across all connections, groups by `sub.collection`,
 *   and fans `patch`/`meta` frames per-sub (carrying `id` when `subId !==
 *   null`).
 * - `pending` holds a backpressured tail: the UTF-8 bytes not yet accepted by
 *   the socket, resumed in `drain`. Backpressure is SOCKET-LEVEL — when set
 *   it skips ALL subs on this connection together (no coordination overhead;
 *   the outbound buffer is the shared resource being protected).
 * - `id` is the debug per-connection sequence id used by `[srv-ts]` logs.
 *
 * Subscription mutation:
 *   - A `query` frame keyed by `frame.id ?? null` atomically replaces (or
 *     creates) one slot in `subs` — list→detail navigation on a legacy client
 *     re-queries the anonymous slot; a multi-sub client adds/replaces by id.
 *   - An `unsubscribe{id}` deletes just that slot (silent no-op when absent
 *     — idempotent, matches HTTP DELETE 404-as-success).
 *   - An `unsubscribe{}` clears the whole map.
 *   - `close` clears the whole map, drops `pending`, and discards decoder tail bytes.
 */
export interface ConnState {
  buffer: LineBuffer;
  decoder: TextDecoder;
  subs: Map<string | null, SubState>;
  pending: { bytes: Uint8Array; offset: number } | null;
  /**
   * Epoch-ms when `pending` last transitioned from null → non-null, or null
   * when not backpressured (fn-723 task .2). The stuck-pending reaper compares
   * this against `STUCK_PENDING_TTL_MS` to evict a dead-but-backpressured conn
   * (one `diffTick` skips for backpressure so it never EPIPEs). Set in `flush`
   * when a write stashes a tail; cleared the instant `pending` drains to null.
   */
  pendingSince: number | null;
  /**
   * Epoch-ms of the LAST inbound activity on this connection (fn-767): stamped
   * at `open` and refreshed on every inbound `data` chunk. The zero-sub idle
   * sweep compares this against {@link IDLE_CONN_TTL_MS} to evict a one-shot
   * query-only client that connected, queried, and then silently died (a death
   * the kernel never reports as a `close`/`error`, so the EPIPE-evict and
   * stuck-pending TTL both miss it). A SUBSCRIBED connection is exempt from the
   * sweep regardless of this clock — a quiet board is legitimately silent — so
   * this drives eviction ONLY for connections carrying zero subscriptions.
   */
  lastActivityAt: number;
  /**
   * The peer process's pid, captured at `open` via `getsockopt`/`LOCAL_PEERPID`
   * (macOS UDS). `null` when the probe is unavailable (non-darwin, load
   * failure, or a `getsockopt` error). Drives the SUBSCRIBED-conn dead-peer
   * sweep ({@link reapDeadPeers}): a subscribed conn whose peer pid is gone is
   * evicted — closing the hole fn-767's subscribed-exempt idle sweep left. A
   * `null` pid is NEVER reaped on liveness (the probe degrades to the existing
   * idle + stuck-pending arms).
   */
  peerPid: number | null;
  /**
   * Epoch-ms when this connection was accepted (`open`). IMMUTABLE — unlike
   * `lastActivityAt` it never refreshes, so the subscribe-by-deadline sweep
   * ({@link reapUnengaged} vs {@link UNENGAGED_CONN_TTL_MS}) measures true age
   * from connect and a noise-chunk stream can't defer it.
   */
  connectedAt: number;
  /**
   * True once this connection has dispatched at least one complete inbound frame
   * (a query / subscribe / unsubscribe). Distinguishes a conn doing real work —
   * including one with a slow cold-boot query in flight — from connect-and-silent
   * dead weight: the subscribe-by-deadline sweep ({@link reapUnengaged}) reaps
   * ONLY a still-`false` zero-sub conn, so a legit query is never force-closed
   * mid-answer (engagement flips the instant the frame arrives, before the reply).
   */
  everEngaged: boolean;
  /** DEBUG: per-connection sequence id for `[srv-ts]` log correlation. */
  id?: number;
}

export function newConnState(): ConnState {
  const now = Date.now();
  return {
    buffer: new LineBuffer(),
    decoder: new TextDecoder("utf-8", { fatal: false }),
    subs: new Map(),
    pending: null,
    pendingSince: null,
    lastActivityAt: now,
    peerPid: null,
    connectedAt: now,
    everEngaged: false,
  };
}

// ---------------------------------------------------------------------------
// Lock-file ownership
// ---------------------------------------------------------------------------

/** Thrown when a live instance already owns the lock — boot must refuse. */
export class LockHeldError extends Error {
  constructor(public readonly pid: number) {
    super(`keeperd lock held by live pid ${pid}; refusing to start`);
    this.name = "LockHeldError";
  }
}

/**
 * Acquire the ownership lock at `lockPath`, reclaiming a stale `sockPath` if
 * the prior holder is dead.
 *
 * - Lock absent → write our pid, return.
 * - Lock present, pid alive (`process.kill(pid, 0)` succeeds) → throw
 *   `LockHeldError`; the caller exits non-zero and launchd backs off.
 * - Lock present, pid dead (`ESRCH`) → stale: unlink the lock AND the socket,
 *   then take ownership.
 * - Lock present but unparseable / `process.kill` denied (`EPERM` — pid alive,
 *   owned by another user) → treat as live and refuse.
 *
 * Acquired BEFORE bind so two instances never race the socket path.
 */
export function acquireLock(lockPath: string, sockPath: string): void {
  const dir = dirname(lockPath);
  if (!existsSync(dir)) {
    // `0700` is the real ACL gate on macOS (socket-file mode may be ignored).
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    // Tighten an existing dir — resolveDbPath's mkdirSync does not set mode.
    try {
      chmodSync(dir, 0o700);
    } catch {
      // best-effort; a pre-existing looser dir is not fatal to boot
    }
  }

  if (existsSync(lockPath)) {
    const text = readFileSync(lockPath, "utf8");
    const pid = Number.parseInt(text.trim(), 10);

    if (Number.isInteger(pid) && pid > 0) {
      if (isPidAlive(pid)) {
        throw new LockHeldError(pid);
      }
      // Stale: prior holder is dead. Unlink lock + socket, then steal.
      unlinkIfExists(lockPath);
      unlinkIfExists(sockPath);
    } else {
      // Unparseable lock — treat conservatively as stale and reclaim.
      unlinkIfExists(lockPath);
      unlinkIfExists(sockPath);
    }
  }

  writeFileSync(lockPath, `${process.pid}\n`, { mode: 0o600 });
}

/**
 * Probe whether `pid` is alive. `process.kill(pid, 0)` sends no signal — it
 * just checks existence/permission:
 * - resolves → alive.
 * - `ESRCH` → no such process (dead).
 * - `EPERM` → process exists but owned by another user → treat as alive.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") {
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Peer-pid capture (macOS LOCAL_PEERPID) — subscribed-ghost eviction
// ---------------------------------------------------------------------------
//
// fn-767's idle sweep DELIBERATELY exempts a subscribed conn (a quiet board is
// legitimately silent — the fn-723 "a ponging orphan is indistinguishable from
// a quiet viewer" descope). That left a hole: a SUBSCRIBED client whose peer
// process is gone (SIGKILL / half-open, no FIN the kernel reports) lingers in
// `conns` forever, costing a serial diff every tick and burning a cap slot.
//
// The peer-pid probe DISTINGUISHES dead-peer from quiet-viewer — exactly what
// ping/pong could not. We capture the client's pid at accept time via
// `getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID)` (macOS UDS), then `reapDeadPeers`
// probes `isPidAlive(pid)` on subscribed conns; a dead peer evicts through the
// existing `sock.end()` path. This is connection hygiene (the fn-723 carve-out),
// matching the exit-watcher's producer-side liveness-probe precedent — NOT
// in-process self-heal, and NEVER keyed on inactivity.
//
// pid-reuse caveat: a recycled pid passing kill(0) leaves a ghost one extra
// lifetime — acceptable (the next death, or the idle/stuck arms, clears it).

// macOS <sys/un.h>: SOL_LOCAL = 0, LOCAL_PEERPID = 0x002 (ABI-stable). The
// option returns the connected peer's pid as a 4-byte int.
const SOL_LOCAL = 0;
const LOCAL_PEERPID = 0x002;

/**
 * Lazily-`dlopen`ed `getsockopt` handle (macOS only). `undefined` = not yet
 * probed; `null` = unavailable on this platform / load failed (the probe then
 * degrades to a no-op so the idle + stuck-pending arms still run). A plain
 * module import never opens it — only the first `peerPidForFd` call does.
 */
let getsockoptLib:
  | { getsockopt: (...args: number[]) => number }
  | null
  | undefined;

function loadGetsockopt(): {
  getsockopt: (...args: number[]) => number;
} | null {
  if (getsockoptLib !== undefined) {
    return getsockoptLib;
  }
  // LOCAL_PEERPID is macOS-only; on any other platform leave the probe inert.
  if (process.platform !== "darwin") {
    getsockoptLib = null;
    return null;
  }
  try {
    // Deferred require so `bun:ffi` is touched only on the production path.
    const { dlopen, FFIType, suffix } =
      require("bun:ffi") as typeof import("bun:ffi");
    const lib = dlopen(`libc.${suffix}`, {
      getsockopt: {
        args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
    });
    getsockoptLib = lib.symbols as unknown as {
      getsockopt: (...args: number[]) => number;
    };
  } catch (err) {
    console.error("[server-worker] LOCAL_PEERPID getsockopt unavailable:", err);
    getsockoptLib = null;
  }
  return getsockoptLib;
}

/**
 * Read the connected peer's pid for socket `fd` via `getsockopt` /
 * `LOCAL_PEERPID` (macOS). Returns `null` when the option is unavailable (non-
 * darwin, load failure, or a `getsockopt` error) — the caller treats a `null`
 * pid as "unknown, never reap on liveness", so a probe failure is benign.
 */
export function peerPidForFd(fd: number): number | null {
  if (!Number.isInteger(fd) || fd < 0) {
    return null;
  }
  const lib = loadGetsockopt();
  if (lib === null) {
    return null;
  }
  try {
    const { ptr } = require("bun:ffi") as typeof import("bun:ffi");
    const out = new Int32Array(1);
    const len = new Uint32Array(1);
    len[0] = 4;
    const rc = lib.getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, ptr(out), ptr(len));
    if (rc !== 0) {
      return null;
    }
    const pid = out[0];
    return pid > 0 ? pid : null;
  } catch {
    // A getsockopt throw (closed fd mid-probe) is benign — treat as unknown.
    return null;
  }
}

export function unlinkIfExists(path: string): void {
  try {
    if (existsSync(path)) {
      unlinkSync(path);
    }
  } catch {
    // best-effort; a leftover file is reclaimed by the next ownership check
  }
}

/**
 * Does the ownership lock at `lockPath` still record OUR pid? A dying stray whose
 * lock a live successor already stole (the successor rewrote the pid) reads false
 * here and MUST NOT unlink the successor's socket. A missing / unparseable lock
 * is "not ours" — ownership can only be proven from our own pid.
 */
export function lockOwnedByUs(lockPath: string): boolean {
  try {
    if (!existsSync(lockPath)) {
      return false;
    }
    const pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid === process.pid;
  } catch {
    return false;
  }
}

/**
 * Ownership-checked teardown: unlink the socket AND the lock ONLY while the lock
 * still records our pid, so a dying stray never unlinks a live successor's socket
 * (which a stale-reclaiming successor may have already rebound under this path).
 */
export function unlinkOwnedSocketAndLock(
  lockPath: string,
  sockPath: string,
): void {
  if (!lockOwnedByUs(lockPath)) {
    return;
  }
  unlinkIfExists(sockPath);
  unlinkIfExists(lockPath);
}

// ---------------------------------------------------------------------------
// Query → result
// ---------------------------------------------------------------------------

/**
 * A resolved exact-match filter: the SQL `WHERE` fragment ("" or "WHERE ...")
 * and its bound parameters. Built ONCE per query (`resolveFilter`) and threaded
 * to BOTH the page SELECT and the membership COUNT+token, so the two can never
 * drift apart.
 */
export interface ResolvedFilter {
  clause: string;
  params: (string | number)[];
}

/**
 * Resolve a `query` frame's wire `filter` map into a SQL `WHERE` clause + bound
 * params, by descriptor map lookup. A wire filter key is only honored if the
 * descriptor declares it (→ a trusted SQL column); the value is bound (`?`). A
 * key absent from `descriptor.filters` is silently ignored (forward-compat).
 *
 * Two value forms: a bare `string | number` is an exact match (`col = ?`); the
 * `{ ne: value }` operator form is a not-equal exclusion (`col != ?`). The
 * operator string (`=` / `!=`) is a fixed literal chosen here, never wire text;
 * an operator object lacking a recognized key is ignored (forward-compat).
 *
 * Default scope: for each key in `descriptor.defaultFilter` the wire query does
 * NOT constrain, the descriptor's default value is applied (e.g. epics default
 * to `status: "open"`, so an unfiltered list hides done/closed epics). A wire
 * value for the key — bare or `{ ne }` — overrides the default for that key. A
 * single-item pk lookup (a detail-page subscribe, `filter:{<pk>}`) is EXEMPT
 * from defaults entirely: it targets one identity and must resolve whatever its
 * status, so the documented "filters include the pk for detail subscribe"
 * invariant holds even for a row outside the default scope.
 *
 * The descriptor is the SOLE identifier-injection gate: only declared columns
 * are interpolated; wire keys are never interpolated, operators are fixed
 * literals, values always bound.
 *
 * `nowSec` (default `Date.now()/1000`) is the wall-clock the optional
 * `descriptor.recencyBound` floor binds against. It is threaded as a param ONLY
 * so tests pin the cutoff deterministically; the live serve path always uses the
 * default. `resolveFilter` is never invoked from a fold, so reading the clock
 * here does not touch re-fold determinism.
 */
export function resolveFilter(
  descriptor: CollectionDescriptor,
  filter: Record<string, FilterValue> | undefined,
  nowSec: number = Date.now() / 1000,
): ResolvedFilter {
  const where: string[] = [];
  const params: (string | number)[] = [];
  // A pk lookup (detail-page single-item subscribe) bypasses the default scope.
  const pkKey = pkFilterKey(descriptor);
  const isPkLookup = pkKey != null && filter?.[pkKey] != null;
  const wireIsEmpty = filter == null || Object.keys(filter).length === 0;
  for (const [key, col] of Object.entries(descriptor.filters)) {
    // Wire value wins; an unconstrained key falls back to the descriptor's
    // default scope, except on a pk lookup (which is exempt from defaults).
    const value =
      filter?.[key] ??
      (isPkLookup ? undefined : descriptor.defaultFilter?.[key]);
    if (value == null) {
      continue;
    }
    if (typeof value === "object") {
      // Operator form. `{ ne }` → `col != ?`; `{ in: [...] }` → `col IN (?, ?)`;
      // `{ not_in: [...] }` → `col NOT IN (?, ?)`. An unrecognized operator
      // object is ignored so a future operator is forward-compatible.
      if ("ne" in value && value.ne != null) {
        where.push(`${col} != ?`);
        params.push(value.ne);
      } else if ("in" in value && Array.isArray(value.in)) {
        if (value.in.length === 0) {
          // Empty IN list matches nothing; emit an always-false guard rather
          // than synthesizing `IN ()` (invalid SQL).
          where.push("0");
        } else {
          const placeholders = value.in.map(() => "?").join(", ");
          where.push(`${col} IN (${placeholders})`);
          params.push(...value.in);
        }
      } else if ("not_in" in value && Array.isArray(value.not_in)) {
        if (value.not_in.length === 0) {
          // Empty NOT IN list excludes nothing; contribute no clause.
          continue;
        }
        const placeholders = value.not_in.map(() => "?").join(", ");
        where.push(`${col} NOT IN (${placeholders})`);
        params.push(...value.not_in);
      }
      continue;
    }
    where.push(`${col} = ?`);
    params.push(value);
  }
  // Raw `defaultClause` fallback (cross-column predicates that don't fit the
  // per-key `defaultFilter` map). Applied only when the wire filter is
  // entirely empty AND this is not a pk lookup — the wire is the user's "I
  // know what I want" override; a pk subscribe is exempt from defaults.
  if (wireIsEmpty && !isPkLookup && descriptor.defaultClause) {
    where.push(descriptor.defaultClause.sql);
    params.push(...descriptor.defaultClause.params);
  }
  // Recency floor — UNLIKE the default scope, it ANDs on top of any wire filter
  // (it bounds history, it is not a default the wire overrides); only a pk
  // lookup is exempt (a per-identity detail read resolves any age). The cutoff
  // is bound (`?`); the column is a descriptor constant, safe to interpolate.
  // Scoping it here threads it into BOTH the page SELECT and the membership
  // `countAndToken` (they share this `ResolvedFilter`), so token/page/COUNT(*)
  // agree on the same window.
  if (descriptor.recencyBound && !isPkLookup) {
    const cutoff = Math.floor(nowSec) - descriptor.recencyBound.windowSec;
    where.push(`${descriptor.recencyBound.column} >= ?`);
    params.push(cutoff);
  }
  return {
    clause: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

/**
 * The wire filter key whose declared column IS the collection's pk (the key a
 * detail-page single-item subscribe uses), or `undefined` if none is declared.
 * Used to exempt a pk lookup from the default scope in {@link resolveFilter}.
 */
function pkFilterKey(descriptor: CollectionDescriptor): string | undefined {
  for (const [key, col] of Object.entries(descriptor.filters)) {
    if (col === descriptor.pk) {
      return key;
    }
  }
  return undefined;
}

/**
 * Page a collection for a `query` frame. Returns the ordered rows plus the
 * world-rev read in the same logical snapshot — both feed the `result` frame
 * and seed the connection's watched-set / `lastSent`. A well-formed `query`
 * naming an unregistered collection returns an `unknown_collection` ErrorFrame
 * (carrying `collection` + `id`) rather than throwing.
 *
 * Everything collection-specific routes through the descriptor: table, column
 * list, pk, the sort allowlist, the default sort, and the filter map. Ordering,
 * filtering, and paging happen in SQL so the page is read in one go.
 *
 * Injection: the sort column is validated against `descriptor.sortable` (an
 * unknown column falls back to `descriptor.defaultSort`); table/columns/pk/sort
 * col are descriptor constants, safe to interpolate. Wire `filter` keys are
 * resolved via `descriptor.filters` by map lookup (never interpolated); values
 * and limit/offset are bound (`?`).
 *
 * Sort direction: when the frame omits `dir`, default to the descriptor's
 * default dir only when the chosen column equals the default column (preserving
 * jobs' "updated_at → desc"), else `asc`.
 *
 * `total`: the filtered-set size (the WHERE only, ignoring limit/offset) plus a
 * membership token are read via ONE `countAndToken` over the SAME resolved
 * filter that built the page SELECT — so the count can't drift from the page,
 * and the result's `total` and the subscription's seeded `lastTotal`/`lastToken`
 * (see `runSubscription`) come from one snapshot. The optional `out` collects
 * the resolved filter + count so the caller seeds ConnState without a re-read.
 *
 * `runQuery` itself is unchanged by fn-698: the dispatch call site wraps it in
 * the per-worldRev result memo (see `serveFromMemo`) so N identical queries at
 * one `worldRev` collapse to ONE `runQuery` call (one SELECT + one serialize),
 * the rest served from the cached entry — `runQuery` runs exactly once per
 * (signature, worldRev) miss.
 */
export function runQuery(
  db: Database,
  worldRev: number,
  frame: QueryFrame,
  out?: { where: ResolvedFilter; total: number; token: string },
  nowSec: number = Date.now() / 1000,
): ResultFrame | ErrorFrame {
  const descriptor = getCollection(frame.collection);
  if (!descriptor) {
    return {
      type: "error",
      ...(frame.id !== undefined ? { id: frame.id } : {}),
      collection: frame.collection,
      rev: worldRev,
      code: "unknown_collection",
      message: `no such collection: ${frame.collection}`,
    };
  }

  const sortCol =
    frame.sort && descriptor.sortable.has(frame.sort.column)
      ? frame.sort.column
      : descriptor.defaultSort.column;
  const dir =
    frame.sort?.dir === "asc" || frame.sort?.dir === "desc"
      ? frame.sort.dir
      : sortCol === descriptor.defaultSort.column
        ? descriptor.defaultSort.dir
        : "asc";

  const limit = clampLimit(frame.limit);
  const offset =
    typeof frame.offset === "number" && frame.offset > 0
      ? Math.floor(frame.offset)
      : 0;

  // Resolve the filter ONCE (descriptor map lookup, bound values) and thread it
  // to BOTH the page SELECT and the membership count below — they can't drift.
  // `nowSec` pins the optional recency cutoff so a memo seed (`serveFromMemo`)
  // and this call share the SAME window — see the threading there.
  const where = resolveFilter(descriptor, frame.filter, nowSec);

  // Staged timing instrumentation — gated by the same module-level `TRACE`
  // const so a `KEEPER_TRACE_SERVER=0` daemon does zero stage work. Ternary
  // -guarded `performance.now()` keeps the const at `0` and elides the
  // syscall when off. Sub-ms resolution; the wall-clock prefix is stamped
  // by `srvTs` from `Date.now()`.
  const _t0 = TRACE ? performance.now() : 0;

  // Filtered-set size + membership token, over the WHERE only (no limit/offset).
  const { total, token } = countAndToken(
    db,
    descriptor,
    where.clause,
    where.params,
  );
  const _t1 = TRACE ? performance.now() : 0;

  // table/columns/pk/sortCol/dir/liveKeyExpr are descriptor constants, never
  // wire text — safe to interpolate. filter values + limit/offset are bound. A wire
  // `limit: 0` ("no limit" sentinel from clampLimit) is rebound as SQLite's
  // `LIMIT -1` — the documented "all remaining rows" form, which still
  // honors `OFFSET` so a paged scan of the full set works the same way.
  const sqlLimit = limit === 0 ? -1 : limit;
  const sql = `
    SELECT ${descriptor.columns.join(", ")}
      FROM ${descriptor.table}
      ${where.clause}
     ORDER BY ${sortCol} ${dir.toUpperCase()}, ${liveKeyExpr(descriptor)} ASC
     LIMIT ? OFFSET ?
  `;
  const rawRows = db
    .prepare(sql)
    .all(...where.params, sqlLimit, offset) as Row[];
  const _t2 = TRACE ? performance.now() : 0;
  // Decode any JSON-TEXT columns so `result` rows carry the same shape as the
  // diff/patch path (`selectByIds`); a no-op while `jsonColumns` is empty.
  const rows = rawRows.map((row) => decodeRow(descriptor, row));
  const _t3 = TRACE ? performance.now() : 0;

  if (out) {
    out.where = where;
    out.total = total;
    out.token = token;
  }

  const result: ResultFrame = {
    type: "result",
    ...(frame.id !== undefined ? { id: frame.id } : {}),
    collection: descriptor.name,
    rev: worldRev,
    total,
    rows,
  };
  const _t4 = TRACE ? performance.now() : 0;

  // `runQuery` is called once per client query (rare relative to tick rate);
  // emit unconditionally when TRACE=1 — no threshold gate needed here. The
  // frame encode stage covers the synchronous Result-frame object build;
  // `writeFrames` byte counts are emitted by its own instrumentation.
  if (TRACE)
    srvTs(
      formatStages({
        op: "runQuery",
        col: descriptor.name,
        rows: rows.length,
        stages: [
          ["countAndToken", (_t1 - _t0).toFixed(2)],
          ["pageSelect", (_t2 - _t1).toFixed(2)],
          ["decodeRow", (_t3 - _t2).toFixed(2)],
          ["frameEncode", (_t4 - _t3).toFixed(2)],
        ],
        total: (_t4 - _t0).toFixed(2),
      }),
    );

  return result;
}

/**
 * Resolve a wire `limit` to a page size: `undefined`/non-finite/negative →
 * `DEFAULT_LIMIT`; `0` → the explicit "no limit" sentinel (diffTick's fan-out
 * scales with page size, so the client opts in deliberately); positive → clamped
 * at `MAX_LIMIT`.
 */
function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0) {
    return DEFAULT_LIMIT;
  }
  if (limit === 0) {
    return 0;
  }
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

// ---------------------------------------------------------------------------
// RPC registry
// ---------------------------------------------------------------------------

const RPC_RUNTIME = createRpcRegistry();

export const RPC_REGISTRY = RPC_RUNTIME.syncHandlers;
export const ASYNC_RPC_REGISTRY = RPC_RUNTIME.asyncHandlers;

export function registerRpc(method: string, handler: RpcHandler): void {
  RPC_RUNTIME.registerSync(method, handler);
}

export function registerAsyncRpc(
  method: string,
  handler: AsyncRpcHandler,
): void {
  RPC_RUNTIME.registerAsync(method, handler);
}

export function unregisterRpc(method: string): void {
  RPC_RUNTIME.unregister(method);
}

export function resetRpcRegistryForTests(): void {
  RPC_RUNTIME.reset();
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Plumbing the dispatch shell forwards to an async RPC handler. `bridge` is the
 * worker→main round-trip surface; `onAsyncResult` writes the eventual frame back
 * on the connection. Both required together. A caller omitting `asyncCtx` keeps
 * the sync-only contract — async-RPC frames return `unknown_method`.
 */
export interface DispatchAsyncCtx {
  bridge: ReplayBridge;
  onAsyncResult: (frames: ServerFrame[]) => void;
}

/**
 * Parse and dispatch ONE NDJSON line. Returns the server frames to send back.
 * NEVER throws on bad input — a malformed/unknown frame yields an `error` frame
 * and the connection stays open.
 *
 * RPC dispatch: an `rpc` frame routes through `RPC_REGISTRY` (sync, run under the
 * WRITER connection) OR `ASYNC_RPC_REGISTRY` (async, via the
 * {@link DispatchAsyncCtx} bridge — returns `[]` immediately, the resolved frame
 * lands via `onAsyncResult`). Every failure path returns an `error` frame:
 * `unknown_method`, `bad_params` (typed throw), `rpc_failed` (any other throw /
 * rejection). An async frame without `asyncCtx` returns `unknown_method`.
 *
 * When a {@link ResultMemo} is threaded in, an identical `query` at the same
 * `worldRev` is served as a single {@link PreSerialized} line; the overload
 * narrows the no-memo return to plain `ServerFrame[]`.
 */
export function dispatchLine(
  db: Database,
  conn: ConnState,
  line: string,
  writerDb?: Database,
  asyncCtx?: DispatchAsyncCtx,
): ServerFrame[];
export function dispatchLine(
  db: Database,
  conn: ConnState,
  line: string,
  writerDb: Database | undefined,
  asyncCtx: DispatchAsyncCtx | undefined,
  memo: ResultMemo,
  bootGate?: BootGate,
): (ServerFrame | PreSerialized)[];
export function dispatchLine(
  db: Database,
  conn: ConnState,
  line: string,
  writerDb?: Database,
  asyncCtx?: DispatchAsyncCtx,
  memo?: ResultMemo,
  bootGate?: BootGate,
): (ServerFrame | PreSerialized)[] {
  if (line.trim().length === 0) {
    return []; // blank keep-alive line — ignore
  }

  let frame: ClientFrame;
  try {
    frame = JSON.parse(line) as ClientFrame;
  } catch {
    return [errorFrame(db, "bad_frame", "line is not valid JSON")];
  }

  if (!frame || typeof frame !== "object" || typeof frame.type !== "string") {
    return [errorFrame(db, "bad_frame", "frame missing string `type`")];
  }

  switch (frame.type) {
    case "query": {
      // `collection` is required and must be a non-empty string. Absent / empty
      // / non-string → bad_frame; a well-formed string naming no descriptor →
      // unknown_collection (decided inside runQuery). Either error leaves the
      // existing subscription intact.
      if (
        typeof frame.collection !== "string" ||
        frame.collection.length === 0
      ) {
        return [
          errorFrame(
            db,
            "bad_frame",
            "query frame missing non-empty string `collection`",
            frame.id,
          ),
        ];
      }
      const worldRev = readWorldRev(db);

      // fn-698 result memo: when N connections issue an identical query at the
      // same worldRev, share ONE runQuery + ONE JSON.stringify and fan out a
      // per-conn PRE-SERIALIZED result line. The whole block is wrapped so any
      // failure DEGRADES to today's un-memoized runQuery + ResultFrame path
      // (`dispatchLine` is no-self-heal — it must never throw). Only attempted
      // when a memo was threaded in (the worker passes it; direct-dispatch
      // tests omit it).
      //
      // Skip the memo while booting so every catch-up query reads its rows
      // directly. At steady state the memo line carries the same boot/Drain
      // header as the object path.
      if (memo && (bootGate === undefined || bootGate.ready)) {
        try {
          const memoResult = serveFromMemo(
            db,
            conn,
            frame,
            worldRev,
            memo,
            bootGate ?? { ready: true },
          );
          if (memoResult) return memoResult;
        } catch (err) {
          // Memo path bug → fall through to the un-memoized path below; never
          // let a memo throw kill the connection.
          if (TRACE)
            srvTs(
              `op=memo stage=throw col=${String(frame.collection)} err=${
                err instanceof Error ? err.message : String(err)
              }`,
            );
        }
      }

      // `seed` collects the resolved filter + count from the SAME read that
      // produced the result's `total`, so the result→first-tick boundary emits
      // no spurious `meta`. (The page-read-vs-count-read snapshot race is
      // accepted — it self-heals on the next tick.)
      const seed = {} as {
        where: ResolvedFilter;
        total: number;
        token: string;
      };
      // runQuery is unchanged; the memo (when present) wraps THIS call so
      // repeated identical queries within a worldRev collapse to one SELECT +
      // one serialize. This is the un-memoized fallback path.
      const out = runQuery(db, worldRev, frame, seed);
      if (out.type !== "result") {
        // unknown_collection (or any error): do NOT mutate the subscription.
        return [out];
      }
      const descriptor = getCollection(out.collection) as CollectionDescriptor;
      // Allocate / replace the subscription atomically (one synchronous block,
      // no await): collection + watched + lastSent + the membership baseline,
      // keyed by the descriptor's pk/version, so no diffTick interleaves stale
      // rows. The slot's key is `frame.id ?? null` — `null` is the anonymous-
      // sub sentinel used by legacy single-sub clients, where subsequent
      // anonymous queries replace this same slot (matching today's "one active
      // subscription" semantic). Id-keyed subs replace per-id and otherwise
      // coexist with every other sub on this connection.
      const subId = frame.id ?? null;
      conn.subs.set(
        subId,
        seedSubState(descriptor, out.collection, out.rows, seed),
      );
      return [out];
    }
    case "unsubscribe": {
      // With `id` → delete just that sub (silent no-op if not found —
      // idempotent, matches HTTP DELETE 404-as-success). Without `id` → clear
      // every sub on this conn (preserves today's "drop the active
      // subscription" semantic for legacy clients).
      if (frame.id !== undefined) {
        conn.subs.delete(frame.id);
      } else {
        conn.subs.clear();
      }
      return [];
    }
    case "rpc": {
      return dispatchRpc(db, frame as RpcFrame, writerDb, asyncCtx, bootGate);
    }
    default: {
      const t = (frame as { type?: unknown }).type;
      return [
        errorFrame(
          db,
          "unknown_type",
          `unsupported frame type: ${String(t)}`,
          (frame as { id?: string }).id,
        ),
      ];
    }
  }
}

/**
 * Dispatch a single RPC frame. Validates shape (`id` and `method` must be
 * non-empty strings — else `bad_frame`, echoing the request id when present),
 * looks up the method (`unknown_method` on miss), invokes the handler with
 * the writer connection inside try/catch, and frames the return as
 * `rpc_result` (or `error` with code `bad_params` / `rpc_failed` on throw).
 *
 * The `id` is echoed on every response frame so a client multiplexing
 * in-flight RPCs can correlate by id alone. The `rev` on `rpc_result` / `error`
 * is the world-rev at frame-construction time — handlers that wrote to the
 * DB will see `rev` reflect their commit on the SAME reader connection used
 * for `rev` reads (the writer commit bumps `data_version`, which the reader
 * picks up on its next prepared-statement execution).
 */
function dispatchRpc(
  db: Database,
  frame: RpcFrame,
  writerDb: Database | undefined,
  asyncCtx: DispatchAsyncCtx | undefined,
  bootGate?: BootGate,
): ServerFrame[] {
  // `id` must be a non-empty string — without it the client can't correlate
  // the response, and we won't echo `undefined` to paper over the omission.
  const rawId = (frame as { id?: unknown }).id;
  const id = typeof rawId === "string" && rawId.length > 0 ? rawId : undefined;

  if (id === undefined) {
    return [
      errorFrame(db, "bad_frame", "rpc frame missing non-empty string `id`"),
    ];
  }

  if (typeof frame.method !== "string" || frame.method.length === 0) {
    return [
      errorFrame(
        db,
        "bad_frame",
        "rpc frame missing non-empty string `method`",
        id,
      ),
    ];
  }

  // fn-897 B1: gate MUTATING RPCs until boot-complete. The read socket comes up
  // during the boot drain, but a state-changing RPC against partially-folded
  // projections (e.g. `set_epic_armed` against unfolded job-link state →
  // phantom-ready dispatch) is the core hazard, so it's enforced HERE at dispatch
  // (not by convention). Reads are served throughout. A `bootGate` of `undefined`
  // (direct-dispatch unit tests) leaves the pre-fn-897 behavior verbatim.
  if (
    bootGate !== undefined &&
    !bootGate.ready &&
    isMutatingRpcMethod(frame.method)
  ) {
    return [
      errorFrame(
        db,
        "server_booting",
        `daemon is still booting (catching up); rpc \`${frame.method}\` rejected until the reducer reaches head and the git surface is seeded`,
        id,
      ),
    ];
  }

  // Try the sync registry first; if there's no sync hit AND the caller
  // wired an async bridge, fall through to the async registry. This order
  // preserves the sync-only contract for existing callers (`asyncCtx ===
  // undefined` collapses async lookups to `unknown_method`, so tests that
  // never wired the bridge keep their pre-fn-643 behavior verbatim).
  const handler = RPC_REGISTRY.get(frame.method);
  if (handler) {
    // Run the handler against the WRITER connection — the server's reader is
    // read-only and will reject INSERTs. Tests may pass `writerDb === undefined`
    // for read-only handlers (in which case we hand the handler the reader,
    // which is enough for a no-op).
    const handlerDb = writerDb ?? db;

    let value: unknown;
    try {
      value = handler(handlerDb, frame.params);
    } catch (err) {
      if (err instanceof BadParamsError) {
        return [errorFrame(db, "bad_params", err.message, id)];
      }
      if (err instanceof SlugConflictError) {
        return [errorFrame(db, "slug_conflict", err.message, id)];
      }
      const message = err instanceof Error ? err.message : String(err);
      return [errorFrame(db, "rpc_failed", message, id)];
    }

    const result: RpcResultFrame = {
      type: "rpc_result",
      id,
      rev: readWorldRev(db),
      value,
    };
    return [result];
  }

  const asyncHandler = ASYNC_RPC_REGISTRY.get(frame.method);
  if (asyncHandler && asyncCtx) {
    // Async path. Fire the handler; on resolution / rejection, frame the
    // result and ship it via `onAsyncResult`. The dispatcher returns []
    // immediately so the sync caller doesn't block — handleData has
    // already returned to the socket-data event loop by the time
    // onAsyncResult fires. The `rev` is read at result-construction time
    // (not at dispatch time) so a recovery write's data_version bump is
    // reflected on the response. Any throw inside the handler synchronous
    // body (a `BadParamsError` raised before the await) AND any promise
    // rejection both flow through the catch.
    void runAsyncRpc(db, id, asyncHandler, frame.params, asyncCtx);
    return [];
  }

  return [
    errorFrame(db, "unknown_method", `no such rpc method: ${frame.method}`, id),
  ];
}

/**
 * Drive an async RPC handler to completion and ship the result frame.
 * Pulled out of `dispatchRpc` for readability — the sync path is the
 * 99% synchronous framing path, while the main-writer bridge RPCs use this
 * helper. Inlining a Promise chain in the middle of the synchronous switch
 * obscured the sync-path control flow.
 *
 * Failure modes that map to `rpc_failed` here:
 * - the handler threw / rejected with a non-`BadParamsError` Error;
 * - the bridge's underlying main-thread post resolved with
 *   `{ok:false, error}` — the handler propagates that as a thrown
 *   Error so this catch frames it uniformly;
 * - the bridge timed out (handler throws an Error with a "no response
 *   from main" message).
 *
 * `BadParamsError` survives as `bad_params` for parity with the sync
 * dispatch.
 */
function runAsyncRpc(
  db: Database,
  id: string,
  handler: AsyncRpcHandler,
  params: unknown,
  asyncCtx: DispatchAsyncCtx,
): void {
  void (async () => {
    let value: unknown;
    try {
      value = await handler(params, asyncCtx.bridge);
    } catch (err) {
      if (err instanceof BadParamsError) {
        asyncCtx.onAsyncResult([errorFrame(db, "bad_params", err.message, id)]);
        return;
      }
      if (err instanceof SlugConflictError) {
        asyncCtx.onAsyncResult([
          errorFrame(db, "slug_conflict", err.message, id),
        ]);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      asyncCtx.onAsyncResult([errorFrame(db, "rpc_failed", message, id)]);
      return;
    }
    const result: RpcResultFrame = {
      type: "rpc_result",
      id,
      rev: readWorldRev(db),
      value,
    };
    asyncCtx.onAsyncResult([result]);
  })();
}

function errorFrame(
  db: Database,
  code: string,
  message: string,
  id?: string,
): ErrorFrame {
  return {
    type: "error",
    ...(id !== undefined ? { id } : {}),
    rev: readWorldRev(db),
    code,
    message,
  };
}

/** One-shot world-rev read used by error/result framing. */
function readWorldRev(db: Database): number {
  const row = db
    .prepare("SELECT last_event_id FROM reducer_state WHERE id = 1")
    .get() as { last_event_id: number } | null;
  return row ? row.last_event_id : 0;
}

/**
 * Per-worker-instance boot gate (fn-897 B1). `ready` flips `true` when main posts
 * `{type:"boot-complete"}` after drain-reaches-head + git-seed + ephemeral-truncate.
 * Until then mutating RPCs are rejected `server_booting` and every served frame
 * carries `catching_up: true`. An object (not a bare boolean) so the dispatch and
 * framing closures share one mutable latch by reference.
 */
export interface BootGate {
  ready: boolean;
  identity?: DaemonBootIdentity;
  /**
   * Per-daemon-boot nonce (see {@link BootStatus.generation}), equal to the
   * parent-owned durable boot id in production. Optional so direct unit gates
   * needn't carry an identity; omission keeps the reconnect fallback active.
   */
  generation?: string;
}

/**
 * Read the {@link BootStatus} header for the current frame (fn-897 B1).
 * Three cheap singleton reads on the reader connection:
 *   - `rev` = `reducer_state.last_event_id` (the global fold cursor).
 *   - `head_event_id` = `max(events.id)` (the newest ingested event; 0 on empty).
 *   - `git_seed_required` = `git_projection_state.seed_required != 0` (the live-only
 *     git surface has not been boot-seeded, so it reads EMPTY).
 * `catching_up` is driven only by the authoritative main-owned boot gate plus
 * pending git seed. `rev`/`head_event_id` stay on the wire as telemetry, but a
 * steady-state one-event `rev < head_event_id` tail is normal because append and
 * fold are separate transactions; it is not itself a boot catch-up signal. Pure
 * read; never throws into the dispatch path (the caller is no-self-heal), so each
 * read defends against a missing row.
 */
export function readBootStatus(db: Database, gate: BootGate): BootStatus {
  let rev = 0;
  let head = 0;
  let seedRequired = false;
  try {
    const r = db
      .prepare("SELECT last_event_id FROM reducer_state WHERE id = 1")
      .get() as { last_event_id: number } | null;
    rev = r ? r.last_event_id : 0;
  } catch {
    rev = 0;
  }
  try {
    const h = db.prepare("SELECT MAX(id) AS head FROM events").get() as {
      head: number | null;
    } | null;
    head = h && h.head !== null ? h.head : 0;
  } catch {
    head = 0;
  }
  try {
    const g = db
      .prepare("SELECT seed_required FROM git_projection_state WHERE id = 1")
      .get() as { seed_required: number } | null;
    // Absent row → treat as unseeded (the conservative default — never report
    // "clean" for a surface we can't confirm is seeded).
    seedRequired = g == null ? true : g.seed_required !== 0;
  } catch {
    seedRequired = true;
  }
  // fn-905: the per-root refinement. Only compute the unseeded set while the
  // coarse flag is SET — clear ⇒ empty (the gate is fully off, bounded to the
  // `seed_required`-set window). Defensive: a probe failure degrades to an empty
  // set, which only over-dispatches in the brief unseeded window — never throws
  // into the read path (the caller is no-self-heal).
  // fn-954: stamp the per-root dispatch concurrency count N so the board computes
  // the SAME per-root demotions as the reconciler. This is the EFFECTIVE cap the
  // wire field publishes (stored intent does NOT cross the wire): derive the
  // folded `autopilot_state` stored `max_concurrent_per_root` through
  // `effectivePerRootCap` against the SAME row's `worktree_mode` — worktree off ⇒
  // 1, on ⇒ the stored positive integer, else the default. The SELECT MUST read
  // `worktree_mode`; omit it and the derivation sees an absent column and floors
  // to 1 forever. Defensive — a probe failure degrades to the default; never
  // throws into the read path.
  let maxConcurrentPerRoot = DEFAULT_MAX_CONCURRENT_PER_ROOT;
  try {
    const a = db
      .prepare(
        "SELECT max_concurrent_per_root, worktree_mode FROM autopilot_state WHERE id = 1",
      )
      .get() as {
      max_concurrent_per_root: number | null;
      worktree_mode: number | null;
    } | null;
    maxConcurrentPerRoot = effectivePerRootCap(
      a?.max_concurrent_per_root,
      a?.worktree_mode === 1,
    );
  } catch {
    maxConcurrentPerRoot = DEFAULT_MAX_CONCURRENT_PER_ROOT;
  }
  let unseededRoots: string[] = [];
  if (seedRequired) {
    try {
      unseededRoots = Array.from(
        // fn-921: normalize the gated read key to the toplevel write key so a
        // subdir/symlink `target_repo` is not falsely reported unseeded
        // (memoized — one resolve per distinct gated root).
        unseededGatedRoots(
          db,
          readGitProjectionFloor(db),
          memoizedGitToplevel(),
        ),
      );
    } catch {
      unseededRoots = [];
    }
  }
  return {
    ...(gate.identity === undefined ? {} : gate.identity),
    rev,
    head_event_id: head,
    // Catch-up is owned by main's boot gate plus pending git seed. `rev<head`
    // remains useful telemetry on the wire, but in steady state append and fold
    // routinely straddle separate transactions for one event, so that tail is
    // not itself a boot catch-up condition.
    catching_up: !gate.ready || seedRequired,
    // Coarse boolean (drives `catching_up` + the coarse git-clean consumer).
    git_seed_required: seedRequired,
    // Per-root refinement so the board renders the SAME per-root `unknown` the
    // autopilot dispatches against.
    git_unseeded_roots: unseededRoots,
    // fn-954: the EFFECTIVE per-root dispatch concurrency count so the board
    // demotes the SAME way the reconciler does (stored intent stays server-side).
    max_concurrent_per_root: maxConcurrentPerRoot,
    // The epoch guard: the per-boot nonce off the gate (omitted when the gate
    // carries none — e.g. a unit gate — so the client keeps its always-
    // re-baseline-on-reconnect fallback).
    ...(gate.generation === undefined ? {} : { generation: gate.generation }),
  };
}

/**
 * The most recent boot's measured catch-up window, as durably recorded by
 * `daemon.ts` (a producer) right before it posts `boot-complete`. Mirrors
 * {@link EventStoreLastBootCatchup} but keeps the raw start/end samples the
 * daemon wrote, so {@link computeEventStoreStatus} can derive BOTH the observed
 * duration and a live "since-last-boot" catch-up projection from one row.
 */
export interface BootCatchupStats {
  startedAtMs: number;
  completedAtMs: number;
  startEventId: number;
  endEventId: number;
  /**
   * Pace-free accumulated fold-work over this boot's window (fn-1313), or `null`
   * when the row predates the column or carried no measurement. Feeds the
   * full-replay projection's rate; the catch-up projection stays on the
   * wall-clock `completedAtMs - startedAtMs`.
   */
  workMs: number | null;
}

/**
 * Read the `boot_catchup_stats` singleton (fn-1311). `null` when the row is
 * absent — a fresh DB, or a binary that booted before this table existed and
 * hasn't completed a boot since upgrading. Pure read; never throws (the caller
 * is no-self-heal), mirroring every other singleton read in
 * {@link readBootStatus}.
 */
function readBootCatchupStats(db: Database): BootCatchupStats | null {
  const row = db
    .query(
      "SELECT started_at, completed_at, start_event_id, end_event_id, fold_work_ms FROM boot_catchup_stats WHERE id = 1",
    )
    .get() as {
    started_at: number;
    completed_at: number;
    start_event_id: number;
    end_event_id: number;
    fold_work_ms: number | null;
  } | null;
  if (row === null) {
    return null;
  }
  return {
    startedAtMs: row.started_at,
    completedAtMs: row.completed_at,
    startEventId: row.start_event_id,
    endEventId: row.end_event_id,
    workMs: row.fold_work_ms,
  };
}

/**
 * Derive the event-store status block (fn-1311, fn-1313) from a durable
 * boot-catchup observation plus the current cheap live reads. PURE — no
 * wall-clock probe, no DB access — so this is the seam `test/status.test.ts`
 * exercises with injected observations.
 *
 * The two projections derive from DIFFERENT rates (ADR 0075):
 *
 *   - The CATCH-UP projection keeps the WALL-CLOCK rate
 *     (`duration_ms / events_folded`) scaled by the events accumulated since
 *     that boot completed (`headEventId - stats.endEventId`, floored at 0):
 *     pacing is real experienced catch-up latency.
 *   - The FULL-REPLAY projection derives ONLY from the pace-free fold-work
 *     rate (`stats.workMs / events_folded`) scaled by the CURRENT total
 *     `eventCount`: an estimator of a from-scratch rebuild, whose folds run
 *     unpaced. It is `null` unless `workMs` is a positive measurement — a
 *     missing, zero, or negative `workMs` reads as "not measured", NEVER a
 *     zero or the paced-rate extrapolation. It is also `null` when
 *     `events_folded < 1000`: the total-event-count multiplier can amplify a
 *     small sample's noise without bound. Catch-up has no floor because its
 *     pending-events multiplier is small and bounded.
 *
 * `stats` absent, or its `events_folded` non-positive (a boot that folded zero
 * or a negative/malformed delta — defensive against a torn row), leaves both
 * projected durations `null`: the shared denominator is undefined. A
 * non-positive `duration_ms` additionally nulls just the catch-up leg.
 */
export function computeEventStoreStatus(
  stats: BootCatchupStats | null,
  eventCount: number,
  dbBytes: number,
  headEventId: number,
): EventStoreStatus {
  if (stats === null) {
    return {
      event_count: eventCount,
      db_bytes: dbBytes,
      last_boot_catchup: null,
      projected_catchup_duration_ms: null,
      projected_full_replay_duration_ms: null,
    };
  }
  const durationMs = stats.completedAtMs - stats.startedAtMs;
  const eventsFolded = stats.endEventId - stats.startEventId;
  const lastBootCatchup = {
    duration_ms: durationMs,
    events_folded: eventsFolded,
  };
  if (eventsFolded <= 0) {
    return {
      event_count: eventCount,
      db_bytes: dbBytes,
      last_boot_catchup: lastBootCatchup,
      projected_catchup_duration_ms: null,
      projected_full_replay_duration_ms: null,
    };
  }
  const pendingSinceLastBoot = Math.max(0, headEventId - stats.endEventId);
  // Catch-up: wall-clock rate. Null when the wall-clock window is non-positive.
  const projectedCatchupMs =
    durationMs > 0
      ? Math.round((durationMs / eventsFolded) * pendingSinceLastBoot)
      : null;
  // Full-replay: pace-free fold-work rate only. Null-honest below the 1000-event
  // sample floor or without positive work — never a paced-rate extrapolation.
  const projectedFullReplayMs =
    stats.workMs !== null && stats.workMs > 0 && eventsFolded >= 1000
      ? Math.round((stats.workMs / eventsFolded) * eventCount)
      : null;
  return {
    event_count: eventCount,
    db_bytes: dbBytes,
    last_boot_catchup: lastBootCatchup,
    projected_catchup_duration_ms: projectedCatchupMs,
    projected_full_replay_duration_ms: projectedFullReplayMs,
  };
}

/**
 * Read the live {@link EventStoreStatus} block (fn-1311) — event count + DB
 * byte size are cheap live reads; the head cursor and durable `boot_catchup_stats`
 * observation feed the two pure projected durations via
 * {@link computeEventStoreStatus}. Delivered on the `result` frame's
 * `event_store` field (NOT the boot header), so a caught-up daemon whose
 * memoized reply omits the header still serves the block. Each sub-read is
 * independently defended so a missing/corrupt piece degrades to the null-honest
 * shape rather than throwing into the no-self-heal serve path.
 */
export function readEventStoreStatus(db: Database): EventStoreStatus {
  let head = 0;
  try {
    const h = db.prepare("SELECT MAX(id) AS head FROM events").get() as {
      head: number | null;
    } | null;
    head = h && h.head !== null ? h.head : 0;
  } catch {
    head = 0;
  }
  let eventCount = 0;
  try {
    const c = db.query("SELECT COUNT(*) AS n FROM events").get() as {
      n: number;
    } | null;
    eventCount = c ? c.n : 0;
  } catch {
    eventCount = 0;
  }
  let dbBytes = 0;
  try {
    const pc = db.query("PRAGMA page_count").get() as {
      page_count: number;
    } | null;
    const ps = db.query("PRAGMA page_size").get() as {
      page_size: number;
    } | null;
    dbBytes = (pc?.page_count ?? 0) * (ps?.page_size ?? 0);
  } catch {
    dbBytes = 0;
  }
  let catchupStats: BootCatchupStats | null = null;
  try {
    catchupStats = readBootCatchupStats(db);
  } catch {
    catchupStats = null;
  }
  return computeEventStoreStatus(catchupStats, eventCount, dbBytes, head);
}

/**
 * Stamp the boot-status header onto every object-form served frame
 * (`result` / `rpc_result` / `error`) in place. A {@link PreSerialized} memo
 * line already carries the header assembled by {@link buildResultLine}. Mutates
 * and returns the same array so callers can inline it. Computes the status once.
 */
function stampBootStatus(
  db: Database,
  gate: BootGate,
  frames: (ServerFrame | PreSerialized)[],
): (ServerFrame | PreSerialized)[] {
  if (frames.length === 0) {
    return frames;
  }
  const boot = readBootStatus(db, gate);
  for (const f of frames) {
    if (isPreSerialized(f)) {
      continue;
    }
    if (f.type === "result" || f.type === "rpc_result" || f.type === "error") {
      f.boot = boot;
    }
  }
  return frames;
}

/**
 * Stamp the event-store block (fn-1311) onto every object-form `result` frame in
 * place — the catch-up-path sibling of the memo line's baked block (see
 * {@link buildResultLine}), so a consumer reads the same field on either path.
 * A {@link PreSerialized} memo line already carries its own block and is skipped.
 * The (`COUNT(*)` + `PRAGMA`) read fires once per call and only when there is an
 * object `result` frame to carry it. Ride the `result` frame only;
 * `rpc_result` / `error` are not snapshot surfaces.
 */
function stampEventStore(
  db: Database,
  frames: (ServerFrame | PreSerialized)[],
): (ServerFrame | PreSerialized)[] {
  let eventStore: EventStoreStatus | null = null;
  for (const f of frames) {
    if (isPreSerialized(f)) {
      continue;
    }
    if (f.type === "result") {
      if (eventStore === null) {
        eventStore = readEventStoreStatus(db);
      }
      f.event_store = eventStore;
    }
  }
  return frames;
}

// ---------------------------------------------------------------------------
// Backpressure-aware write
// ---------------------------------------------------------------------------

/**
 * A minimal write interface — just the surface `writeFrames`/`resumePending`
 * touch — so the unit layer can drive backpressure with a fake socket without
 * a real `Bun.Socket`.
 */
export interface Writable {
  write(data: Uint8Array, byteOffset?: number, byteLength?: number): number;
  /**
   * Close the connection (reaper path). Optional because a test `fakeSock` may
   * omit it; the real Bun socket always has `.end()` at runtime. Eviction calls
   * `sock.end()`; the Bun `close` handler then `conns.delete`s.
   */
  end?(): void;
  data: ConnState;
}

const encoder = new TextEncoder();

/**
 * Encode one dispatch element to its NDJSON line. A {@link PreSerialized}
 * sentinel is written VERBATIM (its `__line` is already a complete line) so a
 * re-encode never re-stringifies a large cached rows blob; every other frame
 * routes through `encodeFrame`.
 */
function encodeFrameOrLine(f: ServerFrame | PreSerialized): string {
  return isPreSerialized(f) ? f.__line : encodeFrame(f);
}

/**
 * Best-effort collection label for the `op=writeFrames` trace line; degrades to
 * `"?"` for frames that don't carry a collection. Pure read of the frames.
 */
function firstFrameCollection(frames: (ServerFrame | PreSerialized)[]): string {
  const first = frames[0] as { collection?: unknown } | undefined;
  return first && typeof first.collection === "string" ? first.collection : "?";
}

/**
 * Write a batch of server frames to the socket with backpressure handling.
 * Encodes to one UTF-8 buffer, then writes from `pending.offset`. Bun's
 * `socket.write()` returns BYTES ACCEPTED — may be `< length` (buffer full) or
 * `0`; a negative return means the socket is closing (drop). On a short write
 * we stash the unaccepted tail in `conn.pending` and resume in `drain`.
 *
 * If a `pending` write is already stashed, the new frames are appended to it
 * rather than racing ahead — preserves frame order on the wire.
 */
export function writeFrames(
  sock: Writable,
  frames: (ServerFrame | PreSerialized)[],
): void {
  if (frames.length === 0 && !sock.data.pending) {
    return;
  }
  let buf: Uint8Array;
  let offset: number;
  if (sock.data.pending) {
    // Append new frames behind the still-pending tail.
    const tail = sock.data.pending.bytes.subarray(sock.data.pending.offset);
    const extra =
      frames.length > 0
        ? encoder.encode(frames.map(encodeFrameOrLine).join(""))
        : new Uint8Array(0);
    buf = new Uint8Array(tail.length + extra.length);
    buf.set(tail, 0);
    buf.set(extra, tail.length);
    offset = 0;
  } else {
    buf = encoder.encode(frames.map(encodeFrameOrLine).join(""));
    offset = 0;
  }

  // Stage-trace large frame batches BEFORE flush so the recorded byte count is
  // the encoded payload, not what hit the wire after a backpressure stash.
  // Threshold-gated; the TRACE env gate short-circuits first.
  if (TRACE && buf.length >= TRACE_FRAME_BYTES)
    srvTs(
      `op=writeFrames col=${firstFrameCollection(frames)} bytes=${buf.length} frames=${frames.length}`,
    );

  flush(sock, buf, offset);
}

/**
 * Resume a stashed partial write after a `drain` event. No-op if nothing is
 * pending.
 */
export function resumePending(sock: Writable): void {
  const p = sock.data.pending;
  if (!p) {
    return;
  }
  sock.data.pending = null;
  flush(sock, p.bytes, p.offset);
}

function flush(sock: Writable, buf: Uint8Array, startOffset: number): void {
  let offset = startOffset;
  while (offset < buf.length) {
    const wrote = sock.write(buf, offset, buf.length - offset);
    if (wrote <= 0) {
      // 0 → buffer full (backpressure); negative → socket closing.
      if (wrote < 0) {
        // Socket is closing/closed (EPIPE/ECONNRESET on a diff write — normal,
        // NOT an error). Drop the rest AND evict (fn-723 task .2): the dead
        // socket must leave `conns` or it costs a serial diff every tick. We
        // `end()` here and rely on the Bun `close` handler (:open/close in
        // startServer) to `conns.delete`; the close handler is idempotent.
        sock.data.pending = null;
        sock.data.pendingSince = null;
        sock.end?.();
        return;
      }
      // Stash the remainder; drain() resumes it. Stamp `pendingSince` only on
      // the null → non-null transition so the stuck-pending TTL measures from
      // when backpressure BEGAN, not from each subsequent partial write.
      sock.data.pending = { bytes: buf, offset };
      if (sock.data.pendingSince === null) {
        sock.data.pendingSince = Date.now();
      }
      return;
    }
    offset += wrote;
  }
  // Fully drained: clear both the buffer and the backpressure clock.
  sock.data.pending = null;
  sock.data.pendingSince = null;
}

// ---------------------------------------------------------------------------
// Realtime poll → diff → patch
// ---------------------------------------------------------------------------

/**
 * Read the singleton world rev once per tick. Same shape as `readWorldRev` but
 * named for the poll path so the call site reads as "rev stamped on this
 * tick's frames".
 */
function readWorldRevOnce(db: Database): number {
  return readWorldRev(db);
}

/**
 * Release per-connection state and drop the socket from the live `conns` set
 * SYNCHRONOUSLY. Idempotent: a second call (the later async Bun `close` event,
 * or a double reap) is a harmless no-op — `Set.delete` on an absent member does
 * nothing and the cleared `ConnState` fields are already null. Threaded into the
 * reapers so a cap-hit sweep can recheck a TRUE `conns.size` before deciding to
 * accept; the Bun `close` handler reuses it so the deferred close stays a no-op.
 */
export function freeConn(conns: Set<Writable>, sock: Writable): void {
  conns.delete(sock);
  flushConnDecoder(sock.data);
  sock.data.subs.clear();
  sock.data.pending = null;
  sock.data.pendingSince = null;
}

/**
 * Evict one connection: synchronously free it from `conns` (when the set is in
 * scope) THEN close the wire. The free runs first so the post-sweep `conns.size`
 * recheck is true the instant this returns; `sock.end()` is wrapped so a throw
 * can never abort the reap of sibling conns (no-self-heal). `conns` is optional —
 * the `diffTick`/`handleKick` callers hold only an `Iterable` and rely on the
 * async `close` handler to delete, exactly as before.
 */
function evictConn(sock: Writable, conns?: Set<Writable>): void {
  if (conns) {
    freeConn(conns, sock);
  }
  try {
    sock.end?.();
  } catch (err) {
    // No-self-heal: a failed end() must not abort the reap of sibling conns.
    console.error(
      `[server-worker] evict end() failed for conn ${sock.data.id ?? -1}:`,
      err,
    );
  }
}

/**
 * Evict connections backpressured past {@link STUCK_PENDING_TTL_MS}. Fires ONLY
 * on a genuinely stuck buffer (`pendingSince` aged past the ceiling) — a quiet
 * receive-only subscriber has `pending === null` and is never touched.
 * Eviction is `sock.end()` (the Bun `close` handler then `conns.delete`s,
 * idempotent), per-conn try/catch'd so one throw can't abort the rest.
 */
function reapStuckPending(list: Writable[], conns?: Set<Writable>): void {
  const now = Date.now();
  for (const sock of list) {
    const since = sock.data.pendingSince;
    if (since === null || now - since < STUCK_PENDING_TTL_MS) {
      continue;
    }
    console.error(
      `[server-worker] reaping stuck-pending conn ${sock.data.id ?? -1} ` +
        `(backpressured ${now - since}ms > ${STUCK_PENDING_TTL_MS}ms ceiling)`,
    );
    evictConn(sock, conns);
  }
}

/**
 * Evict a connection carrying ZERO subscriptions whose last inbound activity is
 * older than {@link IDLE_CONN_TTL_MS} — the leak the EPIPE-evict and
 * stuck-pending TTL both miss (a one-shot probe that dies silently). SUBSCRIPTION-
 * EXEMPT BY CONSTRUCTION: a conn with a non-empty `subs` map is never swept (a
 * legit board may sit silent during a DB-quiet period). Eviction + per-conn
 * try/catch as in `reapStuckPending`.
 */
function reapIdleConns(list: Writable[], conns?: Set<Writable>): void {
  const now = Date.now();
  for (const sock of list) {
    // Subscribed conns are exempt — a quiet board is legitimately silent.
    if (sock.data.subs.size > 0) {
      continue;
    }
    if (now - sock.data.lastActivityAt < IDLE_CONN_TTL_MS) {
      continue;
    }
    console.error(
      `[server-worker] reaping idle zero-sub conn ${sock.data.id ?? -1} ` +
        `(idle ${now - sock.data.lastActivityAt}ms > ${IDLE_CONN_TTL_MS}ms ceiling, ` +
        `no subscriptions)`,
    );
    evictConn(sock, conns);
  }
}

/**
 * Evict ANY connection whose peer process is gone — subscribed OR zero-sub.
 * Probes `isPidAlive(peerPid)` keyed on PROCESS LIVENESS, never on inactivity,
 * so a quiet-but-alive viewer is never touched. Distinguishes dead-peer from
 * quiet-viewer — exactly what the fn-723 ping/pong descope said ping could not.
 *
 * The ZERO-SUB case is the load-bearing arm: a one-shot query / reconnect-probe
 * client that is SIGKILLed (or half-opens — macOS UDS reports no FIN) leaves a
 * zero-sub conn whose `lastActivityAt` is frozen but NOT yet past the 5-minute
 * {@link IDLE_CONN_TTL_MS}. Under a reconnect storm such dead conns refill the
 * table far faster than the idle TTL clears them, wedging the cap with garbage
 * the sweep "can't" reap. Liveness, not inactivity, makes them reapable AT ONCE.
 *
 * A `null` peerPid (probe unavailable — non-darwin, or a getsockopt failure) is
 * NEVER reaped here: the idle + unengaged + stuck-pending arms remain the
 * backstop. Per-conn try/catch as in the sibling reapers.
 */
function reapDeadPeers(list: Writable[], conns?: Set<Writable>): void {
  for (const sock of list) {
    const pid = sock.data.peerPid;
    // Unknown pid (null/undefined) → never reap on liveness (degrade to the
    // other arms). `== null` catches a ConnState built without the field too.
    if (pid == null) {
      continue;
    }
    if (isPidAlive(pid)) {
      continue;
    }
    console.error(
      `[server-worker] reaping dead-peer conn ${sock.data.id ?? -1} ` +
        `(peer pid ${pid} gone; ${sock.data.subs.size} sub(s))`,
    );
    evictConn(sock, conns);
  }
}

/**
 * Evict a zero-sub connection that has done NOTHING — never subscribed, never
 * dispatched a single frame — past {@link UNENGAGED_CONN_TTL_MS} of its
 * `connectedAt`. The fast arm against a reconnect storm of LIVE-peer conns the
 * dead-peer sweep can't touch (the client is alive, just re-dialing without
 * speaking) and that the 5-minute idle TTL clears far too slowly.
 *
 * SAFE for a slow cold-boot query: `everEngaged` flips true the instant the
 * query FRAME lands (in `handleData`, before main computes the multi-second
 * reply), so a conn with work in flight is exempt. Subscribed conns (`subs.size
 * > 0`) are exempt by construction — a quiet board is legitimately silent.
 * Keyed on the IMMUTABLE `connectedAt`, so a noise-chunk stream can't defer it.
 */
function reapUnengaged(list: Writable[], conns?: Set<Writable>): void {
  const now = Date.now();
  for (const sock of list) {
    if (sock.data.subs.size > 0 || sock.data.everEngaged) {
      continue;
    }
    if (now - sock.data.connectedAt < UNENGAGED_CONN_TTL_MS) {
      continue;
    }
    console.error(
      `[server-worker] reaping unengaged conn ${sock.data.id ?? -1} ` +
        `(connected ${now - sock.data.connectedAt}ms ago, no subscribe/query)`,
    );
    evictConn(sock, conns);
  }
}

/**
 * Evict a SUBSCRIBED connection whose inbound engagement has ceased past
 * {@link SUBSCRIBED_SILENCE_TTL_MS} — the abandoned-but-alive ghost the dead-peer,
 * unengaged, and idle sweeps all miss: it holds live subscriptions (idle sweep
 * exempts it), its peer process is still alive (dead-peer sweep skips it), and it
 * long-ago engaged (unengaged sweep skips it). It generates no backpressure in a
 * DB-quiet window (stuck-pending is inert), so nothing else touches it while every
 * diff tick pays its fan-out.
 *
 * POSITIVE abandonment evidence, never push-side silence: a live `subscribeReadiness`
 * viewer refreshes `lastActivityAt` via a heartbeat probe at least every 15s (see
 * {@link SUBSCRIBED_SILENCE_TTL_MS}), so a healthy quiet board is never past this
 * ceiling. Zero-sub conns are OUT of scope (the idle/unengaged arms own them);
 * this arm is the subscribed-conn analog keyed on the client's heartbeat contract.
 * Per-conn try/catch via `evictConn`, exactly as the sibling reapers.
 */
function reapAbandonedSubs(list: Writable[], conns?: Set<Writable>): void {
  const now = Date.now();
  for (const sock of list) {
    // Only subscribed conns — zero-sub is the idle/unengaged sweeps' domain.
    if (sock.data.subs.size === 0) {
      continue;
    }
    if (now - sock.data.lastActivityAt < SUBSCRIBED_SILENCE_TTL_MS) {
      continue;
    }
    console.error(
      `[server-worker] reaping abandoned-sub conn ${sock.data.id ?? -1} ` +
        `(subscribed, inbound-silent ${now - sock.data.lastActivityAt}ms > ` +
        `${SUBSCRIBED_SILENCE_TTL_MS}ms heartbeat ceiling; ${sock.data.subs.size} sub(s))`,
    );
    evictConn(sock, conns);
  }
}

/**
 * Count live connections sharing a peer pid — the admission-control predicate
 * behind {@link PER_PID_MAX_CONNECTIONS}. Pure read over the conn set.
 */
export function pidConnCount(conns: Iterable<Writable>, pid: number): number {
  let n = 0;
  for (const sock of conns) {
    if (sock.data.peerPid === pid) {
      n++;
    }
  }
  return n;
}

/**
 * Whether a connection is the daemon's OWN — its peer pid equals this process's
 * pid. Main's serve-liveness probe connects to a worker thread in the SAME
 * process, so its peer pid IS the daemon pid; those conns are exempt from the
 * per-pid cap (a self-probe must never be cap-rejected into a false death) and
 * censused in a distinct `self` bucket. Precise by design — an exact pid match
 * only, never a broad exemption that would re-open the cap the reapers rely on.
 */
export function isDaemonSelfConn(
  peerPid: number | null,
  selfPid: number,
): boolean {
  return peerPid != null && peerPid === selfPid;
}

/**
 * A connection's census view — the `socket.data` fields the cap census reads,
 * narrowed so the pure seam takes plain objects in tests (no real socket).
 */
export type CensusConnView = {
  data: Pick<
    ConnState,
    | "peerPid"
    | "pending"
    | "subs"
    | "everEngaged"
    | "connectedAt"
    | "lastActivityAt"
  >;
};

/** Cap-census bucket counts ({@link censusConns}). */
export interface ConnCensus {
  total: number;
  /**
   * The daemon's OWN connections (peer pid == daemon pid) — self-probes, exempt
   * from the per-pid cap and never peer-liveness-reaped. Broken out so a cap
   * census settles whether the capped peers are our probes or external clients.
   */
  self: number;
  pending: number;
  zeroSub: number;
  zeroSubDead: number;
  zeroSubUnengaged: number;
  subLive: number;
  subDead: number;
  subUnknown: number;
  /**
   * Subscribed conns whose inbound engagement has ceased past the heartbeat
   * ceiling — the abandoned-but-alive ghosts {@link reapAbandonedSubs} evicts. A
   * NON-EXCLUSIVE sub-count (mirrors `zeroSubDead`): counted IN ADDITION to the
   * conn's `subLive`/`subDead`/`subUnknown` classification, never into `total`.
   */
  subAbandoned: number;
}

/**
 * Classify a connection set into the cap-census buckets. Pure — `isPidAlive` and
 * the clock are injected — so the fast tier covers the bucketing (including the
 * `self` bucket) without a real socket. {@link logCapCensus} formats the result.
 * Buckets mirror the reaper arms: `pending` (backpressured — stuck-pending
 * candidate), `zero_sub` (idle-sweep candidate), `sub_live` (subscribed, peer
 * alive — the protected board), `sub_dead` (subscribed, peer gone — dead-peer
 * candidate), `sub_unknown` (subscribed, peerPid null — never liveness-reaped),
 * `sub_abandoned` (subscribed, inbound-silent past `subscribedSilenceTtlMs` — the
 * abandoned-but-alive candidate, a non-exclusive sub-count), with `self` pulled
 * out ahead of all of them.
 */
export function censusConns(
  conns: Iterable<CensusConnView>,
  opts: {
    selfPid: number;
    nowMs: number;
    unengagedTtlMs: number;
    subscribedSilenceTtlMs: number;
    isPidAlive: (pid: number) => boolean;
  },
): ConnCensus {
  const c: ConnCensus = {
    total: 0,
    self: 0,
    pending: 0,
    zeroSub: 0,
    zeroSubDead: 0,
    zeroSubUnengaged: 0,
    subLive: 0,
    subDead: 0,
    subUnknown: 0,
    subAbandoned: 0,
  };
  for (const sock of conns) {
    c.total++;
    const pid = sock.data.peerPid;
    // The daemon's own conns are exempt from the per-pid cap and never reaped on
    // peer-liveness — count them apart from external clients and skip the rest.
    if (isDaemonSelfConn(pid, opts.selfPid)) {
      c.self++;
      continue;
    }
    if (sock.data.pending !== null) {
      c.pending++;
    }
    const dead = pid != null && !opts.isPidAlive(pid);
    if (sock.data.subs.size === 0) {
      c.zeroSub++;
      if (dead) {
        c.zeroSubDead++;
      } else if (
        !sock.data.everEngaged &&
        opts.nowMs - sock.data.connectedAt >= opts.unengagedTtlMs
      ) {
        c.zeroSubUnengaged++;
      }
      continue;
    }
    if (pid == null) {
      c.subUnknown++;
    } else if (dead) {
      c.subDead++;
    } else {
      c.subLive++;
    }
    // Non-exclusive sub-count (mirrors zeroSubDead): a subscribed conn whose
    // inbound engagement has ceased past the heartbeat ceiling is the
    // abandoned-but-alive ghost, counted ON TOP of its live/dead/unknown class.
    if (opts.nowMs - sock.data.lastActivityAt >= opts.subscribedSilenceTtlMs) {
      c.subAbandoned++;
    }
  }
  return c;
}

/**
 * Log a one-line conn-state census on a cap-hit, classifying every live conn so
 * the reason the sweep did or did not recover a slot is attributable from one log
 * line (the diagnostic the 2026-06-12 stall lacked).
 */
function logCapCensus(conns: Set<Writable>): void {
  const c = censusConns(conns, {
    selfPid: process.pid,
    nowMs: Date.now(),
    unengagedTtlMs: UNENGAGED_CONN_TTL_MS,
    subscribedSilenceTtlMs: SUBSCRIBED_SILENCE_TTL_MS,
    isPidAlive,
  });
  console.error(
    `[server-worker] conn-cap census (${conns.size}/${MAX_CONNECTIONS}): ` +
      `self=${c.self} pending=${c.pending} zero_sub=${c.zeroSub} ` +
      `(dead=${c.zeroSubDead} unengaged=${c.zeroSubUnengaged}) ` +
      `sub_live=${c.subLive} sub_dead=${c.subDead} sub_unknown=${c.subUnknown} ` +
      `sub_abandoned=${c.subAbandoned}`,
  );
}

/**
 * Run the connection-hygiene reapers over the live conn set. Called on EVERY
 * `pollLoop` tick (NOT only changed ticks) because the leak class fills `conns`
 * during DB-quiet windows, exactly when `data_version` is frozen and `diffTick`
 * never fires; also called from inside `diffTick` for the `handleKick` path.
 * Eviction is idempotent, so the double call is a safe no-op.
 *
 * Pass `conns` to free reaped sockets SYNCHRONOUSLY (the cap-hit sweep needs a
 * true post-sweep `conns.size`); omit it and eviction degrades to `sock.end()`
 * alone, relying on the async Bun `close` handler to delete — the `diffTick` /
 * `handleKick` callers that hold only an `Iterable` take this path.
 */
export function reapConns(list: Writable[], conns?: Set<Writable>): void {
  reapStuckPending(list, conns);
  // Dead-peer + unengaged are the fast storm-clearers (they free a flood of
  // garbage conns at once); abandoned-subs clears live-peer ghosts the others
  // miss; the 5-minute idle sweep is the slow zero-sub backstop.
  reapDeadPeers(list, conns);
  reapUnengaged(list, conns);
  reapAbandonedSubs(list, conns);
  reapIdleConns(list, conns);
}

/**
 * Union of watched ids across a set of subscriptions sharing one collection, so
 * N overlapping pages cost one version-probe + at most one full-row read, not N.
 * Takes `SubState`s directly — the (collection, sub) binding is made by the
 * caller's grouping.
 */
function unionWatched(subs: Iterable<SubState>): string[] {
  const union = new Set<string>();
  for (const sub of subs) {
    for (const id of sub.watched) {
      union.add(id);
    }
  }
  return [...union];
}

/**
 * Per-tick fan-out budget: the maximum number of `(conn, sub)` units one
 * {@link diffTick} services. The diff's per-tick cost is `subscribed_conns x
 * watched_ids x collections` — unbounded in board size and conn count, the
 * re-fold time-bomb discipline transplanted to the serve loop: an accumulation
 * of subscriptions (ghosts the reapers have not yet cleared, or a genuinely
 * busy board) would let one tick's synchronous work starve the accept/read
 * loop. {@link sliceFanout} caps each tick to this many units and round-robins
 * the remainder across subsequent ticks, so per-tick cost is O(budget), flat in
 * conn count. At the {@link DEFAULT_POLL_MS} 50ms cadence a deferred sub is
 * serviced within `ceil(total_subs / MAX_SUBS_PER_TICK)` ticks — generous enough
 * that a normal board (well under the budget) sees zero added latency, yet a
 * fully-saturated {@link MAX_CONNECTIONS} table drains within a bounded window.
 */
export const MAX_SUBS_PER_TICK = 64;

/**
 * The round-robin fan-out position, persisted across ticks (owned by the worker
 * `main` like `conns`, threaded into both {@link pollLoop} and {@link handleKick}
 * so the SAME rotation advances no matter which path drives the tick). A plain
 * mutable holder so the pure {@link sliceFanout} can advance it in place.
 */
export interface FanoutCursor {
  value: number;
}

/** Allocate a fresh fan-out cursor at rotation position 0. */
export function newFanoutCursor(): FanoutCursor {
  return { value: 0 };
}

/** One tick's fan-out slice: the units to service now + how many were deferred. */
export interface FanoutSlice<T> {
  serve: T[];
  deferred: number;
}

/**
 * Round-robin scheduler bounding a diff tick's fan-out. Serves at most
 * `maxPerTick` units starting at `cursor.value`, wrapping the ring, and advances
 * the cursor to exactly where this slice ended so the NEXT tick continues the
 * rotation — never a priority-by-recency order (which would starve the ring's
 * tail; see the task risk). Consecutive slices cover a contiguous arc of length
 * `k x maxPerTick`, so within `ceil(units.length / maxPerTick)` ticks the arc
 * wraps the whole ring: EVERY unit is guaranteed serviced within that bound,
 * regardless of the starting cursor.
 *
 * When the budget covers the whole set (`maxPerTick >= units.length`) or is
 * non-positive (the unbounded caller path), the cursor resets to 0 and every
 * unit is served — a no-op bound, so a below-budget board behaves exactly as the
 * un-scheduled fan-out did.
 */
export function sliceFanout<T>(
  units: T[],
  cursor: FanoutCursor,
  maxPerTick: number,
): FanoutSlice<T> {
  const n = units.length;
  if (n === 0) {
    cursor.value = 0;
    return { serve: [], deferred: 0 };
  }
  if (maxPerTick <= 0 || maxPerTick >= n) {
    cursor.value = 0;
    return { serve: units, deferred: 0 };
  }
  // Normalize the cursor into [0, n) — it may point past the ring after a set
  // that shrank between ticks (conns closed), so wrap defensively.
  const start = ((cursor.value % n) + n) % n;
  const serve: T[] = [];
  for (let i = 0; i < maxPerTick; i++) {
    serve.push(units[(start + i) % n]);
  }
  cursor.value = (start + maxPerTick) % n;
  return { serve, deferred: n - maxPerTick };
}

/**
 * Run ONE realtime tick across all connections. Per collection-group: probe
 * `(pk, version)` for the union of watched ids, build `changedIds`, fetch FULL
 * rows only when non-empty, and emit a `patch` per id whose version advanced
 * past the sub's `lastSent`. A SECOND pass groups subs by filter signature, runs
 * ONE `countAndToken` per signature, and emits a `meta` when a sub's `total` or
 * `token` moved (the count signal — NOT a membership stream; the frozen page's
 * changed rows are never sent). The world rev stamped on every patch is the
 * GLOBAL reducer cursor — distinct from the per-row `version` column.
 *
 * The diff is state-based: multiple folds between ticks collapse to one push.
 * Backpressure is SOCKET-LEVEL — a conn with a pending write is SKIPPED for the
 * tick (all its subs together) without advancing any baseline, so the next tick
 * re-reflects current state and nothing is lost.
 *
 * Reads the collection table only (never `events`). A poll landing after a hook
 * `events` INSERT but before the fold sees no projection change; the fold is
 * itself a commit that re-bumps `data_version`, so the next poll catches it.
 */
export function diffTick(
  db: Database,
  conns: Iterable<Writable>,
  cursor?: FanoutCursor,
): void {
  const list = [...conns];
  if (list.length === 0) {
    return;
  }

  // Connection-hygiene reapers run over the FULL conn set (before any fan-out
  // bound) so every zero-sub AND deferred conn is still swept. Also run every
  // poll tick via `reapConns`; the call here covers the `handleKick` path.
  reapConns(list);

  // Build the flat list of (sock, subId, sub) triples across ALL conns, then
  // bound the fan-out to a round-robin slice of {@link MAX_SUBS_PER_TICK} units
  // so per-tick cost stays flat in conn count (deferred subs ride the cursor to
  // a later tick — state-based diffing means nothing is lost, only delayed by a
  // bounded number of ticks). A conn with an empty `subs` map contributes
  // nothing. When `cursor` is omitted (direct unit callers) the fan-out is
  // unbounded — every sub served, exactly as before.
  type Triple = { sock: Writable; subId: string | null; sub: SubState };
  const units: Triple[] = [];
  for (const sock of list) {
    for (const [subId, sub] of sock.data.subs) {
      units.push({ sock, subId, sub });
    }
  }
  if (units.length === 0) {
    return;
  }
  const served = cursor
    ? sliceFanout(units, cursor, MAX_SUBS_PER_TICK).serve
    : units;

  // Group the served slice by `sub.collection` for the patch pass.
  const byCollection = new Map<string, Triple[]>();
  for (const triple of served) {
    const group = byCollection.get(triple.sub.collection);
    if (group) {
      group.push(triple);
    } else {
      byCollection.set(triple.sub.collection, [triple]);
    }
  }
  if (byCollection.size === 0) {
    return;
  }

  // Staged timing — ternary-gated `performance.now()` as in `runQuery`.
  // Per-group sub-stages accumulate into `_acc*` so the line is one tick's total.
  const _tStart = TRACE ? performance.now() : 0;

  const rev = readWorldRevOnce(db);
  const _tAfterRev = TRACE ? performance.now() : 0;
  let _accUnion = 0;
  let _accProbe = 0;
  let _accSelect = 0;
  let _accPatch = 0;

  for (const [name, group] of byCollection) {
    const descriptor = getCollection(name);
    if (!descriptor) {
      // A subscription whose collection vanished from the registry (shouldn't
      // happen — the registry is static): nothing to diff.
      continue;
    }
    const _g0 = TRACE ? performance.now() : 0;
    const ids = unionWatched(group.map((t) => t.sub));
    const _g1 = TRACE ? performance.now() : 0;
    if (TRACE) _accUnion += _g1 - _g0;
    if (ids.length === 0) {
      continue;
    }
    // Version probe — read only `(pk, version)` (no row body, no JSON-decode).
    // The per-sub comparison below builds `changedIds`; only on a non-empty set
    // do we fetch full rows.
    const versions = selectVersionsByIdsChunked(db, descriptor, ids);
    const _g2 = TRACE ? performance.now() : 0;
    if (TRACE) _accProbe += _g2 - _g1;

    // Ids that advanced for ANY sub in the group. Iterates ALL subs (no
    // `pending` skip here — the skip belongs in the fanout below where
    // `lastSent` advances; skipping here would add a tick of drain latency for a
    // sole backpressured watcher).
    const changedIds = new Set<string>();
    for (const { sub } of group) {
      for (const id of sub.watched) {
        const v = versions.get(id);
        const last = sub.lastSent.get(id) ?? -1;
        // `v === undefined` guards a vanished row (defensive); `v === null`
        // guards a null version.
        if (v !== undefined && v !== null && v > last) {
          changedIds.add(id);
        }
      }
    }

    // Conditional full-row fetch + per-sub fanout (skipped when nothing
    // changed). Read-snapshot drift: the probe and this fetch are two autocommit
    // queries, so a writer commit between them returns the post-commit shape —
    // self-correcting on the next tick.
    if (changedIds.size > 0) {
      const rows = selectByIdsChunked(db, descriptor, [...changedIds]);
      const _g3 = TRACE ? performance.now() : 0;
      if (TRACE) _accSelect += _g3 - _g2;
      // Index by the descriptor's live key for per-sub fan-out — the composite
      // `(verb, id)` for `dispatch_failures`, the bare `pk` otherwise — so it
      // agrees with the watched/version keys built from the same `liveKeyOf`.
      const byId = new Map<string, Row>();
      for (const row of rows) {
        byId.set(liveKeyOf(descriptor, row), row);
      }

      for (const { sock, subId, sub } of group) {
        // Backpressured socket: skip (don't advance any sub's lastSent); the
        // next tick re-diffs. SOCKET-LEVEL — all subs on the conn share its
        // outbound buffer.
        if (sock.data.pending) {
          continue;
        }
        const patches: PatchFrame[] = [];
        for (const id of sub.watched) {
          const row = byId.get(id);
          if (!row) {
            // Not in `changedIds` (or vanished — defensive): leave lastSent.
            continue;
          }
          const version = row[descriptor.version] as number | null;
          const last = sub.lastSent.get(id) ?? -1;
          if (version !== null && version > last) {
            patches.push({
              type: "patch",
              ...(subId !== null ? { id: subId } : {}),
              collection: name,
              rev,
              row,
            });
            sub.lastSent.set(id, version);
          }
        }
        if (patches.length > 0) {
          writeFrames(sock, patches);
        }
      }
      const _g4 = TRACE ? performance.now() : 0;
      if (TRACE) _accPatch += _g4 - _g3;
    }
    // else: idle tick — no changes since last tick. Second SELECT skipped
    // entirely; the meta `countAndToken` pass below still runs.
  }
  const _tAfterPatch = TRACE ? performance.now() : 0;

  // Second pass: membership-staleness `meta`. Group the SAME served slice by
  // filter signature so pairs sharing a filter share ONE countAndToken; the
  // signature folds in bound params but excludes sort/limit/offset (different
  // pages of one filter share). Iterating `served` (not `list`) keeps the meta
  // pass under the same per-tick fan-out bound as the patch pass — a deferred
  // sub's membership recheck rides the cursor to a later tick, and meta is
  // throttled to {@link META_MIN_INTERVAL_MS} anyway.
  const byFilter = new Map<
    string,
    {
      descriptor: CollectionDescriptor;
      where: ResolvedFilter;
      pairs: { sock: Writable; subId: string | null; sub: SubState }[];
    }
  >();
  for (const { sock, subId, sub } of served) {
    const descriptor = getCollection(sub.collection);
    if (!descriptor) {
      continue;
    }
    const sig = JSON.stringify([
      sub.collection,
      sub.where.clause,
      sub.where.params,
    ]);
    const group = byFilter.get(sig);
    const pair = { sock, subId, sub };
    if (group) {
      group.pairs.push(pair);
    } else {
      byFilter.set(sig, { descriptor, where: sub.where, pairs: [pair] });
    }
  }

  for (const { descriptor, where, pairs } of byFilter.values()) {
    const { total, token } = countAndToken(
      db,
      descriptor,
      where.clause,
      where.params,
    );
    for (const { sock, subId, sub } of pairs) {
      // Backpressure: skip a pending sock WITHOUT advancing the baseline, so the
      // signal re-fires next tick (mirrors the patch pass).
      if (sock.data.pending) {
        continue;
      }
      if (total !== sub.lastTotal || token !== sub.lastToken) {
        // Coalesce the meta emission: a move within `META_MIN_INTERVAL_MS` of
        // this sub's last emit is deferred so a fold burst collapses into fewer
        // refetch rounds. `Date.now()` is fine — this is the serve path, never a
        // fold. The patch pass stays immediate; only meta is gated.
        if (Date.now() - sub.lastMetaEmittedAt >= META_MIN_INTERVAL_MS) {
          writeFrames(sock, [
            {
              type: "meta",
              ...(subId !== null ? { id: subId } : {}),
              collection: descriptor.name,
              rev,
              total,
            },
          ]);
          // CONVERGENCE INVARIANT: advance the baseline + emit clock ONLY on an
          // actual emit, so a throttled-away move leaves the baseline stale on
          // purpose and the next eligible diffTick re-detects + emits the latest
          // state (no lost final update).
          sub.lastTotal = total;
          sub.lastToken = token;
          sub.lastMetaEmittedAt = Date.now();
        }
        // else: throttled — leave lastTotal/lastToken/lastMetaEmittedAt
        // untouched so the membership delta survives to the next eligible tick.
      }
    }
  }
  const _tEnd = TRACE ? performance.now() : 0;

  // Per-tick gating: emit only when any stage > 5ms OR total > 10ms, or a 50ms
  // poll at rest floods the log. `col` is "*" because the tick spans every
  // group. The TRACE env gate short-circuits first so a TRACE=0 daemon does zero
  // stage arithmetic.
  const _readWorldRevMs = TRACE ? _tAfterRev - _tStart : 0;
  const _metaCountMs = TRACE ? _tEnd - _tAfterPatch : 0;
  const _totalMs = TRACE ? _tEnd - _tStart : 0;
  const _slowTick =
    TRACE &&
    (_readWorldRevMs > 5 ||
      _accUnion > 5 ||
      _accProbe > 5 ||
      _accSelect > 5 ||
      _accPatch > 5 ||
      _metaCountMs > 5 ||
      _totalMs > 10);
  if (TRACE && _slowTick)
    srvTs(
      formatStages({
        op: "diffTick",
        col: "*",
        stages: [
          ["readWorldRev", _readWorldRevMs.toFixed(2)],
          ["unionWatched", _accUnion.toFixed(2)],
          ["probeVersions", _accProbe.toFixed(2)],
          ["selectByIds", _accSelect.toFixed(2)],
          ["patchFanout", _accPatch.toFixed(2)],
          ["metaCount", _metaCountMs.toFixed(2)],
        ],
        total: _totalMs.toFixed(2),
      }),
    );
}

/**
 * Realtime poll loop. Polls `PRAGMA data_version` every `pollMs`; on any change
 * from the last seen value, runs `diffTick` against the live connection set.
 *
 * CRITICAL: the poll connection stays in autocommit — NO surrounding `BEGIN`,
 * or `data_version` freezes for this connection and we go blind to new commits.
 * `getConns` is called per tick so connections opened/closed mid-loop are
 * picked up. Resolves once `isShutdown()` returns true.
 *
 * Exported alongside `diffTick` so the worker `main` wires it and tests can run
 * it against a real two-connection DB.
 *
 * fn-1096.3: a transient SQLITE_NOTADB on the `data_version` read is a
 * boot-checkpoint view race, not corruption — tolerated via the shared
 * `NotadbTolerance` helper (skip this tick's diffTick, bounded consecutive-
 * miss rethrow) rather than letting it crash the worker (this is the UDS
 * subscribe/RPC serve path — the epic's own wedge/crash-loop concern).
 * `reapConns` still runs every tick regardless, since it has no data_version
 * dependency. `onNotadbSkip` — when given — is invoked with the running
 * consecutive-miss count on every tolerated skip so the caller can post
 * countable backstop telemetry. `cursor` — when given — is the persistent
 * round-robin fan-out position threaded into `diffTick` so a busy board's ticks
 * stay bounded (shared with `handleKick` by the worker `main`); omit it and the
 * fan-out is unbounded, the pre-bound behavior direct callers expect.
 */
export async function pollLoop(
  db: Database,
  getConns: () => Iterable<Writable>,
  isShutdown: () => boolean,
  pollMs: number = DEFAULT_POLL_MS,
  onNotadbSkip?: (consecutiveMisses: number) => void,
  cursor?: FanoutCursor,
): Promise<void> {
  const interval = Math.max(MIN_POLL_MS, pollMs);
  // Naked autocommit read — no BEGIN, or the counter freezes for this conn.
  const query = db.query("PRAGMA data_version");
  const tolerance = new NotadbTolerance();
  const readVersion = (): number | null => {
    const outcome = tolerance.poll(
      () => (query.get() as { data_version: number }).data_version,
    );
    if (outcome.skipped) {
      onNotadbSkip?.(outcome.consecutiveMisses);
      return null;
    }
    return outcome.value;
  };
  // A tolerated NOTADB on this VERY FIRST read seeds a `null` baseline — the
  // loop below treats `last === null` as "unknown, always re-diff on the
  // next successful read," never a false suppression.
  let last: number | null = readVersion();

  while (!isShutdown()) {
    const _sleepStart = Date.now();
    await Bun.sleep(interval);
    const _sleepActual = Date.now() - _sleepStart;
    if (_sleepActual > interval + 100) {
      // The event loop didn't wake us on time — something held it.
      if (TRACE)
        srvTs(
          `poll-loop sleep overrun: requested=${interval}ms actual=${_sleepActual}ms`,
        );
    }
    if (isShutdown()) {
      break;
    }
    // Run the connection-hygiene reapers on EVERY tick, not only changed ticks:
    // the ghost-conn leak fills `conns` during DB-quiet windows, when
    // `data_version` is frozen and the `diffTick` arm never fires. No-self-heal:
    // a reap throw must log+continue, never escape the poll loop.
    try {
      reapConns([...getConns()]);
    } catch (err) {
      console.error("[server-worker] poll-loop reapConns failed:", err);
    }
    const cur = readVersion();
    if (cur !== null && cur !== last) {
      last = cur;
      const _tickStart = Date.now();
      diffTick(db, getConns(), cursor);
      const _tickDur = Date.now() - _tickStart;
      if (_tickDur >= 20) {
        if (TRACE) srvTs(`poll-loop diffTick duration=${_tickDur}ms`);
      }
    }
  }
}

/**
 * Run one `diffTick` in response to main's post-fold `{type:"kick"}` message,
 * wrapped so a throw can NEVER escape the message handler (no-self-heal path).
 * The kick does NOT advance `pollLoop`'s `last`, so the next poll re-diffs
 * harmlessly (diffTick is state-based and idempotent).
 */
export function handleKick(
  db: Database,
  conns: Iterable<Writable>,
  cursor?: FanoutCursor,
): void {
  try {
    diffTick(db, conns, cursor);
  } catch (err) {
    // No-self-heal: log + continue. A crashed diffTick must not take down the
    // worker (and with it, the daemon).
    console.error("[server-worker] kick diffTick failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Worker server lifecycle
// ---------------------------------------------------------------------------

/**
 * What `startServer` returns so the worker `main()` (and tests) can drive
 * shutdown: the bound listener and a `stop()` that releases everything.
 */
export interface RunningServer {
  listener: import("bun").UnixSocketListener<ConnState>;
  /**
   * The live connection set. The realtime `pollLoop` reads this each tick so
   * connections opened/closed mid-loop are picked up; entries are `Writable`
   * (each carries its `ConnState` on `.data`) so `diffTick` / `writeFrames`
   * compose without a real-socket shim.
   */
  conns: Set<Writable>;
  /**
   * Served-latency window the dispatch loop feeds. The worker `main()` drains it
   * every {@link SERVE_HEALTH_REPORT_INTERVAL_MS} into a `serve-health` report; a
   * direct unit caller that never drains it just leaves the window growing (bounded
   * — it is a histogram).
   */
  latencyMeter: ServeLatencyMeter;
  stop(): void;
}

/**
 * Acquire the lock, unlink any stale socket, bind the UDS, and wire the dispatch
 * handlers. Returns a `RunningServer`; the caller owns `stop()` on shutdown.
 *
 * Two DB connections: `db` is the read-only reader (powers query/patch/meta and
 * `data_version` polling — MUST stay autocommit). `writerDb` is the writer-mode
 * connection RPC handlers write through; the reader's poll sees the writer's
 * commits because they are DISTINCT connections (a same-connection write does
 * not bump `data_version`). Both lifetimes belong to the caller.
 *
 * `bridge` is the worker→main round-trip surface; when absent, async-RPC methods
 * surface as `unknown_method`. Throws `LockHeldError` if a live instance owns
 * the lock.
 *
 * `bootGate` is the fn-897 B1 latch: while un-`ready` (boot drain still running)
 * every served frame carries `catching_up: true` and mutating RPCs are rejected
 * `server_booting`. Defaults to a permanently-ready gate so direct unit callers
 * (and tests) behave as steady-state.
 */
export function startServer(
  db: Database,
  sockPath: string,
  lockPath: string,
  writerDb?: Database,
  bridge?: ReplayBridge,
  bootGate: BootGate = { ready: true },
): RunningServer {
  acquireLock(lockPath, sockPath);

  // AF_UNIX has no SO_REUSEADDR: a leftover socket file → EADDRINUSE. acquireLock
  // just wrote our pid, so the lock is ours; unlink the stale socket only WHILE we
  // own the lock, so we never clear a live successor's rebound socket.
  if (lockOwnedByUs(lockPath)) {
    unlinkIfExists(sockPath);
  }

  // Live connection registry. The realtime pollLoop iterates this each tick;
  // open() adds, close() removes. Entries are the sockets themselves (typed as
  // Writable so diffTick/writeFrames compose).
  const conns = new Set<Writable>();

  // Per-server-instance result memo: N identical queries at one worldRev share
  // ONE runQuery + ONE serialize. Owned here (not module-global) so a second
  // in-process server instance never cross-contaminates.
  const memo = newResultMemo();

  // Per-server-instance served-latency window (same not-module-global discipline as
  // `memo`). The dispatch loop feeds it; `main()` drains it into `serve-health`.
  const latencyMeter = new ServeLatencyMeter();

  const listener = Bun.listen<ConnState>({
    unix: sockPath,
    socket: {
      open(socket) {
        // No-self-heal try/catch: a throw in the accept path must log+continue.
        try {
          socket.data = newConnState();
          socket.data.id = ++__nextConnId;
          // Capture the peer pid up front — both admission gates (the per-pid cap
          // and the dead-peer sweep) key on it. macOS LOCAL_PEERPID; `null` on any
          // other platform / probe failure, which degrades to the idle + unengaged
          // + stuck-pending arms. Best-effort — a probe failure never blocks accept.
          socket.data.peerPid = peerPidForFd(
            (socket as unknown as { fd?: number }).fd ?? -1,
          );
          const w = socket as unknown as Writable;

          // FIRST wall — per-client admission control: one peer pid cannot hold
          // more than PER_PID_MAX_CONNECTIONS slots, so a single reconnect-loop
          // client (a runaway `keeper board`) can never monopolize the table and
          // wedge every other client out of the global cap. Sweep first (the
          // loop's own dead / unengaged conns free here), then reject if it holds.
          // The daemon's OWN conns (the serve-liveness probe from main, same pid)
          // are EXEMPT — a self-probe cap-rejected into a false death is exactly
          // the incident this hardening closes. The reject frame is emitted here
          // at accept time, BEFORE the request line is read, so it cannot echo the
          // probe's correlation id; the probe's matcher scores the admission code
          // itself as proof-of-life (see daemon.ts `probeReplyProvesLife`).
          const pid = socket.data.peerPid;
          if (
            pid != null &&
            !isDaemonSelfConn(pid, process.pid) &&
            pidConnCount(conns, pid) >= PER_PID_MAX_CONNECTIONS
          ) {
            reapConns([...conns], conns);
            if (pidConnCount(conns, pid) >= PER_PID_MAX_CONNECTIONS) {
              console.error(
                `[server-worker] per-pid cap (${PER_PID_MAX_CONNECTIONS}) held ` +
                  `for peer pid ${pid} — rejecting conn ${socket.data.id} ` +
                  `(one client cannot monopolize the connection table)`,
              );
              writeFrames(w, [
                errorFrame(
                  db,
                  "too_many_connections",
                  `peer at per-client connection cap (${PER_PID_MAX_CONNECTIONS}); rejecting new connection`,
                ),
              ]);
              socket.end();
              return; // never added to `conns`
            }
          }

          // SECOND wall — the global cap. Synchronously sweep reapable conns and
          // accept if that frees a slot. NOT LRU-evict: the sweep reuses the
          // reaper classifications, so a live board subscriber is never evicted
          // (idle sweep exempts subscribed conns; dead-peer evicts only dead-pid
          // conns; unengaged evicts only connect-and-silent ones). The reapers
          // free SYNCHRONOUSLY (the `conns` arg), so the recheck sees a true
          // `conns.size`. A cap STILL held after the sweep means every conn is
          // genuinely live + busy — logged loudly with the attributing census.
          if (conns.size >= MAX_CONNECTIONS) {
            logCapCensus(conns);
            reapConns([...conns], conns);
            if (conns.size >= MAX_CONNECTIONS) {
              console.error(
                `[server-worker] max_connections cap (${MAX_CONNECTIONS}) held ` +
                  `AFTER sweep — rejecting conn ${socket.data.id} ` +
                  `(${conns.size} live conns, all busy)`,
              );
              writeFrames(w, [
                errorFrame(
                  db,
                  "max_connections",
                  `server at connection cap (${MAX_CONNECTIONS}); rejecting new connection`,
                ),
              ]);
              socket.end();
              return; // never added to `conns`
            }
            console.error(
              `[server-worker] max_connections cap (${MAX_CONNECTIONS}) hit — ` +
                `sweep recovered a slot (now ${conns.size}); accepting conn ${socket.data.id}`,
            );
          }
          conns.add(socket as unknown as Writable);
          if (TRACE) srvTs(`conn ${socket.data.id} open`);
        } catch (err) {
          console.error("[server-worker] open handler failed:", err);
        }
      },
      data(socket, chunk) {
        const id = socket.data.id ?? -1;
        if (TRACE) srvTs(`conn ${id} data chunk=${chunk.length}`);
        const t0 = Date.now();
        // Refresh the idle-sweep clock on every inbound frame so an actively-
        // querying conn is never idle-reaped; a silently-dead probe stops
        // bumping this and ages out.
        socket.data.lastActivityAt = t0;
        handleData(
          db,
          socket,
          chunk,
          writerDb,
          bridge,
          memo,
          bootGate,
          latencyMeter,
        );
        const dur = Date.now() - t0;
        if (dur >= 5) {
          if (TRACE) srvTs(`conn ${id} handleData duration=${dur}ms`);
        }
      },
      drain(socket) {
        resumePending(socket as unknown as Writable);
      },
      close(socket) {
        if (TRACE) srvTs(`conn ${socket.data.id ?? -1} close`);
        // Drop the connection from the fan-out set and release per-connection
        // state via the shared idempotent helper. The cap-hit sweep may have
        // already freed this socket synchronously; running it again here is a
        // harmless no-op (the deferred Bun `close` event).
        freeConn(conns, socket as unknown as Writable);
      },
      error(socket, err) {
        // EPIPE/ECONNRESET are the NORMAL shape of a peer going away (handled by
        // the close path); demote to TRACE so a viewer-churn burst doesn't flood
        // the log. Anything else is a genuine fault — log loudly.
        const code = (err as { code?: unknown } | null)?.code;
        if (code === "EPIPE" || code === "ECONNRESET") {
          if (TRACE) srvTs(`conn ${socket.data?.id ?? -1} peer-gone (${code})`);
          return;
        }
        console.error("[server-worker] socket error:", err);
      },
    },
  });

  // The 0700 parent dir is the real ACL gate on macOS; chmod the socket 0600
  // as Linux defense-in-depth.
  try {
    chmodSync(sockPath, 0o600);
  } catch {
    // best-effort; the dir mode is the real gate
  }

  return {
    listener,
    conns,
    latencyMeter,
    stop() {
      // Release the socket HERE — it's owned by the process, not the Worker
      // thread; the daemon's worker.terminate() won't release it.
      try {
        listener.stop(true);
      } catch {
        // best-effort
      }
      // Ownership-checked: a live successor may have stolen the lock (and rebound
      // the socket) while this instance was dying. Only unlink when the lock still
      // records our pid, so a dying stray never unlinks a live daemon's socket.
      unlinkOwnedSocketAndLock(lockPath, sockPath);
    },
  };
}

/** Feed an inbound byte chunk through this connection's UTF-8 decoder and line buffer. */
export function decodeConnChunk(conn: ConnState, chunk: Uint8Array): string[] {
  return conn.buffer.push(conn.decoder.decode(chunk, { stream: true }));
}

export function flushConnDecoder(conn: ConnState): void {
  conn.decoder.decode();
}

/**
 * Feed an inbound chunk into the connection's line buffer and dispatch each
 * complete line. An oversized line (no `\n` past the 1 MiB cap) is a fatal
 * protocol error — send a final `error` frame if we can, then close. Each line
 * dispatches in its own try/catch so one bad line never wedges the connection.
 */
function handleData(
  db: Database,
  socket: import("bun").Socket<ConnState>,
  chunk: Buffer,
  writerDb: Database | undefined,
  bridge: ReplayBridge | undefined,
  memo: ResultMemo,
  bootGate: BootGate = { ready: true },
  meter?: ServeLatencyMeter,
): void {
  const w = socket as unknown as Writable;
  let lines: string[];
  try {
    lines = decodeConnChunk(socket.data, chunk);
  } catch (err) {
    if (err instanceof OversizedLineError) {
      writeFrames(
        w,
        stampBootStatus(db, bootGate, [
          {
            type: "error",
            rev: readWorldRev(db),
            code: "oversized_line",
            message: err.message,
          },
        ]),
      );
      socket.end();
      return;
    }
    throw err;
  }

  // Build the asyncCtx ONCE per data chunk, not per line. The bridge is
  // process-global state; `onAsyncResult` closes over the per-connection
  // socket so a deferred async-RPC result lands on the originating conn.
  // Only constructed when both halves are wired — otherwise async-RPC
  // frames surface as `unknown_method` (see `dispatchRpc`).
  const asyncCtx: DispatchAsyncCtx | undefined = bridge
    ? {
        bridge,
        onAsyncResult: (frames: ServerFrame[]): void => {
          // fn-897 B1: stamp the boot-status header on the deferred async-RPC
          // result too (read at result-construction time, like `rev`).
          if (frames.length > 0)
            writeFrames(w, stampBootStatus(db, bootGate, frames));
        },
      }
    : undefined;

  for (const line of lines) {
    // A complete inbound frame: this conn is doing real work, so it is exempt
    // from the subscribe-by-deadline sweep (a slow cold-boot query in flight is
    // engaged the instant its frame lands, before the multi-second reply).
    socket.data.everEngaged = true;
    let frames: (ServerFrame | PreSerialized)[];
    // Time every dispatch UNCONDITIONALLY (the ~20ns `performance.now()` pair, no
    // env gate) so the serve-liveness watchdog always sees served latency; only the
    // trace LOGGING below stays behind `TRACE`.
    const _dispatchStart = performance.now();
    let _frameType = "unknown";
    let _collection: string | undefined;
    try {
      const parsed = JSON.parse(line) as {
        type?: unknown;
        collection?: unknown;
      };
      if (typeof parsed.type === "string") _frameType = parsed.type;
      if (typeof parsed.collection === "string")
        _collection = parsed.collection;
    } catch {
      // dispatchLine itself will surface the bad_frame; just log unknown.
    }
    try {
      frames = dispatchLine(
        db,
        socket.data,
        line,
        writerDb,
        asyncCtx,
        memo,
        bootGate,
      );
    } catch (err) {
      // Defensive: dispatchLine is contracted not to throw, but a DB hiccup
      // mid-query shouldn't kill the connection.
      frames = [
        {
          type: "error",
          rev: readWorldRev(db),
          code: "internal",
          message: err instanceof Error ? err.message : String(err),
        },
      ];
    }
    // fn-1311: stamp the event-store block on any object `result` frame BEFORE
    // the boot header (so `event_store` precedes `boot` in key order, matching
    // the memo line). A PreSerialized memo line already bakes its own block and
    // is skipped; only the un-memoized (catch-up, or steady cap-skip) object
    // path pays the read here.
    stampEventStore(db, frames);
    // Stamp object replies here; a pre-serialized memo result already includes
    // the same identity and current Drain fields.
    stampBootStatus(db, bootGate, frames);
    const _dispatchDur = performance.now() - _dispatchStart;
    // Feed the served-latency window unconditionally (the watchdog's eyes).
    meter?.record(_dispatchDur);
    const _id = socket.data.id ?? -1;
    const _collTag = _collection ? ` coll=${_collection}` : "";
    if (_frameType === "query" || _dispatchDur >= 5) {
      if (TRACE)
        srvTs(
          `conn ${_id} dispatch type=${_frameType}${_collTag} duration=${_dispatchDur.toFixed(2)}ms frames=${frames.length}`,
        );
    }
    if (frames.length > 0) {
      const _writeStart = Date.now();
      writeFrames(w, frames);
      const _writeDur = Date.now() - _writeStart;
      if (_writeDur >= 5) {
        if (TRACE) srvTs(`conn ${_id} writeFrames duration=${_writeDur}ms`);
      }
    }
  }
}

/**
 * Worker entrypoint. Opens its own read-only connection, binds the server,
 * wires the shutdown message, and signals `ready` to the parent. Any failure
 * to bind (lock held, EADDRINUSE) exits non-zero so the parent's single
 * recovery path (LaunchAgent restart) engages.
 */
function main(): void {
  if (!parentPort) {
    console.error("[server-worker] no parentPort — not running as a Worker");
    process.exit(1);
  }

  const data = workerData as ServerWorkerData | undefined;
  if (!data || typeof data.dbPath !== "string") {
    console.error("[server-worker] missing dbPath in workerData");
    process.exit(1);
  }

  const sockPath = data.sockPath ?? resolveSockPath();
  const lockPath = data.lockPath ?? `${sockPath}.lock`;

  // Two connections per worker:
  //   - `db` (read-only): backs query/patch/meta + the `data_version` poll. MUST
  //     stay autocommit — a `BEGIN` freezes `data_version` and the poll goes
  //     blind.
  //   - `writerDb` (writer mode): the RPC write surface. DISTINCT connection so
  //     the reader's poll sees its commits (a same-connection write doesn't bump
  //     the counter). Goes through `applyPragmas` so RPC writes block politely
  //     instead of erroring `SQLITE_BUSY`.
  const { db } = openDb(data.dbPath, {
    readonly: true,
    prepareStmts: false,
    bootRetry: true,
  });
  // Main is the sole migrator and has already converged the schema, so
  // `migrate: false` skips re-running the (idempotent) ladder on every spawn.
  const { db: writerDb } = openDb(data.dbPath, {
    migrate: false,
    prepareStmts: false,
    bootRetry: true,
  });

  // Installation is atomic and role-qualified, so no listener can observe a
  // partial registry and imports in other worker roles leave it empty.
  installRpcHandlers(RPC_RUNTIME);
  RPC_RUNTIME.assertInstalled();

  // Worker→main async-RPC bridge state. Outgoing request messages await their
  // matching result reply by correlation id, resolving with the typed `{ok, …}`
  // shape; a timeout rejects. The bridge is the SOLE place this thread exchanges
  // messages with main outside the shutdown / ready protocol.
  type ReplayResolution = {
    ok: boolean;
    recovered_dl_id?: string | null;
    error?: string;
  };
  /** Reply shape for the non-replay bridge calls — the replay `{ok, error?}`
   *  union minus the dead-letter-specific `recovered_dl_id`. `conflict` rides
   *  only on the `request_handoff` slug-collision reject. */
  type SimpleResolution = {
    ok: boolean;
    error?: string;
    conflict?: boolean;
    note?: string;
  };
  /** The `retry_dispatch` bridge resolution — the `SimpleResolution` shape plus
   *  the typed clear `outcome` so the handler threads refused_live /
   *  refused_identity through to the CLI instead of a bare `ok`. */
  type RetryDispatchResolution = {
    ok: boolean;
    error?: string;
    outcome?: DispatchClearOutcome;
  };
  type ResolveDeadLetterResolution = {
    ok: boolean;
    error?: string;
    outcome?: DeadLetterOperatorOutcome;
  };
  const pendingReplays = new Map<
    string,
    {
      resolve: (r: ReplayResolution) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const pendingDeadLetterResolutions = new Map<
    string,
    {
      resolve: (r: ResolveDeadLetterResolution) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /** Pending `set_autopilot_paused` requests, correlated by id. A distinct map
   *  per bridge so a stale reply can't wrong-resolve another's promise. */
  const pendingSetPaused = new Map<
    string,
    {
      resolve: (r: SimpleResolution) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /** Pending `retry_dispatch` requests, correlated by id. */
  const pendingRetryDispatch = new Map<
    string,
    {
      resolve: (r: RetryDispatchResolution) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /** Pending `set_autopilot_mode` requests, correlated by id. */
  const pendingSetMode = new Map<
    string,
    {
      resolve: (r: SimpleResolution) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /** Pending `set_autopilot_config` requests, correlated by id. */
  const pendingSetConfig = new Map<
    string,
    {
      resolve: (r: SimpleResolution) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /** Pending `set_epic_armed` requests, correlated by id. */
  const pendingSetArmed = new Map<
    string,
    {
      resolve: (r: SimpleResolution) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /** Pending `request_handoff` requests, correlated by id. */
  const pendingRequestHandoff = new Map<
    string,
    {
      resolve: (r: SimpleResolution) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /** Pending `request_await` requests, correlated by id. */
  const pendingRequestAwait = new Map<
    string,
    {
      resolve: (r: SimpleResolution) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const bridge: ReplayBridge = {
    replay(): Promise<ReplayResolution> {
      return new Promise<ReplayResolution>((resolve, reject) => {
        const reqId = crypto.randomUUID();
        const timer = setTimeout(() => {
          if (pendingReplays.delete(reqId)) {
            reject(
              new Error(
                `no response from main within ${REPLAY_DEADLINE_MS}ms (id ${reqId})`,
              ),
            );
          }
        }, REPLAY_DEADLINE_MS);
        timer.unref?.();
        pendingReplays.set(reqId, { resolve, reject, timer });
        parentPort?.postMessage({
          kind: "replay-request",
          id: reqId,
        } satisfies ReplayRequestMessage);
      });
    },
    resolveDeadLetter(
      request: DeadLetterOperatorRequest,
    ): Promise<ResolveDeadLetterResolution> {
      return new Promise<ResolveDeadLetterResolution>((resolve, reject) => {
        const reqId = crypto.randomUUID();
        const timer = setTimeout(() => {
          if (pendingDeadLetterResolutions.delete(reqId)) {
            reject(
              new Error(
                `no response from main within ${REPLAY_DEADLINE_MS}ms (id ${reqId})`,
              ),
            );
          }
        }, REPLAY_DEADLINE_MS);
        timer.unref?.();
        pendingDeadLetterResolutions.set(reqId, { resolve, reject, timer });
        parentPort?.postMessage({
          kind: "resolve-dead-letter-request",
          id: reqId,
          request,
        } satisfies ResolveDeadLetterRequestMessage);
      });
    },
    setAutopilotPaused(paused: boolean): Promise<SimpleResolution> {
      return new Promise<SimpleResolution>((resolve, reject) => {
        const reqId = crypto.randomUUID();
        const timer = setTimeout(() => {
          if (pendingSetPaused.delete(reqId)) {
            reject(
              new Error(
                `no response from main within ${REPLAY_DEADLINE_MS}ms (id ${reqId})`,
              ),
            );
          }
        }, REPLAY_DEADLINE_MS);
        timer.unref?.();
        pendingSetPaused.set(reqId, { resolve, reject, timer });
        parentPort?.postMessage({
          kind: "set-autopilot-paused-request",
          id: reqId,
          paused,
        } satisfies SetAutopilotPausedRequestMessage);
      });
    },
    retryDispatch(
      verb: RetryDispatchVerb,
      dispatch_id: string,
      force: boolean,
      caller_session: string | null,
    ): Promise<RetryDispatchResolution> {
      return new Promise<RetryDispatchResolution>((resolve, reject) => {
        const reqId = crypto.randomUUID();
        const timer = setTimeout(() => {
          if (pendingRetryDispatch.delete(reqId)) {
            reject(
              new Error(
                `no response from main within ${REPLAY_DEADLINE_MS}ms (id ${reqId})`,
              ),
            );
          }
        }, REPLAY_DEADLINE_MS);
        timer.unref?.();
        pendingRetryDispatch.set(reqId, { resolve, reject, timer });
        parentPort?.postMessage({
          kind: "retry-dispatch-request",
          id: reqId,
          verb,
          dispatch_id,
          force,
          caller_session,
        } satisfies RetryDispatchRequestMessage);
      });
    },
    setAutopilotMode(mode: "yolo" | "armed"): Promise<SimpleResolution> {
      return new Promise<SimpleResolution>((resolve, reject) => {
        const reqId = crypto.randomUUID();
        const timer = setTimeout(() => {
          if (pendingSetMode.delete(reqId)) {
            reject(
              new Error(
                `no response from main within ${REPLAY_DEADLINE_MS}ms (id ${reqId})`,
              ),
            );
          }
        }, REPLAY_DEADLINE_MS);
        timer.unref?.();
        pendingSetMode.set(reqId, { resolve, reject, timer });
        parentPort?.postMessage({
          kind: "set-autopilot-mode-request",
          id: reqId,
          mode,
        } satisfies SetAutopilotModeRequestMessage);
      });
    },
    setAutopilotConfig(patch: {
      max_concurrent_jobs?: number | null;
      max_concurrent_per_root?: number | null;
      worktree_mode?: boolean;
      worktree_multi_repo?: boolean;
      worker_provider?: "claude" | "gpt" | null;
      drift_behind_threshold?: number | null;
      drift_age_threshold_days?: number | null;
      fable_focus?: NormalizedFableFocusInput | null;
    }): Promise<SimpleResolution> {
      return new Promise<SimpleResolution>((resolve, reject) => {
        const reqId = crypto.randomUUID();
        const timer = setTimeout(() => {
          if (pendingSetConfig.delete(reqId)) {
            reject(
              new Error(
                `no response from main within ${REPLAY_DEADLINE_MS}ms (id ${reqId})`,
              ),
            );
          }
        }, REPLAY_DEADLINE_MS);
        timer.unref?.();
        pendingSetConfig.set(reqId, { resolve, reject, timer });
        parentPort?.postMessage({
          kind: "set-autopilot-config-request",
          id: reqId,
          patch,
        } satisfies SetAutopilotConfigRequestMessage);
      });
    },
    setEpicArmed(epic_id: string, armed: boolean): Promise<SimpleResolution> {
      return new Promise<SimpleResolution>((resolve, reject) => {
        const reqId = crypto.randomUUID();
        const timer = setTimeout(() => {
          if (pendingSetArmed.delete(reqId)) {
            reject(
              new Error(
                `no response from main within ${REPLAY_DEADLINE_MS}ms (id ${reqId})`,
              ),
            );
          }
        }, REPLAY_DEADLINE_MS);
        timer.unref?.();
        pendingSetArmed.set(reqId, { resolve, reject, timer });
        parentPort?.postMessage({
          kind: "set-epic-armed-request",
          id: reqId,
          epic_id,
          armed,
        } satisfies SetEpicArmedRequestMessage);
      });
    },
    requestHandoff(req): Promise<SimpleResolution> {
      return new Promise<SimpleResolution>((resolve, reject) => {
        const reqId = crypto.randomUUID();
        const timer = setTimeout(() => {
          if (pendingRequestHandoff.delete(reqId)) {
            reject(
              new Error(
                `no response from main within ${REPLAY_DEADLINE_MS}ms (id ${reqId})`,
              ),
            );
          }
        }, REPLAY_DEADLINE_MS);
        timer.unref?.();
        pendingRequestHandoff.set(reqId, { resolve, reject, timer });
        parentPort?.postMessage({
          kind: "request-handoff-request",
          id: reqId,
          desired_slug: req.desired_slug,
          doc_path: req.doc_path,
          title: req.title,
          target_session: req.target_session,
          target_dir: req.target_dir,
          initiator_session: req.initiator_session,
          initiator_pane: req.initiator_pane,
          capture: req.capture,
          model: req.model,
          effort: req.effort,
          preset: req.preset,
        } satisfies RequestHandoffRequestMessage);
      });
    },
    requestAwait(request): Promise<SimpleResolution> {
      return new Promise<SimpleResolution>((resolve, reject) => {
        const reqId = crypto.randomUUID();
        const timer = setTimeout(() => {
          if (pendingRequestAwait.delete(reqId)) {
            reject(
              new Error(
                `no response from main within ${REPLAY_DEADLINE_MS}ms (id ${reqId})`,
              ),
            );
          }
        }, REPLAY_DEADLINE_MS);
        timer.unref?.();
        pendingRequestAwait.set(reqId, { resolve, reject, timer });
        parentPort?.postMessage({
          kind: "request-await-request",
          id: reqId,
          request,
        } satisfies RequestAwaitRequestMessage);
      });
    },
  };

  // The durable identity is parent-owned: main synced it before opening the DB,
  // so the worker may serve only the exact ledger-backed process identity.
  const bootIdentity = data.bootIdentity;
  if (
    bootIdentity === undefined ||
    typeof bootIdentity.boot_id !== "string" ||
    bootIdentity.boot_id.length === 0 ||
    !Number.isInteger(bootIdentity.pid) ||
    bootIdentity.pid <= 0 ||
    typeof bootIdentity.start_time !== "string" ||
    bootIdentity.start_time.length === 0
  ) {
    console.error(
      "[server-worker] missing durable boot identity in workerData",
    );
    process.exit(1);
  }

  // fn-897 B1 boot gate. The server worker now spawns right after `migrate()`,
  // BEFORE the boot drain, so it serves reads during catch-up. The gate boots
  // un-`ready` (mutating RPCs rejected `server_booting`, every frame stamped
  // `catching_up`) and flips on main's `{type:"boot-complete"}` message, posted
  // after drain-reaches-head + git-seed + ephemeral-truncate.
  // The durable boot id also serves as the reconnect generation: both fields
  // identify one worker lifetime and cannot drift apart.
  const bootGate: BootGate = {
    ready: false,
    identity: bootIdentity,
    generation: bootIdentity.boot_id,
  };

  // Shared round-robin fan-out position. Threaded into BOTH the poll loop and the
  // post-fold kick handler so one rotation advances no matter which drives the
  // tick, bounding every diff tick to {@link MAX_SUBS_PER_TICK} units.
  const fanoutCursor = newFanoutCursor();

  let server: RunningServer;
  try {
    server = startServer(db, sockPath, lockPath, writerDb, bridge, bootGate);
  } catch (err) {
    // Lock held by a live instance, or bind failed. No self-heal — exit
    // non-zero; launchd backs off and the live owner keeps serving.
    console.error("[server-worker] failed to start:", err);
    try {
      db.close();
    } catch {
      // ignore
    }
    try {
      writerDb.close();
    } catch {
      // ignore
    }
    process.exit(1);
  }

  let stopping = false;
  /**
   * Resolves once `pollLoop` has fully exited. `shutdown()` awaits this BEFORE
   * closing `db`, so an in-flight poll tick (which reads `db`) can never race the
   * close ("Cannot use a closed database"). The `Bun.sleep` fallback bounds the
   * wait so a wedged loop can't block teardown forever.
   */
  let resolvePollDone: (() => void) | null = null;
  const pollDone = new Promise<void>((resolve) => {
    resolvePollDone = resolve;
  });

  // Worker-side served-latency self-report. `serveLoopDelayHist` measures THIS
  // worker's own event-loop delay (the queueing signal main cannot see cross-thread)
  // and pins a libuv handle, so it is released in `shutdown`; the report interval is
  // cleared there too, and both the `stopping` guard below and that clear guarantee
  // no `serve-health` is ever posted after stopping.
  const serveLoopDelayHist = monitorEventLoopDelay({ resolution: 20 });
  serveLoopDelayHist.enable();
  let serveHealthReportTimer: ReturnType<typeof setInterval> | null = null;

  const shutdown = async (): Promise<void> => {
    stopping = true; // resolves the poll loop on its next iteration check
    // Stop reporting FIRST (before any await) so no tick can post mid-teardown, and
    // release the loop-delay monitor's libuv handle.
    if (serveHealthReportTimer != null) clearInterval(serveHealthReportTimer);
    try {
      serveLoopDelayHist.disable();
    } catch {
      // best-effort — tearing down either way
    }
    // Stop accepting + evict conns FIRST so a final diffTick has nothing to fan
    // out to, then WAIT for the poll loop to exit before closing the connection
    // it reads from — without the await, `db.close()` races a resumed pollLoop
    // tick's `query.get()` ("Cannot use a closed database").
    server.stop();
    await Promise.race([pollDone, Bun.sleep(POLL_DRAIN_DEADLINE_MS)]);
    try {
      db.close();
    } catch {
      // best-effort; exiting either way
    }
    try {
      writerDb.close();
    } catch {
      // best-effort; exiting either way
    }
    process.exit(0);
  };

  // Drain the served-latency window + own loop-delay p99 into a periodic report.
  // DURATIONS ONLY — main stamps arrival on its own clock and judges staleness there.
  serveHealthReportTimer = setInterval(() => {
    if (stopping) return; // never post after stopping
    const { dispatchP99Ms, busyMs, sampleCount } = server.latencyMeter.drain();
    const loopDelayP99Ms = serveLoopDelayHist.percentile(99) / 1e6;
    serveLoopDelayHist.reset();
    parentPort?.postMessage({
      kind: "serve-health",
      dispatchP99Ms,
      busyMs,
      sampleCount,
      loopDelayP99Ms,
    } satisfies ServeHealthMessage);
  }, SERVE_HEALTH_REPORT_INTERVAL_MS);

  parentPort.on(
    "message",
    (
      msg:
        | ShutdownMessage
        | KickMessage
        | BootCompleteMessage
        | ReplayResultMessage
        | ResolveDeadLetterResultMessage
        | SetAutopilotPausedResultMessage
        | RetryDispatchResultMessage
        | SetAutopilotModeResultMessage
        | SetAutopilotConfigResultMessage
        | SetEpicArmedResultMessage
        | RequestHandoffResultMessage
        | RequestAwaitResultMessage
        | undefined,
    ) => {
      if (!msg) return;
      // Discriminate by `type` so a stale reply for one bridge can't
      // wrong-resolve another's awaiting promise.
      if ((msg as ShutdownMessage).type === "shutdown") {
        // `shutdown` is async; fire-and-forget — it ends in `process.exit(0)`.
        void shutdown();
        return;
      }
      if ((msg as KickMessage).type === "kick") {
        // Fast path: main folded + kicked so we diffTick now. The try/catch is in
        // `handleKick` — this handler must never throw (no-self-heal path).
        handleKick(db, server.conns, fanoutCursor);
        return;
      }
      if ((msg as BootCompleteMessage).type === "boot-complete") {
        // fn-897 B1: drain reached head + git-seed + ephemeral-truncate are done.
        // Flip the gate so mutating RPCs are accepted and `catching_up` settles.
        bootGate.ready = true;
        return;
      }
      if ((msg as ReplayResultMessage).type === "replay-result") {
        const r = msg as ReplayResultMessage;
        const entry = pendingReplays.get(r.id);
        if (!entry) {
          // Stale reply (already timed out / never sent). Silent drop — no
          // awaiting promise to surface it to.
          return;
        }
        pendingReplays.delete(r.id);
        clearTimeout(entry.timer);
        entry.resolve({
          ok: r.ok,
          recovered_dl_id: r.recovered_dl_id,
          error: r.error,
        });
        return;
      }
      if (
        (msg as ResolveDeadLetterResultMessage).type ===
        "resolve-dead-letter-result"
      ) {
        const r = msg as ResolveDeadLetterResultMessage;
        const entry = pendingDeadLetterResolutions.get(r.id);
        if (!entry) return;
        pendingDeadLetterResolutions.delete(r.id);
        clearTimeout(entry.timer);
        entry.resolve({ ok: r.ok, outcome: r.outcome, error: r.error });
        return;
      }
      if (
        (msg as SetAutopilotPausedResultMessage).type ===
        "set-autopilot-paused-result"
      ) {
        const r = msg as SetAutopilotPausedResultMessage;
        const entry = pendingSetPaused.get(r.id);
        if (!entry) return;
        pendingSetPaused.delete(r.id);
        clearTimeout(entry.timer);
        entry.resolve({ ok: r.ok, error: r.error });
        return;
      }
      if (
        (msg as RetryDispatchResultMessage).type === "retry-dispatch-result"
      ) {
        const r = msg as RetryDispatchResultMessage;
        const entry = pendingRetryDispatch.get(r.id);
        if (!entry) return;
        pendingRetryDispatch.delete(r.id);
        clearTimeout(entry.timer);
        entry.resolve({ ok: r.ok, error: r.error, outcome: r.outcome });
        return;
      }
      if (
        (msg as SetAutopilotModeResultMessage).type ===
        "set-autopilot-mode-result"
      ) {
        const r = msg as SetAutopilotModeResultMessage;
        const entry = pendingSetMode.get(r.id);
        if (!entry) return;
        pendingSetMode.delete(r.id);
        clearTimeout(entry.timer);
        entry.resolve({ ok: r.ok, error: r.error });
        return;
      }
      if (
        (msg as SetAutopilotConfigResultMessage).type ===
        "set-autopilot-config-result"
      ) {
        const r = msg as SetAutopilotConfigResultMessage;
        const entry = pendingSetConfig.get(r.id);
        if (!entry) return;
        pendingSetConfig.delete(r.id);
        clearTimeout(entry.timer);
        entry.resolve({ ok: r.ok, error: r.error, note: r.note });
        return;
      }
      if ((msg as SetEpicArmedResultMessage).type === "set-epic-armed-result") {
        const r = msg as SetEpicArmedResultMessage;
        const entry = pendingSetArmed.get(r.id);
        if (!entry) return;
        pendingSetArmed.delete(r.id);
        clearTimeout(entry.timer);
        entry.resolve({ ok: r.ok, error: r.error });
        return;
      }
      if (
        (msg as RequestHandoffResultMessage).type === "request-handoff-result"
      ) {
        const r = msg as RequestHandoffResultMessage;
        const entry = pendingRequestHandoff.get(r.id);
        if (!entry) return;
        pendingRequestHandoff.delete(r.id);
        clearTimeout(entry.timer);
        entry.resolve({ ok: r.ok, error: r.error, conflict: r.conflict });
        return;
      }
      if ((msg as RequestAwaitResultMessage).type === "request-await-result") {
        const r = msg as RequestAwaitResultMessage;
        const entry = pendingRequestAwait.get(r.id);
        if (!entry) return;
        pendingRequestAwait.delete(r.id);
        clearTimeout(entry.timer);
        entry.resolve({ ok: r.ok, error: r.error });
        return;
      }
    },
  );

  // Realtime layer: poll data_version and fan committed changes out as
  // per-entity patches, on the worker's own read-only connection (shared with
  // query serving — both autocommit reads). A loop crash is unrecoverable: exit
  // non-zero → LaunchAgent restart.
  pollLoop(
    db,
    () => server.conns,
    () => stopping,
    data.pollMs,
    // fn-1096.3: countable backstop telemetry for a tolerated transient
    // SQLITE_NOTADB on the data_version poll.
    (consecutiveMisses) => {
      console.error(
        `[server-worker] transient SQLITE_NOTADB on data_version poll — skipped tick (consecutive=${consecutiveMisses})`,
      );
      parentPort?.postMessage({
        kind: "backstop",
        record: buildTimeoutRecord({
          backstop: "notadb-skip",
          worker: "server-worker",
          rescued: true,
          now: Date.now(),
          stalenessMs: null,
          detail: { consecutive_misses: String(consecutiveMisses) },
        }),
      } satisfies BackstopMessage);
    },
    fanoutCursor,
  )
    .then(() => {
      // Clean loop exit. Signal `shutdown()` that the poll connection is idle so
      // it can safely close `db`.
      resolvePollDone?.();
    })
    .catch((err) => {
      console.error("[server-worker] poll loop crashed:", err);
      try {
        server.stop();
      } catch {
        // best-effort
      }
      process.exit(1);
    });

  parentPort.postMessage({ kind: "ready" } satisfies ReadyMessage);
}

// Only run inside a real Worker spawned AS the server (`role: "server"`).
// A plain import on the main thread is inert; an import from ANOTHER worker
// module (which needs `runQuery` but is not the server) must NOT spawn a
// competing server — the role gate enforces that.
if (
  !isMainThread &&
  (workerData as ServerWorkerData | undefined)?.role === "server"
) {
  main();
}
