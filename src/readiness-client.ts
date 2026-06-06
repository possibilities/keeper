/**
 * Shared subscribe client + readiness handoff for the five keeper collections
 * (`epics`, `jobs`, `subagent_invocations`, `git`, `dead_letters`) PLUS a
 * generic single-collection subscribe helper. One imperative API: callers
 * pass a snapshot/rows callback and get back a `dispose()` handle. The
 * helpers own the connection lifecycle (capped-backoff reconnect,
 * post-disconnect re-handshake, per-collection coalesce, steady-poll
 * backstop) plus the relevant first-paint gate and the per-frame projection;
 * callers do rendering and side effects on top.
 *
 * Two public entry points
 * -----------------------
 * - `subscribeCollection({ ... })` — single-collection subscribe used by
 *   sidecar UIs like `scripts/git.ts`. Fires `onRows(rows)` once per `result`
 *   frame (and on coalesced refetch results). No `computeReadiness` handoff;
 *   the caller renders whatever shape it wants from raw rows. Terminal-error
 *   semantics: an `error` frame BEFORE the first `result` is unrecoverable
 *   (the query is malformed); after at least one `result`, errors are
 *   transient and the next refetch can recover.
 * - `subscribeReadiness({ ... })` — five-collection composition used by the
 *   full-readiness consumers (`scripts/board.ts`, `scripts/autopilot.ts`).
 *   All five (`epics` + `jobs` + `subagent_invocations` + `git` +
 *   `dead_letters`) ride a single connection; the all-five-strict
 *   first-paint gate withholds `onSnapshot` until each has produced a
 *   `result`, then `computeReadiness` runs and the composed snapshot fires.
 *   The `dead_letters` collection rides the descriptor's default
 *   `filter: { status: "waiting" }` scope so the wire stream tracks only the
 *   unrecovered backlog — the board's persistent warn-count and
 *   readiness consumers see "things to fix right now," not the audit trail
 *   of already-recovered rows.
 *
 * Both helpers share one internal driver (`subscribeMulti`) that owns the
 * socket, the reconnect-with-backoff loop, the line buffer, the per-collection
 * `queryInFlight` / `refetchDirty` coalescer, the steady-poll backstop, and
 * the terminal-error gate. The public helpers compose the driver with the
 * right number of collections + the right "all paint" predicate.
 *
 * Why callback + dispose, not async iterator. Async generators bring two
 * pitfalls for this workload: (a) cancellation requires consumers to call
 * `.return()` correctly, which is easy to miss on SIGINT; (b) recursive
 * `yield*` for reconnect creates per-reconnect frames on the stack. All
 * consumers want imperative push semantics — a callback fires when a new
 * snapshot is ready, and `dispose()` is the only way out.
 *
 * Why `state.rows` (not `byId.values()`) for `subagent_invocations`. The
 * descriptor exposes `job_id` as the wire pk even though the SQL composite
 * identity is `(job_id, agent_id, turn_seq)`. Two re-entrant sub-agents
 * sharing one `job_id` must BOTH reach `computeReadiness` so predicate 6
 * (`own-progress-sub`) doesn't false-negative. `byId` collapses them
 * last-write-wins; `rows` carries the full wire-order stream. This is the
 * load-bearing invariant covered by `test/board.test.ts`'s regression.
 * (fn-697.2 narrowed the wire frame to the safe-7 columns — `agent_id` is no
 * longer projected — but every row is still streamed; the all-rows-not-byId
 * invariant is unaffected by the column narrow.)
 *
 * Lifecycle contract:
 *   - First-paint gate. `subscribeReadiness` withholds `onSnapshot` until
 *     epics + jobs + subagent_invocations + git + dead_letters have EACH
 *     produced their first `result`; `subscribeCollection` withholds
 *     `onRows` until its single collection has produced its first `result`.
 *     A partial snapshot would compute readiness against a wrong-state
 *     input. The empty steady state of `dead_letters` (zero waiting rows,
 *     the happy case) still produces a `result` frame with `rows: []` so
 *     the gate clears — the descriptor's `defaultFilter: { status:
 *     "waiting" }` scope means "no dropped events to recover," not "no
 *     subscription."
 *   - Capped-backoff reconnect: 250 ms → 5000 ms doubling per attempt;
 *     resets on a successful connection.
 *   - Steady-poll backstop (500 ms) refetches each subscribed collection
 *     every tick, coalesced per collection via `queryInFlight` /
 *     `refetchDirty`.
 *   - On teardown (disconnect or `dispose`): reset `state.rows`,
 *     `state.byId`, `state.order`, AND `gotResult = false` for every
 *     collection. The `gotResult` reset is what board.ts has and
 *     autopilot.ts's previous standalone code was missing — centralized
 *     here so both consumers inherit the correct behavior.
 *   - `dispose()` is idempotent: pre-first-paint bails clean (no callback
 *     fires); during reconnect backoff cancels the pending timer and marks
 *     `shuttingDown`; called twice is a no-op.
 *   - `onSnapshot` / `onRows` exceptions are NOT swallowed — they propagate
 *     up to the caller's I/O frame. Matches keeper's "no in-process
 *     self-heal" stance and matches today's `emitFrameIfChanged`, which has
 *     no try/catch.
 *   - SIGINT remains the CALLER's concern; the helper exposes `dispose()`
 *     and the caller wires its own signal handler (so each script's
 *     SIGINT-prints stay per-script).
 */

import { getCollection } from "./collections";
import {
  encodeFrame,
  type FilterValue,
  LineBuffer,
  type QueryFrame,
  type QuerySort,
  type ServerFrame,
} from "./protocol";
import {
  computeReadiness,
  type PendingDispatch,
  type ReadinessSnapshot,
} from "./readiness";
import type {
  DeadLetter,
  Epic,
  GitStatus,
  Job,
  SubagentInvocation,
} from "./types";

// ---------------------------------------------------------------------------
// Tuning constants — same values the prior board.ts standalone code used.
// ---------------------------------------------------------------------------

