/** Shared types for the keeper reducer + hook. */

/**
 * One entry in {@link Job.epic_links} — a per-job cross-reference to an epic
 * the job's plan footprint touched inside a `/plan:plan` window. `kind`:
 * `"creator"` for a `keeper plan epic-create` mutation; `"refiner"` for every
 * other epic-touching mutation inside a window.
 *
 * Footprint source: the deduped union of the `plan_op` stdout-scrape rows
 * AND the durable `Commit`-event trailer facts, so an edge survives a stdout
 * pipe/redirect/truncation that NULLs `events.plan_op` as long as the
 * plan commit landed. `syncPlanLinks` is the single writer of both
 * `epic_links` and `job_links`; dedup is by `(kind, target)` / `(kind,
 * job_id)`.
 */
export interface Link {
  kind: "creator" | "refiner";
  target: string;
}

/**
 * Canonical vocabulary of `isApiErrorMessage` envelope kinds folded by the
 * reducer's `ApiError` arm. The transcript matcher dispatches on `error.type`;
 * anything else folds to `"unknown"`. The historical `RateLimited` event arm
 * folds to `kind="rate_limit"` for byte-identical re-fold determinism.
 */
export type ApiErrorKind =
  | "rate_limit"
  | "authentication_failed"
  | "billing_error"
  | "server_error"
  | "invalid_request"
  | "unknown";

/**
 * Canonical `ApiErrorKind` allow-list — the dispatch-terminal kinds the
 * transcript matcher recognizes. Excludes `"unknown"`: that's the
 * fall-through bucket every unrecognized value collapses to. Shared source of
 * truth for `validateApiErrorKind` (reducer) and `matchApiError`
 * (transcript-worker); widen this set AND the {@link ApiErrorKind} union in
 * lockstep.
 */
export const API_ERROR_KINDS: ReadonlySet<ApiErrorKind> = new Set([
  "rate_limit",
  "authentication_failed",
  "billing_error",
  "server_error",
  "invalid_request",
]);

/**
 * Canonical vocabulary of `InputRequest` envelope kinds folded by the
 * reducer's `InputRequest` arm. Minted from a transcript-worker
 * `input-request` message when Claude Code uses a built-in interactive tool
 * that fires no hook of its own. No `"unknown"` fallback: the matcher only
 * fires for kinds it has explicitly mapped, so the union carries exactly the
 * matched set — widen this union AND the matcher in lockstep.
 */
export type InputRequestKind = "ask_user_question";

/**
 * Canonical vocabulary of `Notification:permission_prompt` /
 * `Notification:elicitation_dialog` kinds folded by the reducer's
 * `Notification` arm. Driven by REAL hook events whose `event_type` carries
 * the discriminator. The reducer maps the two whitelisted `event_type` values
 * one-for-one:
 *   `permission_prompt` → `"permission"`
 *   `elicitation_dialog` → `"elicitation"`
 *
 * Strict gate: any other `event_type` value does NOT stamp. No `"unknown"`
 * fallback. Widen this union AND `validatePermissionPromptKind`'s allow-list
 * in lockstep.
 */
export type PermissionPromptKind = "permission" | "elicitation";

/**
 * One entry in {@link Epic.job_links} — the symmetric per-epic view of
 * {@link Link}. `job_id` identifies the session whose plan footprint
 * touched this epic. `syncPlanLinks` is the sole writer.
 *
 * Enrichment boundary: the classifier's `JobLink` shape stays thin
 * (`{kind, job_id}`) so it remains a pure function of events; the display
 * fields below are denormalized off the linked `jobs` row at the reducer's
 * write boundary (`enrichJobLink`) so renderers and the readiness predicates
 * read off the projection with no live-jobs join. A missing `jobs` row at
 * enrichment time defaults to the re-fold-safe `{title: null, state:
 * "stopped", <all pair fields>: null}`.
 *
 * Paired-NULL invariant: `last_api_error_at` / `last_api_error_kind`,
 * `last_input_request_at` / `last_input_request_kind`, and
 * `last_permission_prompt_at` / `last_permission_prompt_kind` each move
 * together — every reducer write stamps both columns of a pair, every clear
 * clears both. No code path may write one without the other.
 */
export interface JobLinkEntry {
  kind: "creator" | "refiner";
  job_id: string;
  title: string | null;
  state: string;
  last_api_error_at: number | null;
  last_api_error_kind: string | null;
  last_input_request_at: number | null;
  last_input_request_kind: string | null;
  last_permission_prompt_at: number | null;
  last_permission_prompt_kind: string | null;
}

/**
 * One entry in the rendered handoff edge — the per-job view of the
 * handoff-er→handoff-ee relationship folded purely from `HandoffRequested` +
 * the callee's `SessionStart` bind. Sibling of {@link JobLinkEntry}, but the
 * edge is a job→job relationship (NOT epic-anchored, unlike `creator`/`refiner`):
 * `kind` distinguishes the direction (`handoff-from` on the initiator's row,
 * `handoff-to` on the handoff-ee's), `handoff_id` keys the `handoffs` row, and
 * `peer_job_id` identifies the OTHER endpoint of the edge (the handoff-ee on a
 * `handoff-from` entry, the initiator on a `handoff-to`).
 *
 * Enrichment boundary mirrors `JobLinkEntry`: the display fields are
 * denormalized off the peer `jobs` row at the reducer's write boundary so
 * renderers read off the projection with no live-jobs join; a missing `jobs`
 * row at enrichment time defaults to the re-fold-safe `{title: null, state:
 * "stopped", <all pair fields>: null}`. The paired-NULL invariant
 * (`last_*_at` / `last_*_kind` move together) holds identically.
 */
export interface HandoffLinkEntry {
  kind: "handoff-from" | "handoff-to";
  handoff_id: string;
  peer_job_id: string;
  status: string;
  title: string | null;
  state: string;
  last_api_error_at: number | null;
  last_api_error_kind: string | null;
  last_input_request_at: number | null;
  last_input_request_kind: string | null;
  last_permission_prompt_at: number | null;
  last_permission_prompt_kind: string | null;
}

