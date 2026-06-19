## Description

**Size:** M
**Files:** src/db.ts (v74 tail), src/reducer.ts (drain), src/subagent-invocations.ts, cli/search-history.ts, src/backup.ts, README.md, CLAUDE.md, tests

The destructive, irreversible step. Restore the keep-set inline, DROP `event_blobs`,
reclaim disk, and deploy a COALESCE-free binary. Gated on .3 complete AND the .1 harness
green over the full live corpus. Daemon stopped for the physical reclaim.

### Approach

Logical drop (sole-migrator, in `migrate()` at the v74 TAIL): restore every keep-set
(allow-list) relocated blob back to `events.data` inline (idempotent
`UPDATE ... SET data=(SELECT data FROM event_blobs ...) WHERE data IS NULL AND <keep-predicate>`),
then `DROP TABLE event_blobs` + `idx_event_blobs_tool_attr`. The DROP is the LAST v74
action so a 0→v74 from-scratch walk still runs the historical v57 create + v67 read
against a live table — NEVER remove or modify the v56/v57/v66/v67 ladder steps. Drop the
now-dead COALESCE arms: drain SELECT (reducer.ts:7533), subagent-invocations
(:258/:368 — PreToolUse:Agent is keep-set/inline now), and cli/search-history.ts
(:115/119 — remove the LEFT JOIN to the dropped table or it errors `no such table`).
Physical reclaim (offline, backup.ts pattern): `PRAGMA wal_checkpoint(FULL)` →
`VACUUM INTO` a new file with `auto_vacuum=INCREMENTAL` baked in (set the pragma on the
VACUUM-INTO connection before issuing it — mode can't change on an existing DB) →
`PRAGMA quick_check` on the OUTPUT file as the go/no-go gate → chmod to match source perms
→ atomic `mv` (same filesystem) → delete stale -wal/-shm. Update README event_blobs
read-contract paragraph (~2601-2623), restore-snapshot note (~2762), canonical-fold-source
qualifier (~1264), and the CLAUDE.md re-fold-determinism wording — forward-facing (state
current behavior; the byte-identity guarantee now scopes to projection columns, with
NULLed/absent payload bodies intentionally non-reconstructable and forensics deferring
to transcript_path). Keep the pre-shed VACUUM-INTO snapshot until the restarted new
binary verifies.

### Investigation targets

**Required** (read before coding):
- src/db.ts:3421-3441 (v67 backfill — DO NOT touch; it must keep reading event_blobs during a ladder walk), :3211-3214 (v57 create — keep), :857/:873 (event_blobs + idx CREATE), :1485-1508 (needsEventsRebuild OFFLINE stop-the-world precedent)
- src/backup.ts:306/:324 (VACUUM INTO on a dedicated conn), :236/:254 (verifySnapshot), :404 (restore/mv instructions), :12-29 (never in-place VACUUM)
- src/reducer.ts:7533 (drain COALESCE arm to drop)
- src/subagent-invocations.ts:258,:368 (COALESCE arms — drop; confirm PreToolUse:Agent in keep-set)
- cli/search-history.ts:115,:119 (LEFT JOIN + COALESCE to drop)
- README.md ~1264/~1895/~2601-2623/~2762, CLAUDE.md "## Event-sourcing invariants"

### Risks

- HIGHEST RISK / irreversible. The keep-set restore MUST complete before the DROP, and be idempotent/resumable so a mid-step crash leaves a known-good pre-shed state.
- Migration-ladder hazard: removing/altering any historical event_blobs ladder step → `no such table` on a fresh 0→v74 migrate → wedged boot. DROP only at the v74 tail.
- Old binary against shed DB: rely on the runtime downgrade guard (stored v74 > old binary SCHEMA_VERSION → migrate throws before any CREATE IF NOT EXISTS). Verify the guard fires BEFORE schema-setup CREATEs.
- Disk headroom: VACUUM INTO needs ~full DB size free on the same filesystem; check `page_count*page_size + freelist` before starting, fail fast.
- search-history/subagent COALESCE arms reference a dropped table — they must be removed in the SAME binary that ships the drop, or they error at query time.

### Detailed phases

1. (online, migrate v74) restore keep-set inline → DROP event_blobs at the tail. 2. (binary) drop all dead COALESCE arms + update CLI + docs. 3. (offline op) checkpoint FULL → VACUUM INTO (auto_vacuum=INCREMENTAL) → quick_check → chmod → atomic mv → clear stale wal/shm. 4. restart new binary → keeper await server-up → verify DB size + re-fold + forensics → discard snapshot.

### Rollback

If post-restart verification fails: stop daemon, `mv` the retained pre-shed snapshot back, restart the prior binary. The snapshot is the rollback; never delete it until verification passes.

### Test notes

0→v74 from-scratch migrate test (ladder intact). Post-shed full-corpus differential
re-fold byte-identical. search-history + subagent-invocations forensics tests pass with
the table gone. quick_check on a vacuumed fixture.

## Acceptance

- [ ] Keep-set restored inline (idempotent); `event_blobs` + `idx_event_blobs_tool_attr` dropped at the v74 tail; v56/v57/v66/v67 ladder steps unchanged; 0→v74 from-scratch migrate succeeds
- [ ] All dead COALESCE arms removed (drain, subagent-invocations, search-history) in the same binary; forensics still work
- [ ] Disk reclaimed via VACUUM INTO (auto_vacuum=INCREMENTAL baked, verified post-swap) + atomic mv; quick_check gate passed; DB ~0.4-0.7 GB
- [ ] Post-shed full-corpus differential re-fold byte-identical; README + CLAUDE.md re-fold-determinism wording updated forward-facing
- [ ] `bun run test:full` green

## Done summary

## Evidence
