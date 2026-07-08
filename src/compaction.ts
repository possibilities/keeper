/**
 * Steady-state retention pass (fn-836.5).
 *
 * keeper's first retention pass, repurposed from the fn-717.2 cold-blob
 * RELOCATOR. The relocator MOVEd cold `events.data` bodies into an `event_blobs`
 * side table (NULLing the hot column) and resolved every read via
 * `COALESCE(events.data, event_blobs.data)` — lossless but never shrinking the
 * DB (the bytes just moved sideways). The fn-836.4 shed DROPPED `event_blobs`
 * and narrowed the canonical fold input: shed-class bodies are no longer read by
 * any fold. The mutation tools' only fold-consumed field
 * (`tool_input.file_path`) is promoted to the `events.mutation_path` column; the
 * other shed classes have no fold-consumed body field at all. So those bodies are
 * now pure redundant transcript archive — safe to NULL IN PLACE, returning their
 * overflow pages to the file via `auto_vacuum=INCREMENTAL` (baked at the .4
 * reclaim).
 *
 * ## What it NULLs — the SHED CLASS, a POSITIVE allow-list of fold-unread classes
 *
 * The shed-set is an explicit POSITIVE allow-list ({@link RETENTION_SHED_CLASS_PREDICATE})
 * of event classes whose `data` BODY no live fold parses — a new/unlisted type
 * defaults to KEPT (the fail-safe direction). Its complement IS the keep-set:
 * every class a live fold reads (snapshot/synthetic folds, session/prompt folds,
 * the subagent PreToolUse:Agent bridge, search-history's UserPromptSubmit
 * `$.prompt`, the legacy Agent `tool_response.agentId` fallback, plan Bash
 * `tool_response.stdout`, …) PLUS PostToolUse:Agent and SubagentStop, kept not for
 * a fold but for deliberate offline-analysis capture of the subagent IO pair. The
 * shed-set spans PostToolUse
 * Write/Edit/MultiEdit/NotebookEdit/Read/WebFetch/Skill/ToolSearch, non-plan
 * PostToolUse:Bash, non-Agent PreToolUse / PostToolUseFailure tool bodies, and
 * SubagentStart/BackendExecSnapshot/Notification. Every keep-set
 * body stays inline forever, so a from-scratch re-fold reads it from
 * `events.data` and reproduces byte-identical projection rows.
 *
 * ## Why retention-then-refold is byte-identical
 *
 * No shed-class body is read by any fold, so NULLing it changes no value a fold
 * sees. The ONE qualifier is mutation-tool-specific: a mutation row's body is
 * dropped only once its `file_path` is captured in `mutation_path` — the
 * {@link RETENTION_SHED_PREDICATE} excludes any mutation row that still owes a
 * backfill (`mutation_path IS NULL` while the body holds a promotable
 * `file_path`). So every file_path a from-scratch re-fold reads off the column
 * was already promoted BEFORE its body was NULLed. The keep-set bodies never
 * move. Therefore retention changes no value any fold reads → projections re-fold
 * byte-identically (the sacred invariant).
 *
 * ## Past the cursor — never strip a body the fold has not yet consumed
 *
 * Retention additionally gates on `id < reducer_state.last_event_id`: a body is
 * stripped only AFTER the fold has already advanced past it. Even though no fold
 * reads a shed-class body (the mutation tools read `mutation_path`, the rest read
 * cheap header columns), the cursor gate is defense-in-depth against any reader
 * that resolves an un-folded body and a hedge against a not-yet-backfilled
 * forward mutation row whose body still carries the only copy of its file_path.
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
import { MUTATION_TOOL_SQL_PREDICATE } from "./derivers";

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
 * The SHED-CLASS retention predicate — a POSITIVE ALLOW-list of event classes
 * whose body no live fold reads, expressed over CHEAP HEADER COLUMNS ONLY
 * (`hook_event` / `tool_name` / `plan_op` — NEVER a
 * `json_extract`). A new or unlisted event type matches NOTHING here and so
 * defaults to KEPT — the fail-safe direction (an unclassified body is never
 * shed). The complement of this set IS the keep-set: every class a live fold
 * parses (snapshot / synthetic folds, session / prompt folds, the subagent
 * PreToolUse:Agent bridge, the legacy Agent `tool_response.agentId` fallback,
 * plan Bash `tool_response.stdout`, the cron `tool_response.id`, …), PLUS two
 * classes kept for deliberate offline-analysis capture rather than any fold read:
 * PostToolUse:Agent (the subagent's final answer, resolvedModel, usage) and
 * SubagentStop (last_assistant_message, effort, agent_transcript_path). Paired
 * with the already-kept PreToolUse:Agent prompt they make every subagent's full
 * IO pair durable and SQL-joinable — no fold reads them, so they are simply
 * absent from the shed allow-list below.
 *
 * The shed-set, each clause justified by an exhaustive fold-read audit:
 *  - PostToolUse Write/Edit/MultiEdit/NotebookEdit — the four mutation tools
 *    whose only fold consumption (`tool_input.file_path`) is promoted to
 *    `mutation_path`; the body is pure transcript archive.
 *  - PostToolUse Read/WebFetch/Skill/ToolSearch — no fold reads their body.
 *  - PostToolUse Bash WHERE `plan_op IS NULL` — a plan Bash row's
 *    `tool_response.stdout` envelope IS fold-read (`extractPlanStateRepo`),
 *    so the inversion KEEPS `plan_op IS NOT NULL` and sheds the rest.
 *  - PreToolUse tool bodies EXCLUDING Agent — the subagent bridge reads the
 *    PreToolUse:Agent body (`findBridgePreToolUse` / `findPendingPreToolUseForStart`).
 *  - PostToolUseFailure tool bodies EXCLUDING Agent — a legacy failure:Agent row
 *    falls back to the `tool_response.agentId` body, so all Agent failures KEEP.
 *  - SubagentStart / BackendExecSnapshot / Notification — their folds read CHEAP
 *    COLUMNS only (`agent_id` / `event_type` / `backend_exec_*`), never the body.
 *
 * Used as the class gate of {@link RETENTION_SHED_PREDICATE} AND inside
 * {@link countAbsentBlobs}'s `NOT(...)`. Cheap-cols only is a hard contract: the
 * sentinel must classify shed-vs-keep on a row whose body is already NULL, so it
 * can never re-parse the (gone) body.
 */
