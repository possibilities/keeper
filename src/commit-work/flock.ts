/**
 * `flock(2)` advisory lock primitive for serializing concurrent
 * `keeper commit-work` invocations on one worktree.
 *
 * Concurrent committers in the same worktree would race `git add` / `git
 * commit` against `.git/index.lock` and against each other's staged set. A
 * single advisory `flock(LOCK_EX)` on a per-worktree lock file serializes them:
 * the lock path is `$(git rev-parse --path-format=absolute --git-dir)/keeper-
 * commit-work.lock`, so a commit-work coordinates with another commit-work (or
 * an autopilot base-merge) in the SAME worktree. The git index, `index.lock`,
 * and HEAD are per-worktree, so disjoint linked worktrees share no staging
 * state and take distinct locks.
 *
 * Two macOS-aarch64 correctness hazards are asserted in tests because they
 * fail SILENTLY:
 *
 *  1. **FFI return type.** `flock` returns `int`; declaring it anything but
 *     `FFIType.i32` on aarch64 reads the wrong register width and can
 *     segfault. We declare `i32` and read `__error()` for errno on failure,
 *     mirroring `src/exit-watcher-ffi.ts`.
 *
 *  2. **FD_CLOEXEC.** The lock fd must be opened with platform-specific
 *     `O_CLOEXEC` in the SAME `open(2)` call that creates it. A later
 *     `fcntl(F_SETFD)` has a fork/exec race and, because `fcntl` is variadic,
 *     Bun FFI can silently mis-pass its third argument on darwin-arm64. An
 *     inherited copy in a child keeps the open-file-description (and lock)
 *     alive after our release. `fcntl(F_GETFD)` takes no variadic argument, so
 *     it remains a reliable readback seam for the focused test.
 */

import {
  dlopen,
  type FFIFunction,
  FFIType,
  type Library,
  suffix,
  toArrayBuffer,
} from "bun:ffi";
import { closeSync, constants, openSync } from "node:fs";

// flock(2) operations, from <sys/file.h>. ABI-stable across darwin/linux.
const LOCK_SH = 1;
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

// fcntl(2) F_GETFD command + FD_CLOEXEC flag, from <fcntl.h>. Stable.
// F_GETFD has no variadic argument; the fixed FFI signature's dummy third arg
// is ignored, making this a reliable readback (never use this seam to SET).
const F_GETFD = 1;
const FD_CLOEXEC = 1;

// flock(LOCK_NB) reports contention as EWOULDBLOCK. Unlike the flock operation
// values, errno is platform-specific.
const EWOULDBLOCK = process.platform === "darwin" ? 35 : 11;

// Node's fs constants omit O_CLOEXEC. Its value differs by platform and must be
// ORed into the numeric open flags so close-on-exec is established atomically.
const O_CLOEXEC = process.platform === "darwin" ? 0x1000000 : 0o2000000;
const CLOEXEC_OPEN_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | O_CLOEXEC;

const LE = true; // both supported targets are little-endian

// Bounded-deadline poll schedule for {@link CommitWorkLock.acquireWithDeadline}.
// A blocking `flock(LOCK_EX)` cannot be interrupted in-process (no timer/signal
// reaches a blocked FFI syscall in Bun), so the deadline variant POLLS the
// non-blocking `tryAcquire` with jittered exponential backoff instead.
const LOCK_BACKOFF_START_MS = 20; // first wait between contention polls
const LOCK_BACKOFF_CAP_MS = 500; // backoff never grows past this per-poll

/**
 * Default deadline (ms) for {@link CommitWorkLock.acquireWithDeadline}. Generous
 * — a commit-work / base-merge window holds the lock only for the brief stage →
 * commit/merge → push, so 45s tolerates a slow-but-progressing holder while
 * still bounding the wait so a stuck holder degrades the worktree merge to a
 * retry-skip rather than freezing the reconcile cycle.
 */
export const COMMIT_WORK_LOCK_DEADLINE_MS = 45_000;

interface LibcSyms {
  // flock(int fd, int operation) -> int
  flock: (fd: number, operation: number) => number;
  // fcntl(int fd, int cmd, ...) -> int. We call only F_GETFD, which consumes no
  // variadic argument; the fixed signature's third i32 is a harmless dummy.
  fcntl: (fd: number, cmd: number, arg: number) => number;
  // errno accessor — `__error` on darwin, `__errno_location` on linux.
  errnoLocation: () => unknown;
}

