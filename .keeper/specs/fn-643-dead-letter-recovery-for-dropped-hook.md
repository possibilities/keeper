## Overview

The keeper hook silently loses an `events` row whenever its INSERT fails
(transient `SQLITE_BUSY`, or a schema-transition window during a daemon
deploy) — per the "always exit 0, losing one event row is acceptable"
contract. Because the reducer creates a `jobs` row ONLY on the SessionStart
fold, a dropped SessionStart makes an entire live session invisible on the
board for its whole lifetime (every later event from it folds into nothing).
This happened to `work::fn-604-sunset-jobctl-control-plug-and-autopilot.1`
and was repaired by hand by appending synthetic events.

This epic makes that failure mode visible and recoverable instead of silent,
WITHOUT a fail-closed hook contract (keeper stays a pure observer; it must
never wedge the human's session). Three moves: (1) the hook gains a bounded
retry + writes a per-pid NDJSON dead-letter file on final INSERT failure;
(2) the daemon imports those files into a NEW `dead_letters` OPERATIONAL
sidecar table (visibility only — NOT folded from events) and, on a deliberate
one-at-a-time human action, replays the oldest waiting record back into the
event log; (3) the board shows a persistent warn-count and a keypress that
replays one. End state: a dropped hook event surfaces as a yellow
`dead-letter` count on the board and the human recovers it one keypress at a
time; the recovered session reappears with its worker.

The two-step split (import-for-visibility vs replay-for-recovery) is
deliberate: a boot-time auto-replay would clear the backlog before the
server-worker the board connects to is even up, so the "waiting" state would
never be observable. Import makes it visible and persistent; replay is the
separate, deliberate recovery.

## Quick commands

- `bun test` — full suite (events-writer, daemon/integration, collections, board, readiness-client, rpc-handlers, server-worker)
- `sqlite3 ~/.local/state/keeper/keeper.db "SELECT status, count(*) FROM dead_letters GROUP BY status;"` — inspect the operational table
- `ls ~/.local/state/keeper/dead-letters/` — per-pid NDJSON dead-letter files
- `bun scripts/board.ts` — board shows the `dead-letter` warn count; press the replay key to recover one

## Acceptance

- [ ] A forced hook INSERT failure leaves a per-pid NDJSON dead-letter file (one self-describing record with a `dl_id`, all derived insert bindings, and the SessionStart-scraped spawn_name/start_time/config_dir), and the hook still exits 0.
- [ ] The daemon imports dead-letter files into the `dead_letters` table idempotently (re-scan never duplicates a `dl_id`), at boot and live via a watcher.
- [ ] The board renders a persistent warn/yellow count of `waiting` dead letters and a keypress replays exactly ONE (oldest), routed board→socket→server-worker RPC→main; the recovered session reappears and the count drops.
- [ ] Replay appends a plain real event (full bindings, real pid, preserved ts) and flips the row to `recovered` in ONE transaction; a from-scratch re-fold is byte-identical and never touches `dead_letters`.
- [ ] CLAUDE.md + README updated for the new table, collection, RPC, schema v36, and the revised "main is sole synthetic-event writer" / "approval is the only RPC-writable thing" invariants.

## Early proof point

Task that proves the approach: `.1` (the `dead_letters` table + NDJSON record
schema module + collection) plus `.3` (import). Once those land you can drop a
hand-written NDJSON file into the dead-letters dir and watch a `waiting` row
appear over the subscribe socket — proving the visibility half before the
higher-risk replay bridge (`.4`) is built. If the watcher proves unworkable,
fall back to a boot-scan + low-frequency main timer (the import logic is
identical; only the trigger changes).

## References

- Incident: `work::fn-604-sunset-jobctl-control-plug-and-autopilot.1` (session be979fc3) — dropped SessionStart + UserPromptSubmit, repaired by hand-appending synthetic events.
- SEQUENCING: `SCHEMA_VERSION` is 35 in the working tree (in-flight `fn-642`, colocate-rate-limit-into-usage, uncommitted `M src/db.ts`). This epic targets **v36** and adds its migration slot AFTER fn-642's v35. Coordinate if fn-642 has not landed when work starts — do not clobber its slot.
- practice-scout: macOS `PIPE_BUF` = 512 B (not 4 KB) → per-pid sharding mandatory; `busy_timeout` already waits internally; retry only `SQLITE_BUSY`/`SQLITE_LOCKED` (check `.code` AND `.message`), `SQLITE_BUSY_SNAPSHOT` non-retriable (IMMEDIATE avoids it); `Atomics.wait` for sync sleep; events fold by id ASC so a replayed event gets a NEW higher id; don't fsync in hook; chmod 0600 (raw payload carries prompt text/paths).
