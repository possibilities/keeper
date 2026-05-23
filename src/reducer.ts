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
    // The ON CONFLICT update lists ONLY scalar columns and NEVER `tasks`: an
    // epic snapshot carries no task data, and a shell row inserted by a
    // task-before-epic TaskSnapshot already holds the array. INSERT defaults
    // `tasks='[]'` (the schema default), so the first-sight epic reads an empty
    // array and a later epic snapshot can never clobber an array a shell holds.
    db.run(
      `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, depends_on_epics, last_event_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(epic_id) DO UPDATE SET
         epic_number = excluded.epic_number,
         title = excluded.title,
         project_dir = excluded.project_dir,
         status = excluded.status,
         depends_on_epics = excluded.depends_on_epics,
         last_event_id = excluded.last_event_id,
         updated_at = excluded.updated_at`,
      [
        entityId,
        snapshot.epic_number ?? null,
        snapshot.title ?? null,
        snapshot.project_dir ?? null,
        snapshot.status ?? null,
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
    // element serializes byte-identically; a missing list folds to [].
    const element = {
      task_id: entityId,
      epic_id: epicId,
      task_number: snapshot.task_number ?? null,
      title: snapshot.title ?? null,
      target_repo: snapshot.target_repo ?? null,
      status: snapshot.status ?? null,
      depends_on: snapshot.depends_on ?? [],
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
 * Apply the jobs-side projection for one event. Runs INSIDE the open
 * transaction opened by {@link applyEvent}; performs zero cursor work.
 *
 * Returns nothing — all writes go straight to `db`. The branches are
 * independent: the title update (when a `session_title` is present) is applied
 * on TOP of the lifecycle write, so e.g. a UserPromptSubmit carrying a new
 * title flips both state and title in one fold.
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
      db.run(
        `INSERT INTO jobs (job_id, created_at, cwd, pid, start_time, last_event_id, updated_at, title, title_source, transcript_path)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        ],
      );
      break;

    case "UserPromptSubmit":
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
      // (mirrors SessionStart's resume path). start_time is NOT touched here:
      // UserPromptSubmit events do not carry the platform-tagged start instant
      // (only SessionStart does), so the persisted value stays put.
      db.run(
        `UPDATE jobs SET state = 'working',
                         pid = COALESCE(?, pid),
                         last_event_id = ?, updated_at = ?
           WHERE job_id = ?`,
        [event.pid, event.id, ts, jobId],
      );
      break;

    case "Stop":
      // Keeps the terminal guard: a stray Stop landing on a still-terminal job
      // (no intervening re-open) must not resurrect it. The guard now covers
      // BOTH terminal states — 'ended' (from SessionEnd) and 'killed' (from a
      // synthetic Killed event). After a real re-open (SessionStart or
      // UserPromptSubmit) the row is no longer terminal, so a normal post-resume
      // Stop applies here as usual.
      db.run(
        `UPDATE jobs SET state = 'stopped', last_event_id = ?, updated_at = ?
           WHERE job_id = ? AND state NOT IN ('${ENDED}','${KILLED}')`,
        [event.id, ts, jobId],
      );
      break;

    case "SessionEnd":
      // Lands on any non-terminal row. The terminal guard keeps it idempotent
      // on 'ended' AND prevents a late SessionEnd from clobbering a 'killed'
      // row (the killed signal is more informative because it carries the
      // proven-dead `(pid, start_time)` evidence; an ended-after-killed write
      // would mask it). Matches zero rows for a terminal event with no prior
      // SessionStart — a correct no-op.
      db.run(
        `UPDATE jobs SET state = 'ended', last_event_id = ?, updated_at = ?
           WHERE job_id = ? AND state NOT IN ('${ENDED}','${KILLED}')`,
        [event.id, ts, jobId],
      );
      break;

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
              start_time
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
