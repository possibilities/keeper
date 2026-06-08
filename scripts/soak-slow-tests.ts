#!/usr/bin/env bun
/**
 * Flake-soak harness for the parallel `test:slow` tier (epic fn-747).
 *
 * The slow tier (`integration` + `daemon` + `plan-worker`) was historically
 * carved into a SERIAL split (commit 9558382) because `plan-worker`'s
 * `@parcel/watcher` native NAPI addon panicked under whole-suite `--parallel`.
 * fn-747 reintroduces `--parallel` over the lighter tier (Bun 1.3.14's
 * parallel/isolate fix in hand) — and ships THIS harness as the durable guard
 * that keeps the tier from silently regressing to flaky: it reruns the tier N
 * times and reports any failure, formalizing the "0 flakes over N consecutive
 * runs" manual ritual (fn-722 / fn-683) at 20x by default.
 *
 * TIER COMPOSITION (verified, fn-747.1 — the spec's FALLBACK split): a 20x
 * soak proved `plan-worker` STILL panics intermittently under `--parallel`
 * (`panic: NAPI FATAL ERROR: napi_create_object` / worker SIGTRAP — the exact
 * `@parcel/watcher` native-addon crash from commit 9558382; Bun 1.3.14's
 * parallel/isolate fix does NOT cover this addon). So `plan-worker` STAYS
 * SERIAL. `integration` + `daemon` are the daemon-spawning pair and run
 * `--parallel` together. The two phases mirrored here are exactly what
 * `test:slow` ships:
 *   1. `integration` + `daemon` --parallel
 *   2. `plan-worker` serial
 * (Aside: `integration`'s 30s daemon-boot tests are ALSO contention-sensitive
 * to whole-box load — fn-722.7's 10s→36s spike — so a soak run that times out
 * on a saturated box is an environmental flake, not a tier regression. The
 * harness gates on pass/fail per the spec; soak on a QUIET box for a clean
 * flake rate.)
 *
 * Design (per the spec):
 *   - SEQUENTIAL iterations. Parallel iterations would multiply socket
 *     collisions and become a flake source themselves; the harness measures
 *     the tier's OWN intra-run parallelism, not N tiers fighting each other.
 *   - RUN-ALL by default (don't stop on first fail) so a full N yields a flake
 *     RATE (e.g. 2/20), not just a yes/no. `--bail` / `-b` stops on first fail.
 *   - Each iteration shells a FRESH `bun test <tier files> --parallel` via
 *     `Bun.spawn` — NOT `bun test --rerun-each`, which has a known
 *     beforeEach/afterEach count bug (oven-sh/bun#13493).
 *   - Gates on PASS/FAIL ONLY. Wall-time is informational (fn-722.7 saw the
 *     tier slip 10s→36s under box load; timing is never a hard threshold).
 *   - Exits non-zero IFF any iteration failed.
 *
 * It does NOT spawn its own daemon or invent its own sandbox — it only reruns
 * `bun test`, so it inherits the slow test files' own six-path `KEEPER_*`
 * sandboxing and never pollutes the real feed.
 *
 * Mirrors `scripts/backstop-stats.ts`: a pure aggregator core + a padded
 * summary table renderer.
 *
 * Usage:
 *   bun scripts/soak-slow-tests.ts            # 20 runs (default), run-all
 *   bun scripts/soak-slow-tests.ts 50         # 50 runs
 *   SOAK_RUNS=50 bun scripts/soak-slow-tests.ts
 *   bun scripts/soak-slow-tests.ts 20 --bail  # stop on first failure
 */

