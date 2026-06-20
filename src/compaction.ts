/**
 * Steady-state retention pass (fn-836.5).
 *
 * keeper's first retention pass, repurposed from the fn-717.2 cold-blob
 * RELOCATOR. The relocator MOVEd cold `events.data` bodies into an `event_blobs`
 * side table (NULLing the hot column) and resolved every read via
 * `COALESCE(events.data, event_blobs.data)` — lossless but never shrinking the
 * DB (the bytes just moved sideways). The fn-836.4 shed DROPPED `event_blobs`
 * and narrowed the canonical fold input: shed-class bodies are no longer read by
 * any fold (their only fold-consumed field, `tool_input.file_path`, is promoted
 * to the `events.mutation_path` column). So those bodies are now pure redundant
 * transcript archive — safe to NULL IN PLACE, returning their overflow pages to
 * the file via `auto_vacuum=INCREMENTAL` (baked at the .4 reclaim).
 *
 * ## What it NULLs — the SHED CLASS, the complement of the keep-set ALLOW-list
 *
 * The keep-set is an explicit ALLOW-list of event types whose `data` BODY a live
 * fold parses (snapshot/synthetic folds, session/prompt folds, the subagent
 * PreToolUse:Agent bridge, search-history's UserPromptSubmit `$.prompt`, …). The
 * shed class is its complement: PostToolUse rows for the four mutation tools
 * (`Write`/`Edit`/`MultiEdit`/`NotebookEdit`) whose ONLY fold consumption is
 * `tool_input.file_path` — already promoted to `mutation_path`. This pass NULLs
 * ONLY the complement (never a deny-list): the predicate is the shed-class
 * mutation-tool match, exactly the canonical predicate the v74 shed migration
 * used. Every keep-set body stays inline forever, so a from-scratch re-fold
 * reads it from `events.data` and reproduces byte-identical projection rows.
 *
 * ## Why retention-then-refold is byte-identical
 *
 * A shed-class body is dropped ONLY once its `file_path` is captured in
 * `mutation_path` — the {@link RETENTION_SHED_PREDICATE} excludes any row that
 * still owes a backfill (`mutation_path IS NULL` while the body holds a
 * promotable `file_path`). So every file_path a from-scratch re-fold reads off
 * the column was already promoted BEFORE its body was NULLed. The keep-set bodies
 * never move. Therefore retention changes no value any fold reads → projections
 * re-fold byte-identically (the sacred invariant).
 *
 * ## Past the cursor — never strip a body the fold has not yet consumed
 *
 * Retention additionally gates on `id < reducer_state.last_event_id`: a body is
 * stripped only AFTER the fold has already advanced past it. Even though the fold
 * reads `mutation_path` (not the body) for shed-class rows, the cursor gate is
 * defense-in-depth against any reader that resolves an un-folded body and a hedge
 * against a not-yet-backfilled forward row whose body still carries the only copy
 * of its file_path.
 *
 * ## Single-writer + pacing + reclaim
 *
 * - Runs on MAIN's writable connection (the daemon schedules it on a slack
 *   timer), NEVER inside a fold and NEVER inside the reducer's `BEGIN IMMEDIATE`
 *   cursor-advance transaction. `events.data` is the canonical event log, not a
 *   reducer projection — NULLing a redundant shed-class body touches no
 *   projection, so a from-scratch re-fold stays byte-identical.
 * - Each batch is ONE `.immediate()` transaction over ≤`batchSize` ids so the
 *   writer lock is released between batches and a concurrent hook INSERT is never
 *   starved. Paced: at most `maxBatches` batches per pass.
 * - After each batch the CALLER runs `PRAGMA incremental_vacuum(N)` to return the
 *   freed overflow pages to the file tail in small chunks (a single unbounded
 *   `incremental_vacuum` overflows cache → WAL — see the daemon caller).
 *
 * ## Outside the fold, always — a throw is fatal, never wedges the cursor
 *
 * Retention is STRICTLY a scheduled daemon job, never callable from the reducer
 * (wall-clock / liveness reads would poison re-fold determinism). The daemon
 * caller logs a retention throw non-fatally (a rolled-back batch loses no data —
 * the body stays inline); an unrecoverable daemon-level error takes `fatalExit`
 * (LaunchAgent restart), never an in-process self-heal.
 */

