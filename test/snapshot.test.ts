/**
 * Pure-helper coverage for `src/snapshot.ts` (fn-772). These are the
 * shared pieces the `createViewShell` snapshot branch AND the open-coded
 * `usage` main both call, so the `keeper-meta:` contract can never drift:
 *
 *   - `resolveSnapshotMode` — trigger precedence (flag > CI/TERM=dumb >
 *     stdout.isTTY !== true), tri-state isTTY safety, and the both-flags
 *     typed error.
 *   - `createSnapshotLatch` — ready (all streams reported) vs timeout vs
 *     timeout-degrade (≥1 reported), driven synchronously via an injected
 *     timer.
 *   - the trailer / no-frame formatters — the `keeper-meta:` line is the
 *     LAST stdout line, single-line, JSON-parseable, in every mode.
 */

import { expect, test } from "bun:test";
import {
  createSnapshotLatch,
  formatMetaLine,
  formatNoFrameOutput,
  formatSnapshotOutput,
  KEEPER_META_PREFIX,
  resolveSnapshotMode,
  SNAPSHOT_SCHEMA_VERSION,
  SnapshotCliMisuseError,
  type SnapshotLatchOutcome,
  type SnapshotMeta,
  snapshotExitCode,
} from "../src/snapshot";

// ---------------------------------------------------------------------------
// resolveSnapshotMode — precedence + tri-state
// ---------------------------------------------------------------------------

test("resolveSnapshotMode: both flags → typed CLI-misuse error", () => {
  expect(() =>
    resolveSnapshotMode({
      snapshotFlag: true,
      watchFlag: true,
      stdoutIsTTY: true,
      env: {},
    }),
  ).toThrow(SnapshotCliMisuseError);
});

test("resolveSnapshotMode: --snapshot forces snapshot even on a TTY", () => {
  expect(
    resolveSnapshotMode({
      snapshotFlag: true,
      watchFlag: false,
      stdoutIsTTY: true,
      env: {},
    }),
  ).toBe("snapshot");
});

test("resolveSnapshotMode: --watch forces the live stream even when piped", () => {
  expect(
    resolveSnapshotMode({
      snapshotFlag: false,
      watchFlag: true,
      stdoutIsTTY: undefined, // piped
      env: { CI: "true" }, // env would otherwise force snapshot
    }),
  ).toBe("watch");
});

test("resolveSnapshotMode: CI truthy forces snapshot under a pty (isTTY===true)", () => {
  for (const ci of ["true", "1", "TRUE", "yes"]) {
    expect(
      resolveSnapshotMode({
        snapshotFlag: false,
        watchFlag: false,
        stdoutIsTTY: true,
        env: { CI: ci },
      }),
    ).toBe("snapshot");
  }
});

test("resolveSnapshotMode: CI=false / CI=0 / CI='' do NOT force snapshot", () => {
  for (const ci of ["false", "0", "", "  "]) {
    expect(
      resolveSnapshotMode({
        snapshotFlag: false,
        watchFlag: false,
        stdoutIsTTY: true,
        env: { CI: ci },
      }),
    ).toBe("watch");
  }
});

test("resolveSnapshotMode: TERM=dumb forces snapshot under a pty", () => {
  expect(
    resolveSnapshotMode({
      snapshotFlag: false,
      watchFlag: false,
      stdoutIsTTY: true,
      env: { TERM: "dumb" },
    }),
  ).toBe("snapshot");
});

test("resolveSnapshotMode: tri-state isTTY — undefined (piped) is non-TTY → snapshot", () => {
  expect(
    resolveSnapshotMode({
      snapshotFlag: false,
      watchFlag: false,
      stdoutIsTTY: undefined,
      env: {},
    }),
  ).toBe("snapshot");
});

test("resolveSnapshotMode: isTTY===false → snapshot; isTTY===true → watch", () => {
  expect(
    resolveSnapshotMode({
      snapshotFlag: false,
      watchFlag: false,
      stdoutIsTTY: false,
      env: {},
    }),
  ).toBe("snapshot");
  expect(
    resolveSnapshotMode({
      snapshotFlag: false,
      watchFlag: false,
      stdoutIsTTY: true,
      env: {},
    }),
  ).toBe("watch");
});

// ---------------------------------------------------------------------------
// createSnapshotLatch — ready / timeout / degrade, synchronous via injection
// ---------------------------------------------------------------------------

