/**
 * The supervised Baseline runner (docs/adr/0005). Consumes the CLI-written
 * request spool, computes the fast-gate suite result once per key in a detached
 * scratch worktree, and is the SOLE writer of the per-key result leafs. One
 * computation serves every asker of the same key; distinct keys queue behind a
 * single-slot runner.
 *
 * A Baseline (glossary term — NEVER "cache" / "snapshot" / "golden") is the
 * daemon-computed suite result at a commit sha a worker consults to attribute a
 * test failure as pre-existing or self-inflicted. The request queue is the
 * "spool"; each durable result file is a "leaf".
 *
 * ## Worker contract (CLAUDE.md "Worker contract")
 *
 * - `isMainThread` guard — a plain import (tests driving the pure decision core)
 *   is inert.
 * - Owns NO DB handle: the Baseline surface is file-based, never a projection,
 *   never a synthetic event, never keeper.db. It writes ONLY result leafs (its
 *   sole-writer surface) and reaps its own scratch worktrees.
 * - Typed messages: `{type:"shutdown"}` main→worker; the worker posts nothing
 *   back (leafs are its output, read directly off disk).
 * - Supervisor-owned lifecycle: main spawns after migrate+boot-drain and is the
 *   sole terminator; on `onerror`/`close` main `fatalExit`s.
 *
 * ## Poll loop + containment (the keystone safety property)
 *
 * `setTimeout`-after-completion with an in-flight skip flag (the builds-worker
 * archetype), runner concurrency ONE. EVERY failure — a checkout that cannot
 * resolve the sha, a frozen-lockfile install drift, a crashed or timed-out suite
 * — is caught inside the loop and folded into an infra-error / timeout leaf a
 * reader can never mistake for green. Nothing escapes to main's onerror/fatalExit:
 * a red or flaky suite must never crash-loop the daemon.
 *
 * ## Reap on every path; boot prunes orphans
 *
 * The scratch worktree is reaped on EVERY outcome including crash and timeout (the
 * suite runs detached in its own process group, killed group-wide on the deadline
 * so no zombie survives). At boot every registered scratch worktree is by
 * definition a crashed-run orphan (the single-slot runner has not started), so all
 * are pruned — bounding the disk DoS surface.
 *
 * ## Dependency posture
 *
 * `node:*` plus the dep-free `baseline-store` / `worktree-git` / `git-exec`
 * leaves. NEVER `bun:sqlite` / `src/db.ts`. The decision core (spool ordering,
 * dedupe, deadline→timeout, retry/flaky classification, boot-prune planning,
 * install-failure classification, missing-gate classification, suite-output parsing)
 * is exported PURE and drives the whole test suite without a Worker, subprocess,
 * or git.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import {
  type BaselineOutcome,
  type BaselineRequest,
  deriveResult,
  leafDir,
  leafPath,
  MAX_MESSAGE_LEN,
  pruneLeafs,
  readLeaf,
  readRequest,
  type SuiteRun,
  spoolDir,
  writeLeaf,
} from "./baseline-store";
import {
  GIT_LOCAL_TIMEOUT_MS,
  type GitRunner,
  gitExec,
} from "./commit-work/git-exec";
import {
  BASELINE_SCRATCH_PREFIX,
  baselineScratchPathFor,
  provisionScratchWorktree,
  pruneBaselineScratchWorktrees,
  removeScratchWorktree,
} from "./worktree-git";

// ── constants ────────────────────────────────────────────────────────────────

/** Spool poll cadence — fixed, no backoff. Overridable via workerData (tests). */
const DEFAULT_POLL_MS = 2_000;
/** Deadline for `bun install --frozen-lockfile` in a scratch worktree. */
const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60_000;
/** Deadline for ONE gate-phase suite run; expiry → a timeout leaf. */
const DEFAULT_SUITE_DEADLINE_MS = 15 * 60_000;
/** Cap on spool files parsed per tick — a belt against a pathological spool. */
const MAX_SPOOL_SCAN = 1024;
/** Cap on captured suite output bytes — a belt against a chatty suite. */
const MAX_CAPTURE_BYTES = 8 << 20;
/** Bytes of suite output kept as an infra/crash message tail. */
const MESSAGE_TAIL_BYTES = 1024;
/**
 * Grace after a deadline's `killGroup` before `runDetached` force-resolves to a
 * timeout outcome even if `close` never fires (a double-forked grandchild can
 * hold the pipe open past the SIGKILL). Overridable per-call (tests).
 */
