## Description

**Size:** M
**Files:** src/daemon.ts, src/backstop-telemetry.ts, test/events-ingest-worker.test.ts, test/events-writer.test.ts, README.md

### Approach

Cluster B of the epic. B1 — poison parking in scanEventsLogDir (src/daemon.ts:797-1011):
inside the newline-terminated loop only (the trailing-remainder torn arm outside the
loop is UNTOUCHED), when parseEventLogLine returns null: first check blank
(trimmed-empty lineBytes, checked INLINE in the loop — parseEventLogLine's signature
is frozen, the hook imports src/dead-letter.ts) → advance past it silently. Otherwise
POISON: build a dead_letters row with status='poison' (replay's WHERE
status='waiting' skips it structurally), deterministic
dl_id = `poison:<basename>:<inode>:<startOffset>` (inode is already in hand — the
offsets table keys on (path, inode)), session_id parsed best-effort from the per-pid
filename else 'poison', hook_event='PoisonLine', ts = scan wall-clock seconds
(dead_letters is an operational sidecar, never folded — no determinism requirement),
bindings = JSON.stringify({raw: <line capped 64KiB>, file, start_offset, end_offset})
— every value constructible from data in hand, so the INSERT can never fail on a
well-formed schema. INSERT with ON CONFLICT(dl_id) DO NOTHING in the SAME
BEGIN IMMEDIATE as the events INSERTs + offset advance (exactly-once with the
cursor; idempotent on any re-scan path). The loop CONTINUES past a poison line —
one scan drains a multi-poison file and ingests the valid lines after it. Transient
DB failures keep today's behavior: the transaction throw rolls back everything
including the offset (block + retry, never advance). After COMMIT, emit one backstop
record per poison line: extend the closed BackstopName union
(src/backstop-telemetry.ts:48-54 — "extend, don't rename"; NOTE the file contains a
literal NUL byte, use Read not grep) with an events-ingest poison name; mirror the
pending-dispatch-sweep emit pattern (daemon.ts:3464-3491; counters + log path are in
scope in main()) with detail {file, start_offset, dl_id}. Counters/NDJSON never
rate-limited; only the stderr ALARM is. scanEventsLogDir grows the dead-letter/
backstop context — thread it as one optional context arg (or deps object) across the
three call sites (:1503 boot, :3079 FSEvents, :3525 post-message) + test imports.

B2 — replay columns: repoint recoverOneDeadLetter (:1187) from stale EVENTS_COLUMNS
(:1045-1075, 29-col fn-643 list) to INGEST_EVENTS_COLUMNS (:703-737, live 33-col);
grep for remaining EVENTS_COLUMNS consumers and delete the constant if orphaned. Add
the missing lockstep axis copying test/events-writer.test.ts:1430's shape: open a
migrated DB, PRAGMA table_info('events') minus id, set-equality against
INGEST_EVENTS_COLUMNS. Also verify replay of a status='poison' row is impossible by
construction (status filter) and the replay-by-id RPC path rejects one cleanly if
reachable.

README: new numbered poison-line failure-mode item (~408-425, bold-scenario-label
style) + replay prose (~192-208) noting INGEST_EVENTS_COLUMNS binding.

### Investigation targets

**Required** (read before coding):
- src/daemon.ts:890-1011 — the scan loop, torn flag, BEGIN IMMEDIATE commit shape (:925-955)
- src/dead-letter.ts:288-327 — parseEventLogLine's five null causes (blank, syntax, non-object, bad bindings, nested values)
- src/db.ts:1152-1164 — dead_letters schema (NOT NULL columns the synthetics must satisfy)
- src/daemon.ts:574-667 — scanDeadLetterDir + dead_letters INSERT model; :1120-1218 recoverOneDeadLetter + replay selection (:1133 WHERE status='waiting')
- src/backstop-telemetry.ts:48-54, 241-264, 366-376 — union, record builders, append (Read, not grep)
- test/events-ingest-worker.test.ts:116-330 — harness + the torn-tail test (:200) to sibling

### Risks

- A poison row INSERT that can throw (bad synthetic) rolls back the offset advance
  and wedges the file WORSE than today — the synthetics above are all constructible
  from in-hand data; keep it that way.
- Dead-lettering the trailing torn remainder would drop a mid-write event — the
  poison arm must be unreachable outside the newline loop.
- dead_letters is NOT a reducer projection — nothing here may touch the fold path.

### Test notes

Siblings of the :200 torn test: (a) poison mid-file → offset advances past it,
following valid line ingests in the SAME scan, dead_letters row with status='poison'
+ expected dl_id, backstop NDJSON record present; (b) blank line → advances, NO
dead-letter; (c) trailing no-newline garbage → offset stays (unchanged today);
(d) re-scan after a simulated crash-before-commit → no duplicate poison row
(ON CONFLICT), offset correct; (e) replay skips poison rows; (f) the new lockstep
test fails if a column is added to events without INGEST_EVENTS_COLUMNS.

## Acceptance

- [ ] seeded poison line: parked (status='poison', deterministic dl_id), offset advanced, later lines ingest same-scan, backstop record emitted post-COMMIT
- [ ] blank lines advance silently; torn tails still block; transient DB failure still rolls back offset
- [ ] replay binds INGEST_EVENTS_COLUMNS; EVENTS_COLUMNS deleted if orphaned; lockstep test pins INGEST_EVENTS_COLUMNS to live schema
- [ ] README failure-mode + replay prose updated; full bun test green

## Done summary
Events-log ingester now parks unparseable poison lines as dead_letters (status='poison', deterministic dl_id, ON CONFLICT DO NOTHING) in the same transaction as the events INSERTs + offset advance, then advances past them — draining multi-poison files while torn tails still block; emits an events-ingest-poison backstop per parked line. Dead-letter replay (recoverOneDeadLetter) repointed from the stale 29-col EVENTS_COLUMNS (deleted) to the live 33-col INGEST_EVENTS_COLUMNS, with a lockstep test pinning that list to the live events schema.
## Evidence
