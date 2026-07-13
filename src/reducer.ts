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

import type { Database, SQLQueryBindings, Statement } from "bun:sqlite";
import {
  extractBackgroundTasks,
  extractCommit,
  handoffIdFromSpawnName,
  hasLiveWorkerMonitor,
  isKilledTaskNotification,
  type MonitorEntry,
  parsePlanRef,
  planVerbRefFromSpawnName,
} from "./derivers";
import {
  INSTANT_DEATH_BREAKER_REASON,
  SHARED_DIRTY_DISTRESS_VERB,
} from "./dispatch-failure-key";
import { epicIsCompleted, projectBasename, resolveEpicDep } from "./epic-deps";
import { allGatedRootsSeeded } from "./gated-roots";
import { compileFnmatch, isGlobToken } from "./glob";
import {
  type ClassifierInvocation,
  deriveEpicLinks,
  deriveJobLinks,
  type EpicLink,
  type JobLink,
  normalizePlanOp,
} from "./plan-classifier";
import type { ResolutionDiagnostic } from "./readiness-diagnostics";
// The row types for the `WorktreeRepoStatus` / `LaneMerged` folds live on the pure
// verdict side (the reconcile snapshot references them); re-exported here so
// existing `from "./reducer"` importers keep resolving.
import type {
  LaneMergedEntry,
  WorktreeRepoStatusEntry,
} from "./reconcile-core";
import {
  extractTurnSeq,
  findBridgePreToolUse,
  findFreshInFlightSubagentAnchor,
  findOpenRunningInGroup,
  findOpenTurnForStop,
  findPendingPreToolUseForStart,
  OPEN_TURN_STATUS_SQL,
  resolveBridgeAgentId,
} from "./subagent-invocations";
import type {
  ApiErrorKind,
  BlockEscalationAttemptedPayload,
  BlockEscalationRequestedPayload,
  BlockHumanNotifiedPayload,
  Epic,
  Event,
  HandoffLinkEntry,
  InputRequestKind,
  JobLinkEntry,
  MergeEscalationAttemptedPayload,
  MergeHumanNotifiedPayload,
  PermissionPromptKind,
  RepairDispatchedPayload,
  RepairHumanNotifiedPayload,
  ResolvedEpicDep,
  ResolverDispatchAttemptedPayload,
  SessionTelemetryPayload,
  SharedCheckoutHumanNotifiedPayload,
  SubagentDisposition,
} from "./types";
import { API_ERROR_KINDS } from "./types";

// Re-export the `WorktreeRepoStatus` / `LaneMerged` fold row contracts (now defined
// on the pure verdict side) so existing `from "./reducer"` importers keep resolving.
export type { LaneMergedEntry, WorktreeRepoStatusEntry };

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
 * The lifecycle-stamp gate (ADR 0013). `jobs.last_lifecycle_ts` is a per-row
 * event-time high-water mark that a lifecycle transition may not regress behind,
 * so a stale out-of-order event ANNOTATES but never resurrects state — the fix
 * for phantom-working (a `stopped` row read as `working` after its session went
 * permanently idle, because a straggler tool event with an EARLIER ts than the
 * turn-final `Stop` ingested LAST and un-stopped it).
 *
 * Returns a WHERE / CASE predicate FRAGMENT the caller ANDs into its own terminal
 * and subagent-yield guards — it COMPOSES WITH them, replaces neither. The caller
 * binds one `?` (the event ts) where the fragment sits, plus (on apply) sets
 * `last_lifecycle_ts = <event ts>`; the WHERE guarantees `ts >= stamp`
 * (quiescing) or `ts > stamp` (activating), so the applied value is already
 * `max(stamp, ts)` and needs no SQL `MAX` — that stays only on the terminal arms.
 *
 * Polarity is REMOVE-BIASED last-write-wins (the LWW-Element-Set remove bias):
 *   - `quiesce` (a `→ stopped` transition) applies at `ts >= stamp`;
 *   - `activate` (a `→ working` revival — a prompt, a resume, a tool event)
 *     applies only at strictly `ts > stamp`,
 * so an equal-ts tie between racing same-host writers resolves to QUIESCENCE.
 * Equal-ts collisions are a HOT path at ms granularity, not a rare edge. The
 * tiebreak MUST stay semantic (quiescence wins) and NEVER be "fixed" into an
 * `event.id` tiebreak: insertion id is arrival order, the exact untrusted input
 * the phantom-working bug rode in on. A NULL stamp always applies (a fresh row).
 *
 * `col` lets a caller qualify the column (`jobs.last_lifecycle_ts`) inside an
 * UPSERT `ON CONFLICT DO UPDATE` where the bare name is ambiguous. Pure over
 * event fields + the folded stamp, so the gated fold stays re-fold deterministic.
 */
function lifecycleStampGate(
  polarity: "quiesce" | "activate",
  col = "last_lifecycle_ts",
): string {
  return `(${col} IS NULL OR ? ${polarity === "quiesce" ? ">=" : ">"} ${col})`;
}

/**
 * Recency bound (unix-SECONDS) for the Stop + ApiError sub-agent guards (both
 * route through {@link findFreshInFlightSubagentAnchor}). Without it, a one-shot
 * orphan sub-agent that never emits `SubagentStop` would pin its parent at
 * `state='working'` forever (the guard keeps finding the surviving open-turn row)
 * and hold the autopilot mutex open. If the freshest surviving in-flight
 * sub-agent's last-activity `updated_at` is older than this many seconds relative
 * to the guard event's `ts`, the guard releases and the fold writes its terminal
 * state.
 *
 * Anchored on `updated_at` (last activity — re-stamped by every SubagentTurn /
 * PostToolUse:Agent / SubagentStop), NOT the frozen SubagentStart spawn `ts`, so
 * a slow-but-alive sub re-arms its window on each activity instead of aging out
 * mid-run.
 *
 * UNIT TRAP: both `events.ts` and `subagent_invocations.updated_at` are
 * unix-SECONDS; the comparison `event.ts - row.updated_at` is in seconds —
 * multiplying by 1000 is a 1000x bug. Pure (compile-time constant, no
 * clock/config/meta read), so re-fold determinism holds. Tradeoff: too large
 * pins a stuck sub-agent's mutex longer; too small flashes a slow in-flight
 * sub-agent to `stopped` and clears readiness predicate 5 for a tick.
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
 * Parse a `SubagentTurn` disposition and its settlement bit. Missing settlement
 * defaults true for replay compatibility; explicit `false` remains provisional
 * and cannot drive a lifecycle transition. Malformed values return `null`.
 */
