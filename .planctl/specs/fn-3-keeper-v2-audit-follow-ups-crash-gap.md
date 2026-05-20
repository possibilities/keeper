## Context

Follow-up work from the `/plan:close` audit of `fn-2-keeper-uds-subscribe-server`. Two tier-1 findings survived the evidence pass:

1. **`worker-close-not-fatal`** — A worker crash via `process.exit(1)` fires `close`, not `onerror`. The daemon's `onerror` handlers don't fire, and the `close` listener (`exited()`) is only attached inside `shutdown()` — never in steady state. A crashing server-worker or wake-worker in production leaves a zombie daemon: reducer running, subscribe server gone, launchd never notified.

2. **`max-line-bytes-code-units`** — `MAX_LINE_BYTES` is named and documented as bytes, but all three cap checks in `protocol.ts` use `string.length` (UTF-16 code units). Error message says "bytes" but reports code-unit counts. A comment in `pendingBytes()` acknowledges the discrepancy but doesn't fix it. Misleads future maintainers about the actual memory bound.

## Goals

- Fix the crash gap: unexpected worker `close` in steady state must call `fatalExit()`, exactly as `onerror` does.
- Fix the line-cap naming: make the constant name, doc comments, and error message consistent — either rename to `MAX_LINE_LENGTH` (keep code-unit semantics) or switch measurement to `Buffer.byteLength`.

## Non-goals

- No other daemon or protocol changes.
- No new features.
- No changes outside `src/daemon.ts` and `src/protocol.ts`.

## Tasks

1. **Fix daemon crash gap** (`src/daemon.ts`): After each `onerror` registration, add an `addEventListener('close', ...)` that calls `fatalExit()` when `!shuttingDown`. Covers both `worker` and `serverWorker`.

2. **Fix line-cap semantics** (`src/protocol.ts`): Rename `MAX_LINE_BYTES` → `MAX_LINE_LENGTH`, update the doc comment and `OversizedLineError` message to say "characters" / "code units", and update `pendingBytes()` to `pendingLength()` or update its doc comment to drop the "bytes" claim. All three cap-check call sites update automatically via the rename.

## Invariants to preserve

- Both workers must still use `onerror` for uncaught exceptions (existing).
- The `close` listener must be registered unconditionally at worker-spawn time (not inside `shutdown()`), and must be a no-op when `shuttingDown` is true to avoid double-`fatalExit` on clean shutdown.
- All protocol tests must pass; no behavior change — only naming.
