## Overview

Keeper's `events-writer.ts` hook fires on all 10 hook event types, twice
per tool call, and is now the single biggest per-hook-call cost across the
system (~22.5ms warm). It opens SQLite and INSERTs on every invocation —
importing the 6,493-line `src/db.ts` just for `openDb`/`resolveDbPath`
(~11ms parse), then opening a connection + pragmas + `BEGIN IMMEDIATE` +
insert (~7.5ms), and serializing under WAL (60→343ms at 1→16 concurrent
writers). Make the hook lock-free and cheap: the hook **appends a per-pid
NDJSON line** (mirroring the existing `deadLetter()` per-pid pattern) and
exits — dropping the `db.ts`/`bun:sqlite` import entirely. A **new daemon
ingester Worker** (mirroring `src/dead-letter-worker.ts`) tails the per-pid
files and MAIN inserts the rows into the `events` table; the existing
`drain()`/`applyEvent()` fold runs **unchanged**. The `events` table stays
the canonical fold source, so re-fold determinism is preserved by
construction. Projected: ~22.5ms → ~6–10ms/call and the concurrency cliff
goes flat. Scope is the lock-free rework only; the column-level
event-surface trim is a separate follow-up (orthogonal to perf,
silent-re-fold-breakage risk).

## Architecture

Ingest path changes; fold path does not.

