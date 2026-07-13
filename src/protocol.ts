/**
 * NDJSON wire protocol for the keeper UDS subscribe server. Dependency-free
 * (no bun:sqlite, no node fs) so the frame contract is the same code on both
 * ends — the server worker constructs frames, an in-test `Bun.connect` client
 * parses them, and unit tests round-trip without touching a socket.
 *
 * The protocol is one JSON object per line, encoded as `JSON.stringify(frame)
 * + "\n"`. Either side may emit multiple frames in a single chunk, or split a
 * single frame across chunks — the caller MUST buffer until a `\n` lands.
 *
 * Frame shapes (discriminated unions on `type`):
 *
 * Client → server:
 * - `query`     — request an ordered page; doubles as a subscription anchor.
 *                 Optional `id` echoes back on result/error for correlation.
 *                 `sort` / `limit` / `offset` / `filter` are all optional;
 *                 the server picks sensible defaults.
 * - `unsubscribe` — drop the active subscription for this connection (or the
 *                   specific query `id`); the server stops emitting patches.
 * - `rpc`        — call a registered server-side handler that may mutate the
 *                  DB through the server-worker's writer connection. `id` is
 *                  required (echoed on the `rpc_result` / `error` response);
 *                  `method` names a handler in the server's RPC registry;
 *                  `params` is an optional opaque object the handler validates.
 *
 * Server → client:
 * - `result` — the snapshot page (rows in order) plus the world-rev at query
 *              time. `rev = reducer_state.last_event_id`. This frame doubles
 *              as the initial subscription state; subsequent patches arrive
 *              with monotonically non-decreasing `rev` values. Echoes the
 *              `collection` the page was read from. Carries `total` — the size
 *              of the FULL filtered set (ignoring limit/offset) so a paginated
 *              client can render "showing rows.length of total".
 * - `patch`  — a single row in the page has advanced (its per-row `version`
 *              column moved forward). The full updated `row` is included so the
 *              client never needs to re-query to render the change. Echoes the
 *              `collection`, and echoes the originating query's `id` (when
 *              present) so a multi-sub client can route the frame to the
 *              correct subscription.
 * - `meta`   — a membership-staleness signal for the active subscription: the
 *              filtered-set `total` and/or the set's membership changed since
 *              the last frame sent on this connection. Carries the new `total`
 *              but NOT the changed rows — it's a "set changed, refresh" nudge,
 *              not a live membership stream (frozen membership is unchanged).
 *              Echoes the `collection`, and echoes the originating query's
 *              `id` (when present) for multi-sub routing.
 * - `rpc_result` — response to a successful `rpc` call. Echoes the request's
 *                  `id` for correlation; `value` is the handler's return,
 *                  shaped by the handler (opaque to the framing layer).
 * - `error`  — protocol or query error. `code` is a short tag; `message` is
 *              human-readable. `collection` is echoed when attributable to a
 *              named collection (e.g. `unknown_collection`). For an `rpc`
 *              failure, `id` echoes the request id and `code` is one of
 *              `unknown_method` / `bad_params` / `rpc_failed`.
 *
 * Collections: every frame names a `collection` (resolved against the registry
 * in `src/collections.ts`); `jobs` is the first/default. Rows are generic
 * (`Row`), shaped by the collection's column list.
 *
 * Frozen membership: a live page's row SET is fixed at query time — cells
 * stream (a row's columns update via `patch`) but rows never enter or leave the
 * page. The diff never re-evaluates the WHERE for move-in/move-out.
 *
 * Forward-compat: unknown frame fields are ignored, so older clients keep
 * working as the vocabulary grows.
 *
 * INVARIANT: `rev` is present on EVERY server frame (result, patch, meta,
 * error with a known world-rev). Downstream consumers depend on a single
 * monotonic cursor for ordering. `rev` is the GLOBAL reducer cursor — distinct
 * from a collection's per-row `version` column the diff fires on.
 */

/** The generic served-row shape; a collection's columns determine the keys. */
export type Row = Record<string, unknown>;

