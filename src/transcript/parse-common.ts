/**
 * Harness-neutral parse primitives shared by every `TranscriptReader`. Each
 * on-disk format (claude JSONL, pi session JSON, codex rollout JSONL) has its
 * own line shapes, so only the format-independent plumbing lives here: the
 * append-and-number entry sink, small JSON-shape guards, timestamp bookkeeping
 * that feeds `metadata.startedAt`/`updatedAt`, the tool-name call/result
 * back-fill, and the per-line byte cap every reader applies before
 * `JSON.parse` (a transcript line is attacker/adversary-influenced content —
 * bounding it keeps one oversized line from blowing up parse cost).
 */

import type {
  TranscriptEntry,
  TranscriptMetadata,
  TranscriptSource,
} from "./model";

/** Per-line byte cap applied before `JSON.parse`; an oversized line folds to
 *  a malformed-line skip rather than being parsed. Mirrors the 1 MiB NDJSON
 *  line cap `src/protocol.ts` enforces on the socket wire. */
export const TRANSCRIPT_LINE_BYTE_CAP = 1_048_576;

export function withinTranscriptLineByteCap(line: string): boolean {
  return Buffer.byteLength(line, "utf8") <= TRANSCRIPT_LINE_BYTE_CAP;
}

export interface ParsedTimestamp {
  text: string;
  ms: number;
}

/** Mutable accumulator one reader's line-by-line parse threads through. */
export interface ParseState {
  source: TranscriptSource;
  entries: TranscriptEntry[];
  toolNames: Map<string, string>;
  metadata: TranscriptMetadata;
  minTimestamp: ParsedTimestamp | null;
  maxTimestamp: ParsedTimestamp | null;
}

/** Append one entry, stamping the source-local ordinal every reader relies on. */
export function pushEntry(
  state: ParseState,
  entry: Omit<TranscriptEntry, "sourceOrdinal" | "ordinal" | "source">,
): void {
  const sourceOrdinal = state.entries.length;
  state.entries.push({
    ...entry,
    source: state.source,
    sourceOrdinal,
    ordinal: sourceOrdinal,
  });
}

export function recordOf(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

export function stringOrNull(raw: unknown): string | null {
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export function parseTimestamp(raw: unknown): ParsedTimestamp | null {
  if (typeof raw !== "string") {
    return null;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? { text: raw, ms } : null;
}

/** Flatten a message-content shape (string, block array, or arbitrary JSON)
 *  into display text, preferring a block's own `text`/`content` field. */
export function contentText(raw: unknown): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (!Array.isArray(raw)) {
    return raw === null || raw === undefined ? "" : JSON.stringify(raw);
  }
  const parts: string[] = [];
  for (const block of raw) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    const obj = recordOf(block);
    if (obj === null) {
      continue;
    }
    if (typeof obj.text === "string") {
      parts.push(obj.text);
    } else if (typeof obj.content === "string") {
      parts.push(obj.content);
    } else {
      parts.push(JSON.stringify(obj));
    }
  }
  return parts.join("\n");
}

/** Widen `metadata.startedAt`/`updatedAt`'s min/max as timestamped lines arrive. */
export function trackTimestamp(
  state: ParseState,
  timestamp: ParsedTimestamp | null,
): void {
  if (timestamp === null) {
    return;
  }
  if (state.minTimestamp === null || timestamp.ms < state.minTimestamp.ms) {
    state.minTimestamp = timestamp;
  }
  if (state.maxTimestamp === null || timestamp.ms > state.maxTimestamp.ms) {
    state.maxTimestamp = timestamp;
  }
}

/** Commit the tracked min/max onto `metadata`, once parsing is complete. */
export function finalizeTimestamps(state: ParseState): void {
  state.metadata.startedAt = state.minTimestamp?.text ?? null;
  state.metadata.updatedAt = state.maxTimestamp?.text ?? null;
}

export function markMalformedLine(state: ParseState): void {
  state.metadata.malformedLines++;
}

/**
 * A tool result can precede its call, or the call can live in an earlier
 * (already-flushed) part of the stream. Resolve every result's tool name
 * from `toolNames` once the whole document is parsed, so ordering within the
 * file never starves a result of its call's name.
 */
export function backfillToolNames(state: ParseState): void {
  for (const entry of state.entries) {
    if (
      entry.kind === "tool_result" &&
      entry.tool?.name === null &&
      entry.tool.useId !== null
    ) {
      entry.tool.name = state.toolNames.get(entry.tool.useId) ?? null;
    }
  }
}
