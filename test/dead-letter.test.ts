/**
 * Unit tests for `src/dead-letter.ts` — the shared NDJSON record schema
 * module (fn-643). Covers the serialize→parse round-trip and the
 * crash-safety contract: `parseDeadLetterLine` MUST return null on a
 * truncated / garbage / partial line so the daemon's import path can skip
 * it without losing subsequent valid records.
 */

import { expect, test } from "bun:test";
import type { DeadLetterRecord } from "../src/dead-letter";
import {
  parseDeadLetterLine,
  serializeDeadLetterRecord,
} from "../src/dead-letter";

const BASE: DeadLetterRecord = {
  dl_id: "550e8400-e29b-41d4-a716-446655440000",
  session_id: "be979fc3-0000-0000-0000-000000000001",
  hook_event: "SessionStart",
  ts: 1_700_000_000.5,
  dl_written_at: 1_700_000_001.0,
  pid: 12345,
  bindings: {
    session_id: "be979fc3-0000-0000-0000-000000000001",
    hook_event: "SessionStart",
    ts: 1_700_000_000.5,
    stop_hook_active: false,
    spawn_name: "work:worker",
    config_dir: null,
  },
};

test("serializeDeadLetterRecord produces a single NDJSON line ending with \\n", () => {
  const line = serializeDeadLetterRecord(BASE);
  expect(line.endsWith("\n")).toBe(true);
  expect(line.split("\n").length).toBe(2); // content + trailing empty
  // The line is valid JSON when the trailing newline is stripped.
  expect(() => JSON.parse(line.trimEnd())).not.toThrow();
});

test("round-trip: parseDeadLetterLine(serializeDeadLetterRecord(r)) === r", () => {
  const line = serializeDeadLetterRecord(BASE);
  const parsed = parseDeadLetterLine(line);
  expect(parsed).not.toBeNull();
  expect(parsed!.dl_id).toBe(BASE.dl_id);
  expect(parsed!.session_id).toBe(BASE.session_id);
  expect(parsed!.hook_event).toBe(BASE.hook_event);
  expect(parsed!.ts).toBe(BASE.ts);
  expect(parsed!.dl_written_at).toBe(BASE.dl_written_at);
  expect(parsed!.pid).toBe(BASE.pid);
  expect(parsed!.bindings).toEqual(BASE.bindings);
});

test("round-trip: pid null is preserved", () => {
  const rec = { ...BASE, pid: null };
  const parsed = parseDeadLetterLine(serializeDeadLetterRecord(rec));
  expect(parsed).not.toBeNull();
  expect(parsed!.pid).toBeNull();
});

test("round-trip: bindings with all scalar types round-trips cleanly", () => {
  const rec: DeadLetterRecord = {
    ...BASE,
    bindings: {
      str_col: "hello",
      int_col: 42,
      real_col: 3.14,
      bool_col: true,
      null_col: null,
    },
  };
  const parsed = parseDeadLetterLine(serializeDeadLetterRecord(rec));
  expect(parsed).not.toBeNull();
  expect(parsed!.bindings).toEqual(rec.bindings);
});

test("parseDeadLetterLine: empty string returns null", () => {
  expect(parseDeadLetterLine("")).toBeNull();
});

test("parseDeadLetterLine: whitespace-only line returns null", () => {
  expect(parseDeadLetterLine("   \n")).toBeNull();
});

test("parseDeadLetterLine: garbage / non-JSON returns null", () => {
  expect(parseDeadLetterLine("not json at all")).toBeNull();
  expect(parseDeadLetterLine("{bad json")).toBeNull();
});

test("parseDeadLetterLine: truncated JSON (partial write) returns null", () => {
  const full = serializeDeadLetterRecord(BASE);
  const truncated = full.slice(0, Math.floor(full.length / 2));
  expect(parseDeadLetterLine(truncated)).toBeNull();
});

test("parseDeadLetterLine: missing required field dl_id returns null", () => {
  const obj = { ...BASE, bindings: BASE.bindings } as Record<string, unknown>;
  delete obj.dl_id;
  expect(parseDeadLetterLine(JSON.stringify(obj))).toBeNull();
});

test("parseDeadLetterLine: missing required field session_id returns null", () => {
  const obj = { ...BASE, bindings: BASE.bindings } as Record<string, unknown>;
  delete obj.session_id;
  expect(parseDeadLetterLine(JSON.stringify(obj))).toBeNull();
});

test("parseDeadLetterLine: missing required field hook_event returns null", () => {
  const obj = { ...BASE, bindings: BASE.bindings } as Record<string, unknown>;
  delete obj.hook_event;
  expect(parseDeadLetterLine(JSON.stringify(obj))).toBeNull();
});

test("parseDeadLetterLine: missing required field ts returns null", () => {
  const obj = { ...BASE, bindings: BASE.bindings } as Record<string, unknown>;
  delete obj.ts;
  expect(parseDeadLetterLine(JSON.stringify(obj))).toBeNull();
});

test("parseDeadLetterLine: missing required field dl_written_at returns null", () => {
  const obj = { ...BASE, bindings: BASE.bindings } as Record<string, unknown>;
  delete obj.dl_written_at;
  expect(parseDeadLetterLine(JSON.stringify(obj))).toBeNull();
});

test("parseDeadLetterLine: bindings with nested object returns null", () => {
  const obj = {
    ...BASE,
    bindings: { nested: { deep: "value" } },
  };
  expect(parseDeadLetterLine(JSON.stringify(obj))).toBeNull();
});

test("parseDeadLetterLine: bindings with array value returns null", () => {
  const obj = { ...BASE, bindings: { arr: [1, 2, 3] } };
  expect(parseDeadLetterLine(JSON.stringify(obj))).toBeNull();
});

test("parseDeadLetterLine: bindings null returns null", () => {
  const obj = { ...BASE, bindings: null };
  expect(parseDeadLetterLine(JSON.stringify(obj))).toBeNull();
});

test("parseDeadLetterLine: top-level array returns null", () => {
  expect(parseDeadLetterLine(JSON.stringify([BASE]))).toBeNull();
});

test("parseDeadLetterLine: tolerates trailing newline (caller may or may not strip it)", () => {
  const withNewline = JSON.stringify(BASE) + "\n";
  const parsed = parseDeadLetterLine(withNewline);
  expect(parsed).not.toBeNull();
  expect(parsed!.dl_id).toBe(BASE.dl_id);
});
