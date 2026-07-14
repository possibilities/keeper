import { closeSync, openSync, readSync } from "node:fs";
import {
  parseTimestamp,
  recordOf,
  stringOrNull,
  TRANSCRIPT_LINE_BYTE_CAP,
  withinTranscriptLineByteCap,
} from "./parse-common";

const JSONL_SCAN_CHUNK_BYTES = 64 * 1024;
const JSONL_METADATA_SPINE_BYTES = 16 * 1024;

export interface JsonlMetadataSpine {
  project: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  title: string | null;
  titleHistory: string[];
}

export interface JsonlMetadataSpineTitleReader {
  marker: string;
  read(record: Record<string, unknown>): string | null;
}

function readSlice(fd: number, start: number, length: number): string {
  const buffer = Buffer.alloc(length);
  const bytes = readSync(fd, buffer, 0, length, start);
  return buffer.subarray(0, bytes).toString("utf8");
}

function metadataRecord(
  line: string,
  titleReader?: JsonlMetadataSpineTitleReader,
): {
  project: string | null;
  timestamp: string | null;
  title: string | null;
} | null {
  if (
    !line.includes('"cwd"') &&
    !line.includes('"timestamp"') &&
    (titleReader === undefined || !line.includes(titleReader.marker))
  ) {
    return null;
  }
  try {
    const record = recordOf(JSON.parse(line));
    if (record === null) return null;
    return {
      project: stringOrNull(record.cwd),
      timestamp: parseTimestamp(record.timestamp)?.text ?? null,
      title: titleReader?.read(record) ?? null,
    };
  } catch {
    return null;
  }
}

/** Read a small head/tail metadata spine without normalizing transcript bodies.
 * Full historical titles are scanned separately when a resolver requires them;
 * this helper supplies project, ordering timestamps, and sampled titles. */
export function readJsonlMetadataSpineSync(
  path: string,
  size: number,
  titleReader?: JsonlMetadataSpineTitleReader,
): JsonlMetadataSpine {
  const fd = openSync(path, "r");
  try {
    const head = readSlice(fd, 0, Math.min(size, JSONL_METADATA_SPINE_BYTES));
    const tailStart = Math.max(0, size - JSONL_METADATA_SPINE_BYTES);
    let tail = readSlice(fd, tailStart, Math.min(size, JSONL_METADATA_SPINE_BYTES));
    if (tailStart > 0) {
      const firstNewline = tail.indexOf("\n");
      tail = firstNewline < 0 ? "" : tail.slice(firstNewline + 1);
    }

    let project: string | null = null;
    let startedAt: string | null = null;
    const sampledTitles: string[] = [];
    for (const line of head.split("\n")) {
      const metadata = metadataRecord(line, titleReader);
      if (metadata === null) continue;
      project ??= metadata.project;
      startedAt ??= metadata.timestamp;
      if (metadata.title !== null) sampledTitles.push(metadata.title);
    }

    let updatedAt: string | null = null;
    for (const line of tail.split("\n")) {
      const metadata = metadataRecord(line, titleReader);
      if (metadata === null) continue;
      if (metadata.timestamp !== null) updatedAt = metadata.timestamp;
      if (metadata.title !== null) sampledTitles.push(metadata.title);
    }
    const titleHistory = sampledTitles.filter(
      (title, index) => index === 0 || title !== sampledTitles[index - 1],
    );
    return {
      project,
      startedAt,
      updatedAt,
      title: titleHistory.at(-1) ?? null,
      titleHistory,
    };
  } finally {
    closeSync(fd);
  }
}

/** Visit valid object records in a JSONL file with memory bounded by one capped
 * transcript line. Malformed, oversized, and torn-tail records are skipped.
 * When `lineMarker` is supplied, lines lacking those UTF-8 bytes are discarded
 * before string decoding or JSON parsing; callers must still validate `type`. */
export function scanTranscriptJsonlSync(
  path: string,
  visit: (record: Record<string, unknown>) => void,
  lineMarker?: string,
): void {
  const fd = openSync(path, "r");
  const chunk = Buffer.allocUnsafe(JSONL_SCAN_CHUNK_BYTES);
  const marker = lineMarker === undefined ? null : Buffer.from(lineMarker);
  let pending = Buffer.alloc(0);
  let droppingOversizedLine = false;
  const feed = (lineBuffer: Buffer): void => {
    const end =
      lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === 13
        ? lineBuffer.length - 1
        : lineBuffer.length;
    const bytes = lineBuffer.subarray(0, end);
    if (marker !== null && bytes.indexOf(marker) < 0) return;
    const line = bytes.toString("utf8");
    if (line.trim().length === 0 || !withinTranscriptLineByteCap(line)) return;
    try {
      const record = recordOf(JSON.parse(line));
      if (record !== null) visit(record);
    } catch {
      // One malformed/torn record never poisons the containing artifact.
    }
  };
  try {
    for (;;) {
      const bytes = readSync(fd, chunk, 0, chunk.length, null);
      if (bytes === 0) break;
      const current = chunk.subarray(0, bytes);
      let cursor = 0;
      while (cursor < current.length) {
        if (droppingOversizedLine) {
          const newline = current.indexOf(10, cursor);
          if (newline < 0) break;
          droppingOversizedLine = false;
          cursor = newline + 1;
          continue;
        }
        const newline = current.indexOf(10, cursor);
        if (newline < 0) {
          const remainder = current.subarray(cursor);
          if (pending.length + remainder.length > TRANSCRIPT_LINE_BYTE_CAP) {
            pending = Buffer.alloc(0);
            droppingOversizedLine = true;
          } else {
            pending =
              pending.length === 0
                ? Buffer.from(remainder)
                : Buffer.concat([pending, remainder]);
          }
          break;
        }
        const segment = current.subarray(cursor, newline);
        const line =
          pending.length === 0 ? segment : Buffer.concat([pending, segment]);
        pending = Buffer.alloc(0);
        if (line.length <= TRANSCRIPT_LINE_BYTE_CAP) feed(line);
        cursor = newline + 1;
      }
    }
    if (!droppingOversizedLine && pending.length > 0) feed(pending);
  } finally {
    closeSync(fd);
  }
}
