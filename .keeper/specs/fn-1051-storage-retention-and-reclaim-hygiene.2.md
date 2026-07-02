## Description

**Size:** M
**Files:** src/daemon.ts, src/dead-letter.ts, test/daemon.test.ts, test/dead-letter.test.ts, README.md

### Approach

Add a dead-letter retention step to `runRetentionPass` (src/daemon.ts:5568-5651, main thread — the maintenance worker stays read-only): prune at FILE granularity with unlink-FIRST ordering, because `scanDeadLetterDir` (daemon.ts:1379) INSERT-OR-IGNOREs every surviving file's lines — a deleted row whose file survives resurrects as `waiting` and re-replays a duplicate event. The safe sequence per file: (1) prunability from a DB GROUP BY on `source_file` — every row referencing the file is `recovered` with `recovered_at` older than 7 days (unix SECONDS — recovered_at is Date.now()/1000; do not mix ms), and zero `waiting` rows reference it; (2) sealed check — the per-pid filename's pid is dead (pid probe is fine on main; it is a producer); (3) unlink the file (scoped STRICTLY to paths under KEEPER_DEAD_LETTER_DIR — db.ts:527-534); (4) DELETE its rows. A crash between (3) and (4) leaves orphaned recovered rows — harmless, replay's WHERE status='waiting' skips them; sweep them next pass. Never re-read file contents for prunability — the DB group-by plus seal check gives the guarantee without 50MB of I/O on the Nice=-5 main.

Poison rows: age-gate on `dl_written_at` (poison park leaves recovered_at NULL — daemon.ts:1821-1846), row-delete allowed (the events-log ingester's durable byte-offset prevents re-ingest), but their `source_file` points at EVENTS-LOG files the ingester solely owns — the dead-letter-dir path scope means the prune never unlinks them; assert that in a test. Recovered rows with `source_file IS NULL` age-prune directly (no file to resurrect them). Structure the step as an exported, in-process-testable pass body (the test/maintenance-worker.test.ts post-spy pattern), non-fatal on throw inside the existing retention try (daemon.ts:5624 contract), and count its deletions toward the sentinel/checkpoint gate (daemon.ts:5616,5640). The waiting-warn pill reads status='waiting' only — confirm no observability regression when recovered rows vanish. No schema bump; `idx_dead_letters_status_written_at` (db.ts:1078) serves the prune query.

Consolidate the recovered-row retention story into README's dead-letter and reclaim prose (~246-254, ~4249-4288).

### Investigation targets

**Required** (read before coding):
- src/daemon.ts:5568-5651 — runRetentionPass structure, the non-fatal try, sentinel/checkpoint gate
- src/daemon.ts:1379-1460,1821-1846,1956-2034 — scanDeadLetterDir idempotency, poison park (recovered_at NULL, source_file = events-log path), recoverOneDeadLetter stamps
- src/db.ts:527-534,1057-1079 — the dead-letter dir resolver and table schema + index
- src/dead-letter.ts — record schema (dep-free; a hook imports it — keep it dep-free)

**Optional** (reference as needed):
- test/maintenance-worker.test.ts — the exported-pass-body + post-spy test pattern
- src/backup.ts — the existing sidecar-file prune precedent (pruned field)

### Risks

- The resurrection hazard is the whole game: any path that deletes a row while its file can still be scanned re-replays events; the file-granularity coupling + unlink-first ordering must not be "optimized" away
- A torn trailing line means an N-line file yields fewer rows — prunability must NOT be a line-count equality check (the DB group-by formulation avoids this)

### Test notes

Sandbox KEEPER_DEAD_LETTER_DIR via sandboxEnv. Cover: fully-recovered aged sealed file → unlinked then rows deleted; one waiting row in file → file and rows untouched; live-pid file → skipped; poison rows aged on dl_written_at → rows deleted, events-log file untouched; source_file NULL recovered rows → age-pruned; crash simulation (unlink succeeded, delete skipped) → next pass sweeps orphan rows; throw inside step → non-fatal, checkpoint gate unaffected.

## Acceptance

- [ ] File-granularity coupled prune with unlink-first ordering; zero resurrection paths (tested)
- [ ] Poison rows age on dl_written_at and their files are never touched; waiting rows sacred
- [ ] Prunability is DB-derived (no file-content reads); step is an exported testable pass body, non-fatal on throw
- [ ] README dead-letter retention prose consolidated; full fast suite green

## Done summary

## Evidence
