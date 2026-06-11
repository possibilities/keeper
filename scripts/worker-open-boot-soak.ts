#!/usr/bin/env bun
/**
 * `worker-open-boot-soak` — the diagnostic repro + evidence gate for epic
 * fn-785 (the worker-open boot race), task `.3`.
 *
 * Background (epic fn-785): under heavy load a freshly-spawned keeperd worker
 * thread's `openDb` on the just-migrated DB intermittently failed — either
 * "SQLiteError: no such table: events" thrown from `prepareStmts`, or a native
 * SIGTRAP — killing the process via `fatalExit`. In CI (sharing the box with
 * live autopilot workers) this redded buildbot builds 53/54/86 on 2026-06-10/11.
 * Root contributors: `openDb` prepared statements by default even on read-only
 * connections that use none; ~9 worker threads concurrently construct
 * `Database()` on one file (bun:sqlite's known concurrent-open race, #29277);
 * and the post-boot-drain checkpoint was PASSIVE so a worker's first open may
 * exercise the WAL/shm recovery path.
 *
 * Tasks `.1` and `.2` landed the fix: every worker `openDb` now passes
 * `prepareStmts:false` + `bootRetry` (bounded fresh-handle retry of the
 * transient boot class), and the boot-drain finally checkpoint is TRUNCATE
 * (empty WAL at first worker open). This harness is task `.3` — the empirical
 * proof.
 *
 * What it does
 * ------------
 * Loops `withInProcessDaemon` (test/helpers/in-process-daemon.ts, the fn-747
 * keystone) with the FULL worker set, booting a REAL keeperd in this process
 * each iteration and tearing it down cleanly. The full set spawns ~13 real
 * Worker threads that each call `openDb` on the just-migrated DB at boot — the
 * exact concurrent-open surface the race lives in. (`disableNativeWatcher:true`
 * is forced by the harness, so NO worker dlopens `@parcel/watcher`; that suppresses
 * the addon-dlopen SIGTRAP family the parallel slow-tier already avoids, leaving
 * the bun:sqlite concurrent-open + WAL-recovery surface this epic targets.)
 *
 * Under INDUCED CPU LOAD: before the boot loop, spawn `--load` busy-spin Worker
 * threads (each a tight `while` loop) to peg the cores, recreating the contended
 * box where the raciest boot-open window loses its scheduler slice — the
 * condition under which the race actually fired in CI. A boot is "clean" when
 * `withInProcessDaemon` resolves (migrate + all workers spawned + UDS bound +
 * body ran + teardown) with no throw. Any throw (or a worker `fatalExit`
 * surfacing as an unhandled rejection) is a FAILED boot — recorded with its
 * signature.
 *
 * Pass bar (task `.3`): N consecutive clean boots under load (default 50). It
 * runs against WHATEVER tree it's invoked from — there is no `--patched` switch
 * because the fix (tasks `.1`/`.2`) is already in `src/`; to measure how many
 * iterations the UNPATCHED tree needs to fail (a sanity check that the repro
 * exercises the race) you'd run this from a checkout that predates the fix. The
 * task Evidence records that honest account, since the unpatched code is no
 * longer in the live tree.
 *
 * BOUNDED / OPT-IN / MANUAL. NEVER wire this into CI — the induced-load loop
 * recreates the exact contention flake CI just escaped. It boots a hermetic
 * in-process daemon under a per-iteration tmpdir sandbox (every `KEEPER_*` path
 * isolated by the harness), opens no production DB, writes no production
 * events/RPC. Run it by hand:
 *
 *   bun scripts/worker-open-boot-soak.ts [options]
 *
 * Options:
 *   --iterations <n>   Consecutive clean boots to require (default: 50)
 *   --load <n>         Busy-spin load threads to peg cores (default: # CPUs)
 *   --stop-on-fail     Stop at the first failed boot (default: run all N)
 *   --json             Emit the report as JSON
 *   --quiet            Suppress per-iteration progress; print only the summary
 *   --help, -h         Show this help
 */

import { availableParallelism } from "node:os";
import { parseArgs } from "node:util";
import { withInProcessDaemon } from "../test/helpers/in-process-daemon";

