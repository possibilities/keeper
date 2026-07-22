## Description

**Size:** M
**Files:** src/flock-outcome.ts, src/file-lock.ts, src/usage-flock.ts, src/commit-work/flock.ts, test/flock-outcome.test.ts, test/usage-flock.test.ts, test/commit-work-foundation.test.ts

### Approach

Introduce one DB-free root classification seam that owns the native return/error interpretation and resource cleanup contract. It returns a tagged Acquired, Contended, or Inconclusive outcome; only exact `rc === 0` may construct a held handle, `EAGAIN`/`EWOULDBLOCK` positively identifies contention, and every missing, unreadable, stale, malformed, or unexpected diagnostic remains Inconclusive. Keep wrapper-level compatibility only long enough for dependent tasks to migrate callers, and use the commit-work atomic close-on-exec descriptor pattern as the canonical lifecycle.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/commit-work/flock.ts:53` — platform error constants and atomic close-on-exec open flags.
- `src/commit-work/flock.ts:169` — blocking, nonblocking, and deadline acquisition ownership behavior.
- `src/file-lock.ts:42` — general lock FFI binding and nullable/throw contract.
- `src/usage-flock.ts:1` — duplicate general implementation with a separate import population.
- `plugins/plan/src/flock.ts:160` — existing return-authoritative package-local precedent; copy semantics, not package coupling.

**Optional** (reference as needed):
- `test/usage-flock.test.ts:34` — real same-process descriptor contention coverage.
- `test/commit-work-foundation.test.ts:1410` — close-on-exec and deadline tests that exposed errno loss.

### Risks

Bun's errno accessor is itself an FFI call and may throw, return an unusable pointer, or observe the wrong thread-local value. Descriptor and library cleanup must remain exact on every diagnostic failure, and the canonical seam must not introduce a package or DB dependency into cold-start callers.

### Test notes

Inject exact syscall returns and diagnostic behaviors: success with stale errno, `-1` with both contention symbols, `-1` with zero/unexpected errno, positive nonzero ABI-looking results, accessor/read failure, interruption, and close/setup failure. Keep separate real-lock round trips proving a held descriptor prevents a second acquisition and release permits the next one; assert non-acquisition rather than a fragile errno value.

### Detailed phases

1. Define the tagged outcome and injectable low-level call/diagnostic seam.
2. Consolidate root FFI classification and atomic descriptor ownership behind that seam while preserving temporary adapters for downstream migration.
3. Add deterministic matrix and focused real-descriptor tests, including exact cleanup assertions.

### Alternatives

A native wrapper returning `{rc, errno}` atomically is the fallback if Bun cannot safely expose the required native state. Do not choose boolean/null classification or treat all failures as contention merely to keep CI green.

### Non-functional targets

The adapter remains synchronous, DB-free, allocation-light on the success path, and bounded on every nonblocking attempt. It must never busy-spin, leak a descriptor/native library, unlink a lock file, or permit child inheritance.

### Rollout

Land with transitional wrapper APIs so dependent caller migrations can compile against the new outcome without creating a main-branch window that bypasses locking.

## Acceptance

- [ ] Exact syscall success is the only path that returns a held lock, regardless of the current errno value.
- [ ] Failed calls with positive contention evidence return Contended; failed calls with absent, zero, unreadable, or unexpected diagnostics return Inconclusive without throwing a secondary diagnostic error.
- [ ] Every non-acquired path closes its invocation-owned descriptor and native handle exactly once, while Acquired retains the exact descriptor until idempotent release.
- [ ] General and commit-work root adapters consume the same tagged classification contract and establish close-on-exec atomically.
- [ ] Deterministic tests cover the complete return/error matrix and real descriptor tests prove mutual exclusion and reacquisition.

## Done summary

## Evidence
