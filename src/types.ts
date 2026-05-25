/**
 * Shared types for the keeper reducer + hook.
 *
 * The events table mirrors the row written by the hook (one row per Claude
 * Code hook invocation). The reducer folds events into the `jobs` projection.
 * The `reducer_state` singleton tracks the last event id the reducer has
 * folded, so boot drain + steady-state share the same idempotent code path.
 */

/**
 * One entry in {@link Job.epic_links} — a per-job cross-reference to an epic
 * the job's planctl footprint touched inside a `/plan:plan` window. `kind`
 * partitions the cross-reference: `"creator"` for a `planctl epic-create
 * fn-N-foo` mutation; `"refiner"` for every other epic-touching mutation
 * inside a window (subject to per-window creator suppression — see
 * `src/plan-classifier.ts`).
 *
 * Mirrors `EpicLink` in `src/plan-classifier.ts` field-for-field; kept here
 * so the projection types are self-describing without importing the
 * classifier module.
 */
export interface Link {
  kind: "creator" | "refiner";
  target: string;
}

/**
 * One entry in {@link Epic.job_links} — the symmetric per-epic view of
 * {@link Link}. `kind` carries the same vocabulary; `job_id` identifies the
 * session whose planctl footprint touched this epic inside one of its
 * `/plan:plan` windows.
 *
 * Mirrors `JobLink` in `src/plan-classifier.ts` field-for-field.
 */
