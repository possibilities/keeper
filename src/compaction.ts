/**
 * Cold-blob compaction relocator (fn-717.2).
 *
 * The `events` table has grown ~1.6 GB, dominated by ~1 GB of inline
 * `PostToolUse` `data` blobs (~12 KB each, tens of thousands of rows) that go
 * cold the instant their file attribution discharges yet stay inline in the
 * hot, heavily-indexed `events` table forever — bloating every B-tree scan the
 * drain does and degrading fold cache behavior. Task .1 added the
 * `event_blobs(event_id, data)` side table + COALESCE read plumbing (lossless,
 * re-fold-stable with the table EMPTY). Task .2 relaxed `events.data` to
 * nullable (the v57→v58 stop-the-world rebuild in `migrate()`). This module is
 * the daemon-side relocator that MOVEs cold blobs into the side table and NULLs
 * the hot column — `events` row NEVER deleted, blob VALUE preserved.
 *
 * ## Why this is read-side compaction, not a write-time split
 *
 * The hook is the SOLE writer of hook events, opens `{ migrate: false }`,
 * writes each event as a SINGLE `INSERT INTO events`, must always exit 0, and
 * dead-letters on failure (`plugin/hooks/events-writer.ts`). So `data` CANNOT
 * be split off at write time — a second INSERT into the side table would break
 * the single-statement, always-exit-0 contract. New events therefore keep
 * writing `data` inline; this pass relocates cold blobs AFTER the fact.
 *
 * ## Correctness — why ANY blob is safe to relocate
 *
 * Every reducer `data`-VALUE read resolves the blob through `event_blobs` when
 * the hot column is NULL: the drain SELECT + both commit-trailer scans use
 * `COALESCE(events.data, event_blobs.data)` (task .1), and the explicit-
 * attribution tool scan in `findExplicitAttributions` (`src/reducer.ts`) uses
 * the TWO-ARM form added in this task — ARM A keeps the indexed `events.data`
 * SEEK for inline blobs, ARM B reads `event_blobs.data` for relocated ones, the
 * two arms partitioned by `events.data IS NULL`. So a relocated blob folds
 * byte-identically whether read inline or via the side table, INCLUDING on a
 * from-scratch re-fold (where the discharging Commit replays after the
 * GitSnapshot and the explicit scan momentarily needs a since-discharged
 * mutation's `tool_input.file_path` — ARM B serves it). Relocation is therefore
 * lossless for EVERY read regardless of which blobs we move; there is no
 * correctness boundary in the predicate. (The bash-mutation scan reads
 * `bash_mutation_targets`, a derived column, not `data`; the inferred-bracket
 * scan reads no `data`.)
 *
 * ## The cold watermark — a pacing/locality heuristic, not a correctness gate
 *
 * Because relocation is lossless for any blob, the watermark exists only to
 * (a) keep the hottest, most-recently-written blobs INLINE so the common
 * explicit-attribution scan stays on the fast indexed ARM A (a just-dirtied
 * file's freshest mutation should not pay the ARM-B side-table join), and
 * (b) avoid churning blobs that just landed. It is simply an absolute recent
 * window:
 *
 *   coldWatermark = maxEventId - RECENT_RETENTION_MARGIN
 *
 * keeping the newest `RECENT_RETENTION_MARGIN` events inline and relocating the
 * long cold tail below it. We relocate only `events.id <= coldWatermark AND
 * data IS NOT NULL` (already-relocated rows have `data IS NULL` and are
 * skipped — the pass is naturally idempotent).
 *
 * ## Single-writer + pacing + re-fold determinism
 *
 * - Runs on MAIN's writable connection (the daemon schedules it on the
 *   heartbeat timer), NEVER inside a fold and NEVER inside the reducer's
 *   `BEGIN IMMEDIATE` cursor-advance transaction. `event_blobs` is NOT a
 *   reducer projection — it is a content-preserving sidecar of the immutable
 *   event log, never folded, never in the rewind-and-redrain DELETE list. So a
 *   from-scratch re-fold over a compacted DB reproduces byte-identical
 *   projections (the blob VALUE the fold sees is unchanged; only its LOCATION
 *   moved, and COALESCE papers over the location).
 * - Each batch is ONE transaction (`INSERT INTO event_blobs SELECT ...` then
 *   `UPDATE events SET data = NULL` over the SAME id set) so a blob is never in
 *   NEITHER place — it is in `events.data` before the tx, in `event_blobs`
 *   after, and atomically so across the COMMIT.
 * - Paced: at most `maxBatches` batches of `batchSize` per pass, so the writer
 *   lock is released between batches and a concurrent hook INSERT is never
 *   starved. Space is reclaimed (PASSIVE checkpoint / VACUUM) by the CALLER,
 *   outside the hot path — never TRUNCATE (TRUNCATE waits on writers).
 *
 * ## Observability — absent-in-both-places is a counted bug
 *
 * A blob that ends up in NEITHER `events.data` NOR `event_blobs` is data loss,
 * NOT legitimate compaction (a relocated blob is in `event_blobs`). The
 * relocation can never CREATE that state (the INSERT-then-NULL is atomic and
 * the INSERT reads the real bytes), but a bug elsewhere could. {@link
 * countAbsentBlobs} surfaces it: it counts events whose `COALESCE(events.data,
 * event_blobs.data) IS NULL` — a positive count is a genuine bug the daemon
 * logs, distinct from the (large, legitimate) relocated count.
 */

