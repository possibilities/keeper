import { describe, expect, test } from "bun:test";
import { buildDefaultPlan } from "../scripts/test-default";
import {
  buildChildEnv,
  buildSuitePlan,
  classifyVerdict,
  executeSuitePlan,
  type ProcessResult,
  parseBail,
  parseSuiteTimeoutMs,
} from "../scripts/test-full";

function take<T>(values: T[]): T {
  const value = values.shift();
  if (value === undefined) throw new Error("fixture exhausted");
  return value;
}

describe("default and full package plans", () => {
  test("default owns root and serial OpenTUI with report-all-compatible stages", () => {
    const plan = buildDefaultPlan();
    expect(plan.map((stage) => stage.name)).toEqual(["root", "opentui"]);
    expect(plan[0].cmd).toEqual(["bun", "run", "test:gate"]);
    expect(plan[1].cmd.slice(0, 2)).toEqual(["bun", "test"]);
    expect(plan[1].cmd).toContain("./test/live-shell.test.ts");
  });

  test("covers root, plan, and prompt exactly once in order", () => {
    const plan = buildSuitePlan({ suiteTimeoutMs: 42_000 });
    expect(plan.map((stage) => stage.name)).toEqual(["root", "plan", "prompt"]);
    expect(plan.map((stage) => stage.cwd)).toEqual([
      ".",
      "plugins/plan",
      "plugins/prompt",
    ]);
    expect(plan.map((stage) => stage.timeoutMs)).toEqual([
      42_000, 42_000, 42_000,
    ]);
  });

  test("all children scrub obsolete slow tiers and nested budget/artifact ownership", () => {
    for (const stage of buildSuitePlan()) {
      expect(stage.envPatch).toEqual({
        KEEPER_RUN_SLOW: undefined,
        KEEPER_PLAN_RUN_SLOW: undefined,
        KEEPER_TEST_ENFORCE_BUDGET: undefined,
        KEEPER_TEST_TIMING_DIR: undefined,
      });
    }
  });

  test("uses explicit named phases for plugin package coverage", () => {
    const plan = buildSuitePlan();
    expect(plan[0].cmd).toEqual(["bun", "run", "test"]);
    expect(plan[1].cmd).toContain("--phase=plan");
    expect(plan[2].cmd).toContain("--phase=prompt");
  });
});

describe("full runner seam", () => {
  test("runs serially and reports all outcomes when bail is off", async () => {
    const calls: string[] = [];
    const clock = [0, 3, 3, 8, 8, 13];
    const results: ProcessResult[] = [
      { exitCode: 0 },
      { exitCode: 2 },
      { exitCode: 0 },
    ];
    const executions = await executeSuitePlan(buildSuitePlan(), {
      run: async (stage) => {
        calls.push(stage.name);
        return take(results);
      },
      now: () => take(clock),
      bail: false,
    });
    expect(calls).toEqual(["root", "plan", "prompt"]);
    expect(executions.map((entry) => entry.verdict.ok)).toEqual([
      true,
      false,
      true,
    ]);
  });

  test("bail stops after the first failure", async () => {
    const executions = await executeSuitePlan(buildSuitePlan(), {
      run: async () => ({ exitCode: 1 }),
      now: (() => {
        let now = 0;
        return () => now++;
      })(),
      bail: true,
    });
    expect(executions).toHaveLength(1);
  });

  test("rejects a non-monotonic injected clock", async () => {
    const clock = [2, 1];
    await expect(
      executeSuitePlan(buildSuitePlan().slice(0, 1), {
        run: async () => ({ exitCode: 0 }),
        now: () => take(clock),
        bail: false,
      }),
    ).rejects.toThrow("non-monotonic clock");
  });
});

describe("process verdicts and env", () => {
  test("distinguishes exit, signal, timeout, spawn failure, and cleanup failure", () => {
    expect(classifyVerdict({ exitCode: 0 })).toEqual({
      ok: true,
      reason: "passed",
    });
    expect(classifyVerdict({ exitCode: 2 }).reason).toBe("exited 2");
    expect(classifyVerdict({ exitCode: null, signal: "SIGTERM" }).reason).toBe(
      "terminated by SIGTERM",
    );
    expect(
      classifyVerdict({ exitCode: null, timedOut: true }).reason,
    ).toContain("hang deadline");
    expect(
      classifyVerdict({ exitCode: null, spawnError: "ENOENT" }).reason,
    ).toContain("missing binary");
    expect(
      classifyVerdict({ exitCode: 0, cleanupError: "EPERM" }).reason,
    ).toContain("cleanup failed");
  });

  test("env patches delete ambient ownership switches", () => {
    expect(
      buildChildEnv(
        { KEEP: "yes", KEEPER_RUN_SLOW: "1" },
        { KEEPER_RUN_SLOW: undefined },
      ),
    ).toEqual({ KEEP: "yes" });
  });

  test("parsers pin bail and bounded timeout defaults", () => {
    expect(parseBail("1")).toBe(true);
    expect(parseBail("")).toBe(false);
    expect(parseSuiteTimeoutMs("42")).toBe(42_000);
    expect(parseSuiteTimeoutMs("bad")).toBe(180_000);
  });
});
