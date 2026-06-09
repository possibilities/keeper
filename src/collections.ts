/**
 * Collection registry for the keeper read surface. The UDS subscribe server
 * (`src/server-worker.ts`) used to hardcode `jobs` at every layer — the SQL
 * (`FROM jobs`), the sort allowlist, the filter branches, and the diff key
 * (`job_id` / `last_event_id`). This module pulls everything collection-specific
 * into a `CollectionDescriptor` so `runQuery` / `diffTick` route by collection
 * name instead. Two collections register today — `jobs` and `epics` (each epic
 * embeds its tasks + plan/close jobs as JSON-array columns, and as of schema
 * v13 carries `approval` as a real column). Adding a future collection is one
 * more `REGISTRY` entry with zero wire-protocol or diff-machinery change.
 *
 * Cross-refs:
 * - `src/db.ts` — owns `MAX_IN_PARAMS` (reused here, not redefined) and the
 *   schema the descriptors describe.
 * - `src/protocol.ts` — the wire frames carry the `collection` name resolved
 *   against this registry; `Row` is the generic served-row shape on the frames.
 * - `src/server-worker.ts` — the sole consumer: `getCollection` + `selectByIds`.
 *
 * INJECTION INVARIANT: every interpolated SQL identifier (table, columns, pk,
 * sort column) comes from a descriptor here — trusted constants, never wire
 * text. Wire `filter` *keys* are resolved against `descriptor.filters` by map
 * lookup (never interpolated); `filter` *values* and limit/offset stay bound.
 */

import type { Database } from "bun:sqlite";
import { MAX_IN_PARAMS } from "./db";
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
 * - `pk` — the primary-key column; the diff keys watched membership by it.
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
 *   filter is entirely empty (and the lookup is not a pk lookup, which is
 *   exempt from defaults). Used for predicates that can't be expressed as
 *   per-key ANDs — e.g. epics default to materialized-open via the
 *   `default_visible = 1` generated-column clause. The `sql` string is
 *   interpolated verbatim into the WHERE so
 *   columns / operators are the descriptor author's responsibility; `params`
 *   are bound. ANY explicit wire filter drops the whole clause (the wire is
 *   the user's "I know what I want" override). Distinct from `defaultFilter`
 *   so per-key wins still apply where they make sense; the two can coexist.
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
  version: string;
  sortable: ReadonlySet<string>;
  defaultSort: { column: string; dir: "asc" | "desc" };
  filters: Readonly<Record<string, string>>;
  defaultFilter?: Readonly<Record<string, FilterValue>>;
  defaultClause?: { sql: string; params: readonly (string | number)[] };
  jsonColumns: ReadonlySet<string>;
}

/**
 * The `jobs` descriptor — the first collection. Mirrors what `runQuery` /
 * `diffTick` / `selectJobsByIds` hardcoded before namespacing: the current
 * SELECT list, the `SORTABLE_COLUMNS` allowlist, the `created_at desc` default
 * (newest-created job on top), and the `state`/`cwd` filters PLUS `job_id` (the
 * pk — for detail-page single-item subscribe). The default scope hides `ended`
 * jobs (`defaultFilter` below).
 */
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
    // Schema v52 / fn-686: paired permission-prompt / elicitation
    // annotation. Mirrors the v25 input-request pair shape — read by
    // the board renderer's `permissionPromptPillSeg` to draw the
    // `[awaiting:permission]` / `[awaiting:elicitation]` continuation
    // pill on top of the live `[working]` state. Display-only; OUT of
    // `sortable` / `filters` / `jsonColumns`.
    "last_permission_prompt_at",
    "last_permission_prompt_kind",
    "git_dirty_count",
    // Schema v31: the legacy `git_orphan_count` (schema v28 — "files-not-
    // attributed-to-a-live-session") is renamed to
    // `git_unattributed_to_live_count` under the new vocabulary. The fresh
    // `git_orphan_count` carries the new strict-mystery semantic (files
    // with no attribution from any session — past or present), populated
    // by the new reducer fold in fn-633.6. Both columns ride here as
    // INTEGER NOT NULL DEFAULT 0; neither is in `sortable` / `filters`
    // (display + readiness-predicate inputs only).
    "git_unattributed_to_live_count",
    "git_orphan_count",
    // Schema v36: `profile_name` — the derived `projectBasename(config_dir)`
    // stamped onto the row by the reducer's SessionStart fold (NULL when the
    // session ran under the default `~/.claude` profile). Served for display
    // (the usage surface's "recent sessions" log labels each job by profile);
    // OUT of `sortable` / `filters` / `jsonColumns` (a scalar the renderer
    // reads, never a sort/filter key).
    "profile_name",
    // Schema v48 / fn-668: backend-exec coordinates — the terminal-multiplexer
    // location the session lives in. `backend_exec_{type,session_id,pane_id}`
    // are captured by the hook on every event as pure `process.env` reads
    // (`ZELLIJ` / `ZELLIJ_SESSION_NAME` / `ZELLIJ_PANE_ID`) and folded onto
    // the row latest-non-NULL-wins via COALESCE. Generic `backend_exec_*`
    // naming lets a future tmux/wezterm backend slot in without a schema
    // change. Display-only — OUT of `sortable` / `filters` / `jsonColumns`.
    // `projectJobRow` composes the three into one present-only dim segment so
    // absent coords render as nothing.
    "backend_exec_type",
    "backend_exec_session_id",
    "backend_exec_pane_id",
    // Schema v51 / fn-682: `monitors` — JSON-TEXT array of live monitor
    // entries snapshot-replaced on each Stop. Rendered by `cli/jobs.ts`'s
    // expanded block via `monitorLinesFor`, which parses the raw JSON
    // string itself, so this stays a raw TEXT scalar at the wire layer —
    // OUT of `sortable` / `filters` / `jsonColumns` (display-only, same
    // pattern as `profile_name` and the `backend_exec_*` cluster).
    "monitors",
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
  // Default scope: a jobs query with no `state` filter shows only LIVE jobs —
  // working ("running") + stopped — and hides BOTH terminal states (`ended` and
  // `killed`). Job state is exactly working|stopped|ended|killed (see the
  // reducer), so `state NOT IN ("ended", "killed")` is precisely "stopped and
  // running". A client still pages terminal rows by asking explicitly
  // (`filter:{state:"ended"}` or `filter:{state:"killed"}`, or a custom
  // `{in:[...]}`/`{not_in:[...]}` set), which overrides this default; a pk
  // subscribe is exempt (a detail read of an ended/killed job still resolves).
  defaultFilter: { state: { not_in: ["ended", "killed"] } },
  // `title` + `title_source` + `transcript_path` + `plan_verb` + `plan_ref`
  // are read-only display this phase — served on `result`/`patch` (the
  // source/path for provenance + debugging, the planctl verb/ref pair for
  // associating jobs with epics/tasks) but NOT in `sortable`/`filters`. A
  // future client query (e.g. "subscribe to all jobs for epic X") would add
  // `plan_ref` to `filters` and rely on the partial `idx_jobs_plan_ref`
  // index added in schema v10. `epic_links` (schema v14) is the same shape:
  // a JSON-TEXT array decoded at the read boundary for display only — the
  // creator/refiner cross-references the reducer's `syncPlanctlLinks`
  // fan-out maintains for each job's planctl footprint.
  jsonColumns: new Set(["epic_links"]),
};

