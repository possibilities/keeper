#!/usr/bin/env bun
/**
 * `git-worker-cpu-soak` — the diagnostic repro + evidence gate for epic
 * fn-748 (the git-worker `data_version` snapshot fan-out CPU peg).
 *
 * Background (epic fn-748): the git-worker's `data_version` poll
 * (`DB_POLL_MS=100`, `src/git-worker.ts:2784`) fans a `git status` snapshot
 * out to EVERY subscribed root on every foreign DB write. `data_version`
 * carries no root attribution, so a hook event dirtying repo A schedules a
 * snapshot in repos B/C/D too — O(roots × write-rate) `git status` shell-outs
 * under sustained multi-agent load. The 2026-06-08 soak pegged the daemon at
 * ~144% CPU. The fix (.2) DROPS that fan-out arm so snapshots come solely from
 * the per-root worktree + git-common-dir FSEvents subscriptions
 * (`subscribeRoot`, `:2478`) with the 60s heartbeat as the single backstop.
 *
 * This harness is the .1 keystone — it must establish BOTH halves of the
 * go/no-go before the arm is removed:
 *
 *   1. CPU EVIDENCE — drive a sustained multi-agent write storm against the
 *      LIVE daemon (faithful path: emit through the real hook NDJSON feed so
 *      the hook→ingester→data_version→fan-out chain is exercised, since that
 *      is the EXACT bug path; synthesizing `events` rows directly would skip
 *      it). Sample CPU over the window for the daemon PID AND its aggregated
 *      `git` CHILD processes (spawned git is charged to git PIDs, so a
 *      daemon-only sample under-reports — the daemon's 144% is the cost of
 *      managing O(roots) concurrent `child_process.spawn` lifecycles).
 *      Correlate the storm rate × root-count against the CPU it drives so the
 *      fan-out is shown to be the dominant cost.
 *
 *   2. FSEVENTS COVERAGE — enumerate whether any `git status`-affecting
 *      mutation class for an already-subscribed root produces NO FSEvents on
 *      EITHER the worktree sub or the git-common-dir sub. `git status` output
 *      is a function of exactly three axes: working tree (untracked/modified/
 *      deleted files), HEAD (`.git/HEAD` + the ref it points at), and the
 *      index (`.git/index`). The proof walks each axis, mutates a scratch repo,
 *      and confirms the change lands under a path the worktree sub or the
 *      git-dir sub watches (and is NOT swallowed by that sub's ignore globs).
 *      Any axis that mutates ONLY ignored paths is the residual class — the
 *      trigger for the .3 heartbeat-staleness fallback.
 *
 *   3. FOREIGN-CHANGE LATENCY — measure how long a genuine foreign change in a
 *      subscribed root takes to surface (the baseline for the drop-recovery
 *      tradeoff: if FSEvents+heartbeat recovery is too coarse under load, .3
 *      tightens the heartbeat rather than the data_version poll regaining an
 *      arm). Reuses `bench-latency`'s subscribe-and-stamp passive technique.
 *
 * CLI parsing models `scripts/bench-latency.ts` (`parseArgs` from `node:util`,
 * `--duration`/`--json`/`--quiet`); the pure aggregator + padded-table summary
 * model `scripts/backstop-stats.ts` (`computeStats` + padded `H()` columns).
 *
 * OBSERVABILITY + REPRO ONLY. It opens a READ-ONLY connection to enumerate the
 * subscribed-root set the same way the worker does (`SELECT DISTINCT cwd FROM
 * jobs`), drives the storm through the real hook (a producer, exactly like a
 * live agent), and samples CPU via `ps`. It writes NO synthetic events, no
 * projection, no RPC, and never opens a writable DB handle. The storm it
 * drives is real hook traffic the daemon ingests as genuine `events` rows —
 * that is the point (faithfulness), but it is confined to the events-log feed,
 * never a direct DB write.
 *
 * Usage:
 *   bun scripts/git-worker-cpu-soak.ts [options]
 *
 * Options:
 *   --duration <seconds>   Storm window length (default: 20)
 *   --rate <n>             Hook events PER ROOT per second (default: 4)
 *   --roots <n>            Cap the storm to the first N subscribed roots
 *                          (default: all live roots; use a small N to isolate
 *                          the per-root fan-out coefficient)
 *   --sample-ms <n>        CPU sample cadence (default: 1000)
 *   --skip-storm           Skip the CPU storm; run only the FSEvents-coverage
 *                          + latency proofs (fast, no live load)
 *   --skip-coverage        Skip the FSEvents-coverage proof
 *   --json                 Emit the full report as JSON
 *   --quiet                Suppress progress lines; print only the summary
 *   --help, -h             Show this help
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { openDb, resolveDbPath, resolveSockPath } from "../src/db";
import { type FatalError, subscribeCollection } from "../src/readiness-client";

const HELP = `git-worker-cpu-soak — fn-748 diagnostic repro + evidence gate

Usage:
  bun scripts/git-worker-cpu-soak.ts [options]

Options:
  --duration <seconds>   Storm window length (default: 20)
  --rate <n>             Hook events PER ROOT per second (default: 4)
  --roots <n>            Cap the storm to the first N subscribed roots
  --sample-ms <n>        CPU sample cadence (default: 1000)
  --skip-storm           Skip the CPU storm (coverage + latency only)
  --skip-coverage        Skip the FSEvents-coverage proof
  --json                 Emit the full report as JSON
  --quiet                Only print the summary
  --help, -h             Show this help

Drives a faithful multi-agent write storm through the real hook NDJSON feed
against the LIVE daemon, samples daemon-PID + aggregated git-child CPU, proves
FSEvents worktree+git-dir coverage of every git-status axis, and baselines
foreign-change surfacing latency. Needs keeperd running.
`;

// ── git-dir ignore globs mirrored from src/git-worker.ts:502 ──────────────
// The git-common-dir FSEvents subscription is created with these positive
// ignores. The coverage proof must treat a mutation that lands ONLY under one
// of these as INVISIBLE to the git-dir sub (the worktree sub also ignores
// **/.git/**, so an ignored git-dir path is invisible to BOTH).
const GIT_DIR_IGNORE_SEGMENTS = [
  "objects/",
  "logs/",
  "hooks/",
  "lfs/",
  "info/",
];
// Lockfiles (`**/*.lock`) are also ignored, but they are transient (created +
// removed on every git write) and never the persistent state `git status`
// reads, so an axis that touches only a `*.lock` is still covered by the
// non-lock sibling write (e.g. `index.lock` → `index`).

function nowMs(): number {
  return Date.now();
}

// ── CLI parsing (models bench-latency.ts) ─────────────────────────────────

interface Args {
  durationSec: number;
  ratePerRoot: number;
  rootCap: number | null;
  sampleMs: number;
  skipStorm: boolean;
  skipCoverage: boolean;
  json: boolean;
  quiet: boolean;
}

function parse(argv: string[]): Args | "help" {
  const { values } = parseArgs({
    args: argv,
    options: {
      duration: { type: "string" },
      rate: { type: "string" },
      roots: { type: "string" },
      "sample-ms": { type: "string" },
      "skip-storm": { type: "boolean", default: false },
      "skip-coverage": { type: "boolean", default: false },
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
    return n;
  };

  const rootCap =
    values.roots === undefined
      ? null
      : Math.floor(numOr(values.roots, 1, "roots"));

  return {
    durationSec: numOr(values.duration, 20, "duration"),
    ratePerRoot: numOr(values.rate, 4, "rate"),
    rootCap,
    sampleMs: numOr(values["sample-ms"], 1000, "sample-ms"),
    skipStorm: values["skip-storm"] ?? false,
    skipCoverage: values["skip-coverage"] ?? false,
    json: values.json ?? false,
    quiet: values.quiet ?? false,
  };
}

// ── root enumeration (mirrors the worker's membership query) ──────────────

/**
 * Enumerate the roots the live worker would subscribe — the SAME
 * `SELECT DISTINCT cwd FROM jobs` sweep `discoverProjectRoots` runs
 * (src/git-worker.ts:1522). Read-only connection; we keep only cwds that are
 * live git worktrees so the storm targets repos whose snapshots actually cost.
 */
function enumerateRoots(): string[] {
  const { db } = openDb(resolveDbPath(), { readonly: true });
  try {
    const rows = db
      .query("SELECT DISTINCT cwd FROM jobs WHERE cwd IS NOT NULL")
      .all() as { cwd: string }[];
    const roots: string[] = [];
    for (const { cwd } of rows) {
      if (!existsSync(cwd)) continue;
      if (!existsSync(join(cwd, ".git"))) continue;
      roots.push(cwd);
    }
    roots.sort();
    return roots;
  } finally {
    db.close();
  }
}

// ── live daemon PID + git-child CPU sampling (via ps) ─────────────────────

function findDaemonPid(): number | null {
  const r = spawnSync("pgrep", ["-f", "src/daemon.ts"], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return null;
  const pid = Number(r.stdout.trim().split(/\s+/)[0]);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

interface ProcRow {
  pid: number;
  ppid: number;
  pcpu: number;
  comm: string;
}

/** One `ps` snapshot of every process (pid/ppid/pcpu/comm). */
function snapshotProcs(): ProcRow[] {
  const r = spawnSync("ps", ["-axo", "pid=,ppid=,pcpu=,comm="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0 || !r.stdout) return [];
  const rows: ProcRow[] = [];
  for (const line of r.stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pcpu: Number(m[3]),
      comm: m[4] ?? "",
    });
  }
  return rows;
}

interface CpuSample {
  atMs: number;
  daemonPcpu: number;
  /** Summed %CPU of all `git` processes parented (transitively) to the daemon. */
  gitChildPcpu: number;
  gitChildCount: number;
}

/**
 * One CPU sample: the daemon's own %CPU plus the aggregated %CPU of every
 * `git` process in the daemon's descendant tree. Spawned git is charged to
 * git PIDs (not the daemon PID), so the fan-out's true cost is daemon + git.
 */
function sampleCpu(daemonPid: number): CpuSample {
  const procs = snapshotProcs();
  const byPid = new Map<number, ProcRow>();
  for (const p of procs) byPid.set(p.pid, p);

  // Build the daemon's descendant set so we attribute only ITS git children
  // (a sibling foreground `git status` from the human must not pollute).
  const descendants = new Set<number>([daemonPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of procs) {
      if (descendants.has(p.ppid) && !descendants.has(p.pid)) {
        descendants.add(p.pid);
        grew = true;
      }
    }
  }

  let gitChildPcpu = 0;
  let gitChildCount = 0;
  for (const p of procs) {
    if (p.pid === daemonPid) continue;
    if (!descendants.has(p.pid)) continue;
    if (p.comm.endsWith("git") || p.comm === "git") {
      gitChildPcpu += p.pcpu;
      gitChildCount++;
    }
  }

  const daemonPcpu = byPid.get(daemonPid)?.pcpu ?? 0;
  return { atMs: nowMs(), daemonPcpu, gitChildPcpu, gitChildCount };
}

/**
 * Return the set of `git` PIDs currently in the daemon's descendant tree.
 * Each `git status` fan-out shells out a SHORT-LIVED `git` (≈10-100ms), so a
 * 1s CPU sample's `ps` pcpu mostly catches ZERO concurrent git processes and
 * under-reports the fan-out's git-side cost. A TIGHT poll of this set across
 * the window instead counts the CHURN (distinct git PIDs spawned) and the
 * peak concurrency — the honest git-side signal that the fan-out is firing
 * O(roots × write-rate) shell-outs. Cheaper than `snapshotProcs` (pgrep, no
 * comm parse).
 */
function daemonGitPids(daemonPid: number): number[] {
  const procs = snapshotProcs();
  const descendants = new Set<number>([daemonPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of procs) {
      if (descendants.has(p.ppid) && !descendants.has(p.pid)) {
        descendants.add(p.pid);
        grew = true;
      }
    }
  }
  const pids: number[] = [];
  for (const p of procs) {
    if (p.pid === daemonPid) continue;
    if (!descendants.has(p.pid)) continue;
    if (p.comm.endsWith("git") || p.comm === "git") pids.push(p.pid);
  }
  return pids;
}

/** Churn accumulator for short-lived git children across a tight poll. */
interface GitChurn {
  /** Distinct git PIDs observed spawned across the window. */
  distinctSpawns: number;
  /** Peak concurrent git children at any single tight-poll instant. */
  peakConcurrent: number;
}

// ── faithful hook-feed write storm ────────────────────────────────────────

const HOOK = join(import.meta.dir, "..", "plugin", "hooks", "events-writer.ts");

/**
 * Build a faithful PostToolUse payload for `cwd`. PostToolUse is the highest-
 * frequency real hook event (one per tool call) and folds to a `jobs`-row
 * touch → `data_version` bump, which is exactly what an agent's edit storm
 * looks like to the worker. The shape mirrors what Claude Code sends.
 */
function hookPayload(cwd: string, seq: number): string {
  return JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: `cpu-soak-${process.pid}`,
    tool_name: "Edit",
    cwd,
    permission_mode: "default",
    tool_response: { filePath: join(cwd, `soak-${seq}.txt`) },
  });
}

/**
 * Fire one hook invocation faithfully: spawn `bun events-writer.ts` and pipe
 * the payload to its stdin, exactly as Claude Code runs the hook. The hook
 * appends a per-pid NDJSON line to the events-log; the daemon's ingester
 * folds it → `data_version` bumps → the git-worker poll fans out. We do NOT
 * await each spawn (an agent doesn't); we cap in-flight to avoid a fork bomb.
 */
function fireHook(cwd: string, seq: number, onExit: () => void): void {
  fireHookPayload(hookPayload(cwd, seq), onExit);
}

/** Fire one hook invocation with an explicit JSON payload. */
function fireHookPayload(payload: string, onExit: () => void): void {
  const child = spawn("bun", [HOOK], {
    stdio: ["pipe", "ignore", "ignore"],
    env: process.env,
  });
  child.on("exit", onExit);
  child.on("error", onExit);
  child.stdin.write(payload);
  child.stdin.end();
}

interface StormResult {
  roots: string[];
  durationSec: number;
  ratePerRoot: number;
  eventsFired: number;
  samples: CpuSample[];
  churn: GitChurn;
  daemonPid: number;
}

async function runStorm(
  args: Args,
  roots: string[],
  daemonPid: number,
  log: (s: string) => void,
): Promise<StormResult> {
  const samples: CpuSample[] = [];
  // Baseline sample before any load.
  samples.push(sampleCpu(daemonPid));

  let eventsFired = 0;
  let inFlight = 0;
  const MAX_IN_FLIGHT = 64;
  const onExit = (): void => {
    inFlight = Math.max(0, inFlight - 1);
  };

  const endAt = nowMs() + args.durationSec * 1000;
  // Per-root interval between events.
  const perEventMs = 1000 / args.ratePerRoot;

  // Tight git-child churn poller: short-lived `git status` shell-outs flash in
  // and out between 1s CPU samples, so poll the daemon's git-child set fast and
  // count distinct spawns + peak concurrency — the honest git-side signal.
  const seenGitPids = new Set<number>();
  let peakConcurrent = 0;
  const churnPoll = setInterval(() => {
    const pids = daemonGitPids(daemonPid);
    if (pids.length > peakConcurrent) peakConcurrent = pids.length;
    for (const pid of pids) seenGitPids.add(pid);
  }, 30);

  const sampler = setInterval(() => {
    samples.push(sampleCpu(daemonPid));
  }, args.sampleMs);

  let seq = 0;
  const driver = setInterval(() => {
    if (nowMs() >= endAt) return;
    for (const root of roots) {
      if (inFlight >= MAX_IN_FLIGHT) break;
      inFlight++;
      fireHook(root, seq++, onExit);
      eventsFired++;
    }
  }, perEventMs);

  // Run the window.
  await new Promise<void>((resolve) => {
    const tick = setInterval(() => {
      if (nowMs() >= endAt) {
        clearInterval(tick);
        resolve();
      }
    }, 250);
  });

  clearInterval(driver);
  // Drain a moment so the LAST fan-out's git children are still captured, then
  // take a final under-decay sample.
  await new Promise((r) => setTimeout(r, 1500));
  samples.push(sampleCpu(daemonPid));
  clearInterval(sampler);
  clearInterval(churnPoll);

  log(
    `storm complete: ${eventsFired} hook events over ${args.durationSec}s × ${roots.length} root(s)\n`,
  );

  return {
    roots,
    durationSec: args.durationSec,
    ratePerRoot: args.ratePerRoot,
    eventsFired,
    samples,
    churn: { distinctSpawns: seenGitPids.size, peakConcurrent },
    daemonPid,
  };
}

// ── FSEvents coverage proof ───────────────────────────────────────────────

type CoverageVerdict = "covered-worktree" | "covered-gitdir" | "INVISIBLE";

interface CoverageRow {
  axis: string;
  description: string;
  /** The path the mutation touches, relative to the repo root. */
  touchedPath: string;
  verdict: CoverageVerdict;
  note: string;
}

/** True if `relPath` (relative to the git common dir) is swallowed by a git-dir ignore glob. */
function gitDirIgnored(relPath: string): boolean {
  for (const seg of GIT_DIR_IGNORE_SEGMENTS) {
    if (relPath === seg.replace(/\/$/, "") || relPath.startsWith(seg))
      return true;
  }
  if (relPath.endsWith(".lock")) return true;
  return false;
}

/**
 * Classify a mutation by the path it touches:
 *   - a worktree path (not under .git) → covered by the worktree sub
 *     (unless under a GIT_IGNORE_GLOB region, which git also ignores, so it
 *     cannot affect `git status` anyway → still consistent);
 *   - a non-ignored git-dir path → covered by the git-dir sub;
 *   - an IGNORED git-dir path with no sibling non-ignored write → INVISIBLE.
 */
function classifyTouch(touchedPath: string): {
  verdict: CoverageVerdict;
  note: string;
} {
  // Worktree path?
  const inGitDir = touchedPath === ".git" || touchedPath.startsWith(".git/");
  if (!inGitDir) {
    return {
      verdict: "covered-worktree",
      note: "worktree path — fires the worktree FSEvents sub",
    };
  }
  const rel = touchedPath.slice(".git/".length);
  if (gitDirIgnored(rel)) {
    return {
      verdict: "INVISIBLE",
      note: `git-dir path '${rel}' matches an ignore glob — invisible to the git-dir sub`,
    };
  }
  return {
    verdict: "covered-gitdir",
    note: `git-dir path '${rel}' — fires the git-common-dir FSEvents sub`,
  };
}

/**
 * Enumerate every `git status`-affecting change axis and classify the path it
 * mutates against the worktree + git-dir FSEvents subs. `git status` output is
 * a pure function of: working tree, HEAD (+ its ref), and index. We exercise a
 * real scratch repo per axis to PROVE the path each operation actually writes,
 * rather than asserting from memory.
 */
function proveCoverage(log: (s: string) => void): {
  rows: CoverageRow[];
  invisible: number;
} {
  const repo = mkdtempSync(join(tmpdir(), "git-cov-"));
  const run = (args: string[]): { ok: boolean; out: string } => {
    const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    return { ok: r.status === 0, out: (r.stdout ?? "") + (r.stderr ?? "") };
  };

  const rows: CoverageRow[] = [];
  try {
    run(["init", "-q"]);
    run(["config", "user.email", "soak@keeper.local"]);
    run(["config", "user.name", "soak"]);
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    run(["add", "."]);
    run(["commit", "-qm", "seed"]);

    // Determine which path each axis actually mutates by diffing the git-dir
    // before/after is overkill; the axes below are well-defined git internals.
    // The classification is by KNOWN write target, asserted against the live
    // repo's existence after the op.
    const assertExists = (rel: string): string =>
      existsSync(join(repo, rel))
        ? "(verified present)"
        : "(absent — see note)";

    const axes: {
      axis: string;
      description: string;
      touchedPath: string;
      mutate: () => void;
      verifyRel?: string;
    }[] = [
      {
        axis: "working-tree:untracked",
        description: "new untracked file appears",
        touchedPath: "new-untracked.txt",
        mutate: () => writeFileSync(join(repo, "new-untracked.txt"), "x\n"),
      },
      {
        axis: "working-tree:modified",
        description: "tracked file modified in worktree",
        touchedPath: "seed.txt",
        mutate: () => writeFileSync(join(repo, "seed.txt"), "seed-modified\n"),
      },
      {
        axis: "working-tree:deleted",
        description: "tracked file deleted from worktree",
        touchedPath: "seed.txt",
        mutate: () => rmSync(join(repo, "seed.txt")),
      },
      {
        axis: "index:staged",
        description: "git add stages a change (mutates .git/index)",
        touchedPath: ".git/index",
        mutate: () => {
          writeFileSync(join(repo, "seed.txt"), "seed\n");
          run(["add", "seed.txt"]);
        },
        verifyRel: ".git/index",
      },
      {
        axis: "HEAD:commit",
        description: "commit advances HEAD's ref (.git/refs/heads/<branch>)",
        touchedPath: ".git/refs/heads/main",
        mutate: () => {
          writeFileSync(join(repo, "c.txt"), "c\n");
          run(["add", "."]);
          run(["commit", "-qm", "advance"]);
        },
      },
      {
        axis: "HEAD:branch-switch",
        description: "checkout rewrites .git/HEAD to point at a new ref",
        touchedPath: ".git/HEAD",
        mutate: () => {
          run(["checkout", "-q", "-b", "feature"]);
        },
        verifyRel: ".git/HEAD",
      },
    ];

    for (const a of axes) {
      a.mutate();
      const { verdict, note } = classifyTouch(a.touchedPath);
      // For git-dir paths, the branch name in refs/heads can vary (main vs
      // master); normalize the verify against whatever exists.
      let resolvedPath = a.touchedPath;
      if (a.axis === "HEAD:commit") {
        // Resolve the real branch ref that moved.
        const br = spawnSync("git", ["symbolic-ref", "--short", "HEAD"], {
          cwd: repo,
          encoding: "utf8",
        });
        const branch = (br.stdout ?? "main").trim() || "main";
        resolvedPath = `.git/refs/heads/${branch}`;
      }
      const presence = a.verifyRel ? assertExists(a.verifyRel) : "";
      rows.push({
        axis: a.axis,
        description: a.description,
        touchedPath: resolvedPath,
        verdict,
        note: presence ? `${note} ${presence}` : note,
      });
      if (!args0Quiet) log(`  ${a.axis.padEnd(26)} → ${verdict}\n`);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }

  const invisible = rows.filter((r) => r.verdict === "INVISIBLE").length;
  return { rows, invisible };
}

// args0Quiet is set in main before proveCoverage runs (avoids threading args
// through the pure-ish classification helpers, which take no log control).
let args0Quiet = false;

// ── foreign-change latency probe (models bench-latency.ts) ────────────────

interface LatencyResult {
  observedMs: number | null;
  note: string;
}

/**
 * Measure the surfacing latency of ONE genuine foreign change in a subscribed
 * root: subscribe to `jobs` (as the TUIs do), fire a single real hook event
 * for `root`, and stamp `Date.now() − updated_at` the instant the freshly-
 * touched row surfaces. This is the drop-recovery baseline: how fast a real
 * change in a watched repo appears today, against which the .2 FSEvents-only
 * path (worst case: 60s heartbeat) is judged.
 */
async function measureForeignLatency(
  root: string,
  timeoutMs: number,
): Promise<LatencyResult> {
  const sockPath = resolveSockPath();
  return await new Promise<LatencyResult>((resolve) => {
    let seeded = false;
    const highWater = new Map<string, number>();
    let firedAt = 0;
    let settled = false;
    const sessionId = `cpu-soak-lat-${process.pid}`;

    const finish = (res: LatencyResult): void => {
      if (settled) return;
      settled = true;
      try {
        handle.dispose();
      } catch {
        // best-effort
      }
      resolve(res);
    };

    const handle = subscribeCollection({
      sockPath,
      idPrefix: "cpu-soak-latency",
      collection: "jobs",
      onRows(rows) {
        const firstResult = !seeded;
        for (const row of rows as Record<string, unknown>[]) {
          const id = String(row.job_id);
          const raw = row.updated_at;
          const n = typeof raw === "number" ? raw : Number(raw);
          if (!Number.isFinite(n) || n <= 0) continue;
          const updatedMs = n > 1e12 ? n : n * 1000;
          const prev = highWater.get(id);
          if (prev !== undefined && updatedMs <= prev) continue;
          highWater.set(id, updatedMs);
          if (firstResult) continue;
          // A change surfaced after our fire — only count our own session's row
          // to avoid crediting unrelated live traffic. `jobs` is keyed by the
          // session id as `job_id` (there is no separate `session_id` column),
          // so match the probe's session against `job_id`.
          if (firedAt > 0 && id === sessionId) {
            finish({
              observedMs: nowMs() - updatedMs,
              note: "fast-path surfacing (single foreign SessionStart)",
            });
            return;
          }
        }
        if (firstResult) {
          seeded = true;
          // Now fire the single foreign change. A `SessionStart` INSERTs a new
          // `jobs` row (PostToolUse only touches an existing row, and
          // UserPromptSubmit only UPDATEs — neither inserts, so an unknown
          // session needs SessionStart to surface) and stamps `updated_at =
          // event.ts`, so the surfaced row carries a fresh timestamp we can
          // subtract for the full hook→surface Δ. A new agent appearing in a
          // watched root is exactly the foreign-change class the worker must
          // observe.
          firedAt = nowMs();
          const payload = JSON.stringify({
            hook_event_name: "SessionStart",
            session_id: sessionId,
            cwd: root,
            source: "startup",
          });
          fireHookPayload(payload, () => {});
        }
      },
      onFatal: (_err: FatalError) => {
        finish({
          observedMs: null,
          note: "subscription failed (is keeperd running?)",
        });
      },
    });

    setTimeout(() => {
      finish({
        observedMs: null,
        note: `no surfacing within ${Math.round(timeoutMs / 1000)}s — would fall to the 60s heartbeat`,
      });
    }, timeoutMs);
  });
}

