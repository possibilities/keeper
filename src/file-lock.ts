/**
 * `flock(2)` advisory lock primitive for serializing concurrent read-modify-
 * write cycles on any shared sidecar file. General-purpose: the caller names the
 * lock path and owns whatever file it guards — the primitive knows nothing about
 * the guarded data.
 *
 * DB-free leaf: imports only `bun:ffi` + `node:fs`, never `src/db.ts`, so a
 * cold-start caller (the DB-free `keeper agent` launch path) stays cheap. Mirrors
 * keeper's own `src/commit-work/flock.ts` libc/flock precedent.
 *
 * Two macOS-aarch64 correctness hazards, both asserted in tests because they
 * fail SILENTLY:
 *
 *  1. **FFI return type.** `flock` returns `int`; declaring it anything but
 *     `FFIType.i32` on aarch64 reads the wrong register width and can
 *     segfault. We declare `i32` and read `__error()` for errno on failure.
 *
 *  2. **FD_CLOEXEC.** Without `fcntl(fd, F_SETFD, FD_CLOEXEC)` the lock fd is
 *     INHERITED by every child spawned while holding the lock. `flock` locks
 *     are released only when the LAST fd referencing the open-file-description
 *     closes — so an inherited copy in a still-running child keeps the lock
 *     held long after we release ours, blocking the next waiter until that
 *     child exits. Marking the fd close-on-exec makes spawned children NOT
 *     inherit it.
 *
 * `FileLock` owns the common case: it opens its own lock file (truncating `"w"`
 * — content is irrelevant) and locks the open-file-description. A consumer that
 * must lock a fd it opened NON-truncating uses the raw `loadLibc` / `flockFd` /
 * `setCloexec` exports against its own fd.
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

// flock(LOCK_NB) reports contention with a platform-specific errno.
const EWOULDBLOCK = process.platform === "darwin" ? 35 : 11;

const LE = true; // both supported targets are little-endian

export interface LibcSyms {
  // flock(int fd, int operation) -> int
  flock: (fd: number, operation: number) => number;
  // fcntl(int fd, int cmd, int arg) -> int  (variadic; the 3-arg form for
  // F_SETFD takes an int flag, which the fixed i32 signature matches)
  fcntl: (fd: number, cmd: number, arg: number) => number;
  // errno accessor — `__error` on darwin, `__errno_location` on linux.
  errnoLocation: () => unknown;
}

export interface LoadedLibc {
  lib: Library<Record<string, never>>;
  syms: LibcSyms;
}

// flock + fcntl share a fixed shape across platforms; only the errno accessor
// symbol name differs (`__error` on darwin, `__errno_location` on linux). Two
// literal-keyed `dlopen` specs avoid a dynamic key (which would force an `any`
// on the symbol map).
const FLOCK_FN: FFIFunction = {
  args: [FFIType.i32, FFIType.i32],
  returns: FFIType.i32,
};
const FCNTL_FN: FFIFunction = {
  args: [FFIType.i32, FFIType.i32, FFIType.i32],
  returns: FFIType.i32,
};
const ERRNO_FN: FFIFunction = { args: [], returns: FFIType.ptr };

/**
 * Open libc and bind `flock` / `fcntl` / the errno accessor. Exported so an
 * external consumer can lock a fd it opened itself (non-truncating) without
 * going through {@link FileLock}, which truncates its lock file on open.
 */
export function loadLibc(): LoadedLibc {
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

/** Read the four bytes of the current thread's errno from `int *`. */
export function readErrno(errnoPtr: unknown): number {
  const ab = toArrayBuffer(
    errnoPtr as Parameters<typeof toArrayBuffer>[0],
    0,
    4,
  );
  return new DataView(ab).getInt32(0, LE);
}

/**
 * Mark `fd` close-on-exec. Throws on failure. An external consumer locking its
 * own fd must call this BEFORE the blocking flock (hazard 2) so a child spawned
 * by a concurrent waiter can never inherit a half-armed lock.
 */
export function setCloexec(syms: LibcSyms, fd: number): void {
  const fr = syms.fcntl(fd, F_SETFD, FD_CLOEXEC);
  if (fr < 0) {
    const errno = readErrno(syms.errnoLocation());
    throw new Error(`FileLock: fcntl(F_SETFD) failed errno=${errno}`);
  }
}

/**
 * Run `flock(fd, operation)`. Returns true on success, false on `EWOULDBLOCK`
 * (a non-blocking acquire on a held lock); throws on any other errno. Exported
 * for the external consumer that locks its own fd.
 */
export function flockFd(
  syms: LibcSyms,
  fd: number,
  operation: number,
): boolean {
  const r = syms.flock(fd, operation);
  if (r < 0) {
    const errno = readErrno(syms.errnoLocation());
    if (errno === EWOULDBLOCK) {
      return false;
    }
    throw new Error(`FileLock: flock(${operation}) failed errno=${errno}`);
  }
  return true;
}

/** A held advisory lock on a sidecar file. Call {@link FileLock.release}. */
export class FileLock {
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
  static acquire(lockPath: string): FileLock {
    const { lib, syms } = loadLibc();
    const fd = openSync(lockPath, "w");
    try {
      setCloexec(syms, fd);
      flockFd(syms, fd, LOCK_EX);
    } catch (err) {
      closeSync(fd);
      lib.close();
      throw err;
    }
    return new FileLock(fd, lib, syms);
  }

  /**
   * Try to acquire `LOCK_EX` without blocking (`LOCK_NB`). Returns the held
   * lock, or `null` if another holder owns it (errno `EWOULDBLOCK`).
   */
  static tryAcquire(lockPath: string): FileLock | null {
    const { lib, syms } = loadLibc();
    const fd = openSync(lockPath, "w");
    try {
      setCloexec(syms, fd);
      const got = flockFd(syms, fd, LOCK_EX | LOCK_NB);
      if (!got) {
        closeSync(fd);
        lib.close();
        return null;
      }
    } catch (err) {
      closeSync(fd);
      lib.close();
      throw err;
    }
    return new FileLock(fd, lib, syms);
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

// Re-export the raw constants so consumers (and tests) can assert the exact
// values the FFI path uses without re-deriving them.
export const FLOCK_CONSTANTS = {
  LOCK_SH,
  LOCK_EX,
  LOCK_NB,
  LOCK_UN,
  F_SETFD,
  FD_CLOEXEC,
} as const;
