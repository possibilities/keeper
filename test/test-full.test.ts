/**
 * Tests for the serial four-suite gate (`scripts/test-full.ts`). The runner
 * itself is a thin spawner — a live `bun run test:full` is the integration proof.
 * These drive the pure seam in-process: the suite plan (order, cwd, env
 * scrub/inject, timeout budgets), env patching, verdict classification, bail, and
 * the env parsers. No real second suite is spawned.
 */

import { describe, expect, test } from "bun:test";
import {
  buildChildEnv,
  buildSuitePlan,
  classifyVerdict,
  parseBail,
  parseSuiteTimeoutMs,
  shouldContinue,
  type Verdict,
} from "../scripts/test-full";

const T = 300_000;

describe("buildSuitePlan", () => {
  test("runs the four suites serially with prompt last", () => {
    expect(
      buildSuitePlan("fast", { suiteTimeoutMs: T }).map((s) => s.name),
    ).toEqual(["root", "plan", "python", "prompt"]);
  });

  test("each suite runs in its own cwd (bunfig/import resolution is cwd-relative)", () => {
    const byName = Object.fromEntries(
      buildSuitePlan("fast", { suiteTimeoutMs: T }).map((s) => [s.name, s.cwd]),
    );
    expect(byName).toEqual({
      root: ".",
      plan: "plugins/plan",
      python: ".",
      prompt: "plugins/prompt",
    });
  });

  test("fast mode scrubs BOTH slow gates from every child env", () => {
    for (const spec of buildSuitePlan("fast", { suiteTimeoutMs: T })) {
      expect(spec.envPatch.KEEPER_RUN_SLOW).toBeUndefined();
      expect(spec.envPatch.KEEPER_PLAN_RUN_SLOW).toBeUndefined();
      expect("KEEPER_RUN_SLOW" in spec.envPatch).toBe(true);
      expect("KEEPER_PLAN_RUN_SLOW" in spec.envPatch).toBe(true);
    }
  });

  test("slow mode injects KEEPER_RUN_SLOW into root and swaps plan to test:slow", () => {
    const plan = buildSuitePlan("slow", { suiteTimeoutMs: T });
    const root = plan.find((s) => s.name === "root");
    const planSuite = plan.find((s) => s.name === "plan");
    if (root === undefined || planSuite === undefined) {
      throw new Error("expected root + plan suites in the plan");
    }

    expect(root.envPatch.KEEPER_RUN_SLOW).toBe("1");
    expect(root.envPatch.KEEPER_PLAN_RUN_SLOW).toBeUndefined();

    expect(planSuite.cmd).toEqual(["bun", "run", "test:slow"]);
    expect(planSuite.envPatch.KEEPER_PLAN_RUN_SLOW).toBe("1");
    expect(planSuite.envPatch.KEEPER_RUN_SLOW).toBeUndefined();
  });

  test("slow mode leaves python and prompt scrubbed (no slow tier)", () => {
    const plan = buildSuitePlan("slow", { suiteTimeoutMs: T });
    for (const name of ["python", "prompt"]) {
      const spec = plan.find((s) => s.name === name);
      if (spec === undefined) {
        throw new Error(`expected ${name} suite in the plan`);
      }
      expect(spec.envPatch.KEEPER_RUN_SLOW).toBeUndefined();
      expect(spec.envPatch.KEEPER_PLAN_RUN_SLOW).toBeUndefined();
    }
    expect(plan.find((s) => s.name === "prompt")?.cmd).toEqual([
      "bun",
      "run",
      "test",
    ]);
  });

  test("fast mode applies the per-suite timeout to every suite", () => {
    for (const spec of buildSuitePlan("fast", { suiteTimeoutMs: T })) {
      expect(spec.timeoutMs).toBe(T);
    }
  });

  test("slow root gets a 600s floor while other suites keep the base budget", () => {
    const plan = buildSuitePlan("slow", { suiteTimeoutMs: T });
    expect(plan.find((s) => s.name === "root")?.timeoutMs).toBe(600_000);
    expect(plan.find((s) => s.name === "plan")?.timeoutMs).toBe(T);
  });

  test("slow root floor never shrinks a larger configured budget", () => {
    const plan = buildSuitePlan("slow", { suiteTimeoutMs: 900_000 });
    expect(plan.find((s) => s.name === "root")?.timeoutMs).toBe(900_000);
  });

  test("only the python suite carries the zero-tests scan", () => {
    for (const spec of buildSuitePlan("fast", { suiteTimeoutMs: T })) {
      expect(Boolean(spec.zeroTestsScan)).toBe(spec.name === "python");
    }
  });

  test("python runs unittest discover against tests/ (cwd repo root)", () => {
    const python = buildSuitePlan("fast", { suiteTimeoutMs: T }).find(
      (s) => s.name === "python",
    );
    if (python === undefined) {
      throw new Error("expected python suite in the plan");
    }
    expect(python.cmd).toEqual([
      "python3",
      "-m",
      "unittest",
      "discover",
      "-s",
      "tests",
    ]);
    expect(python.cwd).toBe(".");
  });
});

