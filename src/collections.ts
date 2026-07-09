/**
 * Collection registry for the keeper read surface. Each `CollectionDescriptor`
 * pulls everything collection-specific (table, columns, pk, sort allowlist,
 * filters, diff key) into one entry so `runQuery` / `diffTick` route by
 * collection name. Adding a collection is one more `REGISTRY` entry with zero
 * wire-protocol or diff-machinery change.
 *
 * INJECTION INVARIANT: every interpolated SQL identifier (table, columns, pk,
 * sort column) comes from a descriptor here — trusted constants, never wire
 * text. Wire `filter` *keys* resolve against `descriptor.filters` by map lookup
 * (never interpolated); `filter` *values* and limit/offset stay bound.
 */

import type { Database } from "bun:sqlite";
import { MAX_IN_PARAMS } from "./db";
import {
  WORKTREE_FINALIZE_ID_PREFIX,
  WORKTREE_RECOVER_KEY_PREFIX,
} from "./dispatch-failure-key";
import type { FilterValue, Row } from "./protocol";

export type { Row };

/**
 * Everything collection-specific the read surface needs. All identifier-typed
 * fields (`table`, `columns`, `pk`, the values of `filters`, `sortable` /
 * `defaultSort` columns) are trusted constants safe to interpolate into SQL.
 *
 * - `name` — the wire-facing collection name (`query.collection`).
 * - `table` — the SQL table to read.
 * - `columns` — the SELECT list; also the shape served on the wire.
 * - `pk` — the primary-key column; the wire/filter/page identity, and the diff
 *   key UNLESS `liveKeyColumns` overrides it.
 * - `liveKeyColumns` — an OPTIONAL composite live-diff identity. When the SQL
 *   identity is `(a, b, …)` but `pk` names only ONE column (e.g.
 *   `dispatch_failures` keys `(verb, id)` under `pk: "verb"`), same-`pk` rows
 *   would collapse to one key on the watch path — one `watched`/`lastSent`
 *   slot, one version-probe bucket, one `byId` fan-out entry — so only one
 *   row's live patch survives. Setting this makes seed / version-map / diff /
 *   membership-token key by these columns joined, so each row tracks
 *   independently. `pk` still owns the wire/filter/page identity; this ONLY
 *   governs the diff key. Columns MUST be descriptor constants (interpolated —
 *   the injection invariant) and NON-NULL (a NULL concat operand yields a NULL
 *   key). Absent → the diff keys by `pk` (unchanged).
 * - `version` — the monotonic per-row column the diff fires on (a row patches
 *   when its `version` advances past `lastSent`). NOT the global frame `rev`.
 * - `sortable` — the allowlist of columns a client may sort by.
 * - `defaultSort` — the fallback sort when none/an unknown column is requested.
 * - `filters` — wire filter-key → SQL column. MUST include the pk so a
 *   detail-page single-item subscribe (`filter:{<pk>}`) works.
 * - `defaultFilter` — an optional base scope applied per filter-key when the wire
 *   query leaves that key unconstrained (e.g. epics default to `status: "open"`).
 *   A wire value for the key — bare or `{ ne }` — overrides the default, so a
 *   client can still page any status by asking for it explicitly. Keys MUST also
 *   appear in `filters` (they resolve through the same map-lookup gate).
 * - `defaultClause` — an optional RAW SQL fallback scope, applied when the wire
 *   filter is entirely empty (a pk lookup is exempt). For predicates that can't
 *   be per-key ANDs (e.g. epics' `default_visible = 1`). The `sql` is
 *   interpolated verbatim (the author owns its safety); `params` are bound. ANY
 *   explicit wire filter drops the whole clause. Coexists with `defaultFilter`.
 * - `recencyBound` — an optional `<column> >= ?` floor applied to EVERY non-pk
 *   query of this collection (`resolveFilter` binds the cutoff
 *   `floor(now_sec) - window_sec`). Unlike `defaultClause`/`defaultFilter` an
 *   EXPLICIT wire filter does NOT drop it (it ANDs on top), and only a pk lookup
 *   is exempt (a detail read of one identity must resolve any age). It exists to
 *   bound an unbounded, never-compacted history table (`subagent_invocations`)
 *   so the membership token (`group_concat(pk)`), the page, and `COUNT(*)` all
 *   scope to the same recent window — they read through one `ResolvedFilter`, so
 *   they can never drift. The cutoff is wall-clock at query-resolve time: this is
 *   the LIVE serve path only (`resolveFilter` is never called from a fold), so it
 *   does not touch the re-fold determinism charter. `column` MUST be a descriptor
 *   constant (interpolated, never wire text).
 * - `jsonColumns` — columns stored as JSON TEXT that {@link decodeRow} parses
 *   into real values at the read boundary (so `result` and `patch` frames serve
 *   an array/object, not a JSON string). A parse failure / NULL falls back to
 *   `[]` per row (honors "one bad row never wedges a reader").
 */
export interface CollectionDescriptor {
  name: string;
  table: string;
  columns: readonly string[];
  pk: string;
  liveKeyColumns?: readonly string[];
  version: string;
  sortable: ReadonlySet<string>;
  defaultSort: { column: string; dir: "asc" | "desc" };
  filters: Readonly<Record<string, string>>;
  defaultFilter?: Readonly<Record<string, FilterValue>>;
  defaultClause?: { sql: string; params: readonly (string | number)[] };
  recencyBound?: { column: string; windowSec: number };
  jsonColumns: ReadonlySet<string>;
}

/** The `jobs` descriptor. Default sort `created_at desc`; default scope hides
 *  terminal jobs (`defaultFilter` below). */