- **Before:** hook → `openDb` → `INSERT INTO events` (WAL, serialized) → fold reads `events`.
- **After:** hook → `appendFileSync(<pid>.ndjson)` (no SQLite) → daemon ingester Worker watch-hint → MAIN reads each per-pid file from its durable byte-offset → `INSERT INTO events` (+ offset advance) in ONE `BEGIN IMMEDIATE` → existing fold reads `events` unchanged.
- **Two distinct cursors:** the NEW ingest offset (NDJSON→events, per-pid file) and the UNCHANGED `reducer_state.last_event_id` (events→projections). Keep them conceptually separate.
- **Wake signal:** `wake-worker.ts` polls `PRAGMA data_version` to detect new events — NDJSON appends won't trip that. The ingester's own `events` INSERT (on MAIN's writer conn) DOES bump `data_version`, restoring the downstream pollers' wake for free; the only new trigger needed is the ingester-worker's file-watch hint (mirror dead-letter-worker).

## Quick commands

- `echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}' | plugin/hooks/events-writer.ts && ls ~/.local/state/keeper/<events-log-dir>/` — hook appends an NDJSON line, no DB touched
- `bun test test/events-writer.test.ts test/dead-letter-worker.test.ts test/reducer.test.ts` — writer + ingester + re-fold determinism
- re-run the perf harness from `~/docs/hook-perf-baseline.md` against the reworked hook — confirm ~6–10ms/call and flat contention
- re-fold determinism check: rewind `reducer_state.last_event_id` to 0, DELETE projections, replay, assert byte-identical rows

## Acceptance

- [ ] Hook no longer imports `src/db.ts`/`bun:sqlite`; it appends a per-pid NDJSON line and exits 0; perf harness confirms ~6–10ms/call (down from ~22.5ms) and the concurrency cliff flattens
- [ ] New daemon ingester Worker tails per-pid NDJSON files and MAIN inserts `events` rows; existing `drain()`/`applyEvent()` fold is unchanged
- [ ] Exactly-once ingest: durable per-pid byte-offset committed atomically with the `events` INSERT in one `BEGIN IMMEDIATE`; a double-ingest test (re-run ingester over the same file) yields no duplicate rows
- [ ] Torn final line is not folded and is re-read on a later complete append (offset not advanced past partial bytes)
- [ ] Re-fold determinism intact: an event ingested via NDJSON folds byte-identically to one inserted directly (all columns incl SessionStart-scraped fields)
- [ ] SCHEMA_VERSION bumped for the ingest-offset table, with the new int added to `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the same commit (schema-version.test.ts green)
- [ ] `KEEPER_EVENTS_LOG` (or chosen name) added to `test/helpers/sandbox-env.ts` so tests don't pollute `~/.local/state/keeper/`
- [ ] Docs updated (CLAUDE.md hook/sole-writer rules, README architecture + install step 4, hooks.json description)

## Early proof point

Task `.1` proves the idempotency mechanism: durable per-pid byte-offset
committed atomically with the `events` INSERT, validated by a double-ingest
test (watcher re-fire / daemon restart yields no duplicate rows) and a
re-fold-parity test. If atomic-offset proves too fragile: recovery is a
hook-stamped stable `event_id` + `INSERT OR IGNORE` (a new unique column on
the `events` table — heavier, but idempotent by construction).

## References

- Perf profile + harness: `~/docs/hook-perf-baseline.md` (events-writer ~22.5ms: ~11ms db.ts parse + ~7.5ms SQLite + 3.3ms bun; 60→343ms contention cliff)
- Architectural template: `src/dead-letter-worker.ts` (keeperd's 7th Worker — per-pid NDJSON dir watch → contentless hint → MAIN scan+write, single-writer preserved; missing-dir tolerance; RescanScheduler drop-recovery)
- Lean serializer/parser contract to mirror/extend: `src/dead-letter.ts` (`serializeDeadLetterRecord`, `parseDeadLetterLine` returns null on partial/garbage — crash-safe tail); dep-free by invariant because the hook imports it
- Fold (unchanged) + cursor: `src/reducer.ts` `drain()` ~:8134-8211, `applyEvent()` cursor in one `BEGIN IMMEDIATE`
- Boot/scan/worker-spawn template: `src/daemon.ts` `scanDeadLetterDir` ~:503-613, boot scan ~:1065-1075, worker spawn/handler ~:2196-2245
- APFS O_APPEND atomicity ~256-byte non-interleave limit → per-pid files (one writer/file) sidestep it; single `write()` per complete line; skip fsync on the buffer (SQLite WAL is the durability boundary); 0600 perms (dead-letter already does)

## Docs gaps

- **keeper/CLAUDE.md**: lede ("Hook plugin writes one events row"→NDJSON append), hook rules ~:41-53 (failed-INSERT→dead-letter inverts; drop migrate/column-intersection + bun:sqlite-import rules), sole-writer rules ~:83-85 (hook→NDJSON feed; daemon→SQLite events table)
- **keeper/README.md**: "What keeper is" ~:5-7, Architecture ~:1025-1038 (data_version/WAL prose → new ingest path), install step 4 ~:351-410 (daemon-boot-first gate, PRAGMA probe, INSERT failure-mode bullets → NDJSON)
- **keeper/hooks/hooks.json**: top-level `description` ("one row per hook invocation into keeper.db" → NDJSON append)

## Best practices

- **Per-pid NDJSON files, not a shared log:** APFS O_APPEND only guarantees non-interleave below ~256 bytes; event lines exceed that. One writer per file removes interleaving and rotation races. [practice-scout]
- **Atomic offset advance:** commit the per-pid byte-offset in the same transaction as the `events` INSERT; never line-count; on restart `stat()` — size < offset ⇒ truncated, fall to 0. [practice-scout]
- **Strict torn-tail:** bytes after the last `\n` are uncommitted — don't advance; never throw inside a fold (malformed `data` folds safe, cursor still advances). [keeper CLAUDE.md + practice-scout]
- **No fsync on the ingest buffer; 0600 perms; single write() per line.** [practice-scout]
- **Deploy-skew is lag-not-loss:** new-hook/old-daemon backs up NDJSON, drained at next daemon boot; old-hook/new-daemon INSERTs directly + ingester finds empty dir. Ship the ingester first (task .1), flip the hook second (task .2). [gap-analyst]

## Rollout

Build-forward, no shadow phase (safe because `events` stays canonical +
durable atomic offset gives exactly-once). Sequence: ship task `.1`
(ingester) first — with the hook still doing SQLite INSERT, the ingester
reads an empty/absent dir (no-op). Then ship task `.2` (flip the hook to
NDJSON, remove the SQLite path). The non-atomic boxctl deploy makes both
skew windows real but both are lag-not-loss. Rollback: revert task `.2`
(hook resumes direct INSERT); the ingester from `.1` idles harmlessly.

## Snippet context

No snippets: searched the conversation-surfaced snippets and `find-snippets
"event sourcing ndjson sqlite reducer append-only log"` — the substrate is
arthack-scoped (process/tooling snippets) and none intersects keeper's
event-sourcing/NDJSON-ingest internals; this is a keeper-board epic.
