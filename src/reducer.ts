/**
 * Keeper reducer. Folds events into the `jobs` projection.
 *
 * Exactly-once-per-event: every fold of an event into `jobs` and the matching
 * advance of `reducer_state.last_event_id` happen in the SAME `BEGIN IMMEDIATE`
 * transaction, so a crash mid-fold rolls back BOTH and the boot drain re-folds
 * and converges. The invariant `job_id === session_id` (one session per job)
 * holds throughout.
 *
 * Terminal states: `ended` (from SessionEnd) and `killed` (synthetic `Killed`,
 * emitted by the seed sweep / exit-watcher from outside the hook stream when a
 * `(pid, start_time)` pair is proven dead) are both revivable — SessionStart
 * (source=resume) or a bare UserPromptSubmit re-opens them. A stray `Stop` on a
 * still-terminal job is a no-op. The `Killed` fold never re-probes liveness
 * (re-probing would break re-fold determinism — only the producer probes).
 */

import type { Database, SQLQueryBindings } from "bun:sqlite";
import {
  extractBackgroundTasks,
  extractCommit,
  hasLiveWorkerMonitor,
  isKilledTaskNotification,
  type MonitorEntry,
  parsePlanRef,
  planVerbRefFromSpawnName,
} from "./derivers";
import {
  epicIsCompleted,
  profileNameForUsageId,
  projectBasename,
  resolveEpicDep,
  usageIdForProfileName,
} from "./epic-deps";
import {
  type ClassifierInvocation,
  computePlanWindows,
  deriveEpicLinks,
  deriveJobLinks,
  type EpicLink,
  type JobLink,
  normalizePlanctlOp,
  type PlanWindow,
} from "./plan-classifier";
import type { ResolutionDiagnostic } from "./readiness-diagnostics";
import {
  extractTurnSeq,
  findBridgePreToolUse,
  findOpenRunningInGroup,
  findOpenTurnForStop,
  findPendingPreToolUseForStart,
  resolveBridgeAgentId,
} from "./subagent-invocations";
import type {
  ApiErrorKind,
  Epic,
  Event,
  InputRequestKind,
  JobLinkEntry,
  PermissionPromptKind,
  ResolvedEpicDep,
} from "./types";
import { API_ERROR_KINDS } from "./types";

/**
 * Default batch size for {@link drain}. Each event folds in its OWN
 * `BEGIN IMMEDIATE` transaction; the batch only bounds how many transactions
 * run back-to-back before returning to {@link drainToCompletion}, the loop
 * boundary at which a contending hook INSERT reliably wins the writer lock.
 * Small batch = more frequent writer windows for contending hooks without
 * changing throughput (the caller loops until `drain()` returns 0) or re-fold
 * determinism (the batch size is not an input to any projection write).
 */
export const DEFAULT_BATCH_SIZE = 50;

/**
 * Test-only seam. When set, {@link applyEvent} invokes this AFTER the jobs
 * write but BEFORE the cursor advance, still inside the open transaction. A
 * throw from it must roll back the entire transaction (jobs write included),
 * proving the exactly-once invariant. Production code never sets this.
 */
export interface ApplyEventOptions {
  /** Injected throw point between jobs write and cursor advance (tests only). */
  onBeforeCursorAdvance?: (event: Event) => void;
}

/** Terminal job state reached via the SessionEnd hook. Sticky on re-fold. */
const ENDED = "ended";

/**
 * Terminal-but-revivable job state, reached by a synthetic `Killed` event:
 * the process is proven gone from the OUTSIDE (pid no longer exists, or
 * recycled). SessionStart and UserPromptSubmit re-open a killed row; every
 * other hook event leaves it killed.
 */
const KILLED = "killed";

/**
 * Recency bound (unix-SECONDS) for the Stop fold's sub-agent guard. Without it,
 * a one-shot orphan sub-agent that never emits `SubagentStop` would pin its
 * parent at `state='working'` forever (the guard keeps finding the surviving
 * running row) and hold the autopilot mutex open. If the newest surviving
 * `running` sub-agent's `ts` is older than this many seconds relative to the
 * Stop event's `ts`, the guard releases and the Stop fold writes `stopped`.
 *
 * UNIT TRAP: both `events.ts` and `subagent_invocations.ts` are unix-SECONDS;
 * the comparison `event.ts - row.ts` is in seconds — multiplying by 1000 is a
 * 1000x bug. Pure (compile-time constant, no clock/config/meta read), so
 * re-fold determinism holds. Tradeoff: too large pins a stuck sub-agent's mutex
 * longer; too small flashes a slow in-flight sub-agent to `stopped` and clears
 * readiness predicate 5 for a tick.
 */
const MAX_STOP_YIELD_GAP_SEC = 120;

/**
 * Validate an event's `data.kind` against the {@link ApiErrorKind} union;
 * anything not in the allow-list folds to `"unknown"`. Pure (no throws); the
 * fold arm calls it inside the open transaction.
 */
function validateApiErrorKind(raw: unknown): ApiErrorKind {
  if (typeof raw !== "string") {
    return "unknown";
  }
  return API_ERROR_KINDS.has(raw as ApiErrorKind)
    ? (raw as ApiErrorKind)
    : "unknown";
}

/**
 * Parse the `kind` out of an event's `data` blob for the `ApiError` fold arm.
 * Safe-parse: a malformed blob folds to `"unknown"` (never throws inside the
 * fold transaction).
 */
function extractApiErrorKind(event: Event): ApiErrorKind {
  try {
    const parsed = JSON.parse(event.data) as { kind?: unknown };
    return validateApiErrorKind(parsed?.kind);
  } catch {
    return "unknown";
  }
}

/**
 * Canonical `InputRequestKind` allow-list. Mirrors
 * {@link import("./types").InputRequestKind} exactly; if the type widens or
 * narrows the set MUST be updated in lockstep.
 */
const INPUT_REQUEST_KINDS: ReadonlySet<InputRequestKind> = new Set([
  "ask_user_question",
]);

/**
 * Validate an event's `data.kind` against the {@link InputRequestKind} union;
 * anything not in the allow-list folds to `"ask_user_question"` (the
 * single-member union's only value). Pure (no throws); the fold arm calls it
 * inside the open transaction.
 */
function validateInputRequestKind(raw: unknown): InputRequestKind {
  if (typeof raw !== "string") {
    return "ask_user_question";
  }
  return INPUT_REQUEST_KINDS.has(raw as InputRequestKind)
    ? (raw as InputRequestKind)
    : "ask_user_question";
}

/**
 * Parse the `kind` out of an event's `data` blob for the `InputRequest` fold
 * arm. Safe-parse: a malformed blob folds to `"ask_user_question"` (never
 * throws inside the fold transaction).
 */
function extractInputRequestKind(event: Event): InputRequestKind {
  try {
    const parsed = JSON.parse(event.data) as { kind?: unknown };
    return validateInputRequestKind(parsed?.kind);
  } catch {
    return "ask_user_question";
  }
}

/**
 * Canonical `PermissionPromptKind` allow-list. Mirrors
 * {@link import("./types").PermissionPromptKind} exactly; if the type widens or
 * narrows the set MUST be updated in lockstep.
 */
const PERMISSION_PROMPT_KINDS: ReadonlySet<PermissionPromptKind> = new Set([
  "permission",
  "elicitation",
]);

/**
 * Map a `Notification` event's `event_type` onto its canonical
 * {@link PermissionPromptKind}, or `null` for anything outside the allow-list
 * (a strict gate — the arm short-circuits without stamping). Pure (no throws);
 * the fold arm calls it inside the open transaction.
 */
function permissionPromptKindFromEventType(
  eventType: unknown,
): PermissionPromptKind | null {
  if (typeof eventType !== "string") {
    return null;
  }
  if (eventType === "permission_prompt") {
    return "permission";
  }
  if (eventType === "elicitation_dialog") {
    return "elicitation";
  }
  return null;
}

/**
 * Validate a candidate {@link PermissionPromptKind} against the allow-list;
 * returns the validated value or `null` (NEVER throws). A separate helper so a
 * future path carrying a raw kind string routes through the same check.
 */
function validatePermissionPromptKind(
  raw: unknown,
): PermissionPromptKind | null {
  if (typeof raw !== "string") {
    return null;
  }
  return PERMISSION_PROMPT_KINDS.has(raw as PermissionPromptKind)
    ? (raw as PermissionPromptKind)
    : null;
}

/**
 * Title-source precedence; a higher number wins. NULL maps to 0 via
 * {@link sourcePriority}. The reducer writes a new title iff the incoming
 * source outranks the persisted one, OR ties it with a changed value — a
 * lower-priority source NEVER clobbers a higher one.
 */
const TITLE_PRIORITY: Record<string, number> = {
  spawn: 1,
  payload: 2,
  transcript: 3,
};

/** Priority of a persisted/incoming `title_source`; NULL/unknown → 0. */
function sourcePriority(source: string | null): number {
  return source != null ? (TITLE_PRIORITY[source] ?? 0) : 0;
}

/**
 * Extract the top-level `session_title` from an event's `data` blob.
 * Skip-and-log on a malformed blob (the cursor still advances upstream so one
 * bad row never wedges the reducer). Returns the title only when it is a
 * non-empty string, else `null`.
 */
function extractSessionTitle(event: Event): string | null {
  if (event.data && event.data.length > 0) {
    try {
      const parsed = JSON.parse(event.data) as { session_title?: unknown };
      const title = parsed.session_title;
      if (typeof title === "string" && title.length > 0) {
        return title;
      }
    } catch (err) {
      console.error(
        `keeper reducer: failed to parse data blob for event id=${event.id} session=${event.session_id}: ${err}`,
      );
    }
  }
  return null;
}

/**
 * Resolve the title-source for an event carrying a `session_title`: a synthetic
 * `TranscriptTitle` event folds at the priority-3 `'transcript'` source; every
 * other title-bearing event is the priority-2 `'payload'` source.
 */
function titleSourceForEvent(event: Event): string {
  return event.hook_event === "TranscriptTitle" ? "transcript" : "payload";
}

/**
 * Extract the top-level `prompt` from an event's `data` blob — meaningful only
 * on `UserPromptSubmit` events. Skip-and-log on a malformed blob, never throw.
 * Returns the prompt only when it is a non-empty string, else `null`.
 */
function extractPrompt(event: Event): string | null {
  if (event.data && event.data.length > 0) {
    try {
      const parsed = JSON.parse(event.data) as { prompt?: unknown };
      const prompt = parsed.prompt;
      if (typeof prompt === "string" && prompt.length > 0) {
        return prompt;
      }
    } catch (err) {
      console.error(
        `keeper reducer: failed to parse data blob for event id=${event.id} session=${event.session_id}: ${err}`,
      );
    }
  }
  return null;
}

/**
 * Extract the top-level `transcript_path` from a SessionStart event's `data`
 * blob. Skip-and-log on a malformed blob, never throw. Returns the path only
 * when it is a non-empty absolute string, else `null`.
 */
function extractTranscriptPath(event: Event): string | null {
  if (event.data && event.data.length > 0) {
    try {
      const parsed = JSON.parse(event.data) as { transcript_path?: unknown };
      const path = parsed.transcript_path;
      if (typeof path === "string" && path.length > 0 && path.startsWith("/")) {
        return path;
      }
    } catch (err) {
      console.error(
        `keeper reducer: failed to parse data blob for event id=${event.id} session=${event.session_id}: ${err}`,
      );
    }
  }
  return null;
}

/**
 * Shape of a synthetic `Killed` event's payload — the `(pid, start_time)`
 * recycle-safe identity the producer proved dead. The reducer compares this
 * verbatim against the persisted `(jobs.pid, jobs.start_time)` to decide
 * whether the row folds to `killed` (match) or stays put (mismatch / stale).
 */
interface KilledPayload {
  /**
   * The proven-dead process pid, OR `null` for a PIDLESS REAP of a `stopped`
   * row whose persisted `pid IS NULL` (unwatchable, terminal by construction).
   * The Killed fold honors a pidless reap only against a row whose persisted
   * pid is ALSO NULL, so a pidless event can never knock out a row carrying a
   * real watchable pid.
   */
  pid: number | null;
  start_time: string | null;
}

/**
 * Extract the `(pid, start_time)` payload from a synthetic `Killed` event's
 * `data` blob. Skip-and-log on a malformed blob, never throw — the Killed fold
 * falls through as a safe no-op when this returns null.
 *
 * `pid` is either a finite number (the proven-dead pid) OR explicit `null` for
 * a PIDLESS REAP of a NULL-pid `stopped` row. Any OTHER shape is malformed →
 * null. The pidless arm is opt-in via a literal JSON `null`, so a malformed
 * blob can never accidentally trigger a reap. `start_time` is optional /
 * nullable (the producer may emit a Killed for a row whose stored start_time
 * is NULL).
 */
function extractKilledPayload(event: Event): KilledPayload | null {
  if (event.data == null || event.data.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(event.data) as {
      pid?: unknown;
      start_time?: unknown;
    };
    const pid = parsed.pid;
    // Accept a finite number (proven-dead reap) OR an explicit literal `null`
    // (pidless reap). Anything else is malformed → no-op.
    if (pid !== null && (typeof pid !== "number" || !Number.isFinite(pid))) {
      return null;
    }
    const startTime =
      typeof parsed.start_time === "string" ? parsed.start_time : null;
    return { pid: pid as number | null, start_time: startTime };
  } catch (err) {
    console.error(
      `keeper reducer: failed to parse Killed payload blob for event id=${event.id} session=${event.session_id}: ${err}`,
    );
    return null;
  }
}

/**
 * Shape of a folded plan snapshot, extracted from a synthetic `EpicSnapshot` /
 * `TaskSnapshot` event's `data` blob. The producer pre-computes every field, so
 * the reducer folds the blob verbatim (a pure function of the persisted event).
 * Unknown / absent fields surface as `null`. The fields are a union of the epic
 * + task projection columns minus the pk (which rides in `event.session_id`); a
 * given event populates only the subset its kind cares about.
 */
interface PlanSnapshot {
  epic_number?: number | null;
  task_number?: number | null;
  title?: string | null;
  project_dir?: string | null;
  target_repo?: string | null;
  /**
   * Planctl-native effort tier on TaskSnapshot blobs. Stored opaque (the
   * reducer never branches on the value). Read defensively
   * (`snapshot.tier ?? null`) so an older blob folds to a null tier. Rides
   * free in the embedded-tasks JSON; no schema column.
   */
  tier?: string | null;
  epic_id?: string | null;
  status?: string | null;
  /**
   * Derived worker-phase binary on TaskSnapshot blobs (`worker_done_at` present
   * → `"done"`, else `"open"`). A pre-rename blob carries `status` instead; the
   * reducer reads `worker_phase ?? status` for re-fold determinism across the
   * version boundary.
   */
  worker_phase?: string | null;
  /**
   * Planctl-native runtime status (`"todo" | "in_progress" | "done" |
   * "blocked"`). Read defensively (`runtime_status ?? "todo"`) so an older blob
   * still folds deterministically.
   */
  runtime_status?: string | null;
  /** Epic-level deps (EpicSnapshot blob) — the planctl `depends_on_epics` ids. */
  depends_on_epics?: string[] | null;
  /** Task-level deps (TaskSnapshot blob) — the planctl `depends_on` task ids. */
  depends_on?: string[] | null;
  /**
   * Planctl-native `last_validated_at` (EpicSnapshot blob, epic-level only).
   * Absent / NULL folds to `null` so an older blob reproduces the same row
   * across re-fold.
   */
  last_validated_at?: string | null;
}

/**
 * Extract the full plan snapshot from a synthetic `EpicSnapshot` /
 * `TaskSnapshot` event's `data` blob. Skip-and-log on a malformed blob, never
 * throw. Returns `null` on a missing/malformed blob (the caller then makes the
 * fold a no-op for that event).
 */
function extractPlanSnapshot(event: Event): PlanSnapshot | null {
  if (event.data && event.data.length > 0) {
    try {
      return JSON.parse(event.data) as PlanSnapshot;
    } catch (err) {
      console.error(
        `keeper reducer: failed to parse plan snapshot blob for event id=${event.id} entity=${event.session_id}: ${err}`,
      );
    }
  }
  return null;
}

/** Zero-pad an integer to width 6 for `sort_path` keys. */
const zeroPad6 = (n: number): string => String(n).padStart(6, "0");

/**
 * Predicate: is `epicId` an actively-tombstoned epic? `true` when an
 * `EpicDeleted` has been folded for this id WITHOUT a subsequent `EpicSnapshot`
 * clearing it. Centralized so every shell-INSERT site uses the same gate.
 */
function isEpicTombstoned(db: Database, epicId: string): boolean {
  const row = db
    .query("SELECT 1 AS hit FROM epic_tombstones WHERE epic_id = ?")
    .get(epicId) as { hit: number } | null;
  return row != null;
}

/**
 * Shared epic-shell-INSERT helper routing every shell-INSERT site through one
 * tombstone-checking choke-point. The full-scalar `EpicSnapshot` INSERT is NOT
 * a shell site — it is the CLEAR site. When an `EpicDeleted` has been folded
 * for this id without a subsequent `EpicSnapshot` clearing it, the shell-INSERT
 * is suppressed (a `console.error` notes it); otherwise the `sql` + `params`
 * are passed verbatim to `db.run`.
 */
function insertEpicShellIfNotTombstoned(
  db: Database,
  epicId: string,
  sql: string,
  params: SQLQueryBindings[],
): void {
  if (isEpicTombstoned(db, epicId)) {
    // Suppress the shell-INSERT: it would resurrect the deleted epic as a
    // headerless ghost row on `keeper board`. Never throw inside the fold.
    console.error(
      `keeper reducer: shell-INSERT for epic ${epicId} suppressed (epic is tombstoned — would resurrect as scalar-NULL ghost row)`,
    );
    return;
  }
  db.run(sql, params);
}

function projectPlanRow(db: Database, event: Event): void {
  const snapshot = extractPlanSnapshot(event);
  if (snapshot == null) {
    return;
  }
  const ts = event.ts;
  const entityId = event.session_id;

  if (event.hook_event === "EpicSnapshot") {
    // CLEAR the tombstone for this epic_id BEFORE the upsert: a re-creating
    // EpicSnapshot signals the deletion was reverted. Runs UNCONDITIONALLY (a
    // pure function of `hook_event === "EpicSnapshot"`, NOT gated on the
    // ON-CONFLICT carve-out below) so a cursor=0 re-fold produces byte-
    // identical `epic_tombstones` rows. Idempotent: a no-op when no tombstone
    // exists.
    db.run("DELETE FROM epic_tombstones WHERE epic_id = ?", [entityId]);

    // The ON CONFLICT update lists ONLY scalar columns and NEVER `tasks` /
    // `jobs` / `job_links` / `created_by_closer_of` / `sort_path` /
    // `queue_jump` / `resolved_epic_deps`: an epic snapshot carries none of
    // that data, and a shell row inserted by a task/job/planctl-event before
    // the epic already holds those columns. Without the carve-out, an
    // EpicSnapshot re-fold would wipe the provenance, closer-link, sort-path,
    // queue-jump, and resolved-deps projections.
    db.run(
      `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, depends_on_epics, last_validated_at, last_event_id, updated_at, created_by_closer_of, sort_path, queue_jump)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '', 0)
       ON CONFLICT(epic_id) DO UPDATE SET
         epic_number = excluded.epic_number,
         title = excluded.title,
         project_dir = excluded.project_dir,
         status = excluded.status,
         depends_on_epics = excluded.depends_on_epics,
         last_validated_at = excluded.last_validated_at,
         last_event_id = excluded.last_event_id,
         updated_at = excluded.updated_at`,
      [
        entityId,
        snapshot.epic_number ?? null,
        snapshot.title ?? null,
        snapshot.project_dir ?? null,
        snapshot.status ?? null,
        // Stored as a JSON-TEXT array column; a missing list folds to `[]`.
        JSON.stringify(snapshot.depends_on_epics ?? []),
        // A missing / NULL blob value folds to NULL.
        snapshot.last_validated_at ?? null,
        event.id,
        ts,
      ],
    );
    // If `sort_path` is still '' but `epic_number` is now known, derive it so
    // child epics can inherit a non-empty parent path (an EpicSnapshot for a
    // root epic unblocks the chain without a planctl event). Prepend `!` for
    // ROOT epics whose `queue_jump = 1`: `!` (ASCII 33) sorts strictly below
    // the digits under SQLite BINARY collation, lifting a queue-jumped root
    // above non-queued roots. A non-root queue-jumped epic inherits its
    // parent's path, so the root's `!`-prefix propagates for free.
    const spRow = db
      .query(
        "SELECT epic_number, created_by_closer_of, sort_path, queue_jump FROM epics WHERE epic_id = ?",
      )
      .get(entityId) as {
      epic_number: number | null;
      created_by_closer_of: string | null;
      sort_path: string;
      queue_jump: number;
    } | null;
    if (spRow != null && spRow.sort_path === "" && spRow.epic_number != null) {
      const ownNumber = spRow.epic_number;
      let derivedPath: string;
      if (ownNumber >= 1_000_000) {
        derivedPath = "";
      } else if (spRow.created_by_closer_of == null) {
        // Root: stamp `!`-prefix when queue_jump=1; plain zero-padded
        // epic_number otherwise.
        derivedPath =
          spRow.queue_jump === 1
            ? `!${zeroPad6(ownNumber)}`
            : zeroPad6(ownNumber);
      } else {
        const parentRow = db
          .query("SELECT sort_path FROM epics WHERE epic_id = ?")
          .get(spRow.created_by_closer_of) as {
          sort_path: string | null;
        } | null;
        const parentPath = parentRow?.sort_path ?? "";
        derivedPath =
          parentPath === ""
            ? zeroPad6(ownNumber)
            : `${parentPath}.${zeroPad6(ownNumber)}`;
      }
      if (derivedPath !== "") {
        db.run(
          "UPDATE epics SET sort_path = ?, last_event_id = ?, updated_at = ? WHERE epic_id = ?",
          [derivedPath, event.id, ts, entityId],
        );
        cascadeSortPath(db, entityId, event.id, ts);
      }
    }

    // Forward stamp + reverse fan-out for `resolved_epic_deps` +
    // `epic_dep_edges`. The all-epics index is built ONCE and shared across
    // both passes. Order is load-bearing: forward FIRST settles THIS epic's
    // own row, reverse SECOND re-resolves every downstream consumer (whose
    // `depends_on_epics` token matches this epic's full or bare id) against
    // that settled state, so an upstream state flip propagates in lockstep.
    {
      const index = buildEpicIndex(db);
      syncEpicDepsForward(
        db,
        entityId,
        event.id,
        ts,
        index.epicById,
        index.epicsByNumber,
      );
      // Read the upstream's epic_number off the just-settled row. A NULL
      // epic_number makes the reverse lookup skip the bare-id branch but still
      // consider the full id.
      const upstreamRow = db
        .query("SELECT epic_number FROM epics WHERE epic_id = ?")
        .get(entityId) as { epic_number: number | null } | null;
      syncEpicDepsReverse(
        db,
        entityId,
        upstreamRow?.epic_number ?? null,
        event.id,
        ts,
        index.epicById,
        index.epicsByNumber,
      );
    }

    // PRUNE the `armed_epics` row when this epic folds to completion — a `done`
    // epic can't stay armed. Makes the EpicSnapshot fold a SECOND writer of
    // `armed_epics` alongside the EpicArmed-event writer. Like the
    // `epic_tombstones` clear above, this DELETE sits OUTSIDE the ON-CONFLICT
    // carve-out so it fires on EVERY `done` snapshot (a pure function of
    // `hook_event === "EpicSnapshot"` ∧ `status === "done"`), keeping a
    // cursor=0 re-fold byte-identical. STRICT `=== "done"` so a null/missing
    // status no-ops rather than throwing. Idempotent.
    if (snapshot.status === "done") {
      db.run("DELETE FROM armed_epics WHERE epic_id = ?", [entityId]);
    }
  } else {
    // TaskSnapshot: a read-modify-write on the PARENT epic's embedded `tasks`
    // array. The parent key is `snapshot.epic_id` (NOT event.session_id, which
    // is the task pk). An orphan task (null/absent epic_id) can't be placed —
    // skip-and-log, cursor still advances upstream.
    const epicId = snapshot.epic_id ?? null;
    if (epicId == null) {
      console.error(
        `keeper reducer: TaskSnapshot event id=${event.id} task=${entityId} has no epic_id; skipping (orphan)`,
      );
      return;
    }

    // The element shape stored in the array — field-for-field the served Task.
    // The SLOT ORDER of the keys below is load-bearing: `seedFromDb` in
    // `plan-worker.ts` reconstructs `PlanTaskMessage` from this persisted
    // element shape and the change-gate fingerprint is a `JSON.stringify`
    // byte-compare. Any rename or reorder MUST be mirrored on `PlanTaskMessage`
    // + `buildTaskMessage` + `seedFromDb`, or every task re-emits a synthetic
    // snapshot on every daemon boot.
    const element: {
      task_id: string;
      epic_id: string;
      task_number: number | null;
      title: string | null;
      target_repo: string | null;
      tier: string | null;
      worker_phase: string | null;
      runtime_status: string;
      depends_on: string[];
      jobs: unknown[];
    } = {
      task_id: entityId,
      epic_id: epicId,
      task_number: snapshot.task_number ?? null,
      title: snapshot.title ?? null,
      target_repo: snapshot.target_repo ?? null,
      // The slot order across `target_repo` / `tier` / `worker_phase` etc. must
      // match `PlanTaskMessage` / `seedFromDb` / the `TaskElement` shell in
      // `syncJobIntoEpic` — the change-gate `JSON.stringify` byte-compare
      // relies on consistent slot order across all four sites.
      tier: snapshot.tier ?? null,
      // A pre-rename blob carries `status` instead of `worker_phase`; read
      // whichever is present so a re-fold reproduces the same value.
      worker_phase: snapshot.worker_phase ?? snapshot.status ?? null,
      // Absent on older blobs / never-observed state files → folds to `"todo"`
      // per planctl's `merge_task_state` convention.
      runtime_status: snapshot.runtime_status ?? "todo",
      depends_on: snapshot.depends_on ?? [],
      jobs: [],
    };

    const epicRow = db
      .query("SELECT tasks FROM epics WHERE epic_id = ?")
      .get(epicId) as { tasks: string | null } | null;

    // Parse the persisted array. A malformed/NULL blob folds to `[]` — NEVER
    // throw inside the open BEGIN IMMEDIATE transaction (a throw rolls back the
    // cursor and wedges the reducer).
    let tasks: (typeof element)[] = [];
    if (epicRow != null && epicRow.tasks != null && epicRow.tasks.length > 0) {
      try {
        const parsed = JSON.parse(epicRow.tasks);
        if (Array.isArray(parsed)) {
          tasks = parsed;
        }
      } catch {
        // malformed stored array → treat as empty, fall through.
      }
    }

    // Preserve the OLD element's `jobs` sub-array before re-placing: plan-file
    // snapshots carry zero job info and MUST NOT clobber live state. A
    // first-sight task keeps the default `[]`.
    const oldElement = tasks.find((t) => t.task_id === entityId);
    if (oldElement != null && Array.isArray(oldElement.jobs)) {
      element.jobs = oldElement.jobs;
    }

    // Replace-or-insert the element by task_id, then re-sort by
    // (task_number, task_id) — the SAME deterministic key the migration backfill
    // uses, so a migrated row equals a re-folded one. SQLite ORDER BY puts NULLs
    // first; mirror that for task_number, then break ties on task_id ascending.
    const next = tasks.filter((t) => t.task_id !== entityId);
    next.push(element);
    next.sort((a, b) => {
      const an = a.task_number;
      const bn = b.task_number;
      if (an !== bn) {
        if (an == null) return -1;
        if (bn == null) return 1;
        return an - bn;
      }
      return a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0;
    });
    const tasksJson = JSON.stringify(next);

    if (epicRow != null) {
      db.run(
        "UPDATE epics SET tasks = ?, last_event_id = ?, updated_at = ? WHERE epic_id = ?",
        [tasksJson, event.id, ts, epicId],
      );
    } else {
      // No epic row yet — insert a SHELL (epic_id set, scalars NULL, the array
      // carrying this one task). A later EpicSnapshot fills the scalars without
      // clobbering `tasks`. Routed through the tombstone-checking helper so a
      // TaskSnapshot for a deleted epic suppresses the shell rather than
      // resurrecting it as a NULL-scalar ghost.
      insertEpicShellIfNotTombstoned(
        db,
        epicId,
        `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, last_event_id, updated_at, tasks)
           VALUES (?, NULL, NULL, NULL, NULL, ?, ?, ?)`,
        [epicId, event.id, ts, tasksJson],
      );
    }
  }
}

/**
 * Apply a plan-side RETRACTION for one synthetic `EpicDeleted` / `TaskDeleted`
 * tombstone event. Tombstones are the only replay-deterministic way to fold a
 * delete (a file vanishing off disk leaves no event), so the producer emits an
 * explicit tombstone riding the same synthetic-event pipeline as the snapshots.
 *
 * - `EpicDeleted`: `DELETE FROM epics WHERE epic_id = ?` (the embedded `tasks`
 *   array vanishes with the row); entity id in `event.session_id`.
 * - `TaskDeleted`: a read-modify-write on the PARENT epic's embedded array —
 *   splice out the element by `task_id`, re-sort, write back; parent key in the
 *   `data` blob's `epic_id`.
 *
 * Both folds are idempotent no-ops on a missing target and never throw inside
 * the transaction; a malformed stored array folds to `[]`.
 */
function retractPlanRow(db: Database, event: Event): void {
  const entityId = event.session_id;

  if (event.hook_event === "EpicDeleted") {
    // Capture the upstream's epic_number BEFORE the DELETE so the reverse
    // fan-out can re-stamp consumers that depended on the bare-id form — the
    // row is about to vanish, taking `epic_number` with it.
    const pre = db
      .query("SELECT epic_number FROM epics WHERE epic_id = ?")
      .get(entityId) as { epic_number: number | null } | null;
    db.run("DELETE FROM epics WHERE epic_id = ?", [entityId]);
    // Drop the upstream's OWN edges row — its consumer→token index is gone with
    // the row.
    db.run("DELETE FROM epic_dep_edges WHERE consumer_id = ?", [entityId]);
    // MINT a tombstone so every subsequent shell-INSERT site skips the
    // resurrection (without it, a later job-side fold whose `plan_ref` still
    // points at the gone epic would shell-INSERT it back as a NULL-scalar
    // ghost). Mint UNCONDITIONALLY. `ON CONFLICT DO NOTHING` preserves the
    // FIRST observed delete's event id. Rides the SAME transaction as the
    // DELETE + cursor bump; `event.id`, never wall-clock — re-fold determinism.
    db.run(
      "INSERT INTO epic_tombstones (epic_id, deleted_at_event_id) VALUES (?, ?) ON CONFLICT(epic_id) DO NOTHING",
      [entityId, event.id],
    );
    // Reverse fan-out — re-stamp every downstream consumer whose
    // `depends_on_epics` carried this epic's full or bare id; a matching
    // upstream now misses and the entry flips to `dangling`. DELETE FIRST so
    // the resolver observes the missing row; fan-out SECOND.
    if (pre != null) {
      const index = buildEpicIndex(db);
      syncEpicDepsReverse(
        db,
        entityId,
        pre.epic_number,
        event.id,
        event.ts,
        index.epicById,
        index.epicsByNumber,
      );
    }
    return;
  }

  // TaskDeleted: splice the element out of the parent epic's `tasks` array. The
  // parent key is the blob's `epic_id`. A null/absent epic_id can't be placed —
  // no-op.
  const snapshot = extractPlanSnapshot(event);
  const epicId = snapshot?.epic_id ?? null;
  if (epicId == null) {
    return;
  }

  const epicRow = db
    .query("SELECT tasks FROM epics WHERE epic_id = ?")
    .get(epicId) as { tasks: string | null } | null;
  if (epicRow == null) {
    return; // parent already gone (e.g. EpicDeleted folded first) — no-op.
  }

  // Parse the persisted array. A malformed/NULL blob folds to `[]` — NEVER
  // throw inside the open BEGIN IMMEDIATE transaction.
  let tasks: { task_id: string; task_number: number | null }[] = [];
  if (epicRow.tasks != null && epicRow.tasks.length > 0) {
    try {
      const parsed = JSON.parse(epicRow.tasks);
      if (Array.isArray(parsed)) {
        tasks = parsed;
      }
    } catch {
      // malformed stored array → treat as empty, fall through.
    }
  }

  const next = tasks.filter((t) => t.task_id !== entityId);
  if (next.length === tasks.length) {
    // Element wasn't present — idempotent no-op (don't bump the row, so a
    // re-fold of an already-applied delete stays byte-identical).
    return;
  }

  // Re-sort by the same (task_number, task_id) key the snapshot fold uses so
  // the spliced array stays deterministically ordered.
  next.sort((a, b) => {
    const an = a.task_number;
    const bn = b.task_number;
    if (an !== bn) {
      if (an == null) return -1;
      if (bn == null) return 1;
      return an - bn;
    }
    return a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0;
  });
  db.run(
    "UPDATE epics SET tasks = ?, last_event_id = ?, updated_at = ? WHERE epic_id = ?",
    [JSON.stringify(next), event.id, event.ts, epicId],
  );
}