/**
 * The `epics` descriptor — the plans read surface's first collection. Columns
 * mirror the `epics` table 1:1 (`src/db.ts` `CREATE_EPICS`). `version` is
 * `last_event_id` (the monotonic per-row column the diff fires on, bumped by
 * the snapshot fold). `filters` carries the pk (`epic_id` — detail-page
 * single-item subscribe) plus the natural filter columns `status` +
 * `project_dir`. `title`/`epic_number` are read-only display —
 * served but out of `sortable`/`filters`. `project_dir` holds opaque foreign-
 * process JSON; it's a bound filter VALUE here, never an interpolated
 * identifier or a filesystem-read driver.
 *
 * As of schema v7 each epic embeds its tasks as the `tasks` JSON-array column —
 * the standalone `tasks` collection was dropped. `tasks` is served (in
 * `columns`) AND registered in `jsonColumns` so {@link decodeRow} parses the
 * stored TEXT into a real `Task[]` at the read boundary; it is OUT of
 * `sortable`/`filters` (a nested display array, never a sort/filter key).
 *
 * Default sort: schema v29 flips this from `epic_number asc` to `sort_path
 * asc`. `sort_path` is the materialized-path key the reducer derives in
 * `syncPlanctlLinks` (zero-padded-6 dotted lexicographic, like
 * `"000003.000007"`). The dot (ASCII 46) sits strictly below the digits
 * (ASCII 48-57), so under SQLite BINARY collation the prefix-sort invariant
 * `"000003" < "000003.000007" < "000004"` slots a closer-created child
 * directly after its parent and before the next peer epic. This is a
 * MEANINGFUL change from the v6-through-v28 stance: closer-completion DOES
 * reorder the page, by design — the moment a child epic is created from a
 * closer session, it appears one row below the closed parent. The previous
 * rationale ("`epic_number` never reorders, so a task edit can't churn the
 * page") still holds for ordinary edits (task-snapshot folds don't touch
 * `created_by_closer_of` or `sort_path`); only the closer-creation event
 * itself triggers a reorder, which is the explicitly desired behavior.
 *
 * `sort_path` is added to `sortable` (the trust-boundary allowlist for
 * ORDER BY interpolation in `src/server-worker.ts`). `created_by_closer_of`
 * is served as a column but stays OUT of `sortable` / `filters` —
 * downstream consumers (board's `[slotted-after-closer]` pill, future
 * filters) branch on its null-ness, not its value, so a wire filter slot
 * would be cosmetic.
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
    // `last_validated_at` (schema v16) — plain nullable TEXT (ISO-8601 when
    // set). Served verbatim on `result`/`patch`; out of `sortable` /
    // `filters` (display-only this phase) and out of `jsonColumns` (a
    // scalar string, NOT JSON — decoding it would fall back to `[]` and
    // corrupt the wire value).
    "last_validated_at",
    // Schema v29: closer-creator link + materialized-path sort key. Both
    // reducer-derived inside `syncPlanctlLinks` (see `src/reducer.ts`).
    // `created_by_closer_of` is plain nullable TEXT; `sort_path` is TEXT
    // NOT NULL DEFAULT ''. Both served verbatim on `result`/`patch` and
    // out of `jsonColumns` (scalar strings). `sort_path` lands in
    // `sortable` below (driving the new default ORDER BY);
    // `created_by_closer_of` stays out (downstream branches on its
    // null-ness, not its value).
    "created_by_closer_of",
    "sort_path",
    // Schema v30: `queue_jump` — priority-jump flag projected from the
    // `planctl_invocation` envelope's `queue_jump` boolean by
    // `syncPlanctlLinks`. INTEGER NOT NULL DEFAULT 0 at the SQLite layer;
    // dashctl consumers lift to JS boolean (`queue_jump === 1`) at the
    // read boundary. Served verbatim on `result`/`patch`; kept OUT of
    // `sortable` (the `!`-prefix on `sort_path` carries the ordering
    // signal — sorting by `queue_jump` directly would be a redundant
    // wire knob) AND OUT of `filters` (downstream consumers branch on
    // the value cosmetically — e.g. a `[queued]` pill — rather than
    // wire-filter on it). Out of `jsonColumns` (a scalar integer).
    "queue_jump",
    // Schema v34 (fn-637): `resolved_epic_deps` — nullable JSON-TEXT array
    // carrying the resolved + enriched state of `depends_on_epics`. NULL is
    // load-bearing — it means "not-yet-computed" and is DISTINCT from `'[]'`
    // ("computed, no deps"). The reducer's task-.3 forward-stamp populates
    // the column from the shared `resolveEpicDep` helper, projecting the
    // tri-state (`satisfied | blocked-incomplete | dangling`) the autopilot's
    // BlockReason surface and the board summary pill read. Decoded as a
    // jsonColumn at the read boundary — `decodeRow` parses the JSON to a real
    // array when present, returns null when NULL. Out of `sortable` /
    // `filters` (clients branch on element shape, not column value).
    "resolved_epic_deps",
    // Schema v32: `default_visible` — VIRTUAL generated column SQLite
    // computes from `status` on every read, materializing the
    // predicate as a single-column 0/1 value. As of fn-712 (schema v56)
    // the expression carries a `status IS NOT NULL` "epic is materialized"
    // guard; fn-756 (schema v63) dropped the old `approval` branch, so the
    // expression is now `status IS NOT NULL AND status='open'` — a
    // freshly-scaffolded NULL-status shell row (no EpicSnapshot folded
    // yet) is hidden from the default page until it materializes, and a
    // done epic falls off the page. Served on the wire as
    // display-only — clients can SEE it (a debug aid for "would this
    // epic render on the default page?") but MUST NOT filter/sort by
    // it. Out of `sortable` / `filters` / `jsonColumns`: the column is
    // an implementation detail of the descriptor's `defaultClause`, not
    // a domain attribute. The descriptor's defaultClause queries it
    // (`default_visible = 1`); a partial index keyed on the same shape
    // (`idx_epics_default_visible WHERE default_visible = 1`) serves
    // the SEARCH path. See `fn-634-contention-review-tier-4-default-visible`.
    "default_visible",
  ],
  pk: "epic_id",
  version: "last_event_id",
  sortable: new Set([
    "updated_at",
    "last_event_id",
    "epic_id",
    "epic_number",
    "status",
    // Schema v29: the materialized-path sort key. Added to the
    // trust-boundary allowlist so the generic ORDER BY interpolation in
    // `src/server-worker.ts` accepts it as the default sort column.
    "sort_path",
  ]),
  defaultSort: { column: "sort_path", dir: "asc" },
  filters: {
    epic_id: "epic_id",
    status: "status",
    project_dir: "project_dir",
  },
  // Default scope: an epics query with no wire filter shows every
  // MATERIALIZED epic that is OPEN. Open work (live) is what's interesting;
  // done epics fall off the page by default, and (fn-712) so do
  // not-yet-materialized NULL-status shell rows. ANY explicit wire filter —
  // `--status done`, a pk subscribe — drops this clause entirely (the wire
  // is the user's "I know what I want" override).
  //
  // Schema v32 (fn-634): the predicate is materialized as a single VIRTUAL
  // generated column `default_visible` computed by SQLite from `status` on
  // every read (fn-712 added the `status IS NOT NULL` materialized guard to
  // the expression; fn-756 dropped the old `approval` branch), and a partial
  // index `idx_epics_default_visible WHERE default_visible = 1` makes the
  // SEARCH covering — no SCAN, no temp B-tree for the `sort_path ASC,
  // epic_id ASC` ORDER BY. The clause is the literal `default_visible = 1`
  // (NOT a
  // parameterized `default_visible = ?` with `params=[1]`): SQLite's
  // partial-index matcher requires the query's WHERE term to syntactically
  // imply the partial index's WHERE clause, and literal-1 matches literal-1
  // exactly; relying on bound-parameter constant folding to hit the partial
  // index isn't guaranteed across SQLite versions.
  defaultClause: {
    sql: "default_visible = 1",
    params: [],
  },
  // `tasks`, `depends_on_epics`, `jobs`, and `job_links` are JSON-TEXT array
  // columns — decoded to real arrays at the read boundary. `jobs` carries the
  // epic-level `EmbeddedJob[]` (plan/close verbs); `job_links` (schema v14)
  // carries the symmetric per-epic creator/refiner cross-references the
  // reducer's `syncPlanctlLinks` fan-out maintains from planctl-CLI
  // invocation classifier output. Nested `task.jobs` (work-verb jobs on each
  // task element) rides through the `tasks` parse — `decodeRow` returns
  // parsed arrays whose nested objects' nested arrays are already arrays, so
  // no separate `jsonColumns` entry is needed for the nested sub-array. All
  // four are served + decoded but OUT of `sortable`/`filters`.
  jsonColumns: new Set([
    "tasks",
    "depends_on_epics",
    "jobs",
    "job_links",
    // Schema v34 (fn-637): `resolved_epic_deps` is nullable — `decodeRow`
    // returns `null` for a NULL column (the "not-yet-computed" sentinel)
    // and the parsed array when the column carries JSON. Null-vs-empty-array
    // is load-bearing for clients distinguishing "still converging" from
    // "no deps".
    "resolved_epic_deps",
  ]),
};

/**
 * The `git` descriptor — one row per watched git worktree observed by the git
 * worker (membership gate: `.planctl present || dirty || ahead of upstream > 0`,
 * recomputed each reconcile, epic fn-690). The row is a current-status snapshot plus derived per-live-job
 * dirty/orphan buckets. It is produced by synthetic `GitSnapshot` events, so the
 * read surface still rides the normal SQLite subscription machinery.
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
    "branch",
  ]),
  defaultSort: { column: "project_dir", dir: "asc" },
  filters: { project_dir: "project_dir", branch: "branch" },
  jsonColumns: new Set(["dirty_files", "orphaned_files", "jobs"]),
};

/**
 * The `usage` descriptor — one row per agentuse profile observed by the
 * usage worker. The row is a current-state snapshot of one
 * `~/.local/state/agentuse/<id>.json` envelope (target, multiplier, and the
 * two-window session+week percent/reset pair). It is produced by synthetic
 * `UsageSnapshot` / `UsageDeleted` events, so the read surface rides the
 * normal SQLite subscription machinery.
 *
 * **Freshness fields excluded by design.** The source envelope carries
 * `fetched_at` / `next_fetch_at` / `last_successful_fetch_at` /
 * `last_skipped_fetch_at` / `last_failed_fetch_at` (fn-645 added the last
 * one to the set) — these are read-and-discarded by the worker and absent
 * from the projection schema. See `src/usage-worker.ts` for the change-gate
 * discipline that enforces the exclusion. Distinct from `error_at` (also
 * fn-645), which IS projected for "stale since" display but EXCLUDED from
 * the worker change-gate via `usageGateKey` so a re-failed scrape with the
 * same error details produces zero synthetic events.
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
    "last_rate_limit_at",
    "last_rate_limit_session_id",
    "status",
    "subscription_active",
    "error_type",
    "error_message",
    "error_at",
    // Schema v41 (fn-651): rate-limit lift instant + last-successful-fold
    // freshness stamp. Both ride the `UsageSnapshot` percentage path; the
    // rate-limit fan-out carves them out so a RateLimited event cannot
    // clobber a lift or freshness value. `rate_limit_lifts_at` is an
    // ISO-8601 string mirroring `session_resets_at`;
    // `last_usage_fold_at` is the event ts of the last successful fold
    // (renderer compares against wall clock for the freshness warning).
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
 * The `profiles` descriptor (schema v33, fn-639) — one row per Claude profile
 * directory keyed by `config_dir`. Correlates the last `rate_limit` ApiError
 * with each profile so renderers (`scripts/usage.ts`'s "Rate limits by
 * profile" block) can surface profile-level reset state alongside the
 * per-profile usage stacks.
 *
 * Schema lives in `src/db.ts`'s `CREATE_PROFILES`; the population path is
 * the reducer's SessionStart `INSERT OR IGNORE` seed + the dual-case
 * `RateLimited`/`ApiError` arm UPSERT, both inside the existing
 * `BEGIN IMMEDIATE` transaction. `''`-sentinel collapses the default
 * `~/.claude` profile so a single PK groups every NULL-`config_dir` session.
 *
 * `pk: 'config_dir'` matches the table's NOT NULL PRIMARY KEY;
 * `version: 'last_event_id'` so the wire diff fires on every seed-or-upsert
 * write. `defaultSort` stable by pk (mirrors `USAGE_DESCRIPTOR`'s shape).
 * `filters: { config_dir }` lets a renderer page on a specific profile. No
 * `jsonColumns` — every persisted field is a scalar.
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
 * The `subagent_invocations` descriptor — per-job timeline of `Agent` (Task)
 * tool invocations and their `SubagentStart` / `SubagentStop` lifecycle. The
 * peer-table projection lives in schema v17 (`src/db.ts`'s
 * `CREATE_SUBAGENT_INVOCATIONS`) and is populated by the reducer arms in
 * `projectSubagentInvocationsRow` (`src/reducer.ts`). Composite pk
 * `(job_id, agent_id, turn_seq)` — re-entrant subagents within a session land
 * on distinct rows via the per-job monotone `turn_seq` counter.
 *
 * Composite-PK note: the descriptor's `pk` field expects a single column name
 * (the diff-tick membership token + `selectByIds` lookup both index on it).
 * `job_id` is the consumer-meaningful identity for the wire (every
 * subscribe currently filters by `job_id`), so it carries the role; the
 * other two pk columns ride in `columns` for display. A future
 * detail-page subscribe on a single turn would need a composite-pk extension
 * to the descriptor — out of scope for fn-600 (the wire surface here is
 * per-job timeline, not per-turn detail).
 *
 * `version: 'last_event_id'` — the reducer bumps this on every UPDATE so the
 * wire collection's diff fires patch frames as a row transitions
 * `running → ok` and `duration_ms` populates on SubagentStop. `defaultSort:
 * { ts ASC }` matches the chronological reading order. No `defaultFilter` /
 * `defaultClause` — a subscribe returns every per-job row by default, and
 * the UI filters/sorts on the descriptor-exposed columns.
 */
