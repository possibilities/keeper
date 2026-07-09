#!/usr/bin/env bun
/**
 * Serial three-suite gate. Root `bun run test` covers only the keeper fast tier;
 * the plan and prompt plugins each gate nothing on their own, so a cross-cutting
 * refactor can green root while breaking them. This orchestrator runs all three
 * through their EXISTING scripts, in order, and aggregates one exit code — the
 * "what else is broken" local gate.
 *
 * Suites run SERIALLY, prompt last (it is the slowest). Output streams
 * inherit-style: an === header before each suite, a one-line verdict after.
 * Verdicts come from EXIT CODES only — plan's test count drifts between runs, so
 * nothing here parses counts.
 *
 * The orchestrator OWNS the tier. Both slow gates key on env-var DEFINED-ness, so
 * an ambient `KEEPER_RUN_SLOW` / `KEEPER_PLAN_RUN_SLOW` in the caller's shell would
 * silently promote a child to the slow tier. Fast mode therefore DELETES both from
 * every child env; `--slow` injects `KEEPER_RUN_SLOW=1` into root and swaps plan to
 * its `test:slow` script (`KEEPER_PLAN_RUN_SLOW=1`). No child ever inherits the tier.
 *
 * Process-group teardown: each suite is spawned detached (its own process group,
 * pgid = child pid). A per-suite timeout SIGKILLs the WHOLE group (`kill(-pid)`),
 * so a wedged suite leaks no orphaned descendants — the top-level kill bypasses
 * test-gate's own `--no-orphans` reaper, which only runs on a clean child exit.
 * SIGINT (Ctrl-C) tears down the running child's group and exits non-zero.
 *
 * Known masking: root's `test` script is a `&& bun run test:opentui` chain, so a
 * root fast-tier failure short-circuits before opentui runs. Acceptable — one
 * verdict per suite; we do not restructure root's scripts to unmask it.
 *
 * Env knobs: `KEEPER_TEST_BAIL` (any non-empty = stop after the first failing or
 * timed-out suite), `KEEPER_TEST_SUITE_TIMEOUT_S` (per-suite budget, default 300).
 * The `--slow` root suite gets a 600s floor regardless.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";

const DEFAULT_SUITE_TIMEOUT_S = 300;
/** Floor budget for the root suite under `--slow` (its slow tier is the heaviest). */
const SLOW_ROOT_TIMEOUT_MS = 600_000;

export type Variant = "fast" | "slow";

export type SuiteSpec = {
  /** Stable suite label used in headers and verdicts. */
  name: string;
  /** argv, spawned via `argv[0]` + rest. */
  cmd: string[];
  /** cwd relative to the repo root — bunfig/import resolution is cwd-relative. */
  cwd: string;
  /** Per-key env override; an `undefined` value DELETES the key from the child. */
  envPatch: Record<string, string | undefined>;
  /** Per-suite process-group kill budget. */
  timeoutMs: number;
};

export type Verdict = { ok: boolean; reason: string };

/** The two slow gates. Both fast-mode suites DELETE these so ambient values can't leak the tier. */
const SLOW_ENV_KEYS = {
  root: "KEEPER_RUN_SLOW",
  plan: "KEEPER_PLAN_RUN_SLOW",
} as const;

/** Scrub both slow gates from a child env (fast tier / suites with no slow variant). */
function scrubSlow(): Record<string, string | undefined> {
  return { [SLOW_ENV_KEYS.root]: undefined, [SLOW_ENV_KEYS.plan]: undefined };
}

/**
 * Build the ordered suite plan for a variant. Pure over its inputs — the unit
 * test drives this directly (order, cwd, env scrub/inject, timeout budgets).
 */
export function buildSuitePlan(
  variant: Variant,
  opts: { suiteTimeoutMs: number },
): SuiteSpec[] {
  const t = opts.suiteTimeoutMs;
  const slow = variant === "slow";
  return [
    {
      name: "root",
      cmd: ["bun", "run", "test"],
      cwd: ".",
      envPatch: slow
        ? { [SLOW_ENV_KEYS.root]: "1", [SLOW_ENV_KEYS.plan]: undefined }
        : scrubSlow(),
      timeoutMs: slow ? Math.max(t, SLOW_ROOT_TIMEOUT_MS) : t,
    },
    {
      name: "plan",
      cmd: ["bun", "run", slow ? "test:slow" : "test"],
      cwd: "plugins/plan",
      envPatch: slow
        ? { [SLOW_ENV_KEYS.plan]: "1", [SLOW_ENV_KEYS.root]: undefined }
        : scrubSlow(),
      timeoutMs: t,
    },
    {
      name: "prompt",
      cmd: ["bun", "run", "test"],
      cwd: "plugins/prompt",
      envPatch: scrubSlow(),
      timeoutMs: t,
    },
  ];
}

