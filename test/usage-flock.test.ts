/**
 * Foundation-primitive test for the `FileLock` flock(2) FFI primitive vendored
 * into keeper (`src/usage-flock.ts`). Covers acquire/release round-trip,
 * idempotent release, a second concurrent non-blocking acquire blocking while
 * held, the constants matching the on-the-wire flock(2)/fcntl values, and the
 * raw libc symbol exports an external consumer locks its own fd with.
 *
 * bun:ffi is experimental; this is the regression tripwire pinning the two
 * silent-failing macOS-aarch64 hazards (i32 return width, FD_CLOEXEC ordering).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileLock,
  FLOCK_CONSTANTS,
  flockFd,
  loadLibc,
  setCloexec,
} from "../src/usage-flock";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agentusage-flock-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("FileLock", () => {
  test("constants are the on-the-wire flock(2)/fcntl values", () => {
    expect(FLOCK_CONSTANTS.LOCK_EX).toBe(2);
    expect(FLOCK_CONSTANTS.LOCK_NB).toBe(4);
    expect(FLOCK_CONSTANTS.LOCK_UN).toBe(8);
    expect(FLOCK_CONSTANTS.F_SETFD).toBe(2);
    expect(FLOCK_CONSTANTS.FD_CLOEXEC).toBe(1);
  });

  test("acquire then release round-trips; re-acquire after release succeeds", () => {
    const lockPath = join(tmpDir, "picker.json.lock");
    const lock = FileLock.acquire(lockPath);
    lock.release();
    const again = FileLock.acquire(lockPath);
    again.release();
  });

  test("release is idempotent", () => {
    const lockPath = join(tmpDir, "picker.json.lock");
    const lock = FileLock.acquire(lockPath);
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });

  test("a second concurrent (non-blocking) acquire blocks while held", () => {
    const lockPath = join(tmpDir, "picker.json.lock");
    const held = FileLock.acquire(lockPath);
    try {
      const second = FileLock.tryAcquire(lockPath);
      expect(second).toBeNull();
    } finally {
      held.release();
    }
    const third = FileLock.tryAcquire(lockPath);
    expect(third).not.toBeNull();
    third?.release();
  });
});

describe("raw libc exports (external-consumer fd locking)", () => {
  test("setCloexec + flockFd lock a fd the consumer opened non-truncating", () => {
    // agentwrap's ordinal counter locks the DATA file directly with a
    // non-truncating open. Prove the raw symbols lock such a fd and that a
    // second non-blocking flock on a fresh fd reports contention.
    const dataPath = join(tmpDir, "counter.dat");
    closeSync(openSync(dataPath, "w")); // create the data file
    const { lib, syms } = loadLibc();
    const fd = openSync(dataPath, "r+"); // non-truncating open
    try {
      setCloexec(syms, fd);
      expect(flockFd(syms, fd, FLOCK_CONSTANTS.LOCK_EX)).toBe(true);

      // A second fd onto the same file, non-blocking, must report contention.
      const { lib: lib2, syms: syms2 } = loadLibc();
      const fd2 = openSync(dataPath, "r+");
      try {
        const got = flockFd(
          syms2,
          fd2,
          FLOCK_CONSTANTS.LOCK_EX | FLOCK_CONSTANTS.LOCK_NB,
        );
        expect(got).toBe(false);
      } finally {
        flockFd(syms2, fd2, FLOCK_CONSTANTS.LOCK_UN);
        closeSync(fd2);
        lib2.close();
      }

      flockFd(syms, fd, FLOCK_CONSTANTS.LOCK_UN);
    } finally {
      closeSync(fd);
      lib.close();
    }
  });
});
