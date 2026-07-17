#!/usr/bin/env bun

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export type FastPhase = "root" | "plan" | "prompt";
export type GatePhase = FastPhase | "slow-git" | "slow-daemon";
export type TestClass = GatePhase | "opentui";

export type PackageSpec = {
  phase: FastPhase;
  name: string;
  cwd: string;
  testDir: string;
  packageJson: string;
};

export type TestManifest = {
  packages: readonly PackageSpec[];
  openTuiFiles: readonly string[];
  slowGitFiles: readonly string[];
  slowDaemonFiles: readonly string[];
};

export const OPEN_TUI_FILES = [
  "test/ansi-to-styled.test.ts",
  "test/live-shell.test.ts",
  "test/note-composer.test.ts",
  "test/dash-app.test.ts",
  "test/dash-shell.test.ts",
] as const;

export const SLOW_GIT_FILES = [
  "test/slow/commit-work-publication-realgit.test.ts",
] as const;

export const SLOW_DAEMON_FILES = ["test/slow/daemon-smoke.test.ts"] as const;

export const TEST_PACKAGES: readonly PackageSpec[] = [
  {
    phase: "root",
    name: "root",
    cwd: ".",
    testDir: "test",
    packageJson: "package.json",
  },
  {
    phase: "plan",
    name: "plan",
    cwd: "plugins/plan",
    testDir: "plugins/plan/test",
    packageJson: "plugins/plan/package.json",
  },
  {
    phase: "prompt",
    name: "prompt",
    cwd: "plugins/prompt",
    testDir: "plugins/prompt/test",
    packageJson: "plugins/prompt/package.json",
  },
] as const;

export const TEST_MANIFEST: TestManifest = {
  packages: TEST_PACKAGES,
  openTuiFiles: OPEN_TUI_FILES,
  slowGitFiles: SLOW_GIT_FILES,
  slowDaemonFiles: SLOW_DAEMON_FILES,
};

export type ManifestAudit = {
  files: Record<TestClass, string[]>;
  discovered: string[];
};

export class ManifestError extends Error {
  constructor(message: string) {
    super(`test manifest: ${message}`);
    this.name = "ManifestError";
  }
}

function posix(path: string): string {
  return path.split(sep).join("/").replace(/^\.\//, "");
}

export function isTestFile(path: string): boolean {
  return /\.(?:test|spec)\.tsx?$/.test(path);
}

export function discoverTests(
  repoRoot: string,
  manifest: TestManifest = TEST_MANIFEST,
): string[] {
  const found = new Set<string>();
  for (const pkg of manifest.packages) {
    const absoluteDir = join(repoRoot, pkg.testDir);
    if (!existsSync(join(repoRoot, pkg.packageJson))) {
      throw new ManifestError(
        `required package is missing: ${pkg.packageJson}`,
      );
    }
    if (!existsSync(absoluteDir)) {
      throw new ManifestError(
        `required test directory is missing: ${pkg.testDir}`,
      );
    }
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile() && isTestFile(entry.name)) {
          found.add(posix(relative(repoRoot, path)));
        }
      }
    };
    walk(absoluteDir);
  }
  return [...found].sort();
}

export function classifyTestFile(
  path: string,
  manifest: TestManifest = TEST_MANIFEST,
): TestClass[] {
  const normalized = posix(path);
  const classes: TestClass[] = [];
  if (manifest.openTuiFiles.includes(normalized)) classes.push("opentui");
  if (manifest.slowGitFiles.includes(normalized)) classes.push("slow-git");
  if (manifest.slowDaemonFiles.includes(normalized)) {
    classes.push("slow-daemon");
  }
  for (const pkg of manifest.packages) {
    const prefix = `${posix(pkg.testDir).replace(/\/$/, "")}/`;
    if (normalized.startsWith(prefix)) classes.push(pkg.phase);
  }
  return classes;
}