export const RETENTION_SHED_CLASS_PREDICATE = `(
        (hook_event = 'PostToolUse' AND tool_name IN (
           'Write','Edit','MultiEdit','NotebookEdit',
           'Read','WebFetch','Skill','ToolSearch'
         ))
     OR (hook_event = 'PostToolUse' AND tool_name = 'Bash'
           AND plan_op IS NULL)
     OR (hook_event = 'PreToolUse' AND tool_name IS NOT NULL
           AND tool_name != 'Agent')
     OR (hook_event = 'PostToolUseFailure' AND tool_name IS NOT NULL
           AND tool_name != 'Agent')
     OR hook_event IN (
           'SubagentStart','BackendExecSnapshot','Notification'
         )
      )`;

/**
 * The EXPLICIT class-level KEEP invariant — `TmuxTopologySnapshot` rows AND their
 * bodies are retained unconditionally, never shed and never deleted.
 *
 * Crash-restore's topology-anchored deriver reads each snapshot's panes (+ the
 * per-pane `job_id`) straight from the EVENT PAYLOAD of the dying server
 * generation's last `TmuxTopologySnapshot`, so the body is restore's source of
 * truth — NULLing it or deleting the row would silently destroy the anchor.
 *
 * Today the class survives only INCIDENTALLY: it is absent from
 * {@link RETENTION_SHED_CLASS_PREDICATE} (a positive shed allow-list whose
 * complement is the keep-set) AND from {@link NOOP_SNAPSHOT_DELETE_PREDICATE} /
 * {@link TMUX_FOCUS_DELETE_PREDICATE} (the row-delete allow-lists). A future
 * widen of ANY of those could capture it by accident. This positive keep
 * predicate makes the retention contract DEFENSIVE: it is AND-NOTed into the
 * body-NULL gate ({@link RETENTION_SHED_PREDICATE}) AND into every row-delete
 * pass ({@link deleteColdRowsByPredicate}), so the snapshot survives even if a
 * later edit widens a shed/delete allow-list to nominally include it.
 *
 * It also DOMINATES the live-only skip-floor: `TmuxTopologySnapshot` is a
 * live-only fold arm, so a historical (id ≤ floor) snapshot no-ops on re-fold and
 * would otherwise be delete-safe — but the keep guard sits in the SQL shed/delete
 * gates, not the fold, so restore's source survives regardless of the floor.
 *
 * Cheap-column class gate ONLY (a `hook_event` match, never `json_extract`) — the
 * same hard contract as the shed/delete predicates, so it composes into them and
 * into {@link countAbsentBlobs}'s header-only probe without ever re-parsing a body.
 * Unconditional retention is cheap because snapshots are small and change-gated; a
 * generation-aware "last N" prune (which would need a new indexed `generation_id`
 * column) is a deferred follow-up, only if accumulation is ever observed.
 */
export const RETENTION_KEEP_CLASS_PREDICATE = `hook_event = 'TmuxTopologySnapshot'`;

