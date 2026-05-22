/**
 * Shared types for the keeper reducer + hook.
 *
 * The events table mirrors the row written by the hook (one row per Claude
 * Code hook invocation). The reducer folds events into the `jobs` projection.
 * The `reducer_state` singleton tracks the last event id the reducer has
 * folded, so boot drain + steady-state share the same idempotent code path.
 */

/**
 * One row of the `events` table. Lifted near-verbatim from the canonical
 * hooks-tracker.py shape; id + ts are SQLite-assigned/floats.
 *
 * Field cardinality:
 * - `id` is the rowid (INTEGER PRIMARY KEY AUTOINCREMENT); monotonic per DB.
 * - `ts` is unix-epoch seconds as a REAL (matches the python reference).
 * - All optional columns are `NULL` when not provided by the hook payload.
 */
export interface Event {
  id: number;
  ts: number;
  session_id: string;
  pid: number | null;
  hook_event: string;
  event_type: string;
  tool_name: string | null;
  matcher: string | null;
  cwd: string | null;
  permission_mode: string | null;
  agent_id: string | null;
  agent_type: string | null;
  stop_hook_active: number | null;
  data: string;
  subagent_agent_id: string | null;
  /**
   * The parent claude process's `--name`/`-n` session name, scraped from its
   * argv by the hook ONLY on `SessionStart` (NULL on every other event). The
   * reducer seeds `jobs.title` from it so a row reads a non-NULL title from the
   * very first event — before the first `UserPromptSubmit` payload title.
   */
  spawn_name: string | null;
}

/**
 * One row of the `jobs` projection. `job_id` is the Claude Code session id —
 * v1 holds the simplifying invariant of "one session per job". Defaults match
 * the zero-event projection (`state='stopped'`) so an empty row inserted by
 * `SessionStart` reads correctly before any further events (`title=NULL`).
 *
 * `title` is the live session title, kept up to date by the reducer's title
 * rule. `title_source` records its provenance and drives precedence: NULL =
 * priority 0 (the zero-event reading), `'spawn'` = 1 (seeded at SessionStart
 * from the parent argv `--name`), `'payload'` = 2 (the `UserPromptSubmit`
 * `session_title`), `'transcript'` = 3 (the live transcript `custom-title`,
 * folded from a synthetic `TranscriptTitle` event). The reducer writes a new
 * title iff the incoming source has a higher priority than the persisted one,
 * or the same priority with a changed value — so a lower-priority source never
 * clobbers a higher one, and the fold stays a pure function of persisted state
 * (re-fold determinism).
 *
 * `transcript_path` is the absolute path to the session's transcript JSONL,
 * seeded once at SessionStart from the event payload (NULL when absent). It is
 * display/debug only — never sorted or filtered.
 */
export interface Job {
  job_id: string;
  created_at: number;
  cwd: string | null;
  pid: number | null;
  state: string;
  last_event_id: number;
  updated_at: number;
  title: string | null;
  title_source: string | null;
  transcript_path: string | null;
}

/**
 * Singleton reducer cursor. Exactly one row exists with `id = 1`. The reducer
 * advances `last_event_id` in the SAME transaction that folds each event into
 * `jobs`, giving exactly-once-per-event semantics under crash + boot drain.
 */
export interface ReducerState {
  id: 1;
  last_event_id: number;
  updated_at: number;
}

/**
 * One row of the `epics` projection. `epic_id` is the planctl epic id (pk). The
 * reducer folds synthetic `EpicSnapshot` events (full state-on-disk snapshots
 * posted by the plan worker, written by main) into this table via idempotent
 * upsert. Columns are nullable matching the zero-event reading; `updated_at`
 * defaults to 0 in-schema. `project_dir` is an untrusted foreign-process JSON
 * field — stored opaque, never used to drive filesystem reads or interpolated
 * into SQL.
 *
 * As of schema v7 each epic embeds its tasks as the `tasks` array (the
 * standalone `tasks` table was dropped). On the wire the `tasks` column is
 * stored as JSON TEXT and decoded to a real `Task[]` at the read boundary
 * (`decodeRow`); a task edit folds into this array and bumps the epic's
 * `last_event_id`, so it surfaces as a `patch` on the parent epic row.
 */
export interface Epic {
  epic_id: string;
  epic_number: number | null;
  title: string | null;
  project_dir: string | null;
  status: string | null;
  last_event_id: number | null;
  updated_at: number;
  /**
   * Epic-level dependencies: the planctl `depends_on_epics` ids (other epics
   * this one depends on). Stored as a JSON-TEXT array column and decoded to a
   * real array at the read boundary (`decodeRow`).
   */
  depends_on_epics: string[];
  tasks: Task[];
}

/**
 * One task — the element shape of {@link Epic.tasks}. `task_id` is the planctl
 * task id; `epic_id` links it to its parent epic. As of schema v7 a task is no
 * longer a standalone projection row: the reducer folds each synthetic
 * `TaskSnapshot` into its parent epic's embedded `tasks` array (deterministic
 * `(task_number, task_id)` sort). `target_repo` is an untrusted foreign-process
 * JSON field — stored opaque, never used to drive filesystem reads or
 * interpolated into SQL.
 */
export interface Task {
  task_id: string;
  epic_id: string | null;
  task_number: number | null;
  title: string | null;
  target_repo: string | null;
  status: string | null;
  /**
   * Task-level dependencies: the planctl `depends_on` task ids (other tasks this
   * one depends on). Lives inside the parent epic's embedded `tasks` JSON array
   * (no schema column of its own).
   */
  depends_on: string[];
}
