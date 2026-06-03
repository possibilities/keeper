/**
 * Plan worker. keeperd's FOURTH Bun Worker thread (after wake + server +
 * transcript), and its SECOND event *producer*: it watches each configured
 * project root for `.planctl/{epics,tasks}/*.json` files, reads + parses the
 * current file on each change, and posts typed snapshot messages
 * (`{kind:"plan-epic", …}` / `{kind:"plan-task", …}`) to the parent. The parent
 * (and only the parent) turns those messages into synthetic `EpicSnapshot` /
 * `TaskSnapshot` `events` rows, which the reducer folds into the `epics` /
 * `tasks` projections. The worker never writes the DB — it opens a READ-ONLY
 * connection (for the restart-seed) and only posts messages, keeping main the
 * sole writer.
 *
 * This is the second instance of the producer-worker archetype (the first is
 * `src/transcript-worker.ts`); it clones that contract verbatim:
 * - `isMainThread`-guarded body — a plain `import` from a test is inert; the
 *   pure `PlanScanner` core is exported and drivable with no Worker or watcher.
 * - Own read-only `openDb(path, { readonly: true })` (handles are thread-affine
 *   and not structured-cloneable; the parent hands us only path strings via
 *   `workerData`).
 * - Typed message protocol: `{ kind: ... }` worker→main, `{ type: "shutdown" }`
 *   main→worker. Exit `0` clean / `1` crash. NO in-process self-heal — only a
 *   genuine unrecoverable failure exits non-zero.
 * - Subsystem-style teardown: each `@parcel/watcher` subscription is an external
 *   resource the worker owns and `unsubscribe()`s in its shutdown handler. The
 *   worker holds ONE subscription per root (an array), released all at once.
 *
 * Why a native file watcher here when keeper's DO-NOT bans `fs.watch`/FSEvents
 * for its OWN SQLite DB: same carve-out as the transcript worker. The `.planctl`
 * trees are EXTERNAL files written by other processes (planctl), so the
 * same-process-write blind spot does not apply and there is no `data_version`
 * for a foreign file tree. Every watch event is treated as "something changed,
 * go look" — never as the data: each notification triggers an `fstat` +
 * size-bounded re-read + safe-parse from the current file (routed on
 * path+existence, not `event.type`, since planctl writes via atomic
 * `os.replace`, so an update may surface as create/rename).
 *
 * Watching strategy (the keystone risk this task isolates): ONE recursive
 * `@parcel/watcher` subscribe per root, with aggressive POSITIVE ignore globs
 * (`node_modules`, `.git`, `dist`, … — see {@link IGNORE_GLOBS}) so a git/npm
 * storm under a broad root like `~/code` does not flood the callback. We do NOT
 * use the transcript worker's negation glob (the `!(jsonl)` exclude style) —
 * parcel breaks on negated patterns (parcel-bundler/watcher #174). The filter to
 * `.planctl/{epics,tasks}/*.json` is an IN-CALLBACK check, not a glob.
 *
 * Internal guards (skip-and-log, never escalate): a missing root is tolerated
 * (skipped, the other roots keep watching), per-file read errors, oversize
 * files, and torn/malformed JSON all log to stderr and continue without
 * emitting. Only an unrecoverable failure (the `subscribe` call itself
 * rejecting, the addon failing to load) exits non-zero → daemon `fatalExit` →
 * launchd restart.
 *
 * Boot reconciliation: a file deleted while the daemon was DOWN never fires a
 * live `onDelete`, so it would leave a permanent projection ghost. After every
 * root's boot scan has run (the {@link PlanScanner.markSeen} on-disk census is
 * complete), {@link PlanScanner.sweep} retracts any projection id with no
 * backing file — scoped strictly to configured roots (via the epic's
 * `project_dir`) and run AFTER snapshot emission so a moved/rewritten file is
 * re-emitted, not spuriously retracted. Each retraction rides the SAME task-2
 * tombstone path (`plan-epic-deleted` / `plan-task-deleted`) as a live delete —
 * no new event types.
 *
 * Three-layer ingest (epic fn-681): the authoritative path is the
 * commit-trigger (`planctl-commit-changed` from git-worker → re-ingest the
 * committed bytes, drop-proof and free of the mid-write partial-read race),
 * backed by a periodic reconcile heartbeat ({@link reconcilePlanctlDirs}
 * on the {@link RECONCILE_HEARTBEAT_MS} cadence — the brand-new-repo
 * convergence backstop that fires even when git-worker isn't yet watching
 * the repo and FSEvents dropped its scaffold burst) and the broad
 * `@parcel/watcher` recursive subscription (the best-effort sub-second
 * live path, the only path for uncommitted working-tree edits but the
 * one exposed to FSEvents drops). The drop-recovery `RescanScheduler`
 * callback is `.planctl`-scoped via {@link reconcilePlanctlDirs} so a
 * drop on a broad root recovers in O(#projects), not O(`~/code` tree).
 * All three layers are ADDITIVE re-ingest, idempotent via the change-gate;
 * deletions stay owned by the commit path + boot sweep + live `onDelete`.
 */

import type { Database } from "bun:sqlite";
import {
  type Dirent,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { AsyncSubscription } from "@parcel/watcher";
import { openDb } from "./db";
import { isDropError, RescanScheduler } from "./rescan";

/**
 * Data the parent passes via `new Worker(url, { workerData })`. Only path
 * strings cross the boundary — the Database handle and the subscriptions cannot.
 */
export interface PlanWorkerData {
  dbPath: string;
  /**
   * The project roots to watch (each scanned recursively for `.planctl` trees).
   * The parent resolves these from `resolvePlanRoots()` (config → absolute,
   * existing dirs). Overridable so tests point at hermetic tmp dirs.
   */
  roots: string[];
}

/**
 * The planctl-native approval enum (schema v13). A missing or invalid value on
 * the on-disk file coerces to `"pending"` — see {@link coerceApproval}.
 */
export type Approval = "approved" | "rejected" | "pending";

/** Snapshot message for one `.planctl/epics/*.json` file. */
export interface PlanEpicMessage {
  kind: "plan-epic";
  /** Planctl epic id (the projection pk; rides in the synthetic event's session_id). */
  id: string;
  /** Epic number parsed from the id (`fn-N-…` → N), or null when unparseable. */
  number: number | null;
  title: string | null;
  /** The epic's `primary_repo` — stored opaque, never used to drive FS reads. */
  projectDir: string | null;
  status: string | null;
  /**
   * Planctl-native approval enum, top-level on the epic file. Missing /
   * invalid values fold to `"pending"` via {@link coerceApproval} (the safe
   * value invariant — re-fold of a file written by old planctl stays stable).
   */
  approval: Approval;
  /** Epic-level deps: the planctl `depends_on_epics` ids (string array). */
  dependsOnEpics: string[];
  /**
   * Planctl-native validation timestamp (top-level `last_validated_at` field
   * on `.planctl/epics/<id>.json`). Plain ISO-8601 string when present; a
   * missing / empty / non-string value collapses to `null` via {@link asString}
   * — the CLAUDE.md "safe value" invariant. Drives the board UI's
   * `[validated]` / `[unvalidated]` pill.
   */
  lastValidatedAt: string | null;
}

/** Snapshot message for one `.planctl/tasks/*.json` file. */
export interface PlanTaskMessage {
  kind: "plan-task";
  /** Planctl task id (the projection pk; rides in the synthetic event's session_id). */
  id: string;
  /** Parent epic id (planctl `epic` field). */
  epicId: string | null;
  /** Task number parsed from the id (`….M` → M), or null when unparseable. */
  number: number | null;
  title: string | null;
  /** The task's `target_repo` — stored opaque, never used to drive FS reads. */
  targetRepo: string | null;
  /**
   * Planctl-native effort tier (fn-602): the top-level `tier` field on the
   * task-def file (planctl's `medium | high | xhigh | max` vocabulary).
   * Stored opaque — keeper never branches on the value, so a future tier
   * widening rides through with no code change. Null on absent/legacy files;
   * a pre-fn-602 `TaskSnapshot` event blob lacks this field and folds to
   * `null` deterministically (same graceful-degradation precedent as
   * `worker_phase`/`runtime_status`).
   */
  tier: string | null;
  /**
   * Derived worker-phase binary: `worker_done_at` present → `"done"`, else
   * `"open"`. Surfaces the same compressed signal the field used to carry
   * under the legacy `status` name (renamed in schema v19 to make room for
   * the planctl-native `runtime_status` enum below).
   */
  workerPhase: string;
  /**
   * Planctl-native runtime status ingested from
   * `.planctl/state/tasks/<task_id>.state.json` (top-level `status` field):
   * `"todo" | "in_progress" | "done" | "blocked"`. Absent / missing file /
   * unrecognized value safe-defaults to `"todo"` per planctl's
   * `merge_task_state` convention (a fresh clone with no `state/` tree reads
   * every task as `todo`).
   */
  runtimeStatus: string;
  /**
   * Planctl-native approval enum, top-level on the task file. Same coercion
   * semantics as {@link PlanEpicMessage.approval}.
   */
  approval: Approval;
  /** Task-level deps: the planctl `depends_on` task ids (string array). */
  dependsOn: string[];
}

/**
 * Tombstone message for a deleted `.planctl/epics/*.json` file. Main turns it
 * into a synthetic `EpicDeleted` event; the reducer deletes the `epics` row.
 */
export interface PlanEpicDeletedMessage {
  kind: "plan-epic-deleted";
  /** Planctl epic id (the projection pk; rides in the synthetic event's session_id). */
  id: string;
}

/**
 * Tombstone message for a deleted `.planctl/tasks/*.json` file. Main turns it
 * into a synthetic `TaskDeleted` event; the reducer splices the element out of
 * the parent epic's embedded array. `epicId` is recovered from the change-gate's
 * last-emitted snapshot for this task (the only place the parent link survives a
 * delete, since the file is already gone).
 */
export interface PlanTaskDeletedMessage {
  kind: "plan-task-deleted";
  /** Planctl task id. */
  id: string;
  /** Parent epic id, recovered from the last-emitted task snapshot. */
  epicId: string | null;
}

/** Either snapshot or tombstone message the worker posts to the parent. */
export type PlanMessage =
  | PlanEpicMessage
  | PlanTaskMessage
  | PlanEpicDeletedMessage
  | PlanTaskDeletedMessage;

/** Message the parent sends to ask the worker to stop. */
export interface ShutdownMessage {
  type: "shutdown";
}

/**
 * Message the parent sends to drain the observation gate's pending set
 * (fn-629). Posted on every `GitSnapshot` events row main writes — that is
 * the "HEAD may have moved" cross-worker signal a plan-worker can't observe
 * on its own (a `git commit` does not change the file's content so the
 * `.planctl/*.json` FSEvent will not re-fire). The worker calls
 * {@link PlanScanner.recheckPending} on receipt; a freshly-committed epic
 * drains and emits its snapshot.
 */
export interface RecheckPendingMessage {
  type: "recheck-pending";
}

/**
 * One entry on a {@link PlanctlCommitChangedMessage} — a single
 * `.planctl/**` path that changed in the committed delta the git-worker
 * just observed. `path` is repo-relative (forward-slash on POSIX), tagged
 * by the git-side `diff-tree` parse with the file's commit-time fate.
 *
 * `op` partitions the change:
 * - `"upsert"` — the file is present in HEAD (add or modify); plan-worker
 *   calls {@link PlanScanner.onChange} on the joined absolute path, which
 *   reads the COMMITTED bytes from the worktree (atomic post-commit, no
 *   partial-read race) and runs the existing classify→parse→gate→emit
 *   pipeline. Duplicate fires from a live FSEvent are no-ops via the
 *   change-gate.
 * - `"delete"` — the file was `git rm`'d in this commit (zero blob_oid in
 *   the diff-tree record); plan-worker calls
 *   {@link PlanScanner.onDelete}, which emits the existing tombstone via
 *   the change-gate's recovered epicId. This gives commit-path deletion
 *   without relying on FSEvents delete events.
 */
export interface PlanctlCommitChange {
  path: string;
  op: "upsert" | "delete";
}

/**
 * Message the parent sends when a commit landed in a keeper-tracked repo
 * carrying changed `.planctl/**` paths (epic fn-681). Authoritative ingest
 * trigger: the COMMITTED bytes are atomically written, so re-ingest from
 * the worktree is drop-proof and free of the mid-write partial-read race
 * the broader `~/code` FSEvents subscription is exposed to. The git-worker
 * filters the per-commit diff to `.planctl/{epics,tasks}/*.json` +
 * `.planctl/state/tasks/*.state.json` producer-side via
 * {@link classifyPlanPath}, so the worker receives a tight list.
 *
 * One message per commit (even when several arrive in a single push) so
 * the boundary between commits stays visible — a many-file scaffold burst
 * collapses to one message carrying every changed path.
 *
 * `repo` is the absolute path to the committing worktree root (joined with
 * each `change.path` to recover an absolute path the scanner can stat +
 * read). Plan-worker iterates {@link changes}, calling
 * {@link PlanScanner.onChange} or {@link PlanScanner.onDelete} per entry;
 * any per-path failure (stat race, malformed JSON) skip-and-logs without
 * stalling the rest, mirroring the live FSEvents path.
 */
export interface PlanctlCommitChangedMessage {
  type: "planctl-commit-changed";
  repo: string;
  changes: PlanctlCommitChange[];
}

/** Inbound message protocol — every shape main sends to the worker. */
export type InboundMessage =
  | ShutdownMessage
  | RecheckPendingMessage
  | PlanctlCommitChangedMessage;

/**
 * Cap a plan file's size before `JSON.parse`. Plan JSONs live under a
 * user-editable HOME; a pathological/oversize file is skip-and-logged so a bad
 * file never balloons memory or stalls the callback. 1 MiB is far above any real
 * planctl epic/task JSON.
 */
const MAX_PLAN_FILE_BYTES = 1024 * 1024;

/**
 * Aggressive POSITIVE ignore globs — the #1 perf lever for broad roots like
 * `~/code` / `~/src`. Without these, every git/npm/build churn under the root
 * floods the FSEvents callback. These are passed to `@parcel/watcher`'s
 * `ignore` (positive patterns only — NO negation glob, which parcel mishandles).
 */
const IGNORE_GLOBS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/.cache/**",
  "**/target/**",
  "**/.venv/**",
  "**/*.tmp",
];

