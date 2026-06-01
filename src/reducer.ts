/**
 * Keeper reducer. Folds events into the `jobs` projection.
 *
 * The core invariant is exactly-once-per-event: every fold of an event into
 * `jobs` and the matching advance of `reducer_state.last_event_id` happen in
 * the SAME `BEGIN IMMEDIATE` transaction. A crash mid-fold rolls back BOTH the
 * projection write and the cursor advance, so the boot drain simply re-folds
 * the event and converges. This is the textbook "update projection + advance
 * cursor atomically" pattern.
 *
 * The state machine is a heavily stripped descendant of hooks-tracker.py's
 * `_maintain_job_state`. All prise / harness / lineage / name-scraping logic is
 * intentionally dropped — keeper v1 holds the simplifying invariant that
 * `job_id === session_id` (one session per job).
 *
 *   event.hook_event   | jobs action
 *   -------------------|------------------------------------------------------
 *   SessionStart        | INSERT a new job row; seed title from spawn_name
 *                       |   ('spawn' source) when present. On a duplicate
 *                       |   (resume) RE-OPEN a terminal row: 'ended' or
 *                       |   'killed' -> 'stopped' + refresh pid + start_time;
 *                       |   a non-terminal row's state is left as-is.
 *   UserPromptSubmit    | state -> 'working'  (also re-opens 'ended' or 'killed')
 *                       |   AND clears (last_api_error_at, last_api_error_kind)
 *                       |   to (NULL, NULL) together — a fresh prompt means
 *                       |   the human picked up after the quota reset /
 *                       |   re-auth / retry, so the "this stoppage was
 *                       |   api-error-caused" annotation no longer applies.
 *                       |   EXCEPT when the prompt is Claude Code's
 *                       |   `<task-notification>…<status>killed</status>`
 *                       |   shutdown-housekeeping envelope — those are no-ops
 *                       |   for the lifecycle write (the title rule still
 *                       |   runs). See `isKilledTaskNotification` in
 *                       |   `src/derivers.ts` for the modest-scope rationale.
 *   Stop                | state -> 'stopped'  (skipped on 'ended' or 'killed',
 *                       |   AND skipped while any subagent_invocations row for
 *                       |   this job is status='running' — the parent's Stop
 *                       |   hook fires when it yields to a Task tool's sub-
 *                       |   agent, but the session is conceptually still
 *                       |   working until the sub returns AND any post-sub
 *                       |   follow-up finishes on a subsequent real Stop.
 *                       |   Without this guard the embedded JobLinkEntry.state
 *                       |   flashes to 'stopped' mid-sub-agent, which clears
 *                       |   readiness predicate 5 prematurely and lets
 *                       |   predicate 7 fire job-pending at every SubagentStop
 *                       |   — autopilot's approval notify then dup-fires.)
 *   SessionEnd          | state -> 'ended'    (skipped on 'killed' — the kill
 *                       |   signal carries proven-dead evidence and outranks)
 *   Killed              | state -> 'killed'   (synthetic; folds iff persisted
 *                       |   (pid, start_time) matches the event payload, OR
 *                       |   the persisted start_time is NULL — legacy loose
 *                       |   match. Race-recovered mismatches are no-ops.)
 *   RateLimited/ApiError| state -> 'stopped' AND (last_api_error_at,
 *                       |   last_api_error_kind) -> (event.ts, kind) — both
 *                       |   columns paired in a single UPDATE. The state flip
 *                       |   is suppressed (via a CASE) while any
 *                       |   subagent_invocations row for this job is
 *                       |   status='running' — same rationale as Stop; the
 *                       |   parent isn't actively making API calls while it
 *                       |   waits on a sub-agent, but if an error annotation
 *                       |   lands during that window the projection should
 *                       |   record it WITHOUT misreporting the session as
 *                       |   stopped. The (last_api_error_at, last_api_error_kind)
 *                       |   pair stamps unconditionally so the annotation
 *                       |   reading stays honest. (Synthetic;
 *                       |   skipped on 'ended' or 'killed' — same terminal
 *                       |   guard as Stop. Minted by main from a transcript
 *                       |   -worker `api-error` message when Claude Code
 *                       |   writes its `isApiErrorMessage: true` synthetic
 *                       |   assistant turn to the transcript.) The legacy
 *                       |   `RateLimited` event_type folds to
 *                       |   `kind="rate_limit"` for byte-identical re-fold of
 *                       |   the pre-v24 event log; the new `ApiError`
 *                       |   event_type reads `data.kind` validated against
 *                       |   the `ApiErrorKind` allow-list (unknown values
 *                       |   fold to `"unknown"`). The lifecycle column
 *                       |   tracks "is the session running" honestly — the
 *                       |   API request failed at the boundary, no work is
 *                       |   happening — and the (last_api_error_at,
 *                       |   last_api_error_kind) pair carries the separate
 *                       |   "*why* it's stopped" annotation that survives
 *                       |   Stop/SessionEnd/Killed and only clears on the
 *                       |   next UserPromptSubmit revival.
 *   <any with title>    | title -> data.session_title by precedence (the
 *                       |   source is 'transcript' for a TranscriptTitle event,
 *                       |   else 'payload'; write iff it outranks/ties+changes)
 *   <everything else>   | no jobs write; cursor still advances
 *
 * `ended` is the resting state AFTER a SessionEnd, NOT a permanent trap. A
 * genuinely-ended session can only come back by re-attaching — a fresh
 * `claude --resume` process fires SessionStart (source=resume) — or by submitting
 * a prompt straight away (a UserPromptSubmit with no SessionStart, e.g. after a
 * spurious mid-session SessionEnd); BOTH re-open the job. `killed` is the
 * sibling terminal state reached via a synthetic `Killed` event — emitted by
 * the boot seed sweep (`src/seed-sweep.ts`) and the live exit-watcher worker
 * (`src/exit-watcher.ts`) when a `(pid, start_time)` pair is proven dead from
 * outside the hook stream. Both terminal states are revivable on the same
 * SessionStart / UserPromptSubmit re-open paths; only a stray `Stop` on a
 * still-terminal job stays a no-op. The `Killed` event folds normally — it is
 * a deterministic function of its payload + the persisted (pid, start_time),
 * with no liveness re-probe inside the fold (re-probing would break re-fold
 * determinism — the producer is the ONLY place that probes liveness).
 *
 * Title provenance/precedence: NULL=0, 'spawn'=1, 'payload'=2, 'transcript'=3.
 * A higher source wins; a lower one never clobbers a higher one (see
 * {@link TITLE_PRIORITY}). The synthetic `TranscriptTitle` event (inserted by
 * keeperd's main thread, title carried in `data.session_title`) folds at
 * priority 3 — it triggers no lifecycle write (the `default` branch ignores it)
 * and flows only through the title rule.
 */

import type { Database } from "bun:sqlite";
import {
  extractCommit,
  isKilledTaskNotification,
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
  ResolvedEpicDep,
} from "./types";
import { API_ERROR_KINDS } from "./types";

/**
 * Default batch size for {@link drain}. Keeps each writer transaction short so
 * the reducer never holds the WAL writer lock long enough to block hook
 * inserts; the caller loops until `drain()` returns 0.
 */
export const DEFAULT_BATCH_SIZE = 200;

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
 * Terminal-but-revivable job state. Reached by a synthetic `Killed` event
 * (emitted by the boot seed sweep + the live exit-watcher when a `(pid,
 * start_time)` pair is proven dead). Unlike {@link ENDED} — which comes from
 * the SessionEnd hook — `killed` indicates we proved the process is gone from
 * the OUTSIDE: pid no longer exists, or recycled into a different process.
 *
 * Revival: SessionStart and UserPromptSubmit re-open a killed row (the producer
 * can probe a live new process for that session); every other hook event
 * IGNORES a killed row (the row stays killed). See the Stop / SessionEnd
 * guards below.
 */
const KILLED = "killed";

/**
 * Recency bound (unix-SECONDS) for the Stop fold's sub-agent guard. A one-shot
 * orphan sub-agent that never emits `SubagentStop` (sub crashed, hook timed
 * out, hook write lost to the "hook always exits 0" contract) would otherwise
 * pin its parent job at `state='working'` forever — the Stop guard's
 * `subRunning` query would keep finding the surviving running row, swallow
 * every subsequent Stop, and hold the per-root/per-epic autopilot mutex open
 * until a human closes the window. Until now `sweepRunningSubagentsToUnknown`
 * was the sole orphan resolver and ran ONLY on SessionEnd/Killed.
 *
 * The bound: if the newest surviving `running` sub-agent's `ts` (the same row
 * the existing max-`turn_seq` collapse query already returns) is older than
 * this many seconds relative to the Stop event's `ts`, the guard releases —
 * the Stop fold writes `state='stopped'` and re-fans the embedded plan
 * entries normally (`syncIfPlanRef` / `syncJobLinksOnJobWrite`).
 *
 * Both `events.ts` and `subagent_invocations.ts` are REAL unix-SECONDS
 * (`db.ts:399-413`, and the `(event.ts - row.ts) * 1000` ms convention at
 * `applySubagentInvocations`). The age comparison is in seconds — multiplying
 * by 1000 would be a 1000x bug.
 *
 * Pure function of the event log: the comparison is `event.ts - row.ts`
 * against a compile-time constant — no `Date.now()`, no config, no
 * `meta`-row source. Re-fold determinism holds (CLAUDE.md "Producer-only
 * liveness probing": fold-time comparisons against an event's own `ts` are
 * safe; OS-clock reads inside the fold are banned).
 *
 * Tradeoffs of the chosen value:
 *
 * - Too large → a real stuck sub-agent holds the mutex longer than necessary
 *   before autopilot can redispatch.
 * - Too small → a legitimately slow in-flight sub-agent flashes `stopped`
 *   prematurely; readiness predicate 5 clears for a tick and predicate 7
 *   spuriously fires `job-pending` (autopilot's approval-notify can dup).
 *
 * 120s sits well above the p99 sub-agent latency observed in keeper's own
 * traces while keeping the wedge window short enough that an orphaned worker
 * doesn't sit "working" for a full Claude Code session window.
 */
const MAX_STOP_YIELD_GAP_SEC = 120;

/**
 * Validate an event's `data.kind` against the {@link ApiErrorKind} union.
 * Anything not in the canonical allow-list — including missing /
 * non-string / unrecognized values like the SDK's own `"unknown"` —
 * folds to `"unknown"`. Pure (no side effects, no throws); the fold
 * arm calls it inside the open `BEGIN IMMEDIATE` transaction.
 *
 * Used by the dual-case `ApiError` arm: legacy `RateLimited` events
 * skip this and force `kind = "rate_limit"` directly; new `ApiError`
 * events route their `data.kind` through here.
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
 * Parse the `kind` out of an event's `data` blob for the dual-case
 * `RateLimited` / `ApiError` fold arm. Safe-parse: a malformed blob
 * folds to `"unknown"` (never throws inside the fold transaction).
 * The legacy `RateLimited` event_type forces `"rate_limit"` upstream
 * — this helper is only called on the `ApiError` arm.
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
 * Canonical `InputRequestKind` allow-list — string literals so the
 * runtime validation `validateInputRequestKind` can `.has` against a
 * Set. The values mirror {@link import("./types").InputRequestKind}
 * exactly; if the type widens or narrows the set MUST be updated in
 * lockstep. The fallback for an unrecognized value is the only union
 * member (`"ask_user_question"`) — unlike `ApiErrorKind` there is no
 * reserved `"unknown"` bucket, because the transcript matcher only
 * fires `input-request` messages for kinds it has explicitly mapped
 * (no upstream allow-list to bypass).
 */
const INPUT_REQUEST_KINDS: ReadonlySet<InputRequestKind> = new Set([
  "ask_user_question",
]);

/**
 * Validate an event's `data.kind` against the {@link InputRequestKind}
 * union. Anything not in the canonical allow-list — including missing /
 * non-string / unrecognized values — folds to `"ask_user_question"`,
 * the single-member union's only value. Pure (no side effects, no
 * throws); the fold arm calls it inside the open `BEGIN IMMEDIATE`
 * transaction. Mirrors {@link validateApiErrorKind}'s shape minus the
 * reserved `"unknown"` fallback.
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
 * Parse the `kind` out of an event's `data` blob for the `InputRequest`
 * fold arm. Safe-parse: a malformed blob folds to `"ask_user_question"`
 * (never throws inside the fold transaction). Mirrors
 * {@link extractApiErrorKind} step-for-step.
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
 * Title-source precedence. A higher number wins. NULL `title_source` (the
 * zero-event reading, no title written yet) maps to priority 0 via
 * {@link sourcePriority}. The reducer writes a new title iff the incoming
 * source outranks the persisted one (`p > pp`) OR ties it with a changed value
 * (`p === pp && value changed`) — so a lower-priority source NEVER clobbers a
 * higher one, and an equal-priority re-fold is a value-only last-write-wins.
 *
 * The transcript-supplement source slots in as `3` with no precedence-write
 * rewrite — {@link titleSourceForEvent} maps a `TranscriptTitle` event to it
 * and the same write block promotes the title.
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
 * Extract the top-level `session_title` from an event's `data` blob. try/catch
 * around `JSON.parse(event.data)`, skip-and-log via `console.error` on a
 * malformed blob (the cursor still advances upstream so one bad row never
 * wedges the reducer). `session_title` is NOT lifted to an events column — the
 * raw blob is its only carrier.
 *
 * Run event-agnostically like the mode rule (not gated to UserPromptSubmit); in
 * practice only UserPromptSubmit carries it. Returns the title only when it is a
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
      // Malformed JSON: skip-and-log. The cursor still advances upstream so the
      // reducer never wedges on one bad row.
      console.error(
        `keeper reducer: failed to parse data blob for event id=${event.id} session=${event.session_id}: ${err}`,
      );
    }
  }
  return null;
}

/**
 * Resolve the title-source for an event carrying a `session_title`. A synthetic
 * `TranscriptTitle` event (inserted by keeperd's main thread when the watcher
 * sees a `custom-title` line) folds at the priority-3 `'transcript'` source;
 * every other title-bearing event (in practice `UserPromptSubmit`) is the
 * priority-2 `'payload'` source. Both reuse {@link extractSessionTitle} — the
 * synthetic event carries its title in the same `data.session_title` field, so
 * no second extractor exists.
 */
function titleSourceForEvent(event: Event): string {
  return event.hook_event === "TranscriptTitle" ? "transcript" : "payload";
}

/**
 * Extract the top-level `prompt` from an event's `data` blob — meaningful
 * only on `UserPromptSubmit` events. Guarded-parse mirroring
 * {@link extractSessionTitle}: try/catch around `JSON.parse(event.data)`,
 * skip-and-log on a malformed blob, never throw (the cursor still advances
 * upstream so one bad row never wedges the reducer). Returns the prompt only
 * when it is a non-empty string, else `null`.
 *
 * Used by the `UserPromptSubmit` lifecycle branch to detect Claude Code's
 * `<task-notification>…<status>killed</status>` shutdown-housekeeping
 * envelope via {@link isKilledTaskNotification} — see
 * `src/derivers.ts` for the regex shape + modesty rationale.
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
 * blob. Guarded-parse mirroring {@link extractSessionTitle}: try/catch around
 * `JSON.parse(event.data)`, skip-and-log on a malformed blob, never throw (the
 * cursor still advances upstream). Returns the path only when it is a non-empty
 * absolute string, else `null` — so the SessionStart seed leaves
 * `jobs.transcript_path` NULL when the payload omits or malforms it.
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
      // Malformed JSON: skip-and-log. The cursor still advances upstream so the
      // reducer never wedges on one bad row.
      console.error(
        `keeper reducer: failed to parse data blob for event id=${event.id} session=${event.session_id}: ${err}`,
      );
    }
  }
  return null;
}

/**
 * Shape of a synthetic `Killed` event's payload — the `(pid, start_time)`
 * recycle-safe identity the producer (boot seed sweep / live exit-watcher)
 * proved dead. The reducer compares this verbatim against the persisted
 * `(jobs.pid, jobs.start_time)` to decide whether the row should fold to
 * `killed` (match) or stay put (mismatch / stale).
 */
interface KilledPayload {
  pid: number;
  start_time: string | null;
}

/**
 * Extract the `(pid, start_time)` payload from a synthetic `Killed` event's
 * `data` blob. Guarded-parse mirroring {@link extractSessionTitle}: try/catch
 * around `JSON.parse(event.data)`, skip-and-log on a malformed blob, never
 * throw — the cursor still advances upstream, and the Killed fold falls through
 * as a safe no-op when this returns null.
 *
 * `pid` is required (a Killed event with no pid is meaningless — there's
 * nothing to match against). `start_time` is optional / nullable — the producer
 * may emit a Killed for a row whose stored start_time is NULL (legacy / loose
 * pid-only match handled by the Killed fold).
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
    if (typeof pid !== "number" || !Number.isFinite(pid)) {
      return null;
    }
    const startTime =
      typeof parsed.start_time === "string" ? parsed.start_time : null;
    return { pid, start_time: startTime };
  } catch (err) {
    // Malformed JSON: skip-and-log. The cursor still advances upstream so the
    // reducer never wedges on one bad row.
    console.error(
      `keeper reducer: failed to parse Killed payload blob for event id=${event.id} session=${event.session_id}: ${err}`,
    );
    return null;
  }
}

/**
 * Shape of a folded plan snapshot, extracted from a synthetic
 * `EpicSnapshot` / `TaskSnapshot` event's `data` blob. The producer (the plan
 * worker → main) pre-computes every field — number parsing, status derivation,
 * the `project_dir` / `target_repo` mapping — so the reducer folds whatever the
 * blob carries verbatim (a pure function of the persisted event). Unknown /
 * absent fields surface as `null` so the upsert writes the zero-event reading.
 *
 * The fields are a union of the epic + task projection columns minus the pk
 * (which rides in `event.session_id`, the generic entity-key overload); a given
 * event only populates the subset its kind cares about.
 */
interface PlanSnapshot {
  epic_number?: number | null;
  task_number?: number | null;
  title?: string | null;
  project_dir?: string | null;
  target_repo?: string | null;
  /**
   * Planctl-native effort tier on TaskSnapshot blobs (fn-602): the top-level
   * `tier` field on the task-def file (planctl's `medium | high | xhigh | max`
   * vocabulary). Stored opaque — the reducer never branches on the value, so
   * a future tier widening rides through with no code change. Absent on pre-
   * fn-602 blobs; the reducer reads defensively (`snapshot.tier ?? null`) so
   * an older blob folds to a null tier deterministically — same graceful-
   * degradation precedent as `worker_phase`/`runtime_status`. Rides FREE in
   * the embedded-tasks JSON; no schema column, no SCHEMA_VERSION bump.
   */
  tier?: string | null;
  epic_id?: string | null;
  status?: string | null;
  /**
   * Derived worker-phase binary on TaskSnapshot blobs (schema v19): the same
   * compressed signal the field used to carry under the legacy `status`
   * column on the embedded task element (`worker_done_at` present → `"done"`,
   * else `"open"`). Renamed from `status` to free up `runtime_status` (below)
   * for the planctl-native enum. A pre-v19 TaskSnapshot blob carries
   * `status` instead; the reducer reads `worker_phase ?? status` for
   * re-fold determinism across the version boundary.
   */
  worker_phase?: string | null;
  /**
   * Planctl-native runtime status on TaskSnapshot blobs (schema v19): the
   * top-level `status` field of `.planctl/state/tasks/<task_id>.state.json`
   * (`"todo" | "in_progress" | "done" | "blocked"`). Absent on pre-v19 blobs;
   * the reducer reads defensively (`runtime_status ?? "todo"` — planctl's
   * `merge_task_state` convention) so an older blob still folds
   * deterministically.
   */
  runtime_status?: string | null;
  /**
   * Planctl-native approval enum (schema v13). Pre-coerced by the plan-worker
   * to `"approved" | "rejected" | "pending"`; absent / NULL → folds to
   * `"pending"` so an old-shape blob still rides through deterministically.
   */
  approval?: "approved" | "rejected" | "pending" | null;
  /** Epic-level deps (EpicSnapshot blob) — the planctl `depends_on_epics` ids. */
  depends_on_epics?: string[] | null;
  /** Task-level deps (TaskSnapshot blob) — the planctl `depends_on` task ids. */
  depends_on?: string[] | null;
  /**
   * Planctl-native `last_validated_at` (EpicSnapshot blob — epic-level only).
   * Plain ISO-8601 string when present; absent / NULL folds to `null` so a
   * blob from an older daemon build (or an unvalidated epic file) reproduces
   * the same row across re-fold. Schema column is nullable TEXT — no default.
   */
  last_validated_at?: string | null;
}