// flock + fcntl share a fixed shape across platforms; only the errno accessor
// symbol name differs (`__error` on darwin, `__errno_location` on linux). Two
// literal-keyed `dlopen` specs avoid a dynamic key (which would force an `any`
// on the symbol map) — mirroring `src/exit-watcher-ffi.ts`'s mac/linux split.
const FLOCK_FN: FFIFunction = {
  args: [FFIType.i32, FFIType.i32],
  returns: FFIType.i32,
};
const FCNTL_FN: FFIFunction = {
  args: [FFIType.i32, FFIType.i32, FFIType.i32],
  returns: FFIType.i32,
};
const ERRNO_FN: FFIFunction = { args: [], returns: FFIType.ptr };

function loadLibc(): {
  lib: Library<Record<string, never>>;
  syms: LibcSyms;
} {
  if (process.platform === "darwin") {
    const lib = dlopen(`libSystem.${suffix}`, {
      flock: FLOCK_FN,
      fcntl: FCNTL_FN,
      __error: ERRNO_FN,
    });
    const raw = lib.symbols as unknown as Record<string, unknown>;
    return {
      lib: lib as unknown as Library<Record<string, never>>,
      syms: {
        flock: raw.flock as LibcSyms["flock"],
        fcntl: raw.fcntl as LibcSyms["fcntl"],
        errnoLocation: raw.__error as LibcSyms["errnoLocation"],
      },
    };
  }
  const lib = dlopen(`libc.${suffix}.6`, {
    flock: FLOCK_FN,
    fcntl: FCNTL_FN,
    __errno_location: ERRNO_FN,
  });
  const raw = lib.symbols as unknown as Record<string, unknown>;
  return {
    lib: lib as unknown as Library<Record<string, never>>,
    syms: {
      flock: raw.flock as LibcSyms["flock"],
      fcntl: raw.fcntl as LibcSyms["fcntl"],
      errnoLocation: raw.__errno_location as LibcSyms["errnoLocation"],
    },
  };
}

function readErrno(errnoPtr: unknown): number {
  // `__error` / `__errno_location` returns `int *`. Read the four bytes of the
  // current thread's errno. Mirrors `src/exit-watcher-ffi.ts:readErrno`.
  const ab = toArrayBuffer(
    errnoPtr as Parameters<typeof toArrayBuffer>[0],
    0,
    4,
  );
  return new DataView(ab).getInt32(0, LE);
}

/** A held commit-work lock. Call {@link CommitWorkLock.release} when done. */
export class CommitWorkLock {
  private readonly fd: number;
  private readonly lib: Library<Record<string, never>>;
  private readonly syms: LibcSyms;
  private released = false;

  private constructor(
    fd: number,
    lib: Library<Record<string, never>>,
    syms: LibcSyms,
  ) {
    this.fd = fd;
    this.lib = lib;
    this.syms = syms;
  }

  /**
   * Acquire `LOCK_EX` on `lockPath`, blocking until it is available. The lock
   * file is created if missing (`O_CREAT | O_WRONLY | O_TRUNC`); its CONTENT is
   * irrelevant — `flock` locks the open-file-description, not the bytes.
   * `O_CLOEXEC` is part of that SAME atomic open so a child can never inherit a
   * half-armed lock.
   */
  static acquire(lockPath: string): CommitWorkLock {
    const { lib, syms } = loadLibc();
    let fd: number;
    try {
      fd = openSync(lockPath, CLOEXEC_OPEN_FLAGS);
    } catch (err) {
      lib.close();
      throw err;
    }

    // Blocking exclusive lock. flock auto-retries internally on EINTR in
    // practice on darwin; a -1 here is a genuine failure.
    const r = syms.flock(fd, LOCK_EX);
    if (r < 0) {
      const errno = readErrno(syms.errnoLocation());
      closeSync(fd);
      lib.close();
      throw new Error(
        `commit-work flock: flock(LOCK_EX) failed errno=${errno}`,
      );
    }

    return new CommitWorkLock(fd, lib, syms);
  }

