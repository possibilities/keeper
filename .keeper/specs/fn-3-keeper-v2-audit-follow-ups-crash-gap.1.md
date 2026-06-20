## Description

Audit finding `worker-close-not-fatal` (tier-1, source epic `fn-2-keeper-uds-subscribe-server`).

A worker calling `process.exit(1)` fires the `close` event, not `onerror`. In `daemon.ts`, `onerror` handlers are registered for both `worker` (line 129) and `serverWorker` (line 148), but they only fire for uncaught exceptions that bubble through the JS machinery — not for `process.exit` calls inside the worker thread. The `close` listener (`exited()`) is only attached inside `shutdown()` (line 191), so a worker crash in steady state goes unhandled: the reducer keeps running, the subscribe server silently vanishes, and launchd is never notified to restart.

Fix: immediately after each `onerror` registration, add an `addEventListener('close', ...)` that calls `fatalExit()` when `!shuttingDown`. The `shuttingDown` guard prevents a double `fatalExit` on clean shutdown.

```ts
worker.addEventListener("close", () => {
  if (!shuttingDown) fatalExit();
});
serverWorker.addEventListener("close", () => {
  if (!shuttingDown) fatalExit();
});
```

Only `src/daemon.ts` changes. The new listeners are registered at worker-spawn time (not inside `shutdown()`).

## Acceptance

- `src/daemon.ts` has `addEventListener('close', ...)` for both `worker` and `serverWorker`, registered immediately after their respective `onerror` handlers, guarded by `!shuttingDown`.
- `bun test` passes.
- SIGTERM / clean-shutdown path still exits 0 (because `shuttingDown = true` is set before `close` fires in the clean path).

## Done summary
Added !shuttingDown-guarded close listeners for both wake and server workers at spawn time in src/daemon.ts, so a steady-state worker process.exit(1) (which fires close, not onerror) now triggers fatalExit and launchd restart.
## Evidence
