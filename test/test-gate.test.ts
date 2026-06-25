/**
 * Tests for the `bun test` wrapper (`scripts/test-gate.ts`). The wrapper is a
 * pure arg-injector: it forwards each package.json script's args verbatim and
 * appends a `--parallel` cap and `--no-orphans` when they aren't already set.
 * These drive the pure `buildBunTestArgs` helper in-process — no real second
 * `bun test` is spawned.
 */

import { describe, expect, test } from "bun:test";
import { buildBunTestArgs } from "../scripts/test-gate";

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
