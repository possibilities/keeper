/**
 * Pure unit pins for `cli/baseline.ts` — the `keeper baseline` read verb. NO
 * subprocess, NO git, NO daemon, NO sleep: every test drives the arg parser,
 * envelope render, exit-code map, or the runner with injected git / clock /
 * sleep / read / write seams (the retryUntil idiom). Expected values are
 * hand-authored fixtures, never re-derived by the code under test — the one
 * exception is the request `key`, asserted against `src/baseline-store`'s
 * separately-pinned `baselineKey` oracle (a DIFFERENT module, the contract this
 * verb speaks), plus its concrete fields asserted against fixtures directly.
 *
 * Covers the task acceptance: sha/repo resolution + clean-JSON hit/miss/computing
 * on a non-mutating bare read; `--wait` writing exactly one well-formed spool
 * request, polling to a caller-owned deadline, exit 0 on any terminal envelope
 * (incl. suite-red), and a distinct non-zero deadline report; and registration.
 */

import { expect, test } from "bun:test";
import {
  EXIT_DEADLINE,
  EXIT_NO_RESULT,
  EXIT_OK,
  EXIT_USAGE,
  isTerminalResult,
  parseBaselineArgs,
  type RunDeps,
  resolveTarget,
  runBaseline,
} from "../cli/baseline";
import { SUBCOMMAND_META } from "../cli/keeper";
import {
  type BaselineReadState,
  type BaselineRequest,
  type BaselineResult,
  baselineKey,
  type ToolchainFingerprint,
} from "../src/baseline-store";
import type { GitExecResult, GitRunner } from "../src/commit-work/git-exec";

// ── fixtures ─────────────────────────────────────────────────────────────────

const TOPLEVEL = "/Users/x/code/keeper";
const SHA = "a".repeat(40);
const TC: ToolchainFingerprint = {
  bunVersion: "1.2.3",
  platform: "darwin-arm64",
};

function gitResult(code: number, stdout: string): GitExecResult {
  return { code, stdout, stderr: "" };
}

/** A fake git that answers the two rev-parse calls `resolveTarget` makes. */
function fakeGit(opts: {
  toplevel?: string;
  sha?: string;
  topCode?: number;
  revCode?: number;
  spy?: string[][];
}): GitRunner {
  return async (args) => {
    opts.spy?.push(args);
    if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
      return gitResult(opts.topCode ?? 0, `${opts.toplevel ?? TOPLEVEL}\n`);
    }
    if (args[0] === "rev-parse" && args.includes("--verify")) {
      return gitResult(opts.revCode ?? 0, `${opts.sha ?? SHA}\n`);
    }
    return gitResult(1, "");
  };
}

function greenResult(): BaselineResult {
  return {
    status: "green",
    key: "k",
    sha: SHA,
    toolchain: TC,
    computedAt: 111,
    runs: [{ startedAt: 1, durationMs: 2, exitCode: 0, failingTests: [] }],
  };
}

function suiteRedResult(): BaselineResult {
  return {
    status: "suite-red",
    key: "k",
    sha: SHA,
    toolchain: TC,
    computedAt: 111,
    failing: [{ id: "test/x.test.ts > boom", flakySuspect: false }],
    runs: [
      { startedAt: 1, durationMs: 2, exitCode: 1, failingTests: ["boom"] },
    ],
  };
}

const MISS: BaselineReadState = { status: "miss", key: "k" };
const COMPUTING: BaselineReadState = { status: "computing", key: "k" };