/**
 * One row of the `events` table. `id` is the rowid (monotonic per DB); `ts`
 * is unix-epoch seconds as a REAL; optional columns are `NULL` when not
 * provided by the hook payload.
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
   * reducer seeds `jobs.title` from it.
   */
  spawn_name: string | null;
  /**
   * Opaque platform-tagged process start instant for the (pid, start_time)
   * recycle-safe identity used by the boot seed sweep and the exit-watcher.
   * Captured ONLY on `SessionStart`. Platform-tagged (macOS `lstart` string,
   * Linux `/proc/<pid>/stat` field-22 jiffies) — never parsed, only compared
   * for equality against a re-read at sweep time.
   */
  start_time: string | null;
  /**
   * Leading slash command parsed out of a `UserPromptSubmit`'s `data.prompt`
   * by {@link import("./derivers").slashCommandFromPrompt}. NULL on every
   * other event and on prompts that don't start with a lowercase-led slash
   * token. Backed by a partial index `WHERE slash_command IS NOT NULL`.
   */
  slash_command: string | null;
  /**
   * Skill name parsed out of a Pre/PostToolUse-on-Skill event by
   * {@link import("./derivers").extractSkillName}. Gated by `tool_name ===
   * 'Skill'`; NULL on every other row.
   */
  skill_name: string | null;
  /**
   * Plan-CLI op parsed from a `PostToolUse:Bash` event's `plan_invocation`
   * envelope by {@link import("./derivers").extractPlanInvocation}. NULL when
   * stdout carries no envelope (backed by a partial index `WHERE plan_op IS
   * NOT NULL`). ONE of two channels feeding `syncPlanLinks` (the `Commit`
   * trailer facts are unioned in), but the sole driver of `file_attributions`
   * plan rows.
   */
  plan_op: string | null;
  /**
   * Raw plan target from the envelope — an epic or task id. NULL when the
   * verb takes no argument or the envelope's `target` is absent/non-string.
   */
  plan_target: string | null;
  /**
   * Parsed plan epic id — the parent epic of an epic-form or task-form
   * target. NULL when `plan_target` is NULL or didn't parse.
   */
  plan_epic_id: string | null;
  /**
   * Parsed plan task id — non-NULL only when the target's parsed shape is
   * `task`.
   */
  plan_task_id: string | null;
  /**
   * Subject-present gate (INTEGER 0/1, lifted to boolean via `=== 1`). `true`
   * when the envelope's `subject` is non-null (a mutation carrying human
   * content); NULL when `plan_op` is NULL. Drives creator/refiner
   * classification.
   */
  plan_subject_present: number | null;
  /**
   * Anthropic tool_use correlator (`toolu_...`) parsed from any event payload
   * by {@link import("./derivers").extractToolUseId}. Backed by a partial
   * index `WHERE tool_use_id IS NOT NULL`. Bridges the Pre/PostToolUse →
   * SubagentStart/Stop join in `subagent_invocations`.
   */
  tool_use_id: string | null;
  /**
   * `CLAUDE_CONFIG_DIR` env value observed by the hook at `SessionStart`
   * (`undefined`/empty → NULL; trailing `/` stripped). NULL on every
   * non-SessionStart row. Folded into `jobs.config_dir` latest-non-NULL-wins
   * via COALESCE, so a resume SessionStart capturing NULL preserves the prior
   * value.
   */
  config_dir: string | null;
  /**
   * JSON-encoded array of repo-relative paths the plan CLI wrote during this op
   * (the envelope's `files` array). NULL on non-plan rows and on plan
   * rows whose envelope omitted/misshaped `files`. The reducer mints
   * `source='plan'` `file_attributions` rows under the envelope's
   * `state_repo` for every path. NOT a wire-surface column — reducer-only.
   */
  plan_files: string | null;
  /**
   * Terminal-multiplexer backend tag the hook captured via pure `process.env`
   * reads. `'tmux'` when the `TMUX` sentinel is set; NULL outside tmux. Paired
   * with {@link Event.backend_exec_session_id} / {@link Event.backend_exec_pane_id} —
   * type + pane id stamp together; the session may be NULL on its own
   * (human-created sessions carry no `KEEPER_TMUX_SESSION`). Historical rows
   * may carry other recorded tags verbatim — the fold copies the string as-is.
   */
  backend_exec_type: string | null;
  /**
   * Backend session name: the `KEEPER_TMUX_SESSION` value keeper injects via
   * `-e` on managed launches — NULL for a Claude in a human-created tmux session
   * until the snapshot poller fills it. NULL when {@link Event.backend_exec_type}
   * is NULL. Folded into `jobs.backend_exec_session_id` latest-non-NULL-wins via
   * COALESCE.
   */
  backend_exec_session_id: string | null;
  /**
   * Backend pane id (raw `TMUX_PANE` env value; TEXT so the daemon's
   * `list-panes` id matches via normalized equality). NULL when
   * {@link Event.backend_exec_type} is NULL. Folded into
   * `jobs.backend_exec_pane_id` latest-non-NULL-wins via COALESCE.
   */
  backend_exec_pane_id: string | null;
  /**
   * The git-attribution fold's lone cross-event field —
   * `data.tool_input.file_path` — promoted to a column by
   * {@link import("./derivers").extractMutationPath}. Gated on
   * `(PostToolUse, tool_name in Write/Edit/MultiEdit/NotebookEdit)`; NULL on
   * every other row. Hook-derived forward + ingester-recomputed for pre-deriver
   * lines. Backed by a partial index `WHERE mutation_path IS NOT NULL`. The
   * expression index + COALESCE dual-read stay until the `.3` attribution flip.
   */
  mutation_path: string | null;
  /**
   * Git lane BRANCH the job ran in (`keeper/epic/<id>` for a base/inheriting/
   * closer lane, `keeper/epic/<id>--<task>` for a rib) captured by the hook at
   * `SessionStart` from the producer-injected `KEEPER_PLAN_WORKTREE_BRANCH` env
   * (`undefined`/empty/whitespace → NULL; no normalization — it is a canonical
   * ref). NULL on every non-SessionStart row AND on every non-worktree launch.
   * Folded into `jobs.worktree` set-once via COALESCE, so a resume SessionStart
   * capturing NULL preserves the first-launch branch. Mirrors {@link config_dir}.
   * Stores the BRANCH, never the lane PATH — the path embeds a provision-time
   * dirhash and is torn down at finalize, while the branch survives
   * `git worktree remove`/`move`.
   */
  worktree: string | null;
  /**
   * Launching harness for this session — `"claude"`/`"codex"`/`"pi"`/`"hermes"`.
   * The claude hook stamps `"claude"` at SessionStart; a codex/hermes birth-ingest
   * synthetic SessionStart carries its own tag. NULL on every non-SessionStart row
   * AND on legacy rows. Folded onto `jobs.harness` via the SessionStart COALESCE
   * arm; the fold NEVER synthesizes a value, so a NULL harness reads as claude at
   * every consumer.
   */
  harness: string | null;
  /**
   * The harness-native resume target — the token its own `--resume` argv needs.
   * claude/pi pin their session uuid at seed (carried on the SessionStart event);
   * codex/hermes back-fill it later via a synthetic `ResumeTargetResolved` event
   * (rollout SessionMeta / hook session id) that folds ONLY this column and never
   * touches lifecycle state. NULL on rows that carry no resume identity.
   */
  resume_target: string | null;
}