export interface JobLinkEntry {
  kind: "creator" | "refiner";
  job_id: string;
}

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
  /**
   * Opaque platform-tagged process start instant for the (pid, start_time)
   * recycle-safe identity used by the boot seed sweep and the live exit-watcher.
   * Captured by the hook ONLY on `SessionStart` (NULL on every other event and
   * on every synthetic). Format is platform-tagged (macOS `lstart` string, Linux
   * `/proc/<pid>/stat` field-22 jiffies) — never parsed, only compared for
   * equality against a re-read at sweep time.
   */
  start_time: string | null;
  /**
   * Leading slash command pulled out of a `UserPromptSubmit`'s `data.prompt`
   * by the pure {@link import("./derivers").slashCommandFromPrompt} parser
   * (regex anchored at start-of-string, `/lowercase` then `[\w:-]` body —
   * see `src/derivers.ts`). Captured only on UserPromptSubmit; NULL on
   * every other event and on prompts that don't start with a lowercase-led
   * slash token (file paths like `/Users/foo`, free-text prompts, non-string
   * payloads). Indexed via a partial index `WHERE slash_command IS NOT NULL`
   * so the sparse column scans cheaply.
   */
  slash_command: string | null;
  /**
   * Canonical skill name pulled out of a Pre/PostToolUse-on-Skill event's
   * `data.tool_input.skill` by {@link import("./derivers").extractSkillName}.
   * Gated by `hook_event ∈ {PreToolUse, PostToolUse} && tool_name === 'Skill'`;
   * NULL on every other row. Lets consumers index Skill invocations (e.g.
   * `WHERE skill_name LIKE 'plan:%'`) without JSON-scanning `data`.
   */
  skill_name: string | null;
  /**
   * Planctl-CLI verb extracted from a `PreToolUse:Bash` event's
   * `data.tool_input.command` by
   * {@link import("./derivers").extractPlanctlInvocation}. NULL on every row
   * whose command does not parse as `planctl <verb> [target]` (the hook stamps
   * NULL on misses so the partial-index `WHERE planctl_op IS NOT NULL`
   * predicate stays selective). Examples: `epic-create`, `task-set-title`,
   * `done`, `cat`.
   */
  planctl_op: string | null;
  /**
   * Raw planctl target argument as it appeared on the command line — typically
   * an epic id (`fn-575-foo`) or task id (`fn-575-foo.3`), but NULL when the
   * verb takes no argument (`planctl epics`, `planctl init`) or for unparseable
   * shapes. Surrounding quotes are stripped; empty strings fold to NULL.
   */
  planctl_target: string | null;
  /**
   * Parsed-out planctl epic id (`fn-575-foo`) — the parent epic of either an
   * epic-form or task-form target. NULL when `planctl_target` is NULL or did
   * not parse as a planctl ref. Mirrors jobctl's `audit._derive_ids` shape via
   * {@link import("./derivers").parsePlanRef}.
   */
  planctl_epic_id: string | null;
  /**
   * Parsed-out planctl task id (`fn-575-foo.3`) — non-NULL only when the
   * target's parsed shape is `task`. NULL on epic-form targets and on
   * unparseable / absent targets.
   */
  planctl_task_id: string | null;
  /**
   * Read-only-verb gate: stored as INTEGER (0/1) at the SQLite layer to match
   * the schema column, lifted to JS boolean via `=== 1` at the read boundary.
   * `false` for verbs in the read-only allowlist (`epics`, `tasks`, `cat`,
   * etc.); `true` for every other verb. NULL when `planctl_op` is NULL.
   * Drives creator/refiner classification: `subject_present === false`
   * mirrors jobctl's `subject is None` skip gate.
   */
  planctl_subject_present: number | null;
  /**
   * Anthropic tool_use correlator string (`toolu_...`) pulled out of every
   * event payload's `data.tool_use_id` by
   * {@link import("./derivers").extractToolUseId}. Populated on every
   * Pre/PostToolUse + PostToolUseFailure row across ALL tools (Bash, Read,
   * Edit, Agent, …) when the payload carries it; NULL on every other event
   * row and on rows whose payload omits / misshapes the field. Indexed via a
   * partial index `WHERE tool_use_id IS NOT NULL` so the sparse column scans
   * cheaply. Bridges the Pre/PostToolUse → SubagentStart/Stop join in the
   * `subagent_invocations` projection (schema v17).
   */
  tool_use_id: string | null;
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
  /**
   * Process start instant for the (pid, start_time) recycle-safe identity (see
   * `Event.start_time`). Seeded by the reducer from the `SessionStart` event's
   * `start_time` column (task 3); NULL on rows whose SessionStart pre-dated the
   * schema bump or whose hook failed to capture it. Display-only at the
   * projection layer; consumed by the boot seed sweep and the live exit-watcher
   * to disambiguate pid recycle.
   */
  start_time: string | null;
  /**
   * Spawn-derived planctl verb on the strict whitelist `{plan, work, close}`,
   * extracted from `Event.spawn_name` at SessionStart by
   * {@link import("./derivers").planVerbRefFromSpawnName}. NULL on jobs whose
   * spawn name didn't match the canonical `{verb}::<ref>` shape (no spawn name,
   * `audit::`/`develop::` prefix, malformed body, extra `::` segments). Paired
   * with {@link Job.plan_ref} — both populate together or both stay NULL. Set
   * once at SessionStart and not touched by ON CONFLICT RESUME (mirrors
   * `title`/`title_source` set-once identity).
   */
  plan_verb: string | null;
  /**
   * Spawn-derived planctl ref (epic id `fn-575-foo` or task id
   * `fn-575-foo.3`), extracted alongside {@link Job.plan_verb}. Indexed via
   * `idx_jobs_plan_ref WHERE plan_ref IS NOT NULL` for the common
   * "find /plan: jobs" query path; `plan_verb` rides without its own index
   * (cardinality 3 — the planner serves a `plan_verb=` filter through this
   * partial index plus a cheap post-seek check).
   */
  plan_ref: string | null;
  /**
   * Cross-references derived from this job's planctl-CLI invocations,
   * classified against its `/plan:plan` windows. Each entry has shape
   * `{kind: "creator" | "refiner", target: <epic_id>}` — the epic this job
   * either CREATED (a `planctl epic-create fn-N-foo` mutation inside a
   * `/plan:plan` window) or REFINED (any other epic-touching mutation inside
   * a window). Coexists with the spawn-name pair (`plan_verb` / `plan_ref`):
   * spawn name records the job's OWN planctl spawn role, while `epic_links`
   * records the cross-references the job's planctl footprint produced.
   *
   * Stored as a JSON-TEXT array column and decoded to a real array at the
   * read boundary. Sorted ASC on the `(kind, target)` tuple — total-order
   * tiebreaker is non-negotiable for byte-identical re-fold (CLAUDE.md
   * "byte-identical re-fold" invariant). The reducer's `syncPlanctlLinks`
   * helper re-derives this from scratch on every triggering event via the
   * pure `deriveEpicLinks` classifier in `src/plan-classifier.ts`.
   */
  epic_links: Link[];
  /**
   * Unix-seconds REAL stamped by the reducer's `RateLimited` arm — the
   * synthetic event main mints from a transcript-worker `rate-limited`
   * message when Claude Code writes its `isApiErrorMessage: true,
   * error: "rate_limit"` synthetic assistant turn to the transcript. The
   * lifecycle column (`state`) is concurrently flipped to `'stopped'`, so
   * the underlying state-machine reads correctly; `rate_limited_at` is the
   * separate annotation that explains *why* the session is stopped. Cleared
   * on the next `UserPromptSubmit` revival (the human picked up after the
   * quota reset) and only on that arm — Stop / SessionEnd / Killed leave
   * it intact, so the "this stoppage was rate-limit-caused" attribution
   * survives the natural lifecycle that follows the rate-limit event. NULL
   * on every job that has never been rate-limited.
   */
  rate_limited_at: number | null;
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
 * The display projection of a `jobs` row embedded inside an `epics` row's
 * `jobs` array (epic-level: verbs `plan` / `close`) or inside a task element's
 * `jobs` sub-array (task-level: verb `work`). The reducer's `syncJobIntoEpic`
 * helper builds these from the post-write `jobs` row whenever a `plan_ref` is
 * non-null. Sorted `(created_at desc, job_id asc)` — total-order tiebreaker on
 * `job_id` is non-negotiable for byte-identical re-fold (see CLAUDE.md
 * "byte-identical re-fold" invariant).
 *
 * Field set is the minimal display projection: identity + verb + lifecycle
 * state + title + the monotonic per-row version (`last_event_id`) that fires
 * the read-surface diff. NOT a full `Job` (no pid, no cwd, no start_time —
 * those stay on the `jobs` projection for consumers that want them).
 */
