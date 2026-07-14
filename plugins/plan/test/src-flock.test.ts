import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireCommitWorkLock,
  COMMIT_WORK_LOCK_DEADLINE_MS,
  F_GETFD,
  FD_CLOEXEC,
  fcntl,
  type HeldCommitWorkLock,
} from "../src/flock.ts";
import {
  armInProgressOp,
  fakeVcs,
  initRepo,
  resetFakeVcs,
} from "./fake-vcs.ts";

describe("acquireCommitWorkLock", () => {
  let tmpDir: string;
  const held: HeldCommitWorkLock[] = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "planctl-flock-"));
  });
  afterEach(() => {
    while (held.length > 0) held.pop()?.release();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const lockPath = (): string => join(tmpDir, "keeper-commit-work.lock");

  test("fcntl constants are the on-the-wire <fcntl.h> values", () => {
    expect(F_GETFD).toBe(1);
    expect(FD_CLOEXEC).toBe(1);
  });

  test("acquires a free lock with close-on-exec", () => {
    const outcome = acquireCommitWorkLock(lockPath(), 5_000);
    expect(outcome.kind).toBe("acquired");
    if (outcome.kind !== "acquired") return;
    held.push(outcome.lock);
    expect(fcntl(outcome.lock.fd, F_GETFD, 0) & FD_CLOEXEC).toBe(FD_CLOEXEC);
  });

  test("release is idempotent and permits reacquisition", () => {
    const first = acquireCommitWorkLock(lockPath(), 5_000);
    expect(first.kind).toBe("acquired");
    if (first.kind !== "acquired") return;
    first.lock.release();
    expect(() => first.lock.release()).not.toThrow();
    const second = acquireCommitWorkLock(lockPath(), 5_000);
    expect(second.kind).toBe("acquired");
    if (second.kind === "acquired") second.lock.release();
  });

  test("a free lock is won without sleeping", () => {
    const outcome = acquireCommitWorkLock(lockPath(), 5_000, () => {
      throw new Error("must not sleep when the lock is free");
    });
    expect(outcome.kind).toBe("acquired");
    if (outcome.kind === "acquired") outcome.lock.release();
  });

  test("a contended lock reports a bounded timeout", () => {
    const holder = acquireCommitWorkLock(lockPath(), 5_000);
    expect(holder.kind).toBe("acquired");
    if (holder.kind !== "acquired") return;
    held.push(holder.lock);
    expect(acquireCommitWorkLock(lockPath(), 100).kind).toBe("timeout");
  });

  test("an unopenable lock path is environmental", () => {
    const outcome = acquireCommitWorkLock(
      join(tmpDir, "no-such-dir", "keeper-commit-work.lock"),
      5_000,
    );
    expect(outcome.kind).toBe("environmental");
  });

  test("uses the daemon-side default deadline", () => {
    expect(COMMIT_WORK_LOCK_DEADLINE_MS).toBe(45_000);
  });
});

describe("fakeVcs.inProgressOp / commitWorkLockPath", () => {
  let root: string;

  beforeEach(() => {
    resetFakeVcs();
    root = mkdtempSync(join(tmpdir(), "planctl-fake-vcs-"));
    initRepo(root);
  });
  afterEach(() => {
    resetFakeVcs();
    rmSync(root, { recursive: true, force: true });
  });

  test("reports each in-progress classification", () => {
    expect(fakeVcs.inProgressOp(root)).toBe("none");
    for (const op of ["merge", "cherry-pick", "revert", "rebase", "sequencer"] as const) {
      armInProgressOp(root, op);
      expect(fakeVcs.inProgressOp(root)).toBe(op);
    }
    armInProgressOp(root, "none");
    expect(fakeVcs.inProgressOp(root)).toBe("none");
  });

  test("derives a normalized per-repository lock path", () => {
    expect(fakeVcs.commitWorkLockPath(root)).toBe(
      join(realpathSync(root), ".git", "keeper-commit-work.lock"),
    );
  });
});