/**
 * Directory basenames the boot scan prunes — the recursive-walk equivalent of
 * {@link IGNORE_GLOBS}. The live `@parcel/watcher` subscribe is recursive, so
 * the boot scan must recurse too (plan files live at
 * `<root>/<project>/.planctl/…`, NOT at `<root>/.planctl/…`); without pruning,
 * that walk would descend into every `node_modules`/`.git` under a broad root
 * like `~/code` (tens of thousands of dirs). Basename match mirrors the glob
 * set (the `*.tmp` file glob has no directory equivalent).
 */
const PRUNE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".cache",
  "target",
  ".venv",
]);

/** Which `.planctl` collection a path belongs to (or none). */
type PlanKind = "epic" | "task" | "task-state";

/**
 * Classify a watched path as an epic file, a task file, a task runtime-state
 * file, or neither, by matching the planctl layout. Uses the platform path
 * separator so it works under any root depth. A path NOT matching one of the
 * shapes returns `null` — the callback then skips it (the in-callback filter
 * the ignore globs can't express).
 *
 * Recognised shapes:
 * - `.planctl/epics/<id>.json` (3-segment tail) → `"epic"`
 * - `.planctl/tasks/<id>.json` (3-segment tail) → `"task"`
 * - `.planctl/state/tasks/<id>.state.json` (4-segment tail) → `"task-state"`
 *
 * The 3-segment check is tried first so an `.json`-suffixed file under a
 * 3-tail layout never falls through to the 4-tail probe. The 4-tail probe
 * matches the planctl `LocalFileStateStore` shape (see
 * `apps/planctl/planctl/store.py:151`); files there end in `.state.json` so a
 * stray `*.json` (non-state) under `.planctl/state/tasks/` rejects.
 *
 * Pure — does no I/O. Exported for unit reach.
 */
export function classifyPlanPath(path: string): PlanKind | null {
  if (!path.endsWith(".json")) {
    return null;
  }
  const segments = path.split(sep);
  const n = segments.length;
  // 3-segment tail: `.planctl/<epics|tasks>/<file>.json`.
  if (n >= 3 && segments[n - 3] === ".planctl") {
    const dir = segments[n - 2];
    if (dir === "epics") {
      return "epic";
    }
    if (dir === "tasks") {
      return "task";
    }
    // Other `.planctl/<dir>/*.json` shapes (e.g. `specs/`) fall through and
    // reject below — they are not our concern.
    return null;
  }
  // 4-segment tail: `.planctl/state/tasks/<id>.state.json`. The filename MUST
  // end in `.state.json` (the planctl LocalFileStateStore convention); a
  // stray `*.json` (non-state) under this subtree rejects.
  if (
    n >= 4 &&
    segments[n - 4] === ".planctl" &&
    segments[n - 3] === "state" &&
    segments[n - 2] === "tasks" &&
    segments[n - 1].endsWith(".state.json")
  ) {
    return "task-state";
  }
  return null;
}

/**
 * Parse the leading `fn-N-…` epic number from a planctl id. Returns N (the first
 * integer group) or null for a non-matching id.
 *
 * Pure. Exported for unit reach.
 */
export function epicNumberFromId(id: string): number | null {
  const m = /^[a-z]+-(\d+)-/.exec(id);
  if (!m) {
    return null;
  }
  const n = Number.parseInt(m[1], 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Parse the trailing `.M` task number from a planctl task id
 * (`fn-N-slug.M` → M). Returns M or null for a non-matching id.
 *
 * Pure. Exported for unit reach.
 */
export function taskNumberFromId(id: string): number | null {
  const m = /\.(\d+)$/.exec(id);
  if (!m) {
    return null;
  }
  const n = Number.parseInt(m[1], 10);
  return Number.isNaN(n) ? null : n;
}

/** Raw planctl epic JSON shape — only the fields we project. */
interface RawEpic {
  id?: unknown;
  title?: unknown;
  status?: unknown;
  primary_repo?: unknown;
  approval?: unknown;
  depends_on_epics?: unknown;
  last_validated_at?: unknown;
}

/** Raw planctl task JSON shape — only the fields we project. */
interface RawTask {
  id?: unknown;
  epic?: unknown;
  title?: unknown;
  target_repo?: unknown;
  /**
   * Planctl-native effort tier (fn-602): top-level field on the task-def file,
   * read by `planctl resolve-task` from `task_def.get("tier")`. Planctl's own
   * vocabulary is `medium | high | xhigh | max` (planctl `TASK_TIERS`), but
   * keeper stores the field opaque — never branches on the value — so any
   * future tier widening rides through with no code change. Absent on legacy
   * task files / unset on newer ones; coerced to `null` by `asString`.
   */
  tier?: unknown;
  worker_done_at?: unknown;
  approval?: unknown;
  depends_on?: unknown;
}

/**
 * Raw planctl runtime-state JSON shape — only the field we project. The state
 * file (`.planctl/state/tasks/<task_id>.state.json`) is written by planctl
 * `LocalFileStateStore` (`apps/planctl/planctl/store.py:151`) and carries
 * `assignee` / `claim_note` / `claimed_at` / `evidence` / `status` /
 * `updated_at`; keeper only ingests `status`.
 */
interface RawTaskState {
  status?: unknown;
}

/** Coerce a value to a non-empty string, else null. */
function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Derive the planctl task id from a state-file path:
 * `.../.planctl/state/tasks/<task_id>.state.json` → `<task_id>`. Returns null
 * if the basename does not end in `.state.json` (caller has already
 * classified — this stays a pure transform on the matched shape).
 *
 * Pure. Exported for unit reach.
 */
export function taskIdFromStatePath(path: string): string | null {
  const segments = path.split(sep);
  const base = segments[segments.length - 1];
  const suffix = ".state.json";
  if (!base.endsWith(suffix)) {
    return null;
  }
  const id = base.slice(0, -suffix.length);
  return id.length > 0 ? id : null;
}

/**
 * Map a state-file path
 * `.../.planctl/state/tasks/<task_id>.state.json` to the sibling task
 * definition file path `.../.planctl/tasks/<task_id>.json`. Pure path
 * arithmetic — does no I/O. Returns null on a shape mismatch (caller has
 * already classified, so this is defensive only).
 */
export function taskDefPathFromStatePath(statePath: string): string | null {
  const segments = statePath.split(sep);
  const n = segments.length;
  if (
    n < 4 ||
    segments[n - 4] !== ".planctl" ||
    segments[n - 3] !== "state" ||
    segments[n - 2] !== "tasks"
  ) {
    return null;
  }
  const taskId = taskIdFromStatePath(statePath);
  if (taskId === null) {
    return null;
  }
  // Replace the trailing `state/tasks/<id>.state.json` with `tasks/<id>.json`.
  const planctlPrefix = segments.slice(0, n - 3);
  return [...planctlPrefix, "tasks", `${taskId}.json`].join(sep);
}

/**
 * Coerce a value to an array of non-empty strings, dropping non-string / empty
 * elements; a non-array (or absent) value yields `[]`. Used for the dependency
 * id lists (`depends_on_epics` / `depends_on`) — an untrusted foreign-process
 * field, so one bad element never poisons the list.
 */
function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) {
    return [];
  }
  return v.filter((e): e is string => typeof e === "string" && e.length > 0);
}