/**
 * Reducer-local view of one entry in the producer's `dirty_files[]` array, with
 * every field defensively re-typed as the safe-fold fallback (the producer is a
 * separate process, so the reducer never trusts shape — every parse path folds
 * to a safe value rather than throw inside the transaction).
 */
interface ReducerDirtyFile {
  path: string;
  xy: string;
  orig_path: string | null;
  mtime_ms: number | null;
  /**
   * Worktree blob oid, staged blob oid, and worktree file mode — frozen-into-
   * payload pure facts (no fold-time git probe, re-fold deterministic). Each
   * parses to `null` independently when the producer couldn't compute it, the
   * event pre-dates the field, or the per-file shape is malformed.
   */
  worktree_oid: string | null;
  index_oid: string | null;
  worktree_mode: string | null;
}

/**
 * Reducer-local view of the file-centric `GitSnapshot` payload
 * (`{project_dir, branch, head_oid, upstream, ahead, behind, dirty_files[]}`).
 * The reducer derives every other facet — per-(session, file) attribution rows,
 * per-job dirty rollup, project-broadcast orphan/unattributed counts, and the
 * rendered `dirty_files[].attributions[]` JSON — inside the transaction against
 * the persisted event log + `file_attributions` table. Historical events stored
 * against the older wide shape still parse (extra keys ignored).
 */
interface ParsedGitSnapshot {
  project_dir: string;
  branch: string | null;
  head_oid: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  dirty_files: ReducerDirtyFile[];
}

function extractGitSnapshot(event: Event): ParsedGitSnapshot | null {
  if (event.data == null || event.data.length === 0) {
    return null;
  }
  let parsed: Partial<ParsedGitSnapshot> & {
    dirty_files?: unknown;
  };
  try {
    parsed = JSON.parse(event.data) as Partial<ParsedGitSnapshot> & {
      dirty_files?: unknown;
    };
  } catch (err) {
    console.error(
      `keeper reducer: failed to parse git snapshot blob for event id=${event.id} project=${event.session_id}: ${err}`,
    );
    return null;
  }
  if (
    typeof parsed.project_dir !== "string" ||
    parsed.project_dir.length === 0
  ) {
    return null;
  }
  // Per-file defensive parse: a bad file folds to `null` (skipped); a bad
  // mtime folds to `null` (no inferred-attribution chance in pass 2). Never
  // throws — the fold tx is sacred.
  const dirtyFiles: ReducerDirtyFile[] = [];
  if (Array.isArray(parsed.dirty_files)) {
    for (const rawFile of parsed.dirty_files as unknown[]) {
      if (typeof rawFile !== "object" || rawFile === null) continue;
      const f = rawFile as Record<string, unknown>;
      if (typeof f.path !== "string" || f.path.length === 0) continue;
      const xy = typeof f.xy === "string" ? f.xy : "";
      const origPath =
        typeof f.orig_path === "string" && f.orig_path.length > 0
          ? f.orig_path
          : null;
      const mtimeMs =
        typeof f.mtime_ms === "number" && Number.isFinite(f.mtime_ms)
          ? f.mtime_ms
          : null;
      // Three per-file content axes, all `string|null` with the defensive
      // parse: a non-string folds to `null`. Oid shape isn't validated here
      // (the producer is the trusted writer); a bad oid round-trips into
      // file_attributions as-is and the discharge gate rejects the comparison,
      // falling back to timestamp discharge.
      const worktreeOid =
        typeof f.worktree_oid === "string" && f.worktree_oid.length > 0
          ? f.worktree_oid
          : null;
      const indexOid =
        typeof f.index_oid === "string" && f.index_oid.length > 0
          ? f.index_oid
          : null;
      const worktreeMode =
        typeof f.worktree_mode === "string" && f.worktree_mode.length > 0
          ? f.worktree_mode
          : null;
      dirtyFiles.push({
        path: f.path,
        xy,
        orig_path: origPath,
        mtime_ms: mtimeMs,
        worktree_oid: worktreeOid,
        index_oid: indexOid,
        worktree_mode: worktreeMode,
      });
    }
  }
  return {
    project_dir: parsed.project_dir,
    branch: typeof parsed.branch === "string" ? parsed.branch : null,
    head_oid: typeof parsed.head_oid === "string" ? parsed.head_oid : null,
    upstream: typeof parsed.upstream === "string" ? parsed.upstream : null,
    ahead: typeof parsed.ahead === "number" ? parsed.ahead : null,
    behind: typeof parsed.behind === "number" ? parsed.behind : null,
    dirty_files: dirtyFiles,
  };
}

/**
 * One row in the per-file attribution materialized view embedded into
 * `git_status.dirty_files[].attributions[]`. The reducer composes this from
 * the join `file_attributions LEFT JOIN jobs USING (session_id)` after
 * the discharge filter (`last_mutation_at > COALESCE(last_commit_at, 0)`),
 * so a session that has discharged its claim on a file is omitted from the
 * file's attribution list — which IS the readiness signal a client renders.
 *
 * `title` / `state` are nullable because the `jobs` row may not yet exist for
 * an attribution (a Write tool fold ran before SessionStart); defaults
 * `state="stopped"` if the join misses.
 */
interface RenderedAttribution {
  session_id: string;
  title: string | null;
  state: string;
  last_touch_at: number;
  op: string;
  source: "tool" | "bash" | "inferred" | "planctl";
}

/**
 * Project the latest `(session_id, file_path)` mutation evidence the persisted
 * event log carries for a given dirty file. Three match modes feed the same
 * `file_attributions` UPSERT in pass 1:
 *
 *   - tool mutations (exact): PostToolUse Write/Edit/MultiEdit/NotebookEdit
 *     whose `tool_input.file_path` matches the dirty file's `path` / `orig_path`;
 *   - bash mutations (exact): PostToolUse:Bash events whose
 *     `bash_mutation_targets` array contains the path — SQL-side `json_each`;
 *   - bash mutations (prefix + fnmatch) for `git-rm` / `git-mv`: targets may
 *     name directories or globs (which SQL can't probe) AND the deleted files
 *     carry `mtime_ms=null` (no pass-2 inference), so candidate rows move to JS
 *     for exact / directory-prefix / fnmatch via `bashTargetMatches`. The
 *     `__TREE__` sentinel is excluded so a tree-mutate can't match real files.
 *
 * Returns one row per session, carrying the LATEST `ts` it saw and the
 * source/op identifying that row; the pass-1 upsert folds these into
 * `file_attributions` newest-wins. Pure: no liveness probe, no FS read, no
 * wall-clock — every fact lives in the `events` table so a from-scratch re-fold
 * reproduces the same row set byte-identically.
 */
interface SessionMutation {
  session_id: string;
  last_mutation_at: number;
  last_event_id: number;
  op: string;
  source: "tool" | "bash" | "planctl";
}

/**
 * The literal `__TREE__` token from `extractBashMutation` — used as the
 * sole `targets[]` entry for git tree-mutators with no pathspec, for
 * `git-rm`/`git-mv` with `--pathspec-from-file=`, and for any pathspec
 * carrying `:`-magic. MUST never prefix- or glob-match a real file path,
 * so the deletion-attribution path explicitly skips it before doing
 * directory-prefix or fnmatch.
 */
const BASH_TREE_SENTINEL = "__TREE__";

/**
 * Module-scope cache of fnmatch token → compiled RegExp. The deletion-
 * attribution path may probe the same stored bash_mutation_targets
 * token across many dirty files within a single snapshot; cache the
 * compiled RegExp so re-compilation cost stays O(distinct tokens).
 * Cleared only on process restart — re-fold determinism is unaffected
 * because the cache value is a pure function of the key.
 */
const FNMATCH_CACHE = new Map<string, RegExp>();

/**
 * Is `token` a glob pattern (contains an unescaped `*` or `?`)?
 * We only compile fnmatch for these — exact + directory-prefix cover
 * the rest and avoid the regex round-trip.
 */
function isGlobToken(token: string): boolean {
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    if (c === 0x2a /* * */ || c === 0x3f /* ? */) return true;
  }
  return false;
}

/**
 * Compile a glob token to an anchored fnmatch RegExp. Dependency-free
 * (the hook forbids third-party imports; we keep the helper reducer-
 * side only, so it never enters the hook's import graph). Mapping:
 *
 *   - `*` → `[^/]*` (NEVER `.*` — `*` does not cross path separators)
 *   - `?` → `[^/]`  (single non-separator char)
 *   - every other regex meta (`. + ( ) [ ] { } ^ $ | \`) is escaped
 *   - anchored with `^` / `$` so a substring can't accidentally match
 *
 * NO `**` recursive-glob support, NO nested quantifiers, NO POSIX
 * character classes — every uncovered pattern degrades to "won't match
 * this token" (the dirty file simply doesn't attribute via that
 * token's row; pass-1 exact + directory-prefix still apply). ReDoS-
 * safe by construction: the regex is a flat sequence of `[^/]*` /
 * `[^/]` / single-char literals, no alternation, no backreferences,
 * no nested quantifiers — worst-case linear in `path.length`.
 */
function compileFnmatch(token: string): RegExp {
  const cached = FNMATCH_CACHE.get(token);
  if (cached !== undefined) return cached;
  let pattern = "^";
  for (let i = 0; i < token.length; i++) {
    const ch = token[i] as string;
    if (ch === "*") {
      pattern += "[^/]*";
    } else if (ch === "?") {
      pattern += "[^/]";
    } else if (
      ch === "." ||
      ch === "+" ||
      ch === "(" ||
      ch === ")" ||
      ch === "[" ||
      ch === "]" ||
      ch === "{" ||
      ch === "}" ||
      ch === "^" ||
      ch === "$" ||
      ch === "|" ||
      ch === "\\"
    ) {
      pattern += `\\${ch}`;
    } else {
      pattern += ch;
    }
  }
  pattern += "$";
  const compiled = new RegExp(pattern);
  FNMATCH_CACHE.set(token, compiled);
  return compiled;
}

/**
 * Does a stored bash_mutation_targets `token` (absolute path or glob)
 * match `candidatePath` (also absolute)? Three modes, in order:
 *
 *   1. Exact: `token === candidatePath` (after stripping any trailing `/`).
 *   2. Directory-prefix: `token` has no glob char AND
 *      `candidatePath === token || candidatePath.startsWith(token + '/')`.
 *      Covers `git rm -r dir/` (post-resolveAgainstCwd: `/repo/dir/`
 *      with slash preserved, or `/repo/dir` without) attributing every
 *      file under `/repo/dir/...`. A trailing `/` on the token is
 *      stripped up-front so both shapes hit the same branch (the deriver
 *      preserves the user's input verbatim, so a slash-terminated
 *      directory pathspec must still match the prefix path).
 *   3. Fnmatch: only if `token` contains `*` or `?`; compile and probe.
 *
 * `__TREE__` is rejected up-front so a tree-wide sentinel can never
 * match a real path — preserving the deriver's contract that the
 * sentinel signals "no pathspec, attribute nothing via this token".
 */
function bashTargetMatches(token: string, candidatePath: string): boolean {
  if (token === BASH_TREE_SENTINEL) return false;
  // Strip a trailing `/` so `git rm -r dir/` (resolveAgainstCwd preserves
  // the slash) hits the directory-prefix branch the same as `git rm -r dir`.
  // Reducer-side normalization keeps locality with the matcher; the
  // deriver still stores the user's verbatim pathspec.
  const normalized =
    token.length > 1 && token.endsWith("/") ? token.slice(0, -1) : token;
  if (normalized === candidatePath) return true;
  if (isGlobToken(normalized)) {
    return compileFnmatch(normalized).test(candidatePath);
  }
  if (normalized.length > 0) {
    if (candidatePath.startsWith(`${normalized}/`)) return true;
  }
  return false;
}

function findExplicitAttributions(
  db: Database,
  projectDir: string,
  file: ReducerDirtyFile,
): SessionMutation[] {
  // Build the candidate path list as ABSOLUTE paths anchored on
  // `projectDir`. The derivers store mutation targets absolutely
  // (`tool_input.file_path` is absolute; bash targets are absolutized
  // against cwd via `resolveAgainstCwd`), whereas `file.path` from the git
  // snapshot is repo-relative — so we must lexically join them here before
  // the equality probe. This is exactly the canonicalization the deriver
  // docstring defers to "the reducer's attribution pass". Lexical join only
  // (no `path.resolve`, no symlink walk) to preserve re-fold determinism.
  // Repo-anchoring keeps the match precise: a bare relative basename could
  // collide with a same-named file in another repo, so we never probe the
  // bare relative form. (`orig_path` covers the rename case — the historical
  // mutation events targeted the OLD name.)
  const trimmedRoot = projectDir.endsWith("/")
    ? projectDir.slice(0, -1)
    : projectDir;
  const paths: string[] = [`${trimmedRoot}/${file.path}`];
  if (file.orig_path != null && file.orig_path !== file.path) {
    paths.push(`${trimmedRoot}/${file.orig_path}`);
  }

  const perSession = new Map<string, SessionMutation>();

  // Tool-mutation scan: PostToolUse rows on the four mutation tool names whose
  // `data.tool_input.file_path` equals a candidate path. Split into two
  // complementary arms (NOT a plain `COALESCE(events.data, event_blobs.data)`)
  // so the common inline case keeps its expression index: COALESCE-ing the
  // `json_extract` predicate would defeat `idx_events_tool_attr` and regress
  // this to a multi-second full scan of every PostToolUse row.
  //
  // A relocated mutation blob is STILL needed here on a from-scratch re-fold:
  // the discharging Commit replays AFTER the GitSnapshot, so at GitSnapshot-fold
  // time a currently-discharged mutation is momentarily live and this scan must
  // see its file_path. "Currently discharged ⇒ safe to drop" is therefore
  // FALSE; the two arms partition the rows (ARM B's `e.data IS NULL` guard) and
  // together equal the COALESCE'd scan, lossless regardless of discharge state.
  for (const candidatePath of paths) {
    // ARM A (inline, indexed): filters `events.data` directly so
    // `idx_events_tool_attr` makes this a sub-ms covering SEEK. Covers every
    // inline blob; a relocated row has `data IS NULL` so this arm misses it
    // (handled by ARM B).
    const toolRows = db
      .prepare(
        `SELECT id, ts, session_id, tool_name
           FROM events
          WHERE hook_event = 'PostToolUse'
            AND tool_name IN ('Write','Edit','MultiEdit','NotebookEdit')
            AND json_extract(data, '$.tool_input.file_path') = ?`,
      )
      .all(candidatePath) as Array<{
      id: number;
      ts: number;
      session_id: string;
      tool_name: string;
    }>;
    // ARM B (relocated): reads `event_blobs.data` for rows whose hot column was
    // NULLed, joining back to `events` for the scalar facts; scans only the
    // small side table. The `CASE WHEN json_valid(b.data) THEN json_extract(...)
    // END` form (NOT a bare `json_extract`) does double duty: it MATCHES the
    // expression index `idx_event_blobs_tool_attr` (so this is a SEEK, not a
    // full JSON-parse scan of the side table per dirty file per fold), AND it
    // skips a malformed relocated blob (yields NULL) instead of throwing
    // "malformed JSON" and crashing the fold. A malformed blob has no parseable
    // file_path, so skipping is re-fold-deterministic.
    const relocatedRows = db
      .prepare(
        `SELECT e.id AS id, e.ts AS ts, e.session_id AS session_id,
                e.tool_name AS tool_name
           FROM event_blobs b
           JOIN events e ON e.id = b.event_id
          WHERE e.data IS NULL
            AND e.hook_event = 'PostToolUse'
            AND e.tool_name IN ('Write','Edit','MultiEdit','NotebookEdit')
            AND CASE WHEN json_valid(b.data)
                     THEN json_extract(b.data, '$.tool_input.file_path')
                END = ?`,
      )
      .all(candidatePath) as Array<{
      id: number;
      ts: number;
      session_id: string;
      tool_name: string;
    }>;
    for (const row of [...toolRows, ...relocatedRows]) {
      if (row.session_id == null || row.session_id.length === 0) continue;
      const existing = perSession.get(row.session_id);
      if (existing == null || row.ts > existing.last_mutation_at) {
        perSession.set(row.session_id, {
          session_id: row.session_id,
          last_mutation_at: row.ts,
          last_event_id: row.id,
          op: row.tool_name,
          source: "tool",
        });
      }
    }
  }

  // Bash-mutation scan: PostToolUse:Bash events whose `bash_mutation_targets`
  // array contains the candidate path. The partial index narrows the scan to
  // the sparse mutation subset before the `json_each` probe.
  for (const candidatePath of paths) {
    const bashRows = db
      .prepare(
        `SELECT e.id, e.ts, e.session_id, e.bash_mutation_kind AS kind
           FROM events e
          WHERE e.bash_mutation_kind IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM json_each(e.bash_mutation_targets) j
               WHERE j.value = ?
            )`,
      )
      .all(candidatePath) as Array<{
      id: number;
      ts: number;
      session_id: string;
      kind: string;
    }>;
    for (const row of bashRows) {
      if (row.session_id == null || row.session_id.length === 0) continue;
      const existing = perSession.get(row.session_id);
      // Break ties on event id (a later row in the same ts has a higher id) so
      // the ordering stays deterministic.
      if (
        existing == null ||
        row.ts > existing.last_mutation_at ||
        (row.ts === existing.last_mutation_at &&
          row.id > existing.last_event_id)
      ) {
        perSession.set(row.session_id, {
          session_id: row.session_id,
          last_mutation_at: row.ts,
          last_event_id: row.id,
          op: row.kind,
          source: "bash",
        });
      }
    }
  }

  // Deletion-attribution scan (git-rm / git-mv): these events store directory
  // and glob tokens an exact SQL probe never hits, and the deleted files carry
  // `mtime_ms=null` (no pass-2 inference). Pull candidate rows into JS and apply
  // exact / directory-prefix / fnmatch via `bashTargetMatches` — pure (no FS,
  // no wall-clock), so re-fold determinism holds.
  const deletionRows = db
    .prepare(
      `SELECT id, ts, session_id, bash_mutation_kind AS kind,
              bash_mutation_targets AS targets
         FROM events
        WHERE bash_mutation_kind IN ('git-rm', 'git-mv')`,
    )
    .all() as Array<{
    id: number;
    ts: number;
    session_id: string;
    kind: string;
    targets: string | null;
  }>;
  for (const row of deletionRows) {
    if (row.session_id == null || row.session_id.length === 0) continue;
    if (row.targets == null || row.targets.length === 0) continue;
    let tokens: unknown;
    try {
      tokens = JSON.parse(row.targets);
    } catch {
      // Malformed JSON folds to "no match" — safe-fold per the reducer's
      // "never throw" invariant.
      continue;
    }
    if (!Array.isArray(tokens)) continue;
    let matched = false;
    for (const rawToken of tokens) {
      if (typeof rawToken !== "string") continue;
      let hit = false;
      for (const candidatePath of paths) {
        if (bashTargetMatches(rawToken, candidatePath)) {
          hit = true;
          break;
        }
      }
      if (hit) {
        matched = true;
        break;
      }
    }
    if (!matched) continue;
    const existing = perSession.get(row.session_id);
    if (
      existing == null ||
      row.ts > existing.last_mutation_at ||
      (row.ts === existing.last_mutation_at && row.id > existing.last_event_id)
    ) {
      perSession.set(row.session_id, {
        session_id: row.session_id,
        last_mutation_at: row.ts,
        last_event_id: row.id,
        op: row.kind,
        source: "bash",
      });
    }
  }

  return Array.from(perSession.values());
}

/**
 * Project inferred attributions for a dirty file by time-bracketing its
 * `mtime_ms` against `(PreToolUse:Bash, PostToolUse:Bash)` intervals in
 * sessions whose `cwd` is inside `project_dir`. Used as a last resort when pass
 * 1 finds NO explicit attributions for the file.
 *
 * The window is `(pre.ts, post.ts]`, matched on the `(session_id, tool_use_id)`
 * pair so concurrent bash invocations don't cross-bracket. `cwd` containment
 * accepts a session whose `cwd` equals or is a subdirectory of `project_dir`;
 * conservative by design (a sub-tree session stays unbracketed — the "stay
 * honest" failure mode).
 *
 * Returns one entry per session whose bracket enclosed the mtime (keeping the
 * LATEST matching post.ts). The pass-2 upsert uses
 * `last_mutation_at = file.mtime_ms / 1000`, NOT the bracket's post.ts, so
 * re-fold determinism rides on the frozen-in-payload mtime.
 */
interface InferredAttribution {
  session_id: string;
  last_event_id: number;
}

/**
 * One `(PreToolUse:Bash, PostToolUse:Bash)` invocation window in a project's
 * sessions — `pre_ts`/`post_ts` are the bracket `(pre.ts, post.ts]` a dirty
 * file's mtime is tested against in {@link inferFromWindows}.
 */
interface BashWindow {
  session_id: string;
  last_event_id: number;
  pre_ts: number;
  post_ts: number;
}

/**
 * Compute every bash window in `projectDir`'s sessions that could bracket SOME
 * dirty-file mtime in `[minMtimeSec, maxMtimeSec]`. HOISTED out of the per-file
 * loop and run ONCE per fold: the `(session_id, tool_use_id)` self-join is
 * expensive, and running it per orphan file once held the write lock long
 * enough to starve hook INSERTs. The mtime-span bound shrinks the scan to a
 * recent slice. Pure read of the immutable event log; the exact per-file
 * bracket is applied in {@link inferFromWindows}, so re-fold determinism holds.
 */
/**
 * Lower-bound slack (seconds) on the `pre.ts` range scan in
 * {@link computeRepoBashWindows}. A bracket is one bash command, hard-capped by
 * the Bash tool's 600s timeout, so any window straddling a file mtime `M` has
 * `pre.ts >= M - 600`; 3600 is a defensive cap above that ceiling. Without a
 * lower bound the self-join scanned the whole `PreToolUse:Bash` history every
 * fold (`pre.ts < maxMtimeSec` alone is non-selective). Loss-free: it only
 * prunes windows longer than the cap, which cannot exist under the tool
 * timeout. Constant ⇒ re-fold deterministic.
 */
const MAX_BASH_WINDOW_SEC = 3600;

function computeRepoBashWindows(
  db: Database,
  projectDir: string,
  minMtimeSec: number,
  maxMtimeSec: number,
): BashWindow[] {
  const projectDirPrefix = projectDir.endsWith("/")
    ? projectDir
    : `${projectDir}/`;
  const rows = db
    .prepare(
      `SELECT post.session_id AS session_id, post.id AS last_event_id,
              pre.ts AS pre_ts, post.ts AS post_ts
         FROM events pre
         JOIN events post
           ON post.session_id = pre.session_id
          AND post.tool_use_id = pre.tool_use_id
          AND post.hook_event = 'PostToolUse'
          AND post.tool_name = 'Bash'
        WHERE pre.hook_event = 'PreToolUse'
          AND pre.tool_name = 'Bash'
          AND pre.tool_use_id IS NOT NULL
          AND pre.ts >= ?
          AND pre.ts < ?
          AND post.ts >= ?
          AND (post.cwd = ? OR post.cwd LIKE ?)`,
    )
    .all(
      minMtimeSec - MAX_BASH_WINDOW_SEC,
      maxMtimeSec,
      minMtimeSec,
      projectDir,
      `${projectDirPrefix}%`,
    ) as Array<{
    session_id: string;
    last_event_id: number;
    pre_ts: number;
    post_ts: number;
  }>;
  const windows: BashWindow[] = [];
  for (const row of rows) {
    if (row.session_id == null || row.session_id.length === 0) continue;
    windows.push(row);
  }
  return windows;
}

/**
 * Apply the exact per-file bracket `(pre.ts, post.ts]` to the precomputed
 * {@link computeRepoBashWindows} set: a window matches iff `pre_ts < mtimeSec
 * <= post_ts`. Take-latest per session by `last_event_id`.
 */
function inferFromWindows(
  windows: readonly BashWindow[],
  mtimeSec: number,
): InferredAttribution[] {
  const perSession = new Map<string, InferredAttribution>();
  for (const w of windows) {
    if (!(w.pre_ts < mtimeSec && w.post_ts >= mtimeSec)) continue;
    const existing = perSession.get(w.session_id);
    if (existing == null || w.last_event_id > existing.last_event_id) {
      perSession.set(w.session_id, {
        session_id: w.session_id,
        last_event_id: w.last_event_id,
      });
    }
  }
  return Array.from(perSession.values());
}

/**
 * Fold one synthetic git snapshot. The reducer never re-runs git; it only
 * persists the observed payload from the event log, keeping re-fold
 * deterministic even though the producer observed mutable filesystem state.
 * Five integrated passes inside the same transaction opened by `applyEvent`:
 *
 *   1. Explicit attribution upsert (tool + bash mutations referencing the dirty
 *      file's path), newest-wins per session, tie-break on event id.
 *   2. Inferred attribution for a dirty file with no explicit attribution:
 *      bracket its mtime against `(PreToolUse:Bash, PostToolUse:Bash)` windows;
 *      `last_mutation_at = mtime_ms / 1000` (frozen-in-payload, so re-fold
 *      deterministic).
 *   3. Render `attributions[]` per file from `file_attributions LEFT JOIN jobs`
 *      under the discharge filter `last_mutation_at > COALESCE(last_commit_at, 0)`.
 *   4. Per-job rollups (`git_dirty_count`, `git_unattributed_to_live_count`
 *      driving readiness predicate 6.5, `git_orphan_count`), fanned into
 *      `epics.jobs[]` / `epics.tasks[].jobs[]` via `syncIfPlanRef`.
 *   5. Symmetric retract on `GitRootDropped` (in `retractGitStatus`).
 *
 * Multi-attribution overcount is intentional: a file attributed to sessions A
 * and B counts toward BOTH `git_dirty_count`s (co-authorship is the honest
 * semantic) — aggregate consumers must NOT sum these as disjoint. The
 * `INSERT OR IGNORE`-then-`UPDATE` per-job rollup tolerates a snapshot
 * referencing a job whose `SessionStart` hasn't folded yet (the UPDATE matches
 * zero rows; the next snapshot lands the counts).
 */
/**
 * Threshold above which a GitSnapshot fold emits a per-pass `[gitfold-breakdown]`
 * line — high enough that normal folds stay silent; only the multi-second
 * outliers that hold the write lock and starve hook INSERTs matter.
 */
const GIT_FOLD_BREAKDOWN_MS = 1000;