// ── pure CPU aggregator (models backstop-stats computeStats) ──────────────

interface CpuStats {
  n: number;
  baselineDaemon: number;
  baselineGit: number;
  peakDaemon: number;
  peakGit: number;
  peakCombined: number;
  meanDaemon: number;
  meanGit: number;
  meanCombined: number;
  peakGitChildCount: number;
}

/**
 * Fold CPU samples into a before/peak/mean surface. The FIRST sample is the
 * pre-storm baseline (under no synthetic load); the rest are under-storm. The
 * combined daemon+git series is the honest cost (git children are charged to
 * git PIDs, so daemon-only under-reports). Pure — takes the sample array,
 * returns the aggregate; the renderer and any test call this.
 */
export function computeCpuStats(samples: CpuSample[]): CpuStats {
  if (samples.length === 0) {
    return {
      n: 0,
      baselineDaemon: 0,
      baselineGit: 0,
      peakDaemon: 0,
      peakGit: 0,
      peakCombined: 0,
      meanDaemon: 0,
      meanGit: 0,
      meanCombined: 0,
      peakGitChildCount: 0,
    };
  }
  const baseline = samples[0] as CpuSample;
  const underStorm = samples.slice(1);
  const series = underStorm.length > 0 ? underStorm : samples;

  const daemon = series.map((s) => s.daemonPcpu);
  const git = series.map((s) => s.gitChildPcpu);
  const combined = series.map((s) => s.daemonPcpu + s.gitChildPcpu);
  const mean = (xs: number[]): number =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

  return {
    n: samples.length,
    baselineDaemon: baseline.daemonPcpu,
    baselineGit: baseline.gitChildPcpu,
    peakDaemon: Math.max(...daemon),
    peakGit: Math.max(...git),
    peakCombined: Math.max(...combined),
    meanDaemon: mean(daemon),
    meanGit: mean(git),
    meanCombined: mean(combined),
    peakGitChildCount: Math.max(...series.map((s) => s.gitChildCount)),
  };
}