describe("buildChildEnv", () => {
  test("deletes keys with an undefined patch value (ambient tier can't leak in)", () => {
    const env = buildChildEnv(
      { KEEPER_RUN_SLOW: "1", KEEPER_PLAN_RUN_SLOW: "1", PATH: "/bin" },
      { KEEPER_RUN_SLOW: undefined, KEEPER_PLAN_RUN_SLOW: undefined },
    );
    expect("KEEPER_RUN_SLOW" in env).toBe(false);
    expect("KEEPER_PLAN_RUN_SLOW" in env).toBe(false);
    expect(env.PATH).toBe("/bin");
  });

  test("sets keys with a defined patch value", () => {
    const env = buildChildEnv({ PATH: "/bin" }, { KEEPER_RUN_SLOW: "1" });
    expect(env.KEEPER_RUN_SLOW).toBe("1");
  });
});

describe("classifyVerdict", () => {
  test("passes on exit 0", () => {
    expect(classifyVerdict({ exitCode: 0 })).toEqual({
      ok: true,
      reason: "passed",
    });
  });

  test("fails on a non-zero exit (e.g. unittest collection-error exit 2)", () => {
    expect(classifyVerdict({ exitCode: 2 })).toEqual({
      ok: false,
      reason: "exited 2",
    });
  });

  test("classifies a spawn ENOENT as a distinct missing-binary failure", () => {
    expect(classifyVerdict({ spawnError: "ENOENT", exitCode: null })).toEqual({
      ok: false,
      reason: "missing binary (spawn ENOENT)",
    });
  });

  test("surfaces a non-ENOENT spawn error verbatim", () => {
    const v = classifyVerdict({ spawnError: "EACCES", exitCode: null });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("EACCES");
  });

  test("classifies a timeout as a distinct failure even with a zero exit", () => {
    expect(classifyVerdict({ timedOut: true, exitCode: 0 })).toEqual({
      ok: false,
      reason: "timed out (process group killed)",
    });
  });

  test("classifies a zero-tests scan hit as a failure despite exit 0", () => {
    expect(classifyVerdict({ exitCode: 0, zeroTestsDetected: true })).toEqual({
      ok: false,
      reason: "ran 0 tests",
    });
  });
});

describe("shouldContinue (bail)", () => {
  const pass: Verdict = { ok: true, reason: "passed" };
  const fail: Verdict = { ok: false, reason: "exited 1" };

  test("with bail off, always continues", () => {
    expect(shouldContinue([fail], false)).toBe(true);
  });

  test("with bail on, continues while everything passes", () => {
    expect(shouldContinue([pass, pass], true)).toBe(true);
  });

  test("with bail on, cuts after the first failure", () => {
    expect(shouldContinue([pass, fail], true)).toBe(false);
  });
});

describe("env parsers", () => {
  test("parseBail: any non-empty value is on, empty/unset is off", () => {
    expect(parseBail("1")).toBe(true);
    expect(parseBail("anything")).toBe(true);
    expect(parseBail("")).toBe(false);
    expect(parseBail(undefined)).toBe(false);
  });

  test("parseSuiteTimeoutMs: seconds → ms, default on a bad value", () => {
    expect(parseSuiteTimeoutMs("120")).toBe(120_000);
    expect(parseSuiteTimeoutMs(undefined)).toBe(300_000);
    expect(parseSuiteTimeoutMs("")).toBe(300_000);
    expect(parseSuiteTimeoutMs("0")).toBe(300_000);
    expect(parseSuiteTimeoutMs("nope")).toBe(300_000);
  });
});