const HELP = `worker-open-boot-soak — fn-785 boot-race repro + evidence gate

Usage:
  bun scripts/worker-open-boot-soak.ts [options]

Options:
  --iterations <n>   Consecutive clean boots to require (default: 50)
  --load <n>         Busy-spin load threads to peg cores (default: # CPUs)
  --stop-on-fail     Stop at the first failed boot (default: run all N)
  --json             Emit the report as JSON
  --quiet            Only print the summary
  --help, -h         Show this help

Loops a full-worker-set in-process keeperd boot under induced CPU load,
counting clean boots vs failures. MANUAL ONLY — never wire into CI.
`;

// A busy-spin Worker body: a tight loop with no yield, pegging one core to
// starve the boot-open window of its scheduler slice. Posted as a Blob URL so
// no extra file is needed. It never exits on its own; main terminates it.
const SPIN_WORKER_SRC = `
const start = Date.now();
let x = 0;
// Tight CPU spin. The modulo/sqrt keeps the JIT from hoisting it away.
while (true) {
  x = (x + 1) % 1_000_003;
  x = (x * 7 + Math.floor(Math.sqrt(x + 1))) % 1_000_003;
}
`;

interface Args {
  iterations: number;
  load: number;
  stopOnFail: boolean;
  json: boolean;
  quiet: boolean;
}

function parse(argv: string[]): Args | "help" {
  const { values } = parseArgs({
    args: argv,
    options: {
      iterations: { type: "string" },
      load: { type: "string" },
      "stop-on-fail": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) return "help";

  const numOr = (
    raw: string | undefined,
    dflt: number,
    label: string,
  ): number => {
    if (raw === undefined) return dflt;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`--${label} must be a positive number`);
    }
    return Math.floor(n);
  };

  return {
    iterations: numOr(values.iterations, 50, "iterations"),
    load: numOr(values.load, availableParallelism(), "load"),
    stopOnFail: values["stop-on-fail"] ?? false,
    json: values.json ?? false,
    quiet: values.quiet ?? false,
  };
}

/** One boot iteration's outcome. */
interface BootResult {
  iteration: number;
  ok: boolean;
  /** Failure signature (error name + first message line) when `ok` is false. */
  signature?: string;
  /** Wall-clock ms the boot + teardown took. */
  ms: number;
}

