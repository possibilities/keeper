## Description

**Size:** M
**Files:** src/daemon.ts, src/server-worker.ts, src/db.ts, test/helpers/sandbox-env.ts, test/single-instance-lock.test.ts, CLAUDE.md

### Approach

Make a second concurrent daemon impossible rather than detectable, per ADR 0030. Acquire a
kernel flock (LOCK_EX|LOCK_NB) on a NEW dedicated keeperd.lock at the very top of startDaemon()
— before openDb(), migrate(), or any worker spawn — by reusing src/usage-flock.ts FileLock
(tryAcquire null = live incumbent). Fail CLOSED on a live incumbent: exit 1 naming the holder
and the literal launchctl kickstart recovery line, before the boot ledger append so a refused
boot mints no entry. Fail OPEN (log loud, boot anyway) on an inconclusive primitive. The lock
fd is a module-scope singleton on main with FD_CLOEXEC set (usage-flock's setCloexec, honoring
its documented ordering hazard) — no worker or subprocess may inherit or close it. It must be a
separate file from keeperd.sock.lock (a Bun worker shares process.pid with main; reusing that
path would make the worker's own acquireLock self-conflict). Add
resolveSingleInstanceLockPath() in src/db.ts reading KEEPER_SINGLE_INSTANCE_LOCK (env-override-
then-state-dir pattern), add that class to sandboxEnv() IN THIS SAME COMMIT, and add a
disableSingleInstanceLock startDaemon opt (mirroring disableNativeWatcher) so in-process tests
never touch the host lock. Make stop()'s and startServer()'s socket/lock unlinks ownership-
checked so a dying stray never unlinks a live daemon's socket. Fix the stale server-worker
module doc that calls the pid-file lock "keeperd.lock", and add ONE terse CLAUDE.md guardrail
line for the gate.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/usage-flock.ts — FileLock.tryAcquire()/release(), setCloexec(), the two macOS-arm64 silent-failure hazards in the module doc
- src/daemon.ts:5706 — startDaemon(opts) top, where the gate lands before openDb/migrate; the boot ledger append (≈6890) it must precede
- src/server-worker.ts:943-976 — acquireLock (the TOCTOU pid-file that stays worker-scoped) and startServer's unconditional unlinkIfExists (≈3014) to ownership-check
- src/db.ts:4772 — resolveRestartLedgerPath, the resolver pattern to mirror
- test/helpers/sandbox-env.ts:50 — the state-paths-applied-LAST block gaining KEEPER_SINGLE_INSTANCE_LOCK
- test/usage-flock.test.ts — the FFI tripwire pattern the new lock test mirrors

### Risks

- An inherited lock fd in a spawned subprocess would pin the flock past daemon death and wedge every future boot — FD_CLOEXEC plus a census/tripwire test is the guard
- launchd bounce overlap: the new instance may race the old one's teardown; EWOULDBLOCK → exit 1 → launchd ThrottleInterval retry is the designed self-heal, and the refused boot must not advance the ledger
- A wedged-alive daemon holds the flock; the watchdog tasks landing first in this epic is the designed mitigation

### Test notes

Real-flock round-trip in a tmpdir (mirror usage-flock.test.ts): acquire, concurrent tryAcquire
null, release-on-close; sandboxEnv coverage asserts the class lands under tmpDir; the fail-open
branch is a pure-seam test on the errno classification.

## Acceptance

- [ ] With an incumbent holding the lock, a second startDaemon exits nonzero before opening the DB and prints the holder and recovery command; the refused boot appends no ledger entry
- [ ] The lock file is dedicated (distinct from the socket lock), env-overridable, sandboxed by the test helper in the same commit, and carries close-on-exec
- [ ] An inconclusive lock primitive logs loudly and boots anyway; a held lock never does
- [ ] Socket and lock unlinks are ownership-checked; a non-owner unlink path is proven inert by test
- [ ] In-process tests can disable the gate via the startDaemon opt and the fast suite stays green under parallel runners
- [ ] CLAUDE.md carries one gate guardrail line and the lint stays green

## Done summary

## Evidence