/**
 * The SHED-CLASS retention predicate — the class allow-list AND the
 * mutation-tool backfill guard.
 *
 * A body is eligible to be NULLed iff it is in {@link RETENTION_SHED_CLASS_PREDICATE}
 * AND it does NOT still owe a `mutation_path` backfill. The second clause is the
 * re-fold safety gate: a row still owing a backfill — one of the four mutation
 * tools ({@link MUTATION_TOOL_SQL_PREDICATE}) whose body holds a promotable
 * `file_path` the column does not yet carry (`mutation_path IS NULL AND
 * json_extract(...) IS NOT NULL`) — is the ONE case where the body is still the
 * sole copy of fold-read data, so it is excluded until the backfill promotes it.
 *
 * The guard is scoped to those four tools EXPLICITLY, mirroring
 * {@link extractMutationPath}'s tool gate. It has to be: the shed CLASS is
 * deliberately wider than the mutation tools (Read/WebFetch/Skill/ToolSearch and
 * others), and those non-mutation tools ALSO carry `tool_input.file_path` in
 * their bodies — but they own no `mutation_path` column and no fold reads their
 * body, so their bodies are freely sheddable. Without the tool scope the
 * `json_extract IS NOT NULL` arm fired on every such row and pinned its body
 * inline forever. The `json_extract` is the LONE json parse in the predicate and
 * now only bites the four mutation tools. A malformed / file_path-less mutation
 * body (extract NULL) is freely sheddable — the fold reads NULL either way.
 *
 * Keep-set bodies structurally fail the class match and are NEVER touched. The
 * explicit {@link RETENTION_KEEP_CLASS_PREDICATE} (`TmuxTopologySnapshot`) is
 * AND-NOTed in as a DEFENSIVE backstop: that class is not in the shed allow-list
 * today, but the hard exclusion guarantees a future allow-list widen can never
 * NULL restore's source-of-truth body.
 */
export const RETENTION_SHED_PREDICATE = `${RETENTION_SHED_CLASS_PREDICATE}
   AND NOT (${RETENTION_KEEP_CLASS_PREDICATE})
   AND NOT (
         (${MUTATION_TOOL_SQL_PREDICATE})
         AND mutation_path IS NULL
         AND CASE WHEN json_valid(data)
                  THEN json_extract(data, '$.tool_input.file_path')
             END IS NOT NULL
       )`;

/**
 * The PHYSICAL-DELETE set — a hard-pinned allow-list of THREE event classes
 * whose ROW (not just body) can be deleted with re-fold determinism preserved.
 * MUCH narrower than {@link RETENTION_SHED_CLASS_PREDICATE} (the body-NULL set),
 * and deliberately so: NULLing a fold-unread BODY is always safe, but deleting a
 * ROW skips its fold arm AND removes it from every producer/memo scan on a
 * from-scratch re-fold, so a row is deletable ONLY when its absence cannot
 * change any projection.
 *
 * These three are the retired-to-explicit-no-op fold arms (`src/reducer.ts`
 * BackendExecSnapshot / TmuxPaneSnapshot / WindowIndexSnapshot): each arm touches
 * NO projection, and the rows carry none of the producer-scanned cheap columns
 * (`mutation_path` / `bash_mutation_*` for the git surface, `background_task_id`
 * for `computeMonitors`, `plan_op` for the plan-link folds). So deleting one is
 * indistinguishable from it never having existed — a re-fold over the surviving
 * rows reproduces byte-identical projections.
 *
 * Why NOT the broad shed class: it includes load-bearing ROWS whose BODY is
 * unread but whose ARM / cheap columns are not. SubagentStart/Stop/Turn and
 * modern PostToolUse:Agent mutate `subagent_invocations`; Pre/PostToolUse and
 * Notification mutate `jobs` (clearing api-error / input-request /
 * permission-prompt stamps, flipping `state` stopped→working, stamping
 * `active_since`) in an ORDER-DEPENDENT way; non-plan Bash carries
 * `bash_mutation_*` + `background_task_id`. Deleting any of those diverges a
 * re-fold (empirically: jobs.state working→stopped, last_api_error_at
 * resurrected, last_permission_prompt stamp + active_since lost, a whole
 * subagent_invocations turn vanished). The
 * `physical row deletion is restricted to the no-op-arm snapshot classes` test in
 * test/refold-equivalence.test.ts pins this set so it can never silently widen.
 *
 * Expressed over the cheap `hook_event` column only (no json parse), the same
 * contract as {@link RETENTION_SHED_CLASS_PREDICATE}.
 */
export const NOOP_SNAPSHOT_DELETE_PREDICATE = `hook_event IN (
        'BackendExecSnapshot','TmuxPaneSnapshot','WindowIndexSnapshot'
      )`;

/**
 * The SEPARATELY-NAMED physical-delete predicate for the epic fn-952
 * `TmuxClientFocusSnapshot` cold tail — a distinct symbol from
 * {@link NOOP_SNAPSHOT_DELETE_PREDICATE}, deliberately NOT folded into it.
 *
 * The producer (the `tmux -C` control worker) holds idle volume at zero, but
 * active window/session navigation logs a slow trickle of focus snapshots. Their
 * fold ({@link foldTmuxClientFocusSnapshot} in `src/reducer.ts`) writes ONLY the
 * `tmux_client_focus` LIVE-ONLY singleton (in `LIVE_ONLY_PROJECTIONS`), which is
 * EXCLUDED from the byte-identical re-fold charter — the worker re-bootstraps the
 * singleton from a framed re-read on every connect, so the rows carry no
 * replay-worthy history. The arm reads only the event payload + `event.id` /
 * `event.ts`, and the rows carry NONE of the producer-scanned cheap columns
 * (`mutation_path` / `bash_mutation_*`, `background_task_id`, `plan_op`,
 * `subagent_agent_id`). So deleting a cold focus ROW is indistinguishable from it
 * never having existed: a from-scratch re-fold over the surviving rows reproduces
 * every DETERMINISTIC projection byte-identically (the live-only singleton is
 * outside that charter regardless). The SAFE + NECESSARY pair in
 * test/tmux-focus-compaction.test.ts pins both halves of that contract.
 *
 * Why a DISTINCT symbol, not a widening of {@link NOOP_SNAPSHOT_DELETE_PREDICATE}:
 * that constant is pinned by the `no-op-snapshot delete predicate is pinned to
 * exactly the three retired no-op-arm classes` test in
 * test/refold-equivalence.test.ts to match EXACTLY the three retired no-op-arm
 * classes — a fourth member would fail that guard. The two delete sets are
 * re-fold-safe for INDEPENDENT reasons (no-op fold arm vs. live-only projection),
 * so they stay independent predicates with independent proofs.
 *
 * Expressed over the cheap `hook_event` column only (no json parse), the same
 * contract as {@link NOOP_SNAPSHOT_DELETE_PREDICATE}.
 */