/**
 * Boot-status header (fn-897 B1) the server stamps on EVERY served frame
 * (`result` / `rpc_result` / `error`) so a client can tell whether it is
 * reading catch-up state. The read socket comes up right after `migrate()` —
 * BEFORE the boot drain finishes — so an early client can page a partially-folded
 * projection; this header is how it knows.
 *
 * - `rev` — `reducer_state.last_event_id`, the global fold cursor (mirrors the
 *   frame's own `rev`). Carried here too so a single field carries the whole
 *   staleness verdict.
 * - `head_event_id` — `max(events.id)`, the newest INGESTED event. While the
 *   drain runs `rev < head_event_id`; at head they coincide.
 * - `catching_up` — `true` while the reducer is still draining toward head OR
 *   the git surface is unseeded. The client treats a snapshot read while
 *   `catching_up` is true as provisional (it MUST NOT cache an empty projection
 *   as ground truth — the header rides EVERY reply, not just the first).
 * - `git_seed_required` — `git_projection_state.seed_required !== 0`: the COARSE
 *   "any gated root unseeded" boolean. Drives `catching_up`; a consumer of the
 *   coarse git-clean gate treats unseeded as "unknown", never "clean".
 * - `git_unseeded_roots` (fn-905) — the PER-ROOT refinement: the `effectiveRoot`s
 *   (`target_repo ?? project_dir`) that lack a seeded `git_status` row above the
 *   floor. EMPTY whenever `git_seed_required` is false. The board latches this and
 *   forces `{kind:unknown}` per-root, so it renders the SAME per-root gate the
 *   autopilot dispatches against (the `[::ready]`-while-autopilot-dark divergence
 *   is gone). Optional/additive — an older client ignoring it falls back to no
 *   per-root gating, which over-dispatches only in the brief unseeded window.
 *
 * Forward-compat: an older client ignores the unknown `boot` field (the
 * "unknown frame fields ignored" rule), so adding it is wire-safe.
 */
export interface BootStatus {
  rev: number;
  head_event_id: number;
  catching_up: boolean;
  git_seed_required: boolean;
  git_unseeded_roots?: string[];
  /**
   * fn-954 — the EFFECTIVE per-root dispatch concurrency count N the board must
   * apply so it computes the SAME per-root demotions as the reconciler. Derived
   * server-side from the folded `autopilot_state` stored intent and worktree mode
   * (worktree off ⇒ 1); the durable stored intent does NOT cross the wire, so
   * this field's meaning ("the cap dispatch uses") is stable for older clients.
   * Optional/additive — an older client ignoring it (or a frame omitting it)
   * falls back to N=1, today's one-task-per-root mutex.
   */
  max_concurrent_per_root?: number;
  /**
   * Per-daemon-boot nonce, minted once when the server worker spawns. The fold
   * cursor (`rev`) and `head_event_id` both PERSIST across a plain daemon
   * restart (the DB is durable), so neither can tell a client its connection
   * now rides a NEW daemon generation. This does: a client that observes a
   * changed generation across a reconnect knows a bounce happened and must
   * re-baseline rather than resume a stored sequence (the epoch guard). Opaque
   * to the client — compared for equality only, never parsed. Optional/additive:
   * an older client ignores it, and a frame omitting it disables the guard
   * (the client falls back to the always-re-baseline-on-reconnect contract).
   */
  generation?: string;
}

// ---------------------------------------------------------------------------
// Frame types
// ---------------------------------------------------------------------------

/**
 * Sort spec for a `query` frame. `column` names a sortable column of the
 * target collection (validated against the collection's allowlist); `dir`
 * defaults server-side when omitted.
 */
export interface QuerySort {
  column: string;
  dir?: "asc" | "desc";
}

/**
 * Client → server: request an ordered page (and start a subscription).
 *
 * `collection` (required) names the collection to page (resolved against the
 * registry in `src/collections.ts`; e.g. `"jobs"`). `id` is opaque to the
 * server — when present, it's echoed on the matching `result` / `error` frame
 * for correlation. `unsubscribe` can target a specific id to drop just that
 * subscription if a client multiplexes.
 *
 * `filter` is a map of filter-key → value. The server resolves each key against
 * the collection's declared filters (unknown keys are ignored for
 * forward-compat) and binds the value; keys are never interpolated. A bare
 * `string | number` value is an exact match (`col = ?`); the `{ ne: value }`
 * operator form is a not-equal exclusion (`col != ?`) — e.g.
 * `filter: { state: { ne: "ended" } }` pages every job whose state isn't
 * `ended`. The `{ in: [...] }` / `{ not_in: [...] }` operator forms are
 * SQL `IN (...)` / `NOT IN (...)` exclusions with one bound parameter per
 * value — e.g. `filter: { state: { not_in: ["ended", "killed"] } }` pages
 * every job whose state isn't terminal. Edge cases: `{ in: [] }` matches
 * nothing (resolves to a `WHERE 0` no-rows clause); `{ not_in: [] }` matches
 * everything (contributes no clause). The operator literal is fixed in the
 * server, never wire text; only the values are bound. An operator object the
 * server doesn't recognize is ignored (forward-compat).
 */