/**
 * One row of the `jobs` projection. `job_id` is the Claude Code session id
 * (one session per job). Defaults match the zero-event projection
 * (`state='stopped'`, `title=NULL`).
 *
 * `title_source` records `title`'s provenance and drives precedence: NULL =
 * priority 0, `'spawn'` = 1, `'payload'` = 2, `'transcript'` = 3. The reducer
 * writes a new title iff the incoming source's priority is higher, or equal
 * with a changed value — so a lower-priority source never clobbers a higher
 * one and the fold stays a pure function of persisted state.
 *
 * `transcript_path` is seeded once at SessionStart; display/debug only.
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
   * `Event.start_time`). Display-only; consumed by the boot seed sweep and the
   * exit-watcher to disambiguate pid recycle.
   */
  start_time: string | null;
  /**
   * Spawn-derived plan verb on the strict whitelist
   * `{plan, work, close, approve}`, extracted from `Event.spawn_name` at
   * SessionStart by {@link import("./derivers").planVerbRefFromSpawnName}.
   * NULL when the spawn name didn't match the `{verb}::<ref>` shape. Paired
   * with {@link Job.plan_ref} (both populate or both stay NULL). Set once at
   * SessionStart, untouched by ON CONFLICT RESUME.
   */
  plan_verb: string | null;
  /**
   * Spawn-derived plan ref (epic or task id), extracted alongside
   * {@link Job.plan_verb}. Backed by `idx_jobs_plan_ref WHERE plan_ref IS NOT
   * NULL`; `plan_verb` filters ride this partial index plus a post-seek check.
   */
  plan_ref: string | null;
  /**
   * Cross-references derived from this job's plan-CLI invocations,
   * classified against its `/plan:plan` windows: the epic this job CREATED or
   * REFINED. Distinct from the spawn-name pair (`plan_verb`/`plan_ref`, the
   * job's OWN spawn role).
   *
   * JSON-TEXT, decoded at the read boundary. Sorted ASC on `(kind, target)` —
   * total-order tiebreaker is non-negotiable for byte-identical re-fold.
   * `syncPlanLinks` re-derives this from scratch via `deriveEpicLinks`.
   */
  epic_links: Link[];
  /**
   * Unix-seconds stamped by the reducer's dual-case `RateLimited`/`ApiError`
   * arm when Claude Code writes an `isApiErrorMessage` turn to the transcript.
   * `state` is concurrently flipped to `'stopped'`; this is the separate
   * annotation explaining WHY. Cleared ONLY on the next `UserPromptSubmit`
   * revival — Stop/SessionEnd/Killed leave it intact, so the attribution
   * survives the natural post-error lifecycle. NULL when never hit.
   *
   * Paired-NULL with {@link last_api_error_kind} — both stamp together, both
   * clear together.
   */
  last_api_error_at: number | null;
  /**
   * The {@link ApiErrorKind} value that fired the last api-error stamp.
   * Paired-NULL with {@link last_api_error_at}. Historical `RateLimited`
   * events fold via the dual-case alias to `kind = "rate_limit"` for re-fold
   * determinism.
   */
  last_api_error_kind: string | null;
  /**
   * Unix-seconds stamped by the reducer's `InputRequest` arm when Claude Code
   * uses a built-in interactive tool that fires no hook of its own. `state` is
   * concurrently flipped to `'stopped'`; this is the separate annotation —
   * the session is blocked on a human answer. Cleared on `UserPromptSubmit`,
   * `SessionStart` unconditionally, and on `PreToolUse`/`PostToolUse` gated on
   * non-NULL (the next tool the agent uses is the closest "answered" signal).
   * NULL when never hit.
   *
   * Paired-NULL with {@link last_input_request_kind}.
   */
  last_input_request_at: number | null;
  /**
   * The {@link InputRequestKind} value that fired the last input-request
   * stamp. Paired-NULL with {@link last_input_request_at}.
   */
  last_input_request_kind: string | null;
  /**
   * Timestamp the session was last parked on a
   * `Notification:permission_prompt` (tool-permission dialog) or
   * `Notification:elicitation_dialog` (MCP input request). Diverges from
   * {@link last_input_request_at}: does NOT flip {@link state} — the worker is
   * blocked on the human but structurally still mid-turn (no Stop), so the
   * `[awaiting:*]` pill layers on top of `[working]`. Cleared on
   * `UserPromptSubmit`/`SessionStart` unconditionally, on
   * `PreToolUse`/`PostToolUse` gated on non-NULL, and on `Stop` as the
   * session-level backstop. NULL when never hit.
   *
   * Paired-NULL with {@link last_permission_prompt_kind}.
   */
  last_permission_prompt_at: number | null;
  /**
   * The {@link PermissionPromptKind} value that fired the last
   * permission-prompt / elicitation stamp. Paired-NULL with
   * {@link last_permission_prompt_at}.
   */
  last_permission_prompt_kind: string | null;
  /**
   * Unix-seconds stamped by the reducer's `UserPromptSubmit` arm on the rising
   * edge into `working` (a `state != 'working'` → working transition: a fresh
   * prompt on a stopped row, or a re-open from `ended`/`killed`). HELD across
   * mid-run churn (a 2nd prompt while already `working` does NOT re-stamp) and
   * when a job goes stopped/terminal or resumes-but-idle. The recency key for
   * the unified `keeper dash` AGENTS timeline (`COALESCE(active_since,
   * created_at)` DESC). NULL on a brand-new SessionStart-only job that never
   * prompted — the column DEFAULT (NULL) is the correct seed and it sorts by
   * `created_at`. Never backfilled (that would conflate it with `updated_at`).
   */
  active_since: number | null;
  /**
   * Projection of `Event.config_dir`. Latest-non-NULL-wins via COALESCE so a
   * resume SessionStart capturing NULL preserves the prior value.
   */
  config_dir: string | null;
  /**
   * Durable git lane BRANCH the job ran in — the projection of
   * {@link Event.worktree}, folded set-once on the SessionStart ON CONFLICT arm
   * via `COALESCE(excluded.worktree, jobs.worktree)`. `keeper/epic/<id>` for a
   * base/inheriting/closer lane, `keeper/epic/<id>--<task>` for a rib; NULL on a
   * serial / non-worktree job. A stable, path-independent marker the `keeper
   * jobs` TUI renders as a `[⑂ <branch minus keeper/epic/>]` pill. Display-only
   * on `JOBS_DESCRIPTOR`.
   */
  worktree: string | null;
  /**
   * Per-job dirty-file count from the latest `GitSnapshot` whose `jobs[]`
   * enumerated this session. 0 on every never-enumerated job and after a
   * `GitRootDropped` retraction. Drives readiness's `git-uncommitted`
   * predicate.
   */
  git_dirty_count: number;
  /**
   * Project-wide files-not-attributed-to-a-live-session count: files dirty in
   * the worktree that no LIVE session was the canonical attribution for at
   * snapshot time. 0 on every never-snapshotted job and after a
   * `GitRootDropped` retraction. Drives readiness's `git-orphans` predicate.
   */
  git_unattributed_to_live_count: number;
  /**
   * Project-wide strict-mystery file count: files dirty in the worktree with
   * NO attribution from ANY session, past or present. 0 on every
   * never-snapshotted job and after a `GitRootDropped` retraction.
   */
  git_orphan_count: number;
  /**
   * Backend tag projected from the latest event whose hook stamped it
   * (`'tmux'`; historical rows may carry other recorded tags). Latest-non-NULL-wins via COALESCE. Paired with
   * {@link Job.backend_exec_session_id} / {@link Job.backend_exec_pane_id}.
   * Drives the per-row backend choice for the `keeper jobs` `v` focus key.
   * Surfaced via the shared board-render, never computed in the renderer.
   */
  backend_exec_type: string | null;
  /**
   * LIVE backend session name — the pane's CURRENT tmux session, re-derived by
   * the `TmuxTopologySnapshot` live fold (boot-seeded + skip-floored, live-only).
   * NULL paired with {@link Job.backend_exec_type}, or until the first topology
   * snapshot resolves the pane; consumers COALESCE onto
   * {@link Job.backend_exec_birth_session_id} for the fallback.
   */
  backend_exec_session_id: string | null;
  /**
   * FROZEN launch session (`KEEPER_TMUX_SESSION` at spawn) — the forensic
   * birth-session fallback crash-restore + dash grouping COALESCE onto when the
   * live {@link Job.backend_exec_session_id} is unresolved.
   */
  backend_exec_birth_session_id: string | null;
  /**
   * Backend pane id (raw `TMUX_PANE` TEXT). NULL paired with
   * {@link Job.backend_exec_type}. Surfaced as a `p<pane>` segment in the
   * `keeper jobs` coord pill.
   */
  backend_exec_pane_id: string | null;
  /**
   * The tmux SERVER generation the live pane was last resolved under: stamped by
   * the `TmuxTopologySnapshot` live fold on first match and held equal
   * thereafter, so a recycled `%N` from a NEW server generation never re-targets
   * this row. Live-only + skip-floored like {@link Job.backend_exec_session_id};
   * NULL until the first topology snapshot resolves the pane. A recycle guard
   * cross-checks it against the live
   * snapshot's generation so a recycled `%N` is never mis-attributed to this
   * row. Optional at the projection boundary — not every `jobs` read selects it.
   */
  backend_exec_generation_id?: string | null;
  /**
   * JSON-TEXT array of the session's LIVE background monitors, snapshot-REPLACED
   * on each `Stop` (drop-when-dead). Each entry is a
   * {@link import("./derivers").MonitorEntry}. A terminal job carries `'[]'`.
   *
   * Raw TEXT scalar at the projection boundary (NOT in `jsonColumns`):
   * `monitorLinesFor` and the `monitor-running` await predicate each parse the
   * string defensively (malformed → `[]`, never throw), so no decode is forced
   * at the wire layer.
   */
  monitors: string | null;
  /**
   * The job→job handoff edges this row participates in — a `handoff-from` entry
   * (written by the `HandoffRequested` fold onto the initiator job) and/or a
   * `handoff-to` entry (written by the callee's `SessionStart` bind fold). NOT
   * epic-anchored, unlike {@link epic_links}. JSON-TEXT at the projection
   * boundary, decoded at the read boundary (a `jsonColumn`); optional + absent ≡
   * `[]` for a pre-v88 stored row, so renderers treat absent as no edges. Render
   * reads it via {@link import("../cli/board").renderHandoffLinkLines} on the
   * board and a relation badge on the dash card; the reducer is the sole writer.
   */
  handoff_links?: HandoffLinkEntry[];
  /**
   * Live tmux `#{window_index}` — the window's left-to-right VISUAL position —
   * folded onto the row from each `WindowIndexSnapshot` the restore-worker
   * posts on a `data_version` pulse. The `keeper dash` view-model orders cards
   * within a session band by this index (known ASC, then `created_at`/`job_id`;
   * a null/non-tmux/not-yet-probed index sorts last). Display/sort-only; NULL
   * when no window position is known.
   */
  window_index: number | null;
  /**
   * The session's CURRENT Claude Code model id (e.g. `claude-opus-4-8`),
   * projected from the statusLine payload and folded latest-wins by the
   * `SessionTelemetry` arm (schema v100 / fn-1024). Display-only; NULL until the
   * first statusLine snapshot lands. Paired with {@link current_model_display}.
   */
  current_model_id: string | null;
  /**
   * The session's CURRENT model display name (e.g. `Opus`), from the statusLine
   * payload. Display-only; NULL until the first snapshot. Paired with
   * {@link current_model_id}.
   */
  current_model_display: string | null;
  /**
   * The session's CURRENT reasoning-effort level (`low`/`medium`/`high`/`xhigh`/
   * `max`), from the statusLine payload's `effort.level`. Display-only; NULL when
   * the payload omits effort or no snapshot has landed.
   */
  current_effort: string | null;
  /**
   * The session's CURRENT context-window fill, taken directly from the
   * statusLine payload's `context_window.used_percentage` (never recomputed).
   * Display-only; NULL until the first snapshot.
   */
  context_used_percentage: number | null;
  /**
   * The session's CURRENT context-window input-token count
   * (`context_window.total_input_tokens`). Display-only; NULL until the first
   * snapshot.
   */
  context_input_tokens: number | null;
  /**
   * The session's CURRENT context-window size in tokens
   * (`context_window.context_window_size`). Display-only; NULL until the first
   * snapshot.
   */
  context_window_size: number | null;
  /**
   * Dispatch provenance (schema v107): `'autopilot'` iff this job's
   * binding SessionStart discharged a real `pending_dispatches` row — i.e. the
   * autopilot minted a `Dispatched` intent that materialized into this worker.
   * NULL for every manually-launched session, including a manual `keeper
   * dispatch work::fn-N.M` (plan-form but mints no pending row), a handoff, a
   * pair partner, and a bus-woken session. The airtight autopilot-vs-manual
   * discriminator the autoclose worker scopes on — never a tmux/name heuristic.
   * Deterministic-replayed (survives wipe-and-replay like the `kill_reason`
   * column); set once on discharge-on-bind, untouched by resume.
   */
  dispatch_origin: string | null;
  /**
   * Launching harness (`"claude"`/`"codex"`/`"pi"`/`"hermes"`), folded onto
   * `jobs.harness` from the SessionStart tag. NULL on legacy rows and reads as
   * claude at every consumer (the fold never synthesizes a value). The resume/
   * restore surfaces route {@link resume_target} through this harness's native
   * resume argv.
   */
  harness: string | null;
  /**
   * The harness-native resume target — the token the launching harness's own
   * resume argv needs (claude/pi the session id at seed; codex/hermes back-filled
   * post-stop). NULL when keeper resolved no resume identity, which the restore
   * surfaces render as not-resumable for a non-claude harness.
   */
  resume_target: string | null;
  // NOTE: the migration-only jobs column `kill_reason` (v103) is DELIBERATELY
  // absent here — this interface mirrors only the fields Job-typed reads consume
  // today. The column exists on the row and is read ad-hoc (a scoped SELECT) by
  // the folds/producers that own it; a later read surface adds it when needed.
}

