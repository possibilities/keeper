/**
 * Historical `events.mutation_path` backfill (fn-836.3).
 *
 * Task .2 added the `events.mutation_path` column and the forward write path
 * (hook deriver + ingester recompute), so every row written AFTER the v73
 * deploy already carries it. This module backfills the column over the
 * HISTORICAL rows the forward path never touched — every
 * `(PostToolUse, Write/Edit/MultiEdit/NotebookEdit)` event that predates the
 * deploy, INCLUDING the cold rows compaction already relocated into
 * `event_blobs` (where `events.data IS NULL`). Once this is provably complete
 * the git-attribution scan flips off the blob onto the column and ARM B (the
 * `event_blobs` rowid-join) is deleted.
 *
 * ## Why COALESCE both sides
 *
 * A relocated mutation row has `events.data IS NULL` and its body in
 * `event_blobs.data`. Reading only `events.data` would leave `mutation_path`
 * NULL for every relocated row, and the post-flip discharged-mutation scan
 * (which reaches arbitrarily far back on a from-scratch re-fold) would then
 * silently drop those attributions. So the extract reads
 * `COALESCE(events.data, event_blobs.data)` — the inline body when present, the
 * relocated body otherwise.
 *
 * ## Byte-identical to ARM B's guard
 *
 * The extract uses the SAME `CASE WHEN json_valid(...) THEN json_extract(...,
 * '$.tool_input.file_path') END` guard ARM B uses, so a malformed body folds to
 * the SAME NULL the old two-arm scan produced. The column the post-flip scan
 * reads is therefore byte-identical to what the old blob-parse path read — the
 * determinism gate the .1 differential harness proves.
 *
 * ## Pacing + crash-safe resume (mirrors `compactColdBlobs`)
 *
 * Online, compaction-paced: collect a batch of ids read-only, then UPDATE them
 * under a brief `.immediate()` transaction, never holding a cursor across
 * batches (checkpoint starvation). Each batch advances a crash-safe resume
 * watermark in `meta` (`mutation_path_backfill_watermark`) written in the SAME
 * transaction as the UPDATE, so a mid-pass crash resumes from the last
 * committed batch — never re-scanning the already-backfilled prefix. The
 * watermark is the highest `events.id` the backfill has processed; the next
 * pass selects ids strictly above it.
 *
 * Runs on MAIN's writable connection (the daemon schedules it on a slack
 * timer), NEVER inside a fold or the reducer's cursor-advance transaction.
 * `events.mutation_path` is a content-preserving promoted column of the
 * immutable event log, never a reducer projection — backfilling it does not
 * touch any projection, so a from-scratch re-fold stays byte-identical (the
 * fold reads the column's value, which equals what the old scan read off the
 * blob).
 */

import type { Database } from "bun:sqlite";

/** `meta` key for the crash-safe resume watermark (highest processed id). */
export const BACKFILL_WATERMARK_KEY = "mutation_path_backfill_watermark";

/**
 * Rows backfilled per transaction. Each batch is one `.immediate()` so this
 * bounds how long the writer lock is held per step — kept ≤500 to stay well
 * under a concurrent hook's `busy_timeout`, mirroring
 * {@link import("./compaction").DEFAULT_COMPACTION_BATCH_SIZE}.
 */
export const DEFAULT_BACKFILL_BATCH_SIZE = 500;

/**
 * Max batches per pass. Caps a single timer-scheduled pass at
 * `maxBatches * batchSize` rows so the backfill can't monopolize the writer for
 * an unbounded stretch; the historical tail drains across successive passes.
 */
export const DEFAULT_BACKFILL_MAX_BATCHES = 20;

export interface BackfillOptions {
  /** Rows per transaction. Defaults to {@link DEFAULT_BACKFILL_BATCH_SIZE}. */
  batchSize?: number;
  /** Max batches this pass. Defaults to {@link DEFAULT_BACKFILL_MAX_BATCHES}. */
  maxBatches?: number;
}

export interface BackfillResult {
  /** Rows scanned + UPDATEd this pass (sum across batches). */
  scanned: number;
  /** Number of transactions (batches) executed this pass. */
  batches: number;
  /** The resume watermark after this pass (highest processed `events.id`). */
  watermark: number;
  /**
   * `true` when a full `maxBatches` ran AND the last batch was full — more
   * historical rows likely remain and the caller may schedule a follow-up pass
   * sooner than the next slack tick.
   */
  moreLikely: boolean;
}

/**
 * The mutation-tool predicate shared by every query here, ARM A/B, and the
 * forward deriver: `(PostToolUse, Write/Edit/MultiEdit/NotebookEdit)`.
 */
const MUTATION_TOOL_PREDICATE = `hook_event = 'PostToolUse'
   AND tool_name IN ('Write','Edit','MultiEdit','NotebookEdit')`;

/**
 * The guarded extract, IDENTICAL to ARM B's
 * `CASE WHEN json_valid(b.data) THEN json_extract(b.data, ...) END` but over
 * `COALESCE(events.data, event_blobs.data)` so an already-relocated row's body
 * is read from the side table. Malformed → NULL (never throws), byte-identical
 * to the old scan's malformed handling.
 */
const GUARDED_EXTRACT = `CASE WHEN json_valid(COALESCE(e.data, b.data))
        THEN json_extract(COALESCE(e.data, b.data), '$.tool_input.file_path')
   END`;

