/**
 * `test/builds-watchdog.test.ts` (fn-796 task .1) — unit coverage for the builds
 * sitter's watchdog decision surface (`babysitters/builds/watchdog.ts`).
 *
 * Why this test exists. The watchdog is the ONLY notification path the builds
 * sitter has: the findings path pages nothing, so a stale-heartbeat alarm is the
 * sole signal the sitter has died. Its branches (alarm / first-run / all-clear /
 * ok) are the most load-bearing logic in the sitter, and the `--tick` import-pin
 * in `babysitter-build.test.ts` only smoke-imports the file — it asserts no
 * behavior. A wrong staleness, all-clear, or first-run branch is a silent miss
 * (no page when the sitter is dead) or a spurious page; this locks the surface.
 *
 * The decision is a pure function of injected (now, heartbeat-ts,
 * last-all-clear-day) so the branch matrix asserts with no real botctl and no
 * real clock. The heartbeat-read degrade and the day-marker round-trip touch the
 * filesystem, so those run against a per-test tmpdir.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideWatchdog,
  readHeartbeatTs,
  readLastAllClearDay,
  utcDay,
  WATCHDOG_STALE_SECS,
  writeLastAllClearDay,
} from "../babysitters/builds/watchdog";

// A fixed wall-clock anchor so utcDay() is deterministic. 2026-06-11T12:00:00Z.
const NOW = Math.floor(Date.UTC(2026, 5, 11, 12, 0, 0) / 1000);
const TODAY = "2026-06-11";

describe("decideWatchdog branch matrix (fn-796)", () => {
  test("first-run: a null heartbeat is silent, not an alarm", () => {
    const d = decideWatchdog({
      nowSecs: NOW,
      heartbeatTs: null,
      lastAllClearDay: null,
    });
    expect(d.action).toBe("first-run");
    expect(d.heartbeatTs).toBeNull();
    expect(d.ageSecs).toBeNull();
  });

  test("alarm: a heartbeat older than the stale threshold pages", () => {
    const heartbeatTs = NOW - (WATCHDOG_STALE_SECS + 60);
    const d = decideWatchdog({
      nowSecs: NOW,
      heartbeatTs,
      lastAllClearDay: TODAY,
    });
    expect(d.action).toBe("alarm");
    expect(d.heartbeatTs).toBe(heartbeatTs);
    expect(d.ageSecs).toBe(WATCHDOG_STALE_SECS + 60);
    expect(d.message).toContain("STALE");
  });

  test("alarm boundary: exactly at the threshold is still ok, one second past alarms", () => {
    const atThreshold = decideWatchdog({
      nowSecs: NOW,
      heartbeatTs: NOW - WATCHDOG_STALE_SECS,
      lastAllClearDay: TODAY,
    });
    expect(atThreshold.action).toBe("ok");

    const pastThreshold = decideWatchdog({
      nowSecs: NOW,
      heartbeatTs: NOW - (WATCHDOG_STALE_SECS + 1),
      lastAllClearDay: TODAY,
    });
    expect(pastThreshold.action).toBe("alarm");
  });

  test("all-clear: a fresh heartbeat on a new UTC day emits the daily all-clear", () => {
    const d = decideWatchdog({
      nowSecs: NOW,
      heartbeatTs: NOW - 60,
      lastAllClearDay: "2026-06-10",
    });
    expect(d.action).toBe("all-clear");
    expect(d.heartbeatTs).toBe(NOW - 60);
    expect(d.ageSecs).toBe(60);
  });

  test("all-clear: a null last-all-clear-day (never sent) also emits", () => {
    const d = decideWatchdog({
      nowSecs: NOW,
      heartbeatTs: NOW - 60,
      lastAllClearDay: null,
    });
    expect(d.action).toBe("all-clear");
  });

  test("ok: a fresh heartbeat already all-cleared today is silent", () => {
    const d = decideWatchdog({
      nowSecs: NOW,
      heartbeatTs: NOW - 60,
      lastAllClearDay: TODAY,
    });
    expect(d.action).toBe("ok");
    expect(d.ageSecs).toBe(60);
  });

  test("a custom staleSecs override drives the alarm boundary", () => {
    const d = decideWatchdog({
      nowSecs: NOW,
      heartbeatTs: NOW - 100,
      lastAllClearDay: TODAY,
      staleSecs: 50,
    });
    expect(d.action).toBe("alarm");
  });

  test("utcDay is the YYYY-MM-DD UTC calendar day of the injected now", () => {
    expect(utcDay(NOW)).toBe(TODAY);
  });
});

describe("readHeartbeatTs degrade (fn-796)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "builds-watchdog-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a missing heartbeat file resolves to null (first-run, not death)", () => {
    expect(readHeartbeatTs(join(dir, "absent.json"))).toBeNull();
  });

  test("a corrupt heartbeat file resolves to null, never throws", () => {
    const path = join(dir, "heartbeat.json");
    writeFileSync(path, "{ not json");
    expect(readHeartbeatTs(path)).toBeNull();
  });

  test("a well-formed-but-tsless heartbeat resolves to null", () => {
    const path = join(dir, "heartbeat.json");
    writeFileSync(path, JSON.stringify({ other: 1 }));
    expect(readHeartbeatTs(path)).toBeNull();
  });

  test("a non-finite ts resolves to null", () => {
    const path = join(dir, "heartbeat.json");
    writeFileSync(path, '{"ts": null}');
    expect(readHeartbeatTs(path)).toBeNull();
  });

  test("a valid heartbeat returns its numeric ts", () => {
    const path = join(dir, "heartbeat.json");
    writeFileSync(path, JSON.stringify({ ts: NOW }));
    expect(readHeartbeatTs(path)).toBe(NOW);
  });
});

describe("day-marker round-trip (fn-796)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "builds-watchdog-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("an absent marker reads as null", () => {
    expect(readLastAllClearDay(join(dir, "watchdog.day"))).toBeNull();
  });

  test("writeLastAllClearDay then readLastAllClearDay round-trips the day", () => {
    const path = join(dir, "watchdog.day");
    writeLastAllClearDay(path, TODAY);
    expect(readLastAllClearDay(path)).toBe(TODAY);
  });

  test("the marker write creates a missing parent directory", () => {
    const path = join(dir, "nested", "deep", "watchdog.day");
    writeLastAllClearDay(path, TODAY);
    expect(readLastAllClearDay(path)).toBe(TODAY);
  });

  test("an empty marker file reads as null", () => {
    const path = join(dir, "watchdog.day");
    writeFileSync(path, "   \n");
    expect(readLastAllClearDay(path)).toBeNull();
  });
});
