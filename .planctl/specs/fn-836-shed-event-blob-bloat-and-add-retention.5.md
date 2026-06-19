## Description

**Size:** M
**Files:** src/compaction.ts (→ retention), src/daemon.ts, test/compaction.test.ts (→ retention), tests

Repurpose the retired relocator machinery into keeper's first retention pass so forward
growth is bounded. Ship it ENABLED.

### Approach

Convert `compactColdBlobs` into a retention pass that NULLs cold NON-keep payloads in
place: `UPDATE events SET data = NULL WHERE <not in keep-set allow-list> AND id <= cold
watermark AND id < cursor`. Keep the batched/paced/watermarked shape (BEGIN IMMEDIATE per
batch, PASSIVE checkpoint between, ≤500 rows, moreLikely follow-up). After each retention
batch run `PRAGMA incremental_vacuum(200-500)` to return freed overflow pages to the file
tail (NOT one big call — it overflows cache→WAL). The keep predicate is the explicit
ALLOW-list from .1 (NULL only the complement) — never a deny-list. Re-spec the
`countAbsentBlobs`/data-loss sentinel (daemon.ts:3213): NULLing is now INTENTIONAL, so the
old "absent ⇒ data loss" alarm must not fire on legitimately-shed rows; use a header-only
`IS NULL` probe (never COALESCE — the fn-717.2 overflow-materialization incident). The
retention pass runs STRICTLY outside the fold (a scheduled daemon job, never callable from
the reducer); a throw calls `fatalExit` (LaunchAgent restart), never wedges the cursor.

### Investigation targets

**Required** (read before coding):
- src/compaction.ts (whole file — the machine to repurpose), :274/:289 (countAbsentBlobs header-only IS NULL probe)
- src/daemon.ts:3185-3247 (runCompactionPass + compactionTimer), :3213 (data-loss sentinel to re-spec), :226 (COMPACTION_INTERVAL_MS)
- test/compaction.test.ts (rewrite for retention; :280 re-fold-over-compacted template)

**Optional** (reference as needed):
- the keep-set allow-list module from .1

### Risks

- Allow-list completeness IS the determinism guarantee — a non-keep type that some fold actually reads → re-fold breaks. Reuse .1's proven allow-list; do not redefine it here.
- incremental_vacuum only reclaims if auto_vacuum=INCREMENTAL was baked in .4 — verify it's set before relying on per-batch reclaim.
- Retention must never run inside or be reachable from the fold (wall-clock/liveness reads would poison determinism).

### Test notes

Retention-then-refold byte-identical (the allow-list covers every fold-read body).
Idempotence + pacing + per-batch incremental_vacuum reclaim test. Sentinel no longer
false-alarms on shed rows. Poll, don't sleep.

## Acceptance

- [ ] Retention pass NULLs cold non-keep payloads (allow-list), paced/watermarked, past the cursor; ships ENABLED in the daemon
- [ ] Per-batch `incremental_vacuum` reclaims freelist (auto_vacuum=INCREMENTAL verified); forward growth bounded
- [ ] Retention-then-from-scratch-refold is byte-identical; data-loss sentinel re-spec'd (no false alarm on intentional NULLs); retention runs outside the fold, throw → fatalExit
- [ ] `bun run test:full` green

## Done summary

## Evidence