const DEFAULT_KILL_GRACE_MS = 5_000;

// ── types ────────────────────────────────────────────────────────────────────

/** Data the parent passes via `new Worker(url, { workerData })`. All optional — production omits them and takes the defaults. */
export interface BaselineWorkerData {
  /** The role marker the bootstrap gates on so `main()` boots ONLY in a Worker
   *  spawned AS the baseline runner — NEVER as a stowaway when another worker
   *  module (e.g. `autopilot-worker`, for the merge-suite gate's pure suite-run
   *  helpers) imports this one. Mirrors `autopilot-worker`'s role gate. */
  role?: "baseline";
  /** Override the state dir (spool + leaf root); production omits → keeperStateDir(). */
  stateDir?: string;
  /** Override the out-of-repo scratch worktree root; production omits → `${homedir()}/worktrees`. */
  worktreesRoot?: string;
  /** Poll cadence override (ms). */
  pollMs?: number;
  /** Install deadline override (ms). */
  installTimeoutMs?: number;
  /** Suite-run deadline override (ms). */
  suiteDeadlineMs?: number;
}

/** Message the parent sends to ask the worker to stop. */
export interface ShutdownMessage {
  type: "shutdown";
}

/** Parsed signal from one gate-phase suite run's stdout+stderr. */
export interface ParsedGate {
  /** Failing-test identities (`describe > … > test`), in output order. */
  failingTests: string[];
  /** The summary `N pass` count, or null when no summary was seen. */
  passCount: number | null;
  /** The summary `N fail` count, or null when no summary was seen. */
  failCount: number | null;
}

/**
 * How one completed suite run classifies. `clean` is the ONLY green-eligible
 * class; `crashed` (a non-zero exit with no test-failure signal — a compile error
 * or a bail) is an infra failure, never an empty "ran" that could fold to green.
 */
export type RunClass = "clean" | "failed" | "crashed";

/** One classified run plus its raw {@link SuiteRun} and a crash/infra detail. */
export interface RunRecord {
  run: SuiteRun;
  cls: RunClass;
  detail: string;
}

/** One parsed spool file. */
export interface SpoolEntry {
  file: string;
  request: BaselineRequest;
}

/** All spool files sharing one key, plus a representative request. */
export interface SpoolGroup {
  key: string;
  files: string[];
  requestedAt: number;
  request: BaselineRequest;
}

/** A scratch worktree dir on disk with its resolved parent repo (null = dangling). */
export interface ScratchDir {
  path: string;
  parentRepo: string | null;
}

/** The raw outcome of one detached subprocess run (install or a suite run). */
export interface RawRun {
  startedAt: number;
  durationMs: number;
  exitCode: number;
  timedOut: boolean;
  output: string;
}

// ── pure decision core (exported, unit-driven) ───────────────────────────────

export function noTestGateOutcome(): BaselineOutcome {
  return {
    kind: "infra",
    infra: "spawn",
    message: "no test-gate script in package.json at sha",
  };
}

/** Keep only the last `MESSAGE_TAIL_BYTES` chars — errors cluster at the end. */
function tail(output: string): string {
  const trimmed = output.trim();
  return trimmed.length > MESSAGE_TAIL_BYTES
    ? trimmed.slice(trimmed.length - MESSAGE_TAIL_BYTES)
    : trimmed;
}

/** A non-clean run's detail message — the output tail, or a stable fallback. */
export function crashDetail(output: string): string {
  const t = tail(output);
  return t.length > 0 ? t : "suite exited non-zero with no failing-test output";
}

/**
 * Parse a gate-phase run's combined stdout+stderr into failing-test identities and
 * the summary pass/fail counts. Bun prints one `(fail) <name> [<dur>ms]` line per
 * failing test and a `N pass` / `N fail` summary. The identity is everything
 * between `(fail) ` and the trailing `[<dur>]`, so a name containing brackets
 * survives. PURE — the whole parser is unit-driven against fixture output.
 */
export function parseGateOutput(output: string): ParsedGate {
  const failingTests: string[] = [];
  for (const line of output.split("\n")) {
    if (!line.startsWith("(fail) ")) continue;
    // Strip the marker, then a trailing ` [<number>ms|s]` duration if present.
    const id = line
      .slice("(fail) ".length)
      .replace(/\s+\[[0-9.]+\s*m?s\]\s*$/, "")
      .trim();
    if (id.length > 0) failingTests.push(id);
  }
  return {
    failingTests,
    passCount: lastCount(output, /^\s*(\d+)\s+pass\b/gm),
    failCount: lastCount(output, /^\s*(\d+)\s+fail\b/gm),
  };
}