export type FilterValue =
  | string
  | number
  | { ne: string | number }
  | { in: (string | number)[] }
  | { not_in: (string | number)[] };

export interface QueryFrame {
  type: "query";
  collection: string;
  id?: string;
  sort?: QuerySort;
  /**
   * Page size. Omitted / negative / non-finite → server's `DEFAULT_LIMIT`
   * (100). Positive → clamped at the server's `MAX_LIMIT` (500). `0` is the
   * explicit "no limit" sentinel: the server returns the full filtered set
   * with NO row cap (LIMIT -1 internally; OFFSET still honored). The
   * realtime diff fan-out scales linearly with watched-set size, so callers
   * opt into `limit: 0` deliberately for views that need the whole
   * collection (e.g. `scripts/board.ts`).
   */
  limit?: number;
  offset?: number;
  filter?: Record<string, FilterValue>;
}

/** Client → server: stop emitting patches for `id` (or all, if omitted). */
export interface UnsubscribeFrame {
  type: "unsubscribe";
  id?: string;
}

/**
 * Server → client: the snapshot page for a `query`. `rev` is the
 * `reducer_state.last_event_id` at the moment the page was read; subsequent
 * `patch` frames carry monotonically non-decreasing `rev`. `collection` echoes
 * the queried collection. Rows are generic (`R`, defaulting to `Row`).
 *
 * `total` is the size of the FULL filtered set (the query's WHERE, ignoring
 * limit/offset), so a paginated client can render "showing `rows.length` of
 * `total`". It seeds the subscription's membership baseline; subsequent `meta`
 * frames report when it (or the set's membership) moves.
 *
 * fn-698: the server MAY serve this frame pre-serialized (a shared per-worldRev
 * result memo concatenates the per-conn envelope around one cached `rows`
 * blob). The frame SHAPE on the wire is unchanged — bytes are byte-identical to
 * `encodeFrame(...)` of this object.
 */
export interface ResultFrame<R extends Row = Row> {
  type: "result";
  id?: string;
  collection: string;
  rev: number;
  total: number;
  rows: R[];
  /**
   * Boot-status header (fn-897 B1). Present on every reply during catch-up
   * (and harmlessly at steady state, where `catching_up` is false). Optional
   * for forward/backward compat and so direct-dispatch unit paths that don't
   * thread a status reader omit it.
   */
  boot?: BootStatus;
}

/**
 * Server → client: one row in the active page has advanced. `row` is the
 * full updated row (not a delta) so the client renders without re-querying.
 * `collection` echoes the collection the row belongs to. `id`, when present,
 * echoes the originating query's `id`, routing the frame to the correct
 * subscription on a multi-sub connection. Absent when the originating query
 * had no `id` (legacy single-sub client).
 */
export interface PatchFrame<R extends Row = Row> {
  type: "patch";
  id?: string;
  collection: string;
  rev: number;
  row: R;
}

/**
 * Server → client: a membership-staleness signal for the active subscription.
 * Emitted when the filtered-set `total` and/or the set's membership (the
 * identities of the matching rows, fingerprinted by pk) changed since the last
 * frame sent on this connection — i.e. a row entered or left the filtered set,
 * NOT merely a cell update of an already-matching row (that's `patch`'s job).
 *
 * It carries the new `total` but NOT the changed rows: frozen membership means
 * the live page does not reflow under the client. A `meta` frame is a "the set
 * changed, re-query if you care" nudge, not a live membership stream. `rev` is
 * the same world-rev stamped on the tick's patches; `collection` echoes the
 * subscription's collection. `id`, when present, echoes the originating
 * query's `id`, routing the frame to the correct subscription on a multi-sub
 * connection. Absent when the originating query had no `id` (legacy single-sub
 * client).
 *
 * Server-side coalescing (fn-697 lever 1): the server may THROTTLE meta
 * emission to one nudge per `META_MIN_INTERVAL_MS` per subscription, collapsing
 * a fold burst into fewer refetch rounds. A throttled-away move is never lost —
 * the latest membership state always converges on a subsequent tick (the
 * server's poll loop is the convergence backstop), and `total` always reflects
 * the set as of the emitted nudge. Patches (the cell stream) are never
 * throttled. Clients must already treat `meta` as a coalesced nudge (re-query
 * for current truth), so this is transparent: never assume one `meta` per
 * membership change.
 */