export interface EmbeddedJob {
  job_id: string;
  plan_verb: string;
  state: string;
  title: string | null;
  created_at: number;
  updated_at: number;
  last_event_id: number;
  /**
   * Mirrors {@link Job.rate_limited_at} so a renderer reading the embedded
   * array shows the same `[limited]` pill on the in-epic / in-task job
   * lines that the top-level jobs collection shows on its bottom list.
   * NULL on every entry that has never been rate-limited (the common case).
   */
  rate_limited_at: number | null;
}

/**
 * One row of the `subagent_invocations` peer-table projection (schema v17).
 * Folded from the `Pre/PostToolUse:Agent` + `SubagentStart/Stop` event
 * quartet by the reducer (task .3 — this task adds the schema slot and the
 * `extractToolUseId` bridge column but no reducer cases yet, so the table
 * stays empty until task .3 lands the live folds + the v16→v17 rewind
 * re-drains).
 *
 * Composite primary key `(job_id, agent_id, turn_seq)` mirrors jobctl's
 * Python reference (`apps/cli_common/cli_common/subagent_invocations.py`)
 * minus the `tokens` / `tool_use_count` fields. `turn_seq` is the per-job
 * monotone turn counter so re-entrant subagents within a session land on
 * distinct rows.
 *
 * Defaults match the zero-event projection: `status='running'` is the
 * SubagentStart-time value (a row is created when SubagentStart folds; it
 * flips to `'ok'` or `'error'` on SubagentStop). `prompt_chars` defaults to
 * 0 so a row created by SubagentStart before its matching PreToolUse:Agent
 * row reads zero — task .3 backfills it from the PreToolUse:Agent payload
 * via the `tool_use_id` bridge.
 *
 * `last_event_id` bumps on every UPDATE so the wire collection's diff
 * version semantics emit patch frames as the row transitions
 * `running → ok` / `running → failed` / `running → unknown` and
 * `duration_ms` populates.
 */
