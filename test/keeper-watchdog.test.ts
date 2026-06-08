/**
 * keeper-watchdog (fn-733) — the external dead-man for the babysitter.
 *
 * Covers:
 *  1. The PURE staleness decision (`decideWatchdog`) — fresh ts → ok / all-clear;
 *     stale ts → alarm; missing/corrupt heartbeat → silent first-run; the
 *     once-a-day all-clear de-dup.
 *  2. The heartbeat read (`readHeartbeatTs`) degrade-don't-throw on
 *     missing/corrupt files.
 *  3. The `run` wiring — an alarm/all-clear fires the chat sink (Telegram only),
 *     the all-clear writes the day marker, and first-run / ok stay silent — all
 *     with INJECTED clock + file paths + notifier (no real botctl, no real clock).
 *
 * Sandboxes BABYSITTER_STATE_DIR under a per-test tmpdir (the sitter joins its
 * "performance" slug onto the root, so stateDir = <root>/performance).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHeartbeat } from "../babysitters/performance/watch";
import {
  decideWatchdog,
  type NotifyDeps,
  type RunDeps,
  readHeartbeatTs,
  readLastAllClearDay,
  resolveHeartbeatPath,
  resolveWatchdogDayPath,
  run,
  utcDay,
  WATCHDOG_STALE_SECS,
} from "../babysitters/performance/watchdog";

let tmpDir: string;
let stateDir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-watchdog-"));
  const bbRoot = join(tmpDir, "bb-state");
  stateDir = join(bbRoot, "performance");
  savedEnv = process.env.BABYSITTER_STATE_DIR;
  process.env.BABYSITTER_STATE_DIR = bbRoot;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.BABYSITTER_STATE_DIR;
  else process.env.BABYSITTER_STATE_DIR = savedEnv;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Path resolvers
// ---------------------------------------------------------------------------

describe("path resolvers", () => {
  test("heartbeat + day paths honor BABYSITTER_STATE_DIR", () => {
    expect(resolveHeartbeatPath()).toBe(join(stateDir, "heartbeat.json"));
    expect(resolveWatchdogDayPath()).toBe(join(stateDir, "watchdog.day"));
  });
});

// ---------------------------------------------------------------------------
// The pure decision
// ---------------------------------------------------------------------------

describe("decideWatchdog", () => {
  const now = 1_700_000_000;

  test("missing heartbeat → silent first-run (not dead)", () => {
    const d = decideWatchdog({
      nowSecs: now,
      heartbeatTs: null,
      lastAllClearDay: null,
    });
    expect(d.action).toBe("first-run");
    expect(d.ageSecs).toBeNull();
  });

  test("fresh heartbeat, same day already all-cleared → ok (silent)", () => {
    const d = decideWatchdog({
      nowSecs: now,
      heartbeatTs: now - 60, // 1 min old, well under threshold
      lastAllClearDay: utcDay(now),
    });
    expect(d.action).toBe("ok");
    expect(d.ageSecs).toBe(60);
  });

  test("fresh heartbeat on a NEW day → all-clear", () => {
    const d = decideWatchdog({
      nowSecs: now,
      heartbeatTs: now - 60,
      lastAllClearDay: "1999-01-01",
    });
    expect(d.action).toBe("all-clear");
  });

  test("stale heartbeat (> threshold) → alarm", () => {
    const d = decideWatchdog({
      nowSecs: now,
      heartbeatTs: now - (WATCHDOG_STALE_SECS + 1),
      lastAllClearDay: utcDay(now),
    });
    expect(d.action).toBe("alarm");
    expect(d.ageSecs).toBe(WATCHDOG_STALE_SECS + 1);
    expect(d.message).toContain("STALE");
  });

  test("exactly AT the threshold is NOT yet stale (strict >)", () => {
    const d = decideWatchdog({
      nowSecs: now,
      heartbeatTs: now - WATCHDOG_STALE_SECS,
      lastAllClearDay: utcDay(now),
    });
    expect(d.action).toBe("ok");
  });

  test("threshold is max(3×300, 900) = 900s", () => {
    expect(WATCHDOG_STALE_SECS).toBe(900);
  });
});

// ---------------------------------------------------------------------------
// Heartbeat read (degrade-don't-throw)
// ---------------------------------------------------------------------------

describe("readHeartbeatTs", () => {
  test("missing file → null (first-run)", () => {
    expect(readHeartbeatTs(join(stateDir, "heartbeat.json"))).toBeNull();
  });

  test("corrupt JSON → null (treated as first-run, not death)", () => {
    const p = join(stateDir, "heartbeat.json");
    require("node:fs").mkdirSync(stateDir, { recursive: true });
    writeFileSync(p, "{not json");
    expect(readHeartbeatTs(p)).toBeNull();
  });

  test("valid heartbeat round-trips through keeper-watch's writeHeartbeat", () => {
    const p = join(stateDir, "heartbeat.json");
    writeHeartbeat(p, 4242);
    expect(readHeartbeatTs(p)).toBe(4242);
  });

  test("missing ts field → null", () => {
    const p = join(stateDir, "heartbeat.json");
    require("node:fs").mkdirSync(stateDir, { recursive: true });
    writeFileSync(p, JSON.stringify({ nope: 1 }));
    expect(readHeartbeatTs(p)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// run() — decision wired to real reads + injected notifiers
// ---------------------------------------------------------------------------

describe("run", () => {
  const now = 1_700_000_000;

  function captureNotify(): {
    deps: NotifyDeps;
    chatCalls: string[];
  } {
    const chatCalls: string[] = [];
    return {
      deps: {
        chat: (m) => chatCalls.push(m),
      },
      chatCalls,
    };
  }

  function runDeps(nowSecs: number, notify: NotifyDeps): RunDeps {
    return {
      nowSecs: () => nowSecs,
      heartbeatPath: join(stateDir, "heartbeat.json"),
      dayPath: join(stateDir, "watchdog.day"),
      notify,
    };
  }

  test("no heartbeat → first-run, the chat sink stays silent", () => {
    const { deps, chatCalls } = captureNotify();
    const d = run(runDeps(now, deps));
    expect(d.action).toBe("first-run");
    expect(chatCalls).toHaveLength(0);
  });

  test("stale heartbeat → alarm fires the chat sink (Telegram only)", () => {
    writeHeartbeat(join(stateDir, "heartbeat.json"), now - 100000);
    const { deps, chatCalls } = captureNotify();
    const d = run(runDeps(now, deps));
    expect(d.action).toBe("alarm");
    expect(chatCalls).toHaveLength(1);
    // No day marker written on an alarm (only the all-clear writes it).
    expect(existsSync(join(stateDir, "watchdog.day"))).toBe(false);
  });

  test("fresh heartbeat, no prior all-clear → all-clear (chat) + day marker", () => {
    writeHeartbeat(join(stateDir, "heartbeat.json"), now - 60);
    const { deps, chatCalls } = captureNotify();
    const d = run(runDeps(now, deps));
    expect(d.action).toBe("all-clear");
    expect(chatCalls).toHaveLength(1);
    expect(readLastAllClearDay(join(stateDir, "watchdog.day"))).toBe(
      utcDay(now),
    );
  });

  test("second run same day is silent (all-clear de-duped)", () => {
    writeHeartbeat(join(stateDir, "heartbeat.json"), now - 60);
    const first = captureNotify();
    run(runDeps(now, first.deps));
    expect(first.chatCalls).toHaveLength(1);
    // Same day, fresh heartbeat again → ok, silent.
    const second = captureNotify();
    const d = run(runDeps(now + 120, second.deps));
    expect(d.action).toBe("ok");
    expect(second.chatCalls).toHaveLength(0);
  });
});
