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
 * Two macOS-aarch64 correctness hazards the epic's risks call out, both
 * asserted in tests because they fail SILENTLY:
 *
 *  1. **FFI return type.** `flock` returns `int`; declaring it anything but
 *     `FFIType.i32` on aarch64 reads the wrong register width and can
 *     segfault. We declare `i32` and read `__error()` for errno on failure,
 *     mirroring `src/exit-watcher-ffi.ts`.
 *
 *  2. **FD_CLOEXEC.** Without `fcntl(fd, F_SETFD, FD_CLOEXEC)` the lock fd is
 *     INHERITED by every `git` / `ruff` / `tsc` child we spawn while holding
 *     the lock. `flock` locks are released only when the LAST fd referencing
 *     the open-file-description closes — so an inherited copy in a still-
 *     running child keeps the lock held long after we release ours, blocking
 *     the next committer until that child exits. Marking the fd close-on-exec
 *     makes spawned children NOT inherit it.
 */

import {
  dlopen,
  type FFIFunction,
  FFIType,
  type Library,
  suffix,
  toArrayBuffer,
} from "bun:ffi";
import { closeSync, openSync } from "node:fs";

// flock(2) operations, from <sys/file.h>. ABI-stable across darwin/linux.
const LOCK_SH = 1;
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

// fcntl(2) F_SETFD command + FD_CLOEXEC flag, from <fcntl.h>. Stable.
const F_SETFD = 2;
const FD_CLOEXEC = 1;

// errno values we branch on; stable across darwin/linux.
const EWOULDBLOCK = 35; // == EAGAIN on darwin; flock(LOCK_NB) on a held lock

const LE = true; // both supported targets are little-endian

interface LibcSyms {
  // flock(int fd, int operation) -> int
  flock: (fd: number, operation: number) => number;
  // fcntl(int fd, int cmd, int arg) -> int  (variadic; the 3-arg form for
  // F_SETFD takes an int flag, which the fixed i32 signature matches)
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
   * file is created if missing (`openSync(..., "w")` → `O_CREAT | O_WRONLY |
   * O_TRUNC`); its CONTENT is irrelevant — `flock` locks the open-file-
   * description, not the bytes. The fd is marked `FD_CLOEXEC` BEFORE the
   * blocking `flock` so a child spawned by a concurrent waiter can never
   * inherit a half-armed lock.
   */
  static acquire(lockPath: string): CommitWorkLock {
    const { lib, syms } = loadLibc();
    const fd = openSync(lockPath, "w");

    // Mark close-on-exec FIRST — see the module header (hazard 2). A spawned
    // child must never inherit this fd, or the lock outlives our release.
    const fr = syms.fcntl(fd, F_SETFD, FD_CLOEXEC);
    if (fr < 0) {
      const errno = readErrno(syms.errnoLocation());
      closeSync(fd);
      lib.close();
      throw new Error(
        `commit-work flock: fcntl(F_SETFD) failed errno=${errno}`,
      );
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
    const fd = openSync(lockPath, "w");

    const fr = syms.fcntl(fd, F_SETFD, FD_CLOEXEC);
    if (fr < 0) {
      const errno = readErrno(syms.errnoLocation());
      closeSync(fd);
      lib.close();
      throw new Error(
        `commit-work flock: fcntl(F_SETFD) failed errno=${errno}`,
      );
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
  F_SETFD,
  FD_CLOEXEC,
} as const;