/** The last capture-1 integer a global regex matches, or null. */
function lastCount(output: string, re: RegExp): number | null {
  let last: number | null = null;
  for (const m of output.matchAll(re)) {
    const n = Number.parseInt(m[1] as string, 10);
    if (Number.isFinite(n)) last = n;
  }
  return last;
}

/**
 * Classify one completed (non-timeout) run. Exit 0 is the ONLY green-eligible
 * class; a non-zero exit WITH a failing-test signal is a real suite failure; a
 * non-zero exit with NO failing-test signal is a crash/bail (infra), never an
 * empty "ran" that {@link deriveResult} could fold to green. PURE.
 */
export function classifyRun(exitCode: number, parsed: ParsedGate): RunClass {
  if (exitCode === 0) return "clean";
  if (parsed.failingTests.length > 0 || (parsed.failCount ?? 0) > 0) {
    return "failed";
  }
  return "crashed";
}

/** A failed run is retried once at the same sha to derive flaky-suspect marks. PURE. */
export function shouldRetry(cls: RunClass): boolean {
  return cls === "failed";
}

/**
 * Fold run 1 and its optional retry into the outcome {@link deriveResult}
 * classifies. A clean run 1 is green; a crashed run 1 is infra:spawn; a failed
 * run 1 carries BOTH runs so fail-then-pass at the same sha derives flaky, UNLESS
 * the retry crashed/timed out — then run 1's real failures stand alone as hard
 * failures rather than being diluted to flaky by an inconclusive retry. PURE.
 */
export function finalOutcome(
  run1: RunRecord,
  run2: RunRecord | null,
): BaselineOutcome {
  if (run1.cls === "clean") return { kind: "ran", runs: [run1.run] };
  if (run1.cls === "crashed") {
    return {
      kind: "infra",
      infra: "spawn",
      message: run1.detail || "suite failed to run",
    };
  }
  // run1 failed.
  if (run2 === null || run2.cls === "crashed") {
    return { kind: "ran", runs: [run1.run] };
  }
  return { kind: "ran", runs: [run1.run, run2.run] };
}

/** A deadline expiry → a timeout outcome carrying whatever partial runs completed. PURE. */
export function timeoutOutcome(
  deadlineMs: number,
  runs: SuiteRun[],
): BaselineOutcome {
  return { kind: "timeout", deadlineMs, runs };
}

/** Build a {@link SuiteRun} from a raw run + its parse — a timed-out run reports exit 124. PURE. */
export function toSuiteRun(raw: RawRunLike, parsed: ParsedGate): SuiteRun {
  return {
    startedAt: raw.startedAt,
    durationMs: raw.durationMs,
    exitCode: raw.timedOut ? 124 : raw.exitCode,
    failingTests: parsed.failingTests,
  };
}

/** The subset of a raw run {@link toSuiteRun} reads — lets tests drive it without a subprocess. */
export interface RawRunLike {
  startedAt: number;
  durationMs: number;
  exitCode: number;
  timedOut: boolean;
}

/**
 * Why a frozen-lockfile install could not produce a clean environment, or null
 * when it succeeded. A legitimate lockfile-drift failure at an old sha is
 * infra:install — never a retry loop. PURE.
 */
export function installFailureReason(
  exitCode: number,
  timedOut: boolean,
): string | null {
  if (timedOut) return "frozen-lockfile install timed out";
  if (exitCode !== 0) {
    return `frozen-lockfile install failed (exit ${exitCode})`;
  }
  return null;
}

/**
 * Group spool entries by key and order the groups oldest-first (by each key's
 * earliest `requestedAt`, key-tiebroken for determinism). One group is one
 * computation; every file in it is a coalesced asker of the same key. PURE — the
 * spool ordering + same-key dedupe core.
 */
