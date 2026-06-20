## Description

**Size:** M
**Files:** src/dead-letter-worker.ts (template), a new events-log ingester worker, src/daemon.ts (boot scan + worker spawn + wake), src/db.ts (new ingest-offset table + SCHEMA_VERSION 60→61), keeper/api.py (SUPPORTED_SCHEMA_VERSIONS), src/dead-letter.ts (extend/mirror the serializer-parser for the events line shape), test/dead-letter-worker.test.ts (template), a new ingester test

### Approach

Add a daemon-side ingester that consumes per-pid NDJSON event files and
lands rows in the canonical `events` table; the existing fold is
untouched. Mirror `src/dead-letter-worker.ts`: a Worker watches the
per-pid events-log dir with `@parcel/watcher` (daemon-only dep, allowed
for external files), posts a contentless "go look" hint; MAIN scans each
per-pid file from its durable byte-offset, parses each complete line
crash-safely (mirror `parseDeadLetterLine` — null on partial/garbage),
and `INSERT INTO events` (assigning the integer id) WITH the per-pid
offset advance in ONE `BEGIN IMMEDIATE` (the sacred atomic-cursor
invariant, applied to NDJSON→events). Define the NDJSON line shape (the
`insertBindings` map stripped of `$`) and its parser here — this is the
contract task .2's writer targets. Store offsets in a NEW small table
keyed on per-pid file identity (inode + path); bump SCHEMA_VERSION 60→61
and add 61 to `SUPPORTED_SCHEMA_VERSIONS` in keeper/api.py in the same
commit. Boot ordering: the boot ingest scan MUST precede the boot
`drainToCompletion`, and the ingester Worker spawns AFTER boot ingest
(mirror the dead-letter sequence). The ingester INSERT must run on MAIN's
writer `db` (so `data_version` bumps and the existing pollers wake for
free). Per-pid file cleanup: delete a file only after its offset reaches
EOF and its pid is no longer live; do NOT carry over the dead-letter
16 MiB size cap (a long session legitimately exceeds it). This task lands
while the hook still does SQLite INSERT, so the ingester safely reads an
empty/absent dir (no-op).

### Investigation targets

**Required** (read before coding):
- src/dead-letter-worker.ts — the whole worker (watch → hint → MAIN scan); the architectural template
- src/daemon.ts ~:503-613 (scanDeadLetterDir), ~:1065-1075 (boot scan), ~:2196-2245 (worker spawn + message handler), wake/pumpWakes ~:1099-1162 — boot ordering + single-writer scan pattern
- src/dead-letter.ts — serializeDeadLetterRecord / parseDeadLetterLine (the crash-safe line contract to mirror)
- src/reducer.ts `drain()` ~:8134-8211 + `applyEvent()` — confirm the fold reads `events` unchanged; the cursor is reducer_state.last_event_id
- src/db.ts: CREATE_EVENTS ~:423-472 (events shape, id is the only key), SCHEMA_VERSION :61, openDb; the migrate ladder for adding the offset table
- keeper/api.py SUPPORTED_SCHEMA_VERSIONS ~:219 + test/schema-version.test.ts — the co-commit gate
- plugin/hooks/events-writer.ts insertBindings ~:747-789 — the canonical column→value map that defines the NDJSON line shape

### Detailed phases

1. Define the NDJSON event line shape + crash-safe parser (extend dead-letter.ts contract).
2. Add the ingest-offset table + SCHEMA_VERSION bump + SUPPORTED_SCHEMA_VERSIONS co-commit.
3. MAIN ingest routine: scan per-pid file from offset → parse → `INSERT INTO events` + offset advance in one `BEGIN IMMEDIATE`.
4. Ingester Worker (watch + hint) + boot scan ordering + wake wiring.
5. Per-pid file cleanup (offset-at-EOF + pid-dead).
6. Tests: double-ingest (no dup rows), torn-tail (no fold + re-read), re-fold parity (NDJSON-ingested == direct-INSERT byte-identical), empty/first-run dir tolerance.

### Risks

- **Idempotency is THE keystone.** Durable per-pid byte-offset committed atomically with the INSERT gives exactly-once and keeps the 1.6 GB `events` table schema untouched. Alternative if fragile: hook-stamped stable `event_id` + `INSERT OR IGNORE` (a new UNIQUE column on `events` — heavier). Prove the chosen mechanism with the double-ingest test (the early proof point).
- Inode reuse on APFS for recycled pids — key the offset on inode and `stat()`-check on restart (size < offset ⇒ fall to 0).
- `@parcel/watcher` drops events on macOS and the events dir churns far more than dead-letter — the offset-aware drop-recovery rescan MUST be correct, not just present (re-scan from durable offset, never byte 0).
- Poison line (INSERT throws, e.g. forward-compat column from a newer hook): define the policy — do not spin forever, do not silently advance past a real event.

### Test notes

Mirror test/dead-letter-worker.test.ts. Must add: double-ingest idempotency, torn-tail non-advance, re-fold byte-identical parity (incl SessionStart-scraped columns), empty-dir boot tolerance. Keep test/reducer.test.ts + integration re-fold determinism green unchanged.

## Acceptance

- [ ] Ingester Worker + MAIN scan land per-pid NDJSON lines as `events` rows; fold unchanged
- [ ] Offset advance + events INSERT are atomic in one `BEGIN IMMEDIATE`; double-ingest test yields no duplicate rows
- [ ] Torn final line not folded, re-read on next complete append
- [ ] SCHEMA_VERSION 60→61 + SUPPORTED_SCHEMA_VERSIONS co-commit; schema-version.test.ts green
- [ ] Boot ingest precedes boot drain; ingester reads an empty/absent dir as a no-op (hook still INSERTs at this stage)
- [ ] Re-fold parity test: NDJSON-ingested event folds byte-identically to a direct INSERT
- [ ] Per-pid file cleanup only after offset-at-EOF + pid dead; no 16 MiB cap

## Done summary
Added the daemon-side NDJSON->events ingester: scanEventsLogDir lands per-pid NDJSON lines as events rows with the offset advance committed atomically with the INSERT in one BEGIN IMMEDIATE (exactly-once), plus the events-ingest watch-hint Worker, boot-ingest-before-drain ordering, the event_ingest_offsets table (SCHEMA_VERSION 60->61 + SUPPORTED_SCHEMA_VERSIONS co-commit), and the EventLogRecord serializer/parser contract task .2 targets. The fold reads events unchanged; offset-at-EOF + pid-dead cleanup, no 16 MiB cap.
## Evidence
