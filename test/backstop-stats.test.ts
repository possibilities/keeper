/**
 * Unit tests for `scripts/backstop-stats.ts` (epic fn-720, task .4 — the
 * before/after metric surface). Feeds the pure aggregator a synthetic NDJSON
 * fixture (rescue lines + rollup lines + a torn partial final line) and
 * asserts:
 *
 *   - per-(backstop,class) rescue COUNT and staleness p50/p95/p99 percentiles;
 *   - rescue RATE computed from the rollup denominator (rescues_total ÷
 *     fires_total), with take-last rollup semantics;
 *   - graceful degradation when NO rollup landed — rate is `null`
 *     (`n/a`), NEVER divided-by-the-rescue-line-count (survivorship bias);
 *   - partial-final-line tolerance (a torn write is dropped, not an error)
 *     and blank-newline-terminated tail tolerance.
 *
 * The aggregator is a pure function of the text, so the test exercises it
 * directly — no daemon, no sidecar file, no DB.
 */

import { expect, test } from "bun:test";
import { computeStats, type StatsRow } from "../scripts/backstop-stats";

function rowFor(
  rows: StatsRow[],
  backstop: string,
  cls: string,
): StatsRow | undefined {
  return rows.find((r) => r.backstop === backstop && r.class === cls);
}

test("computes rescue count, percentiles, and rate from the rollup denominator", () => {
  // git-heartbeat / missed-wake: 5 rescue lines with known staleness samples,
  // plus an EARLIER then a LATER rollup (take-last must win).
  const stalenesses = [10, 20, 30, 40, 100];
  const lines: string[] = [];
  for (const ms of stalenesses) {
    lines.push(
      JSON.stringify({
        ts: 1748000000000 + ms,
        kind: "backstop-rescue",
        class: "missed-wake",
        backstop: "git-heartbeat",
        worker: "git-worker",
        fast_path: "data_version_poll",
        rescued: true,
        staleness_ms: ms,
        last_fast_path_at: 1747999000000,
      }),
    );
  }
  // earlier rollup (should be overwritten by the later one)
  lines.push(
    JSON.stringify({
      ts: 1748000000500,
      kind: "backstop-rollup",
      backstop: "git-heartbeat",
      class: "missed-wake",
      fires_total: 8,
      rescues_total: 3,
    }),
  );
  // later rollup — take-last wins: 5 rescues out of 20 fires => 25%
  lines.push(
    JSON.stringify({
      ts: 1748000001000,
      kind: "backstop-rollup",
      backstop: "git-heartbeat",
      class: "missed-wake",
      fires_total: 20,
      rescues_total: 5,
    }),
  );
  // a newline-terminated dump (trailing blank line is the normal case)
  const text = `${lines.join("\n")}\n`;

  const result = computeStats(text);
  expect(result.rescues).toBe(5);
  expect(result.rollups).toBe(2);
  expect(result.partialTail).toBe(false);

  const row = rowFor(result.rows, "git-heartbeat", "missed-wake");
  expect(row).toBeDefined();
  if (!row) return;
  expect(row.rescue_lines).toBe(5);
  // take-last rollup denominator
  expect(row.fires_total).toBe(20);
  expect(row.rescues_total).toBe(5);
  expect(row.rate).toBeCloseTo(0.25, 6);
  // percentiles over sorted [10,20,30,40,100]
  expect(row.p50).toBe(30);
  expect(row.p95).toBe(100);
  expect(row.p99).toBe(100);
  expect(row.max).toBe(100);
  expect("samples" in row).toBe(false);
});

test("tolerates a torn partial final line", () => {
  const good = JSON.stringify({
    ts: 1748000000000,
    kind: "backstop-rescue",
    class: "timeout",
    backstop: "autopilot-ceiling",
    worker: "autopilot-worker",
    fast_path: null,
    rescued: true,
    staleness_ms: 90000,
    last_fast_path_at: null,
  });
  // a write torn mid-flush leaves a non-JSON tail with NO trailing newline
  const text = `${good}\n{"kind":"backstop-rollup","backstop":"autopilot-cei`;

  const result = computeStats(text);
  expect(result.partialTail).toBe(true);
  expect(result.rescues).toBe(1);
  expect(result.rollups).toBe(0);

  const row = rowFor(result.rows, "autopilot-ceiling", "timeout");
  expect(row).toBeDefined();
  if (!row) return;
  expect(row.rescue_lines).toBe(1);
  expect(row.p50).toBe(90000);
});

test("degrades gracefully to n/a rate when no rollup denominator is present", () => {
  const text = `${JSON.stringify({
    ts: 1748000000000,
    kind: "backstop-rescue",
    class: "missed-wake",
    backstop: "plan-heartbeat",
    worker: "plan-worker",
    fast_path: "data_version_poll",
    rescued: true,
    staleness_ms: 5000,
    last_fast_path_at: 1747999995000,
  })}\n`;

  const result = computeStats(text);
  const row = rowFor(result.rows, "plan-heartbeat", "missed-wake");
  expect(row).toBeDefined();
  if (!row) return;
  // rescue lines + percentiles still computed
  expect(row.rescue_lines).toBe(1);
  expect(row.p50).toBe(5000);
  // but the denominator is unknown — rate is null (never divide-by-zero, never
  // faked from the rescue-line count)
  expect(row.fires_total).toBeNull();
  expect(row.rescues_total).toBeNull();
  expect(row.rate).toBeNull();
});

test("a zero-fires rollup yields a null rate (no divide-by-zero)", () => {
  const text = `${JSON.stringify({
    ts: 1748000000000,
    kind: "backstop-rollup",
    backstop: "rescan-drop",
    class: "missed-wake",
    fires_total: 0,
    rescues_total: 0,
  })}\n`;

  const result = computeStats(text);
  const row = rowFor(result.rows, "rescan-drop", "missed-wake");
  expect(row).toBeDefined();
  if (!row) return;
  expect(row.fires_total).toBe(0);
  expect(row.rate).toBeNull();
});

test("empty input yields no rows", () => {
  const result = computeStats("");
  expect(result.parsed).toBe(0);
  expect(result.rows).toHaveLength(0);
});
