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
 * the subagent PreToolUse:Agent bridge, the reducer's UserPromptSubmit
 * prompt/title/lifecycle inputs, the legacy Agent `tool_response.agentId` fallback, plan Bash
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
import { BACKFILL_WATERMARK_KEY } from "./backfill-mutation-path";
import { MUTATION_TOOL_SQL_PREDICATE } from "./derivers";
import {
  createMaintenanceTimeBudget,
  type MaintenanceTimeBudget,
  runBudgetedMaintenanceLoop,
} from "./maintenance-budget";

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
 * Existing event rows inspected per writable batch, relative to the mutation
 * ceiling. The scan is a primary-key seek over this bounded window; the
 * matching UPDATE/DELETE still affects at most `batchSize` rows.
 */
export const DEFAULT_RETENTION_SCAN_FACTOR = 4;

/**
 * Max transactions per scheduled pass. The shared wall-clock budget is the
 * primary guard; this ceiling stays high enough that cheap batches keep using
 * the budget instead of stopping early on a row-count cap. Each transaction still
 * mutates at most {@link DEFAULT_RETENTION_BATCH_SIZE} rows and yields before the
 * next step, so the writer lock is released throughout a catch-up pass.
 */
export const DEFAULT_RETENTION_MAX_BATCHES = 200;

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
   * Existing rows inspected per batch. Defaults to `batchSize *
   * DEFAULT_RETENTION_SCAN_FACTOR`; the mutation remains capped at `batchSize`.
   */
  scanBatchSize?: number;
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
  /** Highest event id fully examined by the persisted body-shed scan. */
  scanWatermark: number;
  /** Estimated event-id rows left to examine below this pass's active ceiling. */
  remainingScanRows: number;
  /** Estimated scan batches left at the current scan-window size. */
  estimatedRemainingBatches: number;
  /** `true` while the persisted scan watermark remains below this pass's ceiling. */
  moreLikely: boolean;
}

const BODY_SCAN_PROGRESS_KEY = "retention_body_scan_progress";
const NOOP_DELETE_SCAN_PROGRESS_KEY = "retention_noop_delete_scan_progress";
const FOCUS_DELETE_SCAN_PROGRESS_KEY = "retention_focus_delete_scan_progress";

interface StoredScanProgress {
  signature: string;
  watermark: number;
}

interface ColdScanMutationResult {
  moved: number;
  batches: number;
  reclaimedPages: number;
  scanWatermark: number;
  remainingScanRows: number;
  estimatedRemainingBatches: number;
  moreLikely: boolean;
}

type ColdScanMutation = "null-body" | "delete-row";

export interface YieldingRetentionBatchResult {
  /** Transactions executed by this step; the yielding driver accepts at most one. */
  batches: number;
  /** Whether the same surface still has cold history below its current ceiling. */
  moreLikely: boolean;
}

export interface YieldingRetentionBatchOptions {
  /** Maximum one-transaction steps in this event-loop turn sequence. */
  maxBatches?: number;
  /** Shared wall-clock budget checked between transactions. */
  budget?: MaintenanceTimeBudget;
  /** Event-loop yield seam. Tests inject a deterministic observer. */
  yieldTurn?: () => Promise<void>;
  /** Cancellation seam checked before every transaction. */
  shouldContinue?: () => boolean;
}

/**
 * Run one retention surface as one-transaction steps, yielding to the event loop
 * between them. Releasing SQLite's writer lock protects external producers;
 * yielding separately lets MAIN service worker-bridged control RPCs while a
 * historical retention backlog advances.
 */
export async function runYieldingRetentionBatches<
  T extends YieldingRetentionBatchResult,
>(step: () => T, options: YieldingRetentionBatchOptions = {}): Promise<T[]> {
  return runBudgetedMaintenanceLoop(step, {
    maxBatches: options.maxBatches ?? DEFAULT_RETENTION_MAX_BATCHES,
    budget: options.budget,
    yieldTurn: options.yieldTurn,
    shouldContinue: options.shouldContinue,
  });
}

function readMetaValue(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as {
    value: string;
  } | null;
  return row?.value ?? null;
}

/**
 * Read one persisted scan position. The predicate itself is the signature, so a
 * predicate edit automatically restarts the bounded scan instead of silently
 * skipping rows newly admitted by the new class gate.
 */