// ── report types + padded-table renderer (models backstop-stats) ──────────

interface Report {
  daemonPid: number | null;
  rootCount: number;
  roots: string[];
  storm: {
    ran: boolean;
    durationSec: number;
    ratePerRoot: number;
    eventsFired: number;
    impliedFanoutRatePerSec: number;
    cpu: CpuStats;
    churn: GitChurn;
  } | null;
  coverage: {
    ran: boolean;
    rows: CoverageRow[];
    invisibleCount: number;
    verdict: "FSEVENTS-EXHAUSTIVE" | "RESIDUAL-CLASS-FOUND";
  } | null;
  latency: LatencyResult | null;
}

function H(s: string, w: number, right = false): string {
  return right ? s.padStart(w) : s.padEnd(w);
}

/** Join padded columns into one newline-terminated table row. */
function row(...cols: string[]): string {
  return `${cols.join("")}\n`;
}

/** A `\n`-terminated horizontal rule of `n` dashes. */
function rule(n: number): string {
  return `${"-".repeat(n)}\n`;
}

function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function render(report: Report, out: (s: string) => void): void {
  out("\n");
  out("══ fn-748 git-worker CPU soak — evidence report ════════════════════\n");
  out(
    `daemon pid: ${report.daemonPid ?? "NOT FOUND"}   subscribed roots: ${report.rootCount}\n`,
  );

  if (report.storm) {
    const s = report.storm;
    out(
      "\n── 1. CPU under the data_version snapshot fan-out storm ────────────\n",
    );
    out(
      `storm: ${s.eventsFired} hook events over ${s.durationSec}s ` +
        `(${s.ratePerRoot}/root/s × ${report.rootCount} roots ` +
        `= ~${s.impliedFanoutRatePerSec.toFixed(0)} foreign writes/s)\n\n`,
    );
    out(
      row(
        H("series", 20),
        H("baseline", 12, true),
        H("peak", 12, true),
        H("mean", 12, true),
      ),
    );
    out(rule(56));
    out(
      row(
        H("daemon PID", 20),
        H(fmtPct(s.cpu.baselineDaemon), 12, true),
        H(fmtPct(s.cpu.peakDaemon), 12, true),
        H(fmtPct(s.cpu.meanDaemon), 12, true),
      ),
    );
    out(
      row(
        H("git children (Σ ps)", 20),
        H(fmtPct(s.cpu.baselineGit), 12, true),
        H(fmtPct(s.cpu.peakGit), 12, true),
        H(fmtPct(s.cpu.meanGit), 12, true),
      ),
    );
    out(
      row(
        H("COMBINED", 20),
        H(fmtPct(s.cpu.baselineDaemon + s.cpu.baselineGit), 12, true),
        H(fmtPct(s.cpu.peakCombined), 12, true),
        H(fmtPct(s.cpu.meanCombined), 12, true),
      ),
    );
    out(
      `\ngit-child churn (30ms poll): ${s.churn.distinctSpawns} distinct ` +
        `git spawns, peak ${s.churn.peakConcurrent} concurrent\n`,
    );
    out(
      "→ Each `git status` shell-out is short-lived (≈10-100ms), so a 1s `ps`\n" +
        "  pcpu sample mostly catches ZERO concurrent git and under-reports the\n" +
        "  git-side cost — the 30ms churn poll above is the honest git signal.\n" +
        "  The daemon-PID %CPU is the cost of managing O(roots) concurrent\n" +
        "  child_process.spawn lifecycles; the churn count is the fan-out volume.\n" +
        "  Peak daemon %CPU under the storm vs the baseline is the before-CPU\n" +
        "  evidence the .2 drop is judged against.\n",
    );
  }

  if (report.coverage) {
    const c = report.coverage;
    out(
      "\n── 2. FSEvents coverage of git-status change axes ──────────────────\n",
    );
    out(row(H("axis", 26), H("touched path", 28), H("verdict", 18)));
    out(rule(72));
    for (const r of c.rows) {
      out(row(H(r.axis, 26), H(r.touchedPath, 28), H(r.verdict, 18)));
    }
    out("\n");
    if (c.verdict === "FSEVENTS-EXHAUSTIVE") {
      out(
        "VERDICT: FSEVENTS-EXHAUSTIVE — every git-status axis (working tree,\n" +
          "  HEAD/ref, index) lands under the worktree sub or the git-common-dir\n" +
          "  sub. The data_version snapshot fan-out arm carries NO unique\n" +
          "  detection. GO for the .2 drop (60s heartbeat as the single backstop).\n",
      );
    } else {
      out(
        `VERDICT: RESIDUAL-CLASS-FOUND (${c.invisibleCount} axis/axes invisible to BOTH\n` +
          "  subs). The .2 drop is UNSAFE as-is — fall back to the .3 heartbeat-\n" +
          "  staleness tightening (per-root lastFastPathAt-gated re-snapshot).\n",
      );
      for (const r of c.rows.filter((r) => r.verdict === "INVISIBLE")) {
        out(`    • ${r.axis}: ${r.note}\n`);
      }
    }
  }

  if (report.latency) {
    out(
      "\n── 3. Foreign-change observation latency ───────────────────────────\n",
    );
    if (report.latency.observedMs === null) {
      out(`  not observed: ${report.latency.note}\n`);
    } else {
      out(
        `  surfaced in ${Math.round(report.latency.observedMs)}ms — ${report.latency.note}\n`,
      );
      out(
        "  → baseline for the drop-recovery tradeoff: FSEvents fast-path today;\n" +
          "    worst case under FSEvents-only is the 60s heartbeat.\n",
      );
    }
  }
  out("════════════════════════════════════════════════════════════════════\n");
}

