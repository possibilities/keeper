#!/usr/bin/env bun
/**
 * Bun test entrypoint guard.
 *
 * Bun 1.3.14 rewrites Bun.argv before a `[test].preload` runs, so a preload
 * cannot distinguish a file selected by the caller from one found by broad
 * discovery. Each package therefore points `[test].root` at this sentinel:
 * bare/name/watch/coverage aggregate invocations fail here, while named gates
 * pass an explicit package test directory plus a short-lived marker. Explicit
 * `*.test.ts` targets bypass the sentinel and remain available.
 *
 * The same module is also the first package preload. It consumes the aggregate
 * marker synchronously before any setup module or test can inherit it. There is
 * no filesystem, subprocess, timer, network, or lock work on this path.
 */

export const TEST_GATE_MARKER = "KEEPER_TEST_GATE_ENTRYPOINT";
export const TEST_GATE_MARKER_VALUE = "keeper:test-gate:v1";
export const TEST_GATE_REPLACEMENT = "bun run test:gate";

export type TestInvocationDecision =
  | { allowed: true; posture: "named-gate" | "explicit-files" }
  | { allowed: false; posture: "aggregate-discovery"; message: string };

const TEST_FLAGS_WITH_VALUES = new Set([
  "--timeout",
  "--rerun-each",
  "--retry",
  "--seed",
  "--coverage-reporter",
  "--coverage-dir",
  "--test-name-pattern",
  "-t",
  "--reporter",
  "--reporter-outfile",
  "--max-concurrency",
  "--path-ignore-patterns",
  "--changed",
  "--parallel",
  "--parallel-delay",
  "--shard",
  "--preload",
]);

/** True only for literal TypeScript test-file targets, never directories/globs. */
export function isExplicitTestFile(arg: string): boolean {
  return !arg.startsWith("-") && arg.endsWith(".test.ts");
}

/** Ignore option values so a name filter like `-t fake.test.ts` cannot masquerade
 * as a targeted file. Wrapper prefixes are ignored by anchoring after `bun test`. */
export function hasExplicitTestFile(argv: readonly string[]): boolean {
  const bunIndex = argv.findIndex((arg, i) => {
    const exe = arg.split("/").pop();
    return exe === "bun" && argv[i + 1] === "test";
  });
  const args = bunIndex === -1 ? argv : argv.slice(bunIndex + 2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--") {
      return args.slice(i + 1).some(isExplicitTestFile);
    }
    if (TEST_FLAGS_WITH_VALUES.has(arg)) {
      i += 1;
      continue;
    }
    if (isExplicitTestFile(arg)) {
      return true;
    }
  }
  return false;
}

/**
 * Classify an original command argv or Bun's per-file test argv. The named gate
 * marker is authoritative for aggregate children; otherwise at least one
 * explicit `*.test.ts` path is required.
 */
export function classifyTestInvocation(
  argv: readonly string[],
  marker: string | undefined,
): TestInvocationDecision {
  if (marker === TEST_GATE_MARKER_VALUE) {
    return { allowed: true, posture: "named-gate" };
  }
  if (hasExplicitTestFile(argv)) {
    return { allowed: true, posture: "explicit-files" };
  }
  return {
    allowed: false,
    posture: "aggregate-discovery",
    message:
      `[test-entrypoint] Direct aggregate bun test is disabled; use ${TEST_GATE_REPLACEMENT}, ` +
      "or run bun test ./path/to/file.test.ts.\n",
  };
}

/**
 * Enforce only when this file is Bun's configured sentinel or a test preload.
 * Importing the pure helpers from an ordinary script must remain inert.
 */
function isTestEntrypointRuntime(): boolean {
  return import.meta.main || Bun.main.endsWith(".test.ts");
}

function enforceTestEntrypoint(): void {
  const marker = process.env[TEST_GATE_MARKER];
  // Consume even a malformed/ambient value so no test code can inherit it.
  delete process.env[TEST_GATE_MARKER];
  const decision = classifyTestInvocation(Bun.argv.slice(1), marker);
  if (!decision.allowed) {
    process.stderr.write(decision.message);
    process.exit(1);
  }
}

if (isTestEntrypointRuntime()) {
  enforceTestEntrypoint();
}
