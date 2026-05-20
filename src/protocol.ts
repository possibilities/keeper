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
 *
 * Server → client:
 * - `result` — the snapshot page (rows in order) plus the world-rev at query
 *              time. `rev = reducer_state.last_event_id`. This frame doubles
 *              as the initial subscription state; subsequent patches arrive
 *              with monotonically non-decreasing `rev` values.
 * - `patch`  — a single row in the page has advanced (its `last_event_id`
 *              moved forward). The full updated `Job` row is included so the
 *              client never needs to re-query to render the change.
 * - `error`  — protocol or query error. `code` is a short tag; `message` is
 *              human-readable.
 *
 * INVARIANT: `rev` is present on EVERY server frame (result, patch, error
 * with a known world-rev). Downstream consumers depend on a single monotonic
 * cursor for ordering.
 */

import type { Job } from "./types";

// ---------------------------------------------------------------------------
// Frame types
// ---------------------------------------------------------------------------

/**
 * Sort spec for a `query` frame. `column` names a sortable `jobs` column;
 * `dir` defaults to `"asc"` server-side when omitted.
 */
export interface QuerySort {
  column: string;
  dir?: "asc" | "desc";
}

/**
 * Filter spec for a `query` frame. Field shape is intentionally open-ended in
 * v1: the server applies what it understands and ignores unknown keys (so
 * older clients keep working as the filter vocabulary grows). Concrete v1
 * filters: `state`, `mode`, `cwd` (exact match).
 */
export interface QueryFilter {
  state?: string;
  mode?: string;
  cwd?: string;
}

/**
 * Client → server: request an ordered page (and start a subscription).
 *
 * `id` is opaque to the server — when present, it's echoed on the matching
 * `result` / `error` frame for correlation. `unsubscribe` can target a
 * specific id to drop just that subscription if a client multiplexes.
 */
export interface QueryFrame {
  type: "query";
  id?: string;
  sort?: QuerySort;
  limit?: number;
  offset?: number;
  filter?: QueryFilter;
}

/** Client → server: stop emitting patches for `id` (or all, if omitted). */
export interface UnsubscribeFrame {
  type: "unsubscribe";
  id?: string;
}

/**
 * Server → client: the snapshot page for a `query`. `rev` is the
 * `reducer_state.last_event_id` at the moment the page was read; subsequent
 * `patch` frames carry monotonically non-decreasing `rev`.
 */
export interface ResultFrame {
  type: "result";
  id?: string;
  rev: number;
  rows: Job[];
}

/**
 * Server → client: one row in the active page has advanced. `job` is the
 * full updated row (not a delta) so the client renders without re-querying.
 */
export interface PatchFrame {
  type: "patch";
  rev: number;
  job: Job;
}

/**
 * Server → client: protocol or query error. `code` is a short stable tag
 * (e.g. `"bad_frame"`, `"oversized_line"`, `"bad_query"`). `id` is set when
 * the error is attributable to a specific client frame.
 */
export interface ErrorFrame {
  type: "error";
  id?: string;
  rev: number;
  code: string;
  message: string;
}

/** Discriminated union of frames a client may send. */
export type ClientFrame = QueryFrame | UnsubscribeFrame;

/** Discriminated union of frames the server may send. */
export type ServerFrame = ResultFrame | PatchFrame | ErrorFrame;

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