export const JOBS_DESCRIPTOR: CollectionDescriptor = {
  name: "jobs",
  table: "jobs",
  columns: [
    "job_id",
    "created_at",
    "cwd",
    "pid",
    "state",
    "last_event_id",
    "updated_at",
    "title",
    "title_source",
    "transcript_path",
    "plan_verb",
    "plan_ref",
    "epic_links",
    "last_api_error_at",
    "last_api_error_kind",
    "last_input_request_at",
    "last_input_request_kind",
    // Paired permission-prompt / elicitation annotation. Display-only.
    "last_permission_prompt_at",
    "last_permission_prompt_kind",
    "git_dirty_count",
    // `git_unattributed_to_live_count`: files not attributed to a LIVE session.
    // `git_orphan_count`: files with no attribution from ANY session. Display +
    // readiness-predicate inputs only.
    "git_unattributed_to_live_count",
    "git_orphan_count",
    // `profile_name`: `projectBasename(config_dir)` (NULL under the default
    // profile). Display-only.
    "profile_name",
    // Backend-exec coordinates, folded latest-non-NULL-wins. Generic naming
    // lets a future tmux/wezterm backend slot in without a schema change.
    // Display-only.
    "backend_exec_type",
    "backend_exec_session_id",
    // `backend_exec_birth_session_id`: the FROZEN launch session
    // (`KEEPER_TMUX_SESSION` at spawn). Forensic fallback consumers COALESCE onto
    // when the LIVE `backend_exec_session_id` (re-derived by the
    // `TmuxTopologySnapshot` fold) is not yet resolved. Display-only.
    "backend_exec_birth_session_id",
    "backend_exec_pane_id",
    // `monitors`: JSON-TEXT array snapshot-replaced each Stop. The renderer
    // parses the raw string itself, so this stays a raw TEXT scalar at the wire
    // layer — OUT of `jsonColumns`.
    "monitors",
    // `active_since`: Unix-seconds stamped on the rising edge into `working`.
    // Display/sort-only.
    "active_since",
    // `window_index`: live tmux `#{window_index}` (a window's left-to-right
    // VISUAL position), folded from `WindowIndexSnapshot`. The dash sorts cards
    // within a session band on it client-side. Display/sort-only.
    "window_index",
    // `handoff_links`: JSON-TEXT array of the job→job handoff edge
    // (`HandoffLinkEntry`), the `handoff-from` entry written by the
    // `HandoffRequested` fold onto the initiator job and the `handoff-to` entry
    // written by the `SessionStart` bind fold onto the callee. Decoded at the
    // read boundary for the board render. Sibling of `epic_links`.
    "handoff_links",
    // `worktree`: durable git lane BRANCH the job ran in (schema v94 / fn-997).
    // Display-only — the renderer's `worktreeLaneSeg` lifts it into a `[⑂ …]`
    // pill; never a `sortable` / `filters` / `jsonColumns` key.
    "worktree",
    // Per-session telemetry projected from the Claude Code statusLine payload
    // (schema v100 / fn-1024), folded latest-wins from `SessionTelemetry`. The
    // CURRENT model / reasoning effort / context-window usage of a live session.
    // Display-only — never a `sortable` / `filters` / `jsonColumns` key.
    "current_model_id",
    "current_model_display",
    "current_effort",
    "context_used_percentage",
    "context_input_tokens",
    "context_window_size",
    // `kill_reason`: WHY keeper reaped the job (which Killed producer arm
    // minted the reap), folded from the synthetic `Killed` payload (schema v103
    // / fn-1075). Orthogonal to the display-only `close_kind` (HOW it died,
    // which is NOT in this descriptor). Surfaced for reap attribution; never a
    // `sortable` / `filters` / `jsonColumns` key.
    "kill_reason",
    // `harness` / `resume_target`: the launching harness + its native resume
    // token (schema v107/v108 / fn-1103). Served so the restore-worker's
    // `revive.sh` and JSON mirror tag each agent's harness and emit its own
    // resume argv; NULL harness reads as claude. Display-only — never a
    // `sortable` / `filters` / `jsonColumns` key.
    "harness",
    "resume_target",
    // `adopted`: the harness-agnostic "a non-launcher path minted this session"
    // marker (schema v110 / fn-1131), 1 on an adopted session (hand-started
    // hermes self-seed / codex rollout mint), NULL otherwise. Served so the board
    // can pill an adopted job distinctly. Display-only — never a `sortable` /
    // `filters` / `jsonColumns` key.
    "adopted",
  ],
  pk: "job_id",
  version: "last_event_id",
  sortable: new Set([
    "updated_at",
    "created_at",
    "last_event_id",
    "job_id",
    "state",
  ]),
  defaultSort: { column: "created_at", dir: "desc" },
  filters: { state: "state", cwd: "cwd", job_id: "job_id" },
  // Default scope: no `state` filter shows only LIVE jobs (working + stopped),
  // hiding both terminal states. An explicit `state` filter overrides; a pk
  // subscribe is exempt (a detail read of a terminal job still resolves).
  defaultFilter: { state: { not_in: ["ended", "killed"] } },
  // `epic_links`: JSON-TEXT array of the creator/refiner cross-references
  // `syncPlanLinks` maintains; `handoff_links`: the job→job handoff edge — both
  // decoded at the read boundary for display.
  jsonColumns: new Set(["epic_links", "handoff_links"]),
};

/**
 * The `epics` descriptor — each epic embeds its tasks + plan/close jobs as
 * JSON-array columns (decoded at the read boundary).
 *
 * Default sort is `epic_number asc` (tie-break `epic_id`) — plain creation
 * order, a neutral seed. This backend carries NO priority/ordering signal;
 * clients (board, autopilot) consume the seed through readiness's
 * `orderEpicsForScheduling` seam, the single future home for any runtime
 * priority. A NULL `epic_number` shell row (a plan event before its
 * `EpicSnapshot`) sorts first, matching the prior empty-`sort_path` first-sort.
 */
export const EPICS_DESCRIPTOR: CollectionDescriptor = {
  name: "epics",
  table: "epics",
  columns: [
    "epic_id",
    "epic_number",
    "title",
    "project_dir",
    "status",
    "last_event_id",
    "updated_at",
    "tasks",
    "depends_on_epics",
    "jobs",
    "job_links",
    // `last_validated_at`: nullable scalar TEXT. Display-only; out of
    // `jsonColumns` (decoding a scalar would corrupt it to `[]`).
    "last_validated_at",
    // `resolved_epic_deps`: nullable JSON-TEXT array. NULL is load-bearing —
    // "not-yet-computed", DISTINCT from `'[]'` ("computed, no deps"). Decoded as
    // a jsonColumn; out of `sortable`/`filters` (clients branch on element
    // shape).
    "resolved_epic_deps",
    // `default_visible`: VIRTUAL generated column (`status IS NOT NULL AND
    // status='open'`) materializing the default-page predicate so a partial
    // index can serve it. Display-only — clients may SEE it but MUST NOT
    // filter/sort by it; it's an implementation detail of `defaultClause`.
    "default_visible",
    // `question`: nullable scalar TEXT, the epic-level parked-closer question.
    // Display-only (out of `jsonColumns`/`sortable`/`filters`) — `keeper
    // status` reads it to render the needs-human board pill.
    "question",
    // `blocks_closing_of`: nullable scalar TEXT, the SOURCE epic id a blocking
    // follow-up gates the close of. Read-only pointer (out of
    // `jsonColumns`/`sortable`/`filters`) — readiness builds a reverse index
    // over it to gate the source's close row.
    "blocks_closing_of",
  ],
  pk: "epic_id",
  version: "last_event_id",
  sortable: new Set([
    "updated_at",
    "last_event_id",
    "epic_id",
    // The creation-order key — in the trust-boundary allowlist so the generic
    // ORDER BY interpolation accepts it as the default sort column.
    "epic_number",
    "status",
  ]),
  defaultSort: { column: "epic_number", dir: "asc" },
  filters: {
    epic_id: "epic_id",
    status: "status",
    project_dir: "project_dir",
  },
  // Default scope: no wire filter shows every MATERIALIZED OPEN epic; done and
  // not-yet-materialized rows fall off the page. ANY explicit wire filter drops
  // this clause. The clause MUST be the literal `default_visible = 1` (NOT a
  // bound `= ?`): SQLite's partial-index matcher requires the WHERE term to
  // syntactically imply the index's `WHERE default_visible = 1`, and
  // bound-parameter constant folding isn't guaranteed to hit it across versions.
  defaultClause: {
    sql: "default_visible = 1",
    params: [],
  },
  // JSON-TEXT array columns decoded at the read boundary. Nested `task.jobs`
  // rides through the `tasks` parse, so it needs no separate entry.
  jsonColumns: new Set([
    "tasks",
    "depends_on_epics",
    "jobs",
    "job_links",
    // `resolved_epic_deps` is nullable — `decodeRow` returns `null` for a NULL
    // column. Null-vs-empty-array is load-bearing (still-converging vs no-deps).
    "resolved_epic_deps",
  ]),
};