import type { Database } from "bun:sqlite";

/**
 * Keep the most-recent N events' bodies inline UNCONDITIONALLY, regardless of
 * shed-class. A freshly-dirty mutation's body lives in this window, so even
 * though the fold reads `mutation_path` (not the body), the recent window is a
 * generous locality/pacing margin: retention targets the long cold tail (tens of
 * thousands of old rows), so leaving the most recent ~5k inline costs almost
 * nothing while giving a wide safety margin against any reader that momentarily
 * resolves a just-written body before its column is observed.
 */
export const RECENT_RETENTION_MARGIN = 5_000;

/**
 * Rows whose body is NULLed per transaction. Each batch is one `BEGIN`/`COMMIT`,
 * so this bounds how long the writer lock is held per step. 500 ~12 KB bodies is
 * ~6 MB of UPDATE per tx — well under the latency that would starve a concurrent
 * hook's `busy_timeout`.
 */
export const DEFAULT_RETENTION_BATCH_SIZE = 500;

/**
 * Max batches per pass. Caps a single timer-scheduled pass at
 * `maxBatches * batchSize` rows so the pass can't monopolize the writer for an
 * unbounded stretch; the cold tail drains across successive passes. The first
 * post-deploy pass over the historical backlog takes many passes to fully drain
 * — that's intentional pacing, not a stall.
 */
export const DEFAULT_RETENTION_MAX_BATCHES = 20;

/**
 * Pages returned to the file tail per `incremental_vacuum` call. Small on
 * purpose: a single unbounded `incremental_vacuum` materializes the entire
 * freelist into the page cache and then the WAL, spiking memory and checkpoint
 * pressure. A bounded chunk per batch drains the freelist steadily across
 * passes, matching the paced retention shape.
 */
export const DEFAULT_INCREMENTAL_VACUUM_PAGES = 400;

/**
 * The SHED-CLASS retention predicate — the COMPLEMENT of the keep-set ALLOW-list.
 *
 * A body is eligible to be NULLed iff it is a PostToolUse mutation-tool row (the
 * four shed tools — the only event class whose body no fold reads post-shed) AND
 * it does NOT still owe a `mutation_path` backfill. The second clause is the
 * re-fold safety gate: a row whose body holds a promotable `file_path` the column
 * does not yet carry (`mutation_path IS NULL AND json_extract(...) IS NOT NULL`)
 * is the ONE case where the body is still the sole copy of fold-read data, so it
 * is excluded until the backfill promotes it. A malformed / file_path-less body
 * (extract NULL) is freely sheddable — the fold reads NULL either way.
 *
 * This is the same `(PostToolUse, Write/Edit/MultiEdit/NotebookEdit)` predicate
 * the v74 shed migration and the `mutation_path` backfill use. Keep-set bodies
 * structurally fail the `hook_event = 'PostToolUse' AND tool_name IN (...)` match
 * and are NEVER touched.
 */
export const RETENTION_SHED_PREDICATE = `hook_event = 'PostToolUse'
   AND tool_name IN ('Write','Edit','MultiEdit','NotebookEdit')
   AND NOT (
         mutation_path IS NULL
         AND CASE WHEN json_valid(data)
                  THEN json_extract(data, '$.tool_input.file_path')
             END IS NOT NULL
       )`;

export interface RetentionOptions {
  /** Rows per transaction. Defaults to {@link DEFAULT_RETENTION_BATCH_SIZE}. */
  batchSize?: number;
  /** Max batches this pass. Defaults to {@link DEFAULT_RETENTION_MAX_BATCHES}. */
  maxBatches?: number;
  /**
   * Recent-window margin. Defaults to {@link RECENT_RETENTION_MARGIN}. Exposed
   * for tests that need a tiny window over a small seeded event log.
   */
  recentRetentionMargin?: number;
  /**
   * Pages per `incremental_vacuum` call after each batch. Defaults to
   * {@link DEFAULT_INCREMENTAL_VACUUM_PAGES}. `0` disables per-batch reclaim
   * (e.g. a DB not born with `auto_vacuum=INCREMENTAL`, where the pragma is a
   * no-op — see {@link reclaimDb}).
   */
  incrementalVacuumPages?: number;
}