export const TMUX_FOCUS_DELETE_PREDICATE = `hook_event = 'TmuxClientFocusSnapshot'`;

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

export interface DrainOptions extends RetentionOptions {
  /**
   * Hard ceiling on catch-up passes, a runaway guard. Each pass NULLs up to
   * `maxBatches * batchSize` rows, so `maxPasses` bounds the whole drain at
   * `maxPasses * maxBatches * batchSize` rows. Defaults
   * {@link DEFAULT_DRAIN_MAX_PASSES}. The loop normally STOPS earlier — the first
   * pass that sheds nothing means the cold backlog is drained.
   */
  maxPasses?: number;
  /**
   * Optional per-pass progress callback, fired AFTER each pass returns with that
   * pass's {@link RetentionResult} and the 1-based pass number. The operator
   * script logs from here; tests use it to assert pacing. Never reads wall-clock
   * or liveness — a pure observer.
   */
  onPass?: (result: RetentionResult, pass: number) => void;
}

export interface DrainResult {
  /** Total bodies NULLed across every pass (sum of each pass's `shed`). */
  shed: number;
  /** Total transactions (batches) executed across every pass. */
  batches: number;
  /** Number of catch-up passes run (each a full {@link retainColdPayloads}). */
  passes: number;
  /** Total overflow pages returned to the file tail across every pass. */
  reclaimedPages: number;
  /**
   * `true` when the loop stopped on the `maxPasses` runaway guard while the last
   * pass still shed rows — i.e. the backlog may not be fully drained. `false`
   * (the steady case) means a pass shed nothing, so the cold tail is fully
   * drained.
   */
  hitPassCap: boolean;
}

/**
 * Max catch-up passes a single {@link drainColdPayloads} call runs before
 * surrendering to the runaway guard. Sized so the default
 * `maxPasses * maxBatches * batchSize` ceiling (1000 * 200 * 500 = 100M rows)
 * dwarfs any realistic historical backlog — the loop always stops earlier on a
 * shed-nothing pass. It exists only so a logic bug (a row that re-selects
 * forever) cannot spin unbounded.
 */
export const DEFAULT_DRAIN_MAX_PASSES = 1_000;

/**
 * Batch count per catch-up pass — far larger than the steady-state
 * {@link DEFAULT_RETENTION_MAX_BATCHES} (20) because the one-shot catch-up wants
 * to clear the historical backlog promptly, not pace across slack ticks. Still
 * one ≤`batchSize`-row transaction per batch, so the writer lock is released
 * between batches and a concurrent hook INSERT is never starved — only the
 * per-PASS cap is elevated, never the per-TX row count.
 */
export const DEFAULT_DRAIN_MAX_BATCHES = 200;

/**
 * One-shot catch-up drain: drive {@link retainColdPayloads} to completion,
 * NULLing the entire cold shed-class backlog in ≤`batchSize`-row transactions.
 * For the OPERATOR catch-up after a predicate widening (fn-837) — the
 * steady-state 300s timer (≤`DEFAULT_RETENTION_MAX_BATCHES` batches/pass) would
 * take hours to drain a ~600k-row historical backlog. This loops the SAME paced
 * pass with an elevated per-pass batch cap until a pass sheds nothing.
 *
 * Idempotent + resumable BY CONSTRUCTION: each pass re-derives the cold/cursor
 * window and selects only `data IS NOT NULL` rows, so already-shed rows are
 * skipped and a re-run (or a resume after an interrupted run) simply continues
 * from where the freelist stands. NEVER a single giant UPDATE — every tx stays
 * ≤`batchSize` rows so the writer lock is released between batches.
 *
 * Runs on a WRITABLE connection OUTSIDE any fold (same contract as
 * {@link retainColdPayloads}). Does NOT checkpoint the WAL or run the offline
 * VACUUM — the operator script handles the PASSIVE checkpoint + the daemon-
 * stopped `reclaimDb` reclaim around this drain.
 */