// Full set — the board's default jobs scope is LIVE-only (working + stopped;
// the descriptor's `defaultFilter` hides `ended`/`killed`), so the streamed
// set is bounded by concurrently-live sessions, not the full job history.
// Page limit 0 streams them all; without it the `created_at DESC` sort drops
// the oldest-created live session off the bottom once more than the cap are
// live at once (e.g. a long-lived session buried under newer ones).
const JOBS_PAGE_LIMIT = 0;
const EPICS_PAGE_LIMIT = 0;
// Full set — page limit 0 streams every per-job sub-agent row (NOT
// latest-per-job), which the renderer's ×N count / N-stuck annotation and
// superseded-orphan detection plus predicate-6 all require. fn-697.2 narrowed
// the descriptor's COLUMNS to the safe-7 (halving per-frame serialize cost)
// but kept ALL rows — column projection, not a row filter/page (paging would
// fight the `job_id` wire-pk / `byId` diff; a latest-per-job aggregate would
// break the count/stuck math).
const SUBAGENT_INVOCATIONS_PAGE_LIMIT = 0;
// Full set — one row per planctl-backed git worktree; the watched set is
// scoped to project roots that have produced events, which is bounded by the
// human's actual repo collection.
const GIT_PAGE_LIMIT = 0;
// Full set — `dead_letters` rides the descriptor's
// `defaultFilter: { status: "waiting" }` so the wire stream is just the
// unrecovered backlog (typically zero rows; bursts are bounded by how many
// hook-INSERT failures the daemon has imported but not yet replayed). Page
// limit 0 streams them all — there is no scroll affordance and the
// renderer needs the full native count to surface as a warn pill.
const DEAD_LETTERS_PAGE_LIMIT = 0;
// Full set (fn-721) — one row per launched-but-not-yet-bound worker
// (`pending_dispatches`, schema v50). The in-flight set is bounded by the
// concurrent launch-window count (typically 0–1 under the one-at-a-time
// stagger). Page limit 0 streams them all; readiness needs every row to hold
// the right launch-window mutex slots.
const PENDING_DISPATCHES_PAGE_LIMIT = 0;
const POLL_MS = 500;
const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5000;
/**
 * Slow-flight + hard-deadline thresholds for an in-flight `query`. The
 * steady-poll loop (`pollAll`, fires every `POLL_MS`) walks every state
 * and compares `Date.now() - queryInFlightSince` against these. At
 * `SLOW_FLIGHT_MS` the helper emits a single `query_slow_flight`
 * lifecycle event (latched by `lastSlowFlightAt` so it fires once per
 * stuck window, not every poll). At `QUERY_TIMEOUT_MS` the helper
 * concludes the connection is wedged, emits `query_timeout`, tears the
 * socket down, and lets the existing `connectWithRetry` machinery
 * reconnect from scratch. `Date.now()` here is correct: thresholds are
 * wall-clock, sub-ms precision is irrelevant, and in-process state has
 * no need to survive a restart (`teardownConnection` clears it).
 */
const SLOW_FLIGHT_MS = 1000;
const QUERY_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Snapshot delivered to `onSnapshot` once per emit. `subagentInvocations` is
 * the FLAT `SubagentInvocation[]` projected from `state.rows`, NOT
 * `byId.values()` — see module docstring for the predicate-6 reasoning.
 * `jobs` is a `Map<job_id, Job>` because board's renderer indexes by id for
 * the per-epic `job_links` lookup; autopilot can ignore the map and read
 * only `epics` if it wants to. `deadLetters` is the unrecovered backlog
 * (descriptor `defaultFilter: { status: "waiting" }` scope); a renderer
 * surfaces `deadLetters.length` as the warn-count pill and a `0`-length
 * array drops the pill cleanly.
 */
export interface ReadinessClientSnapshot {
  readonly epics: Epic[];
  readonly jobs: Map<string, Job>;
  readonly subagentInvocations: SubagentInvocation[];
  readonly gitStatus: GitStatus[];
  readonly deadLetters: DeadLetter[];
  // fn-721: the open `pending_dispatches` rows projected into the plain
  // `PendingDispatch[]` shape (the 6th subscribed collection). Fed into
  // `computeReadiness` so the board/CLI path agrees with the autopilot
  // reconciler on the `dispatch-pending` occupant. Rides on the snapshot so a
  // renderer can surface the in-flight launch list if it wants; `readiness`
  // already reflects the occupancy.
  readonly pendingDispatches: PendingDispatch[];
  readonly readiness: ReadinessSnapshot;
}

/**
 * Fatal-error payload handed to `onFatal` when a terminal `error` frame
 * arrives BEFORE any collection has produced its first `result` (i.e. the
 * query itself is malformed — `bad_frame` / `unknown_collection`). `rev`
 * is the wire-level world-rev when known (the protocol may omit it on
 * pre-handshake errors). The shape is what `onLifecycle` already receives
 * for the same frame; `onFatal` exists so callers can act on the
 * terminal condition instead of just observing it.
 */
export interface FatalError {
  readonly code: string;
  readonly rev?: number;
  readonly message: string;
}

/**
 * Minimal socket shape the helper drives. Matches the surface area of
 * `Bun.Socket` that the driver touches — `write` to push frames,
 * `end` to half-close. Surfaced as a named type so the test-injection
 * `connect` factory can return a mock without depending on `bun:types`.
 */
