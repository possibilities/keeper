#!/usr/bin/env bun

import { join } from "node:path";
import { executeSuitePlan, runProcessGroup, type SuiteSpec } from "./test-full";
import {
  buildTimingReport,
  emitTimingArtifacts,
  OPEN_TUI_FILES,
  qualifyReferenceHost,
  type StageTiming,
  TEST_BUDGETS,
  timingBudgetFailure,
} from "./test-manifest";

export function buildDefaultPlan(): SuiteSpec[] {
  const envPatch = {
    KEEPER_TEST_ENFORCE_BUDGET: undefined,
    KEEPER_TEST_TIMING_DIR: undefined,
  };
  return [
    {
      name: "root",
      cmd: ["bun", "run", "test:gate"],
      cwd: ".",
      envPatch: { ...envPatch },
      timeoutMs: TEST_BUDGETS.gate.hangDeadlineMs,
    },
    {
      name: "opentui",
      cmd: ["bun", "test", ...OPEN_TUI_FILES.map((file) => `./${file}`)],
      cwd: ".",
      envPatch: { ...envPatch, OTUI_USE_CONSOLE: "false" },
      timeoutMs: TEST_BUDGETS.gate.hangDeadlineMs,
    },
  ];
}

async function main(): Promise<number> {
  const repoRoot = join(import.meta.dir, "..");
  const plan = buildDefaultPlan();
  const startedMs = performance.now();
  const executions = await executeSuitePlan(plan, {
    run: (spec) => runProcessGroup(spec, repoRoot),
    now: () => performance.now(),
    bail: false,
  });
  executions.forEach((entry) => {
    process.stdout.write(
      `--- ${entry.spec.name}: ${entry.verdict.ok ? "PASS" : "FAIL"} (${entry.verdict.reason}) ---\n`,
    );
  });
  const endedMs = performance.now();
  const stages: StageTiming[] = executions.map((entry) => ({
    name: entry.spec.name,
    startedMs: entry.startedMs,
    endedMs: entry.endedMs,
    ok: entry.verdict.ok,
    reason: entry.verdict.reason,
  }));
  const report = buildTimingReport({
    gate: "default",
    startedMs,
    endedMs,
    stages,
    enforceBudget: process.env.KEEPER_TEST_ENFORCE_BUDGET === "1",
    qualification: qualifyReferenceHost({
      platform: process.platform,
      arch: process.arch,
      bunVersion: Bun.version,
    }),
  });
  emitTimingArtifacts(report);
  const budgetFailure = timingBudgetFailure(report);
  if (report.objectiveExceeded)
    process.stderr.write(
      `[test-default] objective ${report.objectiveMs}ms exceeded (${report.durationMs}ms); ${budgetFailure ? "FAIL" : "warning only"}\n`,
    );
  if (budgetFailure) process.stderr.write(`[test-default] ${budgetFailure}\n`);
  return executions.length === 2 &&
    executions.every((entry) => entry.verdict.ok) &&
    !budgetFailure
    ? 0
    : 1;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`[test-default] fatal: ${error}\n`);
      process.exit(1);
    });
}
