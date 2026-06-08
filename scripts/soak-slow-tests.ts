#!/usr/bin/env bun
/**
 * Flake-soak harness for the (serial) `test:slow` tier (epic fn-747).
 *
 * The slow tier (`integration` + `daemon` + `plan-worker`) was carved SERIAL
 * (commit 9558382, fn-722) because `@parcel/watcher`'s native NAPI addon
 * panicked under whole-suite `--parallel`. fn-747 set out to `--parallel`-ize
 * it; the `.2` in-process daemon + watcher seam landed (migrating `integration`'s
 * four heaviest daemon-dependent e2e tests off the subprocess boot), but a full
 * `--parallel` soak proved the speedup is NOT reliably reachable, so fn-747.1
 * takes the epic's documented FALLBACK: keep the SERIAL baseline and ship THIS
 * harness as the durable flake-regression guard. It reruns the tier N times and
 * reports any failure, formalizing the "0 flakes over N consecutive runs" ritual
 * (fn-722 / fn-683) at 20x by default.
 *
 * WHY SERIAL (the fn-747.1 finding — two independent walls, both `--parallel`-only):
 *   1. `@parcel/watcher`'s native addon SIGTRAP/segfaults on teardown when many
 *      watcher-bearing REAL DAEMON SUBPROCESSES (the `integration` daemon-spawn
 *      smoke tests) are torn down concurrently.
 *   2. `plan-worker`'s fn-737 realtime-latency regression guards assert the
 *      native reflog WATCH beats the heartbeat fallback
 *      (`heartbeatRescues===0`); under `--parallel` load the watch delivery
 *      slows, the heartbeat wins, and the guard fails. They NEED low-load serial
 *      isolation to measure honestly — so `--parallel`-izing plan-worker is
 *      structurally self-defeating.
 * The `.2` conversions are RETAINED even serial: the four in-process tests boot
 * with `disableNativeWatcher` (zero addon dlopen) and run sub-second instead of
 * 30s, so the serial tier is FASTER and tears down FEWER native watchers than
 * the pre-fn-747 all-subprocess serial baseline.
 * (Aside: `integration`'s real-daemon-boot tests are contention-sensitive to
 * whole-box load — fn-722.7's 10s→36s spike — so soak on a QUIET box; the
 * harness gates on pass/fail per the spec, never timing.)
 *
 * Design (per the spec):
 *   - SEQUENTIAL iterations. Parallel iterations would multiply socket
 *     collisions and become a flake source themselves; the harness measures
 *     the tier's OWN intra-run parallelism, not N tiers fighting each other.
 *   - RUN-ALL by default (don't stop on first fail) so a full N yields a flake
 *     RATE (e.g. 2/20), not just a yes/no. `--bail` / `-b` stops on first fail.
 *   - Each iteration shells a FRESH `bun test <tier files>` via
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
 * The slow tier as ONE serial phase, mirroring `test:slow` (see the file header
 * for the two native-addon walls that keep it serial). All three files run in a
 * single non-`--parallel` `bun test` invocation, so tests execute sequentially —
 * no concurrent addon dlopen/teardown (wall 1) and the fn-737 latency guards run
 * under low load (wall 2). A 60s budget covers load-variable real-daemon boots.
 */
const TIER_PHASES: { argv: string[]; label: string }[] = [
  {
    argv: [
      "test/integration.test.ts",
      "test/daemon.test.ts",
      "test/plan-worker.test.ts",
      "--timeout=60000",
    ],
    label: "integration+daemon+plan-worker (serial)",
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
export function parseConfig(
  argv: string[],
  env: NodeJS.ProcessEnv,
): SoakConfig {
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