/** Capture the scheduled timeout callback so a test can fire it on demand. */
function makeFakeTimer(): {
  setTimeoutFn: (cb: () => void, ms: number) => number;
  clearTimeoutFn: (handle: unknown) => void;
  fire: () => void;
  cleared: number;
  scheduledMs: number | null;
} {
  let cb: (() => void) | null = null;
  let scheduledMs: number | null = null;
  let cleared = 0;
  return {
    setTimeoutFn(fn, ms): number {
      cb = fn;
      scheduledMs = ms;
      return 1;
    },
    clearTimeoutFn(): void {
      cleared += 1;
    },
    fire(): void {
      cb?.();
    },
    get cleared() {
      return cleared;
    },
    get scheduledMs() {
      return scheduledMs;
    },
  };
}

test("latch: resolves ready once every stream reports (streamCount=2)", () => {
  const timer = makeFakeTimer();
  const outcomes: SnapshotLatchOutcome[] = [];
  const latch = createSnapshotLatch({
    streamCount: 2,
    timeoutMs: 2000,
    onResolve: (o) => outcomes.push(o),
    setTimeoutFn: timer.setTimeoutFn,
    clearTimeoutFn: timer.clearTimeoutFn,
  });

  expect(timer.scheduledMs).toBe(2000);
  expect(latch.pending()).toBe(2);

  latch.reportStream();
  expect(latch.pending()).toBe(1);
  expect(outcomes).toHaveLength(0); // not yet — one stream still outstanding

  latch.reportStream();
  expect(latch.pending()).toBe(0);
  expect(outcomes).toEqual([{ kind: "ready" }]);
  // Ready cancels the timeout.
  expect(timer.cleared).toBe(1);

  // A late report after settling is a no-op.
  latch.reportStream();
  expect(outcomes).toHaveLength(1);
});

test("latch: timeout with ≥1 reported → timeout outcome carries reported count", () => {
  const timer = makeFakeTimer();
  const outcomes: SnapshotLatchOutcome[] = [];
  const latch = createSnapshotLatch({
    streamCount: 4,
    timeoutMs: 2000,
    onResolve: (o) => outcomes.push(o),
    setTimeoutFn: timer.setTimeoutFn,
    clearTimeoutFn: timer.clearTimeoutFn,
  });

  latch.reportStream(); // 1 of 4 — partial composite
  timer.fire();
  expect(outcomes).toEqual([{ kind: "timeout", reported: 1 }]);

  // A report racing in after timeout settles is a no-op.
  latch.reportStream();
  expect(outcomes).toHaveLength(1);
});

test("latch: timeout with 0 reported → timeout outcome reported:0 (no-frame)", () => {
  const timer = makeFakeTimer();
  const outcomes: SnapshotLatchOutcome[] = [];
  createSnapshotLatch({
    streamCount: 1,
    timeoutMs: 1000,
    onResolve: (o) => outcomes.push(o),
    setTimeoutFn: timer.setTimeoutFn,
    clearTimeoutFn: timer.clearTimeoutFn,
  });
  timer.fire();
  expect(outcomes).toEqual([{ kind: "timeout", reported: 0 }]);
});

test("latch: a ready resolution after a fired timeout cannot double-resolve", () => {
  const timer = makeFakeTimer();
  const outcomes: SnapshotLatchOutcome[] = [];
  const latch = createSnapshotLatch({
    streamCount: 1,
    timeoutMs: 1000,
    onResolve: (o) => outcomes.push(o),
    setTimeoutFn: timer.setTimeoutFn,
    clearTimeoutFn: timer.clearTimeoutFn,
  });
  timer.fire(); // settles timeout
  latch.reportStream(); // would have resolved ready, but settled guards it
  expect(outcomes).toEqual([{ kind: "timeout", reported: 0 }]);
});

// ---------------------------------------------------------------------------
// formatters — keeper-meta: line is LAST, single-line, JSON-parseable
// ---------------------------------------------------------------------------

function sampleMeta(overrides: Partial<SnapshotMeta> = {}): SnapshotMeta {
  return {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    script: "git",
    pid: 4242,
    status: "ok",
    frame: 1,
    frame_count: 1,
    truncated: false,
    state: "/tmp/keeper-git.4242.state.1.json",
    frame_txt: "/tmp/keeper-git.4242.frame.1.txt",
    lifecycle: "/tmp/keeper-git.4242.lifecycle.txt",
    meta: "/tmp/keeper-git.4242.meta.txt",
    ts: "2026-06-10T00:00:00.000Z",
    catching_up: null,
    ...overrides,
  };
}

