## Overview

Under heavy load, a freshly-spawned keeperd worker thread's openDb on the
just-migrated DB intermittently fails — "SQLiteError: no such table:
events" thrown from prepareStmts, or a native SIGTRAP — killing the
process via fatalExit. In CI (which shares the box with live autopilot
workers) this redded builds 53/54/86 on 2026-06-10/11. Root contributors:
openDb prepares statements by default even on read-only connections that
use none (every worker destructures {db} only; main is the sole stmts
consumer), ~9 worker threads concurrently construct Database() on one
file (bun:sqlite has a known unfixed dlopen/dlsym lazy-load race, bun
#29277, and its native binding has raced on concurrent open before), and
the post-boot-drain checkpoint is PASSIVE so a worker's first open may
exercise the WAL/shm recovery path. End state: worker opens skip
statement preparation, retry the transient boot class boundedly inside
openDb, and first-open after boot sees an empty WAL.

## Quick commands

- `bun test test/db.test.ts test/daemon.test.ts` — targeted suites
- `bun run test:full` — MANDATORY gate (daemon/worker/db paths; fast tier does not cover them)
- Repro/validation loop: see task 3 (induced-load boot loop via the in-process harness)

## Acceptance

- [ ] All 12 worker openDb sites pass prepareStmts:false (events-ingest-worker excluded — it has no openDb); main keeps prepareStmts:true; noStmts() verified live
- [ ] openDb retries the transient boot class (fresh Database per attempt, sync backoff, bounded) and still fails loud after exhaustion — explicitly boot robustness, not self-heal
- [ ] Boot-drain finally checkpoint is TRUNCATE; steady-state checkpoints (daemon.ts reaper/maintenance, compaction.ts) remain PASSIVE
- [ ] N consecutive clean in-process daemon boots under induced CPU load (task 3 defines N) before close
- [ ] bun run test:full green

## Early proof point

Task that proves the approach: ordinal 1 (the retry knob + prepareStmts
sweep pass the existing daemon/worker suites). If it fails: fall back to
prepareStmts:false alone (removes the observed crash site) and defer the
retry knob.

## References

- Incident: buildbot builds 53/54 (bun test worker SIGTRAP), build 86 (wake worker "no such table: events" at db.ts:3286 prepareStmts ← openDb ← wake-worker.ts:117 → exit 1) — all under autopilot load; calm re-runs green
- bun #29277 lazyLoadSQLite dlopen/dlsym call_once race (macOS, fix PR open/unreleased as of 2026-06-11) + companion #29275 — the SIGTRAP family; keeper main opens its Database long before workers spawn, so the first-load variant may not be keeper's exact trigger — task 3's bun check is validation, not the fix
- SQLite isolation docs: schema visibility follows commits, not checkpoints — TRUNCATE is defense-in-depth (empty WAL at first open = no WAL-scan/shm-recovery path), not a spec-level visibility fix
- Worker audit (verified): wake :117, server :2664 + :2667 (writer-mode, RPC uses inline SQL), transcript :811, git :1685, plan :2639, usage :733, exit-watcher :215, builds :464, autopilot :1547, restore :645 — all destructure {db} only; events-ingest has NO openDb (featherlight by design)
- Wired overlap: fn-784 (in-progress) touches src/db.ts (v64→v65 migration) — epic dep added so this lands after

## Docs gaps

- **README.md:105-108**: rewrite the WAL checkpoint rationale — the "PASSIVE never TRUNCATE because a hook INSERT starves" justification is stale since fn-736 (the hook no longer writes the DB); explain boot-TRUNCATE safety + why steady-state stays PASSIVE
- **CLAUDE.md ## Worker contract**: two new single-line bullets matching the existing format — prepareStmts:false on connections that use no prepared statements; bounded initial-open retry for the transient boot class

## Best practices

- **Retry inside the open span, fresh handle per attempt** — a Database that survived a native race is suspect; re-construct, never reuse [github.com/oven-sh/bun/issues/29277]
- **TRUNCATE only when no other connection is attached** — it blocks until readers move off the WAL; boot (pre-spawn, main's writer only) is the one safe moment; PRAGMA returns a busy row rather than throwing, so worst case degrades to PASSIVE semantics after busy_timeout [sqlite.org/c3ref/wal_checkpoint_v2.html]
- **Transient-error classifiers are context-scoped** — "no such table" is retryable only at initial open on a known-migrated path; everywhere else it is fatal
- **Statement preparation at open is wasted cost on connections that never use statements** and creates a needless schema-dependence at the raciest moment of boot
