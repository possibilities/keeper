/**
 * `runMaintenanceWindow` orchestration tests. Every I/O boundary (autopilot
 * pause/play, drain, snapshot, launchctl stop/start, reclaim, server-up,
 * verify) is an injected fake — no real daemon, launchctl, subprocess, or DB
 * file. The production `keeper`/`launchctl` wiring lives in `buildRealDeps`
 * (scripts/maintenance-window.ts) and is exercised only by hand against a
 * live daemon, per the task's own test notes.
 *
 * These tests lock the ONE invariant the whole tool exists for: once autopilot
 * is paused, `setAutopilotPaused(false)` is NEVER called except on the single
 * restore at the very end of a fully-successful, non-`--hold` run. Every
 * failure path — including a mid-window `reclaim` failure that brings the
 * daemon back up for the board's sake — leaves it paused.
 *
 * A second block below unit-tests the pure helpers `buildRealDeps` wires its
 * `awaitDrain`/forensics-term logic through — `readInFlightCounts` /
 * `isBoardQuiet` / `deriveForensicsTerm` — with fabricated inputs, no
 * subprocess or DB required.
 */

import { expect, test } from "bun:test";
import {
  deriveForensicsTerm,
  type InFlightCounts,
  isBoardQuiet,
  type MaintenanceWindowDeps,
  type MaintenanceWindowResult,
  readInFlightCounts,
  runMaintenanceWindow,
} from "../scripts/maintenance-window";

interface FakeConfig {
  wasPaused?: boolean;
  captureOk?: boolean;
  pauseOk?: boolean;
  drainOk?: boolean;
  snapshotOk?: boolean;
  snapshotPath?: string | null;
  stopOk?: boolean;
  reclaimOk?: boolean;
  startOk?: boolean;
  serverUpOk?: boolean;
  verifyOk?: boolean;
  restoreOk?: boolean;
}