export function auditTestManifest(
  discovered: readonly string[],
  manifest: TestManifest = TEST_MANIFEST,
  fileExists: (path: string) => boolean = () => true,
): ManifestAudit {
  if (discovered.length === 0)
    throw new ManifestError("zero test files discovered");
  const requiredPhases: TestClass[] = [
    "root",
    "plan",
    "prompt",
    "opentui",
    "slow-git",
    "slow-daemon",
  ];
  const files: Record<TestClass, string[]> = {
    root: [],
    plan: [],
    prompt: [],
    opentui: [],
    "slow-git": [],
    "slow-daemon": [],
  };
  const requiredFiles: Array<{
    label: string;
    paths: readonly string[];
  }> = [
    { label: "OpenTUI", paths: manifest.openTuiFiles },
    { label: "slow Git", paths: manifest.slowGitFiles },
    { label: "slow daemon", paths: manifest.slowDaemonFiles },
  ];
  for (const required of requiredFiles) {
    for (const expected of required.paths) {
      if (!fileExists(expected) || !discovered.includes(expected)) {
        throw new ManifestError(
          `required ${required.label} file is missing: ${expected}`,
        );
      }
    }
  }
  for (const path of [...discovered].sort()) {
    let classes = classifyTestFile(path, manifest);
    if (
      classes.includes("opentui") ||
      classes.includes("slow-git") ||
      classes.includes("slow-daemon")
    ) {
      classes = classes.filter(
        (classification) =>
          classification === "opentui" ||
          classification === "slow-git" ||
          classification === "slow-daemon",
      );
    }
    if (classes.length === 0)
      throw new ManifestError(`unclassified test file: ${path}`);
    if (classes.length !== 1) {
      throw new ManifestError(
        `test file has overlapping classifications: ${path} (${classes.join(", ")})`,
      );
    }
    files[classes[0]].push(path);
  }
  for (const phase of requiredPhases) {
    if (files[phase].length === 0)
      throw new ManifestError(`required phase has zero files: ${phase}`);
  }
  return { files, discovered: [...discovered].sort() };
}

export function loadTestManifest(repoRoot: string): ManifestAudit {
  const discovered = discoverTests(repoRoot);
  return auditTestManifest(discovered, TEST_MANIFEST, (path) =>
    existsSync(join(repoRoot, path)),
  );
}

export type GateKind = "gate" | "default" | "full";
export type BudgetSpec = {
  objectiveMs: number;
  hardCeilingMs: number;
  hangDeadlineMs: number;
};

export const TEST_BUDGETS: Record<GateKind, BudgetSpec> = {
  gate: { objectiveMs: 10_000, hardCeilingMs: 15_000, hangDeadlineMs: 120_000 },
  default: {
    objectiveMs: 12_000,
    hardCeilingMs: 18_000,
    hangDeadlineMs: 180_000,
  },
  full: { objectiveMs: 20_000, hardCeilingMs: 30_000, hangDeadlineMs: 300_000 },
};

export type ReferenceQualification = { qualified: boolean; reasons: string[] };

export function qualifyReferenceHost(input: {
  platform: string;
  arch: string;
  bunVersion: string;
}): ReferenceQualification {
  const reasons: string[] = [];
  if (input.platform !== "darwin") reasons.push(`platform=${input.platform}`);
  if (input.arch !== "arm64") reasons.push(`arch=${input.arch}`);
  if (input.bunVersion !== "1.3.14") reasons.push(`bun=${input.bunVersion}`);
  return { qualified: reasons.length === 0, reasons };
}

export type StageTiming = {
  name: string;
  startedMs: number;
  endedMs: number;
  ok: boolean;
  reason: string;
};
export type TimingReport = {
  schema: "keeper.test-timing.v1";
  gate: GateKind;
  startedMs: number;
  endedMs: number;
  durationMs: number;
  objectiveMs: number;
  hardCeilingMs: number;
  hangDeadlineMs: number;
  enforcement: "report-only" | "reference" | "unsupported-reference";
  qualifiedReference: boolean;
  qualificationReasons: string[];
  objectiveExceeded: boolean;
  hardCeilingExceeded: boolean;
  stages: Array<StageTiming & { durationMs: number }>;
};