/** Apply an env patch to a base env; an `undefined` value deletes the key. Pure. */
export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  patch: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Classify a suite's outcome into a pass/fail verdict from its exit code and the
 * distinct failure signals (spawn ENOENT and timeout kill). Pure — the unit
 * test drives every branch.
 */
export function classifyVerdict(result: {
  spawnError?: string;
  timedOut?: boolean;
  exitCode: number | null;
}): Verdict {
  if (result.spawnError !== undefined) {
    const missing = result.spawnError === "ENOENT";
    return {
      ok: false,
      reason: missing
        ? "missing binary (spawn ENOENT)"
        : `spawn error: ${result.spawnError}`,
    };
  }
  if (result.timedOut) {
    return { ok: false, reason: "timed out (process group killed)" };
  }
  if (result.exitCode === 0) {
    return { ok: true, reason: "passed" };
  }
  return { ok: false, reason: `exited ${result.exitCode ?? "unknown"}` };
}

/**
 * Bail decision: with bail on, stop the moment any suite has failed. Pure.
 */
export function shouldContinue(verdicts: Verdict[], bail: boolean): boolean {
  if (!bail) {
    return true;
  }
  return verdicts.every((v) => v.ok);
}

/** `KEEPER_TEST_BAIL` — any non-empty value turns bail on. */
export function parseBail(raw: string | undefined): boolean {
  return raw !== undefined && raw.length > 0;
}

/** `KEEPER_TEST_SUITE_TIMEOUT_S` → ms, falling back to the default on a bad value. */
export function parseSuiteTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.length === 0) {
    return DEFAULT_SUITE_TIMEOUT_S * 1000;
  }
  const n = Number.parseInt(raw, 10);
  return (Number.isInteger(n) && n > 0 ? n : DEFAULT_SUITE_TIMEOUT_S) * 1000;
}

// --- thin runner (below the pure seam) ---

let currentChildPid: number | null = null;

/** SIGKILL an entire process group, swallowing an already-dead group. */
function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // group already gone
  }
}

async function runSuite(spec: SuiteSpec, repoRoot: string): Promise<Verdict> {
  const env = buildChildEnv(process.env, spec.envPatch);
  return await new Promise<Verdict>((resolve) => {
    const child = spawn(spec.cmd[0], spec.cmd.slice(1), {
      cwd: join(repoRoot, spec.cwd),
      env,
      detached: true,
      stdio: "inherit",
    });
    currentChildPid = child.pid ?? null;

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        killGroup(child.pid);
      }
    }, spec.timeoutMs);

    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      currentChildPid = null;
      resolve(
        classifyVerdict({
          spawnError: err.code ?? String(err),
          exitCode: null,
        }),
      );
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      currentChildPid = null;
      resolve(classifyVerdict({ timedOut, exitCode: code }));
    });
  });
}

async function main(): Promise<number> {
  const variant: Variant = Bun.argv.includes("--slow") ? "slow" : "fast";
  const bail = parseBail(process.env.KEEPER_TEST_BAIL);
  const suiteTimeoutMs = parseSuiteTimeoutMs(
    process.env.KEEPER_TEST_SUITE_TIMEOUT_S,
  );
  const repoRoot = join(import.meta.dir, "..");
  const plan = buildSuitePlan(variant, { suiteTimeoutMs });

  process.on("SIGINT", () => {
    if (currentChildPid !== null) {
      killGroup(currentChildPid);
    }
    process.exit(130);
  });

  const verdicts: Verdict[] = [];
  let allOk = true;
  for (const spec of plan) {
    if (!shouldContinue(verdicts, bail)) {
      process.stdout.write(
        `\n=== ${spec.name} — SKIPPED (bail after earlier failure) ===\n`,
      );
      break;
    }
    process.stdout.write(`\n=== ${spec.name} (${variant}) ===\n`);
    const verdict = await runSuite(spec, repoRoot);
    verdicts.push(verdict);
    allOk = allOk && verdict.ok;
    process.stdout.write(
      `--- ${spec.name}: ${verdict.ok ? "PASS" : "FAIL"} (${verdict.reason}) ---\n`,
    );
  }

  process.stdout.write(`\n=== summary (${variant}) ===\n`);
  plan.slice(0, verdicts.length).forEach((spec, i) => {
    const v = verdicts[i];
    process.stdout.write(
      `  ${v.ok ? "PASS" : "FAIL"}  ${spec.name} — ${v.reason}\n`,
    );
  });

  return allOk ? 0 : 1;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // A gate bug must not silently green the run — surface it and fail loud.
      process.stderr.write(`[test-full] fatal: ${err}\n`);
      process.exit(1);
    });
}