function buildFakeDeps(cfg: FakeConfig = {}): {
  deps: MaintenanceWindowDeps;
  calls: string[];
  setPausedCalls: boolean[];
} {
  const calls: string[] = [];
  const setPausedCalls: boolean[] = [];
  let startDaemonCallCount = 0;

  const deps: MaintenanceWindowDeps = {
    async getAutopilotPaused() {
      calls.push("capture");
      if (cfg.captureOk === false) {
        return { ok: false, error: "capture failed", paused: false };
      }
      return { ok: true, error: null, paused: cfg.wasPaused ?? false };
    },
    async setAutopilotPaused(paused: boolean) {
      calls.push(`setPaused(${paused})`);
      setPausedCalls.push(paused);
      // `pauseOk` gates only the FIRST call (pausing at window start);
      // `restoreOk` gates only the LAST call (the restore at the end).
      if (setPausedCalls.length === 1 && cfg.pauseOk === false) {
        return { ok: false, error: "pause failed" };
      }
      if (setPausedCalls.length > 1 && cfg.restoreOk === false) {
        return { ok: false, error: "restore failed" };
      }
      return { ok: true, error: null };
    },
    async awaitDrain() {
      calls.push("drain");
      return cfg.drainOk === false
        ? { ok: false, error: "drain timed out" }
        : { ok: true, error: null };
    },
    async snapshot() {
      calls.push("snapshot");
      return cfg.snapshotOk === false
        ? { ok: false, error: "snapshot failed", path: null }
        : {
            ok: true,
            error: null,
            path: cfg.snapshotPath ?? "/tmp/keeper-snap.db",
          };
    },
    async stopDaemon() {
      calls.push("stop");
      return cfg.stopOk === false
        ? { ok: false, error: "stop failed" }
        : { ok: true, error: null };
    },
    async reclaim() {
      calls.push("reclaim");
      return cfg.reclaimOk === false
        ? { ok: false, error: "reclaim failed" }
        : { ok: true, error: null };
    },
    async startDaemon() {
      startDaemonCallCount += 1;
      calls.push(`start(${startDaemonCallCount})`);
      return cfg.startOk === false
        ? { ok: false, error: "start failed" }
        : { ok: true, error: null };
    },
    async awaitServerUp() {
      calls.push("server-up");
      return cfg.serverUpOk === false
        ? { ok: false, error: "server-up timed out" }
        : { ok: true, error: null };
    },
    async verify() {
      calls.push("verify");
      return cfg.verifyOk === false
        ? { ok: false, error: "verify failed" }
        : { ok: true, error: null };
    },
    log() {
      // No-op sink — assertions read `calls`, not log lines.
    },
  };

  return { deps, calls, setPausedCalls };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test("runMaintenanceWindow(): full happy path (--play) runs every step in order and restores unpaused", async () => {
  const { deps, calls, setPausedCalls } = buildFakeDeps({ wasPaused: false });

  const result = await runMaintenanceWindow({ hold: false }, deps);

  expect(result).toEqual({ outcome: "restored" });
  expect(calls).toEqual([
    "capture",
    "setPaused(true)",
    "drain",
    "snapshot",
    "stop",
    "reclaim",
    "start(1)",
    "server-up",
    "verify",
    "setPaused(false)",
  ]);
  expect(setPausedCalls).toEqual([true, false]);
});

test("runMaintenanceWindow(): a board already paused before the window restores to paused (not unpaused)", async () => {
  const { deps, setPausedCalls } = buildFakeDeps({ wasPaused: true });

  const result = await runMaintenanceWindow({ hold: false }, deps);

  expect(result).toEqual({ outcome: "restored" });
  // Restore writes back the CAPTURED value, not a blind unpause.
  expect(setPausedCalls).toEqual([true, true]);
});

test("runMaintenanceWindow(): --hold leaves autopilot paused and never restores", async () => {
  const { deps, calls, setPausedCalls } = buildFakeDeps({ wasPaused: false });

  const result = await runMaintenanceWindow({ hold: true }, deps);

  expect(result).toEqual({ outcome: "held" });
  expect(calls.at(-1)).toBe("verify");
  expect(setPausedCalls).toEqual([true]);
});

// ---------------------------------------------------------------------------
// Fail-safe: every failure path leaves autopilot paused
// ---------------------------------------------------------------------------

test("runMaintenanceWindow(): a capture failure aborts before ever touching autopilot", async () => {
  const { deps, calls, setPausedCalls } = buildFakeDeps({ captureOk: false });

  const result = await runMaintenanceWindow({ hold: false }, deps);

  expect(result).toEqual({
    outcome: "failed",
    step: "capture",
    error: "capture failed",
  });
  expect(calls).toEqual(["capture"]);
  expect(setPausedCalls).toEqual([]);
});

test("runMaintenanceWindow(): a pause failure fails safe before any drain/snapshot/stop", async () => {
  const { deps, calls, setPausedCalls } = buildFakeDeps({ pauseOk: false });

  const result = await runMaintenanceWindow({ hold: false }, deps);

  expect(result).toEqual({
    outcome: "failed",
    step: "pause",
    error: "pause failed",
  });
  expect(calls).toEqual(["capture", "setPaused(true)"]);
  expect(setPausedCalls).toEqual([true]);
});

test("runMaintenanceWindow(): a drain timeout fails safe before any snapshot/stop/reclaim", async () => {
  const { deps, calls, setPausedCalls } = buildFakeDeps({ drainOk: false });

  const result = await runMaintenanceWindow({ hold: false }, deps);

  expect(result).toEqual({
    outcome: "failed",
    step: "drain",
    error: "drain timed out",
  });
  expect(calls).toEqual(["capture", "setPaused(true)", "drain"]);
  expect(setPausedCalls).toEqual([true]);
});

test("runMaintenanceWindow(): a snapshot failure fails safe before stopping the daemon", async () => {
  const { deps, calls, setPausedCalls } = buildFakeDeps({ snapshotOk: false });

  const result = await runMaintenanceWindow({ hold: false }, deps);

  expect(result).toEqual({
    outcome: "failed",
    step: "snapshot",
    error: "snapshot failed",
  });
  expect(calls).toEqual(["capture", "setPaused(true)", "drain", "snapshot"]);
  expect(setPausedCalls).toEqual([true]);
});

test("runMaintenanceWindow(): a stop failure fails safe before reclaim ever runs", async () => {
  const { deps, calls, setPausedCalls } = buildFakeDeps({ stopOk: false });

  const result = await runMaintenanceWindow({ hold: false }, deps);

  expect(result).toEqual({
    outcome: "failed",
    step: "stop",
    error: "stop failed",
  });
  expect(calls).toEqual([
    "capture",
    "setPaused(true)",
    "drain",
    "snapshot",
    "stop",
  ]);
  expect(setPausedCalls).toEqual([true]);
});

test("runMaintenanceWindow(): a reclaim failure restarts the daemon for the board's sake but stays paused", async () => {
  const { deps, calls, setPausedCalls } = buildFakeDeps({ reclaimOk: false });

  const result = await runMaintenanceWindow({ hold: false }, deps);

  expect(result).toEqual({
    outcome: "failed",
    step: "reclaim",
    error: "reclaim failed",
  });
  // Recovery restarts the daemon (the original DB was never swapped), then
  // stops — no `verify`, no restore call.
  expect(calls).toEqual([
    "capture",
    "setPaused(true)",
    "drain",
    "snapshot",
    "stop",
    "reclaim",
    "start(1)",
    "server-up",
  ]);
  expect(setPausedCalls).toEqual([true]);
});

test("runMaintenanceWindow(): a post-reclaim daemon-start failure fails safe", async () => {
  const { deps, calls, setPausedCalls } = buildFakeDeps({ startOk: false });

  const result = await runMaintenanceWindow({ hold: false }, deps);

  expect(result).toEqual({
    outcome: "failed",
    step: "start",
    error: "start failed",
  });
  expect(calls).toEqual([
    "capture",
    "setPaused(true)",
    "drain",
    "snapshot",
    "stop",
    "reclaim",
    "start(1)",
  ]);
  expect(setPausedCalls).toEqual([true]);
});

test("runMaintenanceWindow(): a server-up timeout fails safe", async () => {
  const { deps, calls, setPausedCalls } = buildFakeDeps({ serverUpOk: false });

  const result = await runMaintenanceWindow({ hold: false }, deps);

  expect(result).toEqual({
    outcome: "failed",
    step: "server-up",
    error: "server-up timed out",
  });
  expect(calls).toEqual([
    "capture",
    "setPaused(true)",
    "drain",
    "snapshot",
    "stop",
    "reclaim",
    "start(1)",
    "server-up",
  ]);
  expect(setPausedCalls).toEqual([true]);
});

test("runMaintenanceWindow(): a verify failure preserves the snapshot (structurally unreachable to delete) and stays paused", async () => {
  const { deps, calls, setPausedCalls } = buildFakeDeps({ verifyOk: false });

  const result = await runMaintenanceWindow({ hold: false }, deps);

  expect(result).toEqual({
    outcome: "failed",
    step: "verify",
    error: "verify failed",
  });
  expect(calls).toEqual([
    "capture",
    "setPaused(true)",
    "drain",
    "snapshot",
    "stop",
    "reclaim",
    "start(1)",
    "server-up",
    "verify",
  ]);
  // No restore call — autopilot never unpauses on a verify mismatch. The
  // deps interface exposes no "delete/restore snapshot" capability at all,
  // so this function is structurally incapable of touching the pre-reclaim
  // snapshot on this path.
  expect(setPausedCalls).toEqual([true]);
});

test("runMaintenanceWindow(): --hold also fails safe on a verify mismatch (no held outcome)", async () => {
  const { deps, calls } = buildFakeDeps({ verifyOk: false });

  const result = await runMaintenanceWindow({ hold: true }, deps);

  expect(result).toEqual({
    outcome: "failed",
    step: "verify",
    error: "verify failed",
  });
  expect(calls.at(-1)).toBe("verify");
});

// ---------------------------------------------------------------------------
// Restore failure — distinct from a mid-window failure
// ---------------------------------------------------------------------------

test("runMaintenanceWindow(): a failed final restore is surfaced distinctly from a reclaim failure", async () => {
  const { deps, calls, setPausedCalls } = buildFakeDeps({ restoreOk: false });

  const result: MaintenanceWindowResult = await runMaintenanceWindow(
    { hold: false },
    deps,
  );

  expect(result.outcome).toBe("restore_failed");
  if (result.outcome === "restore_failed") {
    expect(result.error).toContain("reclaim succeeded");
    expect(result.error).toContain("autopilot state unknown");
  }
  expect(calls).toEqual([
    "capture",
    "setPaused(true)",
    "drain",
    "snapshot",
    "stop",
    "reclaim",
    "start(1)",
    "server-up",
    "verify",
    "setPaused(false)",
  ]);
  expect(setPausedCalls).toEqual([true, false]);
});

// ---------------------------------------------------------------------------
// F1 — readInFlightCounts / isBoardQuiet: the drain gate must not report
// quiet while a launch-window (pending) dispatch is still open, even once
// board_work_jobs alone has reached zero.
// ---------------------------------------------------------------------------

test("readInFlightCounts(): reads both counts off a well-formed in_flight block", () => {
  const counts = readInFlightCounts({
    in_flight: { board_work_jobs: 2, pending_dispatches: 1 },
  });
  expect(counts).toEqual({ boardWorkJobs: 2, pendingDispatches: 1 });
});

test("readInFlightCounts(): a missing/non-numeric field reads null, not 0", () => {
  expect(readInFlightCounts(null)).toEqual({
    boardWorkJobs: null,
    pendingDispatches: null,
  });
  expect(readInFlightCounts({})).toEqual({
    boardWorkJobs: null,
    pendingDispatches: null,
  });
  expect(readInFlightCounts({ in_flight: { board_work_jobs: "0" } })).toEqual({
    boardWorkJobs: null,
    pendingDispatches: null,
  });
});

test("isBoardQuiet(): false while board-work jobs are still active", () => {
  const counts: InFlightCounts = { boardWorkJobs: 1, pendingDispatches: 0 };
  expect(isBoardQuiet(counts)).toBe(false);
});

test("isBoardQuiet(): false while a launch-window dispatch is open even though board_work_jobs already reads zero", () => {
  const counts: InFlightCounts = { boardWorkJobs: 0, pendingDispatches: 1 };
  expect(isBoardQuiet(counts)).toBe(false);
});

test("isBoardQuiet(): false on an unreadable count (null), never mistaken for quiet", () => {
  expect(isBoardQuiet({ boardWorkJobs: null, pendingDispatches: 0 })).toBe(
    false,
  );
  expect(isBoardQuiet({ boardWorkJobs: 0, pendingDispatches: null })).toBe(
    false,
  );
});

test("isBoardQuiet(): true only once both board-work and pending counts read zero", () => {
  const counts: InFlightCounts = { boardWorkJobs: 0, pendingDispatches: 0 };
  expect(isBoardQuiet(counts)).toBe(true);
});

// ---------------------------------------------------------------------------
// F2 — deriveForensicsTerm: the captured term must stay a literal substring
// of the source prompt so `keeper search-history` (which ESCAPEs %/_/\ for a
// literal LIKE match) can find it — never stripped.
// ---------------------------------------------------------------------------

test("deriveForensicsTerm(): keeps a literal '%' in the captured prefix instead of stripping it", () => {
  // Under the 32-char cap, so the whole trimmed prompt is the term — the
  // expected value is the hand-typed literal, not a re-slice of the input.
  const term = deriveForensicsTerm("100% done with tests");
  expect(term).toBe("100% done with tests");
});

test("deriveForensicsTerm(): keeps a literal '_' and '\\\\' in the captured prefix instead of stripping them", () => {
  const term = deriveForensicsTerm("fix_the\\path bug");
  expect(term).toBe("fix_the\\path bug");
});

test("deriveForensicsTerm(): trims and caps at 32 chars", () => {
  const prompt = `  ${"a".repeat(50)}  `;
  const term = deriveForensicsTerm(prompt);
  expect(term).toBe("a".repeat(32));
});

test("deriveForensicsTerm(): null when the usable prefix is shorter than 8 chars", () => {
  expect(deriveForensicsTerm("short")).toBeNull();
  expect(deriveForensicsTerm("   ")).toBeNull();
  expect(deriveForensicsTerm("")).toBeNull();
});