import type { Database } from "bun:sqlite";

/**
 * Keep the most-recent N events inline UNCONDITIONALLY, regardless of
 * attribution state. A freshly-dirty file's freshest mutation lives in this
 * window, so the explicit-attribution scan always reads it through
 * `idx_events_tool_attr` (never the side table). Generous on purpose — the
 * relocation target is the long cold tail (tens of thousands of old rows), so
 * leaving the most recent ~5k inline costs almost nothing while giving a wide
 * safety margin against any live attribution whose contributing event somehow
 * post-dates the `minLiveAttributionEventId` floor (it cannot, but defense in
 * depth is cheap here).
 */
export const RECENT_RETENTION_MARGIN = 5_000;

/**
 * Rows relocated per transaction. Each batch is one `BEGIN`/`COMMIT`, so this
 * bounds how long the writer lock is held per step. 500 ~12 KB blobs is ~6 MB
 * of INSERT + a same-size UPDATE per tx — well under the latency that would
 * starve a concurrent hook's `busy_timeout`.
 */
export const DEFAULT_COMPACTION_BATCH_SIZE = 500;

/**
 * Max batches per pass. Caps a single heartbeat-scheduled pass at
 * `maxBatches * batchSize` rows so the pass can't monopolize the writer for an
 * unbounded stretch; the cold tail drains across successive passes. The first
 * post-deploy pass over a ~1 GB backlog takes many passes to fully drain —
 * that's intentional pacing, not a stall.
 */
export const DEFAULT_COMPACTION_MAX_BATCHES = 20;

export interface CompactionOptions {
  /** Rows per transaction. Defaults to {@link DEFAULT_COMPACTION_BATCH_SIZE}. */
  batchSize?: number;
  /** Max batches this pass. Defaults to {@link DEFAULT_COMPACTION_MAX_BATCHES}. */
  maxBatches?: number;
  /**
   * Recent-window margin. Defaults to {@link RECENT_RETENTION_MARGIN}. Exposed
   * for tests that need a tiny window over a small seeded event log.
   */
  recentRetentionMargin?: number;
}

export interface CompactionResult {
  /** Number of blobs relocated this pass (sum across batches). */
  relocated: number;
  /** Number of transactions (batches) executed this pass. */
  batches: number;
  /** The cold watermark used this pass (events at or below were eligible). */
  coldWatermark: number;
  /**
   * `true` when a full `maxBatches` ran AND the last batch was full — i.e.
   * more cold blobs likely remain and the caller may schedule a follow-up
   * pass sooner than the next heartbeat.
   */
  moreLikely: boolean;
}

/**
 * Compute the cold watermark: the highest `events.id` eligible for relocation
 * — every event past the recent-retention window. Returns `0` when nothing is
 * eligible (a watermark of 0 relocates nothing, since `events.id` is a `>= 1`
 * AUTOINCREMENT key).
 *
 * Not a correctness gate (relocation is lossless for any blob via the two-arm
 * explicit-attribution scan + COALESCE reads) — purely a locality/pacing
 * heuristic that keeps the hottest recent blobs inline on the fast indexed
 * scan arm. Pure read; deterministic given the current table contents.
 */
export function computeColdWatermark(
  db: Database,
  recentRetentionMargin: number = RECENT_RETENTION_MARGIN,
): number {
  const maxRow = db.query("SELECT MAX(id) AS max_id FROM events").get() as {
    max_id: number | null;
  } | null;
  const maxId = maxRow?.max_id ?? 0;
  if (maxId <= 0) return 0;

  // Absolute recent window: keep the newest `recentRetentionMargin` events
  // inline so a just-dirtied file's freshest mutation stays on the indexed
  // explicit-attribution arm (never the side-table join).
  return Math.max(0, maxId - recentRetentionMargin);
}

/**
 * Relocate cold blobs from `events.data` into `event_blobs`, paced. Runs on
 * MAIN's writable connection; NEVER call inside a fold transaction.
 *
 * Each batch is one transaction: copy the next `batchSize` cold blobs into
 * `event_blobs`, then NULL the same ids on `events` — atomic, so a blob is
 * never in neither place. Selects only `id <= coldWatermark AND data IS NOT
 * NULL` (already-relocated rows have `data IS NULL`, so they're skipped — the
 * pass is naturally idempotent). The `INSERT ... ON CONFLICT DO NOTHING` guards
 * the impossible re-relocation race (a row already in `event_blobs`).
 *
 * Does NOT checkpoint or VACUUM — the caller reclaims space outside the hot
 * path (PASSIVE checkpoint, never TRUNCATE).
 */
