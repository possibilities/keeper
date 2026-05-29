## Description

**Size:** M
**Files:** plugin/hooks/events-writer.ts, src/db.ts (a hook-local busy_timeout helper if needed), test/events-writer.test.ts

Make the hook resilient: bounded retry on transient INSERT contention, and
on final failure write the fully-resolved bindings to a per-pid NDJSON
dead-letter file — without ever breaking the exit-0 contract or adding deps.

### Approach

- Wrap the `stmts.insertEvent.run(...)` transaction (events-writer.ts:458-493)
  in a bounded retry: on `SQLITE_BUSY`/`SQLITE_LOCKED` (check BOTH `.code`
  === "SQLITE_BUSY"/"SQLITE_LOCKED" AND `.message` includes "database is
  locked"), sleep ~25-50ms via `Atomics.wait(new Int32Array(new
  SharedArrayBuffer(4)),0,0,ms)` (setTimeout needs an event loop the hook
  won't run) and retry ONCE. `SQLITE_BUSY_SNAPSHOT` and all other errors are
  non-retriable → straight to dead-letter.
- Keep the hook's wall-clock inside the SessionEnd 1.5s budget: set a
  hook-LOCAL `busy_timeout` (e.g. ~1000-1200ms) on the hook's connection
  only — do NOT lower the shared `applyPragmas` 5s the daemon + workers
  depend on.
- On FINAL failure (post-binding INSERT still failing, or a non-retriable
  error after bindings were resolved): build a `DeadLetterRecord` (from
  src/dead-letter.ts) carrying a fresh `crypto.randomUUID()` `dl_id`,
  `dl_written_at`, and ALL the resolved insert bindings (the 27 named
  `$`-bindings incl. the SessionStart-scraped spawn_name/start_time/
  config_dir, which are NOT in stdin and unrecoverable later), and append
  one NDJSON line to `~/.local/state/keeper/dead-letters/<pid>.ndjson`.
  Best-effort `mkdir -p` the dir first; chmod the file 0o600 (raw payload
  carries prompt text/paths); per-pid file because macOS PIPE_BUF is 512 B
  and full rows interleave on a shared append.
- Pre-binding failures stay UNCHANGED: a stdin `JSON.parse` throw or empty
  `hook_event_name` has nothing resolved to dead-letter — stderr-log + skip,
  as today. The dead-letter append itself is wrapped so its own failure
  (disk full, unwritable dir) is swallowed to stderr — exit 0 always holds.
- Use `node:fs` appendFileSync (already within the allowed graph) or
  `Bun.write({append})`; no new third-party import.

### Investigation targets

**Required:**
- plugin/hooks/events-writer.ts:451-514 — the openDb(migrate:false) + `db.transaction(insertEvent)` + the outer `import.meta.main` catch that guarantees exit 0; the 26-binding object at 463-492.
- plugin/hooks/events-writer.ts:428-443 — spawnInfo/configDir SessionStart-only scraped fields (must be captured into the record).
- src/dead-letter.ts (from .1) — the record schema + serialize.
- test/events-writer.test.ts:~256 — the shadow-`ps`-via-PATH force-failure harness; mirror it to force an INSERT failure (e.g. point at a stale-schema/locked DB) and assert a dead-letter file appears + exit 0.

### Risks

- The `ps` probe already spends up to 500ms on SessionStart; the retry budget is tightest there. Keep retry to ONE attempt + a short sleep.
- Same-pid concurrent hooks (e.g. a late PostToolUse overlapping SessionEnd) would both append to `<pid>.ndjson`; confirm one pid never has two in-flight hooks, else a >512B interleave can tear a line (parse-null on import handles a torn line safely, but note it).
- Must not regress the exit-0 contract: every new path (retry, sleep, mkdir, append, chmod) lives inside the existing try/catch.

### Test notes

- Force a failing INSERT against a tmpdir DB; assert: exit code 0, a `<pid>.ndjson` exists, its single line round-trips through `parseDeadLetterLine`, and the bindings include spawn_name/start_time/config_dir for a SessionStart.
- Assert a transient-then-success path (retry succeeds) writes the row and NO dead-letter file.

## Acceptance

- [ ] A forced post-binding INSERT failure produces a per-pid NDJSON dead-letter file with a valid record (dl_id + full bindings + scraped fields) and the hook exits 0.
- [ ] Retry fires only on SQLITE_BUSY/SQLITE_LOCKED (one attempt); other errors dead-letter immediately; pre-binding failures still stderr-skip.
- [ ] The hook's busy_timeout change is hook-local; applyPragmas (daemon/workers) stays 5s; no new third-party import in the hook.
- [ ] Dead-letter dir is created 0o700-ish best-effort and the file is 0o600.

## Done summary
Hook gains a bounded one-attempt retry on SQLITE_BUSY/SQLITE_LOCKED (~30ms Atomics.wait sleep) and a per-pid NDJSON dead-letter under ~/.local/state/keeper/dead-letters/<pid>.ndjson on final failure — preserving the exit-0 contract while making dropped INSERTs recoverable. Hook-local PRAGMA busy_timeout=1200 keeps the retry budget inside the SessionEnd 1.5s window; the shared 5s applyPragmas the daemon/workers depend on is unchanged.
## Evidence
