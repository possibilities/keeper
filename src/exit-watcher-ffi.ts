/**
 * Process-exit watcher backed by `bun:ffi`. Used by the exit-watcher worker
 * (task 8) to learn — without polling — that a tracked Claude Code session
 * process has exited, so the daemon can fold a synthetic `Killed` event.
 *
 * Platform abstraction:
 * - macOS uses kqueue with `EVFILT_PROC | NOTE_EXIT | EV_ONESHOT`, plus a
 *   process-wide `EVFILT_USER` registration that doubles as the wakeup primitive
 *   for `wake()`. `EV_ONESHOT` makes the registration auto-delete when the
 *   process exits — no `EV_DELETE` cleanup, no accidental re-arm.
 * - Linux uses `pidfd_open(2)` (kernel ≥ 5.3) + `epoll_wait(2)`. An
 *   `eventfd(2)` is registered alongside the pidfds; writing to the eventfd
 *   from `wake()` interrupts a blocked `epoll_wait`. Each registered pidfd is
 *   `EPOLLIN | EPOLLONESHOT` so a single exit produces a single readable event.
 *
 * Why FFI rather than a JS poll loop:
 * - kqueue / pidfd are the only kernel-supported mechanisms for "tell me when
 *   this process exits", and process-liveness changes have no equivalent in
 *   the Node/Bun stdlib.
 * - Polling `kill(pid, 0)` every N ms wastes CPU and adds N/2 ms of expected
 *   detection latency per pid. The FFI path is event-driven and scales to
 *   hundreds of pids on one fd.
 *
 * Why a small synchronous FFI surface rather than `nonblocking` calls:
 * - The exit-watcher worker (task 8) is a dedicated thread whose only job is
 *   to block in `wait()`. Sync FFI keeps the codepath obvious and lets the
 *   kernel return events directly into a single 32-byte (or 12-byte on Linux)
 *   stack-shaped buffer. JSCallback / threadsafe paths add complexity we
 *   don't need; per the task brief, "keep the kevent/epoll loop INSIDE the
 *   worker thread."
 *
 * Wakeup model:
 * - `wait()` polls in short sub-timeout slices so the JS event loop can
 *   process inbound worker messages between iterations. Each slice is a
 *   blocking syscall (~1µs overhead through the FFI gateway, dominated by
 *   the kernel wait). `wake()` writes to the wakeup primitive (EVFILT_USER on
 *   macOS, eventfd on Linux) — the next slice returns immediately with a
 *   `wakeup` result.
 *
 * Re-fold determinism note: this module performs liveness probes (kill(pid,0)
 * post-register, and the EV_ADD / pidfd_open ESRCH races) but only at the
 * PRODUCER edge — never inside a reducer fold. The caller (exit-watcher
 * worker) emits a `Killed` synthetic event with `(pid, start_time)` once;
 * re-folding from cursor=0 replays that event without re-probing.
 */

import {
  CString,
  dlopen,
  type FFIFunction,
  FFIType,
  type Library,
  read,
  suffix,
  toArrayBuffer,
} from "bun:ffi";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Outcome of `add()`. Caller emits `Killed` immediately on `alreadyDead`. */
export type AddResult =
  | { registered: true }
  | { alreadyDead: true; reason: "esrch" | "kill0" };

/** Outcome of `wait()`. */
export type WaitResult =
  | { kind: "exit"; pid: number; udata: bigint }
  | { kind: "timeout" }
  | { kind: "wakeup" };

/** Common platform-abstract surface implemented by macOS / Linux backends. */
export interface ExitWatcher {
  /**
   * Register interest in `pid`'s exit. `udata` is an opaque caller-chosen
   * correlation token (e.g. the jobs.rowid encoded as i64) returned on the
   * matching `wait()` result.
   *
   * Returns `{ alreadyDead }` if the pid was found dead at register time —
   * either the kernel rejected the registration (kqueue ESRCH/ENOENT, pidfd
   * ESRCH) or the post-register `kill(pid, 0)` probe noticed an exit in the
   * tiny window between event source arrival and kernel registration.
   */
  add(pid: number, udata: bigint): AddResult;