function readScanProgress(
  db: Database,
  key: string,
  signature: string,
): number {
  const raw = readMetaValue(db, key);
  if (raw == null) return 0;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredScanProgress>;
    if (
      parsed.signature === signature &&
      typeof parsed.watermark === "number" &&
      Number.isSafeInteger(parsed.watermark) &&
      parsed.watermark >= 0
    ) {
      return parsed.watermark;
    }
  } catch {
    // A malformed operational memo restarts the scan from zero; event data is
    // never skipped on an unreadable optimization record.
  }
  return 0;
}

/**
 * Advance one retention/delete surface through bounded primary-key windows.
 * Each transaction mutates at most `batchSize` matching rows and atomically
 * persists the highest fully-examined event id. `NOT INDEXED` is deliberate:
 * SQLite otherwise expands the class predicate through hook-event indexes and
 * sorts the full historical match set before honoring LIMIT.
 */
function mutateColdRowsByScan(
  db: Database,
  options: RetentionOptions,
  input: {
    idCeiling: number;
    predicate: string;
    progressKey: string;
    signature: string;
    mutation: ColdScanMutation;
  },
): ColdScanMutationResult {
  const batchSize = options.batchSize ?? DEFAULT_RETENTION_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_RETENTION_MAX_BATCHES;
  const requestedScanBatchSize =
    options.scanBatchSize ?? batchSize * DEFAULT_RETENTION_SCAN_FACTOR;
  const scanBatchSize = Math.max(batchSize, requestedScanBatchSize);
  for (const [name, value, allowZero] of [
    ["batchSize", batchSize, false],
    ["maxBatches", maxBatches, true],
    ["scanBatchSize", scanBatchSize, false],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
      throw new RangeError(
        `${name} must be a safe ${allowZero ? "non-negative" : "positive"} integer`,
      );
    }
  }

  let scanWatermark = readScanProgress(db, input.progressKey, input.signature);
  if (scanWatermark >= input.idCeiling || maxBatches === 0) {
    const remainingScanRows = Math.max(0, input.idCeiling - scanWatermark);
    return {
      moved: 0,
      batches: 0,
      reclaimedPages: 0,
      scanWatermark,
      remainingScanRows,
      estimatedRemainingBatches: Math.ceil(remainingScanRows / scanBatchSize),
      moreLikely: scanWatermark < input.idCeiling,
    };
  }

  const selectWindow = db.prepare(
    `SELECT COUNT(*) AS n, MAX(id) AS max_id
       FROM (
         SELECT id FROM events NOT INDEXED
          WHERE id > ? AND id <= ?
          ORDER BY id ASC
          LIMIT ?
       )`,
  );
  const selectEligible = db.prepare(
    `SELECT id FROM events NOT INDEXED
      WHERE id > ? AND id <= ?
        AND (${input.predicate})
      ORDER BY id ASC
      LIMIT ?`,
  );
  const mutateWindow = db.prepare(
    input.mutation === "null-body"
      ? `UPDATE events SET data = NULL
          WHERE id > ? AND id <= ?
            AND (${input.predicate})`
      : `DELETE FROM events
          WHERE id > ? AND id <= ?
            AND (${input.predicate})`,
  );
  const writeProgress = db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );

  let moved = 0;
  let batches = 0;
  let reclaimedPages = 0;

  for (let i = 0; i < maxBatches && scanWatermark < input.idCeiling; i++) {
    const window = selectWindow.get(
      scanWatermark,
      input.idCeiling,
      scanBatchSize,
    ) as { n: number; max_id: number | null };
    if (window.n === 0 || window.max_id == null) {
      scanWatermark = input.idCeiling;
      db.transaction(() => {
        writeProgress.run(
          input.progressKey,
          JSON.stringify({
            signature: input.signature,
            watermark: scanWatermark,
          }),
        );
      }).immediate();
      break;
    }

    const candidateEnd =
      window.n < scanBatchSize ? input.idCeiling : window.max_id;
    const eligible = selectEligible.all(
      scanWatermark,
      candidateEnd,
      batchSize,
    ) as Array<{ id: number }>;
    const progressEnd =
      eligible.length === batchSize
        ? (eligible[eligible.length - 1] as { id: number }).id
        : candidateEnd;
    if (progressEnd <= scanWatermark) {
      throw new Error(
        "retention scan failed to advance its primary-key window",
      );
    }

    let changed = 0;
    db.transaction(() => {
      changed = mutateWindow.run(scanWatermark, progressEnd).changes;
      if (changed !== eligible.length) {
        throw new Error(
          `retention scan mutation mismatch: selected ${eligible.length}, changed ${changed}`,
        );
      }
      writeProgress.run(
        input.progressKey,
        JSON.stringify({ signature: input.signature, watermark: progressEnd }),
      );
    }).immediate();

    scanWatermark = progressEnd;
    moved += changed;
    batches += 1;

    const incrementalVacuumPages =
      options.incrementalVacuumPages ?? DEFAULT_INCREMENTAL_VACUUM_PAGES;
    if (changed > 0 && incrementalVacuumPages > 0) {
      const pages = incrementalVacuumPages;
      const before = freelistPageCount(db);
      db.run(`PRAGMA incremental_vacuum(${pages})`);
      const after = freelistPageCount(db);
      reclaimedPages += Math.max(0, before - after);
    }
  }

  const remainingScanRows = Math.max(0, input.idCeiling - scanWatermark);
  return {
    moved,
    batches,
    reclaimedPages,
    scanWatermark,
    remainingScanRows,
    estimatedRemainingBatches: Math.ceil(remainingScanRows / scanBatchSize),
    moreLikely: scanWatermark < input.idCeiling,
  };
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
  const recentRetentionMargin =
    options.recentRetentionMargin ?? RECENT_RETENTION_MARGIN;
  const coldWatermark = computeColdWatermark(db, recentRetentionMargin);
  const cursor = readFoldCursor(db);
  const idCeiling = Math.min(coldWatermark, cursor - 1);
  if (idCeiling <= 0) {
    return {
      shed: 0,
      batches: 0,
      coldWatermark,
      cursor,
      reclaimedPages: 0,
      scanWatermark: 0,
      remainingScanRows: 0,
      estimatedRemainingBatches: 0,
      moreLikely: false,
    };
  }

  // A backfill-watermark change resets this scan signature. A mutation row that
  // becomes retention-eligible after its path is promoted is therefore revisited
  // instead of being stranded behind an optimization watermark.
  const backfillWatermark = readMetaValue(db, BACKFILL_WATERMARK_KEY) ?? "";
  const result = mutateColdRowsByScan(db, options, {
    idCeiling,
    predicate: `data IS NOT NULL AND (${RETENTION_SHED_PREDICATE})`,
    progressKey: BODY_SCAN_PROGRESS_KEY,
    signature: `${RETENTION_SHED_PREDICATE}\nbackfill=${backfillWatermark}`,
    mutation: "null-body",
  });

  return {
    shed: result.moved,
    batches: result.batches,
    coldWatermark,
    cursor,
    reclaimedPages: result.reclaimedPages,
    scanWatermark: result.scanWatermark,
    remainingScanRows: result.remainingScanRows,
    estimatedRemainingBatches: result.estimatedRemainingBatches,
    moreLikely: result.moreLikely,
  };
}

