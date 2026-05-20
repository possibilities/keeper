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
}

/**
 * One row of the `jobs` projection. `job_id` is the Claude Code session id —
 * v1 holds the simplifying invariant of "one session per job". Defaults match
 * the zero-event projection (`mode='act'`, `state='stopped'`) so an empty
 * row inserted by `SessionStart` reads correctly before any further events
 * (`title=NULL`, `title_history=[]`).
 *
 * `title_history` is the DECODED shape at the read boundary — stored as JSON
 * TEXT in SQLite, parsed into a real array by `decodeRow` (`src/collections.ts`)
 * before it reaches a `result` / `patch` frame.
 */
export interface Job {
  job_id: string;
  created_at: number;
  cwd: string | null;
  pid: number | null;
  mode: string;
  state: string;
  last_event_id: number;
  updated_at: number;
  title: string | null;
  title_history: string[];
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