export interface RetentionResult {
  /** Number of bodies NULLed this pass (sum across batches). */
  shed: number;
  /** Number of transactions (batches) executed this pass. */
  batches: number;
  /** The cold watermark used this pass (events at or below were eligible). */
  coldWatermark: number;
  /** The fold cursor at pass start (only bodies strictly below it are eligible). */
  cursor: number;
  /** Pages returned to the file tail by per-batch `incremental_vacuum`. */
  reclaimedPages: number;
  /**
   * `true` when a full `maxBatches` ran AND the last batch was full — i.e. more
   * cold shed-class bodies likely remain and the caller may schedule a follow-up
   * pass sooner than the next slack tick.
   */
  moreLikely: boolean;
}

/**
 * Compute the cold watermark: the highest `events.id` eligible for retention —
 * every event past the recent-retention window. Returns `0` when nothing is
 * eligible (a watermark of 0 sheds nothing, since `events.id` is a `>= 1`
 * AUTOINCREMENT key).
 *
 * A locality/pacing heuristic, not a correctness gate (the shed predicate's
 * backfill clause + the cursor gate are the correctness gates). Pure read;
 * deterministic given the current table contents.
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

  // Absolute recent window: keep the newest `recentRetentionMargin` events'
  // bodies inline as a locality/pacing margin.
  return Math.max(0, maxId - recentRetentionMargin);
}

/** Read the fold cursor (`reducer_state.last_event_id`); `0` when unset. */
export function readFoldCursor(db: Database): number {
  const row = db
    .query("SELECT last_event_id FROM reducer_state WHERE id = 1")
    .get() as { last_event_id: number } | null;
  return row?.last_event_id ?? 0;
}

/**
 * NULL cold shed-class bodies in place, paced. Runs on MAIN's writable
 * connection; NEVER call inside a fold transaction.
 *
 * Each batch is one transaction: NULL `data` for the next `batchSize` cold
 * shed-class ids (`id <= coldWatermark AND id < cursor AND data IS NOT NULL AND
 * <shed predicate>`). After each batch, `PRAGMA incremental_vacuum(pages)`
 * returns the freed overflow pages to the file tail. Selecting `data IS NOT NULL`
 * means already-shed rows are skipped — the pass is naturally idempotent. The
 * shed predicate excludes keep-set bodies AND any shed-class row still owing a
 * `mutation_path` backfill, so retention-then-refold is byte-identical.
 *
 * The per-batch `incremental_vacuum` only reclaims if the DB was born with
 * `auto_vacuum=INCREMENTAL` (baked at the .4 `reclaimDb` VACUUM INTO); on a
 * non-INCREMENTAL DB the pragma is a no-op and the freed pages sit on the
 * freelist for a later full reclaim (NULLing still shrinks the inline footprint
 * either way — re-fold safety does not depend on the reclaim).
 */
