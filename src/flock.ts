// flock(2) task locks via bun:ffi — the byte-compatible peer of Python's
// fcntl.flock(fd, LOCK_EX) in planctl/store.py's lock_task. Both engines may
// mutate the same .planctl/ state concurrently, so the lock has to be a real
// advisory whole-file lock that interops with Python's fcntl across process
// boundaries; nothing softer (a sidecar marker, a Bun-only mutex) would block a
// Python peer.
//
// dlopen resolves libc BY NAME with platform candidates (never an embedded
// copy): the system libc owns the kernel's flock table, and only it can hand us
// a lock a Python fcntl peer also sees. fds come from node:fs openSync — Bun.file
// fd handles are GC-hazardous (bun#8687, the fd can be closed under us), so we
// hold a raw integer fd for the whole lock lifetime and closeSync it ourselves.
//
// errno after an FFI call is read through libc's per-thread errno pointer
// (__error on darwin, __errno_location on linux) — Bun does not surface errno on
// the symbols object, so we dereference the pointer with bun:ffi read.i32.

import { dlopen, FFIType, type Pointer, read, suffix } from "bun:ffi";

// flock(2) operation constants — identical across darwin/linux (these are the
// BSD flock API values, not platform-specific unlike errno).
export const LOCK_SH = 1;
export const LOCK_EX = 2;
export const LOCK_NB = 4;
export const LOCK_UN = 8;

// EWOULDBLOCK — the errno flock(LOCK_NB) returns when the lock is already held.
// This one IS platform-specific: 35 on darwin/BSD, 11 on linux.
export const EWOULDBLOCK = process.platform === "darwin" ? 35 : 11;

// libc shared-object candidates, by name only. dlopen walks the loader's search
// path; we never ship a copy. darwin: libc.dylib / libSystem provide flock; on a
// versioned linux libc the bare `libc.so` is a linker script (not dlopen-able),
// so the real soname libc.so.6 leads.
const LIBC_CANDIDATES =
  process.platform === "darwin"
    ? ["libc.dylib", "libSystem.dylib", `libc.${suffix}`]
    : ["libc.so.6", `libc.${suffix}`];

// Per-thread errno accessor: __error on darwin, __errno_location on linux. Both
// return a pointer to the thread's errno int.
const ERRNO_SYMBOL =
  process.platform === "darwin" ? "__error" : "__errno_location";

interface LibcFlock {
  flock(fd: number, op: number): number;
  errnoPtr(): Pointer | null;
}

function openLibc(): LibcFlock {
  let lastError: unknown;
  for (const name of LIBC_CANDIDATES) {
    try {
      const lib = dlopen(name, {
        flock: {
          args: [FFIType.i32, FFIType.i32],
          returns: FFIType.i32,
        },
        [ERRNO_SYMBOL]: {
          args: [],
          returns: FFIType.ptr,
        },
      });
      const symbols = lib.symbols as Record<string, unknown>;
      return {
        flock: symbols.flock as (fd: number, op: number) => number,
        errnoPtr: symbols[ERRNO_SYMBOL] as () => Pointer | null,
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `flock: could not dlopen libc (tried ${LIBC_CANDIDATES.join(", ")}): ${String(lastError)}`,
  );
}

let cachedLibc: LibcFlock | null = null;

function libc(): LibcFlock {
  if (cachedLibc === null) {
    cachedLibc = openLibc();
  }
  return cachedLibc;
}

/** Current errno, read through libc's per-thread errno pointer. Valid only
 * immediately after the failing call, before any other libc activity. */
export function currentErrno(): number {
  const ptr = libc().errnoPtr();
  if (ptr === null) {
    return 0;
  }
  return read.i32(ptr, 0);
}

/** flock(fd, op) — returns 0 on success, -1 on error (errno via currentErrno).
 * Thin pass-through to libc; callers that want the contended LOCK_NB case
 * surfaced as a typed throw use flockOrThrow. */
export function flock(fd: number, op: number): number {
  return libc().flock(fd, op);
}

/** Thrown when a LOCK_NB acquisition finds the lock already held (errno
 * EWOULDBLOCK). Lets tests assert the contended case without inspecting raw
 * errno. */
export class FlockWouldBlock extends Error {
  constructor() {
    super("flock: would block (EWOULDBLOCK)");
    this.name = "FlockWouldBlock";
  }
}

/** Acquire `op` on `fd`, throwing FlockWouldBlock when a non-blocking request
 * is contended. A blocking LOCK_EX never throws this — it parks until granted.
 * Any other failure raises a generic Error carrying errno. */
export function flockOrThrow(fd: number, op: number): void {
  const rc = libc().flock(fd, op);
  if (rc === 0) {
    return;
  }
  const err = currentErrno();
  if (err === EWOULDBLOCK) {
    throw new FlockWouldBlock();
  }
  throw new Error(`flock(fd=${fd}, op=${op}) failed (errno ${err})`);
}