export function compactColdBlobs(
  db: Database,
  options: CompactionOptions = {},
): CompactionResult {
  const batchSize = options.batchSize ?? DEFAULT_COMPACTION_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_COMPACTION_MAX_BATCHES;
  const recentRetentionMargin =
    options.recentRetentionMargin ?? RECENT_RETENTION_MARGIN;

  const coldWatermark = computeColdWatermark(db, recentRetentionMargin);
  if (coldWatermark <= 0) {
    return { relocated: 0, batches: 0, coldWatermark: 0, moreLikely: false };
  }

  // One prepared statement set, reused across batches. The SELECT picks the
  // next cold batch by id; INSERT copies those rows' blobs into the side table;
  // UPDATE NULLs the hot column for the SAME ids. All three share the same
  // `id <= watermark AND data IS NOT NULL` cold predicate so a row relocated by
  // the INSERT is exactly the row the UPDATE clears — the batch is internally
  // consistent within the single transaction.
  const selectBatch = db.prepare(
    `SELECT id FROM events
      WHERE id <= ? AND data IS NOT NULL
      ORDER BY id ASC
      LIMIT ?`,
  );
  const insertBlobs = db.prepare(
    `INSERT INTO event_blobs (event_id, data)
       SELECT id, data FROM events
        WHERE id IN (SELECT value FROM json_each(?))
          AND data IS NOT NULL
     ON CONFLICT(event_id) DO NOTHING`,
  );
  const nullHot = db.prepare(
    `UPDATE events SET data = NULL
      WHERE id IN (SELECT value FROM json_each(?))`,
  );

  let relocated = 0;
  let batches = 0;
  let lastBatchFull = false;

  for (let i = 0; i < maxBatches; i++) {
    const idRows = selectBatch.all(coldWatermark, batchSize) as {
      id: number;
    }[];
    if (idRows.length === 0) break;
    const ids = idRows.map((r) => r.id);
    const idsJson = JSON.stringify(ids);

    // ONE atomic transaction per batch — copy then NULL. `.immediate()` grabs
    // the writer lock at BEGIN so the INSERT/UPDATE can't lose the
    // upgrade-to-writer race to a concurrent hook write and surface a partial
    // SQLITE_BUSY half-way through (same fix as `migrate()`/`applyEvent`).
    db.transaction(() => {
      insertBlobs.run(idsJson);
      nullHot.run(idsJson);
    }).immediate();

    relocated += ids.length;
    batches += 1;
    lastBatchFull = ids.length === batchSize;
  }

  return {
    relocated,
    batches,
    coldWatermark,
    moreLikely: batches === maxBatches && lastBatchFull,
  };
}

/**
 * Count events whose blob is in NEITHER `events.data` NOR `event_blobs` — a
 * genuine data-loss bug, NOT legitimate compaction (a relocated blob is in
 * `event_blobs`). The relocation path cannot create this state (INSERT-then-
 * NULL is atomic and the INSERT reads the real bytes), so a positive count
 * always indicates a bug elsewhere; the daemon logs it distinctly from the
 * (large, legitimate) relocated count.
 *
 * A legitimately-relocated row has `events.data IS NULL` AND a matching
 * `event_blobs` row WITH non-null `data`, so it fails the "absent in both"
 * predicate and is NOT counted. The predicate is written to test nullness via
 * headers/keys only (NOT `COALESCE`, which would materialize the full blob —
 * see the query comment).
 */
export function countAbsentBlobs(db: Database): number {
  const row = db
    .query(
      // Test nullness via the hot column's header and the side table's PK +
      // header — NEVER via `COALESCE(events.data, event_blobs.data)`. COALESCE
      // must MATERIALIZE the first non-null argument's VALUE into a register
      // before the outer `IS NULL` test, so on a fully-relocated DB (every
      // `events.data IS NULL`) it reads the ENTIRE `event_blobs.data` payload —
      // ~1.3 GB of ~12 KB overflow blobs — through random overflow I/O on EVERY
      // heartbeat pass, pegging main and starving hook writes (the fn-717.2
      // post-deploy peg). `col IS NULL` reads only the record-header serial
      // type, never the overflow payload, so this form is the same logical
      // "absent in both" predicate at header/key cost (≈0.4 s vs minutes).
      `SELECT COUNT(*) AS n
         FROM events
         LEFT JOIN event_blobs ON event_blobs.event_id = events.id
        WHERE events.data IS NULL
          AND (event_blobs.event_id IS NULL OR event_blobs.data IS NULL)`,
    )
    .get() as { n: number };
  return row.n;
}
