## Description

**Size:** S
**Files:** scripts/test-gate.ts (new), package.json

### Approach

Add `scripts/test-gate.ts`, a thin `#!/usr/bin/env bun` wrapper that
`test`/`test:full` route through. It (1) acquires a host-wide advisory
flock on a DEDICATED path `~/.local/state/keeper/test.lock` so concurrent
agent test runs serialize instead of oversubscribing cores, then (2)
spawns `bun test` forwarding ALL of the script's own args verbatim and
injecting `--parallel=${KEEPER_TEST_PARALLEL:-4}` if not already present.
Reuse `CommitWorkLock` from `src/commit-work/flock.ts` (already FD_CLOEXEC
+ death-release; the lock path is a caller arg). Use `tryAcquire()` first
and, on contention, print to STDERR what it is waiting on (holder pid if
discoverable), then block with a ~10-15 min timeout. Fail-open: on timeout
OR any lock error (mkdir of the parent dir, openSync, flock dlopen,
acquire) catch and run tests anyway — never wedge the agent. Release the
lock on EVERY exit path including SIGINT/SIGTERM. Forward the child's exit
code as the gate's own exit code, and `inherit` stdio so the live progress
autopilot agents watch survives. `KEEPER_TEST_NO_GATE` bypasses the lock
only (the cap + the package.json args still apply, so a bypassed run is
still a valid suite). The gate stays generic — it owns no ignore-list; each
package.json script passes its own `--path-ignore-patterns` through, so the
divergent `test` vs `test:full` lists never drift.

### Investigation targets

**Required** (read before coding):
- src/commit-work/flock.ts — `CommitWorkLock.acquire(lockPath)` / `tryAcquire()` / `release()`; FD_CLOEXEC + O_TRUNC-open semantics; reuse, do not reimplement
- package.json:13-14 — the `test` and `test:full` scripts; their two DIVERGENT inline `--path-ignore-patterns` lists must pass through verbatim
- plugins/keeper/plugin/hooks/docs-pusher.ts — the `.git/keeper-push.lock` `wx`/O_EXCL precedent for fail-open lock-and-log ethos

**Optional** (reference as needed):
- scripts/assert-comment-only.ts — `#!/usr/bin/env bun` script + package.json wiring pattern

### Risks

- A wedged gate holding `test.lock` blocks every later agent — the exact
  failure this epic prevents. Release on all paths; fail-open the acquire.
- `~/.local/state/keeper/` may not exist on a clean host — `mkdir -p` the
  lock's parent before `openSync`, inside the fail-open try.

### Test notes

Add a focused `test/test-gate.test.ts`: bypass env skips the lock; a held
lock makes a second invocation wait then proceed; the child exit code is
forwarded; fail-open runs tests when the lock path is unwritable. Keep it
in-process where possible (no real second `bun test`).

## Acceptance

- [ ] `scripts/test-gate.ts` exists; `test` + `test:full` route through it preserving each script's args/ignore-list verbatim
- [ ] Concurrent invocations serialize on `~/.local/state/keeper/test.lock`; the waiting one prints what it waits on to stderr
- [ ] `--parallel` defaults to `${KEEPER_TEST_PARALLEL:-4}`; child exit code is forwarded; stdio is inherited
- [ ] Fail-open verified: timeout and unwritable-lock-path both still run the suite; lock releases on success/timeout/SIGINT/SIGTERM
- [ ] `KEEPER_TEST_NO_GATE` bypasses the lock only

## Done summary
Added scripts/test-gate.ts, a fail-open host-wide flock + --parallel cap (KEEPER_TEST_PARALLEL, default 4) that test/test:full route through so concurrent agent runs serialize. KEEPER_TEST_NO_GATE bypasses the lock only; child exit code forwarded, stdio inherited, lock released on all exit paths.
## Evidence