export function drainColdPayloads(
  db: Database,
  options: DrainOptions = {},
): DrainResult {
  const maxPasses = options.maxPasses ?? DEFAULT_DRAIN_MAX_PASSES;
  const passOptions: RetentionOptions = {
    batchSize: options.batchSize ?? DEFAULT_RETENTION_BATCH_SIZE,
    maxBatches: options.maxBatches ?? DEFAULT_DRAIN_MAX_BATCHES,
    recentRetentionMargin:
      options.recentRetentionMargin ?? RECENT_RETENTION_MARGIN,
    incrementalVacuumPages:
      options.incrementalVacuumPages ?? DEFAULT_INCREMENTAL_VACUUM_PAGES,
  };

  let shed = 0;
  let batches = 0;
  let reclaimedPages = 0;
  let passes = 0;
  let hitPassCap = false;

  for (let pass = 1; pass <= maxPasses; pass++) {
    const result = retainColdPayloads(db, passOptions);
    passes = pass;
    shed += result.shed;
    batches += result.batches;
    reclaimedPages += result.reclaimedPages;
    options.onPass?.(result, pass);

    // A pass that shed nothing means the cold backlog is fully drained — stop.
    if (result.shed === 0) break;
    // Last allowed pass still shed rows: the runaway guard tripped. The caller
    // re-runs (idempotent) to finish, but flag it so a wrapper can warn.
    if (pass === maxPasses) hitPassCap = true;
  }

  return { shed, batches, passes, reclaimedPages, hitPassCap };
}

export interface DeleteResult {
  /** Number of rows physically DELETEd this pass (sum across batches). */
  deleted: number;
  /** Number of transactions (batches) executed this pass. */
  batches: number;
  /** The cold watermark used this pass (rows at or below were eligible). */
  coldWatermark: number;
  /** The fold cursor at pass start (only rows strictly below it are eligible). */
  cursor: number;
  /** Pages returned to the file tail by per-batch `incremental_vacuum`. */
  reclaimedPages: number;
  /**
   * `true` when a full `maxBatches` ran AND the last batch was full — i.e. more
   * cold no-op-snapshot rows likely remain and the caller may schedule a
   * follow-up pass sooner than the next slack tick.
   */
  moreLikely: boolean;
}

/**
 * PHYSICALLY DELETE cold rows of the no-op-arm snapshot classes
 * ({@link NOOP_SNAPSHOT_DELETE_PREDICATE}), paced — the ROW-growth bound
 * complementing {@link retainColdPayloads}'s body-NULL pass. Re-fold-safe because
 * the three classes' fold arms are no-ops and they carry no producer-scanned
 * column (proven in test/refold-equivalence.test.ts). Batched mechanics +
 * cursor/watermark gate live in {@link deleteColdRowsByPredicate}.
 */
export function deleteNoopSnapshotRows(
  db: Database,
  options: RetentionOptions = {},
): DeleteResult {
  return deleteColdRowsByPredicate(db, NOOP_SNAPSHOT_DELETE_PREDICATE, options);
}

/**
 * PHYSICALLY DELETE the cold `TmuxClientFocusSnapshot` tail
 * ({@link TMUX_FOCUS_DELETE_PREDICATE}), paced — the epic fn-952 sibling of
 * {@link deleteNoopSnapshotRows}. Same MAIN-writable-connection / paced /
 * cursor-gated discipline; NEVER call inside a fold transaction.
 *
 * Re-fold-safe for an INDEPENDENT reason from the no-op-snapshot classes: the
 * focus fold writes ONLY the `tmux_client_focus` LIVE-ONLY singleton (outside the
 * byte-identical re-fold charter, re-bootstrapped by the worker on connect), and
 * the rows carry no producer-scanned cheap column. So deleting a cold focus row
 * leaves every DETERMINISTIC projection byte-identical on a from-scratch re-fold
 * — proven by the SAFE + NECESSARY pair in test/tmux-focus-compaction.test.ts.
 * Kept a DISTINCT predicate (not a widening of
 * {@link NOOP_SNAPSHOT_DELETE_PREDICATE}, whose pinning test allows exactly the
 * three retired no-op-arm classes).
 */
export function deleteColdTmuxFocusRows(
  db: Database,
  options: RetentionOptions = {},
): DeleteResult {
  return deleteColdRowsByPredicate(db, TMUX_FOCUS_DELETE_PREDICATE, options);
}

