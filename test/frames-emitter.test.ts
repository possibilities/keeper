/**
 * Pure-tier coverage for `src/frames-emitter.ts` (fn-1161) — the `keeper
 * frames` NDJSON wire contract (docs/adr/0012). Everything impure is injected:
 * a fake `diffFn`, in-memory IO sinks, and a fake clock. No subprocess, no
 * real filesystem, no daemon.
 *
 * Proven here: baseline-vs-frame typing, contiguous seq across every record
 * type, the truncation marker with byte/line counts, a trailer on every
 * termination cause with an honest coverage verdict, max-frames counting data
 * frames only, the sidecar ring pruning ONLY its own files, and single-line
 * framing safety against frame/diff text carrying newlines, quotes, and ANSI
 * escapes.
 */

import { expect, test } from "bun:test";
import {
  boundDiff,
  countLines,
  countUtf8Bytes,
  createFramesEmitter,
  DEFAULT_MAX_DIFF_BYTES,
  FRAMES_SCHEMA_VERSION,
  type FrameInput,
  type FramesEmitterDeps,
  type FramesIo,
  type TrailerReason,
} from "../src/frames-emitter";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  emitter: ReturnType<typeof createFramesEmitter>;
  /** Every raw string handed to `writeStdout`, verbatim (one per record). */
  rawWrites: string[];
  /** Parsed records in emission order. */
  records: () => Record<string, unknown>[];
  /** path → contents for every `writeFile` call. */
  written: Map<string, string>;
  /** Paths passed to `unlink`, in order. */
  unlinked: string[];
  /** Advance the injected millisecond clock (drives the duration bound). */
  advance: (ms: number) => void;
}

function makeHarness(overrides: Partial<FramesEmitterDeps> = {}): Harness {
  const rawWrites: string[] = [];
  const written = new Map<string, string>();
  const unlinked: string[] = [];
  let nowMs = 0;
  let tick = 0;

  const io: FramesIo = {
    writeFile: (path, contents) => {
      written.set(path, contents);
    },
    unlink: (path) => {
      unlinked.push(path);
    },
    // Deterministic, strictly-increasing ISO stamps so a test can assert order.
    nowIso: () => `2026-07-07T00:00:${String(tick++).padStart(2, "0")}.000Z`,
    nowMs: () => nowMs,
  };

  const emitter = createFramesEmitter({
    view: "board",
    writeStdout: (line) => rawWrites.push(line),
    // Default fake diff: a short, deterministic single-line diff.
    diffFn: (prev, next) => `@@ ${prev.length} -> ${next.length} @@\n`,
    io,
    pid: 4242,
    sidecarDir: "/tmp/frames-test",
    ...overrides,
  });

  return {
    emitter,
    rawWrites,
    records: () =>
      rawWrites.map((w) => JSON.parse(w) as Record<string, unknown>),
    written,
    unlinked,
    advance: (ms) => {
      nowMs += ms;
    },
  };
}

const frameInput = (over: Partial<FrameInput> = {}): FrameInput => ({
  cursor: "rev-1",
  frameText: "line a\nline b",
  stateJson: { ok: true },
  ...over,
});

// ---------------------------------------------------------------------------
// Pure helpers — asserted against hand-computed constants (independent truth)
// ---------------------------------------------------------------------------

test("countUtf8Bytes: multibyte characters counted by UTF-8 byte length", () => {
  expect(countUtf8Bytes("abc")).toBe(3);
  // h=1, é=2 (U+00E9), l=1, l=1, o=1 → 6 bytes.
  expect(countUtf8Bytes("héllo")).toBe(6);
  // "€" is U+20AC → 3 UTF-8 bytes.
  expect(countUtf8Bytes("€")).toBe(3);
  expect(countUtf8Bytes("")).toBe(0);
});

test("countLines: a trailing newline is not an extra empty line", () => {
  expect(countLines("")).toBe(0);
  expect(countLines("a")).toBe(1);
  expect(countLines("a\nb")).toBe(2);
  expect(countLines("a\nb\n")).toBe(2);
  // Three unified-diff lines with a trailing newline → 3, not 4.
  expect(countLines("--- a\n+++ b\n@@\n")).toBe(3);
});

