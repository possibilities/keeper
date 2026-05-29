## Description

**Size:** M
**Files:** a new src/dead-letter-worker.ts, src/daemon.ts (boot scan + worker spawn/lifecycle + main-side import write), test/dead-letter-worker.test.ts or test/daemon.test.ts

Make dropped events VISIBLE: import the per-pid NDJSON files into the
`dead_letters` table as `waiting` rows, at boot and live, idempotently.
Import does NOT replay (no events written here).

### Approach

- Add a dead-letter watcher worker (src/dead-letter-worker.ts) following the
  keeper worker contract (isMainThread guard, own read-only openDb if it
  needs to read, typed `{kind}` worker→main / `{type}` main→worker protocol,
  supervisor-owned lifecycle, releases its `@parcel/watcher` subscription in
  its own shutdown handler). It watches `~/.local/state/keeper/dead-letters/`
  (a foreign-process-written tree — permitted by the CLAUDE.md
  @parcel/watcher carve-out, same as plan-worker/transcript-worker) and on
  any change posts `{kind:"dead-letter-changed"}` to main. Treat a watcher
  event (and an FSEvents drop-overrun) as "go scan", never as the data.
- MAIN owns the actual `dead_letters` write (main is the DB writer): on the
  worker message AND once at boot (slot the boot scan into the
  daemon.ts:146-154 sequence, after seedKilledSweep/drain), scan the dir:
  for each file, read + `parseDeadLetterLine` each line (skip nulls/partial
  tails), and `INSERT OR IGNORE INTO dead_letters (...) VALUES (...)` keyed
  on `dl_id` (idempotent re-scan). Record `source_file`. This write is a
  direct operational-table write, NOT an event fold — call it out.
- Spawn the worker in daemon.ts AFTER migrate + boot drain + seed sweep
  (same ordering rule as the other workers); wire `worker.onmessage`;
  terminate it in shutdown.

### Investigation targets

**Required:**
- src/plan-worker.ts / src/transcript-worker.ts — the @parcel/watcher worker pattern, FSEvents drop-overrun handling, debounced single-flight re-scan, shutdown-handler resource release.
- src/daemon.ts:120-260 — boot sequence (where the boot scan slots), the worker spawn/onmessage/shutdown pattern, `pumpWakes`.
- src/dead-letter.ts (from .1) — `parseDeadLetterLine`.
- CLAUDE.md "No kernel file watchers on keeper's own DB" — confirm the carve-out covers a hook-written external tree (it does; no new carve-out needed).

### Risks

- Import must be idempotent: `INSERT OR IGNORE` on `dl_id`; a re-scan of an unchanged file inserts nothing new.
- Never throw out of the scan (a malformed line skips; a re-scan throw is swallowed to stderr) — must not wedge boot or the live loop.
- The dead-letters dir may not exist yet on a fresh machine; the scan handles a missing dir gracefully (empty result, no throw). The worker must not crash if the dir is absent at spawn (create-or-tolerate).
- Worker = a 7th worker thread → README worker-count doc update (task .6).

### Test notes

- Drop a hand-written NDJSON file with N valid + 1 truncated line; assert N `waiting` rows imported, partial skipped, re-scan adds nothing.
- Boot scan picks up a pre-existing file before the server-worker serves.

## Acceptance

- [ ] Dropping/О modifying a dead-letter file results in `waiting` rows in `dead_letters` (live via watcher + at boot), idempotent on re-scan.
- [ ] Import never writes the events log and never throws out of the scan; a missing dir is tolerated.
- [ ] The worker follows the worker contract (guard, typed protocol, supervisor lifecycle, watcher released in shutdown).

## Done summary
Added the dead-letter watcher worker (src/dead-letter-worker.ts) + main-side scanDeadLetterDir importer wired into the daemon boot sequence (after seedKilledSweep) and the live worker-message path; INSERT OR IGNORE on dl_id keeps the table idempotent across re-scans. Missing dir is tolerated, partial-line / malformed JSON / oversized files skip-and-log without throwing. The worker follows the keeper contract (isMainThread guard, typed protocol, supervisor lifecycle, @parcel/watcher subscription released in shutdown).
## Evidence