function projectGitStatus(db: Database, event: Event): void {
  const snapshot = extractGitSnapshot(event);
  if (snapshot == null) {
    return;
  }
  const eventTs = event.ts;
  const eventId = event.id;
  const projectDir = snapshot.project_dir;

  // Per-pass timing — emitted (below) ONLY when the whole fold is slow. Never
  // persisted, so it has no bearing on re-fold determinism.
  const _gfT0 = performance.now();

  // PASS 1 — Explicit attribution upsert. For each dirty file, scan the event
  // log for tool/bash mutations referencing the path (or its rename's
  // orig_path); newest-wins via the UPSERT's WHERE clause.
  //
  // `worktree_oid` + `worktree_mode` ride the INSERT VALUES so a new row carries
  // them from the start, and a follow-up `refreshWorktreeOidStmt` stamps the
  // latest snapshot's values onto every row for this `file_path`: both are
  // PER-FILE facts, so every row for the same `(project_dir, file_path)` must
  // converge on the freshest snapshot value the discharge gate (in `foldCommit`)
  // reads. The mutation columns keep newer-wins semantics unchanged.
  const upsertStmt = db.prepare(
    `INSERT INTO file_attributions
       (project_dir, session_id, file_path, last_mutation_at, last_commit_at, op, source, last_event_id, updated_at, worktree_oid, worktree_mode)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_dir, session_id, file_path) DO UPDATE SET
         last_mutation_at = excluded.last_mutation_at,
         op = excluded.op,
         source = excluded.source,
         last_event_id = excluded.last_event_id,
         updated_at = excluded.updated_at
       WHERE excluded.last_mutation_at > file_attributions.last_mutation_at`,
  );
  // Stamp the latest snapshot's `worktree_oid` AND `worktree_mode` onto every
  // file_attributions row for this file, AFTER the upsert, so a new row and a
  // stale row both converge on the freshest content axes. Both columns in ONE
  // statement so a mid-statement crash can't desync the pair.
  const refreshWorktreeOidStmt = db.prepare(
    `UPDATE file_attributions
        SET worktree_oid = ?, worktree_mode = ?
      WHERE project_dir = ?
        AND file_path = ?`,
  );
  for (const file of snapshot.dirty_files) {
    const explicit = findExplicitAttributions(db, projectDir, file);
    for (const m of explicit) {
      upsertStmt.run(
        projectDir,
        m.session_id,
        file.path,
        m.last_mutation_at,
        m.op,
        m.source,
        m.last_event_id,
        eventTs,
        file.worktree_oid,
        file.worktree_mode,
      );
    }
    refreshWorktreeOidStmt.run(
      file.worktree_oid,
      file.worktree_mode,
      projectDir,
      file.path,
    );
  }

  const _gfT1 = performance.now();

  // PASS 2 — Inferred attribution. Files with no UNDISCHARGED explicit
  // attribution (and a non-null mtime) get bracketed against Bash intervals;
  // the matching session(s) get an `inferred`-source upsert with
  // `last_mutation_at = file.mtime_ms / 1000` (frozen-in-payload, so re-fold
  // deterministic).
  //
  // The skip guard probes for an explicit row still ACTIVE under the discharge
  // rule — NOT merely the presence of any explicit row. A file whose explicit
  // attributions were all discharged by a commit, then re-dirtied by a bash
  // step that left no recognized mutation, has zero active explicit
  // attributions, so inference MUST run or the file falls to `<orphan>`.
  // Probing the table (just written in pass 1) is what makes the discharge
  // interaction correct.
  const activeExplicitStmt = db.prepare(
    `SELECT 1 FROM file_attributions
      WHERE project_dir = ?
        AND file_path = ?
        AND source IN ('tool', 'bash', 'planctl')
        AND last_mutation_at > COALESCE(last_commit_at, 0)
      LIMIT 1`,
  );
  // Gather the files that actually need inference (no active explicit
  // attribution, non-null mtime) and the mtime span across them, so the bash-
  // window scan runs ONCE for the whole snapshot instead of once per file.
  const inferNeeded: ReducerDirtyFile[] = [];
  let minMtimeSec = Number.POSITIVE_INFINITY;
  let maxMtimeSec = Number.NEGATIVE_INFINITY;
  for (const file of snapshot.dirty_files) {
    if (activeExplicitStmt.get(projectDir, file.path) != null) continue;
    if (file.mtime_ms == null) continue;
    inferNeeded.push(file);
    const mtimeSec = file.mtime_ms / 1000;
    if (mtimeSec < minMtimeSec) minMtimeSec = mtimeSec;
    if (mtimeSec > maxMtimeSec) maxMtimeSec = mtimeSec;
  }
  if (inferNeeded.length > 0) {
    const bashWindows = computeRepoBashWindows(
      db,
      projectDir,
      minMtimeSec,
      maxMtimeSec,
    );
    for (const file of inferNeeded) {
      const mtimeSec = (file.mtime_ms as number) / 1000;
      const inferred = inferFromWindows(bashWindows, mtimeSec);
      for (const m of inferred) {
        // Same UPSERT shape as pass 1 — `worktree_oid` / `worktree_mode` ride
        // the INSERT VALUES and the post-loop refresh keeps existing rows
        // aligned to the freshest snapshot pair.
        upsertStmt.run(
          projectDir,
          m.session_id,
          file.path,
          mtimeSec,
          "inferred",
          "inferred",
          m.last_event_id,
          eventTs,
          file.worktree_oid,
          file.worktree_mode,
        );
      }
      refreshWorktreeOidStmt.run(
        file.worktree_oid,
        file.worktree_mode,
        projectDir,
        file.path,
      );
    }
  }

  const _gfT2 = performance.now();

  // PASS 3 — Render per-file `attributions[]`. `file_attributions LEFT JOIN
  // jobs` under the discharge rule `last_mutation_at > COALESCE(last_commit_at,
  // 0)` (a session that committed past its last mutation drops out), embedded
  // into each dirty file's `attributions[]`. Sorted ASC on `session_id` — the
  // total-order tiebreaker is non-negotiable for byte-identical re-fold.
  const attribStmt = db.prepare(
    `SELECT fa.session_id AS session_id,
            fa.last_mutation_at AS last_touch_at,
            fa.op AS op,
            fa.source AS source,
            j.title AS title,
            j.state AS state
       FROM file_attributions fa
       LEFT JOIN jobs j ON j.job_id = fa.session_id
      WHERE fa.project_dir = ?
        AND fa.file_path = ?
        AND fa.last_mutation_at > COALESCE(fa.last_commit_at, 0)
      ORDER BY fa.session_id ASC`,
  );
  const renderedFiles: Array<
    ReducerDirtyFile & { attributions: RenderedAttribution[] }
  > = [];
  const fileToAttributions = new Map<string, RenderedAttribution[]>();
  for (const file of snapshot.dirty_files) {
    const rows = attribStmt.all(projectDir, file.path) as Array<{
      session_id: string;
      last_touch_at: number;
      op: string;
      source: string;
      title: string | null;
      state: string | null;
    }>;
    const attributions: RenderedAttribution[] = rows.map((r) => ({
      session_id: r.session_id,
      title: r.title,
      // Default `state="stopped"` matches the zero-event projection (jobs row
      // absent ↔ session never observed).
      state: r.state ?? "stopped",
      last_touch_at: r.last_touch_at,
      op: r.op,
      source:
        r.source === "tool" ||
        r.source === "bash" ||
        r.source === "inferred" ||
        r.source === "planctl"
          ? r.source
          : "inferred",
    }));
    renderedFiles.push({ ...file, attributions });
    fileToAttributions.set(file.path, attributions);
  }

  const _gfT3 = performance.now();

  // PASS 4 — Per-job rollups:
  //   (a) `git_orphan_count`: project-wide count of dirty files with ZERO
  //       active attributions.
  //   (b) `git_unattributed_to_live_count`: project-wide count of dirty files
  //       whose attribution set has NO live session (working/stopped); drives
  //       readiness predicate 6.5.
  //   (c) `git_dirty_count`: per-session count of files the session is on the
  //       hook for (active, undischarged attribution).
  // The project-wide counts broadcast onto every session with an active
  // attribution under this project_dir.
  let orphanCount = 0;
  let unattributedToLiveCount = 0;
  const sessionDirtyCount = new Map<string, number>(); // session_id → git_dirty_count
  const LIVE_STATES = new Set(["working", "stopped"]);
  for (const file of snapshot.dirty_files) {
    const attributions = fileToAttributions.get(file.path) ?? [];
    if (attributions.length === 0) {
      orphanCount++;
      unattributedToLiveCount++;
      continue;
    }
    let hasLive = false;
    for (const a of attributions) {
      sessionDirtyCount.set(
        a.session_id,
        (sessionDirtyCount.get(a.session_id) ?? 0) + 1,
      );
      if (LIVE_STATES.has(a.state)) hasLive = true;
    }
    if (!hasLive) unattributedToLiveCount++;
  }

  // Enumerate every session that previously had a count stamped for this
  // project so their counts zero out symmetrically — otherwise a session that
  // committed all its files keeps a stale git_dirty_count. The canonical
  // pre-write enumeration is the prior snapshot's persisted `git_status.jobs`
  // JSON (a first-ever snapshot reads `[]`).
  const priorRow = db
    .prepare("SELECT jobs FROM git_status WHERE project_dir = ?")
    .get(projectDir) as { jobs: string | null } | null;
  const priorSessions = new Set<string>();
  if (priorRow != null && priorRow.jobs != null && priorRow.jobs.length > 0) {
    try {
      const parsed = JSON.parse(priorRow.jobs) as unknown;
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (typeof entry === "object" && entry !== null) {
            const jobId = (entry as { job_id?: unknown }).job_id;
            if (typeof jobId === "string" && jobId.length > 0) {
              priorSessions.add(jobId);
            }
          }
        }
      }
    } catch {
      // malformed prior JSON folds to empty set; never throw inside the fold.
    }
  }
  // Bound pass-4 fan-out to event-relevant sessions: `sessionDirtyCount.keys()`
  // (currently-dirty attributed) ∪ `priorSessions` (the zero-out-transition set
  // from prior git_status.jobs). Safe because any nonzero per-session
  // git_dirty_count was persisted into git_status.jobs in a prior snapshot →
  // is in priorSessions on the next → no stale-count strand. The project-wide
  // counters narrow to the bounded set, which is cosmetic (readiness reads
  // git_status scalars, not the per-job columns).
  const sessionsToFanOut = new Set<string>();
  for (const s of sessionDirtyCount.keys()) sessionsToFanOut.add(s);
  for (const s of priorSessions) sessionsToFanOut.add(s);

  // Stamp counts. UPDATE-only (no shell-row insert): a session whose
  // `SessionStart` hasn't folded yet — the UPDATE matches zero rows
  // safely, the next snapshot after SessionStart lands the counts.
  const jobUpdateStmt = db.prepare(
    `UPDATE jobs
        SET git_dirty_count = ?,
            git_unattributed_to_live_count = ?,
            git_orphan_count = ?,
            last_event_id = ?,
            updated_at = ?
      WHERE job_id = ?`,
  );
  // Sort explicitly so re-fold stays byte-identical irrespective of
  // insertion-order vagaries across drains.
  const sortedSessions = Array.from(sessionsToFanOut).sort();
  // Canonical attribution JSON for the git_status.jobs slot, shape
  // `{job_id, dirty}` so a downstream retract walks the same structure
  // (retractGitStatus reads `job_id` only).
  const projectionJobs: Array<{ job_id: string; dirty: number }> = [];
  const _gfT4 = performance.now();
  for (const sessionId of sortedSessions) {
    const dirtyForSession = sessionDirtyCount.get(sessionId) ?? 0;
    jobUpdateStmt.run(
      dirtyForSession,
      unattributedToLiveCount,
      orphanCount,
      eventId,
      eventTs,
      sessionId,
    );
    // Re-fan into embedded jobs[] — `syncIfPlanRef` reads back the post-write
    // row and routes via `plan_ref`. A session whose UPDATE matched zero rows
    // (no SessionStart yet) returns null and the helper exits without a write.
    syncIfPlanRef(db, sessionId, eventId, eventTs);
    // Persist ONLY currently-dirty sessions into git_status.jobs. The UPDATE +
    // syncIfPlanRef above STILL fire for every session in sortedSessions, so a
    // session leaving the dirty set gets its clearing UPDATE + embedded jobs[]
    // clear exactly once (on the transition snapshot) then drops from the JSON.
    // Without this guard the set ratchets: every ever-dirty session re-persists
    // forever (it becomes the next snapshot's priorSessions). The pure
    // dependency on sessionDirtyCount keeps the decision fold-deterministic.
    if (dirtyForSession > 0) {
      projectionJobs.push({ job_id: sessionId, dirty: dirtyForSession });
    }
  }

  const _gfT5 = performance.now();

  // git_status write — after passes 1-4 populated file_attributions and the
  // per-job rollups. The rendered `dirty_files[].attributions[]` JSON is the
  // materialized view the client reads; `dirty_count` / `orphaned_count` carry
  // the scalars; `jobs` enumerates the canonical attribution set the retract
  // walks. `orphaned_files` ships empty — the strict-mystery orphan set is just
  // `dirty_files where attributions.length == 0`, so a per-file list would
  // duplicate the `orphaned_count` scalar.
  db.run(
    `INSERT INTO git_status (
       project_dir, branch, head_oid, upstream, ahead, behind,
       dirty_count, orphaned_count, dirty_files, orphaned_files, jobs,
       last_event_id, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_dir) DO UPDATE SET
       branch = excluded.branch,
       head_oid = excluded.head_oid,
       upstream = excluded.upstream,
       ahead = excluded.ahead,
       behind = excluded.behind,
       dirty_count = excluded.dirty_count,
       orphaned_count = excluded.orphaned_count,
       dirty_files = excluded.dirty_files,
       orphaned_files = excluded.orphaned_files,
       jobs = excluded.jobs,
       last_event_id = excluded.last_event_id,
       updated_at = excluded.updated_at`,
    [
      projectDir,
      snapshot.branch,
      snapshot.head_oid,
      snapshot.upstream,
      snapshot.ahead,
      snapshot.behind,
      snapshot.dirty_files.length,
      orphanCount,
      JSON.stringify(renderedFiles),
      JSON.stringify([]),
      JSON.stringify(projectionJobs),
      eventId,
      eventTs,
    ],
  );

  // Slow-fold breakdown — localizes a [fold-slow] GitSnapshot to a pass. Only
  // emitted above the threshold so steady folds stay silent. nfiles/nsessions
  // give the fan-out cardinality alongside the per-pass wall times.
  const _gfTotal = performance.now() - _gfT0;
  if (_gfTotal >= GIT_FOLD_BREAKDOWN_MS) {
    console.error(
      `[gitfold-breakdown] id=${eventId} total=${_gfTotal.toFixed(0)}ms ` +
        `nfiles=${snapshot.dirty_files.length} nsessions=${sortedSessions.length} ` +
        `pass1_explicit=${(_gfT1 - _gfT0).toFixed(0)}ms ` +
        `pass2_inferred=${(_gfT2 - _gfT1).toFixed(0)}ms ` +
        `pass3_render=${(_gfT3 - _gfT2).toFixed(0)}ms ` +
        `pass4_rollup=${(_gfT4 - _gfT3).toFixed(0)}ms ` +
        `fanout=${(_gfT5 - _gfT4).toFixed(0)}ms ` +
        `write=${(performance.now() - _gfT5).toFixed(0)}ms`,
    );
  }
}

/**
 * Fold one synthetic `GitRootDropped` tombstone. The git-worker posts this when
 * a watched worktree no longer satisfies the watch gate; without it,
 * `projectGitStatus`'s UPSERT-only path would leak the final pre-drop snapshot
 * row forever.
 *
 * The primary key (`project_dir`) rides in `event.session_id`. An empty /
 * missing pk is a safe no-op — fold must never throw inside the cursor-advance
 * transaction. DELETE is idempotent.
 *
 * Symmetric clear: before the DELETE, read the row's persisted `git_status.jobs`
 * JSON to enumerate the job_ids the last fan-out stamped, zero each one's
 * `git_dirty_count` / `git_unattributed_to_live_count` / `git_orphan_count`, and
 * re-emit the `syncJobIntoEpic` fan-out so the embedded arrays clear in lockstep
 * — walking the SAME `jobs[]` the write side fanned over keeps an unrelated
 * project's jobs untouched. The retract also DELETEs every `file_attributions`
 * row for this `project_dir`; a re-fold re-creates and re-deletes them across
 * the snapshot + retract pair, preserving byte-identical re-fold.
 */
function retractGitStatus(db: Database, event: Event): void {
  const projectDir = event.session_id;
  if (projectDir == null || projectDir.length === 0) {
    return;
  }
  // Pre-DELETE: read the stored `jobs` JSON to enumerate the job_ids the last
  // fan-out stamped. A missing / empty / malformed value folds to `[]` — never
  // throw inside the fold.
  const row = db
    .query("SELECT jobs FROM git_status WHERE project_dir = ?")
    .get(projectDir) as { jobs: string | null } | null;
  if (row != null && row.jobs != null && row.jobs.length > 0) {
    let attributedJobs: Array<{ job_id?: unknown }> = [];
    try {
      const parsed = JSON.parse(row.jobs);
      if (Array.isArray(parsed)) {
        attributedJobs = parsed as Array<{ job_id?: unknown }>;
      }
    } catch {
      // malformed stored array → treat as empty, fall through to DELETE.
    }
    for (const job of attributedJobs) {
      const jobId = job.job_id;
      if (typeof jobId !== "string" || jobId.length === 0) {
        continue;
      }
      db.run(
        "UPDATE jobs SET git_dirty_count = 0, git_unattributed_to_live_count = 0, git_orphan_count = 0, last_event_id = ?, updated_at = ? WHERE job_id = ?",
        [event.id, event.ts, jobId],
      );
      syncIfPlanRef(db, jobId, event.id, event.ts);
    }
  }
  // Also drop every file_attributions row for this project_dir — symmetric with
  // the projectGitStatus pass-1/2 upserts.
  db.run("DELETE FROM file_attributions WHERE project_dir = ?", [projectDir]);
  db.run("DELETE FROM git_status WHERE project_dir = ?", [projectDir]);
}

/**
 * Fold one synthetic `Commit` event. The git-worker emits one per commit in a
 * HEAD-oid delta; main lifts the message into the synthetic event row this arm
 * reads.
 *
 * Discharge target: `committer_session_id` non-null discharges only the
 * committing session's `(project_dir, session_id, file_path)` row; null (a
 * human / CI commit with no `Session-Id:` trailer) discharges every session's
 * claim on the named files.
 *
 * Content-aware gate: for each file, compare the commit's `blob_oid` +
 * `committed_mode` against the file's `worktree_oid` + `worktree_mode` on the
 * `file_attributions` row (written by the latest GitSnapshot fold).
 *   - All four non-null AND both pairs match → STAMP `last_commit_at` (the
 *     commit captured the worktree; the session is off-the-hook).
 *   - All four non-null AND either pair mismatches → DO NOTHING (the worktree
 *     diverged; the session stays on-the-hook — the stage→re-edit→commit case).
 *   - ANY axis NULL → UNCONDITIONAL timestamp discharge. This is the path
 *     pre-content-gate events traversed, so a cursor=0 re-fold over NULL-oid /
 *     NULL-mode history reproduces byte-identical projections. The gate only
 *     kicks in when both sides carry non-null evidence, leaving historical
 *     re-folds untouched.
 *
 * The UPDATE matches zero rows when no session has recorded a mutation on the
 * file (a discharge can't resurrect a non-existent attribution). Producer-only
 * liveness: reads ONLY payload fields and the already-folded (in-tx)
 * `file_attributions` row — no `git log` re-shell, no FS probe — so a
 * from-scratch re-fold reproduces `last_commit_at` deterministically. A
 * malformed payload folds to a safe no-op via {@link extractCommit}.
 */
function foldCommit(db: Database, event: Event): void {
  const commit = extractCommit(event);
  if (commit == null) {
    return;
  }
  if (commit.files.length === 0) {
    // A commit with no files (empty commit via `--allow-empty`, or a
    // commit whose file-list shell-out returned empty) has nothing to
    // discharge. Safe no-op.
    return;
  }
  // Convert producer-side milliseconds to projection-table seconds. The
  // file_attributions schema (see `src/db.ts:631`) stores REAL unix-
  // seconds for `last_mutation_at` / `last_commit_at`, mirroring every
  // other projection table; the producer carries milliseconds for
  // JS-side ergonomics. Single multiplication, safe-fold on zero (the
  // extractCommit defensive parser folds a bad ts to 0 → discharge
  // timestamp would be 0, indistinguishable from "never committed" in
  // the readiness inequality; accepted lossiness on a malformed
  // payload that should never occur in steady state).
  const lastCommitAtSeconds = commit.committed_at_ms / 1000;
  const eventTs = event.ts;
  const eventId = event.id;

  // Helper: should the content-aware gate suppress discharge for this
  // `(project_dir, file_path)`? Returns `true` (KEEP attribution) when both
  // (oid, mode) pairs differ from the file's stored worktree values (the
  // worktree diverged). Returns `false` (DISCHARGE) when any axis is NULL
  // (legacy timestamp fall-back — re-fold determinism over historical events)
  // or all four are non-null and both pairs match. The read targets the
  // in-tx, event-derived `file_attributions` projection.
  const worktreeProbeStmt = db.prepare(
    `SELECT worktree_oid, worktree_mode FROM file_attributions
      WHERE project_dir = ? AND file_path = ? LIMIT 1`,
  );
  function shouldSkipDischarge(
    projectDir: string,
    filePath: string,
    committedOid: string | null,
    committedMode: string | null,
  ): boolean {
    if (committedOid === null || committedMode === null) {
      // No content evidence — unconditional timestamp discharge.
      return false;
    }
    // worktree_oid / worktree_mode is a per-file fact — every attribution row
    // for `(project_dir, file_path)` carries the SAME pair, so LIMIT 1 is safe.
    const row = worktreeProbeStmt.get(projectDir, filePath) as
      | { worktree_oid: string | null; worktree_mode: string | null }
      | null
      | undefined;
    if (row == null) {
      // No attribution row yet — the discharging UPDATE matches zero rows
      // anyway; fall through (safe no-op).
      return false;
    }
    if (row.worktree_oid === null || row.worktree_mode === null) {
      // No content-aware GitSnapshot folded yet for this file — fall back to
      // unconditional timestamp discharge (re-fold determinism).
      return false;
    }
    // All four axes non-null: suppress discharge only when either pair
    // MISMATCHES (the worktree diverged); when both MATCH, discharge.
    return (
      row.worktree_oid !== committedOid || row.worktree_mode !== committedMode
    );
  }

  if (commit.committer_session_id !== null) {
    // Per-session discharge: only the committing session clears its claim. Other
    // sessions that touched these files (multi-attribution) stay on-the-hook
    // until they commit too.
    const stmt = db.prepare(
      `UPDATE file_attributions
          SET last_commit_at = ?, last_event_id = ?, updated_at = ?
        WHERE project_dir = ?
          AND session_id = ?
          AND file_path = ?`,
    );
    // Content-aware gate. When it suppresses, skip the UPDATE entirely —
    // `last_mutation_at` is unchanged, so the row stays attributed via the
    // (mutation > commit) discharge inequality.
    for (const entry of commit.files) {
      const filePath = entry.path;
      if (typeof filePath !== "string" || filePath.length === 0) continue;
      if (
        shouldSkipDischarge(
          commit.project_dir,
          filePath,
          entry.blob_oid,
          entry.committed_mode,
        )
      ) {
        continue;
      }
      stmt.run(
        lastCommitAtSeconds,
        eventId,
        eventTs,
        commit.project_dir,
        commit.committer_session_id,
        filePath,
      );
    }
    // Task→committing-session link write, gated on `task_ids.length > 0` (the
    // enclosing arm already requires a non-null session). Multi-task commits
    // stamp ALL named tasks symmetrically. Pure function of the payload + the
    // existing epics rows. On a commit-before-claim miss (no embedded job
    // element for this session yet) the link is dropped rather than shelling a
    // job element foldCommit doesn't own — a real worker's SessionStart (lower
    // event id) always folds first, so the miss is reachable only on a
    // hand-crafted event sequence and stays deterministic.
    if (commit.task_ids.length > 0) {
      foldCommitTaskLinks(db, {
        committerSessionId: commit.committer_session_id,
        taskIds: commit.task_ids,
        lastCommitForTaskAt: lastCommitAtSeconds,
        eventId,
        eventTs,
      });
    }
    // Durable commit-derived creator/refiner edge. When the commit carried a
    // `Planctl-Op` + epic-shaped `Planctl-Target` + `Session-Id`, TRIGGER the
    // session's edge rebuild — `syncPlanctlLinks` re-derives `jobs.epic_links` +
    // the epic's `epics.job_links` from the union of the stdout scrape and this
    // commit-trailer fact. We TRIGGER (never write the edge cells directly) so
    // `syncPlanctlLinks` stays the sole writer. A non-planctl commit has NULL
    // `planctl_op` and no-ops, preserving re-fold determinism over the log.
    if (
      commit.planctl_op != null &&
      commit.planctl_target != null &&
      parsePlanRef(commit.planctl_target)?.kind != null
    ) {
      syncPlanctlLinks(db, commit.committer_session_id, eventId, eventTs);
    }
    return;
  }
  // Global discharge: no trailer (or malformed) → no honest way to pin the
  // discharge to a session, so clear EVERY session's attribution row for the
  // named files.
  const globalStmt = db.prepare(
    `UPDATE file_attributions
        SET last_commit_at = ?, last_event_id = ?, updated_at = ?
      WHERE project_dir = ?
        AND file_path = ?`,
  );
  // Same content-aware gate as the per-session arm: the oid/mode read is
  // per-file, so a chmod-only dirty file is not discharged here either.
  for (const entry of commit.files) {
    const filePath = entry.path;
    if (typeof filePath !== "string" || filePath.length === 0) continue;
    if (
      shouldSkipDischarge(
        commit.project_dir,
        filePath,
        entry.blob_oid,
        entry.committed_mode,
      )
    ) {
      continue;
    }
    globalStmt.run(
      lastCommitAtSeconds,
      eventId,
      eventTs,
      commit.project_dir,
      filePath,
    );
  }
}

/**
 * Stamp the per-(task, job) task→committing-session link on the embedded job
 * element under each named task. Called from {@link foldCommit}'s per-session
 * arm. Pure function of the inputs + the existing `epics` rows; NEVER throws (a
 * parse failure folds to "skip this task"). For each `task_id`: resolve the
 * parent epic, find the task element, find the embedded job element for
 * `committerSessionId`, stamp `last_commit_for_task_at`, re-sort via
 * {@link sortEmbeddedJobs} (NEVER append — re-fold determinism), write back. A
 * missing epic / task / job element skips deterministically (the link is set by
 * THIS fold, not `syncJobIntoEpic`, so the snapshot-vs-commit ordering inverting
 * on re-fold doesn't change the result).
 */
function foldCommitTaskLinks(
  db: Database,
  opts: {
    committerSessionId: string;
    taskIds: string[];
    lastCommitForTaskAt: number;
    eventId: number;
    eventTs: number;
  },
): void {
  const { committerSessionId, taskIds, lastCommitForTaskAt, eventId, eventTs } =
    opts;
  // Minimal shape of an `epics.tasks[]` element this helper reads/writes,
  // narrowed to the fields we touch; the index signature carries unknown fields
  // opaquely so a re-serialise round-trips byte-identical for re-fold.
  interface TaskElementJson {
    task_id: string;
    jobs?: EmbeddedJobElement[];
    [key: string]: unknown;
  }
  for (const taskId of taskIds) {
    // Re-parse to extract the parent epic_id and stay robust against future
    // callers (extractCommit already gated on TASK_TRAILER_RE).
    const parsed = parsePlanRef(taskId);
    if (parsed == null || parsed.kind !== "task") {
      continue;
    }
    const epicRow = db
      .query("SELECT tasks FROM epics WHERE epic_id = ?")
      .get(parsed.epic_id) as { tasks: string | null } | null;
    if (
      epicRow == null ||
      epicRow.tasks == null ||
      epicRow.tasks.length === 0
    ) {
      continue;
    }
    let tasksArr: TaskElementJson[];
    try {
      const parsedTasks = JSON.parse(epicRow.tasks);
      if (!Array.isArray(parsedTasks)) {
        continue;
      }
      tasksArr = parsedTasks as TaskElementJson[];
    } catch {
      // Malformed JSON cell — skip this task, never throw inside the fold.
      continue;
    }
    const taskIdx = tasksArr.findIndex((t) => t.task_id === parsed.task_id);
    if (taskIdx < 0) {
      continue; // task not yet known to this epic — skip.
    }
    const oldTask = tasksArr[taskIdx];
    const oldJobs =
      oldTask != null && Array.isArray(oldTask.jobs) ? oldTask.jobs : [];
    const jobIdx = oldJobs.findIndex((j) => j.job_id === committerSessionId);
    if (jobIdx < 0) {
      // Commit-before-claim path — no embedded job element yet for this
      // session under this task; lose the link deterministically.
      continue;
    }
    // RMW: stamp last_commit_for_task_at + bump axes on the matched element,
    // re-sort (for consistency with `syncJobIntoEpic`'s write site), write back.
    const oldJob = oldJobs[jobIdx];
    const newJob: EmbeddedJobElement = {
      ...oldJob,
      last_commit_for_task_at: lastCommitForTaskAt,
      last_event_id: eventId,
      updated_at: eventTs,
    };
    const newJobs = oldJobs.slice();
    newJobs[jobIdx] = newJob;
    sortEmbeddedJobs(newJobs);
    // Carve-out spread: preserve every other scalar field on the task element
    // so a Commit fold does NOT clobber plan-snapshot-derived state.
    const newTask: TaskElementJson = { ...oldTask, jobs: newJobs };
    const newTasksArr = tasksArr.slice();
    newTasksArr[taskIdx] = newTask;
    const tasksJson = JSON.stringify(newTasksArr);
    db.run(
      "UPDATE epics SET tasks = ?, last_event_id = ?, updated_at = ? WHERE epic_id = ?",
      [tasksJson, eventId, eventTs, parsed.epic_id],
    );
  }
}

/**
 * Stamp the provenance-filtered `has_live_worker_monitor` occupancy fact onto
 * THIS session's embedded job element under its bound task.
 *
 * A dedicated write site is needed because the Stop fold's `jobs.monitors`
 * UPDATE is HOISTED ABOVE the sub-agent guard: a mid-Task-yield Stop refreshes
 * `jobs.monitors` but SKIPS the `state='stopped'` UPDATE and its
 * `syncIfPlanRef` fan-out, so without this explicit stamp the embedded
 * occupancy fact would go stale in the guard-swallow case. Mirrors
 * {@link foldCommitTaskLinks}: RMW the embedded job by `job_id`, stamping the
 * boolean + `last_event_id`/`updated_at`.
 *
 * Re-fold deterministic (every RMW input is event-derived). NEVER throws — a
 * malformed `tasks` cell / missing task / commit-before-claim job is a
 * deterministic skip. Only fires for verb `work` (`plan_ref` is `{kind:
 * "task"}`); a planner / closer session holds no working tree.
 */
function stampEmbeddedMonitorFact(
  db: Database,
  opts: {
    jobId: string;
    planRef: string | null;
    hasLiveWorkerMonitor: boolean;
    eventId: number;
    eventTs: number;
  },
): void {
  const { jobId, planRef, hasLiveWorkerMonitor, eventId, eventTs } = opts;
  if (planRef == null) {
    return;
  }
  const parsed = parsePlanRef(planRef);
  if (parsed == null || parsed.kind !== "task") {
    return; // not a work session — no per-task monitor occupancy to stamp.
  }
  // Minimal opaque-passthrough shape mirroring `foldCommitTaskLinks`: only
  // the `jobs` sub-array is touched, every other task field rides through
  // `unknownFields` so a re-serialise round-trips byte-identically.
  interface TaskElementJson {
    task_id: string;
    jobs?: EmbeddedJobElement[];
    [key: string]: unknown;
  }
  const epicRow = db
    .query("SELECT tasks FROM epics WHERE epic_id = ?")
    .get(parsed.epic_id) as { tasks: string | null } | null;
  if (epicRow == null || epicRow.tasks == null || epicRow.tasks.length === 0) {
    return;
  }
  let tasksArr: TaskElementJson[];
  try {
    const parsedTasks = JSON.parse(epicRow.tasks);
    if (!Array.isArray(parsedTasks)) {
      return;
    }
    tasksArr = parsedTasks as TaskElementJson[];
  } catch {
    return; // malformed JSON cell — skip, never throw inside the fold.
  }
  const taskIdx = tasksArr.findIndex((t) => t.task_id === parsed.task_id);
  if (taskIdx < 0) {
    return; // task not yet known — skip.
  }
  const oldTask = tasksArr[taskIdx];
  const oldJobs =
    oldTask != null && Array.isArray(oldTask.jobs) ? oldTask.jobs : [];
  const jobIdx = oldJobs.findIndex((j) => j.job_id === jobId);
  if (jobIdx < 0) {
    // No embedded job element yet — the carve-out picks up the fresh `false`
    // default when SessionStart lands it. Lose the stamp deterministically.
    return;
  }
  const oldJob = oldJobs[jobIdx];
  // No-op short-circuit: skip the write when the boolean is unchanged so a Stop
  // that didn't change occupancy stays byte-stable. `?? false` handles the
  // absent-field case.
  if ((oldJob.has_live_worker_monitor ?? false) === hasLiveWorkerMonitor) {
    return;
  }
  const newJob: EmbeddedJobElement = {
    ...oldJob,
    has_live_worker_monitor: hasLiveWorkerMonitor,
    last_event_id: eventId,
    updated_at: eventTs,
  };
  const newJobs = oldJobs.slice();
  newJobs[jobIdx] = newJob;
  sortEmbeddedJobs(newJobs);
  // OLD-element carve-out spread: preserve EVERY other task scalar field.
  const newTask: TaskElementJson = { ...oldTask, jobs: newJobs };
  const newTasksArr = tasksArr.slice();
  newTasksArr[taskIdx] = newTask;
  db.run(
    "UPDATE epics SET tasks = ?, last_event_id = ?, updated_at = ? WHERE epic_id = ?",
    [JSON.stringify(newTasksArr), eventId, eventTs, parsed.epic_id],
  );
}

/**
 * Terminal-clear counterpart to {@link stampEmbeddedMonitorFact}. A SessionEnd /
 * Killed write clears `jobs.monitors`, but the carve-out PRESERVES whatever
 * `has_live_worker_monitor` the prior embedded element held — so a job that
 * stopped with a live monitor would carry a stale `true` into its terminal
 * element. This forces the fact to `false`. Deterministic no-op for a non-work
 * session.
 */
function clearEmbeddedMonitorFactOnTerminal(
  db: Database,
  jobId: string,
  eventId: number,
  eventTs: number,
): void {
  const planRow = db
    .query("SELECT plan_ref FROM jobs WHERE job_id = ?")
    .get(jobId) as { plan_ref: string | null } | null;
  stampEmbeddedMonitorFact(db, {
    jobId,
    planRef: planRow?.plan_ref ?? null,
    hasLiveWorkerMonitor: false,
    eventId,
    eventTs,
  });
}

/**
 * Pre-flattened agentuse usage snapshot. The usage-worker carries every
 * projection-meaningful field in the synthetic `UsageSnapshot` event's `data`
 * blob; the reducer never re-reads the on-disk file. Freshness fields
 * (`fetched_at` / `next_fetch_at` / `last_successful_fetch_at` /
 * `last_skipped_fetch_at`) are filtered at the producer — including any here
 * would force a synthetic event on every fetch cycle.
 */
interface UsageSnapshotPayload {
  target: string | null;
  multiplier: number | null;
  session_percent: number | null;
  session_resets_at: string | null;
  week_percent: number | null;
  week_resets_at: string | null;
  sonnet_week_percent: number | null;
  sonnet_week_resets_at: string | null;
  // Envelope freshness / plan / stale-error axes.
  status: string | null;
  /**
   * Coerced from the producer's bool|null to 1/0/null at extract time so the
   * UPSERT binding matches the nullable INTEGER column. The wire shape stays
   * boolean.
   */
  subscription_active: 1 | 0 | null;
  error_type: string | null;
  error_message: string | null;
  error_at: string | null;
  /**
   * Rate-limit lift instant — ISO-8601 string carrying the soonest `resets_at`
   * among windows at >=100% used; null when the profile is under every limit.
   * Stored opaque as TEXT. Folds into `usage.rate_limit_lifts_at` on the
   * percentage path; the rate-limit fan-out's UPDATE carves it out so a
   * RateLimited fold cannot clobber a lift time.
   */
  lift_at: string | null;
}

function extractUsageSnapshot(event: Event): UsageSnapshotPayload | null {
  if (event.data == null || event.data.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(event.data) as Partial<
      Omit<UsageSnapshotPayload, "subscription_active">
    > & { subscription_active?: unknown };
    // bool|null → 1/0/null; non-booleans (including missing) fold to null.
    const subRaw = parsed.subscription_active;
    const subscriptionActive: 1 | 0 | null =
      subRaw === true ? 1 : subRaw === false ? 0 : null;
    return {
      target: typeof parsed.target === "string" ? parsed.target : null,
      multiplier:
        typeof parsed.multiplier === "number" &&
        Number.isInteger(parsed.multiplier)
          ? parsed.multiplier
          : null,
      session_percent:
        typeof parsed.session_percent === "number" &&
        Number.isFinite(parsed.session_percent)
          ? parsed.session_percent
          : null,
      session_resets_at:
        typeof parsed.session_resets_at === "string"
          ? parsed.session_resets_at
          : null,
      week_percent:
        typeof parsed.week_percent === "number" &&
        Number.isFinite(parsed.week_percent)
          ? parsed.week_percent
          : null,
      week_resets_at:
        typeof parsed.week_resets_at === "string"
          ? parsed.week_resets_at
          : null,
      sonnet_week_percent:
        typeof parsed.sonnet_week_percent === "number" &&
        Number.isFinite(parsed.sonnet_week_percent)
          ? parsed.sonnet_week_percent
          : null,
      sonnet_week_resets_at:
        typeof parsed.sonnet_week_resets_at === "string"
          ? parsed.sonnet_week_resets_at
          : null,
      status: typeof parsed.status === "string" ? parsed.status : null,
      subscription_active: subscriptionActive,
      error_type:
        typeof parsed.error_type === "string" ? parsed.error_type : null,
      error_message:
        typeof parsed.error_message === "string" ? parsed.error_message : null,
      error_at: typeof parsed.error_at === "string" ? parsed.error_at : null,
      // Rate-limit lift instant — null-safe string parse; older events that
      // predate `lift_at` fold to null safely.
      lift_at: typeof parsed.lift_at === "string" ? parsed.lift_at : null,
    };
  } catch (err) {
    console.error(
      `keeper reducer: failed to parse usage snapshot blob for event id=${event.id} id=${event.session_id}: ${err}`,
    );
    return null;
  }
}

