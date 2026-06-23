/**
 * Tests for the `bun test` concurrency gate (fn-904, `scripts/test-gate.ts`).
 * Drives the gate's pure helpers + the lock-acquire path in-process — no real
 * second `bun test` is spawned. Covers:
 *
 *   - arg forwarding + `--parallel` injection (and respecting a caller's own
 *     `--parallel`);
 *   - `KEEPER_TEST_NO_GATE` bypasses the lock;
 *   - a held lock makes a second `acquireGate` block, then proceed once released;
 *   - fail-open: an unwritable lock parent path runs un-gated (returns null) and
 *     never throws.
 *
 * `acquireGate` is exercised against a per-test tmpdir lock path so the user's
 * real `~/.local/state/keeper/test.lock` is never touched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireGate,
  buildBunTestArgs,
  lockBypassed,
  testLockPath,
} from "../scripts/test-gate";
import { CommitWorkLock } from "../src/commit-work/flock";

let tmpDir: string;
let lockPath: string;
const savedNoGate = process.env.KEEPER_TEST_NO_GATE;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-test-gate-"));
  lockPath = join(tmpDir, "test.lock");
  delete process.env.KEEPER_TEST_NO_GATE;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (savedNoGate === undefined) {
    delete process.env.KEEPER_TEST_NO_GATE;
  } else {
    process.env.KEEPER_TEST_NO_GATE = savedNoGate;
  }
});

describe("buildBunTestArgs", () => {
  test("forwards args verbatim and injects --parallel default", () => {
    const args = buildBunTestArgs(
      ["--timeout=30000", "--path-ignore-patterns='plugins/**'"],
      undefined,
    );
    expect(args).toEqual([
      "test",
      "--timeout=30000",
      "--path-ignore-patterns='plugins/**'",
      "--parallel=4",
    ]);
  });

  test("honors KEEPER_TEST_PARALLEL value", () => {
    expect(buildBunTestArgs([], "8")).toEqual(["test", "--parallel=8"]);
  });

  test("falls back to default on a non-positive / non-numeric value", () => {
    expect(buildBunTestArgs([], "0")).toEqual(["test", "--parallel=4"]);
    expect(buildBunTestArgs([], "nope")).toEqual(["test", "--parallel=4"]);
  });

  test("does not inject when --parallel=<n> already present", () => {
    expect(buildBunTestArgs(["--parallel=2"], "8")).toEqual([
      "test",
      "--parallel=2",
    ]);
  });

  test("does not inject when bare --parallel already present", () => {
    expect(buildBunTestArgs(["--parallel"], "8")).toEqual([
      "test",
      "--parallel",
    ]);
  });
});

describe("testLockPath", () => {
  test("resolves to the dedicated host-wide path", () => {
    expect(testLockPath()).toMatch(/\.local\/state\/keeper\/test\.lock$/);
  });
});

describe("lockBypassed", () => {
  test("false when KEEPER_TEST_NO_GATE unset/empty", () => {
    expect(lockBypassed()).toBe(false);
    process.env.KEEPER_TEST_NO_GATE = "";
    expect(lockBypassed()).toBe(false);
  });

  test("true when KEEPER_TEST_NO_GATE set", () => {
    process.env.KEEPER_TEST_NO_GATE = "1";
    expect(lockBypassed()).toBe(true);
  });
});

describe("acquireGate", () => {
  test("acquires when uncontended, and releases", async () => {
    const lock = await acquireGate(lockPath);
    expect(lock).not.toBeNull();
    lock?.release();
    // After release a plain tryAcquire succeeds (lock truly freed).
    const again = CommitWorkLock.tryAcquire(lockPath);
    expect(again).not.toBeNull();
    again?.release();
  });

  test("KEEPER_TEST_NO_GATE bypasses the lock (returns null, no lock held)", async () => {
    process.env.KEEPER_TEST_NO_GATE = "1";
    const lock = await acquireGate(lockPath);
    expect(lock).toBeNull();
    // The lock was never taken — a tryAcquire still succeeds.
    const free = CommitWorkLock.tryAcquire(lockPath);
    expect(free).not.toBeNull();
    free?.release();
  });

  test("a held lock makes a second acquireGate block, then proceed once released", async () => {
    const held = CommitWorkLock.acquire(lockPath);
    // Start the contended acquire; it must NOT resolve while `held` owns the lock.
    const pending = acquireGate(lockPath);
    let settled = false;
    pending.then(() => {
      settled = true;
    });
    // Give the poll loop several intervals; it should still be waiting.
    await Bun.sleep(250);
    expect(settled).toBe(false);

    held.release();
    const lock = await pending;
    expect(lock).not.toBeNull();
    lock?.release();
  });

  test("fail-open: an unwritable lock parent path runs un-gated (null, no throw)", async () => {
    // A lock path under a non-directory (a file standing in for a parent) makes
    // mkdir/openSync fail; the gate must swallow it and return null.
    const fileAsParent = join(tmpDir, "afile");
    await Bun.write(fileAsParent, "x");
    const bad = join(fileAsParent, "nested", "test.lock");
    let lock: CommitWorkLock | null = null;
    await expect(
      (async () => {
        lock = await acquireGate(bad);
      })(),
    ).resolves.toBeUndefined();
    expect(lock).toBeNull();
  });
});
