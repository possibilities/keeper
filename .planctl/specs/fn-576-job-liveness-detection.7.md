## Description

**Size:** M
**Files:** src/exit-watcher-ffi.ts (new), test/exit-watcher-ffi.test.ts (new)

### Approach

First use of `bun:ffi` in this repo. Build a self-contained module exposing a small platform-conditional API that the worker task (task 8) will import.

**macOS path:**
- `dlopen` libSystem / libc
- `kqueue()` → kq fd
- `kevent()` registration with `EVFILT_PROC | EV_ADD | EV_ONESHOT | NOTE_EXIT`; `ident=pid`; `udata=` opaque correlation token (e.g. row id encoded as i64)
- `EVFILT_USER` registered at startup with `NOTE_TRIGGER` for shutdown wakeup
- `struct kevent` layout (32 bytes on 64-bit): ident:u64, filter:i16, flags:u16, fflags:u32, data:i64, udata:u64

**Linux path:**
- `dlopen` libc.so.6
- `pidfd_open(pid, 0)` → pidfd
- `eventfd(0, EFD_NONBLOCK)` for shutdown wakeup
- `epoll_create1(0)` + `epoll_ctl(EPOLL_CTL_ADD, pidfd, EPOLLIN)` + `epoll_wait`
- Minimum kernel: 5.3 (pidfd_open); document this requirement; fail loudly at dlopen-time if missing

**Common API:**

```
class ExitWatcher {
  constructor()
  add(pid: number, udata: bigint): { registered: true } | { alreadyDead: true }
  wait(timeoutMs: number): { kind: "exit"; pid: number; udata: bigint } | { kind: "timeout" } | { kind: "wakeup" }
  wake(): void
  close(): void
}
```

The `add()` method MUST do the post-register liveness probe (`kill(pid, 0)`) per practice-scout — if the pid died between event arrival and register, return `{ alreadyDead: true }` so the caller can emit Killed immediately. On macOS, also handle ESRCH/ENOENT from the EV_ADD itself the same way.

Struct layout validation: a single test asserts `sizeof` and `offsetof` for `struct kevent` against expected values (32 / 0, 8, 10, 12, 16, 24) — fails loudly if the kernel ABI ever drifts. Same pattern for any Linux structs you define.

### Investigation targets

**Required** (read before coding):
- Bun:ffi docs — https://bun.com/docs/runtime/ffi (esp. JSCallback threadsafe, struct layout via CDataType)
- Apple EV_SET(2) / kevent(2) man pages
- man7 pidfd_open(2)
- Chromium `base/process/kill_mac.cc` — canonical EV_ADD+ESRCH race handler
- Dropbear 2025 epoll-on-pidfd walkthrough — https://dropbear.xyz/2025/06/22/epoll-on-pidfd/

**Optional**:
- corsix.org: "What is a pidfd anyway?"
- systemd `sd_pidfd_get_inode_id(3)` — modern reference for stable process identity

### Risks

First use of bun:ffi in repo. Unknowns: `dlopen` cross-platform reliability, JSCallback threading model, struct layout drift between kernel headers, Worker `terminate()` behavior with held kqueue/pidfd fds. If a fundamental blocker surfaces (e.g. kqueue `ident:u64` vs `uintptr_t` mismatch on 32-bit, or JSCallback unsafe from native threads), this task either degrades to a documented polling fallback or escalates back to the epic level for redesign. The standalone scope means the worst case is "this task fails" not "epic blocked late."

Do NOT use packed structs in CDataType (struct kevent is naturally aligned). Do NOT call JSCallback from arbitrary native threads even with `threadsafe: true`; keep the kevent/epoll loop INSIDE the worker thread (the caller will block on `wait()`).

### Test notes

Per-platform tests (defer-skip on the opposite platform):
1. sizeof/offsetof assertions for all FFI structs
2. register-and-wait on a `Bun.spawn` child that exits after ~100ms
3. race-closer: spawn-and-immediately-kill, then register — sees `alreadyDead`
4. `wake()` interrupts a blocked `wait()` within 50ms
5. `close()` releases the fd cleanly (no FD leak — verify via `/proc/self/fd` count on Linux; via `lsof -p $$` on macOS)

## Acceptance

- [ ] Module `src/exit-watcher-ffi.ts` exports `ExitWatcher` with the API above
- [ ] macOS path uses kqueue / EVFILT_PROC / NOTE_EXIT / EV_ONESHOT + EVFILT_USER wakeup
- [ ] Linux path uses pidfd_open + epoll + eventfd wakeup (kernel ≥5.3, fail loudly at dlopen on older kernels)
- [ ] Post-register liveness probe inside `add()` returns `alreadyDead` on ESRCH race
- [ ] Struct layout sizeof/offsetof assertions in tests
- [ ] All listed per-platform tests pass; deferred-skip on opposite platform

## Done summary

## Evidence