export function planSpool(entries: SpoolEntry[]): SpoolGroup[] {
  const byKey = new Map<string, SpoolGroup>();
  for (const entry of entries) {
    const key = entry.request.key;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        key,
        files: [entry.file],
        requestedAt: entry.request.requestedAt,
        request: entry.request,
      });
      continue;
    }
    existing.files.push(entry.file);
    if (entry.request.requestedAt < existing.requestedAt) {
      existing.requestedAt = entry.request.requestedAt;
      existing.request = entry.request;
    }
  }
  const groups = [...byKey.values()];
  for (const g of groups) g.files.sort();
  groups.sort(
    (a, b) =>
      a.requestedAt - b.requestedAt ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  return groups;
}

/** The spool filenames whose request key matches — the coalesced set to delete. PURE. */
export function spoolFilesForKey(entries: SpoolEntry[], key: string): string[] {
  return entries.filter((e) => e.request.key === key).map((e) => e.file);
}

/**
 * Plan the boot orphan sweep from the scratch dirs found on disk: prune every
 * distinct resolvable parent repo (one `pruneBaselineScratchWorktrees` reaps all
 * of a repo's scratch siblings), and `rm` any dangling dir whose parent repo is
 * gone (no admin entry left to prune). PURE. Deterministic ordering. PURE.
 */
export function planBootPrune(scratchDirs: ScratchDir[]): {
  pruneRepos: string[];
  rmDirs: string[];
} {
  const repos = new Set<string>();
  const rmDirs: string[] = [];
  for (const d of scratchDirs) {
    if (d.parentRepo) repos.add(d.parentRepo);
    else rmDirs.push(d.path);
  }
  return {
    pruneRepos: [...repos].sort(),
    rmDirs: rmDirs.sort(),
  };
}

/**
 * The cleanup owed after a computation attempt: the scratch worktree is reaped on
 * EVERY path; the coalesced spool entries are deleted ONLY when a leaf actually
 * landed (a failed leaf write leaves the spool intact so the key recomputes). PURE.
 */
export function cleanupPlan(leafWritten: boolean): {
  reap: true;
  deleteSpool: boolean;
} {
  return { reap: true, deleteSpool: leafWritten };
}

// ── impure runtime ───────────────────────────────────────────────────────────

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resources the in-flight computation owns, tracked module-side so the shutdown
 * handler can kill the suite process group and reap the scratch worktree. Only
 * ever touched on the worker thread (the pure core never reads these).
 */
let activeChild: ChildProcess | null = null;
let activeScratch: { repoDir: string; path: string } | null = null;

/** Injectable spawn override for {@link runDetached} — same shape as node's `spawn`,
 *  exported so other producers (the merge-suite gate) can share the same seam type. */
export type SpawnFn = typeof spawn;

/** SIGKILL an entire detached process group (pgid = child pid). Best-effort. */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already dead / no such group — nothing to kill.
  }
}

/**
 * Run `file args…` DETACHED in its own process group under a deadline, draining
 * both pipes into a size-capped buffer. On the deadline the whole group is
 * SIGKILLed and the exit consumed (no zombies). Never rejects — a spawn failure
 * resolves as exit 127 so the caller stays on its verdict path.
 *
 * A killed-but-pipe-holding grandchild (double-forked out of the group) can
 * defer `close` indefinitely; a bounded grace timer after `killGroup` force-
 * resolves to the same timeout outcome so the single-slot runner never wedges.
 * `opts` is the injectable seam (tests): override the spawn function and the
 * grace to exercise the deadline→force-resolve liveness path without a real
 * double-forked grandchild.
 */