/**
 * Worker→main message carrying one session's coalesced statusLine telemetry
 * snapshot (fn-1024). The `statusline-worker` producer posts it; main flattens
 * the six projection fields into the synthetic `SessionTelemetry` event's `data`
 * blob via {@link import("./daemon").serializeSessionTelemetry}. `kind` (the
 * discriminator) and `id` (the correlation key — a claude `session_id` that
 * equals the hook-sourced `jobs.job_id`) are NOT serialized: `id` rides in
 * `events.session_id`, mirroring the {@link UsageSnapshotMessage} pipeline. Any
 * field the statusLine payload omits arrives as `null` and folds latest-wins
 * without nulling the other columns (COALESCE merge in the reducer arm).
 */
export interface SessionTelemetryMessage {
  kind: "session-telemetry";
  /** Claude `session_id` — the `jobs.job_id` the fold matches on (rides in `events.session_id`). */
  id: string;
  /** Current model id (`model.id`, e.g. `claude-opus-4-8`); null when absent. */
  model_id: string | null;
  /** Current model display name (`model.display_name`, e.g. `Opus`); null when absent. */
  model_display: string | null;
  /** Current reasoning effort (`effort.level`: low/medium/high/xhigh/max); null when the payload omits it. */
  effort: string | null;
  /** Context-window fill percent, taken verbatim from `context_window.used_percentage`; null when absent. */
  used_percentage: number | null;
  /** Context-window input-token count (`context_window.total_input_tokens`); null when absent. */
  input_tokens: number | null;
  /** Context-window size in tokens (`context_window.context_window_size`); null when absent. */
  window_size: number | null;
}

