/**
 * Tests for the `bun test` wrapper (`scripts/test-gate.ts`). The wrapper is a
 * pure arg-injector: it forwards each package.json script's args verbatim and
 * appends a `--parallel` cap and `--no-orphans` when they aren't already set.
 * These drive the pure `buildBunTestArgs` helper in-process — no real second
 * `bun test` is spawned.
 */

import { describe, expect, test } from "bun:test";
import {
  classifyTestInvocation,
  TEST_GATE_MARKER,
  TEST_GATE_MARKER_VALUE,
  TEST_GATE_REPLACEMENT,
} from "../scripts/test-entrypoint";
import {
  buildBunTestArgs,
  buildBunTestEnv,
  isOrphanTestWorker,
  type ProcRow,
  parseEtimeSeconds,
  parseGateArgs,
} from "../scripts/test-gate";

test("the preload consumes the aggregate marker before test code runs", () => {
  expect(process.env[TEST_GATE_MARKER]).toBeUndefined();
});

describe("named phase arguments", () => {
  test("defaults to root and strips only the explicit phase selector", () => {
    expect(parseGateArgs(["--timeout=10000"])).toEqual({
      phase: "root",
      forwarded: ["--timeout=10000"],
    });
    expect(parseGateArgs(["--phase=plan", "--timeout=5000"])).toEqual({
      phase: "plan",
      forwarded: ["--timeout=5000"],
    });
    expect(() => parseGateArgs(["--phase=slow"])).toThrow("unknown test phase");
  });
});

describe("buildBunTestArgs", () => {
  test("forwards args verbatim and injects --parallel default + --no-orphans", () => {
    const args = buildBunTestArgs(
      ["--timeout=30000", "--path-ignore-patterns='plugins/**'"],
      undefined,
    );
    expect(args).toEqual([
      "test",
      "--timeout=30000",
      "--path-ignore-patterns='plugins/**'",
      "--parallel=5",
      "--no-orphans",
    ]);
  });

  test("honors KEEPER_TEST_PARALLEL value", () => {
    expect(buildBunTestArgs([], "8")).toEqual([
      "test",
      "--parallel=8",
      "--no-orphans",
    ]);
  });

  test("falls back to default on a non-positive / non-numeric value", () => {
    expect(buildBunTestArgs([], "0")).toEqual([
      "test",
      "--parallel=5",
      "--no-orphans",
    ]);
    expect(buildBunTestArgs([], "nope")).toEqual([
      "test",
      "--parallel=5",
      "--no-orphans",
    ]);
  });

  test("does not inject --parallel when --parallel=<n> already present", () => {
    expect(buildBunTestArgs(["--parallel=2"], "8")).toEqual([
      "test",
      "--parallel=2",
      "--no-orphans",
    ]);
  });

  test("does not inject --parallel when bare --parallel already present", () => {
    expect(buildBunTestArgs(["--parallel"], "8")).toEqual([
      "test",
      "--parallel",
      "--no-orphans",
    ]);
  });

  test("does not duplicate --no-orphans when already present", () => {
    expect(buildBunTestArgs(["--no-orphans"], "4")).toEqual([
      "test",
      "--no-orphans",
      "--parallel=4",
    ]);
  });
});

