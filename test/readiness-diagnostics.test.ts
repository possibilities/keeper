/**
 * Pure-function tests for `src/readiness-diagnostics.ts` — exercises the
 * `appendDiagnostic` writer against a tmp log path. The append must be a
 * single line per call, newline-terminated, parseable as JSON, and survive
 * multiple sequential calls.
 *
 * Concurrent-append atomicity (POSIX O_APPEND under PIPE_BUF) is a property
 * of the kernel + node:fs's underlying write(2) syscall — not something we
 * exercise here; the test stays single-process.
 */

import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendDiagnostic,
  type ResolutionDiagnostic,
} from "../src/readiness-diagnostics";

function makeTmpDir(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "keeper-readiness-diag-"));
  return {
    path: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeDiag(
  overrides: Partial<ResolutionDiagnostic> = {},
): ResolutionDiagnostic {
  return {
    ts: "2026-05-28T00:00:00Z",
    kind: "ambiguous-dep-resolution",
    consumer_epic: "fn-1-foo",
    upstream: "fn-2",
    matches: ["fn-2-aaa", "fn-2-zzz"],
    ...overrides,
  };
}

test("appendDiagnostic: writes one JSON line to a fresh log file", () => {
  const tmp = makeTmpDir();
  try {
    const logPath = join(tmp.path, "diag.jsonl");
    const d = makeDiag();
    appendDiagnostic(d, logPath);
    const content = readFileSync(logPath, "utf8");
    expect(content.endsWith("\n")).toBe(true);
    const lines = content.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual(d);
  } finally {
    tmp.cleanup();
  }
});

test("appendDiagnostic: appends to existing content without truncating", () => {
  const tmp = makeTmpDir();
  try {
    const logPath = join(tmp.path, "diag.jsonl");
    // Seed with a pre-existing line — `appendFileSync` mirrors what the
    // helper does internally, but writing it via a different code path
    // exercises the "open-for-append on an existing file" branch.
    appendFileSync(logPath, '{"ts":"prior","kind":"sentinel"}\n');
    const d = makeDiag();
    appendDiagnostic(d, logPath);
    const lines = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      ts: "prior",
      kind: "sentinel",
    });
    expect(JSON.parse(lines[1] ?? "")).toEqual(d);
  } finally {
    tmp.cleanup();
  }
});

test("appendDiagnostic: multiple sequential appends produce one line each", () => {
  const tmp = makeTmpDir();
  try {
    const logPath = join(tmp.path, "diag.jsonl");
    const diags = [
      makeDiag({ ts: "t1", upstream: "fn-1" }),
      makeDiag({ ts: "t2", upstream: "fn-2" }),
      makeDiag({ ts: "t3", upstream: "fn-3" }),
    ];
    for (const d of diags) {
      appendDiagnostic(d, logPath);
    }
    const lines = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.map((p) => p.ts)).toEqual(["t1", "t2", "t3"]);
    expect(parsed.map((p) => p.upstream)).toEqual(["fn-1", "fn-2", "fn-3"]);
  } finally {
    tmp.cleanup();
  }
});

test("appendDiagnostic: I/O error on an unwritable path is swallowed (no throw)", () => {
  // Path under a non-existent directory — `appendFileSync` throws ENOENT.
  // The helper must swallow the error and only emit a stderr warn line so
  // the board/autopilot frame loop never wedges on transient FS hiccups.
  const badPath = "/nonexistent-keeper-test-dir/readiness-diagnostics.jsonl";
  const d = makeDiag();
  // Should not throw.
  expect(() => appendDiagnostic(d, badPath)).not.toThrow();
});
