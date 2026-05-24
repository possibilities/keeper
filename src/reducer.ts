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
 *                       |   EXCEPT when the prompt is Claude Code's
 *                       |   `<task-notification>…<status>killed</status>`
 *                       |   shutdown-housekeeping envelope — those are no-ops
 *                       |   for the lifecycle write (the title rule still
 *                       |   runs). See `isKilledTaskNotification` in
 *                       |   `src/derivers.ts` for the modest-scope rationale.
 *   Stop                | state -> 'stopped'  (skipped on 'ended' or 'killed')
 *   SessionEnd          | state -> 'ended'    (skipped on 'killed' — the kill
 *                       |   signal carries proven-dead evidence and outranks)
 *   Killed              | state -> 'killed'   (synthetic; folds iff persisted
 *                       |   (pid, start_time) matches the event payload, OR
 *                       |   the persisted start_time is NULL — legacy loose
 *                       |   match. Race-recovered mismatches are no-ops.)
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
  isKilledTaskNotification,
  parsePlanRef,
  planVerbRefFromSpawnName,
} from "./derivers";
import type { Event } from "./types";

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
  epic_id?: string | null;
  status?: string | null;
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
function projectPlanRow(db: Database, event: Event): void {
  const snapshot = extractPlanSnapshot(event);
  if (snapshot == null) {
    return;
  }
  const ts = event.ts;
  const entityId = event.session_id;

  if (event.hook_event === "EpicSnapshot") {
    // The ON CONFLICT update lists ONLY scalar columns and NEVER `tasks` /
    // `jobs`: an epic snapshot carries no task or job data, and a shell row
    // inserted by a task-before-epic TaskSnapshot or a job-before-epic
    // `syncJobIntoEpic` already holds those arrays. INSERT defaults both to
    // `'[]'` (the schema default), so the first-sight epic reads empty arrays
    // and a later epic snapshot can never clobber arrays a shell holds.
    db.run(
      `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, approval, depends_on_epics, last_event_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(epic_id) DO UPDATE SET
         epic_number = excluded.epic_number,
         title = excluded.title,
         project_dir = excluded.project_dir,
         status = excluded.status,
         approval = excluded.approval,
         depends_on_epics = excluded.depends_on_epics,
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
        event.id,
        ts,
      ],
    );
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
    const element: {
      task_id: string;
      epic_id: string;
      task_number: number | null;
      title: string | null;
      target_repo: string | null;
      status: string | null;
      approval: "approved" | "rejected" | "pending";
      depends_on: string[];
      jobs: unknown[];
    } = {
      task_id: entityId,
      epic_id: epicId,
      task_number: snapshot.task_number ?? null,
      title: snapshot.title ?? null,
      target_repo: snapshot.target_repo ?? null,
      status: snapshot.status ?? null,
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
    // Idempotent: a missing epic matches zero rows — a correct no-op.
    db.run("DELETE FROM epics WHERE epic_id = ?", [entityId]);
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
}

/**
 * The shape of the post-write `jobs` row {@link syncJobIntoEpic} reads back to
 * build the embedded element. Mirrors the relevant subset of {@link import("./types").Job}.
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
  // scalar columns to NULL.
  interface TaskElement {
    task_id: string;
    epic_id: string | null;
    task_number: number | null;
    title: string | null;
    target_repo: string | null;
    status: string | null;
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

  const newTaskElement: TaskElement =
    oldTask != null
      ? { ...oldTask, jobs: nextTaskJobs }
      : {
          task_id: parsed.task_id,
          epic_id: parsed.epic_id,
          task_number: null,
          title: null,
          target_repo: null,
          status: null,
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
 * Read the post-write `jobs` row and fan into the embedded epic/task arrays
 * iff `plan_ref` is non-null. The SELECT lives here (not at each call site)
 * so the fan-out reads the LATEST state-machine state — e.g. a SessionEnd
 * handler's UPDATE flips `state` to `ended` first, then this SELECT picks
 * up the new state and the embedded entry's `state` updates in lockstep.
 *
 * Runs INSIDE the open transaction opened by {@link applyEvent}. The caller
 * MUST gate on "an UPDATE/INSERT actually wrote" before invoking — the
 * Killed-mismatch path (no write happened) must NOT fire sync. See the
 * per-call-site comments in {@link projectJobsRow}.
 */
function syncIfPlanRef(
  db: Database,
  jobId: string,
  eventId: number,
  ts: number,
): void {
  const row = db
    .query(
      "SELECT job_id, plan_verb, plan_ref, state, title, created_at, updated_at, last_event_id FROM jobs WHERE job_id = ?",
    )
    .get(jobId) as JobsRowForSync | null;
  if (row == null || row.plan_ref == null) {
    return;
  }
  syncJobIntoEpic(db, row, eventId, ts);
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
        // strict `{plan|work|close}::<ref>` whitelist — re-fold deterministic.
        //
        // Set-once identity on RESUME: the ON CONFLICT branch leaves both
        // columns untouched. A duplicate SessionStart on a non-`{plan,work,
        // close}::` spawn (or a switch from one verb to another mid-session)
        // never overwrites the seeded pair — mirrors the title/title_source
        // precedence rule, where a resume never re-seeds the priority-1
        // 'spawn' name over a higher source.
        const { plan_verb, plan_ref } = planVerbRefFromSpawnName(
          event.spawn_name,
        );
        db.run(
          `INSERT INTO jobs (job_id, created_at, cwd, pid, start_time, last_event_id, updated_at, title, title_source, transcript_path, plan_verb, plan_ref)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(job_id) DO UPDATE SET
             pid = COALESCE(excluded.pid, jobs.pid),
             start_time = COALESCE(excluded.start_time, jobs.start_time),
             state = CASE WHEN jobs.state IN ('${ENDED}','${KILLED}') THEN 'stopped' ELSE jobs.state END,
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
          ],
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
      db.run(
        `UPDATE jobs SET state = 'working',
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
        // Sync fires ONLY here, on the proven write path. The earlier
        // `break` arms (malformed payload, missing row, stale mismatch) MUST
        // NOT sync — no write happened, the embedded entry would otherwise
        // re-write with a stale-but-unchanged element keyed to this event id.
        syncIfPlanRef(db, jobId, event.id, ts);
      }
      break;

    default:
      // PreToolUse, PostToolUse, PostToolUseFailure, Notification,
      // SubagentStart, SubagentStop, and any unknown forward-compat event:
      // no lifecycle write. Cursor still advances upstream. (No terminal guard
      // needed — these branches never write the state column.)
      break;
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
      .query("SELECT title, title_source FROM jobs WHERE job_id = ?")
      .get(jobId) as {
      title: string | null;
      title_source: string | null;
    } | null;
    if (row != null) {
      const pp = sourcePriority(row.title_source);
      if (p > pp || (p === pp && row.title !== title)) {
        db.run(
          "UPDATE jobs SET title = ?, title_source = ?, last_event_id = ?, updated_at = ? WHERE job_id = ?",
          [title, source, event.id, ts, jobId],
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
    } else {
      projectJobsRow(db, event);
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
export function drain(db: Database, batchSize = DEFAULT_BATCH_SIZE): number {
  const cursorRow = db
    .query("SELECT last_event_id FROM reducer_state WHERE id = 1")
    .get() as { last_event_id: number } | null;
  const cursor = cursorRow?.last_event_id ?? 0;

  const rows = db
    .query(
      `SELECT id, ts, session_id, pid, hook_event, event_type, tool_name,
              matcher, cwd, permission_mode, agent_id, agent_type,
              stop_hook_active, data, subagent_agent_id, spawn_name,
              start_time, slash_command, skill_name
         FROM events
        WHERE id > ?
        ORDER BY id ASC
        LIMIT ?`,
    )
    .all(cursor, batchSize) as Event[];

  for (const row of rows) {
    applyEvent(db, row);
  }

  return rows.length;
}