/**
 * Recency window (seconds) bounding the recently-done epics read merged into the
 * autopilot reconcile snapshot (see `loadReconcileSnapshot`). A done epic must
 * stay observable long enough for the close-row COMPLETION reap to see its
 * `{tag:"completed"}` verdict — a DURATION requirement (keep it visible through
 * its done→idle close-row wind-down), not a count. The window must exceed a
 * healthy close-row wind-down with headroom over (fold-lag + reconcile cadence +
 * wind-down); 1800s tracks `MONITOR_RELEASE_SEC` (the hard closer-release
 * ceiling) and is ~10-30x a healthy wind-down. Over-observing is free (the reap
 * is idempotent); only UNDER-observing leaks, so the bound has headroom. A
 * closer wedged PAST the window is caught by the exit-watcher dead-pid reprobe,
 * not this window — the window is a backstop, not the sole safeguard.
 */
export const DONE_EPICS_REAP_WINDOW_SEC = 1800;

/**
 * The `epics_recent_done` descriptor — the recently-DONE epics window the
 * autopilot reconciler merges into its snapshot so the close-row completion reap
 * stays reachable. MIRRORS {@link EPICS_DESCRIPTOR}'s full `columns` / `pk` /
 * `version` / `sortable` / `jsonColumns` surface (NOT minimized): `runQuery`
 * projects only `descriptor.columns` and decodes only `descriptor.jsonColumns`,
 * and the merged rows are consumed as full `Epic` objects (with
 * `tasks`/`jobs`/`job_links`/`resolved_epic_deps`) — trimming any column would
 * silently degrade the reap.
 *
 * Two deviations from `EPICS_DESCRIPTOR`: (1) scoped to `status='done'` via
 * `defaultClause` (it must NOT inherit `default_visible = 1`, which serves only
 * OPEN rows and would return zero done rows); (2) `recencyBound` on `updated_at`
 * floors the read to `now - DONE_EPICS_REAP_WINDOW_SEC`, the time bound replacing
 * the old count `LIMIT`. `updated_at` folds from `event.ts` in Unix SECONDS, and
 * the cutoff is seconds (`resolveFilter` floors `Date.now()/1000`), so the units
 * agree. Default sort `updated_at desc` preserves the prior ordering.
 */
export const EPICS_RECENT_DONE_DESCRIPTOR: CollectionDescriptor = {
  name: "epics_recent_done",
  table: "epics",
  columns: EPICS_DESCRIPTOR.columns,
  pk: EPICS_DESCRIPTOR.pk,
  version: EPICS_DESCRIPTOR.version,
  sortable: EPICS_DESCRIPTOR.sortable,
  defaultSort: { column: "updated_at", dir: "desc" },
  filters: EPICS_DESCRIPTOR.filters,
  // Scope to DONE rows. A `defaultClause` (NOT the inherited `default_visible =
  // 1`, which serves only OPEN) so any explicit wire filter still overrides; the
  // reconciler reads with no wire filter, so this is the live scope.
  defaultClause: {
    sql: "status = ?",
    params: ["done"],
  },
  // Time floor replacing the old count `LIMIT`: `updated_at >= now - windowSec`.
  recencyBound: {
    column: "updated_at",
    windowSec: DONE_EPICS_REAP_WINDOW_SEC,
  },
  jsonColumns: EPICS_DESCRIPTOR.jsonColumns,
};

/**
 * The `epics_pinned` descriptor — the display-only PINNED epic collection
 * (ADR 0018): every epic a LIVE `close`/`work` `dispatch_failures` row keys to,
 * REGARDLESS of the epic's status, so a plan-closed epic with a stuck finalize
 * keeps its full board block until the row clears. Mirrors {@link
 * EPICS_DESCRIPTOR}'s full column/jsonColumn surface so rows project as full
 * `Epic` objects (the merge feeds `computeReadiness` for a real verdict; a
 * trimmed column would degrade it). Default sort `epic_number asc` holds a pinned
 * epic in its stable board slot, never a status-derived rank that jumps frames.
 *
 * Membership is a correlated `EXISTS` over `dispatch_failures` restricted to
 * `verb IN ('close', 'work')` — the verb gate is exactly what EXCLUDES a
 * `daemon`-verb stale-base-lane row that embeds an epic id. The four id-forms
 * mirror the failure-key vocabulary: the bare close key (`df.id = epic_id`), the
 * {@link WORKTREE_FINALIZE_ID_PREFIX}`<epic>-` / {@link
 * WORKTREE_RECOVER_KEY_PREFIX}`<epic>-` prefixed close keys, and the `<epic>.<n>`
 * work-task keys. A STRICT SUPERSET of the true pinned set — the `LIKE` forms may
 * over-select (their `%`/`_` only widen a match, never narrow it), and the
 * TypeScript key vocabulary is the true membership arbiter; the client never
 * needs to ADD an epic the SQL missed. TOTAL: a NULL `epic_id` shell row concats
 * to NULL and matches nothing without erroring. NO `recencyBound` and NO LIMIT —
 * a pin nags until its row clears (pin lifetime = row lifetime), and the set is
 * naturally bounded by the `dispatch_failures` table. The two prefix literals are
 * trusted module constants (the injection invariant: never wire text).
 */
export const EPICS_PINNED_DESCRIPTOR: CollectionDescriptor = {
  name: "epics_pinned",
  table: "epics",
  columns: EPICS_DESCRIPTOR.columns,
  pk: EPICS_DESCRIPTOR.pk,
  version: EPICS_DESCRIPTOR.version,
  sortable: EPICS_DESCRIPTOR.sortable,
  defaultSort: { column: "epic_number", dir: "asc" },
  filters: EPICS_DESCRIPTOR.filters,
  // Correlated EXISTS keyed off the OUTER `epics.epic_id` (the page SELECT's
  // single-table `FROM epics`), so `df` never collides with the outer scope.
  defaultClause: {
    sql:
      "EXISTS (SELECT 1 FROM dispatch_failures df" +
      " WHERE df.verb IN ('close', 'work') AND (" +
      " df.id = epics.epic_id" +
      ` OR df.id LIKE '${WORKTREE_FINALIZE_ID_PREFIX}' || epics.epic_id || '-%'` +
      ` OR df.id LIKE '${WORKTREE_RECOVER_KEY_PREFIX}' || epics.epic_id || '-%'` +
      " OR df.id LIKE epics.epic_id || '.%'" +
      "))",
    params: [],
  },
  jsonColumns: EPICS_DESCRIPTOR.jsonColumns,
};

/**
 * The `git` descriptor — one row per watched git worktree (membership gate:
 * `.keeper present || dirty || ahead of upstream > 0`, recomputed each
 * reconcile). A current-status snapshot plus derived per-live-job dirty/orphan
 * buckets, produced by synthetic `GitSnapshot` events.
 */