/**
 * The shared batched-DELETE body behind {@link deleteNoopSnapshotRows} and
 * {@link deleteColdTmuxFocusRows} — the ROW-growth bound complementing
 * {@link retainColdPayloads}'s body-NULL pass. Runs on MAIN's writable
 * connection; NEVER call inside a fold transaction. `predicate` is a TRUSTED
 * INTERNAL `events`-row SQL fragment over the cheap `hook_event` column (a module
 * constant, never caller/user text) selecting a re-fold-safe delete set.
 *
 * Each batch is one transaction: DELETE the next `batchSize` cold matching ids
 * (`id <= coldWatermark AND id < cursor AND <predicate>`). After each batch,
 * `PRAGMA incremental_vacuum(pages)` returns the freed pages to the file tail. The
 * same `id < cursor` + cold-watermark gate as the NULL pass — a row is removed
 * only AFTER the fold has advanced past it, so a forward fold never iterates a row
 * this pass deletes, and a from-scratch re-fold over the surviving rows is
 * byte-identical (the caller's predicate guarantees the delete set is re-fold-safe;
 * proven per-predicate in the test suite).
 *
 * UNLIKE the NULL pass, this is NOT keyed on `data IS NOT NULL`: a row whose body
 * the NULL pass already shed is still DELETE-able (its row overhead is the bytes
 * this pass reclaims). Idempotent across passes — once a row is gone it cannot
 * re-match.
 *
 * The per-batch `incremental_vacuum` only reclaims if the DB was born with
 * `auto_vacuum=INCREMENTAL`; on a non-INCREMENTAL DB the pragma is a no-op and the
 * freed pages sit on the freelist for a later full reclaim (the DELETE removes the
 * row either way — re-fold safety does not depend on the reclaim).
 */