export function runDetached(
  file: string,
  args: string[],
  cwd: string,
  deadlineMs: number,
  opts?: { spawnFn?: SpawnFn; killGraceMs?: number },
): Promise<RawRun> {
  const spawnFn = opts?.spawnFn ?? spawn;
  const killGraceMs = opts?.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  return new Promise<RawRun>((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    const finish = (exitCode: number, timedOut: boolean, output: string) => {
      if (settled) return;
      settled = true;
      if (activeChild === child) activeChild = null;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({
        startedAt,
        durationMs: Date.now() - startedAt,
        exitCode,
        timedOut,
        output,
      });
    };

    let child: ChildProcess;
    try {
      child = spawnFn(file, args, {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
    } catch (err) {
      resolve({
        startedAt,
        durationMs: 0,
        exitCode: 127,
        timedOut: false,
        output: `spawn failed: ${stringifyErr(err)}`,
      });
      return;
    }
    activeChild = child;

    let output = "";
    let bytes = 0;
    const onData = (buf: Buffer): void => {
      if (bytes >= MAX_CAPTURE_BYTES) return;
      const s = buf.toString("utf8");
      output += s;
      bytes += Buffer.byteLength(s);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    let timedOut = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
      // `close` can be deferred indefinitely by a pipe-holding grandchild;
      // force the outcome after a bounded grace so the runner never wedges.
      graceTimer = setTimeout(() => {
        finish(124, true, output);
      }, killGraceMs);
    }, deadlineMs);

    child.on("error", (err) => {
      finish(127, false, `spawn error: ${stringifyErr(err)}`);
    });
    child.on("close", (code, signal) => {
      const exit = timedOut ? 124 : (code ?? (signal ? 128 : 1));
      finish(exit, timedOut, output);
    });
  });
}

/**
 * Compute one Baseline end-to-end and write its leaf. Returns whether a leaf
 * landed (false only on a shutdown-abandon or a leaf-write failure, so the caller
 * retains the spool for a recompute). NEVER throws — every failure folds to an
 * infra/timeout leaf. Reaps the scratch worktree on every path.
 */
async function computeBaseline(
  request: BaselineRequest,
  opts: {
    stateDir: string | undefined;
    worktreesRoot: string | undefined;
    installTimeoutMs: number;
    suiteDeadlineMs: number;
    isShuttingDown: () => boolean;
    run: GitRunner;
  },
): Promise<boolean> {
  const { stateDir, worktreesRoot, installTimeoutMs, suiteDeadlineMs } = opts;
  const key = request.key;
  const leaf = leafPath(key, stateDir);
  const scratchPath = baselineScratchPathFor(
    request.repoDir,
    request.sha,
    worktreesRoot,
  );
  const computedAt = Date.now();
  let leafWritten = false;
  const writeOutcome = (outcome: BaselineOutcome): void => {
    try {
      writeLeaf(
        leaf,
        deriveResult({
          key,
          sha: request.sha,
          toolchain: request.toolchain,
          computedAt,
          outcome,
        }),
      );
      leafWritten = true;
    } catch (err) {
      // A lost leaf leaves the spool intact (leafWritten stays false) so the key
      // recomputes rather than stranding the asker on a false miss.
      console.error(
        `[baseline-worker] leaf write failed for ${key}: ${stringifyErr(err)}`,
      );
    }
  };

  activeScratch = { repoDir: request.repoDir, path: scratchPath };
  try {
    const prov = await provisionScratchWorktree(
      request.repoDir,
      scratchPath,
      request.sha,
      opts.run,
    );
    if (prov.kind === "checkout-failed") {
      writeOutcome({ kind: "infra", infra: "checkout", message: prov.detail });
      return leafWritten;
    }
    if (opts.isShuttingDown()) return false;

    const install = await runDetached(
      "bun",
      ["install", "--frozen-lockfile"],
      scratchPath,
      installTimeoutMs,
    );
    if (opts.isShuttingDown()) return false;
    const installReason = installFailureReason(
      install.exitCode,
      install.timedOut,
    );
    if (installReason !== null) {
      const t = tail(install.output);
      writeOutcome({
        kind: "infra",
        infra: "install",
        message: t.length > 0 ? `${installReason}: ${t}` : installReason,
      });
      return leafWritten;
    }

    const gateCmd = readTestGateCommand(scratchPath);
    if (gateCmd === null) {
      writeOutcome(noTestGateOutcome());
      return leafWritten;
    }

    const raw1 = await runDetached(
      "/bin/sh",
      ["-c", gateCmd],
      scratchPath,
      suiteDeadlineMs,
    );
    if (opts.isShuttingDown()) return false;
    const parsed1 = parseGateOutput(raw1.output);
    const suiteRun1 = toSuiteRun(raw1, parsed1);

    let outcome: BaselineOutcome;
    if (raw1.timedOut) {
      outcome = timeoutOutcome(suiteDeadlineMs, [suiteRun1]);
    } else {
      const cls1 = classifyRun(raw1.exitCode, parsed1);
      if (shouldRetry(cls1)) {
        const raw2 = await runDetached(
          "/bin/sh",
          ["-c", gateCmd],
          scratchPath,
          suiteDeadlineMs,
        );
        if (opts.isShuttingDown()) return false;
        const parsed2 = parseGateOutput(raw2.output);
        const suiteRun2 = toSuiteRun(raw2, parsed2);
        const cls2: RunClass = raw2.timedOut
          ? "crashed"
          : classifyRun(raw2.exitCode, parsed2);
        outcome = finalOutcome(
          { run: suiteRun1, cls: "failed", detail: "" },
          {
            run: suiteRun2,
            cls: cls2,
            detail: raw2.timedOut
              ? "retry timed out"
              : crashDetail(raw2.output),
          },
        );
      } else {
        outcome = finalOutcome(
          { run: suiteRun1, cls: cls1, detail: crashDetail(raw1.output) },
          null,
        );
      }
    }
    writeOutcome(outcome);
    return leafWritten;
  } catch (err) {
    // Defense in depth: any unexpected throw folds to an infra leaf — nothing
    // reaches main's onerror/fatalExit.
    writeOutcome({
      kind: "infra",
      infra: "spawn",
      message: `baseline computation error: ${stringifyErr(err).slice(0, MAX_MESSAGE_LEN)}`,
    });
    return leafWritten;
  } finally {
    // Reap on EVERY path (cleanupPlan.reap is always true) — including crash and
    // timeout, so no scratch worktree lingers under a failed key.
    try {
      await removeScratchWorktree(request.repoDir, scratchPath, opts.run);
    } catch (err) {
      console.error(
        `[baseline-worker] scratch reap failed for ${scratchPath}: ${stringifyErr(err)}`,
      );
    }
    activeScratch = null;
  }
}

export function readTestGateCommand(pkgDir: string): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(join(pkgDir, "package.json"), "utf8"),
    ) as { scripts?: Record<string, unknown> } | null;
    const command = pkg?.scripts?.["test:gate"];
    return typeof command === "string" && command.trim().length > 0
      ? command
      : null;
  } catch {
    return null;
  }
}

