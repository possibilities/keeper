/**
 * Shared subscribe client + readiness handoff for the keeper collections, plus
 * a generic single-collection subscribe helper. One imperative API: callers
 * pass a snapshot/rows callback and get back a `dispose()` handle. The helpers
 * own the connection lifecycle (capped-backoff reconnect, per-collection
 * coalesce, steady-poll backstop) plus the first-paint gate and the per-frame
 * projection; callers do rendering on top.
 *
 * Two public entry points:
 * - `subscribeCollection({ ... })` — single-collection subscribe (sidecar UIs
 *   like `scripts/git.ts`). Fires `onRows(rows)` once per `result` frame, no
 *   `computeReadiness` handoff. Terminal-error semantics: a pre-paint `error`
 *   is unrecoverable ONLY when its `code` is NOT in `TRANSIENT_SERVER_CODES`
 *   (a malformed query); a transient code rides the reconnect loop even
 *   pre-paint. Post-paint, errors are transient.
 * - `subscribeReadiness({ ... })` — multi-collection composition (board,
 *   autopilot). All collections ride a single connection; the all-strict
 *   first-paint gate withholds `onSnapshot` until each has produced a
 *   `result`, then `computeReadiness` runs. `dead_letters` rides its
 *   `filter: { status: "waiting" }` scope so the stream tracks only the
 *   unrecovered backlog.
 *
 * Both helpers share one internal driver (`subscribeMulti`) that owns the
 * socket, the reconnect-with-backoff loop, the line buffer, the per-collection
 * coalescer, the steady-poll backstop, and the terminal-error gate.
 *
 * Why `state.rows` (not `byId.values()`) for `subagent_invocations`: the
 * descriptor exposes `job_id` as the wire pk though the SQL identity is
 * composite `(job_id, agent_id, turn_seq)`. Two re-entrant sub-agents sharing
 * one `job_id` must BOTH reach `computeReadiness` so predicate 6 doesn't
 * false-negative; `byId` collapses them last-write-wins, `rows` carries the
 * full wire-order stream. Covered by `test/board.test.ts`'s regression.
 *
 * Lifecycle contract:
 *   - First-paint gate withholds the callback until every subscribed
 *     collection has produced its first `result` — a partial snapshot would
 *     compute readiness against a wrong-state input. An empty
 *     `dead_letters`/`pending_dispatches`/`armed_epics` still produces a
 *     `result` with `rows: []` so the gate clears.
 *   - Capped-backoff reconnect: 250 ms → 5000 ms doubling, reset on a served
 *     connection. By DEFAULT reconnect-forever (the board/TUI contract). An
 *     opt-in `giveUpPolicy` bounds the CONTINUOUS-UNPAINTED window: when no
 *     first `result` lands within `deadlineMs` the driver tears down and fires
 *     `onFatal({ code: "unreachable" })` once.
 *   - Poll loop (`POLL_MS` floor, ADAPTIVE while idle — see `nextIdlePollDelayMs`):
 *     slow-flight/timeout detection on any IN-FLIGHT query, plus a steady-state
 *     LIVENESS HEARTBEAT — after `HEARTBEAT_IDLE_MS` with no inbound frame and
 *     nothing in flight it sends ONE probe refetch, so a silently-dead socket
 *     (a bounce leaving the transport half-open, or an app-level eviction) is
 *     torn down + reconnected instead of holding stale
 *     state forever. Real-time `patch`/`meta` frames drive data freshness.
 *   - Epoch guard: the boot header's per-daemon-boot `generation` nonce is
 *     tracked across reconnects; a change forces the re-baseline path (drop every
 *     resumable version cursor) and fires `generation_change` — a bounce never
 *     resumes a dead sequence even if the transport never signalled the drop.
 *   - On teardown (disconnect or `dispose`): reset every collection's `rows` /
 *     `byId` / `order` / `gotResult`, and HARD-destroy the held socket
 *     (`destroySocket` → `terminate()`, NOT `end()`) so the native buffers +
 *     libuv handle are freed IMMEDIATELY rather than pinned until a (possibly
 *     never-arriving) peer FIN. A graceful `end()` against a wedged daemon
 *     leaks ~1.4–2.2 KB of native memory per reconnect (invisible to the JS
 *     heap, surviving GC) → the observed ~2GB `keeper await` runaway.
 *     `scripts/subscribe-bounce-soak.ts` is the flat-RSS evidence gate.
 *   - `dispose()` is idempotent.
 *   - `onSnapshot` / `onRows` exceptions are NOT swallowed — they propagate to
 *     the caller (the "no in-process self-heal" stance).
 *   - SIGINT remains the CALLER's concern.
 */

import { computeEligibleEpics } from "./armed-closure";
import {
  projectMaxConcurrentJobs,
  projectMaxConcurrentPerRoot,
  projectWorktreeMode,
  projectWorktreeMultiRepo,
} from "./autopilot-projection";
import { getCollection } from "./collections";
import { effectivePerRootCap } from "./db";
import {
  type BootStatus,
  encodeFrame,
  type FilterValue,
  LineBuffer,
  type QueryFrame,
  type QuerySort,
  type Row,
  type ServerFrame,
} from "./protocol";
import {
  computeReadiness,
  type PendingDispatch,
  type ReadinessSnapshot,
} from "./readiness";
import { isOpenTurnRow } from "./subagent-invocations";
import type {
  BlockEscalation,
  DeadLetter,
  Epic,
  GitStatus,
  Job,
  ScheduledTask,
  SubagentInvocation,
  TmuxClientFocus,
} from "./types";

// ---------------------------------------------------------------------------
// Tuning constants — same values the prior board.ts standalone code used.
// ---------------------------------------------------------------------------

// Page limit 0 = full filtered set, no LIMIT cap. Every readiness collection
// uses it: the default jobs scope is LIVE-only and the rest are intrinsically
// bounded (one row per worktree / armed epic / in-flight launch), and
// readiness needs every row to compute the right counts / mutex slots /
// armed-closure. A `created_at DESC` cap would silently drop the oldest live
// session; a sub-agent page would break the ×N count/stuck math and fight the
// `job_id` wire-pk diff.
const JOBS_PAGE_LIMIT = 0;
const EPICS_PAGE_LIMIT = 0;
const SUBAGENT_INVOCATIONS_PAGE_LIMIT = 0;
const GIT_PAGE_LIMIT = 0;
const DEAD_LETTERS_PAGE_LIMIT = 0;
const PENDING_DISPATCHES_PAGE_LIMIT = 0;
const AUTOPILOT_STATE_PAGE_LIMIT = 0;
const ARMED_EPICS_PAGE_LIMIT = 0;
const SCHEDULED_TASKS_PAGE_LIMIT = 0;
// One row per currently-blocked plan task — intrinsically bounded by the board's
// blocked-task count, so unbounded (0) like the other latch collections.
const BLOCK_ESCALATIONS_PAGE_LIMIT = 0;
// The `tmux_client_focus` singleton (fn-952) — at most one row (`id = 1`), so
// unbounded (0) like the other singleton collections.
const TMUX_CLIENT_FOCUS_PAGE_LIMIT = 0;
// The `lane_merged` observable — one row per merged-lane epic, bounded
// by board size, so unbounded (0) like the other epic-keyed collections.
const LANE_MERGED_PAGE_LIMIT = 0;
// The `dispatch_failures` collection — subscribed UNBOUNDED (0 = the no-row-cap
// sentinel) under the `includeDispatchFailures` opt-in: the collection
// self-prunes as stickies resolve, and exact counts are load-bearing for the
// instant-death-wall threshold, so a silent page-cap truncation is the worse
// failure than an unbounded small collection (ADR 0011).
const DISPATCH_FAILURES_PAGE_LIMIT = 0;
export const POLL_MS = 500;
/**
 * Adaptive idle-poll growth factor + cap (steady-state level-triggered
 * waiting). `pollAll`'s own per-tick work is trivial, but firing it
 * unconditionally every `POLL_MS` for the lifetime of a reconnect-forever
 * `keeper await` is the dominant steady-state cost purely by TIME COVERAGE —
 * it runs the whole connected window, unlike the catching-up backstop (a few
 * short post-bounce windows) or per-frame re-evaluation (bounded by genuine
 * board activity, near-zero on the quiet board the incident hit). While IDLE
 * (nothing in flight AND no inbound frame since the last tick) the poll delay
 * DOUBLES each tick up to `MAX_IDLE_POLL_MS`; ANY in-flight query, a fresh
 * inbound frame, or a just-fired heartbeat probe resets it to the `POLL_MS`
 * floor so slow-flight/timeout detection on active work is never delayed. See
 * `nextIdlePollDelayMs`.
 */
export const POLL_IDLE_GROWTH_FACTOR = 2;
export const MAX_IDLE_POLL_MS = 8_000;
const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5000;
// Cap-reject (capacity-transient) backoff base. A `max_connections` reject was
// ACCEPTED then served an error and closed, so an immediate retry worsens the
// contended cap and a whole await fleet retries in lockstep — cap rejects ride
// this LONGER base with FULL jitter (`random(0, capped_window)`), distinct from
// the deterministic 250ms→5s socket-level ladder.
const TRANSIENT_BACKOFF_BASE_MS = 2500;
// Cap-reject backoff CEILING — distinct from (and far above) the socket-level
// `MAX_BACKOFF_MS`. Under a saturated cap, ~24 concurrent awaits each retrying
// every ≤5s burned ~20 conn-ids/min and re-saturated the cap in lockstep
// (fn-778). A 30s ceiling on the EXPONENTIAL transient window (base 2500ms,
// doubling, FULL jitter over `[0, window)`) bounds the steady-state reconnect
// rate to ~2/min/client while the cap is full, instead of hammering it.
const TRANSIENT_BACKOFF_CAP_MS = 30_000;
/**
 * Server error codes that are CAPACITY-TRANSIENT, not query-terminal. A
 * `max_connections` reject is "full right now," which the reconnect loop
 * recovers from — NOT a malformed query. An error frame whose `code` is in this
 * set is routed to teardown + reconnect (never `onFatal`), even pre-paint. A
 * NAMED allowlist so the terminal path stays narrow (only ABSENT codes are
 * unrecoverable pre-paint).
 */
export const TRANSIENT_SERVER_CODES = new Set<string>(["max_connections"]);
/**
 * Slow-flight + hard-deadline thresholds for an in-flight `query`. `pollAll`
 * compares `Date.now() - queryInFlightSince` against these: at `SLOW_FLIGHT_MS`
 * it emits one `query_slow_flight` (latched so it fires once per stuck window);
 * at `QUERY_TIMEOUT_MS` it concludes the connection is wedged, emits
 * `query_timeout`, and tears down so `connectWithRetry` reconnects. `Date.now()`
 * is correct here — wall-clock thresholds, in-process state cleared on teardown.
 */
const SLOW_FLIGHT_MS = 1000;
const QUERY_TIMEOUT_MS = 5000;
/**
 * Catching-up backstop interval. While the per-connection catching-up latch is
 * set, refetch ONE idle subscribed collection this often so a freshly stamped
 * `result` always arrives to observe the settling flip: `boot-complete` fans out
 * to no subscriber and `patch`/`meta` carry no header, so a quiet board would
 * otherwise wedge the latch. Slow on purpose (an idle-state poll is churn) and
 * disarmed the moment the latch clears. Deliberately DISTINCT from `POLL_MS`,
 * which stays 500ms slow-flight detection ONLY and is never widened for this.
 */
export const CATCHUP_BACKSTOP_MS = 3000;
/**
 * Steady-state liveness heartbeat threshold. After first paint the client is
 * IDLE — it holds no in-flight query and waits on server-pushed `patch`/`meta`
 * frames — so `pollAll`'s slow-flight/timeout logic (which only inspects an
 * IN-FLIGHT query) can never fire. A daemon bounce that leaves the socket
 * half-open (or an app-level subscription eviction) then delivers NEITHER an EOF
 * NOR any frame, and the viewer holds its last-painted state forever (the
 * observed "board stuck on a closed epic across bounces until restart"). This is
 * the app-level loss detector: when the connection has gone this long with no
 * inbound frame AND nothing is in flight, send ONE probe refetch; a live daemon
 * answers (resetting the clock, no repaint churn since the body byte-matches),
 * while a dead one draws no reply and the existing `QUERY_TIMEOUT_MS` path tears
 * down + reconnects. Deliberately slow — one tiny probe per idle window per
 * viewer, never the fn-921 unbounded refetch — and distinct from `POLL_MS`
 * (500ms slow-flight detection) and `CATCHUP_BACKSTOP_MS` (the catch-up-only
 * settling probe).
 */
export const HEARTBEAT_IDLE_MS = 15_000;

/**
 * Pure adaptive-interval step for the steady-poll cadence. `active` means
 * "this tick saw something happening" (an in-flight query, a fresh inbound
 * frame since the last tick, or a heartbeat probe just fired) — active always
 * resets to the `POLL_MS` floor, immediately, regardless of how far the delay
 * had grown. Idle instead grows the delay by `POLL_IDLE_GROWTH_FACTOR`,
 * capped at `MAX_IDLE_POLL_MS`. A plain number-in/number-out function (no
 * clock, no timer) so the grow/reset/cap contract is pinned by fast-tier
 * tests independent of the real poll-loop wiring.
 */