export const GIT_DESCRIPTOR: CollectionDescriptor = {
  name: "git",
  table: "git_status",
  columns: [
    "project_dir",
    "branch",
    "head_oid",
    "upstream",
    "ahead",
    "behind",
    "dirty_count",
    "orphaned_count",
    "unattributed_to_live_count",
    "dirty_files",
    "orphaned_files",
    "jobs",
    "last_event_id",
    "updated_at",
  ],
  pk: "project_dir",
  version: "last_event_id",
  sortable: new Set([
    "updated_at",
    "last_event_id",
    "project_dir",
    "dirty_count",
    "orphaned_count",
    "unattributed_to_live_count",
    "branch",
  ]),
  defaultSort: { column: "project_dir", dir: "asc" },
  filters: { project_dir: "project_dir", branch: "branch" },
  jsonColumns: new Set(["dirty_files", "orphaned_files", "jobs"]),
};

/**
 * The `usage` descriptor — one row per agentusage profile, a current-state
 * snapshot of one `~/.local/state/agentusage/<id>.json` envelope, produced by
 * synthetic `UsageSnapshot` / `UsageDeleted` events.
 *
 * The source envelope's freshness fields (`fetched_at`, `next_fetch_at`, …) are
 * read-and-discarded by the worker and absent from the projection. `error_at`
 * IS projected for "stale since" display but excluded from the worker
 * change-gate so a re-failed scrape with the same error produces zero events.
 * `error_kind` (the stable failure classification) IS gated, so a kind flip
 * emits a fresh snapshot.
 */
export const USAGE_DESCRIPTOR: CollectionDescriptor = {
  name: "usage",
  table: "usage",
  columns: [
    "id",
    "target",
    "multiplier",
    "session_percent",
    "session_resets_at",
    "week_percent",
    "week_resets_at",
    "sonnet_week_percent",
    "sonnet_week_resets_at",
    "codex_spark_session_percent",
    "codex_spark_session_resets_at",
    "codex_spark_week_percent",
    "codex_spark_week_resets_at",
    "last_rate_limit_at",
    "last_rate_limit_session_id",
    "status",
    "subscription_active",
    "account_state",
    "error_type",
    "error_message",
    "error_at",
    "error_kind",
    // Rate-limit lift instant + last-successful-fold freshness stamp, carved out
    // of the rate-limit fan-out so a RateLimited event cannot clobber them.
    "rate_limit_lifts_at",
    "last_usage_fold_at",
    "last_event_id",
    "updated_at",
  ],
  pk: "id",
  version: "last_event_id",
  sortable: new Set(["id", "target", "last_event_id", "updated_at"]),
  defaultSort: { column: "id", dir: "asc" },
  filters: { id: "id", target: "target" },
  jsonColumns: new Set(),
};

/**
 * The `profiles` descriptor — one row per Claude profile directory keyed by
 * `config_dir`, correlating the last `rate_limit` ApiError with each profile.
 * The `''` sentinel collapses the default `~/.claude` profile so a single PK
 * groups every NULL-`config_dir` session.
 */
export const PROFILES_DESCRIPTOR: CollectionDescriptor = {
  name: "profiles",
  table: "profiles",
  columns: [
    "config_dir",
    "profile_name",
    "last_rate_limit_at",
    "last_rate_limit_session_id",
    "last_event_id",
    "updated_at",
  ],
  pk: "config_dir",
  version: "last_event_id",
  sortable: new Set([
    "config_dir",
    "last_rate_limit_at",
    "last_event_id",
    "updated_at",
  ]),
  defaultSort: { column: "config_dir", dir: "asc" },
  filters: { config_dir: "config_dir" },
  jsonColumns: new Set(),
};

/**
 * Recency window (seconds) bounding the `subagent_invocations` membership token,
 * page, and `COUNT(*)` to invocations whose `ts` (start time, Unix epoch sec)
 * falls within the last day. The table is never compacted, so its history grows
 * unbounded (4997 rows over 35 days as of 2026-06-23) — without this floor the
 * `group_concat(job_id)` token recompute and the unbounded full-set page re-page
 * the entire ~1MB collection to all board/dash subscribers on ~every event (the
 * server-worker CPU peg, fn-921). One day keeps every live/recent invocation
 * (the only rows render annotates and readiness predicate-6 reads — a `running`
 * sub goes stale at `SUBAGENT_STALENESS_SEC` = 120s, far inside the window) and
 * drops only weeks-old terminal rows belonging to long-ended jobs absent from
 * any live task's `task.jobs`.
 */
export const SUBAGENT_INVOCATIONS_RECENCY_SEC = 86_400;

/**
 * The `subagent_invocations` descriptor — per-job timeline of `Agent` (Task)
 * tool invocations and their `SubagentStart` / `SubagentStop` lifecycle.
 * Composite pk `(job_id, agent_id, turn_seq)` in the table, but `pk` expects a
 * single column, so `job_id` carries the wire identity (every subscribe filters
 * by it) and the other two ride in `columns` for display.
 *
 * `recencyBound` scopes every non-pk query to `ts >= now - 1d`. The membership
 * token, the page SELECT, and `COUNT(*)` all read through ONE `ResolvedFilter`,
 * so the bound applies to all three consistently — render's count/stuck and the
 * byId diff stay in agreement (the constraint the column-narrowing comment below
 * preserves, now also across the recency floor). It is NOT a `LIMIT` page (which
 * would trim the page but not the count and break that agreement); it is a WHERE
 * floor, so count/token/page agree by construction. A pk (`job_id`) detail
 * subscribe is exempt — a per-job timeline read resolves invocations of any age.
 */
export const SUBAGENT_INVOCATIONS_DESCRIPTOR: CollectionDescriptor = {
  name: "subagent_invocations",
  table: "subagent_invocations",
  // Narrowed to the columns consumers actually read (wire render, readiness
  // predicate-6, the in-process autopilot read). `last_event_id` MUST stay —
  // it's the `version` column the diff and result re-seed read. `duration_ms`
  // MUST stay too: it is half the canonical open-turn predicate
  // (`isOpenTurnRow`) — without it the readiness index + the render collapse
  // can't tell a backgrounded `ok` sub (in flight, NULL `duration_ms`) from a
  // finished one. NOT a row-filter or page (those break render's count/stuck +
  // the byId diff).
  columns: [
    "job_id",
    "subagent_type",
    "turn_seq",
    "ts",
    "status",
    "duration_ms",
    "description",
    "last_event_id",
  ],
  pk: "job_id",
  version: "last_event_id",
  sortable: new Set(["ts", "turn_seq", "duration_ms"]),
  defaultSort: { column: "ts", dir: "asc" },
  filters: { job_id: "job_id" },
  recencyBound: { column: "ts", windowSec: SUBAGENT_INVOCATIONS_RECENCY_SEC },
  jsonColumns: new Set(),
};

/**
 * The `scheduled_tasks` descriptor — one row per cron a Claude session armed
 * via `CronCreate`, served to the jobs TUI's expanded-row detail section.
 *
 * Composite SQL key `(job_id, cron_id)`, but `pk` expects a single column, so
 * `job_id` carries the wire identity (every subscribe filters by it) and
 * `cron_id` rides in `columns` for display. The composite-key/single-pk split
 * means the client MUST read `state.rows` (not `byId`) — `byId` collapses to
 * one row per `job_id` and crons would silently collapse to one per job.
 */