export const SUBAGENT_INVOCATIONS_DESCRIPTOR: CollectionDescriptor = {
  name: "subagent_invocations",
  table: "subagent_invocations",
  // fn-697.2: narrowed from 12 columns to the safe-7 every consumer
  // actually reads — wire render (`collapseSubagentsByName` +
  // `subagentLinesFor` read `{job_id, subagent_type, turn_seq, status,
  // description}` for the ×N/stuck/superseded annotations), readiness
  // predicate-6 (`{job_id, status, ts}`), and the in-process autopilot read
  // (autopilot-worker `loadReconcileSnapshot` → `collapseSubagentsByName`,
  // same read-set). `last_event_id` MUST stay — it's the `version` column
  // the diff (`selectVersionsByIds`) and result re-seed read. Dropped
  // `agent_id, tool_use_id, prompt_chars, duration_ms, updated_at` are read
  // by NO consumer (`countAndToken` reads only `pk`; `selectVersionsByIds`
  // reads `(pk, version)`). Halves the dominant per-frame serialize cost of
  // the ~2005-row subagent set. Wire + in-process only — no SCHEMA_VERSION
  // bump, no keeper-py touch. NOT a row-filter or page (those break render's
  // count/stuck + the byId diff).
  columns: [
    "job_id",
    "subagent_type",
    "turn_seq",
    "ts",
    "status",
    "description",
    "last_event_id",
  ],
  pk: "job_id",
  version: "last_event_id",
  sortable: new Set(["ts", "turn_seq", "duration_ms"]),
  defaultSort: { column: "ts", dir: "asc" },
  filters: { job_id: "job_id" },
  jsonColumns: new Set(),
};

