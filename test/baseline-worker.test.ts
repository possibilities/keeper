/**
 * Pure-seam pins for `src/baseline-worker.ts` — the supervised Baseline runner
 * (docs/adr/0005). NO Worker, NO subprocess, NO git: every test drives an exported
 * pure decision function directly. The daemon wiring is asserted by module shape
 * (an inert import) here and by the spawn-all regression in `test/daemon.test.ts`;
 * the subprocess/git integration is production's own net.
 *
 * Expected values are hand-authored constants / fixtures (bun's real failing-test
 * output format, hand-transcribed), never re-derived by the code under test.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BaselineResult,
  deriveResult,
  type SuiteRun,
  type ToolchainFingerprint,
} from "../src/baseline-store";
import {
  classifyRun,
  cleanupPlan,
  crashDetail,
  finalOutcome,
  gatePhaseCommand,
  installFailureReason,
  parseGateOutput,
  planBootPrune,
  planSpool,
  type RunClass,
  type SpoolEntry,
  shouldRetry,
  spoolFilesForKey,
  timeoutOutcome,
  toSuiteRun,
} from "../src/baseline-worker";

const TC: ToolchainFingerprint = {
  bunVersion: "1.3.14",
  platform: "darwin-arm64",
};

function runOf(exitCode: number, failingTests: string[]): SuiteRun {
  return { startedAt: 1000, durationMs: 500, exitCode, failingTests };
}

// ── gate output parsing (against bun's real format) ──────────────────────────

// Hand-transcribed from `bun test` on a file with 2 passing + 3 failing tests.
const BUN_FAIL_OUTPUT = [
  "bun test v1.3.14 (0d9b296a)",
  "",
  "sample.test.ts:",
  "(fail) top level failing [1.62ms]",
  "(fail) group A > nested failing [1.39ms]",
  "(fail) group A > sub B > deep failing [0.15ms]",
  "",
  " 2 pass",
  " 3 fail",
  " 4 expect() calls",
  "Ran 5 tests across 1 file. [968.00ms]",
].join("\n");

test("parseGateOutput extracts failing-test identities and summary counts", () => {
  const parsed = parseGateOutput(BUN_FAIL_OUTPUT);
  expect(parsed.failingTests).toEqual([
    "top level failing",
    "group A > nested failing",
    "group A > sub B > deep failing",
  ]);
  expect(parsed.passCount).toBe(2);
  expect(parsed.failCount).toBe(3);
});

test("parseGateOutput on a green run finds no failures and a zero fail count", () => {
  const green = [
    "bun test v1.3.14",
    "",
    " 6 pass",
    " 0 fail",
    "Ran 6 tests.",
  ].join("\n");
  const parsed = parseGateOutput(green);
  expect(parsed.failingTests).toEqual([]);
  expect(parsed.passCount).toBe(6);
  expect(parsed.failCount).toBe(0);
});

test("parseGateOutput keeps a bracket inside a test name (strips only the duration)", () => {
  const parsed = parseGateOutput(
    "(fail) handles input [x] gracefully [2.50ms]",
  );
  expect(parsed.failingTests).toEqual(["handles input [x] gracefully"]);
});

test("parseGateOutput ignores a source-snippet line that is not a (fail) marker", () => {
  // Bun echoes numbered source lines in the diff; none begin `(fail) `.
  const parsed = parseGateOutput(
    "3 | expect(1).toBe(2); // (fail) not a marker",
  );
  expect(parsed.failingTests).toEqual([]);
});

// ── run classification ───────────────────────────────────────────────────────

test("classifyRun: exit 0 is the only clean class", () => {
  expect(classifyRun(0, parseGateOutput(" 6 pass\n 0 fail"))).toBe("clean");
});

test("classifyRun: non-zero exit with failing tests is 'failed'", () => {
  expect(classifyRun(1, parseGateOutput(BUN_FAIL_OUTPUT))).toBe("failed");
});

test("classifyRun: non-zero exit with a fail-count but no parsed ids is still 'failed'", () => {
  expect(classifyRun(1, { failingTests: [], passCount: 3, failCount: 2 })).toBe(
    "failed",
  );
});

test("classifyRun: non-zero exit with NO failure signal is 'crashed' (never green)", () => {
  // A compile error / bail: bun exits non-zero, prints no `(fail)` line, no summary.
  const parsed = parseGateOutput("error: Cannot find module './missing'");
  expect(classifyRun(1, parsed)).toBe("crashed");
});

test("shouldRetry only fires for a failed run", () => {
  expect(shouldRetry("failed")).toBe(true);
  expect(shouldRetry("clean")).toBe(false);
  expect(shouldRetry("crashed")).toBe(false);
});

// ── outcome derivation (composed with the store's deriveResult) ──────────────

const DERIVE_BASE = {
  key: "k",
  sha: "a".repeat(40),
  toolchain: TC,
  computedAt: 1_700_000_000_000,
};

function derive(
  run1Cls: RunClass,
  run2: Parameters<typeof finalOutcome>[1],
): BaselineResult {
  const outcome = finalOutcome(
    {
      run: runOf(
        run1Cls === "clean" ? 0 : 1,
        run1Cls === "failed" ? ["A"] : [],
      ),
      cls: run1Cls,
      detail: "boom",
    },
    run2,
  );
  return deriveResult({ ...DERIVE_BASE, outcome });
}

test("finalOutcome: a clean run 1 derives green", () => {
  expect(derive("clean", null).status).toBe("green");
});

test("finalOutcome: a crashed run 1 derives infra-error:spawn, never green", () => {
  const res = derive("crashed", null);
  expect(res.status).toBe("infra-error");
  if (res.status !== "infra-error") throw new Error("unreachable");
  expect(res.kind).toBe("spawn");
  expect(res.message).toBe("boom");
});

test("finalOutcome: fail-then-pass at the same sha marks the test flaky-suspect", () => {
  // run1 fails A; retry passes clean → A failed 1 of 2 runs → flaky.
  const outcome = finalOutcome(
    { run: runOf(1, ["A"]), cls: "failed", detail: "" },
    { run: runOf(0, []), cls: "clean", detail: "" },
  );
  const res = deriveResult({ ...DERIVE_BASE, outcome });
  expect(res.status).toBe("suite-red");
  if (res.status !== "suite-red") throw new Error("unreachable");
  expect(res.runs.length).toBe(2);
  expect(res.failing).toEqual([{ id: "A", flakySuspect: true }]);
});

test("finalOutcome: fail-then-fail keeps the test a hard failure", () => {
  const outcome = finalOutcome(
    { run: runOf(1, ["A", "B"]), cls: "failed", detail: "" },
    { run: runOf(1, ["A"]), cls: "failed", detail: "" },
  );
  const res = deriveResult({ ...DERIVE_BASE, outcome });
  expect(res.status).toBe("suite-red");
  if (res.status !== "suite-red") throw new Error("unreachable");
  const byId = new Map(res.failing.map((f) => [f.id, f.flakySuspect]));
  expect(byId.get("A")).toBe(false); // failed both runs → hard
  expect(byId.get("B")).toBe(true); // failed then absent → flaky
});

test("finalOutcome: a crashed RETRY does not dilute run 1's real failures to flaky", () => {
  // The inconclusive retry is dropped; run1's A stands alone as a hard failure.
  const outcome = finalOutcome(
    { run: runOf(1, ["A"]), cls: "failed", detail: "" },
    { run: runOf(124, []), cls: "crashed", detail: "retry timed out" },
  );
  const res = deriveResult({ ...DERIVE_BASE, outcome });
  expect(res.status).toBe("suite-red");
  if (res.status !== "suite-red") throw new Error("unreachable");
  expect(res.runs.length).toBe(1);
  expect(res.failing).toEqual([{ id: "A", flakySuspect: false }]);
});

test("timeoutOutcome derives a timeout leaf that is never green, partial runs kept", () => {
  const res = deriveResult({
    ...DERIVE_BASE,
    outcome: timeoutOutcome(60_000, [runOf(1, ["slow"])]),
  });
  expect(res.status).toBe("timeout");
  if (res.status !== "timeout") throw new Error("unreachable");
  expect(res.deadlineMs).toBe(60_000);
  expect(res.runs.length).toBe(1);
});

test("toSuiteRun reports exit 124 for a timed-out run regardless of raw exit", () => {
  const run = toSuiteRun(
    { startedAt: 1, durationMs: 2, exitCode: 0, timedOut: true },
    { failingTests: ["x"], passCount: null, failCount: null },
  );
  expect(run.exitCode).toBe(124);
  expect(run.failingTests).toEqual(["x"]);
});

test("crashDetail falls back to a stable message when output is empty", () => {
  expect(crashDetail("")).toBe(
    "suite exited non-zero with no failing-test output",
  );
  expect(crashDetail("  real error text  ")).toBe("real error text");
});

// ── install classification ───────────────────────────────────────────────────

test("installFailureReason: clean exit is null; timeout + non-zero are distinct reasons", () => {
  expect(installFailureReason(0, false)).toBeNull();
  expect(installFailureReason(1, true)).toBe(
    "frozen-lockfile install timed out",
  );
  expect(installFailureReason(1, false)).toBe(
    "frozen-lockfile install failed (exit 1)",
  );
});

// ── gate-phase extraction ────────────────────────────────────────────────────

test("gatePhaseCommand takes the first &&-segment (gate phase, not opentui)", () => {
  const twoPhase =
    "bun scripts/test-gate.ts --timeout=10000 && bun run test:opentui";
  expect(gatePhaseCommand(twoPhase)).toBe(
    "bun scripts/test-gate.ts --timeout=10000",
  );
});

test("gatePhaseCommand returns null for an empty script", () => {
  expect(gatePhaseCommand("")).toBeNull();
  expect(gatePhaseCommand("   ")).toBeNull();
});

test("gatePhaseCommand extracts the real repo's gate phase without the opentui phase", () => {
  const pkg = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
  ) as { scripts: { test: string } };
  const gate = gatePhaseCommand(pkg.scripts.test);
  expect(gate).not.toBeNull();
  expect(gate).toContain("test-gate");
  expect(gate).not.toContain("test:opentui");
});

// ── spool ordering + coalescing ──────────────────────────────────────────────

function entry(file: string, key: string, requestedAt: number): SpoolEntry {
  return {
    file,
    request: {
      key,
      repoDir: "/repo",
      sha: "a".repeat(40),
      toolchain: TC,
      requestedAt,
    },
  };
}

test("planSpool orders groups oldest-first and coalesces same-key files", () => {
  const groups = planSpool([
    entry("r3.json", "keyB", 300),
    entry("r1.json", "keyA", 100),
    entry("r2.json", "keyA", 200),
    entry("r4.json", "keyB", 250),
  ]);
  expect(groups.map((g) => g.key)).toEqual(["keyA", "keyB"]);
  // keyA coalesces both its files; its group requestedAt is the earliest.
  expect(groups[0]?.files).toEqual(["r1.json", "r2.json"]);
  expect(groups[0]?.requestedAt).toBe(100);
  // keyB's earliest is 250 (r4), tie-independent of readdir order.
  expect(groups[1]?.files).toEqual(["r3.json", "r4.json"]);
  expect(groups[1]?.requestedAt).toBe(250);
});

test("planSpool breaks an equal-age tie by key for determinism", () => {
  const groups = planSpool([
    entry("b.json", "keyB", 100),
    entry("a.json", "keyA", 100),
  ]);
  expect(groups.map((g) => g.key)).toEqual(["keyA", "keyB"]);
});

test("planSpool on an empty spool yields no groups", () => {
  expect(planSpool([])).toEqual([]);
});

test("spoolFilesForKey returns exactly the coalesced files for a key", () => {
  const entries = [
    entry("r1.json", "keyA", 100),
    entry("r2.json", "keyB", 200),
    entry("r3.json", "keyA", 300),
  ];
  expect(spoolFilesForKey(entries, "keyA").sort()).toEqual([
    "r1.json",
    "r3.json",
  ]);
  expect(spoolFilesForKey(entries, "missing")).toEqual([]);
});

// ── boot-prune planning ──────────────────────────────────────────────────────

test("planBootPrune reaps distinct parent repos and rm's dangling dirs", () => {
  const plan = planBootPrune([
    { path: "/wt/keeper-baseline--h1-sha1", parentRepo: "/repo/keeper" },
    { path: "/wt/keeper-baseline--h1-sha2", parentRepo: "/repo/keeper" },
    { path: "/wt/keeper-baseline--h2-sha3", parentRepo: "/repo/other" },
    { path: "/wt/keeper-baseline--h9-dead", parentRepo: null },
  ]);
  // One prune per repo reaps all of a repo's scratch siblings — distinct + sorted.
  expect(plan.pruneRepos).toEqual(["/repo/keeper", "/repo/other"]);
  // A dir whose parent repo is gone has no admin entry to prune — rm it directly.
  expect(plan.rmDirs).toEqual(["/wt/keeper-baseline--h9-dead"]);
});

test("planBootPrune on no scratch dirs plans nothing", () => {
  expect(planBootPrune([])).toEqual({ pruneRepos: [], rmDirs: [] });
});

// ── cleanup decision ─────────────────────────────────────────────────────────

test("cleanupPlan always reaps; deletes the spool only once a leaf landed", () => {
  expect(cleanupPlan(true)).toEqual({ reap: true, deleteSpool: true });
  expect(cleanupPlan(false)).toEqual({ reap: true, deleteSpool: false });
});

// ── module shape ─────────────────────────────────────────────────────────────

test("importing the worker module is inert (isMainThread guard) — pure exports only", () => {
  // Reaching this line means the top-level import above did not spawn the worker
  // main() (no parentPort exit, no boot sweep). The decision core is callable.
  expect(typeof parseGateOutput).toBe("function");
  expect(typeof planSpool).toBe("function");
  expect(typeof finalOutcome).toBe("function");
});