export const SCHEDULED_TASKS_DESCRIPTOR: CollectionDescriptor = {
  name: "scheduled_tasks",
  table: "scheduled_tasks",
  columns: [
    "job_id",
    "cron_id",
    "cron",
    "human_schedule",
    "recurring",
    "durable",
    "prompt_summary",
    "status",
    "ts",
    "last_event_id",
  ],
  pk: "job_id",
  version: "last_event_id",
  sortable: new Set(["ts", "cron_id"]),
  defaultSort: { column: "ts", dir: "asc" },
  filters: { job_id: "job_id" },
  jsonColumns: new Set(),
};

/**
 * The `dead_letters` descriptor — one row per dropped hook-INSERT recovered by
 * the daemon's import path. NOT a reducer projection: rows arrive via the daemon
 * scanning per-pid NDJSON files the hook wrote when its `events` INSERT
 * exhausted the bounded retry. Drives the board's persistent warn-count + the
 * replay verb's "oldest waiting first" pick.
 *
 * `version: 'dl_written_at'` so the diff fires when a new dead-letter lands.
 * The replay transition (`waiting → recovered`) does NOT bump it (it stamps
 * `recovered_at`); the `defaultFilter` is what hides recovered rows on the
 * default page, NOT a version-column trick.
 */
export const DEAD_LETTERS_DESCRIPTOR: CollectionDescriptor = {
  name: "dead_letters",
  table: "dead_letters",
  columns: [
    "dl_id",
    "session_id",
    "hook_event",
    "ts",
    "dl_written_at",
    "pid",
    "bindings",
    "status",
    "recovered_at",
    "replayed_event_id",
    "source_file",
  ],
  pk: "dl_id",
  version: "dl_written_at",
  sortable: new Set([
    "dl_written_at",
    "ts",
    "recovered_at",
    "hook_event",
    "session_id",
  ]),
  defaultSort: { column: "dl_written_at", dir: "asc" },
  filters: {
    dl_id: "dl_id",
    status: "status",
    session_id: "session_id",
    hook_event: "hook_event",
  },
  // Default scope: hide already-recovered rows so the warn-count tracks the
  // live backlog. An explicit `status` filter overrides; a pk subscribe is
  // exempt.
  defaultFilter: { status: "waiting" },
  jsonColumns: new Set(["bindings"]),
};

/**
 * The `dispatch_failures` descriptor — the reconciler's sticky-failure surface,
 * one row per `(verb, id)` dispatch stamped failed and not yet cleared via a
 * `retry_dispatch` RPC. A reducer projection (re-fold rebuilds it
 * byte-identically). Composite pk `(verb, id)`, but `pk` expects a single
 * column, so `verb` carries the wire identity and `id` rides in `columns` /
 * `filters`. `verb` is a tiny class (`work` / `close`), so the DIFF path keys
 * by the composite `liveKeyColumns` `(verb, id)` — otherwise two same-verb
 * rows (e.g. two `worktree-finalize:<epic>-<hash>` closes) would collapse to
 * one watched/version/patch slot and only one live pill would surface on
 * `board --watch`.
 */
export const DISPATCH_FAILURES_DESCRIPTOR: CollectionDescriptor = {
  name: "dispatch_failures",
  table: "dispatch_failures",
  columns: [
    "verb",
    "id",
    "reason",
    "dir",
    "ts",
    "last_event_id",
    "created_at",
    "updated_at",
    "merge_escalated_at",
    "resolver_dispatched_at",
    "human_notified_at",
  ],
  pk: "verb",
  liveKeyColumns: ["verb", "id"],
  version: "last_event_id",
  sortable: new Set(["verb", "id", "ts", "created_at", "updated_at"]),
  defaultSort: { column: "ts", dir: "desc" },
  filters: {
    verb: "verb",
    id: "id",
    reason: "reason",
  },
  jsonColumns: new Set(),
};

/**
 * The `autopilot_state` singleton descriptor — the worker's paused/playing flag
 * (plus cap + mode) as a wire-readable collection so `keeper autopilot`'s banner
 * reflects the worker's real state. One row at most (`id = 1`).
 */
export const AUTOPILOT_STATE_DESCRIPTOR: CollectionDescriptor = {
  name: "autopilot_state",
  table: "autopilot_state",
  columns: [
    "id",
    "paused",
    "last_event_id",
    "created_at",
    "updated_at",
    // Global concurrency cap, rendered from the socket ONLY (never config.yaml).
    // NULL = unlimited → `∞`.
    "max_concurrent_jobs",
    // Autopilot mode enum (`'yolo'` | `'armed'`), defaulting `'yolo'` on a
    // zero-event / pre-existing row.
    "mode",
    // Per-root dispatch concurrency count, served so the board resolves the SAME
    // per-root slot count the reconciler dispatches against. NULL = the in-memory
    // DEFAULT_MAX_CONCURRENT_PER_ROOT (= 1).
    "max_concurrent_per_root",
    // Durable worktree-mode toggle (INTEGER 0/1), served so the banner reflects
    // the real durable state. NOT a jsonColumn — decoding a scalar as JSON corrupts it.
    "worktree_mode",
    // Durable multi-repo worktree rollout flag (INTEGER 0/1), read by the
    // reconciler's `classifyWorktreeRepos` partition each cycle. NOT a jsonColumn.
    "worktree_multi_repo",
    // Durable codex rollout-adoption knob (INTEGER 0/1, DEFAULT NULL/absent =
    // OFF), served so `keeper query autopilot_state` reflects the real durable
    // state. NOT a jsonColumn — decoding a scalar as JSON corrupts it.
    "codex_adoption",
  ],
  pk: "id",
  version: "last_event_id",
  sortable: new Set(["id", "last_event_id", "created_at", "updated_at"]),
  defaultSort: { column: "id", dir: "asc" },
  filters: {
    id: "id",
  },
  jsonColumns: new Set(),
};

/**
 * The `armed_epics` descriptor — the per-epic armed PRESENCE table the
 * autopilot's `armed` mode reads each reconcile cycle (a row's presence means
 * armed). Registering it here is what makes the table subscribable over the UDS
 * socket.
 */
export const ARMED_EPICS_DESCRIPTOR: CollectionDescriptor = {
  name: "armed_epics",
  table: "armed_epics",
  columns: ["epic_id", "last_event_id", "created_at", "updated_at"],
  pk: "epic_id",
  version: "last_event_id",
  sortable: new Set(["epic_id", "last_event_id", "created_at", "updated_at"]),
  defaultSort: { column: "created_at", dir: "desc" },
  filters: {
    epic_id: "epic_id",
  },
  jsonColumns: new Set(),
};

/**
 * The `pending_dispatches` descriptor — the durable launch-window
 * double-dispatch suppression substrate: one row per `(verb, id)` dispatch the
 * reconciler minted a `Dispatched` event for and that has not yet been
 * discharged (SessionStart bind, `DispatchFailed`, or the TTL sweep's
 * `DispatchExpired`). The dedup source of truth the reconciler reads in its
 * readiness pass; a reducer projection. Composite pk `(verb, id)` → `verb`
 * carries the wire identity, `id` rides in `columns` / `filters`.
 */
