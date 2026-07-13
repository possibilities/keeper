#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  buildTimingReport,
  emitTimingArtifacts,
  qualifyReferenceHost,
  type StageTiming,
  TEST_BUDGETS,
  timingBudgetFailure,
} from "./test-manifest";

export type SuiteSpec = {
  name: string;
  cmd: string[];
  cwd: string;
  envPatch: Record<string, string | undefined>;
  timeoutMs: number;
};

export type ProcessResult = {
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  spawnError?: string;
  timedOut?: boolean;
  cleanupError?: string;
};

export type Verdict = { ok: boolean; reason: string };

const SCRUBBED_CHILD_ENV: Record<string, undefined> = {
  KEEPER_RUN_SLOW: undefined,
  KEEPER_PLAN_RUN_SLOW: undefined,
  KEEPER_TEST_ENFORCE_BUDGET: undefined,
  KEEPER_TEST_TIMING_DIR: undefined,
};

export function buildSuitePlan(
  opts: { suiteTimeoutMs?: number } = {},
): SuiteSpec[] {
  const timeoutMs = opts.suiteTimeoutMs ?? TEST_BUDGETS.default.hangDeadlineMs;
  return [
    {
      name: "root",
      cmd: ["bun", "run", "test"],
      cwd: ".",
      envPatch: { ...SCRUBBED_CHILD_ENV },
      timeoutMs,
    },
    {
      name: "plan",
      cmd: [
        "bun",
        "../../scripts/test-gate.ts",
        "--phase=plan",
        "--timeout=10000",
      ],
      cwd: "plugins/plan",
      envPatch: { ...SCRUBBED_CHILD_ENV },
      timeoutMs,
    },
    {
      name: "prompt",
      cmd: [
        "bun",
        "../../scripts/test-gate.ts",
        "--phase=prompt",
        "--timeout=10000",
      ],
      cwd: "plugins/prompt",
      envPatch: { ...SCRUBBED_CHILD_ENV },
      timeoutMs,
    },
  ];
}

export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  patch: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

export function classifyVerdict(result: ProcessResult): Verdict {
  if (result.spawnError)
    return {
      ok: false,
      reason:
        result.spawnError === "ENOENT"
          ? "missing binary (spawn ENOENT)"
          : `spawn error: ${result.spawnError}`,
    };
  if (result.timedOut)
    return {
      ok: false,
      reason: "hang deadline exceeded (process group killed)",
    };
  if (result.cleanupError)
    return { ok: false, reason: `cleanup failed: ${result.cleanupError}` };
  if (result.signal)
    return { ok: false, reason: `terminated by ${result.signal}` };
  if (result.exitCode === 0) return { ok: true, reason: "passed" };
  return { ok: false, reason: `exited ${result.exitCode ?? "unknown"}` };
}

export function shouldContinue(
  verdicts: readonly Verdict[],
  bail: boolean,
): boolean {
  return !bail || verdicts.every((verdict) => verdict.ok);
}

export function parseBail(raw: string | undefined): boolean {
  return raw !== undefined && raw.length > 0;
}

export function parseSuiteTimeoutMs(raw: string | undefined): number {
  if (!raw) return TEST_BUDGETS.default.hangDeadlineMs;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.floor(seconds * 1000)
    : TEST_BUDGETS.default.hangDeadlineMs;
}

export type SuiteExecution = {
  spec: SuiteSpec;
  verdict: Verdict;
  startedMs: number;
  endedMs: number;
};

export async function executeSuitePlan(
  plan: readonly SuiteSpec[],
  deps: {
    run: (spec: SuiteSpec) => Promise<ProcessResult>;
    now: () => number;
    bail: boolean;
  },
): Promise<SuiteExecution[]> {
  const executions: SuiteExecution[] = [];
  for (const spec of plan) {
    if (
      !shouldContinue(
        executions.map((entry) => entry.verdict),
        deps.bail,
      )
    )
      break;
    const startedMs = deps.now();
    const verdict = classifyVerdict(await deps.run(spec));
    const endedMs = deps.now();
    if (endedMs < startedMs)
      throw new Error(`non-monotonic clock while running ${spec.name}`);
    executions.push({ spec, verdict, startedMs, endedMs });
  }
  return executions;
}

let currentChildPid: number | null = null;

function killGroup(pid: number): string | undefined {
  try {
    process.kill(-pid, "SIGKILL");
    return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? undefined : String(error);
  }
}

export async function runProcessGroup(
  spec: SuiteSpec,
  repoRoot: string,
): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    const child = spawn(spec.cmd[0], spec.cmd.slice(1), {
      cwd: join(repoRoot, spec.cwd),
      env: buildChildEnv(process.env, spec.envPatch),
      detached: true,
      stdio: "inherit",
    });
    currentChildPid = child.pid ?? null;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killGroup(child.pid);
    }, spec.timeoutMs);
    const finish = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const cleanupError =
        child.pid === undefined ? undefined : killGroup(child.pid);
      currentChildPid = null;
      resolve({ ...result, timedOut, cleanupError });
    };
    child.once("error", (error: NodeJS.ErrnoException) =>
      finish({ spawnError: error.code ?? String(error), exitCode: null }),
    );
    child.once("exit", (exitCode, signal) => finish({ exitCode, signal }));
  });
}

async function main(): Promise<number> {
  const repoRoot = join(import.meta.dir, "..");
  const plan = buildSuitePlan({
    suiteTimeoutMs: parseSuiteTimeoutMs(
      process.env.KEEPER_TEST_SUITE_TIMEOUT_S,
    ),
  });
  const startedMs = performance.now();
  process.once("SIGINT", () => {
    if (currentChildPid !== null) killGroup(currentChildPid);
    process.exit(130);
  });
  const executions = await executeSuitePlan(plan, {
    run: (spec) => runProcessGroup(spec, repoRoot),
    now: () => performance.now(),
    bail: parseBail(process.env.KEEPER_TEST_BAIL),
  });
  for (const entry of executions) {
    process.stdout.write(
      `--- ${entry.spec.name}: ${entry.verdict.ok ? "PASS" : "FAIL"} (${entry.verdict.reason}) ---\n`,
    );
  }
  for (const skipped of plan.slice(executions.length))
    process.stdout.write(`--- ${skipped.name}: SKIP (bail) ---\n`);
  const endedMs = performance.now();
  const stages: StageTiming[] = executions.map((entry) => ({
    name: entry.spec.name,
    startedMs: entry.startedMs,
    endedMs: entry.endedMs,
    ok: entry.verdict.ok,
    reason: entry.verdict.reason,
  }));
  const report = buildTimingReport({
    gate: "full",
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
      `[test-full] objective ${report.objectiveMs}ms exceeded (${report.durationMs}ms); ${budgetFailure ? "FAIL" : "warning only"}\n`,
    );
  if (budgetFailure) process.stderr.write(`[test-full] ${budgetFailure}\n`);
  return executions.length === plan.length &&
    executions.every((entry) => entry.verdict.ok) &&
    !budgetFailure
    ? 0
    : 1;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`[test-full] fatal: ${error}\n`);
      process.exit(1);
    });
}
