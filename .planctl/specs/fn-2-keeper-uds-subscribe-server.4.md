## Description

**Size:** M
**Files:** src/daemon.ts, test/integration.test.ts

### Approach

Wire the completed server worker into the daemon supervisor and prove the whole pipeline end-to-end with a real spawned daemon + an in-test client (the only thing that connects to the socket — there is no shipped consumer).

1. **Spawn** the server worker in `daemon.ts` in the same post-migration window as the wake worker (after writer `openDb` + `migrate` + boot drain — the server's readonly `openDb` fails loud if the DB is missing), reusing the `workerData` cast idiom.
2. **Crash policy**: `serverWorker.onerror → fatalExit()` — the single recovery path, no in-process respawn (mirror the wake worker exactly).
3. **Two-worker shutdown**: extend `shutdown()` to post `{type:"shutdown"}` to **both** workers, await **both** `close` events against the existing `WORKER_SHUTDOWN_DEADLINE_MS` (2000 ms), then `terminate()` both, then `db.close()`, exit 0. Confirm the server worker's teardown (`listener.stop(true)` + unlink socket + lock) fits the deadline.
4. **E2E test** in `test/integration.test.ts`: spawn the real daemon (`bun run src/daemon.ts`) with `KEEPER_DB` **and** `KEEPER_SOCK` pointed at a tmpdir; fold a job (fire the hook / insert an event the way the existing integration test does); connect an in-test `Bun.connect({unix})` client that **de-frames NDJSON using `src/protocol.ts`**; send `query`, assert `result`; fold another change, assert a `patch` arrives (`retryUntil`); SIGTERM the daemon, assert the socket file is removed.
5. `afterEach`: SIGKILL any leaked daemon (`await daemon.exited`) and unlink the socket file, so a hung server can't leak across `--isolate` runs.

### Investigation targets

**Required** (read before coding):
- src/daemon.ts:122-159 — wake-worker spawn / `onmessage` / `onerror` wiring to mirror for the server worker
- src/daemon.ts:171-204 — `shutdown()` (currently single-worker; extend to await both workers) and the `WORKER_SHUTDOWN_DEADLINE_MS` constant
- src/daemon.ts:109-118 — `fatalExit` (wire the server worker's `onerror`)
- test/integration.test.ts:48-95 — spawned-daemon harness, `retryUntil(predicate, timeout, cadence)`, `afterEach` SIGKILL cleanup, 300 ms boot sleep, `KEEPER_DB` env pattern
- src/protocol.ts — the de-framer the in-test client must reuse

**Optional** (reference as needed):
- src/wake-worker.ts — confirm the message/exit contract the daemon awaits on shutdown

### Risks

- Spawn ordering: the server worker must start after `migrate`, or its readonly `openDb` fails loud.
- Shutdown deadline budget: the server's extra teardown (stop listener + 2 unlinks) must complete inside 2000 ms; bump the constant only if measured necessary.
- Test isolation: a test that sets `KEEPER_DB` but not `KEEPER_SOCK` binds the **real** socket and collides across isolates — set **both** to tmp paths.
- A leaked daemon or socket file across isolates → SIGKILL + unlink in `afterEach`.

### Test notes

- E2E lives in `test/integration.test.ts`. Use `retryUntil` for async `result`/`patch` arrival (no fixed sleeps). Assert the socket file is unlinked after SIGTERM. Keep within the existing 15000 ms test timeout.

## Acceptance

- [ ] Daemon spawns the server worker after migrate / boot-drain; `onerror → fatalExit` (no respawn)
- [ ] `shutdown()` posts `{type:"shutdown"}` to both workers, awaits both `close` events (2000 ms), terminates both, closes the db, exits 0
- [ ] E2E: real daemon + in-test `Bun.connect` client (de-framing via `src/protocol.ts`) → `query`→`result`, then a `patch` after a fold (`retryUntil`)
- [ ] SIGTERM removes the socket file; `afterEach` cleans up daemon + socket
- [ ] Full `bun test --isolate` suite + `bun run lint` + `bun run typecheck` pass

## Done summary

## Evidence
