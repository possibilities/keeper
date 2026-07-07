/**
 * Pure-unit coverage for `runWatchdogLoop` (scripts/watch-watchdog.ts) — the
 * debounced watch loop factored out of `main` so it can be driven through its
 * `runCheck`/`sleep` deps without a real subprocess, wall-clock, or socket.
 *
 * Drives a single check through a miss -> miss -> recover -> miss episode and
 * asserts exactly one anomaly line fires per episode: the two-miss debounce
 * (a lone miss never pages), the `reported[name]` single-fire-until-recovery
 * latch (a third consecutive miss does NOT re-page), and the recovery reset
 * (a miss after a recovery re-arms the debounce from zero).
 */

import { expect, test } from "bun:test";
import { runWatchdogLoop } from "../scripts/watch-watchdog";

interface Verdict {
  ok: boolean;
  detail: string;
}

test("runWatchdogLoop: miss -> miss -> recover -> miss fires exactly one anomaly per episode", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];

  // Tick-indexed verdicts for the single "monitors" check under test:
  //   0: miss   (1st consecutive miss — below debounce, no anomaly)
  //   1: miss   (2nd consecutive miss — hits DEBOUNCE_MISSES=2, anomaly #1)
  //   2: miss   (3rd consecutive miss — already reported, latched, no re-page)
  //   3: recover (resets the miss counter + reported latch, stderr note only)
  //   4: miss   (1st miss of a NEW episode — below debounce, no anomaly)
  //   5: miss   (2nd miss of the new episode — anomaly #2)
  const verdicts: Verdict[] = [
    { ok: false, detail: "miss 1" },
    { ok: false, detail: "miss 2" },
    { ok: false, detail: "miss 3" },
    { ok: true, detail: "recovered" },
    { ok: false, detail: "miss 4" },
    { ok: false, detail: "miss 5" },
  ];

  let calls = 0;
  await runWatchdogLoop(
    {
      writeStdout: (line) => stdout.push(line),
      writeStderr: (line) => stderr.push(line),
      runCheck: async () => {
        const v = verdicts[calls];
        calls += 1;
        return v;
      },
      sleep: async () => {},
    },
    { intervalMs: 1, maxTicks: verdicts.length, checks: ["monitors"] },
  );

  expect(calls).toBe(verdicts.length);

  const anomalies = stdout.filter((l) => l.includes("anomaly"));
  expect(anomalies).toHaveLength(2);
  expect(anomalies[0]).toContain("check=monitors");
  expect(anomalies[0]).toContain("misses=2");
  expect(anomalies[0]).toContain("detail=miss 2");
  expect(anomalies[1]).toContain("misses=2");
  expect(anomalies[1]).toContain("detail=miss 5");

  // The recovery is a stderr-only note — stdout stays strictly anomaly-only.
  const recoveries = stderr.filter((l) => l.includes("recovered"));
  expect(recoveries).toHaveLength(1);
  expect(recoveries[0]).toContain("check=monitors");
});

test("runWatchdogLoop: a lone miss never pages (below the two-miss debounce)", async () => {
  const stdout: string[] = [];
  let calls = 0;
  await runWatchdogLoop(
    {
      writeStdout: (line) => stdout.push(line),
      writeStderr: () => {},
      runCheck: async () => {
        calls += 1;
        return { ok: false, detail: "single blip" };
      },
      sleep: async () => {},
    },
    { intervalMs: 1, maxTicks: 1, checks: ["monitors"] },
  );
  expect(calls).toBe(1);
  expect(stdout).toHaveLength(0);
});

test("runWatchdogLoop: --no-bus filter — an omitted check never runs and never anomaly-pages", async () => {
  const stdout: string[] = [];
  const seen: string[] = [];
  await runWatchdogLoop(
    {
      writeStdout: (line) => stdout.push(line),
      writeStderr: () => {},
      runCheck: async (name) => {
        seen.push(name);
        // Every check misses persistently — if `bus` ran, it would anomaly-page
        // by tick 2 exactly like the others.
        return { ok: false, detail: `${name} down` };
      },
      sleep: async () => {},
    },
    {
      intervalMs: 1,
      maxTicks: 2,
      checks: ["monitors", "status"], // bus filtered out by the caller, as --no-bus does
    },
  );
  expect(seen.every((n) => n !== "bus")).toBe(true);
  expect(seen.sort()).toEqual(
    ["monitors", "monitors", "status", "status"].sort(),
  );
  const anomalies = stdout.filter((l) => l.includes("anomaly"));
  expect(anomalies.some((l) => l.includes("check=bus"))).toBe(false);
  expect(anomalies).toHaveLength(2);
  expect(anomalies.some((l) => l.includes("check=monitors"))).toBe(true);
  expect(anomalies.some((l) => l.includes("check=status"))).toBe(true);
});