export function nextIdlePollDelayMs(
  currentDelayMs: number,
  active: boolean,
): number {
  if (active) {
    return POLL_MS;
  }
  return Math.min(currentDelayMs * POLL_IDLE_GROWTH_FACTOR, MAX_IDLE_POLL_MS);
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Snapshot delivered to `onSnapshot` once per emit. `subagentInvocations` is
 * the FLAT `SubagentInvocation[]` projected from `state.rows` (see module
 * docstring for the predicate-6 reasoning). `jobs` is a `Map<job_id, Job>` for
 * the board's per-epic `job_links` lookup. `deadLetters` is the unrecovered
 * backlog; a renderer surfaces its `.length` as the warn-count pill.
 */
export interface ReadinessClientSnapshot {
  readonly epics: Epic[];
  readonly jobs: Map<string, Job>;
  readonly subagentInvocations: SubagentInvocation[];
  // The flat `ScheduledTask[]` projected from `state.rows` (the composite
  // `(job_id, cron_id)` identity collapses under `byId`, so the snapshot
  // carries every cron). The jobs TUI buckets it by `job_id` per frame.
  readonly scheduledTasks: ScheduledTask[];
  readonly gitStatus: GitStatus[];
  readonly deadLetters: DeadLetter[];
  // The open `pending_dispatches` rows fed into `computeReadiness` so the
  // board/CLI path agrees with the reconciler on the `dispatch-pending`
  // occupant; rides on the snapshot for a renderer that wants the in-flight
  // launch list.
  readonly pendingDispatches: PendingDispatch[];
  // fn-941: the `block_escalations` latch rows — one per currently-blocked plan
  // task the daemon producer has armed. The board renders an escalated task
  // distinctly and `keeper await` reads it (with `autopilotPaused`) to soften an
  // escalated-but-paused stall from `stuck` to `waiting`.
  readonly blockEscalations: BlockEscalation[];
  // fn-941: the autopilot reconciler's paused flag, read off the `autopilot_state`
  // singleton (number column coerced to boolean; a missing/malformed row defaults
  // to PAUSED, mirroring `cli/autopilot.ts`'s coercion). Pairs with
  // `blockEscalations` for the escalated-but-paused await softening.
  readonly autopilotPaused: boolean;
  // fn-1015: the autopilot mode / caps / worktree the readiness pass already
  // computes to mirror the daemon's armed-mode dispatch but otherwise dropped.
  // ADDITIVE — these touch neither the `states` array, the first-paint gate, nor
  // the readiness verdict; un-dropped here so every downstream reader (board,
  // dash, await, the new `keeper status`/`watch`) orients off ONE snapshot.
  // `autopilotMode` reuses the local that feeds `computeReadiness`'s armed-mode
  // eligibility (`'yolo'` on a missing/malformed row). `maxConcurrentPerRoot` is
  // the EFFECTIVE cap the readiness pass used, DERIVED off the folded
  // `autopilot_state` through `effectivePerRootCap` (the ONE seam) — the SAME
  // {stored, worktree_mode} the fields below report, so it can never skew against
  // them; an empty/malformed singleton (worktree off) floors it to 1.
  // `maxConcurrentJobs` (`null` = unlimited) and `worktreeMode` come off the same
  // singleton via the shared `cli/autopilot.ts` projectors (never re-coerced
  // inline); an empty/malformed singleton defaults to unlimited / off.
  readonly autopilotMode: "yolo" | "armed";
  // The armed ∪ transitive-upstream eligibility closure (sorted, stable) the
  // reconciler dispatches against in `armed` mode. `undefined` in `yolo` mode —
  // no eligibility filter, matching the `eligibleEpicIds` local handed to
  // `computeReadiness`.
  readonly autopilotEligibleEpicIds?: readonly string[];
  readonly maxConcurrentJobs: number | null;
  readonly maxConcurrentPerRoot: number;
  // The durable STORED per-root intent — projected off the same `autopilot_state`
  // rows this snapshot subscribes. `maxConcurrentPerRoot` above is the EFFECTIVE
  // cap derived from THIS value + `worktreeMode` via `effectivePerRootCap` (floored
  // to 1 while worktree off); this is what the operator SET, honored while worktree
  // mode is on and surfaced distinctly even when it exceeds the effective cap.
  // ABSENT (undefined) when no autopilot rows have folded — a pre-fold singleton
  // nulls it rather than FABRICATING a stored value from the effective default.
  readonly maxConcurrentPerRootStored?: number;
  readonly worktreeMode: boolean;
  // The durable multi-repo worktree rollout flag off the same `autopilot_state`
  // singleton (`false` on an empty/malformed row). ADDITIVE alongside
  // `worktreeMode` — surfaced so `keeper status .data.autopilot` and `keeper
  // autopilot show` round-trip every durable knob off ONE snapshot.
  readonly worktreeMultiRepo: boolean;
  // The durable MERGE-LANDED set — epic ids whose work is provably on the
  // default branch, for `keeper await landed` and `keeper status`. Sorted, stable.
  // Present ONLY under the `includeRecentDoneEpics` opt-in (the OFF degradation
  // reads done epics, which only join `epics` then) — `undefined` for board/dash so
  // their first-paint stays byte-identical (mirrors `autopilotEligibleEpicIds`).
  // Worktree mode ON: the `lane_merged` projection (an `ok` epic's lane merged into
  // default, or torn-down). Worktree mode OFF: degrades cleanly to DONE epics (no
  // lanes exist; merged ⇔ done) — see {@link computeLandedEpicIds}.
  readonly landedEpicIds?: readonly string[];
  // ADR 0011 OPT-IN: the sticky `dispatch_failures` rows (verb/id/reason/dir
  // intact off the fold), backing three of the six needs-human signals (stuck
  // dispatches, finalize non-ff, the instant-death wall). Present ONLY under the
  // `includeDispatchFailures` opt-in (status/watch/await's jam path) — ABSENT
  // (not null, not empty) for board/dash so their first-paint stays
  // byte-identical (mirrors `landedEpicIds`). The gated fold subscribes unbounded
  // (limit 0) so the wall-threshold counts are exact; the shared projector owns
  // the reason classification so status/watch/await never drift on "stuck".
  readonly dispatchFailures?: readonly Row[];
  // ADR 0018 OPT-IN: the PINNED epics — every epic a live close/work
  // `dispatch_failures` row keys to, ANY status (the display-only pinned board
  // collection). Present ONLY under the `includePinnedEpics` opt-in — ABSENT (not
  // null, not empty) for board/dash so their first-paint stays byte-identical
  // (mirrors `landedEpicIds` / `dispatchFailures`). The rows also MERGE open-wins
  // into `epics` (a pinned closed epic gets a real `computeReadiness` verdict);
  // this member stays the distinct pinned-identity signal so a consumer renders
  // the pinned block WITHOUT re-scanning `epics`, and the needs-human count never
  // double-counts a pin as an orphan.
  readonly pinnedEpics?: readonly Epic[];
  // fn-952: the `tmux_client_focus` singleton row (`id = 1`) — the persistent
  // control worker's view of the current real client's focused
  // session/window/pane. `undefined` when the singleton is empty (no-tmux env or
  // a worker that never connected) OR its `status` is `'none'`; the `keeper jobs`
  // banner renders `[focus: none]` in both cases.
  readonly tmuxFocus?: TmuxClientFocus;
  readonly readiness: ReadinessSnapshot;
}

/**
 * Fatal-error payload handed to `onFatal` when a terminal `error` frame
 * arrives BEFORE any collection has painted (a malformed query — `bad_frame` /
 * `unknown_collection`). `rev` is the wire-level world-rev when known. Same
 * shape `onLifecycle` receives; `onFatal` lets callers act on it.
 */
export interface FatalError {
  readonly code: string;
  readonly rev?: number;
  readonly message: string;
}

/**
 * Opt-in bounded give-up policy. When set, the driver bounds how long it will
 * spin reconnecting without ever PAINTING. The deadline is a
 * CONTINUOUS-UNPAINTED wall-clock budget, NOT an attempt count (`attempt`
 * resets on every socket `open`, so a flapping accept-then-drop never trips an
 * attempt cap). The anchor is armed at subscribe start, CLEARED on first paint
 * (the first `result`, NOT socket `open`, so a half-up daemon that accepts but
 * never serves still gives up), and RE-ARMED on any post-paint drop. When
 * `now() - anchor >= deadlineMs` the driver tears down and fires
 * `onFatal({ code: "unreachable" })` once. Default (no policy) is
 * reconnect-forever. Bounds BOTH never-connected and was-connected-then-lost.
 */
export interface GiveUpPolicy {
  /**
   * Continuous-unpainted budget in ms, measured against the injected `now()`
   * clock so the fake-timer harness can drive the deadline without advancing
   * real wall-clock.
   */
  readonly deadlineMs: number;
}

/**
 * Minimal socket shape the helper drives — `write` to push frames, `end` to
 * half-close (graceful FIN), `terminate` to HARD-close. A named type so the
 * test-injection `connect` factory can return a mock without `bun:types`.
 *
 * On EVERY client-initiated teardown the driver must `terminate()`, NOT
 * `end()`: a graceful FIN against a half-up/dead daemon that never closes its
 * side leaves the native read/write buffer + libuv handle PINNED (invisible to
 * the JS heap, surviving GC), leaking per reconnect → the ~2GB `keeper await`
 * runaway. `terminate()` frees them immediately, peer-cooperation-free.
 *
 * Optional so the in-memory mock needn't implement it; the driver
 * feature-detects (`sock.terminate?.()`) and `Bun.connect` always provides it.
 */
export interface ReadinessSocket {
  write(data: string): void;
  end(): void;
  terminate?(): void;
}

/**
 * Socket factory injected via `connect`. The helper hands the factory a
 * `handlers` bag carrying `data` / `close` / `error` callbacks; the factory
 * returns the live socket (or rejects, kicking the reconnect-backoff loop).
 * In production this wraps `Bun.connect({ unix, socket })`; in tests, the
 * mock implementation hands the helper a controllable socket that records
 * writes and exposes the handlers for direct frame delivery.
 */
export interface SocketHandlers {
  open(sock: ReadinessSocket): void;
  data(sock: ReadinessSocket, chunk: Buffer): void;
  close(): void;
  error(sock: ReadinessSocket, err: Error): void;
}

export type ConnectFactory = (
  sockPath: string,
  handlers: SocketHandlers,
) => Promise<ReadinessSocket>;

/**
 * Caller-facing handle. `dispose()` is idempotent — safe to call from a
 * SIGINT handler that may also be reached via a normal exit path.
 */
export interface ReadinessClientHandle {
  dispose(): void;
}

/**
 * Lifecycle-event callback shape. The driver emits `connecting` / `connected`
 * / `disconnected` / `waiting` / `error` / `query_slow_flight` /
 * `query_timeout` / `heartbeat_probe` / `generation_change` with a small detail
 * payload (fields per event). `query_slow_flight` fires once per stuck in-flight
 * window; `query_timeout` fires just before the socket teardown + reconnect;
 * `heartbeat_probe` fires when the idle-liveness probe is sent; `generation_change`
 * fires when a daemon-generation change is detected across a (re)connect.
 */
export type LifecycleCallback = (
  event: string,
  detail?: Record<string, unknown>,
) => void;

/**
 * Catching-up transition callback (the TUI readiness gate). Fired ONLY when the
 * per-connection catching-up latch FLIPS — a transition, never per frame.
 * `catchingUp` is the gate signal: `true` while the daemon is down / draining /
 * seeding (a display harness paints only its loading indicator), `false` once
 * the daemon reports ready (resume painting). `boot` is the freshest
 * {@link BootStatus} header seen on this connection — the re-fold progress a
 * loading indicator renders — or `undefined` if none has been seen. Headless
 * consumers (`keeper status` / `await` / autopilot CLI) omit it and keep
 * receiving rows unchanged; the latch never gates their data path.
 */
export type CatchingUpCallback = (
  catchingUp: boolean,
  boot: BootStatus | undefined,
) => void;

/**
 * Default-bound `onFatal`: `process.exit(1)`. Callers wanting different
 * semantics (tests, in-process consumers, softer-exit sidecars) pass their own.
 */
function defaultOnFatal(_err: FatalError): void {
  process.exit(1);
}

/**
 * Default `connect` factory: wraps `Bun.connect`. Production callers never
 * override this; tests inject an in-memory mock socket. The factory adapts
 * `Bun.connect`'s socket-handler shape to the minimal `SocketHandlers`
 * interface so callers (tests) don't depend on `bun:types`.
 */
function defaultConnect(
  path: string,
  handlers: SocketHandlers,
): Promise<ReadinessSocket> {
  return Bun.connect({
    unix: path,
    socket: {
      open(sock) {
        handlers.open(sock as ReadinessSocket);
      },
      data(sock, chunk) {
        handlers.data(sock as ReadinessSocket, chunk);
      },
      close() {
        handlers.close();
      },
      error(sock, err) {
        handlers.error(sock as ReadinessSocket, err);
      },
    },
  }) as unknown as Promise<ReadinessSocket>;
}

// ---------------------------------------------------------------------------
// Internal driver: collection state + multi-collection connection loop
// ---------------------------------------------------------------------------

/**
 * Per-collection page + coalescing state. INTERNAL — NOT exported (callers
 * consume the projected snapshot/rows, not the raw `byId` / `order` machinery).
 *
 * `rows` carries the full wire-order stream from the most recent `result`;
 * `byId` keys on the wire pk and collapses duplicates last-write-wins. The two
 * views are equivalent except for `subagent_invocations` (see module docstring).
 */
interface CollectionState {
  readonly collection: string;
  readonly subId: string;
  readonly pk: string;
  /**
   * The descriptor's monotonic per-row version column (`last_event_id`, or
   * `dl_written_at` for `dead_letters`), driving the direct-merge version
   * guard. Empty string for an unknown collection — the guard then degrades to
   * "always accept" (inert for `subscribeReadiness`, which never direct-merges).
   */
  readonly version: string;
  /**
   * When true, a `patch` merges its `frame.row` directly and fires `onResult`,
   * no refetch round-trip. Set ONLY by `subscribeCollection`; left false for
   * `subscribeReadiness` (stays on `scheduleRefetchFor`). `meta` frames always
   * refetch — a membership change can't be reconstructed from one row.
   */
  readonly directMergePatch: boolean;
  readonly query: QueryFrame;
  order: string[];
  byId: Map<string, Record<string, unknown>>;
  rows: unknown[];
  /**
   * Per-pk-value last-seen version cursor for the direct-merge guard. A `patch`
   * whose version isn't strictly greater than the stored cursor is dropped
   * (belt-and-suspenders against reconnect-replay / out-of-order delivery).
   * Seeded from the `result` rows, cleared on teardown.
   */
  lastSeenVersion: Map<string, number>;
  gotResult: boolean;
  queryInFlight: boolean;
  refetchDirty: boolean;
  /**
   * `Date.now()` stamp when `queryInFlight` last went `true`; `null` when no
   * query is in flight (cleared on `result` and teardown). Read by `pollAll`
   * to compute the stuck-window age against `SLOW_FLIGHT_MS` / `QUERY_TIMEOUT_MS`.
   */
  queryInFlightSince: number | null;
  /**
   * Single-fire latch for `query_slow_flight`: non-null means "already emitted
   * once for the current stuck window, suppress until it clears." Cleared
   * whenever `queryInFlightSince` is cleared.
   */
  lastSlowFlightAt: number | null;
}

function makeState(
  collection: string,
  subId: string,
  pk: string,
  query: QueryFrame,
  opts?: { version?: string; directMergePatch?: boolean },
): CollectionState {
  return {
    collection,
    subId,
    pk,
    version: opts?.version ?? "",
    directMergePatch: opts?.directMergePatch ?? false,
    query,
    order: [],
    byId: new Map(),
    rows: [],
    lastSeenVersion: new Map(),
    gotResult: false,
    queryInFlight: false,
    refetchDirty: false,
    queryInFlightSince: null,
    lastSlowFlightAt: null,
  };
}

/**
 * Project a collection state into the typed row stream readiness expects. Uses
 * `state.rows` (not `byId.values()`) so a collection with a composite SQL
 * identity but a single-column wire pk (`subagent_invocations`) delivers every
 * received row, not just the last-write-wins one. Exported for the regression
 * test in `test/board.test.ts`.
 */
export function projectRows<T>(state: { rows: readonly unknown[] }): T[] {
  // The descriptors guarantee the row shape matches the typed projection; the
  // permissive input type lets the regression test hand in a `{ rows: T[] }`
  // literal without an upcast.
  return state.rows as unknown as T[];
}

/**
 * Compute the durable MERGE-LANDED set — the epic ids whose work is
 * provably on the default branch — degrading cleanly across worktree mode. PURE
 * (no socket, no clock), so the snapshot path and tests share one source of truth.
 *
 *  - Worktree mode ON: the `lane_merged` projection ids (an `ok` epic's lane merged
 *    into LOCAL default, or torn-down after the merge). The producer probes git;
 *    this consumer just reads the durable projection.
 *  - Worktree mode OFF: there are no lanes, so "merged" degrades to DONE — the work
 *    landed straight on the default branch when the epic finished. Reads each
 *    epic's `status` (the done epics ride `epics` only under the
 *    `includeRecentDoneEpics` opt-in, which is also what gates this whole signal).
 *
 * Returns a fresh sorted array (stable tick-to-tick so a membership-only consumer
 * never sees spurious churn).
 */
export function computeLandedEpicIds(
  worktreeMode: boolean,
  mergedLaneEpicIds: readonly string[],
  epics: readonly Epic[],
): string[] {
  const ids = worktreeMode
    ? [...mergedLaneEpicIds]
    : epics.filter((e) => e.status === "done").map((e) => e.epic_id);
  ids.sort();
  return ids;
}

/**
 * Project raw `git_status` rows into the `Map<project_dir, {dirty_count,
 * unattributed_to_live_count}>` shape `computeReadiness` consumes.
 * `unattributed_to_live_count` is computed client-side by walking each row's
 * `dirty_files[].attributions[]` and counting files with NO attribution in a
 * live (`working`/`stopped`) state — the mirror of the reducer's PASS-4 fan-out,
 * redone from the same materialized JSON so both numbers reconcile. Defensive
 * parsing throughout (malformed rows fall through to no-attribution).
 *
 * Exported so the autopilot reconciler builds its snapshot from the IDENTICAL
 * math — the reconciler's snapshot must match the wire snapshot byte-for-byte,
 * so this lives in one place.
 */
export function projectGitStatusByProjectDir(
  rows: GitStatus[],
): Map<string, { dirty_count: number; unattributed_to_live_count: number }> {
  const out = new Map<
    string,
    { dirty_count: number; unattributed_to_live_count: number }
  >();
  const LIVE_ATTRIBUTION_STATES = new Set(["working", "stopped"]);
  for (const row of rows) {
    let unattributedToLive = 0;
    for (const file of row.dirty_files) {
      if (typeof file !== "object" || file === null) {
        unattributedToLive++;
        continue;
      }
      const attrs = (file as { attributions?: unknown }).attributions;
      if (!Array.isArray(attrs) || attrs.length === 0) {
        unattributedToLive++;
        continue;
      }
      let hasLive = false;
      for (const a of attrs) {
        if (typeof a !== "object" || a === null) continue;
        const state = (a as { state?: unknown }).state;
        if (typeof state === "string" && LIVE_ATTRIBUTION_STATES.has(state)) {
          hasLive = true;
          break;
        }
      }
      if (!hasLive) unattributedToLive++;
    }
    out.set(row.project_dir, {
      dirty_count: row.dirty_count,
      unattributed_to_live_count: unattributedToLive,
    });
  }
  return out;
}

/**
 * Project the wire `pending_dispatches` rows into the plain
 * {@link PendingDispatch}[] shape `computeReadiness` consumes for the
 * `dispatch-pending` occupant. The SOLE builder — imported by BOTH consumers
 * (the reconciler's `loadReconcileSnapshot` and `subscribeReadiness`) so the
 * two paths never diverge.
 *
 * Defensive parsing: `verb` / `id` are required strings (a row missing either
 * can't form a `verb::id` key, so it's dropped); a non-string `dir` normalises
 * to `null` (the root-fallback degrades safely); a non-finite-number
 * `dispatched_at` (unix SECONDS) normalises to `Infinity` so the row is treated
 * as FRESH (never excluded by the staleness backstop — degrades safely toward
 * holding the slot, exactly as before this field existed).
 */
export function projectPendingDispatches(
  rows: Record<string, unknown>[],
): PendingDispatch[] {
  const out: PendingDispatch[] = [];
  for (const row of rows) {
    const verb = row.verb;
    const id = row.id;
    if (typeof verb !== "string" || typeof id !== "string") {
      continue;
    }
    const dir = typeof row.dir === "string" ? row.dir : null;
    const rawDispatchedAt = row.dispatched_at;
    const dispatched_at =
      typeof rawDispatchedAt === "number" && Number.isFinite(rawDispatchedAt)
        ? rawDispatchedAt
        : Number.POSITIVE_INFINITY;
    out.push({ verb, id, dir, dispatched_at });
  }
  return out;
}

/**
 * Client-side collapse of `subagent_invocations` by `(job_id, subagent_type)`.
 * For each group the highest-`turn_seq` row wins; the folded count AND the
 * stuck-orphan count ride alongside for the board's `(×N)` / `N stuck`
 * annotation, and readiness treats each named sub-agent as one logical agent
 * (so predicate 6 stops false-blocking on orphaned `running` rows whose
 * `SubagentStop` never landed).
 *
 * "Stuck": a row is stuck iff it is NOT the surviving row AND its `status ===
 * 'running'`. Counted inline so the non-surviving rows needn't be retained.
 *
 * OPERATING ASSUMPTION: Claude Code does NOT spawn parallel sub-agents of the
 * same `subagent_type` within one parent session, so "same name in one job"
 * means serial re-invocation and collapsing to the most-recent is the correct
 * logical view. If that ceases to hold, parallel `running` rows of one type
 * collapse to a single status — one masked-orphan recurrence, not a wedged
 * projection.
 *
 * Returns groups in first-seen order; the SURVIVING row per group is the
 * highest-`turn_seq` (not necessarily first-seen). Pure; exported so the board
 * renderer and tests can call it without the subscribe loop.
 */
export interface SubagentGroup {
  readonly row: SubagentInvocation;
  readonly count: number;
  readonly stuck: number;
}

export function collapseSubagentsByName(
  rows: readonly SubagentInvocation[],
): SubagentGroup[] {
  const groups = new Map<
    string,
    { row: SubagentInvocation; count: number; stuck: number }
  >();
  const order: string[] = [];
  for (const row of rows) {
    const key = `${row.job_id}\x00${row.subagent_type ?? ""}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { row, count: 1, stuck: 0 });
      order.push(key);
      continue;
    }
    existing.count += 1;
    if (row.turn_seq > existing.row.turn_seq) {
      // New row supersedes the old surviving. The demoted surviving
      // becomes a stuck orphan iff it is still in flight (open turn:
      // NULL `duration_ms`, status running|ok) — a backgrounded `ok`
      // orphan counts too, a finished `ok` does not.
      if (isOpenTurnRow(existing.row)) {
        existing.stuck += 1;
      }
      existing.row = row;
    } else if (isOpenTurnRow(row)) {
      // Older-than-surviving row that's still in flight — stuck.
      existing.stuck += 1;
    }
  }
  return order.map((k) => {
    // biome-ignore lint/style/noNonNullAssertion: keys mirror the `order` array
    const g = groups.get(k)!;
    return { row: g.row, count: g.count, stuck: g.stuck };
  });
}

/**
 * Internal options passed to `subscribeMulti`:
 *   - `states` — the per-collection page + coalescer machinery.
 *   - `onResult(state)` — fires when a collection's `result` lands (`state` is
 *     already updated).
 *   - `isTerminal(states)` — true iff a pre-paint `error` is a fatal
 *     query-shape error (every collection lacks `gotResult`).
 */
interface MultiOptions {
  readonly sockPath: string;
  readonly states: CollectionState[];
  readonly onResult: (state: CollectionState) => void;
  readonly isTerminal: (states: CollectionState[]) => boolean;
  readonly onLifecycle?: LifecycleCallback;
  readonly onFatal: (err: FatalError) => void;
  readonly connect: ConnectFactory;
  /**
   * fn-897 B1: invoked with the boot-status header carried on every `result`
   * frame (when the server stamps one — present only during catch-up). Lets a
   * consumer (e.g. `keeper await git-clean`) know the git surface is unseeded so
   * it never treats an empty projection as "clean". Optional — most callers omit.
   */
  readonly onBootStatus?: (boot: BootStatus) => void;
  /**
   * Catching-up transition callback (see {@link CatchingUpCallback}). Fired on
   * every latch FLIP, delivering the readiness boolean + freshest header. Drives
   * a display harness's readiness gate; headless callers omit it.
   */
  readonly onCatchingUp?: CatchingUpCallback;
  /** Opt-in bounded give-up. Absent → reconnect-forever. */
  readonly giveUpPolicy?: GiveUpPolicy;
  /**
   * Injectable clock (unix ms), default `Date.now`. The give-up deadline is
   * measured against THIS so the fake-timer harness can drive it without
   * advancing real wall-clock. Production callers omit it.
   */
  readonly now?: () => number;
}

/**
 * Core driver: owns the socket, the reconnect-with-backoff loop, the line
 * buffer, the per-collection coalescer, the steady-poll backstop, the
 * teardown, and the terminal-error gate. Both public helpers compose it.
 */
function subscribeMulti(opts: MultiOptions): ReadinessClientHandle {
  const {
    sockPath,
    states,
    onResult,
    isTerminal,
    onLifecycle,
    onFatal,
    connect,
    giveUpPolicy,
    onBootStatus,
    onCatchingUp,
  } = opts;
  const now = opts.now ?? Date.now;
  const byCollection = new Map(states.map((s) => [s.collection, s]));
  // Parallel id-keyed index for multi-sub-aware routing: the server echoes each
  // query's `id` on its frames, so a connection carrying N concurrent subs
  // routes each frame back to its originating state without disambiguating by
  // collection alone. `subId` is a stable constant per state, so this map is
  // built once. Legacy servers that don't echo `id` fall through to
  // `byCollection`.
  const bySubId = new Map(states.map((s) => [s.subId, s]));

  let currentSock: ReadinessSocket | null = null;
  let attempt = 0;
  // Latched on the first `result` of the CURRENT connection window; gates the
  // `attempt = 0` backoff reset so it keys off PROOF OF SERVICE (served), not
  // socket `open` (accepted) — an accept-then-cap-reject server would otherwise
  // pin the backoff at 0. Reset on every teardown.
  let servedThisConnection = false;
  // Latched when the live connection was torn down by a capacity-transient
  // server reject (the daemon ACCEPTED then served "full"). The close-driven
  // reconnect reads it to back off under the LONGER cap-reject regime; cleared
  // as the first act of the next reconnect (so a later socket-level reject
  // reverts to the 250ms ladder).
  let pendingTransientReject = false;
  let shuttingDown = false;
  /**
   * Single-flight guard for `triggerReconnect`: two simultaneously-stuck
   * collections crossing `QUERY_TIMEOUT_MS` on the same poll tick must produce
   * ONE reconnect, else the second teardown races the first reconnect. Cleared
   * in the `connectOnce` open handler and the `close` handler.
   */
  let reconnecting = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  // ---- adaptive idle poll-interval state (see `nextIdlePollDelayMs`) ----
  // The CURRENT live poll delay in ms. Reset to `POLL_MS` on every fresh
  // `open`; grows while idle, resets to the floor on any activity.
  let currentPollDelayMs = POLL_MS;
  // Monotonic count of inbound frames on the CURRENT connection, bumped
  // alongside `lastInboundAt` in `handleFrame`. `pollTick` compares this
  // against `lastPollFrameSeq` (the value observed as of the previous tick)
  // to detect "a frame arrived since the last tick" — the activity signal
  // `nextIdlePollDelayMs` resets on. A COUNTER, not a `Date.now()` compare:
  // two frames landing in the same wall-clock millisecond (real under
  // batched delivery, routine in a fast test) must still register as
  // activity, which a `>` timestamp compare would miss on a tie.
  let inboundFrameSeq = 0;
  let lastPollFrameSeq = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // ---- steady-state liveness heartbeat (see HEARTBEAT_IDLE_MS) ----
  // Wall-clock (`Date.now`, matching the slow-flight machinery) of the last
  // inbound frame of ANY kind on the CURRENT connection — stamped on `open` and
  // on every `handleFrame`. `pollAll` reads it to detect a silently-dead socket:
  // idle past `HEARTBEAT_IDLE_MS` with nothing in flight ⇒ send one probe. Reset
  // on `open`; irrelevant while torn down (no `currentSock`).
  let lastInboundAt = 0;
  // ---- daemon-generation epoch guard (see BootStatus.generation) ----
  // The last daemon-boot nonce observed on a boot header. DELIBERATELY NOT reset
  // on teardown: it must survive a reconnect so a bounce that re-serves under a
  // NEW generation is detectable across the drop. `undefined` until the first
  // header carrying a generation lands (a server that stamps none leaves the
  // guard inert — the always-re-baseline-on-reconnect contract still holds).
  let lastSeenGeneration: string | undefined;
  // ---- catching-up latch + backstop (see CatchingUpCallback) ----
  // Per-connection value-latch. Starts READY (`false`). A served `result`
  // carrying a boot header sets it to that header's `catching_up` (strict
  // boolean — a malformed value mutates nothing); a headerless `result` observed
  // WHILE latched clears it (the server bypasses its pre-serialized memo during
  // catch-up, so a headerless result is positive steady-state evidence);
  // `patch`/`meta` never touch it; teardown resets it to ready and the next
  // connection's first result re-derives it.
  let catchingUp = false;
  // The freshest boot header seen on THIS connection — the payload a transition
  // hands the gate for its loading-indicator progress. Reset on teardown.
  let freshestBoot: BootStatus | undefined;
  // The slow refetch interval armed only while `catchingUp`. Bun's `setInterval`
  // has no `unref`, so it is `clearInterval`d on every disarm/teardown/dispose.
  let backstopTimer: ReturnType<typeof setInterval> | null = null;
  // Resolves the pending backoff sleep so `dispose()` doesn't leak its timer
  // (a raw `setTimeout`, not `Bun.sleep`, so `dispose()` can `clearTimeout` it).
  let sleepResolve: (() => void) | null = null;
  // ---- bounded give-up state ----
  // The continuous-unpainted anchor (unix ms via the injected `now()` clock).
  // `null` = currently painted (or no policy). Armed at subscribe start,
  // CLEARED on first paint, RE-ARMED on a post-paint drop.
  let unpaintedAnchor: number | null = null;
  // Whether ANY collection has ever painted. Distinguishes the never-connected
  // case (don't re-arm — the anchor is already counting) from the
  // was-connected-then-lost case (re-arm for a fresh post-bounce window).
  let everPainted = false;
  // A timer backstopping the loop-top deadline check: a half-up daemon that
  // accepts the connection but never serves never closes the socket, so
  // `connectOnce` never returns and the loop never re-runs its synchronous
  // check. This timer fires `checkGiveUp` independently. Cancelled in
  // `dispose()` and re-armed (never accumulated) on each anchor (re-)arm.
  let giveUpTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Arm (or re-arm) the unpainted anchor + its backstop timer. No-op when
   * there is no give-up policy or we're shutting down. Always cancels any
   * prior timer first so timers never accumulate across reconnects.
   */
  function armGiveUp(): void {
    if (!giveUpPolicy || shuttingDown) {
      return;
    }
    unpaintedAnchor = now();
    if (giveUpTimer !== null) {
      clearTimeout(giveUpTimer);
      giveUpTimer = null;
    }
    giveUpTimer = setTimeout(() => {
      giveUpTimer = null;
      checkGiveUp();
    }, giveUpPolicy.deadlineMs);
  }

  /** Clear the anchor + cancel the backstop timer (called on first paint). */
  function clearGiveUp(): void {
    unpaintedAnchor = null;
    if (giveUpTimer !== null) {
      clearTimeout(giveUpTimer);
      giveUpTimer = null;
    }
  }

  /**
   * Give up iff the continuous-unpainted deadline has elapsed, measured against
   * the injected `now()`. Called from the top of every `connectWithRetry`
   * backoff iteration (deterministic) and the backstop timer (half-up-daemon
   * path). Self-correcting under the fast-forward harness: a timer that fires
   * before the `now()`-measured deadline RE-ARMS off the residual budget — the
   * deadline is owned by `now()`, not the timer's nominal delay.
   */
  function checkGiveUp(): void {
    if (!giveUpPolicy || shuttingDown || unpaintedAnchor === null) {
      return;
    }
    if (now() - unpaintedAnchor < giveUpPolicy.deadlineMs) {
      // Backstop timer fired early relative to the injected clock — re-arm
      // off the residual budget rather than giving up prematurely.
      if (giveUpTimer === null) {
        giveUpTimer = setTimeout(
          () => {
            giveUpTimer = null;
            checkGiveUp();
          },
          giveUpPolicy.deadlineMs - (now() - unpaintedAnchor),
        );
      }
      return;
    }
    // Deadline reached. Tear down BEFORE `onFatal` (so a custom handler
    // observes the helper fully shut down and exceptions propagate — the
    // no-self-heal contract).
    shuttingDown = true;
    unpaintedAnchor = null;
    teardownConnection();
    onFatal({
      code: "unreachable",
      message: `give-up: no first paint within ${giveUpPolicy.deadlineMs}ms`,
    });
  }

  function emit(event: string, detail?: Record<string, unknown>): void {
    onLifecycle?.(event, detail);
  }

  function scheduleRefetchFor(state: CollectionState): void {
    if (shuttingDown || !currentSock) {
      return;
    }
    if (state.queryInFlight) {
      state.refetchDirty = true;
      return;
    }
    state.queryInFlight = true;
    // Stamp the in-flight-since clock and reset the slow-flight latch so the
    // next stuck window gets exactly one emit. Cleared symmetrically in the
    // `result` branch.
    state.queryInFlightSince = Date.now();
    state.lastSlowFlightAt = null;
    currentSock.write(encodeFrame(state.query));
  }

  /**
   * One catching-up backstop tick: refetch the FIRST idle subscribed collection
   * (not in flight) through the shared `scheduleRefetchFor` coalescer, so a
   * freshly stamped `result` arrives to observe the settling flip. When every
   * collection is already in flight the tick is a no-op — those in-flight
   * results will themselves carry the settling header. Guarded so a timer that
   * fires between a clear and its `disarm` does nothing.
   */
  function runBackstopTick(): void {
    if (shuttingDown || !currentSock || !catchingUp) {
      return;
    }
    for (const s of states) {
      if (!s.queryInFlight) {
        scheduleRefetchFor(s);
        return;
      }
    }
  }

  /** Arm the backstop interval (idempotent; inert while shutting down). */
  function armBackstop(): void {
    if (backstopTimer !== null || shuttingDown) {
      return;
    }
    backstopTimer = setInterval(runBackstopTick, CATCHUP_BACKSTOP_MS);
  }

  /** Disarm + clear the backstop interval (idempotent). */
  function disarmBackstop(): void {
    if (backstopTimer !== null) {
      clearInterval(backstopTimer);
      backstopTimer = null;
    }
  }

  /**
   * Fold one `result` frame into the catching-up latch, arming/disarming the
   * backstop and firing `onCatchingUp` on a FLIP only. Called for every `result`
   * (header-carrying or not); `patch`/`meta` bypass it so they never mutate the
   * latch.
   */
  function updateCatchingUpLatch(frame: ServerFrame): void {
    let next = catchingUp;
    if (frame.type === "result" && frame.boot !== undefined) {
      freshestBoot = frame.boot;
      // Strict boolean — a malformed `catching_up` mutates nothing.
      if (typeof frame.boot.catching_up === "boolean") {
        next = frame.boot.catching_up;
      }
    } else if (catchingUp) {
      // A headerless `result` while latched is positive steady-state evidence
      // (catch-up stamps every served frame; the memo path — headerless — only
      // re-engages once `catching_up` is false). Clear.
      next = false;
    }
    if (next === catchingUp) {
      return;
    }
    catchingUp = next;
    if (catchingUp) {
      armBackstop();
    } else {
      disarmBackstop();
    }
    onCatchingUp?.(catchingUp, freshestBoot);
  }

  /**
   * Tear down the live connection on a hard query timeout. Emits
   * `query_timeout` for the state that crossed the deadline, then
   * `teardownConnection()`; the `close` handler drives the reconnect, so no new
   * plumbing. Guarded by `reconnecting` so two stuck collections crossing the
   * threshold on the same poll produce one reconnect.
   */
  function triggerReconnect(state: CollectionState): void {
    if (reconnecting || shuttingDown) {
      return;
    }
    reconnecting = true;
    const ageMs =
      state.queryInFlightSince === null
        ? 0
        : Date.now() - state.queryInFlightSince;
    emit("query_timeout", {
      collection: state.collection,
      query_id: state.subId,
      sock: sockPath,
      age_ms: ageMs,
    });
    // `teardownConnection()` HARD-destroys the held socket (`terminate()`), so
    // it's forcibly closed here; the resulting `close` callback fires, so
    // `connectWithRetry` re-runs.
    teardownConnection();
  }

  /**
   * Returns whether this tick was ACTIVE (something in flight, or a heartbeat
   * probe just went out) — `pollTick` folds this into the adaptive-interval
   * decision. `false` on the early return from a triggered reconnect is
   * irrelevant: `pollTick` checks `currentSock`/`shuttingDown` first and never
   * consults the return value on that path.
   */
  function pollAll(): boolean {
    // Two jobs on each tick, both reading the wall clock (in-process state
    // cleared on teardown, so `Date.now()` is correct here):
    //   1. SLOW-FLIGHT DETECTION: walk every state, compare `Date.now() -
    //      queryInFlightSince` against the thresholds, and emit a one-shot
    //      `query_slow_flight` or trigger a reconnect. No data refetch is
    //      scheduled — real-time `patch`/`meta` drive freshness via
    //      `scheduleRefetchFor`.
    //   2. LIVENESS HEARTBEAT: when the connection is fully idle (nothing in
    //      flight) and has drawn no inbound frame for `HEARTBEAT_IDLE_MS`, send
    //      ONE probe refetch so a silently-dead socket (a bounce that leaves the
    //      transport half-open with no EOF, or an app-level eviction) surfaces —
    //      the probe either draws a fresh reply (live) or times out into job 1's
    //      reconnect (dead). Without it a steady-state viewer never notices loss.
    const now = Date.now();
    let anyInFlight = false;
    for (const s of states) {
      if (!s.queryInFlight || s.queryInFlightSince === null) {
        continue;
      }
      anyInFlight = true;
      const age = now - s.queryInFlightSince;
      if (age >= QUERY_TIMEOUT_MS) {
        triggerReconnect(s);
        return true;
      }
      if (age >= SLOW_FLIGHT_MS && s.lastSlowFlightAt === null) {
        emit("query_slow_flight", {
          collection: s.collection,
          query_id: s.subId,
          sock: sockPath,
          age_ms: age,
        });
        s.lastSlowFlightAt = now;
      }
    }
    // Heartbeat: fire only when steady (no query in flight — so it never
    // double-probes an in-flight round and is naturally inert pre-first-paint,
    // when the opening queries are all in flight) and idle past the threshold.
    // The probe rides the shared coalescer; its reply re-stamps `lastInboundAt`
    // and, being byte-identical on a quiet board, repaints nothing.
    let heartbeatFired = false;
    if (
      !anyInFlight &&
      currentSock !== null &&
      !shuttingDown &&
      states.length > 0 &&
      now - lastInboundAt >= HEARTBEAT_IDLE_MS
    ) {
      emit("heartbeat_probe", { sock: sockPath, idle_ms: now - lastInboundAt });
      scheduleRefetchFor(states[0]);
      heartbeatFired = true;
    }
    return anyInFlight || heartbeatFired;
  }

  /**
   * The live `pollTimer` handler. Wraps `pollAll` with the adaptive
   * idle-interval decision (`nextIdlePollDelayMs`): "activity" is anything
   * `pollAll` reports OR a frame having arrived since the last tick (detected
   * via `inboundFrameSeq`, a monotonic counter — a patch/meta/result that
   * resolves between two ticks still counts, so a genuinely busy board never
   * grows the interval). When the computed delay changes, the live timer is
   * re-armed at the new delay; when it doesn't (the common capped-idle or
   * floor-active steady case), the existing timer is left running untouched.
   * `pollAll` may itself trigger a reconnect (tearing down `currentSock` +
   * `pollTimer`); this checks both AFTER calling it so it never re-arms a
   * timer for a connection that's gone — the fresh connection's `open`
   * handler arms its own floor-cadence timer.
   */
  function pollTick(): void {
    const hadInbound = inboundFrameSeq !== lastPollFrameSeq;
    lastPollFrameSeq = inboundFrameSeq;
    const active = pollAll() || hadInbound;
    if (shuttingDown || currentSock === null) {
      return;
    }
    const nextDelayMs = nextIdlePollDelayMs(currentPollDelayMs, active);
    if (nextDelayMs === currentPollDelayMs) {
      return;
    }
    currentPollDelayMs = nextDelayMs;
    if (pollTimer) {
      clearInterval(pollTimer);
    }
    pollTimer = setInterval(pollTick, currentPollDelayMs);
  }

  /**
   * Read a row's monotonic version-column value as a number, or `null` when
   * the column is absent / non-numeric (or the state has no version column —
   * an unknown collection). The descriptor's `version` is `last_event_id`
   * (an integer) for every collection but `dead_letters`, whose
   * `dl_written_at` is an epoch-ms integer — both compare with `>` cleanly.
   */
  function rowVersion(
    state: CollectionState,
    row: Record<string, unknown>,
  ): number | null {
    if (state.version === "") {
      return null;
    }
    const raw = row[state.version];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  }

  /**
   * Merge a `patch` frame's row into `state` in place (upsert `byId`, replace
   * the matching `rows` entry, re-arm the per-pk version cursor). Returns true
   * iff the merge happened. Dropped when: pk missing; the pk isn't already
   * tracked (off-page — a genuine membership change arrives as `meta`); or its
   * version isn't strictly newer than the last-seen cursor (the version guard
   * against reconnect-replay / out-of-order delivery).
   */
  function mergePatchRow(
    state: CollectionState,
    row: Record<string, unknown>,
  ): boolean {
    const pkVal = row[state.pk];
    if (pkVal === undefined || pkVal === null) {
      return false;
    }
    const id = String(pkVal);
    // Membership guard: an id we don't already track is off-page noise — drop
    // it rather than blind-append (a `meta` carries a genuine membership change).
    if (!state.byId.has(id)) {
      return false;
    }
    // Version guard, per-pk. Inert (accept) when the column is absent/non-numeric.
    const v = rowVersion(state, row);
    if (v !== null) {
      const last = state.lastSeenVersion.get(id);
      if (last !== undefined && v <= last) {
        return false;
      }
    }
    state.byId.set(id, row);
    // Replace the matching `rows` entry in wire/page order. The id is in
    // `order` by the membership guard above, so the lookup always hits.
    const idx = state.order.indexOf(id);
    if (idx !== -1) {
      state.rows[idx] = row;
    }
    if (v !== null) {
      state.lastSeenVersion.set(id, v);
    }
    return true;
  }

  /**
   * Epoch guard (see {@link BootStatus.generation}). Compare a boot header's
   * per-daemon-boot nonce against the last one seen. A change means the daemon
   * bounced across this (re)connect — the ONLY wire signal of it, since `rev`
   * and `head_event_id` both persist a plain restart. Force the re-baseline
   * path: drop every per-pk version cursor so no PRE-bounce version can bias a
   * POST-bounce direct-merge `patch` into a stale drop/accept (the fresh full
   * page reseeds them). Emits `generation_change` so a consumer can observe the
   * detected bounce. Inert when the header carries no generation (older server)
   * or on the first-ever observation (nothing to compare).
   */
  function checkGeneration(boot: BootStatus | undefined): void {
    const gen = boot?.generation;
    if (gen === undefined) {
      return;
    }
    if (lastSeenGeneration !== undefined && gen !== lastSeenGeneration) {
      emit("generation_change", { from: lastSeenGeneration, to: gen });
      for (const s of states) {
        s.lastSeenVersion.clear();
      }
    }
    lastSeenGeneration = gen;
  }

  function handleFrame(frame: ServerFrame): void {
    // Stamp the liveness clock on EVERY inbound frame (result/patch/meta/error)
    // so `pollAll`'s heartbeat measures true connection idleness, not just
    // gaps between full results. `inboundFrameSeq` bumps alongside it for
    // `pollTick`'s activity detection (see its declaration).
    lastInboundAt = Date.now();
    inboundFrameSeq += 1;
    if (frame.type === "result") {
      // fn-897 B1: surface the boot-status header (present during catch-up) so a
      // consumer can detect an unseeded git surface / still-draining reducer. Fired
      // before the per-state handling so a slot evaluating on this same frame sees it.
      if (onBootStatus !== undefined && frame.boot !== undefined) {
        onBootStatus(frame.boot);
      }
      // Epoch guard: detect a daemon-generation change across the (re)connect and
      // force re-baseline BEFORE per-state routing re-pages this collection.
      checkGeneration(frame.boot);
      // Fold this result into the catching-up latch BEFORE per-state routing so
      // a display harness gating on `onCatchingUp` sees the flip alongside the
      // header. Every `result` participates (a headerless one clears while
      // latched); `patch`/`meta` deliberately never reach here.
      updateCatchingUpLatch(frame);
      // Id-first routing: prefer the echoed sub `id`, fall back to `collection`
      // (a legacy server that doesn't echo `id`). Doing this uniformly here
      // keeps result/patch/meta consistent for a future consumer that registers
      // multiple subs on one collection.
      const state =
        (frame.id !== undefined ? bySubId.get(frame.id) : undefined) ??
        byCollection.get(frame.collection);
      if (!state) {
        // A `result` for a sub we don't track — defensive.
        return;
      }
      state.queryInFlight = false;
      // Clear the slow-flight + timeout machinery; the next refetch re-stamps.
      state.queryInFlightSince = null;
      state.lastSlowFlightAt = null;
      state.order.length = 0;
      state.byId.clear();
      state.lastSeenVersion.clear();
      // Re-snapshot `rows` from this frame — see module docstring.
      state.rows = frame.rows.slice();
      for (const row of frame.rows) {
        const id = String(row[state.pk]);
        state.order.push(id);
        state.byId.set(id, row);
        // Re-arm the per-pk version cursor from the authoritative page so a
        // subsequent direct-merge `patch` is compared against this version.
        const v = rowVersion(state, row);
        if (v !== null) {
          state.lastSeenVersion.set(id, v);
        }
      }
      state.gotResult = true;
      // FIRST PAINT clears the give-up anchor. Keyed off the first `result`
      // (the only `gotResult` false→true site), NOT socket `open` — a half-up
      // daemon that accepts but never serves must still give up. `everPainted`
      // latches so a later drop re-arms a FRESH window.
      if (unpaintedAnchor !== null) {
        everPainted = true;
        clearGiveUp();
      }
      // Reset the backoff counter on SERVED (first `result`), NOT socket `open`
      // (accepted) — an accept-then-cap-reject server would otherwise pin it at
      // 0 with no growing backoff. The legitimate daemon-bounce fast-reconnect
      // still resets here on its first post-reconnect result.
      if (!servedThisConnection) {
        servedThisConnection = true;
        attempt = 0;
      }
      onResult(state);
      if (state.refetchDirty) {
        state.refetchDirty = false;
        scheduleRefetchFor(state);
      }
    } else if (frame.type === "patch") {
      // Id-first routing, same fallback chain as `result`.
      const state =
        (frame.id !== undefined ? bySubId.get(frame.id) : undefined) ??
        byCollection.get(frame.collection);
      if (!state) {
        return;
      }
      // Direct-merge the pushed row instead of a refetch — but ONLY for the
      // sidecar helper (`directMergePatch`) and ONLY once the page is seeded
      // (`gotResult`). A patch before the first `result` (e.g. mid-reconnect,
      // state reset by teardown) has no page to merge into; falling through to
      // `scheduleRefetchFor` re-pages it. The board stays on the refetch path.
      if (state.directMergePatch && state.gotResult) {
        if (
          mergePatchRow(state, (frame as { row: Record<string, unknown> }).row)
        ) {
          onResult(state);
        }
        // A dropped patch is a no-op — the server pushed the freshest row, and
        // the steady-poll backstop covers any genuine lost-wakeup.
        return;
      }
      scheduleRefetchFor(state);
    } else if (frame.type === "meta") {
      // A membership-change nudge — UNMERGEABLE from one row, so refetch. The
      // refetch re-sends `state.query`; for a recency-bounded collection
      // (`subagent_invocations`) the server scopes that re-page to its window,
      // so a membership change re-pages only the bounded recent set, NOT the
      // full unbounded history that pegged the server-worker (fn-921). The
      // `queryInFlight` coalescer collapses a fold burst into one round.
      const state =
        (frame.id !== undefined ? bySubId.get(frame.id) : undefined) ??
        byCollection.get(frame.collection);
      if (state) {
        scheduleRefetchFor(state);
      }
    } else if (frame.type === "error") {
      const detail = {
        code: frame.code,
        rev: frame.rev,
        message: frame.message,
      };
      emit("error", detail);
      // A CAPACITY-TRANSIENT reject (`max_connections`) is NOT terminal — a
      // reconnect once a slot frees recovers. The server serves the frame then
      // `end()`s, so the close handler owns teardown + reconnect; we just latch
      // `pendingTransientReject` so that reconnect backs off under the longer
      // cap-reject regime. Bypasses `isTerminal` even pre-paint.
      if (frame.code !== undefined && TRANSIENT_SERVER_CODES.has(frame.code)) {
        pendingTransientReject = true;
        return;
      }
      // A bad_frame / unknown_collection on our own query is terminal — a
      // reconnect can't fix a malformed query. Else it's likely transient.
      if (isTerminal(states)) {
        shuttingDown = true;
        // Tear down (releases the poll interval + HARD-destroys the socket)
        // BEFORE `onFatal`, so a custom handler that returns doesn't leave a
        // live `setInterval` + undestroyed socket holding the event loop open.
        teardownConnection();
        // Hand off AFTER teardown so a custom `onFatal` observes the
        // fully-shut-down helper; its exceptions propagate (no self-heal).
        onFatal({
          code: frame.code,
          rev: frame.rev,
          message: frame.message,
        });
      }
    }
  }

  /**
   * HARD-destroy a socket on a client-initiated teardown — `terminate()` (not
   * `end()`) frees the native buffers + libuv handle immediately, so a half-up/
   * dead daemon that never closes its side can't pin them across reconnects.
   * Falls back to `end()` for a socket without `terminate` (the test mock), and
   * is fully guarded — a teardown must never throw.
   */
  function destroySocket(sock: ReadinessSocket): void {
    try {
      if (typeof sock.terminate === "function") {
        sock.terminate();
      } else {
        sock.end();
      }
    } catch {
      // socket already gone — nothing to release
    }
  }

  function teardownConnection(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    // Reset the adaptive poll delay to the floor — the next connection's
    // `open` re-arms at `POLL_MS` regardless, but resetting here too keeps
    // the state consistent for any read between teardown and the next open.
    currentPollDelayMs = POLL_MS;
    // Reset the catching-up latch to READY and disarm the backstop — the next
    // connection's first `result` re-derives both. Silent (no `onCatchingUp`):
    // a disconnect surfaces via the `disconnected` lifecycle event, not a latch
    // flip, and the reconnect re-derives the true state from the wire.
    disarmBackstop();
    catchingUp = false;
    freshestBoot = undefined;
    // Destroy the live socket BEFORE dropping the reference (else the native
    // buffers leak on a flapping daemon). Safe and idempotent on both the
    // peer-closed `close`-handler path and the still-open give-up path.
    if (currentSock !== null) {
      destroySocket(currentSock);
    }
    currentSock = null;
    // Re-arm the served latch so the NEXT connection's first result resets the
    // backoff counter; an accept-then-reject window (torn down WITHOUT serving)
    // leaves it false → no spurious reset.
    servedThisConnection = false;
    for (const s of states) {
      s.order.length = 0;
      s.byId.clear();
      s.lastSeenVersion.clear();
      s.rows.length = 0;
      s.queryInFlight = false;
      s.refetchDirty = false;
      s.gotResult = false;
      // Reset the slow-flight + timeout machinery so a survived
      // `lastSlowFlightAt` can't suppress the first emit of the new window.
      s.queryInFlightSince = null;
      s.lastSlowFlightAt = null;
    }
  }

  async function connectOnce(): Promise<void> {
    const buffer = new LineBuffer();
    await connect(sockPath, {
      open(sock) {
        // Do NOT reset `attempt` here — socket `open` means ACCEPTED, not
        // SERVED. The reset is keyed on the first `result` (`servedThisConnection`).
        reconnecting = false;
        currentSock = sock;
        // Seed the liveness clock at connect so the heartbeat measures idleness
        // from the fresh connection, not a stale prior-connection stamp. The
        // frame-seq checkpoint is left as-is (both sides of the fresh
        // connection's first comparison start at whatever `inboundFrameSeq`
        // already is — nothing has arrived on THIS connection yet, so the
        // first tick correctly sees no inbound activity).
        lastInboundAt = Date.now();
        lastPollFrameSeq = inboundFrameSeq;
        currentPollDelayMs = POLL_MS;
        emit("connected", { sock: sockPath });
        // Send every subscribed query up front, stamping `queryInFlightSince`
        // and resetting `lastSlowFlightAt` so the post-reconnect window is clean.
        const now = Date.now();
        for (const s of states) {
          s.queryInFlight = true;
          s.queryInFlightSince = now;
          s.lastSlowFlightAt = null;
          sock.write(encodeFrame(s.query));
        }
        pollTimer = setInterval(pollTick, POLL_MS);
      },
      data(sock, chunk) {
        let lines: string[];
        try {
          lines = buffer.push(chunk.toString("utf8"));
        } catch (err) {
          // A protocol-frame parse failure is fatal for this connection but not
          // the caller's process — surface via lifecycle and HARD-destroy; the
          // `close` callback drives the reconnect.
          emit("error", { message: (err as Error).message });
          destroySocket(sock);
          return;
        }
        for (const line of lines) {
          if (line.trim().length === 0) {
            continue;
          }
          handleFrame(JSON.parse(line) as ServerFrame);
        }
      },
      close() {
        if (shuttingDown) {
          return;
        }
        // Clear the single-flight latch so a fresh `connectWithRetry` cycle can
        // advance to `open`, and a future timeout-triggered reconnect isn't
        // permanently suppressed.
        reconnecting = false;
        teardownConnection();
        // Re-arm the give-up anchor on a POST-PAINT drop for a fresh post-bounce
        // window. A drop BEFORE any paint leaves the start-armed anchor running
        // (re-arming there would let an accept-then-drop flap dodge give-up
        // forever), so only re-arm when the anchor is cleared (we were painted).
        if (everPainted && unpaintedAnchor === null) {
          armGiveUp();
        }
        emit("disconnected");
        void connectWithRetry();
      },
      error(_sock, err) {
        emit("error", { message: err.message });
      },
    });
  }

  /**
   * Compute the next backoff delay:
   *   - socket-level reject (`transient=false`): the deterministic 250ms→5s
   *     doubling ladder, capped at `MAX_BACKOFF_MS`.
   *   - capacity-transient cap reject (`transient=true`): a LONGER base
   *     (`TRANSIENT_BACKOFF_BASE_MS`) doubling per attempt with FULL jitter
   *     (`random(0, window)`), capped at the much-higher `TRANSIENT_BACKOFF_CAP_MS`
   *     (~30s) — de-correlating a fleet of awaits rejected in the same incident
   *     AND bounding their steady-state reconnect rate so they don't
   *     re-saturate the cap in lockstep.
   * Caller bumps `attempt` first so `attempt >= 1` here.
   */
  function computeBackoffDelay(transient: boolean): number {
    if (transient) {
      const window = Math.min(
        TRANSIENT_BACKOFF_BASE_MS * 2 ** (attempt - 1),
        TRANSIENT_BACKOFF_CAP_MS,
      );
      return Math.floor(Math.random() * window);
    }
    return Math.min(INITIAL_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  }

  /**
   * Bump `attempt`, emit one `waiting` lifecycle event, and sleep the computed
   * backoff. Shared by the synchronous-reject catch path (socket-level) and the
   * close-driven cap-reject path (transient). Uses a directly-cancellable
   * timeout so `dispose()` during backoff doesn't leak the timer.
   */
  async function backoffSleep(
    reason: string,
    transient: boolean,
  ): Promise<void> {
    attempt += 1;
    const delay = computeBackoffDelay(transient);
    emit("waiting", { attempt, retry_in_ms: delay, reason });
    await new Promise<void>((resolve) => {
      sleepResolve = resolve;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        sleepResolve = null;
        resolve();
      }, delay);
    });
  }

  async function connectWithRetry(): Promise<void> {
    emit("connecting", { sock: sockPath });
    while (!shuttingDown) {
      // Check the continuous-unpainted deadline at the top of every iteration —
      // the deterministic give-up path (the half-up-daemon path rides the
      // backstop timer). `checkGiveUp` may set `shuttingDown`.
      checkGiveUp();
      if (shuttingDown) {
        return;
      }
      // The close-driven reconnect after a CAP REJECT lands here. Back off under
      // the longer cap-reject regime BEFORE re-attempting (an immediate retry
      // hammers the contended cap); clear the latch first so a later
      // SOCKET-level reject reverts to the 250ms ladder.
      if (pendingTransientReject) {
        pendingTransientReject = false;
        await backoffSleep("max_connections", true);
        // Re-check shutdown/give-up after the (possibly long) sleep before
        // attempting the connection.
        if (shuttingDown) {
          return;
        }
        checkGiveUp();
        if (shuttingDown) {
          return;
        }
      }
      try {
        await connectOnce();
        return;
      } catch (err) {
        if (shuttingDown) {
          return;
        }
        await backoffSleep((err as Error).message, false);
      }
    }
  }

  // Arm the give-up anchor from subscribe start so the never-connected case is
  // bounded from the first attempt. Armed BEFORE the loop boots so the first
  // iteration's `checkGiveUp` sees a live anchor.
  armGiveUp();

  // Boot the reconnect loop. Caller does not await — they consume snapshots
  // via the callback and rely on `dispose()` for shutdown.
  void connectWithRetry();

  let disposed = false;
  return {
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      shuttingDown = true;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      // Release the catching-up backstop interval so `dispose()` leaves no live
      // timer holding the event loop open (Bun's `setInterval` has no `unref`).
      disarmBackstop();
      // Cancel the give-up backstop timer so `dispose()` leaves no live timer
      // holding the event loop open.
      if (giveUpTimer !== null) {
        clearTimeout(giveUpTimer);
        giveUpTimer = null;
      }
      unpaintedAnchor = null;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        // Resolve the pending sleep promise so `connectWithRetry`'s loop
        // observes `shuttingDown` and exits cleanly.
        sleepResolve?.();
        sleepResolve = null;
      }
      if (currentSock != null) {
        try {
          // No `id` → drop every subscription on this connection in one frame
          // (best-effort server etiquette; the daemon may already be gone).
          currentSock.write(encodeFrame({ type: "unsubscribe" }));
        } catch {
          // socket already gone — the unsubscribe is best-effort
        }
        // HARD-destroy so `dispose()` against a dead/half-up daemon frees the
        // native socket buffers immediately instead of pinning them in FIN_WAIT.
        destroySocket(currentSock);
      }
      currentSock = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Public helper #1: single-collection subscribe
// ---------------------------------------------------------------------------

/**
 * Single-collection subscribe options. `idPrefix` is suffixed with the
 * collection name to form the subscription id; purely a debug-log
 * discriminator. `filter` / `sort` / `limit` are forwarded verbatim;
 * `limit: 0` is the "no limit" sentinel (omit for the server default of 100).
 * `onRows(rows)` fires once per `result` after the first-paint gate clears,
 * with a fresh slice the caller may mutate; silent across a reconnect until the
 * post-reconnect `result`. `onFatal` fires on a terminal pre-paint `error`
 * (default `process.exit(1)`). `connect` is exposed only for test injection.
 */
export interface SubscribeCollectionOptions {
  readonly sockPath: string;
  readonly idPrefix: string;
  readonly collection: string;
  readonly filter?: Record<string, FilterValue>;
  readonly sort?: QuerySort;
  readonly limit?: number;
  readonly onRows: (rows: Record<string, unknown>[]) => void;
  readonly onLifecycle?: LifecycleCallback;
  readonly onFatal?: (err: FatalError) => void;
  readonly connect?: ConnectFactory;
  /** Opt-in bounded give-up. Absent → reconnect-forever. */
  readonly giveUpPolicy?: GiveUpPolicy;
  /** Injectable clock for the give-up deadline (default `Date.now`). */
  readonly now?: () => number;
  /** fn-897 B1: boot-status header callback (see {@link MultiOptions}). */
  readonly onBootStatus?: (boot: BootStatus) => void;
  /** Catching-up transition callback (see {@link CatchingUpCallback}). */
  readonly onCatchingUp?: CatchingUpCallback;
}

/**
 * Open a subscription to a single collection and invoke `onRows` once per
 * `result`. The building block sidecar UIs use instead of hand-rolling their
 * own `Bun.connect` loop; shares the full lifecycle contract with
 * `subscribeReadiness` so all consumers behave identically on the wire.
 */
export function subscribeCollection(
  opts: SubscribeCollectionOptions,
): ReadinessClientHandle {
  const onFatal = opts.onFatal ?? defaultOnFatal;
  const connect = opts.connect ?? defaultConnect;
  const subId = `${opts.idPrefix}-${opts.collection}`;
  const query: QueryFrame = {
    type: "query",
    id: subId,
    collection: opts.collection,
    ...(opts.limit === undefined ? {} : { limit: opts.limit }),
    ...(opts.sort === undefined ? {} : { sort: opts.sort }),
    ...(opts.filter === undefined ? {} : { filter: opts.filter }),
  };
  // Thread the descriptor's REAL pk + version column so the direct-merge path
  // keys correctly — it upserts into `byId`/`order`/`rows` by pk and the
  // version guard compares the `version` column. An unknown collection keeps
  // pk="" / version="": the merge no-ops on a missing pk and the version guard
  // is inert, so it still rides the refetch path harmlessly.
  const descriptor = getCollection(opts.collection);
  const state = makeState(opts.collection, subId, descriptor?.pk ?? "", query, {
    version: descriptor?.version ?? "",
    directMergePatch: true,
  });
  return subscribeMulti({
    sockPath: opts.sockPath,
    states: [state],
    onResult(s) {
      // Hand back a FRESH copy. The direct-merge `patch` path mutates `s.rows`
      // in place, so a copy-out is load-bearing — handing back the live array
      // would let a later patch mutate a slice the caller still holds.
      opts.onRows((s.rows as Record<string, unknown>[]).slice());
    },
    isTerminal: (sts) => sts.every((s) => !s.gotResult),
    ...(opts.onLifecycle === undefined
      ? {}
      : { onLifecycle: opts.onLifecycle }),
    onFatal,
    connect,
    ...(opts.giveUpPolicy === undefined
      ? {}
      : { giveUpPolicy: opts.giveUpPolicy }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
    ...(opts.onBootStatus === undefined
      ? {}
      : { onBootStatus: opts.onBootStatus }),
    ...(opts.onCatchingUp === undefined
      ? {}
      : { onCatchingUp: opts.onCatchingUp }),
  });
}

// ---------------------------------------------------------------------------
// Public helper #2: five-collection readiness subscribe
// ---------------------------------------------------------------------------

/**
 * Subscribe options. `idPrefix` forms each subscription id (`<prefix>-epics`
 * etc.), a debug-log discriminator. `onFatal` fires on a terminal pre-paint
 * `error` (default `process.exit(1)`; pass a custom one for tests / in-process
 * consumers). `connect` is exposed only for test injection.
 */
export interface SubscribeOptions {
  readonly sockPath: string;
  readonly idPrefix: string;
  readonly onSnapshot: (snap: ReadinessClientSnapshot) => void;
  readonly onLifecycle?: LifecycleCallback;
  readonly onFatal?: (err: FatalError) => void;
  readonly connect?: ConnectFactory;
  /** Opt-in bounded give-up. Absent → reconnect-forever. */
  readonly giveUpPolicy?: GiveUpPolicy;
  /** Injectable clock for the give-up deadline (default `Date.now`). */
  readonly now?: () => number;
  /**
   * Explicit filter for the `jobs` subscription, overriding the descriptor's
   * default live-only scope (`state not_in [ended, killed]`). A
   * `{ state: { not_in: [] } }` value ({@link FilterValue} — `not_in: []`
   * matches everything) widens the stream to terminal states. Absent → the
   * default live-only scope. Only the `jobs` collection is affected. (Server
   * capability; no current caller passes it.)
   */
  readonly jobsFilter?: Record<string, FilterValue>;
  /**
   * Bounded first-page limit for the `jobs` subscription, capping the rows on
   * the snapshot's single NDJSON line so a large job history can never exceed
   * the 1 MiB `MAX_LINE_LENGTH`. The feed pages `created_at DESC`, so the cap
   * keeps the newest jobs. Absent → `JOBS_PAGE_LIMIT` (0 = unbounded), which the
   * readiness CLI callers rely on. Only the `jobs` collection is affected.
   */
  readonly jobsLimit?: number;
  /** fn-897 B1: boot-status header callback (see {@link MultiOptions}). Fires
   *  independently of `onSnapshot` whenever a `result` frame carries a header. */
  readonly onBootStatus?: (boot: BootStatus) => void;
  /**
   * Catching-up transition callback (see {@link CatchingUpCallback}). Fires on
   * the per-connection latch FLIP so a display harness can gate rendering while
   * the daemon catches up; `onSnapshot`/rows keep flowing unchanged underneath.
   */
  readonly onCatchingUp?: CatchingUpCallback;
  /**
   * fn-1015 OPT-IN: also subscribe the `epics_recent_done` window
   * (`status='done'`, time-bounded to the last `DONE_EPICS_REAP_WINDOW_SEC` by
   * the descriptor's `recencyBound`) and MERGE it open-wins into the epic set
   * fed to BOTH `computeReadiness` and the snapshot's `epics` field — so a done
   * epic's close-row `completed` verdict stays reachable through its wind-down.
   * Mirrors the reconciler's `loadReconcileSnapshot` merge. Set ONLY by the
   * await-complete path (and `keeper status`); board/dash leave it OFF, keeping
   * their `computeReadiness` inputs, the `states`/first-paint gate, and the
   * snapshot's `epics` field BYTE-IDENTICAL. Default `false`.
   */
  readonly includeRecentDoneEpics?: boolean;
  /**
   * ADR 0011 OPT-IN: also subscribe the `dispatch_failures` collection
   * (UNBOUNDED — `limit: 0`) and carry its rows on the snapshot's
   * `dispatchFailures` member (verb/id/reason/dir intact). Set by the surfaces
   * that read the needs-human jam class (`keeper status`, `keeper watch`, and
   * `keeper await`'s `drained --fail-on-stuck` jam check). Board/dash leave it
   * OFF, keeping the `states`/first-paint gate and the snapshot's member set
   * BYTE-IDENTICAL. Default `false`.
   */
  readonly includeDispatchFailures?: boolean;
  /**
   * ADR 0018 OPT-IN: also subscribe the `epics_pinned` collection (UNBOUNDED —
   * `limit: 0`, a pin nags until its `dispatch_failures` row clears) and (1)
   * carry its rows on the snapshot's `pinnedEpics` member (the distinct
   * pinned-identity signal) AND (2) MERGE them open-wins into the epic set fed to
   * BOTH `computeReadiness` and the snapshot's `epics` field — so a plan-closed
   * epic with a stuck close/work failure flows through the ordinary verdict path
   * and keeps its full board block. Same overlay shape as `includeRecentDoneEpics`.
   * Set by the surfaces that render the needs-human board (`keeper status`,
   * `keeper watch`). Board/dash leave it OFF, keeping the `states`/first-paint gate
   * and the snapshot's member set BYTE-IDENTICAL. Default `false`.
   */
  readonly includePinnedEpics?: boolean;
}

/**
 * Open a subscription to all readiness collections on a single connection and
 * invoke `onSnapshot` once per emit (after the all-strict gate clears). The
 * `dispose()` handle tears down the connection and releases all timers.
 */
export function subscribeReadiness(
  opts: SubscribeOptions,
): ReadinessClientHandle {
  const { sockPath, idPrefix, onSnapshot, onLifecycle } = opts;
  // fn-905: latch the PER-ROOT unseeded set off the boot-status header so the
  // readiness pass forces UNKNOWN only for rows whose `effectiveRoot` is unseeded
  // — the board renders the SAME per-root gate the autopilot dispatches against.
  // Defaults EMPTY (steady state / a server that stamps no header / an older
  // server omitting the field → assume every root seeded, no per-root gating).
  let unseededRoots: Set<string> = new Set<string>();
  const onFatal = opts.onFatal ?? defaultOnFatal;
  const connect = opts.connect ?? defaultConnect;

  const epicsSubId = `${idPrefix}-epics`;
  const jobsSubId = `${idPrefix}-jobs`;
  const subsSubId = `${idPrefix}-subagent-invocations`;
  const gitSubId = `${idPrefix}-git`;
  const deadLettersSubId = `${idPrefix}-dead-letters`;
  const pendingDispatchesSubId = `${idPrefix}-pending-dispatches`;
  const autopilotStateSubId = `${idPrefix}-autopilot-state`;
  const armedEpicsSubId = `${idPrefix}-armed-epics`;
  const scheduledTasksSubId = `${idPrefix}-scheduled-tasks`;
  const blockEscalationsSubId = `${idPrefix}-block-escalations`;
  const tmuxClientFocusSubId = `${idPrefix}-tmux-client-focus`;
  const epics = makeState("epics", epicsSubId, "epic_id", {
    type: "query",
    collection: "epics",
    id: epicsSubId,
    limit: EPICS_PAGE_LIMIT,
  });
  const jobs = makeState("jobs", jobsSubId, "job_id", {
    type: "query",
    collection: "jobs",
    id: jobsSubId,
    // `?? JOBS_PAGE_LIMIT` (0 = unbounded), not `||`: a caller's explicit `0`
    // must mean unbounded, not coerce to the fallback. The dash caps at a
    // bounded page to stay under `MAX_LINE_LENGTH`.
    limit: opts.jobsLimit ?? JOBS_PAGE_LIMIT,
    // An explicit caller filter overrides the descriptor's default live-only
    // `state not_in [ended, killed]` scope.
    ...(opts.jobsFilter === undefined ? {} : { filter: opts.jobsFilter }),
  });
  // `subagent_invocations` exposes `job_id` as the wire pk though its SQL
  // identity is composite, so `byId` collapses re-entrant sub-agents in one
  // session last-write-wins; the readiness handoff reads from `state.rows`
  // instead so predicate 6 sees every `running` sub.
  const subagentInvocations = makeState(
    "subagent_invocations",
    subsSubId,
    "job_id",
    {
      type: "query",
      collection: "subagent_invocations",
      id: subsSubId,
      limit: SUBAGENT_INVOCATIONS_PAGE_LIMIT,
    },
  );
  // The `git` collection — one row per plan-backed git worktree, keyed by
  // `project_dir`. RETAINED-BUT-UNREAD by readiness (the sole consumer was the
  // deleted predicate 6.5), but still projected onto the snapshot for renderers.
  // The live `git_status` row is the honest source of truth (per-job dirty
  // counts freeze on terminal worker transition).
  const gitStatus = makeState("git", gitSubId, "project_dir", {
    type: "query",
    collection: "git",
    id: gitSubId,
    limit: GIT_PAGE_LIMIT,
  });
  // `dead_letters` feeds the board's persistent warn-count pill. Rides the
  // descriptor's `defaultFilter: { status: "waiting" }` scope so the stream is
  // just the unrecovered backlog. An empty steady state still produces a
  // `result` with `rows: []` so the first-paint gate clears.
  const deadLetters = makeState("dead_letters", deadLettersSubId, "dl_id", {
    type: "query",
    collection: "dead_letters",
    id: deadLettersSubId,
    limit: DEAD_LETTERS_PAGE_LIMIT,
  });
  // `pending_dispatches` feeds the `dispatch-pending` occupant. The wire pk is
  // `verb` (the descriptor's composite-pk workaround), but readiness reads from
  // `state.rows` via `projectRows`, so every row reaches the projection despite
  // the single-column wire pk collapsing on `verb`. An empty steady state still
  // produces a `result` with `rows: []`.
  const pendingDispatches = makeState(
    "pending_dispatches",
    pendingDispatchesSubId,
    "verb",
    {
      type: "query",
      collection: "pending_dispatches",
      id: pendingDispatchesSubId,
      limit: PENDING_DISPATCHES_PAGE_LIMIT,
    },
  );
  // `autopilot_state` carries the `mode` enum and `armed_epics` is the per-epic
  // armed PRESENCE set; together they let the board/CLI readiness pass mirror
  // the reconciler's armed-mode eligibility so the displayed per-root winner
  // agrees with what the daemon dispatches. A missing/malformed `mode` defaults
  // to `'yolo'` (no eligibility filtering).
  const autopilotState = makeState(
    "autopilot_state",
    autopilotStateSubId,
    "id",
    {
      type: "query",
      collection: "autopilot_state",
      id: autopilotStateSubId,
      limit: AUTOPILOT_STATE_PAGE_LIMIT,
    },
  );
  const armedEpics = makeState("armed_epics", armedEpicsSubId, "epic_id", {
    type: "query",
    collection: "armed_epics",
    id: armedEpicsSubId,
    limit: ARMED_EPICS_PAGE_LIMIT,
  });
  // `scheduled_tasks` — one row per cron a Claude session armed via
  // `CronCreate`, served to the jobs TUI's expanded-row detail section. The
  // wire pk is `job_id` (the descriptor's composite-pk workaround for the SQL
  // identity `(job_id, cron_id)`), so the snapshot reads from `state.rows` via
  // `projectRows` — `byId` would collapse every cron in one session to the
  // last-write-wins row. An empty steady state still produces a `result` with
  // `rows: []` so the first-paint gate clears.
  const scheduledTasks = makeState(
    "scheduled_tasks",
    scheduledTasksSubId,
    "job_id",
    {
      type: "query",
      collection: "scheduled_tasks",
      id: scheduledTasksSubId,
      limit: SCHEDULED_TASKS_PAGE_LIMIT,
    },
  );
  // `block_escalations` (fn-941) — one row per currently-blocked plan task the
  // daemon producer has armed. The wire pk is `task_id`; the snapshot reads from
  // `byId` (the pk is single-column, so no collapse). An empty steady state still
  // produces a `result` with `rows: []` so the first-paint gate clears.
  const blockEscalations = makeState(
    "block_escalations",
    blockEscalationsSubId,
    "task_id",
    {
      type: "query",
      collection: "block_escalations",
      id: blockEscalationsSubId,
      limit: BLOCK_ESCALATIONS_PAGE_LIMIT,
    },
  );
  // `tmux_client_focus` (fn-952) — the persistent control worker's live-only
  // singleton view of the current real client's focused session/window/pane. The
  // wire pk is `id` (always `1`), so the snapshot reads `byId.get(order[0])`. The
  // table exists from migration, so an empty / never-populated singleton (no-tmux
  // env, or no worker ever connecting) still produces a `result` with `rows: []`
  // — clearing the first-paint gate without wedging.
  const tmuxClientFocus = makeState(
    "tmux_client_focus",
    tmuxClientFocusSubId,
    "id",
    {
      type: "query",
      collection: "tmux_client_focus",
      id: tmuxClientFocusSubId,
      limit: TMUX_CLIENT_FOCUS_PAGE_LIMIT,
    },
  );
  // fn-1015 OPT-IN: the recently-done epics window. Created, gated, and merged
  // ONLY when `includeRecentDoneEpics` is set (the await-complete / `keeper
  // status` paths). When off it is `null` — never added to `states`, never
  // gated, never merged — so board/dash first-paint and compute inputs stay
  // byte-identical. Reuses `EPICS_PAGE_LIMIT` (unbounded; the descriptor's
  // `recencyBound` is the real bound).
  const epicsRecentDoneSubId = `${idPrefix}-epics-recent-done`;
  const epicsRecentDone =
    opts.includeRecentDoneEpics === true
      ? makeState("epics_recent_done", epicsRecentDoneSubId, "epic_id", {
          type: "query",
          collection: "epics_recent_done",
          id: epicsRecentDoneSubId,
          limit: EPICS_PAGE_LIMIT,
        })
      : null;
  // OPT-IN: the merge-landed observable, gated on the SAME
  // `includeRecentDoneEpics` flag as the recent-done window — the OFF-mode
  // degradation (`landed` ⇔ `done`) reads done epics, which only join `epics` under
  // that opt-in, so the two are intrinsically coupled. When off it is `null` (never
  // subscribed/gated) so board/dash first-paint stays byte-identical.
  const laneMergedSubId = `${idPrefix}-lane-merged`;
  const laneMerged =
    opts.includeRecentDoneEpics === true
      ? makeState("lane_merged", laneMergedSubId, "epic_id", {
          type: "query",
          collection: "lane_merged",
          id: laneMergedSubId,
          limit: LANE_MERGED_PAGE_LIMIT,
        })
      : null;
  // ADR 0011 OPT-IN: the sticky `dispatch_failures` collection. Created, gated,
  // and merged ONLY when `includeDispatchFailures` is set (status/watch/await's
  // jam path). When off it is `null` — never added to `states`, never gated,
  // never merged — so board/dash first-paint and every non-opt-in consumer's
  // snapshot member set stay byte-identical. Subscribes UNBOUNDED (limit 0 — the
  // no-row-cap sentinel). The wire pk is `verb` (a tiny class), but two same-verb
  // rows would collapse under `byId`, so the snapshot projects off `state.rows`.
  const dispatchFailuresSubId = `${idPrefix}-dispatch-failures`;
  const dispatchFailures =
    opts.includeDispatchFailures === true
      ? makeState("dispatch_failures", dispatchFailuresSubId, "verb", {
          type: "query",
          collection: "dispatch_failures",
          id: dispatchFailuresSubId,
          limit: DISPATCH_FAILURES_PAGE_LIMIT,
        })
      : null;
  // ADR 0018 OPT-IN: the display-only PINNED epics window. Created, gated, and
  // merged ONLY when `includePinnedEpics` is set (the needs-human render paths).
  // When off it is `null` — never added to `states`, never gated, never merged —
  // so board/dash first-paint and every non-opt-in consumer's snapshot member set
  // stay byte-identical. Reuses `EPICS_PAGE_LIMIT` (0 = unbounded; the pin set is
  // bounded by the `dispatch_failures` table, so no page cap — a pin nags until
  // its row clears).
  const epicsPinnedSubId = `${idPrefix}-epics-pinned`;
  const epicsPinned =
    opts.includePinnedEpics === true
      ? makeState("epics_pinned", epicsPinnedSubId, "epic_id", {
          type: "query",
          collection: "epics_pinned",
          id: epicsPinnedSubId,
          limit: EPICS_PAGE_LIMIT,
        })
      : null;
  const states: CollectionState[] = [
    epics,
    jobs,
    subagentInvocations,
    gitStatus,
    deadLetters,
    pendingDispatches,
    autopilotState,
    armedEpics,
    scheduledTasks,
    blockEscalations,
    tmuxClientFocus,
  ];
  if (epicsRecentDone !== null) {
    states.push(epicsRecentDone);
  }
  if (laneMerged !== null) {
    states.push(laneMerged);
  }
  if (dispatchFailures !== null) {
    states.push(dispatchFailures);
  }
  if (epicsPinned !== null) {
    states.push(epicsPinned);
  }

  function emitSnapshotIfReady(): void {
    if (
      !epics.gotResult ||
      !jobs.gotResult ||
      !subagentInvocations.gotResult ||
      !gitStatus.gotResult ||
      !deadLetters.gotResult ||
      // Gate on every collection — a partial snapshot must not flip the
      // `dispatch-pending` occupancy or paint the WRONG armed-mode per-root
      // winner on the pre-paint blank state. Empty `pending_dispatches` /
      // `armed_epics` still produce a `result` with `rows: []`.
      !pendingDispatches.gotResult ||
      !autopilotState.gotResult ||
      !armedEpics.gotResult ||
      // `scheduled_tasks` (fn-813) — the jobs-TUI cron detail feed. Empty
      // produces a `result` with `rows: []`, so it still clears the gate.
      !scheduledTasks.gotResult ||
      // `block_escalations` (fn-941) — the escalation latch feed. Empty produces
      // a `result` with `rows: []`, so it still clears the gate.
      !blockEscalations.gotResult ||
      // `tmux_client_focus` (fn-952) — the control-worker focus singleton. The
      // table exists from migration, so an empty / never-populated singleton
      // (no-tmux env) produces a `result` with `rows: []` and still clears the
      // gate. Gating on it keeps the focus pill from painting on a pre-paint
      // blank.
      !tmuxClientFocus.gotResult ||
      // fn-1015 OPT-IN: gate on the recent-done window ONLY when it was opted in
      // (`null` otherwise — board/dash never wait on it, so their gate stays
      // unchanged). Empty produces a `result` with `rows: []`, so it clears.
      (epicsRecentDone !== null && !epicsRecentDone.gotResult) ||
      // OPT-IN: gate on the merge-landed observable ONLY when opted in
      // (`null` otherwise). The table exists from migration, so empty produces a
      // `result` with `rows: []` and still clears the gate.
      (laneMerged !== null && !laneMerged.gotResult) ||
      // ADR 0011 OPT-IN: gate on the `dispatch_failures` collection ONLY when
      // opted in (`null` otherwise). Holding first paint until it paints means a
      // painted snapshot always carries the REAL jam rows — a transient fold
      // failure can never read as "no jam". Empty produces a `result` with
      // `rows: []`, so it clears.
      (dispatchFailures !== null && !dispatchFailures.gotResult) ||
      // ADR 0018 OPT-IN: gate on the pinned epics ONLY when opted in (`null`
      // otherwise — board/dash never wait on it). Empty produces a `result` with
      // `rows: []`, so it clears.
      (epicsPinned !== null && !epicsPinned.gotResult)
    ) {
      return;
    }
    // Cast: the wire delivers each row as `Record<string, unknown>`; the
    // descriptors guarantee the shape matches the typed projection.
    const openEpicsTyped = epics.order.map(
      (id) => (epics.byId.get(id) ?? { [epics.pk]: id }) as unknown as Epic,
    );
    // The pinned epics (fn-1015's recent-done sibling), projected off the pinned
    // window (`null` when un-opted). The `epic_id` wire pk is single-column so
    // `byId` never collapses.
    const pinnedEpicsTyped =
      epicsPinned === null
        ? null
        : epicsPinned.order.map(
            (id) =>
              (epicsPinned.byId.get(id) ?? {
                [epicsPinned.pk]: id,
              }) as unknown as Epic,
          );
    // Reduce open + recent-done + pinned into ONE epic_id-keyed set, open-wins
    // (a live open row wins a collision; a closed done/pinned row only joins for
    // an epic NOT already present), mirroring the reconciler's
    // `loadReconcileSnapshot` dedup. Precedence open > recent-done > pinned — the
    // closed sources carry the SAME epics-table row, so only the identity dedup is
    // load-bearing. When neither opt-in is set this is exactly `openEpicsTyped` —
    // byte-identical to the pre-opt-in board/dash path. The merged set feeds BOTH
    // `computeReadiness` (a closed epic's close-row gets a `completed` verdict) AND
    // the snapshot's `epics` field (so the await presence lookup sees it).
    let epicsTyped = openEpicsTyped;
    if (epicsRecentDone !== null || pinnedEpicsTyped !== null) {
      const doneEpicsTyped =
        epicsRecentDone === null
          ? []
          : epicsRecentDone.order.map(
              (id) =>
                (epicsRecentDone.byId.get(id) ?? {
                  [epicsRecentDone.pk]: id,
                }) as unknown as Epic,
            );
      const seenEpicIds = new Set<string>();
      const merged: Epic[] = [];
      const pushUnseen = (epic: Epic): void => {
        if (seenEpicIds.has(epic.epic_id)) {
          return;
        }
        seenEpicIds.add(epic.epic_id);
        merged.push(epic);
      };
      for (const epic of openEpicsTyped) {
        pushUnseen(epic);
      }
      for (const epic of doneEpicsTyped) {
        pushUnseen(epic);
      }
      for (const epic of pinnedEpicsTyped ?? []) {
        pushUnseen(epic);
      }
      epicsTyped = merged;
    }
    const jobsTyped = new Map<string, Job>();
    for (const [id, row] of jobs.byId) {
      jobsTyped.set(id, row as unknown as Job);
    }
    // Read from `state.rows` (not `byId.values()`) — see module docstring.
    const subsTyped = projectRows<SubagentInvocation>(subagentInvocations);
    // Collapse same-name sub-agents to most-recent before readiness sees them
    // (the `collapseSubagentsByName` operating assumption: no parallel
    // like-named sub-agents, so orphaned `running` rows don't false-block
    // predicate 6). The uncollapsed slice still rides on the snapshot.
    const subsForReadiness = collapseSubagentsByName(subsTyped).map(
      (g) => g.row,
    );
    // Project the `git_status` rows into the `{dirty_count,
    // unattributed_to_live_count}` shape (RETAINED-BUT-UNREAD by readiness now
    // that predicate 6.5 is deleted, but still consistent for any consumer).
    // `unattributed_to_live_count` is computed client-side from the per-file
    // `attributions[]` materialized view (a dirty file counts when no
    // attribution is in a `working`/`stopped` state) — the mirror of the
    // reducer's PASS-4 fan-out, so both numbers reconcile.
    const gitTyped = projectRows<GitStatus>(gitStatus);
    const gitStatusByProjectDir = projectGitStatusByProjectDir(gitTyped);
    // Project the `pending_dispatches` rows via the SOLE shared helper (the SAME
    // one the reconciler uses) so the two readiness paths agree byte-for-byte.
    // Read from `state.rows` — the wire pk is the composite-workaround `verb`,
    // so `byId` would collapse same-`verb` rows.
    const pendingDispatchesTyped = projectPendingDispatches(
      projectRows<Record<string, unknown>>(pendingDispatches),
    );
    // Mirror the reconciler's mode/armed read so the board's per-root winner
    // matches what the daemon dispatches in `armed` mode. PROJECTION-PULL only,
    // no cache; a missing/malformed `mode` defaults to `'yolo'`.
    const modeRaw = (
      autopilotState.byId.get(autopilotState.order[0] ?? "") as
        | { mode?: unknown }
        | undefined
    )?.mode;
    const mode: "yolo" | "armed" = modeRaw === "armed" ? "armed" : "yolo";
    // fn-941: the autopilot `paused` flag off the same singleton row. Stored as a
    // 0/1 INTEGER; a missing/malformed value defaults to PAUSED (mirrors
    // `cli/autopilot.ts`'s coercion — boot-paused is the safe default).
    const pausedRaw = (
      autopilotState.byId.get(autopilotState.order[0] ?? "") as
        | { paused?: unknown }
        | undefined
    )?.paused;
    const autopilotPaused =
      typeof pausedRaw === "number" ? pausedRaw !== 0 : true;
    // Derive the autopilot caps / worktree flags off the folded `autopilot_state`
    // BEFORE the readiness pass. The EFFECTIVE per-root cap is the ONE seam
    // (`effectivePerRootCap`) applied to the SAME folded {stored intent,
    // worktree_mode} the snapshot reports — mirroring the server's
    // `loadReadinessInputs`. Because effective is no longer a SECOND, boot-header
    // -latched source, it can never skew against the reported stored / worktree on
    // a snapshot: a boot frame and a steady frame with identical folded inputs
    // report a byte-identical effective value (no post-boot per_root 1↔2 churn).
    const autopilotRows = projectRows<Record<string, unknown>>(autopilotState);
    const maxConcurrentJobs = projectMaxConcurrentJobs(autopilotRows);
    const worktreeMode = projectWorktreeMode(autopilotRows) ?? false;
    const worktreeMultiRepo = projectWorktreeMultiRepo(autopilotRows) ?? false;
    // The STORED per-root intent — the raw-column projector. An EMPTY row set omits
    // the field (undefined) so a snapshot lacking autopilot rows never FABRICATES a
    // stored value; the EFFECTIVE derivation below still floors to 1 (worktree off).
    const maxConcurrentPerRootStored =
      autopilotRows.length === 0
        ? undefined
        : projectMaxConcurrentPerRoot(autopilotRows);
    // The EFFECTIVE cap the pass demotes against AND every surface reports: the ONE
    // seam over the folded stored intent + worktree mode (worktree off ⇒ 1).
    const maxConcurrentPerRoot = effectivePerRootCap(
      projectMaxConcurrentPerRoot(autopilotRows),
      worktreeMode,
    );
    // In `armed` mode, compute the eligible set (armed ∪ transitive upstream
    // closure) via the SAME `computeEligibleEpics` the reconciler runs. In
    // `yolo` mode leave it `undefined` so `computeReadiness` takes the legacy
    // single-pass — matching the reconciler.
    let eligibleEpicIds: Set<string> | undefined;
    if (mode === "armed") {
      const armedIds = new Set<string>();
      for (const id of armedEpics.order) {
        armedIds.add(id);
      }
      const epicById = new Map<string, Epic>();
      for (const epic of epicsTyped) {
        epicById.set(epic.epic_id, epic);
      }
      eligibleEpicIds = computeEligibleEpics(armedIds, epicById);
    }
    // This client has no pid probe: only the reconcile snapshot injects its
    // proven-dead worker facts. Leaving that argument absent keeps an ambiguous
    // board session conservatively held rather than treating stopped as dead.
    const readiness = computeReadiness(
      epicsTyped,
      jobsTyped,
      subsForReadiness,
      gitStatusByProjectDir,
      // Caller-injected reference timestamp for the `sub-agent-stale` /
      // `monitor-stale` variants — the pure pass never reads `Date.now()`.
      Math.floor(Date.now() / 1000),
      // The launch-window occupancy set.
      pendingDispatchesTyped,
      // Armed-mode eligibility in `armed` mode, `undefined` in `yolo`. Makes
      // the board's per-root tiebreak agree with the reconciler's dispatch.
      eligibleEpicIds,
      // fn-905: the per-root unseeded set → only rows whose `effectiveRoot` is
      // unseeded are forced UNKNOWN (a seeded sibling root still renders ready).
      unseededRoots,
      // The EFFECTIVE per-root dispatch concurrency count N, derived off the folded
      // `autopilot_state` through `effectivePerRootCap` — the board demotes the SAME
      // way the reconciler does because both apply the ONE seam to the same {stored,
      // worktree_mode}. Default 1 = today's one-task-per-root mutex (worktree off).
      maxConcurrentPerRoot,
    );
    const deadLettersTyped = projectRows<DeadLetter>(deadLetters);
    // Read from `state.rows` (not `byId.values()`) — the composite
    // `(job_id, cron_id)` identity rides a single-column `job_id` wire pk, so
    // `byId` would collapse a multi-cron session to one row.
    const scheduledTasksTyped = projectRows<ScheduledTask>(scheduledTasks);
    // fn-941: the escalation latch rows. `task_id` is the single-column wire pk,
    // so `byId` carries every row without collapse — read from `state.rows` for
    // symmetry with the other projections.
    const blockEscalationsTyped =
      projectRows<BlockEscalation>(blockEscalations);
    // fn-952: the `tmux_client_focus` singleton — read the one row (`id = 1`)
    // off `byId` like `autopilot_state`. Absent (no-tmux env, or a worker that
    // never connected) → `undefined`, which the banner renders as `[focus:
    // none]`.
    const tmuxFocus = tmuxClientFocus.byId.get(
      tmuxClientFocus.order[0] ?? "",
    ) as TmuxClientFocus | undefined;
    // fn-1015: un-drop the autopilot caps/worktree onto the snapshot. `mode`, the
    // effective + stored per-root caps, `max_concurrent_jobs`, and `worktree_mode`
    // reuse the locals derived above off the folded `autopilot_state` (so every
    // reported field matches what the readiness pass used, all through the shared
    // projectors + the ONE per-root seam — never a boot-latched second source). The
    // eligibility set is the armed-mode closure, sorted for a stable render and
    // absent in yolo (no filter).
    const eligibleEpicIdsSorted =
      eligibleEpicIds === undefined ? undefined : [...eligibleEpicIds].sort();
    // The merge-landed set, computed ONLY under the `includeRecentDoneEpics`
    // opt-in (the `laneMerged` state is `null` otherwise). Worktree mode ON → the
    // `lane_merged` projection ids; OFF → degrades to DONE epics (read off the merged
    // `epicsTyped`, which carries recent-done under this same opt-in). `undefined` for
    // board/dash so their snapshot stays byte-identical.
    const landedEpicIds =
      laneMerged === null
        ? undefined
        : computeLandedEpicIds(worktreeMode, laneMerged.order, epicsTyped);
    // ADR 0011 OPT-IN: the sticky `dispatch_failures` rows, projected off
    // `state.rows` (the `verb` wire pk would collapse same-verb rows under
    // `byId`). Field names (verb/id/reason/dir) ride through intact so the shared
    // needs-human projector's math is source-agnostic. `undefined` when un-opted
    // (the state is `null`) so the snapshot member is ABSENT for board/dash.
    const dispatchFailuresTyped =
      dispatchFailures === null
        ? undefined
        : projectRows<Row>(dispatchFailures);
    // Exceptions from `onSnapshot` propagate (the "no in-process self-heal"
    // stance).
    onSnapshot({
      epics: epicsTyped,
      jobs: jobsTyped,
      subagentInvocations: subsTyped,
      gitStatus: gitTyped,
      deadLetters: deadLettersTyped,
      pendingDispatches: pendingDispatchesTyped,
      scheduledTasks: scheduledTasksTyped,
      blockEscalations: blockEscalationsTyped,
      autopilotPaused,
      autopilotMode: mode,
      ...(eligibleEpicIdsSorted === undefined
        ? {}
        : { autopilotEligibleEpicIds: eligibleEpicIdsSorted }),
      maxConcurrentJobs,
      maxConcurrentPerRoot,
      ...(maxConcurrentPerRootStored === undefined
        ? {}
        : { maxConcurrentPerRootStored }),
      worktreeMode,
      worktreeMultiRepo,
      ...(landedEpicIds === undefined ? {} : { landedEpicIds }),
      ...(dispatchFailuresTyped === undefined
        ? {}
        : { dispatchFailures: dispatchFailuresTyped }),
      // ADR 0018 OPT-IN: the pinned epics as the distinct pinned-identity member
      // (they ALSO ride merged into `epics` above). `null` when un-opted so the
      // member is ABSENT for board/dash — byte-identical to the pre-opt-in shape.
      ...(pinnedEpicsTyped === null ? {} : { pinnedEpics: pinnedEpicsTyped }),
      ...(tmuxFocus === undefined ? {} : { tmuxFocus }),
      readiness,
    });
  }

  return subscribeMulti({
    sockPath,
    states,
    onResult: emitSnapshotIfReady,
    isTerminal: (sts) => sts.every((s) => !s.gotResult),
    ...(onLifecycle === undefined ? {} : { onLifecycle }),
    onFatal,
    connect,
    ...(opts.giveUpPolicy === undefined
      ? {}
      : { giveUpPolicy: opts.giveUpPolicy }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
    // fn-905: latch the per-root unseeded set for the readiness pass AND forward
    // to a caller-supplied `onBootStatus` (the readiness pass reads the latch on
    // its NEXT emit, which fires on the same frame). An older server omitting the
    // field latches EMPTY (no per-root gating) — falling back to over-dispatch
    // only in the brief unseeded window, never to a clean-read-as-dirty hazard.
    onBootStatus: (boot: BootStatus): void => {
      unseededRoots = new Set(boot.git_unseeded_roots ?? []);
      // The per-root cap is NOT latched off the header: the snapshot derives the
      // effective cap off the folded `autopilot_state` via `effectivePerRootCap`
      // (see above), so a boot frame can never skew it against the reported
      // stored / worktree. The header field is still forwarded verbatim.
      opts.onBootStatus?.(boot);
    },
    // The catching-up latch lives in the shared core; readiness forwards the
    // callback verbatim (no projection to latch, unlike `onBootStatus`).
    ...(opts.onCatchingUp === undefined
      ? {}
      : { onCatchingUp: opts.onCatchingUp }),
  });
}