/**
 * The `dead_letters` descriptor (schema v37, fn-643) — one row per dropped
 * hook-INSERT recovered by the daemon's import path. NOT a reducer
 * projection: rows arrive via the daemon scanning per-pid NDJSON files the
 * hook wrote when its `events` INSERT exhausted the bounded retry (see
 * `CREATE_DEAD_LETTERS` in `src/db.ts`). The collection's purpose is the
 * board's persistent yellow warn-count + the replay verb's "oldest waiting
 * first" pick.
 *
 * `defaultFilter: { status: 'waiting' }` scopes the default page to the
 * unrecovered backlog — a board with no wire filter shows the live count
 * and the replay action targets the same set. Recovered rows still exist
 * (the row is the audit trail joining the dead-letter UUID back to the
 * `replayed_event_id`), but they fall off the default page; a client can
 * still subscribe to recovered rows by asking explicitly
 * (`filter:{ status: "recovered" }`) or to the union via `not_in: []`.
 *
 * `pk: 'dl_id'` (the hook-generated UUID, the import-path idempotency key);
 * `version: 'dl_written_at'` so the wire diff fires when a new dead-letter
 * lands (the column is monotonic at the per-pid file level). The replay
 * transition (`waiting → recovered`) does NOT bump `dl_written_at` — it
 * stamps `recovered_at` instead. Both states are read-visible; the
 * `defaultFilter` is what hides recovered rows on the default page, NOT a
 * version-column trick.
 *
 * `defaultSort: { dl_written_at, asc }` matches the replay's "oldest
 * waiting first" pick. `filters` carries the pk + `status` so the board
 * narrows to one row on detail subscribe and a client can page recovered
 * rows explicitly. `bindings` is JSON-TEXT — decoded at the read boundary
 * so the wire serves a real object, not a stringified one (parity with
 * `epics.tasks`, `git.dirty_files`).
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
  // Default scope: hide already-recovered rows so the board's warn-count
  // tracks the live backlog. An explicit wire filter on `status` overrides
  // (e.g. `--status recovered` pages the audit trail; the union via
  // `{not_in: []}` shows both). A pk subscribe (detail page on one
  // `dl_id`) is exempt from defaults — the row resolves regardless of
  // status.
  defaultFilter: { status: "waiting" },
  jsonColumns: new Set(["bindings"]),
};

/**
 * The `dispatch_failures` descriptor (schema v43, fn-661). The server-side
 * autopilot reconciler's sticky-failure surface — one row per `(verb, id)`
 * dispatch that the reconciler stamped as failed (confirm-timeout,
 * launch-failed, etc) and that has not yet been cleared via a human
 * `retry_dispatch` RPC. Drives the thin `keeper autopilot` viewer's "failed"
 * pane.
 *
 * Schema lives in `src/db.ts`'s `CREATE_DISPATCH_FAILURES`; the population
 * path is the reducer's `DispatchFailed` UPSERT + `DispatchCleared` DELETE
 * fold arms, both inside the existing `BEGIN IMMEDIATE` transaction. The
 * table is a reducer projection (unlike `dead_letters`), so a from-scratch
 * re-fold rebuilds it byte-identically from the event log.
 *
 * Pk is composite (`verb`, `id`) — but `CollectionDescriptor.pk` expects a
 * single column. We carry `verb` as the descriptor pk (the consumer-
 * meaningful identity for the viewer is "what verb failed"; `id` rides in
 * `columns` for display and `filters` for narrowing). A future detail-page
 * subscribe needing single-row resolution by both fields would need a
 * composite-pk extension to `CollectionDescriptor` — same situation as
 * `SUBAGENT_INVOCATIONS_DESCRIPTOR`'s composite pk, deferred for the same
 * reason (the wire surface is the failed-dispatch list, not per-row
 * detail).
 *
 * `version: 'last_event_id'` so the wire diff fires on every UPSERT (the
 * reducer bumps `last_event_id` on every fold). `defaultSort` is `ts DESC`
 * (most-recent failure on top, matching the viewer's expected reverse-
 * chronological "what just broke" feed). No `jsonColumns` — every column
 * is a scalar.
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
  ],
  pk: "verb",
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
 * Schema-v47 `autopilot_state` singleton descriptor (fn-667). The autopilot
 * worker's paused/playing flag as a wire-readable collection — the substrate
 * that makes `keeper autopilot`'s banner reflect the worker's real state
 * (pre-v47 the viewer hardcoded `paused = true` because there was no
 * read surface for the in-memory flag). One row at most (`id = 1`); the
 * reducer's `foldAutopilotPaused` UPSERTs every pause/play event.
 *
 * Pk is the singleton `id` column — `CollectionDescriptor.pk` expects a
 * single column, and the singleton CHECK constraint sidesteps the
 * composite-pk limit `DISPATCH_FAILURES_DESCRIPTOR` documented above.
 *
 * No filters — there is only ever one row; `subscribeCollection` reads it
 * unconditionally. Sortable columns track the typical viewer/debug
 * ordering even though they only ever land one row.
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
    // fn-725 (schema v60): the global autopilot concurrency cap. Rides the
    // subscribe wire so the viewer renders it next to the play/pause pill
    // from the socket ONLY (never reads config.yaml). NULL = unlimited → `∞`.
    "max_concurrent_jobs",
    // fn-751 (schema v62): the explicit autopilot mode enum (`'yolo'` |
    // `'armed'`). Rides the subscribe wire so the `keeper autopilot` viewer
    // renders the mode next to the play/pause pill from the socket ONLY.
    // Defaults `'yolo'` (the work-everything baseline) on a zero-event /
    // pre-existing row.
    "mode",
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
 * The `armed_epics` descriptor (schema v62, epic fn-751). The per-epic armed
 * PRESENCE table the autopilot's `armed` mode reads each reconcile cycle to
 * decide which epics (plus their transitive upstream dep-closure) it may
 * dispatch `work` against. One row per explicitly-armed epic; a row's PRESENCE
 * means armed, its absence means not. Registering it here is the ONLY step
 * that makes the table subscribable/queryable over the UDS socket (the
 * `keeper autopilot` screen's armed-epics section + the board's `[armed]`
 * pill subscribe it).
 *
 * Pk is `epic_id`. `version: 'last_event_id'` so the wire diff fires on every
 * INSERT/REPLACE (the reducer bumps `last_event_id` on every fold).
 * `defaultSort` is `created_at DESC` (most-recently-armed on top). No
 * `jsonColumns` — every column is a scalar. All interpolated identifiers stay
 * trusted constants (the SQL-injection invariant the registry enforces).
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
 * The `pending_dispatches` descriptor (schema v50, epic fn-678). The durable
 * substrate that replaces fn-674's live zellij tab-name probe for launch-
 * window double-dispatch suppression — one row per `(verb, id)` dispatch the
 * autopilot reconciler has minted a `Dispatched` event for and that has not
 * yet been discharged (by SessionStart bind, `DispatchFailed`, or the TTL
 * sweep's `DispatchExpired`). Drives a future "in-flight dispatches" pane on
 * the `keeper autopilot` viewer and is the dedup source of truth the
 * reconciler reads inside its readiness pass.
 *
 * Schema lives in `src/db.ts`'s `CREATE_PENDING_DISPATCHES`; the population
 * path is the reducer's `Dispatched` UPSERT + `DispatchFailed` /
 * `DispatchExpired` / SessionStart-bind DELETE fold arms (task .2 of this
 * epic), all inside the existing `BEGIN IMMEDIATE` transaction. The table
 * is a reducer projection (unlike `dead_letters`), so a from-scratch re-
 * fold rebuilds it byte-identically from the event log.
 *
 * Pk is composite (`verb`, `id`) — but `CollectionDescriptor.pk` expects a
 * single column. We carry `verb` as the descriptor pk and let `id` ride in
 * `columns` for display and `filters` for narrowing, mirroring
 * `DISPATCH_FAILURES_DESCRIPTOR`'s composite-pk workaround. A future
 * detail-page subscribe needing single-row resolution by both fields would
 * need a composite-pk extension to `CollectionDescriptor` — same situation
 * as `SUBAGENT_INVOCATIONS_DESCRIPTOR`'s composite pk, deferred for the
 * same reason (the wire surface is the in-flight list, not per-row
 * detail).
 *
 * `version: 'last_event_id'` so the wire diff fires on every UPSERT (the
 * reducer bumps `last_event_id` on every fold). `defaultSort` is
 * `dispatched_at DESC` (most-recent dispatch on top, matching the viewer's
 * expected reverse-chronological "what just launched" feed). No
 * `jsonColumns` — every column is a scalar.
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
 * The registry, keyed by wire-facing collection name. `jobs` + the `epics`
 * plan collection (which embeds its tasks + plan/close-verb jobs as JSON-array
 * columns — the standalone `tasks` collection was dropped in schema v7 — and
 * carries `approval` as a real column as of schema v13) + `git` + the
 * `subagent_invocations` per-job Agent-timeline projection (schema v17) +
 * the `dead_letters` operational sidecar (schema v37, fn-643) + the
 * `dispatch_failures` autopilot-reconciler sticky-failure projection
 * (schema v43, fn-661) + the `autopilot_state` singleton paused/playing
 * projection (schema v47, fn-667) + the `pending_dispatches` in-flight
 * launch-window projection (schema v50, fn-678) + the `armed_epics` per-epic
 * armed presence projection (schema v62, fn-751).
 */
