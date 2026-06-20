## Description

**Size:** M
**Files:** test/integration.test.ts, test/daemon.test.ts, test/server-worker.test.ts

### Approach

Make integration + daemon 100% stable. (1) Bump per-test timeouts to 30s on the daemon-spawning tests. (2) Classify every fixed `Bun.sleep` — replace daemon-BOOT waits (integration.test.ts:289 `sleep(300)`, :326 `sleep(200)`, and peers) with a readiness probe (socket-exists + `Bun.connect` on the UDS, or `retryUntil` from task 2's helper); but PRESERVE deliberate pacing sleeps (post-COMMIT, the WAL-FIFO bounce-window mitigation per CLAUDE.md — integration.test.ts:299 is explicitly commented "just pacing"). Read each sleep's surrounding comment before touching it. (3) Keep the existing process-group SIGKILL + socket/lock unlink afterEach (integration.test.ts:98/:112/:114-144) — ensure it runs even on assertion failure (try/finally). (4) Fix the server-worker "Cannot use a closed database" leak: the one spawned Worker (:1321, shutdown :1342) — an async kick/diffTick can fire after the test's `db.close()`. Order teardown so the worker is shut down (await its close) BEFORE the DB closes; this is a real ordering bug, not a timeout. If, after readiness probes + serial execution + 30s timeouts, the daemon still loses events under load, that is a genuine WAL-contention race to SURFACE (not paper over).

### Investigation targets

**Required** (read before coding):
- test/integration.test.ts:153 (retryUntil), :189, :289, :326, :1000, :1034, :1096 (sleeps to classify), :98, :112, :114-144 (afterEach reap)
- test/daemon.test.ts — its own retryUntil idiom and boot sleeps (:577/:651/:715/:1856/:1888/:1895-99)
- test/server-worker.test.ts:1321 (spawned Worker), :1342 (shutdown postMessage), :774 (multi-connection reader)
- CLAUDE.md drain notes — the bounce-window / WAL FIFO unfairness rationale for pacing sleeps

### Risks

- **Replacing a pacing sleep re-opens the bounce-window race** the sleep was added to fix. Classify boot-readiness vs pacing before touching each.
- **The flake may be a real bug:** if de-flaking doesn't stabilize it, surface the daemon WAL-contention race rather than hide it behind a bigger timeout.

### Test notes

`bun run test:slow` 5× consecutive, 0 flakes. Confirm server-worker no longer throws "Cannot use a closed database" under repeated runs.

## Acceptance

- [ ] integration + daemon per-test timeouts at 30s; boot waits use readiness probes; pacing sleeps preserved (each classified)
- [ ] afterEach process-group reap + socket/lock unlink runs even on failure (try/finally)
- [ ] server-worker closed-db leak fixed by worker-shutdown-before-db-close ordering
- [ ] `bun run test:slow` 0 flakes over 5 consecutive runs

## Done summary
De-flaked the slow tier to 5/5 consecutive clean runs (157 tests, 0 fail). Replaced daemon-boot sleeps with a waitForDaemon socket-readiness probe; routed all daemon spawns through sandboxEnv (the missing dead-letter-dir override was boot-importing the real backlog → 45MB tmp DB that never bound); excluded boot synthetics by event_type tag so the new AutopilotCapSet row stops inflating the events count; 30s per-test timeouts; afterEach reap in try/finally. Fixed two genuine shutdown races surfaced by the de-flake: daemon now !shuttingDown-guards the global error handlers (terminated-worker postMessage no longer clobbers exit(0)), and server-worker awaits the poll loop draining before db.close() (the closed-db leak). Also corrected a stale fn-724 SCHEMA_VERSION pin (59→60).
## Evidence