/**
 * Decoded fold-side shape of a `SessionTelemetry` event's `data` blob (fn-1024),
 * mirroring the {@link UsageSnapshotMessage}→payload split. Produced by
 * {@link import("./reducer").extractSessionTelemetry} with every field a
 * null-fallback (a guarded parse that NEVER throws — unknown/absent → null), so
 * a malformed or partial blob folds to a safe value. The six fields land on the
 * matching `jobs` telemetry columns; a `null` field is skipped (COALESCE) so a
 * partial snapshot never clobbers a column a prior snapshot filled. `kind`/`id`
 * are event metadata, not carried here.
 */
export interface SessionTelemetryPayload {
  model_id: string | null;
  model_display: string | null;
  effort: string | null;
  used_percentage: number | null;
  input_tokens: number | null;
  window_size: number | null;
}

/**
 * Singleton reducer cursor (`id = 1`). The reducer advances `last_event_id` in
 * the SAME transaction that folds each event into `jobs` — the
 * exactly-once-per-event guarantee under crash + boot drain.
 */
export interface ReducerState {
  id: 1;
  last_event_id: number;
  updated_at: number;
}

/**
 * One row of the `dead_letters` OPERATIONAL sidecar. `bindings` is JSON-TEXT,
 * decoded at the read boundary.
 *
 * NOT a reducer projection: rows arrive via the daemon's import scan over the
 * per-pid NDJSON dead-letter files the hook writes when its `events` INSERT
 * exhausts retry. The rows record events that NEVER MADE IT into the log, so a
 * from-scratch re-fold MUST NOT touch `dead_letters`.
 *
 * The {@link status} transition `waiting → recovered` happens only inside the
 * replay verb, which appends a real `events` row from {@link bindings} and
 * stamps {@link recovered_at} + {@link replayed_event_id} in ONE
 * `BEGIN IMMEDIATE`. No other transitions.
 */
export interface DeadLetter {
  /**
   * Hook-generated UUID — the import path's idempotency key (`INSERT OR
   * IGNORE`), so a re-scan never duplicates a row.
   */
  dl_id: string;
  session_id: string;
  hook_event: string;
  /**
   * The dropped event's own unix-seconds timestamp, preserved verbatim. The
   * replay path re-uses it so a re-fold lands the recovered row at the correct
   * historical position.
   */
  ts: number;
  /**
   * Unix-seconds when the hook wrote the NDJSON record (distinct from
   * {@link ts}, the event's wall time). The "oldest waiting first" replay pick
   * orders on this column.
   */
  dl_written_at: number;
  /** Hook process pid. Nullable: the hook may not have learned its own pid. */
  pid: number | null;
  /**
   * Full insert-binding set the hook would have run against `events`. JSON-TEXT,
   * decoded at the read boundary; the replay path deserializes it back to bound
   * parameters and runs the same insert.
   */
  bindings: Record<string, string | number | boolean | null>;
  /**
   * `'waiting'` until the replay verb flips it to `'recovered'` (the only
   * transition). The descriptor's `defaultFilter: { status: 'waiting' }` scopes
   * the default page to the unrecovered backlog.
   */
  status: "waiting" | "recovered";
  /**
   * Unix-seconds when the replay flipped this row. NULL while {@link status} is
   * `'waiting'`; populates with {@link replayed_event_id} on replay.
   */
  recovered_at: number | null;
  /**
   * `events.id` of the appended real event on replay. NULL while {@link status}
   * is `'waiting'`.
   */
  replayed_event_id: number | null;
  /** Per-pid NDJSON file path the row was imported from. Nullable. */
  source_file: string | null;
}