/** The fixed set of valid {@link Approval} enum values. */
const APPROVAL_VALUES: ReadonlySet<string> = new Set([
  "approved",
  "rejected",
  "pending",
]);

/**
 * The fixed set of valid planctl runtime-status enum values
 * (`.planctl/state/tasks/<id>.state.json`'s top-level `status` field). Mirrors
 * the {@link APPROVAL_VALUES} pattern.
 */
const RUNTIME_STATUS_VALUES: ReadonlySet<string> = new Set([
  "todo",
  "in_progress",
  "done",
  "blocked",
]);

/**
 * Coerce a value off a state file to the runtime-status enum. A valid enum
 * string passes through; a missing field defaults silently to `"todo"`
 * (mirrors planctl's `merge_task_state` convention — a task with no state file
 * reads `todo` everywhere); any other value (wrong type, typo, garbage)
 * coerces to `"todo"` with a stderr log via `onInvalid` — the CLAUDE.md "safe
 * value" invariant. The fold stays a pure function of the persisted file
 * (re-fold determinism preserved).
 *
 * Mirrors {@link coerceApproval} so a new enum field follows the same
 * skip-and-log discipline.
 */
export function coerceRuntimeStatus(
  v: unknown,
  onInvalid?: (raw: unknown) => void,
): string {
  if (v === undefined || v === null) {
    return "todo"; // missing field — quiet default, no log
  }
  if (typeof v === "string" && RUNTIME_STATUS_VALUES.has(v)) {
    return v;
  }
  if (onInvalid) {
    onInvalid(v);
  }
  return "todo";
}

/**
 * Coerce a value off a plan file to the {@link Approval} enum. A valid enum
 * string passes through; a missing field defaults silently to `"pending"`
 * (forward-compat with files written by old planctl that predate the field);
 * any other value (wrong type, typo, garbage) coerces to `"pending"` with a
 * stderr log via `onInvalid` — the CLAUDE.md "safe value" invariant. The fold
 * stays a pure function of the persisted file (re-fold determinism preserved).
 */
export function coerceApproval(
  v: unknown,
  onInvalid?: (raw: unknown) => void,
): Approval {
  if (v === undefined || v === null) {
    return "pending"; // missing field — quiet default, no log
  }
  if (typeof v === "string" && APPROVAL_VALUES.has(v)) {
    return v as Approval;
  }
  if (onInvalid) {
    onInvalid(v);
  }
  return "pending";
}

/**
 * Parse a stored JSON-TEXT array column (`epics.depends_on_epics`) back into a
 * clean `string[]` — JSON.parse then {@link asStringArray}. A NULL/empty/
 * malformed cell yields `[]`, mirroring the read-boundary `decodeRow` tolerance,
 * so the reconstructed seed matches a fresh scan field-for-field.
 */
function parseStringArrayColumn(text: string | null): string[] {
  if (text == null || text.length === 0) {
    return [];
  }
  try {
    return asStringArray(JSON.parse(text));
  } catch {
    return [];
  }
}

/**
 * Pure, exported plan-file scanner — the deterministic core, drivable in tests
 * with no Worker or watcher. Mirrors `TranscriptLineStream`:
 *
 * - `onChange(path)` classifies the path (epic/task/neither), `fstat`s + bounds
 *   + reads + safe-parses the CURRENT file, derives the projection fields
 *   (number from the id, task status from `worker_done_at`), and emits a
 *   `plan-epic` / `plan-task` message via `onSnapshot` ONLY when the snapshot
 *   differs from the change-gate. A read-vs-delete race, an oversize file, or a
 *   malformed/parse failure is skip-and-logged WITHOUT emitting (keep last good).
 * - `onDelete(path)` emits a tombstone (`plan-epic-deleted` /
 *   `plan-task-deleted`) so the projection retracts, then drops the path's
 *   change-gate entry. A task tombstone recovers `epicId` from the last-emitted
 *   snapshot (the parent link is gone with the file). A path that was never
 *   folded (no change-gate entry) emits nothing — there is nothing to retract.
 *
 * The change-gate is keyed by the planctl id (the projection pk) and holds the
 * last-emitted serialized snapshot. `seedFromDb` (below) primes it from the
 * `epics`/`tasks` projection so a daemon restart full-scan does not re-emit a
 * synthetic event per plan file every boot.
 *
 * Observation gate (fn-629 / epic fn-629-planctl-epic-mutation-atomicity): an
 * optional `isTracked(path) => boolean` predicate fed in at construction
 * suppresses emission for any epic/task file that is NOT yet in git HEAD
 * (untracked, or staged-but-not-committed). Suppressed paths land in the
 * {@link pending} set. The reducer continues to fold ONLY committed
 * snapshots, so the autopilot cannot dispatch against an uncommitted epic.
 * A planctl `git commit` does not change the file content, so FSEvents will
 * NOT re-fire on commit — the caller (the worker, driven by git-worker
 * snapshot pulses) drives {@link recheckPending} to drain the set. The
 * predicate is a producer-side gate; the reducer NEVER reads git/fs/wallclock
 * (re-fold determinism preserved). When omitted (default `() => true`) the
 * scanner is gateless — preserves test back-compat and lets the pure-core
 * tests drive `onChange` without a fake git tree.
 */
export class PlanScanner {
  /** id → last-emitted serialized snapshot (the change-gate). */
  private readonly lastEmitted = new Map<string, string>();
  /** path → id, so a delete can drop the right change-gate entry. */
  private readonly pathToId = new Map<string, string>();
  /**
   * Paths of epic/task files whose last `onChange` was gated by
   * {@link isTracked} (file not in HEAD — untracked or staged-but-not-committed).
   * Drained by {@link recheckPending}, called by the worker on every git-worker
   * snapshot pulse (the cross-worker signal that commit/checkout/branch-switch
   * may have moved HEAD). A pending path that was never emitted holds NO
   * `lastEmitted` / `pathToId` entry — so a delete while pending is a no-op
   * (nothing to retract, since the reducer never saw it).
   *
   * NOT tracked for `task-state` (sidecar) paths — those bypass the gate
   * entirely (state files are runtime data, planctl's `.gitignore` excludes
   * them). A state-file change re-emits a TaskSnapshot through the
   * still-gated def-file path; if the def file is pending, the state-file
   * change is effectively pending too (the re-emit lands in `pending`
   * keyed by the def path).
   */
  private readonly pending = new Set<string>();
  /**
   * Per-task cache of the latest runtime-status enum value observed in
   * `.planctl/state/tasks/<task_id>.state.json` (top-level `status` field).
   * Keyed by planctl task id. A task that has never been observed in the
   * cache reads `"todo"` (planctl's `merge_task_state` default — a fresh
   * clone with no `state/` tree shows every task as `todo`); the
   * {@link buildTaskMessage} caller passes this default.
   *
   * Updated by an `onChange` over a `task-state` path AFTER the file
   * coerce-parses cleanly, and re-derived to `"todo"` by `onDelete` over the
   * same path (so a state-file vanish flips the task back to `todo`, matching
   * planctl's "no state file → todo" convention). NEVER mutated from a `task`
   * (definition) path — the cache is the state file's projection.
   */
  private readonly runtimeStatusCache = new Map<string, string>();
  /**
   * The set of planctl ids whose backing `.json` file was actually enumerated
   * on disk by a boot scan ({@link markSeen}, called from `scanPlanctlDir` for
   * EVERY file regardless of parse outcome). The boot-reconciliation
   * {@link sweep} diffs the projection against this census to retract ghosts —
   * projection ids whose file was deleted while the daemon was down (no live
   * `onDelete` ever fired). Keyed by the FILENAME-derived id (file basename
   * minus `.json`), NOT a parse result: a file mid-rewrite that fails to parse
   * still has its name on disk, so it is "seen" and never spuriously retracted.
   *
   * State files (`.planctl/state/tasks/<id>.state.json`) are NOT enrolled in
   * this census — they are a SIDECAR projection layered onto task ids that
   * already enrol via their definition file under `.planctl/tasks/`. The
   * sweep retracts on missing definition files; a sidecar's absence is the
   * cache's `"todo"` default, not a tombstone.
   */
  private readonly seenOnDisk = new Set<string>();

  constructor(
    private readonly onSnapshot: (msg: PlanMessage) => void,
    private readonly log: (msg: string) => void = (m) => console.error(m),
    /**
     * Optional git-tracked predicate. Returns `true` when the epic/task file
     * at `path` is in git HEAD (committed); `false` when untracked or
     * staged-but-not-committed. A `false` from {@link onChange} routes the
     * path into {@link pending} instead of emitting a snapshot — the
     * fn-629 observation gate. Defaults to `() => true` (no gating) so the
     * pure-core unit tests don't need a fake git tree; the live worker
     * passes a `git cat-file -e HEAD:<relpath>` closure.
     *
     * The predicate is producer-side ONLY — the reducer never reads git
     * (re-fold determinism preserved). Path is the absolute filesystem
     * path passed to onChange; the predicate is responsible for resolving
     * the repo root + relpath itself.
     */
    private readonly isTracked: (path: string) => boolean = () => true,
  ) {}

  /**
   * Seed the change-gate for an entity from the persisted projection so an
   * unchanged file on restart does not re-emit. The seed value must match the
   * serialization {@link buildEpicMessage} / {@link buildTaskMessage} produce
   * for the same row — the caller ({@link seedFromDb}) reconstructs the message
   * from projection columns and serializes it the same way.
   */
  seed(id: string, serialized: string): void {
    this.lastEmitted.set(id, serialized);
  }

