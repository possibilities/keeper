import { closeSync, openSync, readSync } from "node:fs";
import {
  recordOf,
  TRANSCRIPT_LINE_BYTE_CAP,
  withinTranscriptLineByteCap,
} from "./parse-common";

const JSONL_SCAN_CHUNK_BYTES = 64 * 1024;

/** Visit valid object records in a JSONL file with memory bounded by one capped
 * transcript line. Malformed, oversized, and torn-tail records are skipped. */
export function scanTranscriptJsonlSync(
  path: string,
  visit: (record: Record<string, unknown>) => void,
): void {
  const fd = openSync(path, "r");
  const chunk = Buffer.allocUnsafe(JSONL_SCAN_CHUNK_BYTES);
  let pending = Buffer.alloc(0);
  let droppingOversizedLine = false;
  const feed = (lineBuffer: Buffer): void => {
    const end =
      lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === 13
        ? lineBuffer.length - 1
        : lineBuffer.length;
    const line = lineBuffer.subarray(0, end).toString("utf8");
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