/** Capture stdout/stderr/writes for a run and thread the fixture seams. */
function harness(over: Partial<RunDeps> = {}): {
  deps: RunDeps;
  stdout: string[];
  stderr: string[];
  writes: BaselineRequest[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const writes: BaselineRequest[] = [];
  const deps: RunDeps = {
    gitRunner: fakeGit({}),
    toolchain: TC,
    now: () => 5000,
    sleep: async () => {},
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
    writeRequest: (r) => writes.push(r),
    ...over,
  };
  return { deps, stdout, stderr, writes };
}

// ── arg parsing ──────────────────────────────────────────────────────────────

test("defaults: no positional, no flags", () => {
  const p = parseBaselineArgs([]);
  expect(p.ok).toBe(true);
  if (!p.ok) return;
  expect(p.args).toEqual({
    sha: null,
    repo: null,
    wait: false,
    timeoutMs: 600_000,
    pollIntervalMs: 1000,
  });
});

test("positional sha + flags parse", () => {
  const p = parseBaselineArgs([
    "deadbeef",
    "--repo",
    "/r",
    "--wait",
    "--timeout-ms",
    "1500",
    "--poll-interval-ms",
    "250",
  ]);
  expect(p.ok).toBe(true);
  if (!p.ok) return;
  expect(p.args).toEqual({
    sha: "deadbeef",
    repo: "/r",
    wait: true,
    timeoutMs: 1500,
    pollIntervalMs: 250,
  });
});

test("--help is the sentinel, not a usage error", () => {
  const p = parseBaselineArgs(["--help"]);
  expect(p).toEqual({ ok: false, message: "__help__" });
});

test("unknown flag is a usage error (not the help sentinel)", () => {
  const p = parseBaselineArgs(["--nope"]);
  expect(p.ok).toBe(false);
  if (p.ok) return;
  expect(p.message).not.toBe("__help__");
});

test("two positionals are rejected", () => {
  const p = parseBaselineArgs(["a", "b"]);
  expect(p.ok).toBe(false);
  if (p.ok) return;
  expect(p.message).toContain("at most one sha");
});

test("non-positive / non-integer ms flags are rejected", () => {
  for (const bad of ["0", "-5", "abc", "1.5"]) {
    const p = parseBaselineArgs(["--timeout-ms", bad]);
    expect(p.ok).toBe(false);
  }
  expect(parseBaselineArgs(["--poll-interval-ms", "0"]).ok).toBe(false);
});

// ── terminal classification ──────────────────────────────────────────────────

test("isTerminalResult splits computed results from read states", () => {
  expect(isTerminalResult(greenResult())).toBe(true);
  expect(isTerminalResult(suiteRedResult())).toBe(true);
  expect(
    isTerminalResult({
      status: "infra-error",
      key: "k",
      sha: SHA,
      toolchain: TC,
      computedAt: 1,
      kind: "checkout",
      message: "boom",
    }),
  ).toBe(true);
  expect(
    isTerminalResult({
      status: "timeout",
      key: "k",
      sha: SHA,
      toolchain: TC,
      computedAt: 1,
      deadlineMs: 9,
      runs: [],
    }),
  ).toBe(true);
  expect(isTerminalResult(MISS)).toBe(false);
  expect(isTerminalResult(COMPUTING)).toBe(false);
});

// ── target resolution ────────────────────────────────────────────────────────

test("resolveTarget resolves the git root + full sha, keying on HEAD by default", async () => {
  const spy: string[][] = [];
  const r = await resolveTarget({ sha: null, repo: null }, fakeGit({ spy }));
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.target).toEqual({ repoDir: TOPLEVEL, sha: SHA });
  // Default ref is HEAD; the verify call carries the ^{commit} peel.
  const verify = spy.find((a) => a.includes("--verify"));
  expect(verify).toContain("HEAD^{commit}");
});

test("resolveTarget forwards an explicit ref to rev-parse", async () => {
  const spy: string[][] = [];
  await resolveTarget({ sha: "v1.2", repo: null }, fakeGit({ spy }));
  const verify = spy.find((a) => a.includes("--verify"));
  expect(verify).toContain("v1.2^{commit}");
});

test("a non-git repo is a usage failure", async () => {
  const r = await resolveTarget(
    { sha: null, repo: "/nope" },
    fakeGit({ topCode: 1 }),
  );
  expect(r.ok).toBe(false);
});

test("an unresolvable ref is a usage failure", async () => {
  const r = await resolveTarget(
    { sha: "bogus", repo: null },
    fakeGit({ revCode: 1 }),
  );
  expect(r.ok).toBe(false);
});

// ── bare read (never mutates) ────────────────────────────────────────────────

test("bare read of a terminal result: clean JSON, exit 0, no write", async () => {
  const h = harness({ readState: () => greenResult() });
  const res = await runBaseline(
    { sha: null, repo: null, wait: false, timeoutMs: 1000, pollIntervalMs: 10 },
    h.deps,
  );
  expect(res.exitCode).toBe(EXIT_OK);
  expect(res.requestsWritten).toBe(0);
  expect(h.writes).toEqual([]);
  // One clean JSON value on stdout.
  expect(JSON.parse(h.stdout.join(""))).toMatchObject({ status: "green" });
});

test("bare read of suite-red exits 0 — red is an answer", async () => {
  const h = harness({ readState: () => suiteRedResult() });
  const res = await runBaseline(
    { sha: null, repo: null, wait: false, timeoutMs: 1000, pollIntervalMs: 10 },
    h.deps,
  );
  expect(res.exitCode).toBe(EXIT_OK);
});

test("bare read miss: prints envelope, exits 1, never writes", async () => {
  const h = harness({ readState: () => MISS });
  const res = await runBaseline(
    { sha: null, repo: null, wait: false, timeoutMs: 1000, pollIntervalMs: 10 },
    h.deps,
  );
  expect(res.exitCode).toBe(EXIT_NO_RESULT);
  expect(res.requestsWritten).toBe(0);
  expect(h.writes).toEqual([]);
  expect(JSON.parse(h.stdout.join(""))).toEqual(MISS);
});