  /**
   * Prime the per-task runtime-status cache from a boot enumeration of
   * `.planctl/state/tasks/<task_id>.state.json` (called by `scanPlanctlDir`
   * BEFORE the `tasks/` loop). Pure cache write — does NOT emit a snapshot,
   * does NOT touch `pathToId`, does NOT touch the on-disk census
   * ({@link markSeen} — state files are sidecar, not enrolled). The
   * subsequent `tasks/` loop's `onChange` reads this cache and emits the
   * task's first `TaskSnapshot` already carrying the correct `runtime_status`,
   * with no redundant re-emit on a follow-up state-file write.
   *
   * The caller has already coerced the value through {@link coerceRuntimeStatus};
   * this method is the un-policed cache poke. Invalid values are filtered
   * upstream so the cache only ever holds the four-value enum vocabulary.
   */
  primeRuntimeStatus(taskId: string, status: string): void {
    this.runtimeStatusCache.set(taskId, status);
  }

  /**
   * Process a delete for `path`. Emits a tombstone so the projection retracts,
   * then drops the change-gate entry (so a re-created file re-emits). A path
   * with no change-gate entry (never folded) emits nothing — nothing to retract.
   *
   * The deleted file is already gone, so we cannot re-read it: the id comes from
   * the `pathToId` map and a task's parent `epicId` from the last-emitted
   * snapshot still held in the change-gate. The tombstone is the only
   * replay-deterministic way to fold a delete — it rides through the same
   * synthetic-event pipeline as the snapshot messages.
   *
   * `task-state` (sidecar) deletes do NOT emit a tombstone — they flip the
   * runtime-status cache back to the planctl default `"todo"` and re-emit a
   * TaskSnapshot from the still-present task-definition file. The definition
   * file is the projection's identity; a sidecar vanishing reverts state, it
   * does not retract the task.
   */
  onDelete(path: string): void {
    const kind = classifyPlanPath(path);
    if (kind === "task-state") {
      // Sidecar delete: drop the cache entry (reverts the task to the planctl
      // default "todo") and re-emit a TaskSnapshot from the still-present
      // task-definition file. A state-file path is NOT tracked in
      // `pathToId` (the cache key is the task id directly), so there is no
      // entry to drop there.
      const taskId = taskIdFromStatePath(path);
      if (taskId === null) {
        return;
      }
      const hadCache = this.runtimeStatusCache.has(taskId);
      this.runtimeStatusCache.delete(taskId);
      if (!hadCache) {
        // The cache was already empty (reading "todo"); deleting a never-cached
        // sidecar can't change the projection. Skip the re-emit.
        return;
      }
      const defPath = taskDefPathFromStatePath(path);
      if (defPath === null) {
        return;
      }
      this.reemitTaskFromDef(defPath);
      return;
    }

    const id = this.pathToId.get(path);
    if (id === undefined) {
      // Never folded this path. If the path was held in the fn-629
      // observation gate's pending set (uncommitted epic/task whose file
      // got removed before it ever made HEAD — e.g. a planctl scaffold
      // unwind on commit_failed), drop it: there's nothing to retract
      // since the reducer never saw the entity. Either way, no tombstone.
      this.pending.delete(path);
      return;
    }
    if (kind === "epic") {
      this.onSnapshot({ kind: "plan-epic-deleted", id });
    } else if (kind === "task") {
      // Recover the parent epic id from the last-emitted task snapshot — the
      // file is gone, so this is the only surviving link. Parse defensively;
      // a missing/garbled gate value falls back to a null epicId (the reducer
      // then no-ops, which is correct: a task we can't place can't be spliced).
      let epicId: string | null = null;
      const serialized = this.lastEmitted.get(id);
      if (serialized !== undefined) {
        try {
          const last = JSON.parse(serialized) as Partial<PlanTaskMessage>;
          if (typeof last.epicId === "string") {
            epicId = last.epicId;
          }
        } catch {
          // garbled gate value → null epicId, fall through.
        }
      }
      this.onSnapshot({ kind: "plan-task-deleted", id, epicId });
      // Definition file is gone: drop the runtime-status cache too, so a
      // re-created task file starts from the planctl "todo" default rather
      // than a stale cached value.
      this.runtimeStatusCache.delete(id);
    }
    // Drop the change-gate so a re-created file re-emits its snapshot.
    this.pathToId.delete(path);
    this.lastEmitted.delete(id);
  }

  /**
   * Read the task-definition file at `defPath` (if present) and re-emit a
   * TaskSnapshot composed with the latest cached `runtimeStatus`. Used by
   * the `task-state` change/delete arms — the sidecar carries only the
   * runtime field, but the snapshot the reducer folds is full.
   *
   * A missing/unreadable/malformed definition file is skip-and-logged
   * without emitting (mirrors {@link onChange}); the next true `task` event
   * will replay through the same path.
   */
  private reemitTaskFromDef(defPath: string): void {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(defPath);
    } catch {
      // Definition file absent (or read-vs-delete race) — the sidecar
      // changed for a task whose definition hasn't appeared yet. The cache
      // already updated; when the def lands, its `task` `onChange` reads
      // the cache and emits correctly.
      return;
    }
    if (!st.isFile() || st.size > MAX_PLAN_FILE_BYTES) {
      return;
    }
    let text: string;
    try {
      text = readFileSync(defPath, "utf8");
    } catch (err) {
      this.log(
        `[plan-worker] read failed for ${defPath}: ${stringifyErr(err)}`,
      );
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      this.log(
        `[plan-worker] malformed JSON in ${defPath}: ${stringifyErr(err)}`,
      );
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      return;
    }
    const raw = parsed as RawTask;
    const id = asString(raw.id);
    if (id === null) {
      return;
    }
    const runtimeStatus = this.runtimeStatusCache.get(id) ?? "todo";
    const msg = buildTaskMessage(raw, runtimeStatus, this.log);
    if (msg === null) {
      return;
    }
    // Observation gate (fn-629): same producer-side gate as {@link onChange}.
    // The sidecar state file fired this re-emit, but the def file is what
    // we project; if the def file isn't in HEAD yet, stash and wait for
    // the next git-worker pulse to drain it via {@link recheckPending}.
    if (!this.isTracked(defPath)) {
      this.pending.add(defPath);
      return;
    }
    this.pending.delete(defPath);
    this.pathToId.set(defPath, msg.id);
    const serialized = JSON.stringify(msg);
    if (this.lastEmitted.get(msg.id) === serialized) {
      return;
    }
    this.lastEmitted.set(msg.id, serialized);
    this.onSnapshot(msg);
  }

  /**
   * Process a change for `path`. Classifies → reads (bounded) → safe-parses →
   * derives → change-gates → emits. Any failure skips-and-logs without emitting.
   */
  onChange(path: string): void {
    const kind = classifyPlanPath(path);
    if (kind === null) {
      return;
    }

    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch (err) {
      // Read-vs-delete race (file vanished between the watch event and the
      // stat): skip-and-log, keep last good, don't emit.
      this.log(`[plan-worker] stat failed for ${path}: ${stringifyErr(err)}`);
      return;
    }
    if (!st.isFile()) {
      return;
    }
    if (st.size > MAX_PLAN_FILE_BYTES) {
      this.log(
        `[plan-worker] ${path} exceeds ${MAX_PLAN_FILE_BYTES} bytes (${st.size}); skipping`,
      );
      return;
    }

    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      this.log(`[plan-worker] read failed for ${path}: ${stringifyErr(err)}`);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      this.log(`[plan-worker] malformed JSON in ${path}: ${stringifyErr(err)}`);
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      this.log(`[plan-worker] non-object JSON in ${path}; skipping`);
      return;
    }

    // `task-state` (sidecar) updates the per-task runtime-status cache and
    // re-emits a TaskSnapshot composed against the sibling definition file.
    // The sidecar carries only `status`; the projection event is wholesale,
    // so the def file is read and merged in `reemitTaskFromDef`. A malformed
    // `status` value safe-falls-through to `"todo"` via `coerceRuntimeStatus`
    // (the fold never throws).
    if (kind === "task-state") {
      const taskId = taskIdFromStatePath(path);
      if (taskId === null) {
        return;
      }
      const raw = parsed as RawTaskState;
      const runtimeStatus = coerceRuntimeStatus(raw.status, (bad) => {
        this.log(
          `[plan-worker] invalid runtime status in ${path}: ${JSON.stringify(bad)}; defaulting to "todo"`,
        );
      });
      const prior = this.runtimeStatusCache.get(taskId) ?? "todo";
      this.runtimeStatusCache.set(taskId, runtimeStatus);
      if (prior === runtimeStatus) {
        // Same value as already cached: the composed TaskSnapshot wouldn't
        // change and the change-gate would suppress it anyway. Skip the
        // re-emit work.
        return;
      }
      const defPath = taskDefPathFromStatePath(path);
      if (defPath === null) {
        return;
      }
      this.reemitTaskFromDef(defPath);
      return;
    }

    // Pass the scanner's own `log` so a malformed `approval` field is logged
    // through the same sink as every other skip-and-log (stderr in production,
    // captured in tests). The build* functions stay pure otherwise — every
    // other coercion result is a return value, not a side effect.
    let msg: PlanEpicMessage | PlanTaskMessage | null;
    if (kind === "epic") {
      msg = buildEpicMessage(parsed as RawEpic, this.log);
    } else {
      // `kind === "task"`: thread the cached runtime status (default `"todo"`
      // when never observed) so the composed TaskSnapshot carries the sidecar
      // field even when the state file hasn't been read yet.
      const raw = parsed as RawTask;
      const id = asString(raw.id);
      const runtimeStatus =
        id !== null ? (this.runtimeStatusCache.get(id) ?? "todo") : "todo";
      msg = buildTaskMessage(raw, runtimeStatus, this.log);
    }
    if (msg === null) {
      // No usable id — can't key the projection. Skip-and-log.
      this.log(`[plan-worker] ${path} has no usable id; skipping`);
      return;
    }

    // Observation gate (fn-629): for epic/task DEFINITION files, suppress
    // emission unless the file is in git HEAD. An uncommitted file goes to
    // {@link pending}; the worker drains the set on the next git-worker
    // snapshot pulse (commit/checkout/branch-switch may have moved HEAD,
    // and a `git commit` does not change file content so FSEvents will
    // not re-fire). State-file (`task-state`) paths bypass this gate
    // because they bypass this code path entirely (they early-returned
    // above via the `task-state` arm). `isTracked` defaults to
    // `() => true`, so a gateless scanner emits unconditionally.
    //
    // We do NOT touch `pathToId` / `lastEmitted` for a gated path: the
    // reducer never saw the entity, so there is nothing to retract on a
    // delete, and the change-gate has no "last good" to compare against
    // when the file finally lands in HEAD. A pending path is its own
    // index — see {@link pending} / {@link recheckPending} / {@link onDelete}.
    if (!this.isTracked(path)) {
      this.pending.add(path);
      return;
    }
    // The file IS in HEAD now (or the gate is disabled). If this path was
    // previously pending, drop it from the set — it has now drained.
    this.pending.delete(path);

    this.pathToId.set(path, msg.id);
    const serialized = JSON.stringify(msg);
    if (this.lastEmitted.get(msg.id) === serialized) {
      return; // change-gate: unchanged snapshot, suppress.
    }
    this.lastEmitted.set(msg.id, serialized);
    this.onSnapshot(msg);
  }

  /**
   * Re-run {@link onChange} for every path the gate has stashed in
   * {@link pending}. Called by the worker on every git-worker snapshot
   * pulse — a `git commit` does not change the file's content so FSEvents
   * will not re-fire on commit, and without this drain a freshly-committed
   * epic would sit in pending forever (projection-absent, never dispatched).
   *
   * `onChange` re-checks the gate, so a still-uncommitted path stays in
   * pending. The set is iterated by snapshot (`[...]`) so an `onChange`
   * mutation during the loop is safe.
   */
  recheckPending(): void {
    if (this.pending.size === 0) {
      return;
    }
    for (const path of [...this.pending]) {
      this.onChange(path);
    }
  }

  /**
   * Number of paths currently held in the observation gate (uncommitted
   * epic/task files). Test-reach + diagnostic; the live worker doesn't
   * branch on this.
   */
  pendingSize(): number {
    return this.pending.size;
  }

  /**
   * Record that a `.planctl/{epics,tasks}/*.json` file was enumerated on disk
   * during a boot scan — the on-disk census the {@link sweep} diffs against.
   * Called from `scanPlanctlDir` for EVERY file BEFORE `onChange`, so it counts
   * regardless of whether the snapshot parsed or was change-gate-suppressed.
   *
   * The id is derived from the filename (basename minus `.json`), which equals
   * the planctl id — keying off the name (not a parse) means a file mid-rewrite
   * that momentarily fails to parse is still "seen" and never spuriously
   * retracted. A non-`.json` path is ignored.
   */
  markSeen(path: string): void {
    if (!path.endsWith(".json")) {
      return;
    }
    const segments = path.split(sep);
    const base = segments[segments.length - 1];
    const id = base.slice(0, -".json".length);
    if (id.length > 0) {
      this.seenOnDisk.add(id);
    }
  }

  /**
   * Boot-reconciliation sweep. After every configured root's boot scan has run
   * (so {@link seenOnDisk} is the complete on-disk census), retract any
   * projection id with no backing file — a deletion that happened while the
   * daemon was down never fired a live `onDelete`, so without this pass it would
   * leave a permanent ghost.
   *
   * Over-retraction is the danger this method is built to avoid:
   * - **Run AFTER snapshot emission** (the caller invokes it once all boot scans
   *   finished), so a moved/rewritten file is re-emitted, not retracted.
   * - **Scope strictly to configured roots** via the epic's `project_dir`: an
   *   epic whose `project_dir` is outside every `root` (or NULL) is never
   *   touched — its file lives under an unscanned tree, so absence from the
   *   census means nothing. Embedded tasks inherit their parent epic's scope.
   * - **Diff against the actually-enumerated census** ({@link markSeen}, keyed
   *   by filename so a mid-rewrite parse failure still counts as present).
   *
   * Each retraction reuses the task-2 tombstone path (`plan-epic-deleted` /
   * `plan-task-deleted`) so main folds it through the SAME synthetic-event
   * pipeline as a live delete — no new event types. The change-gate entry is
   * dropped after each tombstone, mirroring {@link onDelete}.
   *
   * Read-only: uses the worker's own read-only connection. A malformed stored
   * `tasks` array folds to empty (one bad epic never wedges the sweep).
   */
  sweep(db: Database, roots: string[]): void {
    const epics = db
      .query("SELECT epic_id, project_dir, tasks FROM epics")
      .all() as {
      epic_id: string;
      project_dir: string | null;
      tasks: string | null;
    }[];

    for (const epic of epics) {
      // Scope by the epic's project_dir: only retract ids attributable to a
      // root we actually scanned this boot. An out-of-scope epic (and all its
      // embedded tasks) is left entirely untouched.
      if (!isWithinRoots(epic.project_dir, roots)) {
        continue;
      }

      // Decode the embedded tasks first (so we sweep them whether or not the
      // epic itself survives). A malformed/NULL array → empty.
      let tasks: { task_id?: unknown }[] = [];
      if (epic.tasks != null && epic.tasks.length > 0) {
        try {
          const parsed = JSON.parse(epic.tasks);
          if (Array.isArray(parsed)) {
            tasks = parsed;
          }
        } catch {
          // malformed stored array → treat as empty.
        }
      }
      for (const t of tasks) {
        const taskId = typeof t.task_id === "string" ? t.task_id : null;
        if (taskId == null || this.seenOnDisk.has(taskId)) {
          continue;
        }
        this.onSnapshot({
          kind: "plan-task-deleted",
          id: taskId,
          epicId: epic.epic_id,
        });
        this.lastEmitted.delete(taskId);
      }

      if (!this.seenOnDisk.has(epic.epic_id)) {
        this.onSnapshot({ kind: "plan-epic-deleted", id: epic.epic_id });
        this.lastEmitted.delete(epic.epic_id);
      }
    }
  }
}

