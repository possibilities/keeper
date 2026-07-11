/**
 * Tests for the `bun test` wrapper (`scripts/test-gate.ts`). The wrapper is a
 * pure arg-injector: it forwards each package.json script's args verbatim and
 * appends a `--parallel` cap and `--no-orphans` when they aren't already set.
 * These drive the pure `buildBunTestArgs` helper in-process — no real second
 * `bun test` is spawned.
 */

import { describe, expect, test } from "bun:test";
import {
  buildBunTestArgs,
  isOrphanTestWorker,
  type ProcRow,
  parseEtimeSeconds,
} from "../scripts/test-gate";

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
