/**
 * Unit tests for `src/backstop-telemetry.ts` (epic fn-720, task .1 — the
 * foundation). Exercises the four pieces of the shared contract in isolation:
 *
 *   - `appendBackstopRecord` — the NDJSON sidecar writer (the Early proof
 *     point: a synthetic RESCUE record round-trips through the main-sole-writer
 *     path with the uniform schema), append-without-truncate, mode 0o600, and
 *     a swallowed write failure (no throw / no fatalExit).
 *   - `BackstopCounters` — bump increments fires_total always and
 *     rescues_total only on a rescue; snapshot renders deterministic rollups.
 *   - `BackstopRateLimiter` — per-key cooldown gates the (loud) stderr ALARM
 *     while the counter + NDJSON record stay UNgated (the metric stays
 *     complete).
 *   - `resolveBackstopLogPath` — `KEEPER_BACKSTOP_LOG` env override redirects
 *     the path; default is the `~/.local/state/keeper` sibling.
 *
 * Concurrent-append atomicity (POSIX O_APPEND under PIPE_BUF) is a kernel
 * property, not exercised here; the test stays single-process.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendBackstopRecord,
  BackstopCounters,
  BackstopRateLimiter,
  type BackstopRecord,
  buildMissedWakeRecord,
} from "../src/backstop-telemetry";
import { resolveBackstopLogPath } from "../src/db";

function makeTmpDir(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "keeper-backstop-"));
  return {
    path: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeRescue(overrides: Partial<BackstopRecord> = {}): BackstopRecord {
  return {
    ts: 1748000004946,
    kind: "backstop-rescue",
    class: "missed-wake",
    backstop: "git-heartbeat",
    worker: "git-worker",
    fast_path: "data_version_poll",
    rescued: true,
    staleness_ms: 61240,
    last_fast_path_at: 1747999943706,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// appendBackstopRecord — the writer + Early proof point
// ---------------------------------------------------------------------------

test("appendBackstopRecord: a synthetic rescue record round-trips to the sidecar (Early proof point)", () => {
  const tmp = makeTmpDir();
  try {
    const logPath = join(tmp.path, "backstop.ndjson");
    const rec = makeRescue();
    appendBackstopRecord(rec, logPath);
    const content = readFileSync(logPath, "utf8");
    expect(content.endsWith("\n")).toBe(true);
    const lines = content.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    // Round-trips byte-identically: the uniform schema survives the JSON
    // round trip. If THIS fails, the record schema or the topology is wrong.
    expect(JSON.parse(lines[0] ?? "")).toEqual(rec);
  } finally {
    tmp.cleanup();
  }
});

test("appendBackstopRecord: a rollup record round-trips with the rollup discriminator", () => {
  const tmp = makeTmpDir();
  try {
    const logPath = join(tmp.path, "backstop.ndjson");
    const rollup = {
      ts: 1748000005000,
      kind: "backstop-rollup" as const,
      backstop: "plan-heartbeat" as const,
      class: "missed-wake" as const,
      fires_total: 17,
      rescues_total: 2,
    };
    appendBackstopRecord(rollup, logPath);
    const lines = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual(rollup);
  } finally {
    tmp.cleanup();
  }
});

test("appendBackstopRecord: a record with a small detail object round-trips", () => {
  const tmp = makeTmpDir();
  try {
    const logPath = join(tmp.path, "backstop.ndjson");
    const rec = makeRescue({
      class: "timeout",
      backstop: "autopilot-ceiling",
      worker: "autopilot-worker",
      fast_path: null,
      last_fast_path_at: null,
      detail: { verb: "approve", job_id: "fn-1-foo.2" },
    });
    appendBackstopRecord(rec, logPath);
    const lines = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(JSON.parse(lines[0] ?? "")).toEqual(rec);
  } finally {
    tmp.cleanup();
  }
});

test("appendBackstopRecord: appends without truncating prior lines", () => {
  const tmp = makeTmpDir();
  try {
    const logPath = join(tmp.path, "backstop.ndjson");
    appendBackstopRecord(makeRescue({ ts: 1 }), logPath);
    appendBackstopRecord(makeRescue({ ts: 2 }), logPath);
    appendBackstopRecord(makeRescue({ ts: 3 }), logPath);
    const lines = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => JSON.parse(l).ts)).toEqual([1, 2, 3]);
  } finally {
    tmp.cleanup();
  }
});

test("appendBackstopRecord: creates the file with 0600 perms", () => {
  const tmp = makeTmpDir();
  try {
    const logPath = join(tmp.path, "backstop.ndjson");
    appendBackstopRecord(makeRescue(), logPath);
    // Low 9 perm bits — owner rw, nothing else.
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
  } finally {
    tmp.cleanup();
  }
});

test("appendBackstopRecord: an I/O error on an unwritable path is swallowed (no throw)", () => {
  // Path under a non-existent directory — appendFileSync throws ENOENT. The
  // writer must swallow it (stderr warn only) so a missing parent dir or a
  // transient FS hiccup can never wedge the daemon's message loop / fatalExit.
  const badPath = "/nonexistent-keeper-backstop-dir/backstop.ndjson";
  expect(() => appendBackstopRecord(makeRescue(), badPath)).not.toThrow();
});

// ---------------------------------------------------------------------------
// BackstopCounters — the denominator math
// ---------------------------------------------------------------------------

test("BackstopCounters: bump increments fires_total always, rescues_total only on a rescue", () => {
  const c = new BackstopCounters();
  c.bump("plan-heartbeat", "missed-wake", false); // no-op fire
  c.bump("plan-heartbeat", "missed-wake", false); // no-op fire
  c.bump("plan-heartbeat", "missed-wake", true); // genuine rescue
  const rollups = c.snapshot(1000);
  expect(rollups).toHaveLength(1);
  expect(rollups[0]).toEqual({
    ts: 1000,
    kind: "backstop-rollup",
    backstop: "plan-heartbeat",
    class: "missed-wake",
    fires_total: 3,
    rescues_total: 1,
  });
});

test("BackstopCounters: a rate-limited ALARM that still bumps keeps the denominator honest", () => {
  // The decoupling the epic calls out: even when the stderr line is
  // suppressed, the caller still bumps — so fires/rescues are complete.
  const c = new BackstopCounters();
  for (let i = 0; i < 5; i++) {
    c.bump("git-heartbeat", "missed-wake", true);
  }
  const rollups = c.snapshot(2000);
  expect(rollups[0]?.fires_total).toBe(5);
  expect(rollups[0]?.rescues_total).toBe(5);
});

test("BackstopCounters: snapshot renders one deterministic rollup per (backstop,class), sorted", () => {
  const c = new BackstopCounters();
  c.bump("plan-heartbeat", "missed-wake", true);
  c.bump("autopilot-ceiling", "timeout", false);
  c.bump("git-heartbeat", "missed-wake", true);
  const rollups = c.snapshot(3000);
  expect(rollups).toHaveLength(3);
  // Sorted by `${backstop} ${class}` key → stable across runs.
  expect(rollups.map((r) => `${r.backstop} ${r.class}`)).toEqual([
    "autopilot-ceiling timeout",
    "git-heartbeat missed-wake",
    "plan-heartbeat missed-wake",
  ]);
});

test("BackstopCounters: a never-fired counter snapshots to an empty array", () => {
  expect(new BackstopCounters().snapshot(4000)).toEqual([]);
});

test("BackstopCounters: same backstop, two classes are counted separately", () => {
  const c = new BackstopCounters();
  c.bump("pending-dispatch-sweep", "timeout", true);
  c.bump("pending-dispatch-sweep", "missed-wake", false);
  const rollups = c.snapshot(5000);
  expect(rollups).toHaveLength(2);
});

// ---------------------------------------------------------------------------
// BackstopRateLimiter — gates the stderr ALARM only
// ---------------------------------------------------------------------------

test("BackstopRateLimiter: first sighting allowed, then suppressed within the cooldown", () => {
  const rl = new BackstopRateLimiter(1000);
  expect(rl.allow("git-heartbeat", 0)).toBe(true); // first ever
  expect(rl.allow("git-heartbeat", 500)).toBe(false); // within cooldown
  expect(rl.allow("git-heartbeat", 999)).toBe(false); // still within
  expect(rl.allow("git-heartbeat", 1000)).toBe(true); // cooldown elapsed
  expect(rl.allow("git-heartbeat", 1500)).toBe(false); // new cooldown started
});

test("BackstopRateLimiter: per-key — distinct keys don't share a cooldown", () => {
  const rl = new BackstopRateLimiter(1000);
  expect(rl.allow("plan-heartbeat", 0)).toBe(true);
  expect(rl.allow("git-heartbeat", 0)).toBe(true); // different key, allowed
  expect(rl.allow("plan-heartbeat", 100)).toBe(false);
  expect(rl.allow("git-heartbeat", 100)).toBe(false);
});

test("BackstopRateLimiter: suppression of the Nth ALARM never touches counters or the NDJSON record", () => {
  // The metric-completeness invariant: a suppressed ALARM line is purely
  // cosmetic — the counter and the rescue record are written regardless. We
  // model the caller wiring: every fire bumps + writes; only the stderr line
  // is gated.
  const tmp = makeTmpDir();
  try {
    const logPath = join(tmp.path, "backstop.ndjson");
    const rl = new BackstopRateLimiter(1000);
    const c = new BackstopCounters();
    let stderrLines = 0;
    for (let i = 0; i < 4; i++) {
      const now = i * 100; // all within one 1000ms cooldown after the first
      c.bump("git-heartbeat", "missed-wake", true); // ALWAYS bump
      appendBackstopRecord(makeRescue({ ts: now }), logPath); // ALWAYS write
      if (rl.allow("git-heartbeat", now)) stderrLines++; // gated
    }
    // Only the first ALARM line printed...
    expect(stderrLines).toBe(1);
    // ...but all four counters AND all four NDJSON records landed.
    const rollups = c.snapshot(9999);
    expect(rollups[0]?.fires_total).toBe(4);
    expect(rollups[0]?.rescues_total).toBe(4);
    const lines = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(4);
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// resolveBackstopLogPath — env override
// ---------------------------------------------------------------------------

const ORIGINAL_BACKSTOP_LOG = process.env.KEEPER_BACKSTOP_LOG;
afterEach(() => {
  if (ORIGINAL_BACKSTOP_LOG === undefined) {
    delete process.env.KEEPER_BACKSTOP_LOG;
  } else {
    process.env.KEEPER_BACKSTOP_LOG = ORIGINAL_BACKSTOP_LOG;
  }
});

test("resolveBackstopLogPath: KEEPER_BACKSTOP_LOG wins when set", () => {
  process.env.KEEPER_BACKSTOP_LOG = "/tmp/keeper-backstop-override.ndjson";
  expect(resolveBackstopLogPath()).toBe("/tmp/keeper-backstop-override.ndjson");
});

test("resolveBackstopLogPath: empty override falls through to the default sibling", () => {
  process.env.KEEPER_BACKSTOP_LOG = "";
  expect(resolveBackstopLogPath()).toBe(
    join(homedir(), ".local", "state", "keeper", "backstop.ndjson"),
  );
});

test("resolveBackstopLogPath: absent override falls through to the default sibling", () => {
  delete process.env.KEEPER_BACKSTOP_LOG;
  expect(resolveBackstopLogPath()).toBe(
    join(homedir(), ".local", "state", "keeper", "backstop.ndjson"),
  );
});