export interface MetaFrame {
  type: "meta";
  id?: string;
  collection: string;
  rev: number;
  total: number;
}

/** Condition kinds a Durable await worker can evaluate from server projections. */
export const DURABLE_AWAIT_CONDITION_KINDS = [
  "complete",
  "unblocked",
  "started",
  "git-clean",
  "agents-idle",
  "drained",
  "landed",
  "dead-letter",
  "block-escalation",
  "parked-question",
  "stuck-dispatch",
  "finalize-non-ff",
  "instant-death-wall",
  "needs-human",
] as const;

export type DurableAwaitConditionKind =
  (typeof DURABLE_AWAIT_CONDITION_KINDS)[number];

export type DurableAwaitStatus =
  | "waiting"
  | "firing"
  | "done"
  | "failed"
  | "timed_out"
  | "cancelled";

/** One persisted condition segment. Kind-specific fields stay JSON-shaped. */
export interface DurableAwaitCondition {
  condition: DurableAwaitConditionKind;
  [key: string]: unknown;
}

export type DurableAwaitConditionSpec = readonly DurableAwaitCondition[];

/** Wire payload for the eighth mutating RPC. */
export type RequestAwaitRpcParams =
  | {
      op: "request";
      await_id: string;
      condition_spec: DurableAwaitConditionSpec;
      doc_path: string;
      target_session: string;
      target_dir?: string | null;
      timeout_ms?: number | null;
    }
  | { op: "cancel"; await_id: string };

/**
 * Client → server: invoke a registered RPC handler. The server looks up
 * `method` in its RPC registry; a missing entry yields an `error` frame with
 * code `unknown_method`. `id` is REQUIRED (echoed on the matching
 * `rpc_result` / `error`); `params` is an opaque object the handler is
 * responsible for validating (a shape mismatch is conventionally a `bad_params`
 * error from the handler).
 *
 * RPC handlers may write the DB through the server-worker's dedicated writer
 * connection — the read-only subscribe surface (`query` / `unsubscribe`) is
 * unchanged.
 */
export interface RpcFrame {
  type: "rpc";
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Server → client: response to a successful `rpc`. `id` echoes the request
 * for correlation; `value` is the handler's return (shape per-handler, opaque
 * to the framing layer).
 */
export interface RpcResultFrame {
  type: "rpc_result";
  id: string;
  rev: number;
  value: unknown;
  /** Boot-status header (fn-897 B1); see {@link BootStatus} / {@link ResultFrame}. */
  boot?: BootStatus;
}

/**
 * Server → client: protocol or query error. `code` is a short stable tag:
 * - `"bad_frame"` — malformed/unparseable frame, or a `query` whose
 *   `collection` is absent / empty / non-string, or an `rpc` missing a
 *   non-empty string `id` / `method`.
 * - `"unknown_collection"` — a well-formed `query` naming a collection with no
 *   registered descriptor; carries `collection` and leaves any existing
 *   subscription intact.
 * - `"oversized_line"` — a line exceeded the NDJSON cap (connection closes).
 * - `"unknown_type"` — an unsupported frame `type`.
 * - `"unknown_method"` — a well-formed `rpc` naming a method with no
 *   registered handler. Carries the request `id`.
 * - `"bad_params"` — an `rpc` handler rejected its `params` shape. Carries the
 *   request `id`. (Emitted from inside a handler, not the dispatch shell.)
 * - `"rpc_failed"` — an `rpc` handler threw, an async-RPC bridge to main
 *   timed out, or main posted back `{ok: false, error}` on its replay path
 *   (e.g. the recovery transaction itself crashed). The thrown / posted-back
 *   message is carried in `message`; the connection stays open. Carries the
 *   request `id`.
 * - `"slug_conflict"` — a `request_handoff` named a slug already taken on this
 *   host (the host-global uniqueness probe rejected it). DISTINCT from
 *   `rpc_failed` so the CLI maps a duplicate to exit 3, not exit 1. Carries the
 *   request `id`; the connection stays open (retry with a new slug).
 * - `"server_booting"` — a MUTATING rpc was rejected because the daemon has not
 *   yet reached the post-drain spawn point (drain-reaches-head + git-seed +
 *   ephemeral-truncate). Reads are served throughout the boot; only state-changing
 *   RPCs are gated, so a consumer never acts on partial state. Carries the
 *   request `id`; the connection stays open (retry once `catching_up` clears).
 *
 * `id` is set when the error is attributable to a specific client frame;
 * `collection` is set when attributable to a named collection.
 */
