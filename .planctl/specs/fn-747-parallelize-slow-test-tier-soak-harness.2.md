## Description

**Size:** M
**Files:** src/daemon.ts, src/plan-worker.ts, test/helpers/in-process-daemon.ts (new)

### Approach

The keystone. A full `runDaemon` boot spawns five worker threads that each
dlopen `@parcel/watcher`; two parallel test files = concurrent worker
dlopens = the SIGTRAP. So "gut em" needs TWO coupled moves:

1. **Export a programmatic start/stop.** `runDaemon()` (`src/daemon.ts:1246`)
   is unexported, arg-less, and its closure-scoped `shutdown()` ends in
   `process.exit(0)` (`:3475`). Refactor so the boot body is reachable as
   `startDaemon(opts?) → { stop(): Promise<void>, sockPath }`: same
   migrate → boot-drain → worker-spawn sequence, but returns a handle.
   `stop()` runs the existing teardown LOGIC — set the shutdown flag
   FIRST (the `!shuttingDown` guards at `:3309-3328` keep teardown noise
   from tripping `fatalExit`), post `{type:"shutdown"}`, race `close` vs
   `WORKER_SHUTDOWN_DEADLINE_MS`, terminate, `db.close()` — WITHOUT
   `process.exit`. Keep `if (import.meta.main) runDaemon()` and the
   production SIGTERM/SIGINT → exit-0 contract byte-identical (launchd
   `KeepAlive` restarts on non-zero).
2. **Add a `@parcel/watcher` seam.** `plan-worker.ts:3588` (and the four
   other watcher workers) hardcode `import("@parcel/watcher")` in worker
   threads. Mirror the injectable `prewarmWatcherAddon(loader?)` (`:1218`):
   give the in-process daemon a "no native worker dlopen" mode — a polling
   fallback or skip-live-subscribe + manual-rescan trigger — so the
   parallel tier never dlopens the addon in a worker thread. Prefer a real
   polling degrade path over a test-only env gate.
3. **Add `test/helpers/in-process-daemon.ts`** — a
   `withInProcessDaemon(env, fn)`-style harness: `sandboxEnv` the six
   paths, `startDaemon`, `waitForDaemon(sockPath)`, run the body, `stop()`
   + belt-and-suspenders socket/lock unlink. Mirror the in-process
   autopilot-worker spawn precedent at `daemon.test.ts:2189`.

### Investigation targets

**Required** (read before coding):
- src/daemon.ts:1246 — `runDaemon`; :3332/:3475 the `shutdown` closure + `process.exit(0)`; :3490 the `import.meta.main` guard; :3309-3328 the `!shuttingDown` guards
- src/daemon.ts:1218 — `prewarmWatcherAddon(loader?)`, the injectable-loader precedent for the seam
- src/plan-worker.ts:3588 — the worker's hardcoded `@parcel/watcher` import; :3015 the reflog watcher (same module)
- test/daemon.test.ts:2189 — existing in-process worker-spawn template (workerData + boot sleep + postMessage shutdown + race close)
- test/helpers/sandbox-env.ts, test/helpers/wait-for-daemon.ts — reuse verbatim

**Optional** (reference as needed):
- CLAUDE.md — "Worker contract", "No in-process self-heal", "Supervisor-owned lifecycle"

### Risks

- **The watcher seam is the crux.** If the addon dlopen can't be avoided in
  worker threads without breaking the plan-worker's live `.planctl` watch,
  in-process alone won't deliver parallel-safety. Mitigation: a polling
  fallback for `.planctl` is a real degrade path, not just test scaffolding
  (and arguably a resilience win if the addon ever fails to load).
- **Carving `startDaemon` must not regress the SIGTERM→exit-0 contract** or
  the import-safety guard. The 11-worker spawn + `!shuttingDown` teardown
  ordering is subtle; a stop path that terminates before setting the flag
  trips `fatalExit`.

### Test notes

- Prove it with one in-process daemon test: boot → UDS bind → fold one
  event → query it → `stop()` clean, with ZERO `@parcel/watcher` worker
  dlopens. Then a minimal 2-file parallel run to confirm no SIGTRAP. Full
  conversion + 20x soak is task `.1`.

## Acceptance

- [ ] `startDaemon(opts?)` (or equivalent) exported; returns a handle whose `stop()` tears down all workers + db WITHOUT `process.exit`; production `import.meta.main → runDaemon` boot and SIGTERM→exit-0 unchanged
- [ ] A `@parcel/watcher` "no native worker dlopen" seam exists; an in-process daemon runs the fold pipeline without a worker-thread addon dlopen
- [ ] `test/helpers/in-process-daemon.ts` exists, sandboxes all six `KEEPER_*` paths, binds + stops cleanly (socket/lock released)
- [ ] One in-process daemon test passes (boot → fold → query → clean stop) and a 2-file parallel run shows 0 addon SIGTRAPs
- [ ] `bun run test` umbrella green

## Done summary
Carved a programmatic startDaemon(opts) returning a {stop, sockPath} handle whose stop() tears down all workers + db without process.exit (runDaemon now wraps it, preserving the SIGTERM->exit-0 launchd contract), added a disableNativeWatcher seam so all six watcher workers skip their @parcel/watcher dlopen (plan-worker degrades to its data_version-poll/heartbeat fold path), and shipped test/helpers/in-process-daemon.ts + a keystone test proving boot->fold->UDS query->clean stop with zero worker-thread addon dlopens (180/180 on a 2-file parallel run, no SIGTRAP).
## Evidence
