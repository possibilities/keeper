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
// 2. Platform guard — createExitWatcher throws on an unsupported platform
// ---------------------------------------------------------------------------

const isDarwin = process.platform === "darwin";
const isLinux = process.platform === "linux";

describe.if(!isDarwin && !isLinux)("ExitWatcher — unsupported platform", () => {
  test("createExitWatcher throws on unsupported platform", () => {
    expect(() => createExitWatcher()).toThrow(/unsupported platform/);
  });
});
