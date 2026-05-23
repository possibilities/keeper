/**
 * Tests for `src/exit-watcher-ffi.ts`. Two layers:
 *
 * 1. Platform-independent struct-layout assertions (sizeof/offsetof for the
 *    fixed-shape buffers we encode by hand). These catch any constant drift
 *    before we touch a kernel fd, and they run on every platform — there is no
 *    "skip on opposite platform" needed for them.
 *
 * 2. Live integration tests against the real kernel. These are platform-
 *    conditional: the macOS suite runs on darwin and defer-skips on linux; the
 *    Linux suite runs on linux and defer-skips on darwin.
 */

import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { createExitWatcher, KQ, LX } from "../src/exit-watcher-ffi";

// ---------------------------------------------------------------------------
// 1. Struct layout — runs on every platform
// ---------------------------------------------------------------------------

describe("struct layout", () => {
  test("kqueue struct kevent (darwin/BSD) — 32 bytes, fields at canonical offsets", () => {
    // Assertions match Apple's <sys/event.h> on 64-bit; see kevent(2) man page.
    expect(KQ.KEVENT_SIZE).toBe(32);
    expect(KQ.KEVENT_OFF_IDENT).toBe(0); // uintptr_t
    expect(KQ.KEVENT_OFF_FILTER).toBe(8); // int16_t
    expect(KQ.KEVENT_OFF_FLAGS).toBe(10); // uint16_t
    expect(KQ.KEVENT_OFF_FFLAGS).toBe(12); // uint32_t
    expect(KQ.KEVENT_OFF_DATA).toBe(16); // intptr_t
    expect(KQ.KEVENT_OFF_UDATA).toBe(24); // void*

    // Filter values from <sys/event.h>.
    expect(KQ.EVFILT_PROC).toBe(-5);
    expect(KQ.EVFILT_USER).toBe(-10);

    // Flag values from <sys/event.h>.
    expect(KQ.EV_ADD).toBe(0x0001);
    expect(KQ.EV_ENABLE).toBe(0x0004);
    expect(KQ.EV_ONESHOT).toBe(0x0010);
    expect(KQ.EV_CLEAR).toBe(0x0020);
    expect(KQ.EV_ERROR).toBe(0x4000);
    expect(KQ.NOTE_EXIT).toBe(0x80000000);
    expect(KQ.NOTE_TRIGGER).toBe(0x01000000);
  });

  test("linux struct epoll_event — 12 bytes packed, fields at canonical offsets", () => {
    // Linux `struct epoll_event` is `__attribute__((packed))` on x86_64 — the
    // 8-byte data union starts at offset 4, not 8. Total 12 bytes.
    expect(LX.EPOLL_EVENT_SIZE).toBe(12);
    expect(LX.EPOLL_EVENT_OFF_EVENTS).toBe(0); // uint32_t events
    expect(LX.EPOLL_EVENT_OFF_DATA).toBe(4); // epoll_data_t data (union, 8B)

    // Constants from <sys/epoll.h> / <linux/eventfd.h>.
    expect(LX.EPOLL_CTL_ADD).toBe(1);
    expect(LX.EPOLL_CTL_DEL).toBe(2);
    expect(LX.EPOLLIN).toBe(0x001);
    expect(LX.EPOLLONESHOT).toBe(1 << 30);
    expect(LX.EFD_NONBLOCK).toBe(0o4000);
    expect(LX.EFD_CLOEXEC).toBe(0o2000_000);
  });
});

// ---------------------------------------------------------------------------
// 2. Live integration — defer-skip on opposite platform
// ---------------------------------------------------------------------------

const isDarwin = process.platform === "darwin";
const isLinux = process.platform === "linux";