export interface ReadinessSocket {
  write(data: string): void;
  end(): void;
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
 * Lifecycle-event callback shape — same for both public helpers. The
 * driver emits `connecting` / `connected` / `disconnected` / `waiting` /
 * `error` / `query_slow_flight` / `query_timeout` events with a small
 * detail payload (`sock`, `attempt`, `retry_in_ms`, `reason`, `code`,
 * `rev`, `message`, `collection`, `query_id`, `age_ms` — fields per
 * event). `query_slow_flight` fires once at `SLOW_FLIGHT_MS` per stuck
 * in-flight window (latched by `lastSlowFlightAt` so it doesn't repeat
 * every poll); `query_timeout` fires at `QUERY_TIMEOUT_MS` immediately
 * before the helper tears the socket down and the reconnect loop kicks
 * back in. Both carry `{collection, query_id, sock, age_ms}`.
 */
export type LifecycleCallback = (
  event: string,
  detail?: Record<string, unknown>,
) => void;

/**
 * Default-bound `onFatal`: restores the pre-extraction `process.exit(1)`
 * behavior (`scripts/board.ts:870`, commit `212be34^`). Callers that want
 * different semantics (tests, in-process consumers, sidecar scripts that
 * want a softer exit) pass their own.
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
 * Per-collection page + coalescing state. INTERNAL to this module — the
 * helper deliberately does NOT export `CollectionState` because the public
 * API surface should not leak the internal shape (callers consume the
 * projected snapshot/rows, not the raw `byId` / `order` machinery).
 *
 * `rows` carries the full wire-order stream from the most recent `result`
 * frame. `byId` keys on the wire pk (`epic_id` / `job_id` / `project_dir`)
 * and collapses duplicates last-write-wins. For collections whose SQL
 * identity matches the wire pk (`epics`, `jobs`, `git`) the two views are
 * equivalent; for `subagent_invocations` they diverge — see the module
 * docstring.
 */
interface CollectionState {
  readonly collection: string;
  readonly subId: string;
  readonly pk: string;
  /**
   * The descriptor's monotonic per-row version column name (`last_event_id`
   * for most collections; `dl_written_at` for `dead_letters`). Read off each
   * patched/result row to drive the per-`(collection, pk)` version guard in
   * the direct-merge path. Empty string when the collection is unknown — the
   * guard then degrades to "always accept" (no column to compare), which is
   * inert for `subscribeReadiness` since it never direct-merges.
   */
  readonly version: string;
  /**
   * When true, a `patch` frame merges its `frame.row` directly into this
   * state and fires `onResult` — no refetch round-trip (Lever A1, fn-694.1).
   * Set ONLY by `subscribeCollection` (the sidecar helper); left false for
   * `subscribeReadiness` (the board, whose re-entrant-rows merge is
   * deliberately out of scope and stays on `scheduleRefetchFor`). `meta`
   * frames always refetch regardless — a membership change can't be
   * reconstructed from one row.
   */
  readonly directMergePatch: boolean;
  readonly query: QueryFrame;
  order: string[];
  byId: Map<string, Record<string, unknown>>;
  rows: unknown[];
  /**
   * Per-`(collection, pk-value)` last-seen version cursor for the direct-
   * merge guard. Keyed by the row's pk VALUE (collection is fixed per state,
   * so this satisfies the per-`(collection, pk)` requirement); value is the
   * row's `version`-column value at the time it was last rendered. A `patch`
   * whose row version isn't strictly greater than the stored cursor is
   * dropped (belt-and-suspenders against reconnect-replay / out-of-order
   * delivery; the server already gates and UDS is in-order). Seeded from the
   * `result` frame's rows and cleared on teardown alongside `byId`/`order`.
   */
  lastSeenVersion: Map<string, number>;
  gotResult: boolean;
  queryInFlight: boolean;
  refetchDirty: boolean;
  /**
   * `Date.now()` wall-clock stamp when `queryInFlight` last transitioned
   * to `true` (initial open-handler send + every `scheduleRefetchFor`
   * send). `null` whenever no query is in flight — `handleFrame`'s
   * `result` branch clears it back to `null` alongside `queryInFlight`,
   * and `teardownConnection` clears it on every disconnect so a
   * post-reconnect re-stamp is honest. Read by `pollAll` to compute the
   * stuck-window age against `SLOW_FLIGHT_MS` / `QUERY_TIMEOUT_MS`.
   */
  queryInFlightSince: number | null;
  /**
   * Single-fire latch for `query_slow_flight`. `null` means "no
   * slow-flight emitted yet for the current stuck window"; a non-null
   * `Date.now()` stamp means "already emitted once, suppress further
   * emissions until the state clears." Cleared whenever
   * `queryInFlightSince` is cleared (`result`, teardown), so a
   * subsequent stuck window gets exactly one emit again.
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
 * Pure helper — project a collection state into the typed row stream the
 * readiness pipeline expects. Uses `state.rows` (not `byId.values()`) so
 * collections with a composite SQL identity but a single-column wire pk
 * (today: `subagent_invocations`, pk `job_id`, identity
 * `(job_id, agent_id, turn_seq)`) deliver every received row, not just
 * the last-write-wins one per pk value. Exported for the regression test
 * in `test/board.test.ts`.
 */
export function projectRows<T>(state: { rows: readonly unknown[] }): T[] {
  // The descriptors guarantee the row shape matches the typed projection
  // (the server-side `decodeRow` materialises it); this cast is the same
  // shape-trust the readiness handoff already makes. The input type is
  // intentionally permissive (`readonly unknown[]`) so the regression
  // test can hand in a `{ rows: T[] }` literal without an upcast to
  // `Record<string, unknown>[]`.
  return state.rows as unknown as T[];
}

/**
 * Project raw `git_status` rows into the
 * `Map<project_dir, {dirty_count, unattributed_to_live_count}>` shape
 * `computeReadiness` consumes. `unattributed_to_live_count` is computed
 * client-side by walking each row's `dirty_files[].attributions[]` and
 * counting files with NO attribution in a live (`working`/`stopped`)
 * state — the mirror of the reducer's PASS-4 fan-out, redone from the
 * same materialized JSON the reducer wrote so both numbers reconcile.
 *
 * Defensive parsing throughout: every nested field is `unknown` at the
 * wire boundary, so each access is guarded (no-attribution rows count,
 * malformed rows fall through to no-attribution by design — mirrors the
 * reducer's "fold must never throw" safe-value discipline).
 *
 * Exported so the server-side autopilot reconciler worker
 * (`src/autopilot-worker.ts`) builds its `ReconcileSnapshot.gitStatusByProjectDir`
 * from the IDENTICAL math the live readiness client uses — the snapshot
 * the reconciler folds must match the wire snapshot byte-for-byte, so
 * this logic lives in exactly one place.
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
 * Project the wire `pending_dispatches` rows (schema v50, fn-678) into the
 * plain {@link PendingDispatch}[] shape `computeReadiness` consumes for the
 * fn-721 `dispatch-pending` occupant. The SOLE builder of this shape —
 * imported by BOTH consumers (the autopilot reconciler's
 * `loadReconcileSnapshot` in `src/autopilot-worker.ts` AND the board/CLI path
 * `subscribeReadiness` below) so the two readiness paths never diverge on the
 * launch-window occupancy set. Mirrors {@link projectGitStatusByProjectDir}'s
 * one-place-only discipline.
 *
 * Defensive parsing at the wire boundary: `verb` / `id` are required strings
 * (a row missing either can't form a `verb::id` key, so it's dropped — it
 * could never match a row anyway). `dir` is nullable on the column; a
 * non-string value normalises to `null` (the root-fallback degrades safely on
 * a null `dir`, contributing no root occupant). Same "malformed rows fall
 * through to a safe value" discipline as the git projection.
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
    out.push({ verb, id, dir });
  }
  return out;
}

/**
 * Client-side collapse of `subagent_invocations` by `(job_id,
 * subagent_type)`. For each group, the row with the highest
 * `turn_seq` wins; the count of folded rows AND the count of stuck
 * orphans ride alongside so renderers can stamp a `(×N)` multiplier
 * and an `N stuck` indicator (board), and readiness can pretend
 * each named sub-agent is one logical agent (predicate 6 stops
 * false-blocking on orphaned `running` rows whose matching
 * `SubagentStop` never landed).
 *
 * "Stuck" definition: a row inside a group is stuck iff it is NOT
 * the surviving (max-`turn_seq`) row AND its `status === 'running'`.
 * A single-row group is never stuck; a running surviving row is
 * "currently running," not stuck. Counted inline so we never need
 * to retain the non-surviving rows themselves.
 *
 * Operating assumption: Claude Code does NOT spawn parallel sub-
 * agents of the same `subagent_type` within one parent session.
 * Under that assumption, "same name in one job" means "serial re-
 * invocation," and collapsing to the most-recent is the correct
 * logical view. If that ever ceases to hold we'd see parallel
 * `running` rows of the same type collapse to a single status —
 * worth revisiting the assumption then, but at the cost of one
 * masked-orphan recurrence, not a wedged projection.
 *
 * Returns groups in first-seen order (by the first row of each
 * `(job_id, subagent_type)` group as it appears in the input
 * stream), so a renderer that wants to preserve event-stream order
 * gets it for free. Within each group the SURVIVING row is the
 * highest-`turn_seq` row (not necessarily the first-seen).
 *
 * Pure function of its input; exported so the board renderer
 * (`scripts/board.ts:subagentLinesFor`) and the test suite can call
 * it directly without standing up the subscribe loop.
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
      // becomes a stuck orphan iff it was still `running`.
      if (existing.row.status === "running") {
        existing.stuck += 1;
      }
      existing.row = row;
    } else if (row.status === "running") {
      // Older-than-surviving row that's still `running` — stuck.
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
 * Internal options passed to `subscribeMulti`. The two public helpers shape
 * their differing semantics through this surface:
 *
 *   - `states` describes the per-collection page + coalescer machinery.
 *   - `onResult(state)` fires when a collection's `result` lands. The
 *     helper has already updated `state.rows` / `state.byId` / `state.order`
 *     by then.
 *   - `isTerminal(states)` returns true iff a pre-paint `error` should be
 *     treated as a fatal query-shape error (multi: ALL collections lack
 *     `gotResult` — five for `subscribeReadiness`; single: the one
 *     collection lacks `gotResult`).
 */
interface MultiOptions {
  readonly sockPath: string;
  readonly states: CollectionState[];
  readonly onResult: (state: CollectionState) => void;
  readonly isTerminal: (states: CollectionState[]) => boolean;
  readonly onLifecycle?: LifecycleCallback;
  readonly onFatal: (err: FatalError) => void;
  readonly connect: ConnectFactory;
}

/**
 * Core driver: owns the socket, the reconnect-with-backoff loop, the line
 * buffer, the per-collection `queryInFlight` / `refetchDirty` coalescer,
 * the steady-poll backstop, the disconnect teardown, and the terminal-error
 * gate. Both public helpers (`subscribeCollection`, `subscribeReadiness`)
 * compose this with the right number of collections + the right "is the
 * error terminal?" predicate.
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
  } = opts;
  const byCollection = new Map(states.map((s) => [s.collection, s]));
  // Parallel id-keyed index for multi-sub-aware routing. The server (post
  // fn-632.1) echoes each query's `id` on its `result`/`patch`/`meta`
  // frames, so a connection carrying N concurrent subs can route each
  // server frame back to the originating state without disambiguating by
  // collection alone (two subs on the same collection with different
  // filters are now possible). `subId` is a stable constant per state for
  // the helper's lifetime (`${idPrefix}-<collection>` in
  // `subscribeReadiness`, immutable across reconnect), so the map is
  // built once and never rebuilt — matches the immutability contract on
  // `states` itself. Legacy servers that don't echo `id` on patch/meta
  // fall through to `byCollection` — strictly additive on the wire.
  const bySubId = new Map(states.map((s) => [s.subId, s]));

  let currentSock: ReadinessSocket | null = null;
  let attempt = 0;
  let shuttingDown = false;
  /**
   * Single-flight guard for `triggerReconnect`. Two simultaneously-stuck
   * collections crossing `QUERY_TIMEOUT_MS` on the same poll tick must
   * produce ONE reconnect, not two — otherwise the second tear-down
   * would race the first reconnect attempt. Cleared in the `connectOnce`
   * open handler (alongside `attempt = 0`) and in the `close` handler so
   * a graceful close from the server also clears the latch.
   */
  let reconnecting = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Resolves on the pending `await Bun.sleep(...)` so `dispose()` during
  // backoff doesn't leak the timer. Use `setTimeout` directly (not
  // `Bun.sleep`) so we can `clearTimeout` from `dispose()`.
  let sleepResolve: (() => void) | null = null;

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
    // Stamp the in-flight-since clock on every fresh send and reset the
    // slow-flight latch so the next stuck window gets exactly one emit
    // again. Cleared symmetrically in `handleFrame`'s `result` branch.
    state.queryInFlightSince = Date.now();
    state.lastSlowFlightAt = null;
    currentSock.write(encodeFrame(state.query));
  }

