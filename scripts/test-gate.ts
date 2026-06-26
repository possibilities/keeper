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
 */

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

/**
 * Spawn `bun test` with inherited stdio and return its exit code.
 */
async function runBunTest(args: string[]): Promise<number> {
  const child = Bun.spawn(["bun", ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await child.exited;
  return child.exitCode ?? 1;
}

async function main(): Promise<number> {
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