  /**
   * Try to acquire `LOCK_EX` without blocking (`LOCK_NB`). Returns the held
   * lock, or `null` if another holder owns it (errno `EWOULDBLOCK`). Used by
   * the test to prove a second concurrent acquire blocks; production
   * commit-work uses {@link acquire} (blocking).
   */
  static tryAcquire(lockPath: string): CommitWorkLock | null {
    const { lib, syms } = loadLibc();
    let fd: number;
    try {
      fd = openSync(lockPath, CLOEXEC_OPEN_FLAGS);
    } catch (err) {
      lib.close();
      throw err;
    }

    const r = syms.flock(fd, LOCK_EX | LOCK_NB);
    if (r < 0) {
      const errno = readErrno(syms.errnoLocation());
      closeSync(fd);
      lib.close();
      if (errno === EWOULDBLOCK) {
        return null;
      }
      throw new Error(
        `commit-work flock: flock(LOCK_EX|LOCK_NB) failed errno=${errno}`,
      );
    }

    return new CommitWorkLock(fd, lib, syms);
  }

  /**
   * Acquire `LOCK_EX` within `deadlineMs`, or return `null` on timeout. POLLS
   * the non-blocking {@link tryAcquire} with jittered exponential backoff (start
   * {@link LOCK_BACKOFF_START_MS}, cap {@link LOCK_BACKOFF_CAP_MS}) rather than a
   * blocking `flock(LOCK_EX)`, because a blocked FFI syscall cannot be timed out
   * in-process. The OPT-IN bounded acquirer for the autopilot worktree merge
   * path: a stuck holder degrades that merge to a retry-skip instead of freezing
   * the reconcile worker thread. PRODUCER-only — the bounded backoff-sleep is
   * acceptable here (the test-tier "poll, don't sleep" rule governs tests). The
   * default verb (`cli/commit-work.ts`) keeps the plain blocking {@link acquire}.
   */
  static async acquireWithDeadline(
    lockPath: string,
    deadlineMs: number = COMMIT_WORK_LOCK_DEADLINE_MS,
  ): Promise<CommitWorkLock | null> {
    const start = Date.now();
    let backoff = LOCK_BACKOFF_START_MS;
    for (;;) {
      const lock = CommitWorkLock.tryAcquire(lockPath);
      if (lock !== null) {
        return lock;
      }
      const remaining = deadlineMs - (Date.now() - start);
      if (remaining <= 0) {
        return null;
      }
      // Jitter ±50% so concurrent waiters never lock-step their polls, and never
      // sleep PAST the deadline (a tiny deadline still terminates promptly).
      const jittered = backoff * (0.5 + Math.random());
      const wait = Math.min(jittered, remaining);
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
      backoff = Math.min(backoff * 2, LOCK_BACKOFF_CAP_MS);
    }
  }

  /**
   * Read this held fd's descriptor flags through `fcntl(F_GETFD)`. Test-only
   * seam proving the atomic `O_CLOEXEC` open really set `FD_CLOEXEC`; unlike
   * F_SETFD, F_GETFD consumes no variadic argument and is reliable via Bun FFI.
   */
  readFdFlagsForTest(): number {
    if (this.released) {
      throw new Error("commit-work flock: cannot read flags after release");
    }
    const flags = this.syms.fcntl(this.fd, F_GETFD, 0);
    if (flags < 0) {
      const errno = readErrno(this.syms.errnoLocation());
      throw new Error(
        `commit-work flock: fcntl(F_GETFD) failed errno=${errno}`,
      );
    }
    return flags;
  }

  /**
   * Release the lock (`LOCK_UN`) and close the fd. Idempotent — a second call
   * is a no-op. Closing the fd alone would release the lock, but the explicit
   * `LOCK_UN` matches the man-page convention and is harmless.
   */
  release(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    this.syms.flock(this.fd, LOCK_UN);
    closeSync(this.fd);
    this.lib.close();
  }
}

// Re-export the raw constants so tests can assert the exact values the FFI
// path uses without re-deriving them.
export const FLOCK_CONSTANTS = {
  LOCK_SH,
  LOCK_EX,
  LOCK_NB,
  LOCK_UN,
  EWOULDBLOCK,
  F_GETFD,
  FD_CLOEXEC,
  O_CLOEXEC,
} as const;