export interface DrainOptions extends RetentionOptions {
  /**
   * Hard ceiling on catch-up passes, a runaway guard. Each pass NULLs up to
   * `maxBatches * batchSize` rows, so `maxPasses` bounds the whole drain at
   * `maxPasses * maxBatches * batchSize` rows. Defaults
   * {@link DEFAULT_DRAIN_MAX_PASSES}. The loop stops once the persisted scan
   * reaches the current cold/cursor ceiling, including across keep-only gaps.
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
   * `true` when the loop stopped on the `maxPasses` runaway guard before a
   * terminal, fully-scanned pass. `false` means the cold scan reached its current
   * cursor/watermark ceiling.
   */
  hitPassCap: boolean;
}

/**
 * Max catch-up passes a single {@link drainColdPayloads} call runs before
 * surrendering to the runaway guard. Sized so the default
 * `maxPasses * maxBatches * batchSize` ceiling (1000 * 200 * 500 = 100M rows)
 * dwarfs any realistic historical backlog — the loop stops once the persisted
 * scan reaches the cold/cursor ceiling. The guard prevents a progress bug from
 * spinning unbounded.
 */
export const DEFAULT_DRAIN_MAX_PASSES = 1_000;

/**
 * Batch count per catch-up pass. The operator drain reuses the high steady-state
 * ceiling but loops full passes synchronously until the persisted scan reaches
 * the cold/cursor ceiling. Still one ≤`batchSize`-row transaction per batch, so
 * the writer lock is released between batches and a concurrent hook INSERT is
 * never starved.
 */
export const DEFAULT_DRAIN_MAX_BATCHES = 200;