/**
 * Fold one synthetic `UsageSnapshot` event. Single-row UPSERT mirrors
 * {@link projectGitStatus}'s flat-row pattern — no read-modify-write, no
 * embedded arrays, no fan-out. The pk (`id`) rides in `event.session_id`
 * (the generic entity-key overload the synthetic-event pipeline uses);
 * payload fields ride in `event.data` (decoded by
 * {@link extractUsageSnapshot}).
 *
 * Bumps `last_event_id` + `updated_at` on every write. Re-fold deterministic:
 * the reducer NEVER re-reads the on-disk file.
 *
 * Reverse fan-out (UsageSnapshot ← profiles): the colocated
 * `last_rate_limit_at` + `last_rate_limit_session_id` columns are carved OUT of
 * the `ON CONFLICT DO UPDATE` clause so a `UsageSnapshot` re-fold can't clobber
 * the rate-limit annotation a prior `RateLimited` fan-out wrote. After the
 * UPSERT, a SELECT against the matching `profiles` row (joined on `profile_name
 * = usage.id`) stamps the current rate-limit state. NULL-safe when no profile
 * row exists; the `profile_name != ''` guard keeps the `''` sentinel out of the
 * join.
 */
function projectUsageRow(db: Database, event: Event): void {
  const id = event.session_id;
  if (id == null || id.length === 0) {
    return;
  }
  const snapshot = extractUsageSnapshot(event);
  if (snapshot == null) {
    return;
  }
  // Freshness stamp gate. `last_usage_fold_at` is the event `ts` ONLY on a
  // SUCCESSFUL usage fold (status `"active"` or any per-window percent present)
  // — NOT on idle/stale snapshots, which preserve the prior stamp via the
  // COALESCE carve-out below so a wedged-ingestion warning keeps its meaning.
  // The value is the event ts, never `Date.now()` — a wall-clock read would
  // break re-fold determinism.
  const hasUsagePercents =
    snapshot.session_percent != null ||
    snapshot.week_percent != null ||
    snapshot.sonnet_week_percent != null;
  const isSuccessfulFold = snapshot.status === "active" || hasUsagePercents;
  const lastUsageFoldAt: number | null = isSuccessfulFold ? event.ts : null;
  db.run(
    `INSERT INTO usage (
       id, target, multiplier, session_percent, session_resets_at,
       week_percent, week_resets_at, sonnet_week_percent,
       sonnet_week_resets_at, status, subscription_active,
       error_type, error_message, error_at,
       rate_limit_lifts_at, last_usage_fold_at,
       last_event_id, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       target = excluded.target,
       multiplier = excluded.multiplier,
       session_percent = excluded.session_percent,
       session_resets_at = excluded.session_resets_at,
       week_percent = excluded.week_percent,
       week_resets_at = excluded.week_resets_at,
       sonnet_week_percent = excluded.sonnet_week_percent,
       sonnet_week_resets_at = excluded.sonnet_week_resets_at,
       status = excluded.status,
       subscription_active = excluded.subscription_active,
       error_type = excluded.error_type,
       error_message = excluded.error_message,
       error_at = excluded.error_at,
       -- fn-651: percentage path owns the lift instant; a re-snapshot
       -- rewrites it cleanly. The rate-limit fan-out (RateLimited /
       -- ApiError(kind='rate_limit')) carves this out of its UPDATE in
       -- the opposite direction, so a rate-limit fold cannot clobber a
       -- lift time the percentage path wrote.
       rate_limit_lifts_at = excluded.rate_limit_lifts_at,
       -- fn-651: freshness stamp. COALESCE preserves a prior successful
       -- fold's stamp when the current fold is idle/stale (excluded value
       -- is NULL). On a successful fold the excluded value is the event
       -- ts, which overwrites the prior. The rate-limit fan-out carves
       -- this out of its UPDATE for the same carve-out reason as
       -- rate_limit_lifts_at.
       last_usage_fold_at = COALESCE(excluded.last_usage_fold_at, usage.last_usage_fold_at),
       last_event_id = excluded.last_event_id,
       updated_at = excluded.updated_at`,
    [
      id,
      snapshot.target,
      snapshot.multiplier,
      snapshot.session_percent,
      snapshot.session_resets_at,
      snapshot.week_percent,
      snapshot.week_resets_at,
      snapshot.sonnet_week_percent,
      snapshot.sonnet_week_resets_at,
      snapshot.status,
      snapshot.subscription_active,
      snapshot.error_type,
      snapshot.error_message,
      snapshot.error_at,
      snapshot.lift_at,
      lastUsageFoldAt,
      event.id,
      event.ts,
    ],
  );
  // Reverse fan-out: pull the current rate-limit annotation from the matching
  // `profiles` row and stamp it onto the just-UPSERTed usage row. The join key
  // `profileNameForUsageId(usage.id)` translates agentuse's `"default"` id to
  // keeper's `''` default-profile sentinel. NULL-safe: a missing profile row
  // leaves the columns NULL (the zero-event shape); a later `RateLimited`
  // populates them via the forward fan-out. Pure function of the fold inputs +
  // the in-transaction `profiles` row — re-fold deterministic.
  const profileRow = db
    .query(
      `SELECT last_rate_limit_at, last_rate_limit_session_id
         FROM profiles
        WHERE profile_name = ?`,
    )
    .get(profileNameForUsageId(id)) as {
    last_rate_limit_at: number | null;
    last_rate_limit_session_id: string | null;
  } | null;
  db.run(
    `UPDATE usage
        SET last_rate_limit_at = ?,
            last_rate_limit_session_id = ?
      WHERE id = ?`,
    [
      profileRow?.last_rate_limit_at ?? null,
      profileRow?.last_rate_limit_session_id ?? null,
      id,
    ],
  );
}

/**
 * Fold one synthetic `UsageDeleted` tombstone. The usage-worker posts this when
 * an `<id>.json` file disappears; without it, {@link projectUsageRow}'s
 * UPSERT-only path would leak the final pre-delete snapshot row forever.
 *
 * The primary key (`id`) rides in `event.session_id`. An empty / missing pk is a
 * safe no-op — fold must never throw. DELETE is idempotent.
 */
function retractUsageRow(db: Database, event: Event): void {
  const id = event.session_id;
  if (id == null || id.length === 0) {
    return;
  }
  db.run("DELETE FROM usage WHERE id = ?", [id]);
}

/**
 * Wire payload for a synthetic `BuildSnapshot` event — the projection-meaningful
 * fields of one buildbot builder's latest build. The pk (the builder NAME) does
 * NOT ride here; it travels in `event.session_id` (the generic entity-key
 * overload). Every field below MUST round-trip serializer → `event.data` →
 * extractor → `builds` column, or the column folds NULL forever (the fn-651
 * field-drop class). The companion `updated_at` freshness stamp is derived from
 * `event.ts` in the fold, never carried here.
 *
 * `results` is NULL while a build runs (`complete:false`); `complete_at` is NULL
 * until it finishes. `builder_id` is the numeric buildbot builderid — stored as
 * an informational column only (the NAME, not the id, is the stable key).
 */
export interface BuildSnapshotPayload {
  builder_id: number | null;
  build_number: number | null;
  complete: 1 | 0 | null;
  results: number | null;
  state_string: string | null;
  started_at: number | null;
  complete_at: number | null;
}

/**
 * Serialize a {@link BuildSnapshotPayload} into the JSON string that rides in a
 * synthetic `BuildSnapshot` event's `data` blob. Pins the wire shape: the
 * builds-worker (task 2) constructs the payload and calls this; the reducer's
 * {@link extractBuildSnapshot} decodes the same shape. Slot order is
 * shape-tolerant (a keyed object, not positional). Exported so a direct
 * round-trip test (and the worker) share the one contract.
 */
export function serializeBuildSnapshot(payload: BuildSnapshotPayload): string {
  return JSON.stringify({
    builder_id: payload.builder_id,
    build_number: payload.build_number,
    complete: payload.complete,
    results: payload.results,
    state_string: payload.state_string,
    started_at: payload.started_at,
    complete_at: payload.complete_at,
  });
}

/**
 * Null-safe decode of a `BuildSnapshot` event's `data` blob into a
 * {@link BuildSnapshotPayload}. Returns null on a missing/empty/malformed blob
 * ({@link projectBuildsRow} folds null to a no-op); NEVER throws. Each field is
 * type-narrowed independently so a partial / older blob folds the absent fields
 * to null rather than poisoning the row.
 */
export function extractBuildSnapshot(
  event: Event,
): BuildSnapshotPayload | null {
  if (event.data == null || event.data.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(event.data) as Partial<
      Omit<BuildSnapshotPayload, "complete">
    > & { complete?: unknown };
    // 1/0/null pass through; bool tolerated (true→1, false→0); anything else
    // (including missing) folds to null.
    const completeRaw = parsed.complete;
    const complete: 1 | 0 | null =
      completeRaw === 1 || completeRaw === true
        ? 1
        : completeRaw === 0 || completeRaw === false
          ? 0
          : null;
    return {
      builder_id:
        typeof parsed.builder_id === "number" &&
        Number.isInteger(parsed.builder_id)
          ? parsed.builder_id
          : null,
      build_number:
        typeof parsed.build_number === "number" &&
        Number.isInteger(parsed.build_number)
          ? parsed.build_number
          : null,
      complete,
      results:
        typeof parsed.results === "number" && Number.isInteger(parsed.results)
          ? parsed.results
          : null,
      state_string:
        typeof parsed.state_string === "string" ? parsed.state_string : null,
      started_at:
        typeof parsed.started_at === "number" &&
        Number.isFinite(parsed.started_at)
          ? parsed.started_at
          : null,
      complete_at:
        typeof parsed.complete_at === "number" &&
        Number.isFinite(parsed.complete_at)
          ? parsed.complete_at
          : null,
    };
  } catch (err) {
    console.error(
      `keeper reducer: failed to parse build snapshot blob for event id=${event.id} id=${event.session_id}: ${err}`,
    );
    return null;
  }
}

/**
 * Fold one synthetic `BuildSnapshot` event into the `builds` projection. Flat
 * single-row UPSERT keyed on the builder NAME (`event.session_id`) — the
 * {@link projectUsageRow} pattern: no read-modify-write, no embedded arrays, no
 * fan-out. Payload rides in `event.data` (decoded by
 * {@link extractBuildSnapshot}); a malformed/empty blob or empty pk folds to a
 * no-op (the cursor still advances in {@link applyEvent}). `updated_at` is the
 * event `ts`, never `Date.now()` — a wall-clock read would break re-fold
 * determinism.
 */
function projectBuildsRow(db: Database, event: Event): void {
  const project = event.session_id;
  if (project == null || project.length === 0) {
    return;
  }
  const snapshot = extractBuildSnapshot(event);
  if (snapshot == null) {
    return;
  }
  db.run(
    `INSERT INTO builds (
       project, builder_id, build_number, complete, results,
       state_string, started_at, complete_at, last_event_id, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project) DO UPDATE SET
       builder_id = excluded.builder_id,
       build_number = excluded.build_number,
       complete = excluded.complete,
       results = excluded.results,
       state_string = excluded.state_string,
       started_at = excluded.started_at,
       complete_at = excluded.complete_at,
       last_event_id = excluded.last_event_id,
       updated_at = excluded.updated_at`,
    [
      project,
      snapshot.builder_id,
      snapshot.build_number,
      snapshot.complete,
      snapshot.results,
      snapshot.state_string,
      snapshot.started_at,
      snapshot.complete_at,
      event.id,
      event.ts,
    ],
  );
}

/**
 * Fold one synthetic `BuildDeleted` tombstone. The builds-worker posts this when
 * a builder disappears from the buildbot config (or goes ghost); without it,
 * {@link projectBuildsRow}'s UPSERT-only path would leak the final pre-delete
 * row forever. The pk (the builder NAME) rides in `event.session_id`. An empty /
 * missing pk is a safe no-op — fold must never throw. DELETE is idempotent and
 * keys the EXACT same `project` string the snapshot UPSERT used.
 */
function retractBuildsRow(db: Database, event: Event): void {
  const project = event.session_id;
  if (project == null || project.length === 0) {
    return;
  }
  db.run("DELETE FROM builds WHERE project = ?", [project]);
}

/**
 * Pre-flattened `DispatchFailed` synthetic event payload. The autopilot
 * reconciler mints this when a dispatch attempt for `(verb, id)` fails; the
 * free-form `reason` lets future failure shapes ride the same arm.
 *
 * `ts` is the reconcile-time stamp carried in the payload (NOT `event.ts`),
 * which keeps the fold pure: a re-fold reproduces the same
 * `dispatch_failures.ts` regardless of when it happens. The reducer NEVER reads
 * `Date.now()` and NEVER re-probes liveness here.
 */
interface DispatchFailedPayload {
  verb: string;
  id: string;
  reason: string;
  dir: string | null;
  ts: number;
}

/**
 * Pre-flattened `DispatchCleared` synthetic event payload. The reconciler mints
 * this on a human `retry_dispatch` RPC — the only legal way for a sticky failure
 * row to leave `dispatch_failures` (every clear round-trips through the event
 * log so a re-fold reproduces the post-clear state).
 */
interface DispatchClearedPayload {
  verb: string;
  id: string;
}

/**
 * Parse a `DispatchFailed` event payload. Returns null on any structural miss
 * ({@link foldDispatchFailed} folds null to a safe no-op); NEVER throws. Strict:
 * `verb` / `id` / `reason` non-empty strings, `dir` nullable, `ts` finite.
 */
function extractDispatchFailedPayload(
  event: Event,
): DispatchFailedPayload | null {
  if (event.data == null || event.data.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(event.data) as Partial<DispatchFailedPayload>;
    if (typeof parsed.verb !== "string" || parsed.verb.length === 0) {
      return null;
    }
    if (typeof parsed.id !== "string" || parsed.id.length === 0) {
      return null;
    }
    if (typeof parsed.reason !== "string" || parsed.reason.length === 0) {
      return null;
    }
    if (typeof parsed.ts !== "number" || !Number.isFinite(parsed.ts)) {
      return null;
    }
    const dir =
      typeof parsed.dir === "string" && parsed.dir.length > 0
        ? parsed.dir
        : null;
    return {
      verb: parsed.verb,
      id: parsed.id,
      reason: parsed.reason,
      dir,
      ts: parsed.ts,
    };
  } catch (err) {
    console.error(
      `keeper reducer: failed to parse DispatchFailed payload for event id=${event.id} session=${event.session_id}: ${err}`,
    );
    return null;
  }
}

/**
 * Parse a `DispatchCleared` event payload. Mirrors
 * {@link extractDispatchFailedPayload}'s defensive shape — only `verb` +
 * `id` required (the clear arm is keyed-by-pk only); anything missing
 * folds to a safe no-op.
 */
function extractDispatchClearedPayload(
  event: Event,
): DispatchClearedPayload | null {
  if (event.data == null || event.data.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(event.data) as Partial<DispatchClearedPayload>;
    if (typeof parsed.verb !== "string" || parsed.verb.length === 0) {
      return null;
    }
    if (typeof parsed.id !== "string" || parsed.id.length === 0) {
      return null;
    }
    return { verb: parsed.verb, id: parsed.id };
  } catch (err) {
    console.error(
      `keeper reducer: failed to parse DispatchCleared payload for event id=${event.id} session=${event.session_id}: ${err}`,
    );
    return null;
  }
}

/**
 * Fold one synthetic `DispatchFailed` event. UPSERT on `(verb, id)`: the first
 * failure INSERTs a row stamped `created_at = payload.ts`; subsequent failures
 * UPDATE the mutable fields and PRESERVE `created_at` so the "sticky since" view
 * stays honest. Pure function of the payload + the persisted row — no
 * `Date.now()`, no liveness re-probe, no `jobs` SELECT. Malformed/missing
 * payload → safe no-op.
 */
function foldDispatchFailed(db: Database, event: Event): void {
  const payload = extractDispatchFailedPayload(event);
  if (payload == null) {
    return;
  }
  db.run(
    `INSERT INTO dispatch_failures (
       verb, id, reason, dir, ts, last_event_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(verb, id) DO UPDATE SET
       reason = excluded.reason,
       dir = excluded.dir,
       ts = excluded.ts,
       last_event_id = excluded.last_event_id,
       -- created_at preserved through UPSERT: the row's "sticky since"
       -- view is the FIRST observation of this failure, never the latest.
       updated_at = excluded.updated_at`,
    [
      payload.verb,
      payload.id,
      payload.reason,
      payload.dir,
      payload.ts,
      event.id,
      payload.ts,
      event.ts,
    ],
  );
  // A `DispatchFailed` also discharges any in-flight `pending_dispatches` row
  // for the same pair: the outbox ordering (mint `Dispatched` BEFORE `launch()`)
  // means a launch failure leaves both rows, and this arm reconciles them in the
  // same fold. Idempotent DELETE — no-op when no pending row exists.
  db.run("DELETE FROM pending_dispatches WHERE verb = ? AND id = ?", [
    payload.verb,
    payload.id,
  ]);
}

/**
 * Fold one synthetic `DispatchCleared` event. Idempotent DELETE on `(verb, id)`
 * — the ONLY legal clear path (a direct DELETE outside the fold arm would break
 * re-fold determinism). Malformed/missing payload → safe no-op.
 */
function foldDispatchCleared(db: Database, event: Event): void {
  const payload = extractDispatchClearedPayload(event);
  if (payload == null) {
    return;
  }
  db.run("DELETE FROM dispatch_failures WHERE verb = ? AND id = ?", [
    payload.verb,
    payload.id,
  ]);
}

/**
 * Pre-flattened `Dispatched` synthetic event payload. The reconciler mints this
 * BEFORE invoking `ExecBackend.launch()` — outbox-ordered intent, so a crash
 * between mint and launch leaves a phantom pending row the producer-side TTL
 * sweep clears via `DispatchExpired` (preferable to double-dispatch in the
 * launch→SessionStart blind window).
 *
 * `ts` is the producer-side mint-moment wall-clock carried in the payload (NOT
 * `event.ts`), which keeps the fold pure: the reducer NEVER reads `Date.now()`
 * here. The TTL sweep compares this against `Date.now()` IN MAIN.
 */
interface DispatchedPayload {
  verb: string;
  id: string;
  dir: string | null;
  ts: number;
}

/**
 * Pre-flattened `DispatchExpired` synthetic event payload. The producer-side TTL
 * sweep mints this for any `pending_dispatches` row past the ceiling —
 * discharges the phantom launch-window slot without forcing a redispatch
 * decision. Strictly `(verb, id)`, keyed-by-pk only.
 */
interface DispatchExpiredPayload {
  verb: string;
  id: string;
}

/**
 * Parse a `Dispatched` event payload. Returns null on any structural miss
 * ({@link foldDispatched} folds null to a safe no-op); NEVER throws. Strict:
 * `verb` / `id` non-empty strings, `dir` nullable, `ts` finite.
 */
function extractDispatchedPayload(event: Event): DispatchedPayload | null {
  if (event.data == null || event.data.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(event.data) as Partial<DispatchedPayload>;
    if (typeof parsed.verb !== "string" || parsed.verb.length === 0) {
      return null;
    }
    if (typeof parsed.id !== "string" || parsed.id.length === 0) {
      return null;
    }
    if (typeof parsed.ts !== "number" || !Number.isFinite(parsed.ts)) {
      return null;
    }
    const dir =
      typeof parsed.dir === "string" && parsed.dir.length > 0
        ? parsed.dir
        : null;
    return { verb: parsed.verb, id: parsed.id, dir, ts: parsed.ts };
  } catch (err) {
    console.error(
      `keeper reducer: failed to parse Dispatched payload for event id=${event.id} session=${event.session_id}: ${err}`,
    );
    return null;
  }
}

/**
 * Parse a `DispatchExpired` event payload. Mirrors
 * {@link extractDispatchClearedPayload}'s defensive shape — only `verb` +
 * `id` required (the expire arm is keyed-by-pk only); anything missing
 * folds to a safe no-op.
 */
function extractDispatchExpiredPayload(
  event: Event,
): DispatchExpiredPayload | null {
  if (event.data == null || event.data.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(event.data) as Partial<DispatchExpiredPayload>;
    if (typeof parsed.verb !== "string" || parsed.verb.length === 0) {
      return null;
    }
    if (typeof parsed.id !== "string" || parsed.id.length === 0) {
      return null;
    }
    return { verb: parsed.verb, id: parsed.id };
  } catch (err) {
    console.error(
      `keeper reducer: failed to parse DispatchExpired payload for event id=${event.id} session=${event.session_id}: ${err}`,
    );
    return null;
  }
}

/**
 * Fold one synthetic `Dispatched` event. UPSERT on `(verb, id)` — a re-dispatch
 * after a prior `DispatchExpired` / failure lands here without a unique-
 * constraint violation, refreshing `dispatched_at` / `dir` / `last_event_id` to
 * the latest attempt so the TTL sweep keys off it. Pure function of the payload
 * + the persisted row — no `Date.now()`, no liveness re-probe, no `jobs` SELECT.
 * Malformed/missing payload → safe no-op.
 */
function foldDispatched(db: Database, event: Event): void {
  const payload = extractDispatchedPayload(event);
  if (payload == null) {
    return;
  }
  db.run(
    `INSERT INTO pending_dispatches (
       verb, id, dir, dispatched_at, last_event_id
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(verb, id) DO UPDATE SET
       dir = excluded.dir,
       dispatched_at = excluded.dispatched_at,
       last_event_id = excluded.last_event_id`,
    [payload.verb, payload.id, payload.dir, payload.ts, event.id],
  );
}

/**
 * Fold one synthetic `DispatchExpired` event. Idempotent DELETE on `(verb, id)`
 * — MUST NOT throw on a missing row (a boot-drain race where `SessionStart`
 * already discharged the row before the sweep's `DispatchExpired` lands would
 * otherwise wedge the reducer). Malformed/missing payload → safe no-op.
 */
function foldDispatchExpired(db: Database, event: Event): void {
  const payload = extractDispatchExpiredPayload(event);
  if (payload == null) {
    return;
  }
  db.run("DELETE FROM pending_dispatches WHERE verb = ? AND id = ?", [
    payload.verb,
    payload.id,
  ]);
}

/**
 * Pre-flattened `AutopilotPaused` synthetic event payload — the single boolean
 * knob the autopilot worker reads. Pause/play round-trips through the
 * `set_autopilot_paused` RPC → main, which appends one `AutopilotPaused` event;
 * the reducer folds it into the singleton `autopilot_state.paused` column. The
 * fold reads NOTHING outside the payload + the persisted row (uses `event.ts`
 * for timestamps), so re-fold is byte-deterministic. Each autopilot knob gets
 * its own value-carrying event so per-knob invariants stay co-located.
 */
interface AutopilotPausedPayload {
  paused: boolean;
}

/**
 * Parse an `AutopilotPaused` event payload. Returns null on any structural miss
 * ({@link foldAutopilotPaused} folds null to a safe no-op); NEVER throws.
 * Strict: `paused` MUST be a literal boolean — no coercion of `0`/`1` /
 * `"true"` / null, so a corrupted producer folds to a safe no-op.
 */
function extractAutopilotPausedPayload(
  event: Event,
): AutopilotPausedPayload | null {
  if (event.data == null || event.data.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(event.data) as Partial<AutopilotPausedPayload>;
    if (typeof parsed.paused !== "boolean") {
      return null;
    }
    return { paused: parsed.paused };
  } catch (err) {
    console.error(
      `keeper reducer: failed to parse AutopilotPaused payload for event id=${event.id} session=${event.session_id}: ${err}`,
    );
    return null;
  }
}

/**
 * Fold one synthetic `AutopilotPaused` event. UPSERT on the singleton `id = 1`:
 * the first event INSERTs the row stamped `created_at = event.ts`; subsequent
 * events UPDATE `paused` and PRESERVE `created_at`. Pure function of the payload
 * + the persisted row (uses `event.ts` for timestamps) — no `Date.now()`, no
 * env read, no `jobs` SELECT. Malformed/missing payload → safe no-op.
 */
function foldAutopilotPaused(db: Database, event: Event): void {
  const payload = extractAutopilotPausedPayload(event);
  if (payload == null) {
    return;
  }
  db.run(
    `INSERT INTO autopilot_state (
       id, paused, last_event_id, created_at, updated_at
     ) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       paused = excluded.paused,
       last_event_id = excluded.last_event_id,
       -- created_at preserved through UPSERT: the row's "since" view is
       -- the FIRST AutopilotPaused observation (typically the boot-append
       -- re-arm), never the latest flip.
       -- max_concurrent_jobs NOT touched here: the singleton row is shared
       -- with foldAutopilotCapSet (fn-725), so a pause/play toggle MUST
       -- preserve the cap column on conflict — omitting it from the SET
       -- clause leaves the persisted value intact (the INSERT path binds no
       -- value, defaulting to NULL = unlimited, which is correct for the
       -- never-folded-a-cap-yet boot race). Symmetric to
       -- foldAutopilotCapSet's preservation of paused.
       updated_at = excluded.updated_at`,
    [payload.paused ? 1 : 0, event.id, event.ts, event.ts],
  );
}

/**
 * `AutopilotCapSet` synthetic-event payload (fn-725) — the global autopilot
 * concurrency cap surfaced on the `keeper autopilot` viewer banner.
 *
 * `max_concurrent_jobs`: a positive integer ceiling on concurrent
 * root-occupants, or `null` for unlimited (the default). The daemon's
 * boot-append FREEZES `resolveConfig().maxConcurrentJobs` into this payload
 * on main at mint time — the config is NEVER read in the fold (re-fold
 * determinism). Like {@link AutopilotPausedPayload}, a typed value-carrying
 * event rather than a generic `SettingChanged{key,value}` so per-knob
 * invariants stay co-located (planetgeek event-versioning playbook).
 */
interface AutopilotCapSetPayload {
  max_concurrent_jobs: number | null;
}

/**
 * Parse an `AutopilotCapSet` event payload. NULL-TOLERANT — unlike
 * {@link extractAutopilotPausedPayload} (which rejects anything but a literal
 * boolean), the cap's `null` is a first-class legal value (= unlimited), so a
 * missing/null field folds to `{ max_concurrent_jobs: null }` rather than a
 * dropped event. Any non-positive / non-integer / non-number value also folds
 * to `null` (= unlimited) — defensive against a corrupted producer, matching
 * the config parser's "0/negative/non-integer/absent → unlimited" contract.
 * NEVER throws (a throw inside the fold wedges the reducer); a malformed JSON
 * blob folds to `null`.
 */
function extractAutopilotCapSetPayload(
  event: Event,
): AutopilotCapSetPayload | null {
  if (event.data == null || event.data.length === 0) {
    // Empty payload → unlimited (not a dropped event: the row must still
    // fold so a boot-append with a missing value lands NULL = unlimited).
    return { max_concurrent_jobs: null };
  }
  try {
    const parsed = JSON.parse(event.data) as Partial<AutopilotCapSetPayload>;
    const raw = parsed.max_concurrent_jobs;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
      return { max_concurrent_jobs: null };
    }
    return { max_concurrent_jobs: raw };
  } catch (err) {
    console.error(
      `keeper reducer: failed to parse AutopilotCapSet payload for event id=${event.id} session=${event.session_id}: ${err}`,
    );
    return { max_concurrent_jobs: null };
  }
}

/**
 * Fold one synthetic `AutopilotCapSet` event. UPSERT on the singleton `id = 1`,
 * setting ONLY `max_concurrent_jobs` and PRESERVING `paused` on conflict — the
 * arms share `id = 1`, so each MUST preserve the others' columns or a toggle
 * clobbers a sibling. The INSERT path binds `paused = 1` (boots-paused
 * contract), a defensive fallback since the boot-append orders `AutopilotPaused`
 * first. Pure function of the payload + persisted row — no `Date.now()`, no env
 * read. Malformed payload → unlimited (NULL), never a throw.
 */
function foldAutopilotCapSet(db: Database, event: Event): void {
  const payload = extractAutopilotCapSetPayload(event);
  if (payload == null) {
    return;
  }
  db.run(
    `INSERT INTO autopilot_state (
       id, paused, last_event_id, created_at, updated_at, max_concurrent_jobs
     ) VALUES (1, 1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       max_concurrent_jobs = excluded.max_concurrent_jobs,
       last_event_id = excluded.last_event_id,
       -- paused NOT touched here: shared singleton row with
       -- foldAutopilotPaused — a cap re-arm MUST preserve the live
       -- pause/play flag. created_at preserved (first-observation "since").
       updated_at = excluded.updated_at`,
    [event.id, event.ts, event.ts, payload.max_concurrent_jobs],
  );
}

/**
 * `AutopilotMode` synthetic-event payload — the explicit mode enum that rides
 * the SAME singleton `autopilot_state` row as `paused` and `max_concurrent_jobs`.
 * `yolo` (the default) works every ready epic; `armed` works ONLY armed epics
 * plus their transitive upstream dep-closure.
 */
interface AutopilotModePayload {
  mode: "yolo" | "armed";
}

/**
 * Parse an `AutopilotMode` event payload. Returns null on any structural miss OR
 * an unknown enum value ({@link foldAutopilotMode} folds null to a safe no-op);
 * NEVER throws. STRICT: `mode` MUST be exactly `"yolo"` or `"armed"` — no
 * coercion, so a corrupted producer folds to a safe no-op.
 */
function extractAutopilotModePayload(
  event: Event,
): AutopilotModePayload | null {
  if (event.data == null || event.data.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(event.data) as Partial<AutopilotModePayload>;
    if (parsed.mode !== "yolo" && parsed.mode !== "armed") {
      return null;
    }
    return { mode: parsed.mode };
  } catch (err) {
    console.error(
      `keeper reducer: failed to parse AutopilotMode payload for event id=${event.id} session=${event.session_id}: ${err}`,
    );
    return null;
  }
}

/**
 * Fold one synthetic `AutopilotMode` event. UPSERT on the singleton `id = 1`,
 * setting ONLY `mode` and PRESERVING `paused` + `max_concurrent_jobs` on
 * conflict — the arms share `id = 1`, so each MUST preserve the others' columns.
 * The INSERT path binds `paused = 1` (boots-paused contract), a defensive
 * fallback since the boot-append orders `AutopilotPaused` first. Pure function
 * of the payload + persisted row — no `Date.now()`, no env read.
 * Malformed/unknown-enum payload → safe no-op, never a throw.
 */
function foldAutopilotMode(db: Database, event: Event): void {
  const payload = extractAutopilotModePayload(event);
  if (payload == null) {
    return;
  }
  db.run(
    `INSERT INTO autopilot_state (
       id, paused, last_event_id, created_at, updated_at, mode
     ) VALUES (1, 1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       mode = excluded.mode,
       last_event_id = excluded.last_event_id,
       -- paused + max_concurrent_jobs NOT touched here: shared singleton row
       -- with foldAutopilotPaused / foldAutopilotCapSet — a mode flip MUST
       -- preserve the live pause/play flag and the concurrency cap. created_at
       -- preserved (first-observation "since").
       updated_at = excluded.updated_at`,
    [event.id, event.ts, event.ts, payload.mode],
  );
}

/**
 * `EpicArmed` synthetic-event payload — the per-epic armed flag that folds into
 * the `armed_epics` PRESENCE table. `armed:true` arms the epic (row PRESENT);
 * `armed:false` disarms it (row ABSENT).
 */
interface EpicArmedPayload {
  epic_id: string;
  armed: boolean;
}

/**
 * Parse an `EpicArmed` event payload. Returns null on any structural miss —
 * {@link foldEpicArmed} folds null to a safe no-op (cursor still advances).
 * STRICT: `epic_id` MUST be a non-empty string and `armed` MUST be a literal
 * boolean. NEVER throws (a throw inside the fold wedges the reducer).
 */
function extractEpicArmedPayload(event: Event): EpicArmedPayload | null {
  if (event.data == null || event.data.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(event.data) as Partial<EpicArmedPayload>;
    if (
      typeof parsed.epic_id !== "string" ||
      parsed.epic_id.length === 0 ||
      typeof parsed.armed !== "boolean"
    ) {
      return null;
    }
    return { epic_id: parsed.epic_id, armed: parsed.armed };
  } catch (err) {
    console.error(
      `keeper reducer: failed to parse EpicArmed payload for event id=${event.id} session=${event.session_id}: ${err}`,
    );
    return null;
  }
}

/**
 * Fold one synthetic `EpicArmed` event into the `armed_epics` PRESENCE table.
 * `armed:true` → INSERT OR REPLACE the row; `armed:false` → DELETE it. INSERT OR
 * REPLACE (not UPSERT-preserving-created_at) is deliberate: a disarm DELETEs the
 * row, so a re-arm's "since" is correctly the most-recent arm — re-fold-
 * deterministic for a presence flag (not an audit log). Pure function of the
 * payload — no `Date.now()`, no env read. Malformed payload → safe no-op.
 */
function foldEpicArmed(db: Database, event: Event): void {
  const payload = extractEpicArmedPayload(event);
  if (payload == null) {
    return;
  }
  if (payload.armed) {
    db.run(
      `INSERT OR REPLACE INTO armed_epics (
         epic_id, last_event_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?)`,
      [payload.epic_id, event.id, event.ts, event.ts],
    );
  } else {
    db.run("DELETE FROM armed_epics WHERE epic_id = ?", [payload.epic_id]);
  }
}