export const REGISTRY: Map<string, CollectionDescriptor> = new Map([
  [JOBS_DESCRIPTOR.name, JOBS_DESCRIPTOR],
  [EPICS_DESCRIPTOR.name, EPICS_DESCRIPTOR],
  [GIT_DESCRIPTOR.name, GIT_DESCRIPTOR],
  [SUBAGENT_INVOCATIONS_DESCRIPTOR.name, SUBAGENT_INVOCATIONS_DESCRIPTOR],
  [USAGE_DESCRIPTOR.name, USAGE_DESCRIPTOR],
  [PROFILES_DESCRIPTOR.name, PROFILES_DESCRIPTOR],
  [DEAD_LETTERS_DESCRIPTOR.name, DEAD_LETTERS_DESCRIPTOR],
  [DISPATCH_FAILURES_DESCRIPTOR.name, DISPATCH_FAILURES_DESCRIPTOR],
  [AUTOPILOT_STATE_DESCRIPTOR.name, AUTOPILOT_STATE_DESCRIPTOR],
  [PENDING_DISPATCHES_DESCRIPTOR.name, PENDING_DISPATCHES_DESCRIPTOR],
  [ARMED_EPICS_DESCRIPTOR.name, ARMED_EPICS_DESCRIPTOR],
]);