export function buildTimingReport(input: {
  gate: GateKind;
  startedMs: number;
  endedMs: number;
  stages: readonly StageTiming[];
  enforceBudget: boolean;
  qualification: ReferenceQualification;
}): TimingReport {
  if (!Number.isFinite(input.startedMs) || input.endedMs < input.startedMs) {
    throw new Error("test timing: non-monotonic total boundary");
  }
  let cursor = input.startedMs;
  const stages = input.stages.map((stage) => {
    if (
      stage.startedMs < cursor ||
      stage.endedMs < stage.startedMs ||
      stage.endedMs > input.endedMs
    ) {
      throw new Error(
        `test timing: non-monotonic stage boundary: ${stage.name}`,
      );
    }
    cursor = stage.endedMs;
    return { ...stage, durationMs: stage.endedMs - stage.startedMs };
  });
  const budget = TEST_BUDGETS[input.gate];
  const durationMs = input.endedMs - input.startedMs;
  return {
    schema: "keeper.test-timing.v1",
    gate: input.gate,
    startedMs: input.startedMs,
    endedMs: input.endedMs,
    durationMs,
    objectiveMs: budget.objectiveMs,
    hardCeilingMs: budget.hardCeilingMs,
    hangDeadlineMs: budget.hangDeadlineMs,
    enforcement: input.enforceBudget
      ? input.qualification.qualified
        ? "reference"
        : "unsupported-reference"
      : "report-only",
    qualifiedReference: input.qualification.qualified,
    qualificationReasons: [...input.qualification.reasons],
    objectiveExceeded: durationMs > budget.objectiveMs,
    hardCeilingExceeded: durationMs > budget.hardCeilingMs,
    stages,
  };
}

export function timingBudgetFailure(report: TimingReport): string | null {
  if (report.enforcement === "unsupported-reference") {
    return `budget enforcement requires a qualified reference host (${report.qualificationReasons.join(", ")})`;
  }
  if (report.enforcement === "reference" && report.hardCeilingExceeded) {
    return `${report.gate} exceeded hard ceiling ${report.hardCeilingMs}ms (${report.durationMs}ms)`;
  }
  return null;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function renderTimingJunit(report: TimingReport): string {
  const failures =
    report.stages.filter((stage) => !stage.ok).length +
    (timingBudgetFailure(report) ? 1 : 0);
  const cases = report.stages.map(
    (stage) =>
      `<testcase classname="keeper.${report.gate}" name="${xml(stage.name)}" time="${(stage.durationMs / 1000).toFixed(3)}">${stage.ok ? "" : `<failure message="${xml(stage.reason)}"/>`}</testcase>`,
  );
  const budgetFailure = timingBudgetFailure(report);
  if (budgetFailure)
    cases.push(
      `<testcase classname="keeper.${report.gate}" name="performance-budget" time="0.000"><failure message="${xml(budgetFailure)}"/></testcase>`,
    );
  return `<?xml version="1.0" encoding="UTF-8"?><testsuite name="keeper-${report.gate}" tests="${cases.length}" failures="${failures}" time="${(report.durationMs / 1000).toFixed(3)}">${cases.join("")}</testsuite>\n`;
}

export function emitTimingArtifacts(
  report: TimingReport,
  output: { write(chunk: string): unknown } = process.stdout,
  artifactDir = process.env.KEEPER_TEST_TIMING_DIR,
): void {
  const json = `${JSON.stringify(report)}\n`;
  output.write(`[test-timing-json] ${json}`);
  output.write(`[test-timing-junit] ${renderTimingJunit(report)}`);
  if (artifactDir) {
    const dir = resolve(artifactDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${report.gate}.json`), json);
    writeFileSync(join(dir, `${report.gate}.xml`), renderTimingJunit(report));
  }
}

export function repoRootFromScripts(): string {
  return dirname(import.meta.dir);
}