/**
 * Sweep open `status='running'` subagent_invocations rows for a job to
 * `status='unknown'` in a single bulk UPDATE. Called from the SessionEnd and
 * Killed arms of {@link projectJobsRow} on the proven write path (after the
 * jobs UPDATE landed), inside the same `BEGIN IMMEDIATE` transaction as the
 * lifecycle write + cursor advance — exactly-once-per-event holds across both
 * projections.
 *
 * Closes the lifecycle gap for orphaned subagents whose parent session died
 * before the matching SubagentStop landed: a `running` row whose job is now
 * `'ended'` / `'killed'` will never close on its own, so flip its status to the
 * indeterminate sentinel `'unknown'` (`duration_ms` stays NULL). The
 * terminal-status guard in the SubagentStop / PostToolUse arms carves out
 * `'unknown'`, so a late close can't revive the row to `'ok'`. Bulk UPDATE (one
 * statement, never throws); matches zero rows when every subagent closed
 * cleanly.
 */
function sweepRunningSubagentsToUnknown(
  db: Database,
  jobId: string,
  eventId: number,
  ts: number,
): void {
  db.run(
    `UPDATE subagent_invocations
        SET status = 'unknown',
            last_event_id = ?, updated_at = ?
      WHERE job_id = ? AND status = 'running'`,
    [eventId, ts, jobId],
  );
}

/**
 * Apply the `subagent_invocations` projection for one event. Four event shapes
 * feed it:
 *
 * - `SubagentStart` opens a new turn-N row for `(job_id, agent_id)` with
 *   `status='running'`, `subagent_type` seeded from `event.agent_type`.
 * - `SubagentStop` closes the latest open turn — `duration_ms = round((event.ts
 *   - row.ts) * 1000)` (events.ts is REAL seconds), `status='ok'` unless already
 *   terminal. Gates on `duration_ms IS NULL` ALONE — never also on
 *   `status='running'`, because PostToolUse:Agent legitimately flips status to
 *   `'ok'` BEFORE SubagentStop lands for Task calls (Anthropic-confirmed).
 * - `PostToolUse` (`tool_name='Agent'`) resolves the `(session_id, tool_use_id)`
 *   bridge to an `agent_id`, folds PreToolUse metadata onto the turn-0 row
 *   (PreToolUse-wins precedence), then marks earlier-spawned same-`(job_id,
 *   subagent_type)` `running` rows `'superseded'` (narrow `row.ts <
 *   currentRow.ts` gate quarantines the parallel-same-type false-positive).
 * - `PostToolUseFailure` (`tool_name='Agent'`) resolves the bridge `agent_id`
 *   from the indexed column (the failure path carries no `tool_response.agentId`)
 *   and UPDATEs a matching turn-0 row to `'failed'` — no terminal guard, the
 *   failure signal always wins. Orphan failures are a safe no-op.
 *
 * SessionEnd / Killed sweep open `running` rows to `'unknown'` via
 * {@link sweepRunningSubagentsToUnknown} elsewhere. NEVER throws — every arm
 * returns silently on the safe-default branch.
 */
function projectSubagentInvocationsRow(db: Database, event: Event): void {
  const ts = event.ts;
  const jobId = event.session_id;

  switch (event.hook_event) {
    case "SubagentStart": {
      // NULL agent_id → safe no-op. Mirrors Python's
      // `if not agent_id: return None` drop.
      const agentId = event.agent_id;
      if (agentId == null || agentId.length === 0) {
        return;
      }
      const turnSeq = extractTurnSeq(db, jobId, agentId);
      const seedType =
        typeof event.agent_type === "string" && event.agent_type.length > 0
          ? event.agent_type
          : null;
      // Early FIFO bridge: lift description / prompt_chars / tool_use_id
      // from the earliest unbound PreToolUse:Agent in this session whose
      // subagent_type matches the SubagentStart's agent_type. Surfaces the
      // description on the board AT START instead of at SubagentStop. The
      // canonical PostToolUse:Agent path (`subagent_agent_id`-keyed) still
      // overwrites with the authoritative values on close, so any FIFO
      // mis-assignment self-corrects. `null` when no type to match on or no
      // unbound PreToolUse row qualifies — leaves the historical SubagentStart
      // defaults (NULL / NULL / 0) in place.
      const pendingPre = findPendingPreToolUseForStart(db, jobId, seedType);
      const seedToolUseId = pendingPre?.tool_use_id ?? null;
      const seedDescription = pendingPre?.description ?? null;
      const seedPromptChars = pendingPre?.prompt_chars ?? 0;
      // INSERT a fresh row at the seeded turn_seq. `status='running'` matches
      // the schema default. NEVER OR IGNORE here — extractTurnSeq's
      // MAX(turn_seq)+1 ensures a fresh row per SubagentStart, and a
      // primary-key collision would be a deterministic re-fold bug worth
      // surfacing rather than silently swallowing.
      db.run(
        `INSERT INTO subagent_invocations (
           job_id, agent_id, turn_seq, ts, tool_use_id, subagent_type,
           description, prompt_chars, status, duration_ms,
           last_event_id, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, ?, ?)`,
        [
          jobId,
          agentId,
          turnSeq,
          ts,
          seedToolUseId,
          seedType,
          seedDescription,
          seedPromptChars,
          event.id,
          ts,
        ],
      );
      return;
    }

    case "SubagentStop": {
      const agentId = event.agent_id;
      if (agentId == null || agentId.length === 0) {
        return;
      }
      const openTurnSeq = findOpenTurnForStop(db, jobId, agentId);
      if (openTurnSeq == null) {
        // Genuine orphan stop — no matching open turn. Safe no-op.
        return;
      }
      // Read the open row's ts to compute duration_ms = (event.ts - row.ts)
      // * 1000, rounded to integer ms — Python's `int(float(ts_raw) * 1000)`
      // convention. Status stays put when already terminal ('failed' /
      // 'unknown'); otherwise lands 'ok'.
      const row = db
        .query(
          `SELECT ts, status FROM subagent_invocations
            WHERE job_id = ? AND agent_id = ? AND turn_seq = ?`,
        )
        .get(jobId, agentId, openTurnSeq) as {
        ts: number;
        status: string;
      } | null;
      if (row == null) {
        // Shouldn't happen — findOpenTurnForStop returned a turn_seq it just
        // looked up — but a defensive no-op never hurts (re-fold safety).
        return;
      }
      const durationMs = Math.round((ts - row.ts) * 1000);
      // Terminal-status guard includes `superseded` alongside `failed` /
      // `unknown`: a late SubagentStop landing on a row already marked
      // superseded by a peer's PostToolUse:Agent arm must NOT flip it back
      // to `ok`. The supersession signal is intentionally sticky — it
      // declares the row's lifecycle was overtaken by a later same-type
      // sibling and must outlive any subsequent close.
      const nextStatus =
        row.status === "failed" ||
        row.status === "unknown" ||
        row.status === "superseded"
          ? row.status
          : "ok";
      db.run(
        `UPDATE subagent_invocations
            SET duration_ms = ?, status = ?, last_event_id = ?, updated_at = ?
          WHERE job_id = ? AND agent_id = ? AND turn_seq = ?`,
        [durationMs, nextStatus, event.id, ts, jobId, agentId, openTurnSeq],
      );
      return;
    }

    case "PostToolUse": {
      // Gate on tool_name='Agent' — non-Agent PostToolUse rows have no
      // subagent_invocations meaning. The dispatcher above already routes
      // here for any PostToolUse, so we filter at the arm.
      if (event.tool_name !== "Agent") {
        return;
      }
      const bridgeAgentId = resolveBridgeAgentId({
        subagent_agent_id: event.subagent_agent_id,
        data: event.data,
      });
      if (bridgeAgentId == null) {
        return;
      }
      // Look up the turn-0 row for the bridged agent_id. A
      // PostToolUse-before-SubagentStart ordering (theoretical) folds to a
      // safe no-op — matches Python; we lose description/prompt_chars for
      // that turn, but SubagentStop's later 'ok' stamp still lands. Also
      // selects `ts` (the SubagentStart spawn ts) for the supersession scan
      // below — the scan's `ts < ?` gate uses this row's spawn ts, NOT the
      // current event's ts.
      const row = db
        .query(
          `SELECT status, subagent_type, ts FROM subagent_invocations
            WHERE job_id = ? AND agent_id = ? AND turn_seq = 0`,
        )
        .get(jobId, bridgeAgentId) as {
        status: string;
        subagent_type: string | null;
        ts: number;
      } | null;
      if (row == null) {
        return;
      }

      // Look up the PreToolUse:Agent metadata via the (session_id,
      // tool_use_id) bridge. A missing tool_use_id, malformed data, or
      // no-matching-PreToolUse row all fold to a defensive no-op below.
      const toolUseId = event.tool_use_id;
      const pre =
        toolUseId != null && toolUseId.length > 0
          ? findBridgePreToolUse(db, jobId, toolUseId)
          : null;

      // PreToolUse-wins precedence on subagent_type: overwrite the
      // SubagentStart seed iff the PreToolUse value is a non-empty string.
      // Mirrors Python's `if subagent_type:` truthiness gate.
      const nextSubagentType =
        pre != null &&
        typeof pre.subagent_type === "string" &&
        pre.subagent_type.length > 0
          ? pre.subagent_type
          : row.subagent_type;

      // Description / prompt_chars come straight from the PreToolUse payload
      // (truncateDescription already applied inside findBridgePreToolUse).
      // When no PreToolUse row exists, leave description NULL and
      // prompt_chars=0 (the SubagentStart seed defaults).
      const nextDescription = pre != null ? pre.description : null;
      const nextPromptChars = pre != null ? pre.prompt_chars : 0;

      // Status: set 'ok' unless already terminal ('failed' / 'unknown' /
      // 'superseded') — mirrors SubagentStop's gate. PostToolUse:Agent fires
      // BEFORE SubagentStop for Task calls (Anthropic-confirmed); this is
      // the legitimate early-'ok' write. The `superseded` carve-out keeps a
      // late PostToolUse:Agent (e.g. for a row already marked superseded by
      // a later same-type sibling's bridge fold) from flipping the
      // supersession signal away.
      const nextStatus =
        row.status === "failed" ||
        row.status === "unknown" ||
        row.status === "superseded"
          ? row.status
          : "ok";

      db.run(
        `UPDATE subagent_invocations
            SET tool_use_id = ?, subagent_type = ?, description = ?,
                prompt_chars = ?, status = ?,
                last_event_id = ?, updated_at = ?
          WHERE job_id = ? AND agent_id = ? AND turn_seq = 0`,
        [
          toolUseId,
          nextSubagentType,
          nextDescription,
          nextPromptChars,
          nextStatus,
          event.id,
          ts,
          jobId,
          bridgeAgentId,
        ],
      );

      // Supersession scan: PostToolUse:Agent is the moment `subagent_type`
      // becomes authoritative (PreToolUse-wins precedence). After resolving
      // the bridge and stamping the row's final `subagent_type`, look for
      // OTHER rows in the same `(job_id, subagent_type)` group that are
      // still `status='running'` and whose SubagentStart-time `ts` is
      // strictly less than this row's spawn ts (`row.ts`). Each match is a
      // prior concurrent same-type sibling that this bridge fold overtook;
      // mark them `status='superseded'` in the same `BEGIN IMMEDIATE`
      // transaction so the supersession signal lands atomically with the
      // bridge UPDATE above.
      //
      // The scan uses the bridged row's spawn ts (`row.ts`) — NOT the
      // current event's ts — so a concurrent same-type spawn whose
      // SubagentStart landed AFTER `row.ts` is NOT swept. This is the
      // deliberate narrow gate: only earlier-spawned still-open peers are
      // marked superseded. See `findOpenRunningInGroup`'s doc for the
      // known-limitation false-positive (two parallel `Task(subagent_type=X)`
      // calls fired in one parent message).
      //
      // Gate on `nextSubagentType != null` — a row with no authoritative
      // subagent_type cannot identify a group to scan over. Use a bulk
      // UPDATE keyed on the matched `(agent_id, turn_seq)` tuples; the
      // helper returns an empty array in the common case (no concurrent
      // peers), so the loop body fires zero times for sequential spawns.
      // NEVER throw inside the transaction (CLAUDE.md fold invariant).
      if (nextSubagentType != null) {
        const superseded = findOpenRunningInGroup(
          db,
          jobId,
          nextSubagentType,
          bridgeAgentId,
          row.ts,
        );
        for (const sup of superseded) {
          db.run(
            `UPDATE subagent_invocations
                SET status = 'superseded',
                    last_event_id = ?, updated_at = ?
              WHERE job_id = ? AND agent_id = ? AND turn_seq = ?`,
            [event.id, ts, jobId, sup.agent_id, sup.turn_seq],
          );
        }
      }
      return;
    }

    case "PostToolUseFailure": {
      // Gate on tool_name='Agent' — non-Agent PostToolUseFailure has no
      // subagent_invocations meaning. The bridge resolves via the
      // `subagent_agent_id` column (the indexed bridge column hook-writers
      // stamp on every PostToolUse[Failure]:Agent). When the bridge column
      // is NULL — the legitimate PostToolUseFailure case, since the failure
      // path carries no `tool_response.agentId` — we have nothing to match
      // on and fold to a safe no-op (orphan failure). When the bridge
      // resolves AND a matching turn-0 row exists, UPDATE its status to
      // `'failed'`, overriding any prior non-failed value (a `'failed'`
      // signal is more informative than a `'running'` / `'ok'` /
      // `'unknown'` / `'superseded'` value, since it carries the
      // tool-execution-failed evidence directly from Claude Code).
      //
      // No `tool_response` is needed — the `subagent_agent_id` column is
      // enough. Orphan failures (no matching row) are a safe no-op,
      // mirroring SubagentStop's orphan-stop branch.
      if (event.tool_name !== "Agent") {
        return;
      }
      const bridgeAgentId = resolveBridgeAgentId({
        subagent_agent_id: event.subagent_agent_id,
        data: event.data,
      });
      if (bridgeAgentId == null) {
        return;
      }
      // UPDATE the matching turn-0 row directly. If no row matches, the
      // UPDATE affects zero rows — safe no-op (orphan failure).
      // `'failed'` always wins (no terminal-status guard) because the
      // failure signal is the most authoritative lifecycle outcome we can
      // observe — it's a hard tool-execution failure surfaced by Claude
      // Code, not a derived sweep or supersession inference.
      db.run(
        `UPDATE subagent_invocations
            SET status = 'failed',
                last_event_id = ?, updated_at = ?
          WHERE job_id = ? AND agent_id = ? AND turn_seq = 0`,
        [event.id, ts, jobId, bridgeAgentId],
      );
      return;
    }

    default:
      return;
  }
}

/**
 * The shape of an `EmbeddedJob` element stored inside an `epics.jobs` array
 * (epic-level: verbs `plan` / `close`) or a task element's nested `jobs`
 * sub-array (task-level: verb `work`). Mirrors {@link import("./types").EmbeddedJob}
 * field-for-field so this serializes byte-identically.
 */
interface EmbeddedJobElement {
  job_id: string;
  plan_verb: string;
  state: string;
  title: string | null;
  created_at: number;
  updated_at: number;
  last_event_id: number;
  last_api_error_at: number | null;
  last_api_error_kind: string | null;
  last_input_request_at: number | null;
  last_input_request_kind: string | null;
  // Paired-NULL with `last_permission_prompt_kind` (move both together — write
  // both or clear both).
  last_permission_prompt_at: number | null;
  last_permission_prompt_kind: string | null;
  // Drives the readiness pipeline's `git-uncommitted` predicate.
  git_dirty_count: number;
  // Drives the readiness pipeline's `git-orphans` predicate.
  git_unattributed_to_live_count: number;
  // Strict-mystery semantic: files with no attribution from any session.
  git_orphan_count: number;
  /**
   * Per-(task, job) task→committing-session link, stamped by {@link foldCommit}
   * on the embedded element whose `job_id == committer_session_id`. `null` on
   * every job that hasn't committed for this task and on every older stored
   * element. Lives on the JSON-TEXT `jobs` cell; no real column.
   *
   * CLOBBER GUARD: a Commit-event fact, NOT a jobs-row fact, so
   * {@link buildEmbeddedJob} reads it BACK from the prior embedded element (the
   * OLD-element carve-out) — a later job-tick re-sync MUST preserve it.
   */
  last_commit_for_task_at?: number | null;
  /**
   * Provenance-filtered live-worker-monitor occupancy fact for THIS session,
   * derived from `jobs.monitors` by {@link hasLiveWorkerMonitor}. Readiness
   * reads it to hold the per-epic / per-root mutex while a work session's
   * backgrounded suite is still running. Lives FREE on the JSON-TEXT `jobs`
   * cell; no real column.
   *
   * CLOBBER GUARD: a Stop-event fact, NOT a jobs-row field — stamped at the
   * Stop fold's monitors-write site, which doesn't always run
   * {@link syncJobIntoEpic} (the sub-agent-guard-swallow path skips it). So
   * {@link buildEmbeddedJob} lifts it forward off the PRIOR embedded element
   * (like `last_commit_for_task_at`). Optional + coalesced to `false` so an
   * older stored element round-trips deterministically.
   */
  has_live_worker_monitor?: boolean;
}

/**
 * The shape of the post-write `jobs` row {@link syncJobIntoEpic} reads back to
 * build the embedded element. Mirrors the relevant subset of {@link import("./types").Job}.
 * The git count fields are required (not nullable) so TypeScript surfaces any
 * caller that forgets to project them out of `jobs`.
 */
interface JobsRowForSync {
  job_id: string;
  plan_verb: string | null;
  plan_ref: string | null;
  state: string;
  title: string | null;
  created_at: number;
  updated_at: number;
  last_event_id: number;
  last_api_error_at: number | null;
  last_api_error_kind: string | null;
  last_input_request_at: number | null;
  last_input_request_kind: string | null;
  // Paired-NULL with `last_permission_prompt_kind`; required on this input
  // shape so a caller that forgets to project them is surfaced by TypeScript.
  last_permission_prompt_at: number | null;
  last_permission_prompt_kind: string | null;
  git_dirty_count: number;
  // Schema v31: renamed from `git_orphan_count` — carries the legacy v28
  // semantic ("files-not-attributed-to-a-live-session") under the new
  // vocabulary.
  git_unattributed_to_live_count: number;
  // Schema v31: new strict-mystery column.
  git_orphan_count: number;
}

/**
 * Parse a persisted JSON-TEXT array column into an array of {@link EmbeddedJobElement}.
 * A NULL/empty/malformed cell folds to `[]` — NEVER throws inside the open
 * BEGIN IMMEDIATE transaction (a throw rolls back the cursor and wedges the
 * reducer). Mirrors the guarded-parse pattern at {@link projectPlanRow}.
 */
function parseEmbeddedJobs(
  text: string | null | undefined,
): EmbeddedJobElement[] {
  if (text == null || text.length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed as EmbeddedJobElement[];
    }
  } catch {
    // malformed stored array → treat as empty, fall through.
  }
  return [];
}

/**
 * The deterministic embedded-jobs sort: `(created_at desc, job_id asc)`. The
 * trailing `job_id` tiebreaker is non-negotiable — two jobs with the same
 * `created_at` would otherwise produce non-deterministic ordering across
 * re-folds, breaking the byte-identical re-fold invariant (CLAUDE.md
 * "byte-identical re-fold").
 */
function sortEmbeddedJobs(jobs: EmbeddedJobElement[]): void {
  jobs.sort((a, b) => {
    if (a.created_at !== b.created_at) {
      return b.created_at - a.created_at; // desc
    }
    return a.job_id < b.job_id ? -1 : a.job_id > b.job_id ? 1 : 0;
  });
}

/**
 * Build an {@link EmbeddedJobElement} from a post-write `jobs` row. `plan_verb`
 * is non-null by construction (the caller short-circuits via `parsePlanRef`).
 * `last_commit_for_task_at` / `has_live_worker_monitor` are event-facts lifted
 * forward from the PRIOR embedded element (the OLD-element carve-out) so a
 * later job-tick re-sync doesn't clobber them — a pure function of the prior +
 * the jobs row, byte-deterministic.
 */
function buildEmbeddedJob(
  row: JobsRowForSync,
  prior?: EmbeddedJobElement | undefined,
): EmbeddedJobElement {
  // Preserve the event-facts across a jobs-row re-sync; coalesce the older
  // stored element's absent field to the zero-event default for a
  // byte-deterministic round-trip.
  const lastCommitForTaskAt = prior?.last_commit_for_task_at ?? null;
  const hasLiveWorkerMonitor = prior?.has_live_worker_monitor ?? false;
  return {
    job_id: row.job_id,
    plan_verb: row.plan_verb ?? "",
    state: row.state,
    title: row.title,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_event_id: row.last_event_id,
    last_api_error_at: row.last_api_error_at,
    last_api_error_kind: row.last_api_error_kind,
    last_input_request_at: row.last_input_request_at,
    last_input_request_kind: row.last_input_request_kind,
    last_permission_prompt_at: row.last_permission_prompt_at,
    last_permission_prompt_kind: row.last_permission_prompt_kind,
    git_dirty_count: row.git_dirty_count,
    git_unattributed_to_live_count: row.git_unattributed_to_live_count,
    git_orphan_count: row.git_orphan_count,
    last_commit_for_task_at: lastCommitForTaskAt,
    has_live_worker_monitor: hasLiveWorkerMonitor,
  };
}

/**
 * Fan a `jobs` row write into the correct embedded array on the `epics`
 * projection.
 *
 * - `plan_ref == null` or shape mismatch → no-op.
 * - `{kind: 'epic'}` (verbs `plan` / `close`) → RMW the parent epic's
 *   `epics.jobs` array.
 * - `{kind: 'task'}` (verb `work`) → RMW the task element's nested `jobs`
 *   sub-array inside the parent epic's `tasks`.
 *
 * Shell-row pattern: when the parent epic / task element doesn't yet exist,
 * insert a shell carrying just the one entry; later snapshot folds preserve the
 * embedded `jobs` arrays. The sort `(created_at desc, job_id asc)` is applied on
 * every write — never append — for byte-identical re-fold. NEVER throws; a
 * malformed stored array folds to `[]`.
 */
function syncJobIntoEpic(
  db: Database,
  jobsRow: JobsRowForSync,
  eventId: number,
  ts: number,
): void {
  if (jobsRow.plan_ref == null) {
    return;
  }
  const parsed = parsePlanRef(jobsRow.plan_ref);
  if (parsed == null) {
    return; // shape mismatch — skip the fan-out, cursor still advances.
  }

  if (parsed.kind === "epic") {
    const epicRow = db
      .query("SELECT jobs FROM epics WHERE epic_id = ?")
      .get(parsed.epic_id) as { jobs: string | null } | null;
    const existing = parseEmbeddedJobs(epicRow?.jobs);
    // Pass the PRIOR embedded element into buildEmbeddedJob so its event-facts
    // survive this re-sync byte-deterministically (irrelevant for plan/close
    // verbs, but re-fold determinism is the invariant).
    const priorEpicSide = existing.find((j) => j.job_id === jobsRow.job_id);
    const element = buildEmbeddedJob(jobsRow, priorEpicSide);
    const next = existing.filter((j) => j.job_id !== element.job_id);
    next.push(element);
    sortEmbeddedJobs(next);
    const jobsJson = JSON.stringify(next);
    if (epicRow != null) {
      db.run(
        "UPDATE epics SET jobs = ?, last_event_id = ?, updated_at = ? WHERE epic_id = ?",
        [jobsJson, eventId, ts, parsed.epic_id],
      );
    } else {
      // No epic row yet — insert a shell row carrying just this jobs entry. A
      // later EpicSnapshot fills the scalars without clobbering `jobs`. Routed
      // through the tombstone-checking helper — the canonical "job-before-epic"
      // ghost-row vector (a terminal write whose `plan_ref` still names a
      // deleted epic); suppressed when tombstoned.
      insertEpicShellIfNotTombstoned(
        db,
        parsed.epic_id,
        `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, last_event_id, updated_at, tasks, jobs)
           VALUES (?, NULL, NULL, NULL, NULL, ?, ?, '[]', ?)`,
        [parsed.epic_id, eventId, ts, jobsJson],
      );
    }
    return;
  }

  // kind === "task": RMW the task element's `jobs` sub-array nested in the
  // parent epic's `tasks` array.
  const epicRow = db
    .query("SELECT tasks FROM epics WHERE epic_id = ?")
    .get(parsed.epic_id) as { tasks: string | null } | null;

  // The full task element shape we read+write. The SLOT ORDER MUST match
  // `projectPlanRow`'s embedded `element` shape AND `seedFromDb`'s
  // reconstruction in `plan-worker.ts` (the change-gate `JSON.stringify`
  // byte-compare is the parity check).
  interface TaskElement {
    task_id: string;
    epic_id: string | null;
    task_number: number | null;
    title: string | null;
    target_repo: string | null;
    /**
     * Planctl-native effort tier. Optional because older stored elements lack
     * the key; the OLD-element carve-out spread below preserves whatever was
     * there. A shell element initialises `tier: null`.
     */
    tier?: string | null;
    worker_phase: string | null;
    runtime_status: string;
    depends_on: unknown[];
    jobs: EmbeddedJobElement[];
  }

  let tasksArr: TaskElement[] = [];
  if (epicRow != null && epicRow.tasks != null && epicRow.tasks.length > 0) {
    try {
      const parsedTasks = JSON.parse(epicRow.tasks);
      if (Array.isArray(parsedTasks)) {
        tasksArr = parsedTasks as TaskElement[];
      }
    } catch {
      // malformed stored array → treat as empty, fall through.
    }
  }

  // Find-or-shell the task element. A first-sight shell has scalar columns NULL
  // — a later TaskSnapshot fills them without clobbering the `jobs` sub-array.
  const oldTask = tasksArr.find((t) => t.task_id === parsed.task_id);
  const oldJobs =
    oldTask != null && Array.isArray(oldTask.jobs) ? oldTask.jobs : [];
  // Pass the PRIOR embedded element into buildEmbeddedJob so a job-tick re-sync
  // preserves the Commit-event link `last_commit_for_task_at` — THE task-level
  // clobber guard; without it every jobs-row write would zero the link
  // `pick_target_job` relies on.
  const priorTaskSide = oldJobs.find((j) => j.job_id === jobsRow.job_id);
  const element = buildEmbeddedJob(jobsRow, priorTaskSide);
  const nextTaskJobs = oldJobs.filter((j) => j.job_id !== element.job_id);
  nextTaskJobs.push(element);
  sortEmbeddedJobs(nextTaskJobs);

  // OLD-element carve-out: when an OLD task element exists, preserve ALL its
  // scalar fields by spreading and re-attaching only the merged `jobs`
  // sub-array — a jobs-write fan-out MUST NOT clobber the plan-snapshot-derived
  // fields, or every job tick would stomp the task-status pills with stale
  // snapshot values.
  const newTaskElement: TaskElement =
    oldTask != null
      ? { ...oldTask, jobs: nextTaskJobs }
      : {
          task_id: parsed.task_id,
          epic_id: parsed.epic_id,
          task_number: null,
          title: null,
          target_repo: null,
          tier: null,
          worker_phase: null,
          // Shell element gets the planctl `"todo"` default (zero-event
          // projection / `merge_task_state` convention).
          runtime_status: "todo",
          depends_on: [],
          jobs: nextTaskJobs,
        };

  // Replace-or-insert by task_id, then re-sort by the same (task_number,
  // task_id) key the plan fold uses.
  const nextTasks: TaskElement[] = tasksArr.filter(
    (t) => t.task_id !== parsed.task_id,
  );
  nextTasks.push(newTaskElement);
  nextTasks.sort((a, b) => {
    const an = a.task_number;
    const bn = b.task_number;
    if (an !== bn) {
      if (an == null) return -1;
      if (bn == null) return 1;
      return an - bn;
    }
    return a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0;
  });
  const tasksJson = JSON.stringify(nextTasks);

  if (epicRow != null) {
    db.run(
      "UPDATE epics SET tasks = ?, last_event_id = ?, updated_at = ? WHERE epic_id = ?",
      [tasksJson, eventId, ts, parsed.epic_id],
    );
  } else {
    // No epic row yet — insert a shell epic carrying the shell task element.
    // A later EpicSnapshot fills the epic scalars; a later TaskSnapshot
    // fills the task element's scalars (and preserves its `jobs` via the
    // OLD-element-`jobs` RMW step).
    // Schema v53 (fn-688): routed through the shared tombstone-checking
    // helper — symmetric to the epic-kind shell-INSERT above. A
    // tombstoned epic suppresses the shell, never-deleted epics still
    // get their legit before-arrival shell + task element.
    insertEpicShellIfNotTombstoned(
      db,
      parsed.epic_id,
      `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, last_event_id, updated_at, tasks, jobs)
         VALUES (?, NULL, NULL, NULL, NULL, ?, ?, ?, '[]')`,
      [parsed.epic_id, eventId, ts, tasksJson],
    );
  }
}

/**
 * Read the post-write `jobs` row and fan into:
 *   (1) the embedded `epics.jobs` / task `jobs` sub-arrays via
 *       {@link syncJobIntoEpic} — gated on `plan_ref != null`.
 *   (2) every linked epic's `epics.job_links` entries via
 *       {@link syncJobLinksOnJobWrite} — gated on `epic_links != '[]'`,
 *       INDEPENDENT of `plan_ref` (a manual session can still carry a
 *       creator/refiner edge from `planctl epic-create`).
 *
 * The SELECT lives here (not at each call site) so both fan-outs read the
 * LATEST state-machine state in lockstep. The caller MUST gate on "an
 * UPDATE/INSERT actually wrote" — the Killed-mismatch path must NOT fire either
 * fan-out.
 */
function syncIfPlanRef(
  db: Database,
  jobId: string,
  eventId: number,
  ts: number,
): void {
  const row = db
    .query(
      "SELECT job_id, plan_verb, plan_ref, state, title, created_at, updated_at, last_event_id, last_api_error_at, last_api_error_kind, last_input_request_at, last_input_request_kind, last_permission_prompt_at, last_permission_prompt_kind, git_dirty_count, git_unattributed_to_live_count, git_orphan_count FROM jobs WHERE job_id = ?",
    )
    .get(jobId) as JobsRowForSync | null;
  if (row == null) {
    return;
  }
  if (row.plan_ref != null) {
    syncJobIntoEpic(db, row, eventId, ts);
  }
  // Always call: `syncJobLinksOnJobWrite` short-circuits on `'[]'` itself, and
  // gating on `plan_ref != null` would miss creator/refiner sessions whose
  // spawn name didn't parse as a planctl verb (e.g. a manual `planctl
  // epic-create`).
  syncJobLinksOnJobWrite(db, jobId, eventId, ts);
}

/**
 * Parse a persisted JSON-TEXT array column into an array of {@link EpicLink}.
 * A NULL/empty/malformed cell folds to `[]` — NEVER throws inside the open
 * BEGIN IMMEDIATE transaction (a throw rolls back the cursor and wedges the
 * reducer). Parallel to {@link parseEmbeddedJobs}.
 */
function parseEmbeddedLinks<T extends EpicLink | JobLink>(
  text: string | null | undefined,
): T[] {
  if (text == null || text.length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed as T[];
    }
  } catch {
    // malformed stored array → treat as empty, fall through.
  }
  return [];
}

/**
 * Deterministic sort for an embedded `epic_links` array. Total-order ASC on the
 * full `(kind, target)` tuple — a single-field sort would leave equal-`kind`
 * ties in implementation-defined order, breaking byte-identical re-fold.
 */
function sortEpicLinks(links: EpicLink[]): void {
  links.sort((a, b) => {
    if (a.kind < b.kind) return -1;
    if (a.kind > b.kind) return 1;
    if (a.target < b.target) return -1;
    if (a.target > b.target) return 1;
    return 0;
  });
}

/**
 * Deterministic sort for an embedded `job_links` array. Total-order ASC on the
 * full `(kind, job_id)` tuple. Accepts any `{kind, job_id}` so both the thin
 * classifier shape and the enriched projection shape sort through the same path.
 */
function sortJobLinks(
  links: { kind: "creator" | "refiner"; job_id: string }[],
): void {
  links.sort((a, b) => {
    if (a.kind < b.kind) return -1;
    if (a.kind > b.kind) return 1;
    if (a.job_id < b.job_id) return -1;
    if (a.job_id > b.job_id) return 1;
    return 0;
  });
}

/**
 * Enrich a thin classifier-output `JobLink` (`{kind, job_id}`) into the widened
 * `JobLinkEntry` shape carried on `epics.job_links`, adding the display +
 * annotation fields off the post-write `jobs` row. Shared between
 * `syncPlanctlLinks` and `syncJobLinksOnJobWrite` so both produce identical JSON.
 *
 * On a missing `jobs` row, returns the zero-event defaults with the api-error
 * columns as explicit JSON nulls (NOT omitted) — omitting keys vs. emitting
 * nulls produces different `JSON.stringify` bytes. KEY ORDER IS LOCKED for the
 * same reason: any drift between branches breaks byte-identical re-fold. NEVER
 * throws inside the transaction.
 */