test("boundDiff: under both budgets passes the raw diff through untruncated", () => {
  const raw = "@@ -1 +1 @@\n-old\n+new\n";
  const out = boundDiff(raw, { maxBytes: 1000, maxLines: 100 });
  expect(out.truncated).toBe(false);
  expect(out.diff).toBe(raw);
  expect(out.bytes).toBe(countUtf8Bytes(raw));
  expect(out.lines).toBe(3);
});

test("boundDiff: over the byte budget yields a marker naming raw byte/line counts", () => {
  const raw = "X".repeat(10_000); // 10000 bytes, 1 line (no newline)
  const out = boundDiff(raw, { maxBytes: 100, maxLines: 100 });
  expect(out.truncated).toBe(true);
  expect(out.bytes).toBe(10_000);
  expect(out.lines).toBe(1);
  expect(out.diff).toContain("10000 bytes");
  expect(out.diff).toContain("1 lines");
  // The marker, never the payload, is inlined.
  expect(out.diff.length).toBeLessThan(raw.length);
});

test("boundDiff: over the line budget truncates even when bytes are small", () => {
  const raw = "a\n".repeat(500); // 1000 bytes, 500 lines
  const out = boundDiff(raw, { maxBytes: 1_000_000, maxLines: 100 });
  expect(out.truncated).toBe(true);
  expect(out.bytes).toBe(1_000);
  expect(out.lines).toBe(500);
  expect(out.diff).toContain("1000 bytes");
  expect(out.diff).toContain("500 lines");
});

// ---------------------------------------------------------------------------
// Baseline vs frame typing
// ---------------------------------------------------------------------------

test("baseline carries type 'baseline', null diff, and valid state/frame pointers", () => {
  const h = makeHarness();
  h.emitter.emitBaseline(frameInput());
  const [rec] = h.records();
  expect(rec.type).toBe("baseline");
  expect(rec.schema_version).toBe(FRAMES_SCHEMA_VERSION);
  expect(rec.view).toBe("board");
  expect(rec.cursor).toBe("rev-1");
  expect(rec.diff).toBeNull();
  expect(rec.diff_truncated).toBe(false);
  expect(rec.diff_path).toBeNull();
  // Pointers are non-null, carry the pid, and were actually written.
  expect(rec.frame_path).toBe(
    "/tmp/frames-test/keeper-frames-board.4242.frame.0.txt",
  );
  expect(rec.state_path).toBe(
    "/tmp/frames-test/keeper-frames-board.4242.state.0.json",
  );
  expect(h.written.has(rec.frame_path as string)).toBe(true);
  expect(h.written.has(rec.state_path as string)).toBe(true);
});

test("a data frame carries type 'frame', an inline diff, and a valid diff pointer", () => {
  const h = makeHarness();
  h.emitter.emitBaseline(frameInput({ frameText: "old" }));
  h.emitter.emitFrame(frameInput({ frameText: "new", cursor: "rev-2" }));
  const [, frame] = h.records();
  expect(frame.type).toBe("frame");
  expect(frame.cursor).toBe("rev-2");
  expect(frame.diff_truncated).toBe(false);
  // The fake diff saw the prior frame text ("old", length 3) vs the new ("new").
  expect(frame.diff).toBe("@@ 3 -> 3 @@\n");
  expect(frame.diff_path).toBe(
    "/tmp/frames-test/keeper-frames-board.4242.diff.1.txt",
  );
  // The FULL raw diff landed at diff_path.
  expect(h.written.get(frame.diff_path as string)).toBe("@@ 3 -> 3 @@\n");
});

test("a truncated frame diff sets diff_truncated and still writes the full diff to diff_path", () => {
  const bigDiff = "Z".repeat(DEFAULT_MAX_DIFF_BYTES + 1);
  const h = makeHarness({ diffFn: () => bigDiff });
  h.emitter.emitBaseline(frameInput());
  h.emitter.emitFrame(frameInput({ frameText: "changed" }));
  const frame = h.records()[1];
  expect(frame.diff_truncated).toBe(true);
  expect(frame.diff).toContain(`${DEFAULT_MAX_DIFF_BYTES + 1} bytes`);
  expect(frame.diff).toContain("1 lines");
  // The consumer's fallback: the untruncated diff is on disk verbatim.
  expect(h.written.get(frame.diff_path as string)).toBe(bigDiff);
});

// ---------------------------------------------------------------------------
// catching_up — tri-state, defaults to null, threaded per-record
// ---------------------------------------------------------------------------