/** Read the crash-safe resume watermark; `0` when no pass has run yet. */
export function readBackfillWatermark(db: Database): number {
  const row = db
    .query("SELECT value FROM meta WHERE key = ?")
    .get(BACKFILL_WATERMARK_KEY) as { value: string } | null;
  if (row == null) return 0;
  const n = Number.parseInt(row.value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Backfill `events.mutation_path` over the historical mutation rows above the
 * resume watermark, paced. Runs on MAIN's writable connection; NEVER call
 * inside a fold transaction.
 *
 * Each batch: read the next `batchSize` mutation-row ids strictly above the
 * watermark (read-only), then under one `.immediate()` transaction UPDATE their
 * `mutation_path` from the guarded `COALESCE(events.data, event_blobs.data)`
 * extract AND advance the watermark to the batch's max id — both in the SAME
 * transaction so a crash resumes from exactly the last committed batch. Rows
 * whose body yields no valid file_path are STILL processed (their column stays
 * NULL) and the watermark advances past them, so a done-null row is never
 * re-scanned next pass.
 *
 * Does NOT checkpoint — the caller reclaims WAL space outside the hot path,
 * exactly as the compaction pass does.
 */
export function backfillMutationPath(
  db: Database,
  options: BackfillOptions = {},
): BackfillResult {
  const batchSize = options.batchSize ?? DEFAULT_BACKFILL_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_BACKFILL_MAX_BATCHES;

  let watermark = readBackfillWatermark(db);

  // Select the next batch of mutation-row ids strictly above the watermark.
  // `mutation_path IS NULL` skips the forward-path rows task .2 already filled
  // (so a re-deployed daemon doesn't re-touch them), while the watermark skips
  // the done-null tail (malformed / no-file_path rows whose column legitimately
  // stays NULL). LEFT JOIN `event_blobs` so a relocated row's body is visible
  // to the cold-row probe below; the id select itself reads only `events`.
  const selectBatch = db.prepare(
    `SELECT id FROM events
      WHERE id > ?
        AND ${MUTATION_TOOL_PREDICATE}
        AND mutation_path IS NULL
      ORDER BY id ASC
      LIMIT ?`,
  );

  // UPDATE the batch's `mutation_path` from the guarded extract over the
  // COALESCE'd body. The correlated `event_blobs` subquery supplies the
  // relocated body (`b.data`) for a row whose `events.data` is NULL; an inline
  // row reads `events.data` and the subquery's `b.data` is irrelevant. The
  // outer `events` reference inside the subquery is the row being updated, so
  // the join keys on its id.
  const updateBatch = db.prepare(
    `UPDATE events
        SET mutation_path = (
          SELECT CASE WHEN json_valid(COALESCE(events.data, b.data))
                      THEN json_extract(COALESCE(events.data, b.data),
                                        '$.tool_input.file_path')
                 END
            FROM (SELECT 1) AS _
            LEFT JOIN event_blobs b ON b.event_id = events.id
        )
      WHERE id IN (SELECT value FROM json_each(?))`,
  );

  const upsertWatermark = db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );

  let scanned = 0;
  let batches = 0;
  let lastBatchFull = false;

  for (let i = 0; i < maxBatches; i++) {
    const idRows = selectBatch.all(watermark, batchSize) as { id: number }[];
    if (idRows.length === 0) break;
    const ids = idRows.map((r) => r.id);
    const idsJson = JSON.stringify(ids);
    const maxId = ids[ids.length - 1] as number;

    // ONE atomic transaction per batch — UPDATE the column AND advance the
    // watermark together, so a crash leaves a consistent (backfilled-prefix,
    // watermark) pair. `.immediate()` grabs the writer lock at BEGIN so the
    // UPDATE can't lose the upgrade-to-writer race to a concurrent hook write.
    db.transaction(() => {
      updateBatch.run(idsJson);
      upsertWatermark.run(BACKFILL_WATERMARK_KEY, String(maxId));
    }).immediate();

    watermark = maxId;
    scanned += ids.length;
    batches += 1;
    lastBatchFull = ids.length === batchSize;
  }

  return {
    scanned,
    batches,
    watermark,
    moreLikely: batches === maxBatches && lastBatchFull,
  };
}

/**
 * Completion gate: `true` when NO historical mutation row still owes a
 * backfill. A row owes a backfill iff `mutation_path IS NULL` AND the guarded
 * extract over `COALESCE(events.data, event_blobs.data)` YIELDS A VALUE — i.e.
 * its body carries a real file_path the column doesn't yet hold. This
 * deliberately does NOT count a legitimately-NULL row (malformed body / no
 * `file_path`), so the gate distinguishes "not yet backfilled" from
 * "backfilled to a correct NULL". The git-attribution flip is safe ONLY when
 * this returns `true` (and the .1 differential harness is green).
 *
 * Pure read. The LEFT JOIN to `event_blobs` covers relocated rows; `IS NOT
 * NULL` over the guarded extract is the "yields a valid file_path" predicate.
 */
export function isMutationPathBackfillComplete(db: Database): boolean {
  const row = db
    .query(
      `SELECT COUNT(*) AS n
         FROM events e
         LEFT JOIN event_blobs b ON b.event_id = e.id
        WHERE e.${MUTATION_TOOL_PREDICATE}
          AND e.mutation_path IS NULL
          AND ${GUARDED_EXTRACT} IS NOT NULL`,
    )
    .get() as { n: number };
  return row.n === 0;
}