/** Spawn `n` busy-spin load workers; returns them so main can terminate them. */
function spawnLoad(n: number): Worker[] {
  const blob = new Blob([SPIN_WORKER_SRC], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  const workers: Worker[] = [];
  for (let i = 0; i < n; i++) {
    const w = new Worker(url);
    // A spin worker that somehow errors must not crash the harness — the load
    // is best-effort pressure, not a measured surface.
    w.addEventListener("error", () => {});
    workers.push(w);
  }
  return workers;
}

/** One boot: resolve = clean, throw = failed. Captures the failure signature. */
async function bootOnce(iteration: number): Promise<BootResult> {
  const t0 = Date.now();
  try {
    await withInProcessDaemon(
      async ({ handle }) => {
        // The boot already proved the race surface (migrate + ~13 worker
        // openDb spawns + UDS bind, gated by waitForDaemon). A trivial body
        // confirms the daemon is live and serving before teardown.
        if (!handle.sockPath) throw new Error("daemon returned no sockPath");
      },
      // Full worker set (omit `workers`) — the production-parity spawn that
      // races ~13 concurrent worker openDb calls at boot.
    );
    return { iteration, ok: true, ms: Date.now() - t0 };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    const firstLine = (e.message ?? String(err)).split("\n")[0] ?? "";
    return {
      iteration,
      ok: false,
      signature: `${e.name ?? "Error"}: ${firstLine}`,
      ms: Date.now() - t0,
    };
  }
}

interface Report {
  iterations: number;
  load: number;
  cpus: number;
  bunVersion: string;
  bunRevision: string;
  cleanBoots: number;
  failedBoots: number;
  longestCleanStreak: number;
  firstFailureAt: number | null;
  failures: { iteration: number; signature: string; ms: number }[];
  passedBar: boolean;
  meanBootMs: number;
}

function render(report: Report, out: (s: string) => void): void {
  out("\n");
  out(
    "== fn-785 worker-open boot-race soak -- evidence report ==============\n",
  );
  out(
    `bun ${report.bunVersion} (${report.bunRevision})   cpus: ${report.cpus}   load threads: ${report.load}\n`,
  );
  out(
    `requested: ${report.iterations} consecutive clean boots under induced CPU load\n\n`,
  );
  out(`clean boots:          ${report.cleanBoots}/${report.iterations}\n`);
  out(`failed boots:         ${report.failedBoots}\n`);
  out(`longest clean streak: ${report.longestCleanStreak}\n`);
  out(`mean boot+teardown:   ${report.meanBootMs.toFixed(0)}ms\n`);
  if (report.firstFailureAt !== null) {
    out(`first failure at:     iteration ${report.firstFailureAt}\n`);
  }
  if (report.failures.length > 0) {
    out("\nfailure signatures:\n");
    for (const f of report.failures) {
      out(`  • iter ${f.iteration} (${f.ms}ms): ${f.signature}\n`);
    }
  }
  out("\n");
  if (report.passedBar) {
    out(
      `VERDICT: PASS — ${report.cleanBoots} consecutive clean boots under load.\n` +
        "  This tree (with prepareStmts:false + bootRetry + TRUNCATE checkpoint from\n" +
        "  tasks .1/.2) survives the induced-contention boot loop the race fired under\n" +
        "  in CI.\n",
    );
  } else {
    out(
      `VERDICT: FAIL — only ${report.longestCleanStreak} consecutive clean boots ` +
        `(needed ${report.iterations}).\n` +
        "  A boot failed under load. Inspect the signatures above.\n",
    );
  }
  out(
    "=====================================================================\n",
  );
}

async function main(argv: string[]): Promise<void> {
  let args: Args | "help";
  try {
    args = parse(argv);
  } catch (err) {
    process.stderr.write(
      `worker-open-boot-soak: ${(err as Error).message}\n\n${HELP}`,
    );
    process.exit(1);
  }
  if (args === "help") {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const out = (s: string): void => {
    process.stdout.write(s);
  };
  const log = (s: string): void => {
    if (!args.quiet) process.stdout.write(s);
  };

  log(
    `worker-open-boot-soak — spinning up ${args.load} CPU-load thread(s)…\n` +
      `looping ${args.iterations} full-worker-set in-process boots under load.\n\n`,
  );

  const loadWorkers = spawnLoad(args.load);
  const results: BootResult[] = [];
  let longestStreak = 0;
  let currentStreak = 0;
  let firstFailureAt: number | null = null;

  try {
    for (let i = 1; i <= args.iterations; i++) {
      const r = await bootOnce(i);
      results.push(r);
      if (r.ok) {
        currentStreak++;
        if (currentStreak > longestStreak) longestStreak = currentStreak;
        log(`  iter ${String(i).padStart(4)}: clean (${r.ms}ms)\n`);
      } else {
        if (firstFailureAt === null) firstFailureAt = i;
        currentStreak = 0;
        log(
          `  iter ${String(i).padStart(4)}: FAILED (${r.ms}ms) — ${r.signature}\n`,
        );
        if (args.stopOnFail) {
          log("\n--stop-on-fail set; halting at first failure.\n");
          break;
        }
      }
    }
  } finally {
    // Terminate the spin workers — they never exit on their own.
    for (const w of loadWorkers) {
      try {
        w.terminate();
      } catch {
        // best-effort
      }
    }
  }

  const cleanBoots = results.filter((r) => r.ok).length;
  const failedBoots = results.filter((r) => !r.ok).length;
  const meanBootMs =
    results.length === 0
      ? 0
      : results.reduce((a, r) => a + r.ms, 0) / results.length;

  const report: Report = {
    iterations: args.iterations,
    load: args.load,
    cpus: availableParallelism(),
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    cleanBoots,
    failedBoots,
    longestCleanStreak: longestStreak,
    firstFailureAt,
    failures: results
      .filter((r) => !r.ok)
      .map((r) => ({
        iteration: r.iteration,
        signature: r.signature ?? "unknown",
        ms: r.ms,
      })),
    // PASS requires the FULL requested run completed clean (no failure at all),
    // which under a complete run means longestStreak === iterations.
    passedBar: failedBoots === 0 && cleanBoots === args.iterations,
    meanBootMs,
  };

  if (args.json) {
    out(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    render(report, out);
  }
  process.exit(report.passedBar ? 0 : 1);
}

if (import.meta.main) {
  void main(process.argv.slice(2));
}