/**
 * Extract the full plan snapshot from a synthetic `EpicSnapshot` /
 * `TaskSnapshot` event's `data` blob. Guarded-parse mirroring
 * {@link extractSessionTitle} / {@link extractTranscriptPath}: try/catch around
 * `JSON.parse(event.data)`, skip-and-log on a malformed blob, never throw — the
 * cursor still advances upstream, so one bad snapshot row never wedges the
 * reducer. Returns `null` on a missing/malformed blob (the caller then makes the
 * fold a no-op for that event).
 *
 * Every field is taken verbatim from the blob — the producer pre-computes
 * number parsing + status derivation, so the reducer stays a pure function of
 * the persisted event and a from-scratch re-fold is byte-identical.
 */
function extractPlanSnapshot(event: Event): PlanSnapshot | null {
  if (event.data && event.data.length > 0) {
    try {
      return JSON.parse(event.data) as PlanSnapshot;
    } catch (err) {
      // Malformed JSON: skip-and-log. The cursor still advances upstream so the
      // reducer never wedges on one bad row.
      console.error(
        `keeper reducer: failed to parse plan snapshot blob for event id=${event.id} entity=${event.session_id}: ${err}`,
      );
    }
  }
  return null;
}

/**
 * Apply the plan-side projection for one synthetic `EpicSnapshot` /
 * `TaskSnapshot` event. Runs INSIDE the open transaction opened by
 * {@link applyEvent}; performs zero cursor work.
 *
 * The entity id rides in `event.session_id` (the generic entity-key overload —
 * always non-NULL, guaranteed by the producer), the full snapshot rides in the
 * `data` JSON blob. Each kind upserts its projection table with
 * `INSERT … ON CONFLICT(<pk>) DO UPDATE` so a re-arrived snapshot is idempotent
 * last-write-wins. `last_event_id = event.id` on every fold — the monotonic
 * per-row `version` column the read-surface diff fires on (jobs uses the same);
 * `updated_at = event.ts`.
 *
 * Plans are state-on-disk full snapshots, so unlike jobs there is no
 * accumulating lifecycle — every column is overwritten from the blob each fold.
 * A missing/malformed blob is a no-op (extract returned null); the cursor still
 * advances upstream.
 */
/** Zero-pad an integer to width 6 for schema-v29 `sort_path` keys. */
const zeroPad6 = (n: number): string => String(n).padStart(6, "0");

