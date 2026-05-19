## Description

**Size:** M
**Files:** src/daemon.ts

### Approach

Main entry point. Sequence:

1. **Boot**: `openDb(KEEPER_DB)` writer connection. DDL + migrations run inside `openDb`. Set process title `keeperd` for `ps` clarity.
2. **Boot drain**: loop `while (drain(db, 200) > 0) {}` — fold all existing events; this is the *same code path* as steady-state drain. After downtime, this catches up the projection before going live.
3. **Spawn wake worker**: `new Worker("./wake-worker.ts", { type: "module", data: { dbPath } })`. Register `worker.onmessage` to push a signal into an async queue / `Promise.resolve` chain.
4. **Main loop**: `for await (const _ of wakeQueue) { while (drain(db, 200) > 0) {} }` — each wake triggers a full drain. If a wake arrives mid-drain, it coalesces into the next drain pass (no missed events; we always re-read from cursor).
5. **Signal handling**: `process.on("SIGTERM", async () => { … })` — post `{ type: "shutdown" }` to worker, `await worker.terminate()` (with a short deadline), `db.close()`, `process.exit(0)`.
6. **Crash policy**: per locked decision, ANY unrecoverable error (worker `error` event, unhandled rejection, fold throw outside the per-event catch) → `process.exit(1)`. LaunchAgent `KeepAlive.SuccessfulExit = false` restarts the daemon. One well-tested recovery path, not two.

### Investigation targets

**Required** (read before coding):
- Brief's boot flow spec (step 1-5 in the sketch ride-along)
- `src/reducer.ts` (task 4) — `drain` contract
- `src/wake-worker.ts` (task 5) — Worker message contract

**Optional** (reference as needed):
- `/Users/mike/code/arthack/apps/jobctl/jobctl/run_run_server.py` — for what NOT to import (UDS server, in-memory Store, RPC verbs, snapshot pump — all out of v1 scope)

### Risks

- **Boot drain MUST complete before spawning the wake worker.** Otherwise the worker fires `{ kind: "wake" }` events while boot drain is still iterating on the writer connection — harmless (drain is idempotent) but wasteful.
- **Wakes during in-flight drain**: solve via a signal queue / dedupe pattern (e.g. a single boolean "wake pending" flag, reset before each drain pass, set on every wake message). Don't trigger drain re-entrantly inside `drain()`.
- **`process.exit(0)` is dangerous under `KeepAlive.SuccessfulExit = false`** — clean exit means launchd will NOT restart. Reserve exit(0) for the SIGTERM-handled shutdown path only.
- **Worker `error` event** is not the same as a message — register `worker.onerror` separately and treat it as crash → exit(1).

### Test notes

- End-to-end smoke covered in task 7.
- A small "boot drain over pre-seeded events" test can run the daemon's drain loop directly against a tmp DB without the worker — verifies the catch-up path independent of the wake mechanism.

## Acceptance

- [ ] Daemon boots, runs boot drain to completion before spawning worker
- [ ] Each worker wake triggers a full `drain()` loop; wakes during in-flight drain coalesce (no events missed, no re-entrant drain)
- [ ] SIGTERM cleanly shuts down worker, closes db, exits 0
- [ ] Worker crash or unhandled error → exit 1 (so launchd restarts)
- [ ] Boot drain handles a pre-seeded `events` table (catch-up after downtime)

## Done summary

## Evidence