function enrichJobLink(db: Database, classifierEntry: JobLink): JobLinkEntry {
  const row = db
    .query(
      "SELECT title, state, last_api_error_at, last_api_error_kind, last_input_request_at, last_input_request_kind, last_permission_prompt_at, last_permission_prompt_kind FROM jobs WHERE job_id = ?",
    )
    .get(classifierEntry.job_id) as {
    title: string | null;
    state: string;
    last_api_error_at: number | null;
    last_api_error_kind: string | null;
    last_input_request_at: number | null;
    last_input_request_kind: string | null;
    last_permission_prompt_at: number | null;
    last_permission_prompt_kind: string | null;
  } | null;
  if (row == null) {
    return {
      kind: classifierEntry.kind,
      job_id: classifierEntry.job_id,
      title: null,
      state: "stopped",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
      last_permission_prompt_at: null,
      last_permission_prompt_kind: null,
    };
  }
  return {
    kind: classifierEntry.kind,
    job_id: classifierEntry.job_id,
    title: row.title,
    state: row.state,
    last_api_error_at: row.last_api_error_at,
    last_api_error_kind: row.last_api_error_kind,
    last_input_request_at: row.last_input_request_at,
    last_input_request_kind: row.last_input_request_kind,
    last_permission_prompt_at: row.last_permission_prompt_at,
    last_permission_prompt_kind: row.last_permission_prompt_kind,
  };
}

/**
 * Reverse fan-out from a jobs-write that may have changed display / annotation
 * fields on a session whose planctl footprint already produced epic-link edges.
 * For each epic referencing this `jobId` via the symmetric `jobs.epic_links`
 * array, re-stamp the matching `epics.job_links` entry with fresh enrichment,
 * preserving every OTHER entry verbatim (the OLD-element carve-out — without it
 * a jobs-write would clobber every cross-session edge).
 *
 * Has its OWN gate (`epic_links !== '[]'`), NOT piggybacking on `plan_ref` (a
 * creator/refiner session may have `plan_ref = null`). The reverse lookup walks
 * the symmetric `jobs.epic_links` array (a PK read) rather than a `json_each`
 * scan of `epics.job_links` (an unindexed TVF). When a targeted epic row
 * doesn't exist yet, shell-insert it. NEVER throws; a malformed blob folds to
 * `[]`.
 */
function syncJobLinksOnJobWrite(
  db: Database,
  jobId: string,
  eventId: number,
  ts: number,
): void {
  const jobRow = db
    .query("SELECT epic_links FROM jobs WHERE job_id = ?")
    .get(jobId) as { epic_links: string | null } | null;
  if (jobRow == null) {
    return; // no backing jobs row — orphan, nothing to fan from.
  }
  // `'[]'` short-circuit: a cheap pre-parse skip for the common case (a session
  // with no planctl footprint); the schema default and the reducer's empty
  // write both produce `'[]'` exactly.
  if (jobRow.epic_links === null || jobRow.epic_links === "[]") {
    return;
  }
  const epicLinks = parseEmbeddedLinks<EpicLink>(jobRow.epic_links);
  if (epicLinks.length === 0) {
    return; // malformed/empty after parse — nothing to fan into.
  }

  // Build the enriched entry once (amortizes the SELECT across every touched
  // epic). `kind` here is a placeholder — the per-epic loop re-stamps with the
  // kind from the existing entry it replaces.
  const enriched = enrichJobLink(db, { kind: "creator", job_id: jobId });

  for (const epicLink of epicLinks) {
    const epicId = epicLink.target;
    const epicRow = db
      .query("SELECT job_links FROM epics WHERE epic_id = ?")
      .get(epicId) as { job_links: string | null } | null;
    const existing =
      epicRow != null
        ? parseEmbeddedLinks<JobLinkEntry>(epicRow.job_links)
        : [];
    // OLD-element carve-out: drop the entry for THIS job_id, preserve every
    // other verbatim. Re-stamp with the OLD entry's `kind` (the classifier, not
    // the jobs-write, owns creator vs. refiner; this helper only refreshes
    // display fields).
    const oldEntry = existing.find((e) => e.job_id === jobId);
    if (oldEntry == null) {
      // Unreachable in a healthy projection (`jobs.epic_links` and
      // `epics.job_links` are atomically co-written); defense-in-depth so a
      // corrupt blob can't wedge the fan-out.
      continue;
    }
    const next = existing.filter((e) => e.job_id !== jobId);
    next.push({
      ...enriched,
      kind: oldEntry.kind,
    });
    sortJobLinks(next);
    const jobLinksJson = JSON.stringify(next);
    if (epicRow != null) {
      db.run(
        "UPDATE epics SET job_links = ?, last_event_id = ?, updated_at = ? WHERE epic_id = ?",
        [jobLinksJson, eventId, ts, epicId],
      );
    } else {
      // No epic row yet — shell-insert. The EpicSnapshot ON CONFLICT carve-out
      // preserves `job_links` / `created_by_closer_of` / `sort_path` /
      // `queue_jump`, so a later snapshot can't wipe the enriched payload; the
      // next `syncPlanctlLinks` computes the closer columns. `queue_jump` is
      // omitted so SQLite fills its `NOT NULL DEFAULT 0`.
      db.run(
        `INSERT INTO epics (
           epic_id, epic_number, title, project_dir, status,
           last_event_id, updated_at, tasks, jobs, job_links,
           created_by_closer_of, sort_path
         ) VALUES (?, NULL, NULL, NULL, NULL, ?, ?, '[]', '[]', ?, NULL, '')`,
        [epicId, eventId, ts, jobLinksJson],
      );
    }
  }
}

/**
 * Extract the envelope's `state_repo` (the absolute path planctl wrote
 * `.planctl/...` into) from the stored event payload. Pure parse; a malformed
 * payload / missing envelope / non-string `state_repo` folds to `null` (the
 * mint is a no-op then), keeping the fold tx sacred.
 */
