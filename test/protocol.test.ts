/**
 * Protocol framing tests. The wire contract has zero I/O dependencies, so
 * everything here is a pure round-trip: encode → split → decode → assert.
 * Covers partial-chunk reassembly, multi-frame chunks, CRLF stripping, and
 * the oversized-line cap.
 */

import { describe, expect, test } from "bun:test";
import {
  type ClientFrame,
  encodeFrame,
  extractLines,
  LineBuffer,
  MAX_LINE_LENGTH,
  OversizedLineError,
  type PatchFrame,
  type ResultFrame,
  type Row,
} from "../src/protocol";

// A `jobs` row as a generic served `Row`. The protocol layer is row-shape
// agnostic (generic over `Row`); these round-trips only assert JSON equality,
// so a plain Row literal is all the wire contract needs.
const sampleJob: Row = {
  job_id: "job-1",
  created_at: 1_700_000_000,
  cwd: "/tmp/x",
  pid: 1234,
  mode: "act",
  state: "working",
  last_event_id: 42,
  updated_at: 1_700_000_001,
};

describe("encodeFrame", () => {
  test("appends a trailing newline", () => {
    const out = encodeFrame({ type: "query", collection: "jobs" });
    expect(out.endsWith("\n")).toBe(true);
  });

  test("round-trips a query frame (carries collection + filter)", () => {
    const frame: ClientFrame = {
      type: "query",
      collection: "jobs",
      id: "q1",
      sort: { column: "updated_at", dir: "desc" },
      limit: 50,
      offset: 0,
      filter: { state: "working" },
    };
    const line = encodeFrame(frame).slice(0, -1);
    expect(JSON.parse(line)).toEqual(frame);
  });

  test("round-trips a result frame with collection + rev + rows", () => {
    const frame: ResultFrame = {
      type: "result",
      id: "q1",
      collection: "jobs",
      rev: 99,
      rows: [sampleJob],
    };
    const line = encodeFrame(frame).slice(0, -1);
    expect(JSON.parse(line)).toEqual(frame);
  });

  test("round-trips a patch frame with collection + rev + row", () => {
    const frame: PatchFrame = {
      type: "patch",
      collection: "jobs",
      rev: 101,
      row: { ...sampleJob, last_event_id: 50 },
    };
    const line = encodeFrame(frame).slice(0, -1);
    expect(JSON.parse(line)).toEqual(frame);
  });
});

describe("extractLines", () => {
  test("returns [] and the chunk as remainder when no newline", () => {
    const r = extractLines("partial", "");
    expect(r.lines).toEqual([]);
    expect(r.remaining).toBe("partial");
  });

  test("splits a single complete line", () => {
    const r = extractLines("hello\n", "");
    expect(r.lines).toEqual(["hello"]);
    expect(r.remaining).toBe("");
  });

  test("reassembles a frame split across two chunks", () => {
    const a = extractLines('{"type":"que', "");
    expect(a.lines).toEqual([]);
    expect(a.remaining).toBe('{"type":"que');

    const b = extractLines('ry"}\n', a.remaining);
    expect(b.lines).toEqual(['{"type":"query"}']);
    expect(b.remaining).toBe("");

    const parsed = JSON.parse(b.lines[0]);
    expect(parsed).toEqual({ type: "query" });
  });

  test("splits two frames in one chunk", () => {
    const chunk = `${encodeFrame({
      type: "query",
      collection: "jobs",
      id: "a",
    })}${encodeFrame({
      type: "query",
      collection: "jobs",
      id: "b",
    })}`;
    const r = extractLines(chunk, "");
    expect(r.lines).toHaveLength(2);
    expect(r.remaining).toBe("");
    expect(JSON.parse(r.lines[0])).toMatchObject({ type: "query", id: "a" });
    expect(JSON.parse(r.lines[1])).toMatchObject({ type: "query", id: "b" });
  });

  test("two frames + partial third in one chunk", () => {
    const chunk = `${encodeFrame({
      type: "query",
      collection: "jobs",
      id: "a",
    })}${encodeFrame({
      type: "query",
      collection: "jobs",
      id: "b",
    })}{"type":"que`;
    const r = extractLines(chunk, "");
    expect(r.lines).toHaveLength(2);
    expect(r.remaining).toBe('{"type":"que');
  });

  test("strips trailing \\r (CRLF)", () => {
    const r = extractLines("hello\r\nworld\r\n", "");
    expect(r.lines).toEqual(["hello", "world"]);
    expect(r.remaining).toBe("");
  });

  test("preserves a bare \\r inside the line", () => {
    // Only a trailing \r is treated as CRLF; embedded \r stays.
    const r = extractLines("a\rb\n", "");
    expect(r.lines).toEqual(["a\rb"]);
  });

  test("throws OversizedLineError when remainder exceeds cap with no newline", () => {
    const huge = "x".repeat(MAX_LINE_LENGTH + 1);
    expect(() => extractLines(huge, "")).toThrow(OversizedLineError);
  });

  test("throws OversizedLineError when a completed line exceeds cap", () => {
    const huge = `${"x".repeat(MAX_LINE_LENGTH + 1)}\n`;
    expect(() => extractLines(huge, "")).toThrow(OversizedLineError);
  });

  test("accumulated remainder across chunks triggers the cap", () => {
    const half = "x".repeat(MAX_LINE_LENGTH / 2 + 1);
    const first = extractLines(half, "");
    expect(first.lines).toEqual([]);
    expect(() => extractLines(half, first.remaining)).toThrow(
      OversizedLineError,
    );
  });

  test("empty lines are preserved (blank frames are caller's problem)", () => {
    const r = extractLines("\n\n", "");
    expect(r.lines).toEqual(["", ""]);
    expect(r.remaining).toBe("");
  });
});

describe("LineBuffer", () => {
  test("threads remainder across push calls", () => {
    const buf = new LineBuffer();
    expect(buf.push('{"type":"que')).toEqual([]);
    expect(buf.pendingLength()).toBeGreaterThan(0);

    const lines = buf.push('ry","id":"x"}\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ type: "query", id: "x" });
    expect(buf.pendingLength()).toBe(0);
  });

  test("yields all complete frames in one push", () => {
    const buf = new LineBuffer();
    const chunk = `${encodeFrame({
      type: "query",
      collection: "jobs",
      id: "a",
    })}${encodeFrame({
      type: "query",
      collection: "jobs",
      id: "b",
    })}`;
    const lines = buf.push(chunk);
    expect(lines).toHaveLength(2);
  });

  test("propagates OversizedLineError", () => {
    const buf = new LineBuffer();
    const huge = "x".repeat(MAX_LINE_LENGTH + 1);
    expect(() => buf.push(huge)).toThrow(OversizedLineError);
  });
});