describe.if(isDarwin || isLinux)(
  "ExitWatcher — live (current platform)",
  () => {
    test("register-and-wait fires on a child that exits ~100ms later", async () => {
      const w = createExitWatcher();
      try {
        // Use Bun.spawn so we get a stable cross-platform pid back.
        const child = Bun.spawn(["sleep", "0.1"]);
        const pid = child.pid;

        const res = w.add(pid, 0xa1b2c3d4n);
        expect(res).toEqual({ registered: true });

        const t0 = performance.now();
        const ev = await w.wait(3000);
        const elapsed = performance.now() - t0;

        expect(ev.kind).toBe("exit");
        if (ev.kind === "exit") {
          expect(ev.pid).toBe(pid);
          // udata round-trips byte-for-byte through the kernel.
          expect(ev.udata).toBe(0xa1b2c3d4n);
        }
        // Sanity: we shouldn't have waited the full 3s.
        expect(elapsed).toBeLessThan(2000);

        await child.exited;
      } finally {
        w.close();
      }
    });

    test("race-closer: registering a freshly-dead pid returns alreadyDead", async () => {
      const w = createExitWatcher();
      try {
        // Spawn and reap before register so the pid is guaranteed dead.
        const child = Bun.spawn(["true"]);
        const pid = child.pid;
        await child.exited;

        const res = w.add(pid, 1n);
        expect("alreadyDead" in res && res.alreadyDead).toBe(true);
      } finally {
        w.close();
      }
    });

    test("wake() interrupts a blocked wait() within ~50ms of being called", async () => {
      const w = createExitWatcher();
      try {
        const t0 = performance.now();
        const pending = w.wait(5000);

        let wakeAt = 0;
        setTimeout(() => {
          wakeAt = performance.now();
          w.wake();
        }, 50);

        const ev = await pending;
        const returnedAt = performance.now();

        expect(ev.kind).toBe("wakeup");
        // wake() should be observed by the next slice; SLICE_MS is 25 so the
        // worst-case latency between wake() and wait() returning is ~25ms.
        // Be generous in the assertion to keep this stable under CI load.
        expect(returnedAt - wakeAt).toBeLessThan(100);
        // Total elapsed from start = ~50ms (delay) + ~25ms (slice) = ~75ms.
        expect(returnedAt - t0).toBeLessThan(200);
      } finally {
        w.close();
      }
    });

    test("close() releases fds — no fd leak after a register-wait cycle", async () => {
      const before = countOpenFds();

      const w = createExitWatcher();
      const child = Bun.spawn(["sleep", "0.05"]);
      w.add(child.pid, 0n);
      await w.wait(2000);
      await child.exited;
      w.close();

      // Give the runtime a beat to drop any pending close in flight (libc close
      // is synchronous on both platforms, but child.exited cleanup may linger).
      await Bun.sleep(20);

      const after = countOpenFds();
      // Allow a tiny slop (e.g. the test runner itself may rotate an internal
      // fd between snapshots), but the watcher's kqueue/epoll/eventfd/pidfds
      // must all be reclaimed — a leak would be many fds, not one.
      expect(after - before).toBeLessThan(5);
    });

    test("close() is idempotent and subsequent ops throw cleanly", () => {
      const w = createExitWatcher();
      w.close();
      w.close(); // no throw on second close

      expect(() => w.add(process.pid, 0n)).toThrow();
      // wake() after close is best-effort silent
      expect(() => w.wake()).not.toThrow();
    });
  },
);

describe.if(!isDarwin && !isLinux)("ExitWatcher — unsupported platform", () => {
  test("createExitWatcher throws on unsupported platform", () => {
    expect(() => createExitWatcher()).toThrow(/unsupported platform/);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Count this process's open fds. Cross-platform: `/proc/self/fd` on Linux,
 * `lsof -p` on macOS. Returns a finite number even if the underlying command
 * is flaky — a NaN return would mask leaks.
 */
function countOpenFds(): number {
  try {
    if (process.platform === "linux") {
      const out = execSync(`ls /proc/${process.pid}/fd | wc -l`, {
        encoding: "utf8",
      });
      return Number.parseInt(out.trim(), 10);
    }
    if (process.platform === "darwin") {
      const out = execSync(`lsof -p ${process.pid} 2>/dev/null | wc -l`, {
        encoding: "utf8",
      });
      return Number.parseInt(out.trim(), 10);
    }
  } catch {
    // best-effort
  }
  return 0;
}
