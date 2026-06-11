## Description

**Size:** M
**Files:** whatever the diagnosis implicates (usage-worker/reducer/daemon)

### Approach

The 2026-06-10 18:57:29 daemon restart was a CRASH: server.stderr shows repeated
`[keeperd] uncaught exception: 1988 | hookEvent = "UsageDeleted";` followed by
`panic: Segmentation fault at address 0x152348000`. Diagnose-first: find the
code at/near that line emitting or folding the `UsageDeleted` event kind (recent
usage-surface epics changed this area), determine why it throws uncaught (a
worker error path not routed to fatalExit? a throw inside a fold — forbidden —
or main-side mint?), and whether the segfault is a separate bun:sqlite fault
(the fn-746 class) or a consequence. Fix the exception properly (never-throw
fold rules / safe extractor), route any remaining uncaught path loudly, and pin
with a test folding a malformed/edge UsageDeleted. Check server.stderr history
for how often this crash has fired today (each crash = unpaused-boot dup window
until .2 lands).

### Investigation targets

**Required**: grep src/ for "UsageDeleted" (mint + fold sites); server.stderr
crash context; src/usage-worker.ts; the reducer's usage fold arm; CLAUDE.md
never-throw-in-fold invariant.

## Acceptance

- [ ] verdict in Evidence (throw site, why uncaught, segfault relation, crash frequency today)
- [ ] exception fixed per the never-throw rules + test; full bun test green

## Done summary
Verdict: the 2026-06-10 daemon crashes were NOT a forbidden throw-in-fold (the UsageDeleted fold retractUsageRow is already a safe idempotent never-throw DELETE). The throw was on the MAIN-SIDE MINT at daemon.ts: the usage worker's synchronous stmts.insertEvent.run threw SQLITE_BUSY (errno 5, 'database is locked') from inside uw.onmessage, which has no try/catch, so it bubbled to process.on('uncaughtException') -> fatalExit. The uncaughtException handler IS working as designed (loud + exit 1 + launchd relaunch); the bug was treating a TRANSIENT, recoverable writer-lock contention (the 5s busy_timeout exhausted while a multi-GB WAL checkpoint/compaction held the lock during cap saturation) as fatal. Frequency: 39 UsageDeleted uncaught-exception throws across >=3 distinct daemon builds/boots in the current server.stderr, each = one fatalExit = one restart into the unpaused-boot dup window. Segfault relation: SEPARATE and later — a bun:sqlite native panic (fn-746 class) preceded by SQLITE_CORRUPT in the autopilot worker; Bun's own message says 'a bug in Bun, not your code'. Independent symptom of the same degraded multi-GB-DB-under-contention condition, not caused by the UsageDeleted throw and out of scope. Fix: isTransientBusyError discriminates SQLITE_BUSY/LOCKED (code + errno fallback); mintUsageEventTolerant logs-and-drops a transient busy (recoverable via change-gated re-emit / boot-scan sweep) and gates the wake on success, while SQLITE_CORRUPT and all other faults still rethrow to fatalExit. Pinned by a discriminator test + a regression test driving a REAL insertEvent.run starved past its busy_timeout by a lock-holder subprocess, asserting the live bun error carries the code the drop path keys on. Full bun test:full green (2906 pass, 0 fail).
## Evidence