function deleteColdRowsByPredicate(
  db: Database,
  predicate: string,
  options: RetentionOptions = {},
): DeleteResult {
  const batchSize = options.batchSize ?? DEFAULT_RETENTION_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_RETENTION_MAX_BATCHES;
  const recentRetentionMargin =
    options.recentRetentionMargin ?? RECENT_RETENTION_MARGIN;
  const incrementalVacuumPages =
    options.incrementalVacuumPages ?? DEFAULT_INCREMENTAL_VACUUM_PAGES;

  const coldWatermark = computeColdWatermark(db, recentRetentionMargin);
  const cursor = readFoldCursor(db);
  // Same eligibility ceiling as the NULL pass: `min(coldWatermark, cursor - 1)`
  // — at or below the cold window AND strictly below the fold cursor.
  const idCeiling = Math.min(coldWatermark, cursor - 1);
  if (idCeiling <= 0) {
    return {
      deleted: 0,
      batches: 0,
      coldWatermark,
      cursor,
      reclaimedPages: 0,
      moreLikely: false,
    };
  }

  // One prepared statement set, reused across batches. The SELECT picks the next
  // cold matching batch by id; the DELETE removes the SAME ids. Both share the
  // `id <= ceiling AND <predicate>` filter so a row the SELECT picked is exactly
  // the row the DELETE removes. The explicit {@link RETENTION_KEEP_CLASS_PREDICATE}
  // is AND-NOTed in as a DEFENSIVE backstop: no current delete predicate matches
  // `TmuxTopologySnapshot`, but the hard exclusion guarantees a future delete-set
  // widen can never physically remove restore's source-of-truth row.
  const selectBatch = db.prepare(
    `SELECT id FROM events
      WHERE id <= ?
        AND (${predicate})
        AND NOT (${RETENTION_KEEP_CLASS_PREDICATE})
      ORDER BY id ASC
      LIMIT ?`,
  );
  const deleteRows = db.prepare(
    `DELETE FROM events
      WHERE id IN (SELECT value FROM json_each(?))`,
  );

  let deleted = 0;
  let batches = 0;
  let reclaimedPages = 0;
  let lastBatchFull = false;

  for (let i = 0; i < maxBatches; i++) {
    const idRows = selectBatch.all(idCeiling, batchSize) as { id: number }[];
    if (idRows.length === 0) break;
    const ids = idRows.map((r) => r.id);
    const idsJson = JSON.stringify(ids);

    // ONE atomic transaction per batch. `.immediate()` grabs the writer lock at
    // BEGIN so the DELETE can't lose the upgrade-to-writer race to a concurrent
    // hook write (same fix as `retainColdPayloads`/`migrate()`).
    db.transaction(() => {
      deleteRows.run(idsJson);
    }).immediate();

    deleted += ids.length;
    batches += 1;
    lastBatchFull = ids.length === batchSize;

    // Return freed pages to the file tail in a bounded chunk — OUTSIDE the batch
    // transaction (incremental_vacuum cannot run inside one), never one unbounded
    // call. A no-op on a DB not born with auto_vacuum=INCREMENTAL.
    if (incrementalVacuumPages > 0) {
      const before = freelistPageCount(db);
      db.run(`PRAGMA incremental_vacuum(${incrementalVacuumPages})`);
      const after = freelistPageCount(db);
      reclaimedPages += Math.max(0, before - after);
    }
  }

  return {
    deleted,
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
 * Bytes sitting on the freelist — {@link freelistPageCount} pages × the DB page
 * size. This is disk the file already occupies that only a full offline
 * `keeper reclaim` (VACUUM INTO) returns to the filesystem; body-NULLing feeds
 * this pool but the per-batch `incremental_vacuum` trims only the file tail (and
 * is a no-op unless the DB was born `auto_vacuum=INCREMENTAL`). Exported for the
 * daemon's step-latched reclaimable-space log.
 */
export function reclaimableFreelistBytes(db: Database): number {
  const row = db.query("PRAGMA page_size").get() as {
    page_size?: number;
  } | null;
  return freelistPageCount(db) * (row?.page_size ?? 0);
}

/** Step size (bytes) for the reclaimable-freelist observability log. */
export const RECLAIMABLE_LOG_STEP_BYTES = 100 * 1024 * 1024;

/**
 * Step-latch decision for the reclaimable-freelist log. Pure: given the current
 * reclaimable byte pool and the last-logged step index, returns whether to emit a
 * line now and the step index to latch next. Logs ONLY on a fresh upward step
 * crossing — an unconditional per-pass line would grow the very server.stderr this
 * bounds. The returned step lowers when the pool drains (a reclaim), so the caller
 * that latches it lets a later regrowth re-log.
 */
export function reclaimableLogStep(
  reclaimableBytes: number,
  lastLoggedStep: number,
  stepBytes: number = RECLAIMABLE_LOG_STEP_BYTES,
): { shouldLog: boolean; step: number } {
  const step = Math.floor(Math.max(0, reclaimableBytes) / stepBytes);
  return { shouldLog: step > lastLoggedStep, step };
}

/**
 * Keep-set classes whose NULL `data` body is BENIGN — a POSITIVE allow-list of
 * classes the data-loss sentinel ({@link countAbsentBlobs}) must NOT flag even
 * though they sit OUTSIDE the shed allow-list ({@link RETENTION_SHED_CLASS_PREDICATE}).
 *
 * The keep-set is NOT uniformly "a body a fold reads". It splits in two, and only
 * the first half is re-fold data loss when its body goes missing:
 *  - MANDATORY-BODY classes — the body is the SOLE source of a re-fold-critical
 *    value (UserPromptSubmit `$.prompt`, the PreToolUse:Agent bridge, plan Bash
 *    `tool_response.stdout`, TmuxTopologySnapshot panes, a legacy Agent row's
 *    `tool_response.agentId` fallback). A NULL body here IS data loss — deliberately
 *    NOT listed below, so the sentinel keeps flagging it (the fail-safe default: an
 *    unlisted keep-set class stays flagged).
 *  - The classes BELOW — a NULL body is either NEVER re-fold data loss (no fold
 *    reads the body, or the fold reads it only as best-effort NULL-tolerant
 *    enrichment a producer legitimately mints absent) OR — for `Stop` alone — a
 *    BENIGN drop-when-dead divergence the sentinel cannot separate from a
 *    legitimate mint-NULL body (spelled out in the `Stop` clause below).
 *
 * Each clause, justified by the fold-read audit and expressed over CHEAP HEADER
 * COLUMNS ONLY (`hook_event` / `tool_name` / `subagent_agent_id` — the same hard
 * contract as {@link RETENTION_SHED_CLASS_PREDICATE}, since the sentinel classifies
 * a row whose body is already NULL and can never re-parse it):
 *  - `SubagentStop` — its fold reads only `agent_id` + the event `ts`; the body
 *    (last_assistant_message / effort / transcript_path) is offline-analysis
 *    capture, never a fold input.
 *  - `PostToolUse:Agent` WHERE `subagent_agent_id IS NOT NULL` — the modern bridge
 *    resolves the agent id from the cheap `subagent_agent_id` COLUMN, never the body
 *    (final answer / model / usage = offline-analysis capture). The LEGACY variant
 *    (`subagent_agent_id IS NULL`) falls back to the body's `tool_response.agentId`
 *    — mandatory-body, deliberately EXCLUDED from this clause so it stays flagged.
 *  - `ResumeTargetResolved` — a synthetic event whose fold reads only the
 *    `resume_target` COLUMN; it is minted with a NULL body by construction.
 *  - `SessionStart` — the fold reads the body only for best-effort, NULL-tolerant
 *    `transcript_path` enrichment, re-homed from later live activity. An adopted
 *    -harness SessionStart is legitimately minted with a NULL body, folding to the
 *    same safe value a body-carrying row folds to when the field is absent.
 *  - `Stop` — UNLIKE the classes above, a fold DOES read this body: the FINAL
 *    per-session Stop's `data.background_tasks` feeds `computeMonitors` ->
 *    `jobs.monitors` (a byte-identical re-fold charter projection, pinned in
 *    `test/refold-equivalence.test.ts`) plus its derived `has_live_worker_monitor`
 *    readiness fact and the `keeper await` background-task condition. Snapshot
 *    -replace means no later Stop re-derives the surviving value, so a stray-NULLed
 *    body-carrying final Stop IS a genuine re-fold divergence (`monitors` -> `'[]'`).
 *    The class is exempt anyway, for two reasons the cheap-header sentinel cannot
 *    act on:
 *      1. BENIGN divergence — `jobs.monitors` snapshots the session's LIVE OS
 *         shells, which cannot outlive the daemon a from-scratch re-fold reboots,
 *         so `'[]'` is the intended drop-when-dead value (the snapshot paradox).
 *         Every reader (the readiness mutex via `has_live_worker_monitor`, and
 *         `keeper await`) treats absent monitors as done / not-holding, so the
 *         divergence only releases a hold that reality already released — it never
 *         regresses a decision to an unsafe state.
 *      2. INDISTINGUISHABLE from a legitimate mint — a synthetic turn-completion
 *         Stop is minted with a NULL body BY CONSTRUCTION (`mintCodexStop`), and
 *         these vastly outnumber any real loss. Only cheap header columns are
 *         available here (the body is already NULL), and they cannot separate a
 *         born-NULL synthetic Stop from a stray-NULLed one — flagging the class
 *         would be all false positives.
 *
 * Retention's NULL pass is gated on {@link RETENTION_SHED_PREDICATE} (the shed
 * allow-list), so it can NEVER strip a keep-set body — every NULL body in the
 * classes above is a legitimate mint-time absence, not a stripped one.
 */
export const RETENTION_NULL_TOLERANT_KEEP_PREDICATE = `(
        hook_event = 'SubagentStop'
     OR (hook_event = 'PostToolUse' AND tool_name = 'Agent'
           AND subagent_agent_id IS NOT NULL)
     OR hook_event = 'ResumeTargetResolved'
     OR hook_event IN ('SessionStart','Stop')
      )`;

/**
 * Count KEEP-SET bodies that went missing — genuine data loss, NOT legitimate
 * retention. Post-shed (fn-836.4) there is no `event_blobs` side table: a body
 * is either inline in `events.data` or intentionally NULLed by retention. NULLing
 * is now an INTENTIONAL outcome for shed-class rows, so the old "absent ⇒ data
 * loss" alarm must NOT fire on a legitimately-shed body.
 *
 * Three legitimate NULL/absent outcomes the sentinel must tolerate:
 *  - a NULLed BODY of a shed-class row ({@link RETENTION_SHED_CLASS_PREDICATE}) —
 *    the INTENDED retention outcome, excluded via the first `NOT(...)` below;
 *  - a NULL BODY of a NULL-tolerant keep-set class
 *    ({@link RETENTION_NULL_TOLERANT_KEEP_PREDICATE}) — a keep-set class whose body
 *    no fold reads, reads only as mint-absent NULL-tolerant enrichment, or (for
 *    `Stop`) feeds `jobs.monitors` but whose NULLed-body `'[]'` divergence is a
 *    benign drop-when-dead a cheap-header probe cannot separate from a legitimate
 *    mint — excluded via the second `NOT(...)` below;
 *  - a physically ABSENT ROW of a no-op-snapshot class
 *    ({@link NOOP_SNAPSHOT_DELETE_PREDICATE}) — {@link deleteNoopSnapshotRows}
 *    removes these. An absent row carries NO record at all, so it can never
 *    surface as a `data IS NULL` hit — the absent-row case is inherently
 *    invisible to this `COUNT(*)`. (The no-op-snapshot classes are a SUBSET of
 *    the shed class, so a NULLed-but-not-yet-deleted snapshot row is excluded by
 *    the first `NOT(...)` anyway.) Either way an absent/NULL no-op-snapshot row is
 *    never flagged.
 *
 * The sentinel flags only a NULL body that is neither shed-class nor NULL-tolerant
 * keep — i.e. a MANDATORY-BODY keep-set event whose body is the SOLE source of a
 * value a fold reads. Retention's NULL pass matches only the shed allow-list and
 * its DELETE pass removes only no-op-snapshot rows, so neither can create that
 * state — a positive count always indicates a bug elsewhere (a stray NULLing
 * write, a corrupt restore). The daemon logs it distinctly from the (large,
 * legitimate) shed count.
 *
 * Header-only `IS NULL` probe: tests nullness via the record header's serial
 * type, never materializing the body (no `COALESCE`, the overflow-materialization
 * peg). It reuses the CHEAP-COLUMNS-ONLY class allow-lists
 * ({@link RETENTION_SHED_CLASS_PREDICATE} + {@link RETENTION_NULL_TOLERANT_KEEP_PREDICATE}),
 * NOT the full {@link RETENTION_SHED_PREDICATE} (whose `json_extract`/`json_valid`
 * would re-parse a body that is already NULL). Only the cheap header columns
 * distinguish the exempt classes from a mandatory-body keep-set row, so a
 * NULL-body row is never re-parsed.
 */
export function countAbsentBlobs(db: Database): number {
  const row = db
    .query(
      // `data IS NULL` reads only the record-header serial type, never any
      // overflow payload. Two NULL-body populations are legitimate and excluded
      // via cheap-column class predicates: a shed-class row (the INTENDED
      // retention outcome) and a NULL-tolerant keep-set class (no fold reads its
      // body, the fold tolerates a legitimately mint-absent one, or — for `Stop` —
      // the fold reads it but its NULLed-body `'[]'` divergence is a benign
      // drop-when-dead indistinguishable from a legitimate mint). Every REMAINING
      // NULL body is a mandatory-body keep-set event whose sole-source fold input
      // has gone missing — data loss.
      `SELECT COUNT(*) AS n
         FROM events
        WHERE data IS NULL
          AND NOT ${RETENTION_SHED_CLASS_PREDICATE}
          AND NOT ${RETENTION_NULL_TOLERANT_KEEP_PREDICATE}`,
    )
    .get() as { n: number };
  return row.n;
}