test("bare read computing exits 1 (non-terminal)", async () => {
  const h = harness({ readState: () => COMPUTING });
  const res = await runBaseline(
    { sha: null, repo: null, wait: false, timeoutMs: 1000, pollIntervalMs: 10 },
    h.deps,
  );
  expect(res.exitCode).toBe(EXIT_NO_RESULT);
});

test("an unresolvable target is exit 2, prints nothing to stdout", async () => {
  const h = harness({
    gitRunner: fakeGit({ topCode: 1 }),
    readState: () => MISS,
  });
  const res = await runBaseline(
    { sha: null, repo: null, wait: false, timeoutMs: 1000, pollIntervalMs: 10 },
    h.deps,
  );
  expect(res.exitCode).toBe(EXIT_USAGE);
  expect(res.final).toBeNull();
  expect(h.stdout).toEqual([]);
  expect(h.stderr.join("")).toContain("not a git repository");
});

// ── --wait: trigger + await ──────────────────────────────────────────────────

test("--wait writes exactly one well-formed request, then polls to a terminal", async () => {
  // miss (initial) → computing (poll 1) → green (poll 2).
  const states: BaselineReadState[] = [MISS, COMPUTING, greenResult()];
  let i = 0;
  const h = harness({
    now: () => 7000,
    readState: () =>
      states[Math.min(i++, states.length - 1)] as BaselineReadState,
  });
  const res = await runBaseline(
    {
      sha: null,
      repo: null,
      wait: true,
      timeoutMs: 60_000,
      pollIntervalMs: 10,
    },
    h.deps,
  );
  expect(res.exitCode).toBe(EXIT_OK);
  expect(res.requestsWritten).toBe(1);
  expect(h.writes.length).toBe(1);
  // The spool request carries the resolved fields + the contract-composed key.
  const req = h.writes[0] as BaselineRequest;
  expect(req.repoDir).toBe(TOPLEVEL);
  expect(req.sha).toBe(SHA);
  expect(req.toolchain).toEqual(TC);
  expect(req.requestedAt).toBe(7000);
  expect(req.key).toBe(
    baselineKey({ repoDir: TOPLEVEL, sha: SHA, toolchain: TC }),
  );
  expect(JSON.parse(h.stdout.join(""))).toMatchObject({ status: "green" });
});

test("--wait on an already-terminal leaf triggers nothing (no request written)", async () => {
  const h = harness({ readState: () => greenResult() });
  const res = await runBaseline(
    {
      sha: null,
      repo: null,
      wait: true,
      timeoutMs: 60_000,
      pollIntervalMs: 10,
    },
    h.deps,
  );
  expect(res.exitCode).toBe(EXIT_OK);
  expect(res.requestsWritten).toBe(0);
  expect(h.writes).toEqual([]);
});

test("--wait deadline: distinct non-zero report, never mistaken for a result", async () => {
  let clock = 0;
  const h = harness({
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    readState: () => COMPUTING, // never terminalizes
  });
  const res = await runBaseline(
    { sha: null, repo: null, wait: true, timeoutMs: 50, pollIntervalMs: 10 },
    h.deps,
  );
  expect(res.exitCode).toBe(EXIT_DEADLINE);
  expect(res.requestsWritten).toBe(1);
  // The printed value is a read-state (computing), NOT one of the four terminal
  // statuses — a worker keying on `status` can never read it as a result.
  const printed = JSON.parse(h.stdout.join(""));
  expect(printed.status).toBe("computing");
  expect(isTerminalResult(printed)).toBe(false);
  expect(h.stderr.join("")).toContain("deadline exceeded");
});

test("--wait exits 0 on a terminal infra-error (a could-not-run answer)", async () => {
  const infra: BaselineResult = {
    status: "infra-error",
    key: "k",
    sha: SHA,
    toolchain: TC,
    computedAt: 1,
    kind: "install",
    message: "frozen lockfile drift",
  };
  const states: BaselineReadState[] = [MISS, infra];
  let i = 0;
  const h = harness({
    readState: () =>
      states[Math.min(i++, states.length - 1)] as BaselineReadState,
  });
  const res = await runBaseline(
    {
      sha: null,
      repo: null,
      wait: true,
      timeoutMs: 60_000,
      pollIntervalMs: 10,
    },
    h.deps,
  );
  expect(res.exitCode).toBe(EXIT_OK);
  expect(JSON.parse(h.stdout.join(""))).toMatchObject({
    status: "infra-error",
  });
});

// ── registration ─────────────────────────────────────────────────────────────

test("baseline is registered with a summary (so --help --json lists it)", () => {
  expect(SUBCOMMAND_META.baseline).toBeDefined();
  expect(SUBCOMMAND_META.baseline.summary.length).toBeGreaterThan(0);
});