/** Parse the spool dir into typed entries, fail-open per file, bounded per tick. */
function readSpool(stateDir: string | undefined): SpoolEntry[] {
  const dir = spoolDir(stateDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries: SpoolEntry[] = [];
  for (const name of names.slice(0, MAX_SPOOL_SCAN)) {
    if (!name.endsWith(".json")) continue;
    const request = readRequest(join(dir, name));
    if (request) entries.push({ file: name, request });
  }
  return entries;
}

/** Delete every spool file whose request key matches — coalesces late askers too. */
function cleanSpoolForKey(key: string, stateDir: string | undefined): void {
  const dir = spoolDir(stateDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const p = join(dir, name);
    const request = readRequest(p);
    if (request && request.key === key) {
      try {
        unlinkSync(p);
      } catch {
        // Already gone — nothing to do.
      }
    }
  }
}

/** Resolve a scratch worktree dir's parent (main) repo via git, or null if dangling. */
async function resolveScratchParent(
  dir: string,
  run: GitRunner,
): Promise<string | null> {
  const res = await run(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      cwd: dir,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    },
  );
  if (res.code !== 0) return null;
  const commonDir = res.stdout.trim();
  if (commonDir.length === 0) return null;
  const parent = commonDir.replace(/\/\.git\/?$/, "");
  return parent.length > 0 ? parent : null;
}

/** Enumerate scratch worktree dirs directly under the worktrees root. */
function gatherScratchDirs(worktreesRoot: string): string[] {
  let names: string[];
  try {
    names = readdirSync(worktreesRoot);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith(BASELINE_SCRATCH_PREFIX))
    .map((n) => join(worktreesRoot, n));
}

/**
 * Prune every orphaned scratch worktree at boot. Any scratch worktree present is
 * a crashed-run orphan (the single-slot runner has not started), so all are
 * reaped. Fail-open — a prune failure for one repo never blocks the rest or boot.
 */
async function bootPrune(worktreesRoot: string, run: GitRunner): Promise<void> {
  const scratchDirs: ScratchDir[] = [];
  for (const path of gatherScratchDirs(worktreesRoot)) {
    let parentRepo: string | null = null;
    try {
      parentRepo = await resolveScratchParent(path, run);
    } catch {
      parentRepo = null;
    }
    scratchDirs.push({ path, parentRepo });
  }
  const plan = planBootPrune(scratchDirs);
  for (const repo of plan.pruneRepos) {
    try {
      await pruneBaselineScratchWorktrees(repo, run);
    } catch (err) {
      console.error(
        `[baseline-worker] boot prune failed for ${repo}: ${stringifyErr(err)}`,
      );
    }
  }
  for (const dir of plan.rmDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Dangling dir already gone — nothing to do.
    }
  }
}

