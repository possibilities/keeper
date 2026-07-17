#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { relative } from "node:path";
import { formatPolicyViolations, lintFastTests } from "./lint-fast-tests";
import { TEST_GATE_MARKER, TEST_GATE_MARKER_VALUE } from "./test-entrypoint";
import { classifyVerdict, runProcessGroup, type SuiteSpec } from "./test-full";
import {
  buildTimingReport,
  emitTimingArtifacts,
  type GatePhase,
  loadTestManifest,
  qualifyReferenceHost,
  repoRootFromScripts,
  TEST_BUDGETS,
  timingBudgetFailure,
} from "./test-manifest";

const DEFAULT_PARALLEL = 5;
const ORPHAN_MIN_AGE_SEC = 120;

export function buildBunTestArgs(
  forwarded: string[],
  parallelEnv: string | undefined,
): string[] {
  const hasParallel = forwarded.some(
    (arg) => arg === "--parallel" || arg.startsWith("--parallel="),
  );
  const hasNoOrphans = forwarded.includes("--no-orphans");
  const args = ["test", ...forwarded];
  if (!hasParallel) args.push(`--parallel=${normalizeParallel(parallelEnv)}`);
  if (!hasNoOrphans) args.push("--no-orphans");
  return args;
}

function normalizeParallel(raw: string | undefined): number {
  if (!raw) return DEFAULT_PARALLEL;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_PARALLEL;
}

export type ProcRow = {
  pid: number;
  ppid: number;
  uid: number;
  etime: string;
  args: string;
};

export function parseEtimeSeconds(etime: string): number {
  const [daysRaw, clock] = etime.includes("-")
    ? etime.split("-")
    : ["0", etime];
  const parts = clock.split(":").map((part) => Number.parseInt(part, 10));
  if (parts.some(Number.isNaN) || (parts.length !== 2 && parts.length !== 3))
    return 0;
  const [hours, minutes, seconds] =
    parts.length === 3 ? parts : [0, parts[0], parts[1]];
  return (
    (((Number.parseInt(daysRaw, 10) || 0) * 24 + hours) * 60 + minutes) * 60 +
    seconds
  );
}

export function isOrphanTestWorker(
  row: ProcRow,
  selfPid: number,
  selfUid: number,
  minAgeSec: number,
): boolean {
  if (
    row.pid === selfPid ||
    row.ppid !== 1 ||
    selfUid < 0 ||
    row.uid !== selfUid
  )
    return false;
  const tokens = row.args.trim().split(/\s+/);
  return (
    tokens[0]?.split("/").pop() === "bun" &&
    tokens[1] === "test" &&
    tokens.includes("--test-worker") &&
    parseEtimeSeconds(row.etime) >= minAgeSec
  );
}

function sweepOrphanTestWorkers(minAgeSec = ORPHAN_MIN_AGE_SEC): void {
  const selfUid = process.getuid?.() ?? -1;
  let output: string;
  try {
    output = execFileSync("ps", ["-axo", "pid=,ppid=,uid=,etime=,args="], {
      encoding: "utf8",
    });
  } catch (error) {
    process.stderr.write(`[test-gate] orphan sweep skipped: ${error}\n`);
    return;
  }
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const row: ProcRow = {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      uid: Number(match[3]),
      etime: match[4],
      args: match[5],
    };
    if (!isOrphanTestWorker(row, process.pid, selfUid, minAgeSec)) continue;
    try {
      process.kill(row.pid, "SIGKILL");
    } catch {
      // The worker exited after the snapshot.
    }
  }
}

export function buildBunTestEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    BUN_FEATURE_FLAG_NO_ORPHANS: "1",
    [TEST_GATE_MARKER]: TEST_GATE_MARKER_VALUE,
  };
}

export function parseGateArgs(argv: readonly string[]): {
  phase: GatePhase;
  forwarded: string[];
} {
  let phase: GatePhase = "root";
  const forwarded: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = arg.startsWith("--phase=")
      ? arg.slice("--phase=".length)
      : arg === "--phase"
        ? argv[++index]
        : undefined;
    if (value !== undefined) {
      if (
        value !== "root" &&
        value !== "plan" &&
        value !== "prompt" &&
        value !== "slow-git" &&
        value !== "slow-daemon"
      ) {
        throw new Error(`unknown test phase: ${value}`);
      }
      phase = value;
    } else forwarded.push(arg);
  }
  return { phase, forwarded };
}

export function phaseTargets(
  phase: GatePhase,
  repoRoot: string,
): { cwd: string; files: string[] } {
  const audit = loadTestManifest(repoRoot);
  const cwd =
    phase === "root" || phase === "slow-git" || phase === "slow-daemon"
      ? "."
      : `plugins/${phase}`;
  return {
    cwd,
    files: audit.files[phase].map((file) =>
      cwd === "." ? `./${file}` : `./${relative(cwd, file)}`,
    ),
  };
}

async function main(): Promise<number> {
  const repoRoot = repoRootFromScripts();
  const { phase, forwarded } = parseGateArgs(Bun.argv.slice(2));
  const startedMs = performance.now();
  const violations = lintFastTests(repoRoot);
  if (violations.length > 0) {
    process.stderr.write(
      `fast-test policy: FAIL (${violations.length})\n${formatPolicyViolations(violations)}\n`,
    );
    return 1;
  }
  sweepOrphanTestWorkers();
  const target = phaseTargets(phase, repoRoot);
  const args = buildBunTestArgs(
    [...forwarded, ...target.files],
    process.env.KEEPER_TEST_PARALLEL,
  );
  const spec: SuiteSpec = {
    name: phase,
    cmd: ["bun", ...args],
    cwd: target.cwd,
    envPatch: buildBunTestEnv({}),
    timeoutMs: TEST_BUDGETS.gate.hangDeadlineMs,
  };
  const stageStartedMs = performance.now();
  const verdict = classifyVerdict(await runProcessGroup(spec, repoRoot));
  const endedMs = performance.now();
  const report = buildTimingReport({
    gate: "gate",
    startedMs,
    endedMs,
    stages: [
      {
        name: phase,
        startedMs: stageStartedMs,
        endedMs,
        ok: verdict.ok,
        reason: verdict.reason,
      },
    ],
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
      `[test-gate] objective ${report.objectiveMs}ms exceeded (${report.durationMs}ms); ${budgetFailure ? "FAIL" : "warning only"}\n`,
    );
  if (budgetFailure) process.stderr.write(`[test-gate] ${budgetFailure}\n`);
  return verdict.ok && !budgetFailure ? 0 : 1;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`[test-gate] fatal: ${error}\n`);
      process.exit(1);
    });
}