export function retainColdPayloads(
  db: Database,
  options: RetentionOptions = {},
): RetentionResult {
  const batchSize = options.batchSize ?? DEFAULT_RETENTION_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_RETENTION_MAX_BATCHES;
  const recentRetentionMargin =
    options.recentRetentionMargin ?? RECENT_RETENTION_MARGIN;
  const incrementalVacuumPages =
    options.incrementalVacuumPages ?? DEFAULT_INCREMENTAL_VACUUM_PAGES;

  const coldWatermark = computeColdWatermark(db, recentRetentionMargin);
  const cursor = readFoldCursor(db);
  // Nothing is eligible when the watermark or cursor floors at/below the first
  // row. The eligibility id ceiling is `min(coldWatermark, cursor - 1)`: at or
  // below the cold window AND strictly below the fold cursor.
  const idCeiling = Math.min(coldWatermark, cursor - 1);
  if (idCeiling <= 0) {
    return {
      shed: 0,
      batches: 0,
      coldWatermark,
      cursor,
      reclaimedPages: 0,
      moreLikely: false,
    };
  }

  // One prepared statement set, reused across batches. The SELECT picks the next
  // cold shed-class batch by id; the UPDATE NULLs `data` for the SAME ids. Both
  // share the `id <= ceiling AND data IS NOT NULL AND <shed predicate>` cold
  // predicate so a row the SELECT picked is exactly the row the UPDATE clears —
  // internally consistent within the single transaction.
  const selectBatch = db.prepare(
    `SELECT id FROM events
      WHERE id <= ?
        AND data IS NOT NULL
        AND ${RETENTION_SHED_PREDICATE}
      ORDER BY id ASC
      LIMIT ?`,
  );
  const nullBodies = db.prepare(
    `UPDATE events SET data = NULL
      WHERE id IN (SELECT value FROM json_each(?))`,
  );

  let shed = 0;
  let batches = 0;
  let reclaimedPages = 0;
  let lastBatchFull = false;

  for (let i = 0; i < maxBatches; i++) {
    const idRows = selectBatch.all(idCeiling, batchSize) as { id: number }[];
    if (idRows.length === 0) break;
    const ids = idRows.map((r) => r.id);
    const idsJson = JSON.stringify(ids);

    // ONE atomic transaction per batch. `.immediate()` grabs the writer lock at
    // BEGIN so the UPDATE can't lose the upgrade-to-writer race to a concurrent
    // hook write and surface a partial SQLITE_BUSY half-way through (same fix as
    // `migrate()`/`applyEvent`).
    db.transaction(() => {
      nullBodies.run(idsJson);
    }).immediate();

    shed += ids.length;
    batches += 1;
    lastBatchFull = ids.length === batchSize;

    // Return freed overflow pages to the file tail in a bounded chunk — OUTSIDE
    // the batch transaction (incremental_vacuum cannot run inside one), and
    // never one unbounded call (it would materialize the whole freelist into
    // cache → WAL). A no-op on a DB not born with auto_vacuum=INCREMENTAL.
    if (incrementalVacuumPages > 0) {
      const before = freelistPageCount(db);
      db.run(`PRAGMA incremental_vacuum(${incrementalVacuumPages})`);
      const after = freelistPageCount(db);
      reclaimedPages += Math.max(0, before - after);
    }
  }

  return {
    shed,
    batches,
    coldWatermark,
    cursor,
    reclaimedPages,
    moreLikely: batches === maxBatches && lastBatchFull,
  };
}

/** Current freelist page count — the pool `incremental_vacuum` drains. */
function freelistPageCount(db: Database): number {
  const row = db.query("PRAGMA freelist_count").get() as {
    freelist_count?: number;
  } | null;
  return row?.freelist_count ?? 0;
}

/**
 * Count KEEP-SET bodies that went missing — genuine data loss, NOT legitimate
 * retention. Post-shed (fn-836.4) there is no `event_blobs` side table: a body
 * is either inline in `events.data` or intentionally NULLed by retention. NULLing
 * is now an INTENTIONAL outcome for shed-class rows, so the old "absent ⇒ data
 * loss" alarm must NOT fire on a legitimately-shed body.
 *
 * The re-spec'd sentinel flags only a NULL body that is NOT shed-class — i.e. a
 * keep-set event whose body a fold reads but which is missing. Retention can
 * never create that state (its predicate matches ONLY shed-class mutation tools),
 * so a positive count always indicates a bug elsewhere (a stray NULLing write, a
 * corrupt restore). The daemon logs it distinctly from the (large, legitimate)
 * shed count.
 *
 * Header-only `IS NULL` probe: tests nullness via the record header's serial
 * type, never materializing the body (no `COALESCE` — the fn-717.2 overflow-
 * materialization peg). The shed predicate's `json_extract`/`json_valid` are not
 * evaluated here (only `hook_event`/`tool_name` distinguish shed-class from
 * keep-set, both cheap header columns), so a NULL-body row is never re-parsed.
 */
export function countAbsentBlobs(db: Database): number {
  const row = db
    .query(
      // `data IS NULL` reads only the record-header serial type, never any
      // overflow payload. A shed-class mutation row with a NULL body is the
      // INTENDED retention outcome and is excluded; every other NULL body is a
      // keep-set event whose fold-read body has gone missing — data loss.
      `SELECT COUNT(*) AS n
         FROM events
        WHERE data IS NULL
          AND NOT (
                hook_event = 'PostToolUse'
                AND tool_name IN ('Write','Edit','MultiEdit','NotebookEdit')
              )`,
    )
    .get() as { n: number };
  return row.n;
}
