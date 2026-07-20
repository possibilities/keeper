/**
 * Historical `events.mutation_path` backfill (fn-836.3).
 *
 * Task .2 added the `events.mutation_path` column and the forward write path
 * (hook deriver + ingester recompute), so every row written AFTER the v73
 * deploy already carries it. This module backfills the column over the
 * HISTORICAL rows the forward path never touched — every
 * `(PostToolUse, Write/Edit/MultiEdit/NotebookEdit)` event that predates the
 * deploy. Once this was provably complete (`.3` gate) the git-attribution scan
 * flipped off the blob onto the column and ARM B (the `event_blobs` rowid-join)
 * was deleted.
 *
 * ## Reads `events.data` only (post-shed, fn-836.4)
 *
 * `.3` ran this against a corpus where cold mutation bodies were relocated into
 * `event_blobs` (`events.data IS NULL`), so it COALESCE'd both sides to see the
 * relocated body. The `.4` shed DROPPED `event_blobs` — every keep-set body was
 * restored inline and every shed-class mutation body was NULLed (its file_path
 * already lives in `mutation_path` from this very backfill) — so there is no
 * side table left to read. The extract now reads `events.data` directly: a row
 * still owing a backfill must have an INLINE body carrying a file_path, which
 * (post-shed) means a forward-written row, and the completion gate goes true the
 * instant no inline mutation body holds an unstamped file_path.
 *
 * ## Malformed → NULL (never throws)
 *
 * The extract keeps the `CASE WHEN json_valid(e.data) THEN json_extract(e.data,
 * '$.tool_input.file_path') END` guard, so a malformed body folds to NULL
 * instead of throwing — byte-identical to the old scan's malformed handling.
 *
 * ## Pacing + crash-safe resume (mirrors `retainColdPayloads`)
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
import { MUTATION_TOOL_SQL_PREDICATE } from "./derivers";

/** `meta` key for the crash-safe resume watermark (highest processed id). */
export const BACKFILL_WATERMARK_KEY = "mutation_path_backfill_watermark";

/**
 * Rows backfilled per transaction. Each batch is one `.immediate()` so this
 * bounds how long the writer lock is held per step — kept ≤500 to stay well
 * under a concurrent hook's `busy_timeout`, mirroring
 * {@link import("./compaction").DEFAULT_RETENTION_BATCH_SIZE}.
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
 * The mutation-tool predicate shared by every query here, ARM A/B, the forward
 * deriver, AND compaction's shed guard — the one dep-free
 * {@link MUTATION_TOOL_SQL_PREDICATE} in `src/derivers.ts`.
 */
const MUTATION_TOOL_PREDICATE = MUTATION_TOOL_SQL_PREDICATE;

/**
 * Forward-seeking batch selector. `NOT INDEXED` prevents SQLite from expanding
 * the hook/tool OR through secondary indexes and sorting cold history for LIMIT.
 */
export const BACKFILL_SELECT_BATCH_SQL = `SELECT id FROM events NOT INDEXED
  WHERE id > ?
    AND ${MUTATION_TOOL_PREDICATE}
    AND mutation_path IS NULL
  ORDER BY id ASC
  LIMIT ?`;

/**
 * The guarded extract over `events.data` (post-shed there is no side table to
 * COALESCE). `CASE WHEN json_valid(e.data) THEN json_extract(e.data, ...) END`:
 * a malformed body folds to NULL instead of throwing, byte-identical to the old
 * scan's malformed handling.
 */
const GUARDED_EXTRACT = `CASE WHEN json_valid(e.data)
        THEN json_extract(e.data, '$.tool_input.file_path')
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
 * `mutation_path` from the guarded extract over the inline `events.data` body
 * (post-shed: no `event_blobs` side table) AND advance the watermark to the
 * batch's max id — both in the SAME transaction so a crash resumes from exactly
 * the last committed batch. Rows whose body yields no valid file_path are STILL
 * processed (their column stays NULL) and the watermark advances past them, so a
 * done-null row is never re-scanned next pass.
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
  // `NOT INDEXED` keeps this as one forward primary-key seek: the hook/tool OR
  // predicate's secondary indexes would otherwise materialize and sort the
  // entire historical match set before LIMIT, starving MAIN on a cold tail.
  // `mutation_path IS NULL` skips the forward-path rows task .2 already filled
  // (so a re-deployed daemon doesn't re-touch them), while the watermark skips
  // the done-null tail (malformed / no-file_path rows whose column legitimately
  // stays NULL). Reads only `events` (the body extract below also reads only the
  // inline `events.data` — post-shed there is no side table).
  const selectBatch = db.prepare(BACKFILL_SELECT_BATCH_SQL);

  // UPDATE the batch's `mutation_path` from the guarded extract over the inline
  // `events.data` body (post-shed: no `event_blobs` side table to COALESCE). A
  // shed-class row whose body was NULLed extracts to NULL and keeps the
  // `mutation_path` this backfill already stamped before the shed.
  const updateBatch = db.prepare(
    `UPDATE events
        SET mutation_path = CASE WHEN json_valid(data)
                                 THEN json_extract(data, '$.tool_input.file_path')
                            END
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
 * Completion gate: `true` when NO mutation row still owes a backfill. A row owes
 * a backfill iff `mutation_path IS NULL` AND the guarded extract over the inline
 * `events.data` YIELDS A VALUE — i.e. its body carries a real file_path the
 * column doesn't yet hold. This deliberately does NOT count a legitimately-NULL
 * row (malformed body / no `file_path` / shed-class body NULLed by the v74 shed),
 * so the gate distinguishes "not yet backfilled" from "backfilled to a correct
 * NULL". The git-attribution flip was gated on this returning `true`.
 *
 * Pure read over `events.data` only (post-shed: no `event_blobs` side table).
 */
export function isMutationPathBackfillComplete(db: Database): boolean {
  const row = db
    .query(
      `SELECT COUNT(*) AS n
         FROM events e
        WHERE e.${MUTATION_TOOL_PREDICATE}
          AND e.mutation_path IS NULL
          AND ${GUARDED_EXTRACT} IS NOT NULL`,
    )
    .get() as { n: number };
  return row.n === 0;
}