export const PENDING_DISPATCHES_DESCRIPTOR: CollectionDescriptor = {
  name: "pending_dispatches",
  table: "pending_dispatches",
  columns: ["verb", "id", "dir", "dispatched_at", "last_event_id"],
  pk: "verb",
  version: "last_event_id",
  sortable: new Set(["verb", "id", "dispatched_at", "last_event_id"]),
  defaultSort: { column: "dispatched_at", dir: "desc" },
  filters: {
    verb: "verb",
    id: "id",
  },
  jsonColumns: new Set(),
};

/**
 * The `builds` descriptor — one row per registered buildbot builder, keyed by
 * builder NAME (`project`). A reducer projection produced by synthetic
 * `BuildSnapshot` / `BuildDeleted` events; the `keeper builds` dashboard
 * subscribes over the socket. All scalar columns (no JSON). `version:
 * 'last_event_id'` so the diff fires on every fold; default sort is stable by
 * pk so the dashboard renders builders alphabetically.
 */
export const BUILDS_DESCRIPTOR: CollectionDescriptor = {
  name: "builds",
  table: "builds",
  columns: [
    "project",
    "builder_id",
    "build_number",
    "complete",
    "results",
    "state_string",
    "started_at",
    "complete_at",
    "last_event_id",
    "updated_at",
  ],
  pk: "project",
  version: "last_event_id",
  sortable: new Set([
    "project",
    "build_number",
    "results",
    "last_event_id",
    "updated_at",
  ]),
  defaultSort: { column: "project", dir: "asc" },
  filters: { project: "project" },
  jsonColumns: new Set(),
};

/**
 * The `block_escalations` descriptor (fn-941) — the daemon block-escalation
 * producer's escalate-once LATCH, one row per blocked plan task keyed by
 * `(epic_id, task_id)`. A reducer projection (re-fold rebuilds it
 * byte-identically). `task_id` carries the wire identity; `epic_id` rides in
 * `columns` / `filters`. Registering it here is what makes the latch
 * subscribable over the UDS socket so the board renders an escalated-blocked
 * task distinctly and `keeper await` reads the escalation-in-flight signal.
 */
export const BLOCK_ESCALATIONS_DESCRIPTOR: CollectionDescriptor = {
  name: "block_escalations",
  table: "block_escalations",
  columns: [
    "task_id",
    "epic_id",
    "blocked_since",
    "status",
    "outcome",
    "last_event_id",
    "human_notified_at",
  ],
  pk: "task_id",
  version: "last_event_id",
  sortable: new Set(["task_id", "epic_id", "blocked_since", "last_event_id"]),
  defaultSort: { column: "blocked_since", dir: "desc" },
  filters: {
    task_id: "task_id",
    epic_id: "epic_id",
    status: "status",
  },
  jsonColumns: new Set(),
};

/**
 * The `handoffs` descriptor — one row per `keeper handoff` enqueue, keyed on
 * `handoff_id`. A DETERMINISTIC-replayed reducer projection (`HandoffRequested`
 * → row + the dispatcher's transactional-outbox lifecycle). Registering it here
 * is what lets `keeper handoff show <id>` read the stored `doc` body over the
 * UDS socket and the board read the edge. `doc` is the contextful brief the
 * dispatched fire-and-forget worker reads back. All scalar columns (no JSON).
 */
export const HANDOFFS_DESCRIPTOR: CollectionDescriptor = {
  name: "handoffs",
  table: "handoffs",
  columns: [
    "handoff_id",
    "status",
    "doc",
    "title",
    "target_session",
    "target_dir",
    "initiator_session",
    "initiator_pane",
    "initiator_job_id",
    "callee_job_id",
    "claimed_at",
    "never_bound_count",
    "last_event_id",
  ],
  pk: "handoff_id",
  version: "last_event_id",
  sortable: new Set(["handoff_id", "status", "claimed_at", "last_event_id"]),
  defaultSort: { column: "handoff_id", dir: "asc" },
  filters: {
    handoff_id: "handoff_id",
    status: "status",
    initiator_job_id: "initiator_job_id",
    callee_job_id: "callee_job_id",
  },
  jsonColumns: new Set(),
};

/**
 * The `tmux_client_focus` singleton descriptor (fn-952) — the persistent
 * `tmux -C` control worker's live-only view of which session/window/pane the
 * current real (non-control) tmux client is focused on. One row at most
 * (`id = 1`, last-write-wins UPSERT). Modeled on `AUTOPILOT_STATE_DESCRIPTOR`:
 * single-row singleton, `version: 'last_event_id'` so the diff fires on every
 * fold, unbounded page limit (the page can only ever hold the one row). The
 * `keeper jobs` banner subscribes over the socket and renders the focus pill; an
 * empty / never-populated table returns `rows: []` so the no-tmux env still
 * first-paints.
 */
export const TMUX_CLIENT_FOCUS_DESCRIPTOR: CollectionDescriptor = {
  name: "tmux_client_focus",
  table: "tmux_client_focus",
  columns: [
    "id",
    "status",
    "generation_id",
    "session_name",
    "window_index",
    "pane_id",
    "last_event_id",
    "updated_at",
  ],
  pk: "id",
  version: "last_event_id",
  sortable: new Set(["id", "last_event_id", "updated_at"]),
  defaultSort: { column: "id", dir: "asc" },
  filters: {
    id: "id",
  },
  jsonColumns: new Set(),
};

/**
 * The `worktree_repo_status` descriptor (fn-1013) — the LIVE-ONLY operator
 * surface for the per-epic worktree-eligibility verdict. One row per epic the
 * autopilot reconciler marked `disabled` (a not-worktree-friendly repo → serial
 * shared-checkout dispatch), folded from a synthetic `WorktreeRepoStatus` event.
 * `keeper autopilot` subscribes over the socket and renders a neutral
 * `--- worktree ---` section DISTINCT from the red failed / dispatch-failures
 * block; an empty / pre-first-cycle table returns `rows: []` so the section
 * renders nothing. `version: 'last_event_id'` so the diff fires on every fold.
 */
export const WORKTREE_REPO_STATUS_DESCRIPTOR: CollectionDescriptor = {
  name: "worktree_repo_status",
  table: "worktree_repo_status",
  columns: [
    "epic_id",
    "repo_dir",
    "mode",
    "reason",
    "last_event_id",
    "updated_at",
  ],
  pk: "epic_id",
  version: "last_event_id",
  sortable: new Set([
    "epic_id",
    "repo_dir",
    "mode",
    "last_event_id",
    "updated_at",
  ]),
  defaultSort: { column: "epic_id", dir: "asc" },
  filters: { epic_id: "epic_id", mode: "mode" },
  jsonColumns: new Set(),
};

/**
 * The `lane_merged` descriptor — the LIVE-ONLY merge-landed observable.
 * One row per epic whose worktree lane branch (`keeper/epic/<id>`) the autopilot
 * reconciler probed as merged into the LOCAL default branch (ancestor-of-default,
 * or torn-down after the merge), folded from a synthetic `LaneMerged` event the
 * worker posts when the merged set changes. Registering it here is what makes the
 * table subscribable over the UDS socket so `keeper await landed` and `keeper
 * status` can read the durable signal; an empty / pre-first-cycle table returns
 * `rows: []`. `version: 'last_event_id'` so the diff fires on every fold. Mirrors
 * {@link WORKTREE_REPO_STATUS_DESCRIPTOR}.
 */