export interface SubagentInvocation {
  job_id: string;
  agent_id: string;
  turn_seq: number;
  ts: number;
  tool_use_id: string | null;
  subagent_type: string | null;
  description: string | null;
  prompt_chars: number;
  status: "running" | "ok" | "failed" | "unknown";
  duration_ms: number | null;
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
 *
 * As of schema v11 each epic also embeds its plan/close-verb jobs in the
 * `jobs` array (`EmbeddedJob[]`); work-verb jobs live inside their target
 * task element's nested `jobs` sub-array (see {@link Task.jobs}). The reducer
 * fans a `jobs` write into the correct embedded array via `syncJobIntoEpic`
 * whenever the row carries a `plan_ref`. Stored as JSON TEXT, decoded to a
 * real array at the read boundary; sorted `(created_at desc, job_id asc)`.
 */
export interface Epic {
  epic_id: string;
  epic_number: number | null;
  title: string | null;
  project_dir: string | null;
  status: string | null;
  /**
   * Planctl-native approval state. Top-level field on `.planctl/epics/<id>.json`
   * valued `"approved" | "rejected" | "pending"` (schema v13 — see the
   * fn-592-approval-as-planctl-field epic). A missing / invalid value coerces
   * to `"pending"` so a file written by old planctl rides through without
   * breaking re-fold determinism (defensive "safe value" fold per CLAUDE.md).
   * Drives the epics UI's default-filter scope; `EPICS_DESCRIPTOR` composes
   * `{ status: "open", approval: { ne: "approved" } }` so approved epics
   * drop out of the default page.
   */
  approval: "approved" | "rejected" | "pending";
  last_event_id: number | null;
  updated_at: number;
  /**
   * Epic-level dependencies: the planctl `depends_on_epics` ids (other epics
   * this one depends on). Stored as a JSON-TEXT array column and decoded to a
   * real array at the read boundary (`decodeRow`).
   */
  depends_on_epics: string[];
  tasks: Task[];
  /**
   * Epic-level embedded jobs: `jobs` rows whose `plan_ref` equals this
   * `epic_id` (verbs `plan` / `close`). Work-verb jobs live in each task
   * element's `jobs` sub-array, never here. Sorted
   * `(created_at desc, job_id asc)`.
   */
  jobs: EmbeddedJob[];
  /**
   * Symmetric per-epic view of {@link Job.epic_links}: every job whose
   * planctl-CLI footprint inside a `/plan:plan` window CREATED this epic
   * (`kind === "creator"`) or REFINED it (`kind === "refiner"`). Stored as a
   * JSON-TEXT array column and decoded to a real array at the read boundary.
   * Sorted ASC on the `(kind, job_id)` tuple — total-order tiebreaker.
   *
   * Survives an `EpicSnapshot` round-trip (the ON CONFLICT clause explicitly
   * preserves the column alongside `jobs` / `tasks`) — without this, an
   * approval RPC → file write → file-watcher → snapshot fold would wipe the
   * provenance projection.
   */
  job_links: JobLinkEntry[];
  /**
   * Planctl-native validation timestamp — top-level `last_validated_at` field
   * on `.planctl/epics/<id>.json` (schema v16). Plain ISO-8601 string when
   * present; `null` when the epic file omits the field (unvalidated) or the
   * stored value isn't a non-empty string. Display-only at the projection
   * layer; drives the board UI's `[validated]` / `[unvalidated]` pill.
   */
  last_validated_at: string | null;
}

/**
 * One row of the volatile git read projection. Rows are produced by synthetic
 * `GitSnapshot` events emitted by the git worker after polling a planctl-backed
 * git worktree with porcelain-v2 status output, and retracted by synthetic
 * `GitRootDropped` tombstone events the git worker emits when a worktree stops
 * being planctl-backed (e.g. its `.planctl/` directory was removed) and the
 * watcher is being torn down. The reducer folds only the persisted snapshot
 * payload (or the tombstone's `project_dir` pk in `session_id`); it never
 * shells out or re-reads filesystem state, so a from-scratch re-fold reproduces
 * the same observed frames — including the retraction.
 */
export interface GitStatus {
  project_dir: string;
  branch: string | null;
  head_oid: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  dirty_count: number;
  orphaned_count: number;
  dirty_files: unknown[];
  orphaned_files: unknown[];
  jobs: unknown[];
  last_event_id: number | null;
  updated_at: number;
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
  /**
   * Derived worker-phase binary (schema v19): `worker_done_at` present →
   * `"done"`, else `"open"`. Surfaces the same compressed signal the field
   * used to carry under the legacy `status` name (renamed to free up
   * `runtime_status` below for the planctl-native enum). Nullable on a shell
   * task element inserted by `syncJobIntoEpic` before any plan-snapshot fold
   * lands (matches the zero-event projection).
   */
  worker_phase: string | null;
  /**
   * Planctl-native runtime status (schema v19): the top-level `status` field
   * of `.planctl/state/tasks/<task_id>.state.json` (`"todo" | "in_progress"
   * | "done" | "blocked"`). Absent / missing state file / unrecognized value
   * folds to `"todo"` per planctl's `merge_task_state` convention (a fresh
   * clone with no `state/` tree reads every task as `todo`). Never null —
   * the planctl default is always meaningful, so the type stays a plain
   * string rather than `string | null`.
   */
  runtime_status: string;
  /**
   * Planctl-native approval state — top-level field on
   * `.planctl/tasks/<id>.<n>.json` (schema v13). Same enum + missing/invalid
   * coercion-to-`"pending"` semantics as {@link Epic.approval}. Lives inside the
   * parent epic's embedded `tasks` array element (no schema column of its own).
   */
  approval: "approved" | "rejected" | "pending";
  /**
   * Task-level dependencies: the planctl `depends_on` task ids (other tasks this
   * one depends on). Lives inside the parent epic's embedded `tasks` JSON array
   * (no schema column of its own).
   */
  depends_on: string[];
  /**
   * Task-level embedded jobs: `jobs` rows whose `plan_ref` equals this
   * `task_id` (verb `work`). Lives nested inside the parent epic's embedded
   * `tasks` array — decoded at the read boundary via the same JSON parse as
   * `tasks` itself (no separate `jsonColumns` entry; nested decode rides for
   * free). Sorted `(created_at desc, job_id asc)`.
   */
  jobs: EmbeddedJob[];
}
