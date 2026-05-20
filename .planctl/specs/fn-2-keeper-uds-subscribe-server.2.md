## Description

**Size:** M
**Files:** src/server-worker.ts (new), test/server-worker.test.ts (new)

### Approach

The keystone: a **subsystem worker** that owns a UDS listener, per-connection state, lock-file ownership, and its own read-only DB connection — mirroring `wake-worker.ts`'s conventions but adding an external endpoint. This task ships the transport + lifecycle + dispatch shell **up to one-shot `query → result`**; the live poll/diff/patch loop is task `.3`.

1. **Module shape** mirrors `src/wake-worker.ts`: `isMainThread`-guarded body, `openDb(path, { readonly: true })` + the PRAGMAs applied (via `openDb`), typed message protocol (`{kind:...}` worker→main, handle `{type:"shutdown"}` main→worker), exit `0` clean / `1` crash, **no in-process self-heal**.
2. **Lock-file ownership** (acquire before binding): write `<state-dir>/keeperd.lock` containing the pid. On boot, if the lock exists and its pid is alive (`process.kill(pid, 0)` succeeds) → **refuse to start** (exit non-zero; launchd backs off). If the pid is dead (ESRCH) → stale: unlink the lock and the socket, then take ownership.
3. **Bind**: unlink any stale socket file, ensure the parent dir is `0700`, `Bun.listen({ unix: resolveSockPath(), socket: { open, close, data, error, drain } })`, then `chmod 0600` the socket (the `0700` dir is the real ACL gate on macOS; the socket mode is Linux defense-in-depth).
4. **Per-connection state on `socket.data`** (typed via the `Bun.listen<Data>` generic): inbound line-buffer remainder, watched-set (entity ids), `lastSent` map (`job_id → last_event_id`), and pending-write `{ slice, offset }`.
5. **Dispatch** parsed NDJSON lines: `query` → run `selectJobsByIds` shaped by `sort` (default `updated_at` desc) + `limit` + `offset` + optional `state` filter, reply `result`, and seed the connection's watched-set (+ `lastSent` from the same read); `unsubscribe` → clear watched-set. Unknown type / malformed JSON / oversized line → reply an `error` frame and **keep the connection open** (parse each line in its own try/catch).
6. **Backpressure**: `socket.write()` returns bytes accepted (may be `< length`, may be `0` — **not `-1`**); on a short write, stash the remaining slice + offset in `socket.data` and resume in `drain(socket)`.
7. **Shutdown** (`{type:"shutdown"}`): stop accepting, `listener.stop(true)`, unlink socket + lock, `closeDb`, exit 0 — release the socket **here**, because it's owned by the process and `worker.terminate()` from the daemon won't release it.

### Investigation targets

**Required** (read before coding):
- src/wake-worker.ts:1-160 — the worker archetype: `isMainThread` guard (154-156), own readonly connection, `{type:"shutdown"}` handling, exit 0/1, clean teardown
- src/db.ts:236-262 — `openDb(path,{readonly:true})` (fails loud if DB missing) + `applyPragmas` (153-159, `busy_timeout`)
- src/protocol.ts — frame types + `encodeFrame`/line-buffer from task `.1`
- node_modules/bun-types/bun.d.ts — `Bun.listen<Data>({unix})` → `UnixSocketListener.unix`; `SocketHandler` (`open/close/data/error/drain`); `socket.data`; `socket.write` byte-count return

**Optional** (reference as needed):
- src/daemon.ts:122-159 — the wake-worker spawn site (the `workerData` cast idiom the daemon will reuse for this worker in task `.4`)

### Risks

- AF_UNIX has no `SO_REUSEADDR`; a leftover socket file → `Bun.listen` `EADDRINUSE`. The lock must be acquired **before** the unlink-then-bind, or two instances race the path.
- The socket is bound to the **process**, not the Worker thread — the worker must `listener.stop(true)` + unlink in its own shutdown handler before the daemon terminates it, or the socket leaks into the next boot.
- `socket.write` returns a byte count, never `-1` — compare `wrote < payload.length`.
- Unbounded no-newline input is a DoS vector even on a local socket — enforce the 1 MB inbound cap from task `.1`.
- Parent dir `0700` is the real permission gate on macOS; `resolveDbPath`'s `mkdirSync` does not set mode — set it explicitly.

### Test notes

- `test/server-worker.test.ts` (new). Tmp socket path under the per-test `mkdtemp` dir so `--isolate` runs don't collide; set both `KEEPER_DB` and `KEEPER_SOCK` to tmp paths.
- Direct-call layer (no real Worker): dispatch `query` against a tmp DB → `result` with expected rows/order; malformed line → `error` (connection survives); oversized line → `error`; `unsubscribe` clears the watched-set.
- Lock-file: live-pid → refuse; dead-pid → steal (lock + socket unlinked).
- One real spawned-Worker test: `{type:"shutdown"}` → clean exit and the socket file is gone, racing a 2 s timeout (mirror `test/wake-worker.test.ts`).

## Acceptance

- [ ] `src/server-worker.ts` mirrors wake-worker conventions (`isMainThread` guard, own readonly `openDb` + PRAGMAs, exit 0/1, no self-heal)
- [ ] Lock-file ownership: live pid → refuse boot; dead pid → steal (unlink stale lock + socket)
- [ ] Binds the UDS at `resolveSockPath()` after unlinking a stale socket; parent dir `0700`, socket `0600`
- [ ] `query` → `result` snapshot (sort/limit/offset/optional state filter); `unsubscribe` clears watched-set; malformed/unknown/oversized → `error` frame with the connection staying open
- [ ] Backpressure handled via partial-write + `drain` (compares bytes written, not `=== -1`)
- [ ] `{type:"shutdown"}` → `listener.stop(true)` + unlink socket + unlink lock + `closeDb` + exit 0
- [ ] `bun test`, `bun run lint`, `bun run typecheck` pass

## Done summary

## Evidence