export interface ErrorFrame {
  type: "error";
  id?: string;
  collection?: string;
  rev: number;
  code: string;
  message: string;
  /** Boot-status header (fn-897 B1); see {@link BootStatus} / {@link ResultFrame}. */
  boot?: BootStatus;
}

/** Discriminated union of frames a client may send. */
export type ClientFrame = QueryFrame | UnsubscribeFrame | RpcFrame;

/** Discriminated union of frames the server may send. */
export type ServerFrame =
  | ResultFrame
  | PatchFrame
  | MetaFrame
  | RpcResultFrame
  | ErrorFrame;

/** Any NDJSON frame (either direction). */
export type Frame = ClientFrame | ServerFrame;

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/**
 * Maximum length in characters (UTF-16 code units) of a single NDJSON line (a
 * line === a frame). A remainder that grows past this without a `\n` is a
 * protocol error — even on a local socket an unbounded line is a memory-pressure
 * vector. 1 Mi code units is the same cap used by the reference implementation
 * (theodo-group/debug-that).
 */
export const MAX_LINE_LENGTH = 1024 * 1024;

/**
 * Encode a frame as a single NDJSON line (trailing `\n` included). The output
 * is always one full line; the caller may concatenate multiple `encodeFrame`
 * results and write them in one go.
 */
export function encodeFrame(frame: Frame): string {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * Result of one `extractLines` call. `lines` are complete frames (no trailing
 * `\n`, no `\r`); `remaining` is the partial tail to carry into the next
 * chunk. Carry `remaining` back as `prevRemainder` on the next call.
 */
export interface ExtractResult {
  lines: string[];
  remaining: string;
}

/**
 * Error thrown when the accumulated remainder exceeds `MAX_LINE_LENGTH`
 * without producing a newline. The caller should treat this as a fatal
 * protocol error for the connection (close it, optionally send an `error`
 * frame first if the channel is still writable).
 */
export class OversizedLineError extends Error {
  constructor(public readonly size: number) {
    super(
      `NDJSON line exceeded ${MAX_LINE_LENGTH} characters (got ${size}); closing connection`,
    );
    this.name = "OversizedLineError";
  }
}

/**
 * Split a new chunk into complete NDJSON lines, carrying the partial tail.
 * Strips a trailing `\r` from each line (handles CRLF clients on the off
 * chance one shows up). Throws `OversizedLineError` if the accumulated
 * remainder exceeds `MAX_LINE_LENGTH` without a newline.
 *
 * Usage:
 *   let buf = "";
 *   socket.on("data", (chunk) => {
 *     const { lines, remaining } = extractLines(chunk, buf);
 *     buf = remaining;
 *     for (const line of lines) handle(line);
 *   });
 */
export function extractLines(
  chunk: string,
  prevRemainder: string,
): ExtractResult {
  const combined = prevRemainder + chunk;

  // Fast path: no newline in this chunk. Enforce the cap on the carry.
  const firstNl = combined.indexOf("\n");
  if (firstNl === -1) {
    if (combined.length > MAX_LINE_LENGTH) {
      throw new OversizedLineError(combined.length);
    }
    return { lines: [], remaining: combined };
  }

  const lines: string[] = [];
  let start = 0;
  let idx = firstNl;
  while (idx !== -1) {
    let line = combined.slice(start, idx);
    // Strip trailing \r so CRLF clients parse cleanly.
    if (line.length > 0 && line.charCodeAt(line.length - 1) === 0x0d) {
      line = line.slice(0, -1);
    }
    if (line.length > MAX_LINE_LENGTH) {
      throw new OversizedLineError(line.length);
    }
    lines.push(line);
    start = idx + 1;
    idx = combined.indexOf("\n", start);
  }

  const remaining = combined.slice(start);
  if (remaining.length > MAX_LINE_LENGTH) {
    throw new OversizedLineError(remaining.length);
  }
  return { lines, remaining };
}

/**
 * Stateful wrapper around `extractLines` for connection-scoped use. Holds the
 * partial tail across `push` calls; one instance per socket. Throws
 * `OversizedLineError` on cap breach (caller closes the connection).
 */
export class LineBuffer {
  private remainder = "";

  /** Feed a chunk; returns any complete lines extracted from it. */
  push(chunk: string): string[] {
    const { lines, remaining } = extractLines(chunk, this.remainder);
    this.remainder = remaining;
    return lines;
  }

  /** Current pending tail length in characters (UTF-16 code units), matching the cap check. */
  pendingLength(): number {
    return this.remainder.length;
  }
}