/**
 * One row of the `pending_dispatches` reducer projection — the durable
 * substrate for launch-window double-dispatch suppression. A row exists for as
 * long as the reconciler's `Dispatched` mint has not been discharged by a
 * SessionStart bind (a job whose `(plan_verb, plan_ref)` matches `(verb, id)`),
 * a `DispatchFailed`, or the TTL sweep's `DispatchExpired`.
 *
 * Row presence IS the signal — no status column; the row's absence is the
 * slot-free fact every dedup arm reads. Mint + discharge ride the same
 * `BEGIN IMMEDIATE` cursor-advance transaction, so a from-scratch re-fold
 * rebuilds the table byte-identically.
 */
export interface PendingDispatch {
  /** Dispatch verb — the `jobs.plan_verb` correlation key. Part of the pk. */
  verb: string;
  /** Dispatch target id — the `jobs.plan_ref` correlation key. Part of the pk. */
  id: string;
  /** Working directory the dispatch launched against. Nullable. */
  dir: string | null;
  /**
   * Producer-side wall-clock unix-seconds frozen onto the `Dispatched` payload.
   * The TTL sweep compares it against `Date.now()` IN MAIN (never in the fold)
   * to decide `DispatchExpired`; re-fold-deterministic because the payload is
   * immutable.
   */
  dispatched_at: number;
  /** `events.id` of the last `Dispatched` event that UPSERTed this row. */
  last_event_id: number;
}

/**
 * The display projection of a `jobs` row embedded inside an `epics` row's
 * `jobs` array (epic-form ref: `plan`/`close`/`approve`) or a task element's
 * `jobs` sub-array (task-form ref: `work`/`approve`). `syncJobIntoEpic` builds
 * these whenever a `plan_ref` is non-null; the destination array is decided by
 * `parsePlanRef`'s kind (ordinal-suffix presence). Sorted `(created_at desc,
 * job_id asc)` — total-order tiebreaker is non-negotiable for byte-identical
 * re-fold.
 *
 * Minimal display field set, NOT a full `Job` (no pid/cwd/start_time). The
 * `last_*` annotation pairs each mirror the same-named {@link Job} column and
 * share its paired-NULL invariant.
 */
export interface EmbeddedJob {
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
  last_permission_prompt_at: number | null;
  last_permission_prompt_kind: string | null;
  git_dirty_count: number;
  git_unattributed_to_live_count: number;
  git_orphan_count: number;
  /**
   * Mirror of `jobs.active_since` — `null` until the session's FIRST un-stop
   * edge (the reducer stamps it on the first `state != 'working'` arm), then
   * non-null and re-stamped to the latest `ts` on every subsequent un-stop edge
   * (it is the most-recent-edge timestamp, NOT frozen at the first). Lifted by
   * `buildEmbeddedJob` straight off the row, so it round-trips
   * byte-deterministically; optional + absent ≡ `null` for a pre-v84 stored
   * element. Readiness reads it to disambiguate a
   * FRESHLY-BOUND `stopped` worker (bound by SessionStart, never yet active:
   * `active_since === null`) from a genuinely STOPPED-AFTER-WORKING / dead one
   * (`active_since` non-null) — the former occupies its root through the bind →
   * first-activity handoff (`bound-pending`), the latter must NOT over-hold it.
   */
  active_since?: number | null;
  /**
   * The provenance-filtered live-worker-monitor occupancy fact for THIS
   * session, carried on by `buildEmbeddedJob`. `true` iff a worker-launched
   * `monitor`/`bash-bg` entry is present in `jobs.monitors` (`ambient`
   * watchers NEVER count); terminal SessionEnd/Killed force it `false`.
   * Optional + absent ≡ `false` so a pre-v59 stored element round-trips
   * deterministically. Readiness reads it to hold the per-epic/per-root mutex
   * via the `monitor-*` verdicts while a backgrounded suite is still live.
   */
  has_live_worker_monitor?: boolean;
}

/**
 * One row of the `subagent_invocations` peer-table projection, folded from the
 * `Pre/PostToolUse:Agent` + `SubagentStart/Stop` event quartet.
 *
 * Composite primary key `(job_id, agent_id, turn_seq)`; `turn_seq` is the
 * per-job monotone turn counter so re-entrant subagents land on distinct rows.
 *
 * Defaults match the zero-event projection: `status='running'` at
 * SubagentStart, flipping to `'ok'`/`'error'` on SubagentStop; `prompt_chars`
 * defaults to 0 (backfilled from the PreToolUse:Agent payload via the
 * `tool_use_id` bridge). `last_event_id` bumps on every UPDATE to drive the
 * wire diff.
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
  status: "running" | "ok" | "failed" | "unknown" | "superseded";
  duration_ms: number | null;
  /**
   * Terminal disposition of the subagent's most recent assistant turn, derived
   * from the subagent transcript by the transcript worker. `'cut'` = the stream
   * was interrupted mid-turn (last assistant `stop_reason` was `tool_use` or
   * `null` with no terminal text — the SILENT_STREAM_CUT signature); `'clean'`
   * = the turn ended on `end_turn`. NULL until the first `SubagentTurn`
   * synthetic event folds (the zero-event default). Read by the SubagentStop
   * fold to recognize a silent stream cut and drive auto-resume. Optional +
   * absent on the wire (the `subagent_invocations` collection descriptor
   * narrows the served columns to what consumers read; this is a fold-only
   * fact), so readers treat absent ≡ NULL.
   */
  last_disposition?: SubagentDisposition | null;
  last_event_id: number;
  updated_at: number;
}

/**
 * The transcript-derived disposition of a subagent assistant turn. `'cut'` is
 * the SILENT_STREAM_CUT signature (interrupted stream); `'clean'` is a normal
 * `end_turn` close. Carried by the synthetic `SubagentTurn` event and stored on
 * {@link SubagentInvocation.last_disposition}.
 */
export type SubagentDisposition = "cut" | "clean";

/**
 * One row of the `scheduled_tasks` peer-table projection, folded from the
 * `CronCreate` / `CronDelete` `PostToolUse` pair a Claude session arms.
 *
 * Composite primary key `(job_id, cron_id)`; `job_id` is the arming session id,
 * `cron_id` the harness-minted cron handle. CronCreate upserts a `'active'` row
 * (a re-created id resurrects); CronDelete flips the matching row to
 * `'deleted'`. `recurring` / `durable` are INTEGER 0/1 lifts of the payload's
 * booleans. `human_schedule` is the payload's pre-rendered display form (no
 * cron-string parsing); `prompt_summary` is the deterministically truncated
 * first prompt line. Wall-clock spent/expired marking is renderer-side only —
 * the fold derives `status` purely from event order. `last_event_id` bumps on
 * every write to drive the wire diff.
 */