import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The slow tier's two phases, mirroring `test:slow` (the fn-747.1 FALLBACK —
 * see the file header for why `plan-worker` stays serial):
 *   1. `integration` + `daemon` run --parallel (the daemon-spawning pair).
 *   2. `plan-worker` runs ALONE/serial (its `@parcel/watcher` NAPI addon
 *      panics intermittently under --parallel; commit 9558382's reason).
 * Each phase is its own `bun test` invocation; a phase failing fails the run.
 */
const TIER_PHASES: { argv: string[]; label: string }[] = [
  {
    argv: [
      "test/integration.test.ts",
      "test/daemon.test.ts",
      "--parallel",
      "--timeout=30000",
    ],
    label: "integration+daemon --parallel",
  },
  {
    argv: ["test/plan-worker.test.ts", "--timeout=30000"],
    label: "plan-worker (serial)",
  },
];

/** One iteration's outcome. */
export interface RunResult {
  run: number;
  exitCode: number;
  passed: boolean;
  elapsedMs: number;
  /** Where this run's full stderr was captured (for triaging a failure). */
  logPath: string;
}

export interface SoakConfig {
  runs: number;
  bail: boolean;
}

/** Parse argv/env into a soak config. argv `N` and `--bail`/`-b`; `SOAK_RUNS` env. */
export function parseConfig(argv: string[], env: NodeJS.ProcessEnv): SoakConfig {
  let runs = 20;
  let bail = false;
  const envRuns = env.SOAK_RUNS;
  if (envRuns !== undefined && envRuns.trim() !== "") {
    const n = Number.parseInt(envRuns, 10);
    if (Number.isFinite(n) && n > 0) runs = n;
  }
  for (const arg of argv) {
    if (arg === "--bail" || arg === "-b") {
      bail = true;
      continue;
    }
    const n = Number.parseInt(arg, 10);
    if (Number.isFinite(n) && n > 0 && String(n) === arg.trim()) {
      runs = n;
    }
  }
  return { runs, bail };
}

/**
 * Aggregate run results into the summary shape. Pure — the renderer and any
 * test both call this. A run "failed" iff its exit code was non-zero.
 */
export interface SoakSummary {
  total: number;
  passes: number;
  fails: number;
  /** 1-indexed run numbers that failed (stable ascending order). */
  failedRuns: number[];
  /** PASS iff zero fails; else FLAKY. */
  verdict: "PASS" | "FLAKY";
  /** Wall-time stats (informational only — never a gate). */
  minMs: number | null;
  maxMs: number | null;
  meanMs: number | null;
}

export function summarize(results: RunResult[]): SoakSummary {
  const total = results.length;
  const failedRuns = results
    .filter((r) => !r.passed)
    .map((r) => r.run)
    .sort((a, b) => a - b);
  const fails = failedRuns.length;
  const elapsed = results.map((r) => r.elapsedMs);
  const minMs = elapsed.length ? Math.min(...elapsed) : null;
  const maxMs = elapsed.length ? Math.max(...elapsed) : null;
  const meanMs = elapsed.length
    ? elapsed.reduce((a, b) => a + b, 0) / elapsed.length
    : null;
  return {
    total,
    passes: total - fails,
    fails,
    failedRuns,
    verdict: fails === 0 ? "PASS" : "FLAKY",
    minMs,
    maxMs,
    meanMs,
  };
}

function fmtMs(n: number | null): string {
  if (n === null) return "-";
  return `${(n / 1000).toFixed(2)}s`;
}

/** Shell one `bun test` phase; return its exit code + captured output. */
async function runPhase(
  argv: string[],
): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(["bun", "test", ...argv], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // bun test writes its summary to stderr; keep stdout too for completeness.
  return { exitCode, output: `${stdout}\n${stderr}` };
}

/**
 * Run one iteration of the slow tier (all phases, mirroring `test:slow`);
 * capture exit/elapsed/combined output to a per-run log. The run FAILS iff any
 * phase exits non-zero. Phases run sequentially; a `--bail`-style early stop on
 * phase failure is fine within a run (a failed phase already fails the run), so
 * we stop probing phases once one fails to avoid piling more box load.
 */
async function runOnce(run: number, logDir: string): Promise<RunResult> {
  const logPath = join(logDir, `run-${String(run).padStart(3, "0")}.log`);
  const started = Date.now();
  const chunks: string[] = [];
  let exitCode = 0;
  for (const phase of TIER_PHASES) {
    chunks.push(`\n===== phase: ${phase.label} =====\n`);
    const { exitCode: code, output } = await runPhase(phase.argv);
    chunks.push(output);
    if (code !== 0) {
      exitCode = code;
      break;
    }
  }
  const elapsedMs = Date.now() - started;
  await writeFile(logPath, chunks.join(""));
  return {
    run,
    exitCode,
    passed: exitCode === 0,
    elapsedMs,
    logPath,
  };
}

function renderSummary(summary: SoakSummary, logDir: string): void {
  const H = (s: string, w: number, right = false) =>
    right ? s.padStart(w) : s.padEnd(w);
  console.log();
  console.log("=".repeat(56));
  console.log("  slow-tier soak summary");
  console.log("=".repeat(56));
  console.log(`${H("Runs", 18)}${String(summary.total)}`);
  console.log(`${H("Passes", 18)}${String(summary.passes)}`);
  console.log(`${H("Fails", 18)}${String(summary.fails)}`);
  console.log(
    `${H("Failed runs", 18)}${summary.failedRuns.length ? summary.failedRuns.join(", ") : "(none)"}`,
  );
  console.log(
    `${H("Wall (min/mean/max)", 18)}${fmtMs(summary.minMs)} / ${fmtMs(summary.meanMs)} / ${fmtMs(summary.maxMs)}  (informational)`,
  );
  console.log(`${H("Logs", 18)}${logDir}`);
  console.log("-".repeat(56));
  console.log(`  VERDICT: ${summary.verdict}`);
  console.log("=".repeat(56));
}

async function main(): Promise<void> {
  const config = parseConfig(process.argv.slice(2), process.env);
  const logDir = mkdtempSync(join(tmpdir(), "keeper-soak-"));
  console.log(
    `Soaking the slow tier [${TIER_PHASES.map((p) => p.label).join(" ; ")}], ` +
      `${config.runs} run(s)${config.bail ? ", bail-on-first-fail" : ", run-all"}.`,
  );
  console.log(`Per-run logs: ${logDir}\n`);

  const results: RunResult[] = [];
  for (let run = 1; run <= config.runs; run++) {
    const result = await runOnce(run, logDir);
    results.push(result);
    const tag = result.passed ? "PASS" : "FAIL";
    console.log(
      `run ${String(run).padStart(3)}/${config.runs}  ${tag}  ` +
        `${fmtMs(result.elapsedMs)}  (exit ${result.exitCode})` +
        `${result.passed ? "" : `  -> ${result.logPath}`}`,
    );
    if (!result.passed && config.bail) {
      console.log(`\nbail: stopping at first failure (run ${run}).`);
      break;
    }
  }

  const summary = summarize(results);
  renderSummary(summary, logDir);
  process.exit(summary.fails === 0 ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