export const LANE_MERGED_DESCRIPTOR: CollectionDescriptor = {
  name: "lane_merged",
  table: "lane_merged",
  columns: ["epic_id", "repo_dir", "last_event_id", "updated_at"],
  pk: "epic_id",
  version: "last_event_id",
  sortable: new Set(["epic_id", "repo_dir", "last_event_id", "updated_at"]),
  defaultSort: { column: "epic_id", dir: "asc" },
  filters: { epic_id: "epic_id" },
  jsonColumns: new Set(),
};

/** The registry, keyed by wire-facing collection name. */
export const REGISTRY: Map<string, CollectionDescriptor> = new Map([
  [JOBS_DESCRIPTOR.name, JOBS_DESCRIPTOR],
  [EPICS_DESCRIPTOR.name, EPICS_DESCRIPTOR],
  [EPICS_RECENT_DONE_DESCRIPTOR.name, EPICS_RECENT_DONE_DESCRIPTOR],
  [EPICS_PINNED_DESCRIPTOR.name, EPICS_PINNED_DESCRIPTOR],
  [GIT_DESCRIPTOR.name, GIT_DESCRIPTOR],
  [SUBAGENT_INVOCATIONS_DESCRIPTOR.name, SUBAGENT_INVOCATIONS_DESCRIPTOR],
  [SCHEDULED_TASKS_DESCRIPTOR.name, SCHEDULED_TASKS_DESCRIPTOR],
  [USAGE_DESCRIPTOR.name, USAGE_DESCRIPTOR],
  [PROFILES_DESCRIPTOR.name, PROFILES_DESCRIPTOR],
  [DEAD_LETTERS_DESCRIPTOR.name, DEAD_LETTERS_DESCRIPTOR],
  [DISPATCH_FAILURES_DESCRIPTOR.name, DISPATCH_FAILURES_DESCRIPTOR],
  [AUTOPILOT_STATE_DESCRIPTOR.name, AUTOPILOT_STATE_DESCRIPTOR],
  [PENDING_DISPATCHES_DESCRIPTOR.name, PENDING_DISPATCHES_DESCRIPTOR],
  [ARMED_EPICS_DESCRIPTOR.name, ARMED_EPICS_DESCRIPTOR],
  [BUILDS_DESCRIPTOR.name, BUILDS_DESCRIPTOR],
  [BLOCK_ESCALATIONS_DESCRIPTOR.name, BLOCK_ESCALATIONS_DESCRIPTOR],
  [HANDOFFS_DESCRIPTOR.name, HANDOFFS_DESCRIPTOR],
  [TMUX_CLIENT_FOCUS_DESCRIPTOR.name, TMUX_CLIENT_FOCUS_DESCRIPTOR],
  [WORKTREE_REPO_STATUS_DESCRIPTOR.name, WORKTREE_REPO_STATUS_DESCRIPTOR],
  [LANE_MERGED_DESCRIPTOR.name, LANE_MERGED_DESCRIPTOR],
]);

/** Resolve a collection name to its descriptor, or `undefined` if unknown. */
export function getCollection(name: string): CollectionDescriptor | undefined {
  return REGISTRY.get(name);
}

/**
 * Read-allowlist for `keeper query <collection>` — the curated set of
 * collection names an agent may one-shot read off the daemon. A DELIBERATE gate
 * distinct from the full {@link REGISTRY}: an off-allowlist name is rejected at
 * the CLI's parse time (exit 1 usage) BEFORE any daemon round-trip, so adding a
 * registry collection never auto-exposes it to the query CLI. There is no
 * `safe-to-expose` flag on the descriptor, so the allowlist is authored here as
 * its own constant. Every entry MUST also be a `REGISTRY` key — asserted in
 * `test/status.test.ts` so a typo here fails loudly rather than always-rejecting.
 */
export const QUERY_READ_ALLOWLIST: ReadonlySet<string> = new Set([
  "epics",
  "jobs",
  "git",
  "subagent_invocations",
  "scheduled_tasks",
  "dead_letters",
  "dispatch_failures",
  "autopilot_state",
  "pending_dispatches",
  "armed_epics",
  "builds",
  "block_escalations",
  "handoffs",
  "tmux_client_focus",
  "worktree_repo_status",
  "lane_merged",
  "profiles",
  "usage",
]);

/** Whether `name` is on the {@link QUERY_READ_ALLOWLIST} for `keeper query`. */
export function isQueryAllowed(name: string): boolean {
  return QUERY_READ_ALLOWLIST.has(name);
}

/**
 * The delimiter joining a composite live-key's columns. `char(31)` (ASCII unit
 * separator) never appears in a keeper verb / id / epic-id, so the SQL-side
 * `col || char(31) || col` and the JS-side `join("")` produce the SAME
 * bytes — the watched set (JS), the version-probe SELECT alias (SQL), the diff
 * fan-out index (JS), and the membership token (SQL) all agree on one identity.
 */
const LIVE_KEY_DELIM = "";

/**
 * The SQL expression yielding a row's live-diff identity: the composite
 * `col || char(31) || col …` when `liveKeyColumns` is set, else the single `pk`
 * column verbatim. Trusted descriptor constants only (the injection invariant),
 * so it is safe to interpolate wherever the diff path keys watched membership,
 * the version probe, or the membership token. Byte-identical to `descriptor.pk`
 * for every single-pk collection, so their generated SQL is unchanged.
 */
export function liveKeyExpr(descriptor: CollectionDescriptor): string {
  const cols = descriptor.liveKeyColumns;
  if (!cols || cols.length === 0) {
    return descriptor.pk;
  }
  return cols.join(" || char(31) || ");
}

/**
 * A row's live-diff identity string, byte-identical to {@link liveKeyExpr}'s SQL
 * output (same `` delimiter). Mirrors the SQL keying on the JS side — the
 * seed `watched`/`lastSent` maps and the diff `byId` fan-out index — so the two
 * halves of the diff never disagree on which row a key names. Falls back to
 * `String(row[pk])` for a single-pk collection (unchanged behavior).
 */
export function liveKeyOf(descriptor: CollectionDescriptor, row: Row): string {
  const cols = descriptor.liveKeyColumns;
  if (!cols || cols.length === 0) {
    return String(row[descriptor.pk]);
  }
  return cols.map((c) => String(row[c])).join(LIVE_KEY_DELIM);
}

/**
 * Read a set of rows by primary key. Empty-set short-circuits to `[]` (a bare
 * `IN ()` is a SQL syntax error); over `MAX_IN_PARAMS` throws ("chunk the
 * caller"). Returns rows in SQLite's emission order (NOT input order). Trusted
 * identifiers interpolated, ids bound (`?`). Keys by {@link liveKeyExpr} so a
 * composite-identity collection matches the same ids its diff watches.
 */