/** The keeper-meta: record parsed from the LAST line of a stdout block. */
function parseTrailer(stdout: string): Record<string, unknown> {
  const lines = stdout.split("\n");
  // Trailing newline → last element is "". The trailer is the last NON-empty.
  const last = lines.filter((l) => l.length > 0).at(-1);
  if (last === undefined) {
    throw new Error("no stdout lines");
  }
  expect(last.startsWith(KEEPER_META_PREFIX)).toBe(true);
  // Single-line: the prefix-stripped remainder must itself contain no newline.
  const json = last.slice(KEEPER_META_PREFIX.length);
  expect(json).not.toContain("\n");
  return JSON.parse(json) as Record<string, unknown>;
}

test("formatSnapshotOutput: frame text, labeled lines, then a parseable keeper-meta: last line", () => {
  const meta = sampleMeta();
  const out = formatSnapshotOutput({
    frameText: "row a\nrow b",
    meta,
  });
  expect(out.endsWith("\n")).toBe(true);
  expect(out).toContain("row a\nrow b");
  expect(out).toContain("state: /tmp/keeper-git.4242.state.1.json");
  expect(out).toContain("frame_txt: /tmp/keeper-git.4242.frame.1.txt");
  expect(out).toContain("lifecycle: /tmp/keeper-git.4242.lifecycle.txt");

  const parsed = parseTrailer(out);
  expect(parsed.schema_version).toBe(SNAPSHOT_SCHEMA_VERSION);
  expect(parsed.script).toBe("git");
  expect(parsed.status).toBe("ok");
  expect(parsed.frame).toBe(1);
  expect(parsed.truncated).toBe(false);
  expect(parsed.catching_up).toBeNull();
});

test("formatSnapshotOutput: catching_up round-trips true/false explicitly", () => {
  expect(
    parseTrailer(
      formatSnapshotOutput({
        frameText: "row",
        meta: sampleMeta({ catching_up: true }),
      }),
    ).catching_up,
  ).toBe(true);
  expect(
    parseTrailer(
      formatSnapshotOutput({
        frameText: "row",
        meta: sampleMeta({ catching_up: false }),
      }),
    ).catching_up,
  ).toBe(false);
});

test("formatMetaLine: an omitted catching_up defaults to null on the wire", () => {
  const { catching_up: _omit, ...withoutField } = sampleMeta();
  const parsed = JSON.parse(
    formatMetaLine(withoutField as SnapshotMeta).slice(
      KEEPER_META_PREFIX.length,
    ),
  ) as Record<string, unknown>;
  expect(parsed).toHaveProperty("catching_up");
  expect(parsed.catching_up).toBeNull();
});

test("formatSnapshotOutput: truncated:true (timeout-degrade) round-trips", () => {
  const out = formatSnapshotOutput({
    frameText: "partial",
    meta: sampleMeta({ truncated: true }),
  });
  expect(parseTrailer(out).truncated).toBe(true);
});

test("formatNoFrameOutput: diagnostic on stderr, frame:null keeper-meta: on stdout", () => {
  const { stdout, stderr } = formatNoFrameOutput({
    meta: sampleMeta({
      status: "timeout",
      frame: null,
      frame_count: 0,
      truncated: true,
      state: null,
      frame_txt: null,
    }),
    diagnostic: "keeper git: no frame before 2000ms timeout",
  });
  // Human diagnostic + labeled paths on stderr; NO keeper-meta: there.
  expect(stderr).toContain("no frame before");
  expect(stderr).not.toContain(KEEPER_META_PREFIX);
  // The keeper-meta: line is on stdout and parses with frame:null.
  const parsed = parseTrailer(stdout);
  expect(parsed.frame).toBeNull();
  expect(parsed.status).toBe("timeout");
  expect(parsed.state).toBeNull();
  expect(parsed.catching_up).toBeNull();
});

test("snapshotExitCode: frame → 0, no frame → 1", () => {
  expect(snapshotExitCode({ status: "ok", haveFrame: true })).toBe(0);
  expect(snapshotExitCode({ status: "timeout", haveFrame: false })).toBe(1);
  expect(
    snapshotExitCode({ status: "daemon-unreachable", haveFrame: false }),
  ).toBe(1);
});