function projectPlanRow(db: Database, event: Event): void {
  const snapshot = extractPlanSnapshot(event);
  if (snapshot == null) {
    return;
  }
  const ts = event.ts;
  const entityId = event.session_id;

  if (event.hook_event === "EpicSnapshot") {
    // The ON CONFLICT update lists ONLY scalar columns and NEVER `tasks` /
    // `jobs` / `job_links` / `created_by_closer_of` / `sort_path` /
    // `queue_jump` / `resolved_epic_deps`: an epic snapshot carries no
    // task, job, job-link, closer-derivation, queue-jump, OR dep-
    // resolution data, and a shell row inserted by a task-before-epic
    // TaskSnapshot, a job-before-epic `syncJobIntoEpic`, or a
    // planctl-event-before-epic `syncPlanctlLinks` already holds those
    // columns (the planctl-event shell stamps `job_links` real and leaves
    // the schema-v29 closer columns + the schema-v30 queue-jump column at
    // NULL / '' / 0 for the next `syncPlanctlLinks` call to compute). The
    // schema-v34 (fn-637) `resolved_epic_deps` column is computed AFTER
    // this INSERT/UPDATE by `syncEpicDepsForward` against the post-write
    // row; INSERT defaults it to NULL (the schema column default) and the
    // ON CONFLICT carve-out preserves the just-computed projection
    // across the next snapshot fold. Without the carve-out, an
    // approval RPC → atomic file write → file-watcher → EpicSnapshot fold
    // would wipe the creator/refiner provenance projection (schema v14)
    // AND the closer-creator link + materialized-path sort key (schema
    // v29) AND the priority-jump flag (schema v30) AND the resolved-
    // deps projection (schema v34) on every approval flip.
    db.run(
      `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, approval, depends_on_epics, last_validated_at, last_event_id, updated_at, created_by_closer_of, sort_path, queue_jump)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '', 0)
       ON CONFLICT(epic_id) DO UPDATE SET
         epic_number = excluded.epic_number,
         title = excluded.title,
         project_dir = excluded.project_dir,
         status = excluded.status,
         approval = excluded.approval,
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
        // The plan-worker pre-coerced this to the enum (or `"pending"`); a
        // missing / NULL value in the blob — a synthetic event from an
        // older keeperd build — folds to `"pending"` so the schema's NOT NULL
        // default is honored AND re-fold determinism is preserved across the
        // v12→v13 boundary (an event produced before approval existed in the
        // pipeline reproduces a `"pending"` row, same as on the older daemon).
        snapshot.approval ?? "pending",
        // Stored as a JSON-TEXT array column; decoded back to an array at the
        // read boundary. A missing list folds to the empty array (schema default).
        JSON.stringify(snapshot.depends_on_epics ?? []),
        // Nullable TEXT — no DEFAULT; a missing / NULL blob value (older
        // daemon build, or an unvalidated epic file) folds to NULL so the
        // pre-v16 zero-event reading is preserved across re-fold.
        snapshot.last_validated_at ?? null,
        event.id,
        ts,
      ],
    );
    // Schema v29: if `sort_path` is still '' (no `syncPlanctlLinks` has run
    // yet) but `epic_number` is now known, derive the sort_path so that child
    // epics can inherit a non-empty parent path. This is the "parent's
    // EpicSnapshot triggers cascade re-stamp" behaviour — an EpicSnapshot for
    // a root epic unblocks the chain without requiring a planctl event.
    //
    // Schema v30: also read `queue_jump` off the existing row (the ON
    // CONFLICT carve-out above preserves it across snapshot folds) and
    // prepend `!` to the path for ROOT epics whose `queue_jump = 1`. A
    // non-root queue-jumped epic inherits its parent's path verbatim — the
    // root parent's `!`-prefix propagates through the `parentPath` string
    // concat for free (no double-prefix risk). The `!` (ASCII 33) sorts
    // strictly below the digits (ASCII 48-57) under SQLite BINARY collation,
    // so a queue-jumped root lifts above every non-queued root in the
    // dashctl board's default ORDER BY.
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

    // Schema v34 (fn-637): forward stamp + reverse fan-out for
    // `resolved_epic_deps` + `epic_dep_edges`. Built ONCE per EpicSnapshot
    // — the all-epics index assembled here is shared across the forward
    // pass (the consumer is THIS epic; its edges + projection rebuild
    // from scratch) and the reverse pass (every consumer whose
    // `depends_on_epics` token IN (this.epic_id, 'fn-' || this.epic_number)
    // — they re-resolve against the same index so a state flip on the
    // upstream propagates in lockstep).
    //
    // Read-in-fold is allowed (the autocommit ban is on DB watchers,
    // not query reads). The all-epics scan is ~1k rows on the steady-
    // state DB; the per-event cost is dominated by the per-consumer
    // re-stamps in the reverse pass.
    //
    // Order: forward FIRST, reverse SECOND. The reverse pass reads the
    // consumer's `epics` row and re-resolves against the upstream's
    // post-write state; running it AFTER the forward pass keeps the
    // upstream's own row settled before downstream consumers re-stamp
    // against it.
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
      // Read the upstream's epic_number off the just-settled row (the
      // forward pass may have stamped sort_path / resolved_epic_deps but
      // didn't touch epic_number itself — the EpicSnapshot's INSERT/UPDATE
      // did). A NULL epic_number means the reverse lookup skips the
      // bare-id (`fn-N`) branch but still considers the full id.
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
    // `depends_on` is last (matches the Task interface order) so a re-folded
    // element serializes byte-identically; a missing list folds to []. The
    // embedded `jobs` sub-array is preserved from the OLD element below (a
    // plan-file snapshot carries no job data — see the RMW preservation step
    // before push), or defaults to `[]` for a first-sight task.
    // The SLOT ORDER of the keys below is load-bearing: `seedFromDb` in
    // `plan-worker.ts` reconstructs `PlanTaskMessage` from this persisted
    // element shape, and the change-gate fingerprint is a `JSON.stringify`
    // byte-compare. Any rename or reorder MUST be mirrored on
    // `PlanTaskMessage` + `buildTaskMessage` + `seedFromDb`, or every task
    // re-emits a synthetic snapshot on every daemon boot.
    const element: {
      task_id: string;
      epic_id: string;
      task_number: number | null;
      title: string | null;
      target_repo: string | null;
      tier: string | null;
      worker_phase: string | null;
      runtime_status: string;
      approval: "approved" | "rejected" | "pending";
      depends_on: string[];
      jobs: unknown[];
    } = {
      task_id: entityId,
      epic_id: epicId,
      task_number: snapshot.task_number ?? null,
      title: snapshot.title ?? null,
      target_repo: snapshot.target_repo ?? null,
      // Planctl-native effort tier (fn-602): rides FREE in the embedded JSON
      // — no schema column, no SCHEMA_VERSION bump. Pre-fn-602 TaskSnapshot
      // blobs lack the field and fold to `null` (graceful-degradation
      // precedent shared with `worker_phase` / `runtime_status`); a later
      // planctl re-emit of the task fills it. The slot lives after
      // `target_repo` to match `PlanTaskMessage` / `seedFromDb` / the
      // `TaskElement` shell in `syncJobIntoEpic` — the change-gate
      // `JSON.stringify` byte-compare relies on consistent slot order
      // across all four sites (see CLAUDE.md "SLOT ORDER is load-bearing").
      tier: snapshot.tier ?? null,
      // Renamed from the legacy `status` column on the embedded element
      // (schema v19). A pre-v19 TaskSnapshot blob carries `status` instead of
      // `worker_phase`; read whichever is present so a re-fold reproduces
      // the same value across the version boundary.
      worker_phase: snapshot.worker_phase ?? snapshot.status ?? null,
      // Planctl-native runtime status (`todo|in_progress|done|blocked`),
      // ingested from `.planctl/state/tasks/<task_id>.state.json` and pre-
      // coerced by the plan-worker. Absent on pre-v19 blobs / never-observed
      // state files → folds to `"todo"` per planctl's `merge_task_state`
      // convention (a fresh clone with no `state/` tree reads every task as
      // `todo`).
      runtime_status: snapshot.runtime_status ?? "todo",
      // Pre-coerced by the plan-worker; a missing / NULL value in a legacy
      // synthetic event folds to "pending" so re-fold determinism survives the
      // v12→v13 boundary (same default as the schema column on the parent
      // epic). The field is placed BEFORE `depends_on` to match the seed
      // reconstruction order in `plan-worker.ts:seedFromDb` so an unchanged
      // task on restart suppresses cleanly.
      approval: snapshot.approval ?? "pending",
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

    // Preserve the OLD element's `jobs` sub-array before re-placing. Plan-file
    // snapshots carry zero job info — they MUST NOT clobber live state. Without
    // this read-then-attach, every plan-file edit would drop the
    // job-association list. A first-sight task (no OLD element) keeps the
    // default `[]` set on `element` above.
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
      // No epic row yet — insert a SHELL (epic_id set, scalar columns NULL,
      // the array carrying this one task). A later EpicSnapshot fills the
      // scalars without clobbering `tasks` (its ON CONFLICT omits the column).
      db.run(
        `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, last_event_id, updated_at, tasks)
           VALUES (?, NULL, NULL, NULL, NULL, ?, ?, ?)`,
        [epicId, event.id, ts, tasksJson],
      );
    }
  }
}

/**
 * Apply a plan-side RETRACTION for one synthetic `EpicDeleted` / `TaskDeleted`
 * tombstone event. Runs INSIDE the open transaction opened by
 * {@link applyEvent}; performs zero cursor work.
 *
 * Tombstones are the only replay-deterministic way to fold a delete: a file
 * vanishing off disk leaves no event, so the producer emits an explicit
 * tombstone that rides the same synthetic-event pipeline as the snapshots. A
 * re-fold from scratch replays the create→delete sequence and reproduces the
 * same retracted state.
 *
 * - `EpicDeleted`: `DELETE FROM epics WHERE epic_id = ?` — the embedded `tasks`
 *   array vanishes with the row. The entity id rides in `event.session_id`.
 * - `TaskDeleted`: a read-modify-write on the PARENT epic's embedded array —
 *   splice out the element by `task_id` (the task pk in `event.session_id`),
 *   re-sort, write back, bump `last_event_id`/`updated_at` so the retraction
 *   `patch`es. The parent key rides in the `data` blob's `epic_id`.
 *
 * Both folds are idempotent no-ops on a missing target (epic / element already
 * gone, or — for a task — a null `epic_id` we can't place against), and never
 * throw inside the transaction (a throw rolls back the cursor and wedges the
 * reducer); a malformed stored array folds to `[]`.
 */
function retractPlanRow(db: Database, event: Event): void {
  const entityId = event.session_id;

  if (event.hook_event === "EpicDeleted") {
    // Schema v34 (fn-637): capture the upstream's epic_number BEFORE the
    // DELETE so the reverse fan-out can re-stamp downstream consumers
    // that depended on the bare-id form (`fn-N`) — the row is about to
    // vanish, taking `epic_number` with it. Idempotent: a missing epic
    // reads `null`, falls through, and the DELETE is a no-op match.
    const pre = db
      .query("SELECT epic_number FROM epics WHERE epic_id = ?")
      .get(entityId) as { epic_number: number | null } | null;
    db.run("DELETE FROM epics WHERE epic_id = ?", [entityId]);
    // Also drop the upstream's OWN edges row — the consumer→token
    // index for THIS epic as a consumer is gone with the row, so its
    // back-references should not linger. Forward-only: re-fold from
    // scratch replays the create→delete sequence and reproduces the
    // same retracted state. Idempotent: zero matches on a never-existed
    // / already-retracted edge.
    db.run("DELETE FROM epic_dep_edges WHERE consumer_id = ?", [entityId]);
    // Reverse fan-out — re-stamp every downstream consumer whose
    // `depends_on_epics` carried this epic's full id or bare id. The
    // resolver re-runs against the post-DELETE `epics` table: a
    // matching upstream now misses and the consumer's matching entry
    // flips to `dangling`. Order matters: DELETE FIRST so the resolver
    // observes the missing row; reverse fan-out SECOND. Built ONCE per
    // EpicDeleted — same shape as the EpicSnapshot path.
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
  // parent key is the blob's `epic_id` (the file is gone, so the producer
  // recovered it from the change-gate). A null/absent epic_id can't be placed —
  // no-op, cursor still advances upstream.
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

  // Re-sort by the SAME (task_number, task_id) key the snapshot fold + migration
  // backfill use, so the spliced array stays deterministically ordered.
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
 * Reducer-local view of one entry in the producer's `dirty_files[]` array.
 * Field-for-field a {@link import("./git-worker").GitDirtyFile} with every
 * field defensively re-typed as the safe-fold fallback (the producer is a
 * separate process, so the reducer cannot trust shape — every parse path
 * has to fold to a safe value rather than throw inside the BEGIN IMMEDIATE
 * transaction).
 */
interface ReducerDirtyFile {
  path: string;
  xy: string;
  orig_path: string | null;
  mtime_ms: number | null;
  /**
   * Schema v44 / fn-664: filter-correct worktree blob oid (`git hash-object
   * --stdin-paths` per file at producer time), staged blob oid (porcelain v2
   * `hI`), and worktree file mode (porcelain v2 `mW`). All three are
   * frozen-into-payload pure facts — no fold-time git probe, re-fold
   * deterministic. Each parses to `null` independently when (a) the producer
   * couldn't compute it, (b) the event pre-dates v44 and the field is
   * absent, or (c) the per-file shape is malformed. Task .1 stamps
   * `worktree_oid` into `file_attributions` (additive UPSERT column) but
   * does NOT yet read it for discharge; task .2 of the epic switches
   * `foldCommit` to gate on `committed_oid == worktree_oid`.
   */
  worktree_oid: string | null;
  index_oid: string | null;
  worktree_mode: string | null;
}

/**
 * Reducer-local view of the v31 file-centric `GitSnapshot` payload. The
 * producer narrowed to `{project_dir, branch, head_oid, upstream, ahead,
 * behind, dirty_files[]}` in fn-633.5; this task (.6) derives every other
 * facet — per-(session, file) attribution rows, per-job dirty rollup,
 * project-broadcast orphan/unattributed counts, and the rendered
 * `dirty_files[].attributions[]` JSON — inside `BEGIN IMMEDIATE` against
 * the persisted event log + `file_attributions` table. No more
 * `orphaned_files` or `jobs[]` lifted from the event blob (the
 * transitional shape was removed at this task; historical events stored
 * against the wide shape still parse — extra keys are ignored — but their
 * `orphaned_files` / `jobs[]` are never read).
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
  // Per-file defensive parse: every field guarded against shape mismatch.
  // A bad file folds to `null` (skipped); a bad mtime folds to `null` (the
  // file simply gets no inferred-attribution chance in pass 2). Never
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
      // v44 / fn-664: three new per-file content axes. All `string|null`
      // with the defensive parse: a non-string folds to `null` so a
      // malformed payload never wedges the fold tx. Validation of
      // worktree_oid / index_oid against GIT_OID_RE shape isn't done here
      // (the producer is the trusted writer); a bad oid round-trips into
      // file_attributions as-is and the task .2 discharge gate will
      // reject the comparison, falling back to timestamp discharge —
      // identical safe-side behavior to today's pre-v44 fold.
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
 * `title` / `state` are nullable because the `jobs` row may not yet exist
 * for an attribution (a Write tool fold ran before SessionStart, possible
 * during a re-fold-from-cursor=0 if event ordering differs from the boot-
 * drain — defensive shape, defaults `state="stopped"` if the join misses).
 */
interface RenderedAttribution {
  session_id: string;
  title: string | null;
  state: string;
  last_touch_at: number;
  op: string;
  source: "tool" | "bash" | "inferred";
}

/**
 * Project the latest `(session_id, file_path)` mutation evidence the
 * persisted event log carries for a given dirty file. Three match modes
 * are layered, all feeding the same `file_attributions` UPSERT in
 * pass 1:
 *
 *   - tool mutations (exact): PostToolUse on `tool_name ∈ {Write, Edit,
 *     MultiEdit, NotebookEdit}` whose `tool_input.file_path` matches the
 *     dirty file's `path` or its `orig_path` (rename case);
 *   - bash mutations (exact): PostToolUse:Bash events whose
 *     `bash_mutation_targets` JSON array contains the dirty file's `path`
 *     or `orig_path` — SQL-side via `json_each WHERE j.value = ?`. Covers
 *     plain modifications by `git-tree-mutate` / `fs-*` deriver kinds
 *     stamping concrete file paths.
 *   - bash mutations (prefix + fnmatch) for `git-rm` / `git-mv` events:
 *     these targets MAY name directories (recursive `git rm -r dir/`) or
 *     globs (`'*.ts'`) — modes SQL can't probe — AND the dirty files
 *     they touch carry `mtime_ms=null` (deleted-tree), so the inferred
 *     pass-2 path is unavailable. We pull candidate rows narrowed by the
 *     partial index on `bash_mutation_kind IN ('git-rm', 'git-mv')` into
 *     JS and run three checks per stored token: exact, directory-prefix
 *     (`file === token || file.startsWith(token + '/')`), and a hand-
 *     rolled fnmatch (`*`→`[^/]*`, `?`→`[^/]`, anchored, no `**`/nested
 *     quantifiers). The `__TREE__` sentinel is excluded explicitly so a
 *     tree-mutate event can't match real files. Cached compiled RegExp.
 *
 * The function returns one row per session, carrying the LATEST `ts` it
 * saw and the source/op identifying that row. The reducer's pass-1 upsert
 * folds these into `file_attributions` using the "newest wins" rule (the
 * UPSERT's WHERE clause gates the UPDATE on `excluded.last_mutation_at >
 * file_attributions.last_mutation_at`).
 *
 * Pure: no liveness probe, no FS read, no wall-clock. Every fact lives
 * in the `events` table so a from-scratch re-fold reproduces the same
 * row set byte-identically.
 */
interface SessionMutation {
  session_id: string;
  last_mutation_at: number;
  last_event_id: number;
  op: string;
  source: "tool" | "bash";
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

  // Tool-mutation scan: PostToolUse rows on the four mutation tool names
  // whose `data.tool_input.file_path` equals one of the candidate paths.
  // `json_extract` walks the stored JSON in place — no full parse from
  // SQL's perspective, and the `tool_name` filter narrows the index-seek
  // before the JSON probe. The reducer's BEGIN IMMEDIATE bounds this scan
  // to the writer lock window — kept narrow by the per-file iteration.
  for (const candidatePath of paths) {
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

  // Bash-mutation scan: PostToolUse:Bash events whose stored
  // `bash_mutation_targets` JSON array contains the candidate path.
  // The partial index `WHERE bash_mutation_kind IS NOT NULL` narrows the
  // scan to the sparse mutation subset before the JSON probe. Use
  // `json_each` to expand the array — SQLite's JSON1 module evaluates
  // this lazily, so a non-matching row exits the join after one probe.
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
      // Bash wins ties via "last write wins on the same ts" — keep
      // deterministic ordering by also breaking ties on event id (a
      // later row in the same ts has a higher id under the events
      // INTEGER PRIMARY KEY AUTOINCREMENT).
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

  // Deletion-attribution scan (git-rm / git-mv): SQL above probes only
  // exact `j.value = ?` matches. `git-rm`/`git-mv` events legitimately
  // store directory tokens (`git rm -r dir/` → `/repo/dir`) and glob
  // tokens (`git rm '*.ts'` → `/repo/*.ts`) that an exact probe will
  // never hit; the dirty files they touch carry `mtime_ms=null` (the
  // file is gone), so the inferred pass-2 path also doesn't fire. Pull
  // candidate rows narrowed by the kind filter into JS and apply
  // exact / directory-prefix / fnmatch via `bashTargetMatches`. The
  // SQL→JS boundary moves here for these kinds only: pure (no FS,
  // no wall-clock), so re-fold determinism holds.
  //
  // The query enumerates every `git-rm` / `git-mv` event once; for each
  // we walk its `bash_mutation_targets` JSON in JS and probe every
  // candidate path. A typical session emits a handful of these per
  // snapshot at most, so the JS-side cost is negligible compared to
  // the SQL-side `json_each` pass.
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
 * sessions whose `cwd` is inside `project_dir`. Used when pass 1 finds NO
 * explicit attributions (tool or bash) for the file — a last-resort honest
 * inference: "some bash invocation in this project's window may have
 * touched this file".
 *
 * The window is `(pre.ts, post.ts]` — `pre` is the PreToolUse:Bash, `post`
 * is the matched PostToolUse:Bash with the same `tool_use_id`. The match
 * uses the `(session_id, tool_use_id)` pair (every Bash invocation gets a
 * fresh `tool_use_id`, schema v17), so concurrent bash invocations don't
 * cross-bracket.
 *
 * `cwd` containment: we accept a session whose `cwd` is either equal to
 * `project_dir` or a subdirectory of it. `project_dir + '/'` prefix-match
 * with a guard against `project_dir` being root (`/`) or having a trailing
 * slash already. This is conservative: a session running in a sub-tree of
 * the worktree's parent (e.g. a monorepo) won't be bracketed against the
 * sub-tree's snapshot — that's the desired "stay honest" failure mode.
 *
 * Returns one entry per session whose bracket enclosed the mtime; if
 * multiple brackets in the same session enclose, we keep the LATEST
 * matching post.ts (the most recent plausible bash window). The pass-2
 * upsert uses `last_mutation_at = file.mtime_ms / 1000` (NOT the
 * bracket's post.ts) — re-fold determinism rides on the frozen-in-payload
 * mtime, not the floating event timestamps.
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
 * loop: the old `findInferredAttributions` ran this `(session_id,
 * tool_use_id)` self-join — a ~2.5s grind over 32k `PreToolUse:Bash` rows — once
 * PER orphan file, so an orphan-heavy `GitSnapshot` took tens of seconds and
 * held the `BEGIN IMMEDIATE` write lock long enough to starve hook INSERTs into
 * dead-letters. Now it runs ONCE per fold, bounded to the dirty mtime span
 * (`post.ts >= minMtimeSec AND pre.ts < maxMtimeSec`): a window outside that
 * span cannot bracket any of this snapshot's files, and dirty files are recently
 * modified, so the bound shrinks the scan to a tiny recent slice.
 *
 * The cwd containment (`post.cwd = projectDir OR post.cwd LIKE projectDir/%`)
 * and the partial-index-served `(session_id, tool_use_id)` join are unchanged
 * from the old per-file query. Pure read of the immutable event log; the exact
 * per-file bracket is applied in {@link inferFromWindows}, so re-fold
 * determinism is byte-identical to the pre-hoist behavior.
 */
/**
 * Lower-bound slack (seconds) on the `pre.ts` range scan in
 * {@link computeRepoBashWindows}. A bracket is a single `(PreToolUse:Bash,
 * PostToolUse:Bash)` pair = ONE bash command, hard-capped by the Bash tool's
 * 600s timeout; the longest window ever observed on the live log is ~240s. So
 * any window straddling a file mtime `M` has `pre.ts >= M - 600`. We use 3600
 * (1h) as a defensive cap — far above the 600s ceiling, robust to clock skew /
 * hook latency / a future timeout bump, yet still bounding the `pre` scan to a
 * tight time range instead of ALL history.
 *
 * Why this matters: `pre.ts < maxMtimeSec` alone is NON-selective (files are
 * usually modified ~now, so it matches the whole log). Without a lower bound
 * the self-join scanned all ~38k PreToolUse:Bash events every fold — index-
 * covering but huge, ballooning to 6-22s under concurrent load and starving
 * hook INSERTs. The lower bound makes it a bounded range scan (measured 20x
 * fewer candidate windows, byte-identical inferred result). Loss-free: it only
 * prunes windows LONGER than the cap, which cannot exist under the tool
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
 * <= post_ts`. Take-latest per session by `last_event_id` — byte-identical to
 * the old per-file query's in-JS aggregation, so re-fold determinism holds.
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
 * deterministic even though the original producer observed mutable
 * filesystem state.
 *
 * Schema-v31 attribution rewrite (fn-633.6): five integrated passes inside
 * the same `BEGIN IMMEDIATE` transaction opened by `applyEvent`:
 *
 *   1. Explicit attribution upsert. For each dirty file, scan the event
 *      log for tool mutations (`Write`/`Edit`/`MultiEdit`/`NotebookEdit`
 *      against the file's `path` or `orig_path`) and bash mutations
 *      (`bash_mutation_targets` array contains the path). Per session,
 *      take the latest event ts and upsert into `file_attributions` with
 *      `source ∈ {'tool', 'bash'}`. Newest-wins per session, deterministic
 *      tie-break on event id.
 *
 *   2. Inferred attribution. For each dirty file with `mtime_ms != null`
 *      AND NO explicit attribution from pass 1, find `(PreToolUse:Bash,
 *      PostToolUse:Bash)` brackets in any session whose cwd is inside
 *      `project_dir` and whose interval contains the file's mtime. Upsert
 *      with `source='inferred'`, `op='inferred'`, `last_mutation_at =
 *      mtime_ms / 1000`. Re-fold deterministic because mtimes are
 *      frozen in the payload.
 *
 *   3. Render `attributions[]` per file. Join `file_attributions` LEFT
 *      JOIN `jobs` under the discharge filter `last_mutation_at >
 *      COALESCE(last_commit_at, 0)`, materialize `{session_id, title,
 *      state, last_touch_at, op, source}` per active attribution into the
 *      `git_status.dirty_files[].attributions[]` JSON.
 *
 *   4. Per-job rollups. For every session referenced by an active
 *      attribution under this project_dir:
 *      - `git_dirty_count` = count of files in this snapshot's dirty set
 *        the session is still on the hook for;
 *      - `git_unattributed_to_live_count` = project-wide count of dirty
 *        files whose attribution set contains no LIVE session (state ∈
 *        {'working', 'stopped'}); legacy "orphan" semantic, drives
 *        readiness predicate 6.5;
 *      - `git_orphan_count` = project-wide count of dirty files with
 *        ZERO active attributions (strict-mystery semantic).
 *      Fan into `epics.jobs[]` + `epics.tasks[].jobs[]` via the existing
 *      `syncIfPlanRef` helper.
 *
 *   5. Symmetric retract (in `retractGitStatus`): on `GitRootDropped`,
 *      DELETE `file_attributions` for `project_dir` and zero
 *      `git_dirty_count` / `git_unattributed_to_live_count` /
 *      `git_orphan_count` on every session that was on-the-hook.
 *
 * Multi-attribution overcount: a file attributed to sessions A and B
 * counts toward BOTH A's and B's `git_dirty_count`. That's intentional —
 * co-authorship is the honest semantic. Aggregate consumers (board.ts)
 * must NOT sum these as if they were disjoint.
 *
 * The from-scratch re-fold sees every historical `GitSnapshot` event in
 * order and re-derives the same counts byte-identically; every fact lives
 * in the persisted event log (the frozen-in-payload mtimes preserve
 * inferred-attribution determinism). The `INSERT OR IGNORE`-then-`UPDATE`
 * pattern for the per-job rollup is intentional: a snapshot referencing
 * a job whose `SessionStart` hasn't folded yet leaves the row absent and
 * the UPDATE matches zero rows. The next snapshot after SessionStart
 * lands the counts.
 */
/**
 * Threshold above which a GitSnapshot fold emits a per-pass `[gitfold-breakdown]`
 * line. Set high enough that normal folds stay silent — we only care about the
 * multi-second outliers that hold the write lock and starve hook INSERTs.
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

  // Per-pass timing — emitted (below) ONLY when the whole fold is slow, so a
  // [fold-slow] GitSnapshot line is always accompanied by a breakdown that
  // localizes the cost to a specific pass. Timing is never persisted, so it
  // has no bearing on re-fold determinism.
  const _gfT0 = performance.now();

  // PASS 1 — Explicit attribution upsert. For each dirty file, scan the
  // event log for tool/bash mutations whose payload references the file
  // path (or its rename's orig_path). Per session, take the LATEST
  // matching event (newest-wins via the UPSERT's WHERE clause).
  //
  // v44 / fn-664: the per-file `worktree_oid` is added to the INSERT
  // VALUES so a brand-new row carries it from the start; the existing
  // UPDATE WHERE remains gated on "newer mutation wins" (no
  // discharge-behavior change). For pre-existing rows whose mutation
  // didn't advance, a follow-up `refreshWorktreeOidStmt` UPDATE stamps
  // the latest snapshot's `worktree_oid` onto every attribution row for
  // this `file_path` — the oid is a PER-FILE fact (the file's worktree
  // bytes are what they are, regardless of who attributes to it), so
  // every row for the same `(project_dir, file_path)` must hold the
  // SAME oid in this snapshot. The split keeps the existing newer-wins
  // semantics for the mutation columns byte-identical while making the
  // worktree_oid the freshest-per-snapshot value the discharge gate
  // (in `foldCommit`) reads.
  //
  // v45 / fn-664.2: `worktree_mode` rides alongside `worktree_oid` on
  // the same INSERT VALUES and refresh UPDATE — the mode is also a
  // per-file snapshot fact, so the same "every row converges on the
  // freshest snapshot value" invariant holds. The discharge gate pairs
  // the mode against the commit's `committed_mode` so a chmod-only
  // dirty file does not wrongly discharge.
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
  // v44 / fn-664 + v45 / fn-664.2: stamp the latest snapshot's
  // `worktree_oid` AND `worktree_mode` onto every file_attributions row
  // for this file. Runs AFTER the upsert so a brand-new row (just
  // INSERTed) and a stale row (UPDATE WHERE was false) both converge
  // on the snapshot's freshest content axes. Both columns written in
  // ONE statement so a transient mid-statement crash can't leave the
  // pair desynced.
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
  // attribution from any session (and a non-null mtime) get bracketed
  // against PreToolUse/PostToolUse Bash intervals. The matching
  // session(s) get an `inferred`-source upsert with `last_mutation_at =
  // file.mtime_ms / 1000`. The mtime is frozen in the payload, so re-fold
  // deterministic.
  //
  // The skip guard probes for an explicit (`tool`/`bash`) row that is
  // still ACTIVE under the discharge rule (`last_mutation_at >
  // COALESCE(last_commit_at, 0)`) — NOT merely the presence of any
  // explicit row. A file whose every explicit attribution has been
  // discharged by a commit, then re-dirtied by a bash step (formatter,
  // codegen) that left no `Write`/`Edit` and no recognized
  // `bash_mutation`, has zero active explicit attributions — so inference
  // MUST run, or the file falls to `<orphan>` even though a bracketing
  // Bash window in the producing session is available. Probing the table
  // (just written in pass 1) rather than an in-memory "any explicit ever"
  // set is what makes the discharge interaction correct; it stays a pure
  // function of the event log within this `BEGIN IMMEDIATE`.
  const activeExplicitStmt = db.prepare(
    `SELECT 1 FROM file_attributions
      WHERE project_dir = ?
        AND file_path = ?
        AND source IN ('tool', 'bash')
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
        // v44 / fn-664 + v45 / fn-664.2: same UPSERT shape as pass 1 —
        // `worktree_oid` AND `worktree_mode` are per-file snapshot facts;
        // they ride on the INSERT VALUES of a brand-new inferred row, and
        // the post-loop refresh UPDATE keeps every existing row aligned
        // to the freshest snapshot pair.
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

  // PASS 3 — Render per-file `attributions[]`. Join `file_attributions`
  // against `jobs` (LEFT JOIN — a missing jobs row reads defaults), apply
  // the discharge filter, and embed the materialized view inside each
  // dirty file's `attributions[]`. The WHERE clause `last_mutation_at >
  // COALESCE(last_commit_at, 0)` is THE discharge rule: a session that
  // has committed past its last mutation drops out of the file's
  // attribution list.
  //
  // Sorted ASC on `(session_id)` — total-order tiebreaker is non-
  // negotiable for byte-identical re-fold. Without the deterministic
  // sort, two re-folds could produce different JSON orderings under
  // the same input.
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
      // Default `state="stopped"` matches the schema default + the zero
      // -event projection (jobs row absent ↔ session never observed).
      state: r.state ?? "stopped",
      last_touch_at: r.last_touch_at,
      op: r.op,
      source:
        r.source === "tool" || r.source === "bash" || r.source === "inferred"
          ? r.source
          : "inferred",
    }));
    renderedFiles.push({ ...file, attributions });
    fileToAttributions.set(file.path, attributions);
  }

  const _gfT3 = performance.now();

  // PASS 4 — Per-job rollups.
  //
  // (a) `git_orphan_count`: project-wide count of dirty files with ZERO
  //     active attributions — the strict-mystery semantic.
  // (b) `git_unattributed_to_live_count`: project-wide count of dirty
  //     files whose attribution set contains NO live session
  //     (state ∈ {'working', 'stopped'}). The legacy v28 "orphan" name
  //     under the new vocabulary; drives readiness predicate 6.5.
  // (c) `git_dirty_count`: per-session count of files in the current
  //     snapshot the session is on the hook for (active attribution,
  //     undischarged).
  //
  // The two project-wide counts are broadcast onto every enumerated
  // session — every session with at least one active attribution under
  // this project_dir. The per-session count is, well, per-session.
  let orphanCount = 0;
  let unattributedToLiveCount = 0;
  const sessionsWithAttribution = new Set<string>();
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
      sessionsWithAttribution.add(a.session_id);
      sessionDirtyCount.set(
        a.session_id,
        (sessionDirtyCount.get(a.session_id) ?? 0) + 1,
      );
      if (LIVE_STATES.has(a.state)) hasLive = true;
    }
    if (!hasLive) unattributedToLiveCount++;
  }

  // Also enumerate every session that has any active attribution for
  // this project — even if NONE of its attributed files are in the
  // current snapshot's dirty_files set. (A file that was attributed in
  // an earlier snapshot but discharged in the current commit set would
  // not appear in `dirty_files` — but if undischarged, the session's
  // count should still reflect the project-wide rollup.) In practice
  // the previous `attributions[]` build only considered current
  // dirty_files, so we need a separate enumeration. This walks every
  // active row under `project_dir` and includes its session in the
  // fan-out set; the per-session `git_dirty_count` already counted only
  // current dirty files (sessionDirtyCount entries default to 0 for
  // sessions present here but absent from sessionDirtyCount — they're
  // attributed to this project but to no file in the current snapshot).
  const allActiveSessions = db
    .prepare(
      `SELECT DISTINCT session_id
         FROM file_attributions
        WHERE project_dir = ?
          AND last_mutation_at > COALESCE(last_commit_at, 0)`,
    )
    .all(projectDir) as Array<{ session_id: string }>;
  for (const row of allActiveSessions) {
    sessionsWithAttribution.add(row.session_id);
  }

  // Enumerate every session that previously had a count stamped for
  // this project, even if it has no active attribution now. Their
  // counts must zero out symmetrically — otherwise a session that
  // committed all its files would keep a stale git_dirty_count.
  // The canonical pre-write enumeration: the persisted `git_status.jobs`
  // JSON from the prior snapshot (the projection's own canonical
  // attribution). A first-ever snapshot reads `[]`; thereafter every
  // prior fan-out session shows up here.
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
      // malformed prior JSON folds to empty set; safe-fold per "never
      // throw" invariant.
    }
  }
  // Union of "sessions with at least one active attribution" and
  // "sessions that had a count stamped in the prior snapshot" — every
  // session in either set needs a fan-out write.
  const sessionsToFanOut = new Set<string>();
  for (const s of sessionsWithAttribution) sessionsToFanOut.add(s);
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
  // Deterministic iteration order — Set iteration in V8/JSC is
  // insertion-order, but we sort explicitly to keep re-fold byte-
  // identical irrespective of insertion-order vagaries across
  // different drains.
  const sortedSessions = Array.from(sessionsToFanOut).sort();
  // Build the canonical attribution JSON for the post-PASS-5
  // git_status.jobs slot. Format mirrors the legacy v28 shape
  // `{job_id, dirty: <count>}` so a downstream retract walks the
  // same structure (retractGitStatus reads `job_id` only).
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
    // Re-fan into embedded jobs[] — `syncIfPlanRef` reads back the
    // post-write row + routes via `plan_ref`. A session whose UPDATE
    // matched zero rows (no SessionStart yet) returns null from the
    // SELECT and the helper exits without a write.
    syncIfPlanRef(db, sessionId, eventId, eventTs);
    // fn-656.1: persist ONLY currently-dirty sessions into
    // git_status.jobs. The UPDATE + syncIfPlanRef above STILL fire for
    // every session in sortedSessions (including ones that just
    // transitioned to dirty == 0 via priorSessions), so a session
    // leaving the dirty set gets its clearing UPDATE + embedded epic
    // jobs[] clear exactly once — on the transition snapshot — and
    // then drops from the persisted JSON. Without this guard the set
    // ratchets: every session that has ever been dirty is re-persisted
    // forever (it becomes the next snapshot's priorSessions and re-
    // enters sortedSessions). Steady-state fan-out collapses to the
    // currently-dirty set; the pure dependency on sessionDirtyCount
    // keeps the decision a fold-deterministic function of the event.
    if (dirtyForSession > 0) {
      projectionJobs.push({ job_id: sessionId, dirty: dirtyForSession });
    }
  }

  const _gfT5 = performance.now();

  // git_status write — after pass 1-4 have populated file_attributions
  // and per-job rollups. The rendered `dirty_files[].attributions[]`
  // JSON is the materialized view the client reads. `orphaned_files` /
  // `jobs` carry the project-broadcast counts in the same on-disk shape
  // the legacy v28 producer used (`orphaned_files.length` == orphan
  // count for backward-compatible reads); the new strict-mystery
  // semantic flows through the dedicated `dirty_count` /
  // `orphaned_count` columns. The `jobs` JSON enumerates the
  // canonical attribution set the retract walks — same shape the v28
  // producer wrote.
  //
  // `orphaned_files` shape: we don't ship a per-file orphan list (the
  // new strict-mystery semantic is "files with no attribution at all",
  // which IS just `dirty_files where attributions.length == 0`).
  // Storing the per-file list would duplicate that. Instead we store
  // an empty array and let the `orphaned_count` column carry the
  // scalar — the same approach the producer took post-fn-633.5.
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
 * Fold one synthetic `GitRootDropped` tombstone. The git-worker posts this
 * from `unsubscribeRoot()` when a watched worktree stops being planctl-backed
 * (its `.planctl/` directory was removed); without it, `projectGitStatus`'s
 * UPSERT-only path would leak the final pre-drop snapshot row forever.
 *
 * The primary key (`project_dir`) rides in `event.session_id`. An empty /
 * missing pk is a safe no-op — the invariant says fold must never throw
 * inside the cursor-advance transaction. DELETE is idempotent: re-folding
 * over a row that's already gone matches zero rows, not an error.
 *
 * Schema-v28 symmetric clear (widened in v31): before the DELETE, read the
 * soon-to-be-dropped row's persisted `git_status.jobs` JSON to enumerate the
 * job_ids the last fan-out stamped, then zero each one's `git_dirty_count`
 * / `git_unattributed_to_live_count` / `git_orphan_count` and re-emit the
 * `syncJobIntoEpic` fan-out so the embedded arrays clear in lockstep.
 * Canonical attribution: the SAME `jobs[]` enumeration that the write side
 * fanned over is the enumeration the clear walks — symmetric write/clear
 * keeps an unrelated project's jobs (running in another worktree)
 * untouched. All inside the open transaction.
 *
 * Schema-v31 widening (fn-633.6): the retract also DELETEs every
 * `file_attributions` row for this `project_dir`. The attribution table is
 * a pure projection of the event log under the new attribution rewrite, so
 * dropping the worktree drops the per-(session, file) rows it owned. A
 * re-fold over the persisted events re-creates the same rows — and the
 * subsequent retract (re-folded too) re-deletes them — preserving the
 * "byte-identical re-fold" invariant across the snapshot + retract pair.
 */
function retractGitStatus(db: Database, event: Event): void {
  const projectDir = event.session_id;
  if (projectDir == null || projectDir.length === 0) {
    return;
  }
  // Pre-DELETE: read the row's stored `jobs` JSON to enumerate the job_ids
  // the last fan-out stamped (canonical attribution). A missing row / empty
  // / malformed JSON folds to `[]` — no-op, matches the "fold must never
  // throw" invariant.
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
  // Schema-v31: also drop every file_attributions row for this project_dir
  // — symmetric with the projectGitStatus pass-1/2 upserts. The
  // attribution table is a pure projection of the event log, so a retract
  // walks it the same way.
  db.run("DELETE FROM file_attributions WHERE project_dir = ?", [projectDir]);
  db.run("DELETE FROM git_status WHERE project_dir = ?", [projectDir]);
}

/**
 * Fold one synthetic `Commit` event. The git-worker emits one of these per
 * commit in a HEAD-oid delta (see {@link
 * import("./git-worker").enumerateCommitsInDelta}); main lifts the message
 * into the synthetic event row this arm reads.
 *
 * Discharge semantic (schema v45 / fn-664.2 — content-aware):
 *   - `committer_session_id` non-null → UPDATE the matching
 *     `file_attributions` row for `(project_dir, committer_session_id,
 *     file_path)`, setting `last_commit_at = committed_at_ms / 1000`. Per
 *     -session discharge: only the committing session clears its claim.
 *   - `committer_session_id` null → UPDATE every `file_attributions` row
 *     for `(project_dir, file_path)` regardless of session — a human / CI
 *     commit (no `Session-Id:` trailer, or malformed value) globally
 *     discharges every session's attribution claim for the named files.
 *
 * Content-aware gate (the fn-664.2 fix): for each file the commit would
 * discharge, compare the commit's payload `blob_oid` + `committed_mode`
 * against the file's CURRENT `worktree_oid` + `worktree_mode` stored on
 * the `file_attributions` row (written by the latest GitSnapshot fold —
 * see `projectGitStatus`).
 *
 *   - All four axes non-null AND the (oid, mode) pairs match → STAMP
 *     `last_commit_at` (the legacy discharge path — the commit truly
 *     captured the worktree, so the session is off-the-hook).
 *   - All four axes non-null AND either pair MISMATCHES → DO NOTHING
 *     (the worktree diverged from the committed bytes/mode; the session
 *     is still on-the-hook for the still-dirty file, and a re-edit is
 *     ALREADY accounted for via `last_mutation_at`). This is the
 *     stage→re-edit→commit case the epic exists to fix; without this
 *     branch the file falls to `<orphan>` even though the editing session
 *     should retain attribution.
 *   - ANY of the four axes IS NULL → fall back to today's UNCONDITIONAL
 *     timestamp discharge (the SAME code path pre-v45 events traversed,
 *     so a cursor=0 re-fold over NULL-oid / NULL-mode history reproduces
 *     byte-identical projections). The null sources: pre-v44 producer
 *     events (`worktree_oid` / `committed_*` absent), pre-v45 producer
 *     events (`committed_mode` / `worktree_mode` absent), the producer's
 *     per-file `hash-object` / `diff-tree` parse miss, racy-clean rows
 *     (the GitSnapshot fold ran without observing this file), inferred /
 *     untracked entries that never carried a meaningful committed
 *     baseline. The fall-back is the safer side per the epic's "Best
 *     practices": "Treat NULL worktree_oid (racy-clean / lstat miss /
 *     inferred / untracked) as 'cannot confirm → keep attribution
 *     active'" was the intent — but for re-fold determinism against
 *     historical events we MUST converge on the EXISTING semantic, which
 *     was unconditional discharge. The pre-existing semantics
 *     unconditionally discharge; the new gate only KICKS IN when both
 *     sides have non-null evidence, so historical re-folds are
 *     untouched.
 *
 * The UPDATE matches zero rows when no session has yet recorded a mutation
 * on the file (file_attributions rows are created by the mutation-event
 * fold, not here). That's intentional — a discharge can't resurrect a
 * non-existent attribution. The cursor still advances per the fold-tx
 * invariant.
 *
 * Producer-only liveness: this arm reads ONLY the payload fields and the
 * already-folded `file_attributions` row (event-derived). No `git log`
 * re-shell, no FS probe, no env read — every fact it touches lives in
 * the event log, so a from-scratch re-fold reproduces the same
 * `file_attributions.last_commit_at` byte-deterministically. The
 * worktree_oid / worktree_mode read-back is on the IN-TX projection
 * (post-pass-1 of any prior GitSnapshot fold), so re-fold determinism
 * holds.
 *
 * Runs inside the same `BEGIN IMMEDIATE` transaction as the cursor
 * advance (via {@link applyEvent}); a throw anywhere here rolls back
 * both writes. The defensive {@link import("./derivers").extractCommit}
 * parser returns `null` on every shape-mismatch path so a malformed
 * payload folds to a safe no-op; the cursor still advances. The
 * four discharge READ predicates downstream (`projectGitStatus`
 * passes 2/3/4) are byte-identical — only the WRITE site here changes.
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

  // Helper: decide whether the content-aware gate should suppress
  // discharge for this `(project_dir, file_path)` against the commit's
  // payload entry. Returns `true` if the commit's `(blob_oid,
  // committed_mode)` pair both DIFFER from the file's current
  // `(worktree_oid, worktree_mode)` stored on `file_attributions` — i.e.
  // the worktree diverged from the committed bytes/mode, so the session
  // stays on-the-hook. Returns `false` (DISCHARGE) when (a) any of the
  // four axes is NULL (legacy timestamp fall-back — same path historical
  // events take, re-fold determinism), or (b) all four are non-null AND
  // the (oid, mode) pairs MATCH (the commit captured the worktree).
  //
  // The read targets the post-pass-1 `file_attributions` projection —
  // pure event-derived, in-tx with this fold. Re-fold determinism
  // preserved.
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
      // Pre-v44/v45 event, producer parse miss, or deletion — fall back
      // to today's unconditional timestamp discharge. Identical to
      // pre-fn-664.2 behavior.
      return false;
    }
    // The worktree_oid / worktree_mode is a per-file fact — any
    // attribution row for `(project_dir, file_path)` carries the SAME
    // pair (the GitSnapshot refresh UPDATE writes both columns onto
    // every row for the file). LIMIT 1 is safe.
    const row = worktreeProbeStmt.get(projectDir, filePath) as
      | { worktree_oid: string | null; worktree_mode: string | null }
      | null
      | undefined;
    if (row == null) {
      // No attribution row exists yet — nothing to gate; the
      // discharging UPDATE will match zero rows below either way. Fall
      // through to the legacy path (zero-row UPDATE is a safe no-op).
      return false;
    }
    if (row.worktree_oid === null || row.worktree_mode === null) {
      // No GitSnapshot has yet folded a content-aware payload for this
      // file (pre-v44/v45 events, or never observed dirty). Fall back to
      // today's unconditional timestamp discharge — re-fold determinism
      // over historical events.
      return false;
    }
    // All four axes non-null: gate on EQUALITY. Suppress discharge only
    // when EITHER pair MISMATCHES (the worktree diverged from the
    // committed bytes/mode — the session stays on-the-hook). When BOTH
    // pairs MATCH, fall through to discharge (the commit truly captured
    // the worktree).
    return (
      row.worktree_oid !== committedOid || row.worktree_mode !== committedMode
    );
  }

  if (commit.committer_session_id !== null) {
    // Per-session discharge: only the committing session clears its claim
    // on each named file. Other sessions that also touched these files
    // (multi-attribution) stay on-the-hook until they commit too.
    const stmt = db.prepare(
      `UPDATE file_attributions
          SET last_commit_at = ?, last_event_id = ?, updated_at = ?
        WHERE project_dir = ?
          AND session_id = ?
          AND file_path = ?`,
    );
    // v45 / fn-664.2: content-aware gate. The extractCommit defensive
    // parser already guarded the entry shape; we re-check `path` here
    // for safety inside the fold tx (mirrors the prior per-string
    // defensive check). When the gate suppresses, we skip the UPDATE
    // entirely — `last_mutation_at` is unchanged, the row stays in
    // the dirty/attributed bucket via the (mutation > commit)
    // inequality the four discharge read predicates use.
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
    return;
  }
  // Global discharge: no trailer or malformed trailer → no honest way to
  // pin the discharge to a specific session, so we clear EVERY session's
  // attribution row for the named files. Matches the spec's "global
  // discharge (null committer_session_id) updates every session's
  // attribution row for the named files" rule.
  const globalStmt = db.prepare(
    `UPDATE file_attributions
        SET last_commit_at = ?, last_event_id = ?, updated_at = ?
      WHERE project_dir = ?
        AND file_path = ?`,
  );
  // v45 / fn-664.2: same content-aware gate as the per-session arm
  // above. The oid/mode read is per-file (a property of the worktree,
  // not the session), so the same `shouldSkipDischarge` probe gates
  // both the per-session and global discharge paths symmetrically — a
  // chmod-only dirty file under a human/CI commit is NOT discharged
  // either, for the same reason a session-commit doesn't discharge it.
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
 * Pre-flattened agentuse usage snapshot. The usage-worker carries every
 * projection-meaningful field in the synthetic `UsageSnapshot` event's
 * `data` blob; the reducer never re-reads the on-disk file. **Freshness
 * fields are explicitly absent** — `fetched_at` / `next_fetch_at` /
 * `last_successful_fetch_at` / `last_skipped_fetch_at` are filtered at the
 * producer (see `src/usage-worker.ts` `buildUsageMessage`); including any
 * here would force a synthetic event on every ~90s fetch cycle.
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
  // fn-645: envelope freshness / plan / stale-error axes.
  status: string | null;
  /**
   * Coerced from the producer's bool|null to 1/0/null at extract time so the
   * UPSERT binding matches the SQLite column type (INTEGER, nullable). The
   * producer's wire shape stays boolean (see `UsageSnapshotMessage`).
   */
  subscription_active: 1 | 0 | null;
  error_type: string | null;
  error_message: string | null;
  error_at: string | null;
  /**
   * fn-651: rate-limit lift instant — ISO-8601 string carrying the soonest
   * `resets_at` among windows at >=100% used (agentuse computes it). Null
   * when the profile is not over any limit. Mirrors `session_resets_at` —
   * stored opaque as TEXT; the renderer parses it. Folds into
   * `usage.rate_limit_lifts_at` on the percentage path; the rate-limit
   * fan-out's UPDATE carves it out so a RateLimited fold cannot clobber a
   * lift time.
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
    // fn-645: bool|null → 1/0/null. Non-booleans (including missing) fold to
    // null per the "safe value" invariant.
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
      // fn-651: rate-limit lift instant — null-safe string parse mirroring
      // `session_resets_at`. Pre-v41 events on disk that predate `lift_at`
      // fold to null safely.
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
 * Bumps `last_event_id` + `updated_at` on every write so the descriptor's
 * diff-tick fires patches. Re-fold determinism: the reducer NEVER re-reads
 * the on-disk file — the persisted event log is the sole source of truth.
 *
 * **Schema v35 (fn-642): reverse fan-out (UsageSnapshot ← profiles).** The
 * colocated `last_rate_limit_at` + `last_rate_limit_session_id` columns are
 * carved OUT of the `ON CONFLICT(id) DO UPDATE SET` clause (mirroring the
 * `EpicSnapshot` carve-out for `tasks` / `jobs` / `job_links` / etc.) — a
 * `UsageSnapshot` re-fold must NOT clobber the rate-limit annotation a
 * prior `RateLimited` fan-out wrote. After the UPSERT, a SELECT against
 * the matching `profiles` row (joined on `profile_name = usage.id`) pulls
 * the current rate-limit state and stamps it onto the row. NULL-safe: if
 * no matching `profiles` row exists (e.g. a usage id with no SessionStart-
 * seeded profile yet), the columns stay NULL — a later `RateLimited` will
 * fan them in via the forward path. The `profile_name != ''` guard keeps
 * the `''` sentinel (default `~/.claude`) out of the join.
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
  // fn-651: freshness stamp gate. `last_usage_fold_at` is the event `ts`
  // ONLY on a SUCCESSFUL usage fold (status `"active"` or any per-window
  // usage present) — NOT on idle/stale snapshots, NEVER on the rate-limit
  // fan-out (which carves both new columns out of its UPDATE). The
  // renderer compares this against the wall clock to warn when ingestion
  // has wedged; an idle/stale fold must NOT bump it or the warning loses
  // its meaning. Determinism boundary: the value is the event ts, never
  // `Date.now()` — a fold-time wall-clock read would break re-fold
  // determinism (CLAUDE.md "byte-identical re-fold").
  //
  // "Successful usage" is defined as: status === "active" OR any of the
  // three per-window percents is non-null (a row carrying real quota
  // numbers from a recent scrape). Idle / stale snapshots typically carry
  // status === "idle" / "stale" with NULL percents — these preserve the
  // prior `last_usage_fold_at` via the carve-out spread in the UPSERT
  // clause below, so a wedged ingestion path's last-good stamp does not
  // get overwritten by a later idle/stale envelope that DID make it
  // through.
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
  // Schema v35 (fn-642), corrected at v42 (fn-662): reverse fan-out. Pull
  // the current rate-limit annotation from the matching `profiles` row and
  // stamp it onto the just-UPSERTed usage row. The join key is
  // `profiles.profile_name = profileNameForUsageId(usage.id)` — v42's
  // shared directional mapping translates agentuse's `"default"` usage id
  // to keeper's `''` default-profile sentinel at the join boundary, so a
  // `default` UsageSnapshot reads the `''` profile row's annotation. Every
  // other usage id passes through unchanged. NULL-safe: a missing/quiet
  // profile row leaves the columns NULL (`SELECT ... LIMIT 1` returns null
  // → both bindings are NULL → the UPDATE writes NULLs, which is the
  // correct zero-event shape). A later `RateLimited` will populate them
  // via the forward fan-out.
  //
  // The pre-v42 `WHERE profile_name != ''` guard is gone: the reverse
  // direction is one-way (`'default'` → `''`, never `''` → `''`), so a
  // pathological literal `usage.id=''` would resolve to
  // `profile_name=''` ONLY if the helper mapped it that way — it does
  // not. And `projectUsageRow` rejects an empty `event.session_id` at
  // the early guard above, so the SELECT can never see `id===''` in
  // steady state. The cross-contamination the original guard prevented
  // is now structurally impossible by the mapping direction.
  //
  // Pure function of the fold inputs + the in-transaction `profiles` row —
  // no `Date.now`/env/OS reads. Re-fold determinism: events fold in id
  // order, so a re-fold sees the same `profiles` state at the same point in
  // the stream and stamps the same values. The `last_event_id` bump is
  // already covered by the UPSERT above; the reverse fan-out's UPDATE does
  // not need to re-bump because the row's `last_event_id` already advanced
  // for this same event.
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
 * Fold one synthetic `UsageDeleted` tombstone. The usage-worker posts this
 * when an `<id>.json` file disappears (or the boot-reconciliation sweep
 * retracts a projection ghost); without it, {@link projectUsageRow}'s
 * UPSERT-only path would leak the final pre-delete snapshot row forever.
 *
 * The primary key (`id`) rides in `event.session_id`. An empty / missing pk
 * is a safe no-op — the invariant says fold must never throw inside the
 * cursor-advance transaction. DELETE is idempotent: re-folding over a row
 * that's already gone matches zero rows, not an error.
 */
function retractUsageRow(db: Database, event: Event): void {
  const id = event.session_id;
  if (id == null || id.length === 0) {
    return;
  }
  db.run("DELETE FROM usage WHERE id = ?", [id]);
}

/**
 * Pre-flattened `DispatchFailed` synthetic event payload (fn-661). The
 * server-side autopilot reconciler mints this event when a dispatch attempt
 * for the `(verb, id)` pair fails (today: a confirm-poll timeout, but the
 * `reason` field is free-form so future failure shapes ride the same arm
 * without a schema change).
 *
 * The reconciler stamps `ts` at reconcile time — NOT the same as the
 * synthetic event's `event.ts` (which is the producer-side mint clock).
 * Carrying it in the payload is what keeps the fold pure: a re-fold of the
 * stored event reproduces the same `dispatch_failures.ts` column value
 * regardless of when the re-fold happens. The reducer NEVER reads
 * `Date.now()` and NEVER re-probes liveness here — both would break re-fold
 * determinism (see the `Killed` arm and CLAUDE.md "byte-identical re-fold").
 */
interface DispatchFailedPayload {
  verb: string;
  id: string;
  reason: string;
  dir: string | null;
  ts: number;
}

/**
 * Pre-flattened `DispatchCleared` synthetic event payload (fn-661). The
 * reconciler mints this event when a human `retry_dispatch` RPC fires
 * against the `(verb, id)` pair — the only legal way for a sticky failure
 * row to leave `dispatch_failures` (no direct DELETE: every clear must
 * round-trip through the event log so a from-scratch re-fold reproduces
 * the post-clear empty-table state).
 */
interface DispatchClearedPayload {
  verb: string;
  id: string;
}

/**
 * Parse a `DispatchFailed` event payload. Returns null on any structural
 * miss — the surrounding {@link foldDispatchFailed} folds null to a safe
 * no-op (cursor still advances). NEVER throws: per CLAUDE.md "a malformed
 * `data` blob skips/folds to a safe value", a throw inside the fold rolls
 * back the cursor and wedges the reducer.
 *
 * Strict typing: `verb` / `id` / `reason` MUST be non-empty strings;
 * `dir` is nullable (null on payloads that omit it, accepts a string
 * otherwise); `ts` MUST be a finite number (the reconciler's reconcile-
 * time stamp). Any miss → null → safe no-op.
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
 * Fold one synthetic `DispatchFailed` event (fn-661). UPSERT on
 * `(verb, id)` — the first failure for the pair INSERTs a new row stamped
 * `created_at = payload.ts`; subsequent failures (a reconciler that retries
 * itself without a human clear in between would be a bug, but a stale
 * re-fire IS possible across keeperd restarts) UPDATE the row's mutable
 * fields and PRESERVE `created_at` so the viewer's "sticky since" view
 * stays honest.
 *
 * The fold is a pure function of the event payload + the persisted row:
 * - `verb` / `id` / `reason` / `dir` / `ts` / `created_at` come from the
 *   immutable event payload (`ts` is the reconciler's reconcile-time
 *   stamp, frozen in by the producer — see {@link DispatchFailedPayload}).
 * - `last_event_id` is `event.id`.
 * - `updated_at` is `event.ts` (the synthetic event's own mint clock — the
 *   table's last-touched discipline mirrors every other projection).
 *
 * No `Date.now()`, no liveness re-probe, no `jobs` SELECT inside the fold
 * — all three would break re-fold determinism. Runs INSIDE the open
 * `BEGIN IMMEDIATE` transaction opened by {@link applyEvent}; performs
 * zero cursor work (the surrounding `applyEvent` advances the cursor).
 *
 * Malformed/missing payload → safe no-op; the cursor still advances.
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
}

/**
 * Fold one synthetic `DispatchCleared` event (fn-661). DELETE on
 * `(verb, id)` — idempotent (re-folding over a `(verb, id)` that's already
 * gone matches zero rows, not an error). This is the ONLY legal clear
 * path: any direct DELETE against `dispatch_failures` outside the fold
 * arm would break the from-scratch re-fold determinism invariant (the
 * event log is the sole source of truth).
 *
 * Runs INSIDE the open `BEGIN IMMEDIATE` transaction opened by
 * {@link applyEvent}; performs zero cursor work.
 *
 * Malformed/missing payload → safe no-op; the cursor still advances.
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
 * Sweep open `status='running'` subagent_invocations rows for a job to
 * `status='unknown'` in a single bulk UPDATE. Called from the SessionEnd and
 * Killed arms of {@link projectJobsRow} on the proven write path (after the
 * jobs UPDATE landed), inside the same `BEGIN IMMEDIATE` transaction as the
 * lifecycle write + cursor advance — exactly-once-per-event holds across both
 * projections.
 *
 * Closes the lifecycle gap for orphaned subagents whose parent session died
 * before the matching SubagentStop landed: a `running` row whose job is now
 * `'ended'` or `'killed'` will never close on its own, so we flip its status
 * to the indeterminate-outcome sentinel `'unknown'`. `duration_ms` stays
 * NULL — the row truly has no known close time. The terminal-status guard in
 * {@link projectSubagentInvocationsRow}'s SubagentStop / PostToolUse arms
 * carves out `'unknown'`, so a late close after the sweep cannot revive the
 * row to `'ok'`.
 *
 * Bulk UPDATE (not a per-row loop) so the sweep is a single SQL statement and
 * never throws inside the open transaction (CLAUDE.md fold invariant — a
 * throw rolls back the cursor and wedges the reducer). Matches zero rows in
 * the common case where every subagent already closed cleanly.
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
 * Apply the `subagent_invocations` projection for one event. Runs INSIDE the
 * open transaction opened by {@link applyEvent}; performs zero cursor work.
 *
 * Wires the parser-port from `src/subagent-invocations.ts` into the per-event
 * reducer. Four event shapes feed this projection:
 *
 * - `SubagentStart` opens a new turn-N row for the `(job_id, agent_id)` pair
 *   with `status='running'`, `duration_ms=NULL`, `subagent_type` seeded from
 *   `event.agent_type` (NULL when absent — PreToolUse-wins precedence applies
 *   later on the PostToolUse:Agent fold).
 * - `SubagentStop` closes the latest open turn for the pair — UPDATE sets
 *   `duration_ms = round((event.ts - row.ts) * 1000)` (events.ts is REAL
 *   seconds, duration_ms is integer ms — matches Python's `int(float(ts_raw)
 *   * 1000)` convention). Sets `status='ok'` unless already terminal
 *   (`failed` / `unknown` / `superseded`). Gates on `duration_ms IS NULL`
 *   ALONE — never also on `status='running'`; PostToolUse:Agent legitimately
 *   flips status to `'ok'` BEFORE SubagentStop lands for Task calls
 *   (Anthropic-confirmed; fn-480).
 * - `PostToolUse` with `tool_name='Agent'` resolves the `(session_id,
 *   tool_use_id)` bridge to an `agent_id` via {@link resolveBridgeAgentId},
 *   then folds PreToolUse metadata (description, prompt_chars, subagent_type)
 *   onto the turn-0 row via the PreToolUse-wins precedence rule (a non-empty
 *   PreToolUse `subagent_type` overwrites the SubagentStart seed; an empty
 *   value leaves the seed in place). Once `subagent_type` is authoritative,
 *   scans for OTHER same-`(job_id, subagent_type)` rows still `status='running'`
 *   with a strictly earlier spawn ts and marks them `status='superseded'`
 *   in the same transaction (the v1 supersession rule — narrow gate on
 *   `row.ts < currentRow.ts` keeps the known-limitation false-positive of
 *   genuine parallel same-type spawns documented but quarantined).
 * - `PostToolUseFailure` with `tool_name='Agent'` resolves the bridge
 *   `agent_id` from the indexed `subagent_agent_id` column (the failure
 *   path carries no `tool_response.agentId`, so the column is the only
 *   reliable signal). When a matching turn-0 row exists, UPDATEs its
 *   status to `'failed'`. No terminal-status guard — the failure signal is
 *   the most authoritative lifecycle outcome we can observe and always
 *   wins. Orphan failures (no matching row) are a safe no-op.
 *
 * Outside this function: SessionEnd and Killed lifecycle events sweep open
 * `status='running'` rows for the job to `status='unknown'` via
 * {@link sweepRunningSubagentsToUnknown}, fired from {@link projectJobsRow}
 * on the proven write path inside the same `BEGIN IMMEDIATE` transaction.
 *
 * **Never throws inside the transaction** — a throw rolls back the cursor
 * and wedges the reducer. Every arm guards lookups and returns silently on
 * the safe-default branch (orphan stops, malformed data, missing bridge, no
 * turn-0 row, etc.). The cursor still advances upstream.
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
 * field-for-field — the wire boundary decodes the JSON-TEXT column into a
 * real array via the same field order so this serializes byte-identically.
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
  // Schema v28: per-job dirty-file count. INTEGER NOT NULL DEFAULT 0 on the
  // underlying `jobs` row, so the read-side mirror is plain `number` (never
  // null). Drives the readiness pipeline's `git-uncommitted` predicate via
  // the embedded array on the parent task / epic element.
  git_dirty_count: number;
  // Schema v31: renamed from the legacy v28 `git_orphan_count`. Same
  // numeric value, same fold, same zero-event reading; the rename carries
  // through every embedded array via `buildEmbeddedJob`. Drives the
  // readiness pipeline's `git-orphans` predicate after fn-633.6 flips the
  // consumer.
  git_unattributed_to_live_count: number;
  // Schema v31: NEW column for the strict-mystery semantic (files with no
  // attribution from any session). Reads 0 on every entry until the
  // reducer fold rewrite in fn-633.6 lands. INTEGER NOT NULL DEFAULT 0.
  git_orphan_count: number;
}

/**
 * The shape of the post-write `jobs` row {@link syncJobIntoEpic} reads back to
 * build the embedded element. Mirrors the relevant subset of {@link import("./types").Job}.
 *
 * Schema-v28: `git_dirty_count` + `git_orphan_count` are required on this
 * input shape so TypeScript surfaces any caller of `syncJobIntoEpic` (via
 * the `syncIfPlanRef` SELECT path) that forgets to project them out of
 * `jobs`. The defaults are `0` on a never-snapshotted row, but the type is
 * `number` (not `number | null`) because the column is `NOT NULL DEFAULT 0`.
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
 * Build an {@link EmbeddedJobElement} from a post-write `jobs` row. The
 * `plan_verb` field is non-null by construction — the caller short-circuits
 * via `parsePlanRef` before invoking this on a row whose `plan_verb` is null
 * (a job carrying `plan_ref` always carries `plan_verb`, set-once at
 * SessionStart together).
 */
function buildEmbeddedJob(row: JobsRowForSync): EmbeddedJobElement {
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
    git_dirty_count: row.git_dirty_count,
    git_unattributed_to_live_count: row.git_unattributed_to_live_count,
    git_orphan_count: row.git_orphan_count,
  };
}

/**
 * Fan a `jobs` row write into the correct embedded array on the `epics`
 * projection. Runs INSIDE the open transaction opened by {@link applyEvent};
 * performs zero cursor work.
 *
 * - `plan_ref == null` → no-op (this isn't a planctl-spawned session).
 * - `plan_ref` parses to `{kind: 'epic', epic_id}` (verbs `plan` / `close`) →
 *   read-modify-write the parent epic's `epics.jobs` array.
 * - `plan_ref` parses to `{kind: 'task', epic_id, task_id}` (verb `work`) →
 *   read-modify-write the corresponding task element's nested `jobs`
 *   sub-array inside the parent epic's `tasks`.
 * - `plan_ref` shape mismatch → null parse → no-op, cursor still advances.
 *
 * Shell-row pattern: when the parent epic (or for task-level, the parent
 * task element) does not yet exist, insert a shell row / shell task element
 * carrying just the one new entry. Subsequent `EpicSnapshot` / `TaskSnapshot`
 * folds preserve the embedded `jobs` arrays — the EpicSnapshot ON CONFLICT
 * carve-out omits `jobs`, and the TaskSnapshot RMW reads the OLD element's
 * `jobs` before re-placing.
 *
 * Every write bumps the epic's `last_event_id` to `eventId` so the per-row
 * diff fires (the read surface emits a `patch` on the epic, regardless of
 * which nested array changed). The sort `(created_at desc, job_id asc)` is
 * applied on every write — never append — for byte-identical re-fold.
 *
 * NEVER throws inside the open transaction. A malformed stored array folds
 * to `[]`; an absent epic row folds to a fresh shell.
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
  const element = buildEmbeddedJob(jobsRow);

  if (parsed.kind === "epic") {
    const epicRow = db
      .query("SELECT jobs FROM epics WHERE epic_id = ?")
      .get(parsed.epic_id) as { jobs: string | null } | null;
    const existing = parseEmbeddedJobs(epicRow?.jobs);
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
      // No epic row yet — insert a shell row carrying just this new jobs
      // entry. A later EpicSnapshot fills the scalars without clobbering
      // `jobs` (its ON CONFLICT omits the column). Mirror the
      // shell-row INSERT pattern from `projectPlanRow`.
      db.run(
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

  // The full task element shape we read+write. The plan-fold's element
  // already carries all these fields; a shell task element initialises the
  // scalar columns to NULL / the planctl `"todo"` default. The SLOT ORDER
  // MUST match `projectPlanRow`'s embedded `element` shape AND
  // `seedFromDb`'s reconstruction in `plan-worker.ts` (the change-gate
  // `JSON.stringify` byte-compare is the parity check; see schema v19 note).
  interface TaskElement {
    task_id: string;
    epic_id: string | null;
    task_number: number | null;
    title: string | null;
    target_repo: string | null;
    /**
     * Planctl-native effort tier (fn-602). Optional on the type because pre-
     * fn-602 stored elements lack the key; the OLD-element carve-out spread
     * below preserves whatever value (or absence) was already there. A shell
     * element from this fan-out initialises `tier: null` (matches the zero-
     * event projection) — a later plan-snapshot fold fills it without
     * clobbering jobs via the same spread-carve-out as the other scalars.
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

  // Find-or-shell the task element. A first-sight task element shells with
  // scalar columns NULL — a later TaskSnapshot fills them without clobbering
  // the `jobs` sub-array (the RMW preserves the OLD element's `jobs`).
  const oldTask = tasksArr.find((t) => t.task_id === parsed.task_id);
  const oldJobs =
    oldTask != null && Array.isArray(oldTask.jobs) ? oldTask.jobs : [];
  const nextTaskJobs = oldJobs.filter((j) => j.job_id !== element.job_id);
  nextTaskJobs.push(element);
  sortEmbeddedJobs(nextTaskJobs);

  // OLD-element carve-out: when an OLD task element exists, preserve ALL of
  // its scalar fields (including the new `worker_phase` + `runtime_status`)
  // by spreading and re-attaching only the freshly-merged `jobs` sub-array.
  // The spread is the carve-out — a jobs-write fan-out MUST NOT clobber the
  // plan-snapshot-derived fields, or every job tick would stomp the task-
  // status pills with stale snapshot values (CLAUDE.md §Acceptance bullet).
  const newTaskElement: TaskElement =
    oldTask != null
      ? { ...oldTask, jobs: nextTaskJobs }
      : {
          task_id: parsed.task_id,
          epic_id: parsed.epic_id,
          task_number: null,
          title: null,
          target_repo: null,
          // Planctl-native effort tier (fn-602): shell elements know
          // nothing about it — a later plan-snapshot fold fills it via the
          // OLD-element carve-out spread above (`{...oldTask, jobs: ...}`)
          // without clobbering the new `jobs` sub-array.
          tier: null,
          worker_phase: null,
          // A shell task element (no plan-snapshot folded yet) gets the
          // planctl `"todo"` default, matching the zero-event projection
          // and `merge_task_state` convention.
          runtime_status: "todo",
          depends_on: [],
          jobs: nextTaskJobs,
        };

  // Replace-or-insert the task element by task_id, then re-sort by
  // (task_number, task_id) — the SAME deterministic key the plan fold +
  // migration backfill use.
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
    db.run(
      `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, last_event_id, updated_at, tasks, jobs)
         VALUES (?, NULL, NULL, NULL, NULL, ?, ?, ?, '[]')`,
      [parsed.epic_id, eventId, ts, tasksJson],
    );
  }
}

/**
 * Read the post-write `jobs` row and fan into:
 *
 * (1) the embedded `epics.jobs` / task `jobs` sub-arrays via
 *     {@link syncJobIntoEpic} — gated on `plan_ref != null` (the
 *     `EmbeddedJob` slot is keyed off the session's spawn-name verb).
 * (2) every linked epic's `epics.job_links` enriched entries via
 *     {@link syncJobLinksOnJobWrite} — gated on `epic_links != '[]'`
 *     (the link projection is keyed off the session's planctl-CLI
 *     footprint, which is INDEPENDENT of `plan_ref`: an arthack-driven
 *     manual session with `plan_ref = null` can still carry a creator
 *     or refiner edge from `planctl epic-create` etc.).
 *
 * The SELECT lives here (not at each call site) so the fan-out reads
 * the LATEST state-machine state — e.g. a SessionEnd handler's UPDATE
 * flips `state` to `ended` first, then this SELECT picks up the new
 * state and BOTH fan-outs see the updated `state` value in lockstep.
 *
 * Runs INSIDE the open transaction opened by {@link applyEvent}. The
 * caller MUST gate on "an UPDATE/INSERT actually wrote" before invoking
 * — the Killed-mismatch path (no write happened) must NOT fire either
 * fan-out. See the per-call-site comments in {@link projectJobsRow}.
 *
 * The two fan-outs have DISJOINT gates (`plan_ref` vs `epic_links`) but
 * SHARE the trigger condition ("a jobs row was just written that may
 * have changed display fields"), so co-locating their wiring here keeps
 * every call site one line and ensures neither fan-out is silently
 * forgotten when a new jobs-write branch lands.
 */
function syncIfPlanRef(
  db: Database,
  jobId: string,
  eventId: number,
  ts: number,
): void {
  const row = db
    .query(
      "SELECT job_id, plan_verb, plan_ref, state, title, created_at, updated_at, last_event_id, last_api_error_at, last_api_error_kind, last_input_request_at, last_input_request_kind, git_dirty_count, git_unattributed_to_live_count, git_orphan_count FROM jobs WHERE job_id = ?",
    )
    .get(jobId) as JobsRowForSync | null;
  if (row == null) {
    return;
  }
  if (row.plan_ref != null) {
    syncJobIntoEpic(db, row, eventId, ts);
  }
  // Independent gate: `syncJobLinksOnJobWrite` reads `jobs.epic_links`
  // and short-circuits on `'[]'` itself, so it's cheap to always call —
  // and gating it on `plan_ref != null` here would silently miss
  // creator/refiner sessions whose spawn name didn't parse as
  // `{plan|work|close|approve}::<ref>` (e.g. arthack manual sessions running
  // `planctl epic-create` outside the planctl spawn whitelist).
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
 * Deterministic sort for an embedded `epic_links` array (used on
 * `jobs.epic_links`). Total-order ASC on the full `(kind, target)` tuple —
 * mirrors the classifier's final sort. The classifier already sorts its
 * output, but the fold also re-applies here so any future read-side mutation
 * stays deterministic. Parallel to {@link sortEmbeddedJobs}.
 *
 * Why total-order: a single-field sort would leave equal-`kind` ties (two
 * creators, two refiners) in implementation-defined order, breaking the
 * byte-identical re-fold invariant.
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
 * Deterministic sort for an embedded `job_links` array (used on
 * `epics.job_links`). Total-order ASC on the full `(kind, job_id)` tuple —
 * mirrors the classifier's final sort. Parallel to {@link sortEpicLinks}.
 *
 * Accepts any object with `{kind, job_id}` so both the thin classifier
 * shape ({@link JobLink}) and the enriched projection shape
 * ({@link JobLinkEntry}) sort through the same code path — re-fold
 * determinism is a function of the SORT order alone, not the carried
 * fields, so a single sort with one widened parameter is correct.
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
 * Enrich a thin classifier-output `JobLink` (`{kind, job_id}`) into the
 * widened `JobLinkEntry` projection shape carried on `epics.job_links`
 * — adding `(title, state, last_api_error_at, last_api_error_kind)` read
 * directly off the post-write `jobs` row.
 *
 * Shared between the live reducer fan-out (`syncPlanctlLinks`) and the
 * jobs-write fan-out (`syncJobLinksOnJobWrite`). SAME code path, SAME
 * defaults — different code paths producing the same JSON is the
 * classic silent re-fold-determinism break this helper exists to
 * prevent.
 *
 * **Defaults on a missing `jobs` row.** Returns
 * `{kind, job_id, title: null, state: "stopped", last_api_error_at: null,
 * last_api_error_kind: null}` — the zero-event projection reading. The
 * two api-error columns are emitted as explicit JSON nulls (NOT
 * omitted): omitting keys vs. emitting nulls produces different
 * `JSON.stringify` bytes and would break the byte-identical re-fold
 * contract. This matches the scenario where the classifier emitted an
 * edge for a session whose backing `jobs` row was never inserted (orphan
 * planctl invocation: no SessionStart), and preserves re-fold
 * determinism (a from-scratch re-fold sees the same missing row at the
 * same enrichment point and writes the same defaults).
 *
 * **Key order is locked.** Both branches emit
 * `{kind, job_id, title, state, last_api_error_at, last_api_error_kind}`
 * in that exact order; the wire encoding is `JSON.stringify`, which
 * preserves insertion order, so any drift between branches would
 * produce different bytes for the same logical entry — a silent
 * re-fold-determinism break.
 *
 * NEVER throws inside the open BEGIN IMMEDIATE transaction.
 */
function enrichJobLink(db: Database, classifierEntry: JobLink): JobLinkEntry {
  const row = db
    .query(
      "SELECT title, state, last_api_error_at, last_api_error_kind, last_input_request_at, last_input_request_kind FROM jobs WHERE job_id = ?",
    )
    .get(classifierEntry.job_id) as {
    title: string | null;
    state: string;
    last_api_error_at: number | null;
    last_api_error_kind: string | null;
    last_input_request_at: number | null;
    last_input_request_kind: string | null;
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
  };
}

/**
 * Reverse fan-out from a jobs-write that may have changed `title` /
 * `state` / `last_api_error_at` / `last_api_error_kind` on a session
 * whose planctl-CLI footprint has already produced epic-link edges. For
 * each epic that references this `jobId` via the symmetric
 * `jobs.epic_links` array, re-stamp the matching entry on that epic's
 * `job_links` with fresh enrichment (`enrichJobLink`), preserving every
 * OTHER entry on that epic verbatim.
 *
 * Mirrors {@link syncJobIntoEpic}'s step-for-step structure. Runs INSIDE
 * the open transaction opened by {@link applyEvent}; performs zero cursor
 * work.
 *
 * **Gate (epic_links !== '[]').** The fan-out has its OWN gate — it is
 * NOT piggybacking on `plan_ref`. A creator / refiner session may have
 * `plan_ref = null` (an arthack-driven manual session running
 * `planctl epic-create` outside a `work::` / `plan::` / `close::` spawn),
 * so gating on `plan_ref` would silently miss its epic re-stamps. The
 * gate reads `jobs.epic_links` directly and short-circuits when the cell
 * is `'[]'` (no edges to fan into, so no epic to re-stamp).
 *
 * **Reverse lookup via the symmetric array (no `json_each` scan).**
 * Single-row PK SELECT + small JSON parse of `jobs.epic_links` to know
 * which epics to touch. We deliberately do NOT scan `epics.job_links`
 * with `json_each`: that's an unindexed TVF (full table scan + virtual-
 * row expansion), and the symmetric `jobs.epic_links` array already
 * carries the reverse lookup at PK cost.
 *
 * **Shell-insert pattern.** When a targeted epic row does not yet exist
 * (the classifier emitted an edge, but no EpicSnapshot has folded for
 * that epic yet) the helper INSERTs a shell row carrying just this one
 * enriched entry. Mirrors the same pattern in {@link syncPlanctlLinks}'s
 * touched-epic loop and {@link syncJobIntoEpic}'s epic-shell branch.
 *
 * **OLD-element carve-out.** Entries for OTHER `job_id`s on the same
 * epic are preserved verbatim (filter + push pattern); only the entry
 * matching `jobId` is re-stamped with fresh enrichment. Without this
 * carve-out a jobs-write would clobber every cross-session edge on every
 * touched epic.
 *
 * NEVER throws inside the open transaction. A malformed stored
 * `jobs.epic_links` blob folds to `[]` via {@link parseEmbeddedLinks};
 * a malformed `epics.job_links` blob does the same.
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
  // Gate: `'[]'` short-circuit. The byte-compare is intentional — the
  // schema default + the reducer's empty-array write both produce
  // `'[]'` exactly, so this is a cheap pre-parse skip for the common
  // case (a session with no planctl footprint).
  if (jobRow.epic_links === null || jobRow.epic_links === "[]") {
    return;
  }
  const epicLinks = parseEmbeddedLinks<EpicLink>(jobRow.epic_links);
  if (epicLinks.length === 0) {
    return; // malformed/empty after parse — nothing to fan into.
  }

  // Build the freshly-enriched entry once — every targeted epic re-stamps
  // the SAME entry shape (the entry IS the post-write jobs row's
  // projection through `enrichJobLink`).
  const enriched = enrichJobLink(db, { kind: "creator", job_id: jobId });
  // Note: `kind` above is a placeholder — the per-epic loop below knows
  // the kind from the existing entry it's replacing, so we never use the
  // placeholder kind. We construct the enriched payload here to amortize
  // the SELECT across every touched epic.

  for (const epicLink of epicLinks) {
    const epicId = epicLink.target;
    const epicRow = db
      .query("SELECT job_links FROM epics WHERE epic_id = ?")
      .get(epicId) as { job_links: string | null } | null;
    const existing =
      epicRow != null
        ? parseEmbeddedLinks<JobLinkEntry>(epicRow.job_links)
        : [];
    // OLD-element carve-out: drop the entry for THIS job_id, preserve
    // every other entry verbatim. Find the OLD entry's `kind` so the
    // re-stamp lands with the same classifier-derived kind (the
    // classifier — not the jobs-write — is the source of truth for
    // creator vs. refiner; this helper only refreshes the display
    // fields).
    const oldEntry = existing.find((e) => e.job_id === jobId);
    if (oldEntry == null) {
      // Unreachable in a healthy projection. Invariant: `jobs.epic_links`
      // and `epics.job_links` are atomically co-written by
      // `syncPlanctlLinks` in the same `BEGIN IMMEDIATE` transaction as
      // the event fold, so every `(session, epic)` edge present in
      // `jobs.epic_links` has a matching reverse entry in
      // `epics.job_links`. No other helper de-syncs them — the OLD-element
      // carve-out in `syncPlanctlLinks` preserves other entries verbatim,
      // the EpicSnapshot ON CONFLICT carve-out preserves `job_links`, and
      // EpicDeleted drops the epic row entirely (the shell-insert branch
      // below rebuilds it). There is NO async catch-up loop; we keep this
      // `continue` purely as defense-in-depth so a corrupt-blob projection
      // can't wedge the reverse fan-out mid-transaction.
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
      // No epic row yet — shell-insert. Mirrors the shell-insert in
      // `syncPlanctlLinks`'s touched-epic loop; the EpicSnapshot ON
      // CONFLICT carve-out preserves `job_links` /
      // `created_by_closer_of` / `sort_path` / `queue_jump` so a later
      // snapshot fold cannot wipe the enriched payload OR the
      // schema-v29 closer columns OR the schema-v30 queue-jump flag.
      // All three new columns default to `NULL` / `''` / `0` (the
      // schema zero-event reading); the next `syncPlanctlLinks` call
      // computes the real values. `queue_jump` is omitted from the
      // column list so SQLite fills `INTEGER NOT NULL DEFAULT 0`.
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
 * Fan a planctl-CLI invocation (or a `/plan:plan` window opener) into the
 * `jobs.epic_links` + per-touched-epic `epics.job_links` projections. Runs
 * INSIDE the open transaction opened by {@link applyEvent}; performs zero
 * cursor work. Parallel to {@link syncJobIntoEpic} — the triggers are
 * disjoint (jobs-write trigger vs. planctl-event trigger) so the two fan-out
 * helpers do NOT share code.
 *
 * Procedure (re-derive from scratch on every triggering event — full-replace,
 * never delta-merge, per CLAUDE.md "byte-identical re-fold"):
 *
 * 1. Load every planctl invocation row for `sessionId` (the partial composite
 *    index `(session_id, id) WHERE planctl_op IS NOT NULL` makes this cheap).
 *    Also load every `/plan:plan` opener event for the session (locked gate:
 *    `PreToolUse + skill_name='plan:plan'` only — `slash_command` rows would
 *    double-fire on slash-typed invocations).
 * 2. Compute half-open `/plan:plan` windows via {@link computePlanWindows}.
 * 3. Compute the new `epic_links` via {@link deriveEpicLinks}.
 * 4. Read the pre-state `jobs.epic_links` for the session.
 * 5. Compute the pre + post epic-id union — every target that appears in
 *    EITHER pre or post `epic_links` (a removed edge still needs its epic's
 *    `job_links` re-derived to drop the now-stale entry).
 * 6. UPDATE the jobs row's `epic_links` + `last_event_id` + `updated_at`.
 * 7. For each epic id in the pre+post union, re-derive `job_links` via
 *    {@link deriveJobLinks} over the FULL per-epic invocation/window
 *    namespace (every session, not just this one). UPDATE the epic row;
 *    shell-insert a missing epic row mirroring {@link syncJobIntoEpic}'s
 *    pattern so a from-scratch re-fold reproduces every row.
 *
 * **Cost profile.** A session with N planctl events triggers N fan-outs, and
 * each fan-out scans every session's planctl invocations for the per-epic
 * `deriveJobLinks` pass. The partial composite index
 * `idx_events_planctl_session` (db.ts schema v14) bounds the per-session scan
 * to its own slice. Worst case: 200 planctl events × 5 touched epics × full
 * per-epic-namespace scan. Acceptable for the current scale; if it becomes
 * hot a future optimization could cache per-session invocations within the
 * fold transaction.
 *
 * **No-op when:**
 * - The jobs row for `sessionId` does not exist (no SessionStart yet —
 *   skip; the jobs UPDATE matches zero rows and the per-epic re-derive is
 *   pointless without a backing job row).
 *
 * NEVER throws inside the open transaction. A malformed stored array folds
 * to `[]` via {@link parseEmbeddedLinks}; an absent epic row folds to a
 * fresh shell.
 */
function syncPlanctlLinks(
  db: Database,
  sessionId: string,
  eventId: number,
  ts: number,
): void {
  // The session's backing jobs row must exist for an epic_links UPDATE to
  // land. A planctl invocation in a session with no SessionStart is an
  // orphan; we skip the jobs-side write but still re-derive every touched
  // epic's job_links (cross-session classifier output) so symmetry holds.
  const jobsRow = db
    .query("SELECT epic_links FROM jobs WHERE job_id = ?")
    .get(sessionId) as { epic_links: string | null } | null;

  // Load this session's planctl invocations (ASC by event id — stable
  // ordering for the classifier's per-window pointer advance). The partial
  // composite index `idx_events_planctl_session (session_id, id) WHERE
  // planctl_op IS NOT NULL` serves this with no full-table scan.
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

  // Load this session's `/plan:plan` openers. Locked gate: PreToolUse-on-Skill
  // with skill_name='plan:plan' only. Slash-command UserPromptSubmit rows are
  // NOT openers — they'd double-fire on slash-typed invocations (the same
  // /plan:plan call appears as both a slash_command UserPromptSubmit and a
  // PreToolUse:Skill event).
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
  // re-fold determinism requires that re-folding the same events produces the
  // same JSON; delta-merge would double on re-fold).
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

  // Build the per-epic re-derive inputs: every session that has touched any of
  // the affected epics, with its full planctl invocations + windows. The
  // classifier's `deriveJobLinks` expects ReadOnly maps keyed by job_id.
  //
  // Step 1: find every distinct session_id that has at least one planctl
  // invocation touching any of `touchedEpics` (epic id appearing as either
  // planctl_epic_id or planctl_target). We then load each such session's FULL
  // invocation list — not just the touching ones — because the classifier
  // needs the full per-session ordering for its window advance.
  const targetList = [...touchedEpics];
  const placeholders = targetList.map(() => "?").join(",");
  // UNION (not OR) so the planner uses BOTH partial indexes — SQLite picks
  // ONE index per cross-column OR, but a UNION decomposes into a COMPOUND
  // QUERY whose left branch SEARCHes `idx_events_planctl_epic` and right
  // branch SEARCHes `idx_events_planctl_target` (Tier 2 fn-628; see
  // `CREATE_EVENTS_PLANCTL_INDEXES` in src/db.ts). UNION dedups via temp
  // B-tree — identical session_id set to the prior `SELECT DISTINCT ...
  // OR ...` form, so re-fold determinism is preserved (the downstream
  // `syncPlanctlLinks` derivation consumes the session_id set the same
  // way regardless of which form produced it).
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
  // The current session might have touched an epic in pre-state that NO
  // invocation now references (a refiner edge dropped because of suppression
  // ordering) — make sure it's in the sweep too so its now-stale job_links
  // entry gets pulled.
  const sessionIds = new Set<string>(sessionRows.map((r) => r.session_id));
  sessionIds.add(sessionId);

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
    invocationsBySession.set(
      sid,
      sidInvRows.map((r) => ({
        ts: r.ts,
        op: normalizePlanctlOp(r.planctl_op),
        target: r.planctl_target,
        epic_id: r.planctl_epic_id,
        subject_present: r.planctl_subject_present === 1,
      })),
    );
    // Schema v30: queue_jump is NOT part of the ClassifierInvocation shape
    // (the classifier doesn't need it — it's a per-epic flag, not a per-
    // invocation classification signal). We read it below per-touched-epic
    // off the events sparse column directly, gated by the same
    // `planctl_op IS NOT NULL` partial index.
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

  // Step 2: re-derive job_links for each touched epic and UPDATE the epic row.
  // Shell-insert a missing epic row — mirrors syncJobIntoEpic's pattern. A
  // later EpicSnapshot fills the scalars without clobbering job_links (the
  // EpicSnapshot ON CONFLICT omits the column — see projectPlanRow).
  //
  // Schema v29: per-epic, also derive `created_by_closer_of` (the raw closer
  // → child link) and `sort_path` (the materialized-path sort key). After
  // each touched epic's UPDATE, transitively re-stamp every descendant's
  // `sort_path` whose closer-chain leads back to this epic. The cascade
  // runs inside the same BEGIN IMMEDIATE so a from-scratch re-fold
  // reproduces byte-identical projection.
  for (const epicId of touchedEpics) {
    const newJobLinks = deriveJobLinks(
      invocationsBySession,
      windowsBySession,
      epicId,
    );
    // Enrich each thin classifier entry into the widened JobLinkEntry
    // shape (schema v24): SELECT the linked `jobs` row inside the open
    // transaction and stamp `(title, state, last_api_error_at,
    // last_api_error_kind)`. The enrichment helper is the SAME one used
    // by the jobs-write fan-out (`syncJobLinksOnJobWrite`) — re-fold
    // determinism requires a single source of truth for "what's the
    // projection shape on disk".
    const enriched: JobLinkEntry[] = newJobLinks.map((e) =>
      enrichJobLink(db, e),
    );
    sortJobLinks(enriched);
    const jobLinksJson = JSON.stringify(enriched);

    // Schema v29: derive `created_by_closer_of` from the just-computed
    // creator entries. Filter the creator job_ids down to those whose
    // backing `jobs` row carries `plan_verb='close' AND plan_ref IS NOT
    // NULL`; tie-break on lowest `job_id` ASC (deterministic, identical
    // across re-folds). If none match → NULL.
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

    // Derive `sort_path` from the resolved `created_by_closer_of` and this
    // epic's own `epic_number`. Three branches:
    //   - `created_by_closer_of == null` → `zeroPad6(epic_number)`.
    //   - Parent's `sort_path` resolves to a non-empty value →
    //     `<parent.sort_path>.<zeroPad6(epic_number)>`.
    //   - Parent row missing OR parent's `sort_path === ''` (transient
    //     shell, or recursive overflow earlier in chain) → fall back to
    //     `zeroPad6(epic_number)` (placeholder; later parent re-projection
    //     triggers cascade re-stamp).
    //   - Overflow guard: `epic_number >= 1_000_000` → `sort_path = ''` +
    //     console.error note. Never throws (the safe-fold honors the
    //     "reducer never throws inside BEGIN IMMEDIATE" invariant).
    //
    // `epic_number` is read off the touched epic row, NOT from the in-
    // flight snapshot — `syncPlanctlLinks` may run on an EpicSnapshot,
    // a planctl-event, or a /plan:plan opener, only the first of which
    // even carries an `epic_number`. A shell row (planctl event before
    // the EpicSnapshot lands) has `epic_number = NULL`; the derivation
    // safely-folds to `zeroPad6(0)` = `"000000"` in that case so the
    // re-fold determinism holds. The very next EpicSnapshot triggers a
    // fresh `syncPlanctlLinks` round (via the planctl-event fold), which
    // will recompute with the now-known `epic_number` and cascade if it
    // changed.
    const ownRow = db
      .query("SELECT epic_number FROM epics WHERE epic_id = ?")
      .get(epicId) as { epic_number: number | null } | null;
    const ownNumber = ownRow?.epic_number ?? 0;

    // Schema v30: derive `queue_jump` for this epic. Scan THIS epic's
    // session events for any planctl_invocation envelope that carried
    // `queue_jump: true` (today: the `/plan:queue` scaffold path). The
    // signal is sticky-true: any single envelope flipping it to `1`
    // locks the epic into queued state for the lifetime of the
    // projection. There is no `/plan:unqueue` path — removing a queued
    // epic requires deleting the epic outright. A re-fold replays the
    // same envelopes in the same order, so the EXISTS branch is
    // byte-deterministic.
    //
    // The scan keys off `planctl_epic_id = <this epicId>` (the parsed-
    // out epic side of `planctl_target`). The Tier 2 (fn-628.2)
    // `idx_events_planctl_epic ON events(planctl_epic_id, session_id, id)
    // WHERE planctl_op IS NOT NULL` partial composite index serves this
    // equality cheaply — EQP shows `SEARCH events USING INDEX
    // idx_events_planctl_epic (planctl_epic_id=?)`. The schema-v14
    // `(session_id, id) WHERE planctl_op IS NOT NULL` index is
    // session-leading and cannot serve a `planctl_epic_id = ?` lookup
    // on its own.
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
      // Root epic. Schema v30: prepend `!` when queue_jump=1 so this
      // epic sorts strictly above every non-queued root under SQLite
      // BINARY collation (`!` = ASCII 33 < digits 48-57). Multiple
      // queue-jumped roots sort FIFO by epic_number under the shared
      // `!` prefix — no tiebreaker math.
      sortPath =
        queueJump === 1 ? `!${zeroPad6(ownNumber)}` : zeroPad6(ownNumber);
    } else {
      const parentRow = db
        .query("SELECT sort_path FROM epics WHERE epic_id = ?")
        .get(createdByCloserOf) as { sort_path: string | null } | null;
      const parentPath = parentRow?.sort_path ?? "";
      if (parentPath === "") {
        // Parent missing / placeholder — fall back to root-level position.
        // The cascade re-stamps when the parent later resolves.
        // Schema v30: a non-root queue-jumped epic in placeholder state
        // does NOT get the `!`-prefix; once the parent resolves the
        // cascade re-stamps with the inherited prefix from `parentPath`.
        sortPath = zeroPad6(ownNumber);
      } else {
        // Non-root: inherit parent's path verbatim. If the parent (root
        // or transitive ancestor) carries the `!`-prefix, it propagates
        // through this string concat for free — no separate child-flag
        // plumbing. A non-root queue-jumped epic still projects
        // `queue_jump = 1` for symmetry (the row knows its own state)
        // but does NOT prepend a second `!`.
        sortPath = `${parentPath}.${zeroPad6(ownNumber)}`;
      }
    }

    const epicExists = db
      .query("SELECT epic_id FROM epics WHERE epic_id = ?")
      .get(epicId) as { epic_id: string } | null;
    if (epicExists != null) {
      // Extend the existing UPDATE to also set the schema-v29 columns
      // AND the schema-v30 `queue_jump` column in the same statement.
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
      // Shell-insert: no epic row yet. Scalars default to NULL / "[]"
      // matching the schema's zero-event reading. A later EpicSnapshot
      // fills the scalars; the ON CONFLICT carve-out preserves
      // job_links / jobs / tasks / created_by_closer_of / sort_path /
      // queue_jump. The schema-v29 + v30 columns are stamped with the
      // JUST-DERIVED values (typically `created_by_closer_of` is real
      // but `sort_path` is the placeholder `zeroPad6(0) = "000000"` since
      // no `epic_number` is known yet — the next `syncPlanctlLinks`
      // call, post-EpicSnapshot, recomputes against the now-visible
      // `epic_number`; the `queue_jump` value is locked-in true on
      // first observation since the scan reads it from the immutable
      // event log).
      db.run(
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

    // Transitive cascade: every epic whose `created_by_closer_of` equals
    // this just-updated epic's id must have its `sort_path` recomputed
    // against the new parent value. Recurse to fixed point inside the
    // open transaction. Cycle guard: a `visited` set + depth cap of 50.
    // By construction `created_by_closer_of` is immutable once set (one
    // closer-creator per epic, set on creation), so cycles can't form;
    // the guard is defense-in-depth — a malformed historical state, an
    // unexpected pathological event sequence, or a future invariant
    // violation cannot wedge the reducer.
    cascadeSortPath(db, epicId, eventId, ts);
  }
}

/**
 * Schema v29: re-stamp `sort_path` on every transitive descendant of
 * `rootEpicId` (every epic with `created_by_closer_of = rootEpicId`, and
 * recursively their descendants). Runs INSIDE the open BEGIN IMMEDIATE
 * transaction opened by {@link applyEvent}; performs zero cursor work.
 *
 * The cascade is BFS over an in-memory queue with a `visited: Set<string>`
 * cycle guard and a depth cap at 50. By construction cycles can't form —
 * `created_by_closer_of` is immutable once set, one closer-creator per
 * epic — so the guard is defense-in-depth: a malformed historical state
 * or unexpected pathological event sequence cannot wedge the reducer.
 * Both bails (cycle hit / depth overrun) `console.error` a note and
 * return; never throws.
 *
 * Each descendant's `sort_path` is recomputed as `<parent.sort_path>.<
 * zeroPad6(descendant.epic_number)>` (or `zeroPad6(descendant.epic_number)`
 * if parent's `sort_path === ''` — the placeholder case). Same overflow
 * guard as in {@link syncPlanctlLinks}: `epic_number >= 1_000_000` folds
 * to `sort_path = ''` and notes.
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
 * Schema v34 (fn-637): row shape lifted from `epics` for the fold-time
 * resolver's all-epics index. Carries the minimal subset
 * `resolveEpicDep` reads off an {@link Epic}: `epic_id`, `epic_number`,
 * `project_dir`, `status`, `approval`. Everything else (`tasks`,
 * `jobs`, `job_links`, `depends_on_epics`, etc.) is irrelevant to
 * resolution and excluded from the SELECT to keep the in-fold scan
 * narrow.
 */
interface EpicLite {
  epic_id: string;
  epic_number: number | null;
  project_dir: string | null;
  status: string | null;
  approval: "approved" | "rejected" | "pending";
}

/**
 * Reducer-local minimal {@link Epic}-shaped record assembled from an
 * {@link EpicLite} row, satisfying the {@link Epic} surface the shared
 * {@link resolveEpicDep} resolver reads. The fields the resolver does
 * NOT touch (`tasks`, `jobs`, `job_links`, etc.) are stamped with
 * zero-event defaults so a type-narrow consumer that walks them yields
 * the same shape as a real {@link Epic} (defense-in-depth — the
 * resolver only reads the five fields above, but the helper builds the
 * full surface so future widening of the resolver doesn't silently miss
 * fields).
 */
function epicLiteToEpic(row: EpicLite): Epic {
  return {
    epic_id: row.epic_id,
    epic_number: row.epic_number,
    title: null,
    project_dir: row.project_dir,
    status: row.status,
    approval: row.approval,
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
 * Schema v34 (fn-637): build the in-fold all-epics index the shared
 * {@link resolveEpicDep} resolver reads against. Returns `(epicById,
 * epicsByNumber)` keyed off the live `epics` table. Runs INSIDE the
 * open transaction opened by {@link applyEvent}; performs zero cursor
 * work.
 *
 * Read-in-fold is allowed (the autocommit ban in CLAUDE.md is on DB
 * watchers, not query reads). The SELECT is narrow — five columns —
 * and the table sits at ~1k rows in the steady state, so the scan is
 * cheap. Per-call cost dominates the fold; if it becomes hot a future
 * optimization could cache the index inside `applyEvent` and reuse it
 * across the forward + reverse passes, but the current shape keeps
 * each helper composable.
 *
 * Determinism: every column read is persisted from the immutable event
 * log; nothing here reads wall-clock, env, or OS state. A from-scratch
 * re-fold rebuilds the same index at the same event, so the per-event
 * derivation of `resolved_epic_deps` is byte-identical across re-folds.
 */
function buildEpicIndex(db: Database): {
  epicById: Map<string, Epic>;
  epicsByNumber: Map<number, Epic[]>;
} {
  const rows = db
    .query(
      `SELECT epic_id, epic_number, project_dir, status, approval
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
  // Stable order inside each `epicsByNumber` bucket so the resolver's
  // ambiguity tie-break (and downstream re-fold byte-identity) does not
  // depend on SQLite's result ordering. ORDER BY at the SELECT layer
  // would lift the cost into the planner; sorting the small bucket in
  // memory is cheaper and identical in semantics.
  for (const bucket of epicsByNumber.values()) {
    bucket.sort((a, b) =>
      a.epic_id < b.epic_id ? -1 : a.epic_id > b.epic_id ? 1 : 0,
    );
  }
  return { epicById, epicsByNumber };
}

/**
 * Schema v34 (fn-637): the shared enrich helper — mirror of
 * {@link enrichJobLink}. Given a raw `depTok` from the consumer's
 * `depends_on_epics` and the in-fold all-epics index, runs the shared
 * fold-safe {@link resolveEpicDep} resolver and projects the minimal-
 * subset tri-state entry onto the wire shape carried in
 * `epics.resolved_epic_deps`. Shared by the forward stamp, the
 * reverse fan-out, and the EpicDeleted path: SAME code path, SAME
 * defaults — re-fold determinism requires a single source of truth
 * for "what's the projection shape on disk".
 *
 * **Tri-state mapping** (locked):
 * - `dangling` — resolver returned `{kind: "dangling"}`.
 * - `satisfied` — resolver returned `{kind: "found"}` AND
 *   `epicIsCompleted(upstream)` (status='done' AND approval='approved'
 *   — the same terminal predicate `evaluateCloseRow` reads).
 * - `blocked-incomplete` — resolver returned `{kind: "found"}` but the
 *   upstream is not completed (any other `status`/`approval` combo).
 *
 * **Locked key order.** The minimal-subset shape emits keys in the
 * exact order `{dep_token, resolved_epic_id, epic_number,
 * project_basename, cross_project, state}`; the wire encoding is
 * `JSON.stringify`, which preserves insertion order, so any drift
 * between this helper's branches would produce different bytes for the
 * same logical entry — a silent re-fold-determinism break. Both
 * branches (dangling vs. found) emit the same six keys with explicit
 * `null` for the four "no resolution" fields in the dangling branch
 * (NOT omitted) so the byte shape stays uniform.
 *
 * **Cross-project flag.** Computed off the consumer's `project_dir`
 * basename vs. the upstream's. The same `projectBasename` helper the
 * readiness side uses (`./epic-deps`) keeps the boundary semantics
 * (POSIX-only, strip-trailing-slash) consistent across re-folds.
 * `cross_project` is `true` IFF the resolved upstream's basename is a
 * non-empty string AND differs from the consumer's non-empty basename;
 * dangling and "no project_dir on either side" both fold to `false`.
 *
 * **No wall-clock, no diagnostics surface.** The resolver injects `now`
 * for the `ambiguous-dep-resolution` diagnostic timestamp. The fold-
 * time call passes the event's own `ts` (an ISO-8601 string derived
 * deterministically — see `eventTsToIso`) so a re-fold reproduces the
 * same diagnostic. The diagnostics sink itself is a fresh empty array
 * the helper drops on the floor — the fold writes only the projection
 * row, never the side-band JSONL log (that's a `scripts/board.ts` /
 * `scripts/autopilot.ts` concern reading the readiness snapshot's
 * `diagnostics` field at frame-emit time).
 *
 * NEVER throws inside the open BEGIN IMMEDIATE transaction.
 */
function enrichEpicDep(
  depTok: string,
  consumer: Epic,
  epicById: Map<string, Epic>,
  epicsByNumber: Map<number, Epic[]>,
  nowIso: string,
): ResolvedEpicDep {
  // No-op diagnostics sink: a fresh empty array the helper drops on
  // the floor. Diagnostics are observational (side-band JSONL log read
  // at frame emit), not projection state; emitting them at fold time
  // would require an I/O path inside the transaction. The readiness
  // side surfaces the same diagnostic on its live resolve pass.
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
  // Cross-project is a boolean on the wire (NOT the readiness-side
  // string-or-null shape) — the projection carries the basename
  // separately so a consumer that wants to render the prefix has
  // both fields. `resolved.cross_project` is `string | null` from the
  // resolver; reduce to boolean here.
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
 * Schema v34 (fn-637): unix-seconds → ISO-8601 string for the resolver's
 * `now` parameter. Deterministic — `Date(unix*1000).toISOString()` is a
 * pure function of the unix-second integer carried on the event row, so
 * a from-scratch re-fold reproduces the same diagnostic ts byte-for-
 * byte (and `enrichEpicDep` drops the diagnostic on the floor anyway,
 * but the determinism contract holds end-to-end).
 *
 * Why we don't just pass the unix-seconds number through: the resolver's
 * `now` slot is typed as a string for the readiness side's
 * `new Date().toISOString()` precedent. Keeping the signature shape
 * stable across the readiness wrapper + the fold-time caller avoids
 * a `now: string | number` widening and the discriminated-union noise
 * that would ride with it.
 */
function eventTsToIso(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

/**
 * Schema v34 (fn-637): deterministic sort for an embedded
 * `resolved_epic_deps` array. **Source order** — entries are written
 * in the same order they appear in the consumer's `depends_on_epics`
 * array (NOT sorted by `dep_token`). This matches the readiness side's
 * iteration order, so a renderer reading `resolved_epic_deps` sees the
 * deps in the same order it'd see them off `depends_on_epics`.
 *
 * The sort itself is a no-op — included as a named function for symmetry
 * with {@link sortEpicLinks} / {@link sortJobLinks} and a single hook
 * point if a future ORDER BY rule lands. Re-fold determinism holds
 * because `depends_on_epics` is the source array (persisted in the
 * event blob, byte-stable across re-folds), and the helper just walks
 * it in order.
 */
function preserveSourceOrder(_arr: ResolvedEpicDep[]): void {
  // Intentional no-op — see docstring.
}

/**
 * Schema v34 (fn-637): the forward fold. Rebuild `epic_dep_edges` rows
 * for consumer `epicId` from scratch, then stamp the enriched
 * `resolved_epic_deps` array on the consumer's `epics` row.
 *
 * Runs INSIDE the open transaction opened by {@link applyEvent}; performs
 * zero cursor work. Called from the {@link projectPlanRow} EpicSnapshot
 * arm AFTER the INSERT/UPDATE of the consumer's row, AFTER the
 * sort_path derivation, but BEFORE the reverse fan-out (the reverse
 * pass reads `epics` for upstream rows that may have moved into / out
 * of the dep-resolution scope on this fold, and the forward pass has
 * already settled the consumer's row).
 *
 * **Full-recompute, never delta-merge.** Mirrors {@link syncPlanctlLinks}.
 * A delta-merge would double-add edges on re-fold. The forward pass
 * deletes every existing `epic_dep_edges` row for this consumer and
 * inserts one per `dep_token` in the consumer's `depends_on_epics`.
 *
 * **Raw-token edges.** Each `epic_dep_edges` row carries the raw token
 * from `depends_on_epics` verbatim — NOT the resolved id. Raw-token
 * keying makes ambiguity flips (a new same-number epic appears) and
 * dangling deps (no upstream resolves) re-stamp natively on a later
 * upstream snapshot: the reverse fan-out looks up consumers via
 * `dep_token IN (A.epic_id, 'fn-' || A.epic_number)`, and the raw
 * token is what the consumer originally typed.
 *
 * **De-duplicates within the consumer.** Two identical `depends_on_epics`
 * tokens collapse to ONE `epic_dep_edges` row (the table's `PRIMARY
 * KEY (consumer_id, dep_token)`) but BOTH render in `resolved_epic_deps`
 * — the projection mirrors the source array exactly. The de-dup at
 * the edges level is the schema constraint speaking, not a semantic
 * rule; the `INSERT OR IGNORE` shape preserves it without throwing
 * inside the transaction.
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
  // Read the consumer's row, including the just-written
  // `depends_on_epics`. This is the post-write read — the consumer's
  // INSERT/UPDATE has already landed in this transaction.
  const consumerRow = db
    .query(
      `SELECT epic_id, epic_number, project_dir, status, approval,
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

  // Full-recompute: wipe the consumer's existing edges, then insert
  // fresh ones from `depTokens`. `INSERT OR IGNORE` collapses
  // duplicate tokens onto a single edge row (the table's composite PK
  // enforces it), without throwing.
  db.run("DELETE FROM epic_dep_edges WHERE consumer_id = ?", [epicId]);
  for (const tok of depTokens) {
    db.run(
      "INSERT OR IGNORE INTO epic_dep_edges (consumer_id, dep_token) VALUES (?, ?)",
      [epicId, tok],
    );
  }

  // Build the enriched array. Source order — see
  // `preserveSourceOrder`'s docstring.
  const consumerEpic = epicLiteToEpic(consumerRow);
  // Make sure the consumer's own row is visible to the resolver — it
  // may have been freshly INSERTed into `epics` this fold and the index
  // was assembled BEFORE that INSERT landed on disk (we read the index
  // mid-projectPlanRow, after the upstream INSERT but the caller assembles
  // it before). Defense-in-depth: stamp the consumer back into the index
  // so a self-referential dep resolves the same way it would on a re-fold.
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
 * Schema v34 (fn-637): the reverse fan-out. After upstream `epicId`'s
 * row was written (EpicSnapshot) or deleted (EpicDeleted), find every
 * downstream consumer whose `depends_on_epics` carries a token that
 * could match this upstream and re-stamp their `resolved_epic_deps`.
 *
 * Runs INSIDE the open transaction opened by {@link applyEvent}; performs
 * zero cursor work. Depth-1 only — the fan-out never recurses, even if
 * a re-stamped consumer's projection changes downstream. The acyclic
 * `depends_on_epics` invariant + depth-1 fan-out together bound the
 * write fan-out per event to "the consumers of this one epic".
 *
 * **Matching tokens** (raw-token, NOT resolved-id). Looks up consumers
 * via `dep_token IN (<full_id>, 'fn-' || <epic_number>)`. Both forms
 * are considered: a consumer typed the full id `fn-100-foo` or the
 * bare id `fn-100`. The bare-id branch catches ambiguity flips —
 * before, `fn-100` resolved to nothing (no candidate); now, with a
 * new `fn-100-bar` epic in play, it resolves to one (or two, which
 * the resolver then re-disambiguates).
 *
 * **Skip the upstream itself.** A consumer that depends on itself (a
 * pathological state) is filtered out via `consumer_id != ?`. Without
 * this, the reverse pass would re-stamp the upstream's OWN
 * `resolved_epic_deps` based on its post-write state — already done
 * by the forward pass on this same fold. Avoiding the double-stamp
 * keeps the fold-time write count tight.
 *
 * **Deterministic ORDER BY consumer_id ASC.** Re-fold determinism
 * requires the per-consumer re-stamps to land in a stable order,
 * since each re-stamp UPDATEs the consumer row and bumps its
 * `last_event_id` / `updated_at`; SQLite's result order is otherwise
 * implementation-defined.
 *
 * **`isDelete=true` branch** (EpicDeleted). Same query, same loop, same
 * re-stamp. The upstream's row was already DELETEd by `retractPlanRow`,
 * so when the resolver looks it up by full id it misses; bare-id lookups
 * also miss because the deleted row has fallen out of `epicsByNumber`.
 * Both flip the consumer's matching entry to `dangling`. The branch is
 * unified with the snapshot path because the resolver consults the LIVE
 * `epics` table via `buildEpicIndex` — once the upstream row is gone,
 * the resolution outcome flips naturally.
 *
 * NEVER throws inside the open transaction.
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
  // Reverse adjacency lookup keyed off the raw token. Both the full id
  // (`fn-100-foo`) and the bare id (`fn-100`) are considered — a
  // consumer typed one or the other. Bare-id is materialized only when
  // `epicNumber != null`; an epic with no `epic_number` (a transient
  // shell, theoretically) projects no bare-id back-edge.
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
        `SELECT epic_id, epic_number, project_dir, status, approval,
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
      // FIRST sight of a session: the INSERT seeds the row. The schema default
      // gives state='stopped' — the zero-event reading. Seed the title from the
      // scraped spawn name (priority-1 'spawn' source) so the row reads a
      // non-NULL title from the very first event; a NULL spawn_name leaves title
      // NULL / title_source NULL (priority 0), with Tier 0 (the payload title
      // rule below) still seeding at the first UserPromptSubmit. The seed also
      // captures `transcript_path` from the payload (guarded parse, NULL when
      // absent/malformed) — a display/debug column, not a title.
      //
      // A DUPLICATE SessionStart is a RESUME: a genuinely-ended session can only
      // be reopened by a fresh `claude --resume` process, which fires
      // SessionStart (source=resume) — even a no-interaction resume — so this is
      // keeper's re-open signal. ON CONFLICT re-opens a TERMINAL row (CASE:
      // 'ended' OR 'killed' -> 'stopped'; a mid-session compact/clear
      // SessionStart on a working/stopped row leaves its state untouched, so it
      // never knocks a live job backwards) and refreshes BOTH pid and
      // start_time (a resume is a new OS process — fresh recycle-safe identity).
      // The COALESCE on start_time preserves the persisted value when the
      // incoming event has none (legacy / hook capture failure).
      // title/title_source are NOT touched — they stay precedence-owned, so a
      // resume never re-seeds the priority-1 spawn name over a higher source;
      // created_at / cwd / transcript_path are set-once identity and stay put.
      {
        // Derive `plan_verb`/`plan_ref` from the SessionStart spawn name via
        // the same pure parser the v9→v10 migration backfill uses (single
        // source of truth). NULL on every spawn name that doesn't match the
        // strict `{plan|work|close|approve}::<ref>` whitelist — re-fold
        // deterministic.
        //
        // Set-once identity on RESUME: the ON CONFLICT branch leaves both
        // columns untouched. A duplicate SessionStart on a non-`{plan,work,
        // close,approve}::` spawn (or a switch from one verb to another
        // mid-session) never overwrites the seeded pair — mirrors the
        // title/title_source precedence rule, where a resume never re-seeds
        // the priority-1 'spawn' name over a higher source.
        const { plan_verb, plan_ref } = planVerbRefFromSpawnName(
          event.spawn_name,
        );
        // Schema v40 (fn-652): seed `name_history` with `["<spawn_name>"]`
        // on the spawn INSERT when `spawn_name != null`, else `'[]'` (the
        // schema default, also written explicitly for symmetry). RESUME is
        // a no-touch: the ON CONFLICT branch must leave `name_history`
        // alone — mirrors `title` / `title_source` (precedence-owned, a
        // resume never re-seeds the priority-1 spawn name over a higher
        // source). The title precedence-write block below the switch is
        // the only path that appends a new entry; the spawn seed is set-
        // once identity per session, so re-fold determinism holds.
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
             last_input_request_at = NULL,
             last_input_request_kind = NULL,
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
            // Schema v36: derive the profile name from the same helper the
            // `profiles` seed below uses. NULL config_dir → NULL profile_name
            // (NOT the `''`-collapse profiles applies) so the column tracks
            // `jobs.config_dir`'s own nullability under the resume COALESCE.
            event.config_dir == null ? null : projectBasename(event.config_dir),
            // Schema v40 (fn-652): see comment above. ON CONFLICT leaves
            // jobs.name_history untouched (no `name_history = ...` clause
            // in the UPDATE SET), so RESUME never re-seeds.
            spawnNameHistory,
          ],
        );
        // Schema v33 (fn-639): seed a visible `profiles` row for this
        // session's `config_dir` bucket. `INSERT OR IGNORE` so a resume into
        // a profile that already has a row is a no-op, and a duplicate
        // SessionStart on the same profile never re-stamps `last_event_id`
        // (the first seed wins). `COALESCE(?,'')` collapses a NULL
        // `events.config_dir` (default `~/.claude` — no `CLAUDE_CONFIG_DIR`
        // env) into the empty-string sentinel, matching the rate-limit
        // fan-out's identical expression so a NULL-config session's later
        // rate limit lands on the exact `''` row it seeded here.
        // `last_rate_limit_*` stay NULL — populated only by the rate-limit
        // arm below. Pure function of the event (no `Date.now`/env/OS state).
        //
        // Schema v35 (fn-642): also seed `profile_name` from the SAME
        // `projectBasename` derivation the v34→v35 migrate backfill uses
        // (byte-identical so a re-fold post-migrate converges). The `''`
        // sentinel's basename is `""`; the `profile_name != ''` guard on
        // both sides of the usage<->profiles join keeps it from cross-
        // contaminating a `''`-id usage row. `INSERT OR IGNORE` means a
        // pre-existing row keeps the first seed's `profile_name`, but the
        // helper is a pure function of `config_dir` so a duplicate
        // SessionStart on the same `config_dir` would derive the same value
        // anyway — re-fold determinism holds.
        db.run(
          `INSERT OR IGNORE INTO profiles (config_dir, profile_name, last_event_id, updated_at) VALUES (COALESCE(?, ''), ?, ?, ?)`,
          [event.config_dir, projectBasename(event.config_dir), event.id, ts],
        );
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
      // terminal guard). This is also a re-open path: a session can resume
      // straight into a prompt with no SessionStart hook, and a spurious
      // mid-session SessionEnd(reason=other) is sometimes followed immediately by
      // a prompt in the SAME live process. Either way the job must leave 'ended'
      // or 'killed' — both are revivable on a fresh prompt (the producer can
      // probe the live new process). The un-end lives in the fold, not a
      // liveness overlay — see the header.
      //
      // Pid is COALESCE-refreshed so a re-open updates to the live process's pid
      // (mirrors SessionStart's resume path). UserPromptSubmit events never
      // carry start_time (only SessionStart scrapes it), so we cannot refresh
      // it here.
      //
      // BUT: when the event's pid differs from the persisted pid, the resume
      // landed in a DIFFERENT live process, and the persisted start_time now
      // describes a dead/recycled process. Leaving it stuck breaks the
      // recycle-safe identity invariant — `(pid, start_time)` must always
      // describe the same live process — and the next boot's seed sweep would
      // see `pid alive + osStart != stored start_time`, fire a synthetic Killed
      // payload carrying the STORED stale start_time, and the reducer's strict
      // (pid, start_time) match would fold the live row to 'killed' (the bug
      // chain documented in fn-579-fix-stale-start-time-on-ups-resume.1).
      //
      // Clearing start_time to NULL on pid change activates the legacy-loose
      // branches in both producers (`seed-sweep.ts`: "pid alive + no stored
      // start_time → cannot prove recycle. Leave alone.") and the reducer's
      // own Killed fold (loose pid-only match). The next SessionStart will
      // refresh start_time to the new live value. When the event omits pid
      // (legacy hook) or pid matches, behavior is unchanged.
      //
      // The CASE is a pure function of (event.pid, row.pid) — re-fold safe.
      // Also clears `last_api_error_at` AND `last_api_error_kind` to NULL
      // together on every revival: a fresh prompt means the human picked
      // up after the quota reset / re-auth / retry, so the "this stoppage
      // was api-error-caused" annotation no longer applies. The clear is
      // unconditional (cheap, no-op when already NULL), pure (a from-
      // scratch re-fold sees the same write), and paired (both columns
      // move together — no code path may clear one without the other,
      // see {@link import("./types").JobLinkEntry}'s paired-NULL
      // invariant).
      //
      // Schema v25 extends the same paired-clear to
      // `last_input_request_at` + `last_input_request_kind`: a fresh
      // prompt means the human answered the pending `AskUserQuestion`
      // (or whatever interactive built-in tool was blocking), so the
      // "this stoppage was input-request-caused" annotation no longer
      // applies either. Unconditional (cheap, no-op when already NULL)
      // and paired with its sibling column.
      db.run(
        `UPDATE jobs SET state = 'working',
                         last_api_error_at = NULL,
                         last_api_error_kind = NULL,
                         last_input_request_at = NULL,
                         last_input_request_kind = NULL,
                         pid = COALESCE(?, pid),
                         start_time = CASE
                           WHEN ? IS NOT NULL AND ? != pid THEN NULL
                           ELSE start_time
                         END,
                         last_event_id = ?, updated_at = ?
           WHERE job_id = ?`,
        [event.pid, event.pid, event.pid, event.id, ts, jobId],
      );
      syncIfPlanRef(db, jobId, event.id, ts);
      break;
    }

    case "Stop": {
      // Keeps the terminal guard: a stray Stop landing on a still-terminal job
      // (no intervening re-open) must not resurrect it. The guard now covers
      // BOTH terminal states — 'ended' (from SessionEnd) and 'killed' (from a
      // synthetic Killed event). After a real re-open (SessionStart or
      // UserPromptSubmit) the row is no longer terminal, so a normal post-resume
      // Stop applies here as usual.
      //
      // Sub-agent guard: when Claude Code's parent agent dispatches a Task
      // tool, it emits Stop and yields to the sub-agent (sub-agent events
      // share the parent session_id; the parent's hook stream genuinely sees
      // a Stop). Conceptually the session is still working until the sub-
      // agent returns AND any post-sub follow-up emits a subsequent real Stop.
      // Honoring the mid-yield Stop drops state to 'stopped' while a sub is
      // running, which clears readiness predicate 5 prematurely — predicate 7
      // then fires `job-pending` the moment SubagentStop lands (if approval is
      // already pending), and autopilot's approval-notify dup-fires when the
      // parent resumes and Stops a second time. Skip the state flip while any
      // subagent_invocations row for this job is still status='running'.
      //
      // Same-name collapse: a `running` row is ignored by the guard if a
      // LATER same-`(job_id, subagent_type)` row exists in the projection.
      // Operating assumption: Claude Code does not spawn parallel same-name
      // sub-agents in one parent session, so "same name with a higher
      // turn_seq" means "the older row is an orphan whose `SubagentStop`
      // never landed" — exactly the fn-593.3 case. The guard then matches
      // the client-side `collapseSubagentsByName` rule, so server `jobs.state`
      // and client predicate 6 unwedge together. `subagent_type IS …` is
      // null-safe equality (matches null-to-null but not null-to-non-null),
      // mirroring the client key derivation that treats `subagent_type ??
      // ""` as the group key.
      //
      // Re-fold determinism: subagent_invocations reflects every SubagentStart
      // / SubagentStop folded with id < event.id (sequential fold), so the
      // running-check is a pure function of the event log up to this point.
      //
      // Recency bound (fn-638.1): anchor the staleness check on the SURVIVING
      // running row (max `turn_seq` per same-name group) — measured against
      // the newest running `ts`, never a demoted orphan. Return that `ts` from
      // the same query so the JS-side comparison reads the exact row the
      // collapse rule already chose to honor. ORDER BY ts DESC ensures
      // multiple concurrent in-flight sub-agents pick the newest start (a
      // single slow-but-real sub keeps the guard armed; we only release once
      // even the freshest survivor crosses the bound).
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
        // Edge cases (CLAUDE.md "never throw inside the fold"):
        // - NULL `ts` on a legacy/malformed running row → conservatively
        //   treat as not-stuck (keep swallowing) to avoid a premature
        //   release on a row whose age we cannot honestly compute.
        // - Negative / zero `age` (clock skew, same-second events,
        //   re-fold replays) → keep swallowing; the bound only releases
        //   once `age` STRICTLY exceeds `MAX_STOP_YIELD_GAP_SEC`.
        const rowTs = subRunning.ts;
        if (rowTs == null || rowTs <= 0) {
          break;
        }
        const age = event.ts - rowTs;
        if (age <= MAX_STOP_YIELD_GAP_SEC) {
          break;
        }
        // Fall through: the newest surviving running sub-agent is older
        // than the bound — treat as an orphan whose `SubagentStop` never
        // landed, release the Stop gate. The UPDATE below writes
        // `state='stopped'` and the standard `syncIfPlanRef` fan-out runs
        // (which in turn re-stamps every linked epic via
        // `syncJobLinksOnJobWrite`, so the state flip propagates to the
        // `epics.job_links` projection symmetrically with the normal
        // mid-sub-completed Stop path).
      }
      const res = db.run(
        `UPDATE jobs SET state = 'stopped', last_event_id = ?, updated_at = ?
           WHERE job_id = ? AND state NOT IN ('${ENDED}','${KILLED}')`,
        [event.id, ts, jobId],
      );
      // Sync only when the UPDATE actually wrote — a guarded no-op on a
      // still-terminal row must NOT re-fan the embedded entry (it would
      // re-write a stale-but-unchanged element with the new event_id).
      if (res.changes > 0) {
        syncIfPlanRef(db, jobId, event.id, ts);
      }
      break;
    }

    case "SessionEnd": {
      // Lands on any non-terminal row. The terminal guard keeps it idempotent
      // on 'ended' AND prevents a late SessionEnd from clobbering a 'killed'
      // row (the killed signal is more informative because it carries the
      // proven-dead `(pid, start_time)` evidence; an ended-after-killed write
      // would mask it). Matches zero rows for a terminal event with no prior
      // SessionStart — a correct no-op.
      const res = db.run(
        `UPDATE jobs SET state = 'ended', last_event_id = ?, updated_at = ?
           WHERE job_id = ? AND state NOT IN ('${ENDED}','${KILLED}')`,
        [event.id, ts, jobId],
      );
      if (res.changes > 0) {
        sweepRunningSubagentsToUnknown(db, jobId, event.id, ts);
        syncIfPlanRef(db, jobId, event.id, ts);
      }
      break;
    }

    case "Killed":
      // Synthetic event emitted by the boot seed sweep + the live exit-watcher
      // when a `(pid, start_time)` pair is proven dead (the bare pid is unsafe
      // on macOS where recycle is common). The producer pre-computes the
      // `(pid, start_time)` payload — the reducer NEVER re-probes liveness
      // here (a re-probe inside the fold would break re-fold determinism).
      //
      // Match rule (Q7): fold to 'killed' iff the persisted (pid, start_time)
      // matches the event's payload, OR the persisted start_time is NULL
      // (legacy row — loose match on pid alone). On mismatch / missing pid /
      // missing target row, short-circuit as a stale event — the cursor still
      // advances (the surrounding applyEvent commits the update), no row write,
      // no throw. NEVER throw inside the open BEGIN IMMEDIATE transaction (a
      // throw rolls back the cursor and wedges the reducer).
      {
        const payload = extractKilledPayload(event);
        if (payload == null) {
          break; // malformed/missing payload — safe no-op.
        }
        const row = db
          .query("SELECT pid, start_time FROM jobs WHERE job_id = ?")
          .get(jobId) as {
          pid: number | null;
          start_time: string | null;
        } | null;
        if (row == null) {
          break; // no jobs row for this session — safe no-op.
        }
        // Strict match when the row has a stored start_time; loose pid-only
        // match when start_time is NULL (legacy / pre-schema-v9 row).
        const pidMatches = row.pid != null && row.pid === payload.pid;
        const startMatches =
          row.start_time == null || row.start_time === payload.start_time;
        if (!pidMatches || !startMatches) {
          break; // stale/recycled — safe no-op.
        }
        db.run(
          `UPDATE jobs SET state = 'killed', last_event_id = ?, updated_at = ?
             WHERE job_id = ?`,
          [event.id, ts, jobId],
        );
        // Sweep fires ONLY on the proven write path, mirroring sync. The
        // earlier `break` arms (malformed payload, missing row, stale
        // mismatch) MUST NOT sweep — no lifecycle write happened, so a
        // sweep would be a spurious mid-life mutation of running subagent
        // rows whose parent session is still healthy.
        sweepRunningSubagentsToUnknown(db, jobId, event.id, ts);
        // Sync fires ONLY here, on the proven write path. The earlier
        // `break` arms (malformed payload, missing row, stale mismatch) MUST
        // NOT sync — no write happened, the embedded entry would otherwise
        // re-write with a stale-but-unchanged element keyed to this event id.
        syncIfPlanRef(db, jobId, event.id, ts);
      }
      break;

    case "RateLimited":
    case "ApiError": {
      // Dual-case fold (schema v24). Both labels route through the same
      // handler so the historical event log re-folds byte-deterministically:
      //
      //   - `RateLimited` is the legacy synthetic event_type (forever — the
      //     event log is immutable per CLAUDE.md "hook/main is sole writer"
      //     + "append-only"). Forces `kind = "rate_limit"` so the projection
      //     reads identically to a fresh-mint `ApiError(kind="rate_limit")`.
      //   - `ApiError` is the schema-v24 mint — main writes it from the
      //     transcript-worker `api-error` message (task .2) carrying the
      //     openclaude `SDKAssistantMessageError.type`. The event's
      //     `data.kind` routes through `validateApiErrorKind` (anything not
      //     in the canonical allow-list — including the SDK's own
      //     `"unknown"` — folds to `"unknown"`).
      //
      // Both arms write `last_api_error_at` + `last_api_error_kind`
      // together in a single compound UPDATE — paired-NULL invariant
      // (CLAUDE.md "schema defaults match zero-event projection"); no code
      // path may stamp one without the other. The board pill pair is
      // byte-identical under a from-scratch re-fold.
      //
      // Same terminal guard as Stop: a stray ApiError on an already-
      // terminal row must NOT resurrect it (and must not stamp the
      // annotation onto a row whose lifecycle is already `ended` / `killed`
      // for unrelated reasons — the api-error signal is by definition
      // mid-life). The terminal guard is preserved verbatim from the
      // pre-v24 `RateLimited` arm.
      const kind: ApiErrorKind =
        event.hook_event === "RateLimited"
          ? "rate_limit"
          : extractApiErrorKind(event);
      // Sub-agent guard (mirrors Stop): suppress the state flip while any
      // subagent_invocations row for this job is status='running'. The
      // parent isn't actively making API calls while it waits on a sub-
      // agent, but an api-error annotation may still land in that window
      // (synthetic minting from the transcript-worker is independent of
      // sub-agent lifecycle). Stamp the (last_api_error_at, last_api_error_kind)
      // pair unconditionally — that's the honest annotation reading — while
      // keeping state at its pre-event value via CASE. Pure function of the
      // event log up to event.id (sequential fold of SubagentStart/Stop).
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
      // Sync only when the UPDATE actually wrote — a guarded no-op on a
      // still-terminal row must NOT re-fan the embedded entry (it would
      // re-write a stale-but-unchanged element with the new event_id).
      if (res.changes > 0) {
        syncIfPlanRef(db, jobId, event.id, ts);
      }
      // Schema v33 (fn-639): profile-level rate-limit fan-out. Gated on
      // the already-resolved `kind === "rate_limit"` local above — covers
      // both the legacy `RateLimited` event_type (forced to "rate_limit")
      // and the v24 `ApiError` mint whose `extractApiErrorKind` returned
      // "rate_limit". Other `ApiErrorKind` values (`authentication_failed`,
      // `server_error`, etc.) are out of scope per fn-639 — only `rate_limit`
      // stamps the profile row.
      //
      // Read the session's `config_dir` from `jobs` in-transaction (the
      // `syncIfPlanRef` read-then-write precedent at ~:2714-2738). Null-
      // guarded: if the jobs row is absent (a rate_limit landing before
      // SessionStart on a brand-new session — unusual but legal), skip the
      // fan-out; the cursor still advances. The UPSERT runs INDEPENDENTLY
      // of the jobs UPDATE guard above — a rate_limit on a terminal jobs
      // row still attributes to the profile (the profile-level signal is
      // honest regardless of the per-session terminal guard).
      //
      // UPSERT shape: last-write-wins on `last_rate_limit_at`. Events fold
      // in id order, so a later event always carries a strictly-greater
      // (ts, id) pair — no `max()` guard needed. `COALESCE(?,'')` matches
      // the SessionStart seed's identical expression so a NULL-config
      // session's rate limit lands on the exact `''` row it seeded.
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
          // Schema v35 (fn-642): forward fan-out — colocate the rate-limit
          // annotation on the matching `usage` row so a single `usage`
          // subscribe carries both quota numbers and rate-limit state. The
          // join key is `usage.id = profiles.profile_name` (the on-disk
          // profile-directory basename agentuse and keeper agreed on).
          //
          // Pure UPDATE — never UPSERT: a rate_limit must not mint a
          // phantom `usage` row for a profile agentuse isn't tracking
          // (the `usage` set is the canonical "tracked profiles" surface
          // and is the responsibility of the usage-worker alone). If no
          // matching `usage` row exists, the UPDATE matches zero rows
          // and we move on; a later `UsageSnapshot` for the same id will
          // pull the rate-limit annotation back via the reverse fan-out
          // (the `projectUsageRow` post-UPSERT SELECT).
          //
          // Schema v42 (fn-662) mapping: `usageIdForProfileName` translates
          // the `''` default-profile sentinel (default `~/.claude`, basename
          // `""`) to agentuse's `"default"` usage id at the join boundary,
          // so a default-account rate limit colocates on `usage.default`
          // instead of stranding on the unjoinable `''` profile row. Every
          // other profile name passes through unchanged — a named profile
          // still binds to `WHERE id = <profile_name>`. A pathological
          // literal `usage.id=''` is NOT cross-contaminated: an empty
          // `event.session_id` is rejected by `projectUsageRow`'s early
          // empty-string guard up the call stack, so no `usage.id=''` row
          // ever exists in steady state — and the mapping is one-way (`''`
          // forward → `'default'`), never `''` → `''`.
          //
          // The `last_event_id` bump is load-bearing — the descriptor's
          // version column drives the wire diff; without the bump the
          // subscribe wouldn't fire and the UI would stay stale.
          //
          // Pure function of the fold inputs (`event.ts`, `event.id`,
          // `jobId`, in-transaction `jobs.config_dir`) — no
          // `Date.now`/env/OS reads.
          //
          // **Schema v41 (fn-651) carve-out (symmetric to v35).** This
          // UPDATE writes ONLY the rate-limit columns + the descriptor
          // bookkeeping (`last_event_id`, `updated_at`); it MUST NOT
          // touch `rate_limit_lifts_at` or `last_usage_fold_at`. Those
          // columns ride the percentage path (`projectUsageRow` — the
          // UsageSnapshot fold), so a rate-limit fold cannot clobber a
          // lift time or a freshness stamp the percentage path wrote.
          // Symmetric to the v35 reverse carve-out where the percentage
          // path's UPSERT excludes the rate-limit columns: each fold
          // owns the columns it can speak to honestly. Adding either
          // column to this UPDATE would break the two-paths discipline
          // and let a stale rate-limit event clobber a fresh percentage
          // fold's freshness stamp.
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
      // Synthetic event (schema v25) minted by main from a transcript-worker
      // `input-request` message — Claude Code used a built-in interactive
      // tool that fires no hook of its own (initially `AskUserQuestion`).
      // The session is blocked on a human answer that has not yet arrived,
      // so the lifecycle column flips to `'stopped'` AND the pair
      // `(last_input_request_at, last_input_request_kind)` stamps to the
      // event ts + the matched {@link import("./types").InputRequestKind}.
      //
      // Clone of the v24 `RateLimited`/`ApiError` arm in structural shape:
      // one compound UPDATE that writes the lifecycle column + the
      // annotation pair together (paired-NULL invariant — CLAUDE.md
      // "schema defaults match zero-event projection"; no code path may
      // stamp one column of the pair without the other). Same terminal
      // guard as Stop / ApiError: a stray InputRequest on an already-
      // terminal row must NOT resurrect it (and must not stamp the
      // annotation onto a row whose lifecycle is already `ended` /
      // `killed` for unrelated reasons — the input-request signal is by
      // definition mid-life).
      //
      // `extractInputRequestKind` reads `data.kind` and routes through
      // {@link validateInputRequestKind} (anything not in the canonical
      // allow-list folds to `"ask_user_question"` — the single-member
      // union's only value, mirroring fn-616's `ApiError` "unknown"
      // fallback shape but without a reserved `"unknown"` member, since
      // the transcript matcher only mints messages for kinds it has
      // explicitly mapped).
      //
      // **Why a synthetic event, not a hook event?** `AskUserQuestion`
      // fires no Pre/PostToolUse hook of its own (verified empirically
      // against two real AskUserQuestion sessions). The transcript-worker
      // matcher (lands in task .2) is the only place we can detect the
      // tool use; main mints the `InputRequest` synthetic carrying the
      // session id + matched kind, and this arm folds it identically to
      // the api-error arm shape. The clear paths (`UserPromptSubmit` /
      // `SessionStart` unconditional; `PreToolUse` / `PostToolUse` gated)
      // run from the regular hook events — see those arms for the
      // "closest answered signal" rationale.
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
      // Hot-path clear (~50+ fires per turn). `AskUserQuestion` fires no
      // Pre/PostToolUse hook of its own, so the closest "answered" signal
      // is the next tool the agent uses — once any other tool fires, the
      // human has answered the question and the session is no longer
      // blocked, so we zero the input-request pair.
      //
      // Gated on `last_input_request_at IS NOT NULL` so the unconditional
      // `UPDATE jobs SET ... WHERE job_id = ?` only fires when there is
      // actually something to clear — without the gate, every tool call
      // in every session would no-op-write the pair to NULL (already
      // NULL), churning `last_event_id` / `updated_at` and re-fanning
      // every embedded array. The gate keeps the cost at zero for the
      // overwhelming majority of tool calls (no prior input-request) and
      // pays only when the pair actually needs clearing.
      //
      // Paired clear (CLAUDE.md "schema defaults match zero-event
      // projection"): both columns NULL together — no code path may
      // clear one without the other.
      //
      // Sync gated on the UPDATE actually firing (changes > 0): a no-op
      // clear must NOT re-fan the embedded entry. The gate is a SELECT-
      // free predicate that re-runs at WHERE time, so the UPDATE's
      // `changes > 0` is the authoritative signal.
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
      break;
    }

    default:
      // PostToolUseFailure, Notification, and any unknown forward-compat
      // event: no lifecycle write. Cursor still advances upstream. (No
      // terminal guard needed — these branches never write the state
      // column.) The `Pre/PostToolUse[Failure]` rows ALSO feed
      // `projectSubagentInvocationsRow` (via the per-event dispatch in
      // `applyEvent`); the no-op here is specifically the *jobs*
      // projection. SubagentStart / SubagentStop, formerly listed here
      // as no-ops, are dispatched out of `applyEvent` to
      // `projectSubagentInvocationsRow` — they still never touch `jobs`
      // (no lifecycle column writes), so the `jobs` arm stays a no-op
      // for them.
      //
      // Schema v25 lifts `PreToolUse` and `PostToolUse` out of this
      // default arm into their own gated-clear case (above) — but only
      // for the `last_input_request_*` paired clear. The post-switch
      // planctl fan-out + title precedence rule still fire for those
      // events because they live OUTSIDE the switch.
      break;
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

  // Title precedence rule: a `session_title` in the data blob folds into
  // `jobs.title`, layered on top of any lifecycle write above. The source is
  // resolved per-event by titleSourceForEvent — 'transcript' (priority 3) for a
  // synthetic TranscriptTitle event, else 'payload' (priority 2). Runs on ANY
  // event and has no `state != 'ended'` guard (no title-bearing events arrive
  // post-SessionEnd anyway). Tier 1's 'spawn' source (priority 1) is seeded on
  // the SessionStart insert above, not here; this rule generalizes the write so
  // a higher-priority source promotes the title and a lower one never clobbers
  // it.
  //
  // Re-fold determinism: the write compares the incoming `(title, source)`
  // against the PERSISTED `(title, title_source)` read in-txn, never an
  // accumulator. We write iff the incoming priority outranks the persisted one,
  // or ties it with a changed value — so a rebuild-from-scratch is identical
  // (pure function of persisted state). No row → no-op.
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
        // Schema v40 (fn-652): append the promoted title to the persisted
        // `name_history` JSON array iff it isn't already the last element
        // (dedupe-against-tail). Cap at the most-recent 20 by slicing the
        // tail. Pure function of the persisted cell + the incoming title —
        // no `Date.now`/env reads, no event-arrival ordering — so a from-
        // scratch re-fold reproduces byte-identical history. Defensive
        // parse: a malformed array folds to `[]` per the CLAUDE.md "safe
        // value on malformed payload" invariant (the column is NOT NULL
        // DEFAULT '[]' so a healthy reducer never writes anything else,
        // but the JSON.parse boundary is the right place to harden).
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
    } else if (event.hook_event === "DispatchFailed") {
      foldDispatchFailed(db, event);
    } else if (event.hook_event === "DispatchCleared") {
      foldDispatchCleared(db, event);
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

  const rows = db
    .query(
      `SELECT id, ts, session_id, pid, hook_event, event_type, tool_name,
              matcher, cwd, permission_mode, agent_id, agent_type,
              stop_hook_active, data, subagent_agent_id, spawn_name,
              start_time, slash_command, skill_name,
              planctl_op, planctl_target, planctl_epic_id, planctl_task_id,
              planctl_subject_present, tool_use_id, config_dir
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