describe("test entrypoint invocation contract", () => {
  const allow = [
    {
      name: "root cwd explicit file",
      argv: ["bun", "test", "test/test-gate.test.ts"],
    },
    {
      name: "plan package cwd explicit file",
      argv: ["bun", "test", "test/harness.test.ts"],
    },
    {
      name: "prompt package cwd explicit file",
      argv: ["bun", "test", "test/parity.test.ts"],
    },
    {
      name: "multiple explicit files",
      argv: ["bun", "test", "test/a.test.ts", "test/b.test.ts"],
    },
    {
      name: "file-scoped long name filter",
      argv: [
        "bun",
        "test",
        "--test-name-pattern",
        "one case",
        "test/a.test.ts",
      ],
    },
    {
      name: "file-scoped short name filter through a shell wrapper",
      argv: ["timeout", "300", "bun", "test", "test/a.test.ts", "-t", "case"],
    },
  ];
  for (const { name, argv } of allow) {
    test(`allows ${name}`, () => {
      expect(classifyTestInvocation(argv, undefined)).toEqual({
        allowed: true,
        posture: "explicit-files",
      });
    });
  }

  const deny = [
    ["bare", ["bun", "test"]],
    ["broad dot", ["bun", "test", "."]],
    ["broad directory", ["bun", "test", "test"]],
    ["broad glob", ["bun", "test", "test/*.test.*"]],
    ["name only", ["bun", "test", "--test-name-pattern", "case"]],
    ["test-shaped name only", ["bun", "test", "-t", "fake.test.ts"]],
    ["watch only", ["bun", "test", "--watch"]],
    ["coverage only", ["bun", "test", "--coverage"]],
    ["wrapped aggregate", ["nohup", "bun", "test", "--coverage"]],
  ] as const;
  for (const [name, argv] of deny) {
    test(`denies ${name}`, () => {
      const decision = classifyTestInvocation(argv, undefined);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.message).toContain(TEST_GATE_REPLACEMENT);
        expect(decision.message.split("\n").filter(Boolean)).toHaveLength(1);
      }
    });
  }

  test("allows a sanctioned aggregate child and pins its short-lived marker", () => {
    expect(
      classifyTestInvocation(["bun", "test", "test"], TEST_GATE_MARKER_VALUE),
    ).toEqual({ allowed: true, posture: "named-gate" });
    expect(
      classifyTestInvocation(["bun", "test"], "ambient-junk").allowed,
    ).toBe(false);

    const env = buildBunTestEnv({ KEEP: "yes", [TEST_GATE_MARKER]: "stale" });
    expect(env.KEEP).toBe("yes");
    expect(env.BUN_FEATURE_FLAG_NO_ORPHANS).toBe("1");
    expect(env[TEST_GATE_MARKER]).toBe(TEST_GATE_MARKER_VALUE);
  });
});

describe("parseEtimeSeconds", () => {
  test("parses mm:ss / hh:mm:ss / dd-hh:mm:ss", () => {
    expect(parseEtimeSeconds("00:47")).toBe(47);
    expect(parseEtimeSeconds("09:17:33")).toBe(9 * 3600 + 17 * 60 + 33);
    expect(parseEtimeSeconds("01-02:03:04")).toBe(86400 + 7200 + 180 + 4);
  });

  test("returns 0 for an unparseable value (fails toward not killing)", () => {
    expect(parseEtimeSeconds("nope")).toBe(0);
    expect(parseEtimeSeconds("")).toBe(0);
  });
});

describe("isOrphanTestWorker", () => {
  const SELF_PID = 1000;
  const SELF_UID = 501;
  const MIN_AGE = 120;
  // A leaked worker: bun-test subcommand, reparented to init, our uid, hours old.
  const base: ProcRow = {
    pid: 999,
    ppid: 1,
    uid: SELF_UID,
    etime: "09:17:00",
    args: "/opt/homebrew/Cellar/bun/1.3.14/bin/bun test --test-worker --isolate --timeout=10000 --max-concurrency=20",
  };
  const decide = (row: ProcRow) =>
    isOrphanTestWorker(row, SELF_PID, SELF_UID, MIN_AGE);

  test("kills a genuinely orphaned old bun-test worker", () => {
    expect(decide(base)).toBe(true);
  });

  test("spares a LIVE sibling run's worker (ppid points at a live coordinator)", () => {
    expect(decide({ ...base, ppid: 4242 })).toBe(false);
  });

  test("spares an agent session that only mentions --test-worker in prose", () => {
    expect(
      decide({
        ...base,
        args: "/Users/x/.local/bin/claude --name hunt /hack ... bun test --test-worker ... prose",
      }),
    ).toBe(false);
  });

  test("spares a `bun <script>` invocation whose argv[1] is not `test`", () => {
    expect(
      decide({
        ...base,
        args: "/opt/homebrew/bin/bun /path/keeper.ts agent run --test-worker",
      }),
    ).toBe(false);
  });

  test("spares a young just-orphaned worker within the grace window", () => {
    expect(decide({ ...base, etime: "00:30" })).toBe(false);
  });

  test("spares another user's process and the gate process itself", () => {
    expect(decide({ ...base, uid: 0 })).toBe(false);
    expect(decide({ ...base, pid: SELF_PID })).toBe(false);
  });

  test("spares the coordinator itself (has no --test-worker token)", () => {
    expect(
      decide({
        ...base,
        args: "/opt/homebrew/bin/bun test --parallel=5 --no-orphans",
      }),
    ).toBe(false);
  });
});
