// flock(2) task locks via bun:ffi. Concurrent `keeper plan` processes may
// mutate the same `.keeper/` state, so the lock has to be a real advisory
// whole-file lock the kernel arbitrates across process boundaries; nothing
// softer (a sidecar marker, a Bun-only mutex) would serialize separate
// processes.
//
// dlopen resolves libc BY NAME with platform candidates (never an embedded
// copy): the system libc owns the kernel's flock table, and only it can hand us
// a real advisory lock across processes. fds come from node:fs openSync — Bun.file
// fd handles are GC-hazardous (bun#8687, the fd can be closed under us), so we
// hold a raw integer fd for the whole lock lifetime and closeSync it ourselves.
//
// errno after an FFI call is read through libc's per-thread errno pointer
// (__error on darwin, __errno_location on linux) — Bun does not surface errno on
// the symbols object, so we dereference the pointer with bun:ffi read.i32.

import { dlopen, FFIType, type Pointer, read, suffix } from "bun:ffi";
import { closeSync, constants, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// flock(2) operation constants — identical across darwin/linux (these are the
// BSD flock API values, not platform-specific unlike errno).
export const LOCK_SH = 1;
export const LOCK_EX = 2;
export const LOCK_NB = 4;
export const LOCK_UN = 8;

// EWOULDBLOCK — the errno flock(LOCK_NB) returns when the lock is already held.
// This one IS platform-specific: 35 on darwin/BSD, 11 on linux.
export const EWOULDBLOCK = process.platform === "darwin" ? 35 : 11;

// The commit-work lock fd is held ACROSS git child spawns, so it MUST be
// close-on-exec — an inherited copy in a still-running child keeps the
// open-file-description (and its flock) alive past our release, blocking the next
// committer until that child exits. We set it via O_CLOEXEC AT open() (atomic, no
// fork-race), NOT fcntl(F_SETFD): fcntl is variadic, and bun:ffi's fixed-arity
// declaration mis-passes the third arg on darwin arm64 (register vs the stack the
// C ABI reads variadic args from), so fcntl(F_SETFD, FD_CLOEXEC) returns success
// yet silently leaves the flag CLEAR. F_GETFD (no variadic arg) reads back fine,
// so it stays the verification path. FD_CLOEXEC + F_GETFD are ABI-stable across
// darwin/linux.
export const F_GETFD = 1;
export const FD_CLOEXEC = 1;

// O_CLOEXEC is NOT exposed by Bun's node:fs `constants` and its value is
// platform-specific: 0x1000000 on darwin, 0o2000000 on linux. OR-ing it into the
// open() flags is what actually marks the lock fd close-on-exec.
const O_CLOEXEC = process.platform === "darwin" ? 0x1000000 : 0o2000000;

// The open() flags for the lock file: write + create + truncate + close-on-exec.
// Content is irrelevant — flock locks the open-file-description, not the bytes.
const CLOEXEC_OPEN_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | O_CLOEXEC;

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
  fcntl(fd: number, cmd: number, arg: number): number;
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
        // fcntl is variadic; we only ever call the F_GETFD form (which reads no
        // variadic arg), so the fixed 3-arg i32 signature is safe here. A dummy
        // third arg is passed and ignored.
        fcntl: {
          args: [FFIType.i32, FFIType.i32, FFIType.i32],
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
        fcntl: symbols.fcntl as (
          fd: number,
          cmd: number,
          arg: number,
        ) => number,
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

/** fcntl(fd, cmd, arg) — thin pass-through to libc, returning the raw rc (-1 on
 * error, errno via currentErrno). Used to read the fd flags back with
 * `fcntl(fd, F_GETFD, 0)` (a NON-variadic-arg command, so it is reliable under
 * FFI); do NOT use it to SET a flag (F_SETFD) — see the FD_CLOEXEC note. */
export function fcntl(fd: number, cmd: number, arg: number): number {
  return libc().fcntl(fd, cmd, arg);
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

// ---------------------------------------------------------------------------
// Global epic-id lock.
// ---------------------------------------------------------------------------

// A single host-wide lock PATH so concurrent `keeper plan` creates serialize
// against each other across process boundaries: `~/.local/state/keeper/...`,
// honoring $HOME first.
function epicIdLockPath(): string {
  const home = process.env.HOME || homedir();
  return join(home, ".local", "state", "keeper", "epic-id.lock");
}

/** Run `fn` while holding the global epic-id lock (blocking LOCK_EX) over the
 * scan -> global-name-check -> write-epic critical section. FAIL-SOFT: if the
 * lock file cannot be created or locked (unwritable state dir, OSError), `fn`
 * runs UNLOCKED rather than hard-breaking create — the per-project
 * epic-path-exists backstop is the degraded guard. The fd is unlocked + closed
 * in finally. NEVER routes through flockOrThrow: a contended blocking LOCK_EX
 * parks until granted, and any acquire error degrades to unlocked. */
export function withEpicIdLock<T>(fn: () => T): T {
  let fd: number | null = null;
  try {
    const path = epicIdLockPath();
    mkdirSync(dirname(path), { recursive: true });
    fd = openSync(path, "w");
    // Blocking LOCK_EX: parks until granted, never throws on contention.
    if (flock(fd, LOCK_EX) !== 0) {
      // Acquire failed — degrade to unlocked (fail-soft).
      closeFdQuiet(fd);
      fd = null;
    }
  } catch {
    // Could not establish the lock — proceed unlocked (fail-soft).
    if (fd !== null) {
      closeFdQuiet(fd);
      fd = null;
    }
  }

  try {
    return fn();
  } finally {
    if (fd !== null) {
      try {
        flock(fd, LOCK_UN);
      } catch {
        // ignore — closing the fd releases the advisory lock anyway.
      }
      closeFdQuiet(fd);
    }
  }
}

function closeFdQuiet(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // ignore — best-effort release.
  }
}

// ---------------------------------------------------------------------------
// Commit-work lock — synchronous deadline-bounded exclusive acquire.
// ---------------------------------------------------------------------------

// The plan auto-commit path serializes its write -> commit window on the shared
// commit-work flock so a `keeper plan` verb and the daemon's base-merge /
// commit-work never race the same checkout's index. The commit path is
// deliberately SYNCHRONOUS (see the busy-wait in commit.ts, run inline before
// the emit seam prints), so this acquire is sync too: a poll of the non-blocking
// LOCK_NB with jittered backoff against an absolute deadline, NEVER a blocking
// LOCK_EX. A blocked FFI syscall is uninterruptible under Bun — no timer or
// signal reaches it — so a blocking acquire could freeze the verb indefinitely.

const COMMIT_WORK_BACKOFF_START_MS = 20; // first wait between contention polls
const COMMIT_WORK_BACKOFF_CAP_MS = 500; // backoff never grows past this per-poll

/** Default deadline (ms) for {@link acquireCommitWorkLock}. Mirrors the daemon
 * side (src/commit-work/flock.ts): a commit / base-merge holds the lock only for
 * the brief stage -> commit -> push, so 45s tolerates a slow-but-progressing
 * holder while still bounding the wait — a stuck holder degrades to a `timeout`
 * outcome the caller surfaces as a retryable envelope rather than a freeze. */
export const COMMIT_WORK_LOCK_DEADLINE_MS = 45_000;

/** A held commit-work lock. `release()` unlocks + closes the fd (idempotent).
 * `fd` is exposed so a test can read back FD_CLOEXEC via `fcntl(fd, F_GETFD)`. */
export interface HeldCommitWorkLock {
  readonly fd: number;
  release(): void;
}

/** The tagged outcome of {@link acquireCommitWorkLock}. `acquired` carries the
 * held lock; `timeout` means the deadline elapsed under contention (RETRYABLE —
 * another committer held it the whole window); `environmental` means the lock
 * file could not be opened / marked / locked for a reason that is NOT contention
 * (unwritable state dir, bad fd, IO error), carrying its errno + message. The
 * caller MUST distinguish timeout (retry) from environmental (fail the verb). */
export type CommitWorkAcquire =
  | { kind: "acquired"; lock: HeldCommitWorkLock }
  | { kind: "timeout" }
  | { kind: "environmental"; errno: number; message: string };

function heldCommitWorkLock(fd: number): HeldCommitWorkLock {
  let released = false;
  return {
    fd,
    release(): void {
      if (released) {
        return;
      }
      released = true;
      try {
        flock(fd, LOCK_UN);
      } catch {
        // ignore — closing the fd releases the advisory lock anyway.
      }
      closeFdQuiet(fd);
    },
  };
}

/**
 * Acquire the exclusive commit-work lock at `lockPath` within `deadlineMs`,
 * SYNCHRONOUSLY. Opens (creates) the lock file close-on-exec — so a git child
 * spawned while we hold the lock can never inherit the open-file-description and
 * keep the lock alive past our release — then polls the non-blocking `flock(
 * LOCK_EX | LOCK_NB)` with jittered exponential backoff (start
 * {@link COMMIT_WORK_BACKOFF_START_MS}, cap {@link COMMIT_WORK_BACKOFF_CAP_MS})
 * until it wins the lock or the deadline elapses. A single attempt always fires
 * even with a zero/tiny deadline. Returns a tagged {@link CommitWorkAcquire}: an
 * open failure or a non-EWOULDBLOCK flock error is `environmental` (never a false
 * `timeout`), a genuinely contended window that outlasts the deadline is
 * `timeout`. `sleep` is injectable (defaults to `Bun.sleepSync`) so a test can
 * drive the backoff without real wall-clock waits; production always sleeps
 * between polls so contention never busy-spins a core.
 */
export function acquireCommitWorkLock(
  lockPath: string,
  deadlineMs: number = COMMIT_WORK_LOCK_DEADLINE_MS,
  sleep: (ms: number) => void = Bun.sleepSync,
): CommitWorkAcquire {
  let fd: number;
  try {
    fd = openSync(lockPath, CLOEXEC_OPEN_FLAGS);
  } catch (err) {
    return {
      kind: "environmental",
      errno: 0,
      message: `open ${lockPath}: ${String(err)}`,
    };
  }

  const deadline = Date.now() + Math.max(0, deadlineMs);
  let backoff = COMMIT_WORK_BACKOFF_START_MS;
  for (;;) {
    if (flock(fd, LOCK_EX | LOCK_NB) === 0) {
      return { kind: "acquired", lock: heldCommitWorkLock(fd) };
    }
    const errno = currentErrno();
    if (errno !== EWOULDBLOCK) {
      // Not contention — a real lock-fd error. Environmental, never a timeout.
      closeFdQuiet(fd);
      return {
        kind: "environmental",
        errno,
        message: `flock(LOCK_EX | LOCK_NB) failed (errno ${errno})`,
      };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      closeFdQuiet(fd);
      return { kind: "timeout" };
    }
    // Jitter ±50% so concurrent waiters never lock-step their polls, and never
    // sleep past the deadline (a tiny deadline still terminates promptly).
    const jittered = backoff * (0.5 + Math.random());
    sleep(Math.min(jittered, remaining));
    backoff = Math.min(backoff * 2, COMMIT_WORK_BACKOFF_CAP_MS);
  }
}