export function selectByIds(
  db: Database,
  descriptor: CollectionDescriptor,
  ids: readonly string[],
): Row[] {
  if (ids.length === 0) {
    return [];
  }
  if (ids.length > MAX_IN_PARAMS) {
    throw new Error(
      `selectByIds: id-set of ${ids.length} exceeds SQLITE_MAX_VARIABLE_NUMBER (${MAX_IN_PARAMS}); chunk the caller`,
    );
  }
  const placeholders = ids.map(() => "?").join(",");
  const sql = `
    SELECT ${descriptor.columns.join(", ")}
      FROM ${descriptor.table}
     WHERE ${liveKeyExpr(descriptor)} IN (${placeholders})
  `;
  // Per-call prepare: the statement shape is arity-dependent and page sizes are
  // small (capped well below MAX_IN_PARAMS), so compile cost is negligible.
  const stmt = db.prepare(sql);
  const rows = stmt.all(...ids) as Row[];
  // Decode any JSON-TEXT columns so the diff/patch path serves the same shape
  // as the page SELECT in `runQuery` (a no-op while `jsonColumns` is empty).
  return rows.map((row) => decodeRow(descriptor, row));
}

/**
 * Read JUST the `(pk, version)` pair for a set of rows — `diffTick`'s
 * version-probe-first pass, which drives the conditional full-row `selectByIds`
 * ONLY when something changed. The two reads can race a writer commit between
 * them (same read-snapshot drift class as elsewhere; self-correcting next tick).
 * Mirrors `selectByIds`'s prelude (empty → empty Map, over-cap throw, per-call
 * prepare). The `Map<string, number | null>` value shape future-proofs against
 * a descriptor making `version` nullable.
 */
export function selectVersionsByIds(
  db: Database,
  descriptor: CollectionDescriptor,
  ids: readonly string[],
): Map<string, number | null> {
  if (ids.length === 0) {
    return new Map();
  }
  if (ids.length > MAX_IN_PARAMS) {
    throw new Error(
      `selectVersionsByIds: id-set of ${ids.length} exceeds SQLITE_MAX_VARIABLE_NUMBER (${MAX_IN_PARAMS}); chunk the caller`,
    );
  }
  const placeholders = ids.map(() => "?").join(",");
  const sql = `
    SELECT ${liveKeyExpr(descriptor)} AS pk, ${descriptor.version} AS version
      FROM ${descriptor.table}
     WHERE ${liveKeyExpr(descriptor)} IN (${placeholders})
  `;
  const stmt = db.prepare(sql);
  const rows = stmt.all(...ids) as { pk: unknown; version: number | null }[];
  const map = new Map<string, number | null>();
  for (const r of rows) {
    map.set(String(r.pk), r.version);
  }
  return map;
}

/**
 * Caller-side chunking wrappers for {@link selectByIds} /
 * {@link selectVersionsByIds}, which throw past `MAX_IN_PARAMS`. `diffTick`
 * watches WHOLE collections, so a collection over the cap would blow SQLite's
 * bound-variable limit and crash-loop the daemon. These split into
 * `MAX_IN_PARAMS`-sized batches and merge (array form preserves batch order;
 * map form is a disjoint union — pks are unique). Sub-cap calls pass straight
 * through.
 */
export function selectByIdsChunked(
  db: Database,
  descriptor: CollectionDescriptor,
  ids: readonly string[],
): Row[] {
  if (ids.length <= MAX_IN_PARAMS) {
    return selectByIds(db, descriptor, ids);
  }
  const out: Row[] = [];
  for (let i = 0; i < ids.length; i += MAX_IN_PARAMS) {
    const batch = selectByIds(db, descriptor, ids.slice(i, i + MAX_IN_PARAMS));
    for (const row of batch) out.push(row);
  }
  return out;
}

export function selectVersionsByIdsChunked(
  db: Database,
  descriptor: CollectionDescriptor,
  ids: readonly string[],
): Map<string, number | null> {
  if (ids.length <= MAX_IN_PARAMS) {
    return selectVersionsByIds(db, descriptor, ids);
  }
  const merged = new Map<string, number | null>();
  for (let i = 0; i < ids.length; i += MAX_IN_PARAMS) {
    const batch = selectVersionsByIds(
      db,
      descriptor,
      ids.slice(i, i + MAX_IN_PARAMS),
    );
    for (const [pk, version] of batch) merged.set(pk, version);
  }
  return merged;
}

/**
 * Decode a row's JSON-TEXT columns at the read boundary so the wire frame serves
 * arrays/objects, not JSON strings. A NULL/empty cell or parse failure falls
 * back to `[]` (one bad row never wedges a reader). Returns a new row.
 *
 * MUST be called at BOTH row-producing reads (the page SELECT and `selectByIds`
 * on the diff path) so `result` and `patch` frames agree on the decoded shape.
 */
export function decodeRow(descriptor: CollectionDescriptor, row: Row): Row {
  if (descriptor.jsonColumns.size === 0) {
    return row;
  }
  const out: Row = { ...row };
  for (const col of descriptor.jsonColumns) {
    const raw = out[col];
    if (typeof raw === "string" && raw.length > 0) {
      try {
        out[col] = JSON.parse(raw);
        continue;
      } catch {
        // fall through to the [] fallback
      }
    }
    // NULL preservation: for nullable JSON columns (e.g. `resolved_epic_deps`)
    // NULL is load-bearing — "not-yet-computed", DISTINCT from a stored `'[]'`.
    // Preserve `null` so clients can branch on it; an unparseable/empty string
    // still falls back to `[]` (the schema default for NOT NULL JSON columns).
    out[col] = raw === null || raw === undefined ? null : [];
  }
  return out;
}

/** A filtered set's size + a membership fingerprint over its live-key identities. */
export interface CountAndToken {
  /** `COUNT(*)` over the full filtered set (the WHERE only — no limit/offset). */
  total: number;
  /**
   * A fingerprint of the matching rows' live-key IDENTITIES (never mutable
   * columns), ordered by that key so it's stable tick-to-tick. Changes iff a
   * row enters/leaves the filtered set (incl. a balanced swap: one in, one out,
   * `total` steady — even two rows sharing a `pk` under a composite live key).
   * The empty set normalizes to `""` so it compares cleanly against a populated
   * set's token.
   */
  token: string;
}

/**
 * Compute a filtered set's `total` plus a membership `token` in ONE query. The
 * caller passes the SAME `whereClause` + `params` that built the page SELECT so
 * the count can never drift from the page.
 *
 * The token is `group_concat` over the matching rows' live-key identities
 * ({@link liveKeyExpr} — the composite `(verb, id)` for `dispatch_failures`, the
 * bare `pk` otherwise). The inner `ORDER BY` on that same key is REQUIRED:
 * `group_concat` order is otherwise plan-dependent, and an unstable token fires
 * phantom `meta` frames every tick. Ordering by the identity (not the display
 * sort) keeps it a pure membership fingerprint. Zero rows → `NULL`, normalized
 * to `""` for a clean-diffing empty set.
 */
export function countAndToken(
  db: Database,
  descriptor: CollectionDescriptor,
  whereClause: string,
  params: readonly (string | number)[],
): CountAndToken {
  const sql = `
    SELECT COUNT(*) AS n, group_concat(k) AS token
      FROM (
        SELECT ${liveKeyExpr(descriptor)} AS k
          FROM ${descriptor.table}
          ${whereClause}
         ORDER BY k
      )
  `;
  const row = db.prepare(sql).get(...params) as {
    n: number;
    token: string | null;
  };
  return { total: row.n, token: row.token ?? "" };
}