/**
 * Is `projectDir` inside (or equal to) one of the configured `roots`? Used to
 * scope the boot sweep so an epic from an unconfigured/unscanned root is never
 * retracted. A NULL/empty `projectDir` is never in scope (we can't attribute it
 * to a scanned tree). Path-segment-aware so `/a/code-x` is NOT treated as inside
 * `/a/code`.
 *
 * Pure. Exported for unit reach.
 */
export function isWithinRoots(
  projectDir: string | null,
  roots: string[],
): boolean {
  if (projectDir == null || projectDir.length === 0) {
    return false;
  }
  for (const root of roots) {
    if (projectDir === root) {
      return true;
    }
    const prefix = root.endsWith(sep) ? root : root + sep;
    if (projectDir.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

/**
 * Build a `plan-epic` message from a parsed epic JSON, or null when the file
 * has no usable id (the projection pk). The number is derived from the id; every
 * other field is taken verbatim (coerced to string-or-null). `approval` rides
 * through {@link coerceApproval} — a missing value silently defaults to
 * `"pending"` (forward-compat with old planctl), an invalid one logs via `log`
 * and falls back to `"pending"` (the CLAUDE.md "safe value" invariant).
 */
export function buildEpicMessage(
  raw: RawEpic,
  log: (msg: string) => void = (m) => console.error(m),
): PlanEpicMessage | null {
  const id = asString(raw.id);
  if (id === null) {
    return null;
  }
  const approval = coerceApproval(raw.approval, (bad) =>
    log(
      `[plan-worker] invalid approval value on epic ${id}: ${JSON.stringify(bad)}; coercing to "pending"`,
    ),
  );
  return {
    kind: "plan-epic",
    id,
    number: epicNumberFromId(id),
    title: asString(raw.title),
    projectDir: asString(raw.primary_repo),
    status: asString(raw.status),
    approval,
    dependsOnEpics: asStringArray(raw.depends_on_epics),
    lastValidatedAt: asString(raw.last_validated_at),
  };
}

/**
 * Build a `plan-task` message from a parsed task JSON + the task's current
 * runtime status (carried in the sibling `.planctl/state/tasks/<id>.state.json`
 * file). Returns null when the task JSON has no usable id.
 *
 * Field derivation:
 * - `workerPhase` is DERIVED from the task definition: `worker_done_at`
 *   present → `"done"` else `"open"`. Surfaces the same compressed signal the
 *   field used to carry under the legacy `status` name.
 * - `runtimeStatus` is the planctl-native enum carried by the state file —
 *   passed in by the caller (the {@link PlanScanner}, which caches the last
 *   per-task value). When absent / never-observed, the caller passes `"todo"`
 *   (planctl's `merge_task_state` default).
 * - `approval` follows the {@link buildEpicMessage} coercion semantics.
 *
 * The OBJECT-LITERAL SLOT ORDER below is load-bearing — the change-gate
 * compares `JSON.stringify` output byte-for-byte, and the seed reconstruction
 * in {@link seedFromDb} must produce identical key order or every task
 * re-emits a synthetic snapshot on every daemon boot.
 */
export function buildTaskMessage(
  raw: RawTask,
  runtimeStatus: string = "todo",
  log: (msg: string) => void = (m) => console.error(m),
): PlanTaskMessage | null {
  const id = asString(raw.id);
  if (id === null) {
    return null;
  }
  const approval = coerceApproval(raw.approval, (bad) =>
    log(
      `[plan-worker] invalid approval value on task ${id}: ${JSON.stringify(bad)}; coercing to "pending"`,
    ),
  );
  return {
    kind: "plan-task",
    id,
    epicId: asString(raw.epic),
    number: taskNumberFromId(id),
    title: asString(raw.title),
    targetRepo: asString(raw.target_repo),
    tier: asString(raw.tier),
    workerPhase: asString(raw.worker_done_at) !== null ? "done" : "open",
    runtimeStatus,
    approval,
    dependsOn: asStringArray(raw.depends_on),
  };
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Find the `.planctl` ancestor of `path` — the parent of the parent (because
 * `path` is `.planctl/{epics,tasks}/<id>.json`). Returns the parent dir of
 * `.planctl` (the planctl-managed repo root in keeper's layout) or `null` if
 * `.planctl` isn't found in the ancestry. Pure path arithmetic.
 *
 * fn-629 observation gate: the live worker uses this to derive the repo
 * root to run `git cat-file -e HEAD:<relpath>` against without a per-path
 * shell-out (`git rev-parse --show-toplevel` per call would be a
 * 100ms-class per-file cost on a `~/code` storm). The planctl tree IS
 * always at the repo root — planctl writes via `_resolve_repo_root` which
 * calls `git rev-parse --show-toplevel` and refuses to operate on a
 * non-git tree — so the `.planctl` parent equals the repo root by
 * construction. A future subtree-planctl layout would need to switch to
 * `git rev-parse`.
 */
export function repoRootFromPlanctlPath(path: string): string | null {
  // Walk up from `path` looking for a `.planctl` directory; return its parent.
  // The shape is always `.../<root>/.planctl/{epics,tasks}/<id>.json` so the
  // `.planctl` element sits at depth `n-3` from the basename. We could index
  // directly, but a walk is more robust against any future shape drift.
  let cur = dirname(path);
  while (cur !== "" && cur !== "/" && cur !== ".") {
    const parent = dirname(cur);
    if (parent === cur) {
      return null; // hit filesystem root without finding .planctl
    }
    const segments = cur.split(sep);
    if (segments[segments.length - 1] === ".planctl") {
      return parent;
    }
    cur = parent;
  }
  return null;
}

/**
 * fn-629 observation gate predicate: is `path` in git HEAD (committed)?
 * Returns `false` for untracked paths AND for staged-but-not-committed
 * paths (the planctl commit-failed window the gate exists to close).
 *
 * Implementation: `git -C <root> cat-file -e HEAD:<relpath>` — exits 0 iff
 * the path exists in the HEAD tree. Hits the object DB without scanning
 * the index or worktree, so it's fast (~5-10ms per call) and cannot block
 * the watcher callback for long even under a churning planctl tree. The
 * subprocess is bounded by {@link GIT_CHECK_TIMEOUT_MS}.
 *
 * Edge cases handled by returning `false` (fail closed — never wrongly
 * announce a file as committed):
 * - Path is not inside a `.planctl` tree (shouldn't happen, the caller
 *   already classified) — no repo root resolvable → `false`.
 * - `git` shell-out fails (not a git repo, no commits yet, timeout) →
 *   `false`. The next git-worker pulse will retry.
 * - Path is outside the resolved repo root → `false`.
 *
 * Exported for unit reach.
 */
export function isPathInHead(path: string): boolean {
  const root = repoRootFromPlanctlPath(path);
  if (root === null) {
    return false;
  }
  const rel = relative(root, path);
  if (rel.length === 0 || rel.startsWith("..") || rel.startsWith(sep)) {
    return false;
  }
  try {
    const res = Bun.spawnSync(
      ["git", "-C", root, "cat-file", "-e", `HEAD:${rel}`],
      {
        stdout: "ignore",
        stderr: "ignore",
        timeout: GIT_CHECK_TIMEOUT_MS,
      },
    );
    return res.success && res.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Subprocess timeout for {@link isPathInHead}. 1s is far above the
 * ~5-10ms object-DB lookup but well under a watcher-callback budget — a
 * pathological git repo can hang on `cat-file` (corrupt loose object,
 * locked index, NFS stall) and we'd rather fail closed (file reads as
 * not-in-HEAD; the next git-worker pulse retries) than wedge the callback.
 */
const GIT_CHECK_TIMEOUT_MS = 1000;

/**
 * Periodic reconcile cadence — mirrors `git-worker.ts` HEARTBEAT_MS so the
 * two producer workers share one schedule and the steady-state cost is
 * predictable. 60s is the cheap convergence backstop for the
 * brand-new-repo case the commit-trigger can't cover (git-worker only
 * watches a repo's `.git` after an epic row for it exists, so the FIRST
 * `.planctl` scaffold in a fresh repo has no commit signal — only this
 * heartbeat + the broad FSEvents subscription stand between it and
 * "needs a daemon restart"). Exported for unit reach (tests assert on
 * the constant rather than the timer plumbing).
 */
export const RECONCILE_HEARTBEAT_MS = 60_000;

/**
 * Boot scan: recursively walk `root` for `.planctl/{epics,tasks}/*.json` files
 * and run each through the scanner. Called once after each subscribe resolves so
 * files that pre-existed the daemon's boot (or were changed while keeperd was
 * down) are picked up without waiting for a watcher event. The change-gate in
 * PlanScanner suppresses re-emits for files that already match the seeded
 * projection row. Exported for unit reach.
 *
 * The walk MUST recurse: the live `@parcel/watcher` subscribe is recursive, and
 * plan files live at `<root>/<project>/.planctl/…` — there is no `.planctl` at
 * the root itself. A non-recursive scan finds nothing under a broad root, so
 * only files touched while keeperd is live would ever enter the projection.
 * {@link PRUNE_DIRS} keeps the walk cheap (skips `node_modules`/`.git`/… under a
 * big root); a `.planctl` dir is scanned but NOT descended into; symlinked
 * directories are not followed (`Dirent.isDirectory()` is false for a symlink),
 * so a symlink cycle can't trap the walk.
 */
export function scanRoot(root: string, scanner: PlanScanner): void {
  const stack: string[] = [root];
  while (stack.length > 0) {
    // biome-ignore lint/style/noNonNullAssertion: guarded by stack.length > 0
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      console.error(
        `[plan-worker] boot scan failed to read ${dir}: ${stringifyErr(err)}`,
      );
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || PRUNE_DIRS.has(entry.name)) {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.name === ".planctl") {
        scanPlanctlDir(full, scanner);
        continue; // a `.planctl` tree has no nested `.planctl` to find
      }
      stack.push(full);
    }
  }
}

/**
 * Enumerate one `.planctl` dir's `state/tasks/` + `epics/` + `tasks/` files
 * and run each through the scanner. A missing subdir is fine (skip). The
 * change-gate handles re-emit suppression.
 *
 * The `state/tasks/` pass runs FIRST so the per-task runtime-status cache is
 * primed before any task definition file is read: a state file existing at
 * daemon boot (planctl's `LocalFileStateStore` writes `<id>.state.json` on
 * every status transition) would otherwise be ignored until the next live
 * write touched it, and the projection's `runtime_status` would silently
 * read the cache-miss default `"todo"` for the entire window. Priming
 * before the `tasks/` loop means the first `TaskSnapshot` emitted for each
 * definition already carries the correct `runtime_status` and no redundant
 * re-emit fires.
 *
 * State files are NOT enrolled in the on-disk census (no {@link markSeen}
 * call) — they are a sidecar projection layered onto task ids that enrol
 * via their definition file under `tasks/`. The boot-reconciliation sweep
 * retracts on missing definition files; a sidecar's absence is the cache's
 * `"todo"` default, not a tombstone.
 */
function scanPlanctlDir(planctlDir: string, scanner: PlanScanner): void {
  // Pass 1: prime `runtimeStatusCache` from `state/tasks/*.state.json`. A
  // missing dir is fine (fresh clone with no state files yet). Each file is
  // bounded-read + safe-parsed + coerced through the same guard as the live
  // `task-state` onChange arm, so the cache only holds the four-value enum
  // vocabulary; malformed JSON / bad-status / oversized files skip-and-log
  // without poisoning the cache. The cache write is the only side effect:
  // no snapshot emits here.
  const stateDir = join(planctlDir, "state", "tasks");
  let stateNames: string[];
  try {
    stateNames = readdirSync(stateDir);
  } catch {
    stateNames = []; // No state/tasks/ subdir — nothing to prime.
  }
  for (const name of stateNames) {
    if (!name.endsWith(".state.json")) {
      continue;
    }
    const taskId = name.slice(0, -".state.json".length);
    if (taskId.length === 0) {
      continue;
    }
    const full = join(stateDir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch (err) {
      console.error(
        `[plan-worker] boot scan stat failed for ${full}: ${stringifyErr(err)}`,
      );
      continue;
    }
    if (!st.isFile() || st.size > MAX_PLAN_FILE_BYTES) {
      continue;
    }
    let text: string;
    try {
      text = readFileSync(full, "utf8");
    } catch (err) {
      console.error(
        `[plan-worker] boot scan read failed for ${full}: ${stringifyErr(err)}`,
      );
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      console.error(
        `[plan-worker] boot scan malformed JSON in ${full}: ${stringifyErr(err)}`,
      );
      continue;
    }
    if (!parsed || typeof parsed !== "object") {
      continue;
    }
    const raw = parsed as { status?: unknown };
    let primed = true;
    const coerced = coerceRuntimeStatus(raw.status, (bad) => {
      // Match the live onChange arm: an invalid value logs and is SKIPPED
      // (no cache write), so the cache only holds the four-value vocabulary.
      // The cache miss reads as the planctl default "todo" downstream.
      console.error(
        `[plan-worker] boot scan invalid runtime status in ${full}: ${JSON.stringify(bad)}; skipping cache prime`,
      );
      primed = false;
    });
    if (!primed) {
      continue;
    }
    scanner.primeRuntimeStatus(taskId, coerced);
  }

  // Pass 2: enumerate the canonical definition trees. Tasks now read the
  // primed cache so their first emitted snapshot carries the correct
  // runtime_status.
  for (const collection of ["epics", "tasks"]) {
    const dir = join(planctlDir, collection);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      // No epics/ or tasks/ subdir under this .planctl — nothing to scan.
      continue;
    }
    for (const name of names) {
      if (name.endsWith(".json")) {
        const full = join(dir, name);
        // Record the on-disk census FIRST (filename-keyed, parse-independent),
        // then run the snapshot read. The sweep diffs the projection against
        // this census; marking before onChange keeps a mid-rewrite parse
        // failure from looking "absent".
        scanner.markSeen(full);
        scanner.onChange(full);
      }
    }
  }
}

/**
 * Shallow discovery of `<root>/<project>/.planctl` dirs across the configured
 * roots — the cheap convergence backstop the periodic reconcile and on-drop
 * recovery share (epic fn-681).
 *
 * One level deep ONLY: for each `root`, read its top-level entries and emit
 * `<root>/<entry>/.planctl` for every directory entry whose name isn't in
 * {@link PRUNE_DIRS} and whose `.planctl` child is a real directory. Heavy
 * vendored trees (`node_modules`, `.git`, …) are skipped at the project-name
 * step, so a broad root like `~/code` stays O(#projects) instead of
 * O(`~/code` tree). No recursive descent — a project nested deeper than one
 * level under a configured root is intentionally out of scope (the live
 * recursive FSEvents watch + boot {@link scanRoot} cover those cases; this
 * helper exists for the cheap heartbeat / drop-recovery path).
 *
 * Symlinked directories are not followed (`Dirent.isDirectory()` is false
 * for a symlink), so a symlink cycle can't trap the walk. A missing root
 * skip-and-logs (same discipline as {@link scanRoot}). Pure I/O — no DB
 * read, no event emission; the change-gate side effect lives downstream in
 * {@link scanPlanctlDir}. Exported for unit reach.
 */
export function discoverPlanctlDirs(roots: readonly string[]): string[] {
  const dirs: string[] = [];
  for (const root of roots) {
    let entries: Dirent[];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch (err) {
      console.error(
        `[plan-worker] discoverPlanctlDirs failed to read ${root}: ${stringifyErr(err)}`,
      );
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || PRUNE_DIRS.has(entry.name)) {
        continue;
      }
      const planctl = join(root, entry.name, ".planctl");
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(planctl);
      } catch {
        // No `.planctl` under this project — common case.
        continue;
      }
      if (st.isDirectory()) {
        dirs.push(planctl);
      }
    }
  }
  return dirs;
}

/**
 * ADDITIVE re-ingest of every `<root>/<project>/.planctl` dir discovered by
 * {@link discoverPlanctlDirs} via the change-gated {@link scanPlanctlDir}
 * primitive — the heartbeat backstop and on-drop recovery path (epic
 * fn-681).
 *
 * "Additive" is the load-bearing word: this path NEVER calls
 * {@link PlanScanner.sweep}, so a transient read failure / mid-rewrite
 * parse miss / file that hasn't shown up yet can NOT produce a false
 * tombstone. Deletions stay owned exclusively by (1) the live FSEvents
 * `onDelete`, (2) the commit-trigger `planctl-commit-changed` arm
 * (`git rm` is a `committed_mode: 0` zero-oid sentinel), and (3) the
 * one-shot boot sweep — none of which run on this code path.
 *
 * Steady-state cost: one shallow `readdirSync` per root + one `statSync`
 * per top-level entry + one shallow `readdirSync` per `.planctl/{epics,tasks,
 * state/tasks}` + one bounded read + parse per planctl file. The
 * change-gate (`PlanScanner.lastEmitted`) suppresses re-emits for unchanged
 * files, so a quiescent repo emits nothing across heartbeats.
 *
 * Per-dir failures inside {@link scanPlanctlDir} skip-and-log (the same
 * discipline as the boot scan); the loop never throws. Exported for unit
 * reach.
 */
export function reconcilePlanctlDirs(
  roots: readonly string[],
  scanner: PlanScanner,
): void {
  const dirs = discoverPlanctlDirs(roots);
  for (const dir of dirs) {
    scanPlanctlDir(dir, scanner);
  }
}

/**
 * Seed the scanner's change-gate from the keeper DB: for each persisted
 * `epics`/`tasks` row, reconstruct the message the scanner would emit for that
 * row and seed its serialized form. So a daemon restart's full re-scan does not
 * re-emit a synthetic event for a plan file that is byte-identical to its
 * already-folded projection row.
 *
 * The reconstruction MUST match {@link buildEpicMessage} / {@link buildTaskMessage}
 * field-for-field, since the change-gate compares serialized messages.
 *
 * Read-only — uses the worker's own read-only connection. Exported for the
 * worker `main` (and unit reach).
 */
export function seedFromDb(db: Database, scanner: PlanScanner): void {
  // The seed reconstruction MUST mirror what `buildEpicMessage` /
  // `buildTaskMessage` produce for the same on-disk file: the change-gate
  // compares serialized messages, so any drift re-emits a synthetic event for
  // every plan file on every boot. The reconstructed messages carry NO `jobs`
  // arrays — jobs are live state, NOT plan-file truth. The reducer's
  // `syncJobIntoEpic` fan-out bumps `epics.last_event_id` and rewrites
  // `epics.jobs` / `task.jobs` independently; including them here would feed
  // back into the seed signature on every boot and re-emit every snapshot
  // (the worst-case feedback loop documented in the epic's Risks section).
  const epics = db
    .query(
      "SELECT epic_id, epic_number, title, project_dir, status, approval, depends_on_epics, last_validated_at, tasks FROM epics",
    )
    .all() as {
    epic_id: string;
    epic_number: number | null;
    title: string | null;
    project_dir: string | null;
    status: string | null;
    approval: string | null;
    depends_on_epics: string | null;
    last_validated_at: string | null;
    tasks: string | null;
  }[];
  for (const e of epics) {
    const msg: PlanEpicMessage = {
      kind: "plan-epic",
      id: e.epic_id,
      number: e.epic_number,
      title: e.title,
      projectDir: e.project_dir,
      status: e.status,
      // The schema column has NOT NULL DEFAULT 'pending'; coerce defensively
      // anyway (legacy DB / hand-write) so the reconstructed seed matches a
      // fresh scan of a file whose `approval` field is missing or invalid —
      // both fold to `"pending"`. A schema-resident invalid value (someone
      // hand-rewrote the column off-enum) would have been logged at fold time,
      // not here, so the silent path is correct.
      approval: coerceApproval(e.approval),
      dependsOnEpics: parseStringArrayColumn(e.depends_on_epics),
      // `last_validated_at` is a nullable TEXT column; `asString` collapses
      // any non-string / empty-string stored value to `null`, mirroring the
      // producer-side coercion in `buildEpicMessage`. Object-literal slot
      // position MUST match `buildEpicMessage`'s return — the change-gate
      // compares `JSON.stringify` output byte-for-byte, and a slot mismatch
      // would re-emit one synthetic `EpicSnapshot` per epic every boot.
      lastValidatedAt: asString(e.last_validated_at),
    };
    scanner.seed(e.epic_id, JSON.stringify(msg));

    // As of schema v7 each epic embeds its tasks as a JSON-array column. Decode
    // it and reconstruct each task's seed message field-for-field to match
    // {@link buildTaskMessage} — `taskNumberFromId` for the number,
    // `status ?? "open"` for the derived status — or the change-gate would
    // re-emit every plan-task on every boot. A malformed/NULL array is treated
    // as empty (one bad row never wedges the seed).
    //
    // The stored task element may carry a `jobs` sub-array (schema v11) — it
    // is intentionally NOT read here. Jobs are live state, not plan-file truth;
    // the reconstructed task message must match what `buildTaskMessage`
    // produces from the on-disk file (which has no `jobs`), or the change-gate
    // re-emits every plan-task on every boot whenever a job tick fans into
    // `task.jobs`.
    let tasks: {
      task_id: string;
      epic_id: string | null;
      title: string | null;
      target_repo: string | null;
      /**
       * Planctl-native effort tier (fn-602). Absent on pre-fn-602 stored
       * task elements; read defensively (`?? null`) so the reconstructed
       * `PlanTaskMessage.tier` matches `buildTaskMessage`'s output on a
       * fresh re-scan and the change-gate suppresses correctly across the
       * upgrade window.
       */
      tier?: string | null;
      // Legacy column name in the embedded JSON — pre-schema-bump rows carry
      // `status`; post-bump rows carry `worker_phase`. Both are read
      // defensively (whichever is present feeds `workerPhase`) so the seed
      // reconstruction works across the migration window.
      status?: string | null;
      worker_phase?: string | null;
      runtime_status?: string | null;
      approval?: unknown;
      depends_on?: unknown;
    }[] = [];
    if (e.tasks != null && e.tasks.length > 0) {
      try {
        const parsed = JSON.parse(e.tasks);
        if (Array.isArray(parsed)) {
          tasks = parsed;
        }
      } catch {
        // malformed stored array → treat as empty.
      }
    }
    for (const t of tasks) {
      const msg: PlanTaskMessage = {
        kind: "plan-task",
        id: t.task_id,
        epicId: t.epic_id,
        // Reconstruct the number from the id (matches buildTaskMessage), NOT
        // the stored task_number, so a fresh scan's message is byte-identical.
        number: taskNumberFromId(t.task_id),
        title: t.title,
        targetRepo: t.target_repo,
        // Planctl-native effort tier (fn-602). Pre-fn-602 stored elements
        // lack the key — `?? null` matches `buildTaskMessage`'s
        // `asString(raw.tier)` on a tier-less task file so the change-gate
        // byte-compare suppresses on restart.
        tier: t.tier ?? null,
        // The projection stores the derived worker-phase verbatim under
        // `worker_phase` (post-bump) or the legacy `status` key (pre-bump);
        // read whichever is present and default to "open" for a NULL so the
        // reconstructed seed matches a fresh scan.
        workerPhase: t.worker_phase ?? t.status ?? "open",
        // The projection stores the planctl-native runtime status under
        // `runtime_status`; default to "todo" for a (legacy / pre-bump) NULL
        // so the reconstructed seed matches a fresh scan whose state file
        // hasn't been read yet (planctl's `merge_task_state` convention).
        runtimeStatus: t.runtime_status ?? "todo",
        // Same defensive coercion as buildTaskMessage so the seed is
        // byte-identical with what a fresh scan would emit; a legacy task
        // element without `approval` reconstructs to "pending" (matches the
        // on-disk default for files predating this field).
        approval: coerceApproval(t.approval),
        // Same coercion as buildTaskMessage so the seed is byte-identical; a
        // (legacy) task element without `depends_on` reconstructs to [].
        dependsOn: asStringArray(t.depends_on),
      };
      scanner.seed(t.task_id, JSON.stringify(msg));
    }
  }
}

/**
 * Worker entrypoint. Opens its own read-only connection, seeds the change-gate,
 * subscribes ONE recursive watch per root, routes each change event into the
 * scanner, and posts a snapshot message per changed plan file. Each subscription
 * is an owned external resource — all `unsubscribe()`d in the shutdown handler.
 */
function main(): void {
  if (!parentPort) {
    console.error("[plan-worker] no parentPort — not running as a Worker");
    process.exit(1);
  }

  const data = workerData as PlanWorkerData | undefined;
  if (!data || typeof data.dbPath !== "string" || !Array.isArray(data.roots)) {
    console.error("[plan-worker] missing dbPath/roots in workerData");
    process.exit(1);
  }

  const { db } = openDb(data.dbPath, { readonly: true });
  const port = parentPort;
  // fn-629 observation gate: the live worker passes `isPathInHead` so an
  // uncommitted epic/task file lands in the scanner's pending set instead
  // of emitting a snapshot. Main drives the drain by posting
  // {@link RecheckPendingMessage} on every git-worker `GitSnapshot` pulse
  // (the cross-worker "HEAD may have moved" signal).
  const scanner = new PlanScanner(
    (msg) => {
      port.postMessage(msg);
    },
    (m) => console.error(m),
    isPathInHead,
  );

  // Restart-seed: don't re-emit a snapshot already folded into the projection.
  try {
    seedFromDb(db, scanner);
  } catch (err) {
    // Non-fatal: worst case a stale snapshot re-emits once (the reducer's
    // idempotent upsert makes that a no-op anyway).
    console.error(`[plan-worker] restart-seed failed: ${stringifyErr(err)}`);
  }

  const subscriptions: AsyncSubscription[] = [];
  // One drop-recovery scheduler per root (each subscribe callback closes over
  // its own `root`). Cleared in shutdown BEFORE unsubscribe so a queued re-scan
  // can't touch a closing DB.
  const schedulers: RescanScheduler[] = [];
  // fn-681 periodic reconcile backstop: a low-frequency heartbeat re-runs
  // `reconcilePlanctlDirs` across every configured root, so a brand-new
  // repo's first scaffold converges within one interval even if FSEvents
  // dropped its burst AND git-worker isn't yet watching it (it only
  // starts watching a repo's `.git` once an epic row for it exists).
  // Cancelled in shutdown alongside the drop-recovery schedulers.
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let shuttingDown = false;

  const closeDb = (): void => {
    try {
      db.close();
    } catch {
      // best-effort; exiting either way
    }
  };

  parentPort.on("message", (msg: InboundMessage | undefined) => {
    if (!msg) return;
    if (msg.type === "recheck-pending") {
      // fn-629: main observed a `GitSnapshot` events row land — HEAD may
      // have advanced. Drain the observation gate's pending set so a
      // freshly-committed epic/task file emits its snapshot. Idempotent
      // and cheap when the set is empty.
      if (shuttingDown) return;
      try {
        scanner.recheckPending();
      } catch (err) {
        console.error(
          `[plan-worker] recheckPending failed: ${stringifyErr(err)}`,
        );
      }
      return;
    }
    if (msg.type === "planctl-commit-changed") {
      // fn-681: authoritative ingest trigger. The git-worker just observed
      // a commit landing in `msg.repo` carrying changed `.planctl/**`
      // paths; re-ingest each from the COMMITTED worktree bytes via the
      // existing idempotent `onChange` / `onDelete` paths. Drop-proof
      // (independent of the broad `~/code` FSEvents subscription) and
      // free of the mid-write partial-read race (planctl commits
      // atomically). Duplicate fires from a live FSEvent are no-ops via
      // the change-gate. The per-path try/catch mirrors `onChange`'s own
      // skip-and-log discipline so one malformed file in a many-file
      // commit can't stall the rest of the batch.
      if (shuttingDown) return;
      for (const change of msg.changes) {
        const abs = join(msg.repo, change.path);
        try {
          if (change.op === "delete") {
            scanner.onDelete(abs);
          } else {
            scanner.onChange(abs);
          }
        } catch (err) {
          console.error(
            `[plan-worker] commit-driven ingest failed for ${abs}: ${stringifyErr(err)}`,
          );
        }
      }
      return;
    }
    if (msg.type === "shutdown") {
      shuttingDown = true;
      // Clear every armed re-scan timer FIRST (before unsubscribe / db close) so
      // a pending drop-recovery scan can't fire against a closing connection.
      for (const sched of schedulers.splice(0)) {
        sched.cancel();
      }
      // fn-681: cancel the periodic-reconcile heartbeat alongside the
      // drop-recovery schedulers so it can't tick against a closing DB
      // (mirrors the schedulers' BEFORE-unsubscribe ordering — the scan
      // re-checks `shuttingDown` belt-and-suspenders, but the clear is
      // what prevents a leaked timer under `bun test --isolate`).
      if (heartbeatTimer != null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      // Release every subscription (external resources), then the db, then exit
      // clean. Mirrors transcript-worker's teardown but over an array.
      void (async () => {
        for (const sub of subscriptions.splice(0)) {
          try {
            await sub.unsubscribe();
          } catch {
            // best-effort
          }
        }
        closeDb();
        process.exit(0);
      })();
    }
  });

  // fn-681 periodic reconcile backstop. Independent of the @parcel/watcher
  // subscription (so it still ticks if the addon load is delayed) and of
  // git-worker's commit signal (so it covers the brand-new-repo case where
  // no `.git` is yet watched). The scan re-checks `shuttingDown` belt-and-
  // suspenders; the timer itself is cleared in the shutdown handler above.
  // Reuses the change-gated {@link reconcilePlanctlDirs} primitive — a
  // quiescent repo emits nothing across heartbeats.
  heartbeatTimer = setInterval(() => {
    if (shuttingDown) return;
    try {
      reconcilePlanctlDirs(data.roots, scanner);
    } catch (err) {
      console.error(
        `[plan-worker] periodic reconcile failed: ${stringifyErr(err)}`,
      );
    }
  }, RECONCILE_HEARTBEAT_MS);

  // ONE recursive subscribe per root. A missing root is tolerated (skip-and-log,
  // keep watching the others). A per-root subscribe rejection is logged but does
  // NOT kill the other roots' watching — only a complete failure to load the
  // addon (which rejects every subscribe) effectively wedges the worker, and the
  // launchd restart is the recovery. We register each subscription as it
  // resolves; if shutdown raced ahead, we release it immediately.
  // Boot-reconciliation barrier: the sweep can only run once EVERY root's boot
  // scan has populated the on-disk census (a ghost is "a projection id no root
  // saw"). Count per-root boot-scan completions (success OR failure — a root
  // whose subscribe rejected contributes nothing to the census but must not
  // stall the barrier) and fire the sweep on the last one. `data.roots` is fixed
  // at spawn, so the target count is known up front.
  const rootCount = data.roots.length;
  let bootScansDone = 0;
  const noteBootScanDone = (): void => {
    bootScansDone += 1;
    if (bootScansDone < rootCount || shuttingDown) {
      return;
    }
    // All roots scanned. Retract any projection ghost (file deleted while the
    // daemon was down) — scoped to configured roots, AFTER snapshot emission.
    try {
      scanner.sweep(db, data.roots);
    } catch (err) {
      console.error(`[plan-worker] boot sweep failed: ${stringifyErr(err)}`);
    }
  };

  void import("@parcel/watcher")
    .then((watcher) => {
      for (const root of data.roots) {
        if (!existsSync(root)) {
          console.error(
            `[plan-worker] root ${root} does not exist; not watching`,
          );
          // A non-existent root never scans, but it still counts toward the
          // barrier — otherwise a missing root would stall the sweep forever.
          noteBootScanDone();
          continue;
        }
        // Per-root drop-recovery scheduler: a recoverable FSEvents drop schedules
        // a debounced, single-flight re-scan of THIS root's `.planctl` dirs via
        // the change-gated {@link reconcilePlanctlDirs} primitive — never an
        // unsubscribe+re-subscribe (the subscription stays alive; re-subscribing
        // would open a no-watch gap). The warm in-memory change-gate
        // (PlanScanner.lastEmitted) suppresses re-emits for unchanged files, so
        // recovery is idempotent. The scan re-checks shuttingDown so a queued
        // scan can't touch a closing DB.
        //
        // fn-681: scoped to `.planctl` dirs (O(#projects)), NOT the full
        // recursive walk over the whole `~/code` tree the boot scan does.
        // The commit path (`planctl-commit-changed`) + the boot sweep
        // continue to handle deletions, so an additive shallow rescan is
        // sufficient for the live drop-recovery window and dramatically
        // cheaper than re-walking the entire root.
        const rescan = new RescanScheduler(() => {
          if (shuttingDown) {
            return;
          }
          reconcilePlanctlDirs([root], scanner);
        });
        schedulers.push(rescan);
        watcher
          .subscribe(
            root,
            (err, events) => {
              if (err) {
                // Always leave a breadcrumb so a future @parcel/watcher wording
                // change (the drop discriminator couples to its message text) is
                // observable in the logs.
                console.error(
                  `[plan-worker] watcher error for ${root}: ${stringifyErr(err)}`,
                );
                // A recoverable FSEvents drop ("...must be re-scanned"): the lost
                // change may never re-fire, so schedule a debounced re-scan. A
                // non-drop err keeps today's swallow-and-log (additive only — no
                // change to fatal/escalation behavior).
                if (isDropError(err)) {
                  rescan.schedule();
                }
                return;
              }
              for (const ev of events) {
                // The in-callback `.planctl/{epics,tasks}/*.json` filter (via
                // classifyPlanPath, applied inside onChange) is what guarantees
                // only real plan files reach the read path — the positive ignore
                // globs are belt-and-suspenders perf, not the correctness gate.
                // Route on path+existence, NOT event.type (planctl writes via
                // atomic os.replace, so an update may surface as create/rename).
                if (ev.type === "delete") {
                  scanner.onDelete(ev.path);
                  continue;
                }
                scanner.onChange(ev.path);
              }
            },
            { ignore: IGNORE_GLOBS },
          )
          .then((sub) => {
            if (shuttingDown) {
              // Shutdown raced the subscribe resolution — release immediately.
              void sub.unsubscribe();
              noteBootScanDone();
              return;
            }
            subscriptions.push(sub);
            // Boot scan: pick up files that pre-existed this daemon's start
            // (or were changed while keeperd was down) without waiting for a
            // watcher event. The change-gate suppresses unchanged files.
            scanRoot(root, scanner);
            // This root's census is now recorded; advance the sweep barrier.
            noteBootScanDone();
          })
          .catch((err) => {
            // Per-root isolation: one root's subscribe failure must not kill the
            // others. Log and continue (no process exit).
            console.error(
              `[plan-worker] failed to subscribe to ${root}: ${stringifyErr(err)}`,
            );
            // A failed subscribe scanned nothing, but still advances the barrier
            // so a single bad root can't stall the sweep for the others.
            noteBootScanDone();
          });
      }
    })
    .catch((err) => {
      // The addon itself failed to load — the sole unrecoverable surface.
      console.error(
        `[plan-worker] failed to load @parcel/watcher: ${stringifyErr(err)}`,
      );
      closeDb();
      process.exit(1);
    });
}

// Only run inside a real Worker; a plain import on the main thread (tests
// driving the pure PlanScanner) is inert.
if (!isMainThread) {
  main();
}