  /**
   * Block up to `timeoutMs` waiting for an exit event or a wakeup. Returns:
   * - `{ kind: "exit", pid, udata }` — exactly one tracked pid has exited
   * - `{ kind: "timeout" }` — `timeoutMs` elapsed with nothing to report
   * - `{ kind: "wakeup" }` — `wake()` was called from another thread
   *
   * Internally polls in short slices so JS message processing on the calling
   * worker isn't starved. The total wall time will not exceed `timeoutMs`
   * meaningfully.
   */
  wait(timeoutMs: number): Promise<WaitResult>;

  /**
   * Trigger an out-of-band wakeup on the underlying kqueue/epoll fd. Safe to
   * call from a different thread inside the same process — fds are
   * process-wide.
   */
  wake(): void;

  /** Release all held kernel resources. Idempotent. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// macOS / BSD kqueue, from <sys/event.h>. ABI-stable since 10.6.
export const KQ = {
  EVFILT_PROC: -5,
  EVFILT_USER: -10,
  EV_ADD: 0x0001,
  EV_ENABLE: 0x0004,
  EV_ONESHOT: 0x0010,
  EV_CLEAR: 0x0020,
  EV_ERROR: 0x4000,
  NOTE_EXIT: 0x80000000,
  NOTE_TRIGGER: 0x01000000,
  KEVENT_SIZE: 32,
  KEVENT_OFF_IDENT: 0,
  KEVENT_OFF_FILTER: 8,
  KEVENT_OFF_FLAGS: 10,
  KEVENT_OFF_FFLAGS: 12,
  KEVENT_OFF_DATA: 16,
  KEVENT_OFF_UDATA: 24,
  WAKE_IDENT: 1n, // ident for the EVFILT_USER wakeup registration
} as const;

// Linux: from <sys/epoll.h>, <linux/eventfd.h>, <sys/syscall.h>. ABI-stable.
export const LX = {
  EPOLL_CTL_ADD: 1,
  EPOLL_CTL_DEL: 2,
  EPOLLIN: 0x001,
  EPOLLONESHOT: 1 << 30,
  EFD_NONBLOCK: 0o4000, // 0x800
  EFD_CLOEXEC: 0o2000_000, // 0x80000
  // x86_64 syscall numbers — pidfd_open is the only one we need by-number;
  // others use libc.
  SYS_pidfd_open_x86_64: 434,
  SYS_pidfd_open_aarch64: 434,
  // struct epoll_event on Linux x86_64/aarch64: __packed__, 12 bytes total
  // (uint32_t events; epoll_data_t data — 8 bytes union, naturally aligned but
  // the struct itself is __attribute__((packed)) on x86_64). Linux always uses
  // a 12-byte struct here regardless of platform.
  EPOLL_EVENT_SIZE: 12,
  EPOLL_EVENT_OFF_EVENTS: 0,
  EPOLL_EVENT_OFF_DATA: 4,
  WAKE_UDATA: 0xfeedfacefeedfacen, // tag for the eventfd registration
} as const;

// errno values we branch on. Stable across darwin/linux.
const ESRCH = 3;
const ENOENT = 2;
const EINTR = 4;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct an `ExitWatcher` for the current platform. Throws if the platform
 * is unsupported or the required kernel facilities cannot be loaded (e.g.
 * Linux without pidfd_open / kernel < 5.3).
 */
export function createExitWatcher(): ExitWatcher {
  if (process.platform === "darwin") {
    return new MacExitWatcher();
  }
  if (process.platform === "linux") {
    return new LinuxExitWatcher();
  }
  throw new Error(`exit-watcher-ffi: unsupported platform ${process.platform}`);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const LE = true; // both supported targets are little-endian

/** Write a `struct timespec` (16 bytes) into `buf` for `ms` milliseconds. */
function writeTimespec(buf: ArrayBuffer, ms: number): void {
  const dv = new DataView(buf);
  const clamped = Math.max(0, ms);
  const sec = Math.floor(clamped / 1000);
  const nsec = (clamped - sec * 1000) * 1_000_000;
  dv.setBigInt64(0, BigInt(sec), LE);
  dv.setBigInt64(8, BigInt(nsec), LE);
}

/**
 * `process.kill(pid, 0)` — alive iff resolves or EPERM. ESRCH means the pid is
 * gone. Mirrors `src/server-worker.ts:isPidAlive` deliberately (don't import to
 * keep this module standalone; the function is two lines).
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

// ---------------------------------------------------------------------------
// macOS backend — kqueue + EVFILT_PROC + EVFILT_USER
// ---------------------------------------------------------------------------

interface MacSyms {
  kqueue: () => number;
  kevent: (
    kq: number,
    changelist: ArrayBuffer | null,
    nchanges: number,
    eventlist: ArrayBuffer | null,
    nevents: number,
    timeout: ArrayBuffer | null,
  ) => number;
  close: (fd: number) => number;
  __error: () => unknown; // returns int* to thread-local errno
}

function readErrno(errnoPtr: unknown): number {
  // `__error` / `__errno_location` returns `int *`. `toArrayBuffer(ptr, 0, 4)`
  // gives us the four bytes of the current thread's errno. The Bun type for
  // the first arg is the opaque `Pointer` nominal type; we get a real pointer
  // back from FFI and cast through `unknown` to match.
  const ab = toArrayBuffer(
    errnoPtr as Parameters<typeof toArrayBuffer>[0],
    0,
    4,
  );
  return new DataView(ab).getInt32(0, LE);
}

class MacExitWatcher implements ExitWatcher {
  private readonly lib: Library<{
    kqueue: FFIFunction;
    kevent: FFIFunction;
    close: FFIFunction;
    __error: FFIFunction;
  }>;
  private readonly syms: MacSyms;
  private kq: number;
  private closed = false;
  // Reused scratch buffers — kqueue is single-threaded and we never overlap
  // calls from inside one ExitWatcher.
  private readonly changeBuf = new ArrayBuffer(KQ.KEVENT_SIZE);
  private readonly eventBuf = new ArrayBuffer(KQ.KEVENT_SIZE);
  private readonly timespecBuf = new ArrayBuffer(16);

  constructor() {
    this.lib = dlopen(`libSystem.${suffix}`, {
      kqueue: { args: [], returns: FFIType.i32 },
      kevent: {
        args: [
          FFIType.i32,
          FFIType.ptr,
          FFIType.i32,
          FFIType.ptr,
          FFIType.i32,
          FFIType.ptr,
        ],
        returns: FFIType.i32,
      },
      close: { args: [FFIType.i32], returns: FFIType.i32 },
      __error: { args: [], returns: FFIType.ptr },
    });
    this.syms = this.lib.symbols as unknown as MacSyms;

    this.kq = this.syms.kqueue();
    if (this.kq < 0) {
      const errno = readErrno(this.syms.__error());
      throw new Error(`exit-watcher-ffi: kqueue() failed errno=${errno}`);
    }

    // Register the EVFILT_USER wakeup. EV_CLEAR resets the "fired" state after
    // each delivery so consecutive `wake()` calls each produce a wakeup.
    this.writeKevent(
      this.changeBuf,
      KQ.WAKE_IDENT,
      KQ.EVFILT_USER,
      KQ.EV_ADD | KQ.EV_CLEAR,
      0,
      0n,
      0n,
    );
    writeTimespec(this.timespecBuf, 0); // immediate (don't wait)
    const r = this.syms.kevent(
      this.kq,
      this.changeBuf,
      1,
      null,
      0,
      this.timespecBuf,
    );
    if (r < 0) {
      const errno = readErrno(this.syms.__error());
      this.syms.close(this.kq);
      throw new Error(
        `exit-watcher-ffi: EVFILT_USER registration failed errno=${errno}`,
      );
    }
  }

  add(pid: number, udata: bigint): AddResult {
    this.assertOpen();
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new TypeError(`exit-watcher-ffi: invalid pid ${pid}`);
    }

    // EV_ADD with EV_ONESHOT — the kernel auto-deletes when NOTE_EXIT fires.
    // We pass a 1-slot eventlist so any EV_ERROR (ESRCH/ENOENT) comes back
    // inline without us needing a second kevent() round-trip.
    this.writeKevent(
      this.changeBuf,
      BigInt(pid),
      KQ.EVFILT_PROC,
      KQ.EV_ADD | KQ.EV_ONESHOT,
      KQ.NOTE_EXIT,
      0n,
      udata,
    );
    writeTimespec(this.timespecBuf, 0);
    const r = this.syms.kevent(
      this.kq,
      this.changeBuf,
      1,
      this.eventBuf,
      1,
      this.timespecBuf,
    );

    if (r < 0) {
      const errno = readErrno(this.syms.__error());
      throw new Error(
        `exit-watcher-ffi: kevent(EV_ADD pid=${pid}) failed errno=${errno}`,
      );
    }

    if (r === 1) {
      // Could be either an EV_ERROR receipt or — extremely unlikely on EV_ADD —
      // an immediate exit. Inspect EV_ERROR.
      const dv = new DataView(this.eventBuf);
      const flags = dv.getUint16(KQ.KEVENT_OFF_FLAGS, LE);
      if ((flags & KQ.EV_ERROR) !== 0) {
        const errno = Number(dv.getBigInt64(KQ.KEVENT_OFF_DATA, LE));
        if (errno === ESRCH || errno === ENOENT) {
          return { alreadyDead: true, reason: "esrch" };
        }
        throw new Error(
          `exit-watcher-ffi: EV_ADD pid=${pid} returned EV_ERROR errno=${errno}`,
        );
      }
      // Unexpected non-error event on register; treat conservatively.
    }

    // Post-register liveness probe — closes the race between event source
    // arrival and kernel registration. Practice-scout reference:
    // Chromium base/process/kill_mac.cc.
    if (!pidAlive(pid)) {
      return { alreadyDead: true, reason: "kill0" };
    }
    return { registered: true };
  }

  async wait(timeoutMs: number): Promise<WaitResult> {
    this.assertOpen();
    const deadline = performance.now() + Math.max(0, timeoutMs);
    // Slice the wait into small chunks so the calling worker's JS event loop
    // can process inbound `{ type: "shutdown" }` messages between iterations.
    const SLICE_MS = 25;

    while (true) {
      if (this.closed) {
        return { kind: "wakeup" };
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        return { kind: "timeout" };
      }
      const slice = Math.min(SLICE_MS, Math.ceil(remaining));
      writeTimespec(this.timespecBuf, slice);
      const r = this.syms.kevent(
        this.kq,
        null,
        0,
        this.eventBuf,
        1,
        this.timespecBuf,
      );

      if (r < 0) {
        const errno = readErrno(this.syms.__error());
        if (errno === EINTR) {
          // signal during wait — continue the slice loop
          continue;
        }
        throw new Error(`exit-watcher-ffi: kevent(wait) failed errno=${errno}`);
      }

      if (r === 0) {
        // slice timeout — yield one full event-loop tick so timers, I/O, and
        // `parentPort` messages can drain. `Promise.resolve()` only flushes
        // microtasks (timers stay queued); a setImmediate-style yield is
        // required to let `setTimeout(..., n)` callbacks land between slices.
        await new Promise<void>((res) => setImmediate(res));
        continue;
      }

      // r === 1: one event delivered
      const dv = new DataView(this.eventBuf);
      const filter = dv.getInt16(KQ.KEVENT_OFF_FILTER, LE);
      const flags = dv.getUint16(KQ.KEVENT_OFF_FLAGS, LE);
      const ident = dv.getBigUint64(KQ.KEVENT_OFF_IDENT, LE);
      const udata = dv.getBigUint64(KQ.KEVENT_OFF_UDATA, LE);

      if (filter === KQ.EVFILT_USER && ident === KQ.WAKE_IDENT) {
        return { kind: "wakeup" };
      }

      if (filter === KQ.EVFILT_PROC && (flags & KQ.EV_ERROR) === 0) {
        // NOTE_EXIT delivery
        return { kind: "exit", pid: Number(ident), udata };
      }

      // Unexpected event class — fall back to wakeup so the caller re-checks.
      return { kind: "wakeup" };
    }
  }

  wake(): void {
    if (this.closed) {
      return;
    }
    // Trigger the EVFILT_USER registration. We re-use the change buffer; this
    // is safe only because all four kevent call sites in this class are
    // serialized by the JS event loop. Cross-thread wake() callers (from main
    // into the worker) must dispatch wake via parentPort; they don't call this
    // method directly.
    this.writeKevent(
      this.changeBuf,
      KQ.WAKE_IDENT,
      KQ.EVFILT_USER,
      0, // no flag changes — just modify the existing registration
      KQ.NOTE_TRIGGER,
      0n,
      0n,
    );
    writeTimespec(this.timespecBuf, 0);
    this.syms.kevent(this.kq, this.changeBuf, 1, null, 0, this.timespecBuf);
    // Best-effort: ignore failures here so close() can call wake() safely.
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.kq >= 0) {
      this.syms.close(this.kq);
      this.kq = -1;
    }
    this.lib.close();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("exit-watcher-ffi: ExitWatcher is closed");
    }
  }

  private writeKevent(
    buf: ArrayBuffer,
    ident: bigint,
    filter: number,
    flags: number,
    fflags: number,
    data: bigint,
    udata: bigint,
  ): void {
    const dv = new DataView(buf);
    dv.setBigUint64(KQ.KEVENT_OFF_IDENT, ident, LE);
    dv.setInt16(KQ.KEVENT_OFF_FILTER, filter, LE);
    dv.setUint16(KQ.KEVENT_OFF_FLAGS, flags, LE);
    dv.setUint32(KQ.KEVENT_OFF_FFLAGS, fflags, LE);
    dv.setBigInt64(KQ.KEVENT_OFF_DATA, data, LE);
    dv.setBigUint64(KQ.KEVENT_OFF_UDATA, udata, LE);
  }
}

// ---------------------------------------------------------------------------
// Linux backend — pidfd_open + epoll + eventfd
// ---------------------------------------------------------------------------

interface LinuxSyms {
  syscall: (n: bigint, a: bigint, b: bigint) => bigint; // SYS_pidfd_open
  epoll_create1: (flags: number) => number;
  epoll_ctl: (
    epfd: number,
    op: number,
    fd: number,
    event: ArrayBuffer | null,
  ) => number;
  epoll_wait: (
    epfd: number,
    events: ArrayBuffer,
    maxEvents: number,
    timeoutMs: number,
  ) => number;
  eventfd: (initval: number, flags: number) => number;
  // We declare count as i32 in the FFI signature (not size_t / u64); 8 fits
  // trivially and keeps the JS interface a plain `number`. write/read return
  // ssize_t which we type as `bigint` since Bun marshals i64 returns as bigint.
  write: (fd: number, buf: ArrayBuffer, count: number) => bigint;
  read: (fd: number, buf: ArrayBuffer, count: number) => bigint;
  close: (fd: number) => number;
  __errno_location: () => unknown;
}

function pidfdOpenSyscallNumber(): bigint {
  // pidfd_open is syscall 434 on both x86_64 and aarch64 — the two architectures
  // we plausibly run on. arm and i686 differ; bail loudly.
  const arch = process.arch;
  if (arch === "x64" || arch === "arm64") {
    return BigInt(LX.SYS_pidfd_open_x86_64);
  }
  throw new Error(
    `exit-watcher-ffi: pidfd_open syscall number unknown for arch ${arch}`,
  );
}

class LinuxExitWatcher implements ExitWatcher {
  private readonly lib: Library<{
    syscall: FFIFunction;
    epoll_create1: FFIFunction;
    epoll_ctl: FFIFunction;
    epoll_wait: FFIFunction;
    eventfd: FFIFunction;
    write: FFIFunction;
    read: FFIFunction;
    close: FFIFunction;
    __errno_location: FFIFunction;
  }>;
  private readonly syms: LinuxSyms;
  private readonly pidfdSyscallNo: bigint;
  private epfd: number;
  private wakefd: number;
  private closed = false;
  // pidfd → (pid, udata) so we can recover them on epoll_wait delivery and
  // close the pidfd when we're done.
  private readonly tracked = new Map<number, { pid: number; udata: bigint }>();

  private readonly epollEventBuf = new ArrayBuffer(LX.EPOLL_EVENT_SIZE);
  private readonly epollWaitBuf = new ArrayBuffer(LX.EPOLL_EVENT_SIZE * 8); // up to 8 events per slice
  private readonly wakeWriteBuf = new ArrayBuffer(8);
  private readonly wakeReadBuf = new ArrayBuffer(8);

  constructor() {
    this.pidfdSyscallNo = pidfdOpenSyscallNumber();
    // libc.so.6 is the conventional soname on every glibc system. musl uses
    // libc.so or libc.musl-<arch>.so.1 — we explicitly require glibc here; a
    // musl deployment will fail loudly at dlopen, which is acceptable for now.
    this.lib = dlopen(`libc.${suffix}.6`, {
      syscall: {
        args: [FFIType.i64, FFIType.i64, FFIType.i64],
        returns: FFIType.i64,
      },
      epoll_create1: { args: [FFIType.i32], returns: FFIType.i32 },
      epoll_ctl: {
        args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr],
        returns: FFIType.i32,
      },
      epoll_wait: {
        args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
        returns: FFIType.i32,
      },
      eventfd: { args: [FFIType.u32, FFIType.i32], returns: FFIType.i32 },
      write: {
        args: [FFIType.i32, FFIType.ptr, FFIType.i32],
        returns: FFIType.i64,
      },
      read: {
        args: [FFIType.i32, FFIType.ptr, FFIType.i32],
        returns: FFIType.i64,
      },
      close: { args: [FFIType.i32], returns: FFIType.i32 },
      __errno_location: { args: [], returns: FFIType.ptr },
    });
    this.syms = this.lib.symbols as unknown as LinuxSyms;

    this.epfd = this.syms.epoll_create1(0);
    if (this.epfd < 0) {
      const errno = readErrno(this.syms.__errno_location());
      throw new Error(`exit-watcher-ffi: epoll_create1 failed errno=${errno}`);
    }

    this.wakefd = this.syms.eventfd(0, LX.EFD_NONBLOCK | LX.EFD_CLOEXEC);
    if (this.wakefd < 0) {
      const errno = readErrno(this.syms.__errno_location());
      this.syms.close(this.epfd);
      throw new Error(`exit-watcher-ffi: eventfd failed errno=${errno}`);
    }

    // Add the wakefd to epoll with a sentinel udata.
    this.writeEpollEvent(this.epollEventBuf, LX.EPOLLIN, LX.WAKE_UDATA);
    const r = this.syms.epoll_ctl(
      this.epfd,
      LX.EPOLL_CTL_ADD,
      this.wakefd,
      this.epollEventBuf,
    );
    if (r < 0) {
      const errno = readErrno(this.syms.__errno_location());
      this.syms.close(this.wakefd);
      this.syms.close(this.epfd);
      throw new Error(
        `exit-watcher-ffi: epoll_ctl(ADD wakefd) failed errno=${errno}`,
      );
    }
  }

  add(pid: number, udata: bigint): AddResult {
    this.assertOpen();
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new TypeError(`exit-watcher-ffi: invalid pid ${pid}`);
    }

    // pidfd_open(pid, 0) — returns a new pidfd, or -1 with errno set.
    const pidfdRaw = this.syms.syscall(this.pidfdSyscallNo, BigInt(pid), 0n);
    const pidfd = Number(pidfdRaw);
    if (pidfd < 0) {
      const errno = readErrno(this.syms.__errno_location());
      if (errno === ESRCH) {
        return { alreadyDead: true, reason: "esrch" };
      }
      throw new Error(
        `exit-watcher-ffi: pidfd_open(${pid}) failed errno=${errno}`,
      );
    }

    // Register with EPOLLIN | EPOLLONESHOT, using the pidfd itself as the
    // data.u64 (we look up the original pid + udata in `tracked` on delivery).
    this.writeEpollEvent(
      this.epollEventBuf,
      LX.EPOLLIN | LX.EPOLLONESHOT,
      BigInt(pidfd),
    );
    const r = this.syms.epoll_ctl(
      this.epfd,
      LX.EPOLL_CTL_ADD,
      pidfd,
      this.epollEventBuf,
    );
    if (r < 0) {
      const errno = readErrno(this.syms.__errno_location());
      this.syms.close(pidfd);
      throw new Error(
        `exit-watcher-ffi: epoll_ctl(ADD pidfd=${pidfd}) failed errno=${errno}`,
      );
    }

    this.tracked.set(pidfd, { pid, udata });

    // Post-register liveness probe — closes the gap between pidfd_open
    // succeeding and the process exiting before epoll arms.
    if (!pidAlive(pid)) {
      this.dropTracked(pidfd);
      return { alreadyDead: true, reason: "kill0" };
    }
    return { registered: true };
  }

  async wait(timeoutMs: number): Promise<WaitResult> {
    this.assertOpen();
    const deadline = performance.now() + Math.max(0, timeoutMs);
    const SLICE_MS = 25;

    while (true) {
      if (this.closed) {
        return { kind: "wakeup" };
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        return { kind: "timeout" };
      }
      const slice = Math.min(SLICE_MS, Math.ceil(remaining));
      const r = this.syms.epoll_wait(this.epfd, this.epollWaitBuf, 8, slice);

      if (r < 0) {
        const errno = readErrno(this.syms.__errno_location());
        if (errno === EINTR) {
          continue;
        }
        throw new Error(`exit-watcher-ffi: epoll_wait failed errno=${errno}`);
      }

      if (r === 0) {
        // setImmediate-style yield, see MacExitWatcher.wait() rationale.
        await new Promise<void>((res) => setImmediate(res));
        continue;
      }

      const dv = new DataView(this.epollWaitBuf);
      // We process events in order; if multiple arrived we'll drain on the
      // next wait() iteration (the caller emits one Killed per exit).
      for (let i = 0; i < r; i += 1) {
        const off = i * LX.EPOLL_EVENT_SIZE;
        const data = dv.getBigUint64(off + LX.EPOLL_EVENT_OFF_DATA, LE);
        if (data === LX.WAKE_UDATA) {
          // Drain the eventfd to clear its readable state.
          this.syms.read(this.wakefd, this.wakeReadBuf, 8);
          return { kind: "wakeup" };
        }
        const pidfd = Number(data);
        const entry = this.tracked.get(pidfd);
        if (entry) {
          this.dropTracked(pidfd);
          return { kind: "exit", pid: entry.pid, udata: entry.udata };
        }
        // Stale event for an fd we've already dropped — skip.
      }
      // All events were stale; loop and re-wait.
    }
  }

  wake(): void {
    if (this.closed) {
      return;
    }
    const dv = new DataView(this.wakeWriteBuf);
    dv.setBigUint64(0, 1n, LE);
    // write(2) on eventfd accepts an 8-byte counter increment.
    this.syms.write(this.wakefd, this.wakeWriteBuf, 8);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pidfd of this.tracked.keys()) {
      this.syms.close(pidfd);
    }
    this.tracked.clear();
    if (this.wakefd >= 0) {
      this.syms.close(this.wakefd);
      this.wakefd = -1;
    }
    if (this.epfd >= 0) {
      this.syms.close(this.epfd);
      this.epfd = -1;
    }
    this.lib.close();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("exit-watcher-ffi: ExitWatcher is closed");
    }
  }

  private dropTracked(pidfd: number): void {
    // EPOLL_CTL_DEL not strictly required when the fd is closed (kernel
    // removes it automatically), but explicit is clearer and matches the man
    // page's "should be done" wording.
    this.syms.epoll_ctl(this.epfd, LX.EPOLL_CTL_DEL, pidfd, null);
    this.syms.close(pidfd);
    this.tracked.delete(pidfd);
  }

  private writeEpollEvent(
    buf: ArrayBuffer,
    events: number,
    data: bigint,
  ): void {
    const dv = new DataView(buf);
    dv.setUint32(LX.EPOLL_EVENT_OFF_EVENTS, events, LE);
    dv.setBigUint64(LX.EPOLL_EVENT_OFF_DATA, data, LE);
  }
}

// Re-export a couple of unused-looking helpers so tests that exercise the FFI
// layer don't have to re-derive them.
export { CString as _ffiCString, read as _ffiRead };