function extractPlanctlStateRepo(event: Event): string | null {
  if (event.data == null || event.data.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  // Two equivalent envelope shapes: (1) the canonical PostToolUse:Bash hook
  // payload `{tool_response:{stdout:"{...planctl_invocation...}"}}`, and (2) a
  // top-level inlined `planctl_invocation` (synthetic / test events).
  const obj = parsed as Record<string, unknown>;
  // Path 1: hook payload — dive through tool_response.stdout.
  const toolResponse = obj.tool_response;
  if (typeof toolResponse === "object" && toolResponse !== null) {
    const stdout = (toolResponse as Record<string, unknown>).stdout;
    if (typeof stdout === "string" && stdout.length > 0) {
      let inner: unknown;
      try {
        inner = JSON.parse(stdout);
      } catch {
        // Fall through to path 2 — the stdout might not be JSON for a
        // non-planctl event, but the planctl_op gate above already ensured
        // this IS a planctl envelope, so the stdout should parse. A parse
        // miss here is a malformed payload — fold to null.
        inner = null;
      }
      if (typeof inner === "object" && inner !== null) {
        const env = (inner as Record<string, unknown>).planctl_invocation;
        if (typeof env === "object" && env !== null) {
          const sr = (env as Record<string, unknown>).state_repo;
          if (typeof sr === "string" && sr.length > 0) {
            return sr;
          }
        }
      }
    }
  }
  // Path 2: top-level inlined envelope (synthetic / test shape).
  const topLevelEnv = obj.planctl_invocation;
  if (typeof topLevelEnv === "object" && topLevelEnv !== null) {
    const sr = (topLevelEnv as Record<string, unknown>).state_repo;
    if (typeof sr === "string" && sr.length > 0) {
      return sr;
    }
  }
  return null;
}

/**
 * Mint one `source='planctl'` `file_attributions` row per path in the event's
 * `planctl_files` array, keyed under the envelope's `state_repo` +
 * `event.session_id` + the repo-relative path. Without it, `.planctl/...` files
 * (written by the planctl CLI, not a Claude Write/Edit or recognized bash
 * mutation) would appear as strict-mystery orphans on the next `GitSnapshot`.
 *
 * The `(project_dir, file_path)` tuple MUST match the
 * `(GitSnapshot.project_dir, dirty_files[].path)` tuple downstream:
 * `project_dir = state_repo` (canonical absolute path), `file_path =
 * <repo-relative>`. `worktree_oid` / `worktree_mode` ride NULL — the next
 * GitSnapshot's `refreshWorktreeOidStmt` stamps them. All inputs are pure
 * event-derived, so re-fold is byte-identical. No-op (cursor still advances)
 * when `planctl_op` / `planctl_files` are absent or `state_repo` can't be
 * lifted. NEVER throws.
 */
function mintPlanctlFileAttributions(db: Database, event: Event): void {
  if (event.planctl_op == null || event.planctl_files == null) {
    return;
  }
  let files: unknown;
  try {
    files = JSON.parse(event.planctl_files);
  } catch {
    return;
  }
  if (!Array.isArray(files) || files.length === 0) {
    return;
  }
  const stateRepo = extractPlanctlStateRepo(event);
  if (stateRepo === null) {
    return;
  }
  // Same UPSERT shape as projectGitStatus pass-1. `worktree_oid` /
  // `worktree_mode` ride NULL (stamped by the next GitSnapshot). The newest-wins
  // UPDATE gate keeps a stale planctl event from overwriting a newer attribution.
  const upsertStmt = db.prepare(
    `INSERT INTO file_attributions
       (project_dir, session_id, file_path, last_mutation_at,
        last_commit_at, op, source, last_event_id, updated_at,
        worktree_oid, worktree_mode)
       VALUES (?, ?, ?, ?, NULL, ?, 'planctl', ?, ?, NULL, NULL)
       ON CONFLICT(project_dir, session_id, file_path) DO UPDATE SET
         last_mutation_at = excluded.last_mutation_at,
         op = excluded.op,
         source = excluded.source,
         last_event_id = excluded.last_event_id,
         updated_at = excluded.updated_at
       WHERE excluded.last_mutation_at > file_attributions.last_mutation_at`,
  );
  for (const rawPath of files) {
    if (typeof rawPath !== "string" || rawPath.length === 0) continue;
    // Skip absolute paths (planctl emits relative; an absolute path would never
    // match the `dirty_files[].path` tuple and strand as an orphan).
    if (rawPath.startsWith("/")) continue;
    // Skip `..` traversal — defensive against a corrupt envelope.
    if (rawPath.includes("..")) continue;
    upsertStmt.run(
      stateRepo,
      event.session_id,
      rawPath,
      event.ts,
      event.planctl_op,
      event.id,
      event.ts,
    );
  }
}

/**
 * Fan a planctl-CLI invocation (or a `/plan:plan` window opener) into the
 * `jobs.epic_links` + per-touched-epic `epics.job_links` projections. Parallel
 * to {@link syncJobIntoEpic} but with a disjoint trigger, so the two helpers do
 * NOT share code. Re-derives from scratch on every triggering event
 * (full-replace, never delta-merge) for byte-identical re-fold:
 *
 *   1. Load every planctl invocation for `sessionId` — the UNION of the legacy
 *      `events.planctl_op` stdout-scrape rows and durable commit-trailer facts
 *      ({@link loadCommitTrailerInvocations}). The classifier dedups, so a
 *      scrape and a commit for the same op collapse to one edge; a scaffold
 *      whose scrape yielded NULL still produces a creator edge via the commit
 *      channel. Also load every `/plan:plan` opener (`PreToolUse +
 *      skill_name='plan:plan'` only — `slash_command` rows would double-fire).
 *   2-6. Compute windows + `epic_links`, read the pre-state, UPDATE the jobs
 *      row.
 *   7. For each epic in the pre+post union, re-derive `job_links` over the FULL
 *      per-epic namespace; shell-insert a missing epic row.
 *
 * No-op when the jobs row for `sessionId` doesn't exist (no SessionStart yet).
 * NEVER throws; a malformed stored array folds to `[]`.
 */

/**
 * Load the durable commit-trailer facts for one session as synthetic
 * {@link ClassifierInvocation}s, to UNION with the stdout-scrape rows inside
 * {@link syncPlanctlLinks}. Synthetic `Commit` events carry the trailer facts
 * ONLY in the `data` blob, so this scans `Commit` rows and filters in SQL via
 * `json_extract` on `committer_session_id` + `planctl_op`, re-parsing survivors
 * through {@link extractCommit} (no re-normalize — the producer already
 * normalized `planctl_op`). Each maps to one `ClassifierInvocation` with `ts =
 * committed_at_ms / 1000` (so it falls inside the open-ended final `/plan:plan`
 * window), `epic_id` via the same target→epic split the scrape deriver uses,
 * and `subject_present = true` (a trailer only rides a mutating chore commit).
 *
 * Ordered by event `id` ASC for a stable window-advance. Pure read; a malformed
 * blob is skipped by `extractCommit`, never throws. Older `Commit` events with
 * NULL `planctl_op` are excluded by the filter, so the union is a no-op over
 * the historical log.
 */
function loadCommitTrailerInvocations(
  db: Database,
  sessionId: string,
): ClassifierInvocation[] {
  // The blob VALUE and the `json_extract` filters resolve via
  // `COALESCE(events.data, event_blobs.data)`, so a relocated Commit blob still
  // matches and re-parses byte-identically. No expression index covers these
  // Commit `json_extract` probes, so COALESCE-ing the WHERE breaks no index.
  const rows = db
    .query(
      `SELECT COALESCE(events.data, event_blobs.data) AS data
         FROM events
         LEFT JOIN event_blobs ON event_blobs.event_id = events.id
        WHERE hook_event = 'Commit'
          AND json_extract(COALESCE(events.data, event_blobs.data), '$.committer_session_id') = ?
          AND json_extract(COALESCE(events.data, event_blobs.data), '$.planctl_op') IS NOT NULL
        ORDER BY events.id ASC`,
    )
    .all(sessionId) as { data: string }[];
  const out: ClassifierInvocation[] = [];
  for (const r of rows) {
    const commit = extractCommit({ data: r.data });
    if (commit == null) {
      continue;
    }
    // Re-assert the validated shape (op non-empty, target a valid plan ref). A
    // commit whose target failed validation drops — the scrape path's `epic_id`
    // would have been null too, so the classifier yields no edge either way.
    if (commit.planctl_op == null || commit.planctl_target == null) {
      continue;
    }
    out.push({
      ts: commit.committed_at_ms / 1000,
      op: commit.planctl_op,
      target: commit.planctl_target,
      epic_id: parsePlanRef(commit.planctl_target)?.epic_id ?? null,
      subject_present: true,
    });
  }
  return out;
}

/**
 * Find every distinct `committer_session_id` whose commit-trailer facts touch
 * ANY of `epicIds` — the commit-channel counterpart to {@link syncPlanctlLinks}'s
 * scrape-side session sweep. Without it, a session that ONLY ever produced
 * commit-trailer edges would be invisible to the per-epic `deriveJobLinks`
 * rebuild. A commit "touches" an epic when the trailer's target parses to that
 * epic OR the raw target equals the epic id. Pure read; never throws. Returns a
 * deduped Set of session ids.
 */
function loadCommitTrailerSessionsForEpics(
  db: Database,
  epicIds: ReadonlySet<string>,
): Set<string> {
  const sessions = new Set<string>();
  if (epicIds.size === 0) {
    return sessions;
  }
  // Same COALESCE(events.data, event_blobs.data) resolution as
  // loadCommitTrailerInvocations — a relocated Commit blob stays matchable and
  // re-parsable.
  const rows = db
    .query(
      `SELECT COALESCE(events.data, event_blobs.data) AS data
         FROM events
         LEFT JOIN event_blobs ON event_blobs.event_id = events.id
        WHERE hook_event = 'Commit'
          AND json_extract(COALESCE(events.data, event_blobs.data), '$.planctl_op') IS NOT NULL
          AND json_extract(COALESCE(events.data, event_blobs.data), '$.committer_session_id') IS NOT NULL
        ORDER BY events.id ASC`,
    )
    .all() as { data: string }[];
  for (const r of rows) {
    const commit = extractCommit({ data: r.data });
    if (commit == null) {
      continue;
    }
    if (
      commit.committer_session_id == null ||
      commit.planctl_op == null ||
      commit.planctl_target == null
    ) {
      continue;
    }
    const epicId = parsePlanRef(commit.planctl_target)?.epic_id ?? null;
    if (
      (epicId !== null && epicIds.has(epicId)) ||
      epicIds.has(commit.planctl_target)
    ) {
      sessions.add(commit.committer_session_id);
    }
  }
  return sessions;
}

function syncPlanctlLinks(
  db: Database,
  sessionId: string,
  eventId: number,
  ts: number,
): void {
  // The backing jobs row must exist for an epic_links UPDATE to land. A planctl
  // invocation in a session with no SessionStart is an orphan; skip the
  // jobs-side write but still re-derive every touched epic's job_links so
  // symmetry holds.
  const jobsRow = db
    .query("SELECT epic_links FROM jobs WHERE job_id = ?")
    .get(sessionId) as { epic_links: string | null } | null;

  // Load this session's planctl invocations (ASC by event id for stable
  // window-pointer advance); the partial composite index serves this without a
  // full-table scan.
  const invRows = db
    .query(
      `SELECT ts, planctl_op, planctl_target, planctl_epic_id,
              planctl_subject_present
         FROM events
        WHERE session_id = ? AND planctl_op IS NOT NULL
        ORDER BY id ASC`,
    )
    .all(sessionId) as {
    ts: number;
    planctl_op: string;
    planctl_target: string | null;
    planctl_epic_id: string | null;
    planctl_subject_present: number | null;
  }[];
  const invocations: ClassifierInvocation[] = invRows.map((r) => ({
    ts: r.ts,
    op: normalizePlanctlOp(r.planctl_op),
    target: r.planctl_target,
    epic_id: r.planctl_epic_id,
    subject_present: r.planctl_subject_present === 1,
  }));
  // UNION the durable commit-trailer facts — the classifier dedups, so a scrape
  // and a commit for the same scaffold collapse to one creator edge, and a
  // scrape-NULL scaffold's commit fact alone still mints it.
  invocations.push(...loadCommitTrailerInvocations(db, sessionId));

  // Load this session's `/plan:plan` openers. Locked gate: `PreToolUse +
  // skill_name='plan:plan'` only — a slash-command UserPromptSubmit would
  // double-fire on the same call.
  const openerRows = db
    .query(
      `SELECT ts
         FROM events
        WHERE session_id = ?
          AND hook_event = 'PreToolUse'
          AND skill_name = 'plan:plan'
        ORDER BY id ASC`,
    )
    .all(sessionId) as { ts: number }[];
  const windows = computePlanWindows(openerRows.map((r) => r.ts));

  // Compute the new epic_links from scratch (full-replace, never delta-merge —
  // delta-merge would double on re-fold).
  const newEpicLinks = deriveEpicLinks(invocations, windows);
  sortEpicLinks(newEpicLinks);

  // Read the pre-state epic_links so we know which epics' job_links need a
  // re-derive (every target that appears in EITHER pre or post — a removed
  // edge still needs its epic's job_links updated to drop the stale entry).
  const preEpicLinks =
    jobsRow != null ? parseEmbeddedLinks<EpicLink>(jobsRow.epic_links) : [];
  const touchedEpics = new Set<string>();
  for (const link of preEpicLinks) {
    touchedEpics.add(link.target);
  }
  for (const link of newEpicLinks) {
    touchedEpics.add(link.target);
  }

  // UPDATE the jobs row's epic_links. Skip when the backing row does not
  // exist (orphan invocation — no SessionStart for this session_id yet).
  if (jobsRow != null) {
    db.run(
      "UPDATE jobs SET epic_links = ?, last_event_id = ?, updated_at = ? WHERE job_id = ?",
      [JSON.stringify(newEpicLinks), eventId, ts, sessionId],
    );
  }

  if (touchedEpics.size === 0) {
    return;
  }

  // Step 1: find every distinct session_id with at least one planctl invocation
  // touching any of `touchedEpics` (epic id as planctl_epic_id or
  // planctl_target). UNION (not OR) so the planner uses BOTH partial indexes —
  // SQLite picks one index per cross-column OR, but a UNION's branches each
  // SEARCH their own index. The session_id set is identical to the OR form, so
  // re-fold determinism holds.
  const targetList = [...touchedEpics];
  const placeholders = targetList.map(() => "?").join(",");
  const sessionRows = db
    .query(
      `SELECT session_id
         FROM events
        WHERE planctl_op IS NOT NULL
          AND planctl_epic_id IN (${placeholders})
        UNION
       SELECT session_id
         FROM events
        WHERE planctl_op IS NOT NULL
          AND planctl_target IN (${placeholders})`,
    )
    .all(...targetList, ...targetList) as { session_id: string }[];
  // Add the current session too, in case it touched a pre-state epic that no
  // invocation now references (a dropped refiner edge) so its now-stale
  // job_links entry gets pulled.
  const sessionIds = new Set<string>(sessionRows.map((r) => r.session_id));
  sessionIds.add(sessionId);
  // The scrape-side sweep only sees sessions with populated sparse columns; add
  // every commit-channel session (whose `Commit` events carry NULL sparse
  // columns) touching a touched epic so the per-epic rebuild sees its
  // commit-only creator/refiner.
  for (const sid of loadCommitTrailerSessionsForEpics(db, touchedEpics)) {
    sessionIds.add(sid);
  }

  const invocationsBySession = new Map<string, ClassifierInvocation[]>();
  const windowsBySession = new Map<string, PlanWindow[]>();
  for (const sid of sessionIds) {
    const sidInvRows = db
      .query(
        `SELECT ts, planctl_op, planctl_target, planctl_epic_id,
                planctl_subject_present
           FROM events
          WHERE session_id = ? AND planctl_op IS NOT NULL
          ORDER BY id ASC`,
      )
      .all(sid) as {
      ts: number;
      planctl_op: string;
      planctl_target: string | null;
      planctl_epic_id: string | null;
      planctl_subject_present: number | null;
    }[];
    const sidInvocations: ClassifierInvocation[] = sidInvRows.map((r) => ({
      ts: r.ts,
      op: normalizePlanctlOp(r.planctl_op),
      target: r.planctl_target,
      epic_id: r.planctl_epic_id,
      subject_present: r.planctl_subject_present === 1,
    }));
    // UNION this session's commit-trailer facts so the per-epic rebuild
    // classifies BOTH channels symmetrically. Concat is safe — the classifier
    // dedups + re-sorts by ts.
    sidInvocations.push(...loadCommitTrailerInvocations(db, sid));
    invocationsBySession.set(sid, sidInvocations);
    const sidOpenerRows = db
      .query(
        `SELECT ts
           FROM events
          WHERE session_id = ?
            AND hook_event = 'PreToolUse'
            AND skill_name = 'plan:plan'
          ORDER BY id ASC`,
      )
      .all(sid) as { ts: number }[];
    windowsBySession.set(
      sid,
      computePlanWindows(sidOpenerRows.map((r) => r.ts)),
    );
  }

  // Step 2: re-derive job_links for each touched epic and UPDATE the epic row
  // (shell-insert a missing one). Per-epic, also derive `created_by_closer_of`
  // (the closer→child link) and `sort_path` (the materialized-path sort key),
  // then transitively re-stamp every descendant's `sort_path` whose
  // closer-chain leads back to this epic — inside the same transaction for
  // byte-identical re-fold.
  for (const epicId of touchedEpics) {
    const newJobLinks = deriveJobLinks(
      invocationsBySession,
      windowsBySession,
      epicId,
    );
    // Enrich each thin classifier entry into the widened JobLinkEntry shape via
    // the SAME helper the jobs-write fan-out uses — a single source of truth for
    // the on-disk projection shape is required for re-fold determinism.
    const enriched: JobLinkEntry[] = newJobLinks.map((e) =>
      enrichJobLink(db, e),
    );
    sortJobLinks(enriched);
    const jobLinksJson = JSON.stringify(enriched);

    // Derive `created_by_closer_of` from the creator entries whose backing
    // `jobs` row is `plan_verb='close' AND plan_ref IS NOT NULL`; tie-break on
    // lowest `job_id` ASC. None → NULL.
    let createdByCloserOf: string | null = null;
    const creatorJobIds = enriched
      .filter((e) => e.kind === "creator")
      .map((e) => e.job_id);
    if (creatorJobIds.length > 0) {
      const placeholders = creatorJobIds.map(() => "?").join(",");
      const closerRows = db
        .query(
          `SELECT job_id, plan_ref
             FROM jobs
            WHERE job_id IN (${placeholders})
              AND plan_verb = 'close'
              AND plan_ref IS NOT NULL
            ORDER BY job_id ASC`,
        )
        .all(...creatorJobIds) as {
        job_id: string;
        plan_ref: string;
      }[];
      if (closerRows.length > 0) {
        createdByCloserOf = closerRows[0].plan_ref;
      }
    }

    // Derive `sort_path` from `created_by_closer_of` and this epic's
    // `epic_number`: root → `zeroPad6(epic_number)`; non-root → inherit parent's
    // path; missing/placeholder parent → fall back to root-level (the cascade
    // re-stamps when the parent resolves); `epic_number >= 1_000_000` → `''` +
    // note (never throws). `epic_number` is read off the touched row, so a shell
    // row (planctl event before the EpicSnapshot) has NULL → folds to
    // `"000000"`; the next EpicSnapshot recomputes against the known number.
    const ownRow = db
      .query("SELECT epic_number FROM epics WHERE epic_id = ?")
      .get(epicId) as { epic_number: number | null } | null;
    const ownNumber = ownRow?.epic_number ?? 0;

    // Derive `queue_jump`: scan this epic's events for any planctl envelope that
    // carried `queue_jump: true`. Sticky-true — any single flip locks the epic
    // queued for the projection's lifetime (no `/plan:unqueue`); a re-fold
    // replays the same envelopes, so EXISTS is byte-deterministic. Keyed off
    // `planctl_epic_id`, served by the dedicated partial composite index.
    const queueJumpRow = db
      .query(
        `SELECT EXISTS(
           SELECT 1 FROM events
            WHERE planctl_op IS NOT NULL
              AND planctl_epic_id = ?
              AND planctl_queue_jump = 1
         ) AS hit`,
      )
      .get(epicId) as { hit: number };
    const queueJump = queueJumpRow.hit === 1 ? 1 : 0;

    let sortPath: string;
    if (ownNumber >= 1_000_000) {
      // Overflow guard — width=6 can't represent this monotonic id; the
      // documented ceiling is 999,999. Fold to `''` and note; never throw.
      console.error(
        `keeper reducer: epic ${epicId} has epic_number=${ownNumber} ` +
          `>= 1_000_000; sort_path overflow ceiling — folding to ''`,
      );
      sortPath = "";
    } else if (createdByCloserOf == null) {
      // Root: prepend `!` when queue_jump=1 so this epic sorts strictly above
      // non-queued roots under SQLite BINARY collation (`!` = ASCII 33 <
      // digits). Multiple queue-jumped roots sort FIFO under the shared prefix.
      sortPath =
        queueJump === 1 ? `!${zeroPad6(ownNumber)}` : zeroPad6(ownNumber);
    } else {
      const parentRow = db
        .query("SELECT sort_path FROM epics WHERE epic_id = ?")
        .get(createdByCloserOf) as { sort_path: string | null } | null;
      const parentPath = parentRow?.sort_path ?? "";
      if (parentPath === "") {
        // Parent missing / placeholder — fall back to root-level; the cascade
        // re-stamps (with any inherited `!`-prefix) when the parent resolves.
        sortPath = zeroPad6(ownNumber);
      } else {
        // Non-root: inherit the parent's path verbatim — a parent `!`-prefix
        // propagates through the concat for free.
        sortPath = `${parentPath}.${zeroPad6(ownNumber)}`;
      }
    }

    const epicExists = db
      .query("SELECT epic_id FROM epics WHERE epic_id = ?")
      .get(epicId) as { epic_id: string } | null;
    if (epicExists != null) {
      db.run(
        "UPDATE epics SET job_links = ?, created_by_closer_of = ?, sort_path = ?, queue_jump = ?, last_event_id = ?, updated_at = ? WHERE epic_id = ?",
        [
          jobLinksJson,
          createdByCloserOf,
          sortPath,
          queueJump,
          eventId,
          ts,
          epicId,
        ],
      );
    } else {
      // Shell-insert: no epic row yet. The just-derived closer/sort/queue
      // columns are stamped (sort_path typically the `"000000"` placeholder
      // until an EpicSnapshot supplies `epic_number`); the ON CONFLICT carve-out
      // preserves them. Routed through the tombstone-checking helper — a
      // planctl-event-before-epic shell for a deleted epic is suppressed.
      insertEpicShellIfNotTombstoned(
        db,
        epicId,
        `INSERT INTO epics (
           epic_id, epic_number, title, project_dir, status,
           last_event_id, updated_at, tasks, jobs, job_links,
           created_by_closer_of, sort_path, queue_jump
         ) VALUES (?, NULL, NULL, NULL, NULL, ?, ?, '[]', '[]', ?, ?, ?, ?)`,
        [
          epicId,
          eventId,
          ts,
          jobLinksJson,
          createdByCloserOf,
          sortPath,
          queueJump,
        ],
      );
    }

    // Transitive cascade: re-stamp `sort_path` on every descendant whose
    // `created_by_closer_of` is this epic. Cycles can't form
    // (`created_by_closer_of` is immutable once set); the cycle guard is
    // defense-in-depth.
    cascadeSortPath(db, epicId, eventId, ts);
  }
}

/**
 * Re-stamp `sort_path` on every transitive descendant of `rootEpicId`. BFS over
 * an in-memory queue with a `visited` cycle guard + depth cap of 50 — cycles
 * can't form (`created_by_closer_of` is immutable once set), so the guard is
 * defense-in-depth; both bails note and return, never throws. Each descendant's
 * path is `<parent.sort_path>.<zeroPad6(epic_number)>` (or just
 * `zeroPad6(epic_number)` when the parent's path is the `''` placeholder); same
 * `epic_number >= 1_000_000 → ''` overflow guard as {@link syncPlanctlLinks}.
 *
 * Schema v30: the `!`-prefix queue-jump signal propagates through the
 * `parentPath` string concat for free. If the root epic carries
 * `sort_path = "!000003"`, the BFS reads that string off the `epics` row
 * and composes `"!000003.000007"` for each child — the cascade has NO
 * separate queue_jump awareness because the prefix is already baked into
 * the parent path string. `queue_jump` itself (the projection column) is
 * NOT re-stamped here: children carry their OWN queue-jump state set by
 * `syncPlanctlLinks` on their own session's events, independent of the
 * root's state. Cascading only touches `sort_path`, never `queue_jump`.
 */
function cascadeSortPath(
  db: Database,
  rootEpicId: string,
  eventId: number,
  ts: number,
): void {
  const MAX_DEPTH = 50;
  const visited = new Set<string>();
  visited.add(rootEpicId);
  // BFS frontier: each entry is `(parentId, depth)`. We re-stamp every
  // child of `parentId` and enqueue the children for their own children.
  let frontier: { id: string; depth: number }[] = [
    { id: rootEpicId, depth: 0 },
  ];
  while (frontier.length > 0) {
    const next: { id: string; depth: number }[] = [];
    for (const { id: parentId, depth } of frontier) {
      if (depth >= MAX_DEPTH) {
        console.error(
          `keeper reducer: sort_path cascade depth >= ${MAX_DEPTH} ` +
            `at parent=${parentId}; bailing (cycle guard / defense-in-depth)`,
        );
        return;
      }
      const parentRow = db
        .query("SELECT sort_path FROM epics WHERE epic_id = ?")
        .get(parentId) as { sort_path: string | null } | null;
      const parentPath = parentRow?.sort_path ?? "";
      const children = db
        .query(
          `SELECT epic_id, epic_number
             FROM epics
            WHERE created_by_closer_of = ?
            ORDER BY epic_id ASC`,
        )
        .all(parentId) as {
        epic_id: string;
        epic_number: number | null;
      }[];
      for (const child of children) {
        if (visited.has(child.epic_id)) {
          console.error(
            `keeper reducer: sort_path cascade cycle detected ` +
              `at epic=${child.epic_id}; bailing (defense-in-depth)`,
          );
          return;
        }
        visited.add(child.epic_id);
        const childNumber = child.epic_number ?? 0;
        let childPath: string;
        if (childNumber >= 1_000_000) {
          console.error(
            `keeper reducer: epic ${child.epic_id} has epic_number=` +
              `${childNumber} >= 1_000_000; sort_path overflow ceiling ` +
              `— folding to '' (cascade)`,
          );
          childPath = "";
        } else if (parentPath === "") {
          childPath = zeroPad6(childNumber);
        } else {
          childPath = `${parentPath}.${zeroPad6(childNumber)}`;
        }
        db.run(
          "UPDATE epics SET sort_path = ?, last_event_id = ?, updated_at = ? WHERE epic_id = ?",
          [childPath, eventId, ts, child.epic_id],
        );
        next.push({ id: child.epic_id, depth: depth + 1 });
      }
    }
    frontier = next;
  }
}

/**
 * Row shape lifted from `epics` for the fold-time resolver's all-epics index —
 * the minimal subset `resolveEpicDep` reads (`epic_id`, `epic_number`,
 * `project_dir`, `status`); everything else is excluded to keep the scan narrow.
 */
interface EpicLite {
  epic_id: string;
  epic_number: number | null;
  project_dir: string | null;
  status: string | null;
}

/**
 * Assemble a minimal {@link Epic}-shaped record from an {@link EpicLite} row.
 * The fields the resolver doesn't touch are stamped with zero-event defaults so
 * the full surface is present (defense-in-depth against a future resolver
 * widening).
 */
function epicLiteToEpic(row: EpicLite): Epic {
  return {
    epic_id: row.epic_id,
    epic_number: row.epic_number,
    title: null,
    project_dir: row.project_dir,
    status: row.status,
    last_event_id: null,
    updated_at: 0,
    depends_on_epics: [],
    tasks: [],
    jobs: [],
    job_links: [],
    last_validated_at: null,
    created_by_closer_of: null,
    sort_path: "",
    queue_jump: 0,
    resolved_epic_deps: null,
  };
}

/**
 * Build the in-fold all-epics index the shared {@link resolveEpicDep} resolver
 * reads against. Returns `(epicById, epicsByNumber)` keyed off the live `epics`
 * table. Read-in-fold is allowed (the watcher ban doesn't cover query reads).
 * Every column is event-persisted — no wall-clock / env / OS read — so a re-fold
 * rebuilds the same index and the per-event `resolved_epic_deps` derivation is
 * byte-identical.
 */
function buildEpicIndex(db: Database): {
  epicById: Map<string, Epic>;
  epicsByNumber: Map<number, Epic[]>;
} {
  const rows = db
    .query(
      `SELECT epic_id, epic_number, project_dir, status
         FROM epics`,
    )
    .all() as EpicLite[];
  const epicById = new Map<string, Epic>();
  const epicsByNumber = new Map<number, Epic[]>();
  for (const row of rows) {
    const epic = epicLiteToEpic(row);
    epicById.set(row.epic_id, epic);
    if (row.epic_number != null) {
      const bucket = epicsByNumber.get(row.epic_number);
      if (bucket == null) {
        epicsByNumber.set(row.epic_number, [epic]);
      } else {
        bucket.push(epic);
      }
    }
  }
  // Stable order inside each bucket so the resolver's ambiguity tie-break (and
  // re-fold byte-identity) doesn't depend on SQLite's result ordering.
  for (const bucket of epicsByNumber.values()) {
    bucket.sort((a, b) =>
      a.epic_id < b.epic_id ? -1 : a.epic_id > b.epic_id ? 1 : 0,
    );
  }
  return { epicById, epicsByNumber };
}

/**
 * Shared enrich helper (mirror of {@link enrichJobLink}). Runs the fold-safe
 * {@link resolveEpicDep} resolver and projects the tri-state entry onto the wire
 * shape carried in `epics.resolved_epic_deps`. Shared by the forward stamp, the
 * reverse fan-out, and the EpicDeleted path — one source of truth for the
 * on-disk projection shape.
 *
 * Tri-state: `dangling` (no upstream), `satisfied` (`{kind: "found"}` AND
 * `epicIsCompleted`), `blocked-incomplete` (found but not done). KEY ORDER IS
 * LOCKED — both branches emit the same six keys (dangling fills the resolution
 * fields with explicit `null`, NOT omitted) so the byte shape stays uniform.
 * `cross_project` is true IFF the upstream basename is non-empty and differs
 * from the consumer's. The resolver's `now` is the event's own `ts`
 * (deterministic); the diagnostics sink is dropped on the floor (observational,
 * surfaced on the readiness side). NEVER throws.
 */
function enrichEpicDep(
  depTok: string,
  consumer: Epic,
  epicById: Map<string, Epic>,
  epicsByNumber: Map<number, Epic[]>,
  nowIso: string,
): ResolvedEpicDep {
  // No-op diagnostics sink: observational, not projection state, so the fold
  // drops it (the readiness side surfaces the same diagnostic).
  const diagnostics: ResolutionDiagnostic[] = [];
  const resolved = resolveEpicDep(
    depTok,
    consumer,
    epicById,
    epicsByNumber,
    diagnostics,
    nowIso,
  );
  if (resolved.kind === "dangling") {
    return {
      dep_token: depTok,
      resolved_epic_id: null,
      epic_number: null,
      project_basename: null,
      cross_project: false,
      state: "dangling",
    };
  }
  const upstream = resolved.epic;
  // Cross-project is a boolean on the wire (the basename rides separately);
  // reduce the resolver's `string | null` to boolean.
  const crossProject = resolved.cross_project !== null;
  return {
    dep_token: depTok,
    resolved_epic_id: upstream.epic_id,
    epic_number: upstream.epic_number,
    project_basename: projectBasename(upstream.project_dir),
    cross_project: crossProject,
    state: epicIsCompleted(upstream) ? "satisfied" : "blocked-incomplete",
  };
}

/**
 * Unix-seconds → ISO-8601 string for the resolver's `now` parameter.
 * Deterministic (a pure function of the event's unix-second integer), so a
 * re-fold reproduces the same diagnostic ts. The resolver's `now` slot is typed
 * as a string for the readiness side's precedent; keeping it stable avoids a
 * `now: string | number` widening.
 */
function eventTsToIso(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

/**
 * Source-order hook for an embedded `resolved_epic_deps` array: entries are
 * written in `depends_on_epics` order (matching the readiness side), so the
 * sort itself is a no-op — a named symmetry point with {@link sortEpicLinks} /
 * {@link sortJobLinks} for a future ORDER BY rule.
 */
function preserveSourceOrder(_arr: ResolvedEpicDep[]): void {
  // Intentional no-op — see docstring.
}

/**
 * The forward fold: rebuild `epic_dep_edges` for consumer `epicId` from scratch,
 * then stamp the enriched `resolved_epic_deps` array on the consumer's row.
 * Called from the EpicSnapshot arm AFTER the consumer's row + sort_path settle
 * but BEFORE the reverse fan-out.
 *
 * Full-recompute, never delta-merge (a delta-merge would double-add on re-fold):
 * DELETE every existing edge for this consumer, INSERT one per `dep_token`. Each
 * edge carries the RAW token verbatim (not the resolved id) so ambiguity flips
 * and dangling deps re-stamp natively on a later upstream snapshot — the reverse
 * fan-out looks consumers up by `dep_token IN (A.epic_id, 'fn-' ||
 * A.epic_number)`. Duplicate tokens collapse to one edge (the table PK) but BOTH
 * render in `resolved_epic_deps` via `INSERT OR IGNORE`.
 *
 * NEVER throws inside the open transaction. A malformed
 * `depends_on_epics` blob is already filtered out by `projectPlanRow`'s
 * guarded parse (it lands on the row as `'[]'`); we re-parse defensively
 * here as `[]` if SQLite returns a NULL/malformed cell.
 */
function syncEpicDepsForward(
  db: Database,
  epicId: string,
  eventId: number,
  ts: number,
  epicById: Map<string, Epic>,
  epicsByNumber: Map<number, Epic[]>,
): void {
  // Post-write read of the consumer's row (its INSERT/UPDATE already landed
  // this transaction), including the just-written `depends_on_epics`.
  const consumerRow = db
    .query(
      `SELECT epic_id, epic_number, project_dir, status,
              depends_on_epics
         FROM epics
        WHERE epic_id = ?`,
    )
    .get(epicId) as (EpicLite & { depends_on_epics: string | null }) | null;
  if (consumerRow == null) {
    // Consumer row vanished mid-fold — shouldn't happen (we're called
    // post-INSERT/UPDATE of this very row), but defense-in-depth.
    return;
  }
  let depTokens: string[] = [];
  if (
    consumerRow.depends_on_epics != null &&
    consumerRow.depends_on_epics.length > 0
  ) {
    try {
      const parsed = JSON.parse(consumerRow.depends_on_epics);
      if (Array.isArray(parsed)) {
        depTokens = parsed.filter((t): t is string => typeof t === "string");
      }
    } catch {
      // malformed stored array → treat as empty, fall through.
    }
  }

  // Full-recompute: wipe the consumer's edges, then insert fresh ones from
  // `depTokens`. `INSERT OR IGNORE` collapses duplicate tokens onto one edge.
  db.run("DELETE FROM epic_dep_edges WHERE consumer_id = ?", [epicId]);
  for (const tok of depTokens) {
    db.run(
      "INSERT OR IGNORE INTO epic_dep_edges (consumer_id, dep_token) VALUES (?, ?)",
      [epicId, tok],
    );
  }

  const consumerEpic = epicLiteToEpic(consumerRow);
  // Make sure the consumer's own row is visible to the resolver — the index
  // may have been assembled before this fold's INSERT landed. Stamping it back
  // keeps a self-referential dep resolving the same way on a re-fold.
  if (!epicById.has(epicId)) {
    epicById.set(epicId, consumerEpic);
    if (consumerEpic.epic_number != null) {
      const bucket = epicsByNumber.get(consumerEpic.epic_number);
      if (bucket == null) {
        epicsByNumber.set(consumerEpic.epic_number, [consumerEpic]);
      } else {
        bucket.push(consumerEpic);
        bucket.sort((a, b) =>
          a.epic_id < b.epic_id ? -1 : a.epic_id > b.epic_id ? 1 : 0,
        );
      }
    }
  }
  const nowIso = eventTsToIso(ts);
  const enriched: ResolvedEpicDep[] = depTokens.map((tok) =>
    enrichEpicDep(tok, consumerEpic, epicById, epicsByNumber, nowIso),
  );
  preserveSourceOrder(enriched);

  db.run(
    "UPDATE epics SET resolved_epic_deps = ?, last_event_id = ?, updated_at = ? WHERE epic_id = ?",
    [JSON.stringify(enriched), eventId, ts, epicId],
  );
}

/**
 * The reverse fan-out. After upstream `epicId`'s row was written or deleted,
 * find every downstream consumer whose `depends_on_epics` could match it and
 * re-stamp their `resolved_epic_deps`. Depth-1 only — the acyclic invariant +
 * depth-1 bound the per-event write fan-out to "the consumers of this one epic".
 *
 * Looks consumers up by RAW token `dep_token IN (<full_id>, 'fn-' ||
 * <epic_number>)` (both forms — the bare-id branch catches ambiguity flips).
 * Skips the upstream itself (`consumer_id != ?`) since the forward pass already
 * stamped it. ORDER BY consumer_id ASC for stable re-stamp order (each bumps
 * `last_event_id`). The EpicDeleted path is unified — the resolver consults the
 * LIVE `epics` table, so once the upstream row is gone the matching entry flips
 * to `dangling` naturally. NEVER throws.
 */
function syncEpicDepsReverse(
  db: Database,
  epicId: string,
  epicNumber: number | null,
  eventId: number,
  ts: number,
  epicById: Map<string, Epic>,
  epicsByNumber: Map<number, Epic[]>,
): void {
  // Reverse adjacency lookup by raw token — both the full id and the bare id
  // are considered. Bare-id only when `epicNumber != null` (a shell with no
  // number projects no bare-id back-edge).
  let consumerRows: { consumer_id: string }[];
  if (epicNumber != null) {
    consumerRows = db
      .query(
        `SELECT DISTINCT consumer_id
           FROM epic_dep_edges
          WHERE consumer_id != ?
            AND dep_token IN (?, ?)
          ORDER BY consumer_id ASC`,
      )
      .all(epicId, epicId, `fn-${epicNumber}`) as { consumer_id: string }[];
  } else {
    consumerRows = db
      .query(
        `SELECT DISTINCT consumer_id
           FROM epic_dep_edges
          WHERE consumer_id != ?
            AND dep_token = ?
          ORDER BY consumer_id ASC`,
      )
      .all(epicId, epicId) as { consumer_id: string }[];
  }
  if (consumerRows.length === 0) {
    return;
  }
  const nowIso = eventTsToIso(ts);
  for (const { consumer_id: consumerId } of consumerRows) {
    const consumerRow = db
      .query(
        `SELECT epic_id, epic_number, project_dir, status,
                depends_on_epics
           FROM epics
          WHERE epic_id = ?`,
      )
      .get(consumerId) as
      | (EpicLite & { depends_on_epics: string | null })
      | null;
    if (consumerRow == null) {
      // Edges table out of sync with epics — defense-in-depth.
      continue;
    }
    let depTokens: string[] = [];
    if (
      consumerRow.depends_on_epics != null &&
      consumerRow.depends_on_epics.length > 0
    ) {
      try {
        const parsed = JSON.parse(consumerRow.depends_on_epics);
        if (Array.isArray(parsed)) {
          depTokens = parsed.filter((t): t is string => typeof t === "string");
        }
      } catch {
        // malformed stored array → treat as empty, fall through.
      }
    }
    const consumerEpic = epicLiteToEpic(consumerRow);
    const enriched: ResolvedEpicDep[] = depTokens.map((tok) =>
      enrichEpicDep(tok, consumerEpic, epicById, epicsByNumber, nowIso),
    );
    preserveSourceOrder(enriched);
    db.run(
      "UPDATE epics SET resolved_epic_deps = ?, last_event_id = ?, updated_at = ? WHERE epic_id = ?",
      [JSON.stringify(enriched), eventId, ts, consumerId],
    );
  }
}

/**
 * Apply the jobs-side projection for one event. Runs INSIDE the open
 * transaction opened by {@link applyEvent}; performs zero cursor work.
 *
 * Returns nothing — all writes go straight to `db`. The branches are
 * independent: the title update (when a `session_title` is present) is applied
 * on TOP of the lifecycle write, so e.g. a UserPromptSubmit carrying a new
 * title flips both state and title in one fold.
 *
 * Every branch that ACTUALLY writes a `jobs` row also fans the post-write
 * row into the embedded `epics.jobs` / `task.jobs` arrays via
 * {@link syncIfPlanRef} (gated on `plan_ref != null`). The Killed-mismatch
 * path — which `break`s without writing — must NOT fire sync; encoded by
 * placing the sync call inside each branch's write path, not after the
 * switch.
 */
function projectJobsRow(db: Database, event: Event): void {
  const ts = event.ts;
  const jobId = event.session_id;

  switch (event.hook_event) {
    case "SessionStart":
      // FIRST sight of a session: the INSERT seeds the row (schema default
      // state='stopped'). Seed the title from the scraped spawn name (priority-1
      // 'spawn' source); a NULL spawn_name leaves title NULL with the payload
      // title rule still seeding at the first UserPromptSubmit. Also captures
      // `transcript_path` (guarded parse).
      //
      // A DUPLICATE SessionStart is a RESUME (a fresh `claude --resume`). ON
      // CONFLICT re-opens a TERMINAL row (CASE: 'ended'/'killed' → 'stopped'; a
      // working/stopped row is left untouched, so a live job is never knocked
      // backwards) and refreshes pid + start_time (a resume is a new OS
      // process). title/title_source/created_at/cwd/transcript_path are NOT
      // touched — precedence-owned / set-once identity.
      {
        // Derive `plan_verb`/`plan_ref` from the spawn name via the shared pure
        // parser; NULL on any name outside the `{plan|work|close|approve}::<ref>`
        // whitelist. Set-once on RESUME (ON CONFLICT leaves both untouched).
        const { plan_verb, plan_ref } = planVerbRefFromSpawnName(
          event.spawn_name,
        );
        // Discharge-on-bind gating: read the jobs row BEFORE the UPSERT to
        // distinguish spawn-INSERT (no prior row) from resume ON CONFLICT. The
        // pending-dispatch discharge fires ONLY on spawn-INSERT — a RESUME must
        // NOT discharge a legitimately re-pending dispatch. The pre-INSERT SELECT
        // is pure, so re-fold determinism holds.
        const priorJob = db
          .query("SELECT 1 AS one FROM jobs WHERE job_id = ?")
          .get(jobId) as { one: number } | null;
        const isSpawnInsert = priorJob == null;
        // Seed `name_history` with `["<spawn_name>"]` on the spawn INSERT (else
        // `'[]'`). RESUME is a no-touch (no `name_history` clause in the UPDATE
        // SET); the title precedence-write block is the only path that appends.
        const spawnNameHistory =
          event.spawn_name != null ? JSON.stringify([event.spawn_name]) : "[]";
        db.run(
          `INSERT INTO jobs (job_id, created_at, cwd, pid, start_time, last_event_id, updated_at, title, title_source, transcript_path, plan_verb, plan_ref, config_dir, profile_name, name_history)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(job_id) DO UPDATE SET
             pid = COALESCE(excluded.pid, jobs.pid),
             start_time = COALESCE(excluded.start_time, jobs.start_time),
             config_dir = COALESCE(excluded.config_dir, jobs.config_dir),
             -- Schema v36: track config_dir's nullability — a resume carrying
             -- a NULL config_dir derives a NULL excluded.profile_name, so
             -- COALESCE preserves the seeded name (mirrors config_dir above).
             profile_name = COALESCE(excluded.profile_name, jobs.profile_name),
             state = CASE WHEN jobs.state IN ('${ENDED}','${KILLED}') THEN 'stopped' ELSE jobs.state END,
             -- Schema v25: unconditional paired clear on every SessionStart
             -- (including resume). A SessionStart means a live process is
             -- attached, so any pending input-request annotation is stale:
             -- if the question still matters, the next user prompt will
             -- come fresh (and re-trigger via the matcher); if the human
             -- moved on (most resume cases), the stale annotation must not
             -- linger. Cheap when already NULL — no-op write. Paired:
             -- both columns clear together — see
             -- {@link import("./types").JobLinkEntry}'s paired-NULL
             -- invariant. SessionStart is rare (once per session boot/
             -- resume), so the unconditional write — versus a gated one —
             -- is the trivially-cheap shape.
             --
             -- Schema v52 / fn-686 extends the same shape to the
             -- (last_permission_prompt_at, last_permission_prompt_kind)
             -- pair: a resume into a session that was parked on a
             -- permission dialog / elicitation prompt means the dialog
             -- is no longer the live worker's concern (either dismissed
             -- by Claude Code's restart sequence, or the human moved
             -- on and the next prompt will re-trigger if needed). Same
             -- unconditional shape, same paired-NULL invariant.
             last_input_request_at = NULL,
             last_input_request_kind = NULL,
             last_permission_prompt_at = NULL,
             last_permission_prompt_kind = NULL,
             last_event_id = excluded.last_event_id,
             updated_at = excluded.updated_at`,
          [
            jobId,
            ts,
            event.cwd,
            event.pid,
            event.start_time,
            event.id,
            ts,
            event.spawn_name,
            event.spawn_name ? "spawn" : null,
            extractTranscriptPath(event),
            plan_verb,
            plan_ref,
            event.config_dir,
            // NULL config_dir → NULL profile_name (NOT the `''`-collapse the
            // profiles seed applies) so the column tracks `jobs.config_dir`'s
            // own nullability under the resume COALESCE.
            event.config_dir == null ? null : projectBasename(event.config_dir),
            spawnNameHistory,
          ],
        );
        // Seed a visible `profiles` row for this session's `config_dir` bucket.
        // `INSERT OR IGNORE` so the first seed wins. `COALESCE(?,'')` collapses a
        // NULL config_dir into the `''` sentinel, matching the rate-limit
        // fan-out's expression so a NULL-config session's later rate limit lands
        // on the row it seeded here. `profile_name` is seeded from the same
        // `projectBasename` the migrate backfill uses; the `profile_name != ''`
        // guard on the usage<->profiles join keeps the `''` sentinel from
        // cross-contaminating. Pure function of the event.
        db.run(
          `INSERT OR IGNORE INTO profiles (config_dir, profile_name, last_event_id, updated_at) VALUES (COALESCE(?, ''), ?, ?, ?)`,
          [event.config_dir, projectBasename(event.config_dir), event.id, ts],
        );
        // Discharge-on-bind: fires ONLY on spawn-INSERT, NEVER on resume. A
        // successful bind means the autopilot's `Dispatched` intent materialized
        // into a real job, so the launch-window slot is reaped. Idempotent DELETE
        // (no-op when no pending row). Pure fold.
        if (isSpawnInsert && plan_verb != null && plan_ref != null) {
          db.run("DELETE FROM pending_dispatches WHERE verb = ? AND id = ?", [
            plan_verb,
            plan_ref,
          ]);
        }
      }
      syncIfPlanRef(db, jobId, event.id, ts);
      break;

    case "UserPromptSubmit": {
      // Modest carve-out: Claude Code's shutdown sequence reports each killed
      // backgrounded task back to the model by injecting a
      // `<task-notification>…<status>killed</status>` envelope through this
      // same `UserPromptSubmit` hook. That fired a brief `stopped → working`
      // flash right before `SessionEnd` (or the exit-watcher's synthetic
      // `Killed`) landed — see the parser + scope rationale in
      // `src/derivers.ts` (`isKilledTaskNotification`). Suppress only the
      // `killed` variant; `completed` / `failed` task-notifications are real
      // signals the model reacts to and continue to flip state to `working`.
      //
      // The title rule below the switch is intentionally NOT skipped: a
      // task-notification still carries a `session_title` that the title
      // precedence rule may legitimately fold. Skipping only the lifecycle
      // write + `syncIfPlanRef` keeps the carve-out as small as possible.
      //
      // Re-fold determinism: `isKilledTaskNotification` is a pure function of
      // `event.data.prompt`, so a from-scratch re-fold agrees with the
      // steady-state write byte-for-byte.
      if (isKilledTaskNotification(extractPrompt(event))) {
        break;
      }
      // A prompt means the session is ALIVE — set 'working' unconditionally (no
      // terminal guard). Also a re-open path: a session can resume straight into
      // a prompt with no SessionStart, and a spurious mid-session SessionEnd is
      // sometimes followed by a prompt in the SAME process. Either way the job
      // leaves 'ended'/'killed'.
      //
      // Pid is COALESCE-refreshed; UserPromptSubmit carries no start_time. When
      // the event's pid DIFFERS from the persisted pid, the resume landed in a
      // different process, so the persisted start_time now describes a recycled
      // process — clearing it to NULL keeps the `(pid, start_time)` recycle-safe
      // identity honest (otherwise the next seed sweep would fire a Killed
      // carrying the stale start_time and fold the live row to 'killed'). NULL
      // activates the loose pid-only match in both producers and the Killed
      // fold; the next SessionStart refreshes it. The CASE is pure over
      // (event.pid, row.pid).
      //
      // Clears the api-error / input-request / permission-prompt annotation
      // pairs to NULL together: a fresh prompt means the human picked up after
      // the quota reset / answered the question / dismissed the dialog, so the
      // "why it stopped" annotations no longer apply. Each is unconditional
      // (no-op when already NULL) and paired (both columns of a pair move
      // together).
      db.run(
        `UPDATE jobs SET state = 'working',
                         last_api_error_at = NULL,
                         last_api_error_kind = NULL,
                         last_input_request_at = NULL,
                         last_input_request_kind = NULL,
                         last_permission_prompt_at = NULL,
                         last_permission_prompt_kind = NULL,
                         pid = COALESCE(?, pid),
                         start_time = CASE
                           WHEN ? IS NOT NULL AND ? != pid THEN NULL
                           ELSE start_time
                         END,
                         -- Schema v65: stamp the unified-timeline recency key on
                         -- the rising edge into 'working' only. SQLite evaluates
                         -- a SET RHS against pre-update row values, so the state
                         -- read here is the OLD state: the stamp re-fires on
                         -- every stopped/terminal-to-working re-open (genuine
                         -- restart) and HOLDS (explicit ELSE) when already
                         -- 'working' — a 2nd prompt mid-run does NOT re-promote.
                         -- Guard is state != 'working', NOT active_since IS NULL
                         -- (the IS-NULL form stamps once forever and never
                         -- re-promotes on restart).
                         active_since = CASE
                           WHEN state != 'working' THEN ?
                           ELSE active_since
                         END,
                         last_event_id = ?, updated_at = ?
           WHERE job_id = ?`,
        [event.pid, event.pid, event.pid, ts, event.id, ts, jobId],
      );
      syncIfPlanRef(db, jobId, event.id, ts);
      break;
    }

    case "Stop": {
      // Session-level backstop clear for the permission-prompt / elicitation
      // pair, hoisted ABOVE the sub-agent guard: even a guard-swallowed Stop
      // means the dialog is no longer the live worker's concern. Gated-on-IS-NOT
      // -NULL so the common no-prior-prompt case is a zero-cost no-op. Paired
      // -NULL; `changes > 0` gates the re-fan.
      const stopClearRes = db.run(
        `UPDATE jobs SET last_permission_prompt_at = NULL,
                         last_permission_prompt_kind = NULL,
                         last_event_id = ?,
                         updated_at = ?
           WHERE job_id = ? AND last_permission_prompt_at IS NOT NULL`,
        [event.id, ts, jobId],
      );
      if (stopClearRes.changes > 0) {
        syncIfPlanRef(db, jobId, event.id, ts);
      }
      // Live monitors snapshot-replace, hoisted ABOVE the sub-agent guard so a
      // guard-swallowed Stop STILL refreshes `jobs.monitors` from this Stop's
      // `data.background_tasks` snapshot (authoritative — Claude Code re-emits
      // the FULL live set every Stop, so a just-dead shell must not linger).
      // Empty/malformed → `'[]'` (drop-when-dead). Writes ONLY `monitors` /
      // stamps, NOT `state`: an unconditional state flip here would re-open the
      // predicate-5/7 dup-fire window the sub-agent guard closes. Pure over
      // event-derived inputs.
      let stopData: unknown = null;
      try {
        stopData = JSON.parse(event.data);
      } catch {
        // Malformed blob → `computeMonitors` returns '[]' (an unreadable Stop is
        // treated as "no live monitors"); cursor still advances.
        stopData = null;
      }
      const nextMonitors = computeMonitors(
        db,
        event.session_id,
        event.id,
        stopData,
      );
      // Gated by the same terminal guard as the state UPDATE below: a stray Stop
      // on an already-terminal row must not re-touch the stamps (a terminal row
      // has no live monitors). The hoist above the SUB-AGENT guard is what lets
      // a sub-agent-yielded Stop on a still-live row refresh monitors.
      const monitorsRes = db.run(
        `UPDATE jobs SET monitors = ?, last_event_id = ?, updated_at = ?
           WHERE job_id = ? AND state NOT IN ('${ENDED}','${KILLED}')`,
        [nextMonitors, event.id, ts, jobId],
      );
      // Stamp the `has_live_worker_monitor` occupancy fact onto the embedded
      // job element. Gated on `changes > 0` so a guarded terminal-row no-op
      // doesn't re-fan a stale stamp. Stamped HERE (not via `syncIfPlanRef`)
      // because the monitors-only write is hoisted above the sub-agent guard and
      // skips the `syncIfPlanRef` fan-out, so the fact would otherwise go stale
      // in the guard-swallow case.
      if (monitorsRes.changes > 0) {
        const planRow = db
          .query("SELECT plan_ref FROM jobs WHERE job_id = ?")
          .get(jobId) as { plan_ref: string | null } | null;
        stampEmbeddedMonitorFact(db, {
          jobId,
          planRef: planRow?.plan_ref ?? null,
          hasLiveWorkerMonitor: hasLiveWorkerMonitor(nextMonitors),
          eventId: event.id,
          eventTs: ts,
        });
      }
      // Terminal guard: a stray Stop on a still-terminal job (no intervening
      // re-open) must not resurrect it; covers both 'ended' and 'killed'.
      //
      // Sub-agent guard: when the parent dispatches a Task tool it emits Stop and
      // yields to the sub-agent (which shares the parent session_id), but the
      // session is conceptually still working. Honoring the mid-yield Stop would
      // clear readiness predicate 5 prematurely and dup-fire predicate 7's
      // approval-notify. So skip the state flip while any subagent_invocations
      // row is still `running`. Same-name collapse: a `running` row is ignored if
      // a LATER same-`(job_id, subagent_type)` row exists — "same name, higher
      // turn_seq" means the older row is an orphan whose SubagentStop never
      // landed; this matches the client's `collapseSubagentsByName`.
      // `subagent_type IS …` is null-safe equality. Pure over the event log.
      //
      // Recency bound: anchor the staleness check on the SURVIVING running row
      // (max `turn_seq` per name group), measured against its `ts` — ORDER BY ts
      // DESC so multiple in-flight subs pick the newest start (the guard only
      // releases once even the freshest survivor crosses the bound).
      const subRunning = db
        .query(
          `SELECT s1.ts AS ts FROM subagent_invocations s1
            WHERE s1.job_id = ?
              AND s1.status = 'running'
              AND NOT EXISTS (
                SELECT 1 FROM subagent_invocations s2
                 WHERE s2.job_id = s1.job_id
                   AND s2.subagent_type IS s1.subagent_type
                   AND s2.turn_seq > s1.turn_seq
              )
            ORDER BY s1.ts DESC
            LIMIT 1`,
        )
        .get(jobId) as { ts: number | null } | null;
      if (subRunning != null) {
        // Keep swallowing on a NULL/non-positive `ts` (age uncomputable) or a
        // non-positive age (clock skew / same-second); the bound only releases
        // once age STRICTLY exceeds `MAX_STOP_YIELD_GAP_SEC`.
        const rowTs = subRunning.ts;
        if (rowTs == null || rowTs <= 0) {
          break;
        }
        const age = event.ts - rowTs;
        if (age <= MAX_STOP_YIELD_GAP_SEC) {
          break;
        }
        // Fall through: the newest surviving sub-agent is older than the bound —
        // an orphan whose SubagentStop never landed; release the Stop gate.
      }
      const res = db.run(
        `UPDATE jobs SET state = 'stopped', last_event_id = ?, updated_at = ?
           WHERE job_id = ? AND state NOT IN ('${ENDED}','${KILLED}')`,
        [event.id, ts, jobId],
      );
      // Sync only when the UPDATE actually wrote — a guarded no-op must NOT
      // re-fan a stale-but-unchanged element with the new event_id.
      if (res.changes > 0) {
        syncIfPlanRef(db, jobId, event.id, ts);
      }
      break;
    }

    case "SessionEnd": {
      // The terminal guard keeps this idempotent on 'ended' AND prevents a late
      // SessionEnd from clobbering a 'killed' row (the killed signal carries
      // proven-dead evidence and outranks). Clears `monitors='[]'` in the same
      // UPDATE (terminal jobs have no live monitors). Matches zero rows for a
      // terminal event with no prior SessionStart — a correct no-op.
      const res = db.run(
        `UPDATE jobs SET state = 'ended', monitors = '[]', last_event_id = ?, updated_at = ?
           WHERE job_id = ? AND state NOT IN ('${ENDED}','${KILLED}')`,
        [event.id, ts, jobId],
      );
      if (res.changes > 0) {
        sweepRunningSubagentsToUnknown(db, jobId, event.id, ts);
        syncIfPlanRef(db, jobId, event.id, ts);
        // Force the embedded occupancy fact to `false`: the `monitors='[]'`
        // clear makes the source false, but `buildEmbeddedJob`'s carve-out
        // would otherwise PRESERVE a stale `true` into the terminal element.
        clearEmbeddedMonitorFactOnTerminal(db, jobId, event.id, ts);
      }
      break;
    }

    case "Killed":
      // Synthetic event from the seed sweep / exit-watcher when a `(pid,
      // start_time)` pair is proven dead. The producer pre-computes the payload;
      // the reducer NEVER re-probes liveness (a re-probe would break re-fold
      // determinism). Fold to 'killed' iff the persisted (pid, start_time)
      // matches, OR the persisted start_time is NULL (legacy loose pid-only
      // match). On mismatch / missing pid / missing row, short-circuit as stale
      // — no row write, no throw.
      {
        const payload = extractKilledPayload(event);
        if (payload == null) {
          break; // malformed/missing payload — safe no-op.
        }
        const row = db
          .query("SELECT pid, start_time, state FROM jobs WHERE job_id = ?")
          .get(jobId) as {
          pid: number | null;
          start_time: string | null;
          state: string;
        } | null;
        if (row == null) {
          break; // no jobs row for this session — safe no-op.
        }
        // Pidless reap: a Killed carrying `pid: null` reaps a non-terminal row
        // whose persisted pid is ALSO NULL (unwatchable, terminal by
        // construction). Guarded both ways, so a pidless event never folds a row
        // with a real pid (that's the strict arm's job). The pidless arm carries
        // its OWN terminal guard; the strict arm relies on the (pid, start_time)
        // identity instead (a terminal guard there would change re-fold output).
        if (payload.pid == null) {
          if (row.pid != null) {
            break; // pidless reap must not touch a row that has a real pid.
          }
          if (row.state === ENDED || row.state === KILLED) {
            break; // already terminal — never resurrect a NULL-pid ended row.
          }
          // row.pid == null && payload.pid == null && non-terminal → reap the
          // unwatchable row.
        } else {
          // Strict match when the row has a stored start_time; loose pid-only
          // match when start_time is NULL (legacy / pre-schema-v9 row).
          const pidMatches = row.pid != null && row.pid === payload.pid;
          const startMatches =
            row.start_time == null || row.start_time === payload.start_time;
          if (!pidMatches || !startMatches) {
            break; // stale/recycled — safe no-op.
          }
        }
        db.run(
          `UPDATE jobs SET state = 'killed', monitors = '[]', last_event_id = ?, updated_at = ?
             WHERE job_id = ?`,
          [event.id, ts, jobId],
        );
        // Sweep + sync + clear fire ONLY here, on the proven write path. The
        // earlier `break` arms (malformed / missing / stale) MUST NOT — no
        // lifecycle write happened, so any of them would be a spurious mutation.
        sweepRunningSubagentsToUnknown(db, jobId, event.id, ts);
        syncIfPlanRef(db, jobId, event.id, ts);
        clearEmbeddedMonitorFactOnTerminal(db, jobId, event.id, ts);
      }
      break;

    case "RateLimited":
    case "ApiError": {
      // Dual-case fold so the historical log re-folds byte-deterministically:
      // legacy `RateLimited` forces `kind = "rate_limit"`; `ApiError` routes
      // `data.kind` through `validateApiErrorKind` (non-allow-list → "unknown").
      // Both write the `(last_api_error_at, last_api_error_kind)` pair together
      // (paired-NULL). Same terminal guard as Stop.
      const kind: ApiErrorKind =
        event.hook_event === "RateLimited"
          ? "rate_limit"
          : extractApiErrorKind(event);
      // Sub-agent guard (mirrors Stop): suppress the state flip while any
      // subagent row is `running` (the parent isn't making API calls while it
      // waits on a sub), but stamp the annotation pair UNCONDITIONALLY — that's
      // the honest reading — via the CASE keeping state at its pre-event value.
      const res = db.run(
        `UPDATE jobs SET state = CASE
                           WHEN EXISTS (
                             SELECT 1 FROM subagent_invocations
                              WHERE job_id = jobs.job_id
                                AND status = 'running'
                           ) THEN state
                           ELSE 'stopped'
                         END,
                         last_api_error_at = ?,
                         last_api_error_kind = ?,
                         last_event_id = ?,
                         updated_at = ?
           WHERE job_id = ? AND state NOT IN ('${ENDED}','${KILLED}')`,
        [ts, kind, event.id, ts, jobId],
      );
      // Sync only when the UPDATE wrote — a guarded no-op must NOT re-fan a
      // stale-but-unchanged element with the new event_id.
      if (res.changes > 0) {
        syncIfPlanRef(db, jobId, event.id, ts);
      }
      // Profile-level rate-limit fan-out, gated on `kind === "rate_limit"` (other
      // ApiErrorKind values are out of scope). Reads `config_dir` in-transaction;
      // null-guarded (a rate_limit before SessionStart skips). Runs INDEPENDENTLY
      // of the jobs UPDATE guard — a rate_limit on a terminal row still
      // attributes to the profile. Last-write-wins (events fold id-ordered);
      // `COALESCE(?,'')` matches the SessionStart seed's sentinel.
      if (kind === "rate_limit") {
        const profileRow = db
          .query("SELECT config_dir FROM jobs WHERE job_id = ?")
          .get(jobId) as { config_dir: string | null } | null;
        if (profileRow != null) {
          db.run(
            `INSERT INTO profiles (config_dir, profile_name, last_rate_limit_at, last_rate_limit_session_id, last_event_id, updated_at)
                  VALUES (COALESCE(?, ''), ?, ?, ?, ?, ?)
             ON CONFLICT(config_dir) DO UPDATE SET
               last_rate_limit_at = excluded.last_rate_limit_at,
               last_rate_limit_session_id = excluded.last_rate_limit_session_id,
               last_event_id = excluded.last_event_id,
               updated_at = excluded.updated_at`,
            [
              profileRow.config_dir,
              projectBasename(profileRow.config_dir),
              ts,
              jobId,
              event.id,
              ts,
            ],
          );
          // Forward fan-out: colocate the rate-limit annotation on the matching
          // `usage` row (join key `usage.id = profiles.profile_name`). Pure
          // UPDATE, never UPSERT — a rate_limit must not mint a phantom `usage`
          // row for a profile agentuse isn't tracking; a missing row matches
          // zero, and a later `UsageSnapshot` pulls the annotation back via the
          // reverse fan-out. `usageIdForProfileName` maps the `''` sentinel to
          // agentuse's `"default"` id so a default-account rate limit colocates
          // on `usage.default`. The `last_event_id` bump is load-bearing (it
          // drives the wire diff). Pure function of the fold inputs.
          //
          // CARVE-OUT: writes ONLY the rate-limit columns + bookkeeping; MUST NOT
          // touch `rate_limit_lifts_at` / `last_usage_fold_at` (those ride the
          // percentage path), so a rate-limit fold can't clobber a lift time or
          // freshness stamp the UsageSnapshot fold wrote.
          const profileName = projectBasename(profileRow.config_dir);
          const usageId = usageIdForProfileName(profileName);
          db.run(
            `UPDATE usage
                SET last_rate_limit_at = ?,
                    last_rate_limit_session_id = ?,
                    last_event_id = ?,
                    updated_at = ?
              WHERE id = ?`,
            [ts, jobId, event.id, ts, usageId],
          );
        }
      }
      break;
    }

    case "InputRequest": {
      // Synthetic event minted by main from a transcript-worker `input-request`
      // message — Claude Code used a built-in interactive tool (e.g.
      // `AskUserQuestion`) that fires no hook of its own. The session is blocked
      // on a human answer, so flip `state` to `'stopped'` AND stamp the
      // `(last_input_request_at, last_input_request_kind)` pair. Structural clone
      // of the ApiError arm: one compound UPDATE (paired-NULL), same terminal
      // guard. `extractInputRequestKind` folds a non-allow-list kind to
      // `"ask_user_question"` (the single-member union's only value). The clear
      // paths run from the regular hook events.
      const kind = extractInputRequestKind(event);
      const res = db.run(
        `UPDATE jobs SET state = 'stopped',
                         last_input_request_at = ?,
                         last_input_request_kind = ?,
                         last_event_id = ?,
                         updated_at = ?
           WHERE job_id = ? AND state NOT IN ('${ENDED}','${KILLED}')`,
        [ts, kind, event.id, ts, jobId],
      );
      // Sync only when the UPDATE actually wrote — a guarded no-op on a
      // still-terminal row must NOT re-fan the embedded entry (it would
      // re-write a stale-but-unchanged element with the new event_id).
      if (res.changes > 0) {
        syncIfPlanRef(db, jobId, event.id, ts);
      }
      break;
    }

    case "PreToolUse":
    case "PostToolUse": {
      // Hot-path clear: `AskUserQuestion` fires no Pre/PostToolUse hook of its
      // own, so the next tool the agent uses is the closest "answered" signal —
      // zero the input-request pair. Gated on `IS NOT NULL` so the common
      // already-NULL case is a zero-cost no-op (no stamp churn / re-fan).
      // Paired clear; sync gated on `changes > 0`.
      const res = db.run(
        `UPDATE jobs SET last_input_request_at = NULL,
                         last_input_request_kind = NULL,
                         last_event_id = ?,
                         updated_at = ?
           WHERE job_id = ? AND last_input_request_at IS NOT NULL`,
        [event.id, ts, jobId],
      );
      if (res.changes > 0) {
        syncIfPlanRef(db, jobId, event.id, ts);
      }
      // Identically-shaped hot-path clear for the permission-prompt pair. No
      // "permission dialog dismissed" hook exists, so the clear is inferred from
      // the next downstream tool (both Pre and Post, to close the narrow window
      // where the worker fires its next tool before keeper sees a PostToolUse).
      // Same gate / paired-NULL / `changes > 0` discipline as above.
      const resPP = db.run(
        `UPDATE jobs SET last_permission_prompt_at = NULL,
                         last_permission_prompt_kind = NULL,
                         last_event_id = ?,
                         updated_at = ?
           WHERE job_id = ? AND last_permission_prompt_at IS NOT NULL`,
        [event.id, ts, jobId],
      );
      if (resPP.changes > 0) {
        syncIfPlanRef(db, jobId, event.id, ts);
      }
      break;
    }

    case "Notification": {
      // Hook-event-driven fold of `Notification:permission_prompt` (the
      // tool-permission dialog) and `:elicitation_dialog` (an MCP input
      // request). The discriminator rides `event.event_type`. STRICT gate: only
      // the two whitelisted values stamp; everything else short-circuits via
      // `permissionPromptKindFromEventType` returning null (the post-switch
      // fan-outs still fire). The stamp does NOT flip `state` — the pill layers
      // `[awaiting:…]` on top of the live state without firing a Stop.
      // Terminal-row guard cloned from the InputRequest arm. Stamp value is
      // `event.ts` only — re-fold deterministic.
      const kind = permissionPromptKindFromEventType(event.event_type);
      if (kind === null) {
        break;
      }
      // Defensive double-check the kind is still in the allow-list, so a future
      // map entry that forgets to widen the type can't drift silently.
      const validated = validatePermissionPromptKind(kind);
      if (validated === null) {
        break;
      }
      const res = db.run(
        `UPDATE jobs SET last_permission_prompt_at = ?,
                         last_permission_prompt_kind = ?,
                         last_event_id = ?,
                         updated_at = ?
           WHERE job_id = ? AND state NOT IN ('${ENDED}','${KILLED}')`,
        [ts, validated, event.id, ts, jobId],
      );
      // Sync only when the UPDATE actually wrote — a guarded no-op on a
      // still-terminal row must NOT re-fan the embedded entry (it would
      // re-write a stale-but-unchanged element with the new event_id).
      if (res.changes > 0) {
        syncIfPlanRef(db, jobId, event.id, ts);
      }
      break;
    }

    default:
      // PostToolUseFailure and any unknown forward-compat event: no jobs
      // lifecycle write (no terminal guard needed — these never write `state`).
      // Pre/PostToolUse[Failure] + Subagent* rows also feed
      // `projectSubagentInvocationsRow` via the `applyEvent` dispatch; the no-op
      // here is specifically the *jobs* projection.
      break;
  }

  // Backend-exec coordinates: latest-non-NULL-wins COALESCE fold from
  // `events.backend_exec_*` onto `jobs.backend_exec_*`. Fires on EVERY event
  // (the hook stamps the columns on every hook event as pure env reads), so a
  // session that opens / moves panes mid-life lands the freshest coords on the
  // next event. Gated on `backend_exec_type != null` (the all-NULL non-pane
  // case is a fast no-op); a partial capture still COALESCEs so a NULL field
  // preserves the prior value. Reads only `event.backend_exec_*` + the
  // persisted cell — re-fold deterministic. An UPDATE against a missing jobs
  // row is a no-op (SessionStart, the only mint, fires first per session).
  if (event.backend_exec_type != null) {
    db.run(
      `UPDATE jobs SET
         backend_exec_type = COALESCE(?, backend_exec_type),
         backend_exec_session_id = COALESCE(?, backend_exec_session_id),
         backend_exec_pane_id = COALESCE(?, backend_exec_pane_id),
         last_event_id = ?,
         updated_at = ?
       WHERE job_id = ?`,
      [
        event.backend_exec_type,
        event.backend_exec_session_id,
        event.backend_exec_pane_id,
        event.id,
        ts,
        jobId,
      ],
    );
  }

  // Planctl-CLI invocation fan-out. Re-derive the session's epic_links +
  // every touched epic's job_links from scratch via the pure classifier in
  // `src/plan-classifier.ts`. Gated on:
  //   `planctl_op != NULL`     — this event is a planctl-CLI Bash invocation
  //                              (PostToolUse:Bash whose stdout carried the
  //                              `planctl_invocation` envelope — see
  //                              {@link extractPlanctlInvocation}), one of
  //                              the windowed mutations the classifier folds
  //                              into edges;
  //   OR `PreToolUse + skill_name='plan:plan'`
  //                            — this event is a `/plan:plan` window opener,
  //                              which can change the set of windows (and
  //                              thus which planctl events fall inside them)
  //                              even though it carries no `planctl_op` itself.
  //
  // The trigger gate itself is hook-event-agnostic — `planctl_op != null`
  // fires correctly regardless of whether the source event is a PreToolUse
  // or PostToolUse row. Only the stamping deriver changed.
  //
  // The two seams are disjoint from `syncJobIntoEpic` (jobs-write trigger):
  // a hook event like a SessionStart with `plan_ref` fires syncIfPlanRef but
  // not syncPlanctlLinks; a PostToolUse:Bash with a planctl envelope fires
  // syncPlanctlLinks but no jobs-side write happens (default switch arm).
  //
  // Post-switch placement matches the title-precedence precedent below: the
  // gate fires regardless of which `hook_event` switch arm did (or did not)
  // do lifecycle work.
  if (
    event.planctl_op != null ||
    (event.hook_event === "PreToolUse" && event.skill_name === "plan:plan")
  ) {
    syncPlanctlLinks(db, jobId, event.id, ts);
  }

  // Planctl-written tracked files get a `source='planctl'` attribution row per
  // path the envelope's `files` array names — without this mint they appear as
  // strict-mystery orphans the instant they flash dirty.
  if (event.planctl_op != null && event.planctl_files != null) {
    mintPlanctlFileAttributions(db, event);
  }

  // Title precedence rule: a `session_title` folds into `jobs.title`, source
  // resolved per-event ('transcript' priority 3 / 'payload' priority 2). Runs on
  // ANY event. Compares the incoming `(title, source)` against the PERSISTED
  // pair in-txn (never an accumulator), writing iff the incoming priority
  // outranks or ties+changes — so a higher source promotes and a lower never
  // clobbers, re-fold deterministic. No row → no-op.
  const title = extractSessionTitle(event);
  if (title != null) {
    const source = titleSourceForEvent(event);
    const p = sourcePriority(source);
    const row = db
      .query(
        "SELECT title, title_source, name_history FROM jobs WHERE job_id = ?",
      )
      .get(jobId) as {
      title: string | null;
      title_source: string | null;
      name_history: string;
    } | null;
    if (row != null) {
      const pp = sourcePriority(row.title_source);
      if (p > pp || (p === pp && row.title !== title)) {
        // Append the promoted title to `name_history` (dedupe-against-tail,
        // capped); pure function of the cell + the incoming title, so re-fold
        // is byte-identical.
        const nextHistory = appendNameHistory(row.name_history, title);
        db.run(
          "UPDATE jobs SET title = ?, title_source = ?, name_history = ?, last_event_id = ?, updated_at = ? WHERE job_id = ?",
          [title, source, nextHistory, event.id, ts, jobId],
        );
        // Title flipped → re-fan into the embedded entry so the displayed
        // title tracks. A TranscriptTitle event's title rule is the only
        // path that updates an EmbeddedJob's title without a lifecycle
        // branch firing, so the sync must live here too. Gated on the
        // title precedence-write actually happening so a no-op tier-3-vs-3
        // identical-value title doesn't fan a stale-but-unchanged element.
        syncIfPlanRef(db, jobId, event.id, ts);
      }
    }
  }
}

/**
 * Schema v40 (fn-652): append `title` to the persisted JSON array iff it
 * is not already the last element. Caps the result at the most-recent 20
 * entries by slicing the tail. Pure function of `(persistedJson, title)`:
 * no `Date.now`/env reads, no fold-time wall-clock — so a from-scratch
 * re-fold reproduces byte-identical history. Returns a `JSON.stringify`
 * of the resulting array, ready to bind into the `UPDATE jobs SET
 * name_history = ?` slot.
 *
 * Defensive parse: a malformed persisted JSON blob (which should never
 * happen — the column is NOT NULL DEFAULT '[]' and every writer
 * `JSON.stringify`s a real array) folds to `[]` per the CLAUDE.md "safe
 * value on malformed payload" invariant, then proceeds with the append.
 * A non-array JSON value (e.g. an object) is treated the same way.
 * Entries that are not strings (defensive — a malformed historical row)
 * are filtered out before append.
 */
function appendNameHistory(persisted: string, title: string): string {
  const NAME_HISTORY_CAP = 20;
  let history: string[];
  try {
    const parsed = JSON.parse(persisted) as unknown;
    if (Array.isArray(parsed)) {
      history = parsed.filter((x): x is string => typeof x === "string");
    } else {
      history = [];
    }
  } catch {
    history = [];
  }
  // Dedupe against the tail only: the array represents oldest→newest, so a
  // distinct-advance that happens to repeat an earlier title (e.g. foo→bar→foo)
  // still records the second `foo` entry, preserving the "title history" shape
  // a session-name resolver wants. Skipping only the case where the incoming
  // title equals the current tail keeps the precedence-write rule (which
  // already gates on `row.title !== title`) symmetric with the history.
  if (history.length > 0 && history[history.length - 1] === title) {
    return JSON.stringify(history);
  }
  history.push(title);
  if (history.length > NAME_HISTORY_CAP) {
    history = history.slice(history.length - NAME_HISTORY_CAP);
  }
  return JSON.stringify(history);
}

/**
 * Schema v51 (fn-682): compute the next `jobs.monitors` JSON-array
 * value from the Stop event's `data.background_tasks` snapshot, the
 * persisted live entries, and an in-fold scan of `events` for
 * three-way provenance lookup. Snapshot-replace (NOT append): the
 * returned JSON IS the full new value, byte-identical across re-folds
 * because every input is event-derived (no wallclock / env / fs / DB-
 * liveness probe). The empty / missing case returns `'[]'` —
 * authoritative drop-when-dead per CLAUDE.md "snapshot paradox".
 *
 * Provenance:
 * - `monitor` — an earlier PostToolUse:Monitor event in this session
 *   minted `tool_response.taskId === entry.id`.
 * - `bash-bg` — an earlier PostToolUse:Bash with `run_in_background`
 *   minted `tool_response.backgroundTaskId === entry.id`.
 * - `ambient` — no launch event in this session's event stream
 *   matches (plugin/harness-armed before the session existed, or
 *   launched by a SubagentStart that we never saw a PostToolUse for).
 *
 * The provenance scan is gated on `id < currentEventId` so it reads
 * only the immutable log up to but not including the current Stop —
 * a future event minted later cannot influence this fold's result, so
 * a cursor=0 re-fold reproduces byte-identical output. Index-backed
 * via `idx_events_background_task_id`'s partial composite predicate;
 * the trailing `tool_name` makes the index covering for the projected
 * read. Pure function of `(persistedJson, eventDataPayload, sessionId,
 * currentEventId, dbScan)` — `dbScan` reads only the event log.
 *
 * fn-718 (task 1): each entry also carries `command` / `description`,
 * which ride straight from the Stop payload via `extractBackgroundTasks`
 * (NOT from the events scan) so the render layer can show the script the
 * monitor is running. The provenance SELECT is UNCHANGED — only `kind`
 * comes from the scan — so the covering index is unaffected.
 *
 * NEVER throws — `extractBackgroundTasks` already swallows malformed
 * `background_tasks` shapes (returns `[]`), and the in-fold scan is
 * a strict SELECT against a known column shape.
 */
function computeMonitors(
  db: Database,
  sessionId: string,
  currentEventId: number,
  data: unknown,
): string {
  const tasks = extractBackgroundTasks(data);
  if (tasks.length === 0) {
    return "[]";
  }
  // Index-backed provenance scan: the partial composite
  // `idx_events_background_task_id (session_id, background_task_id,
  // id, tool_name) WHERE background_task_id IS NOT NULL` makes this a
  // direct seek + range lookup, never a full-table scan. The trailing
  // `tool_name` makes the index covering — no heap row lookup.
  const rows = db
    .query(
      `SELECT background_task_id AS task_id, tool_name
         FROM events
        WHERE session_id = ?
          AND background_task_id IS NOT NULL
          AND id < ?`,
    )
    .all(sessionId, currentEventId) as {
    task_id: string;
    tool_name: string | null;
  }[];
  // Map<id, provenance>: a re-launch with the same id (extremely
  // unlikely but defensive) keeps the FIRST observed mint, since
  // background-task ids are session-scoped and the launch event is
  // by definition the one that minted the id we see in the snapshot.
  // The forEach order is the same on every re-fold (the SELECT is
  // ordered by the index's natural order — `(session_id,
  // background_task_id, id)` — so the dedupe is deterministic).
  const provenance = new Map<string, "monitor" | "bash-bg">();
  for (const row of rows) {
    if (provenance.has(row.task_id)) continue;
    if (row.tool_name === "Monitor") {
      provenance.set(row.task_id, "monitor");
    } else if (row.tool_name === "Bash") {
      provenance.set(row.task_id, "bash-bg");
    }
    // tool_name not in {Monitor, Bash}: skip — the deriver should
    // never have stamped background_task_id, but if a future event
    // shape adds a third kind we leave it as `ambient` until the
    // deriver+projection learn how to name it.
  }
  // fn-718 (task 1): command/description ride from the Stop payload via
  // `extractBackgroundTasks`; only `kind` is merged from the provenance
  // scan above. The provenance SELECT is UNCHANGED — it still reads only
  // `(background_task_id, tool_name)`, so the covering index is unaffected.
  const entries: MonitorEntry[] = tasks.map((t) => ({
    id: t.id,
    kind: provenance.get(t.id) ?? "ambient",
    command: t.command,
    description: t.description,
  }));
  return JSON.stringify(entries);
}

/**
 * Fold ONE event into `jobs` and advance the cursor to `event.id`, atomically.
 *
 * Both writes share a single `BEGIN IMMEDIATE` transaction (via
 * `db.transaction`, which bun:sqlite runs as IMMEDIATE). On any throw the whole
 * transaction rolls back: neither the projection nor the cursor moves, and the
 * boot drain re-folds the event idempotently.
 *
 * `options.onBeforeCursorAdvance` is a test-only seam to simulate a crash
 * between the jobs write and the cursor advance.
 */
export function applyEvent(
  db: Database,
  event: Event,
  options: ApplyEventOptions = {},
): void {
  const fold = db.transaction(() => {
    // Route synthetic plan snapshots to the plans projection; every other event
    // (the hook lifecycle + title events) folds into jobs. Both share this one
    // BEGIN IMMEDIATE transaction + cursor advance — there is no second reducer.
    if (
      event.hook_event === "EpicSnapshot" ||
      event.hook_event === "TaskSnapshot"
    ) {
      projectPlanRow(db, event);
    } else if (
      event.hook_event === "EpicDeleted" ||
      event.hook_event === "TaskDeleted"
    ) {
      retractPlanRow(db, event);
    } else if (event.hook_event === "GitSnapshot") {
      projectGitStatus(db, event);
    } else if (event.hook_event === "GitRootDropped") {
      retractGitStatus(db, event);
    } else if (event.hook_event === "Commit") {
      foldCommit(db, event);
    } else if (event.hook_event === "UsageSnapshot") {
      projectUsageRow(db, event);
    } else if (event.hook_event === "UsageDeleted") {
      retractUsageRow(db, event);
    } else if (event.hook_event === "BuildSnapshot") {
      projectBuildsRow(db, event);
    } else if (event.hook_event === "BuildDeleted") {
      retractBuildsRow(db, event);
    } else if (event.hook_event === "DispatchFailed") {
      foldDispatchFailed(db, event);
    } else if (event.hook_event === "DispatchCleared") {
      foldDispatchCleared(db, event);
    } else if (event.hook_event === "Dispatched") {
      foldDispatched(db, event);
    } else if (event.hook_event === "DispatchExpired") {
      foldDispatchExpired(db, event);
    } else if (event.hook_event === "AutopilotPaused") {
      foldAutopilotPaused(db, event);
    } else if (event.hook_event === "AutopilotCapSet") {
      foldAutopilotCapSet(db, event);
    } else if (event.hook_event === "AutopilotMode") {
      foldAutopilotMode(db, event);
    } else if (event.hook_event === "EpicArmed") {
      foldEpicArmed(db, event);
    } else if (event.hook_event === "BackendExecSnapshot") {
      // retired fn-684 — fold to no-op so historical events advance the
      // cursor without touching the jobs projection. MUST stay an explicit
      // empty arm: the final `else` runs projectJobsRow, so deleting this
      // arm would route historical BackendExecSnapshot events into the jobs
      // projection and break re-fold determinism.
    } else {
      projectJobsRow(db, event);
      // The `subagent_invocations` projection rides the same transaction +
      // cursor advance — every triggering arm is folded inside this open
      // BEGIN IMMEDIATE so exactly-once-per-event holds across both
      // projections. Triggering hook_events: SubagentStart, SubagentStop,
      // PostToolUse (tool_name='Agent'), PostToolUseFailure
      // (tool_name='Agent'). Every other event is a fast in-fn no-op.
      projectSubagentInvocationsRow(db, event);
    }
    options.onBeforeCursorAdvance?.(event);
    db.run(
      "UPDATE reducer_state SET last_event_id = ?, updated_at = ? WHERE id = 1",
      [event.id, event.ts],
    );
  });
  // `.immediate()` issues BEGIN IMMEDIATE — grab the writer lock at BEGIN, not
  // when the first write upgrades. Without this, a SELECT-then-UPDATE inside
  // the transaction loses the snapshot-upgrade race to a concurrent hook
  // insert and surfaces as SQLITE_BUSY_SNAPSHOT (errno 517), wedging the
  // reducer. The cursor + projection co-advance contract is the whole point of
  // running this as one atomic write transaction — DEFERRED breaks it under
  // contention. See {@link migrate} for the same shape.
  fold.immediate();
}

/**
 * Drain a batch of unfolded events. Reads up to `batchSize` events with
 * `id > last_event_id`, folds each via {@link applyEvent}, and returns the
 * number drained. Returns 0 when caught up (including when a non-event
 * `data_version` bump — VACUUM / WAL checkpoint — produced no new rows).
 *
 * The caller loops until this returns 0. Each event is folded in its own
 * transaction (NOT one big transaction across the batch) so the writer lock is
 * released between events and hook inserts are never starved.
 *
 * A row whose `data` blob is unparseable still advances the cursor — the parse
 * is guarded inside {@link extractPermissionMode} (skip-and-log), so one
 * malformed row never halts the reducer.
 */
/**
 * A single-event fold over this many ms logs a `[fold-slow]` diagnostic line.
 * A slow fold holds the `BEGIN IMMEDIATE` write lock that long, starving
 * concurrent hook INSERTs and producing dead-letter bursts — the threshold is
 * the gate (only outliers log, so steady-state is silent). Instrumentation
 * only; not part of any projection.
 */
const SLOW_FOLD_LOG_MS = 200;

/**
 * Per-fold pacing knob for {@link drain}: how many milliseconds to sleep AFTER
 * each fold's `BEGIN IMMEDIATE` transaction COMMITs, before issuing the next
 * `BEGIN IMMEDIATE`. The sleep is a real OS-level pause (the JS thread is
 * blocked via `Atomics.wait`) — `setImmediate` / event-loop yields do NOT
 * release the SQLite writer lock to a separate process, so a real sleep is the
 * only primitive that opens a contention window for concurrent hook INSERTs.
 *
 * Re-fold determinism: the sleep lives in `drain` AFTER `applyEvent` returns
 * (the transaction has already COMMITted) — never inside `applyEvent`, never
 * inside any `project*` fn, never inside a `BEGIN IMMEDIATE`. No wall-clock
 * read feeds any projection write, so a from-scratch re-fold with pacing on or
 * off reproduces byte-identical rows.
 *
 * Single drain path: pacing is a stateless parameter on the SAME `drain()`
 * function steady state uses; the boot caller passes a positive `paceMs`, the
 * steady-state wake loop passes the default `0` (no pace). There is no forked
 * boot path — CLAUDE.md's "one drain code path serves boot and steady-state"
 * invariant holds.
 */
export interface DrainOptions {
  /**
   * Milliseconds to sleep AFTER each fold's COMMIT, before the next event's
   * `BEGIN IMMEDIATE`. `0` (or omitted) is "no pace" — the tight per-event
   * loop steady state needs. The boot caller passes a small positive value
   * (a few ms) to open a window for concurrent hook INSERTs to slip in.
   */
  paceMs?: number;
  /**
   * Budget on how many events `paceMs` applies to within a single `drain()`
   * call. After this many paced folds the loop runs unpaced for the rest of
   * the batch — so a large from-scratch re-fold (the schema-migration path
   * that rewinds the cursor and replays the full ~150k-event log) catches
   * up to head in bounded time instead of paying `paceMs` per event for
   * minutes. `0` (or omitted) is "pace every event in the batch" — only
   * appropriate when the caller knows the batch is small.
   */
  paceEvents?: number;
  /**
   * OS-level sleep primitive. Defaulted to a `SharedArrayBuffer`/`Atomics.wait`
   * sleep (the same shape `plugin/hooks/events-writer.ts` uses for its bounded
   * retry) — a real sleep that releases the SQLite writer lock to a separate
   * process. Test-only injection point: a mock sleep can record call counts
   * and durations without paying the actual wall-clock cost. Production
   * callers leave this defaulted.
   */
  sleep?: (ms: number) => void;
}

/**
 * Default OS-level synchronous sleep: blocks the JS thread for up to `ms`
 * milliseconds via `Atomics.wait` on a fresh zero-initialized
 * `SharedArrayBuffer`. Same shape `plugin/hooks/events-writer.ts` uses; the
 * wait always returns `"timed-out"` because nothing holds a handle to the
 * buffer to notify. A real OS sleep is the only primitive that releases the
 * SQLite writer lock to a separate process — `setImmediate` does NOT.
 */
function defaultDrainSleep(ms: number): void {
  if (ms <= 0) return;
  const buf = new SharedArrayBuffer(4);
  const view = new Int32Array(buf);
  Atomics.wait(view, 0, 0, ms);
}

export function drain(
  db: Database,
  batchSize = DEFAULT_BATCH_SIZE,
  options: DrainOptions = {},
): number {
  const cursorRow = db
    .query("SELECT last_event_id FROM reducer_state WHERE id = 1")
    .get() as { last_event_id: number } | null;
  const cursor = cursorRow?.last_event_id ?? 0;

  // fn-717.1: the `data` blob resolves via `COALESCE(events.data,
  // event_blobs.data)` so a blob the compaction relocator (task .2) has
  // MOVEd into the `event_blobs` side table folds byte-identically to one
  // still inline. The LEFT JOIN is empty in .1 (no compaction yet), so
  // COALESCE returns the inline `events.data` for every row and this drain
  // is byte-identical to the pre-v57 form. `event_blobs` carries only
  // `(event_id, data)`, so every other projected column is unambiguous;
  // `id` is qualified to `events.id` for the join key (the side table has
  // no `id`).
  const rows = db
    .query(
      `SELECT events.id AS id, ts, session_id, pid, hook_event, event_type,
              tool_name, matcher, cwd, permission_mode, agent_id, agent_type,
              stop_hook_active,
              COALESCE(events.data, event_blobs.data) AS data,
              subagent_agent_id, spawn_name,
              start_time, slash_command, skill_name,
              planctl_op, planctl_target, planctl_epic_id, planctl_task_id,
              planctl_subject_present, tool_use_id, config_dir, planctl_files,
              backend_exec_type, backend_exec_session_id, backend_exec_pane_id
         FROM events
         LEFT JOIN event_blobs ON event_blobs.event_id = events.id
        WHERE events.id > ?
        ORDER BY events.id ASC
        LIMIT ?`,
    )
    .all(cursor, batchSize) as Event[];

  // Pacing config: `paceMs` ≤ 0 disables, `paceEvents` ≤ 0 means "no event
  // budget — pace every event in the batch". The budget is decremented per
  // paced fold so a large backlog naturally drops out of paced mode after the
  // budget is spent.
  const paceMs = options.paceMs ?? 0;
  const paceEventsBudget = options.paceEvents ?? 0;
  const sleep = options.sleep ?? defaultDrainSleep;
  let pacedRemaining =
    paceMs > 0 ? (paceEventsBudget > 0 ? paceEventsBudget : rows.length) : 0;

  for (const row of rows) {
    const foldStart = performance.now();
    applyEvent(db, row);
    const foldMs = performance.now() - foldStart;
    if (foldMs >= SLOW_FOLD_LOG_MS) {
      // Instrumentation: this fold held the `BEGIN IMMEDIATE` write lock for
      // `foldMs`, starving any concurrent hook INSERT (→ dead-letter bursts).
      // Logs the event identity so the cause is attributable and time-
      // correlatable with the hook drop-log. Pure side-effect: the projection
      // write inside `applyEvent` is unchanged, so re-fold determinism holds
      // (the wall-clock read is not an input to any projection).
      console.error(
        `[fold-slow] id=${row.id} event=${row.hook_event ?? "?"} type=${row.event_type ?? "?"} dur=${Math.round(foldMs)}ms`,
      );
    }
    // Post-COMMIT yield. `applyEvent` has already returned — the transaction
    // is closed and the writer lock is released. A real OS sleep here opens
    // a window for a concurrent hook INSERT (separate process, separate
    // `BEGIN IMMEDIATE`) to grab the writer lock instead of starving on the
    // tight loop that would otherwise issue the next `BEGIN IMMEDIATE`
    // microseconds after this fold's COMMIT. The budget `pacedRemaining`
    // bounds total paced latency so a large backlog catches up to head.
    if (pacedRemaining > 0) {
      sleep(paceMs);
      pacedRemaining -= 1;
    }
  }

  return rows.length;
}