/**
 * Worker entrypoint. Boot-prunes orphaned scratch worktrees, then drives the
 * single-slot poll loop (setTimeout-after-completion, in-flight skip). Shutdown
 * kills the in-flight suite group, reaps its scratch worktree, and exits clean.
 */
function main(): void {
  if (!parentPort) {
    console.error("[baseline-worker] no parentPort — not running as a Worker");
    process.exit(1);
  }

  const data = (workerData ?? {}) as BaselineWorkerData;
  const stateDir = data.stateDir;
  const worktreesRoot = data.worktreesRoot ?? `${homedir()}/worktrees`;
  const pollMs =
    typeof data.pollMs === "number" && data.pollMs > 0
      ? data.pollMs
      : DEFAULT_POLL_MS;
  const installTimeoutMs =
    typeof data.installTimeoutMs === "number" && data.installTimeoutMs > 0
      ? data.installTimeoutMs
      : DEFAULT_INSTALL_TIMEOUT_MS;
  const suiteDeadlineMs =
    typeof data.suiteDeadlineMs === "number" && data.suiteDeadlineMs > 0
      ? data.suiteDeadlineMs
      : DEFAULT_SUITE_DEADLINE_MS;
  const run: GitRunner = gitExec;

  let shuttingDown = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const isShuttingDown = (): boolean => shuttingDown;

  const scheduleNext = (): void => {
    if (shuttingDown) return;
    timer = setTimeout(() => {
      void tick();
    }, pollMs);
  };

  const processOne = async (): Promise<void> => {
    const entries = readSpool(stateDir);
    const groups = planSpool(entries);
    if (groups.length === 0) return;
    const group = groups[0] as SpoolGroup;

    // A valid leaf already on disk (a prior boot computed it) coalesces every
    // asker onto it — clean the spool, skip the recompute.
    const existing = readLeaf(leafPath(group.key, stateDir));
    const leafWritten = existing
      ? true
      : await computeBaseline(group.request, {
          stateDir,
          worktreesRoot,
          installTimeoutMs,
          suiteDeadlineMs,
          isShuttingDown,
          run,
        });

    if (cleanupPlan(leafWritten).deleteSpool) {
      cleanSpoolForKey(group.key, stateDir);
    }
    // Bound the leaf count on disk — retention is eviction, never invalidation.
    try {
      pruneLeafs(leafDir(stateDir));
    } catch {
      // Fail-open — retention must never crash the loop.
    }
  };

  const tick = async (): Promise<void> => {
    if (inFlight || shuttingDown) return;
    inFlight = true;
    try {
      await processOne();
    } catch (err) {
      // Defense in depth: processOne is internally no-throw, but a bug here must
      // never reach onerror/fatalExit and crash-loop the daemon.
      console.error(
        `[baseline-worker] tick threw (non-fatal): ${stringifyErr(err)}`,
      );
    } finally {
      inFlight = false;
    }
    scheduleNext();
  };

  parentPort.on("message", (msg: ShutdownMessage | undefined) => {
    if (!msg || msg.type !== "shutdown") return;
    void (async () => {
      shuttingDown = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      // Release the in-flight subprocess (kill its whole group) and reap its
      // scratch worktree; the next boot's prune is the backstop if this is cut short.
      killGroup(activeChild?.pid);
      const scratch = activeScratch;
      if (scratch) {
        try {
          await removeScratchWorktree(scratch.repoDir, scratch.path, run);
        } catch {
          // Best-effort — boot prune reaps any residue.
        }
      }
      process.exit(0);
    })();
  });

  // Boot-prune, then kick the first tick. A prune failure never blocks the loop.
  void (async () => {
    try {
      await bootPrune(worktreesRoot, run);
    } catch (err) {
      console.error(
        `[baseline-worker] boot prune sweep failed (non-fatal): ${stringifyErr(err)}`,
      );
    }
    if (!shuttingDown) void tick();
  })();
}

// Only run inside a real Worker spawned AS the baseline runner (`role: "baseline"`).
// A plain import on the main thread (tests driving the pure decision core) is inert;
// an import from ANOTHER worker module that pulls the pure suite-run helpers from here
// (e.g. `autopilot-worker`'s merge-suite gate) must NOT boot a stowaway baseline
// runner in that thread — the role gate enforces that (mirrors `autopilot-worker`).
if (
  !isMainThread &&
  (workerData as BaselineWorkerData | undefined)?.role === "baseline"
) {
  main();
}