/** Resolve a collection name to its descriptor, or `undefined` if unknown. */
export function getCollection(name: string): CollectionDescriptor | undefined {
  return REGISTRY.get(name);
}

/**
 * Read a set of rows from a collection's table by primary key. Generalizes the
 * old `db.selectJobsByIds`: same empty-set → `[]` short-circuit (a bare
 * `IN ()` is a SQL syntax error), same `MAX_IN_PARAMS` cap throw, same per-call
 * prepare. Returns rows in SQLite's emission order (NOT input order) — the
 * caller re-indexes by `descriptor.pk` if rendering order matters.
 *
 * `descriptor.table` / `columns` / `pk` are trusted constants (interpolated);
 * the ids are bound (`?`). See the injection invariant at the top of the file.
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
     WHERE ${descriptor.pk} IN (${placeholders})
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
 * Read JUST the `(pk, version)` pair for a set of rows by primary key. The
 * version-probe-first pass in `diffTick`: cheap to project (no row body, no
 * JSON columns), cheap to decode (no `decodeRow`), and the result feeds a
 * per-conn `version > lastSent` comparison that drives the conditional
 * `selectByIds` for full rows ONLY when something changed. The two reads can
 * race a writer commit between them — same read-snapshot drift class as the
 * existing `readWorldRev` + `selectByIds` sequence; self-correcting next tick.
 *
 * Mirrors `selectByIds`'s prelude one-for-one: empty `ids` short-circuits to
 * an empty Map (`IN ()` is a SQL syntax error), `ids.length > MAX_IN_PARAMS`
 * throws (the cap-throw failure semantics match `selectByIds` — propagates to
 * `pollLoop` → daemon `fatalExit` → LaunchAgent restart), and the prepare is
 * per-call (the IN-list arity varies per tick; caching by SQL string via
 * `db.query()` would leak prepared-statement entries). `AS pk`/`AS version`
 * aliases normalize the returned shape regardless of which descriptor was
 * passed. `descriptor.pk` and `descriptor.version` are trusted constants
 * (interpolation-safe); the ids are bound (`?`).
 *
 * NEVER calls `decodeRow` — by descriptor design, neither `pk` nor `version`
 * is in `jsonColumns` (they're SQL scalar identifiers). The `Map<string,
 * number | null>` value shape preserves today's `selectByIds` row-cast
 * (`row[descriptor.version] as number | null`) at the call site so the
 * existing `version !== null && version > last` guard in `diffTick` keeps
 * unchanged — and future-proofs against a descriptor making `version`
 * nullable.
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
    SELECT ${descriptor.pk} AS pk, ${descriptor.version} AS version
      FROM ${descriptor.table}
     WHERE ${descriptor.pk} IN (${placeholders})
  `;
  // Per-call prepare: matches the `selectByIds` rationale — arity-varying
  // IN-list, cache-leak risk via `db.query()`.
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
 * {@link selectVersionsByIds}. Those deliberately throw past `MAX_IN_PARAMS`
 * ("chunk the caller") — a tested contract. `diffTick` watches WHOLE
 * collections, so once a collection exceeds 999 rows the watched-id union (and
 * the changed-id fetch on a from-scratch first tick) blows SQLite's bound-
 * variable cap and crashes the poll loop → daemon crash-loop. (The
 * `dead_letters` collection crossing 999 is what triggered this in the wild.)
 * These split the id-set into `MAX_IN_PARAMS`-sized batches and merge: the
 * array form preserves batch order; the map form is a plain union (collection
 * pks are unique, so batches are disjoint — no real conflict). Sub-cap calls
 * pass straight through with zero extra allocation.
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
 * Decode a row's JSON-TEXT columns into real values at the read boundary. For
 * each name in `descriptor.jsonColumns`, replaces the row's stored TEXT with
 * `JSON.parse`'d output so the wire frame serves an array/object — not a JSON
 * string. A NULL/empty cell or a parse failure falls back to `[]` for that
 * column (one bad row never wedges a reader). Returns a new row; the input is
 * left untouched.
 *
 * MUST be called at BOTH row-producing reads (the page SELECT in
 * `runQuery` and `selectByIds` on the diff path) so `result` and `patch` frames
 * agree on the decoded shape — a divergence would serve a JSON-TEXT column as a
 * string on one path and a parsed value on the other. `epics.tasks` (schema v7)
 * is the first — and currently only — registered `jsonColumn`: the embedded
 * `Task[]` array decoded here so a `result`/`patch` epic row serves a real
 * array, not a JSON string.
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
    // NULL preservation (schema v34, fn-637): a NULL column reads `null`
    // from bun:sqlite. For nullable JSON columns like `resolved_epic_deps`,
    // NULL is load-bearing — it signals "not-yet-computed", DISTINCT from a
    // stored `'[]'` ("computed, no deps"). Preserve `null` on the wire so
    // clients can branch on null-ness; an unparseable or empty string still
    // falls back to `[]` (the schema-default empty shape for non-nullable
    // JSON columns like `tasks` / `jobs` / `job_links`, which have a
    // `NOT NULL DEFAULT '[]'` and so will never reach this branch with `null`).
    out[col] = raw === null || raw === undefined ? null : [];
  }
  return out;
}

/** A filtered set's size + a membership fingerprint over its pk identities. */
export interface CountAndToken {
  /** `COUNT(*)` over the full filtered set (the WHERE only — no limit/offset). */
  total: number;
  /**
   * A fingerprint of the matching rows' pk IDENTITIES (never mutable columns),
   * ordered by pk so it's stable tick-to-tick. Changes iff a row enters/leaves
   * the filtered set (incl. a balanced swap: one in, one out, `total` steady).
   * The empty set normalizes to `""` so it compares cleanly against a populated
   * set's token.
   */
  token: string;
}