  /**
   * Tear down the live connection in response to a hard query timeout.
   * Emits `query_timeout` for the first state that crossed the deadline,
   * calls `teardownConnection()` to release the steady-poll interval and
   * reset every per-state field, then half-closes the socket. The
   * existing `close` handler in `connectOnce` invokes `connectWithRetry`
   * on the resulting close event, so reconnect is automatic — no new
   * plumbing. Guarded by `reconnecting` so two stuck collections
   * crossing the threshold on the same poll produce one reconnect.
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
    // Grab the socket reference BEFORE `teardownConnection()` nulls
    // `currentSock` — otherwise the `end()` below is silently a no-op
    // and the underlying socket never closes, no `close` callback ever
    // fires, and `connectWithRetry` never re-runs.
    const sock = currentSock;
    teardownConnection();
    try {
      sock?.end();
    } catch {
      // already torn down
    }
  }

  function pollAll(): void {
    // The poll loop is now SLOW-FLIGHT DETECTION ONLY (fn-622's Tier 1
    // diagnostic). It walks every state, compares
    // `Date.now() - queryInFlightSince` against `SLOW_FLIGHT_MS` /
    // `QUERY_TIMEOUT_MS`, and either emits a one-shot
    // `query_slow_flight` lifecycle event or triggers a reconnect via
    // the single-flight `reconnecting` latch. NO REFETCH IS SCHEDULED
    // HERE — the prior steady-poll second pass (which fired a refetch
    // on every state every `POLL_MS`) was a workaround for the F3
    // single-sub server bug that the multi-sub refactor (fn-632.1)
    // closes. Post-Task-A, real-time `patch`/`meta` frames drive
    // freshness via `scheduleRefetchFor` in `handleFrame`; pollAll is
    // pure diagnosis.
    const now = Date.now();
    for (const s of states) {
      if (!s.queryInFlight || s.queryInFlightSince === null) {
        continue;
      }
      const age = now - s.queryInFlightSince;
      if (age >= QUERY_TIMEOUT_MS) {
        triggerReconnect(s);
        return;
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
   * Merge a `patch` frame's full row into `state` in place, mirroring the
   * `result` branch's upsert shape (upsert `byId`, append to `order` if new,
   * replace the matching `rows` entry / append if new), then re-arm the
   * per-pk version cursor. Returns true iff the merge happened and `onResult`
   * should fire; false when the patch is dropped — missing pk, or its version
   * is not strictly newer than the last-seen cursor for that pk (the
   * per-`(collection, pk)` version guard against reconnect-replay / out-of-
   * order delivery). Page membership is respected: a patch for a pk NOT in
   * the current page is dropped (the server only watches in-page ids, so this
   * is defensive — never blind-append an off-page row).
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
    // Membership guard: the server only emits patches for ids in the active
    // page, so an id we don't already track is off-page noise — drop it
    // rather than blind-append (a blind append would surface a row outside
    // the page/sort/limit). A genuine membership change arrives as `meta`.
    if (!state.byId.has(id)) {
      return false;
    }
    // Version guard, keyed per-pk: drop a patch whose version isn't strictly
    // newer than what we last rendered for this pk. When the column is
    // absent/non-numeric (`rowVersion` → null) the guard is inert (accept),
    // matching the pre-guard behavior for versionless rows.
    const v = rowVersion(state, row);
    if (v !== null) {
      const last = state.lastSeenVersion.get(id);
      if (last !== undefined && v <= last) {
        return false;
      }
    }
    state.byId.set(id, row);
    // Replace the matching `rows` entry in wire/page order (what `onRows`
    // reads). The id is in `order` by the membership guard above, so the
    // index lookup always hits.
    const idx = state.order.indexOf(id);
    if (idx !== -1) {
      state.rows[idx] = row;
    }
    if (v !== null) {
      state.lastSeenVersion.set(id, v);
    }
    return true;
  }

  function handleFrame(frame: ServerFrame): void {
    if (frame.type === "result") {
      // Id-first routing: prefer the echoed sub `id` (multi-sub-aware
      // server, fn-632.1+), fall back to `collection` (legacy server
      // that doesn't echo `id`). The result frame has always carried
      // `id?: string` in the wire protocol, but legacy single-sub
      // servers omitted it on `patch`/`meta`; doing the lookup uniformly
      // here keeps result/patch/meta consistent. A bare `collection`
      // lookup would still work for the helper (one sub per collection
      // by construction), but the consistency is load-bearing for any
      // future consumer that registers multiple subs on the same
      // collection.
      const state =
        (frame.id !== undefined ? bySubId.get(frame.id) : undefined) ??
        byCollection.get(frame.collection);
      if (!state) {
        // A `result` for a sub we don't track — defensive; should
        // never happen on a connection we opened ourselves.
        return;
      }
      state.queryInFlight = false;
      // Clear the slow-flight + timeout machinery now that we have a
      // result. The next `scheduleRefetchFor` re-stamps both.
      state.queryInFlightSince = null;
      state.lastSlowFlightAt = null;
      state.order.length = 0;
      state.byId.clear();
      state.lastSeenVersion.clear();
      // Re-snapshot `rows` from this frame — see module docstring on why
      // the readiness handoff reads from here.
      state.rows = frame.rows.slice();
      for (const row of frame.rows) {
        const id = String(row[state.pk]);
        state.order.push(id);
        state.byId.set(id, row);
        // Re-arm the per-pk version cursor from the authoritative page so a
        // subsequent direct-merge `patch` is compared against the version
        // this `result` rendered (a stale/equal-version patch is dropped).
        const v = rowVersion(state, row);
        if (v !== null) {
          state.lastSeenVersion.set(id, v);
        }
      }
      state.gotResult = true;
      onResult(state);
      if (state.refetchDirty) {
        state.refetchDirty = false;
        scheduleRefetchFor(state);
      }
    } else if (frame.type === "patch") {
      // Id-first routing, same fallback chain as `result`. A new server
      // (fn-632.1+) echoes `id` on every patch on behalf of a sub with a
      // non-null id; a legacy server emits neither, and the collection
      // lookup is the only routable signal.
      const state =
        (frame.id !== undefined ? bySubId.get(frame.id) : undefined) ??
        byCollection.get(frame.collection);
      if (!state) {
        return;
      }
      // Lever A1 (fn-694.1): direct-merge the pushed row instead of a
      // refetch round-trip — but ONLY for the sidecar helper
      // (`subscribeCollection` sets `directMergePatch`), and ONLY once the
      // initial page is seeded (`gotResult`). A patch that arrives before
      // the first `result` — e.g. mid-reconnect, with `byId`/`order`/
      // `lastSeenVersion` all reset by teardown — has no page to merge
      // into; falling through to `scheduleRefetchFor` re-pages it cleanly.
      // The board (`subscribeReadiness`) leaves `directMergePatch` false
      // and stays on the refetch path (deliberately out of scope).
      if (state.directMergePatch && state.gotResult) {
        if (
          mergePatchRow(state, (frame as { row: Record<string, unknown> }).row)
        ) {
          onResult(state);
        }
        // A dropped patch (stale/equal version, or missing pk) is a no-op
        // — the server already pushed the freshest row, so there is
        // nothing to re-query; the steady-poll backstop covers any genuine
        // lost-wakeup.
        return;
      }
      scheduleRefetchFor(state);
    } else if (frame.type === "meta") {
      // A `meta` is a membership-change nudge and is UNMERGEABLE from one
      // row (a row entered or left the filtered set), so it always
      // refetches — for both helpers. Id-first routing, same fallback
      // chain as `result`/`patch`.
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
      // A bad_frame / unknown_collection on our own query is terminal — a
      // reconnect can't fix a malformed query. Terminal predicate per
      // helper: for a single collection, true iff `!gotResult`; for the
      // readiness composition, true iff NO collection has a first result.
      // Otherwise the error is likely transient and the next refetch will
      // recover.
      if (isTerminal(states)) {
        shuttingDown = true;
        try {
          currentSock?.end();
        } catch {
          // already torn down
        }
        // Release the steady-poll interval and reset per-collection state
        // before handing the terminal error to the caller. The default
        // `onFatal` is `process.exit(1)` so the leak is invisible there,
        // but a custom `onFatal` that returns (tests, in-process
        // consumers) would otherwise leave a live `setInterval` holding
        // the event loop open indefinitely.
        teardownConnection();
        // Hand the terminal error off to the caller (default:
        // `process.exit(1)`) AFTER tearing the connection down, so a
        // custom `onFatal` that throws or schedules work observes the
        // helper in its fully-shut-down state. `onFatal` exceptions
        // propagate — same no-self-heal contract as `onSnapshot` /
        // `onRows`.
        onFatal({
          code: frame.code,
          rev: frame.rev,
          message: frame.message,
        });
      }
    }
  }

  function teardownConnection(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    currentSock = null;
    for (const s of states) {
      s.order.length = 0;
      s.byId.clear();
      s.lastSeenVersion.clear();
      s.rows.length = 0;
      s.queryInFlight = false;
      s.refetchDirty = false;
      s.gotResult = false;
      // Reset the slow-flight + timeout machinery so the
      // post-reconnect re-stamp is honest and a survived
      // `lastSlowFlightAt` from the old window can't suppress the
      // first emit of the new window.
      s.queryInFlightSince = null;
      s.lastSlowFlightAt = null;
    }
  }

  async function connectOnce(): Promise<void> {
    const buffer = new LineBuffer();
    await connect(sockPath, {
      open(sock) {
        attempt = 0;
        reconnecting = false;
        currentSock = sock;
        emit("connected", { sock: sockPath });
        // Send every subscribed query up front. Each collection's
        // `queryInFlight` tracks its own send so the poll/refetch
        // coalescer stays sane. Stamp `queryInFlightSince` on each
        // send and reset `lastSlowFlightAt` so the post-reconnect
        // window starts clean.
        const now = Date.now();
        for (const s of states) {
          s.queryInFlight = true;
          s.queryInFlightSince = now;
          s.lastSlowFlightAt = null;
          sock.write(encodeFrame(s.query));
        }
        pollTimer = setInterval(pollAll, POLL_MS);
      },
      data(sock, chunk) {
        let lines: string[];
        try {
          lines = buffer.push(chunk.toString("utf8"));
        } catch (err) {
          // A protocol-frame parse failure is fatal for this connection
          // but not for the caller's process — surface via lifecycle
          // and tear down. The reconnect loop will try again.
          emit("error", { message: (err as Error).message });
          try {
            sock.end();
          } catch {
            // ignore
          }
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
        // Clear the single-flight latch so a fresh `connectWithRetry`
        // cycle (whether it follows a graceful close or our own
        // `triggerReconnect` tear-down) can advance to `open` and reset
        // the latch on its own — and so a future timeout-triggered
        // reconnect after this cycle isn't permanently suppressed.
        reconnecting = false;
        teardownConnection();
        emit("disconnected");
        void connectWithRetry();
      },
      error(_sock, err) {
        emit("error", { message: err.message });
      },
    });
  }

  async function connectWithRetry(): Promise<void> {
    emit("connecting", { sock: sockPath });
    while (!shuttingDown) {
      try {
        await connectOnce();
        return;
      } catch (err) {
        if (shuttingDown) {
          return;
        }
        attempt += 1;
        const delay = Math.min(
          INITIAL_BACKOFF_MS * 2 ** (attempt - 1),
          MAX_BACKOFF_MS,
        );
        emit("waiting", {
          attempt,
          retry_in_ms: delay,
          reason: (err as Error).message,
        });
        // Use a directly-cancellable timeout so `dispose()` during backoff
        // doesn't leak the timer. `Bun.sleep` returns a Promise we can't
        // resolve from outside.
        await new Promise<void>((resolve) => {
          sleepResolve = resolve;
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            sleepResolve = null;
            resolve();
          }, delay);
        });
      }
    }
  }

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
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        // Resolve the pending sleep promise so `connectWithRetry`'s loop
        // observes `shuttingDown` and exits cleanly.
        sleepResolve?.();
        sleepResolve = null;
      }
      try {
        // No `id` → drop every subscription on this connection in one frame.
        if (currentSock != null) {
          currentSock.write(encodeFrame({ type: "unsubscribe" }));
          currentSock.end();
        }
      } catch {
        // socket already gone — nothing to release
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
 * collection name to form the subscription id (e.g. `git-frames`); the
 * server doesn't enforce uniqueness across connections, the prefix is
 * purely a debug-log discriminator.
 *
 * `filter` / `sort` / `limit` are forwarded verbatim to the underlying
 * `QueryFrame`. `limit: 0` is the explicit "no limit" sentinel (matches
 * the protocol's `limit: 0` semantics — full filtered set, no LIMIT cap
 * server-side); omit to use the server default of 100. The caller is
 * responsible for choosing a limit appropriate to the watched-set size.
 *
 * `onRows(rows)` fires once per `result` frame after the per-collection
 * first-paint gate clears. `rows` is the wire-order array straight from
 * the result frame (a fresh slice — the caller can mutate without
 * disturbing the helper's state). On reconnect the gate re-closes and
 * `onRows` is silent until the post-reconnect first `result` lands.
 *
 * `onLifecycle` observes `connecting` / `connected` / `disconnected` /
 * `waiting` / `error` events.
 *
 * `onFatal` is called when a terminal `error` frame arrives BEFORE the
 * single collection has produced a first `result` — the query itself is
 * unrecoverable and a reconnect cannot fix it. When omitted, the helper
 * defaults to `process.exit(1)`. The terminal error is also surfaced via
 * `onLifecycle` with the same payload immediately before `onFatal` fires.
 *
 * `connect` is the socket factory used to open a connection — exposed
 * only for test injection. Defaults to a thin wrapper around
 * `Bun.connect({ unix, socket })`; production callers should never set
 * this. Tests use it to substitute an in-memory mock that records
 * outbound frames and delivers inbound frames synchronously.
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
}

/**
 * Open a subscription to a single collection and invoke `onRows` once per
 * `result` frame. Returns a handle whose `dispose()` tears down the
 * connection, cancels any pending reconnect timer, and releases the
 * steady-poll interval.
 *
 * This helper is the building block sidecar UIs (e.g. `scripts/git.ts`)
 * use instead of hand-rolling their own `Bun.connect` loop. It shares the
 * full lifecycle contract with `subscribeReadiness` — capped-backoff
 * reconnect, per-collection coalesce, steady-poll backstop, idempotent
 * dispose, no in-process self-heal — so all subscribe consumers behave
 * identically on the wire.
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
  // Thread the descriptor's REAL pk + version column so the direct-merge
  // path keys correctly (Lever A1, fn-694.1). Pre-fn-694 this passed pk=""
  // because the helper never read `byId`/`order` from outside — but the
  // direct-merge `patch` path now upserts into `byId`/`order`/`rows` by pk,
  // and the version guard compares the `version` column, so both must be the
  // descriptor's actual columns. An unknown collection (no descriptor) keeps
  // pk="" / version="" — `getCollection` returns undefined; the merge then
  // no-ops on a missing pk and the version guard is inert, so an unknown
  // collection still rides the refetch path harmlessly.
  const descriptor = getCollection(opts.collection);
  const state = makeState(opts.collection, subId, descriptor?.pk ?? "", query, {
    version: descriptor?.version ?? "",
    directMergePatch: true,
  });
  return subscribeMulti({
    sockPath: opts.sockPath,
    states: [state],
    onResult(s) {
      // Hand back a FRESH array copy of the current rows. On a `result`
      // frame `s.rows` is already a fresh `frame.rows.slice()`, but the
      // direct-merge `patch` path mutates `s.rows` in place, so a copy-out
      // here is load-bearing — consumers retain the slice (see the
      // `onRows(s.rows)` handoff contract), and handing back the live array
      // would let a later patch mutate a slice the caller still holds.
      opts.onRows((s.rows as Record<string, unknown>[]).slice());
    },
    isTerminal: (sts) => sts.every((s) => !s.gotResult),
    ...(opts.onLifecycle === undefined
      ? {}
      : { onLifecycle: opts.onLifecycle }),
    onFatal,
    connect,
  });
}

// ---------------------------------------------------------------------------
// Public helper #2: five-collection readiness subscribe
// ---------------------------------------------------------------------------

/**
 * Subscribe options. `idPrefix` is appended with the collection name so
 * subscription IDs become `<prefix>-epics` / `<prefix>-jobs` /
 * `<prefix>-subagent-invocations` / `<prefix>-git` /
 * `<prefix>-dead-letters`. The server doesn't enforce uniqueness across
 * connections; the prefix is purely a debug-log discriminator.
 *
 * `onFatal` is called when a terminal `error` frame arrives BEFORE any
 * collection has produced a first `result` — the query itself is
 * unrecoverable and a reconnect cannot fix it. When omitted, the helper
 * defaults to `process.exit(1)` (matching the pre-extraction behavior at
 * `scripts/board.ts:870`, commit `212be34^`). Callers that want
 * non-process-exit semantics (e.g. tests, in-process consumers) pass a
 * custom `onFatal`. The terminal error is also surfaced via `onLifecycle`
 * with the same payload immediately before `onFatal` fires.
 *
 * `connect` is the socket factory used to open a connection — exposed
 * only for test injection. Defaults to a thin wrapper around
 * `Bun.connect({ unix, socket })`; production callers should never set
 * this. Tests use it to substitute an in-memory mock that records
 * outbound frames and delivers inbound frames synchronously.
 */
export interface SubscribeOptions {
  readonly sockPath: string;
  readonly idPrefix: string;
  readonly onSnapshot: (snap: ReadinessClientSnapshot) => void;
  readonly onLifecycle?: LifecycleCallback;
  readonly onFatal?: (err: FatalError) => void;
  readonly connect?: ConnectFactory;
}

/**
 * Open a subscription to all five readiness collections on a single
 * connection and invoke `onSnapshot` once per emit (after the all-five
 * gate clears). Returns a handle whose `dispose()` tears down the
 * connection, cancels any pending reconnect timer, and releases the
 * steady-poll interval.
 */
export function subscribeReadiness(
  opts: SubscribeOptions,
): ReadinessClientHandle {
  const { sockPath, idPrefix, onSnapshot, onLifecycle } = opts;
  const onFatal = opts.onFatal ?? defaultOnFatal;
  const connect = opts.connect ?? defaultConnect;

  const epicsSubId = `${idPrefix}-epics`;
  const jobsSubId = `${idPrefix}-jobs`;
  const subsSubId = `${idPrefix}-subagent-invocations`;
  const gitSubId = `${idPrefix}-git`;
  const deadLettersSubId = `${idPrefix}-dead-letters`;
  const pendingDispatchesSubId = `${idPrefix}-pending-dispatches`;
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
    limit: JOBS_PAGE_LIMIT,
  });
  // The `subagent_invocations` descriptor exposes `job_id` as the wire pk
  // even though the SQL identity is composite `(job_id, agent_id,
  // turn_seq)` — see `src/collections.ts:SUBAGENT_INVOCATIONS_DESCRIPTOR`.
  // `byId` collapses re-entrant sub-agents in one session (multiple rows
  // sharing one `job_id`) to last-write-wins, so the readiness handoff
  // reads from `state.rows` instead — every received invocation reaches
  // `computeReadiness` so predicate 6 (`own-progress-sub`) sees every
  // `running` sub. Page limit 0 streams the full default scope — same
  // scope-is-board reasoning as epics.
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
  // The `git` collection feeds predicate 6.5 (git-uncommitted / git-orphans)
  // — one row per planctl-backed git worktree, keyed by `project_dir`.
  // Schema-v21 froze per-job `git_dirty_count`/`git_orphan_count` columns
  // on terminal worker transition, so reading those at evaluate time
  // produced false `git-orphans` blocks against a since-clean tree. The
  // live `git_status` row is the honest source of truth; we project it
  // into a `Map<project_dir, {dirty_count, unattributed_to_live_count}>`
  // and pass it into `computeReadiness` below. The
  // `unattributed_to_live_count` field carries the schema-v31 legacy
  // "orphan" semantic (renamed for honesty under `git_unattributed_to_live_count`);
  // see the projection block below for the column-name-vs-reason-kind
  // divergence rationale. First-paint gate widened to include this
  // collection so a partial snapshot can't flip the pill on the pre-paint
  // blank state.
  const gitStatus = makeState("git", gitSubId, "project_dir", {
    type: "query",
    collection: "git",
    id: gitSubId,
    limit: GIT_PAGE_LIMIT,
  });
  // The `dead_letters` collection feeds the board's persistent warn-count
  // pill (waiting rows the daemon imported from per-pid NDJSON files when
  // the hook's `events` INSERT exhausted retry — see fn-643). Default
  // page rides the descriptor's `defaultFilter: { status: "waiting" }`
  // server-side scope so the wire stream is just the unrecovered backlog;
  // recovered rows still exist (the row is the audit trail joining
  // `dl_id` to the appended `replayed_event_id`) but fall off the default
  // page. First-paint gate widened to this collection — an empty steady
  // state (zero waiting, the happy case) still produces a `result` frame
  // with `rows: []` so the gate clears.
  const deadLetters = makeState("dead_letters", deadLettersSubId, "dl_id", {
    type: "query",
    collection: "dead_letters",
    id: deadLettersSubId,
    limit: DEAD_LETTERS_PAGE_LIMIT,
  });
  // fn-721: the `pending_dispatches` collection — the 6th subscribed
  // collection. Feeds the `dispatch-pending` occupant (a launched-but-not-yet-
  // bound worker holds its mutex slot). The wire pk is `verb` (the descriptor's
  // composite-pk workaround — `id` rides in `columns`/`filters`), but readiness
  // reads from `state.rows` via `projectRows`, so every row reaches the
  // projection regardless of the single-column wire pk collapsing on `verb`.
  // First-paint gate widened to this collection — an empty steady state (zero
  // in-flight launches, the common case) still produces a `result` frame with
  // `rows: []` so the gate clears (the `dead_letters` precedent).
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
  const states: CollectionState[] = [
    epics,
    jobs,
    subagentInvocations,
    gitStatus,
    deadLetters,
    pendingDispatches,
  ];

  function emitSnapshotIfReady(): void {
    if (
      !epics.gotResult ||
      !jobs.gotResult ||
      !subagentInvocations.gotResult ||
      !gitStatus.gotResult ||
      !deadLetters.gotResult ||
      // fn-721: gate on the 6th collection too — a partial snapshot must not
      // flip the `dispatch-pending` occupancy on the pre-paint blank state.
      // An empty `pending_dispatches` still produces a `result` frame with
      // `rows: []`, so this clears in the common (no in-flight launch) case.
      !pendingDispatches.gotResult
    ) {
      return;
    }
    // Cast: the wire delivers each row as `Record<string, unknown>`; the
    // descriptors guarantee the shape matches the typed projection
    // (decoded by `decodeRow` on the server side).
    const epicsTyped = epics.order.map(
      (id) => (epics.byId.get(id) ?? { [epics.pk]: id }) as unknown as Epic,
    );
    const jobsTyped = new Map<string, Job>();
    for (const [id, row] of jobs.byId) {
      jobsTyped.set(id, row as unknown as Job);
    }
    // Read from `state.rows` (not `byId.values()`) — see module docstring.
    const subsTyped = projectRows<SubagentInvocation>(subagentInvocations);
    // Collapse same-name sub-agents to most-recent before readiness sees
    // them — same operating assumption + rationale as `collapseSubagentsByName`'s
    // docstring (no parallel like-named sub-agents in practice, so
    // orphaned `running` rows whose matching `SubagentStop` never
    // landed shouldn't false-block predicate 6). The full uncollapsed
    // slice still rides on the snapshot for the audit trail; only the
    // readiness handoff sees the collapsed view.
    const subsForReadiness = collapseSubagentsByName(subsTyped).map(
      (g) => g.row,
    );
    // Project the `git_status` rows into the
    // `{dirty_count, unattributed_to_live_count}` shape `computeReadiness`
    // consumes. The `dirty_count` is the direct column read; the
    // `unattributed_to_live_count` is the schema-v31 legacy v28 "orphan"
    // semantic (renamed for honesty — "dirty files no LIVE session is on
    // the hook for") and feeds readiness predicate 6.5's `git-orphans`
    // block reason. Note the deliberate column-name-vs-reason-kind
    // divergence: the readiness reason kind is STILL `git-orphans`
    // (preserved for backward compatibility with autopilot's literal
    // string comparisons in `scripts/autopilot.ts:230,238,449`); only the
    // underlying column the count is sourced from gets the more honest
    // name. See `gitStatusByProjectDir`'s doc on `computeReadiness` for
    // the rationale.
    //
    // The `git_status.orphaned_count` column on the wire carries the NEW
    // schema-v31 strict-mystery semantic (files with ZERO active
    // attribution from any tracked session — same value as
    // `jobs.git_orphan_count`); it is INFORMATIONAL ONLY at v31 and is
    // NOT projected into the readiness map. To recover the legacy
    // unattributed-to-live count for readiness, we compute it
    // client-side from the per-file `attributions[]` materialized view
    // on `git_status.dirty_files`: a dirty file counts toward
    // `unattributed_to_live_count` when its `attributions[]` contains no
    // entry with `state IN ('working', 'stopped')`. The mirror of the
    // reducer's PASS-4 fan-out computation (`src/reducer.ts:1442-1463`),
    // redone here from the same materialized JSON the reducer wrote so
    // both numbers reconcile.
    const gitTyped = projectRows<GitStatus>(gitStatus);
    const gitStatusByProjectDir = projectGitStatusByProjectDir(gitTyped);
    // fn-721: project the `pending_dispatches` rows into the plain
    // `PendingDispatch[]` shape via the SOLE shared helper (the SAME one the
    // autopilot reconciler's `loadReconcileSnapshot` uses) so the board/CLI
    // readiness pass and the autopilot reconciler agree byte-for-byte on the
    // `dispatch-pending` occupancy set. Read from `state.rows` (not
    // `byId.values()`) — the descriptor's wire pk is the composite-workaround
    // `verb`, so `byId` would collapse same-`verb` rows; every in-flight
    // dispatch must reach the projection.
    const pendingDispatchesTyped = projectPendingDispatches(
      projectRows<Record<string, unknown>>(pendingDispatches),
    );
    const readiness = computeReadiness(
      epicsTyped,
      jobsTyped,
      subsForReadiness,
      gitStatusByProjectDir,
      // fn-638.4: caller-injected reference timestamp (unix seconds) for
      // the `sub-agent-stale` `RunningReason` variant. The pure readiness
      // pass never reads `Date.now()`; the live client supplies it here,
      // per snapshot, so a still-`running` sub-agent past
      // `SUBAGENT_STALENESS_SEC` renders as `sub-agent-stale` instead of
      // `sub-agent-running`. See `computeReadiness`'s `now` parameter doc
      // for the full rationale (mirrors fn-637.1's injected-`now`
      // resolver pattern in `epic-deps.ts`).
      Math.floor(Date.now() / 1000),
      // fn-721: the launch-window occupancy set.
      pendingDispatchesTyped,
    );
    // `dead_letters` is a flat row stream — typed projection from
    // `state.rows` so the wire diff (each `result` re-snapshots `rows`)
    // is the source of truth. Renderers consume `deadLetters.length` for
    // the warn-count pill; the `dl_id` + `hook_event` + `session_id`
    // fields ride along so a future detail view (or a tooltip) can
    // surface "what dropped" without a separate sub.
    const deadLettersTyped = projectRows<DeadLetter>(deadLetters);
    // Exceptions from `onSnapshot` propagate. This matches keeper's
    // "no in-process self-heal" stance and the prior board.ts code path,
    // which had no try/catch around its emit either.
    onSnapshot({
      epics: epicsTyped,
      jobs: jobsTyped,
      subagentInvocations: subsTyped,
      gitStatus: gitTyped,
      deadLetters: deadLettersTyped,
      pendingDispatches: pendingDispatchesTyped,
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
  });
}