/**
 * One-shot catch-up drain: drive {@link retainColdPayloads} to completion,
 * NULLing the entire cold shed-class backlog in ≤`batchSize`-row transactions.
 * Operator catch-up loops the same paced scan until its persisted watermark
 * reaches the cold/cursor ceiling, instead of waiting for scheduled slack
 * heartbeats.
 *
 * Idempotent + resumable by construction: each transaction advances the scan
 * watermark atomically with its body updates, so a re-run continues from the
 * highest fully-examined id. Already-shed rows cannot match `data IS NOT NULL`.
 * Every transaction stays ≤`batchSize` mutations so the writer lock is released
 * between batches.
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
    scanBatchSize: options.scanBatchSize,
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

    // A zero-mutation pass is terminal only once its bounded scan reached the
    // current ceiling; keep-only gaps still advance and continue.
    if (result.shed === 0 && !result.moreLikely) break;
    // Preserve a final zero-mutation observation after the last mutating pass.
    // Callers use that terminal pass as proof the scan is fully drained.
    if (pass === maxPasses) hitPassCap = result.moreLikely;
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
  /** Highest event id fully examined by the persisted delete scan. */
  scanWatermark: number;
  /** Estimated event-id rows left to examine below this pass's active ceiling. */
  remainingScanRows: number;
  /** Estimated scan batches left at the current scan-window size. */
  estimatedRemainingBatches: number;
  /** `true` while the persisted scan watermark remains below this pass's ceiling. */
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
  const recentRetentionMargin =
    options.recentRetentionMargin ?? RECENT_RETENTION_MARGIN;
  const coldWatermark = computeColdWatermark(db, recentRetentionMargin);
  const cursor = readFoldCursor(db);
  const idCeiling = Math.min(coldWatermark, cursor - 1);
  if (idCeiling <= 0) {
    return {
      deleted: 0,
      batches: 0,
      coldWatermark,
      cursor,
      reclaimedPages: 0,
      scanWatermark: 0,
      remainingScanRows: 0,
      estimatedRemainingBatches: 0,
      moreLikely: false,
    };
  }

  // The positive keep predicate stays in the executable gate even though neither
  // current delete class matches it. The signature covers the complete gate, so
  // changing either side restarts the bounded scan automatically.
  const executablePredicate = `(${predicate}) AND NOT (${RETENTION_KEEP_CLASS_PREDICATE})`;
  const progressKey =
    predicate === TMUX_FOCUS_DELETE_PREDICATE
      ? FOCUS_DELETE_SCAN_PROGRESS_KEY
      : NOOP_DELETE_SCAN_PROGRESS_KEY;
  const result = mutateColdRowsByScan(db, options, {
    idCeiling,
    predicate: executablePredicate,
    progressKey,
    signature: executablePredicate,
    mutation: "delete-row",
  });

  return {
    deleted: result.moved,
    batches: result.batches,
    coldWatermark,
    cursor,
    reclaimedPages: result.reclaimedPages,
    scanWatermark: result.scanWatermark,
    remainingScanRows: result.remainingScanRows,
    estimatedRemainingBatches: result.estimatedRemainingBatches,
    moreLikely: result.moreLikely,
  };
}

export interface YieldingRetentionPassOptions extends RetentionOptions {
  /** Shared wall-clock budget checked between transactions and surfaces. */
  budget?: MaintenanceTimeBudget;
  /** Event-loop yield seam. Defaults to `setImmediate`. */
  yieldTurn?: () => Promise<void>;
  /** Cancellation seam checked between transactions and surfaces. */
  shouldContinue?: () => boolean;
}

export interface YieldingRetentionPassResult {
  bodies: RetentionResult;
  noopSnapshots: DeleteResult;
  tmuxFocus: DeleteResult;
  budgetExhausted: boolean;
}

function aggregateRetentionResults(
  results: RetentionResult[],
): RetentionResult | null {
  const last = results.at(-1);
  if (!last) return null;
  return {
    ...last,
    shed: results.reduce((sum, item) => sum + item.shed, 0),
    batches: results.reduce((sum, item) => sum + item.batches, 0),
    reclaimedPages: results.reduce((sum, item) => sum + item.reclaimedPages, 0),
  };
}

function aggregateDeleteResults(results: DeleteResult[]): DeleteResult | null {
  const last = results.at(-1);
  if (!last) return null;
  return {
    ...last,
    deleted: results.reduce((sum, item) => sum + item.deleted, 0),
    batches: results.reduce((sum, item) => sum + item.batches, 0),
    reclaimedPages: results.reduce((sum, item) => sum + item.reclaimedPages, 0),
  };
}