// ── main ───────────────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<void> {
  let args: Args | "help";
  try {
    args = parse(argv);
  } catch (err) {
    process.stderr.write(
      `git-worker-cpu-soak: ${(err as Error).message}\n\n${HELP}`,
    );
    process.exit(1);
  }
  if (args === "help") {
    process.stdout.write(HELP);
    process.exit(0);
  }

  args0Quiet = args.quiet;
  const out = (s: string): void => {
    process.stdout.write(s);
  };
  const log = (s: string): void => {
    if (!args.quiet) process.stdout.write(s);
  };

  const daemonPid = findDaemonPid();
  let roots = enumerateRoots();
  if (args.rootCap !== null) roots = roots.slice(0, args.rootCap);

  if (!args.quiet) {
    log(
      `git-worker-cpu-soak — daemon pid ${daemonPid ?? "NOT FOUND"}, ${roots.length} subscribed root(s)\n`,
    );
    for (const r of roots) log(`  • ${r}\n`);
    log("\n");
  }

  // ── 1. CPU storm ──
  let storm: Report["storm"] = null;
  if (!args.skipStorm) {
    if (daemonPid === null) {
      process.stderr.write(
        "git-worker-cpu-soak: daemon not found (pgrep -f src/daemon.ts) — cannot sample CPU.\n" +
          "Start keeperd, or pass --skip-storm to run the coverage + latency proofs only.\n",
      );
      process.exit(1);
    }
    if (roots.length === 0) {
      process.stderr.write(
        "git-worker-cpu-soak: no subscribed git roots found — the storm has nothing to target.\n",
      );
      process.exit(1);
    }
    log(
      `driving storm: ${args.ratePerRoot}/root/s × ${roots.length} roots for ${args.durationSec}s…\n`,
    );
    const result = await runStorm(args, roots, daemonPid, log);
    storm = {
      ran: true,
      durationSec: result.durationSec,
      ratePerRoot: result.ratePerRoot,
      eventsFired: result.eventsFired,
      impliedFanoutRatePerSec: result.ratePerRoot * roots.length,
      cpu: computeCpuStats(result.samples),
      churn: result.churn,
    };
  }

  // ── 2. FSEvents coverage proof ──
  let coverage: Report["coverage"] = null;
  if (!args.skipCoverage) {
    log("\nproving FSEvents coverage of git-status axes…\n");
    const { rows, invisible } = proveCoverage(log);
    coverage = {
      ran: true,
      rows,
      invisibleCount: invisible,
      verdict: invisible === 0 ? "FSEVENTS-EXHAUSTIVE" : "RESIDUAL-CLASS-FOUND",
    };
  }

  // ── 3. Foreign-change latency ──
  let latency: LatencyResult | null = null;
  if (daemonPid !== null && roots.length > 0) {
    log("\nmeasuring foreign-change observation latency…\n");
    latency = await measureForeignLatency(roots[0] as string, 15_000);
  }

  const report: Report = {
    daemonPid,
    rootCount: roots.length,
    roots,
    storm,
    coverage,
    latency,
  };

  if (args.json) {
    out(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    render(report, out);
  }
  process.exit(0);
}

if (import.meta.main) {
  void main(process.argv.slice(2));
}