function extractSubagentDisposition(
  event: Event,
): { disposition: SubagentDisposition; settled: boolean } | null {
  try {
    const parsed = JSON.parse(event.data) as {
      disposition?: unknown;
      settled?: unknown;
    };
    const raw = parsed?.disposition;
    if (raw !== "cut" && raw !== "clean") {
      return null;
    }
    return { disposition: raw, settled: parsed.settled !== false };
  } catch {
    return null;
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
 * Extract the top-level `transcript_path` from an event's verbatim hook-payload
 * `data` blob. A SessionStart seeds the jobs row with it; a proven-live activity
 * event refreshes it via {@link refreshTranscriptPathFromActivity}. Skip-and-log
 * on a malformed blob, never throw. Returns the path only when it is a non-empty
 * absolute string, else `null`.
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
 * Activity-gated `transcript_path` refresh. Only a proven-live activity event
 * that already carries the live `transcript_path` in its verbatim hook payload
 * may move the column off the value the row's first-sight INSERT seeded. A bare
 * SessionStart never reaches here, so the SessionStart(+SessionEnd) pair a
 * FAILED resume emits (no activity, only a predicted-but-never-created path) can
 * never clobber the last good `transcript_path`. An activity event LACKING the
 * field (`extractTranscriptPath` → null) is a no-op — it must never null the
 * column. The change-gate WHERE keeps the steady state (an unchanged path
 * repeated across a turn) a cold no-op, so this writes only on a genuine
 * rehome/resume drift.
 *
 * Called ONLY from the UserPromptSubmit and Stop arms — both keep-set
 * hook_events whose `data` body the retention shed NEVER NULLs, so a from-
 * scratch re-fold over a shed-shaped corpus reads the same body and reproduces
 * the same write. Pre/PostToolUse is deliberately NOT a source: its body sheds
 * for the mutation tools and `transcript_path` has no promoted column, so
 * reading it there would diverge post-shed (see the Pre/PostToolUse arm note).
 *
 * `transcript_path` is display/debug only and is not embedded in the
 * `epics.jobs` element, so a move needs no `syncIfPlanRef` re-fan. Pure over
 * `event.data` — re-fold deterministic.
 */
function refreshTranscriptPathFromActivity(
  db: Database,
  event: Event,
  jobId: string,
): void {
  const transcriptPath = extractTranscriptPath(event);
  if (transcriptPath == null) {
    return;
  }
  db.run(
    `UPDATE jobs SET transcript_path = ?, last_event_id = ?, updated_at = ?
       WHERE job_id = ?
         AND (transcript_path IS NULL OR transcript_path != ?)`,
    [transcriptPath, event.id, event.ts, jobId, transcriptPath],
  );
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
  /**
   * Why the session died, stamped by the producer's main-side tmux liveness
   * probe (`server_gone` / `pid_died` / `window_gone_server_alive` / `unknown`).
   * The reducer folds it as an OPAQUE string copy — no liveness re-probe in the
   * fold (a re-probe would break re-fold determinism). `null` when the producer
   * emitted no classification (a pre-schema-v70 Killed re-folding, or a path
   * that does not probe), folding the column to NULL.
   */
  close_kind: string | null;
  /**
   * WHY keeper reaped the job — the producer arm that minted this Killed
   * (`exit_watched` for the steady-state exit-watcher; `boot_unwatchable` /
   * `boot_pid_dead` / `boot_pid_recycled` for the boot seed sweep). Orthogonal
   * to `close_kind` (HOW the session died). Folded onto `jobs.kill_reason` as an
   * OPAQUE string copy — no re-probe in the fold (a re-probe breaks re-fold
   * determinism). `null` when the producer emitted no reason (a pre-schema-v103
   * Killed re-folding), folding the column to NULL. Any non-string (including
   * absent) folds to NULL, never coerced.
   */
  reason: string | null;
}

/**
 * Extract the `(pid, start_time, close_kind)` payload from a synthetic `Killed`
 * event's `data` blob. Skip-and-log on a malformed blob, never throw — the
 * Killed fold falls through as a safe no-op when this returns null.
 *
 * `pid` is either a finite number (the proven-dead pid) OR explicit `null` for
 * a PIDLESS REAP of a NULL-pid `stopped` row. Any OTHER shape is malformed →
 * null. The pidless arm is opt-in via a literal JSON `null`, so a malformed
 * blob can never accidentally trigger a reap. `start_time` is optional /
 * nullable (the producer may emit a Killed for a row whose stored start_time
 * is NULL). `close_kind` and `reason` are defensive: any non-string (including
 * absent) folds to NULL, never coerced — a garbage value must not masquerade as
 * a real kind/reason.
 */
function extractKilledPayload(event: Event): KilledPayload | null {
  if (event.data == null || event.data.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(event.data) as {
      pid?: unknown;
      start_time?: unknown;
      close_kind?: unknown;
      reason?: unknown;
    };
    const pid = parsed.pid;
    // Accept a finite number (proven-dead reap) OR an explicit literal `null`
    // (pidless reap). Anything else is malformed → no-op.
    if (pid !== null && (typeof pid !== "number" || !Number.isFinite(pid))) {
      return null;
    }
    const startTime =
      typeof parsed.start_time === "string" ? parsed.start_time : null;
    const closeKind =
      typeof parsed.close_kind === "string" ? parsed.close_kind : null;
    const reason = typeof parsed.reason === "string" ? parsed.reason : null;
    return {
      pid: pid as number | null,
      start_time: startTime,
      close_kind: closeKind,
      reason,
    };
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
   * plan-native effort tier on TaskSnapshot blobs. Stored opaque (the
   * reducer never branches on the value). Read defensively
   * (`snapshot.tier ?? null`) so an older blob folds to a null tier. Rides
   * free in the embedded-tasks JSON; no schema column.
   */
  tier?: string | null;
  /**
   * plan-native worker model on TaskSnapshot blobs (the model axis of the
   * {model × effort} worker matrix). Stored opaque (the reducer never branches
   * on the value). Read defensively (`snapshot.model ?? null`) so an older blob
   * folds to a null model. Rides free in the embedded-tasks JSON; no schema column.
   */
  model?: string | null;
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
   * plan-native runtime status (`"todo" | "in_progress" | "done" |
   * "blocked"`). Read defensively (`runtime_status ?? "todo"`) so an older blob
   * still folds deterministically.
   */
  runtime_status?: string | null;
  /** Epic-level deps (EpicSnapshot blob) — the plan `depends_on_epics` ids. */
  depends_on_epics?: string[] | null;
  /** Task-level deps (TaskSnapshot blob) — the plan `depends_on` task ids. */
  depends_on?: string[] | null;
  /**
   * plan-native `last_validated_at` (EpicSnapshot blob, epic-level only).
   * Absent / NULL folds to `null` so an older blob reproduces the same row
   * across re-fold.
   */
  last_validated_at?: string | null;
  /**
   * The epic-level parked-closer question (EpicSnapshot blob, epic-level
   * only), sourced from the gitignored `.state.json` runtime overlay. Absent
   * / NULL folds to `null` (no parked question) so a pre-this-feature blob
   * reproduces the same row across re-fold.
   */
  question?: string | null;
  /**
   * The blocking-follow-up source pointer (EpicSnapshot blob, epic-level
   * only) — the source epic id this follow-up gates the close of. Absent /
   * NULL folds to `null` (an ordinary epic) so a pre-this-feature blob
   * reproduces the same row across re-fold.
   */
  blocks_closing_of?: string | null;
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
    // `jobs` / `job_links` / `resolved_epic_deps`: an epic snapshot carries
    // none of that data, and a shell row inserted by a task/job/plan-event
    // before the epic already holds those columns. Without the carve-out, an
    // EpicSnapshot re-fold would wipe the provenance, job-link, and
    // resolved-deps projections.
    db.run(
      `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, depends_on_epics, last_validated_at, question, blocks_closing_of, last_event_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(epic_id) DO UPDATE SET
         epic_number = excluded.epic_number,
         title = excluded.title,
         project_dir = excluded.project_dir,
         status = excluded.status,
         depends_on_epics = excluded.depends_on_epics,
         last_validated_at = excluded.last_validated_at,
         question = excluded.question,
         blocks_closing_of = excluded.blocks_closing_of,
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
        // The parked-closer question — a missing / NULL blob value folds to
        // NULL (no parked question, the zero-event reading).
        snapshot.question ?? null,
        // The blocking-follow-up source pointer — a missing / NULL blob value
        // folds to NULL (an ordinary epic, the zero-event reading).
        snapshot.blocks_closing_of ?? null,
        event.id,
        ts,
      ],
    );

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
      model: string | null;
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
      // The slot order across `target_repo` / `tier` / `model` / `worker_phase`
      // etc. must match `PlanTaskMessage` / `seedFromDb` / the `TaskElement`
      // shell in `syncJobIntoEpic` — the change-gate `JSON.stringify`
      // byte-compare relies on consistent slot order across all four sites.
      tier: snapshot.tier ?? null,
      // plan-native worker model — the model axis of the worker matrix; older
      // blobs lack the key and fold to null.
      model: snapshot.model ?? null,
      // A pre-rename blob carries `status` instead of `worker_phase`; read
      // whichever is present so a re-fold reproduces the same value.
      worker_phase: snapshot.worker_phase ?? snapshot.status ?? null,
      // Absent on older blobs / never-observed state files → folds to `"todo"`
      // per plan's `merge_task_state` convention.
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

    // `block_escalations` latch — the escalate-once gate for the daemon
    // block-escalation producer (task 3). The transition is read off the
    // EMBEDDED array's prev value (`oldElement`, the latch's prev-value source —
    // a first-sight task has none, so its prior status is not-blocked) versus the
    // freshly-folded `element.runtime_status`. Pure function of the payload + the
    // persisted row (event.id only — no wall-clock/fs/liveness), so the fold
    // stays re-fold-deterministic. Category is NOT read here: the
    // `TOOLING_FAILURE`-skip gate lives in the producer.
    const prevRuntimeStatus = oldElement?.runtime_status ?? null;
    const nextRuntimeStatus = element.runtime_status;
    if (prevRuntimeStatus !== "blocked" && nextRuntimeStatus === "blocked") {
      // Entered blocked: ARM the latch. `ON CONFLICT DO NOTHING` preserves the
      // first-observed arm's `blocked_since`/`status` so a redundant re-snapshot
      // of an already-blocked task (same blocked instance) never resets the
      // latch — only the leave-blocked DELETE below clears it, so an
      // unblock→re-block re-arms exactly once (the `dispatch_never_bound`
      // bind/clear reset analog).
      db.run(
        `INSERT INTO block_escalations (epic_id, task_id, blocked_since, status, outcome, last_event_id)
           VALUES (?, ?, ?, 'pending', NULL, ?)
         ON CONFLICT(epic_id, task_id) DO NOTHING`,
        [epicId, entityId, event.id, event.id],
      );
    } else if (
      prevRuntimeStatus === "blocked" &&
      nextRuntimeStatus !== "blocked"
    ) {
      // Left blocked: CLEAR the latch so the next block instance re-arms fresh.
      db.run(
        "DELETE FROM block_escalations WHERE epic_id = ? AND task_id = ?",
        [epicId, entityId],
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
  source: "tool" | "bash" | "inferred" | "plan";
}

/**
 * Project the latest `(session_id, file_path)` mutation evidence the persisted
 * event log carries for a given dirty file, reading the per-snapshot
 * {@link ExplicitAttribHoist} (built once before the pass-1 loop). Three match
 * modes feed the same `file_attributions` UPSERT in pass 1:
 *
 *   - tool mutations (exact): PostToolUse Write/Edit/MultiEdit/NotebookEdit
 *     whose promoted `mutation_path` column matches the dirty file's `path` /
 *     `orig_path` — a SEEK on the once-prepared `toolStmt` (fn-836.3);
 *   - bash mutations (exact): PostToolUse:Bash events whose
 *     `bash_mutation_targets` array contains the path — an O(1) lookup into the
 *     once-built `bashByToken` index (the old SQL-side `json_each` probe,
 *     materialized per token);
 *   - bash mutations (prefix + fnmatch) for `git-rm` / `git-mv`: targets may
 *     name directories or globs (which SQL can't probe) AND the deleted files
 *     carry `mtime_ms=null` (no pass-2 inference), so the once-parsed
 *     `deletionRows` are matched in JS via `bashTargetMatches` for exact /
 *     directory-prefix / fnmatch. The `__TREE__` sentinel is excluded (by
 *     `bashTargetMatches`) so a tree-mutate can't match real files.
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
  source: "tool" | "bash" | "plan";
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

/**
 * Per-arm timing + cardinality accumulator for pass 1 of {@link projectGitStatus},
 * surfaced on the `[gitfold-breakdown]` line. The two tool arms are prepared once
 * (in {@link buildExplicitAttribHoist}) and SEEK per dirty file, so only their
 * summed `.all()` execute time + matched-row count are tracked. The bash and
 * git-rm/git-mv deletion scans run ONCE per snapshot (also in the hoist); their
 * prepare/execute split is the once-per-snapshot scan cost, after which each file
 * matches via an O(1) JS lookup. Pure instrumentation: never read into a
 * projection write, so re-fold determinism is untouched.
 */
interface ExplicitAttribAccumulator {
  // The single tool-mutation scan is prepared ONCE per snapshot (the hoist) and
  // seeks per file off `mutation_path`, so only its per-file `.all()` execute
  // time + matched-row count are tracked (fn-836.3 collapsed the old two arms
  // — inline + relocated `event_blobs` — into one column read).
  toolArmAExecMs: number;
  toolArmARows: number;
  // Bash + deletion scans run ONCE per snapshot (the hoist); prep=compile,
  // exec=.all+materialize, rows=scanned. A per-file `.get` lookup is O(1) JS.
  bashScanPrepMs: number;
  bashScanExecMs: number;
  bashScanRows: number;
  deletionScanPrepMs: number;
  deletionScanExecMs: number;
  deletionScanRows: number;
}

function newExplicitAttribAccumulator(): ExplicitAttribAccumulator {
  return {
    toolArmAExecMs: 0,
    toolArmARows: 0,
    bashScanPrepMs: 0,
    bashScanExecMs: 0,
    bashScanRows: 0,
    deletionScanPrepMs: 0,
    deletionScanExecMs: 0,
    deletionScanRows: 0,
  };
}

/**
 * Per-snapshot scans + prepared statements hoisted ONCE out of the per-file
 * loop of {@link projectGitStatus}, mirroring the {@link computeRepoBashWindows}
 * prior art. The pass-1 cost was dominated by the per-file loop re-running two
 * snapshot-invariant scans (the bash `json_each` exact-match scan over the 1.1k
 * mutation rows and the git-rm/git-mv deletion scan, both identical for every
 * dirty file) and re-`prepare`ing the two tool statements per file — bun:sqlite
 * does not cache `prepare()`. Hoisting collapsed the bash scan to a built
 * exact-match index and the deletion scan to a parsed row list, sharing one
 * prepared statement pair across the loop. fn-892 then makes both INCREMENTAL:
 * the index + row list are owned by the per-`Database` {@link GitAttribMemo} and
 * a fold appends only the `id > maxId` delta rather than rebuilding from a
 * full-history scan. The matched-row set per file stays byte-identical to the
 * per-file scans (the consumer is newest-wins `(ts, id)`, order-insensitive), so
 * re-fold determinism is untouched.
 */
interface BashMutationRow {
  id: number;
  ts: number;
  session_id: string;
  kind: string;
}

interface DeletionMutationRow {
  id: number;
  ts: number;
  session_id: string;
  kind: string;
  tokens: string[];
}

interface ExplicitAttribHoist {
  // Prepared once, reused across every dirty file (and both candidate paths).
  // Single arm off `mutation_path` (fn-836.3) — `event_blobs` no longer read.
  toolStmt: Statement;
  // The bash exact-match scan, materialized once as `target token → rows`. The
  // SQL probe was `json_each(targets) WHERE value = ?` (exact equality), so a
  // per-token bucket reproduces the same matched set via an O(1) JS lookup.
  // Owned by the per-`Database` {@link GitAttribMemo} — INCREMENTALLY appended,
  // not rebuilt, so the returned reference is the live memo map.
  bashByToken: Map<string, BashMutationRow[]>;
  // The git-rm/git-mv rows, pulled and JSON-parsed ONCE; matched per file in JS
  // via `bashTargetMatches` (exact / dir-prefix / fnmatch) exactly as before.
  // Also owned by the per-`Database` memo (appended, not rebuilt).
  deletionRows: DeletionMutationRow[];
}

/**
 * Per-`Database` incremental memo for the two pass-1 attribution scans (fn-892).
 *
 * The two scans in {@link buildExplicitAttribHoist} (a bash exact-match scan over
 * every `bash_mutation_kind IS NOT NULL` row and a git-rm/git-mv deletion scan)
 * are snapshot-invariant — they ran once per snapshot but rescanned the WHOLE
 * `events` table each time, so the dominant steady-state fold cost grew
 * monotonically with log size. This memo collapses each to O(rows since the last
 * fold): per fold we scan only `id > maxId` and APPEND the freshly-parsed rows
 * into the cached structures, then bump `maxId`.
 *
 * Correctness rests on three facts:
 *  - the event log below head is APPEND-ONLY (rows are never deleted; retention
 *    only NULLs fold-unread bodies — never `bash_mutation_kind` /
 *    `bash_mutation_targets`, the only columns these scans read), so an
 *    incremental append over `id > maxId` is a faithful SUPERSET of a full rescan;
 *  - attribution is newest-wins re-evaluated per `(file_path)` on `(ts, id)` in
 *    `findExplicitAttributions` / the UPSERT WHERE clause, so id-insertion order
 *    (the watermark axis) need not match ts order — a later-inserted older-ts row
 *    still loses correctly on re-evaluation;
 *  - the persisted `file_attributions` projection is order-insensitive
 *    (newest-wins UPSERT by `last_mutation_at`), so an in-memory append never
 *    perturbs the on-disk bytes — a warm-cache fold equals a cold rescan.
 *
 * This is the LIVE-ONLY / charter-excluded git surface (`git_status`,
 * `file_attributions`), so in-process per-`Database` memoization is acceptable: it
 * is NOT a projection, never persisted, and re-derives for free on a fresh
 * connection (a cold entry's first scan is `id > 0` = the whole history once,
 * preserving boot-seed full fidelity). Keyed by `Database` via a `WeakMap` so a
 * dropped connection's memo is collected; a test using a fresh DB per case starts
 * cold by construction (see CLAUDE.md test-isolation note).
 */
interface GitAttribMemo {
  maxId: number;
  bashByToken: Map<string, BashMutationRow[]>;
  deletionRows: DeletionMutationRow[];
}

const gitAttribMemos = new WeakMap<Database, GitAttribMemo>();

/**
 * Test-only: drop the per-`Database` git-attribution memo so the NEXT fold on
 * this connection starts cold (a full `id > 0` rescan). Production never calls
 * this — the WeakMap collects a dropped connection's memo on its own, and a
 * fresh-DB-per-test is cold by construction. Exposed so a warm-vs-cold
 * equivalence test can force a cold rescan on a connection it has already warmed
 * (see the CLAUDE.md WeakMap test-isolation note).
 */
export function __resetGitAttribMemoForTest(db: Database): void {
  gitAttribMemos.delete(db);
}

/**
 * Pre-warm the per-`Database` {@link GitAttribMemo} to the current
 * `max(events.id)` ONCE, OUTSIDE any fold's lock-held critical section (fn-921).
 *
 * On a fresh connection the memo is cold (`maxId = 0`), so the FIRST
 * {@link buildExplicitAttribHoist} call inside a fold pays the single `id > 0`
 * full-history scan of the sparse bash-mutation subset. At boot the boot-seed
 * runs that first git fold per root while holding the reducer write lock and
 * racing the per-root time budget; paying the cold scan there is what made one
 * slow root starve the rest of the seed loop. Warming the memo here moves that
 * one-time scan ahead of the per-root fold loop so each root's fold sees a warm
 * memo (an `id > maxId` empty/near-empty delta).
 *
 * This is a PURE optimization: the memo is never a fold INPUT — every projection
 * write re-derives attribution newest-wins per file, and the memo only caches
 * the snapshot-invariant scan rows. So warming early changes no projection byte
 * and leaves re-fold determinism untouched (identical to a fold that warmed the
 * memo lazily on its first call). Producer-only — call it from the boot-seed
 * before the per-root loop, NEVER from inside a fold.
 */
export function warmGitAttribMemo(db: Database): void {
  // `buildExplicitAttribHoist` does the incremental `id > maxId` scan and bumps
  // the memo watermark as a side effect; we discard the returned hoist (the
  // per-fold loop builds its own cheaply off the now-warm memo).
  buildExplicitAttribHoist(db);
}

/**
 * Build the per-snapshot {@link ExplicitAttribHoist} once before the pass-1
 * loop. The two scans here ran once per dirty file (fn-787 hoisted them to once
 * per snapshot); fn-892 makes each INCREMENTAL via the per-`Database`
 * {@link GitAttribMemo}, so a steady-state fold scans only the `id > maxId`
 * delta and appends into the cached structures instead of re-scanning the whole
 * `events` table. `acc` carries the prepare-vs-execute timing split for the
 * `[gitfold-breakdown]` line (pure instrumentation; `p1_bash_rows` /
 * `p1_del_rows` now report the per-fold delta, not full history).
 */
function buildExplicitAttribHoist(
  db: Database,
  acc?: ExplicitAttribAccumulator,
): ExplicitAttribHoist {
  // Single-arm tool-mutation scan off the promoted `mutation_path` column
  // (fn-836.3): the file_path the old two-arm scan parsed from the JSON body
  // (inline ARM A + relocated ARM B) is now read directly from the column,
  // backfilled byte-identically over every historical row (`backfillMutationPath`,
  // guarded extract, malformed→NULL, matching the old scan exactly). The
  // `WHERE mutation_path IS NOT NULL` partial index `idx_events_mutation_path`
  // serves this as a sub-ms covering SEEK. Post-shed (fn-836.4) the `event_blobs`
  // side table is gone entirely (ARM B's rowid-join was deleted here in .3), so
  // there are no more multi-second attribution folds under load.
  const toolStmt = db.prepare(
    `SELECT id, ts, session_id, tool_name
         FROM events
        WHERE hook_event = 'PostToolUse'
          AND tool_name IN ('Write','Edit','MultiEdit','NotebookEdit')
          AND mutation_path = ?`,
  );

  // Per-`Database` incremental memo (fn-892): scan only `id > maxId` and append
  // into the cached structures, so steady-state pass-1 cost is O(rows since the
  // last fold), not O(history). A cold entry (no memo for this connection) starts
  // at `maxId = 0`, so its first scan is `id > 0` = the whole history once —
  // preserving boot-seed full fidelity. See {@link GitAttribMemo}.
  let memo = gitAttribMemos.get(db);
  if (memo == null) {
    memo = { maxId: 0, bashByToken: new Map(), deletionRows: [] };
    gitAttribMemos.set(db, memo);
  }
  const bashByToken = memo.bashByToken;
  const deletionRows = memo.deletionRows;
  const fromId = memo.maxId;
  // Highest `id` seen across BOTH scans — including malformed/body-nulled rows
  // the parse loops `continue` past. The watermark MUST advance past those too,
  // or a permanently-malformed low row would re-anchor every later scan (and
  // re-process the whole tail forever). Strict `id > fromId` (never `>=`) so the
  // watermark row is never re-applied.
  let newMaxId = fromId;

  // Bash exact-match scan — pull the sparse mutation subset newer than the memo
  // watermark and bucket each row under every target token it carries (the SQL
  // `json_each ... = ?` probe was per-file per-token exact equality, so a
  // per-token bucket is equivalent). The partial `idx_events_bash_attr` covers
  // the `bash_mutation_kind IS NOT NULL` predicate as a SEARCH; the `id > ?`
  // rowid bound makes it the incremental slice. NO `ORDER BY` — the per-token
  // buckets feed a newest-wins `(ts, id)` consumer that is order-insensitive, so
  // an ordered scan would only buy a needless TEMP B-TREE.
  const _bashP0 = acc != null ? performance.now() : 0;
  const bashStmt = db.prepare(
    `SELECT e.id, e.ts, e.session_id, e.bash_mutation_kind AS kind,
            e.bash_mutation_targets AS targets
       FROM events e
      WHERE e.bash_mutation_kind IS NOT NULL
        AND e.id > ?`,
  );
  const _bashP1 = acc != null ? performance.now() : 0;
  const bashScanRows = bashStmt.all(fromId) as Array<{
    id: number;
    ts: number;
    session_id: string;
    kind: string;
    targets: string | null;
  }>;
  for (const row of bashScanRows) {
    // Advance the watermark FIRST, before any `continue`, so a malformed or
    // empty-targets row still moves `maxId` past itself.
    if (row.id > newMaxId) newMaxId = row.id;
    if (row.targets == null || row.targets.length === 0) continue;
    let tokens: unknown;
    try {
      tokens = JSON.parse(row.targets);
    } catch {
      // Malformed JSON folds to "no targets" — safe-fold per the reducer's
      // "never throw" invariant.
      continue;
    }
    if (!Array.isArray(tokens)) continue;
    const slim: BashMutationRow = {
      id: row.id,
      ts: row.ts,
      session_id: row.session_id,
      kind: row.kind,
    };
    for (const tok of tokens) {
      if (typeof tok !== "string") continue;
      let bucket = bashByToken.get(tok);
      if (bucket == null) {
        bucket = [];
        bashByToken.set(tok, bucket);
      }
      bucket.push(slim);
    }
  }
  if (acc != null) {
    acc.bashScanPrepMs += _bashP1 - _bashP0;
    acc.bashScanExecMs += performance.now() - _bashP1;
    acc.bashScanRows += bashScanRows.length;
  }

  // git-rm / git-mv deletion scan — same incremental `id > ?` bound; per file the
  // directory-prefix / fnmatch match still runs in JS via bashTargetMatches. This
  // selects a strict SUBSET of the bash scan's rows (git-rm/git-mv both satisfy
  // `bash_mutation_kind IS NOT NULL`), so the bash scan already advanced the
  // watermark past every id here — but advance defensively per-row regardless.
  // No `ORDER BY` — the deletionRows consumer is newest-wins (ts, id), so
  // append-order does not affect the projection (same rationale as the bash scan).
  const _delP0 = acc != null ? performance.now() : 0;
  const deletionStmt = db.prepare(
    `SELECT id, ts, session_id, bash_mutation_kind AS kind,
            bash_mutation_targets AS targets
       FROM events
      WHERE bash_mutation_kind IN ('git-rm', 'git-mv')
        AND id > ?`,
  );
  const _delP1 = acc != null ? performance.now() : 0;
  const deletionScanRows = deletionStmt.all(fromId) as Array<{
    id: number;
    ts: number;
    session_id: string;
    kind: string;
    targets: string | null;
  }>;
  for (const row of deletionScanRows) {
    if (row.id > newMaxId) newMaxId = row.id;
    if (row.session_id == null || row.session_id.length === 0) continue;
    if (row.targets == null || row.targets.length === 0) continue;
    let tokens: unknown;
    try {
      tokens = JSON.parse(row.targets);
    } catch {
      // Malformed JSON folds to "no match" — safe-fold.
      continue;
    }
    if (!Array.isArray(tokens)) continue;
    const strTokens = tokens.filter((t): t is string => typeof t === "string");
    if (strTokens.length === 0) continue;
    deletionRows.push({
      id: row.id,
      ts: row.ts,
      session_id: row.session_id,
      kind: row.kind,
      tokens: strTokens,
    });
  }
  if (acc != null) {
    acc.deletionScanPrepMs += _delP1 - _delP0;
    acc.deletionScanExecMs += performance.now() - _delP1;
    acc.deletionScanRows += deletionScanRows.length;
  }

  // Commit the advanced watermark. Strict-`>` scans next fold resume from here.
  memo.maxId = newMaxId;

  return { toolStmt, bashByToken, deletionRows };
}

function findExplicitAttributions(
  projectDir: string,
  file: ReducerDirtyFile,
  hoist: ExplicitAttribHoist,
  acc?: ExplicitAttribAccumulator,
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
  // promoted `mutation_path` column (fn-836.3) equals a candidate path. Single
  // arm off the column — the old two-arm form (inline `json_extract` ARM A +
  // relocated `event_blobs` ARM B) is gone now that every historical row's
  // file_path is backfilled into the column. The partial index
  // `idx_events_mutation_path WHERE mutation_path IS NOT NULL` makes this a
  // sub-ms covering SEEK, and the fold no longer touches `event_blobs` at all.
  //
  // Discharge-state still doesn't matter: the column holds the file_path
  // regardless of whether the mutation has since been discharged by a Commit,
  // so a from-scratch re-fold (where the discharging Commit replays AFTER the
  // GitSnapshot and a momentarily-live discharged mutation must be seen) reads
  // the same value the old COALESCE'd two-arm scan read off the body.
  for (const candidatePath of paths) {
    // Prepared ONCE per snapshot (in `buildExplicitAttribHoist`) and reused —
    // bun:sqlite does not cache `prepare()`, so per-file recompilation was pure
    // overhead. The `mutation_path = ?` predicate is a covering SEEK on the
    // partial index.
    const _armAP0 = acc != null ? performance.now() : 0;
    const toolRows = hoist.toolStmt.all(candidatePath) as Array<{
      id: number;
      ts: number;
      session_id: string;
      tool_name: string;
    }>;
    if (acc != null) {
      acc.toolArmAExecMs += performance.now() - _armAP0;
      acc.toolArmARows += toolRows.length;
    }
    for (const row of toolRows) {
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
  // array contains the candidate path (exact equality). The per-snapshot
  // `bashByToken` index (built once in `buildExplicitAttribHoist`) reproduces
  // the old per-file `json_each ... = ?` probe via an O(1) JS lookup. The
  // newest-wins `(ts, id)` tie-break below is order-independent, so iterating
  // the bucket in scan order stays re-fold deterministic.
  for (const candidatePath of paths) {
    const bashRows = hoist.bashByToken.get(candidatePath);
    if (bashRows == null) continue;
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
  // `mtime_ms=null` (no pass-2 inference). The candidate rows are pulled +
  // JSON-parsed ONCE per snapshot (`hoist.deletionRows`); the exact /
  // directory-prefix / fnmatch match via `bashTargetMatches` still runs per file
  // in JS — pure (no FS, no wall-clock), so re-fold determinism holds.
  for (const row of hoist.deletionRows) {
    let matched = false;
    for (const rawToken of row.tokens) {
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
 * Read the LIVE-ONLY git-projection skip-floor (`git_projection_state.floor`).
 * The git surface (`git_status` + `file_attributions` + the 3 `jobs` git-counter
 * columns) is a LIVE-PRODUCER-FED projection, NOT replayed from history: a
 * boot-seed re-derives it on boot and live folds keep it current. Every git fold
 * NO-OPS for `event.id <= floor`, so re-folding the 4.3M historical
 * `GitSnapshot`/`Commit` events skips the ~6-day `computeRepoBashWindows`
 * self-join entirely.
 *
 * Inline SQL (matching the reducer's no-prepared-stmts convention). Returns 0
 * when the control row is missing (pre-v79 / mid-migrate) so folds run rather
 * than silently gate — fail-open. PURE event-derived: this reads a control row,
 * never wall-clock / env / FS, so it does NOT break re-fold determinism for the
 * deterministic projections (and the git surface it gates is charter-excluded).
 */
function readGitFloor(db: Database): number {
  const row = db
    .query("SELECT floor FROM git_projection_state WHERE id = 1")
    .get() as { floor: number } | null;
  return row?.floor ?? 0;
}

/**
 * Read whether the boot gate `seed_required` is currently set. Returns false
 * when the control row is absent (pre-v79 / mid-migrate) so the self-clear in
 * `projectGitStatus` no-ops rather than firing a pointless UPDATE against a
 * missing row. PURE — reads a control row only, no wall-clock / env / FS, so it
 * does not break re-fold determinism (and `seed_required` is charter-excluded
 * control state regardless).
 */
function gitSeedRequiredSet(db: Database): boolean {
  const row = db
    .query("SELECT seed_required FROM git_projection_state WHERE id = 1")
    .get() as { seed_required: number } | null;
  return row != null && row.seed_required !== 0;
}

/**
 * Read the LIVE-ONLY tmux-projection skip-floor (`tmux_projection_state.floor`,
 * fn-907). The tmux live-location surface — `jobs.backend_exec_session_id` +
 * `jobs.window_index` — is a LIVE-PRODUCER-FED projection, NOT replayed from
 * history: a boot-seed re-derives it on boot and the `TmuxTopologySnapshot` fold
 * keeps it current. That fold NO-OPS for `event.id <= floor`, so re-folding the
 * historical topology stream skips the live surface entirely (the location
 * columns join the byte-identical re-fold charter's EXCLUSION set).
 *
 * Module-local twin of {@link readGitFloor} — mirrors db.ts's exported
 * `readTmuxProjectionFloor` but kept inline so the fold stays a pure reducer
 * read (matching the reducer's no-prepared-stmts convention). Returns 0 when the
 * control row is missing (pre-v83 / mid-migrate) so folds run rather than
 * silently gate — fail-open. PURE event-derived: reads a control row, never
 * wall-clock / env / FS, so it does not break re-fold determinism for the
 * deterministic projections (and the tmux surface it gates is charter-excluded).
 */
function readTmuxFloor(db: Database): number {
  const row = db
    .query("SELECT floor FROM tmux_projection_state WHERE id = 1")
    .get() as { floor: number } | null;
  return row?.floor ?? 0;
}

/**
 * Threshold above which a GitSnapshot fold emits a per-pass `[gitfold-breakdown]`
 * line — high enough that normal folds stay silent; only the multi-second
 * outliers that hold the write lock and starve hook INSERTs matter.
 */
const GIT_FOLD_BREAKDOWN_MS = 1000;

/**
 * Hard cap on how many per-file entries the `git_status.dirty_files` MATERIALIZED
 * array carries. `dirty_count` stays EXACT (the full `snapshot.dirty_files.length`);
 * only the rendered `dirty_files[].attributions[]` mirror is bounded.
 *
 * The `git` collection rides the board's subscribe first-frame, and the subscribe
 * serve path emits each `result` as ONE NDJSON line the client rejects past
 * `MAX_LINE_LENGTH` (1 MiB, `src/protocol.ts`) — a rejected line reconnect-loops
 * the viewer and NO first frame ever lands. A single worktree with thousands of
 * dirty files renders a `dirty_files` array well over 1 MiB on its own (a rendered
 * entry is ~200-250 B), so the whole-board frame crosses the cap and starves the
 * snapshot. Capping each worktree's array at this bound keeps its serialized
 * contribution ≈ 50 KB, so even a board of dozens of simultaneously-dirty
 * worktrees stays under the line cap.
 *
 * Bounding at the FOLD (not the serve path) keeps the wire frame and the
 * reconciler's direct `git_status` read byte-identical — both fold-consumers see
 * the same bounded array. The array is a render/consistency mirror only: the
 * board renders the `dirty_count` scalar, and readiness's per-file consumer
 * (`projectGitStatusByProjectDir`) is retained-but-unread, so the cap changes no
 * dispatch decision. The per-job rollups (`jobs.git_*`) fold from the FULL
 * `snapshot.dirty_files` in pass 4, never this bounded array, so they stay exact.
 */
export const GIT_STATUS_DIRTY_FILES_WIRE_CAP = 200;

function projectGitStatus(db: Database, event: Event): void {
  // LIVE-ONLY skip-floor: `git_status` + `file_attributions` are producer-fed,
  // not replayed. A historical GitSnapshot (`id <= floor`) no-ops — the boot-seed
  // re-derives the surface above the floor. The cursor still advances at the
  // dispatch site, so the other ~16 deterministic projections fold normally.
  // This is the fold whose `computeRepoBashWindows` self-join is the replay
  // time-bomb, so gating it is the whole point of the live-only design.
  if (event.id <= readGitFloor(db)) {
    return;
  }
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
  // Per-arm pass1 accumulator — only allocated/threaded so the eventual
  // breakdown line (emitted below only above threshold) can attribute pass1 to
  // a specific scan + its prepare-vs-execute split. Pure instrumentation.
  const _pass1Acc = newExplicitAttribAccumulator();
  // Hoist the two snapshot-invariant scans (bash exact-match + git-rm/git-mv
  // deletion) and the two tool prepared statements ONCE before the per-file
  // loop, mirroring `computeRepoBashWindows`. The matched-row set per file is
  // identical to the old per-file scans, so re-fold determinism is untouched.
  const _explicitHoist = buildExplicitAttribHoist(db, _pass1Acc);
  for (const file of snapshot.dirty_files) {
    const explicit = findExplicitAttributions(
      projectDir,
      file,
      _explicitHoist,
      _pass1Acc,
    );
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
        AND source IN ('tool', 'bash', 'plan')
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
        r.source === "plan"
          ? r.source
          : "inferred",
    }));
    // Cap only the MATERIALIZED array (the wire/render mirror) — `fileToAttributions`
    // stays complete so pass 4's per-job rollups fold from every file. See
    // {@link GIT_STATUS_DIRTY_FILES_WIRE_CAP}.
    if (renderedFiles.length < GIT_STATUS_DIRTY_FILES_WIRE_CAP) {
      renderedFiles.push({ ...file, attributions });
    }
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
  // materialized view the client reads; `dirty_count` / `orphaned_count` /
  // `unattributed_to_live_count` carry the EXACT project-wide scalars (the
  // latter is pass 4's `unattributedToLiveCount`, folded from the FULL
  // `snapshot.dirty_files` — never the wire-capped `renderedFiles` mirror, so
  // `cli/git.ts` can render it directly instead of re-deriving from the capped
  // array); `jobs` enumerates the canonical attribution set the retract walks.
  // `orphaned_files` ships empty — the strict-mystery orphan set is just
  // `dirty_files where attributions.length == 0`, so a per-file list would
  // duplicate the `orphaned_count` scalar.
  db.run(
    `INSERT INTO git_status (
       project_dir, branch, head_oid, upstream, ahead, behind,
       dirty_count, orphaned_count, unattributed_to_live_count,
       dirty_files, orphaned_files, jobs,
       last_event_id, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_dir) DO UPDATE SET
       branch = excluded.branch,
       head_oid = excluded.head_oid,
       upstream = excluded.upstream,
       ahead = excluded.ahead,
       behind = excluded.behind,
       dirty_count = excluded.dirty_count,
       orphaned_count = excluded.orphaned_count,
       unattributed_to_live_count = excluded.unattributed_to_live_count,
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
      unattributedToLiveCount,
      JSON.stringify(renderedFiles),
      JSON.stringify([]),
      JSON.stringify(projectionJobs),
      eventId,
      eventTs,
    ],
  );

  // PRODUCER-ONLY SELF-HEAL: clear `seed_required` once every GATED root has an
  // above-floor `git_status` row. This snapshot just wrote one (it is above the
  // floor — the early return gated `id <= floor`), so a gated root the boot-seed
  // missed/failed clears the flag THE MOMENT its live emit lands here. The clear
  // is MAIN's fold, never a git-worker write — the git-worker only emits
  // GitSnapshots; main folds them and owns `git_projection_state`, preserving the
  // single-writer (producer-only) recovery path with no retry loop / no TOCTOU.
  //
  // Determinism: gated only by above-floor folds (re-fold replays pre-floor git
  // folds, which return early), reads only `epics`+`git_status` projections (no
  // wall-clock/fs/env), and `seed_required` is charter-excluded control state —
  // so re-fold stays byte-identical for the deterministic projections.
  if (gitSeedRequiredSet(db) && allGatedRootsSeeded(db, readGitFloor(db))) {
    db.run(
      `UPDATE git_projection_state
          SET seed_required = 0, updated_at = ?
        WHERE id = 1`,
      [eventTs],
    );
  }

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
        `write=${(performance.now() - _gfT5).toFixed(0)}ms ` +
        // pass1 tool scan. The single `mutation_path` SEEK is prepared once (the
        // hoist) and seeks per file, so only its summed `.all()` exec + matched
        // rows show (fn-836.3 collapsed the old inline+relocated arms into one).
        // Bash + deletion are once-per-snapshot scans (prep=compile, exec=.all),
        // matched per file via an O(1) lookup that no longer touches SQLite.
        `p1_tool_exec=${_pass1Acc.toolArmAExecMs.toFixed(0)}ms ` +
        `p1_tool_rows=${_pass1Acc.toolArmARows} ` +
        `p1_bash_prep=${_pass1Acc.bashScanPrepMs.toFixed(0)}ms ` +
        `p1_bash_exec=${_pass1Acc.bashScanExecMs.toFixed(0)}ms ` +
        `p1_bash_rows=${_pass1Acc.bashScanRows} ` +
        `p1_del_prep=${_pass1Acc.deletionScanPrepMs.toFixed(0)}ms ` +
        `p1_del_exec=${_pass1Acc.deletionScanExecMs.toFixed(0)}ms ` +
        `p1_del_rows=${_pass1Acc.deletionScanRows}`,
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
  // LIVE-ONLY skip-floor: a historical GitRootDropped (`id <= floor`) no-ops —
  // the boot-seed re-derives the current surface, and replaying old tombstones
  // against a freshly-seeded surface would wrongly DELETE a still-dirty root.
  if (event.id <= readGitFloor(db)) {
    return;
  }
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
/**
 * Threshold above which a Commit fold emits a `[commitfold-breakdown]` line
 * splitting the per-file discharge loop vs {@link foldCommitTaskLinks} vs the
 * {@link syncPlanLinks} fan-out (the commit-trailer edge rebuild — the
 * O(children) JSON RMW). Commit averages 2.5s on the live DB; the split
 * convicts which sub-step holds the write lock. Gated so steady folds stay
 * silent. Pure instrumentation — never read into a projection write.
 */
const COMMIT_FOLD_BREAKDOWN_MS = 1000;

function foldCommit(db: Database, event: Event): void {
  const commit = extractCommit(event);
  if (commit == null) {
    return;
  }
  // Record the durable commit-trailer fact (the fn-807 projection) BEFORE the
  // empty-files early-return: the commit-trailer loader / migration backfill key
  // off the trailer facts ALONE (never the file list), so a plan Commit that
  // happened to carry zero files must still land its fact row for the two views
  // to agree. The condition — committer_session_id + plan_op + plan_target
  // all non-null — is exactly the loader/backfill keep condition (DELIBERATELY
  // wider than the syncPlanLinks trigger gate below, which additionally
  // requires `parsePlanRef(target).kind != null`). `INSERT OR IGNORE` keys on the
  // `event_id` PK so a re-fold over the same `Commit` event is idempotent.
  if (
    commit.committer_session_id != null &&
    commit.plan_op != null &&
    commit.plan_target != null
  ) {
    db.run(
      `INSERT OR IGNORE INTO commit_trailer_facts (
         event_id, committer_session_id, plan_op, plan_target,
         plan_epic_id, committed_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        event.id,
        commit.committer_session_id,
        commit.plan_op,
        commit.plan_target,
        parsePlanRef(commit.plan_target)?.epic_id ?? null,
        commit.committed_at_ms,
      ],
    );
  }
  if (commit.files.length === 0) {
    // A commit with no files (empty commit via `--allow-empty`, or a
    // commit whose file-list shell-out returned empty) has nothing to
    // discharge. Safe no-op.
    return;
  }
  // LIVE-ONLY skip-floor — SCOPED to the `file_attributions` discharge ONLY.
  // A historical Commit (`id <= floor`) must NOT touch the producer-fed
  // `file_attributions` surface (the boot-seed re-derives it). But the
  // `commit_trailer_facts` INSERT above, plus `foldCommitTaskLinks` +
  // `syncPlanLinks` below, stay UNCONDITIONAL — those are DETERMINISTIC
  // projections that must replay byte-identically over the full log. So the gate
  // is a per-block boolean, not an early-return out of `foldCommit`.
  const skipDischarge = event.id <= readGitFloor(db);
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
    // Per-arm timing — emitted (below) ONLY when the whole fold is slow. Never
    // persisted, so no bearing on re-fold determinism.
    const _cfT0 = performance.now();
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
    // (mutation > commit) discharge inequality. The whole discharge loop is also
    // skipped below the live-only floor (`skipDischarge`) — `file_attributions`
    // is producer-fed, so a historical Commit must not discharge against it.
    if (!skipDischarge) {
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
    }
    const _cfT1 = performance.now();
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
    // session's edge rebuild — `syncPlanLinks` re-derives `jobs.epic_links` +
    // the epic's `epics.job_links` from the union of the stdout scrape and this
    // commit-trailer fact. We TRIGGER (never write the edge cells directly) so
    // `syncPlanLinks` stays the sole writer. A non-plan commit has NULL
    // `plan_op` and no-ops, preserving re-fold determinism over the log.
    const _cfT2 = performance.now();
    // Arm the syncPlanLinks fan-out accumulator so the breakdown line can
    // carry the plan cardinality (touched epics / swept sessions / trailer
    // facts). Pure instrumentation; the value is read only by console.error.
    _syncPlanLinksAccum = {
      calls: 0,
      touchedEpics: 0,
      sweptSessions: 0,
      factsRows: 0,
      factsLoadMs: 0,
      deriveJobLinksMs: 0,
    };
    if (
      commit.plan_op != null &&
      commit.plan_target != null &&
      parsePlanRef(commit.plan_target)?.kind != null
    ) {
      syncPlanLinks(db, commit.committer_session_id, eventId, eventTs);
    }
    const _cfPlanAccum = _syncPlanLinksAccum;
    _syncPlanLinksAccum = null;
    // Slow-fold breakdown — localizes a [fold-slow] Commit (per-session arm) to
    // a sub-step. nfiles/ntasks give the fan-out cardinality; the plan_*
    // counters split the trailer-fact load + sweep shape out of plan_fanout.
    // Only emitted above threshold so steady folds stay silent. Pure side-effect.
    const _cfTotal = performance.now() - _cfT0;
    if (_cfTotal >= COMMIT_FOLD_BREAKDOWN_MS) {
      console.error(
        `[commitfold-breakdown] id=${eventId} arm=session total=${_cfTotal.toFixed(0)}ms ` +
          `nfiles=${commit.files.length} ntasks=${commit.task_ids.length} ` +
          `discharge_loop=${(_cfT1 - _cfT0).toFixed(0)}ms ` +
          `task_links=${(_cfT2 - _cfT1).toFixed(0)}ms ` +
          `plan_fanout=${(performance.now() - _cfT2).toFixed(0)}ms ` +
          formatSyncPlanFanout(_cfPlanAccum),
      );
    }
    return;
  }
  // Global discharge: no trailer (or malformed) → no honest way to pin the
  // discharge to a session, so clear EVERY session's attribution row for the
  // named files. This arm is ENTIRELY a `file_attributions` discharge (the
  // unconditional `commit_trailer_facts` INSERT + task-links + syncPlanLinks all
  // live in the per-session arm, which already returned), so the live-only floor
  // skips the whole arm — a historical Commit (`id <= floor`) leaves the
  // producer-fed surface to the boot-seed.
  if (skipDischarge) {
    return;
  }
  const _cfgT0 = performance.now();
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
  // Global arm has only the discharge loop (no task-links / fanout). Same gate.
  const _cfgTotal = performance.now() - _cfgT0;
  if (_cfgTotal >= COMMIT_FOLD_BREAKDOWN_MS) {
    console.error(
      `[commitfold-breakdown] id=${eventId} arm=global total=${_cfgTotal.toFixed(0)}ms ` +
        `nfiles=${commit.files.length} ntasks=${commit.task_ids.length} ` +
        `discharge_loop=${_cfgTotal.toFixed(0)}ms ` +
        `task_links=0ms plan_fanout=0ms`,
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
 * Decode one synthetic `SessionTelemetry` event's `data` blob (fn-1024) into the
 * six null-fallback telemetry fields: guarded `JSON.parse`, every field a
 * type-checked null-fallback, NEVER throws.
 * A malformed / empty blob folds to `null` (the arm no-ops); an
 * unknown-typed field folds to `null` individually so the COALESCE merge in the
 * `SessionTelemetry` jobs arm preserves whatever a prior snapshot wrote. The
 * `used_percentage` is taken verbatim (never recomputed) — folding a derived %
 * would break re-fold byte-identity.
 */
export function extractSessionTelemetry(
  event: Event,
): SessionTelemetryPayload | null {
  if (event.data == null || event.data.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(event.data) as Partial<SessionTelemetryPayload>;
    return {
      model_id: typeof parsed.model_id === "string" ? parsed.model_id : null,
      model_display:
        typeof parsed.model_display === "string" ? parsed.model_display : null,
      effort: typeof parsed.effort === "string" ? parsed.effort : null,
      used_percentage:
        typeof parsed.used_percentage === "number" &&
        Number.isFinite(parsed.used_percentage)
          ? parsed.used_percentage
          : null,
      input_tokens:
        typeof parsed.input_tokens === "number" &&
        Number.isInteger(parsed.input_tokens)
          ? parsed.input_tokens
          : null,
      window_size:
        typeof parsed.window_size === "number" &&
        Number.isInteger(parsed.window_size)
          ? parsed.window_size
          : null,
    };
  } catch (err) {
    console.error(
      `keeper reducer: failed to parse session telemetry blob for event id=${event.id} id=${event.session_id}: ${err}`,
    );
    return null;
  }
}

// fn-907 retired two folds the new `TmuxTopologySnapshot` live-location fold
// (below) subsumes: the fn-789 fill-only `TmuxPaneSnapshot` session resolver and
// the fn-817 standalone `WindowIndexSnapshot` fold. The topology fold is the SOLE
// owner of `backend_exec_session_id` + `window_index`, so both old fold bodies
// (and their decoders) are gone. Their `applyEvent` arms REMAIN as explicit
// no-ops (NOT deleted) so historical `TmuxPaneSnapshot` / `WindowIndexSnapshot`
// events keep advancing the cursor without routing into the final-`else`
// `projectJobsRow` — that no-op is what holds re-fold determinism, not the fold
// bodies. The producer (task 2) no longer posts either kind.

/**
 * One pane of a `TmuxTopologySnapshot` payload, post-decode: the durable `%N`
 * `pane_id`, its current `#{session_name}`, and its `#{window_index}` (the
 * window's left-to-right POSITION, or `null` when the producer could not read a
 * valid integer). Keyed by `pane_id` within the snapshot's single server
 * generation — `%N` is reused after a kill, so the generation handle rides
 * alongside the panes (see {@link TmuxTopologySnapshot}), not inside each pane.
 */
export interface TmuxTopologyPaneEntry {
  pane_id: string;
  session_name: string;
  window_index: number | null;
  // OPTIONAL keeper job that owned the pane at post time (producer-stamped via
  // the `pane_id → jobs.backend_exec_pane_id` join). Decoded for the
  // topology-anchored crash-restore deriver, which reads job identity from the
  // event payload; the FOLD ignores it (re-fold determinism). Absent when no
  // keeper job owned the pane, or when the field is missing / non-string.
  job_id?: string;
}

/**
 * The decoded `TmuxTopologySnapshot` payload: the server `generation_id` (the
 * recycle-guard handle) and the whole-server pane map. `generation_id` is a
 * validated non-empty string; an absent / non-string generation drops the WHOLE
 * snapshot (a paneless generation bump still has a generation, but without one
 * the recycle guard cannot run, so the fold must not touch live location).
 */
export interface TmuxTopologySnapshot {
  generation_id: string;
  panes: TmuxTopologyPaneEntry[];
}

/**
 * Null-safe decode of a `TmuxTopologySnapshot` event's `data` blob into the
 * validated `{generation_id, panes}` snapshot (epic fn-907). Returns `null` on a
 * missing / empty / malformed blob OR an absent / non-string / empty
 * `generation_id` (the fold folds a null snapshot to a no-op); NEVER throws.
 *
 * Each pane entry is type-narrowed INDEPENDENTLY so a partial / garbage entry is
 * dropped rather than poisoning the snapshot: `pane_id` + `session_name` MUST be
 * non-empty strings (identity + the live session to write), and `window_index`
 * is a finite integer OR explicitly `null` (a NULL / non-integer / NaN index is
 * normalized to `null`, NEVER coerced — the fold preserves the last-known index
 * on a null). Reads ONLY `event.data` — no probe, no env — keeping the fold a
 * pure function of the event payload (re-fold determinism).
 *
 * Mirrors the never-throw, per-entry type-narrow skeleton of
 * {@link extractWindowIndexSnapshot}; the one structural difference is the
 * generation_id sidecar (validated once, snapshot-wide) the recycle guard needs.
 */
export function extractTmuxTopologySnapshot(
  event: Event,
): TmuxTopologySnapshot | null {
  if (event.data == null || event.data.length === 0) {
    return null;
  }
  let parsed: { generation_id?: unknown; panes?: unknown };
  try {
    parsed = JSON.parse(event.data) as {
      generation_id?: unknown;
      panes?: unknown;
    };
  } catch {
    return null;
  }
  const generationId = parsed.generation_id;
  if (typeof generationId !== "string" || generationId === "") {
    return null;
  }
  const panes: TmuxTopologyPaneEntry[] = [];
  if (Array.isArray(parsed.panes)) {
    for (const raw of parsed.panes) {
      if (raw == null || typeof raw !== "object") {
        continue;
      }
      const rec = raw as Record<string, unknown>;
      const paneId = rec.pane_id;
      const sessionName = rec.session_name;
      if (
        typeof paneId !== "string" ||
        paneId === "" ||
        typeof sessionName !== "string" ||
        sessionName === ""
      ) {
        continue;
      }
      const rawIndex = rec.window_index;
      const windowIndex =
        typeof rawIndex === "number" && Number.isInteger(rawIndex)
          ? rawIndex
          : null;
      // OPTIONAL: a non-empty string decodes; anything else (absent / non-string
      // / empty) leaves `job_id` undefined. The deriver tolerates the absence;
      // the fold never reads it.
      const rawJobId = rec.job_id;
      const jobId =
        typeof rawJobId === "string" && rawJobId !== "" ? rawJobId : undefined;
      panes.push({
        pane_id: paneId,
        session_name: sessionName,
        window_index: windowIndex,
        ...(jobId !== undefined ? { job_id: jobId } : {}),
      });
    }
  }
  return { generation_id: generationId, panes };
}

function tmuxGenerationPidPart(generationId: string): string | null {
  const colon = generationId.indexOf(":");
  if (colon <= 0) {
    return null;
  }
  const pid = generationId.slice(0, colon);
  return /^\d+$/.test(pid) ? pid : null;
}

/**
 * Fold one synthetic `TmuxTopologySnapshot` event (epic fn-907) — the SOLE owner
 * of a tmux job's LIVE location (`backend_exec_session_id` + `window_index`). The
 * restore-worker timer-poll producer hash-deduped a whole-server `tmux
 * list-panes -a` probe and main minted this event carrying the server
 * `generation_id` + the per-pane `(session_name, window_index)` map. For each
 * pane, OVERWRITE the matching LIVE tmux job's session + window index — keyed on
 * `(generation_id, pane_id)` so a recycled `%N` from a NEW server generation
 * never re-targets a prior generation's job.
 *
 * Match: `backend_exec_type = 'tmux'` AND `backend_exec_pane_id = pane_id` AND a
 * live state (NOT ended/killed) AND the generation either EQUALS the snapshot's
 * or is still NULL. A NULL-generation match ADOPTS the snapshot generation
 * (first-match stamping) — the launch env never carried it. The live-state
 * filter is load-bearing: a killed job must NOT adopt a new generation (the
 * recycle-guard risk note), so a recycled pane in a fresh server can't resurrect
 * a dead row's location.
 *
 * OVERWRITE semantics (NOT fill-only, unlike {@link foldTmuxPaneSnapshot}): a
 * pane MOVE re-points an already-resolved session, so a later snapshot must
 * replace the earlier value. But location is only ever written with a PRESENT
 * value — a pane absent from the snapshot leaves its job untouched (no UPDATE),
 * and a NULL `window_index` in the payload COALESCEs to the prior index (never
 * wipes a good value). The session is always present per validated pane, so it
 * overwrites unconditionally for a matched live job.
 *
 * Gated above `tmux_projection_state.floor`: a historical TmuxTopologySnapshot
 * (`id <= floor`) no-ops — the boot-seed re-derives the live surface, so the two
 * location columns are LIVE-ONLY (excluded from the byte-identical re-fold
 * charter). Pure: reads ONLY the event payload + in-transaction `jobs` rows — no
 * probe, no env, no wall-clock. An empty / malformed payload folds to a no-op
 * (null snapshot) with the cursor still advancing (NEVER throws). An UPDATE
 * matching zero rows (no live tmux job for the pane, or a generation mismatch) is
 * a correct no-op.
 */
function foldTmuxTopologySnapshot(db: Database, event: Event): void {
  // LIVE-ONLY skip-floor: the two location columns are producer-fed, not
  // replayed. A historical snapshot (`id <= floor`) no-ops — the boot-seed
  // re-derives the surface above the floor. The cursor still advances at the
  // dispatch site, so the deterministic projections fold normally.
  if (event.id <= readTmuxFloor(db)) {
    return;
  }
  const snapshot = extractTmuxTopologySnapshot(event);
  if (snapshot === null || snapshot.panes.length === 0) {
    return;
  }
  const pidGenerationId = tmuxGenerationPidPart(snapshot.generation_id);
  for (const pane of snapshot.panes) {
    // OVERWRITE session (always present per validated pane); COALESCE the
    // window_index so a NULL-in-payload preserves the last-known good index
    // (crash-restore sorting depends on it). ADOPT the snapshot generation on a
    // first match (`backend_exec_generation_id IS NULL`) or a pid-only generation
    // that names this same server; otherwise the generation must EQUAL the
    // snapshot's recycle guard. Live-state filter blocks a killed job from
    // adopting a recycled pane's new generation.
    db.run(
      `UPDATE jobs SET
         backend_exec_session_id = ?,
         backend_exec_generation_id = ?,
         window_index = COALESCE(?, window_index),
         last_event_id = ?,
         updated_at = ?
       WHERE backend_exec_type = 'tmux'
         AND backend_exec_pane_id = ?
         AND state NOT IN ('${ENDED}','${KILLED}')
         AND (backend_exec_generation_id = ?
              OR backend_exec_generation_id IS NULL
              OR backend_exec_generation_id = ?)`,
      [
        pane.session_name,
        snapshot.generation_id,
        pane.window_index,
        event.id,
        event.ts,
        pane.pane_id,
        snapshot.generation_id,
        pidGenerationId,
      ],
    );
  }
}

/**
 * The decoded `TmuxClientFocusSnapshot` payload (epic fn-952): the current real
 * (non-control) tmux client's focused location, as observed by keeperd's
 * persistent `tmux -C` control worker. `status` is the worker's connection
 * liveness ('connected' / 'disconnected' / 'none'); `generation_id` is the tmux
 * server generation the focus was read under (discarded + re-read on every
 * reconnect); `session_name` / `pane_id` identify the focused pane and `window_index` is its
 * window's left-to-right position. Every field is nullable — an idle / no-focus /
 * disconnected snapshot carries a `status` with the location fields NULL, which
 * the fold writes verbatim (the singleton is last-write-wins, never fill-only).
 */
interface TmuxClientFocusSnapshot {
  status: string | null;
  generation_id: string | null;
  session_name: string | null;
  window_index: number | null;
  pane_id: string | null;
}

/**
 * Null-safe decode of a `TmuxClientFocusSnapshot` event's `data` blob into the
 * validated `{status, generation_id, session_name, window_index, pane_id}`
 * payload. Returns `null` on a missing / empty / malformed blob (the fold folds a
 * null payload to a no-op); NEVER throws.
 *
 * Each field is type-narrowed INDEPENDENTLY so a partial / garbage field is
 * normalized to NULL rather than poisoning the whole payload: the string fields
 * (`status` / `generation_id` / `session_name` / `pane_id`) keep a non-empty
 * string and normalize everything else (including `""`) to `null`;
 * `window_index` keeps a finite integer and normalizes a NULL / non-integer /
 * NaN to `null`. Reads ONLY `event.data` — no probe, no env, no wall-clock —
 * keeping the fold a pure function of the event payload.
 *
 * Mirrors the never-throw, per-field type-narrow skeleton of
 * {@link extractTmuxTopologySnapshot}, but simpler: a flat single-row payload
 * with no per-pane array and no generation gate (the fold is a pure
 * last-write-wins UPSERT, no recycle guard).
 */
function extractTmuxClientFocusSnapshot(
  event: Event,
): TmuxClientFocusSnapshot | null {
  if (event.data == null || event.data.length === 0) {
    return null;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(event.data) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== "object") {
    return null;
  }
  const narrowString = (v: unknown): string | null =>
    typeof v === "string" && v !== "" ? v : null;
  const rawIndex = parsed.window_index;
  return {
    status: narrowString(parsed.status),
    generation_id: narrowString(parsed.generation_id),
    session_name: narrowString(parsed.session_name),
    window_index:
      typeof rawIndex === "number" && Number.isInteger(rawIndex)
        ? rawIndex
        : null,
    pane_id: narrowString(parsed.pane_id),
  };
}

/**
 * Fold one synthetic `TmuxClientFocusSnapshot` event (epic fn-952) into the
 * LIVE-ONLY `tmux_client_focus` singleton — a last-write-wins UPSERT on `id = 1`.
 * The persistent `tmux -C` control worker (task .3) observes the current real
 * client's focus and posts this event; the fold simply overwrites the singleton
 * with the latest payload + `event.ts` freshness stamp.
 *
 * NO floor gate, NO seed: focus has no replay-worthy history (the worker
 * re-bootstraps on every connect), so this fold runs unconditionally and a
 * pre-feature / empty log leaves the table empty (the `keeper jobs` banner then
 * renders `[focus: none]`). Pure: reads ONLY the event payload + `event.id` /
 * `event.ts` — no probe, no env, no wall-clock (re-fold safe; the singleton is
 * live-only and excluded from the byte-identical charter regardless). A malformed
 * / empty payload folds to a no-op (null payload) with the cursor still advancing
 * at the dispatch site — NEVER throws.
 */
function foldTmuxClientFocusSnapshot(db: Database, event: Event): void {
  const snapshot = extractTmuxClientFocusSnapshot(event);
  if (snapshot === null) {
    return;
  }
  db.run(
    `INSERT INTO tmux_client_focus (
       id, status, generation_id, session_name, window_index, pane_id,
       last_event_id, updated_at
     ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       generation_id = excluded.generation_id,
       session_name = excluded.session_name,
       window_index = excluded.window_index,
       pane_id = excluded.pane_id,
       last_event_id = excluded.last_event_id,
       updated_at = excluded.updated_at`,
    [
      snapshot.status,
      snapshot.generation_id,
      snapshot.session_name,
      snapshot.window_index,
      snapshot.pane_id,
      event.id,
      event.ts,
    ],
  );
}

/**
 * Null-safe decode of a `WorktreeRepoStatus` event's `data` blob into the
 * validated entry array. Returns `[]` on a missing / empty / malformed blob OR a
 * non-array `entries` (the fold then clears the table — the disabled set is
 * empty); NEVER throws. Each entry is type-narrowed independently: a non-string
 * field normalizes to `""`, and an entry with no `epic_id` is dropped (the PK
 * must be present). Reads ONLY `event.data` — no probe, no env, no wall-clock —
 * keeping the fold a pure function of the event payload.
 */
function extractWorktreeRepoStatus(event: Event): WorktreeRepoStatusEntry[] {
  if (event.data == null || event.data.length === 0) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.data);
  } catch {
    return [];
  }
  if (parsed == null || typeof parsed !== "object") {
    return [];
  }
  const rawEntries = (parsed as Record<string, unknown>).entries;
  if (!Array.isArray(rawEntries)) {
    return [];
  }
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const out: WorktreeRepoStatusEntry[] = [];
  for (const raw of rawEntries) {
    if (raw == null || typeof raw !== "object") {
      continue;
    }
    const r = raw as Record<string, unknown>;
    const epic_id = str(r.epic_id);
    if (epic_id === "") {
      continue;
    }
    out.push({
      epic_id,
      repo_dir: str(r.repo_dir),
      mode: str(r.mode) || "serial",
      reason: str(r.reason),
    });
  }
  return out;
}

/**
 * Fold one synthetic `WorktreeRepoStatus` event (fn-1013) into the LIVE-ONLY
 * `worktree_repo_status` projection — a full-set REPLACE: wipe the table, then
 * INSERT one row per disabled epic carried in the event. The autopilot worker
 * posts the FULL current disabled set whenever it changes, so the table always
 * reflects the latest emitted set; an empty set (e.g. worktree mode flipped OFF,
 * or no disabled epics) clears it.
 *
 * Cheap full replace bounded by board size (NOT O(history)), so no floor/seed of
 * its own — the wipe + re-INSERT runs unconditionally and a re-fold's last
 * `WorktreeRepoStatus` event wins; the table is LIVE-ONLY (in
 * `LIVE_ONLY_PROJECTIONS`) so it is excluded from the byte-identical re-fold
 * charter regardless. `ON CONFLICT DO UPDATE` keeps the fold total even if the
 * producer ever posts a duplicate epic_id. Pure: reads ONLY the event payload +
 * `event.id` / `event.ts` — NEVER throws (a malformed payload clears the table).
 */
function foldWorktreeRepoStatus(db: Database, event: Event): void {
  const entries = extractWorktreeRepoStatus(event);
  db.run("DELETE FROM worktree_repo_status");
  for (const e of entries) {
    db.run(
      `INSERT INTO worktree_repo_status (
         epic_id, repo_dir, mode, reason, last_event_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(epic_id) DO UPDATE SET
         repo_dir = excluded.repo_dir,
         mode = excluded.mode,
         reason = excluded.reason,
         last_event_id = excluded.last_event_id,
         updated_at = excluded.updated_at`,
      [e.epic_id, e.repo_dir, e.mode, e.reason, event.id, event.ts],
    );
  }
}

/**
 * Null-safe decode of a `LaneMerged` event's `data` blob into the validated entry
 * array. Returns `[]` on a missing / empty / malformed blob OR a non-array
 * `entries` (the fold then clears the table — the merged set is empty); NEVER
 * throws. Each entry is type-narrowed independently: a non-string field
 * normalizes to `""`, and an entry with no `epic_id` is dropped (the PK must be
 * present). Reads ONLY `event.data` — no probe, no env, no wall-clock — keeping
 * the fold a pure function of the event payload. Mirrors
 * {@link extractWorktreeRepoStatus}.
 */
function extractLaneMerged(event: Event): LaneMergedEntry[] {
  if (event.data == null || event.data.length === 0) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.data);
  } catch {
    return [];
  }
  if (parsed == null || typeof parsed !== "object") {
    return [];
  }
  const rawEntries = (parsed as Record<string, unknown>).entries;
  if (!Array.isArray(rawEntries)) {
    return [];
  }
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const out: LaneMergedEntry[] = [];
  for (const raw of rawEntries) {
    if (raw == null || typeof raw !== "object") {
      continue;
    }
    const r = raw as Record<string, unknown>;
    const epic_id = str(r.epic_id);
    if (epic_id === "") {
      continue;
    }
    out.push({ epic_id, repo_dir: str(r.repo_dir) });
  }
  return out;
}

/**
 * Fold one synthetic `LaneMerged` event into the LIVE-ONLY
 * `lane_merged` projection — a full-set REPLACE: wipe the table, then INSERT one
 * row per merged-lane epic carried in the event. The autopilot worker posts the
 * FULL current merged set whenever it changes, so the table always reflects the
 * latest emitted set; an empty set (worktree mode OFF, or no merged lanes) clears
 * it.
 *
 * Cheap full replace bounded by board size (NOT O(history)), so no floor/seed of
 * its own — the wipe + re-INSERT runs unconditionally and a re-fold's last
 * `LaneMerged` event wins; the table is LIVE-ONLY (in `LIVE_ONLY_PROJECTIONS`) so
 * it is excluded from the byte-identical re-fold charter regardless (the merged
 * verdict is git-derived — a per-cycle ancestry probe — so it must NOT be
 * deterministic-replayed). `ON CONFLICT DO UPDATE` keeps the fold total even if
 * the producer ever posts a duplicate epic_id. Pure: reads ONLY the event payload
 * + `event.id` / `event.ts` — NEVER throws (a malformed payload clears the
 * table). Mirrors {@link foldWorktreeRepoStatus}.
 */
function foldLaneMerged(db: Database, event: Event): void {
  const entries = extractLaneMerged(event);
  db.run("DELETE FROM lane_merged");
  for (const e of entries) {
    db.run(
      `INSERT INTO lane_merged (
         epic_id, repo_dir, last_event_id, updated_at
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT(epic_id) DO UPDATE SET
         repo_dir = excluded.repo_dir,
         last_event_id = excluded.last_event_id,
         updated_at = excluded.updated_at`,
      [e.epic_id, e.repo_dir, event.id, event.ts],
    );
  }
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
 * single-row UPSERT keyed on the builder NAME (`event.session_id`): no
 * read-modify-write, no embedded arrays, no fan-out. Payload rides in
 * `event.data` (decoded by
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
  conflictedFiles: string[] | null;
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
    const conflictedFiles = Array.isArray(parsed.conflictedFiles)
      ? parsed.conflictedFiles.filter(
          (path): path is string => typeof path === "string",
        )
      : null;
    return {
      verb: parsed.verb,
      id: parsed.id,
      reason: parsed.reason,
      dir,
      conflictedFiles,
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
       verb, id, reason, dir, conflicted_files, ts, last_event_id, created_at,
       updated_at, merge_escalated_at, resolver_dispatched_at,
       human_notified_at, instance_event_id, repair_dispatched_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL)
     ON CONFLICT(verb, id) DO UPDATE SET
       reason = excluded.reason,
       dir = excluded.dir,
       conflicted_files = excluded.conflicted_files,
       ts = excluded.ts,
       last_event_id = excluded.last_event_id,
       -- created_at preserved through UPSERT: the row's "sticky since"
       -- view is the FIRST observation of this failure, never the latest.
       -- merge_escalated_at + resolver_dispatched_at + human_notified_at +
       -- repair_dispatched_at preserved through UPSERT (excluded from the SET
       -- clause, same as created_at): a re-failure of an uncleared row must NOT
       -- reset any once-marker, or the daemon merge-escalation sweep would
       -- re-dispatch the deconflict session, the repair sweep would re-dispatch
       -- the repair session, and the human-notify sweeps would re-notify. All four
       -- markers re-arm only on a DispatchCleared (retry_dispatch) DELETE
       -- dropping the row entirely.
       -- instance_event_id preserved through UPSERT for the SAME reason: it is
       -- the FIRST-appearance event id of this open incident (the fencing token
       -- the deconflict/resolve corroboration reads to pin the instance), so a
       -- re-emit of the still-open row must NOT re-mint it — only a clear + fresh
       -- INSERT opens a new instance.
       updated_at = excluded.updated_at`,
    [
      payload.verb,
      payload.id,
      payload.reason,
      payload.dir,
      payload.conflictedFiles === null
        ? null
        : JSON.stringify(payload.conflictedFiles),
      payload.ts,
      event.id,
      payload.ts,
      event.ts,
      event.id,
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
 * re-fold determinism). Clears the sticky `dispatch_failures` row, the never-bound
 * `dispatch_never_bound` counter (so a `keeper autopilot retry` re-arms the breaker
 * from zero — a residual count would re-trip after one expire instead of K), the
 * instant-death `dispatch_instant_death` counter (same re-arm-from-zero rationale
 * for its sibling breaker), AND the in-flight `pending_dispatches` row (fn-870 BUG
 * fix: an operator clear must immediately free the launch-window slot + per-root
 * mutex; clearing only the failure + counter left a stale pending stranding the
 * slot until the TTL sweep). All DELETEs are idempotent no-ops on a missing row.
 * Malformed/missing payload → safe no-op.
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
  db.run("DELETE FROM dispatch_never_bound WHERE verb = ? AND id = ?", [
    payload.verb,
    payload.id,
  ]);
  db.run("DELETE FROM dispatch_instant_death WHERE verb = ? AND id = ?", [
    payload.verb,
    payload.id,
  ]);
  db.run("DELETE FROM pending_dispatches WHERE verb = ? AND id = ?", [
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
 * Never-bound circuit-breaker threshold: after K CONSECUTIVE
 * `DispatchExpired`-without-bind events for one `(verb, id)`, the fold mints a
 * sticky `dispatch_failures(reason='never-bound')` the existing `failedKeys` arm
 * suppresses. A successful bind (or a `retry_dispatch` clear) resets the count,
 * so a worker that binds even once never trips it ("bound-then-died" is the
 * exit-watcher's path, not this). Tunable: 2 = more aggressive.
 */
const NEVER_BOUND_EXPIRE_THRESHOLD = 3;

/** Stable reason string for the never-bound circuit-breaker failure. */
const NEVER_BOUND_REASON = "never-bound";

/**
 * Fold one synthetic `DispatchExpired` event. Two arms, both pure functions of
 * the event stream (no `Date.now`, no env, no liveness re-probe):
 *
 *  1. The idempotent `pending_dispatches` DELETE — UNCHANGED. It releases the
 *     re-dispatch slot so a normally-slow (in-doubt) launch can re-dispatch.
 *     MUST NOT throw on a missing row (a boot-drain race where `SessionStart`
 *     already discharged the row before the sweep's `DispatchExpired` lands would
 *     otherwise wedge the reducer).
 *
 *  2. The never-bound circuit breaker — increment the per-`(verb, id)`
 *     consecutive-expire counter in `dispatch_never_bound` (the count CANNOT live
 *     on the just-deleted `pending_dispatches` row, hence its own table). At
 *     `NEVER_BOUND_EXPIRE_THRESHOLD` mint a sticky
 *     `dispatch_failures(reason='never-bound')` via the same UPSERT shape as
 *     {@link foldDispatchFailed}, which the `failedKeys` arm suppresses. The mint
 *     is keyed-by-pk with `created_at`/`ts` lifted from `event.ts` (re-fold
 *     deterministic), and ALSO clears the counter so a post-retry re-arm starts
 *     fresh. The counter resets to zero (DELETE) on a successful bind (the
 *     SessionStart discharge-on-bind gate) and on `DispatchCleared`.
 *
 *     Breaker-loop safety (fn-870): the counter arm is SKIPPED when the key
 *     ALREADY has a `dispatch_failures` row. The TTL sweep now expires aged
 *     pendings UNCONDITIONALLY (BUG2) — including a key already holding a sticky
 *     failure — so an expiry of an already-failed row is just a slot release, not
 *     a fresh target failure: it must NOT bump the counter (which would re-trip
 *     the breaker on an already-failed key and churn `last_event_id`). Arm 1's
 *     DELETE still frees the slot. The probe reads only the persisted row, so the
 *     fold stays pure + re-fold-deterministic.
 *
 * Malformed/missing payload → safe no-op.
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
  // Breaker-loop safety: an expiry of a key that ALREADY has a sticky
  // `dispatch_failures` row is a slot release, not a target failure — skip the
  // counter arm entirely (no bump, no re-trip, no `last_event_id` churn). With the
  // sweep's df-guard dropped (BUG2), this is the arm that keeps an already-failed
  // pending's repeated expiries from re-tripping the never-bound breaker.
  const alreadyFailed = db
    .query("SELECT verb FROM dispatch_failures WHERE verb = ? AND id = ?")
    .get(payload.verb, payload.id) as { verb: string } | null;
  if (alreadyFailed != null) {
    return;
  }
  // Increment the consecutive-no-bind counter. UPSERT keyed on `(verb, id)`:
  // first expire INSERTs `1`, each subsequent expire (with no intervening bind /
  // clear, which would have DELETEd the row) bumps it. `last_event_id` tracks the
  // latest expire for the re-fold cursor view.
  db.run(
    `INSERT INTO dispatch_never_bound (verb, id, consecutive_expired, last_event_id)
       VALUES (?, ?, 1, ?)
     ON CONFLICT(verb, id) DO UPDATE SET
       consecutive_expired = dispatch_never_bound.consecutive_expired + 1,
       last_event_id = excluded.last_event_id`,
    [payload.verb, payload.id, event.id],
  );
  const counter = db
    .query(
      "SELECT consecutive_expired FROM dispatch_never_bound WHERE verb = ? AND id = ?",
    )
    .get(payload.verb, payload.id) as { consecutive_expired: number } | null;
  if (
    counter != null &&
    counter.consecutive_expired >= NEVER_BOUND_EXPIRE_THRESHOLD
  ) {
    // Mint the sticky failure via the SAME UPSERT shape as `foldDispatchFailed`
    // (reason='never-bound' satisfies the non-empty extractor; dir is unknown at
    // expire time → NULL). `created_at` preserved on conflict so the "sticky
    // since" view is the first never-bound mint. Event-payload-free: `ts` /
    // `created_at` / `updated_at` all come from `event.ts`, keeping the fold
    // re-fold-deterministic. `instance_event_id = event.id` stamps the row's
    // first-appearance incident id (preserved on conflict, same as `created_at`).
    db.run(
      `INSERT INTO dispatch_failures (
         verb, id, reason, dir, ts, last_event_id, created_at, updated_at,
         instance_event_id
       ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)
       ON CONFLICT(verb, id) DO UPDATE SET
         reason = excluded.reason,
         dir = excluded.dir,
         ts = excluded.ts,
         last_event_id = excluded.last_event_id,
         updated_at = excluded.updated_at`,
      [
        payload.verb,
        payload.id,
        NEVER_BOUND_REASON,
        event.ts,
        event.id,
        event.ts,
        event.ts,
        event.id,
      ],
    );
    // Clear the counter: the breaker has tripped and the sticky failure now owns
    // suppression. A `retry_dispatch` (`DispatchCleared`) clears the failure; the
    // counter must start fresh on the next dispatch cycle, not at the threshold.
    db.run("DELETE FROM dispatch_never_bound WHERE verb = ? AND id = ?", [
      payload.verb,
      payload.id,
    ]);
  }
}

/**
 * Instant-death circuit-breaker: max post-bind lifetime (event-`ts` seconds) a
 * terminal `Killed` counts as an INSTANT death. Sub-minute — a worker that binds,
 * makes its first API call, and dies at the account session/quota wall lives only
 * seconds (the fn-1083.2 evidence: 6–40s), while a real task that got to work
 * survives well past a minute. Tunable.
 */
const INSTANT_DEATH_LIFETIME_SEC = 60;

/**
 * Instant-death circuit-breaker threshold: after K CONSECUTIVE instant post-bind
 * deaths for one `(verb, id)` (bind → sub-minute `Killed` → re-dispatch → …), the
 * fold mints a sticky `dispatch_failures(reason='instant-death-breaker')` the
 * `failedKeys` arm suppresses. Mirrors {@link NEVER_BOUND_EXPIRE_THRESHOLD}: 3.
 * The consecutive-K guard is what makes a lone reaped-fast-completion harmless —
 * a done task is never re-dispatched, so an isolated instant `Killed` increments
 * to 1 and stops, never reaching K (the board's real churn had 2 back-to-back
 * before a supervisor paused).
 */
const INSTANT_DEATH_THRESHOLD = 3;

/**
 * Fold the instant-death circuit breaker on a job's TERMINAL event — the
 * reducer-side SIBLING of the never-bound breaker (`foldDispatchExpired`), for the
 * wall never-bound MISSES: a worker that BINDS then dies fast. A bind RESETS the
 * never-bound counter, so a bind → instant-death → re-dispatch loop never trips
 * it; this breaker keys on post-bind LIFETIME instead. Called ONLY on the proven
 * terminal-write path of the `Killed` (`isAbruptDeath=true`) and `SessionEnd`
 * (`isAbruptDeath=false`) folds, AFTER the row is flipped terminal.
 *
 * Detection is cause-AGNOSTIC (no transcript parse, no `close_kind`/`kill_reason`
 * filter — every close kind in the evidence appears both for genuine churn and
 * for a reaped success): an INSTANT death is an ABRUPT `Killed` whose job had
 * BOUND-and-worked (`active_since` non-NULL) and whose post-bind lifetime
 * (`event.ts - active_since`) is under {@link INSTANT_DEATH_LIFETIME_SEC}.
 *
 * Guards that keep a fast SUCCESSFUL task from tripping — encoded explicitly:
 *  1. A clean `SessionEnd` (the normal completion exit) is `isAbruptDeath=false`,
 *     so it NEVER increments — it RESETS the counter (a completion is progress).
 *  2. `active_since` must be non-NULL — a worker that never reached `working` is
 *     never-bound territory, not this breaker's.
 *  3. The CONSECUTIVE-K threshold: a done task is never re-dispatched, so even a
 *     rare success reaped as `Killed` (SessionEnd lost the race) increments to at
 *     most 1 and stops — it can never reach K without a re-dispatch the done task
 *     will never get. (Its lone stale count is invisible and re-fold-deterministic.)
 *
 * A NON-instant terminal (clean `SessionEnd`, or a long-lived `Killed` — the
 * worker did real work before dying) RESETS the count: "consecutive" means
 * uninterrupted by any real progress. A successful bind is NOT a reset (unlike
 * never-bound) — the whole signal is bind-then-die, so the count MUST survive the
 * re-dispatch's bind. Breaker-loop safety mirrors never-bound's `alreadyFailed`
 * guard: once the key holds a sticky `dispatch_failures` row, a late in-flight
 * terminal is a slot release, not a fresh trip (no bump, no re-mint, no
 * `last_event_id` churn). Change-gate-equivalent by construction: the sticky is
 * minted EXACTLY once at K (the mint then clears the counter), never per-event.
 *
 * Pure over the persisted row + `event.ts`/`event.id` (no wall-clock/fs/liveness),
 * so re-fold is byte-deterministic. A non-plan-keyed job (`plan_verb`/`plan_ref`
 * NULL) is a safe no-op — the breaker only tracks `(verb, id)` dispatch keys.
 */
function foldInstantDeathTerminal(
  db: Database,
  event: Event,
  jobId: string,
  isAbruptDeath: boolean,
): void {
  const row = db
    .query(
      "SELECT plan_verb, plan_ref, active_since FROM jobs WHERE job_id = ?",
    )
    .get(jobId) as {
    plan_verb: string | null;
    plan_ref: string | null;
    active_since: number | null;
  } | null;
  if (row == null || row.plan_verb == null || row.plan_ref == null) {
    return;
  }
  const verb = row.plan_verb;
  const id = row.plan_ref;
  const bound = row.active_since != null;
  const isInstantDeath =
    isAbruptDeath &&
    bound &&
    event.ts - (row.active_since as number) < INSTANT_DEATH_LIFETIME_SEC;
  if (!isInstantDeath) {
    // Clean exit, or a worker that lived past the wall window — the
    // consecutive-fast-death streak is broken. Idempotent no-op DELETE.
    db.run("DELETE FROM dispatch_instant_death WHERE verb = ? AND id = ?", [
      verb,
      id,
    ]);
    return;
  }
  // Breaker-loop safety: an already-failed key's late terminal is a slot release,
  // not a fresh trip — skip the counter arm (the mint cleared it to zero already).
  const alreadyFailed = db
    .query("SELECT verb FROM dispatch_failures WHERE verb = ? AND id = ?")
    .get(verb, id) as { verb: string } | null;
  if (alreadyFailed != null) {
    return;
  }
  db.run(
    `INSERT INTO dispatch_instant_death (verb, id, consecutive_deaths, last_event_id)
       VALUES (?, ?, 1, ?)
     ON CONFLICT(verb, id) DO UPDATE SET
       consecutive_deaths = dispatch_instant_death.consecutive_deaths + 1,
       last_event_id = excluded.last_event_id`,
    [verb, id, event.id],
  );
  const counter = db
    .query(
      "SELECT consecutive_deaths FROM dispatch_instant_death WHERE verb = ? AND id = ?",
    )
    .get(verb, id) as { consecutive_deaths: number } | null;
  if (
    counter != null &&
    counter.consecutive_deaths >= INSTANT_DEATH_THRESHOLD
  ) {
    // Mint the sticky failure via the SAME UPSERT shape as `foldDispatchFailed`
    // (dir unknown at kill time → NULL; `ts`/`created_at`/`updated_at` all from
    // `event.ts`, keeping the fold re-fold-deterministic). The `failedKeys` arm
    // suppresses re-dispatch of the key until `retry_dispatch` clears it.
    // `instance_event_id = event.id` stamps the row's first-appearance incident
    // id (preserved on conflict, same as `created_at`).
    db.run(
      `INSERT INTO dispatch_failures (
         verb, id, reason, dir, ts, last_event_id, created_at, updated_at,
         instance_event_id
       ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)
       ON CONFLICT(verb, id) DO UPDATE SET
         reason = excluded.reason,
         dir = excluded.dir,
         ts = excluded.ts,
         last_event_id = excluded.last_event_id,
         updated_at = excluded.updated_at`,
      [
        verb,
        id,
        INSTANT_DEATH_BREAKER_REASON,
        event.ts,
        event.id,
        event.ts,
        event.ts,
        event.id,
      ],
    );
    // Clear the counter: the breaker tripped and the sticky now owns suppression;
    // a post-retry re-arm starts fresh (a residual count would re-trip after one
    // death instead of K).
    db.run("DELETE FROM dispatch_instant_death WHERE verb = ? AND id = ?", [
      verb,
      id,
    ]);
  }
}

/**
 * Parse a `BlockEscalationRequested` event payload. Returns null on any
 * structural miss ({@link foldBlockEscalationRequested} folds null to a safe
 * no-op); NEVER throws. Strict: `epic_id` / `task_id` non-empty strings (the
 * `block_escalations` pk).
 */
function extractBlockEscalationRequestedPayload(
  event: Event,
): BlockEscalationRequestedPayload | null {
  if (event.data == null || event.data.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      event.data,
    ) as Partial<BlockEscalationRequestedPayload>;
    if (typeof parsed.epic_id !== "string" || parsed.epic_id.length === 0) {
      return null;
    }
    if (typeof parsed.task_id !== "string" || parsed.task_id.length === 0) {
      return null;
    }
    return { epic_id: parsed.epic_id, task_id: parsed.task_id };
  } catch (err) {
    console.error(
      `keeper reducer: failed to parse BlockEscalationRequested payload for event id=${event.id} session=${event.session_id}: ${err}`,
    );
    return null;
  }
}

/**
 * Fold one synthetic `BlockEscalationRequested` event. Advances the
 * `block_escalations` latch `pending → requested` for the matching
 * `(epic_id, task_id)`. Idempotent: a missing latch row (the leave-blocked
 * DELETE already cleared it, or a malformed payload) folds to a safe no-op — the
 * UPDATE matches zero rows. Pure function of the payload + the persisted row
 * (`event.id` only, no wall-clock/fs/liveness), so re-fold is byte-deterministic.
 */
function foldBlockEscalationRequested(db: Database, event: Event): void {
  const payload = extractBlockEscalationRequestedPayload(event);
  if (payload == null) {
    return;
  }
  db.run(
    `UPDATE block_escalations
        SET status = 'requested', last_event_id = ?
      WHERE epic_id = ? AND task_id = ?`,
    [event.id, payload.epic_id, payload.task_id],
  );
}

/**
 * Parse a `BlockEscalationAttempted` event payload. Returns null on any
 * structural miss ({@link foldBlockEscalationAttempted} folds null to a safe
 * no-op); NEVER throws. Strict: `epic_id` / `task_id` / `outcome` non-empty
 * strings.
 */
function extractBlockEscalationAttemptedPayload(
  event: Event,
): BlockEscalationAttemptedPayload | null {
  if (event.data == null || event.data.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      event.data,
    ) as Partial<BlockEscalationAttemptedPayload>;
    if (typeof parsed.epic_id !== "string" || parsed.epic_id.length === 0) {
      return null;
    }
    if (typeof parsed.task_id !== "string" || parsed.task_id.length === 0) {
      return null;
    }
    if (typeof parsed.outcome !== "string" || parsed.outcome.length === 0) {
      return null;
    }
    return {
      epic_id: parsed.epic_id,
      task_id: parsed.task_id,
      outcome: parsed.outcome,
    };
  } catch (err) {
    console.error(
      `keeper reducer: failed to parse BlockEscalationAttempted payload for event id=${event.id} session=${event.session_id}: ${err}`,
    );
    return null;
  }
}

/**
 * Fold one synthetic `BlockEscalationAttempted` event with STAGED outcomes. For a
 * TERMINAL outcome (the escalation-dispatch `dispatched`, or any outcome that is
 * not in the non-terminal set) it advances the `block_escalations` latch
 * `requested → attempted` and records the `outcome`. For a NON-TERMINAL outcome
 * (`dispatch_failed` — the `unblock::<task>` launch failed — or the bus-send
 * `send_failed`) it instead RESETS the latch to `pending` so
 * `selectPendingBlockEscalations` re-sweeps it on the next heartbeat tick — a
 * transient dispatch failure retries instead of dropping the escalation forever
 * (the latch otherwise only re-arms on an unblock→re-block `TaskSnapshot`
 * transition). The `outcome` is still recorded on the row so the failure is
 * observable. The branch reads ONLY the payload `outcome` + the persisted row
 * (`event.id`, no wall-clock/fs/liveness), so re-fold stays byte-deterministic.
 * Idempotent on a missing latch row (the UPDATE matches zero rows).
 */
function foldBlockEscalationAttempted(db: Database, event: Event): void {
  const payload = extractBlockEscalationAttemptedPayload(event);
  if (payload == null) {
    return;
  }
  const nonTerminal =
    payload.outcome === "send_failed" || payload.outcome === "dispatch_failed";
  const status = nonTerminal ? "pending" : "attempted";
  db.run(
    `UPDATE block_escalations
        SET status = ?, outcome = ?, last_event_id = ?
      WHERE epic_id = ? AND task_id = ?`,
    [status, payload.outcome, event.id, payload.epic_id, payload.task_id],
  );
}

/**
 * Parse a `MergeEscalationAttempted` event payload. Returns null on any
 * structural miss ({@link foldMergeEscalationAttempted} folds null to a safe
 * no-op); NEVER throws. Strict: `id` / `outcome` non-empty strings.
 */
function extractMergeEscalationAttemptedPayload(
  event: Event,
): MergeEscalationAttemptedPayload | null {
  if (event.data == null || event.data.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      event.data,
    ) as Partial<MergeEscalationAttemptedPayload>;
    if (typeof parsed.id !== "string" || parsed.id.length === 0) {
      return null;
    }
    if (typeof parsed.outcome !== "string" || parsed.outcome.length === 0) {
      return null;
    }
    // `verb` is OPTIONAL on the wire: a historical close event (minted `{id, outcome}`)
    // carries no verb, so a missing/blank/non-string value defaults to `close`, keeping
    // that fold byte-identical. The WORK fan-in path mints an explicit `verb:"work"`.
    const verb =
      typeof parsed.verb === "string" && parsed.verb.length > 0
        ? parsed.verb
        : "close";
    return { id: parsed.id, outcome: parsed.outcome, verb };
  } catch (err) {
    console.error(
      `keeper reducer: failed to parse MergeEscalationAttempted payload for event id=${event.id} session=${event.session_id}: ${err}`,
    );
    return null;
  }
}

/**
 * Fold one synthetic `MergeEscalationAttempted` event. For a TERMINAL outcome
 * (the escalation-dispatch `dispatched`, or a delivered bus-send `sent` /
 * `queued_for_wake`) it stamps the once-marker `merge_escalated_at = event.ts` on
 * the sticky `worktree-merge-conflict` row identified by the payload's
 * verb-parameterized `(verb, id)` key, gated `merge_escalated_at IS NULL` so the
 * first observation wins and a re-fold reproduces it byte-identically. The `verb`
 * defaults to `close` for a legacy verb-less payload, so historical close events fold
 * exactly as before; the WORK fan-in path stamps the `(work, taskId)` row. Every other
 * outcome (`dispatch_failed` / `send_failed` / undelivered / unknown) is NON-TERMINAL
 * and folds to a no-op, leaving the marker NULL so the sweep re-attempts on the next
 * tick — mirroring `foldBlockEscalationAttempted`'s non-terminal rule. The branch reads
 * ONLY the payload (`outcome` + `verb`) + `event.ts` (no wall-clock/fs/liveness), so
 * re-fold stays byte-deterministic. The UPDATE no-ops on a missing row (the
 * clear-before-mint race) and NEVER clears the row — only `DispatchCleared`
 * (`retry_dispatch`) does. Malformed/missing payload → safe no-op.
 */
function foldMergeEscalationAttempted(db: Database, event: Event): void {
  const payload = extractMergeEscalationAttemptedPayload(event);
  if (payload == null) {
    return;
  }
  const terminal =
    payload.outcome === "dispatched" ||
    payload.outcome === "sent" ||
    payload.outcome === "queued_for_wake";
  if (!terminal) {
    return;
  }
  db.run(
    `UPDATE dispatch_failures
        SET merge_escalated_at = ?
      WHERE verb = ? AND id = ? AND merge_escalated_at IS NULL`,
    [event.ts, payload.verb, payload.id],
  );
}

/**
 * Parse a `ResolverDispatchAttempted` event payload. Returns null on any
 * structural miss ({@link foldResolverDispatchAttempted} folds null to a safe
 * no-op); NEVER throws. Strict: `id` / `outcome` non-empty strings.
 */
function extractResolverDispatchAttemptedPayload(
  event: Event,
): ResolverDispatchAttemptedPayload | null {
  if (event.data == null || event.data.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      event.data,
    ) as Partial<ResolverDispatchAttemptedPayload>;
    if (typeof parsed.id !== "string" || parsed.id.length === 0) {
      return null;
    }
    if (typeof parsed.outcome !== "string" || parsed.outcome.length === 0) {
      return null;
    }
    // `verb` is OPTIONAL on the wire: a historical close event (minted `{id, outcome}`)
    // carries no verb, so a missing/blank/non-string value defaults to `close`, keeping
    // that fold byte-identical. The WORK fan-in path mints an explicit `verb:"work"`.
    const verb =
      typeof parsed.verb === "string" && parsed.verb.length > 0
        ? parsed.verb
        : "close";
    return { id: parsed.id, outcome: parsed.outcome, verb };
  } catch (err) {
    console.error(
      `keeper reducer: failed to parse ResolverDispatchAttempted payload for event id=${event.id} session=${event.session_id}: ${err}`,
    );
    return null;
  }
}

/**
 * Fold one synthetic `ResolverDispatchAttempted` event — the resolver-dispatch
 * once-latch, sibling to {@link foldMergeEscalationAttempted}. For the TERMINAL
 * `dispatched` outcome (the daemon sweep launched the `resolve::<id>` worker) it
 * stamps `resolver_dispatched_at = event.ts` on the sticky `worktree-merge-conflict`
 * row identified by the payload's verb-parameterized `(verb, id)` key, gated
 * `resolver_dispatched_at IS NULL` so the first observation wins and a re-fold
 * reproduces it byte-identically. The `verb` defaults to `close` for a legacy
 * verb-less payload, so historical close events fold exactly as before; the WORK fan-in
 * path stamps the `(work, taskId)` row. Every other outcome (`dispatch_failed` /
 * unknown) is NON-TERMINAL and folds to a no-op, leaving the marker NULL so the sweep
 * re-attempts on the next tick. The branch reads ONLY the payload (`outcome` + `verb`)
 * + `event.ts` (no wall-clock/fs/liveness), so re-fold stays byte-deterministic. The
 * UPDATE no-ops on a missing row (the clear-before-mint race) and NEVER clears the row
 * — only `DispatchCleared` (`retry_dispatch`) does, which re-arms the marker at NULL.
 * Independent of `merge_escalated_at`: a row can be human-escalated, resolver-
 * dispatched, both, or neither. Malformed/missing payload → safe no-op.
 */
function foldResolverDispatchAttempted(db: Database, event: Event): void {
  const payload = extractResolverDispatchAttemptedPayload(event);
  if (payload == null) {
    return;
  }
  if (payload.outcome !== "dispatched") {
    return;
  }
  db.run(
    `UPDATE dispatch_failures
        SET resolver_dispatched_at = ?
      WHERE verb = ? AND id = ? AND resolver_dispatched_at IS NULL`,
    [event.ts, payload.verb, payload.id],
  );
}

/**
 * Parse a `MergeHumanNotified` event payload. Returns null on any structural miss
 * ({@link foldMergeHumanNotified} folds null to a safe no-op); NEVER throws.
 * Strict: `id` / `outcome` non-empty strings.
 */
function extractMergeHumanNotifiedPayload(
  event: Event,
): MergeHumanNotifiedPayload | null {
  if (event.data == null || event.data.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(event.data) as Partial<MergeHumanNotifiedPayload>;
    if (typeof parsed.id !== "string" || parsed.id.length === 0) {
      return null;
    }
    if (typeof parsed.outcome !== "string" || parsed.outcome.length === 0) {
      return null;
    }
    // `verb` is OPTIONAL on the wire: a historical close event (minted `{id, outcome}`)
    // carries no verb, so a missing/blank/non-string value defaults to `close`, keeping
    // that fold byte-identical. The WORK fan-in path mints an explicit `verb:"work"`.
    const verb =
      typeof parsed.verb === "string" && parsed.verb.length > 0
        ? parsed.verb
        : "close";
    return { id: parsed.id, outcome: parsed.outcome, verb };
  } catch (err) {
    console.error(
      `keeper reducer: failed to parse MergeHumanNotified payload for event id=${event.id} session=${event.session_id}: ${err}`,
    );
    return null;
  }
}

/**
 * Fold one synthetic `MergeHumanNotified` event — the terminal "human notified"
 * once-latch of a `worktree-merge-conflict` escalation path, sibling to {@link
 * foldMergeEscalationAttempted} and {@link foldResolverDispatchAttempted}. For the
 * TERMINAL `notified` outcome (the daemon delivered the one botctl notification —
 * about a declined/dead `deconflict::<epic>` session on the close path, or straight
 * away for a stuck `work::<taskId>` fan-in conflict on the work path) it stamps
 * `human_notified_at = event.ts` on the sticky row identified by the payload's
 * verb-parameterized `(verb, id)` key, gated `human_notified_at IS NULL` so the first
 * observation wins and a re-fold reproduces it byte-identically. The `verb` defaults
 * to `close` for a legacy verb-less payload, so historical close events fold exactly
 * as before. Every other outcome (`notify_failed` / unknown) is NON-TERMINAL and folds
 * to a no-op, leaving the marker NULL so the sweep re-attempts on the next tick. The
 * branch reads ONLY the payload (`outcome` + `verb`) + `event.ts` (no
 * wall-clock/fs/liveness), so re-fold stays byte-deterministic. The UPDATE no-ops on a
 * missing row (the clear-before-mint race) and NEVER clears the row — only
 * `DispatchCleared` (`retry_dispatch`) does, which re-arms the marker at NULL.
 * Independent of `merge_escalated_at` / `resolver_dispatched_at`. Malformed/missing
 * payload → safe no-op.
 */
function foldMergeHumanNotified(db: Database, event: Event): void {
  const payload = extractMergeHumanNotifiedPayload(event);
  if (payload == null) {
    return;
  }
  if (payload.outcome !== "notified") {
    return;
  }
  db.run(
    `UPDATE dispatch_failures
        SET human_notified_at = ?
      WHERE verb = ? AND id = ? AND human_notified_at IS NULL`,
    [event.ts, payload.verb, payload.id],
  );
}

/**
 * Parse a `RepairDispatched` event payload. Returns null on any structural miss
 * ({@link foldRepairDispatched} folds null to a safe no-op); NEVER throws. Strict:
 * `id` / `outcome` non-empty strings.
 */
function extractRepairDispatchedPayload(
  event: Event,
): RepairDispatchedPayload | null {
  if (event.data == null || event.data.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(event.data) as Partial<RepairDispatchedPayload>;
    if (typeof parsed.id !== "string" || parsed.id.length === 0) {
      return null;
    }
    if (typeof parsed.outcome !== "string" || parsed.outcome.length === 0) {
      return null;
    }
    return { id: parsed.id, outcome: parsed.outcome };
  } catch (err) {
    console.error(
      `keeper reducer: failed to parse RepairDispatched payload for event id=${event.id} session=${event.session_id}: ${err}`,
    );
    return null;
  }
}

/**
 * Fold one synthetic `RepairDispatched` event — the repair-dispatch once-latch,
 * sibling to {@link foldResolverDispatchAttempted} but on the sticky
 * `repair::<repo-token>` row (verb `repair`). For the TERMINAL `dispatched` outcome
 * (the daemon SHARED_BASE_BROKEN sweep launched the `repair::<token>` session) it
 * stamps `repair_dispatched_at = event.ts` on the repair row, gated
 * `repair_dispatched_at IS NULL` so the first observation wins and a re-fold
 * reproduces it byte-identically. Every other outcome (`dispatch_failed` / unknown)
 * is NON-TERMINAL and folds to a no-op, leaving the marker NULL so the sweep
 * re-attempts on the next tick. The branch reads ONLY the payload `outcome` +
 * `event.ts` (no wall-clock/fs/liveness), so re-fold stays byte-deterministic. The
 * UPDATE no-ops on a missing row (the clear-before-mint race) and NEVER clears the
 * row — only `DispatchCleared` does (retry_dispatch OR the sweep's positive-evidence
 * clear), which re-arms the marker at NULL. Independent of the merge/resolver markers
 * (a different verb keys a different row). Malformed/missing payload → safe no-op.
 */
function foldRepairDispatched(db: Database, event: Event): void {
  const payload = extractRepairDispatchedPayload(event);
  if (payload == null) {
    return;
  }
  if (payload.outcome !== "dispatched") {
    return;
  }
  db.run(
    `UPDATE dispatch_failures
        SET repair_dispatched_at = ?
      WHERE verb = 'repair' AND id = ? AND repair_dispatched_at IS NULL`,
    [event.ts, payload.id],
  );
}

/**
 * Parse a `RepairHumanNotified` event payload. Returns null on any structural miss
 * ({@link foldRepairHumanNotified} folds null to a safe no-op); NEVER throws. Strict:
 * `id` / `outcome` non-empty strings.
 */
function extractRepairHumanNotifiedPayload(
  event: Event,
): RepairHumanNotifiedPayload | null {
  if (event.data == null || event.data.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      event.data,
    ) as Partial<RepairHumanNotifiedPayload>;
    if (typeof parsed.id !== "string" || parsed.id.length === 0) {
      return null;
    }
    if (typeof parsed.outcome !== "string" || parsed.outcome.length === 0) {
      return null;
    }
    return { id: parsed.id, outcome: parsed.outcome };
  } catch (err) {
    console.error(
      `keeper reducer: failed to parse RepairHumanNotified payload for event id=${event.id} session=${event.session_id}: ${err}`,
    );
    return null;
  }
}

/**
 * Fold one synthetic `RepairHumanNotified` event — the terminal "human notified"
 * once-latch of the REPAIR path, sibling to {@link foldMergeHumanNotified} but on the
 * sticky `repair::<repo-token>` row (verb `repair`). For the TERMINAL `notified`
 * outcome (the daemon paged the human about a declined/dead `repair::<token>` session)
 * it stamps `human_notified_at = event.ts` on the repair row, gated
 * `human_notified_at IS NULL` so the page fires exactly once and a re-fold reproduces
 * it byte-identically. Every other outcome (`notify_failed` / unknown) is
 * NON-TERMINAL and folds to a no-op, leaving the marker NULL so the sweep re-attempts.
 * The branch reads ONLY the payload `outcome` + `event.ts`, so re-fold stays
 * byte-deterministic. The UPDATE no-ops on a missing row and NEVER clears the row —
 * only `DispatchCleared` does, which re-arms it at NULL. Malformed/missing payload →
 * safe no-op.
 */
function foldRepairHumanNotified(db: Database, event: Event): void {
  const payload = extractRepairHumanNotifiedPayload(event);
  if (payload == null) {
    return;
  }
  if (payload.outcome !== "notified") {
    return;
  }
  db.run(
    `UPDATE dispatch_failures
        SET human_notified_at = ?
      WHERE verb = 'repair' AND id = ? AND human_notified_at IS NULL`,
    [event.ts, payload.id],
  );
}

/**
 * Parse a `SharedCheckoutHumanNotified` event payload. Returns null on any structural
 * miss ({@link foldSharedCheckoutHumanNotified} folds null to a safe no-op); NEVER
 * throws. Strict: `id` / `outcome` non-empty strings.
 */
function extractSharedCheckoutHumanNotifiedPayload(
  event: Event,
): SharedCheckoutHumanNotifiedPayload | null {
  if (event.data == null || event.data.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      event.data,
    ) as Partial<SharedCheckoutHumanNotifiedPayload>;
    if (typeof parsed.id !== "string" || parsed.id.length === 0) {
      return null;
    }
    if (typeof parsed.outcome !== "string" || parsed.outcome.length === 0) {
      return null;
    }
    return { id: parsed.id, outcome: parsed.outcome };
  } catch (err) {
    console.error(
      `keeper reducer: failed to parse SharedCheckoutHumanNotified payload for event id=${event.id} session=${event.session_id}: ${err}`,
    );
    return null;
  }
}

/**
 * Fold one synthetic `SharedCheckoutHumanNotified` event — the terminal "human paged"
 * once-latch of the shared-checkout hygiene page-once sweep, sibling to {@link
 * foldRepairHumanNotified} but on a `shared-checkout-{dirty,desync}:<repoHash>` distress
 * row (the shared daemon distress verb, {@link SHARED_DIRTY_DISTRESS_VERB} — the desync
 * family shares that verb; the `id` prefix picks the family). For the TERMINAL `notified`
 * outcome (the daemon paged the human about a live dirty/desync distress row) it stamps
 * `human_notified_at = event.ts` on the distress row, gated `human_notified_at IS NULL`
 * so the page fires exactly once per row instance and a re-fold reproduces it
 * byte-identically. Every other outcome (`notify_failed` / unknown) is NON-TERMINAL and
 * folds to a no-op, leaving the marker NULL so the sweep re-attempts. The branch reads
 * ONLY the payload `outcome` + `event.ts` (no wall-clock/fs/liveness), so re-fold stays
 * byte-deterministic. The UPDATE no-ops on a missing row (the clear-before-mint race) and
 * NEVER clears the row — only the producer level-clear (`DispatchCleared`) does, which
 * re-arms the marker at NULL so a cleared-then-reminted row pages anew. Malformed/missing
 * payload → safe no-op.
 */
function foldSharedCheckoutHumanNotified(db: Database, event: Event): void {
  const payload = extractSharedCheckoutHumanNotifiedPayload(event);
  if (payload == null) {
    return;
  }
  if (payload.outcome !== "notified") {
    return;
  }
  db.run(
    `UPDATE dispatch_failures
        SET human_notified_at = ?
      WHERE verb = ? AND id = ? AND human_notified_at IS NULL`,
    [event.ts, SHARED_DIRTY_DISTRESS_VERB, payload.id],
  );
}

/**
 * Parse a `BlockHumanNotified` event payload. Returns null on any structural miss
 * ({@link foldBlockHumanNotified} folds null to a safe no-op); NEVER throws.
 * Strict: `epic_id` / `task_id` / `outcome` non-empty strings.
 */
function extractBlockHumanNotifiedPayload(
  event: Event,
): BlockHumanNotifiedPayload | null {
  if (event.data == null || event.data.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(event.data) as Partial<BlockHumanNotifiedPayload>;
    if (typeof parsed.epic_id !== "string" || parsed.epic_id.length === 0) {
      return null;
    }
    if (typeof parsed.task_id !== "string" || parsed.task_id.length === 0) {
      return null;
    }
    if (typeof parsed.outcome !== "string" || parsed.outcome.length === 0) {
      return null;
    }
    return {
      epic_id: parsed.epic_id,
      task_id: parsed.task_id,
      outcome: parsed.outcome,
    };
  } catch (err) {
    console.error(
      `keeper reducer: failed to parse BlockHumanNotified payload for event id=${event.id} session=${event.session_id}: ${err}`,
    );
    return null;
  }
}

/**
 * Fold one synthetic `BlockHumanNotified` event — the terminal "human notified"
 * once-latch of the UNBLOCK path on the `block_escalations` latch, sibling in
 * discipline to {@link foldMergeHumanNotified}. For the TERMINAL `notified`
 * outcome (the daemon delivered the one botctl notification about a declined/dead
 * `unblock::<task>` session) it stamps `human_notified_at = event.ts` on the
 * `(epic_id, task_id)` latch row, gated `human_notified_at IS NULL` so the first
 * observation wins and a re-fold reproduces it byte-identically. Every other
 * outcome (`notify_failed` / unknown) is NON-TERMINAL and folds to a no-op,
 * leaving the marker NULL so the sweep re-attempts on the next tick. The branch
 * reads ONLY the payload `outcome` + `event.ts` (no wall-clock/fs/liveness), so
 * re-fold stays byte-deterministic. The UPDATE no-ops on a missing latch row (the
 * leave-blocked DELETE already cleared it) and NEVER clears the latch — only the
 * leave-blocked `TaskSnapshot` transition does, which re-arms the marker at NULL.
 * Malformed/missing payload → safe no-op.
 */
function foldBlockHumanNotified(db: Database, event: Event): void {
  const payload = extractBlockHumanNotifiedPayload(event);
  if (payload == null) {
    return;
  }
  if (payload.outcome !== "notified") {
    return;
  }
  db.run(
    `UPDATE block_escalations
        SET human_notified_at = ?
      WHERE epic_id = ? AND task_id = ? AND human_notified_at IS NULL`,
    [event.ts, payload.epic_id, payload.task_id],
  );
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
 * `AutopilotCapSet` synthetic-event payload (fn-725) — the LEGACY global
 * autopilot concurrency-cap event. NO LONGER PRODUCED: the cap is now set at
 * runtime via the generic `set_autopilot_config` RPC → `AutopilotConfigSet`
 * event (see {@link AutopilotConfigSetPayload}). The fold arm is RETAINED so an
 * OLD DB carrying historical `AutopilotCapSet` events still re-folds
 * byte-identically; never mint a new one.
 *
 * `max_concurrent_jobs`: a positive integer ceiling on concurrent
 * root-occupants, or `null` for unlimited (the default).
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
 * The scalar autopilot CONFIG columns a `set_autopilot_config` patch may set —
 * the SINGLE source of truth shared by the reducer fold, the RPC validator, and
 * the worker→main mint site. Each entry maps a wire patch field to its
 * `autopilot_state` column. Adding a future scalar setting = one entry here + a
 * column + a parse/validate clause; NO new RPC and NO new event type. `paused`
 * and `mode` are DELIBERATELY absent — they keep their own live RPCs; this
 * surface owns only the config half (the config-file-frozen settings).
 */
const AUTOPILOT_CONFIG_COLUMNS = {
  max_concurrent_jobs: "max_concurrent_jobs",
  max_concurrent_per_root: "max_concurrent_per_root",
  worktree_mode: "worktree_mode",
  worktree_multi_repo: "worktree_multi_repo",
  codex_adoption: "codex_adoption",
  worker_provider: "worker_provider",
  drift_behind_threshold: "drift_behind_threshold",
  drift_age_threshold_days: "drift_age_threshold_days",
} as const satisfies Record<string, string>;

type AutopilotConfigField = keyof typeof AUTOPILOT_CONFIG_COLUMNS;

/**
 * `AutopilotConfigSet` synthetic-event payload — a PARTIAL patch of the scalar
 * autopilot config columns (`max_concurrent_jobs` + `max_concurrent_per_root`,
 * extensible via {@link AUTOPILOT_CONFIG_COLUMNS}). Round-trips through the generic
 * `set_autopilot_config` RPC → main append → this fold, which UPSERTs the
 * `autopilot_state` singleton setting ONLY the patched columns and PRESERVING
 * every other column (mirror of the `AutopilotCapSet`/`Mode`/`Paused` discipline).
 * A partial patch — an absent field is "leave the column as-is", NOT "null it".
 */
interface AutopilotConfigSetPayload {
  /** A positive-integer concurrency cap, or `null` for unlimited. Present iff
   *  the patch touches the cap. */
  max_concurrent_jobs?: number | null;
  /** A positive-integer per-root dispatch concurrency count, or `null` to reset
   *  to the in-memory `DEFAULT_MAX_CONCURRENT_PER_ROOT` (= 1). Present iff the
   *  patch touches it. UNLIKE the cap, `null` is "reset to default", NOT
   *  "unlimited" — there is no unlimited sentinel for the per-root count. */
  max_concurrent_per_root?: number | null;
  /** The durable worktree-mode toggle, stored as INTEGER 0/1 (`1` = ON, `0` =
   *  OFF) so the generic fold loop binds it like the other config columns.
   *  Present iff the patch touches it. The wire field is a BOOLEAN; the parser
   *  coerces `true`→1 / anything-else→0 (`null`/absent/non-boolean → OFF). No
   *  `null` here — there is no unlimited/unset sentinel; a present field always
   *  resolves to a concrete 0/1. */
  worktree_mode?: number;
  /** The durable multi-repo worktree rollout flag, stored as INTEGER 0/1 (`1` =
   *  ON = per-repo lane groups for a multi-toplevel epic, `0` = OFF = today's
   *  whole-epic `>1`-toplevel reject). Same shape/coercion as
   *  {@link worktree_mode}: the wire field is a BOOLEAN; the parser coerces
   *  `true`→1 / anything-else→0. No `null` sentinel; a present field always
   *  resolves to a concrete 0/1. */
  worktree_multi_repo?: number;
  /** The durable codex rollout-adoption knob, stored as INTEGER 0/1 (`1` = ON =
   *  positive-evidence codex rollout adoption enabled, `0` = OFF = the
   *  byte-identical default, nothing adopted). Same shape/coercion as
   *  {@link worktree_mode}: the wire field is a BOOLEAN; the parser coerces
   *  `true`→1 / anything-else→0. No `null` sentinel; a present field always
   *  resolves to a concrete 0/1. No fold reads it — the codex adoption producer
   *  resolves an absent column `?? OFF` at read time. */
  codex_adoption?: number;
  /** The durable worker-provider dispatch pin (docs/adr/0047), stored as TEXT —
   *  the FIRST non-numeric config column. `"claude"` / `"gpt"` pin every work
   *  dispatch to that provider family; `null` clears the pin (unconstrained,
   *  the byte-identical default). Present iff the patch touches it AND the raw
   *  wire value is one of the recognized members — the deprecated `"codex"`
   *  alias folds to `"gpt"` (LOAD-BEARING for re-fold determinism: historical
   *  events carry `"codex"`), while an unrecognized value (a typo, a stale enum
   *  member) drops the field entirely, preserving the existing column, rather
   *  than coercing to a sentinel (unlike the numeric fields above, silently
   *  clearing a dispatch pin is not the safe direction). The RPC validator
   *  rejects a bad value loud before it ever reaches here; this is a defensive
   *  backstop, never a throw. */
  worker_provider?: "claude" | "gpt" | null;
  /** The durable base-drift behind-count threshold — a positive integer, or
   *  `null` to disable that axis. Same coercion discipline as
   *  `max_concurrent_per_root`: `null` / non-positive / non-integer all
   *  resolve to `null` (the sentinel/0-disables OFF default); a positive int
   *  sets the threshold. Present iff the patch touches it. */
  drift_behind_threshold?: number | null;
  /** The durable base-drift merge-base-age threshold, in days — same shape and
   *  coercion as {@link drift_behind_threshold}. Present iff the patch touches
   *  it. Both drift thresholds resolving `null` is the OFF default: `.2`'s
   *  drift probe and `.4`'s refresh pass both stay inert. */
  drift_age_threshold_days?: number | null;
}

/**
 * Parse an `AutopilotConfigSet` event payload into the validated partial patch.
 * Returns null on a structurally-invalid blob OR an EMPTY patch (no recognized
 * field) — {@link foldAutopilotConfigSet} folds null to a safe no-op so the
 * cursor still advances. NEVER throws (a throw inside the fold wedges the
 * reducer). Per-field tolerance MIRRORS the cap parser: each field coerces a
 * non-positive / non-integer / non-number to `null` (`max_concurrent_jobs`
 * `null` = unlimited; `max_concurrent_per_root` `null` = reset to the in-memory
 * default = 1), matching the config parser's contract; an explicit `null` is a
 * first-class value. An ABSENT field is dropped from the patch (preserve the
 * column), distinct from a present `null` (set the column to NULL).
 */
function extractAutopilotConfigSetPayload(
  event: Event,
): AutopilotConfigSetPayload | null {
  if (event.data == null || event.data.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(event.data) as Record<string, unknown>;
    if (parsed == null || typeof parsed !== "object") {
      return null;
    }
    const patch: AutopilotConfigSetPayload = {};
    if ("max_concurrent_jobs" in parsed) {
      const raw = parsed.max_concurrent_jobs;
      // null/non-positive/non-integer → unlimited (NULL); a positive int wins.
      patch.max_concurrent_jobs =
        typeof raw === "number" && Number.isInteger(raw) && raw > 0
          ? raw
          : null;
    }
    if ("max_concurrent_per_root" in parsed) {
      const raw = parsed.max_concurrent_per_root;
      // null/non-positive/non-integer → NULL (= reset to the in-memory
      // DEFAULT_MAX_CONCURRENT_PER_ROOT = 1, the byte-identical N=1 mutex); a
      // positive int sets the per-root count. NO unlimited sentinel — the column
      // is always resolved `?? DEFAULT` to a positive integer at read time.
      patch.max_concurrent_per_root =
        typeof raw === "number" && Number.isInteger(raw) && raw > 0
          ? raw
          : null;
    }
    if ("worktree_mode" in parsed) {
      const raw = parsed.worktree_mode;
      // BOOLEAN wire field stored as INTEGER 0/1: `true` → 1 (ON), anything else
      // (false / null / non-boolean) → 0 (OFF). A present field always resolves
      // to a concrete 0/1 — there is no unset sentinel, so the column never goes
      // NULL via a patch (the reconciler still resolves an absent column `?? OFF`).
      patch.worktree_mode = raw === true ? 1 : 0;
    }
    if ("worktree_multi_repo" in parsed) {
      const raw = parsed.worktree_multi_repo;
      // BOOLEAN wire field stored as INTEGER 0/1, mirroring `worktree_mode`:
      // `true` → 1 (ON), anything else (false / null / non-boolean) → 0 (OFF). A
      // present field always resolves to a concrete 0/1 — the reconciler resolves
      // an absent column `?? OFF`.
      patch.worktree_multi_repo = raw === true ? 1 : 0;
    }
    if ("codex_adoption" in parsed) {
      const raw = parsed.codex_adoption;
      // BOOLEAN wire field stored as INTEGER 0/1, mirroring `worktree_multi_repo`:
      // `true` → 1 (ON), anything else (false / null / non-boolean) → 0 (OFF). A
      // present field always resolves to a concrete 0/1 — the codex adoption
      // producer resolves an absent column `?? OFF` at read time.
      patch.codex_adoption = raw === true ? 1 : 0;
    }
    if ("worker_provider" in parsed) {
      const raw = parsed.worker_provider;
      // STRING ENUM, the first non-numeric config column: accept exactly
      // `"claude"` / `"gpt"` / `null`, plus the deprecated `"codex"` alias
      // folded to `"gpt"` — LOAD-BEARING for re-fold determinism, since
      // historical `set_autopilot_config` events already carry `"codex"` and
      // every replay must fold them to `"gpt"`. Anything else (a typo, a
      // number, a stale enum member) is NOT coerced to a sentinel — it drops
      // the field entirely so the existing column survives untouched, matching
      // the strict-mode discipline of `extractAutopilotModePayload` rather than
      // the coerce-to-null tolerance the numeric fields above use.
      if (raw === "claude" || raw === "gpt" || raw === null) {
        patch.worker_provider = raw;
      } else if (raw === "codex") {
        patch.worker_provider = "gpt";
      }
    }
    if ("drift_behind_threshold" in parsed) {
      const raw = parsed.drift_behind_threshold;
      // null/non-positive/non-integer → NULL (OFF for this axis, the
      // sentinel/0-disables discipline); a positive int sets the threshold.
      patch.drift_behind_threshold =
        typeof raw === "number" && Number.isInteger(raw) && raw > 0
          ? raw
          : null;
    }
    if ("drift_age_threshold_days" in parsed) {
      const raw = parsed.drift_age_threshold_days;
      // Same coercion as drift_behind_threshold — null/non-positive/non-integer
      // → NULL (OFF for this axis).
      patch.drift_age_threshold_days =
        typeof raw === "number" && Number.isInteger(raw) && raw > 0
          ? raw
          : null;
    }
    // An empty patch (no recognized field) folds to a safe no-op.
    return Object.keys(patch).length === 0 ? null : patch;
  } catch (err) {
    console.error(
      `keeper reducer: failed to parse AutopilotConfigSet payload for event id=${event.id} session=${event.session_id}: ${err}`,
    );
    return null;
  }
}

/**
 * Fold one synthetic `AutopilotConfigSet` event. UPSERT on the singleton
 * `id = 1`, setting ONLY the patched config columns and PRESERVING `paused` +
 * `mode` + every unpatched config column on conflict — the arms share `id = 1`,
 * so each MUST preserve the others' columns or a patch clobbers a sibling. The
 * INSERT path binds `paused = 1` (boots-paused contract), the defensive fallback
 * now that the `AutopilotCapSet` boot-append is gone: an `AutopilotConfigSet`
 * that is the FIRST event to touch the row still materializes a paused singleton.
 * Pure function of the payload + persisted row — no `Date.now()`, no env read.
 * Malformed/empty payload → safe no-op, never a throw.
 */
function foldAutopilotConfigSet(db: Database, event: Event): void {
  const payload = extractAutopilotConfigSetPayload(event);
  if (payload == null) {
    return;
  }
  // Build the INSERT column list + the ON CONFLICT SET clause dynamically from
  // exactly the patched fields, so an unpatched config column is left untouched
  // (preserved) on conflict — the partial-patch contract. `paused` defaults to 1
  // on the INSERT path (boots-paused); on conflict it is NEVER in the SET clause,
  // so the durable pause/play flag survives. Column names come from the
  // compile-time `AUTOPILOT_CONFIG_COLUMNS` allowlist (never foreign input), so
  // interpolating them into the SQL is injection-safe.
  const insertCols: string[] = [
    "id",
    "paused",
    "last_event_id",
    "created_at",
    "updated_at",
  ];
  const insertVals: (number | string | null)[] = [
    1,
    1,
    event.id,
    event.ts,
    event.ts,
  ];
  const setClauses: string[] = ["last_event_id = excluded.last_event_id"];
  for (const field of Object.keys(payload) as AutopilotConfigField[]) {
    const column = AUTOPILOT_CONFIG_COLUMNS[field];
    insertCols.push(column);
    insertVals.push(payload[field] ?? null);
    setClauses.push(`${column} = excluded.${column}`);
  }
  setClauses.push("updated_at = excluded.updated_at");
  const placeholders = insertCols.map(() => "?").join(", ");
  db.run(
    `INSERT INTO autopilot_state (${insertCols.join(", ")})
       VALUES (${placeholders})
     ON CONFLICT(id) DO UPDATE SET
       ${setClauses.join(",\n       ")}`,
    insertVals,
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
 * `HandoffRequested` synthetic-event payload — the durable record of a
 * `keeper handoff` enqueue, minted main-side. `handoff_id` is the human-authored
 * slug (host-global-unique, frozen at request time — never re-slugified at
 * replay), serving as the idempotency key; `doc` is the contextful brief (capped
 * at WRITE time, never here); the raw `initiator_*` coords always ride even when
 * `initiator_job_id` resolved null (initiator pane not yet folded).
 * `target_session` is the resolved tmux session the dispatcher launches the
 * handoff-ee into.
 */
interface HandoffRequestedPayload {
  handoff_id: string;
  doc: string;
  title: string | null;
  target_session: string | null;
  /** Resolved ABSOLUTE launch directory (null = pre-feature event / no `--cwd`
   *  → the dispatcher coalesces to keeperd's cwd). */
  target_dir: string | null;
  initiator_session: string | null;
  initiator_pane: string | null;
  initiator_job_id: string | null;
}

/**
 * Parse a `HandoffRequested` event payload. Returns null on any structural miss
 * — {@link foldHandoffRequested} folds null to a safe no-op (cursor still
 * advances). STRICT on the load-bearing fields: `handoff_id` MUST be a non-empty
 * string and `doc` MUST be a string. The nullable coordinate fields coerce a
 * non-string to null (re-fold-stable). NEVER throws (a throw inside the fold
 * wedges the reducer).
 */
function extractHandoffRequestedPayload(
  event: Event,
): HandoffRequestedPayload | null {
  if (event.data == null || event.data.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(event.data) as Partial<HandoffRequestedPayload>;
    if (
      typeof parsed.handoff_id !== "string" ||
      parsed.handoff_id.length === 0 ||
      typeof parsed.doc !== "string"
    ) {
      return null;
    }
    const str = (v: unknown): string | null =>
      typeof v === "string" ? v : null;
    return {
      handoff_id: parsed.handoff_id,
      doc: parsed.doc,
      title: str(parsed.title),
      target_session: str(parsed.target_session),
      target_dir: str(parsed.target_dir),
      initiator_session: str(parsed.initiator_session),
      initiator_pane: str(parsed.initiator_pane),
      initiator_job_id: str(parsed.initiator_job_id),
    };
  } catch (err) {
    console.error(
      `keeper reducer: failed to parse HandoffRequested payload for event id=${event.id} session=${event.session_id}: ${err}`,
    );
    return null;
  }
}

/**
 * Fold one synthetic `HandoffRequested` event. Two writes, both pure functions
 * of the payload + persisted state:
 *
 * 1. UPSERT the `handoffs` row (status=`requested`) keyed on `handoff_id`. The
 *    dispatcher's later lifecycle events (task .3) advance the same row, so this
 *    is an INSERT-or-leave: a re-fold replays this event before any dispatcher
 *    event, so the `requested` row is correctly re-established. ON CONFLICT
 *    refreshes only the requested-time fields (never `claimed_at` /
 *    `callee_job_id` / `never_bound_count`, which the dispatcher/bind own) so a
 *    re-fold lands byte-identical rows regardless of arm order.
 * 2. Write the `handoff-from` {@link HandoffLinkEntry} onto the initiator job's
 *    `handoff_links` array (no-op when the initiator job is an orphan / unfolded
 *    — the raw coords on the row still anchor the edge). The `peer_job_id` is
 *    the callee, NOT YET KNOWN at request time → the empty string; the bind fold
 *    (task .3) re-stamps both endpoints once the callee binds.
 *
 * Pure — no `Date.now()`, no env/liveness read; `claimed_at` stays NULL here
 * (the dispatcher stamps it from its own event ts). Malformed payload → safe
 * no-op (cursor still advances). NEVER throws.
 */
function foldHandoffRequested(db: Database, event: Event): void {
  const payload = extractHandoffRequestedPayload(event);
  if (payload == null) {
    return;
  }
  db.run(
    `INSERT INTO handoffs (
       handoff_id, status, doc, title, target_session, target_dir,
       initiator_session, initiator_pane, initiator_job_id,
       callee_job_id, claimed_at, never_bound_count, last_event_id
     ) VALUES (?, 'requested', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?)
     ON CONFLICT(handoff_id) DO UPDATE SET
       doc = excluded.doc,
       title = excluded.title,
       target_session = excluded.target_session,
       target_dir = excluded.target_dir,
       initiator_session = excluded.initiator_session,
       initiator_pane = excluded.initiator_pane,
       initiator_job_id = excluded.initiator_job_id,
       last_event_id = excluded.last_event_id`,
    [
      payload.handoff_id,
      payload.doc,
      payload.title,
      payload.target_session,
      payload.target_dir,
      payload.initiator_session,
      payload.initiator_pane,
      payload.initiator_job_id,
      event.id,
    ],
  );
  // Write the handoff-from edge onto the initiator job. The callee is unknown at
  // request time (peer_job_id = "") — the bind fold (.3) re-stamps it.
  if (payload.initiator_job_id != null && payload.initiator_job_id.length > 0) {
    writeHandoffLinkOnJob(
      db,
      payload.initiator_job_id,
      "handoff-from",
      payload.handoff_id,
      "",
      "requested",
      event.id,
      event.ts,
    );
  }
}

/** Persisted request/cancel payload for one Durable await intent. */
type AwaitRequestedPayload =
  | {
      op: "request";
      await_id: string;
      condition_spec: unknown[];
      follow_up: string;
      target_session: string | null;
      target_dir: string | null;
      timeout_at: number | null;
    }
  | { op: "cancel"; await_id: string };

/** Parse without throwing; malformed Durable await Events Fold to a no-op. */
function extractAwaitRequestedPayload(
  event: Event,
): AwaitRequestedPayload | null {
  if (event.data == null || event.data.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(event.data) as Record<string, unknown>;
    if (typeof parsed.await_id !== "string" || parsed.await_id.length === 0) {
      return null;
    }
    if (parsed.op === "cancel") {
      return { op: "cancel", await_id: parsed.await_id };
    }
    if (
      parsed.op !== "request" ||
      !Array.isArray(parsed.condition_spec) ||
      parsed.condition_spec.length === 0 ||
      typeof parsed.follow_up !== "string"
    ) {
      return null;
    }
    const nullableString = (value: unknown): string | null =>
      typeof value === "string" ? value : null;
    const timeout_at =
      typeof parsed.timeout_at === "number" &&
      Number.isFinite(parsed.timeout_at)
        ? parsed.timeout_at
        : null;
    return {
      op: "request",
      await_id: parsed.await_id,
      condition_spec: parsed.condition_spec,
      follow_up: parsed.follow_up,
      target_session: nullableString(parsed.target_session),
      target_dir: nullableString(parsed.target_dir),
      timeout_at,
    };
  } catch (err) {
    console.error(
      `keeper reducer: failed to parse AwaitRequested payload for event id=${event.id} session=${event.session_id}: ${err}`,
    );
    return null;
  }
}

/** Fold one request/cancel Synthetic event into the Durable await Projection. */
function foldAwaitRequested(db: Database, event: Event): void {
  const payload = extractAwaitRequestedPayload(event);
  if (payload == null) {
    return;
  }
  if (payload.op === "cancel") {
    db.run(
      `UPDATE awaits
          SET status = 'cancelled', claimed_at = NULL, last_event_id = ?
        WHERE await_id = ? AND status = 'waiting'`,
      [event.id, payload.await_id],
    );
    return;
  }
  db.run(
    `INSERT INTO awaits (
       await_id, condition_spec, follow_up, target_session, target_dir,
       timeout_at, status, claimed_at, attempt_count, never_bound_count,
       last_event_id
     ) VALUES (?, ?, ?, ?, ?, ?, 'waiting', NULL, 0, 0, ?)
     ON CONFLICT(await_id) DO UPDATE SET
       condition_spec = excluded.condition_spec,
       follow_up = excluded.follow_up,
       target_session = excluded.target_session,
       target_dir = excluded.target_dir,
       timeout_at = excluded.timeout_at,
       last_event_id = excluded.last_event_id`,
    [
      payload.await_id,
      JSON.stringify(payload.condition_spec),
      payload.follow_up,
      payload.target_session,
      payload.target_dir,
      payload.timeout_at,
      event.id,
    ],
  );
}

/** Await worker lifecycle marker. The producer owns clocks/launches; this fold
 * only records their event-stamped outcomes and is therefore replay-safe. */
function foldAwaitLifecycle(db: Database, event: Event): void {
  let payload: { await_id?: unknown } = {};
  try {
    payload = JSON.parse(event.data ?? "{}") as typeof payload;
  } catch {
    return;
  }
  if (typeof payload.await_id !== "string" || payload.await_id.length === 0) {
    return;
  }
  if (event.hook_event === "AwaitFiring") {
    const row = db
      .query("SELECT status, never_bound_count FROM awaits WHERE await_id = ?")
      .get(payload.await_id) as
      | { status: string; never_bound_count: number }
      | undefined;
    if (row === undefined || !["waiting", "firing"].includes(row.status)) {
      return;
    }
    const neverBoundCount = row.never_bound_count + 1;
    db.run(
      `UPDATE awaits
          SET status = ?, claimed_at = ?, attempt_count = attempt_count + 1,
              never_bound_count = ?, last_event_id = ?
        WHERE await_id = ? AND status IN ('waiting', 'firing')`,
      [
        neverBoundCount >= 3 ? "failed" : "firing",
        event.ts,
        neverBoundCount,
        event.id,
        payload.await_id,
      ],
    );
    return;
  }
  const status =
    event.hook_event === "AwaitDone"
      ? "done"
      : event.hook_event === "AwaitTimedOut"
        ? "timed_out"
        : "failed";
  // Terminal outcomes never regress: a late failure may not overwrite a timeout
  // (or a completed effect) after a lease-reclaim race.
  db.run(
    `UPDATE awaits
        SET status = ?, claimed_at = NULL, last_event_id = ?
      WHERE await_id = ? AND status IN ('waiting', 'firing')`,
    [status, event.id, payload.await_id],
  );
}

/**
 * Never-bound circuit-breaker threshold for handoffs: K CONSECUTIVE
 * `HandoffDispatching` events for one handoff WITHOUT an intervening bind flip
 * the row to sticky `failed`. Mirrors {@link NEVER_BOUND_EXPIRE_THRESHOLD} (the
 * autopilot dispatch breaker). A successful bind ({@link projectJobsRow}'s
 * `handoff::` SessionStart arm) resets `never_bound_count` to 0, so a handoff
 * that binds even once never trips it. Defined fold-side (NOT imported from the
 * producer worker) so the reducer's import graph stays free of the launch
 * transport — the worker carries its own copy under the same name.
 */
const NEVER_BOUND_HANDOFF_THRESHOLD = 3;

/**
 * `HandoffDispatching` synthetic-event payload — the durable transactional-outbox
 * marker the dispatcher mints BEFORE it launches the handoff-ee. `handoff_id` is
 * the only field; `claimed_at` is stamped fold-side from `event.ts` (NEVER from
 * the producer) so a re-fold reproduces byte-identical rows.
 */
interface HandoffDispatchingPayload {
  handoff_id: string;
}

/** Parse a `HandoffDispatching` payload; null on any miss (fold no-ops). */
function extractHandoffDispatchingPayload(
  event: Event,
): HandoffDispatchingPayload | null {
  if (event.data == null || event.data.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(event.data) as Partial<HandoffDispatchingPayload>;
    if (
      typeof parsed.handoff_id !== "string" ||
      parsed.handoff_id.length === 0
    ) {
      return null;
    }
    return { handoff_id: parsed.handoff_id };
  } catch {
    return null;
  }
}

/**
 * Fold one `HandoffDispatching` event — the dispatcher's mint-before-launch
 * marker. Advances the matching `handoffs` row to `status='dispatching'`,
 * stamps `claimed_at` from `event.ts` (the lease anchor the worker reads back),
 * and BUMPS `never_bound_count`. When the bumped count reaches
 * {@link NEVER_BOUND_HANDOFF_THRESHOLD} the row goes sticky `failed` — K
 * consecutive dispatches with no intervening bind (a bind resets the counter in
 * {@link projectJobsRow}). A `bound`/`failed` row is left ALONE (a late marker
 * for an already-settled handoff must never re-open it); the breaker also leaves
 * an already-`failed` row untouched. NO-OP when the row is absent (the marker
 * raced ahead of the `HandoffRequested` fold — can't happen given outbox
 * ordering, but defense-in-depth). Pure (all time is `event.ts`); NEVER throws.
 */
function foldHandoffDispatching(db: Database, event: Event): void {
  const payload = extractHandoffDispatchingPayload(event);
  if (payload == null) {
    return;
  }
  const row = db
    .query(
      "SELECT status, never_bound_count FROM handoffs WHERE handoff_id = ?",
    )
    .get(payload.handoff_id) as
    | { status: string; never_bound_count: number }
    | undefined;
  if (row == null) {
    // Marker with no requested row — outbox ordering prevents this; ignore.
    return;
  }
  if (row.status === "bound" || row.status === "failed") {
    // Terminal/settled — a late marker must not re-open it.
    return;
  }
  const nextCount = row.never_bound_count + 1;
  const tripped = nextCount >= NEVER_BOUND_HANDOFF_THRESHOLD;
  db.run(
    `UPDATE handoffs
        SET status = ?, claimed_at = ?, never_bound_count = ?, last_event_id = ?
      WHERE handoff_id = ?`,
    [
      tripped ? "failed" : "dispatching",
      event.ts,
      nextCount,
      event.id,
      payload.handoff_id,
    ],
  );
}

/**
 * `HandoffLaunchFailed` synthetic-event payload — a PERMANENT launch failure
 * (keeper agent exit 1/2/3, a thrown launch) the dispatcher surfaces. Distinct from
 * the never-bound breaker (which trips off `never_bound_count`). `reason` is the
 * surfaced launch error (carried for the operator view; the fold only needs the
 * id to flip status).
 */
interface HandoffLaunchFailedPayload {
  handoff_id: string;
  reason: string;
}

/** Parse a `HandoffLaunchFailed` payload; null on any miss (fold no-ops). */
function extractHandoffLaunchFailedPayload(
  event: Event,
): HandoffLaunchFailedPayload | null {
  if (event.data == null || event.data.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      event.data,
    ) as Partial<HandoffLaunchFailedPayload>;
    if (
      typeof parsed.handoff_id !== "string" ||
      parsed.handoff_id.length === 0
    ) {
      return null;
    }
    return {
      handoff_id: parsed.handoff_id,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch {
    return null;
  }
}

/**
 * Fold one `HandoffLaunchFailed` event — flip the matching `handoffs` row to
 * terminal `status='failed'`. A `bound` row is left ALONE (a launch-failure
 * mint racing a successful bind must never knock a live handoff-ee terminal);
 * an already-`failed` row is idempotently re-stamped (cheap). NO-OP on a missing
 * row. Pure; NEVER throws.
 */
function foldHandoffLaunchFailed(db: Database, event: Event): void {
  const payload = extractHandoffLaunchFailedPayload(event);
  if (payload == null) {
    return;
  }
  db.run(
    `UPDATE handoffs
        SET status = 'failed', last_event_id = ?
      WHERE handoff_id = ? AND status != 'bound'`,
    [event.id, payload.handoff_id],
  );
}

/**
 * Sweep open (in-flight) subagent_invocations rows for a job to
 * `status='unknown'` in a single bulk UPDATE. "In-flight" is the canonical
 * open-turn predicate (`duration_ms IS NULL AND status IN (...)`), so a
 * backgrounded `ok` orphan (NULL `duration_ms`) is swept too — NOT a bare
 * `status='running'`. The `duration_ms IS NULL` clause is load-bearing: without
 * it a FINISHED `ok` row (non-null `duration_ms`) on a now-terminal job would be
 * clobbered to `unknown`, corrupting a legitimately-closed turn. Called from the
 * SessionEnd and Killed arms of {@link projectJobsRow} on the proven write path
 * (after the jobs UPDATE landed), inside the same `BEGIN IMMEDIATE` transaction
 * as the lifecycle write + cursor advance — exactly-once-per-event holds across
 * both projections.
 *
 * Closes the lifecycle gap for orphaned subagents whose parent session died
 * before the matching SubagentStop landed: an open-turn row whose job is now
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
      WHERE job_id = ?
        AND duration_ms IS NULL
        AND status IN (${OPEN_TURN_STATUS_SQL})`,
    [eventId, ts, jobId],
  );
}

/**
 * SILENT_STREAM_CUT recovery. When a subagent's most recent assistant
 * turn was a stream cut (`last_disposition='cut'` — `stop_reason` was `tool_use`
 * or `null`, the harness terminated the turn between a tool_result and the next
 * API response) and its parent job is STILL `working`, flip the parent job to
 * `'stopped'` so readiness re-readies the task and autopilot re-dispatches —
 * faster than the ~60s dead-pid reprobe.
 *
 * The `state = 'working'` guard IS the "no terminal error in the correlation
 * window" guard, by construction: any api_error / SessionEnd / Killed / Stop in
 * the window would already have moved the row OFF `working` (to `stopped` /
 * `ended` / `killed`), so a still-`working` row is one that has NO terminal
 * signal — exactly the SILENT_STREAM_CUT class (the task .3 census found 0/50
 * api_error correlation). A `clean` (end_turn) turn never reaches here. The
 * guard also makes the fold idempotent (a re-fire finds the row already
 * `stopped` → zero changes → no re-fan) and re-fold deterministic (it reads only
 * folded `jobs.state` + the event log, never wall-clock or liveness).
 *
 * Returns true iff it flipped the row (so the caller can decide whether to log).
 */
function dropParentJobOnSilentStreamCut(
  db: Database,
  jobId: string,
  eventId: number,
  ts: number,
): boolean {
  const res = db.run(
    // Quiescing (working -> stopped): gated at `ts >= stamp` (ADR 0013). A
    // silent-stream-cut whose ts has regressed behind the lifecycle stamp is a
    // stale straggler — swallow it (no flip, no stamp advance, no re-fan) rather
    // than drop a session that a newer event already proved live.
    `UPDATE jobs SET state = 'stopped', last_lifecycle_ts = ?,
                     last_event_id = ?, updated_at = ?
       WHERE job_id = ? AND state = 'working'
         AND ${lifecycleStampGate("quiesce")}`,
    [ts, eventId, ts, jobId, ts],
  );
  if (res.changes > 0) {
    syncIfPlanRef(db, jobId, eventId, ts);
    return true;
  }
  return false;
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
/**
 * Threshold above which a SubagentStart fold emits a `[subagentfold-breakdown]`
 * line splitting `extractTurnSeq` vs `findPendingPreToolUseForStart` (the FIFO
 * bridge probe, which parses candidate PreToolUse blobs) vs the row INSERT.
 * SubagentStart averages 2.6s / maxes 27.6s on the live DB; the split convicts
 * which probe holds the write lock. Gated so steady folds stay silent. Pure
 * instrumentation — never read into a projection write.
 */
const SUBAGENT_FOLD_BREAKDOWN_MS = 1000;

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
      const _saT0 = performance.now();
      const turnSeq = extractTurnSeq(db, jobId, agentId);
      const _saT1 = performance.now();
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
      const pendingPre = findPendingPreToolUseForStart(
        db,
        jobId,
        seedType,
        event.id,
      );
      const _saT2 = performance.now();
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
      // Slow-fold breakdown — localizes a [fold-slow] SubagentStart to the
      // dominant probe. Only emitted above threshold so steady folds stay
      // silent. Pure side-effect: not read into any projection write.
      const _saTotal = performance.now() - _saT0;
      if (_saTotal >= SUBAGENT_FOLD_BREAKDOWN_MS) {
        console.error(
          `[subagentfold-breakdown] id=${event.id} total=${_saTotal.toFixed(0)}ms ` +
            `extractTurnSeq=${(_saT1 - _saT0).toFixed(0)}ms ` +
            `findPendingPre=${(_saT2 - _saT1).toFixed(0)}ms ` +
            `insert=${(performance.now() - _saT2).toFixed(0)}ms`,
        );
      }
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
          `SELECT ts, status, last_disposition FROM subagent_invocations
            WHERE job_id = ? AND agent_id = ? AND turn_seq = ?`,
        )
        .get(jobId, agentId, openTurnSeq) as {
        ts: number;
        status: string;
        last_disposition: string | null;
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
      // SILENT_STREAM_CUT: the turn that just closed had its last
      // assistant message folded as a cut (`stop_reason` tool_use/null, no
      // terminal text) by a prior `SubagentTurn` event, yet a SubagentStop
      // landed — the harness terminated the worker turn mid-stream. Flip the
      // still-`working` parent job to `stopped` so the dropped task re-dispatches
      // without waiting on the ~60s dead-pid reprobe. The negative control is the
      // disposition itself: a `clean` (end_turn) turn never enters this branch.
      // Race-tolerant: if the `SubagentTurn(cut)` event instead lands AFTER this
      // close, its own fold arm performs the identical flip.
      if (row.last_disposition === "cut") {
        dropParentJobOnSilentStreamCut(db, jobId, event.id, ts);
      }
      return;
    }

    case "SubagentTurn": {
      // Synthetic event (transcript worker → main): the terminal disposition of
      // a subagent's most recent assistant turn. Stamp it onto the row so the
      // SubagentStop fold can recognize a SILENT_STREAM_CUT. `agent_id` carries
      // the subagent identity; provisional (`settled:false`) evidence is inert.
      const agentId = event.agent_id;
      if (agentId == null || agentId.length === 0) {
        return; // no subagent identity — safe no-op.
      }
      const evidence = extractSubagentDisposition(event);
      if (evidence == null || !evidence.settled) {
        return;
      }
      const disposition = evidence.disposition;
      // Stamp the LATEST turn for this (job_id, agent_id) — open or just-closed.
      // Targeting max(turn_seq) (NOT only the open turn) makes the stamp
      // race-tolerant: a `SubagentTurn` landing AFTER SubagentStop closed the
      // turn (duration_ms non-null) still records the disposition on the right
      // row. Matches zero rows when no SubagentStart has folded yet — a safe
      // no-op (the orphan-turn case).
      const target = db
        .query(
          `SELECT turn_seq, duration_ms FROM subagent_invocations
            WHERE job_id = ? AND agent_id = ?
            ORDER BY turn_seq DESC
            LIMIT 1`,
        )
        .get(jobId, agentId) as {
        turn_seq: number;
        duration_ms: number | null;
      } | null;
      if (target == null) {
        return; // no row to stamp — safe no-op.
      }
      db.run(
        `UPDATE subagent_invocations
            SET last_disposition = ?, last_event_id = ?, updated_at = ?
          WHERE job_id = ? AND agent_id = ? AND turn_seq = ?`,
        [disposition, event.id, ts, jobId, agentId, target.turn_seq],
      );
      // Race tail: when this `cut` disposition lands AFTER the SubagentStop
      // already closed the turn (`duration_ms` non-null), the SubagentStop arm
      // could not have seen the cut — so perform the parent-job flip HERE. The
      // still-`working` guard inside the helper keeps it idempotent if both arms
      // fire. A `clean` disposition never flips.
      if (disposition === "cut" && target.duration_ms != null) {
        dropParentJobOnSilentStreamCut(db, jobId, event.id, ts);
      }
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

/** First prompt line, deterministically capped — wall-clock-free truncation. */
const SCHEDULED_TASK_PROMPT_MAX_CHARS = 200;

/**
 * Project a `CronCreate` / `CronDelete` `PostToolUse` event onto the
 * `scheduled_tasks` side table. Called as a sibling of
 * {@link projectSubagentInvocationsRow} at the PostToolUse dispatch site; gated
 * strictly on `hook_event === 'PostToolUse'` by the caller (a CronCreate
 * PostToolUseFailure carries no `tool_response` and must NEVER mint a row).
 *
 * Create arm: UPSERT on `(job_id, cron_id)` — a re-created cron id resurrects
 * (`status='active'`). Delete arm: flip the matching row to `'deleted'`; an
 * unmatched key is a safe no-op. Every field comes from `event.ts` /
 * `event.id` so a from-scratch re-fold reproduces identical rows. Parses
 * `event.data` defensively and guard-and-returns on any malformed/missing-id
 * payload — the cursor still advances upstream. NEVER throws (CLAUDE.md fold
 * invariant).
 */
function projectScheduledTasksRow(db: Database, event: Event): void {
  // Caller gates hook_event === 'PostToolUse'; filter to the two cron tools
  // here. Every other PostToolUse is a fast in-fn no-op.
  if (event.tool_name !== "CronCreate" && event.tool_name !== "CronDelete") {
    return;
  }

  let parsed: { tool_input?: unknown; tool_response?: unknown };
  try {
    parsed = JSON.parse(event.data ?? "{}") as {
      tool_input?: unknown;
      tool_response?: unknown;
    };
  } catch {
    // Malformed payload — safe no-op; the cursor still advances upstream.
    return;
  }
  const toolInput =
    typeof parsed.tool_input === "object" && parsed.tool_input != null
      ? (parsed.tool_input as Record<string, unknown>)
      : {};
  const toolResponse =
    typeof parsed.tool_response === "object" && parsed.tool_response != null
      ? (parsed.tool_response as Record<string, unknown>)
      : {};

  const ts = event.ts;
  const jobId = event.session_id;

  if (event.tool_name === "CronCreate") {
    // Create-side cron id rides `tool_response.id`. A PostToolUseFailure (or
    // any payload missing it) has no id to key on → guard-and-return no-op.
    const cronId = toolResponse.id;
    if (typeof cronId !== "string" || cronId.length === 0) {
      return;
    }
    const cron = typeof toolInput.cron === "string" ? toolInput.cron : "";
    const humanSchedule =
      typeof toolResponse.humanSchedule === "string"
        ? toolResponse.humanSchedule
        : "";
    // `recurring` / `durable` arrive as JSON booleans — lift to INTEGER 0/1.
    const recurring = toolResponse.recurring === true ? 1 : 0;
    const durable = toolResponse.durable === true ? 1 : 0;
    // First prompt line, deterministically capped. Untrusted freeform text —
    // stored opaque, rendered as plain text client-side.
    const promptRaw =
      typeof toolInput.prompt === "string" ? toolInput.prompt : "";
    const promptSummary = promptRaw
      .split("\n", 1)[0]
      .slice(0, SCHEDULED_TASK_PROMPT_MAX_CHARS);
    // UPSERT, never REPLACE/IGNORE: INSERT OR REPLACE is delete+insert and
    // OR IGNORE silently drops a re-fold update. The ON CONFLICT arm
    // resurrects a previously-deleted cron id back to 'active'.
    db.run(
      `INSERT INTO scheduled_tasks (
         job_id, cron_id, cron, human_schedule, recurring, durable,
         prompt_summary, status, ts, last_event_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
       ON CONFLICT(job_id, cron_id) DO UPDATE SET
         cron = excluded.cron,
         human_schedule = excluded.human_schedule,
         recurring = excluded.recurring,
         durable = excluded.durable,
         prompt_summary = excluded.prompt_summary,
         status = 'active',
         ts = excluded.ts,
         last_event_id = excluded.last_event_id,
         updated_at = excluded.updated_at`,
      [
        jobId,
        cronId,
        cron,
        humanSchedule,
        recurring,
        durable,
        promptSummary,
        ts,
        event.id,
        ts,
      ],
    );
    return;
  }

  // CronDelete: id rides `tool_input.id` (also echoed at `tool_response.id`).
  // Prefer tool_input — a PostToolUseFailure carries no tool_response. Missing
  // → guard-and-return no-op.
  const inputId = toolInput.id;
  const cronId =
    typeof inputId === "string" && inputId.length > 0
      ? inputId
      : typeof toolResponse.id === "string" && toolResponse.id.length > 0
        ? (toolResponse.id as string)
        : null;
  if (cronId == null) {
    return;
  }
  // Flip the matching row to 'deleted'. An unmatched key affects zero rows —
  // safe no-op (crons are session-scoped). `last_event_id` bumps so the wire
  // diff fires for the surviving row.
  db.run(
    `UPDATE scheduled_tasks
        SET status = 'deleted', last_event_id = ?, updated_at = ?
      WHERE job_id = ? AND cron_id = ?`,
    [event.id, ts, jobId, cronId],
  );
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
   * Mirror of `jobs.active_since` (`null` until the first `stopped → working`
   * un-stop edge, then non-null and re-stamped to the latest `ts` on each
   * subsequent un-stop edge — the most-recent-edge timestamp, NOT frozen). A
   * pure jobs-row fact — lifted fresh by {@link buildEmbeddedJob} each re-sync,
   * NO clobber-guard carry needed. Readiness reads it to keep a freshly-bound
   * `stopped` worker holding its root across the bind → first-activity handoff
   * without over-holding a stopped-after-working one. Optional + absent ≡ `null`
   * for a pre-v84 stored element.
   */
  active_since?: number | null;
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
  // `null` until the first `stopped → working` un-stop edge, then non-null and
  // re-stamped to the latest edge's `ts` on each subsequent edge (the
  // most-recent-edge timestamp, NOT frozen). Lifted onto the embedded element so readiness can tell a
  // freshly-bound `stopped` worker (never active) from a stopped-after-working
  // one. Pure function of event order — re-fold byte-stable.
  active_since: number | null;
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
    active_since: row.active_since,
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
     * plan-native effort tier. Optional because older stored elements lack
     * the key; the OLD-element carve-out spread below preserves whatever was
     * there. A shell element initialises `tier: null`.
     */
    tier?: string | null;
    /**
     * plan-native worker model. Optional because older stored elements lack the
     * key; the OLD-element carve-out spread below preserves whatever was there.
     * A shell element initialises `model: null`.
     */
    model?: string | null;
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
          model: null,
          worker_phase: null,
          // Shell element gets the plan `"todo"` default (zero-event
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
 *       creator/refiner edge from `keeper plan epic-create`).
 *
 * The SELECT lives here (not at each call site) so both fan-outs read the
 * LATEST state-machine state in lockstep. The caller MUST gate on "an
 * UPDATE/INSERT actually wrote" — the Killed-mismatch path must NOT fire either
 * fan-out.
 */
/**
 * When non-null, {@link syncIfPlanRef} adds its own wall-time (ms) to this
 * accumulator. Armed ONLY around the PostToolUse dispatch in {@link applyEvent}
 * so the `[ptufold-breakdown]` line can split the syncIfPlanRef fan-out out of
 * the jobs-arm total without threading a param through all 15 call sites. Pure
 * instrumentation: the value is never read into a projection write, never
 * influences a branch — re-fold determinism is untouched. A fold is
 * single-threaded, so the module-scoped accumulator can't interleave.
 */
let _syncIfPlanRefAccumMs: number | null = null;

/**
 * When non-null, {@link syncPlanLinks} accumulates its fan-out cardinality
 * (touched epics, swept sessions), the commit-trailer load cost, and the
 * per-epic `deriveJobLinks` re-derive cost into this object. Armed ONLY around
 * the dispatch sites in {@link applyEvent} (the commit, PostToolUse, and
 * PreToolUse breakdown arms) so the breakdown lines can carry the plan fan-out
 * shape without threading a param through the two fixed `syncPlanLinks` call
 * sites. `calls` counts invocations so a fold that fires the fan-out more than
 * once still reports a faithful total. `sweptSessions` is now always `calls`
 * (each call processes exactly ITS session's slice — the former cross-session
 * orphan sweep is gone), so a value above `calls` is the tell of a regression
 * back to an unbounded fan-out. Pure instrumentation: never read into a
 * projection write, never influences a branch — re-fold determinism is
 * untouched. A fold is single-threaded, so the module-scoped accumulator can't
 * interleave.
 */
interface SyncPlanLinksAccum {
  calls: number;
  touchedEpics: number;
  sweptSessions: number;
  factsRows: number;
  factsLoadMs: number;
  deriveJobLinksMs: number;
}
let _syncPlanLinksAccum: SyncPlanLinksAccum | null = null;

/**
 * Render the armed {@link SyncPlanLinksAccum} as a single breakdown segment
 * (the `plan_fanout=` field shared across the commit / PostToolUse /
 * PreToolUse breakdown lines). `calls=0` means the fold never reached
 * `syncPlanLinks`, so the cardinality counters are all zero — still emitted
 * verbatim so the absence is legible. Pure formatter; reads only the accumulator.
 */
function formatSyncPlanFanout(acc: SyncPlanLinksAccum): string {
  return (
    `plan_calls=${acc.calls} ` +
    `plan_touched_epics=${acc.touchedEpics} ` +
    `plan_swept_sessions=${acc.sweptSessions} ` +
    `plan_facts_rows=${acc.factsRows} ` +
    `plan_facts_load_ms=${acc.factsLoadMs.toFixed(0)} ` +
    `plan_derive_ms=${acc.deriveJobLinksMs.toFixed(0)}`
  );
}

function syncIfPlanRef(
  db: Database,
  jobId: string,
  eventId: number,
  ts: number,
): void {
  const _siprT0 = _syncIfPlanRefAccumMs != null ? performance.now() : 0;
  const row = db
    .query(
      "SELECT job_id, plan_verb, plan_ref, state, title, created_at, updated_at, last_event_id, last_api_error_at, last_api_error_kind, last_input_request_at, last_input_request_kind, last_permission_prompt_at, last_permission_prompt_kind, git_dirty_count, git_unattributed_to_live_count, git_orphan_count, active_since FROM jobs WHERE job_id = ?",
    )
    .get(jobId) as JobsRowForSync | null;
  if (row == null) {
    if (_syncIfPlanRefAccumMs != null) {
      _syncIfPlanRefAccumMs += performance.now() - _siprT0;
    }
    return;
  }
  if (row.plan_ref != null) {
    syncJobIntoEpic(db, row, eventId, ts);
  }
  // Always call: `syncJobLinksOnJobWrite` short-circuits on `'[]'` itself, and
  // gating on `plan_ref != null` would miss creator/refiner sessions whose
  // spawn name didn't parse as a plan verb (e.g. a manual `keeper plan
  // epic-create`).
  syncJobLinksOnJobWrite(db, jobId, eventId, ts);
  if (_syncIfPlanRefAccumMs != null) {
    _syncIfPlanRefAccumMs += performance.now() - _siprT0;
  }
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
 * Replace-by-key merge of one session's slice into an epic's `job_links` array.
 * MERGE ONLY — the shared core both `syncPlanLinks` and `syncJobLinksOnJobWrite`
 * splice through: drop EVERY entry whose `job_id === dropJobId`, append the
 * caller's freshly-built `replacements`, re-sort by the locked `(kind, job_id)`
 * total order. Returns a NEW array; mutates no input.
 *
 * The merge is idempotent and non-additive: dropping the old slice before
 * splicing means a re-fold reproduces the same bytes (additive append would
 * double). Every OTHER session's entry is preserved verbatim — the
 * enrichment-freshness invariant (every enriched-column jobs-write fans out via
 * `syncJobLinksOnJobWrite`) makes that byte-identical to a full re-derive.
 *
 * What stays per-caller (NOT merged here): the classifier `kind` ownership
 * (`syncPlanLinks` derives a fresh `kind`; the sibling re-stamps the OLD entry's
 * `kind`) and the shell-insert shape. Those differ per caller and live at the
 * call sites.
 */
function mergeJobLinkSlice(
  existing: readonly JobLinkEntry[],
  dropJobId: string,
  replacements: readonly JobLinkEntry[],
): JobLinkEntry[] {
  const merged = existing.filter((e) => e.job_id !== dropJobId);
  merged.push(...replacements);
  sortJobLinks(merged);
  return merged;
}

/**
 * Enrich a thin classifier-output `JobLink` (`{kind, job_id}`) into the widened
 * `JobLinkEntry` shape carried on `epics.job_links`, adding the display +
 * annotation fields off the post-write `jobs` row. Shared between
 * `syncPlanLinks` and `syncJobLinksOnJobWrite` so both produce identical JSON.
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
 * Parse a persisted `jobs.handoff_links` JSON-TEXT array into
 * {@link HandoffLinkEntry}[]. A NULL/empty/malformed cell folds to `[]` — NEVER
 * throws inside the open BEGIN IMMEDIATE transaction. Sibling of
 * {@link parseEmbeddedLinks} (which is type-constrained to the epic/job link
 * shapes, hence a dedicated reader here).
 */
function parseHandoffLinks(
  text: string | null | undefined,
): HandoffLinkEntry[] {
  if (text == null || text.length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed as HandoffLinkEntry[];
    }
  } catch {
    // malformed stored array → treat as empty.
  }
  return [];
}

/**
 * Deterministic sort for a `jobs.handoff_links` array. Total-order ASC on the
 * full `(kind, handoff_id)` tuple — a single-field sort would leave equal-`kind`
 * ties in implementation-defined order, breaking byte-identical re-fold (each
 * job carries at most one `handoff-from` + one `handoff-to`, but the locked
 * total order is what keeps the bytes stable).
 */
function sortHandoffLinks(links: HandoffLinkEntry[]): void {
  links.sort((a, b) => {
    if (a.kind < b.kind) return -1;
    if (a.kind > b.kind) return 1;
    if (a.handoff_id < b.handoff_id) return -1;
    if (a.handoff_id > b.handoff_id) return 1;
    return 0;
  });
}

/**
 * Enrich a `(kind, handoff_id, peer_job_id, status)` tuple into the widened
 * {@link HandoffLinkEntry} carried on `jobs.handoff_links`, denormalizing the
 * peer job's display + annotation fields off its post-write `jobs` row at the
 * reducer's write boundary so renderers read straight off the projection.
 *
 * On a missing peer `jobs` row (the initiator pane not yet folded, or the callee
 * before its `SessionStart`), returns the re-fold-safe defaults with the api-
 * error columns as explicit JSON nulls (NOT omitted — omitting keys vs. emitting
 * nulls produces different `JSON.stringify` bytes). KEY ORDER IS LOCKED for
 * byte-identical re-fold; the order MUST match {@link HandoffLinkEntry}'s field
 * declaration. NEVER throws inside the transaction. Mirrors {@link enrichJobLink}.
 */
function enrichHandoffLink(
  db: Database,
  kind: HandoffLinkEntry["kind"],
  handoff_id: string,
  peer_job_id: string,
  status: string,
): HandoffLinkEntry {
  const row = db
    .query(
      "SELECT title, state, last_api_error_at, last_api_error_kind, last_input_request_at, last_input_request_kind, last_permission_prompt_at, last_permission_prompt_kind FROM jobs WHERE job_id = ?",
    )
    .get(peer_job_id) as {
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
      kind,
      handoff_id,
      peer_job_id,
      status,
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
    kind,
    handoff_id,
    peer_job_id,
    status,
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
 * Replace-by-key merge of one handoff's entry into a job's `handoff_links`
 * array. MERGE ONLY — drop EVERY entry matching the same `(kind, handoff_id)`,
 * append the freshly-built `replacement`, re-sort by the locked `(kind,
 * handoff_id)` total order. Returns a NEW array; mutates no input. Idempotent
 * and non-additive so a re-fold reproduces the same bytes (an additive append
 * would double). Every OTHER entry is preserved verbatim. Mirrors
 * {@link mergeJobLinkSlice}.
 */
function mergeHandoffLinkSlice(
  existing: readonly HandoffLinkEntry[],
  replacement: HandoffLinkEntry,
): HandoffLinkEntry[] {
  const merged = existing.filter(
    (e) =>
      !(e.kind === replacement.kind && e.handoff_id === replacement.handoff_id),
  );
  merged.push(replacement);
  sortHandoffLinks(merged);
  return merged;
}

/**
 * Write/refresh ONE {@link HandoffLinkEntry} onto a backing `jobs` row's
 * `handoff_links` array. Reads the pre-state array, merges the freshly-enriched
 * entry by `(kind, handoff_id)`, and UPDATEs. NO-OP when the backing jobs row is
 * absent (an orphan endpoint — the initiator pane not yet folded, or a bind
 * before the callee's jobs row): the raw coords / id live on the `handoffs` row
 * regardless, so the edge is half-anchored in that rare case with no backfill.
 * Pure function of the event id + persisted state (the jobs row exists
 * deterministically at this cursor position), so re-fold stays byte-identical.
 * NEVER throws.
 */
function writeHandoffLinkOnJob(
  db: Database,
  jobId: string,
  kind: HandoffLinkEntry["kind"],
  handoff_id: string,
  peer_job_id: string,
  status: string,
  eventId: number,
  ts: number,
): void {
  const jobRow = db
    .query("SELECT handoff_links FROM jobs WHERE job_id = ?")
    .get(jobId) as { handoff_links: string | null } | null;
  if (jobRow == null) {
    return; // orphan endpoint — no backing jobs row to write onto.
  }
  const existing = parseHandoffLinks(jobRow.handoff_links);
  const enriched = enrichHandoffLink(db, kind, handoff_id, peer_job_id, status);
  const merged = mergeHandoffLinkSlice(existing, enriched);
  db.run(
    "UPDATE jobs SET handoff_links = ?, last_event_id = ?, updated_at = ? WHERE job_id = ?",
    [JSON.stringify(merged), eventId, ts, jobId],
  );
}

/**
 * Bind a handoff-ee on its `SessionStart`: the back half of the job→job handoff
 * edge. Called from {@link projectJobsRow}'s SessionStart arm ONLY when the
 * spawn name parsed to a `handoff::<id>` — the AUTHORITATIVE bind signal (the
 * bind EVENT, not the tmux window, which can outlive its process). The callee's
 * `jobs` row was just UPSERTed by the SessionStart arm, so `calleeJobId` is a
 * live row here.
 *
 * Three writes, all pure functions of the event + persisted state:
 *  1. Stamp `handoffs.callee_job_id = calleeJobId`, `status = 'bound'`, and RESET
 *     `never_bound_count = 0` (a worker that binds even once must never trip the
 *     never-bound breaker — mirrors the autopilot discharge-on-bind). The bind
 *     wins over a `dispatching` OR a prior `failed` row: a live process is
 *     attached, so liveness supersedes a never-bound write-off. NO-OP on a
 *     missing handoffs row (a `handoff::` spawn with no matching enqueue — a
 *     stale window; nothing to bind).
 *  2. Write the `handoff-to` {@link HandoffLinkEntry} onto the CALLEE's job row
 *     (peer = the initiator).
 *  3. Re-stamp the `handoff-from` entry on the INITIATOR's job row so its
 *     `peer_job_id` (empty at request time) now points at the bound callee, and
 *     both endpoints carry `status='bound'`.
 *
 * Idempotent: a duplicate SessionStart (a resume) re-stamps the same bytes
 * (status already `bound`, count already 0, links replace-merged by key). Pure —
 * `event.id`/`event.ts` are the only "time"; re-fold byte-identical. NEVER throws.
 */
function bindHandoffOnSessionStart(
  db: Database,
  handoffId: string,
  calleeJobId: string,
  eventId: number,
  ts: number,
): void {
  const row = db
    .query("SELECT initiator_job_id FROM handoffs WHERE handoff_id = ?")
    .get(handoffId) as { initiator_job_id: string | null } | undefined;
  if (row == null) {
    // A `handoff::<id>` spawn with no matching enqueue — a stale window or a
    // hand-typed name. Nothing to bind; leave the projection untouched.
    return;
  }
  db.run(
    `UPDATE handoffs
        SET callee_job_id = ?, status = 'bound', never_bound_count = 0, last_event_id = ?
      WHERE handoff_id = ?`,
    [calleeJobId, eventId, handoffId],
  );
  const initiatorJobId = row.initiator_job_id;
  // 2. handoff-to on the callee — peer is the initiator (may be "" / orphan).
  writeHandoffLinkOnJob(
    db,
    calleeJobId,
    "handoff-to",
    handoffId,
    initiatorJobId ?? "",
    "bound",
    eventId,
    ts,
  );
  // 3. Re-stamp handoff-from on the initiator so its peer now points at the
  // bound callee (it was "" at request time). NO-OP when the initiator job is an
  // orphan / unfolded — the edge is half-anchored by the row's raw coords.
  if (initiatorJobId != null && initiatorJobId.length > 0) {
    writeHandoffLinkOnJob(
      db,
      initiatorJobId,
      "handoff-from",
      handoffId,
      calleeJobId,
      "bound",
      eventId,
      ts,
    );
  }
}

/**
 * Reverse fan-out from a jobs-write that may have changed display / annotation
 * fields on a session whose plan footprint already produced epic-link edges.
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
  // with no plan footprint); the schema default and the reducer's empty
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
    // Replace-by-key via the shared MERGE helper: drop this job_id's entry,
    // splice ONE re-stamped entry carrying the OLD `kind` (the classifier, not
    // the jobs-write, owns creator vs. refiner; this helper only refreshes
    // display fields). Closer/sort/cascade/shell-insert stay per-caller below.
    const next = mergeJobLinkSlice(existing, jobId, [
      { ...enriched, kind: oldEntry.kind },
    ]);
    const jobLinksJson = JSON.stringify(next);
    if (epicRow != null) {
      db.run(
        "UPDATE epics SET job_links = ?, last_event_id = ?, updated_at = ? WHERE epic_id = ?",
        [jobLinksJson, eventId, ts, epicId],
      );
    } else {
      // No epic row yet — shell-insert. The EpicSnapshot ON CONFLICT carve-out
      // preserves `job_links`, so a later snapshot can't wipe the enriched
      // payload.
      db.run(
        `INSERT INTO epics (
           epic_id, epic_number, title, project_dir, status,
           last_event_id, updated_at, tasks, jobs, job_links
         ) VALUES (?, NULL, NULL, NULL, NULL, ?, ?, '[]', '[]', ?)`,
        [epicId, eventId, ts, jobLinksJson],
      );
    }
  }
}

/**
 * Extract the envelope's `state_repo` (the absolute path plan wrote
 * `.keeper/...` into) from the stored event payload. Pure parse; a malformed
 * payload / missing envelope / non-string `state_repo` folds to `null` (the
 * mint is a no-op then), keeping the fold tx sacred.
 */
function extractPlanStateRepo(event: Event): string | null {
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
  // payload `{tool_response:{stdout:"{...plan_invocation...}"}}`, and (2) a
  // top-level inlined envelope (synthetic / test events). Single-path read of
  // `plan_invocation` — the v78 migration rewrote every legacy
  // `planctl_invocation` envelope forward, so no canonical event carries it.
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
        // non-plan event, but the plan_op gate above already ensured
        // this IS a plan envelope, so the stdout should parse. A parse
        // miss here is a malformed payload — fold to null.
        inner = null;
      }
      if (typeof inner === "object" && inner !== null) {
        const innerObj = inner as Record<string, unknown>;
        const env = innerObj.plan_invocation;
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
  const topLevelEnv = obj.plan_invocation;
  if (typeof topLevelEnv === "object" && topLevelEnv !== null) {
    const sr = (topLevelEnv as Record<string, unknown>).state_repo;
    if (typeof sr === "string" && sr.length > 0) {
      return sr;
    }
  }
  return null;
}

/**
 * Mint one `source='plan'` `file_attributions` row per path in the event's
 * `plan_files` array, keyed under the envelope's `state_repo` +
 * `event.session_id` + the repo-relative path. Without it, `.keeper/...` files
 * (written by the plan CLI, not a Claude Write/Edit or recognized bash
 * mutation) would appear as strict-mystery orphans on the next `GitSnapshot`.
 *
 * The `(project_dir, file_path)` tuple MUST match the
 * `(GitSnapshot.project_dir, dirty_files[].path)` tuple downstream:
 * `project_dir = state_repo` (canonical absolute path), `file_path =
 * <repo-relative>`. `worktree_oid` / `worktree_mode` ride NULL — the next
 * GitSnapshot's `refreshWorktreeOidStmt` stamps them. All inputs are pure
 * event-derived, so re-fold is byte-identical. No-op (cursor still advances)
 * when `plan_op` / `plan_files` are absent or `state_repo` can't be
 * lifted. NEVER throws.
 */
function mintPlanFileAttributions(db: Database, event: Event): void {
  // LIVE-ONLY skip-floor: `file_attributions` is producer-fed. A historical
  // plan-file mint (`id <= floor`) no-ops — the boot-seed re-derives current
  // attributions, and the next live GitSnapshot re-mints any still-dirty
  // `.keeper/**` path. Gating here keeps the surface live-only end to end.
  if (event.id <= readGitFloor(db)) {
    return;
  }
  if (event.plan_op == null || event.plan_files == null) {
    return;
  }
  let files: unknown;
  try {
    files = JSON.parse(event.plan_files);
  } catch {
    return;
  }
  if (!Array.isArray(files) || files.length === 0) {
    return;
  }
  const stateRepo = extractPlanStateRepo(event);
  if (stateRepo === null) {
    return;
  }
  // Same UPSERT shape as projectGitStatus pass-1. `worktree_oid` /
  // `worktree_mode` ride NULL (stamped by the next GitSnapshot). The newest-wins
  // UPDATE gate keeps a stale plan event from overwriting a newer attribution.
  const upsertStmt = db.prepare(
    `INSERT INTO file_attributions
       (project_dir, session_id, file_path, last_mutation_at,
        last_commit_at, op, source, last_event_id, updated_at,
        worktree_oid, worktree_mode)
       VALUES (?, ?, ?, ?, NULL, ?, 'plan', ?, ?, NULL, NULL)
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
    // Skip absolute paths (plan emits relative; an absolute path would never
    // match the `dirty_files[].path` tuple and strand as an orphan).
    if (rawPath.startsWith("/")) continue;
    // Skip `..` traversal — defensive against a corrupt envelope.
    if (rawPath.includes("..")) continue;
    upsertStmt.run(
      stateRepo,
      event.session_id,
      rawPath,
      event.ts,
      event.plan_op,
      event.id,
      event.ts,
    );
  }
}

/**
 * Fan a plan-CLI invocation into the `jobs.epic_links` +
 * per-touched-epic `epics.job_links` projections. Parallel to
 * {@link syncJobIntoEpic} but with a disjoint trigger, so the two helpers do
 * NOT share code. Re-derives from scratch on every triggering event
 * (full-replace, never delta-merge) for byte-identical re-fold:
 *
 *   1. Load every plan invocation for `sessionId` — the UNION of the legacy
 *      `events.plan_op` stdout-scrape rows and durable commit-trailer facts
 *      ({@link commitTrailerInvocationsFor}). The classifier dedups, so a
 *      scrape and a commit for the same op collapse to one edge; a scaffold
 *      whose scrape yielded NULL still produces a creator edge via the commit
 *      channel. Each invocation carries its source `event_id` so the
 *      classifier's `(ts, event_id)` total-order sort is deterministic.
 *   2. Compute `epic_links` (windowless — every epic-mutating op links), read
 *      the pre-state, UPDATE the jobs row.
 *   3. For each epic in the pre+post union, re-derive `job_links` over the FULL
 *      per-epic namespace; shell-insert a missing epic row.
 *
 * No-op when the jobs row for `sessionId` doesn't exist (no SessionStart yet).
 * NEVER throws; a malformed stored array folds to `[]`.
 */

/**
 * One session's commit-trailer invocations read via the
 * `idx_commit_trailer_facts_session` index, clamped INCLUSIVE of `maxEventId`.
 * Both `syncPlanLinks` channels use this per-session slice — constant per-event
 * cost independent of board size (there is no whole-table load).
 *
 * The `event_id <= maxEventId` clamp is INCLUSIVE (a DELIBERATE departure from
 * the exclusive `id < currentEventId` clamp used by memos that run AFTER the
 * current event's own row lands): {@link foldCommit} INSERTs THIS commit's own
 * fact into `commit_trailer_facts` BEFORE it calls `syncPlanLinks`, so an
 * exclusive clamp would drop the commit's own creator/refiner edge. The clamp
 * also pins live-fold semantics — a re-fold at `maxEventId` never reads a fact
 * appended by a LATER commit of this session (which would only reconcile if a
 * still-later touch of the epic re-fired, and never does when this event is the
 * epic's last touch).
 *
 * Each row maps to one {@link ClassifierInvocation} with `ts = committed_at_ms /
 * 1000` (so it falls inside the open-ended final `/plan:plan` window),
 * `epic_id` the stored `plan_epic_id` (frozen at write time via the same
 * target→epic split the scrape deriver uses), and `subject_present = true` (a
 * trailer only rides a mutating chore commit). `ORDER BY event_id ASC`
 * preserves the historical total order the classifier's ts-tie dedup depends
 * on. A commit-only session (no scrape-side rows) still returns its facts.
 * Pure indexed read; never throws.
 */
function commitTrailerInvocationsForSession(
  db: Database,
  sessionId: string,
  maxEventId: number,
): ClassifierInvocation[] {
  const rows = db
    .query(
      `SELECT event_id, plan_op, plan_target, plan_epic_id, committed_at_ms
         FROM commit_trailer_facts
        WHERE committer_session_id = ? AND event_id <= ?
        ORDER BY event_id ASC`,
    )
    .all(sessionId, maxEventId) as {
    event_id: number;
    plan_op: string;
    plan_target: string;
    plan_epic_id: string | null;
    committed_at_ms: number;
  }[];
  return rows.map((r) => ({
    ts: r.committed_at_ms / 1000,
    op: r.plan_op,
    target: r.plan_target,
    epic_id: r.plan_epic_id,
    subject_present: true,
    event_id: r.event_id,
  }));
}

function syncPlanLinks(
  db: Database,
  sessionId: string,
  eventId: number,
  ts: number,
): void {
  // The backing jobs row must exist for an epic_links UPDATE to land. A plan
  // invocation in a session with no SessionStart is an orphan; skip the
  // jobs-side write but still re-derive every touched epic's job_links so
  // symmetry holds. The row's presence gates ONLY the jobs-side write below —
  // BOTH paths re-derive each touched epic's job_links via the SAME per-session
  // replace-by-key merge, bounded to O(local degree). The orphan path no longer
  // runs a cross-session sweep: it used to re-derive every touched epic over
  // EVERY session that ever touched it (a whole-table commit-facts load + a
  // cross-session events scan + an O(touchedEpics × sessions) re-derive) — an
  // O(history × board) re-fold time-bomb, the documented 437s incident. The
  // strategy is a pure function of the event id (the jobs row exists
  // deterministically at this cursor position), so re-fold stays byte-identical.
  const jobsRow = db
    .query("SELECT epic_links FROM jobs WHERE job_id = ?")
    .get(sessionId) as { epic_links: string | null } | null;
  const isOrphan = jobsRow == null;

  // This session's commit-trailer facts — the SAME per-session slice for both
  // channels, read via the per-session index and clamped INCLUSIVE of the
  // current event (see {@link commitTrailerInvocationsForSession}). Constant
  // per-event cost regardless of board size.
  const _splFactsT0 = _syncPlanLinksAccum != null ? performance.now() : 0;
  const thisSessionCommitFacts = commitTrailerInvocationsForSession(
    db,
    sessionId,
    eventId,
  );
  if (_syncPlanLinksAccum != null) {
    _syncPlanLinksAccum.calls += 1;
    _syncPlanLinksAccum.factsLoadMs += performance.now() - _splFactsT0;
    _syncPlanLinksAccum.factsRows += thisSessionCommitFacts.length;
  }

  // Load this session's plan invocations (ASC by event id — the `id` doubles as
  // the classifier's total-order tiebreak on `ts`-ties), clamped INCLUSIVE of
  // the current event id. Live-fold semantics: the fold at `eventId` must see
  // ONLY `id <= eventId`, so a re-fold (whole log present) never reads a FUTURE
  // invocation of this session. The old unbounded read was safe only because a
  // later touch reconciled — which fails exactly when this event is an epic's
  // LAST touch. The partial composite index serves this without a full scan.
  const invRows = db
    .query(
      `SELECT id, ts, plan_op, plan_target, plan_epic_id,
              plan_subject_present
         FROM events
        WHERE session_id = ? AND plan_op IS NOT NULL AND id <= ?
        ORDER BY id ASC`,
    )
    .all(sessionId, eventId) as {
    id: number;
    ts: number;
    plan_op: string;
    plan_target: string | null;
    plan_epic_id: string | null;
    plan_subject_present: number | null;
  }[];
  const invocations: ClassifierInvocation[] = invRows.map((r) => ({
    ts: r.ts,
    op: normalizePlanOp(r.plan_op),
    target: r.plan_target,
    epic_id: r.plan_epic_id,
    subject_present: r.plan_subject_present === 1,
    event_id: r.id,
  }));
  // UNION the durable commit-trailer facts — the classifier dedups, so a scrape
  // and a commit for the same scaffold collapse to one creator edge, and a
  // scrape-NULL scaffold's commit fact alone still mints it.
  invocations.push(...thisSessionCommitFacts);

  // Compute the new epic_links from scratch (full-replace, never delta-merge —
  // delta-merge would double on re-fold). Windowless: every epic-mutating op
  // links regardless of `/plan:plan` timing; the read-only gate is the only skip.
  const newEpicLinks = deriveEpicLinks(invocations);
  sortEpicLinks(newEpicLinks);

  // Read the pre-state epic_links so we know which epics' job_links need a
  // re-derive (every target that appears in EITHER pre or post — a removed
  // edge still needs its epic's job_links updated to drop the stale entry). An
  // orphan has no jobs row, so its pre-state is empty — identical to the prior
  // orphan behavior, which also read `[]` here; edges only ever accrete (no
  // unlink op exists), so a post-only touched set drops nothing.
  const preEpicLinks =
    jobsRow != null ? parseEmbeddedLinks<EpicLink>(jobsRow.epic_links) : [];
  const touchedEpics = new Set<string>();
  for (const link of preEpicLinks) {
    touchedEpics.add(link.target);
  }
  for (const link of newEpicLinks) {
    touchedEpics.add(link.target);
  }
  if (_syncPlanLinksAccum != null) {
    _syncPlanLinksAccum.touchedEpics += touchedEpics.size;
    // Each call now processes exactly ITS session's slice — no cross-session
    // sweep. Recorded as 1 so a value above `calls` flags a fan-out regression.
    _syncPlanLinksAccum.sweptSessions += 1;
  }

  // UPDATE the jobs row's epic_links. Skip on the orphan path (no backing row —
  // no SessionStart for this session_id yet); this is the ONLY branch `isOrphan`
  // gates now that both paths share the per-session merge below.
  if (!isOrphan) {
    db.run(
      "UPDATE jobs SET epic_links = ?, last_event_id = ?, updated_at = ? WHERE job_id = ?",
      [JSON.stringify(newEpicLinks), eventId, ts, sessionId],
    );
  }

  if (touchedEpics.size === 0) {
    return;
  }

  // This session's single-session slice input: its scrape invocations UNIONed
  // with its commit-trailer facts (the two-channel union), keyed under the
  // triggering session id. Fed to `deriveJobLinks` per touched epic so the
  // classifier emits exactly this session's creator/refiner edge for the merge.
  const thisSessionSlice = new Map([[sessionId, invocations]]);

  // Re-derive job_links for each touched epic via the per-session replace-by-key
  // merge and UPDATE the epic row (shell-insert a missing one), inside the same
  // transaction for byte-identical re-fold. The merge drops THIS session's
  // entries from the stored array, splices its freshly-derived+enriched slice,
  // and preserves every OTHER session's entry VERBATIM. The enrichment-freshness
  // invariant — every enriched-column jobs-write already fans out via
  // `syncJobLinksOnJobWrite` — makes the preserved entries byte-identical to a
  // full cross-session re-derive, for the ORPHAN path as much as the normal one
  // (the removed sweep was pre-merge-era conservatism, not a correctness need;
  // every session touching this epic already re-derived it in id order, so the
  // stored array is complete for all sessions but this one). Enrichment is
  // limited to THIS session's spliced entries.
  const _splDeriveT0 = _syncPlanLinksAccum != null ? performance.now() : 0;
  for (const epicId of touchedEpics) {
    // Pre-filter tombstoned epics before the derive loop: a deleted epic gets no
    // job_links UPDATE / shell-insert (it would resurrect a ghost row). An
    // UPDATE on a missing/deleted row would be a no-op, so the skip is the same
    // net effect.
    if (isEpicTombstoned(db, epicId)) {
      continue;
    }

    const epicRow = db
      .query("SELECT job_links FROM epics WHERE epic_id = ?")
      .get(epicId) as { job_links: string | null } | null;
    const existing =
      epicRow != null
        ? parseEmbeddedLinks<JobLinkEntry>(epicRow.job_links)
        : [];
    const sliceLinks = deriveJobLinks(thisSessionSlice, epicId);
    const sliceEnriched = sliceLinks.map((e) => enrichJobLink(db, e));
    const enriched = mergeJobLinkSlice(existing, sessionId, sliceEnriched);
    const jobLinksJson = JSON.stringify(enriched);

    const epicExists = db
      .query("SELECT epic_id FROM epics WHERE epic_id = ?")
      .get(epicId) as { epic_id: string } | null;
    if (epicExists != null) {
      db.run(
        "UPDATE epics SET job_links = ?, last_event_id = ?, updated_at = ? WHERE epic_id = ?",
        [jobLinksJson, eventId, ts, epicId],
      );
    } else {
      // Shell-insert: no epic row yet. Routed through the tombstone-checking
      // helper — a plan-event-before-epic shell for a deleted epic is
      // suppressed.
      insertEpicShellIfNotTombstoned(
        db,
        epicId,
        `INSERT INTO epics (
           epic_id, epic_number, title, project_dir, status,
           last_event_id, updated_at, tasks, jobs, job_links
         ) VALUES (?, NULL, NULL, NULL, NULL, ?, ?, '[]', '[]', ?)`,
        [epicId, eventId, ts, jobLinksJson],
      );
    }
  }
  if (_syncPlanLinksAccum != null) {
    _syncPlanLinksAccum.deriveJobLinksMs += performance.now() - _splDeriveT0;
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
    resolved_epic_deps: null,
    question: null,
    blocks_closing_of: null,
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
 * Called from the EpicSnapshot arm AFTER the consumer's row settles but BEFORE
 * the reverse fan-out.
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
      // touched here — precedence-owned / set-once identity. `cwd` stays
      // set-once at this insert for the row's life. `transcript_path` is seeded
      // here on first sight but from then on moves ONLY on proven-live activity
      // (UserPromptSubmit / Stop via `refreshTranscriptPathFromActivity`): a
      // bare SessionStart — including the SessionStart(+SessionEnd) pair a
      // FAILED resume emits — carries no liveness proof, so it can never clobber
      // the last good path with a predicted-but-never-created one.
      {
        // Derive `plan_verb`/`plan_ref` from the spawn name via the shared pure
        // parser; NULL on any name outside the `{plan|work|close}::<ref>`
        // whitelist. The pair is COALESCE-filled on the ON CONFLICT branch:
        // fill-only-when-NULL, so a genuine resume (pair already set) is left
        // untouched, but a row seeded with a NULL pair — e.g. a fork-seed minted
        // by an out-of-order UserPromptSubmit before this SessionStart — heals
        // to the parsed pair. (`planVerbRefFromSpawnName` returns both-or-
        // neither, so the two columns never desync.)
        const { plan_verb, plan_ref } = planVerbRefFromSpawnName(
          event.spawn_name,
        );
        // Discharge-on-bind gating: read the jobs row's PRIOR pair BEFORE the
        // UPSERT. This distinguishes a spawn-INSERT (no prior row) from a resume
        // ON CONFLICT, AND captures whether the prior pair was NULL — the heal
        // transition. The discharge fires on a spawn-INSERT OR a NULL->non-NULL
        // heal, but NOT on a genuine resume (prior pair already set) which must
        // NOT clear a legitimately re-pending dispatch. The "was-NULL" half MUST
        // read the PRE-UPSERT value here — a post-UPSERT read is always non-NULL
        // after the COALESCE and would wrongly discharge every resume. The
        // pre-INSERT SELECT is pure, so re-fold determinism holds. A seed row
        // returns `{ plan_verb: null, plan_ref: null }` (not `null`), so
        // `isSpawnInsert` stays keyed on row ABSENCE.
        const priorJob = db
          .query("SELECT plan_verb, plan_ref FROM jobs WHERE job_id = ?")
          .get(jobId) as {
          plan_verb: string | null;
          plan_ref: string | null;
        } | null;
        const isSpawnInsert = priorJob == null;
        // Seed `name_history` with `["<spawn_name>"]` on the spawn INSERT (else
        // `'[]'`). RESUME is a no-touch (no `name_history` clause in the UPDATE
        // SET); the title precedence-write block is the only path that appends.
        const spawnNameHistory =
          event.spawn_name != null ? JSON.stringify([event.spawn_name]) : "[]";
        db.run(
          `INSERT INTO jobs (job_id, created_at, cwd, pid, start_time, last_event_id, updated_at, title, title_source, transcript_path, plan_verb, plan_ref, config_dir, profile_name, name_history, worktree, harness, resume_target, adopted, account_route)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(job_id) DO UPDATE SET
             pid = COALESCE(excluded.pid, jobs.pid),
             start_time = COALESCE(excluded.start_time, jobs.start_time),
             config_dir = COALESCE(excluded.config_dir, jobs.config_dir),
             -- Set-once durable worktree-lane marker: a resume RE-INJECTS the
             -- same lane branch env (resume-mode launch still carries
             -- KEEPER_PLAN_WORKTREE_BRANCH), so excluded.worktree is that same
             -- branch — COALESCE is set-once and idempotent either way (mirrors
             -- config_dir). MUST stay on THIS SessionStart arm (never the
             -- every-event backend_exec arm): only SessionStart captures the
             -- lane env, so it is the sole arm whose excluded.worktree is ever
             -- non-NULL.
             worktree = COALESCE(excluded.worktree, jobs.worktree),
             -- v107 (fn-1103.3): latest-non-NULL-wins for the harness tag and the
             -- resume target, mirroring worktree/config_dir. A claude resume
             -- re-stamps harness "claude" (idempotent); a legacy NULL-harness row
             -- resumed post-upgrade heals to "claude" (still correct — it IS
             -- claude). The fold copies the event value verbatim and never
             -- synthesizes, so a NULL excluded.harness preserves the prior value.
             -- resume_target stays on THIS SessionStart arm ONLY for claude/pi's
             -- own seed value; a codex/hermes back-fill flows through the separate
             -- ResumeTargetResolved arm precisely so it can never trip this arm's
             -- terminal-row revive (killed -> stopped) semantics.
             harness = COALESCE(excluded.harness, jobs.harness),
             resume_target = COALESCE(excluded.resume_target, jobs.resume_target),
             -- v110 (fn-1131.1): set-once ADOPTED marker, mirroring worktree. The
             -- claude hook + every birth mint carry excluded.adopted NULL
             -- (launcher-owned), so COALESCE preserves an adopted marker a prior
             -- non-launcher mint (hermes self-seed / codex rollout) set — a later
             -- resume or a racing launcher re-mint NEVER clobbers it. The fold
             -- copies the event value verbatim and never synthesizes, so a NULL
             -- excluded leaves the prior value (NULL stays NULL, 1 stays 1).
             adopted = COALESCE(excluded.adopted, jobs.adopted),
             -- v119 (fn-1239.3): latest-non-NULL-wins per-process account-route
             -- attribution, mirroring config_dir/worktree/adopted. A resume
             -- carrying a route (excluded.account_route non-NULL) re-stamps this
             -- process's route; a resume that carried none (NULL) preserves the
             -- prior launch's value. The fold copies the event value verbatim and
             -- NEVER synthesizes one — so attribution stays observational and no
             -- prior route ever binds a conversation or drives a later choice.
             account_route = COALESCE(excluded.account_route, jobs.account_route),
             -- Schema v36: track config_dir's nullability — a resume carrying
             -- a NULL config_dir derives a NULL excluded.profile_name, so
             -- COALESCE preserves the seeded name (mirrors config_dir above).
             profile_name = COALESCE(excluded.profile_name, jobs.profile_name),
             -- Re-open a TERMINAL row on resume, gated by the ADR-0013 lifecycle
             -- stamp. This is a revival (terminal -> stopped), so it takes the
             -- ACTIVATING polarity (strictly ts > stamp) it shares with the
             -- UserPromptSubmit prompt-revival: a stale/duplicate SessionStart
             -- whose ts has not advanced past the terminal event's stamp must
             -- NOT resurrect a genuinely-dead session. A live working/stopped row
             -- is left untouched (the CASE ELSE), and a fresh INSERT seeds a NULL
             -- stamp (not in the column list) that the first real lifecycle event
             -- advances. The stamp CASE mirrors the state CASE so it advances ONLY
             -- on the re-open, keeping a non-revival resume re-fold-stable.
             state = CASE WHEN jobs.state IN ('${ENDED}','${KILLED}') AND ${lifecycleStampGate("activate", "jobs.last_lifecycle_ts")} THEN 'stopped' ELSE jobs.state END,
             last_lifecycle_ts = CASE WHEN jobs.state IN ('${ENDED}','${KILLED}') AND ${lifecycleStampGate("activate", "jobs.last_lifecycle_ts")} THEN ? ELSE jobs.last_lifecycle_ts END,
             -- Heal-on-resume: COALESCE-fill the plan correlator. The existing
             -- jobs column FIRST = fill-only-when-NULL, so a genuine resume's
             -- already-bound pair is preserved (set-once), but a row seeded with
             -- a NULL pair (an out-of-order UserPromptSubmit fork-seed that
             -- minted the row before this SessionStart folded) heals to the
             -- parsed excluded pair. Both columns fill together — the parser
             -- returns both-or-neither, honoring the paired-NULL invariant.
             plan_verb = COALESCE(jobs.plan_verb, excluded.plan_verb),
             plan_ref = COALESCE(jobs.plan_ref, excluded.plan_ref),
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
            // NULL config_dir → NULL profile_name, so the column tracks
            // `jobs.config_dir`'s own nullability under the resume COALESCE.
            event.config_dir == null ? null : projectBasename(event.config_dir),
            spawnNameHistory,
            event.worktree,
            event.harness,
            event.resume_target,
            event.adopted,
            event.account_route,
            // The three trailing `?` bind the ADR-0013 lifecycle-stamp gate + set
            // value added to the ON CONFLICT DO UPDATE re-open above (state-CASE
            // gate, stamp-CASE gate, stamp value) — all the event ts. The DO
            // UPDATE SET binds no other `?`, so these follow the INSERT VALUES in
            // positional order.
            ts,
            ts,
            ts,
          ],
        );
        // Discharge-on-bind: fires on a spawn-INSERT OR a NULL->non-NULL heal
        // (a fork-seed row whose prior pair was NULL, now filled by the
        // COALESCE above), but NEVER on a genuine resume whose pair was already
        // bound (that must not clear a legitimately re-pending dispatch). A
        // successful bind means the autopilot's `Dispatched` intent materialized
        // into a real job, so the launch-window slot is reaped. The "was-NULL"
        // half reads the PRE-UPSERT `priorJob.plan_ref` — a post-UPSERT read is
        // always non-NULL after the COALESCE and would wrongly fire on resume.
        // The DELETE keys on the just-parsed `(plan_verb, plan_ref)`, which
        // equals the COALESCEd result because the heal branch fires only when
        // the prior pair was NULL. Idempotent DELETE (no-op when no pending
        // row). Pure fold.
        if (
          (isSpawnInsert || priorJob.plan_ref == null) &&
          plan_verb != null &&
          plan_ref != null
        ) {
          const dischargeRes = db.run(
            "DELETE FROM pending_dispatches WHERE verb = ? AND id = ?",
            [plan_verb, plan_ref],
          );
          // Provenance stamp: the ONLY airtight autopilot-vs-manual
          // discriminator. Gate on the ACTUAL discharge — `dischargeRes.changes`
          // read HERE, before the sibling `dispatch_never_bound` DELETE below
          // overwrites the changes counter — NEVER on `plan_verb`/`plan_ref`
          // presence: a manual `keeper dispatch work::fn-N.M` is plan-form but
          // mints no `Dispatched` event and thus no pending row (`cli/dispatch.ts`
          // only READS the table as a race guard), so its discharge removes
          // nothing and the row correctly stays NULL (= manual/unknown). A removed
          // row means the autopilot's `Dispatched` intent materialized into this
          // job, so it is autopilot-owned. The `Dispatched` event precedes this
          // binding SessionStart in the log, so a from-scratch re-fold reproduces
          // the same discharge and the same stamp byte-identically. The enclosing
          // UPSERT already wrote this row's `last_event_id`/`updated_at` to this
          // event in the same fold, so this narrow set-once UPDATE need not touch
          // them. Pure fold.
          if (dischargeRes.changes > 0) {
            db.run(
              "UPDATE jobs SET dispatch_origin = 'autopilot' WHERE job_id = ?",
              [jobId],
            );
          }
          // Never-bound circuit-breaker reset: a successful bind for this pair
          // zeroes the consecutive-no-bind counter (DELETE), so a bind between
          // expires never trips the breaker and a "bound-then-died" worker (whose
          // death is the exit-watcher's path) never counts toward never-bound.
          // Same discharge gate as the pending DELETE above — fires on spawn-
          // INSERT or NULL->non-NULL heal, never on a genuine resume. Idempotent.
          db.run("DELETE FROM dispatch_never_bound WHERE verb = ? AND id = ?", [
            plan_verb,
            plan_ref,
          ]);
        }
        // Escalation-instance binding: an `unblock::<task>` / `deconflict::<epic>`
        // / `resolve::<epic>` session is a first-class dispatch key
        // (`planVerbRefFromSpawnName` returns its verb), but it is dispatched by a
        // daemon escalation sweep that mints NO `Dispatched`/`pending_dispatches`
        // row — so it NEVER trips the discharge gate above and its
        // `dispatch_origin` would otherwise stay NULL. This branch is STRUCTURALLY
        // SEPARATE from that gate: gated on the SAME spawn-INSERT-or-heal condition
        // (never a genuine resume, so the stamp is set-once, COALESCE-preserved),
        // it CORROBORATES the spawn name against the PRIOR deterministic projection
        // and — only on a hit — stamps `dispatch_origin='escalation'` + the
        // `escalation_instance` id TOGETHER. Both-or-neither: a corroboration MISS
        // (e.g. the task cycled unblocked→re-blocked before this SessionStart
        // folded, so the latch re-armed with a NULL outcome) leaves BOTH NULL —
        // stamping origin off the name alone would be the heuristic the design
        // forbids. The corroborating event (the `BlockEscalationAttempted`
        // 'dispatched', the merge-escalation stamp, or the resolver-dispatch stamp)
        // ALWAYS precedes this binding SessionStart in total order, so the fold
        // reads only prior projections + the event's own spawn name — re-fold-
        // deterministic including the miss case.
        if (
          (isSpawnInsert || priorJob.plan_ref == null) &&
          plan_verb != null &&
          plan_ref != null &&
          (plan_verb === "unblock" ||
            plan_verb === "deconflict" ||
            plan_verb === "resolve")
        ) {
          let escalationInstance: number | null = null;
          if (plan_verb === "unblock") {
            // unblock::<task> — corroborate the block_escalations latch whose
            // `unblock::<task>` session was dispatched for this task. The latch PK
            // is (epic_id, task_id) and a task_id is globally unique across epics,
            // so the task_id-only read resolves the one row. Instance = the latch's
            // `blocked_since` (the event id that ARMED this blocked episode — a
            // re-block after an unblock opens a NEW instance with a new id).
            const latch = db
              .query(
                "SELECT blocked_since FROM block_escalations WHERE task_id = ? AND outcome = 'dispatched'",
              )
              .get(plan_ref) as { blocked_since: number } | null;
            escalationInstance = latch?.blocked_since ?? null;
          } else if (plan_verb === "deconflict") {
            // deconflict::<id> — corroborate the sticky row whose merge was
            // human-escalated (`merge_escalated_at` set). Instance = the row's
            // first-appearance `instance_event_id`. `verb IN ('close','work')`: a
            // `deconflict::<epic>` matches the close row (epic id), a
            // `deconflict::<taskId>` the work fan-in row (task id) — the two id
            // namespaces are disjoint, so at most one row matches, and a legacy
            // close event resolves the same close row as before (re-fold-identical).
            const row = db
              .query(
                "SELECT instance_event_id FROM dispatch_failures WHERE verb IN ('close', 'work') AND id = ? AND merge_escalated_at IS NOT NULL",
              )
              .get(plan_ref) as { instance_event_id: number | null } | null;
            escalationInstance = row?.instance_event_id ?? null;
          } else {
            // resolve::<id> — corroborate the sticky row whose resolver was dispatched
            // (`resolver_dispatched_at` set). Instance = the SAME first-appearance
            // `instance_event_id`. Same `verb IN ('close','work')` disjoint-namespace
            // match as the deconflict arm above.
            const row = db
              .query(
                "SELECT instance_event_id FROM dispatch_failures WHERE verb IN ('close', 'work') AND id = ? AND resolver_dispatched_at IS NOT NULL",
              )
              .get(plan_ref) as { instance_event_id: number | null } | null;
            escalationInstance = row?.instance_event_id ?? null;
          }
          // Both-or-neither: stamp origin + instance TOGETHER, only on a hit. A
          // miss (NULL instance) leaves both columns NULL — the design forbids a
          // name-only stamp. The narrow UPDATE need not touch last_event_id /
          // updated_at (the enclosing UPSERT already wrote them for this event).
          if (escalationInstance != null) {
            db.run(
              "UPDATE jobs SET dispatch_origin = 'escalation', escalation_instance = ? WHERE job_id = ?",
              [escalationInstance, jobId],
            );
          }
        }
        // Handoff bind: a `handoff::<id>` spawn name is a SEPARATE spawn-name
        // class from the `{plan,work,close}::` plan verbs (it carries no plan
        // ref — `planVerbRefFromSpawnName` returned NULL above, so the discharge
        // block did not fire). Bind the handoff-ee to its `handoffs` row here,
        // AFTER the callee's jobs row was UPSERTed (so the back-link can enrich
        // off it). Pure parse + projection reads — re-fold byte-identical.
        const handoffId = handoffIdFromSpawnName(event.spawn_name);
        if (handoffId != null) {
          bindHandoffOnSessionStart(db, handoffId, jobId, event.id, ts);
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
      // Fork attribution: a `claude --fork-session` session gets a NEW session
      // id that NEVER emits a SessionStart (the SessionStart fired under the
      // PARENT id; every subsequent event carries the fork's new id). Without a
      // mint the fold's other arms — all `UPDATE … WHERE job_id = ?` — silently
      // no-op, so the fork is invisible to the board and `restore.json`. Seed a
      // minimal STANDALONE row here so the fork becomes a normal job: the
      // `UPDATE` directly below immediately flips state 'stopped' → 'working'
      // and stamps `active_since = ts` (the `CASE WHEN state != 'working'` arm),
      // identical to a normal session's first-prompt transition; the
      // backend-coords fold and post-switch title rule then enrich the now-
      // present row.
      //
      // `ON CONFLICT(job_id) DO NOTHING` (not `INSERT OR IGNORE`): skips only
      // the PK conflict — when a real SessionStart later arrives it hydrates
      // pid/start_time/config_dir — while still surfacing any real NOT NULL /
      // CHECK violation. Guarded by `event.pid != null`: a NULL-pid event
      // (notably the daemon-synthesized `TranscriptTitle`) would mint an
      // unwatchable ghost row the reapers immediately kill; a real-pid +
      // NULL-start_time row is the existing loose-pid-only match the seed
      // sweep and exit watcher already leave alone. Self-contained upsert —
      // no pre-SELECT of projection state — and reads ONLY event fields, so a
      // from-scratch re-fold reproduces the minted row byte-identically.
      if (event.pid != null) {
        db.run(
          `INSERT INTO jobs (job_id, created_at, cwd, pid, last_event_id, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(job_id) DO NOTHING`,
          [jobId, ts, event.cwd, event.pid, event.id, ts],
        );
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
      //
      // ADR 0013 lifecycle-stamp gate: this revival is ACTIVATING (-> working),
      // so it requires strictly `ts > stamp` — a stale prompt straggler whose ts
      // has regressed behind the stamp can NEVER resurrect the row (it shares the
      // exact stale-arrival race the phantom-working bug rode in on). A genuine
      // prompt whose ts EXACTLY equals the stamp is swallowed here, which is
      // acceptable: the turn's following tool events carry newer ts and revive
      // the row through the bare un-stop arm. On a gated-out (swallowed) prompt
      // the whole UPDATE no-ops — the annotation clears and pid refresh defer to
      // the next non-stale event — so `syncIfPlanRef` is gated on `changes > 0`
      // to keep the swallowed transition re-fold-stable (no stale re-fan).
      const upsRes = db.run(
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
                         active_since = CASE
                           WHEN state != 'working' THEN ?
                           ELSE active_since
                         END,
                         last_lifecycle_ts = ?,
                         last_event_id = ?, updated_at = ?
           WHERE job_id = ? AND ${lifecycleStampGate("activate")}`,
        [event.pid, event.pid, event.pid, ts, ts, event.id, ts, jobId, ts],
      );
      if (upsRes.changes > 0) {
        syncIfPlanRef(db, jobId, event.id, ts);
      }
      // Proven-live activity: refresh transcript_path off this event's live
      // value when it drifted (rehome/resume). Change-gated no-op otherwise.
      refreshTranscriptPathFromActivity(db, event, jobId);
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
      // approval-notify. So skip the state flip while a fresh in-flight subagent
      // survives — `findFreshInFlightSubagentAnchor` applies the canonical
      // open-turn predicate (so a backgrounded `ok` sub still blocks), the
      // same-name collapse (a higher-turn_seq sibling masks an orphan), and the
      // `MAX_STOP_YIELD_GAP_SEC` freshness bound anchored on last-activity
      // `updated_at`. Pure over the event log (re-fold deterministic).
      if (
        findFreshInFlightSubagentAnchor(
          db,
          jobId,
          MAX_STOP_YIELD_GAP_SEC,
          event.ts,
        )
      ) {
        break;
      }
      // ADR 0013 lifecycle-stamp gate: this quiescence (-> stopped) applies at
      // `ts >= stamp`, so a stale Stop straggler whose ts has regressed behind
      // the stamp is swallowed (no flip, no stamp advance, no re-fan) — it can
      // never stop a session a newer event already proved live. Composes AFTER
      // the terminal + sub-agent-yield guards above (it replaces neither).
      const res = db.run(
        `UPDATE jobs SET state = 'stopped', last_lifecycle_ts = ?,
                         last_event_id = ?, updated_at = ?
           WHERE job_id = ? AND state NOT IN ('${ENDED}','${KILLED}')
             AND ${lifecycleStampGate("quiesce")}`,
        [ts, event.id, ts, jobId, ts],
      );
      // Sync only when the UPDATE actually wrote — a guarded no-op must NOT
      // re-fan a stale-but-unchanged element with the new event_id.
      if (res.changes > 0) {
        syncIfPlanRef(db, jobId, event.id, ts);
      }
      // Proven-live activity: a Stop is emitted by a live process, so refresh
      // transcript_path off its live value when it drifted. Change-gated no-op
      // otherwise. Runs UNGATED by the terminal/sub-agent guards above: a Stop
      // reaching this arm at all is liveness evidence, and the helper's own
      // change-gate WHERE never resurrects or re-fans a row.
      refreshTranscriptPathFromActivity(db, event, jobId);
      break;
    }

    case "SessionEnd": {
      // The terminal guard keeps this idempotent on 'ended' AND prevents a late
      // SessionEnd from clobbering a 'killed' row (the killed signal carries
      // proven-dead evidence and outranks). The process guard treats SessionEnd
      // as evidence from one process: a resumed session can share the same
      // session id while another process's close event is still in flight, so a
      // mismatched pid must leave the live row untouched while the cursor still
      // advances. When start_time is present on the event, it tightens the same
      // identity check; current hooks usually stamp it only on SessionStart, so
      // pid remains the mandatory process-scoped guard.
      //
      // Clears `monitors='[]'` in the same UPDATE (terminal jobs have no live
      // monitors). NULLs the backend-exec pane + generation coords too: tmux
      // recycles `%N`, so a dead job that keeps its pane id would be
      // mis-attributed as owning the live window that later inherits it (the
      // post-switch COALESCE arm carries a matching terminal guard so a late
      // hook event can't re-stamp the pane). Matches zero rows for a terminal
      // event with no prior SessionStart — a correct no-op.
      // ADR 0013: a terminal arm keeps its identity/terminal guards and is EXEMPT
      // from stamp REJECTION (a row pinned by a bogus far-future ts must stay
      // healable), but STILL advances the stamp via `MAX` so it never regresses —
      // hence the `MAX(COALESCE(...))`, not the bare `= ?` the rejection-gated
      // arms use.
      const res = db.run(
        `UPDATE jobs SET state = 'ended', monitors = '[]',
                         backend_exec_pane_id = NULL,
                         backend_exec_generation_id = NULL,
                         last_lifecycle_ts = MAX(COALESCE(last_lifecycle_ts, ?), ?),
                         last_event_id = ?, updated_at = ?
           WHERE job_id = ? AND state NOT IN ('${ENDED}','${KILLED}')
             AND (pid IS NULL OR (? IS NOT NULL AND pid = ?))
             AND (start_time IS NULL OR ? IS NULL OR start_time = ?)`,
        [
          ts,
          ts,
          event.id,
          ts,
          jobId,
          event.pid,
          event.pid,
          event.start_time,
          event.start_time,
        ],
      );
      if (res.changes > 0) {
        sweepRunningSubagentsToUnknown(db, jobId, event.id, ts);
        syncIfPlanRef(db, jobId, event.id, ts);
        // Force the embedded occupancy fact to `false`: the `monitors='[]'`
        // clear makes the source false, but `buildEmbeddedJob`'s carve-out
        // would otherwise PRESERVE a stale `true` into the terminal element.
        clearEmbeddedMonitorFactOnTerminal(db, jobId, event.id, ts);
        // A clean SessionEnd is the normal completion exit — NEVER an instant
        // death. RESETS the instant-death counter (a completion is real progress
        // that breaks the consecutive-fast-death streak).
        foldInstantDeathTerminal(db, event, jobId, false);
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
        // NULL the backend-exec pane + generation coords on the terminal flip
        // (same recycle-guard rationale as SessionEnd): a dead job must not keep
        // a tmux pane id `%N` that a fresh window can inherit, or it gets
        // mis-attributed as owning that live window.
        // ADR 0013: terminal arm — exempt from stamp REJECTION (the JS identity
        // guards above already gated it; a far-future-pinned row must stay
        // healable to 'killed'), but still advances the stamp via `MAX` so it
        // never regresses.
        db.run(
          `UPDATE jobs SET state = 'killed', monitors = '[]', close_kind = ?,
                           kill_reason = ?,
                           backend_exec_pane_id = NULL,
                           backend_exec_generation_id = NULL,
                           last_lifecycle_ts = MAX(COALESCE(last_lifecycle_ts, ?), ?),
                           last_event_id = ?, updated_at = ?
             WHERE job_id = ?`,
          [payload.close_kind, payload.reason, ts, ts, event.id, ts, jobId],
        );
        // Sweep + sync + clear fire ONLY here, on the proven write path. The
        // earlier `break` arms (malformed / missing / stale) MUST NOT — no
        // lifecycle write happened, so any of them would be a spurious mutation.
        sweepRunningSubagentsToUnknown(db, jobId, event.id, ts);
        syncIfPlanRef(db, jobId, event.id, ts);
        clearEmbeddedMonitorFactOnTerminal(db, jobId, event.id, ts);
        // Instant-death circuit breaker: an ABRUPT proven death. If the job had
        // bound-and-worked and died within the sub-minute wall window, this
        // increments the consecutive-instant-death count (and mints the sticky at
        // K); a long-lived death resets it. On the proven write path only.
        foldInstantDeathTerminal(db, event, jobId, true);
      }
      break;

    case "StopReconciled":
      // ADR 0013 layer 3: the corrective quiescence the stuck-state sentinel
      // producer mints when a `working` row is a proven logical contradiction —
      // a worker-done task (or a very-stale live-pid session) whose row never
      // folded back to `stopped` because its stamp was pinned by an out-of-order
      // straggler. Deliberately NOT `Killed`: the exit-watcher is the sole Killed
      // producer, `killed` fails the `stopped`-only autoclose gate, and killing
      // mislabels completed work — this only quiesces so autoclose can reap it.
      //
      // A quiescing (-> stopped) transition that, like the terminal arms, is
      // EXEMPT from stamp REJECTION (a phantom row pinned by a bogus far-future ts
      // must stay healable) but still ADVANCES the stamp via MAX so it never
      // regresses, and respects the terminal WHERE guard (never resurrects an
      // ended/killed row). Reads ONLY session_id + ts, so a from-scratch re-fold
      // reproduces it byte-identically. A genuine resume AFTER the heal simply
      // re-activates under the stamp gate — a later event with a newer ts wins the
      // strictly-`ts > stamp` activation.
      {
        const res = db.run(
          `UPDATE jobs SET state = 'stopped',
                           last_lifecycle_ts = MAX(COALESCE(last_lifecycle_ts, ?), ?),
                           last_event_id = ?, updated_at = ?
             WHERE job_id = ? AND state NOT IN ('${ENDED}','${KILLED}')`,
          [ts, ts, event.id, ts, jobId],
        );
        // Fan the healed state into the embedded epics.jobs / task.jobs arrays —
        // ONLY on the proven write path (a guarded terminal-row no-op must NOT
        // re-fan a stale-but-unchanged element with the new event_id).
        if (res.changes > 0) {
          syncIfPlanRef(db, jobId, event.id, ts);
        }
      }
      break;

    case "ResumeTargetResolved":
      // Synthetic event (fn-1103) minted daemon-side when a harness's native
      // resume target is resolved AFTER launch — the codex rollout-poll match or
      // the hermes on_session_start hook id back-fills a keeper-minted job. Folds
      // ONLY `jobs.resume_target` (idempotent replace) and NEVER touches lifecycle
      // state, so a late back-fill can NEVER revive a terminal row — which is
      // exactly why this is a SEPARATE arm from SessionStart's killed->stopped
      // revive. Reads the `resume_target` COLUMN the producer set via
      // `insertEvent` (symmetric with the SessionStart arm). A NULL target or a
      // missing jobs row is a safe no-op (no write). No terminal guard and no
      // `state` clause: the resume target is valid on a stopped/ended/killed row
      // alike (you resume a dead session). Reads ONLY event fields, so a
      // from-scratch re-fold reproduces the row byte-identically.
      {
        const resumeTarget = event.resume_target;
        if (resumeTarget == null) {
          break; // nothing to resolve — safe no-op.
        }
        db.run(
          `UPDATE jobs SET resume_target = ?, last_event_id = ?, updated_at = ?
             WHERE job_id = ?`,
          [resumeTarget, event.id, ts, jobId],
        );
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
      // Sub-agent guard (mirrors Stop): suppress the state FLIP while a fresh
      // in-flight subagent survives (the parent isn't making API calls while it
      // waits on a sub) — but stamp the (last_api_error_at, last_api_error_kind)
      // pair UNCONDITIONALLY, which is the honest reading. The liveness decision
      // is lifted to `findFreshInFlightSubagentAnchor` (open-turn predicate +
      // same-name collapse + `updated_at` freshness bound — both of which the
      // old inline `EXISTS(status='running')` CASE lacked); only the `state =`
      // clause is gated on it. The interpolated fragment is a fixed string chosen
      // by a fold-time-pure boolean (re-fold deterministic).
      const subBlocks = findFreshInFlightSubagentAnchor(
        db,
        jobId,
        MAX_STOP_YIELD_GAP_SEC,
        event.ts,
      );
      // The `state ->stopped` flip is quiescing (ADR 0013): gate it on the
      // lifecycle stamp (`ts >= stamp`) so a stale ApiError straggler cannot stop
      // a session a newer event already proved live — otherwise a permutation of
      // {ApiError, PostToolUse} would leave a different final state per ingest
      // order. The gate rides the state CASE (NOT the WHERE) so the (last_api_
      // error_at, last_api_error_kind) pair still stamps UNCONDITIONALLY, the
      // honest reading kept from the sub-agent-suppressed path. The stamp advances
      // ONLY when the flip lands, mirroring the gated CASE. When a fresh in-flight
      // sub-agent survives, `stateClause`/`stampClause` collapse to no-ops (the
      // parent stays 'working', the stamp is untouched).
      const stampGate = lifecycleStampGate("quiesce");
      const stateClause = subBlocks
        ? "state"
        : `CASE WHEN ${stampGate} THEN 'stopped' ELSE state END`;
      const stampClause = subBlocks
        ? "last_lifecycle_ts"
        : `CASE WHEN ${stampGate} THEN ? ELSE last_lifecycle_ts END`;
      // The gated CASEs bind the event ts three times (state-gate, stamp-gate,
      // stamp-value); the sub-agent-suppressed branch binds none.
      const stampParams = subBlocks ? [] : [ts, ts, ts];
      const res = db.run(
        `UPDATE jobs SET state = ${stateClause},
                         last_lifecycle_ts = ${stampClause},
                         last_api_error_at = ?,
                         last_api_error_kind = ?,
                         last_event_id = ?,
                         updated_at = ?
           WHERE job_id = ? AND state NOT IN ('${ENDED}','${KILLED}')`,
        [...stampParams, ts, kind, event.id, ts, jobId],
      );
      // Sync only when the UPDATE wrote — a guarded no-op must NOT re-fan a
      // stale-but-unchanged element with the new event_id.
      if (res.changes > 0) {
        syncIfPlanRef(db, jobId, event.id, ts);
      }
      // Retired fn-1239 task .6: the profile-level rate-limit fan-out into the
      // `profiles` / `usage` tables (gated on `kind === "rate_limit"`) is gone —
      // both tables are DROPped at schema v120. The `(last_api_error_at,
      // last_api_error_kind)` stamp above, and every other RateLimited/ApiError
      // behavior, is unaffected.
      break;
    }

    case "SessionTelemetry": {
      // fn-1024: fold one coalesced statusLine telemetry snapshot onto the six
      // v100 `jobs` columns. Modeled on the ApiError arm's partial UPDATE + the
      // same terminal guard, but DELIBERATELY narrower on three axes:
      //   (1) writes ONLY the six telemetry columns + last_event_id/updated_at —
      //       NEVER `state`/`active_since`; display data must not perturb the job
      //       lifecycle (touching them would corrupt the timeline sort + board).
      //   (2) NO syncIfPlanRef fan-out — the embedded jobs[] mirrors carry no
      //       telemetry columns, so a re-fan would only churn a stale event_id.
      //   (3) COALESCE(?, col) per column so a PARTIAL snapshot merges — an
      //       effort-only event (or context-only before the first API call)
      //       leaves whatever a prior snapshot wrote intact, never nulls it.
      // A snapshot arriving before SessionStart matches zero rows (the job isn't
      // seeded) — the correct no-op; this arm NEVER UPSERT-mints a phantom jobs
      // row. Malformed data folds to null → skip. `used_percentage` is the raw
      // observed value (never recomputed), so re-fold stays byte-identical.
      const telemetry = extractSessionTelemetry(event);
      if (telemetry == null) {
        break;
      }
      db.run(
        `UPDATE jobs SET current_model_id = COALESCE(?, current_model_id),
                         current_model_display = COALESCE(?, current_model_display),
                         current_effort = COALESCE(?, current_effort),
                         context_used_percentage = COALESCE(?, context_used_percentage),
                         context_input_tokens = COALESCE(?, context_input_tokens),
                         context_window_size = COALESCE(?, context_window_size),
                         last_event_id = ?,
                         updated_at = ?
           WHERE job_id = ? AND state NOT IN ('${ENDED}','${KILLED}')`,
        [
          telemetry.model_id,
          telemetry.model_display,
          telemetry.effort,
          telemetry.used_percentage,
          telemetry.input_tokens,
          telemetry.window_size,
          event.id,
          ts,
          jobId,
        ],
      );
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
      // ADR 0013 lifecycle-stamp gate: this quiescence (-> stopped) applies at
      // `ts >= stamp`. Unlike the ApiError arm (whose sub-agent guard forces the
      // annotation stamp to stay UNCONDITIONAL), InputRequest has no sub-agent
      // guard, so the whole UPDATE — flip AND pair stamp — rides the WHERE gate:
      // a stale InputRequest straggler is swallowed entirely, which makes both the
      // final state AND the annotation converge across ingest orderings.
      const res = db.run(
        `UPDATE jobs SET state = 'stopped',
                         last_input_request_at = ?,
                         last_input_request_kind = ?,
                         last_lifecycle_ts = ?,
                         last_event_id = ?,
                         updated_at = ?
           WHERE job_id = ? AND state NOT IN ('${ENDED}','${KILLED}')
             AND ${lifecycleStampGate("quiesce")}`,
        [ts, kind, ts, event.id, ts, jobId, ts],
      );
      // Sync only when the UPDATE actually wrote — a guarded no-op on a
      // still-terminal or stale-straggler row must NOT re-fan the embedded entry
      // (it would re-write a stale-but-unchanged element with the new event_id).
      if (res.changes > 0) {
        syncIfPlanRef(db, jobId, event.id, ts);
      }
      break;
    }

    case "PreToolUse":
    case "PostToolUse": {
      // Hot-path clear + un-stop for the api-error pair: a tool event after an
      // ApiError/RateLimited stamp proves the CLI resumed (it internally retried
      // the transient failure), so the board must not keep showing `[failed:*]`
      // / `[::stopped]` on a worker that is actually running. Zero the pair AND
      // un-stop the row in ONE statement: one write, one `changes > 0`, one
      // fan-out. Gated on `IS NOT NULL` so the common already-NULL case is a
      // zero-cost no-op (no stamp churn / re-fan). Both state and active_since
      // gate on the literal `'stopped'`, NOT the UserPromptSubmit arm's
      // `!= 'working'` predicate: the narrow gate can never resurrect an
      // `ended`/`killed` row (a terminal row with a stale pair gets its pair
      // cleared, state untouched), and in the subagent-suppressed case (pair
      // stamped while state stayed `working`) it leaves active_since untouched so
      // the dash timeline sort key does not churn on every tool event. SQLite
      // evaluates all SET right-hand sides against the pre-UPDATE row, so both
      // CASEs read the same old state. active_since stamps to `event.ts` only on
      // the genuine stopped→working rising edge (mirrors the UPS arm's mechanics).
      //
      // ADR 0013 lifecycle-stamp gate: the un-stop is ACTIVATING (-> working), so
      // every flip CASE below ANDs `ts > stamp` onto its `state = 'stopped'`
      // predicate — a stale tool-event straggler whose ts has regressed behind
      // the stamp clears its annotation pair but does NOT resurrect the row (the
      // exact phantom-working race). The `last_lifecycle_ts` CASE mirrors the flip
      // CASE so the stamp advances (and active_since re-stamps) ONLY on a real
      // rising edge, keeping a swallowed straggler re-fold-stable.
      const unstopGate = lifecycleStampGate("activate");
      const resApi = db.run(
        `UPDATE jobs SET last_api_error_at = NULL,
                         last_api_error_kind = NULL,
                         state = CASE WHEN state = 'stopped' AND ${unstopGate} THEN 'working' ELSE state END,
                         active_since = CASE WHEN state = 'stopped' AND ${unstopGate} THEN ? ELSE active_since END,
                         last_lifecycle_ts = CASE WHEN state = 'stopped' AND ${unstopGate} THEN ? ELSE last_lifecycle_ts END,
                         last_event_id = ?,
                         updated_at = ?
           WHERE job_id = ? AND last_api_error_at IS NOT NULL`,
        [ts, ts, ts, ts, ts, event.id, ts, jobId],
      );
      if (resApi.changes > 0) {
        syncIfPlanRef(db, jobId, event.id, ts);
      }
      // Hot-path clear + un-stop for the input-request pair: `AskUserQuestion`
      // fires no Pre/PostToolUse hook of its own, so the next tool the agent uses
      // is the closest "answered" signal — zero the pair AND un-stop the row
      // (the human answered, the session resumed). Same single-statement
      // clear+un-stop shape as the api-error arm above, same literal-`'stopped'`
      // gate on both CASEs. Gated on `IS NOT NULL`; paired clear; sync gated on
      // `changes > 0`.
      const res = db.run(
        // Same ADR-0013 activating gate as the api-error un-stop above (`unstopGate`).
        `UPDATE jobs SET last_input_request_at = NULL,
                         last_input_request_kind = NULL,
                         state = CASE WHEN state = 'stopped' AND ${unstopGate} THEN 'working' ELSE state END,
                         active_since = CASE WHEN state = 'stopped' AND ${unstopGate} THEN ? ELSE active_since END,
                         last_lifecycle_ts = CASE WHEN state = 'stopped' AND ${unstopGate} THEN ? ELSE last_lifecycle_ts END,
                         last_event_id = ?,
                         updated_at = ?
           WHERE job_id = ? AND last_input_request_at IS NOT NULL`,
        [ts, ts, ts, ts, ts, event.id, ts, jobId],
      );
      if (res.changes > 0) {
        syncIfPlanRef(db, jobId, event.id, ts);
      }
      // Identically-shaped hot-path clear for the permission-prompt pair. No
      // "permission dialog dismissed" hook exists, so the clear is inferred from
      // the next downstream tool (both Pre and Post, to close the narrow window
      // where the worker fires its next tool before keeper sees a PostToolUse).
      // Same gate / paired-NULL / `changes > 0` discipline as above — but NO
      // un-stop: the permission-prompt stamp arm (Notification) never flips
      // `state` (the `[awaiting:…]` pill layers on top of the live state), so
      // there is no `stopped` to un-stop. Do not "fix" this into a fourth
      // un-stop.
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
      // Bare un-stop for a PLAIN-stopped row (both annotation pairs NULL). A
      // session that ended a turn to wait on background tasks gets flipped to
      // 'stopped' by the plain Stop fold; when it resumes straight into tool
      // events (no UserPromptSubmit, so no UPS revival — the live repro: a Stop
      // followed by a flood of Pre/PostToolUse), the two annotation-gated arms
      // above never fire, and the row reads 'stopped' indefinitely while
      // demonstrably working. This third arm treats ANY current-session tool
      // event as proof of liveness and un-stops the row.
      //
      // Composes with the annotation-clearing arms by running LAST: an
      // annotation-carrying stopped row already un-stopped + stamped active_since
      // through the api-error / input-request arms, so state is 'working' here
      // and the `state = 'stopped'` WHERE no-ops (no double-stamp). This arm owns
      // only the both-NULL case they skip.
      //
      // The `state = 'stopped'` WHERE is the resurrection guard (same rationale
      // as the annotation arms' literal-'stopped' CASE, :8398-8405): an
      // 'ended'/'killed' row is untouchable by construction — a late async tool
      // event on a genuinely-dead session can never resurrect a terminal row.
      // The WHERE already pins state='stopped', so the SET is unconditional
      // within it: active_since stamps to `event.ts` on the genuine
      // stopped→working rising edge (the rising-edge discipline the sibling
      // CASEs encode). Working rows never match, so the 50+/turn hot path stays
      // cold. Tradeoff: a stray tool event after a real stop flips the row
      // 'working' until the next Stop folds it back — acceptable by design for a
      // 'stopped' (non-terminal) row. Pure over the event log — re-fold
      // deterministic.
      //
      // ADR 0013 lifecycle-stamp gate: the un-stop is ACTIVATING (-> working), so
      // the WHERE ANDs `ts > stamp` onto `state = 'stopped'`. THIS is the
      // root-cause fix for phantom-working — the turn-final `Stop` advanced the
      // stamp to its own ts, so a straggler PostToolUse with an EARLIER ts is
      // swallowed here and can never resurrect the correctly-stopped row. A
      // genuine resume (tool events with newer ts) still un-stops. The WHERE gate
      // means a swallowed straggler no-ops entirely (no active_since/stamp churn),
      // and working rows keep no-op-ing so the 50+/turn hot path stays cold.
      const resUnstop = db.run(
        `UPDATE jobs SET state = 'working',
                         active_since = ?,
                         last_lifecycle_ts = ?,
                         last_event_id = ?,
                         updated_at = ?
           WHERE job_id = ? AND state = 'stopped'
             AND ${lifecycleStampGate("activate")}`,
        [ts, ts, event.id, ts, jobId, ts],
      );
      if (resUnstop.changes > 0) {
        syncIfPlanRef(db, jobId, event.id, ts);
      }
      // NOTE: this arm deliberately does NOT refresh transcript_path off the
      // tool event, even though a tool event is proven-live activity. A
      // Pre/PostToolUse body for the shed mutation tools (Write/Edit/MultiEdit/
      // NotebookEdit + non-plan Bash) is NULLed by the retention shed, and
      // transcript_path lives only in the body (no promoted column), so reading
      // it here would re-fold differently post-shed — breaking the shed
      // re-fold-equivalence invariant. The refresh rides UserPromptSubmit +
      // Stop instead (both keep-set / never shed). This arm reads scalar columns
      // only — keep it that way.
      break;
    }

    case "Notification": {
      // Three discriminated `event.event_type` values fold here: `idle_prompt`
      // is a QUIESCING lifecycle signal (flips state), the other two are
      // stamp-only annotations (never flip state).
      //
      // `idle_prompt` (ADR 0013 layer 2): a claude-authored POSITIVE assertion
      // that the session is idle at the prompt — done as an explicit signal, not
      // absence-of-events. It folds working -> stopped behind the SAME terminal,
      // sub-agent-yield, and lifecycle-stamp guards as the Stop arm; drop any one
      // and it re-opens the dup-fire window the sub-agent guard closes. Helper
      // signal ONLY — claude is the sole harness emitting it, so no other arm may
      // come to depend on it as the primary done signal. Handled via a SEPARATE
      // discriminator (never routed through `permissionPromptKindFromEventType`)
      // so the two stamp-only kinds stay byte-identical and the idle flip stays
      // orthogonal to them.
      if (event.event_type === "idle_prompt") {
        // Sub-agent-yield guard, cloned from the Stop arm: while a fresh
        // in-flight sub-agent survives, the parent session is conceptually still
        // working even though it emitted an idle Notification, so skip the flip
        // (the same open-turn predicate + same-name collapse +
        // `MAX_STOP_YIELD_GAP_SEC` freshness bound anchored on `updated_at`).
        if (
          findFreshInFlightSubagentAnchor(
            db,
            jobId,
            MAX_STOP_YIELD_GAP_SEC,
            event.ts,
          )
        ) {
          break;
        }
        // Quiescence gate (ADR 0013): applies at `ts >= stamp`, so a stale
        // replayed idle_prompt straggler whose ts has regressed behind the stamp
        // is swallowed entirely — no flip, no stamp advance, no re-fan. It can
        // never stop a session a newer event already proved live, and (being
        // quiescing) never resurrects one. Terminal guard shared with the Stop
        // arm. Stamp value is `event.ts` only — re-fold deterministic.
        const res = db.run(
          `UPDATE jobs SET state = 'stopped', last_lifecycle_ts = ?,
                           last_event_id = ?, updated_at = ?
             WHERE job_id = ? AND state NOT IN ('${ENDED}','${KILLED}')
               AND ${lifecycleStampGate("quiesce")}`,
          [ts, event.id, ts, jobId, ts],
        );
        // Sync only when the UPDATE actually wrote — a guarded no-op (terminal,
        // stale straggler, or already-stopped row) must NOT re-fan a
        // stale-but-unchanged element with the new event_id.
        if (res.changes > 0) {
          syncIfPlanRef(db, jobId, event.id, ts);
        }
        break;
      }
      // Hook-event-driven fold of `Notification:permission_prompt` (the
      // tool-permission dialog) and `:elicitation_dialog` (an MCP input
      // request). The discriminator rides `event.event_type`. STRICT gate: only
      // the two whitelisted values stamp; every other value (idle_prompt handled
      // above; unknowns) short-circuits via `permissionPromptKindFromEventType`
      // returning null (the post-switch fan-outs still fire). The stamp does NOT
      // flip `state` — the pill layers `[awaiting:…]` on top of the live state
      // without firing a Stop. Terminal-row guard cloned from the InputRequest
      // arm. Stamp value is `event.ts` only — re-fold deterministic.
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
  // session that opens panes mid-life lands the freshest coords on the next
  // event. Gated on `backend_exec_type != null` (the all-NULL non-pane case is a
  // fast no-op); a partial capture still COALESCEs so a NULL field preserves the
  // prior value. Reads only `event.backend_exec_*` + the persisted cell —
  // re-fold deterministic. An UPDATE against a missing jobs row is a no-op — a
  // row is minted first per session by either a SessionStart or the first
  // pid-bearing UserPromptSubmit (the fork-attribution seed), so a live session
  // always has one by the time backend coords arrive.
  //
  // PRECEDENCE FLIP (fn-907): this arm NO LONGER writes the LIVE
  // `backend_exec_session_id`. The frozen launch-time `KEEPER_TMUX_SESSION` env
  // never rewrites when a pane MOVES, so re-asserting it on every hook event
  // clobbered the live location. The env session value is now FORENSIC — it
  // COALESCE-fills `backend_exec_birth_session_id` (written once, idempotent
  // since the env is constant per process). The LIVE `backend_exec_session_id`
  // (+ `window_index`) is owned SOLELY by the `TmuxTopologySnapshot` fold, which
  // tracks reality across moves. Consumers fall back to birth when the live
  // session is unresolved. `backend_exec_type` + `backend_exec_pane_id` stay as
  // pure env reads (a pane's TYPE + `%N` identity don't move out from under it).
  //
  // TERMINAL GUARD: skip a job already folded to ended/killed. The terminal
  // arms NULL `backend_exec_pane_id` (tmux recycles `%N`, so a dead job holding
  // a live-recyclable pane id would be mis-attributed as owning a fresh window);
  // without this guard a late hook event carrying the stale env pane id would
  // COALESCE it straight back onto the dead row, undoing the clear in the very
  // same event. Mirrors the `TmuxTopologySnapshot` fold's live-state filter.
  if (event.backend_exec_type != null) {
    db.run(
      `UPDATE jobs SET
         backend_exec_type = COALESCE(?, backend_exec_type),
         backend_exec_birth_session_id = COALESCE(backend_exec_birth_session_id, ?),
         backend_exec_pane_id = COALESCE(?, backend_exec_pane_id),
         last_event_id = ?,
         updated_at = ?
       WHERE job_id = ? AND state NOT IN ('${ENDED}','${KILLED}')`,
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

  // plan-CLI invocation fan-out. Re-derive the session's epic_links +
  // every touched epic's job_links from scratch via the pure classifier in
  // `src/plan-classifier.ts`. Gated on:
  //   `plan_op != NULL`        — this event is a plan-CLI Bash invocation
  //                              (PostToolUse:Bash whose stdout carried the
  //                              `plan_invocation` envelope — see
  //                              {@link extractPlanInvocation}), one of
  //                              the windowed mutations the classifier folds
  //                              into edges;
  //   OR `PreToolUse + skill_name='plan:plan'`
  //                            — this event is a `/plan:plan` window opener,
  //                              which can change the set of windows (and
  //                              thus which plan events fall inside them)
  //                              even though it carries no `plan_op` itself.
  //
  // The trigger gate itself is hook-event-agnostic — `plan_op != null`
  // fires correctly regardless of whether the source event is a PreToolUse
  // or PostToolUse row. Only the stamping deriver changed.
  //
  // The two seams are disjoint from `syncJobIntoEpic` (jobs-write trigger):
  // a hook event like a SessionStart with `plan_ref` fires syncIfPlanRef but
  // not syncPlanLinks; a PostToolUse:Bash with a plan envelope fires
  // syncPlanLinks but no jobs-side write happens (default switch arm).
  //
  // Post-switch placement matches the title-precedence precedent below: the
  // gate fires regardless of which `hook_event` switch arm did (or did not)
  // do lifecycle work.
  if (
    event.plan_op != null ||
    (event.hook_event === "PreToolUse" && event.skill_name === "plan:plan")
  ) {
    syncPlanLinks(db, jobId, event.id, ts);
  }

  // plan-written tracked files get a `source='plan'` attribution row per
  // path the envelope's `files` array names — without this mint they appear as
  // strict-mystery orphans the instant they flash dirty.
  if (event.plan_op != null && event.plan_files != null) {
    mintPlanFileAttributions(db, event);
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
 * fn-934 (task .4): per-`Database` INCREMENTAL id-watermark memo for the
 * `computeMonitors` provenance scan. The old scan re-read a session's WHOLE
 * `background_task_id`-bearing history on EVERY Stop (O(history) per-event —
 * the next O(history) time-bomb after fn-892's git pass-1). This memo mirrors
 * fn-892's {@link GitAttribMemo}: per fold it scans only `id > maxId` and
 * ACCUMULATES the first-observed provenance per `(session, task_id)`, so
 * steady-state cost is O(rows since the last fold), not session history.
 *
 * Correctness — the accumulated set is byte-identical to the unbounded scan:
 *  - the event log below head is APPEND-ONLY (`background_task_id` is never
 *    rewritten; retention only NULLs fold-unread BODIES, never this column),
 *    so an incremental `id > maxId` append faithfully reproduces a full rescan;
 *  - the unbounded scan deduped FIRST-observed by the index's natural order
 *    `(session_id, background_task_id, id)` — i.e. the LOWEST id per
 *    `(session, task_id)` wins. The watermark axis IS ascending `id`, so the
 *    accumulator's "keep the first provenance written per key" reproduces that
 *    lowest-id winner exactly (a later higher-id row for the same key never
 *    overwrites);
 *  - the Stop fold runs in strict `id ASC` order (drain `ORDER BY id ASC`), so
 *    by the time `computeMonitors` runs at `currentEventId` the memo holds every
 *    `id < currentEventId` row already. The incremental scan is bounded
 *    `id < currentEventId` (NOT unbounded `> maxId`) so a higher-id row already
 *    physically present in the batch but NOT YET folded can never leak into this
 *    fold's result — preserving the unbounded scan's `id < currentEventId` gate.
 *
 * PURE optimization — the memo is NEVER a fold INPUT that changes output: it
 * only caches the snapshot-invariant provenance the scan would re-derive, and
 * `jobs.monitors` is recomputed from `extractBackgroundTasks` + this lookup each
 * Stop. Uses only the event's `id` (the watermark axis); NO `Date.now()` /
 * wall-clock / env / fs / liveness probe (re-fold determinism is sacred — the
 * serve-path `recencyBound`/`ResolvedFilter` is forbidden in a fold). Keyed by
 * `Database` via a `WeakMap` so a dropped connection's memo is collected; a
 * fresh-DB-per-test starts cold (`maxId = 0`, first scan = `id > 0` = the whole
 * history once — preserving full fidelity on a cold connection).
 */
interface MonitorProvenanceMemo {
  maxId: number;
  // session_id -> (task_id -> first-observed provenance). First-write-wins per
  // key reproduces the unbounded scan's lowest-id winner.
  bySession: Map<string, Map<string, "monitor" | "bash-bg">>;
}

const monitorProvenanceMemos = new WeakMap<Database, MonitorProvenanceMemo>();

/**
 * Test-only: drop the per-`Database` monitor-provenance memo so the NEXT
 * `computeMonitors` on this connection starts cold (a full `id > 0` rescan).
 * Production never calls this — the WeakMap collects a dropped connection's memo
 * on its own, and a fresh-DB-per-test is cold by construction. Exposed so a
 * warm-vs-cold equivalence test can force a cold rescan on a warmed connection.
 */
export function __resetMonitorProvenanceMemoForTest(db: Database): void {
  monitorProvenanceMemos.delete(db);
}

/**
 * Advance the {@link MonitorProvenanceMemo} for `db` to cover every
 * `background_task_id`-bearing event with `id < currentEventId`, then return the
 * provenance map for `sessionId`. Scans only `id > memo.maxId` (and bounded
 * `< currentEventId`) per call, accumulating first-observed-wins per
 * `(session, task_id)`. NEVER throws — a strict SELECT against known columns.
 */
function monitorProvenanceForSession(
  db: Database,
  sessionId: string,
  currentEventId: number,
): Map<string, "monitor" | "bash-bg"> {
  let memo = monitorProvenanceMemos.get(db);
  if (memo == null) {
    memo = { maxId: 0, bySession: new Map() };
    monitorProvenanceMemos.set(db, memo);
  }
  const fromId = memo.maxId;
  // Bound the incremental slice `(fromId, currentEventId)`: strictly above the
  // watermark and strictly below the current Stop. The drain folds in `id ASC`,
  // so this exactly reproduces the unbounded scan's `id < currentEventId` gate
  // while paying only the delta. `idx_events_background_task_id
  // (session_id, background_task_id, id, tool_name) WHERE background_task_id IS
  // NOT NULL` covers the read (trailing `tool_name` keeps it covering); the
  // `id` range bound rides the index's natural order.
  if (currentEventId > fromId) {
    const rows = db
      .query(
        `SELECT id, session_id, background_task_id AS task_id, tool_name
           FROM events
          WHERE background_task_id IS NOT NULL
            AND id > ?
            AND id < ?`,
      )
      .all(fromId, currentEventId) as {
      id: number;
      session_id: string;
      task_id: string;
      tool_name: string | null;
    }[];
    for (const row of rows) {
      let bucket = memo.bySession.get(row.session_id);
      if (bucket == null) {
        bucket = new Map();
        memo.bySession.set(row.session_id, bucket);
      }
      // First-observed-wins per key: the unbounded scan deduped on the LOWEST
      // id per `(session, task_id)`; ascending-id accumulation reproduces it.
      if (bucket.has(row.task_id)) continue;
      if (row.tool_name === "Monitor") {
        bucket.set(row.task_id, "monitor");
      } else if (row.tool_name === "Bash") {
        bucket.set(row.task_id, "bash-bg");
      }
      // tool_name not in {Monitor, Bash}: leave the key unset — the entry folds
      // to `ambient` in `computeMonitors`. (A future third launch kind learns a
      // name in the deriver + here together.)
    }
    // Commit the watermark to `currentEventId - 1`, the highest id this slice
    // could cover (the scan is bounded `id < currentEventId`). Every
    // `id < currentEventId` row is already folded and thus present in the table,
    // so the slice was complete to that ceiling — clamping to it (rather than the
    // highest OBSERVED background-task id) means the next Stop's `id > maxId` slice
    // never re-scans the gap of non-monitor rows below this Stop.
    memo.maxId = currentEventId - 1;
  }
  return memo.bySession.get(sessionId) ?? new Map();
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
 * The provenance lookup is gated on `id < currentEventId` so it reads
 * only the immutable log up to but not including the current Stop —
 * a future event minted later cannot influence this fold's result, so
 * a cursor=0 re-fold reproduces byte-identical output. fn-934 (task .4):
 * the lookup is served by the INCREMENTAL {@link MonitorProvenanceMemo}
 * (via {@link monitorProvenanceForSession}) instead of an O(history)
 * full-session rescan on every Stop — steady-state cost is now the
 * `id > maxId` delta, not session length, and the accumulated provenance
 * set is byte-identical to the old unbounded scan (a long-lived monitor
 * older than any window is NEVER dropped — the memo never forgets a key).
 * The memo is a PURE optimization, never a fold INPUT, and reads only the
 * event `id` (no wall-clock / serve-path recencyBound — forbidden in a fold).
 * Pure function of `(persistedJson, eventDataPayload, sessionId,
 * currentEventId, memo-of-the-event-log)`.
 *
 * fn-718 (task 1): each entry also carries `command` / `description`,
 * which ride straight from the Stop payload via `extractBackgroundTasks`
 * (NOT from the provenance lookup) so the render layer can show the script
 * the monitor is running. Only `kind` comes from the provenance memo.
 *
 * NEVER throws — `extractBackgroundTasks` already swallows malformed
 * `background_tasks` shapes (returns `[]`), and the provenance lookup is
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
  // fn-934 (task .4): the per-`Database` incremental id-watermark memo serves the
  // first-observed provenance per `(session, task_id)` over every
  // `id < currentEventId` row — byte-identical to the old unbounded full-session
  // scan, but at O(delta) steady-state cost. A re-launch with the same id keeps
  // the FIRST observed mint (lowest-id winner) exactly as the index-ordered scan
  // did. `idx_events_background_task_id` covers the bounded slice inside the memo.
  const provenance = monitorProvenanceForSession(db, sessionId, currentEventId);
  // fn-718 (task 1): command/description ride from the Stop payload via
  // `extractBackgroundTasks`; only `kind` is merged from the provenance memo.
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
/**
 * Last fold's lock-wait vs work split, in ms. {@link applyEvent} stamps these
 * each call so {@link drain}'s `[fold-slow]` line can attribute a slow fold to
 * BEGIN-IMMEDIATE lock contention (`lock_wait_ms`) vs the projection work that
 * actually held the lock (`work_ms`). The lock-wait is t1−t0 where t0 is taken
 * just before `fold.immediate()` and t1 is the FIRST statement inside the
 * transaction callback (post-BEGIN-IMMEDIATE, lock held); work is t2−t1 where
 * t2 is taken after `fold.immediate()` returns (COMMIT done). Module-scoped
 * because the transaction callback can't return a value to the caller; a fold
 * is single-threaded so these can't interleave. Pure instrumentation — never
 * read into a projection write.
 */
let _foldLockWaitMs = 0;
let _foldWorkMs = 0;

export function applyEvent(
  db: Database,
  event: Event,
  options: ApplyEventOptions = {},
): void {
  // t0: just before BEGIN IMMEDIATE issues — the lock-wait window opens here.
  const _foldT0 = performance.now();
  let _foldT1 = _foldT0;
  const fold = db.transaction(() => {
    // t1: first statement inside the callback — BEGIN IMMEDIATE has returned,
    // so the writer lock is held; `_foldT1 − _foldT0` is the pure lock-wait.
    _foldT1 = performance.now();
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
      // Retired fn-1239 task .6 — the `usage` projection is DROPped at schema
      // v120. Fold to NO-OP so historical UsageSnapshot events advance the
      // cursor without routing into the final `else` (`projectJobsRow`, which
      // would misread `event.session_id` as a job id and corrupt the jobs
      // projection). MUST stay an explicit empty arm for the same reason as
      // the retired TmuxPaneSnapshot / WindowIndexSnapshot arms below. The
      // producer no longer posts this kind; the historical events remain in
      // the log forever.
    } else if (event.hook_event === "UsageDeleted") {
      // Retired fn-1239 task .6, mirroring the UsageSnapshot no-op above.
    } else if (event.hook_event === "SessionTelemetry") {
      // fn-1024: a jobs-ONLY telemetry fold. Route it to projectJobsRow (its
      // `case "SessionTelemetry"` arm folds onto the row keyed by
      // event.session_id) rather than the final `else`, so it skips the
      // subagent-invocations sibling projection (a fast no-op for this kind, but
      // an explicit arm documents the jobs-only scope + keeps the hot path lean).
      projectJobsRow(db, event);
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
    } else if (event.hook_event === "BlockEscalationRequested") {
      foldBlockEscalationRequested(db, event);
    } else if (event.hook_event === "BlockEscalationAttempted") {
      foldBlockEscalationAttempted(db, event);
    } else if (event.hook_event === "MergeEscalationAttempted") {
      foldMergeEscalationAttempted(db, event);
    } else if (event.hook_event === "ResolverDispatchAttempted") {
      foldResolverDispatchAttempted(db, event);
    } else if (event.hook_event === "MergeHumanNotified") {
      foldMergeHumanNotified(db, event);
    } else if (event.hook_event === "RepairDispatched") {
      foldRepairDispatched(db, event);
    } else if (event.hook_event === "RepairHumanNotified") {
      foldRepairHumanNotified(db, event);
    } else if (event.hook_event === "SharedCheckoutHumanNotified") {
      foldSharedCheckoutHumanNotified(db, event);
    } else if (event.hook_event === "BlockHumanNotified") {
      foldBlockHumanNotified(db, event);
    } else if (event.hook_event === "AutopilotPaused") {
      foldAutopilotPaused(db, event);
    } else if (event.hook_event === "AutopilotCapSet") {
      foldAutopilotCapSet(db, event);
    } else if (event.hook_event === "AutopilotConfigSet") {
      foldAutopilotConfigSet(db, event);
    } else if (event.hook_event === "AutopilotMode") {
      foldAutopilotMode(db, event);
    } else if (event.hook_event === "EpicArmed") {
      foldEpicArmed(db, event);
    } else if (event.hook_event === "AwaitRequested") {
      foldAwaitRequested(db, event);
    } else if (
      event.hook_event === "AwaitFiring" ||
      event.hook_event === "AwaitDone" ||
      event.hook_event === "AwaitFailed" ||
      event.hook_event === "AwaitTimedOut"
    ) {
      foldAwaitLifecycle(db, event);
    } else if (event.hook_event === "HandoffRequested") {
      foldHandoffRequested(db, event);
    } else if (event.hook_event === "HandoffDispatching") {
      foldHandoffDispatching(db, event);
    } else if (event.hook_event === "HandoffLaunchFailed") {
      foldHandoffLaunchFailed(db, event);
    } else if (event.hook_event === "BackendExecSnapshot") {
      // retired fn-684 — fold to no-op so historical events advance the
      // cursor without touching the jobs projection. MUST stay an explicit
      // empty arm: the final `else` runs projectJobsRow, so deleting this
      // arm would route historical BackendExecSnapshot events into the jobs
      // projection and break re-fold determinism.
    } else if (event.hook_event === "TmuxTopologySnapshot") {
      // epic fn-907 — the LIVE-LOCATION fold (sole owner of
      // `backend_exec_session_id` + `window_index`). Overwrites each matching
      // LIVE tmux job's session + window index, recycle-guarded on
      // `(generation_id, pane_id)` and gated above `tmux_projection_state.floor`.
      // LIVE-ONLY: the two columns are boot-seeded + skip-floored (NOT replayed),
      // so this fold no-ops below the floor and the columns are excluded from the
      // byte-identical re-fold charter.
      foldTmuxTopologySnapshot(db, event);
    } else if (event.hook_event === "TmuxClientFocusSnapshot") {
      // epic fn-952 — the LIVE-ONLY client-focus singleton fold (sole owner of
      // `tmux_client_focus`). Last-write-wins UPSERT on id=1 from the persistent
      // `tmux -C` control worker's focus observation. NO floor/seed: focus has no
      // replay-worthy history (the worker re-bootstraps on every connect), so the
      // fold runs unconditionally and an empty log leaves the table empty. The
      // singleton is LIVE-ONLY (in `LIVE_ONLY_PROJECTIONS`) — excluded from the
      // byte-identical re-fold charter. A malformed payload no-ops; the cursor
      // still advances here.
      foldTmuxClientFocusSnapshot(db, event);
    } else if (event.hook_event === "WorktreeRepoStatus") {
      // fn-1013 — the LIVE-ONLY worktree-eligibility operator surface (sole owner
      // of `worktree_repo_status`). Full-set REPLACE from the autopilot worker's
      // current disabled set (posted only when it changes). NO floor/seed: the
      // verdict is fs-derived and re-emitted each cycle, so the fold runs
      // unconditionally and a re-fold's last event wins; the table is LIVE-ONLY
      // (in `LIVE_ONLY_PROJECTIONS`) — excluded from the byte-identical re-fold
      // charter. A malformed payload clears the table; the fold never throws.
      foldWorktreeRepoStatus(db, event);
    } else if (event.hook_event === "LaneMerged") {
      // The LIVE-ONLY merge-landed observable (sole owner of
      // `lane_merged`). Full-set REPLACE from the autopilot worker's current
      // merged-lane set (posted only when it changes). NO floor/seed: the verdict
      // is git-derived (a per-cycle ancestry probe) and re-emitted each cycle, so
      // the fold runs unconditionally and a re-fold's last event wins; the table
      // is LIVE-ONLY (in `LIVE_ONLY_PROJECTIONS`) — excluded from the
      // byte-identical re-fold charter. A malformed payload clears the table; the
      // fold never throws.
      foldLaneMerged(db, event);
    } else if (event.hook_event === "TmuxPaneSnapshot") {
      // retired fn-907 — the fill-only session resolver (epic fn-789) is
      // superseded by the `TmuxTopologySnapshot` live-location fold above. Fold
      // to NO-OP so historical TmuxPaneSnapshot events advance the cursor without
      // touching the jobs projection. MUST stay an explicit empty arm: the final
      // `else` runs projectJobsRow, so deleting this arm would route historical
      // TmuxPaneSnapshot events into the jobs projection and break re-fold
      // determinism. The producer no longer posts this kind, but the historical
      // events remain in the log forever.
    } else if (event.hook_event === "WindowIndexSnapshot") {
      // retired fn-907 — the standalone window-index fold (epic fn-817) is
      // subsumed by the `TmuxTopologySnapshot` fold above (which carries
      // window_index per pane). Fold to NO-OP so historical WindowIndexSnapshot
      // events advance the cursor without touching the jobs projection. MUST stay
      // an explicit empty arm for the same re-fold-determinism reason as the
      // retired TmuxPaneSnapshot arm above — a deleted arm routes the historical
      // events into projectJobsRow. The producer no longer posts this kind.
    } else if (event.hook_event === "BackendExecStart") {
      // epic fn-819 — a backend generation boundary (restore-worker mints one on
      // a server-generation change). NO-OP fold: the boundary lives in the
      // event-log `id` order (read at restore time by `deriveLastGenerationSet`), not a
      // projection column. MUST stay an explicit empty arm — the final `else`
      // runs projectJobsRow, so deleting this arm would route BackendExecStart
      // into the jobs projection and corrupt it. A DISTINCT name from the retired
      // `BackendExecSnapshot` no-op arm above. The event still advances the
      // cursor; an empty re-fold reproduces zero rows (the producer probes the
      // pid, never the fold).
    } else if (event.hook_event === "PostToolUse") {
      // PostToolUse fans to BOTH projections plus syncIfPlanRef (inside
      // projectJobsRow); the 781ms avg is otherwise unattributable. Arm the
      // module-scoped syncIfPlanRef accumulator so its fan-out splits out of
      // the jobs-arm total. The syncPlanLinks accumulator (armed alongside)
      // adds the plan fan-out cardinality. Pure instrumentation — no
      // projection write reads either accumulator.
      _syncIfPlanRefAccumMs = 0;
      _syncPlanLinksAccum = {
        calls: 0,
        touchedEpics: 0,
        sweptSessions: 0,
        factsRows: 0,
        factsLoadMs: 0,
        deriveJobLinksMs: 0,
      };
      const _ptuT0 = performance.now();
      projectJobsRow(db, event);
      const _ptuT1 = performance.now();
      // The `subagent_invocations` projection rides the same transaction +
      // cursor advance — exactly-once-per-event holds across both projections.
      projectSubagentInvocationsRow(db, event);
      // The `scheduled_tasks` projection rides this same transaction too. Cron
      // events are PostToolUse, so this sibling lives in the PostToolUse arm
      // ONLY (the else arm below never sees CronCreate/CronDelete). The fn
      // fast-no-ops on every non-cron PostToolUse.
      projectScheduledTasksRow(db, event);
      const _ptuT2 = performance.now();
      const _ptuSyncMs = _syncIfPlanRefAccumMs;
      _syncIfPlanRefAccumMs = null;
      const _ptuPlanAccum = _syncPlanLinksAccum;
      _syncPlanLinksAccum = null;
      const _ptuTotal = _ptuT2 - _ptuT0;
      if (_ptuTotal >= PTU_FOLD_BREAKDOWN_MS) {
        // jobs_arm includes its own syncIfPlanRef cost; sync_fanout breaks it
        // out so jobs_arm−sync_fanout is the pure state-machine write. The
        // plan_* counters localize the syncPlanLinks fan-out shape.
        console.error(
          `[ptufold-breakdown] id=${event.id} total=${_ptuTotal.toFixed(0)}ms ` +
            `jobs_arm=${(_ptuT1 - _ptuT0).toFixed(0)}ms ` +
            `subagent_arm=${(_ptuT2 - _ptuT1).toFixed(0)}ms ` +
            `sync_fanout=${_ptuSyncMs.toFixed(0)}ms ` +
            formatSyncPlanFanout(_ptuPlanAccum),
        );
      }
    } else {
      // PreToolUse falls here with NO dedicated arm, yet a `/plan:plan` opener
      // (PreToolUse + skill_name='plan:plan') fires the syncPlanLinks fan-out
      // from inside projectJobsRow — the 437s incident fold was a PreToolUse and
      // had zero attribution. Arm the fan-out accumulators on the PreToolUse path
      // so a slow opener gets a breakdown line mirroring [ptufold-breakdown].
      // Pure instrumentation — no projection write reads either accumulator.
      const _ptuePre = event.hook_event === "PreToolUse";
      if (_ptuePre) {
        _syncIfPlanRefAccumMs = 0;
        _syncPlanLinksAccum = {
          calls: 0,
          touchedEpics: 0,
          sweptSessions: 0,
          factsRows: 0,
          factsLoadMs: 0,
          deriveJobLinksMs: 0,
        };
      }
      const _ptueT0 = _ptuePre ? performance.now() : 0;
      projectJobsRow(db, event);
      const _ptueT1 = _ptuePre ? performance.now() : 0;
      // The `subagent_invocations` projection rides the same transaction +
      // cursor advance — every triggering arm is folded inside this open
      // BEGIN IMMEDIATE so exactly-once-per-event holds across both
      // projections. Triggering hook_events: SubagentStart, SubagentStop,
      // PostToolUse (tool_name='Agent'), PostToolUseFailure
      // (tool_name='Agent'). Every other event is a fast in-fn no-op.
      projectSubagentInvocationsRow(db, event);
      if (_ptuePre) {
        const _ptueT2 = performance.now();
        const _ptueSyncMs = _syncIfPlanRefAccumMs ?? 0;
        _syncIfPlanRefAccumMs = null;
        const _ptuePlanAccum = _syncPlanLinksAccum;
        _syncPlanLinksAccum = null;
        const _ptueTotal = _ptueT2 - _ptueT0;
        if (_ptueTotal >= PTU_FOLD_BREAKDOWN_MS && _ptuePlanAccum != null) {
          // Same shape as [ptufold-breakdown]; subagent_arm is ~0 on PreToolUse
          // (never an Agent tool_use) but kept for line symmetry. plan_* is
          // the segment that would have convicted the 437s opener fold.
          console.error(
            `[pretufold-breakdown] id=${event.id} total=${_ptueTotal.toFixed(0)}ms ` +
              `jobs_arm=${(_ptueT1 - _ptueT0).toFixed(0)}ms ` +
              `subagent_arm=${(_ptueT2 - _ptueT1).toFixed(0)}ms ` +
              `sync_fanout=${_ptueSyncMs.toFixed(0)}ms ` +
              formatSyncPlanFanout(_ptuePlanAccum),
          );
        }
      }
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
  // t2: COMMIT done. Stamp the lock-wait/work split for `drain`'s [fold-slow]
  // line. `_foldT1` defaults to `_foldT0`, so a transaction body that threw
  // before its first statement reports zero lock-wait (the whole span is
  // attributed to work) rather than a negative number — a throw rolls back and
  // never reaches here anyway, so this is defense-in-depth.
  _foldLockWaitMs = _foldT1 - _foldT0;
  _foldWorkMs = performance.now() - _foldT1;
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
 * Threshold above which a PostToolUse fold emits a `[ptufold-breakdown]` line
 * splitting the jobs-arm vs the subagent-arm vs the syncIfPlanRef fan-out.
 * PostToolUse averages 781ms on the live DB — below the 1s mark the other
 * breakdowns use, so this gate is lower to catch the representative slow
 * PostToolUse fold. Gated so steady folds stay silent. Pure instrumentation.
 */
const PTU_FOLD_BREAKDOWN_MS = 500;

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
   * sleep (the same shape `plugins/keeper/plugin/hooks/events-writer.ts` uses for its bounded
   * retry) — a real sleep that releases the SQLite writer lock to a separate
   * process. Test-only injection point: a mock sleep can record call counts
   * and durations without paying the actual wall-clock cost. Production
   * callers leave this defaulted.
   */
  sleep?: (ms: number) => void;
  /**
   * Boot-drain checkpoint gate overrides (test-only). `drainToCompletion`'s
   * periodic PASSIVE fires when events-since-last-checkpoint cross
   * `checkpointEventInterval` OR the `-wal` file crosses `checkpointWalBytes`.
   * Both default to the production constants; a test shrinks them to exercise
   * the same checkpoint-caps-WAL contract at a fraction of the event/IO volume.
   * PASSIVE is pure space reclamation, so changing WHEN it fires never affects
   * fold output — production callers leave both defaulted.
   */
  checkpointEventInterval?: number;
  checkpointWalBytes?: number;
}

/**
 * Default OS-level synchronous sleep: blocks the JS thread for up to `ms`
 * milliseconds via `Atomics.wait` on a fresh zero-initialized
 * `SharedArrayBuffer`. Same shape `plugins/keeper/plugin/hooks/events-writer.ts` uses; the
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

  // fn-836.4: the `data` blob reads straight from `events.data` — the
  // `event_blobs` side table + its `COALESCE(events.data, event_blobs.data)`
  // dual-read are gone now that the shed restored every keep-set body inline
  // and dropped the table. Shed-class PostToolUse mutation rows carry NULL
  // `data` (their `tool_input.file_path` lives in `mutation_path`), and the
  // shed-class fold arm never reads the body, so a from-scratch re-fold over
  // the post-shed corpus reproduces byte-identical projection rows.
  const rows = db
    .query(
      `SELECT id, ts, session_id, pid, hook_event, event_type,
              tool_name, matcher, cwd, permission_mode, agent_id, agent_type,
              stop_hook_active, data,
              subagent_agent_id, spawn_name,
              start_time, slash_command, skill_name,
              plan_op, plan_target, plan_epic_id, plan_task_id,
              plan_subject_present, tool_use_id, config_dir, plan_files,
              backend_exec_type, backend_exec_session_id, backend_exec_pane_id,
              worktree, harness, resume_target, adopted, account_route
         FROM events
        WHERE id > ?
        ORDER BY id ASC
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
      //
      // `lock_wait_ms` (BEGIN IMMEDIATE contention) vs `work_ms` (the fold body
      // that held the lock) is stamped by `applyEvent`; their sum matches the
      // old `dur` within scheduler noise (the `foldStart`/`foldMs` span here
      // brackets the same call). This is the line that attributes a slow fold to
      // contention vs work in one read.
      console.error(
        `[fold-slow] id=${row.id} event=${row.hook_event ?? "?"} type=${row.event_type ?? "?"} ` +
          `dur=${Math.round(foldMs)}ms lock_wait_ms=${Math.round(_foldLockWaitMs)} ` +
          `work_ms=${Math.round(_foldWorkMs)}`,
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