/**
 * Compute a filtered set's `total` plus a membership `token` in ONE query. The
 * caller passes the already-resolved `whereClause` ("" or "WHERE ...") and its
 * bound `params` — the SAME pair that built the page SELECT — so the count can
 * never drift from the page (a drift would mean "X of N" where X isn't a subset
 * of N).
 *
 * The token is `group_concat(<pk>)` over the matching pk identities, computed
 * via the portable subquery form `SELECT group_concat(pk) FROM (SELECT pk ...
 * ORDER BY pk)`. The inner `ORDER BY <pk>` is REQUIRED: SQLite `group_concat`
 * order is otherwise arbitrary (plan-dependent), and an unstable token fires
 * phantom `meta` frames every tick. Ordering by the pk (the stable identity),
 * not the display sort, keeps the token a pure membership fingerprint. The
 * subquery form (rather than SQLite-3.44+ `group_concat(pk ORDER BY pk)`) drops
 * a runtime-version dependency at zero cost on a tiny table.
 *
 * `group_concat` over zero rows returns `NULL`; we normalize that to `""` so an
 * empty filtered set has a stable `token=""` / `total=0` that diffs cleanly.
 *
 * Injection: only `descriptor.table` / `descriptor.pk` are interpolated
 * (trusted constants); the filter `params` are bound (`?`). The descriptor stays
 * the SOLE SQL-identifier injection gate — see the file-top invariant.
 */
export function countAndToken(
  db: Database,
  descriptor: CollectionDescriptor,
  whereClause: string,
  params: readonly (string | number)[],
): CountAndToken {
  const sql = `
    SELECT COUNT(*) AS n, group_concat(${descriptor.pk}) AS token
      FROM (
        SELECT ${descriptor.pk}
          FROM ${descriptor.table}
          ${whereClause}
         ORDER BY ${descriptor.pk}
      )
  `;
  const row = db.prepare(sql).get(...params) as {
    n: number;
    token: string | null;
  };
  return { total: row.n, token: row.token ?? "" };
}
