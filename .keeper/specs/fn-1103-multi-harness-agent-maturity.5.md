## Description

**Size:** M
**Files:** src/birth-ingest-worker.ts (new), src/daemon.ts, test/birth-ingest-worker.test.ts (new), test/daemon.test.ts

### Approach

The architectural twin of the events-ingest worker: a watcher worker subscribes
to the births tree with @parcel/watcher (missing-dir tolerance at spawn, the
disableNativeWatcher test seam — mandatory or the slow-test tier SIGTRAPs on NAPI
dlopen in a worker thread, RescanScheduler drop-recovery, no DB handle) and posts
a contentless go-look message; MAIN owns all writes. Because births are one-record
maildir files (not append logs), the scan is process-then-retire: parse each file
in new/, mint one synthetic SessionStart event (hook_event "SessionStart") carrying
every record field including harness and resume_target, and retire the file
(delete or move to done/) in the SAME BEGIN IMMEDIATE as the event insert —
exactly-once by construction; a duplicate is harmless anyway (the fold revives
idempotently). Malformed records poison-park to dead_letters, never wedge. Boot
scan on startup plus the watcher hint plus a fallback poll mirror the events-log
trio. GC bounds the tree: retire processed files; park stale unprocessed records
whose pid is provably dead. Worker registry is a five-site add (WorkerName,
ALL_WORKERS, WATCHER_WORKERS, spawn-site, shutdown post-list) — the 20th worker.
Downstream (exit-watcher killed-detection, tmux topology poller, renamer) inherits
with zero changes; verify exit-watcher registers the new rows through its normal
jobs-driven path.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/events-ingest-worker.ts — the whole twin (watcher lifecycle, disableNativeWatcher seam, missing-dir tolerance)
- src/daemon.ts:2476 — scanEventsLogDir (BEGIN IMMEDIATE discipline, poison-park); :2939/:2960/:2989 worker registry lists; :5325-5377 spawn site; :7700 shutdown post-list; :6775 fallback poll timer
- src/seed-sweep.ts:148 — insertKilledEvent synthetic-mint precedent; :239 boot_unwatchable reap (why a NULL-pid seed must never be minted)
- src/exit-watcher.ts — how new jobs rows get registered for death-watch
- test/events-ingest-worker.test.ts:245 — the re-fold parity assertion to mirror

**Optional** (reference as needed):
- src/rescan.ts — RescanScheduler / isDropError
- src/renamer-worker.ts:109-227 — the rename candidate filter the seeded rows must satisfy

### Risks

- fn-1098 (running epic) edits other regions of daemon.ts — land after it (epic dep), expect import-block rebase
- A record parsed before its rename completes would be partial — react to move-in events and parse defensively; skip-not-park on ENOENT races

### Test notes

Template on the events-ingest tests: exactly-once across restarts, torn/partial
parse parks, missing-dir tolerated, re-fold parity (producer-minted SessionStart
folds identically to a direct INSERT). End-to-end (slow tier or manual): detached
codex launch appears as a jobs row, window renamed, kill flips killed.

## Acceptance

- [ ] A detached launch of any harness yields a jobs row (correct harness, title from spawn_name, backend/pane coordinates) shortly after launch, with no reducer arm added
- [ ] Killing the harness process flips the row to killed via the existing exit-watcher/seed-sweep path; the tmux window is renamed from the title
- [ ] Each birth record is processed exactly once (event insert + file retirement atomic); malformed records park to dead letters without wedging the scan
- [ ] The daemon boots with the new worker in the production worker list and shuts it down cleanly; the births tree stays bounded

## Done summary

## Evidence