test("catching_up defaults to null on every record kind when the caller omits it", () => {
  const h = makeHarness();
  h.emitter.emitBaseline(frameInput());
  h.emitter.emitFrame(frameInput({ frameText: "changed" }));
  h.emitter.emitTrailer({ reason: "eof" });
  const [baseline, frame, trailer] = h.records();
  expect(baseline.catching_up).toBeNull();
  expect(frame.catching_up).toBeNull();
  expect(trailer.catching_up).toBeNull();
});

test("catching_up threads the caller's injected value per record", () => {
  const h = makeHarness();
  h.emitter.emitBaseline(frameInput({ catchingUp: true }));
  h.emitter.emitFrame(frameInput({ frameText: "changed", catchingUp: false }));
  h.emitter.emitTrailer({ reason: "eof", catchingUp: true });
  const [baseline, frame, trailer] = h.records();
  expect(baseline.catching_up).toBe(true);
  expect(frame.catching_up).toBe(false);
  expect(trailer.catching_up).toBe(true);
});

// ---------------------------------------------------------------------------
// seq contiguity
// ---------------------------------------------------------------------------

test("seq is contiguous across baseline, frames, and the trailer", () => {
  const h = makeHarness();
  h.emitter.emitBaseline(frameInput());
  h.emitter.emitFrame(frameInput({ frameText: "f1" }));
  h.emitter.emitFrame(frameInput({ frameText: "f2" }));
  h.emitter.emitTrailer({ reason: "interrupt" });
  const seqs = h.records().map((r) => r.seq);
  expect(seqs).toEqual([0, 1, 2, 3]);
});

// ---------------------------------------------------------------------------
// Bounds: max-frames counts data frames only; duration via the fake clock
// ---------------------------------------------------------------------------

test("max-frames counts data frames only — baseline is excluded", () => {
  const h = makeHarness({ maxFrames: 2 });
  h.emitter.emitBaseline(frameInput());
  expect(h.emitter.shouldStop()).toBeNull();
  h.emitter.emitFrame(frameInput({ frameText: "f1" }));
  expect(h.emitter.shouldStop()).toBeNull();
  h.emitter.emitFrame(frameInput({ frameText: "f2" }));
  expect(h.emitter.shouldStop()).toBe("max_frames");
  expect(h.emitter.framesEmitted()).toBe(2);
});

test("the duration bound trips once the injected clock passes the deadline", () => {
  const h = makeHarness({ durationMs: 10_000 });
  h.emitter.emitBaseline(frameInput());
  expect(h.emitter.shouldStop()).toBeNull();
  h.advance(9_999);
  expect(h.emitter.shouldStop()).toBeNull();
  h.advance(1);
  expect(h.emitter.shouldStop()).toBe("duration");
});

// ---------------------------------------------------------------------------
// Trailer: every termination cause + coverage verdict
// ---------------------------------------------------------------------------

for (const reason of ["max_frames", "duration", "interrupt", "eof"] as const) {
  test(`a trailer is produced for termination cause '${reason}' with a resume cursor`, () => {
    const h = makeHarness();
    h.emitter.emitBaseline(frameInput({ cursor: "rev-1" }));
    h.emitter.emitFrame(frameInput({ frameText: "f1", cursor: "rev-7" }));
    h.emitter.emitTrailer({ reason });
    const trailer = h.records().at(-1) as Record<string, unknown>;
    expect(trailer.type).toBe("trailer");
    expect(trailer.reason).toBe(reason as TrailerReason);
    expect(trailer.resume_cursor).toBe("rev-7"); // last cursor seen
    expect(trailer.frames_emitted).toBe(1);
    expect(trailer.coverage).toBe("continuous");
  });
}

test("coverage stays continuous on a clean run and flips to gap_possible after a reconnect", () => {
  const clean = makeHarness();
  clean.emitter.emitBaseline(frameInput());
  clean.emitter.emitTrailer({ reason: "eof" });
  expect((clean.records().at(-1) as Record<string, unknown>).coverage).toBe(
    "continuous",
  );

  const reconnected = makeHarness();
  reconnected.emitter.emitBaseline(frameInput());
  reconnected.emitter.noteReconnect();
  reconnected.emitter.emitBaseline(frameInput()); // the re-baseline after reconnect
  reconnected.emitter.emitTrailer({ reason: "eof" });
  expect(
    (reconnected.records().at(-1) as Record<string, unknown>).coverage,
  ).toBe("gap_possible");
});