export interface ScheduledTask {
  job_id: string;
  cron_id: string;
  cron: string;
  human_schedule: string;
  recurring: number;
  durable: number;
  prompt_summary: string;
  status: "active" | "deleted";
  ts: number;
  last_event_id: number;
  updated_at: number;
}

/**
 * One row of the `epics` projection. `epic_id` is the plan epic id (pk).
 * The reducer folds synthetic `EpicSnapshot` events into this table via
 * idempotent upsert; columns are nullable matching the zero-event reading.
 * `project_dir` is an untrusted foreign-process JSON field — stored opaque,
 * never used to drive filesystem reads or interpolated into SQL.
 *
 * Each epic embeds its `tasks` (`Task[]`) and its epic-form-ref `jobs`
 * (`EmbeddedJob[]` — verbs `plan`/`close`/`approve`); task-form-ref jobs
 * (`work`/`approve`) live inside each task element's nested `jobs` sub-array.
 * `syncJobIntoEpic` fans a `jobs` write into the correct array whenever the
 * row carries a `plan_ref` (epic vs task decided by `parsePlanRef`). All three
 * collections are JSON TEXT, decoded at the read boundary; embedded jobs
 * sorted `(created_at desc, job_id asc)`.
 */
export interface Epic {
  epic_id: string;
  epic_number: number | null;
  title: string | null;
  project_dir: string | null;
  status: string | null;
  last_event_id: number | null;
  updated_at: number;
  /** Plan `depends_on_epics` ids. JSON-TEXT, decoded at the read boundary. */
  depends_on_epics: string[];
  tasks: Task[];
  jobs: EmbeddedJob[];
  /**
   * Symmetric per-epic view of {@link Job.epic_links}: every job whose plan
   * footprint CREATED or REFINED this epic. JSON-TEXT, decoded at the read
   * boundary; sorted ASC on `(kind, job_id)` — total-order tiebreaker. The ON
   * CONFLICT clause preserves it across an `EpicSnapshot` round-trip so a
   * snapshot re-fold can't wipe the provenance projection.
   */
  job_links: JobLinkEntry[];
  /**
   * Plan-native validation timestamp (`last_validated_at` on the epic
   * file). ISO-8601 string when present; `null` when absent/non-string.
   * Drives the board's `[validated]`/`[unvalidated]` pill.
   */
  last_validated_at: string | null;
  /**
   * The resolved + enriched state of this epic's `depends_on_epics`, computed
   * at fold time via `resolveEpicDep`. Drives readiness's `dep-on-epic` /
   * `dep-on-epic-dangling` verdicts and the board pill, so consumers read the
   * projection instead of re-resolving live.
   *
   * Three-state:
   * - `null` — NOT-YET-COMPUTED, load-bearing: a fresh row reads `null`,
   *   DISTINCT from `[]` ("computed, no deps"). `decodeRow` preserves `null`
   *   on the wire.
   * - `[]` — COMPUTED, NO DEPS.
   * - `ResolvedEpicDep[]` — one entry per `depends_on_epics` token, in source
   *   order.
   *
   * JSON-TEXT (nullable). Maintained by the reducer's forward-stamp + reverse
   * fan-out keyed through `epic_dep_edges`; preserved across an `EpicSnapshot`
   * round-trip by the `projectPlanRow` ON CONFLICT carve-out.
   */
  resolved_epic_deps: ResolvedEpicDep[] | null;
  /**
   * The epic-level parked-closer question (`keeper plan epic-question`), or
   * `null` when none is parked (the zero-event reading). Folded from the
   * `EpicSnapshot` synthetic event's `question` field, sourced from the
   * gitignored `<state>/epics/<epic_id>.state.json` runtime overlay — mirrors
   * how {@link Task.runtime_status} rides the task-level `.state.json`
   * sidecar. `keeper status` surfaces a non-null value as a needs-human
   * board signal.
   */
  question: string | null;
}

/**
 * One entry in {@link Epic.resolved_epic_deps} — the resolved + enriched state
 * of a single `depends_on_epics` token. Computed at fold time via
 * `resolveEpicDep`. The tri-state `state` field carries the readiness verdict:
 * - `'satisfied'` — upstream resolved + done.
 * - `'blocked-incomplete'` — upstream resolved but not done.
 * - `'dangling'` — no upstream resolves, or an ambiguous match.
 */
export interface ResolvedEpicDep {
  /** The raw `depends_on_epics` token, verbatim. */
  dep_token: string;
  /** Resolved upstream `epics.epic_id`, or `null` when dangling/ambiguous. */
  resolved_epic_id: string | null;
  /** Upstream's `epic_number`, or `null` when dangling. Display-only. */
  epic_number: number | null;
  /**
   * Basename of the upstream's `project_dir`, or `null` when dangling.
   * Display-only — drives the `<basename> · fn-N` board chip.
   */
  project_basename: string | null;
  /**
   * `true` when the resolved upstream lives in a different project. `false`
   * for same-project and dangling deps.
   */
  cross_project: boolean;
  state: "satisfied" | "blocked-incomplete" | "dangling";
}

/**
 * One row of the volatile git read projection. Rows are produced by synthetic
 * `GitSnapshot` events the git worker emits after polling a worktree with
 * porcelain-v2 status, and retracted by `GitRootDropped` tombstone events when
 * a worktree stops satisfying the watch gate (no `.keeper/` AND clean-and-
 * pushed past the cooling dwell). The reducer folds only the persisted payload
 * and never re-reads filesystem state, so a from-scratch re-fold reproduces
 * the same frames — including the retraction.
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
 * One task — the element shape of {@link Epic.tasks}. `task_id` is the plan
 * task id; `epic_id` links it to its parent epic. The reducer folds each
 * synthetic `TaskSnapshot` into its parent epic's embedded `tasks` array
 * (deterministic `(task_number, task_id)` sort). `target_repo` is an untrusted
 * foreign-process JSON field — stored opaque, never used to drive filesystem
 * reads or interpolated into SQL.
 */
