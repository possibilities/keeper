#!/usr/bin/env bun
/**
 * Thin `bun test` wrapper that bounds each run's footprint so many suites can
 * share one host WITHOUT a lock. CI and several interactive agents all run tests
 * on the same box; isolation comes from capping each run, not from serializing
 * runs against each other.
 *
 * `package.json`'s `test` script routes through this wrapper. It spawns
 * `bun test`, forwarding ALL of the gate's own args verbatim (the script owns its
 * `--path-ignore-patterns` list — the gate is generic and holds no ignore-list),
 * and injecting two bounds when the forwarded args don't already set them:
 *
 *  - `--parallel=${KEEPER_TEST_PARALLEL:-5}` — worker-process cap. `--parallel`
 *    implies `--isolate`; the suite is import-bound, so a low cap keeps a single
 *    run brisk and lets several concurrent runs degrade gracefully (the OS
 *    scheduler shares cores) instead of each claiming every core and thrashing.
 *  - `--no-orphans` — on exit, SIGKILL every descendant. A test that leaks a
 *    tmux/daemon/git subprocess can otherwise outlive the run and wedge the host;
 *    this reaps the leak when the run ends.
 *
 * The child's exit code becomes the gate's exit code, and stdio is inherited so
 * the live progress autopilot agents watch survives.
 *
 * Two guards keep bun's own `--parallel` worker children from surviving the
 * coordinator: the spawn injects `BUN_FEATURE_FLAG_NO_ORPHANS` into the child
 * env (the env form of `--no-orphans`, which — unlike the argv flag — reaches
 * the workers, so they die with the coordinator even on its abnormal death),
 * and a gate-start sweep reaps any worker an earlier run still leaked.
 */

import { execFileSync } from "node:child_process";

// Default per-run worker cap; `KEEPER_TEST_PARALLEL` overrides. Five keeps a
// single run near its floor on this class of box (a few performance cores) while
// leaving headroom for a concurrent run to coexist without collapse.
const DEFAULT_PARALLEL = 5;

/**
 * Build the `bun test` argv from the gate's forwarded args. Injects
 * `--parallel=${KEEPER_TEST_PARALLEL:-5}` and `--no-orphans`, each only when the
 * forwarded args don't already carry it, so a script that sets its own value
 * wins. Pure over its inputs for the unit test.
 */
export function buildBunTestArgs(
  forwarded: string[],
  parallelEnv: string | undefined,
): string[] {
  const hasParallel = forwarded.some(
    (a) => a === "--parallel" || a.startsWith("--parallel="),
  );
  const hasNoOrphans = forwarded.includes("--no-orphans");
  const args = ["test", ...forwarded];
  if (!hasParallel) {
    args.push(`--parallel=${normalizeParallel(parallelEnv)}`);
  }
  if (!hasNoOrphans) {
    args.push("--no-orphans");
  }
  return args;
}