test("the trailer resume cursor honors an explicit override", () => {
  const h = makeHarness();
  h.emitter.emitBaseline(frameInput({ cursor: "rev-1" }));
  h.emitter.emitTrailer({ reason: "interrupt", cursor: "rev-explicit" });
  const trailer = h.records().at(-1) as Record<string, unknown>;
  expect(trailer.resume_cursor).toBe("rev-explicit");
});

// ---------------------------------------------------------------------------
// Sidecar ring — prunes ONLY its own files, never a foreign path
// ---------------------------------------------------------------------------

test("the sidecar ring prunes the oldest triples and never unlinks a path it did not write", () => {
  const h = makeHarness({ ringSize: 2 });
  // Seed a foreign path into the fake fs the emitter never wrote.
  const foreign = "/tmp/frames-test/keeper-frames-board.9999.frame.0.txt";
  h.written.set(foreign, "someone else's file");

  h.emitter.emitBaseline(frameInput()); // index 0 → [state.0, frame.0]
  h.emitter.emitFrame(frameInput({ frameText: "f1" })); // index 1 → +diff.1
  h.emitter.emitFrame(frameInput({ frameText: "f2" })); // index 2 → prunes index 0
  h.emitter.emitFrame(frameInput({ frameText: "f3" })); // index 3 → prunes index 1

  // Index 0 (2 files) and index 1 (3 files) were pruned = 5 unlinks.
  expect(h.unlinked).toEqual([
    "/tmp/frames-test/keeper-frames-board.4242.state.0.json",
    "/tmp/frames-test/keeper-frames-board.4242.frame.0.txt",
    "/tmp/frames-test/keeper-frames-board.4242.state.1.json",
    "/tmp/frames-test/keeper-frames-board.4242.frame.1.txt",
    "/tmp/frames-test/keeper-frames-board.4242.diff.1.txt",
  ]);
  // Every unlinked path was one this emitter wrote.
  for (const path of h.unlinked) {
    expect(h.written.has(path)).toBe(true);
  }
  // The foreign path was never touched.
  expect(h.unlinked).not.toContain(foreign);
});

test("the newest frame's pointers survive pruning even at ring size 1", () => {
  const h = makeHarness({ ringSize: 1 });
  h.emitter.emitBaseline(frameInput());
  h.emitter.emitFrame(frameInput({ frameText: "f1" }));
  const frame = h.records()[1];
  // The just-emitted frame's sidecars must NOT be among the pruned paths.
  expect(h.unlinked).not.toContain(frame.frame_path);
  expect(h.unlinked).not.toContain(frame.state_path);
  expect(h.unlinked).not.toContain(frame.diff_path);
});

// ---------------------------------------------------------------------------
// Framing safety — single-line records survive hostile frame/diff text
// ---------------------------------------------------------------------------

test("every record is exactly one physical line terminated by a single newline", () => {
  const h = makeHarness();
  h.emitter.emitBaseline(frameInput());
  h.emitter.emitFrame(frameInput({ frameText: "f1" }));
  h.emitter.emitTrailer({ reason: "eof" });
  for (const raw of h.rawWrites) {
    expect(raw.endsWith("\n")).toBe(true);
    // No interior newline: the record body (minus its terminator) is one line.
    expect(raw.slice(0, -1)).not.toContain("\n");
  }
});

test("frame + diff text with newlines, quotes, and ANSI cannot break the single-line framing", () => {
  const hostileFrame =
    'row "fn-1-a"\n\x1b[31mALERT\x1b[0m\n{"injection":true}\nmore';
  const hostileDiff = '@@ evil @@\n-"quoted"\n+\x1b[1mbold\x1b[0m\nend\n';
  const h = makeHarness({ diffFn: () => hostileDiff });
  h.emitter.emitBaseline(frameInput({ frameText: "prev" }));
  h.emitter.emitFrame(frameInput({ frameText: hostileFrame }));

  const [, raw] = h.rawWrites;
  // One physical line despite embedded newlines in both frame text and diff.
  expect(raw.slice(0, -1)).not.toContain("\n");
  const rec = JSON.parse(raw) as Record<string, unknown>;
  // The diff round-trips exactly through the JSON string escaping.
  expect(rec.diff).toBe(hostileDiff);
  // The hostile frame text was never inlined — only its sidecar pointer is.
  expect(h.written.get(rec.frame_path as string)).toBe(`${hostileFrame}\n`);
});