function deferredDeleteResult(
  reference: RetentionResult | DeleteResult,
): DeleteResult {
  return {
    deleted: 0,
    batches: 0,
    coldWatermark: reference.coldWatermark,
    cursor: reference.cursor,
    reclaimedPages: 0,
    scanWatermark: reference.scanWatermark,
    remainingScanRows: reference.remainingScanRows,
    estimatedRemainingBatches: reference.estimatedRemainingBatches,
    moreLikely: true,
  };
}

function defaultRetentionYieldTurn(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Advance all three event-retention surfaces, one transaction per event-loop
 * turn. A yield also separates surfaces when one reaches its ceiling in a
 * single transaction. Returns `null` when shutdown cancellation interrupts the
 * pass, leaving each committed scan watermark ready for the next heartbeat.
 */
export async function runYieldingRetentionPass(
  db: Database,
  options: YieldingRetentionPassOptions = {},
): Promise<YieldingRetentionPassResult | null> {
  const {
    maxBatches = DEFAULT_RETENTION_MAX_BATCHES,
    budget = createMaintenanceTimeBudget(),
    yieldTurn = defaultRetentionYieldTurn,
    shouldContinue = () => true,
    ...retentionOptions
  } = options;
  const driverOptions: YieldingRetentionBatchOptions = {
    maxBatches,
    budget,
    yieldTurn,
    shouldContinue,
  };
  const stepOptions: RetentionOptions = {
    ...retentionOptions,
    maxBatches: 1,
  };

  const bodyResults = await runYieldingRetentionBatches(
    () => retainColdPayloads(db, stepOptions),
    driverOptions,
  );
  const bodies = aggregateRetentionResults(bodyResults);
  if (!bodies || !shouldContinue()) return null;
  if (budget.exhausted()) {
    const deferred = deferredDeleteResult(bodies);
    return {
      bodies,
      noopSnapshots: deferred,
      tmuxFocus: deferred,
      budgetExhausted: true,
    };
  }
  await yieldTurn();
  if (!shouldContinue()) return null;

  const noopResults = await runYieldingRetentionBatches(
    () => deleteNoopSnapshotRows(db, stepOptions),
    driverOptions,
  );
  const noopSnapshots =
    aggregateDeleteResults(noopResults) ?? deferredDeleteResult(bodies);
  if (budget.exhausted()) {
    return {
      bodies,
      noopSnapshots,
      tmuxFocus: deferredDeleteResult(noopSnapshots),
      budgetExhausted: true,
    };
  }
  if (!shouldContinue()) return null;
  await yieldTurn();
  if (!shouldContinue()) return null;

  const focusResults = await runYieldingRetentionBatches(
    () => deleteColdTmuxFocusRows(db, stepOptions),
    driverOptions,
  );
  const tmuxFocus =
    aggregateDeleteResults(focusResults) ?? deferredDeleteResult(noopSnapshots);
  if (!shouldContinue()) return null;
  if (!budget.exhausted()) await yieldTurn();
  if (!shouldContinue()) return null;

  return {
    bodies,
    noopSnapshots,
    tmuxFocus,
    budgetExhausted: budget.exhausted(),
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

/** Body-shed progress log cadence, in committed scan transactions. */
export const RETENTION_SHED_PROGRESS_LOG_BATCHES = 100;

/**
 * Step-latch decision for large body-shed backlog progress. Pure and monotone:
 * callers accumulate committed body-shed batches and log only on a fresh upward
 * step while `moreLikely` remains true, then reset once the scan reaches its
 * ceiling.
 */
export function retentionShedProgressLogStep(
  completedBatches: number,
  lastLoggedStep: number,
  stepBatches: number = RETENTION_SHED_PROGRESS_LOG_BATCHES,
): { shouldLog: boolean; step: number } {
  const step = Math.floor(Math.max(0, completedBatches) / stepBatches);
  return { shouldLog: step > lastLoggedStep, step };
}

/** Bounded daemon log line for large body-shed backlog progress. */
export function formatRetentionShedProgressLogLine(
  result: RetentionResult,
  completedBatches: number,
): string {
  const activeCeiling = Math.max(
    0,
    Math.min(result.coldWatermark, result.cursor - 1),
  );
  return `[keeperd] retention: shed progress ${completedBatches} body batch(es), scan id<=${result.scanWatermark}/${activeCeiling}, ~${result.remainingScanRows} cold row(s) remain (~${result.estimatedRemainingBatches} scan batch(es))`;
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