/** Parse `KEEPER_TEST_PARALLEL` into a positive integer, else the default. */
function normalizeParallel(raw: string | undefined): number {
  if (raw === undefined || raw.length === 0) {
    return DEFAULT_PARALLEL;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_PARALLEL;
}

/** A parsed `ps` row the orphan sweep decides on; `args` is the full command line. */
export type ProcRow = {
  pid: number;
  ppid: number;
  uid: number;
  etime: string;
  args: string;
};

/** Grace before a leaked worker is swept — a healthy just-orphaned worker
 * self-exits well inside this window, so the sweep never races a clean teardown. */
const ORPHAN_MIN_AGE_SEC = 120;

/**
 * Parse a `ps -o etime` string (`[[dd-]hh:]mm:ss`) into seconds. An unparseable
 * value returns 0 — read as "just started", so the sweep never kills on a value
 * it did not understand (fail toward leaving the process alone). Pure.
 */
export function parseEtimeSeconds(etime: string): number {
  const [dPart, hms] = etime.includes("-") ? etime.split("-") : ["0", etime];
  const parts = hms.split(":").map((n) => Number.parseInt(n, 10));
  if (parts.some((n) => Number.isNaN(n))) {
    return 0;
  }
  let h = 0;
  let m = 0;
  let s = 0;
  if (parts.length === 3) {
    [h, m, s] = parts;
  } else if (parts.length === 2) {
    [m, s] = parts;
  } else {
    return 0;
  }
  const days = Number.parseInt(dPart, 10) || 0;
  return ((days * 24 + h) * 60 + m) * 60 + s;
}

/**
 * Decide whether a `ps` row is a leaked, orphaned `bun test` worker safe to
 * SIGKILL. EVERY clause must hold, so a healthy sibling run's LIVE workers are
 * never touched:
 *  - argv is exactly `bun test … --test-worker` — anchoring on `argv[1] ===
 *    "test"` excludes any process that merely mentions `--test-worker` in its
 *    command line (an agent session, an editor, a grep);
 *  - `ppid === 1` — the coordinator is provably dead (reparented to init). A
 *    live run's worker carries its live coordinator as ppid, never 1, and ppid
 *    does not flip to 1 on suspend — only on real parent exit. This is the
 *    invariant that keeps the sweep off a concurrent run;
 *  - the process is our own uid, and older than `minAgeSec`, and not this gate.
 * Pure over its inputs; the unit test drives every branch.
 */
export function isOrphanTestWorker(
  row: ProcRow,
  selfPid: number,
  selfUid: number,
  minAgeSec: number,
): boolean {
  if (row.pid === selfPid || row.ppid !== 1) {
    return false;
  }
  if (selfUid < 0 || row.uid !== selfUid) {
    return false;
  }
  const toks = row.args.trim().split(/\s+/);
  const bin = toks[0]?.split("/").pop();
  if (bin !== "bun" || toks[1] !== "test" || !toks.includes("--test-worker")) {
    return false;
  }
  return parseEtimeSeconds(row.etime) >= minAgeSec;
}

/**
 * Best-effort reaper run once at gate start: SIGKILL our own leaked, orphaned
 * `bun test` workers left by an earlier run whose coordinator died abnormally.
 * A SIGKILL/OOM/crash of the coordinator bypasses bun's `--no-orphans` on-exit
 * reaper, and bun gives each worker its own process group, so no group kill
 * reaches them — this catches whatever still slipped through on the next run.
 * Every failure is swallowed: the sweep must never block the suite.
 */
function sweepOrphanTestWorkers(minAgeSec = ORPHAN_MIN_AGE_SEC): void {
  const selfUid = process.getuid?.() ?? -1;
  let out: string;
  try {
    out = execFileSync("ps", ["-axo", "pid=,ppid=,uid=,etime=,args="], {
      encoding: "utf8",
    });
  } catch (err) {
    process.stderr.write(`[test-gate] orphan sweep skipped: ${err}\n`);
    return;
  }
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (m === null) {
      continue;
    }
    const row: ProcRow = {
      pid: Number(m[1]),
      ppid: Number(m[2]),
      uid: Number(m[3]),
      etime: m[4],
      args: m[5],
    };
    if (!isOrphanTestWorker(row, process.pid, selfUid, minAgeSec)) {
      continue;
    }
    try {
      process.kill(row.pid, "SIGKILL");
      process.stderr.write(
        `[test-gate] swept orphan bun test worker pid=${row.pid} age=${row.etime}\n`,
      );
    } catch {
      // Process exited between the scan and the kill — nothing to do.
    }
  }
}

/**
 * Spawn `bun test` with inherited stdio and return its exit code.
 */
async function runBunTest(args: string[]): Promise<number> {
  const child = Bun.spawn(["bun", ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    // Env form of `--no-orphans`: it propagates to bun's `--parallel` worker
    // children (the argv flag does not), so a worker dies with the coordinator
    // even when the coordinator is SIGKILLed and its on-exit reaper never runs.
    env: { ...process.env, BUN_FEATURE_FLAG_NO_ORPHANS: "1" },
  });
  await child.exited;
  return child.exitCode ?? 1;
}

async function main(): Promise<number> {
  // Reap any worker an earlier run leaked before adding this run's own.
  sweepOrphanTestWorkers();
  const forwarded = Bun.argv.slice(2);
  const args = buildBunTestArgs(forwarded, process.env.KEEPER_TEST_PARALLEL);
  return await runBunTest(args);
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // A gate bug must not silently swallow the suite — surface it, but still
      // fail (non-zero) so a broken gate is loud rather than green.
      process.stderr.write(`[test-gate] fatal: ${err}\n`);
      process.exit(1);
    });
}