export interface Task {
  task_id: string;
  epic_id: string | null;
  task_number: number | null;
  title: string | null;
  target_repo: string | null;
  /**
   * Plan-native effort tier. Stored opaque — keeper never branches on the
   * value, so a future tier widening rides through with no code change. Null
   * on legacy task files / shell elements.
   */
  tier: string | null;
  /**
   * Plan-native worker model (the model axis of the {model × effort} worker
   * matrix). Stored opaque — keeper never branches on the value; the autopilot
   * producer pairs it with {@link tier} to resolve the launch-time
   * `--plugin-dir plugins/plan/workers/<model>-<effort>` cell. Null on
   * legacy task files / shell elements.
   */
  model: string | null;
  /**
   * Derived worker-phase binary: `worker_done_at` present → `"done"`, else
   * `"open"`. Nullable on a shell task element inserted by `syncJobIntoEpic`
   * before any plan-snapshot fold lands.
   */
  worker_phase: string | null;
  /**
   * Plan-native runtime status (`"todo" | "in_progress" | "done" |
   * "blocked"`). Absent / missing state file / unrecognized value folds to
   * `"todo"` per plan's `merge_task_state` convention. Never null — the
   * plan default is always meaningful.
   */
  runtime_status: string;
  /** Plan `depends_on` task ids. */
  depends_on: string[];
  /**
   * Task-level embedded jobs: `jobs` rows whose `plan_ref` equals this
   * `task_id` — verb `work`, plus `approve`. Nested inside the parent epic's
   * `tasks` array, decoded via the same JSON parse. Sorted `(created_at desc,
   * job_id asc)`.
   */
  jobs: EmbeddedJob[];
}

/**
 * A `block_escalations` projection row (fn-941) — the daemon block-escalation
 * producer's escalate-once latch, one row per currently-blocked plan task keyed
 * by `(epic_id, task_id)`. Subscribed by the board / `keeper await` as a coarse
 * "escalation in flight" signal (a row's PRESENCE for a task, not its internal
 * `status` state machine). The `status` advances `pending → requested →
 * attempted`; `outcome` records the helper's result on the `attempted` row.
 * `blocked_since` / `last_event_id` are event ids, never wall-clock.
 */
export interface BlockEscalation {
  epic_id: string;
  task_id: string;
  blocked_since: number;
  status: string;
  outcome: string | null;
  last_event_id: number;
}

/**
 * The `tmux_client_focus` singleton projection row (fn-952) — the persistent
 * `tmux -C` control worker's last-write-wins view of which session/window/pane
 * the current real (non-control) tmux client is focused on. At most one row
 * (`id = 1`). `status` is `'focused'` when a real client's active pane resolved,
 * `'none'` when no real client / no resolvable active pane (the worker's
 * `pickCurrentClient` derivation). On `'none'` the location fields are absent /
 * null. The `keeper jobs` banner reads this to render its focus pill.
 */
export interface TmuxClientFocus {
  id: number;
  status: string | null;
  generation_id: string | null;
  session_name: string | null;
  window_index: number | null;
  pane_id: string | null;
  last_event_id: number | null;
  updated_at: number | null;
}

/**
 * Pre-flattened `BlockEscalationRequested` synthetic event payload — the daemon
 * block-escalation producer (task 3) mints it for a `pending` `block_escalations`
 * latch row right before it spawns the one-way bus-send helper, advancing the
 * latch `pending → requested`. Keyed strictly `(epic_id, task_id)` — the latch
 * pk. The reducer fold reads this event (it stays in the KEEP-SET inline forever,
 * the complement of the retention shed allow-list).
 */
export interface BlockEscalationRequestedPayload {
  /** Parent epic id — part of the `block_escalations` pk. */
  epic_id: string;
  /** Blocked task id — part of the `block_escalations` pk. */
  task_id: string;
}

/**
 * Pre-flattened `BlockEscalationAttempted` synthetic event payload — the producer
 * mints it after the one-way bus-send helper resolves, advancing the latch
 * `requested → attempted` and recording the helper's `outcome` (e.g. `"sent"` /
 * `"skipped"` / `"failed"`). Keyed `(epic_id, task_id)`. The reducer fold reads
 * this event (KEEP-SET inline forever — never added to the retention shed
 * predicate).
 */
export interface BlockEscalationAttemptedPayload {
  /** Parent epic id — part of the `block_escalations` pk. */
  epic_id: string;
  /** Blocked task id — part of the `block_escalations` pk. */
  task_id: string;
  /** Producer-recorded helper outcome, recorded onto the latch `outcome` column. */
  outcome: string;
}

/**
 * Pre-flattened `MergeEscalationAttempted` synthetic event payload — the daemon
 * merge-escalation sweep mints it after the one-way `planner@<epic>` bus-send
 * helper resolves, stamping the `dispatch_failures.merge_escalated_at` once-marker
 * so the notify fires exactly once per sticky `worktree-merge-conflict` close
 * failure. Keyed by the close-row `id` (verb is always `close`). A TERMINAL
 * `outcome` (`sent` / `queued_for_wake`) stamps `merge_escalated_at = event.ts`;
 * the non-terminal `send_failed` outcome folds to a no-op, leaving the marker NULL
 * so the row stays re-sweepable (mirrors `BlockEscalationAttempted`'s
 * `send_failed`-is-non-terminal rule). The fold reads ONLY the payload + the
 * persisted row, so re-fold stays byte-deterministic. The marker NEVER clears the
 * sticky row — only `retry_dispatch` does. KEEP-SET inline forever (never added to
 * the retention shed predicate).
 */
export interface MergeEscalationAttemptedPayload {
  /** The sticky close-row `dispatch_failures.id` (the epic id; verb is `close`). */
  id: string;
  /** Producer-recorded helper outcome; only a terminal outcome stamps the marker. */
  outcome: string;
}

/**
 * Pre-flattened `ResolverDispatchAttempted` synthetic event payload — the daemon
 * resolver-dispatch sweep mints it after it attempts to launch ONE `resolve::<epic>`
 * merge-resolver worker against a sticky `worktree-merge-conflict` close failure,
 * stamping the `dispatch_failures.resolver_dispatched_at` once-marker so the resolver
 * fires exactly once per condition instance (never a per-cycle re-dispatch loop).
 * Keyed by the close-row `id` (verb is always `close`). The TERMINAL `dispatched`
 * outcome (the launch succeeded) stamps `resolver_dispatched_at = event.ts`; the
 * non-terminal `dispatch_failed` outcome folds to a no-op, leaving the marker NULL so
 * the row stays re-sweepable (mirrors `MergeEscalationAttempted`'s
 * `send_failed`-is-non-terminal rule). The fold reads ONLY the payload + the persisted
 * row, so re-fold stays byte-deterministic. The marker NEVER clears the sticky row —
 * only `retry_dispatch` does (and dropping the row re-arms the marker at NULL). The
 * `resolver_dispatched_at` latch is INDEPENDENT of `merge_escalated_at`: the human
 * escalation notify and the resolver dispatch are two consumers of the same sticky.
 * KEEP-SET inline forever (never added to the retention shed predicate).
 */
export interface ResolverDispatchAttemptedPayload {
  /** The sticky close-row `dispatch_failures.id` (the epic id; verb is `close`). */
  id: string;
  /** Producer-recorded launch outcome; only the terminal `dispatched` stamps the marker. */
  outcome: string;
}
