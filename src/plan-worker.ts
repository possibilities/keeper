/**
 * Plan worker — a Bun Worker thread and event *producer*: it watches each
 * configured project root for `<data-dir>/{epics,tasks}/*.json` files, parses
 * the current file on each change, and posts typed snapshot messages to the
 * parent. The data dir is `.keeper/` — see {@link DATA_DIR_NAMES}; a board folds
 * into the `epics` projection from there. Main (and only main) turns those
 * snapshots into synthetic `EpicSnapshot` / `TaskSnapshot` events rows. The
 * worker never writes the DB — a READ-ONLY connection (for the restart-seed) and
 * posted messages only, keeping main the sole writer.
 *
 * Producer-worker archetype (cloned from `transcript-worker.ts`):
 * - `isMainThread`-guarded body — a plain `import` is inert; the pure
 *   `PlanScanner` core is exported and drivable with no Worker or watcher.
 * - Own read-only `openDb(path, { readonly: true })`.
 * - Typed protocol: `{ kind }` worker→main, `{ type: "shutdown" }` main→worker.
 *   Exit `0` clean / `1` crash. NO in-process self-heal.
 * - Each `@parcel/watcher` subscription is an external resource the worker owns
 *   and `unsubscribe()`s in its shutdown handler.
 *
 * The native file watcher is allowed here despite the ban on watching keeper's
 * OWN DB: the `.keeper` trees are EXTERNAL files written by `keeper plan`, so the
 * same-process-write blind spot does not apply. Every watch event is "go look",
 * never the data: each fires an `fstat` + size-bounded re-read + safe-parse,
 * routed on path+existence (`keeper plan` writes via atomic `os.replace`, so an
 * update may surface as create/rename). The fast `PRAGMA data_version` poll runs
 * on keeper's OWN read-only connection (the sanctioned DB-change primitive),
 * purely as a TRIGGER — the snapshot data still comes only from a parsed
 * `.keeper` file.
 *
 * Watching strategy: ONE recursive `@parcel/watcher` subscribe per root with
 * POSITIVE ignore globs (see {@link IGNORE_GLOBS}) so a git/npm storm doesn't
 * flood the callback. NOT a negation glob — parcel breaks on negated patterns
 * (parcel-bundler/watcher #174). The `<data-dir>/{epics,tasks}/*.json` filter is
 * an in-callback check ({@link classifyPlanPath}), keyed on the `.keeper/`
 * data-dir name.
 *
 * RESTART REQUIRED to apply this data-dir set: the recursive subscription + the
 * boot scan are wired once at worker spawn. A running daemon keeps folding the
 * dir names it booted with — bounce the daemon to re-wire the watch.
 *
 * Internal guards (skip-and-log, never escalate): a missing root, per-file read
 * errors, oversize files, and torn/malformed JSON all log and continue without
 * emitting. Only an unrecoverable failure (the `subscribe` rejecting, the addon
 * failing to load) exits non-zero → daemon `fatalExit` → launchd restart.
 *
 * Boot reconciliation: a file deleted while the daemon was DOWN fires no live
 * `onDelete`, leaving a projection ghost. After every root's boot scan,
 * {@link PlanScanner.sweep} retracts any projection id with no backing file —
 * scoped to configured roots, run AFTER emission so a moved/rewritten file is
 * re-emitted, not retracted. Each retraction rides the SAME tombstone path as a
 * live delete.
 *
 * Multi-layer ingest: the authoritative path is the commit-trigger
 * (`plan-commit-changed` → re-ingest the committed bytes, drop-proof and free
 * of the mid-write partial-read race); the fast `data_version` poll drives a
 * gated {@link PlanScanner.recheckPending} drain plus a change-gated
 * {@link reconcilePlanDirs} re-scan, collapsing close→emit for any repo
 * keeper already watches; the periodic reconcile heartbeat is the paranoia
 * backstop for the brand-new-repo case no DB write accompanies; and the broad
 * `@parcel/watcher` subscription is the best-effort live path, the only one for
 * uncommitted edits but exposed to FSEvents drops. All layers are ADDITIVE
 * re-ingest, idempotent via the change-gate. The poll is a TRIGGER ONLY — it
 * never writes the DB nor bypasses the in-HEAD gate, preserving re-fold
 * determinism and the dup-dispatch guard.
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
import {
  BackstopCounters,
  type BackstopMessage,
  BackstopRateLimiter,
  buildMissedWakeRecord,
  buildTimeoutRecord,
} from "./backstop-telemetry";
import { openDb } from "./db";
import { NotadbTolerance } from "./notadb-tolerance";
import { isDropError, RescanScheduler } from "./rescan";

/**
 * Data the parent passes via `new Worker(url, { workerData })`. Only path
 * strings cross the boundary — the Database handle and the subscriptions cannot.
 */
export interface PlanWorkerData {
  dbPath: string;
  /**
   * The project roots to watch (each scanned recursively for `.keeper` trees).
   * The parent resolves these from `resolvePlanRoots()` (config → absolute,
   * existing dirs). Overridable so tests point at hermetic tmp dirs.
   */
  roots: string[];
  /**
   * Fast `data_version` poll cadence in ms. Defaults to
   * {@link PLAN_DB_POLL_MS} when omitted; tests pass a small value to assert
   * realtime emission without a heartbeat-length wait. The live daemon leaves
   * it unset (the production cadence is the constant).
   */
  pollMs?: number;
  /**
   * When `true`, the worker NEVER `import()`s `@parcel/watcher` — it skips the
   * live FSEvents subscribe + the reflog watches and runs a POLLING degrade: the
   * boot scan per root plus the fast `data_version` poll and the periodic
   * `reconcilePlanDirs` heartbeat carry the live fold pipeline at poll/
   * heartbeat cadence. The in-process daemon harness sets this so the slow-test
   * tier never dlopens the NAPI addon. A real resilience path — the degrade
   * keeper would take if the addon ever failed to load.
   */
  disableNativeWatcher?: boolean;
}

/** Snapshot message for one `.keeper/epics/*.json` file. */
export interface PlanEpicMessage {
  kind: "plan-epic";
  /** Plan epic id (the projection pk; rides in the synthetic event's session_id). */
  id: string;
  /** Epic number parsed from the id (`fn-N-…` → N), or null when unparseable. */
  number: number | null;
  title: string | null;
  /** The epic's `primary_repo` — stored opaque, never used to drive FS reads. */
  projectDir: string | null;
  status: string | null;
  /** Epic-level deps: the plan `depends_on_epics` ids (string array). */
  dependsOnEpics: string[];
  /**
   * Plan-native validation timestamp (top-level `last_validated_at` field
   * on `.keeper/epics/<id>.json`). Plain ISO-8601 string when present; a
   * missing / empty / non-string value collapses to `null` via {@link asString}
   * — the CLAUDE.md "safe value" invariant. Drives the board UI's
   * `[validated]` / `[unvalidated]` pill.
   */
  lastValidatedAt: string | null;
  /**
   * The epic-level parked-closer question, ingested from
   * `.keeper/state/epics/<epic_id>.state.json` (top-level `question` field) —
   * the epic mirror of {@link PlanTaskMessage.runtimeStatus}. Carried in the
   * scanner's per-epic cache (like the task's runtime-status cache) so a def
   * change composes against the latest observed question and vice versa.
   * `null` when no question is parked (never-observed / cleared).
   */
  question: string | null;
}

/** Snapshot message for one `.keeper/tasks/*.json` file. */
export interface PlanTaskMessage {
  kind: "plan-task";
  /** Plan task id (the projection pk; rides in the synthetic event's session_id). */
  id: string;
  /** Parent epic id (plan `epic` field). */
  epicId: string | null;
  /** Task number parsed from the id (`….M` → M), or null when unparseable. */
  number: number | null;
  title: string | null;
  /** The task's `target_repo` — stored opaque, never used to drive FS reads. */
  targetRepo: string | null;
  /**
   * Plan-native effort tier — the top-level `tier` field on the task-def file.
   * Stored opaque — keeper never branches on the value, so a tier widening rides
   * through with no code change. Null on absent/legacy files (folds to `null`
   * deterministically).
   */
  tier: string | null;
  /**
   * Plan-native worker model — the top-level `model` field on the task-def file
   * (the model axis of the {model × effort} worker matrix). Stored opaque; the
   * autopilot producer pairs it with `tier` to select the launch-time worker
   * plugin cell. Null on absent/legacy files (folds to `null` deterministically).
   */
  model: string | null;
  /**
   * Derived worker-phase binary: `worker_done_at` present → `"done"`, else
   * `"open"`. Kept distinct from the plan-native `runtime_status` enum below.
   */
  workerPhase: string;
  /**
   * Plan-native runtime status ingested from
   * `.keeper/state/tasks/<task_id>.state.json` (top-level `status` field):
   * `"todo" | "in_progress" | "done" | "blocked"`. Absent / missing file /
   * unrecognized value safe-defaults to `"todo"` per plan's
   * `merge_task_state` convention (a fresh clone with no `state/` tree reads
   * every task as `todo`).
   */
  runtimeStatus: string;
  /** Task-level deps: the plan `depends_on` task ids (string array). */
  dependsOn: string[];
}

/**
 * Tombstone message for a deleted `.keeper/epics/*.json` file. Main turns it
 * into a synthetic `EpicDeleted` event; the reducer deletes the `epics` row.
 */
export interface PlanEpicDeletedMessage {
  kind: "plan-epic-deleted";
  /** Plan epic id (the projection pk; rides in the synthetic event's session_id). */
  id: string;
}

/**
 * Tombstone message for a deleted `.keeper/tasks/*.json` file. Main turns it
 * into a synthetic `TaskDeleted` event; the reducer splices the element out of
 * the parent epic's embedded array. `epicId` is recovered from the change-gate's
 * last-emitted snapshot for this task (the only place the parent link survives a
 * delete, since the file is already gone).
 */
export interface PlanTaskDeletedMessage {
  kind: "plan-task-deleted";
  /** Plan task id. */
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

/**
 * Discovery nudge. Posted by the plan-worker when it first observes a `.keeper`
 * tree in a repo, so main hands the repo root to the git-worker's discovery
 * candidate set IMMEDIATELY instead of waiting for the next full sweep. Closes
 * the attribution blind spot for a repo keeper has never seen a session in.
 *
 * NOT a synthetic event and NOT routed through the scanner's `onSnapshot` (it
 * drives a producer worker, not a projection). Main forwards it to the
 * git-worker verbatim; the forward tolerates a null git-worker ref during the
 * boot window. The worker de-dupes per root.
 */
export interface PlanDiscoveryNudgeMessage {
  kind: "nudge-discovery";
  /** Absolute repo root (the `.keeper` parent) the git-worker should watch. */
  root: string;
}

/**
 * Every shape the plan-worker posts to main (snapshots + the discovery nudge +
 * the backstop-telemetry channel). The `{kind:"backstop"}` record is routed to
 * main as the sole sidecar writer.
 */
export type PlanWorkerOutbound =
  | PlanMessage
  | PlanDiscoveryNudgeMessage
  | BackstopMessage;

/** Message the parent sends to ask the worker to stop. */
export interface ShutdownMessage {
  type: "shutdown";
}

/**
 * Message the parent sends to drain the observation gate's pending set. Posted on
 * every `GitSnapshot` events row main writes — the "HEAD may have moved"
 * cross-worker signal a plan-worker can't observe on its own (a `git commit`
 * leaves the file content unchanged, so the FSEvent won't re-fire). The worker
 * calls {@link PlanScanner.recheckPending}; a freshly-committed epic drains and
 * emits its snapshot.
 */
export interface RecheckPendingMessage {
  type: "recheck-pending";
  /**
   * Optional repo-root scope. When set, drain ONLY the pending paths in `repo`
   * (main stamps it with the originating snapshot's `project_dir`). Absent →
   * global drain over every {@link PlanScanner.pendingRepos}. Invariant: the
   * drain probes each repo with ONE batched `git cat-file`, never a per-path
   * spawn — a per-path spawn over a cross-repo pending set starves the message
   * loop.
   */
  repo?: string;
}

/**
 * Edge-triggered fast-path kick. Main posts this to drain the observation gate's
 * pending set out-of-band of a git pulse, so a dirty plan file doesn't wait on
 * the heartbeat. The handler runs the SAME GATED {@link PlanScanner.recheckPending}
 * — NOT a bypass: an uncommitted file re-runs the in-HEAD probe and stays
 * pending, so it does NOT emit (preventing the duplicate-dispatch regression).
 *
 * The shape `{type:"kick"}` is byte-identical to the server-worker `KickMessage`
 * so main's existing `satisfies KickMessage` post sites can target the
 * plan-worker. The fast `data_version` poll is the level-triggered lost-wakeup
 * backstop for this edge-triggered kick; the heartbeat is the paranoia floor.
 */
export interface KickMessage {
  type: "kick";
}

/**
 * One entry on a {@link PlanCommitChangedMessage} — a single
 * `.keeper/**` path that changed in the committed delta the git-worker
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
export interface PlanCommitChange {
  path: string;
  op: "upsert" | "delete";
}

/**
 * Message the parent sends when a commit landed in a keeper-tracked repo
 * carrying changed `.keeper/**` paths. Authoritative ingest
 * trigger: the COMMITTED bytes are atomically written, so re-ingest from
 * the worktree is drop-proof and free of the mid-write partial-read race
 * the broader `~/code` FSEvents subscription is exposed to. The git-worker
 * filters the per-commit diff to `.keeper/{epics,tasks}/*.json` +
 * `.keeper/state/tasks/*.state.json` producer-side via
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
export interface PlanCommitChangedMessage {
  /**
   * The commit-driven ingest trigger main forwards from the git-worker. A
   * worker-IPC TRIGGER, not minted projection data, so re-fold determinism is
   * unaffected.
   */
  type: "plan-commit-changed";
  repo: string;
  changes: PlanCommitChange[];
}

/** Inbound message protocol — every shape main sends to the worker. */
export type InboundMessage =
  | ShutdownMessage
  | RecheckPendingMessage
  | KickMessage
  | PlanCommitChangedMessage;

/**
 * Cap a plan file's size before `JSON.parse`. Plan JSONs live under a
 * user-editable HOME; a pathological/oversize file is skip-and-logged so a bad
 * file never balloons memory or stalls the callback. 1 MiB is far above any real
 * plan epic/task JSON.
 */
const MAX_PLAN_FILE_BYTES = 1024 * 1024;

/**
 * Per-key cooldown (ms) for the loud per-path backstop ALARM prose in
 * {@link PlanScanner.logBackstopEmit}. A broken fast path makes
 * the 5s heartbeat rescue EVERY cycle, which would flood `server.stderr` with
 * the ALARM line; the rate-limiter caps it to ≤1 line per key per this window.
 * The NDJSON record + the in-memory counters are NEVER gated through this — a
 * suppressed ALARM still bumps the denominator and still writes the rescue line
 * (the metric stays complete). 60s matches the cadence at which a human tailing
 * stderr would want a re-reminder without the firehose.
 */
const BACKSTOP_ALARM_COOLDOWN_MS = 60_000;

/**
 * per-wake-path attribution window (ms). When a missed-wake backstop
 * fires, {@link PlanScanner.recentFastPaths} reports which fast-path labels
 * stamped {@link PlanScanner.markFastPath} within this trailing window — the
 * evidence that disambiguates a heartbeat defaulting `fast_path:
 * "data_version_poll"` from the real miss (e.g. a no-reflog-watch commit, where
 * NO fast path fired at all). One git-worker heartbeat (60s) wide so a recent
 * foreign-commit signal is still in view when the plan heartbeat next fires;
 * the stamp list is pruned to this window so it stays bounded. Producer-side
 * only — never read in a fold.
 */
const FAST_PATH_ATTRIBUTION_WINDOW_MS = 60_000;

/**
 * Plan data-dir basenames the worker watches + folds. `.keeper/` is the data
 * dir; a board folds into the `epics` projection from there.
 *
 * Mirrors the CLI's `DATA_DIR_NAMES` in `plugins/plan/src/state_path.ts`; the
 * worker can't import the vendored package, so the list is restated here (the
 * two MUST agree).
 */
const DATA_DIR_NAMES = [".keeper"] as const;

/** Is `name` a recognized plan data-dir basename (`.keeper`)? The single
 * membership test every dir-name match routes through. */
function isDataDirName(name: string): boolean {
  return (DATA_DIR_NAMES as readonly string[]).includes(name);
}

/**
 * Resolve the SINGLE data-dir basename to fold for a root, given the set of
 * data-dir names actually present there — the first in {@link DATA_DIR_NAMES},
 * or null when none is present.
 */
function resolveDataDirName(present: ReadonlySet<string>): string | null {
  for (const name of DATA_DIR_NAMES) {
    if (present.has(name)) {
      return name;
    }
  }
  return null;
}

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
 * `<root>/<project>/.keeper/…`, NOT at `<root>/.keeper/…`); without pruning,
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

/** Which `.keeper` collection a path belongs to (or none). */
type PlanKind = "epic" | "task" | "task-state" | "epic-state";

/**
 * Classify a watched path as an epic file, a task file, a task runtime-state
 * file, or neither, by matching the plan layout. Uses the platform path
 * separator so it works under any root depth. A path NOT matching one of the
 * shapes returns `null` — the callback then skips it (the in-callback filter
 * the ignore globs can't express).
 *
 * Recognised shapes (the data-dir basename is `.keeper` — {@link isDataDirName}):
 * - `<data-dir>/epics/<id>.json` (3-segment tail) → `"epic"`
 * - `<data-dir>/tasks/<id>.json` (3-segment tail) → `"task"`
 * - `<data-dir>/state/tasks/<id>.state.json` (4-segment tail) → `"task-state"`
 * - `<data-dir>/state/epics/<id>.state.json` (4-segment tail) → `"epic-state"`
 *
 * The 3-segment check is tried first so an `.json`-suffixed file under a
 * 3-tail layout never falls through to the 4-tail probe. The 4-tail probes
 * match the plan `LocalFileStateStore` shape (see
 * `apps/plan/plan/store.py:151`); files there end in `.state.json` so a
 * stray `*.json` (non-state) under `<data-dir>/state/{tasks,epics}/` rejects.
 * The epic-state sidecar classifies as `"epic-state"` so its path is
 * recognized, but keeper ingests no field from it — no change/delete arm acts
 * on an epic-state path.
 *
 * Pure — does no I/O. Exported for unit reach.
 */
export function classifyPlanPath(path: string): PlanKind | null {
  if (!path.endsWith(".json")) {
    return null;
  }
  const segments = path.split(sep);
  const n = segments.length;
  // 3-segment tail: `<data-dir>/<epics|tasks>/<file>.json`.
  if (n >= 3 && isDataDirName(segments[n - 3])) {
    const dir = segments[n - 2];
    if (dir === "epics") {
      return "epic";
    }
    if (dir === "tasks") {
      return "task";
    }
    // Other `<data-dir>/<dir>/*.json` shapes (e.g. `specs/`) fall through and
    // reject below — they are not our concern.
    return null;
  }
  // 4-segment tail: `<data-dir>/state/tasks/<id>.state.json`. The filename MUST
  // end in `.state.json` (the plan LocalFileStateStore convention); a
  // stray `*.json` (non-state) under this subtree rejects.
  if (
    n >= 4 &&
    isDataDirName(segments[n - 4]) &&
    segments[n - 3] === "state" &&
    segments[n - 1].endsWith(".state.json")
  ) {
    if (segments[n - 2] === "tasks") {
      return "task-state";
    }
    // 4-segment tail: `.keeper/state/epics/<id>.state.json`. Same shape rules
    // as task-state, different leaf dir (epic runtime-state sidecar; keeper
    // ingests no field from it).
    if (segments[n - 2] === "epics") {
      return "epic-state";
    }
  }
  return null;
}

/**
 * Parse the leading `fn-N-…` epic number from a plan id. Returns N (the first
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
 * Parse the trailing `.M` task number from a plan task id
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

/** Raw plan epic JSON shape — only the fields we project. */
interface RawEpic {
  id?: unknown;
  title?: unknown;
  status?: unknown;
  primary_repo?: unknown;
  depends_on_epics?: unknown;
  last_validated_at?: unknown;
}

/** Raw plan task JSON shape — only the fields we project. */
interface RawTask {
  id?: unknown;
  epic?: unknown;
  title?: unknown;
  target_repo?: unknown;
  /**
   * Plan-native effort tier: top-level field on the task-def file,
   * read by `keeper plan resolve-task` from `task_def.get("tier")`. Plan's own
   * vocabulary is `low | medium | high | xhigh | max`, but
   * keeper stores the field opaque — never branches on the value — so any
   * future tier widening rides through with no code change. Absent on legacy
   * task files / unset on newer ones; coerced to `null` by `asString`.
   */
  tier?: unknown;
  /**
   * Plan-native worker model: top-level `model` field on the task-def file (the
   * model axis of the {model × effort} matrix `keeper plan resolve-task` pairs
   * with `tier`). Stored opaque; absent on legacy files, coerced to `null` by
   * `asString`.
   */
  model?: unknown;
  worker_done_at?: unknown;
  depends_on?: unknown;
}

/**
 * Raw plan runtime-state JSON shape — only the fields we project. The state
 * file (`.keeper/state/tasks/<task_id>.state.json`) is written by plan
 * `LocalFileStateStore` (`apps/plan/plan/store.py:151`) and carries
 * `assignee` / `claim_note` / `claimed_at` / `evidence` / `status` /
 * `updated_at`; keeper ingests only `status`.
 */
interface RawTaskState {
  status?: unknown;
}

/**
 * Raw plan epic runtime-state JSON shape — only the field we project. The
 * state file (`.keeper/state/epics/<epic_id>.state.json`) is written by plan
 * `LocalFileStateStore.saveEpicRuntime` (`keeper plan epic-question`); keeper
 * ingests only `question`.
 */
interface RawEpicState {
  question?: unknown;
}

/** Coerce a value to a non-empty string, else null. */
function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Derive the plan task id from a state-file path:
 * `.../.keeper/state/tasks/<task_id>.state.json` → `<task_id>`. Returns null
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
 * `.../<data-dir>/state/tasks/<task_id>.state.json` to the sibling task
 * definition file path `.../<data-dir>/tasks/<task_id>.json`, preserving the
 * input's `.keeper` data-dir basename. Pure path
 * arithmetic — does no I/O. Returns null on a shape mismatch (caller has
 * already classified, so this is defensive only).
 */
export function taskDefPathFromStatePath(statePath: string): string | null {
  const segments = statePath.split(sep);
  const n = segments.length;
  if (
    n < 4 ||
    !isDataDirName(segments[n - 4]) ||
    segments[n - 3] !== "state" ||
    segments[n - 2] !== "tasks"
  ) {
    return null;
  }
  const taskId = taskIdFromStatePath(statePath);
  if (taskId === null) {
    return null;
  }
  // Replace the trailing `state/tasks/<id>.state.json` with `tasks/<id>.json`,
  // keeping the data-dir prefix (and its basename) intact.
  const dataDirPrefix = segments.slice(0, n - 3);
  return [...dataDirPrefix, "tasks", `${taskId}.json`].join(sep);
}

/**
 * Derive the epic id from an epic state-file path:
 * `.../.keeper/state/epics/<epic_id>.state.json` → `<epic_id>`. Returns null
 * if the basename does not end in `.state.json` (caller has already
 * classified — this stays a pure transform on the matched shape). Mirrors
 * {@link taskIdFromStatePath}.
 *
 * Pure. Exported for unit reach.
 */
export function epicIdFromStatePath(path: string): string | null {
  // Same basename arithmetic as the task variant — the id-from-basename
  // transform is dir-agnostic, so reuse it directly.
  return taskIdFromStatePath(path);
}

/**
 * Map an epic state-file path
 * `.../<data-dir>/state/epics/<epic_id>.state.json` to the committed epic
 * definition file path `.../<data-dir>/epics/<epic_id>.json`, preserving the
 * input's `.keeper` data-dir basename. Pure path
 * arithmetic — does no I/O. Returns null on a shape mismatch (caller has
 * already classified, so this is defensive only). Mirrors
 * {@link taskDefPathFromStatePath}.
 */
export function epicDefPathFromStatePath(statePath: string): string | null {
  const segments = statePath.split(sep);
  const n = segments.length;
  if (
    n < 4 ||
    !isDataDirName(segments[n - 4]) ||
    segments[n - 3] !== "state" ||
    segments[n - 2] !== "epics"
  ) {
    return null;
  }
  const epicId = epicIdFromStatePath(statePath);
  if (epicId === null) {
    return null;
  }
  // Replace the trailing `state/epics/<id>.state.json` with `epics/<id>.json`,
  // keeping the data-dir prefix (and its basename) intact.
  const dataDirPrefix = segments.slice(0, n - 3);
  return [...dataDirPrefix, "epics", `${epicId}.json`].join(sep);
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

/**
 * The fixed set of valid plan runtime-status enum values
 * (`.keeper/state/tasks/<id>.state.json`'s top-level `status` field).
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
 * (mirrors plan's `merge_task_state` convention — a task with no state file
 * reads `todo` everywhere); any other value (wrong type, typo, garbage)
 * coerces to `"todo"` with a stderr log via `onInvalid` — the CLAUDE.md "safe
 * value" invariant. The fold stays a pure function of the persisted file
 * (re-fold determinism preserved).
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
 * Coerce a value off an epic state file to the parked-question field. A
 * non-empty string passes through; a missing/`null`/empty-string field
 * defaults silently to `null` (no parked question); any other value (wrong
 * type, e.g. a number or object) coerces to `null` with a stderr log via
 * `onInvalid` — mirrors {@link coerceRuntimeStatus}. The bounded-length cap
 * (`EPIC_QUESTION_MAX_CHARS`) is enforced at the `keeper plan epic-question`
 * write boundary, not here — the fold stays a pure function of the persisted
 * file (re-fold determinism preserved) and the per-file byte cap already
 * guards against a pathological state file.
 */
export function coerceEpicQuestion(
  v: unknown,
  onInvalid?: (raw: unknown) => void,
): string | null {
  if (v === undefined || v === null) {
    return null; // missing/explicit-null field — quiet default, no log
  }
  if (typeof v === "string") {
    return v.length > 0 ? v : null;
  }
  if (onInvalid) {
    onInvalid(v);
  }
  return null;
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
 * The change-gate is keyed by the plan id (the projection pk) and holds the
 * last-emitted serialized snapshot. `seedFromDb` (below) primes it from the
 * `epics`/`tasks` projection so a daemon restart full-scan does not re-emit a
 * synthetic event per plan file every boot.
 *
 * Observation gate: an optional `isTracked(path) => boolean` predicate fed in at
 * construction suppresses emission for any epic/task file that is NOT yet in HEAD
 * (untracked, or staged-but-not-committed). Suppressed paths land in the
 * {@link pending} set. The reducer continues to fold ONLY committed
 * snapshots, so the autopilot cannot dispatch against an uncommitted epic.
 * A plan `git commit` does not change the file content, so FSEvents will
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
   * entirely (state files are runtime data, plan's `.gitignore` excludes
   * them). A state-file change re-emits a TaskSnapshot through the
   * still-gated def-file path; if the def file is pending, the state-file
   * change is effectively pending too (the re-emit lands in `pending`
   * keyed by the def path).
   */
  private readonly pending = new Set<string>();
  /**
   * Per-task cache of the latest runtime-status enum value observed in
   * `.keeper/state/tasks/<task_id>.state.json` (top-level `status` field).
   * Keyed by plan task id. A task that has never been observed in the
   * cache reads `"todo"` (plan's `merge_task_state` default — a fresh
   * clone with no `state/` tree shows every task as `todo`); the
   * {@link buildTaskMessage} caller passes this default.
   *
   * Updated by an `onChange` over a `task-state` path AFTER the file
   * coerce-parses cleanly, and re-derived to `"todo"` by `onDelete` over the
   * same path (so a state-file vanish flips the task back to `todo`, matching
   * plan's "no state file → todo" convention). NEVER mutated from a `task`
   * (definition) path — the cache is the state file's projection.
   */
  private readonly runtimeStatusCache = new Map<string, string>();
  /**
   * Per-epic cache of the latest parked-closer question observed in
   * `.keeper/state/epics/<epic_id>.state.json` (top-level `question` field) —
   * the epic mirror of {@link runtimeStatusCache}. Keyed by plan epic id. An
   * epic never observed in the cache reads `null` (no parked question, the
   * plan default); the {@link buildEpicMessage} caller passes this default.
   *
   * Updated by an `onChange` over an `epic-state` path AFTER the file
   * coerce-parses cleanly, and reset to `null` by `onDelete` over the same
   * path (a state-file vanish clears the question, matching the "no state
   * file → no question" convention). NEVER mutated from an `epic` (definition)
   * path — the cache is the state file's projection.
   */
  private readonly epicQuestionCache = new Map<string, string | null>();
  /**
   * The set of plan ids whose backing `.json` file was actually enumerated
   * on disk by a boot scan ({@link markSeen}, called from `scanPlanDir` for
   * EVERY file regardless of parse outcome). The boot-reconciliation
   * {@link sweep} diffs the projection against this census to retract ghosts —
   * projection ids whose file was deleted while the daemon was down (no live
   * `onDelete` ever fired). Keyed by the FILENAME-derived id (file basename
   * minus `.json`), NOT a parse result: a file mid-rewrite that fails to parse
   * still has its name on disk, so it is "seen" and never spuriously retracted.
   *
   * State files (`.keeper/state/tasks/<id>.state.json`) are NOT enrolled in
   * this census — they are a SIDECAR projection layered onto task ids that
   * already enrol via their definition file under `.keeper/tasks/`. The
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
     * Observation gate. Defaults to `() => true` (no gating) so the
     * pure-core unit tests don't need a fake git tree; the live worker
     * passes a `git cat-file -e HEAD:<relpath>` closure.
     *
     * The predicate is producer-side ONLY — the reducer never reads git
     * (re-fold determinism preserved). Path is the absolute filesystem
     * path passed to onChange; the predicate is responsible for resolving
     * the repo root + relpath itself.
     */
    private readonly isTracked: (path: string) => boolean = () => true,
    /**
     * Optional BATCHED git-tracked predicate. Given a repo `root`
     * and the repo-relative paths `rels` of every pending file in that repo,
     * returns a positional `boolean[]` (`result[i]` is "is `rels[i]` in
     * HEAD") in ONE `git cat-file --batch-check` spawn — the per-repo probe
     * {@link recheckPending} uses instead of one {@link isTracked} spawn per
     * path. Defaults to a per-path fallback over {@link isTracked} so the
     * pure-core unit tests (and any scanner constructed without it) still gate
     * correctly, just unbatched; the live worker passes
     * {@link isPathInHeadBatch}. Like {@link isTracked} it is producer-side
     * ONLY — the reducer never reads git (re-fold determinism preserved).
     *
     * Fail-closed contract (inherited from {@link isPathInHead}): on any
     * anomaly the predicate returns ALL-`false`, so a parse slip never wrongly
     * announces a path as in-HEAD (the duplicate-dispatch guard). An
     * empty `rels` is a no-op (`[]`, no spawn).
     */
    private readonly isTrackedBatch: (
      root: string,
      rels: string[],
    ) => boolean[] = (root, rels) =>
      rels.map((rel) => this.isTracked(join(root, rel))),
    /**
     * Optional observer fired AFTER any public mutation
     * ({@link onChange} / {@link onDelete} / {@link recheckPending}) that may
     * have changed the {@link pending} set. The live worker uses it
     * to reconcile its per-repo `.git/logs/HEAD` reflog watches against
     * {@link pendingRepos}: a commit in an OTHERWISE-UNWATCHED repo (one
     * keeper has never seen a session in, so the git-worker isn't watching
     * its `.git`) produces no DB write — so neither the `recheck-pending`
     * post nor the `data_version` poll wakes — AND leaves the file's
     * worktree bytes unchanged, so FSEvents won't re-fire. Watching
     * `.git/logs/HEAD` (a commit always appends there) is the only realtime
     * trigger for that path's in-HEAD transition.
     *
     * Called UNCONDITIONALLY at each mutation exit (even when `pending` is
     * unchanged) — the worker's reconcile is idempotent + cheap, and a
     * conditional "only on real change" would have to diff the set anyway.
     * Defaults to a no-op so the pure-core unit tests need no watch infra.
     * Try/catch is the CALLER's responsibility — the scanner is in the
     * no-self-heal path and must not swallow the worker's reconcile throw
     * inside the gate logic.
     */
    private readonly onPendingChange: () => void = () => {},
    /**
     * backstop-telemetry sink. Posts a built `{kind:"backstop"}`
     * message UP to main (the SOLE sidecar writer) on every heartbeat /
     * FSEvents-drop fire — a rescue record when the change-gated scan actually
     * emitted, a periodic + on-shutdown rollup for the denominator. Defaults to
     * a no-op so the pure-core unit tests need no message bus; the live worker
     * passes `(msg) => port.postMessage(msg)`.
     */
    private readonly postBackstop: (msg: BackstopMessage) => void = () => {},
    /**
     * Injected wall-clock (epoch ms) the backstop telemetry stamps for
     * `last_fast_path_at`, staleness, and rollup `ts`. A producer-side read —
     * NEVER consulted inside a fold (re-fold determinism is unaffected; the
     * sidecar is a pure consumer-side side-file). Defaults to `Date.now`; tests
     * inject a synthetic clock.
     */
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * backstop-telemetry state. `lastFastPathAt` is stamped at every
   * confirmed fast-path fire ({@link markFastPath} — live FSEvents `onChange`,
   * the `data_version` poll re-scan, the reflog-driven `recheckPending`); the
   * heartbeat / FSEvents-drop backstops read it to compute staleness. `null`
   * until the first fast path fires (the cold-boot sentinel that keeps a giant
   * false staleness off the histogram). Counters accumulate fires/rescues per
   * (backstop,class) for the denominator; the rate-limiter gates ONLY the loud
   * per-path ALARM prose in {@link logBackstopEmit} (the NDJSON record +
   * counters are NEVER gated, so the metric stays complete).
   */
  private lastFastPathAt: number | null = null;
  /**
   * per-wake-path attribution: the recent fast-path stamps, each
   * `{label, at}`, most-recent LAST (append order). {@link recentFastPaths}
   * filters this to the attribution window when a heartbeat fires, so a
   * missed-wake record can name WHICH fast path(s) recently delivered work —
   * disambiguating a heartbeat that defaults `fast_path:"data_version_poll"`
   * from the real miss (e.g. a no-reflog-watch commit). Bounded by pruning to
   * the window on every {@link markFastPath} stamp. Pure in-memory; producer-
   * side only (never read in a fold).
   */
  private readonly fastPathStamps: { label: string; at: number }[] = [];
  private readonly backstopCounters = new BackstopCounters();
  private readonly backstopAlarmLimiter = new BackstopRateLimiter(
    BACKSTOP_ALARM_COOLDOWN_MS,
  );

  /**
   * Stamp the in-memory `last_fast_path_at` from the injected clock. Called at
   * every confirmed FAST-path fire (live FSEvents `onChange`, the
   * `data_version`-poll re-scan, the reflog-driven `recheckPending` drain) — NOT
   * on a heartbeat / FSEvents-drop fire (those are the BACKSTOPS that READ this
   * value to compute staleness). Pure in-memory; no I/O.
   *
   * `label` names which fast path stamped (e.g. `fsevents`, `db-poll`,
   * `reflog`); it's appended to {@link fastPathStamps} (pruned to the
   * attribution window) so a later backstop can attribute the miss. The label
   * defaults to a generic marker so legacy call sites stay valid; the live
   * worker passes the specific path.
   */
  markFastPath(label = "unknown"): void {
    const now = this.now();
    this.lastFastPathAt = now;
    this.fastPathStamps.push({ label, at: now });
    // Prune to the attribution window so the list stays bounded (the heartbeat
    // attribution only cares about recent stamps; an old one is just noise).
    const floor = now - FAST_PATH_ATTRIBUTION_WINDOW_MS;
    while (
      this.fastPathStamps.length > 0 &&
      this.fastPathStamps[0].at < floor
    ) {
      this.fastPathStamps.shift();
    }
  }

  /**
   * the fast-path labels that stamped within the attribution window
   * ending at `now`, MOST-RECENT FIRST, de-duplicated (a path that fired twice
   * in the window appears once, at its latest position). Drives the
   * `recent_fast_paths` attribution on a missed-wake record. Returns `[]` when
   * no fast path fired in the window (cold boot or a long stall) — the caller
   * then OMITS the field so the legacy record shape is preserved.
   */
  recentFastPaths(now: number): string[] {
    const floor = now - FAST_PATH_ATTRIBUTION_WINDOW_MS;
    const seen = new Set<string>();
    const out: string[] = [];
    // Walk newest→oldest so the first sighting of each label is its latest.
    for (let i = this.fastPathStamps.length - 1; i >= 0; i--) {
      const stamp = this.fastPathStamps[i];
      if (stamp.at < floor) break;
      if (seen.has(stamp.label)) continue;
      seen.add(stamp.label);
      out.push(stamp.label);
    }
    return out;
  }

  /**
   * Record one backstop fire (the heartbeat or the FSEvents-drop rescan). Always
   * bumps the (backstop,`missed-wake`) counter; on a genuine RESCUE
   * (`rescued === true`, i.e. the change-gated scan emitted at least one
   * snapshot) ALSO posts a full {@link buildMissedWakeRecord} line up to main.
   * A no-op fire (`rescued === false`) bumps the denominator only — no NDJSON
   * line (the plan heartbeat is 5s; a line per no-op would write ~17k/day). The
   * cold-boot sentinel lives in {@link buildMissedWakeRecord} (null staleness
   * when `lastFastPathAt` is still `null`). Producer-side only; never a
   * synthetic event.
   */
  fireBackstop(
    backstop: "plan-heartbeat" | "rescan-drop",
    fastPath: string,
    rescued: boolean,
    /**
     * Per-wake-path attribution: whether a `.git/logs/HEAD` reflog watch
     * was ARMED at fire time for the repo(s) this backstop covers. The worker
     * passes `present` when at least one currently-pending repo had a live
     * reflog subscription, `absent` when a pending repo had none (the prime-
     * suspect slow path), and omits it when there's no per-repo notion. Carried
     * onto the missed-wake record; producer-side only.
     */
    reflogWatch?: "present" | "absent",
  ): void {
    this.backstopCounters.bump(backstop, "missed-wake", rescued);
    if (!rescued) return;
    const now = this.now();
    const recent = this.recentFastPaths(now);
    this.postBackstop({
      kind: "backstop",
      record: buildMissedWakeRecord({
        backstop,
        worker: "plan-worker",
        fastPath,
        rescued: true,
        now,
        lastFastPathAt: this.lastFastPathAt,
        reflogWatch,
        recentFastPaths: recent.length > 0 ? recent : undefined,
      }),
    });
  }

  /**
   * Flush the in-memory backstop counters as {@link BackstopRollup} records up
   * to main (the denominator survives without a line per no-op fire). Called
   * periodically and on shutdown by the worker. Posts nothing when no backstop
   * has fired this process life.
   */
  flushBackstopRollups(): void {
    for (const rollup of this.backstopCounters.snapshot(this.now())) {
      this.postBackstop({ kind: "backstop", record: rollup });
    }
  }

  /**
   * The per-key cooldown gate for the loud per-path ALARM prose only — exposed
   * so {@link logBackstopEmit} can suppress a flood while the NDJSON record +
   * counters (routed through {@link fireBackstop}) stay complete.
   */
  private alarmAllowed(key: string): boolean {
    return this.backstopAlarmLimiter.allow(key, this.now());
  }

  /**
   * The set of repo roots that currently own at least one path in the
   * observation gate's {@link pending} set, derived via
   * {@link repoRootFromPlanPath} (pure path arithmetic). The live worker
   * reconciles its `.git/logs/HEAD` reflog watches against this set:
   * a repo enters when it gains a first pending path and leaves when its last
   * pending path drains, keeping the watch lifecycle bounded. A path whose
   * repo root can't be derived (shape drift) is silently skipped — it simply
   * gets no reflog watch and falls back to the heartbeat floor.
   */
  pendingRepos(): Set<string> {
    const repos = new Set<string>();
    for (const path of this.pending) {
      const root = repoRootFromPlanPath(path);
      if (root !== null) {
        repos.add(root);
      }
    }
    return repos;
  }

  /**
   * Add `path` to the observation gate's {@link pending} set and notify the
   * {@link onPendingChange} observer. Single choke point for every gate-fail
   * stash so the reflog-watch reconcile never misses a pending-set
   * transition.
   */
  private addPending(path: string): void {
    this.pending.add(path);
    this.onPendingChange();
  }

  /**
   * Drop `path` from {@link pending} and notify the {@link onPendingChange}
   * observer. The mirror of {@link addPending}: a drain (path made HEAD, or a
   * pending file deleted) may have emptied a repo's pending set, so the
   * worker must reconcile its reflog watches down.
   */
  private deletePending(path: string): void {
    this.pending.delete(path);
    this.onPendingChange();
  }

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
   * `.keeper/state/tasks/<task_id>.state.json` (called by `scanPlanDir`
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
   * Prime the per-epic question cache from a boot enumeration of
   * `.keeper/state/epics/<epic_id>.state.json` (called by `scanPlanDir`
   * BEFORE the `epics/` loop) — the epic mirror of {@link primeRuntimeStatus}.
   * Pure cache write — does NOT emit a snapshot, does NOT touch `pathToId`,
   * does NOT touch the on-disk census. The subsequent `epics/` loop's
   * `onChange` reads this cache and emits the epic's first `EpicSnapshot`
   * already carrying the parked question, with no redundant re-emit on a
   * follow-up state-file write.
   */
  primeEpicQuestion(epicId: string, question: string | null): void {
    this.epicQuestionCache.set(epicId, question);
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
   * runtime-status cache back to the plan default `"todo"` and re-emit a
   * TaskSnapshot from the still-present task-definition file. The definition
   * file is the projection's identity; a sidecar vanishing reverts state, it
   * does not retract the task.
   */
  onDelete(path: string): void {
    const kind = classifyPlanPath(path);
    if (kind === "task-state") {
      // Sidecar delete: drop the runtime-status cache entry (reverts the task
      // to the plan default "todo") and re-emit a TaskSnapshot from the
      // still-present task-definition file. A state-file path is NOT tracked in
      // `pathToId` (the cache key is the task id directly), so there is no
      // entry to drop there.
      const taskId = taskIdFromStatePath(path);
      if (taskId === null) {
        return;
      }
      const hadCache = this.runtimeStatusCache.has(taskId);
      this.runtimeStatusCache.delete(taskId);
      if (!hadCache) {
        // The cache was already empty (reading the default); deleting a
        // never-cached sidecar can't change the projection. Skip the re-emit.
        return;
      }
      const defPath = taskDefPathFromStatePath(path);
      if (defPath === null) {
        return;
      }
      this.reemitTaskFromDef(defPath);
      return;
    }
    if (kind === "epic-state") {
      // Sidecar delete: reset the question cache to `null` (reverts to "no
      // parked question") and re-emit an EpicSnapshot from the still-present
      // epic-definition file. A state-file path is NOT tracked in `pathToId`
      // (the cache key is the epic id directly), so there is no entry to
      // drop there. Mirrors the `task-state` arm above.
      const epicId = epicIdFromStatePath(path);
      if (epicId === null) {
        return;
      }
      const hadCache = this.epicQuestionCache.has(epicId);
      this.epicQuestionCache.delete(epicId);
      if (!hadCache) {
        // The cache was already empty (reading the default null); deleting a
        // never-cached sidecar can't change the projection. Skip the re-emit.
        return;
      }
      const defPath = epicDefPathFromStatePath(path);
      if (defPath === null) {
        return;
      }
      this.reemitEpicFromDef(defPath);
      return;
    }

    const id = this.pathToId.get(path);
    if (id === undefined) {
      // Never folded this path. If the path was held in the observation
      // gate's pending set (uncommitted epic/task whose file
      // got removed before it ever made HEAD — e.g. a plan scaffold
      // unwind on commit_failed), drop it: there's nothing to retract
      // since the reducer never saw the entity. Either way, no tombstone.
      this.deletePending(path);
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
      // Definition file is gone: drop the runtime-status cache so a re-created
      // task file starts from the plan "todo" default rather than a stale
      // cached value.
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
   *
   * Returns `true` iff a snapshot was emitted (mirrors {@link onChange}'s
   * contract). The def-file in-HEAD gate STAYS in force here:
   * task-state sidecars are gitignored and never appear in a commit's file
   * list, so the commit-driven bypass never reaches this method — the gate
   * is correct for every path that does.
   */
  private reemitTaskFromDef(defPath: string): boolean {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(defPath);
    } catch {
      // Definition file absent (or read-vs-delete race) — the sidecar
      // changed for a task whose definition hasn't appeared yet. The cache
      // already updated; when the def lands, its `task` `onChange` reads
      // the cache and emits correctly.
      return false;
    }
    if (!st.isFile() || st.size > MAX_PLAN_FILE_BYTES) {
      return false;
    }
    let text: string;
    try {
      text = readFileSync(defPath, "utf8");
    } catch (err) {
      this.log(
        `[plan-worker] read failed for ${defPath}: ${stringifyErr(err)}`,
      );
      return false;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      this.log(
        `[plan-worker] malformed JSON in ${defPath}: ${stringifyErr(err)}`,
      );
      return false;
    }
    if (!parsed || typeof parsed !== "object") {
      return false;
    }
    const raw = parsed as RawTask;
    const id = asString(raw.id);
    if (id === null) {
      return false;
    }
    const runtimeStatus = this.runtimeStatusCache.get(id) ?? "todo";
    const msg = buildTaskMessage(raw, runtimeStatus, this.log);
    if (msg === null) {
      return false;
    }
    // Observation gate: same producer-side gate as {@link onChange}.
    // The sidecar state file fired this re-emit, but the def file is what
    // we project; if the def file isn't in HEAD yet, stash and wait for
    // the next git-worker pulse to drain it via {@link recheckPending}.
    if (!this.isTracked(defPath)) {
      this.addPending(defPath);
      return false;
    }
    this.deletePending(defPath);
    this.pathToId.set(defPath, msg.id);
    const serialized = JSON.stringify(msg);
    if (this.lastEmitted.get(msg.id) === serialized) {
      return false;
    }
    this.lastEmitted.set(msg.id, serialized);
    this.onSnapshot(msg);
    return true;
  }

  /**
   * Read the epic-definition file at `defPath` (if present) and re-emit an
   * EpicSnapshot composed with the latest cached parked question. Used by the
   * `epic-state` change/delete arms — the sidecar carries only the `question`
   * field, but the snapshot the reducer folds is full. Mirrors
   * {@link reemitTaskFromDef}.
   *
   * A missing/unreadable/malformed definition file is skip-and-logged without
   * emitting; the next true `epic` event will replay through the same path.
   *
   * Returns `true` iff a snapshot was emitted. The def-file in-HEAD gate STAYS
   * in force here: `epic-state` sidecars are gitignored and never appear in a
   * commit's file list, so the commit-driven bypass never reaches this method.
   */
  private reemitEpicFromDef(defPath: string): boolean {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(defPath);
    } catch {
      // Definition file absent (or read-vs-delete race) — the sidecar
      // changed for an epic whose definition hasn't appeared yet. The cache
      // already updated; when the def lands, its `epic` `onChange` reads the
      // cache and emits correctly.
      return false;
    }
    if (!st.isFile() || st.size > MAX_PLAN_FILE_BYTES) {
      return false;
    }
    let text: string;
    try {
      text = readFileSync(defPath, "utf8");
    } catch (err) {
      this.log(
        `[plan-worker] read failed for ${defPath}: ${stringifyErr(err)}`,
      );
      return false;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      this.log(
        `[plan-worker] malformed JSON in ${defPath}: ${stringifyErr(err)}`,
      );
      return false;
    }
    if (!parsed || typeof parsed !== "object") {
      return false;
    }
    const raw = parsed as RawEpic;
    const id = asString(raw.id);
    if (id === null) {
      return false;
    }
    const question = this.epicQuestionCache.get(id) ?? null;
    const msg = buildEpicMessage(raw, question, this.log);
    if (msg === null) {
      return false;
    }
    // Observation gate: same producer-side gate as {@link onChange}.
    // The sidecar state file fired this re-emit, but the def file is what
    // we project; if the def file isn't in HEAD yet, stash and wait for
    // the next git-worker pulse to drain it via {@link recheckPending}.
    if (!this.isTracked(defPath)) {
      this.addPending(defPath);
      return false;
    }
    this.deletePending(defPath);
    this.pathToId.set(defPath, msg.id);
    const serialized = JSON.stringify(msg);
    if (this.lastEmitted.get(msg.id) === serialized) {
      return false;
    }
    this.lastEmitted.set(msg.id, serialized);
    this.onSnapshot(msg);
    return true;
  }

  /**
   * Process a change for `path`. Classifies → reads (bounded) → safe-parses →
   * derives → change-gates → emits. Any failure skips-and-logs without emitting.
   *
   * Returns `true` iff this call emitted a snapshot through {@link onSnapshot}
   * (a fresh entity or a changed one that cleared the change-gate); `false` for
   * every no-op outcome (non-plan path, gated-to-pending, unchanged snapshot,
   * parse skip, task-state cache poke). The boolean lets a backstop caller
   * ({@link reconcilePlanDirs} via heartbeat / FSEvents-drop rescan) detect
   * that it delivered work a fast path missed and log a trigger-tagged line.
   *
   * `triggeredByCommit` (default `false`): when `true`, the `isTracked`
   * observation gate at the epic/task arm is BYPASSED — the
   * `plan-commit-changed` signal already proves the path is in HEAD (the
   * git-worker enumerated it from a landed commit), so re-running the
   * fail-closed `git cat-file -e HEAD` probe is redundant and (on its 1s
   * timeout fail-closed window) is exactly what silently bounced a
   * just-committed file into {@link pending}, delaying its snapshot until the
   * 60s heartbeat. The live `@parcel/watcher` callback and
   * {@link recheckPending} pass `false` — those are the genuinely-uncertain
   * paths and stay gated.
   */
  onChange(path: string, triggeredByCommit = false): boolean {
    const kind = classifyPlanPath(path);
    if (kind === null) {
      return false;
    }

    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch (err) {
      // Read-vs-delete race (file vanished between the watch event and the
      // stat): skip-and-log, keep last good, don't emit.
      this.log(`[plan-worker] stat failed for ${path}: ${stringifyErr(err)}`);
      return false;
    }
    if (!st.isFile()) {
      return false;
    }
    if (st.size > MAX_PLAN_FILE_BYTES) {
      this.log(
        `[plan-worker] ${path} exceeds ${MAX_PLAN_FILE_BYTES} bytes (${st.size}); skipping`,
      );
      return false;
    }

    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      this.log(`[plan-worker] read failed for ${path}: ${stringifyErr(err)}`);
      return false;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      this.log(`[plan-worker] malformed JSON in ${path}: ${stringifyErr(err)}`);
      return false;
    }
    if (!parsed || typeof parsed !== "object") {
      this.log(`[plan-worker] non-object JSON in ${path}; skipping`);
      return false;
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
        return false;
      }
      const raw = parsed as RawTaskState;
      const runtimeStatus = coerceRuntimeStatus(raw.status, (bad) => {
        this.log(
          `[plan-worker] invalid runtime status in ${path}: ${JSON.stringify(bad)}; defaulting to "todo"`,
        );
      });
      const priorStatus = this.runtimeStatusCache.get(taskId) ?? "todo";
      this.runtimeStatusCache.set(taskId, runtimeStatus);
      if (priorStatus === runtimeStatus) {
        // The cached value is unchanged: the composed TaskSnapshot wouldn't
        // change and the change-gate would suppress it anyway. Skip the
        // re-emit work.
        return false;
      }
      const defPath = taskDefPathFromStatePath(path);
      if (defPath === null) {
        return false;
      }
      // `task-state` paths are gitignored sidecars that never appear in a
      // commit's file list, so `triggeredByCommit` is always `false` here —
      // the def-file gate inside `reemitTaskFromDef` stays in force.
      return this.reemitTaskFromDef(defPath);
    }

    // `epic-state` (sidecar) updates the per-epic question cache and re-emits
    // an EpicSnapshot composed against the sibling definition file. Mirrors
    // the `task-state` arm above; the sidecar carries only `question`, so the
    // def file is read and merged in `reemitEpicFromDef`.
    if (kind === "epic-state") {
      const epicId = epicIdFromStatePath(path);
      if (epicId === null) {
        return false;
      }
      const raw = parsed as RawEpicState;
      const question = coerceEpicQuestion(raw.question, (bad) => {
        this.log(
          `[plan-worker] invalid epic question in ${path}: ${JSON.stringify(bad)}; defaulting to null`,
        );
      });
      const priorQuestion = this.epicQuestionCache.get(epicId) ?? null;
      this.epicQuestionCache.set(epicId, question);
      if (priorQuestion === question) {
        // The cached value is unchanged: the composed EpicSnapshot wouldn't
        // change and the change-gate would suppress it anyway.
        return false;
      }
      const defPath = epicDefPathFromStatePath(path);
      if (defPath === null) {
        return false;
      }
      // `epic-state` paths are gitignored sidecars that never appear in a
      // commit's file list, so the def-file gate inside `reemitEpicFromDef`
      // stays in force.
      return this.reemitEpicFromDef(defPath);
    }

    let msg: PlanEpicMessage | PlanTaskMessage | null;
    if (kind === "epic") {
      const raw = parsed as RawEpic;
      const id = asString(raw.id);
      const question =
        id !== null ? (this.epicQuestionCache.get(id) ?? null) : null;
      msg = buildEpicMessage(raw, question, this.log);
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
      return false;
    }

    // the cheap in-memory change-gate runs BEFORE the in-HEAD
    // probe. For ~99% of scans (unchanged files re-read by the 5s heartbeat /
    // boot / drop-rescan) `lastEmitted` already holds the identical
    // serialization, so we suppress here and NEVER fork the `git cat-file -e`
    // probe — eliminating the per-scan subprocess storm (~1.7M forks/day) that
    // starved the realtime plan pipeline. macOS spawn is ~2-5ms; this compare
    // is nanoseconds.
    //
    // Accepted semantic shift (the ONE behavior change): in-HEAD-ness is
    // re-verified only when content changes. An unchanged file's HEAD-membership
    // regression (e.g. a branch switch that drops the file from HEAD without
    // touching its bytes) has no observable effect — the change-gate suppresses
    // re-emits regardless, so we'd emit nothing either way.
    const serialized = JSON.stringify(msg);
    if (this.lastEmitted.get(msg.id) === serialized) {
      // Unchanged snapshot: suppress with NO probe and NO pending mutation.
      // `pathToId.set` is REQUIRED on this branch — boot seeds `lastEmitted`
      // from the projection but leaves `pathToId` empty (the boot-seed
      // asymmetry), and delete-tombstone routing in {@link onDelete} keys off
      // `pathToId`. Without this set, a boot-seeded entity whose file is later
      // deleted would leave a permanent projection ghost (no tombstone). We do
      // NOT call deletePending here — fail-closed: an unchanged path cannot
      // legitimately be pending, because the gate means an uncommitted
      // path never earned a `lastEmitted` entry to match against.
      this.pathToId.set(path, msg.id);
      return false; // change-gate: unchanged snapshot, suppress.
    }

    // Observation gate: for epic/task DEFINITION files, suppress
    // emission unless the file is in git HEAD. An uncommitted file goes to
    // {@link pending}; the worker drains the set on the next git-worker
    // snapshot pulse (commit/checkout/branch-switch may have moved HEAD,
    // and a `git commit` does not change file content so FSEvents will
    // not re-fire). State-file (`task-state`) paths bypass this gate
    // because they bypass this code path entirely (they early-returned
    // above via the `task-state` arm). `isTracked` defaults to
    // `() => true`, so a gateless scanner emits unconditionally.
    //
    // a commit-driven ingest (`triggeredByCommit === true`) BYPASSES
    // the gate entirely — the `plan-commit-changed` signal already proves
    // the path is in HEAD (the git-worker enumerated it from a landed commit),
    // so re-running the fail-closed probe is redundant and (on its 1s
    // fail-closed timeout) is the silent-bounce-to-pending bug this epic
    // fixes. A bounce on the commit path is now impossible by construction;
    // only the genuinely-uncertain FSEvents/recheck paths reach `isTracked`.
    // The `triggeredByCommit` bypass still flows through the change-gate above,
    // so a commit re-ingest of an unchanged file suppresses cheaply too.
    //
    // We do NOT touch `pathToId` / `lastEmitted` for a gated path: the
    // reducer never saw the entity, so there is nothing to retract on a
    // delete, and the change-gate has no "last good" to compare against
    // when the file finally lands in HEAD. A pending path is its own
    // index — see {@link pending} / {@link recheckPending} / {@link onDelete}.
    if (!triggeredByCommit && !this.isTracked(path)) {
      // Make the silent bounce LOUD: a heartbeat-only recovery from
      // here is the signature of the fast path failing. This is the gated
      // FSEvents / recheckPending path — the commit path never reaches it.
      this.log(
        `[plan-worker] fn-629 gate bounced ${path} to pending (not in HEAD; gated FSEvents/recheck path)`,
      );
      this.addPending(path);
      return false;
    }
    // The file IS in HEAD now (or the gate is disabled, or this is a
    // commit-driven bypass) AND its content changed. If this path was
    // previously pending, drop it from the set — it has now drained.
    this.deletePending(path);

    this.pathToId.set(path, msg.id);
    this.lastEmitted.set(msg.id, serialized);
    this.onSnapshot(msg);
    return true;
  }

  /**
   * Re-probe the gate over the paths it has stashed in {@link pending} and
   * emit any that are now in HEAD. Called by the worker on every git-worker
   * snapshot pulse / reflog fire — a `git commit` does not change the file's
   * content so FSEvents will not re-fire on commit, and without this drain a
   * freshly-committed epic would sit in pending forever (projection-absent,
   * never dispatched).
   *
   * batched + scoped, the ~74s emission-lag fix. The OLD shape
   * `for (path of pending) onChange(path)` spawned one synchronous
   * `git cat-file` PER pending path across ALL repos on EVERY trigger; a
   * cross-repo pending set of ~1292 abandoned `.keeper` files turned each
   * trigger into a synchronous git storm that starved the single-threaded
   * worker so the realtime `plan-commit-changed` bypass queued behind it
   * for tens of seconds. Two levers collapse it:
   * - **Scope.** With `root`, drain ONLY the pending paths in that repo (main
   *   stamps the originating `GitSnapshot`/`Commit`'s `project_dir`); without
   *   `root` (the boot/heartbeat callers, and the kick — an uncommitted plan
   *   file may sit in ANY repo and must not be stranded), cover every
   *   {@link pendingRepos}.
   * - **Batch.** GROUP the in-scope pending paths by repo and probe each repo
   *   with ONE {@link isTrackedBatch} call (a single
   *   `git cat-file --batch-check`), then re-run {@link onChange} ONLY for the
   *   paths the batch reports in-HEAD. A still-uncommitted path is left in
   *   pending WITHOUT an `onChange` call (so it triggers no per-path spawn) —
   *   exactly the storm the old loop caused. The batch fails closed (all
   *   `false`) on any anomaly, so a parse slip leaves a path pending rather
   *   than wrongly emitting it (the dup-dispatch guard).
   *
   * `onChange` re-checks the per-path gate as a belt-and-suspenders, so even
   * if a batch+onChange disagreed (they can't on a stable HEAD) the per-path
   * predicate still governs the emit. The in-HEAD subset is snapshotted into
   * an array before the loop so an `onChange`-driven `pending` mutation during
   * the loop is safe.
   */
  recheckPending(root?: string): void {
    if (this.pending.size === 0) {
      return;
    }
    // a confirmed realtime drain (driven by the reflog watch, the
    // GitSnapshot/Commit `recheck-pending` post, or the approval kick) is a
    // FAST path — stamp `last_fast_path_at` so a later heartbeat measures
    // staleness against it. Stamped after the empty-check so a no-op recheck
    // (nothing pending) does NOT pretend a fast path delivered work.
    // label as `recheck-pending` so a later backstop's attribution can
    // name this path; the reflog watch is the dominant driver of this drain for
    // the no-pending-repo-commit case the epic targets.
    this.markFastPath("recheck-pending");
    // Group the in-scope pending paths by repo root. `root` set → only that
    // repo's paths; absent → every repo with at least one pending path. A path
    // whose repo root can't be derived (shape drift) is skipped — it has no
    // repo to batch-probe and would have failed `isPathInHead` anyway.
    const byRepo = new Map<string, string[]>();
    for (const path of this.pending) {
      const repo = repoRootFromPlanPath(path);
      if (repo === null) continue;
      if (root !== undefined && repo !== root) continue;
      const group = byRepo.get(repo);
      if (group === undefined) {
        byRepo.set(repo, [path]);
      } else {
        group.push(path);
      }
    }
    // One batched probe per repo; re-run `onChange` only for the now-in-HEAD
    // paths (the others stay pending with no per-path spawn).
    for (const [repo, paths] of byRepo) {
      const rels = paths.map((p) => relative(repo, p));
      const inHead = this.isTrackedBatch(repo, rels);
      const toEmit: string[] = [];
      for (let i = 0; i < paths.length; i++) {
        if (inHead[i] === true) {
          const path = paths[i];
          if (path !== undefined) toEmit.push(path);
        }
      }
      for (const path of toEmit) {
        this.onChange(path);
      }
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
   * Log that a TRIGGER-driven reconcile (the 60s heartbeat, an FSEvents-drop
   * rescan, or the `data_version` poll) delivered a snapshot. Routed
   * through the scanner's own `log` sink (the private field the callers can't
   * reach).
   *
   * Log SEMANTICS branch on whether the trigger is a FAST path or a BACKSTOP:
   * - `"heartbeat"` is the SHOULD-NEVER-FIRE paranoia floor. With the
   *   `data_version` poll + reflog watch landed, an emit here means EVERY fast
   *   path missed a change — a genuine ALARM that the realtime architecture is
   *   broken (or a `.keeper` file is genuinely abandoned-uncommitted), so it
   *   logs the loudest wording. It must NEVER fire in normal operation.
   * - `"fswatcher-drop"` is the FSEvents-drop rescan backstop — an
   *   emit means the kernel coalesced/dropped a watcher edge the poll/reflog
   *   fast paths then also missed; loud, but expected on a known macOS FSEvents
   *   overrun, not a realtime-architecture failure.
   * - `"db-poll"` is itself a FAST path (every keeper DB write drives it,
   *   including the close→approve fold), so an emit here is EXPECTED, not a
   *   missed-fast-path alarm. It logs a low-key "did real work" line WITHOUT
   *   the alarm wording so a poll-rescued emit is distinguishable from (and not
   *   confused with) a heartbeat-rescued one. (The `.git/logs/HEAD` reflog
   *   trigger drives {@link recheckPending} directly, not this sink, so it too
   *   never logs the alarm.)
   *
   * The caller gates this on `onChange` having RETURNED `true` (it emitted),
   * which the in-memory change-gate (`lastEmitted`) already dedups against a
   * fast-path emit earlier this cycle — so a normal first-time emit is never
   * double-logged here.
   *
   * Never a synthetic event — re-fold determinism forbids a fold-driving fact
   * from a trigger log line.
   */
  logBackstopEmit(
    path: string,
    reason: "heartbeat" | "fswatcher-drop" | "db-poll",
  ): void {
    if (reason === "db-poll") {
      this.log(`[plan-worker] db-poll emitted ${path}`);
      return;
    }
    if (reason === "heartbeat") {
      // Paranoia floor fired in normal operation: every realtime fast path
      // (data_version poll, reflog watch, FSEvents) missed this change. Loudest
      // wording so a grep on the alarm count surfaces a broken fast path.
      // rate-limit ONLY this stderr line (per backstop key) so a broken
      // fast path rescuing every 5s heartbeat can't flood server.stderr — the
      // NDJSON record + counters route through `fireBackstop` and stay complete.
      if (this.alarmAllowed("plan-heartbeat")) {
        this.log(
          `[plan-worker] ALARM: backstop (heartbeat) emitted ${path} — every fast path missed it; the realtime path is broken or the file is abandoned-uncommitted`,
        );
      }
      return;
    }
    // `fswatcher-drop`: a known macOS FSEvents overrun rescued via the drop
    // rescan — loud but expected, so rate-limit the prose under the same gate.
    if (this.alarmAllowed("rescan-drop")) {
      this.log(
        `[plan-worker] backstop (${reason}) emitted ${path} — a fast path missed it`,
      );
    }
  }

  /**
   * Record that a `.keeper/{epics,tasks}/*.json` file was enumerated on disk
   * during a boot scan — the on-disk census the {@link sweep} diffs against.
   * Called from `scanPlanDir` for EVERY file BEFORE `onChange`, so it counts
   * regardless of whether the snapshot parsed or was change-gate-suppressed.
   *
   * The id is derived from the filename (basename minus `.json`), which equals
   * the plan id — keying off the name (not a parse) means a file mid-rewrite
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
 * other field is taken verbatim (coerced to string-or-null).
 */
/**
 * Build a `plan-epic` message from a parsed epic JSON + the epic's current
 * parked question (carried in the sibling `.keeper/state/epics/<id>.state.json`
 * file), or null when the file has no usable id. `question` is passed in by
 * the caller (the {@link PlanScanner}, which caches the last per-epic value)
 * mirroring {@link buildTaskMessage}'s `runtimeStatus` parameter; absent /
 * never-observed defaults to `null` (no parked question).
 *
 * The OBJECT-LITERAL SLOT ORDER below is load-bearing — the change-gate
 * compares `JSON.stringify` output byte-for-byte, and the seed reconstruction
 * in {@link seedFromDb} must produce identical key order or every epic
 * re-emits a synthetic snapshot on every daemon boot.
 */
export function buildEpicMessage(
  raw: RawEpic,
  question: string | null = null,
  // `log` is retained in the signature for call-site parity (the scanner passes
  // its own logger positionally) even though no field currently coerces.
  _log: (msg: string) => void = (m) => console.error(m),
): PlanEpicMessage | null {
  const id = asString(raw.id);
  if (id === null) {
    return null;
  }
  return {
    kind: "plan-epic",
    id,
    number: epicNumberFromId(id),
    title: asString(raw.title),
    projectDir: asString(raw.primary_repo),
    status: asString(raw.status),
    dependsOnEpics: asStringArray(raw.depends_on_epics),
    lastValidatedAt: asString(raw.last_validated_at),
    question,
  };
}

/**
 * Build a `plan-task` message from a parsed task JSON + the task's current
 * runtime status (carried in the sibling `.keeper/state/tasks/<id>.state.json`
 * file). Returns null when the task JSON has no usable id.
 *
 * Field derivation:
 * - `workerPhase` is DERIVED from the task definition: `worker_done_at`
 *   present → `"done"` else `"open"`. Surfaces the same compressed signal the
 *   field used to carry under the legacy `status` name.
 * - `runtimeStatus` is the plan-native enum carried by the state file —
 *   passed in by the caller (the {@link PlanScanner}, which caches the last
 *   per-task value). When absent / never-observed, the caller passes `"todo"`
 *   (plan's `merge_task_state` default).
 *
 * The OBJECT-LITERAL SLOT ORDER below is load-bearing — the change-gate
 * compares `JSON.stringify` output byte-for-byte, and the seed reconstruction
 * in {@link seedFromDb} must produce identical key order or every task
 * re-emits a synthetic snapshot on every daemon boot.
 */
export function buildTaskMessage(
  raw: RawTask,
  runtimeStatus: string = "todo",
  // `log` is retained in the signature for call-site parity (the scanner passes
  // its own logger positionally) even though no field currently coerces.
  _log: (msg: string) => void = (m) => console.error(m),
): PlanTaskMessage | null {
  const id = asString(raw.id);
  if (id === null) {
    return null;
  }
  return {
    kind: "plan-task",
    id,
    epicId: asString(raw.epic),
    number: taskNumberFromId(id),
    title: asString(raw.title),
    targetRepo: asString(raw.target_repo),
    tier: asString(raw.tier),
    model: asString(raw.model),
    workerPhase: asString(raw.worker_done_at) !== null ? "done" : "open",
    runtimeStatus,
    dependsOn: asStringArray(raw.depends_on),
  };
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Find the plan-data-dir ancestor of `path` — the parent of the parent (because
 * `path` is `<data-dir>/{epics,tasks}/<id>.json`). Returns the parent dir of the
 * data dir (the plan-managed repo root in keeper's layout) or `null` if no
 * `.keeper` data dir is found in the ancestry. Pure
 * path arithmetic.
 *
 * observation gate: the live worker uses this to derive the repo
 * root to run `git cat-file -e HEAD:<relpath>` against without a per-path
 * shell-out (`git rev-parse --show-toplevel` per call would be a
 * 100ms-class per-file cost on a `~/code` storm). The data dir IS
 * always at the repo root — plan writes via `_resolve_repo_root` which
 * calls `git rev-parse --show-toplevel` and refuses to operate on a
 * non-git tree — so the data-dir parent equals the repo root by
 * construction. A future subtree-plan layout would need to switch to
 * `git rev-parse`.
 */
export function repoRootFromPlanPath(path: string): string | null {
  // Walk up from `path` looking for a `.keeper` plan data dir;
  // return its parent. The shape is always
  // `.../<root>/<data-dir>/{epics,tasks}/<id>.json` so the data-dir element sits
  // at depth `n-3` from the basename. We could index directly, but a walk is
  // more robust against any future shape drift.
  let cur = dirname(path);
  while (cur !== "" && cur !== "/" && cur !== ".") {
    const parent = dirname(cur);
    if (parent === cur) {
      return null; // hit filesystem root without finding a data dir
    }
    const segments = cur.split(sep);
    if (isDataDirName(segments[segments.length - 1])) {
      return parent;
    }
    cur = parent;
  }
  return null;
}

/**
 * observation gate predicate: is `path` in git HEAD (committed)?
 * Returns `false` for untracked paths AND for staged-but-not-committed
 * paths (the plan commit-failed window the gate exists to close).
 *
 * Implementation: `git -C <root> cat-file -e HEAD:<relpath>` — exits 0 iff
 * the path exists in the HEAD tree. Hits the object DB without scanning
 * the index or worktree, so it's fast (~5-10ms per call) and cannot block
 * the watcher callback for long even under a churning plan tree. The
 * subprocess is bounded by {@link GIT_CHECK_TIMEOUT_MS}.
 *
 * Edge cases handled by returning `false` (fail closed — never wrongly
 * announce a file as committed):
 * - Path is not inside a `.keeper` tree (shouldn't happen, the caller
 *   already classified) — no repo root resolvable → `false`.
 * - `git` shell-out fails (not a git repo, no commits yet, timeout) →
 *   `false`. The next git-worker pulse will retry.
 * - Path is outside the resolved repo root → `false`.
 *
 * Exported for unit reach.
 */
export function isPathInHead(path: string): boolean {
  const root = repoRootFromPlanPath(path);
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
 * Batched sibling of {@link isPathInHead}: given a repo `root` and the
 * repo-relative paths `rels`, returns a positional `boolean[]` (`result[i]` is
 * "is `rels[i]` in HEAD") in ONE `git cat-file --batch-check` spawn. The
 * scoped/batched {@link PlanScanner.recheckPending} drain uses it instead of
 * one {@link isPathInHead} spawn per pending path — so a cross-repo pending
 * set no longer turns every gate-drain trigger into a synchronous per-path git
 * storm that starves the single-threaded worker (the ~74s emission lag).
 *
 * `git cat-file --batch-check=%(objecttype)` reads one ref per stdin line and
 * prints one stdout line each, in input order. For an in-HEAD path the line is
 * the object type (`blob`); for a missing ref git prints `<rev> missing`. We
 * parse strictly 1:1-positional to `rels` and treat a `" missing"`-terminated
 * (or empty) line as not-in-HEAD.
 *
 * Fail-closed, byte-identical posture to {@link isPathInHead}'s `catch →
 * false`: on a non-zero exit, a timeout, a line-count mismatch, or a spawn
 * throw we return ALL-`false`. A parse slip that wrongly announced a path as
 * in-HEAD would re-open the duplicate-dispatch harm, so any anomaly
 * resolves to "not committed; the next pulse retries" rather than a guess.
 *
 * Empty `rels` is a no-op (`[]`, NO spawn) — an empty batch stdin yields a
 * spurious `missing` line, so we must never feed git an empty input.
 *
 * Exported for unit reach.
 */
export function isPathInHeadBatch(root: string, rels: string[]): boolean[] {
  if (rels.length === 0) {
    return [];
  }
  const allFalse = (): boolean[] => rels.map(() => false);
  // Normalize path separators to `/` for the git ref (moot on macOS where
  // `sep === "/"`, but explicit so a future win32 build doesn't feed git a
  // backslash ref it can't resolve).
  const refs = rels.map((rel) => `HEAD:${rel.split(sep).join("/")}`);
  try {
    const res = Bun.spawnSync(
      ["git", "-C", root, "cat-file", "--batch-check=%(objecttype)"],
      {
        stdin: Buffer.from(`${refs.join("\n")}\n`),
        stdout: "pipe",
        stderr: "ignore",
        timeout: GIT_CHECK_TIMEOUT_MS,
      },
    );
    if (!res.success || res.exitCode !== 0) {
      return allFalse();
    }
    const out = res.stdout.toString();
    // Trailing newline yields a final empty element — drop it so the line
    // count matches `rels` exactly.
    const lines = out.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    if (lines.length !== rels.length) {
      return allFalse(); // line-count mismatch → fail closed for the whole batch.
    }
    return lines.map((line) => {
      // A missing ref prints `<rev> missing`; an in-HEAD ref prints its object
      // type (e.g. `blob`). Anything ending in ` missing` (or empty) is
      // not-in-HEAD.
      const trimmed = line.trimEnd();
      return trimmed.length > 0 && !trimmed.endsWith(" missing");
    });
  } catch {
    return allFalse();
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
 * Periodic reconcile cadence — the SHOULD-NEVER-FIRE paranoia backstop
 *. With T1-T3 landed, three realtime triggers cover every case:
 * the fast {@link PLAN_DB_POLL_MS} `data_version` poll (every keeper DB
 * write — the close→approve fold included — drives a gated rescan in
 * ~50ms), the per-repo `.git/logs/HEAD` reflog watch (a commit always
 * appends there, closing the brand-new/never-seen-repo tail the
 * commit-ingest channel can't cover), and the broad FSEvents
 * subscription. The heartbeat is the FINAL FLOOR for the lone residual
 * case with literally no other signal — a `.keeper` file that flashed
 * dirty, never committed, and sits in a repo with no DB write and no
 * reflog append. In normal operation it must NEVER deliver a snapshot; a
 * `"heartbeat"`-tagged backstop emit is a loud alarm that a fast path is
 * broken (see {@link PlanScanner.logBackstopEmit}). Lowered from 60s to
 * 5s so even that residual case is near-realtime — the change-gate makes a
 * quiescent reconcile a near-no-op, so the higher tick rate is cheap.
 * Exported for unit reach (tests assert on the constant rather than the
 * timer plumbing).
 */
export const RECONCILE_HEARTBEAT_MS = 5_000;

/**
 * Per-cycle cap on mute-watcher re-arm tear-down + re-subscribe (the git-worker
 * fn-771 precedent value). The configured-root set is small, so the cap is cheap
 * insurance against a pathological flag explosion churning streams in one drain;
 * any overflow stays flagged for the next drain. Exported for unit reach (the
 * {@link decidePlanResubscribe} cap test asserts against it).
 */
export const MAX_SUBSCRIBES_PER_CYCLE = 16;

/**
 * Cadence (ms) at which the worker flushes its in-memory backstop counters as
 * {@link BackstopRollup} records — the denominator
 * (fires_total / rescues_total) `scripts/backstop-stats.ts` divides into the
 * rescue records for a true RATE. Slow (5 min) because a rollup is a periodic
 * checkpoint, NOT a per-fire line; a clean shutdown also flushes one final
 * rollup, so a quiescent daemon still records a complete denominator. Exported
 * for unit reach.
 */
export const BACKSTOP_ROLLUP_FLUSH_MS = 5 * 60_000;

/**
 * Fast `PRAGMA data_version` poll cadence — same value as
 * `git-worker.ts` `DB_POLL_MS` / `wake-worker.ts` so all producer/reader
 * workers share one schedule. A bump means SOMETHING committed to keeper's DB
 * (a hook event, a fold, a `Commit` discharge); since the close→approve flow
 * that makes a plan file "ready" IS such a write, polling the DB collapses
 * close→emit to ~50ms for any repo keeper already watches — no longer bound by
 * the 60s heartbeat. 25ms is the documented floor (don't poll faster, it can
 * interfere with @parcel/watcher's kqueue subscription on macOS); 100ms is
 * comfortably above it and matches the sibling producer. Exported for unit
 * reach. Overridable per-worker via `PlanWorkerData.pollMs` so tests can drive
 * a tighter cadence without a heartbeat-length wait.
 */
export const PLAN_DB_POLL_MS = 100;

/**
 * Single-flight coalescing wrapper — the same `cycleRunning` /
 * `wakePending` shape `src/autopilot-worker.ts` keeps for its reconcile drive.
 * Returns a trigger function: invoking it while the `work` body is mid-flight
 * sets a pending flag rather than re-entering, and the running cycle loops once
 * more after `work` returns — so a BURST of triggers coalesces into EXACTLY ONE
 * trailing re-run, never a queue.
 *
 * The `work` body is synchronous here (the plan-worker's recheck + reconcile
 * are both sync), so the in-flight window only spans a re-entrant trigger
 * (`work` calling the returned trigger). That re-entrancy is exactly what the
 * The poll must coalesce — a `data_version` bump landing while the previous
 * bump's scan runs — and it makes the contract pure-unit-testable without a
 * real timer (a test passes a `work` that re-triggers and asserts the trailing
 * single re-run).
 *
 * `isShutdown` is checked before each loop iteration so a shutdown mid-cycle
 * stops the trailing re-run. `onError` (optional) receives any throw from
 * `work`; the wrapper swallows it (log+continue, no self-heal) and the
 * `finally` always clears the in-flight guard so a throw can't wedge the loop.
 * Exported for unit reach.
 */
export function makeSingleFlight(
  work: () => void,
  isShutdown: () => boolean,
  onError?: (err: unknown) => void,
): () => void {
  let cycleRunning = false;
  let wakePending = false;
  return (): void => {
    if (cycleRunning) {
      wakePending = true;
      return;
    }
    cycleRunning = true;
    try {
      do {
        wakePending = false;
        if (isShutdown()) {
          return;
        }
        try {
          work();
        } catch (err) {
          onError?.(err);
        }
      } while (wakePending && !isShutdown());
    } finally {
      cycleRunning = false;
    }
  };
}

/**
 * Boot scan: recursively walk `root` for `<data-dir>/{epics,tasks}/*.json`
 * files (the data dir is `.keeper/` — see {@link DATA_DIR_NAMES}) and run each
 * through the scanner. Called once after
 * each subscribe resolves so files that pre-existed the daemon's boot (or were
 * changed while keeperd was down) are picked up without waiting for a watcher
 * event. The change-gate in PlanScanner suppresses re-emits for files that
 * already match the seeded projection row. Exported for unit reach.
 *
 * The walk MUST recurse: the live `@parcel/watcher` subscribe is recursive, and
 * plan files live at `<root>/<project>/<data-dir>/…` — there is no data dir at
 * the root itself. A non-recursive scan finds nothing under a broad root, so
 * only files touched while keeperd is live would ever enter the projection.
 * {@link PRUNE_DIRS} keeps the walk cheap (skips `node_modules`/`.git`/… under a
 * big root); a data dir is scanned but NOT descended into; symlinked
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
    // Names present in this dir, so the precedence resolution below is an O(1)
    // Set hit and doesn't re-stat.
    const present = new Set<string>();
    for (const entry of entries) {
      if (!entry.isDirectory() || PRUNE_DIRS.has(entry.name)) {
        continue;
      }
      // A data dir is NOT pushed onto the walk stack — it has no nested data
      // dir to find, and scanning it is handled in the resolution pass below.
      if (isDataDirName(entry.name)) {
        present.add(entry.name);
        continue;
      }
      stack.push(join(dir, entry.name));
    }
    // Resolve to the `.keeper/` data dir and scan it.
    const resolved = resolveDataDirName(present);
    if (resolved === null) {
      continue;
    }
    const full = join(dir, resolved);
    scanPlanDir(full, scanner);
  }
}

/**
 * Enumerate one `.keeper` dir's `state/tasks/` + `epics/` + `tasks/` files and
 * run each through the scanner. A missing subdir is fine (skip). The change-gate
 * handles re-emit suppression.
 *
 * The `state/tasks/` pass runs FIRST so the per-task runtime-status cache is
 * primed before any definition file is read — otherwise the first snapshot
 * would reset runtime_status to "todo" for the whole boot window.
 *
 * For the runtime-status case: a state file existing at
 * daemon boot (plan's `LocalFileStateStore` writes `<id>.state.json` on
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
 *
 * `triggerReason`: when set (a trigger caller — the
 * 60s heartbeat, an FSEvents-drop rescan, or the `data_version` poll), a
 * definition-file `onChange` that RETURNS `true` (it emitted a snapshot) logs a
 * trigger-tagged line via {@link PlanScanner.logBackstopEmit} (which keeps the
 * loud "a fast path missed it" alarm for the two BACKSTOP reasons only — a
 * `db-poll` emit is a normal fast-path success). The boot scan
 * ({@link scanRoot}) passes `undefined` and stays silent — a first-time boot
 * emit is expected, not a noteworthy event.
 *
 * Returns `true` iff at least one definition-file `onChange` emitted a snapshot
 * during this scan — the `rescued` boolean the backstop caller folds
 * into one uniform `missed-wake` record per fire (the heartbeat / FSEvents-drop
 * backstop did real work a fast path missed). Boot / `db-poll` callers ignore
 * the return (boot isn't a backstop; `db-poll` IS a fast path, stamped
 * separately via {@link PlanScanner.markFastPath}).
 */
function scanPlanDir(
  planDir: string,
  scanner: PlanScanner,
  triggerReason?: "heartbeat" | "fswatcher-drop" | "db-poll",
): boolean {
  // track whether ANY definition-file onChange emitted this scan so the
  // backstop caller can fold it into one `rescued` boolean per fire.
  let emittedAny = false;
  // Pass 1: prime `runtimeStatusCache` from `state/tasks/*.state.json`. A
  // missing dir is fine (fresh clone with no state files yet). Each file is
  // bounded-read + safe-parsed + coerced through the same guard as the live
  // `task-state` onChange arm, so the cache only holds the four-value enum
  // vocabulary; malformed JSON / bad-status / oversized files skip-and-log
  // without poisoning the cache. The cache write is the only side effect:
  // no snapshot emits here.
  const stateDir = join(planDir, "state", "tasks");
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
      // The cache miss reads as the plan default "todo" downstream.
      console.error(
        `[plan-worker] boot scan invalid runtime status in ${full}: ${JSON.stringify(bad)}; skipping cache prime`,
      );
      primed = false;
    });
    if (primed) {
      scanner.primeRuntimeStatus(taskId, coerced);
    }
  }

  // Pass 1b: prime `epicQuestionCache` from `state/epics/*.state.json` —
  // the epic mirror of the tasks prime pass above. A missing dir is fine
  // (fresh clone with no state files yet, or an epic with no parked
  // question). Each file is bounded-read + safe-parsed + coerced through the
  // same guard as the live `epic-state` onChange arm; malformed JSON /
  // bad-question / oversized files skip-and-log without poisoning the cache.
  const epicStateDir = join(planDir, "state", "epics");
  let epicStateNames: string[];
  try {
    epicStateNames = readdirSync(epicStateDir);
  } catch {
    epicStateNames = []; // No state/epics/ subdir — nothing to prime.
  }
  for (const name of epicStateNames) {
    if (!name.endsWith(".state.json")) {
      continue;
    }
    const epicId = name.slice(0, -".state.json".length);
    if (epicId.length === 0) {
      continue;
    }
    const full = join(epicStateDir, name);
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
    const raw = parsed as RawEpicState;
    let primed = true;
    const coerced = coerceEpicQuestion(raw.question, (bad) => {
      // Match the live onChange arm: an invalid value logs and is SKIPPED
      // (no cache write), so the cache miss reads as the plan default null.
      console.error(
        `[plan-worker] boot scan invalid epic question in ${full}: ${JSON.stringify(bad)}; skipping cache prime`,
      );
      primed = false;
    });
    if (primed) {
      scanner.primeEpicQuestion(epicId, coerced);
    }
  }

  // Pass 2: enumerate the canonical definition trees. Tasks now read the
  // primed cache so their first emitted snapshot carries the correct
  // runtime_status; epics read the epic-question cache the same way.
  for (const collection of ["epics", "tasks"]) {
    const dir = join(planDir, collection);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      // No epics/ or tasks/ subdir under this .keeper — nothing to scan.
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
        // Boot/heartbeat/drop ingest is FSEvents-gated (`triggeredByCommit`
        // stays false) — this is the genuinely-uncertain path the gate
        // exists for. When a backstop trigger drove this scan and `onChange`
        // actually emitted, surface it: a backstop delivering work means a
        // fast path missed it.
        const emitted = scanner.onChange(full);
        if (emitted) {
          emittedAny = true;
          if (triggerReason !== undefined) {
            scanner.logBackstopEmit(full, triggerReason);
          }
        }
      }
    }
  }
  return emittedAny;
}

/**
 * Shallow discovery of `<root>/<project>/<data-dir>` dirs across the configured
 * roots — the cheap convergence backstop the periodic reconcile and on-drop
 * recovery share. A data dir is `.keeper/` (see {@link DATA_DIR_NAMES}).
 *
 * One level deep ONLY: for each `root`, read its top-level entries and emit
 * `<root>/<entry>/<data-dir>` for every directory entry whose name isn't in
 * {@link PRUNE_DIRS} and that holds a real data dir.
 * Heavy vendored trees (`node_modules`, `.git`, …) are skipped at the
 * project-name step, so a broad root like `~/code` stays O(#projects) instead of
 * O(`~/code` tree). No recursive descent — a project nested deeper than one
 * level under a configured root is intentionally out of scope (the live
 * recursive FSEvents watch + boot {@link scanRoot} cover those cases; this
 * helper exists for the cheap heartbeat / drop-recovery path).
 *
 * Symlinked directories are not followed (`Dirent.isDirectory()` is false
 * for a symlink), so a symlink cycle can't trap the walk. A missing root
 * skip-and-logs (same discipline as {@link scanRoot}). Pure I/O — no DB
 * read, no event emission; the change-gate side effect lives downstream in
 * {@link scanPlanDir}. Exported for unit reach.
 */
export function discoverPlanDirs(roots: readonly string[]): string[] {
  const dirs: string[] = [];
  for (const root of roots) {
    let entries: Dirent[];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch (err) {
      console.error(
        `[plan-worker] discoverPlanDirs failed to read ${root}: ${stringifyErr(err)}`,
      );
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || PRUNE_DIRS.has(entry.name)) {
        continue;
      }
      // Resolve to the `.keeper/` data dir present under this project.
      const present = new Set<string>();
      for (const name of DATA_DIR_NAMES) {
        try {
          if (statSync(join(root, entry.name, name)).isDirectory()) {
            present.add(name);
          }
        } catch {
          // No data dir of this name under this project — common case.
        }
      }
      const resolved = resolveDataDirName(present);
      if (resolved !== null) {
        dirs.push(join(root, entry.name, resolved));
      }
    }
  }
  return dirs;
}

/**
 * Re-scan a single repo root's `.keeper/` data dir
 * ({@link resolveDataDirName}) through the change-gated
 * {@link scanPlanDir} primitive. The repo-scoped re-scan the reflog-watch
 * fire uses (a commit landed in `repoRoot`, possibly already in-HEAD before any
 * FSEvent gated it). A no-op when the repo holds no data dir. `triggerReason`
 * tags the calling trigger for the per-emit log line, same as
 * {@link scanPlanDir}. Pure I/O dispatch — no DB read, no emission of its
 * own; the change-gate side effect lives in {@link scanPlanDir}. Exported
 * for unit reach.
 */
export function scanRepoDataDirs(
  repoRoot: string,
  scanner: PlanScanner,
  triggerReason?: "heartbeat" | "fswatcher-drop" | "db-poll",
): void {
  const present = new Set<string>();
  for (const name of DATA_DIR_NAMES) {
    try {
      if (statSync(join(repoRoot, name)).isDirectory()) {
        present.add(name);
      }
    } catch {
      // no data dir of this name under this repo — skip.
    }
  }
  const resolved = resolveDataDirName(present);
  if (resolved !== null) {
    scanPlanDir(join(repoRoot, resolved), scanner, triggerReason);
  }
}

/**
 * ADDITIVE re-ingest of every `<root>/<project>/<data-dir>` dir discovered by
 * {@link discoverPlanDirs} via the change-gated {@link scanPlanDir}
 * primitive — the heartbeat backstop and on-drop recovery path (epic
 *).
 *
 * "Additive" is the load-bearing word: this path NEVER calls
 * {@link PlanScanner.sweep}, so a transient read failure / mid-rewrite
 * parse miss / file that hasn't shown up yet can NOT produce a false
 * tombstone. Deletions stay owned exclusively by (1) the live FSEvents
 * `onDelete`, (2) the commit-trigger `plan-commit-changed` arm
 * (`git rm` is a `committed_mode: 0` zero-oid sentinel), and (3) the
 * one-shot boot sweep — none of which run on this code path.
 *
 * Steady-state cost: one shallow `readdirSync` per root + one `statSync`
 * per top-level entry + one shallow `readdirSync` per `.keeper/{epics,tasks,
 * state/tasks}` + one bounded read + parse per plan file. The
 * change-gate (`PlanScanner.lastEmitted`) suppresses re-emits for unchanged
 * files, so a quiescent repo emits nothing across heartbeats.
 *
 * Per-dir failures inside {@link scanPlanDir} skip-and-log (the same
 * discipline as the boot scan); the loop never throws. Exported for unit
 * reach.
 *
 * `triggerReason` tags the calling trigger —
 * `"heartbeat"` for the 60s reconcile, `"fswatcher-drop"` for an FSEvents-drop
 * rescan, `"db-poll"` for the `data_version` poll — so an emission logs
 * a trigger-tagged "did real work" line (the BACKSTOP reasons carry the loud
 * "a fast path missed it" alarm; `db-poll` does not — it IS a fast path). Pass
 * `undefined` (boot / silent reconcile) to suppress the log.
 *
 * `onPlanDir` is invoked once per `.keeper` dir surfaced by this
 * sweep, BEFORE its scan — the live worker uses it to nudge git-worker
 * discovery for a newly-seen `.keeper` repo (de-duped worker-side). The walk
 * already paid for the directory enumeration, so this rides free; pure unit
 * tests omit it.
 *
 * Returns `true` iff at least one `.keeper` dir's scan emitted a snapshot
 * — the `rescued` boolean the backstop caller (heartbeat / FSEvents-
 * drop) folds into one uniform `missed-wake` record per fire. The `db-poll`
 * (fast-path) and boot callers ignore the return. The boolean's meaning is
 * unchanged across the fn-788 attribution add (the backstop record / counters
 * keep their semantics byte-for-byte).
 *
 * `emittedRoots` (optional out-param) — when passed, every CONFIGURED root whose
 * `.keeper` scan emitted is added to it (a discovered `<root>/<project>/.keeper`
 * dir is attributed back to its configured root via
 * {@link attributePlanDirToRoot}). The mute-watcher re-arm consumes this to
 * flag exactly the implicated roots; all other callers omit it.
 */
export function reconcilePlanDirs(
  roots: readonly string[],
  scanner: PlanScanner,
  triggerReason?: "heartbeat" | "fswatcher-drop" | "db-poll",
  onPlanDir?: (planDir: string) => void,
  emittedRoots?: Set<string>,
): boolean {
  const dirs = discoverPlanDirs(roots);
  let emittedAny = false;
  for (const dir of dirs) {
    if (onPlanDir !== undefined) {
      onPlanDir(dir);
    }
    if (scanPlanDir(dir, scanner, triggerReason)) {
      emittedAny = true;
      if (emittedRoots !== undefined) {
        const root = attributePlanDirToRoot(dir, roots);
        if (root !== null) emittedRoots.add(root);
      }
    }
  }
  return emittedAny;
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
      "SELECT epic_id, epic_number, title, project_dir, status, depends_on_epics, last_validated_at, question, tasks FROM epics",
    )
    .all() as {
    epic_id: string;
    epic_number: number | null;
    title: string | null;
    project_dir: string | null;
    status: string | null;
    depends_on_epics: string | null;
    last_validated_at: string | null;
    question: string | null;
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
      dependsOnEpics: parseStringArrayColumn(e.depends_on_epics),
      // `last_validated_at` is a nullable TEXT column; `asString` collapses
      // any non-string / empty-string stored value to `null`, mirroring the
      // producer-side coercion in `buildEpicMessage`. Object-literal slot
      // position MUST match `buildEpicMessage`'s return — the change-gate
      // compares `JSON.stringify` output byte-for-byte, and a slot mismatch
      // would re-emit one synthetic `EpicSnapshot` per epic every boot.
      lastValidatedAt: asString(e.last_validated_at),
      // `question` is a nullable TEXT column; `asString` collapses any
      // non-string / empty-string stored value to `null`, mirroring
      // `coerceEpicQuestion`'s producer-side contract (a valid stored value is
      // always a non-empty string or NULL, so this is defensive-only). Slot
      // position (last) MUST match `buildEpicMessage`'s return.
      question: asString(e.question),
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
       * Plan-native effort tier. Absent on legacy stored
       * task elements; read defensively (`?? null`) so the reconstructed
       * `PlanTaskMessage.tier` matches `buildTaskMessage`'s output on a
       * fresh re-scan and the change-gate suppresses correctly across the
       * upgrade window.
       */
      tier?: string | null;
      /**
       * Plan-native worker model. Absent on pre-model stored task elements;
       * read defensively (`?? null`) so the reconstructed `PlanTaskMessage.model`
       * matches `buildTaskMessage`'s `asString(raw.model)` on a fresh re-scan and
       * the change-gate byte-compare suppresses correctly across the upgrade
       * window.
       */
      model?: string | null;
      // Legacy column name in the embedded JSON — pre-schema-bump rows carry
      // `status`; post-bump rows carry `worker_phase`. Both are read
      // defensively (whichever is present feeds `workerPhase`) so the seed
      // reconstruction works across the migration window.
      status?: string | null;
      worker_phase?: string | null;
      runtime_status?: string | null;
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
        // Plan-native effort tier. Pre-tier stored elements
        // lack the key — `?? null` matches `buildTaskMessage`'s
        // `asString(raw.tier)` on a tier-less task file so the change-gate
        // byte-compare suppresses on restart.
        tier: t.tier ?? null,
        // Plan-native worker model. Pre-model stored elements lack the key —
        // `?? null` matches `buildTaskMessage`'s `asString(raw.model)` on a
        // model-less task file so the change-gate byte-compare suppresses on
        // restart. Slot position (right after `tier`) mirrors buildTaskMessage.
        model: t.model ?? null,
        // The projection stores the derived worker-phase verbatim under
        // `worker_phase` (post-bump) or the legacy `status` key (pre-bump);
        // read whichever is present and default to "open" for a NULL so the
        // reconstructed seed matches a fresh scan.
        workerPhase: t.worker_phase ?? t.status ?? "open",
        // The projection stores the plan-native runtime status under
        // `runtime_status`; default to "todo" for a (legacy / pre-bump) NULL
        // so the reconstructed seed matches a fresh scan whose state file
        // hasn't been read yet (plan's `merge_task_state` convention).
        runtimeStatus: t.runtime_status ?? "todo",
        // Same coercion as buildTaskMessage so the seed is byte-identical; a
        // (legacy) task element without `depends_on` reconstructs to [].
        dependsOn: asStringArray(t.depends_on),
      };
      scanner.seed(t.task_id, JSON.stringify(msg));
    }
  }
}

/**
 * Resolve the reflog file to watch for `repoRoot`, degrading gracefully
 * (Risk: `core.logAllRefUpdates=false` repos have no `.git/logs/HEAD`).
 * Prefer `.git/logs/HEAD` (appended on every commit when reflogs are on);
 * fall back to `.git/HEAD` (rewritten on branch-switch — weaker but present
 * even with reflogs off). `null` when neither exists (degrade to the
 * heartbeat floor + T1's poll for any repo that produces a DB write).
 *
 * Pure `existsSync` ladder — no mutation, no DB read. Hoisted out of
 * the worker `main()` closure to module scope + exported so the reflog
 * watch-set wiring stays unit-tested after the live reflog tests are deleted.
 */
export function resolveReflogTarget(repoRoot: string): string | null {
  const logsHead = join(repoRoot, ".git", "logs", "HEAD");
  if (existsSync(logsHead)) return logsHead;
  const head = join(repoRoot, ".git", "HEAD");
  if (existsSync(head)) return head;
  return null;
}

/**
 * the discovered plan-repo set — every `<root>/<project>` that
 * holds a `.keeper` tree under the configured roots, via the same
 * {@link discoverPlanDirs} walk the heartbeat reconcile uses (a shallow
 * readdir+stat per root, no DB read, no emission). Each `.keeper` dir's
 * parent IS its repo root (`repoRootFromPlanPath`-shaped), so a commit in
 * any of these repos can be caught by a reflog watch even when it holds no
 * currently-pending path. Pure I/O; failures inside {@link discoverPlanDirs}
 * skip-and-log (so a transient read miss just yields a smaller set this cycle,
 * re-derived on the next reconcile).
 *
 * hoisted out of the worker `main()` closure, parameterized on `roots`
 * (was a closure over `data.roots`) + exported. Thin FS wrapper over the
 * already-exported {@link discoverPlanDirs} + `dirname` — no readdir/dirname
 * logic duplicated here.
 */
export function discoverPlanRepos(roots: readonly string[]): Set<string> {
  const repos = new Set<string>();
  for (const planDir of discoverPlanDirs(roots)) {
    repos.add(dirname(planDir));
  }
  return repos;
}

/**
 * The repos that SHOULD hold a `.git/logs/HEAD` reflog watch: every repo that
 * currently owns a pending path UNION every repo that holds a `.keeper` tree
 * under the configured roots (widening — the latter closes the
 * no-pending-repo commit tail).
 *
 * PURE set arithmetic over the two input sets — READ-only (returns a fresh
 * union; never mutates `pending` or `discovered`). Extracted from
 * `reconcileReflogWatches` so the desired-set derivation is unit-testable
 * without a Worker, a watcher, or a real `~/code` walk.
 */
export function desiredReflogRepos(
  pending: ReadonlySet<string>,
  discovered: ReadonlySet<string>,
): Set<string> {
  const desired = new Set<string>(pending);
  for (const repo of discovered) {
    desired.add(repo);
  }
  return desired;
}

/**
 * Diff the desired reflog-watch set against the live (subscribed) set:
 * `toAdd = desired - live` (repos that should be watched but aren't),
 * `toDrop = live - desired` (repos no longer desired — neither pending nor
 * holding a `.keeper` tree any longer, e.g. a removed `.keeper` repo).
 *
 * PURE set arithmetic — READ-only (returns fresh sets; never mutates the live
 * `reflogSubs`/`reflogSubscribing` sets the worker owns). Extracted
 * from `reconcileReflogWatches` so the add/drop derivation is unit-testable
 * in isolation; the `subscribe()`/`unsubscribe()` I/O + the mutation of the
 * worker's live sets stay in the closure that CALLS this helper.
 */
export function reflogWatchDiff(
  desired: ReadonlySet<string>,
  live: ReadonlySet<string>,
): { toAdd: Set<string>; toDrop: Set<string> } {
  const toAdd = new Set<string>();
  for (const repo of desired) {
    if (!live.has(repo)) toAdd.add(repo);
  }
  const toDrop = new Set<string>();
  for (const repo of live) {
    if (!desired.has(repo)) toDrop.add(repo);
  }
  return { toAdd, toDrop };
}

/**
 * Attribute a discovered `<root>/<project>/.keeper` dir back to the configured
 * root whose FSEvents subscription covers it — the mute-watcher re-arm operates
 * on the broad CONFIGURED root (`data.roots`, the subscription key), not the
 * nested per-project `.keeper` dir the heartbeat scan walks. Returns the
 * LONGEST matching configured-root prefix (a nested configured root wins over a
 * broader ancestor of it), or `null` when no configured root contains the dir
 * (a path the heartbeat scan should never surface, but defended so a stray dir
 * can't mis-attribute a re-arm onto an unrelated subscription).
 *
 * PURE — string-prefix arithmetic over the path, no I/O. Exported for unit reach.
 */
export function attributePlanDirToRoot(
  planDir: string,
  roots: readonly string[],
): string | null {
  let best: string | null = null;
  for (const root of roots) {
    const prefix = root.endsWith(sep) ? root : root + sep;
    if (planDir === root || planDir.startsWith(prefix)) {
      if (best === null || root.length > best.length) best = root;
    }
  }
  return best;
}

/**
 * Mute-watcher re-arm decision. Given the configured roots a heartbeat rescue
 * implicated (their `.keeper` scan emitted a snapshot the FSEvents fast path
 * missed) and a per-cycle cap, decide which roots to tear down + re-subscribe
 * THIS drain. Bounded by `cap` (the precedent {@link MAX_SUBSCRIBES_PER_CYCLE});
 * an overflow stays flagged for the next drain. Re-arming the FULL root set on
 * any rescue is the stream-flap vector and is rejected — only the implicated
 * roots are returned.
 *
 * PURE — set/order arithmetic, no I/O and no mutation of its inputs (the caller
 * owns the one-shot flag clear + the `unsubscribe()`/`subscribe()` I/O). Returns
 * a stable insertion-ordered slice so the drain is deterministic. Exported for
 * unit reach (the {@link reflogWatchDiff} / {@link decideReconcileTransitions}
 * model).
 */
export function decidePlanResubscribe(
  pendingResubscribe: ReadonlySet<string>,
  cap: number,
): string[] {
  return [...pendingResubscribe].slice(0, Math.max(0, cap));
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

  const { db } = openDb(data.dbPath, {
    readonly: true,
    prepareStmts: false,
    bootRetry: true,
  });
  const port = parentPort;

  // Shared shutdown flag — read by every timer/callback so a queued tick can't
  // touch a closing connection or post against a torn-down port. Declared up
  // front so the scanner's `onPendingChange` reflog reconcile (below)
  // can close over it.
  let shuttingDown = false;

  // ── `.git/logs/HEAD` reflog watches ────────────────────────────────
  // The last non-realtime tail: a brand-new epic scaffolded+committed in a repo
  // keeper has never seen a session in. The plan-worker watches CONFIGURED
  // roots, so the new epic file appears via FSEvents (bounces to `pending`, not
  // in HEAD). But the git-worker discovers repos from `jobs.cwd` seen-cwds, so
  // it isn't watching that repo's `.git`; the commit produces NO DB write (the
  // poll never wakes) and leaves the file bytes unchanged (no second FSEvent).
  // The in-HEAD transition has no realtime trigger. Fix: watch
  // `.git/logs/HEAD` (a commit ALWAYS appends there) and, on the append, run the
  // GATED `recheckPending()` scoped to that repo (now in HEAD → emit) PLUS a
  // change-gated `scanPlanDir` re-scan (recover a committed `.keeper` change
  // that was never gated into pending).
  //
  // Widening. The pending-only watch set left the epic's confirmed slow
  // path open: a commit in a repo that holds a `.keeper` tree but NO currently-
  // pending path (a steady-state plan change — e.g. a `done`/`reset` that
  // edits then commits, or any `.keeper` mutation whose file-write FSEvent the
  // kernel coalesced so it never bounced into `pending`). With no pending path
  // no reflog watch was armed, the broad recursive watch IGNORES `.git`
  // (IGNORE_GLOBS), and a foreign commit writes no keeper DB row — so the
  // in-HEAD change was invisible until the git-worker's 60s heartbeat (task .1's
  // measured diagnosis: that is the dominant production fold-latency tail). Fix:
  // arm a `.git/logs/HEAD` reflog watch for EVERY repo that holds a `.keeper`
  // tree under the configured roots — `pendingRepos()` ∪ the discovered plan-
  // repo set — not just the pending ones. Bounded + safe: the watch count is the
  // number of plan-tracked repos under the roots (a handful), the broad watch
  // already ignores `.git` so these per-repo `.git/logs` watches do NOT overlap
  // it (no fseventsd bad-state from overlapping subtree watches), and the
  // callback stays repo-SCOPED (`recheckPending(root)` + one `scanPlanDir` —
  // no global-recheck storm). The poll stays trigger-only: the
  // re-scan is change-gated, re-probes the in-HEAD gate, and writes no DB row.
  //
  // Lifecycle is bounded: a watch is ADDED when a repo gains a pending path OR
  // is discovered to hold a `.keeper` tree, and DROPPED when it neither holds a
  // pending path NOR a `.keeper` tree any longer (`reconcileReflogWatches`
  // diffs `pendingRepos()` ∪ `discoverPlanRepos()` against
  // `reflogSubs.keys()`). Per FSEvents
  // discipline the append is a HINT, not data — `recheckPending` re-probes
  // `isPathInHead`, so a spurious fire is an idempotent no-op and a missed fire
  // is covered by the lowered heartbeat floor.
  let reflogWatcherModule: typeof import("@parcel/watcher") | null = null;
  // root → its `.git/logs/HEAD` (or `.git/HEAD` fallback) subscription.
  const reflogSubs = new Map<string, AsyncSubscription>();
  // Roots whose reflog subscribe is mid-flight, so a re-entrant reconcile
  // (another pending mutation lands while a subscribe `await`s) doesn't
  // double-subscribe the same root.
  const reflogSubscribing = new Set<string>();

  // The module-scope `resolveReflogTarget` (the `.git/logs/HEAD` -> `.git/HEAD`
  // -> null `existsSync` ladder) and `discoverPlanRepos(roots)` (the
  // `discoverPlanDirs` + `dirname` FS wrapper) are pure helpers this closure
  // composes.

  // Bring the live reflog-watch set into agreement with the repos that should
  // hold a `.git/logs/HEAD` reflog watch: every repo that currently owns a
  // pending path UNION every repo that holds a `.keeper` tree under the
  // configured roots (widening — the latter closes the no-pending-repo
  // commit tail). Idempotent + cheap (a no-op when the union hasn't changed).
  // Fired by the scanner's `onPendingChange` on every pending mutation, by the
  // heartbeat (so a brand-new `.keeper` repo arms its watch within one interval
  // even with no pending path), AND once after the watcher module loads (to
  // catch any pending/discovered repos accrued before the module was ready).
  const reconcileReflogWatches = (): void => {
    if (shuttingDown || reflogWatcherModule === null) return;
    const watcher = reflogWatcherModule;
    // PURE desired-set derivation: the union of currently-pending
    // repos and every discovered `.keeper` repo under the configured roots.
    const desired = desiredReflogRepos(
      scanner.pendingRepos(),
      discoverPlanRepos(data.roots),
    );
    // PURE add/drop diff against the live subscription set. The live set is the
    // KEYS of `reflogSubs` only — a mid-subscribe root (`reflogSubscribing`)
    // isn't live yet, so it must not count toward `toDrop` (the `subscribing`
    // skip below + the in-flight `stillDesired` teardown handle that case).
    const { toDrop } = reflogWatchDiff(desired, new Set(reflogSubs.keys()));
    // Drop watches for repos that are no longer in the desired union (neither
    // pending nor holding a `.keeper` tree any longer) — the I/O the pure diff
    // can't do: actually `unsubscribe()` and mutate the worker's live set.
    for (const root of toDrop) {
      const sub = reflogSubs.get(root);
      if (sub === undefined) continue;
      reflogSubs.delete(root);
      void sub.unsubscribe().catch(() => {
        // best-effort; the repo is no longer desired either way.
      });
    }
    // Add watches for newly-desired repos (skip ones already subscribed or
    // mid-subscribe).
    for (const root of desired) {
      if (reflogSubs.has(root) || reflogSubscribing.has(root)) continue;
      const target = resolveReflogTarget(root);
      if (target === null) {
        // No reflog/HEAD file (e.g. `core.logAllRefUpdates=false` + no HEAD):
        // degrade to the heartbeat floor; nothing to subscribe.
        continue;
      }
      reflogSubscribing.add(root);
      // `@parcel/watcher` subscribes a DIRECTORY recursively; point it at the
      // dir holding the target file and filter the callback to that file. The
      // dir is tiny (`.git/logs` or `.git`), so the recursive watch is cheap.
      const watchDir = dirname(target);
      watcher
        .subscribe(watchDir, (err) => {
          // The event is a HINT — re-probe via the GATED `recheckPending`
          // (re-checks `isPathInHead`), NEVER a `triggeredByCommit` bypass
          // (preserves the in-HEAD gate / the dup-dispatch guard). Idempotent
          // under repeat fires. A watcher `err` (incl. a drop) is also treated
          // as "go look" — the same defensive re-check.
          if (shuttingDown) return;
          if (err) {
            console.error(
              `[plan-worker] reflog watcher error for ${root}: ${stringifyErr(err)}`,
            );
          }
          try {
            // the reflog fire is repo-specific (this `root`'s
            // `.git/logs/HEAD` moved), so scope the drain to it — ONE batched
            // probe over only this repo's pending paths.
            scanner.recheckPending(root);
          } catch (e) {
            console.error(
              `[plan-worker] reflog recheckPending failed for ${root}: ${stringifyErr(e)}`,
            );
          }
          // `recheckPending(root)` only drains paths ALREADY in the
          // pending gate. The widened-watch slow path is a commit in a repo with
          // NO pending path — the data-dir change was never gated in (its
          // file-write FSEvent was a no-op or coalesced), so a pending drain is
          // a no-op. Re-scan this repo's present data dirs directly via the same
          // change-gated `scanPlanDir` the heartbeat/db-poll reconcile uses:
          // it re-reads the now-COMMITTED bytes, re-probes the in-HEAD gate per
          // file, and emits only changed-and-in-HEAD files (the change-gate
          // suppresses unchanged ones, so a spurious fire is an idempotent
          // no-op). Repo-SCOPED to this `root`'s `.keeper/` data dir only — no
          // global re-discovery, no per-path git storm. The re-scan never
          // writes the DB (poll-is-trigger-only). Tagged `fswatcher-drop` (this
          // IS a watcher edge a fast path would otherwise need the heartbeat to
          // recover).
          try {
            scanRepoDataDirs(root, scanner, "fswatcher-drop");
          } catch (e) {
            console.error(
              `[plan-worker] reflog scanPlanDir failed for ${root}: ${stringifyErr(e)}`,
            );
          }
        })
        .then((sub) => {
          reflogSubscribing.delete(root);
          // Lost-the-race teardown: shutdown, or the repo left the desired union
          // (its pending set drained AND it no longer holds a `.keeper` tree)
          // while we were subscribing — release immediately. check the
          // FULL desired union (pending ∪ discovered plan repos), not just
          // `pendingRepos()`, or a freshly-discovered no-pending repo's watch
          // would be torn down the instant it resolved.
          const stillDesired =
            scanner.pendingRepos().has(root) ||
            discoverPlanRepos(data.roots).has(root);
          if (shuttingDown || !stillDesired) {
            void sub.unsubscribe().catch(() => {});
            return;
          }
          reflogSubs.set(root, sub);
        })
        .catch((err) => {
          reflogSubscribing.delete(root);
          console.error(
            `[plan-worker] failed to subscribe reflog for ${root}: ${stringifyErr(err)}`,
          );
        });
    }
  };

  // per-wake-path attribution. Classify, at backstop-fire time, whether
  // the currently-pending repos had a reflog watch armed. Returns `absent` when
  // AT LEAST ONE pending repo has NO live reflog subscription (the prime-suspect
  // slow path: a commit in a no-pending-repo never armed a watch, so the
  // in-HEAD transition had no FSEvents trigger and fell to this heartbeat),
  // `present` when every pending repo had a watch (so a present-but-missed
  // FSEvents signal, not a coverage gap), and `undefined` when nothing is
  // pending (no per-repo notion to attribute). Pure read of the live watch set;
  // producer-side only, never consulted in a fold. Post-widening: every
  // discovered plan repo arms a watch, so `absent` should now be RARE — a
  // sustained run of `present` (or no rescue at all) is the evidence the
  // coverage gap closed.
  const reflogWatchAttribution = (): "present" | "absent" | undefined => {
    const pending = scanner.pendingRepos();
    if (pending.size === 0) return undefined;
    for (const root of pending) {
      if (!reflogSubs.has(root)) return "absent";
    }
    return "present";
  };

  // ── discovery nudge ─────────────────────────────────────────────────
  // The git-worker discovers repos to watch from `jobs.cwd` seen-cwds, so a
  // repo keeper has never seen a session in is unwatched — no GitSnapshot /
  // attribution data flows. When the plan-worker first sees a `.keeper` tree
  // in a repo, hand the repo root to git-worker discovery immediately so its
  // `.keeper` short-circuit in `shouldWatchRoot` subscribes it on the next
  // reconcile, rather than waiting for the next full discovery sweep. De-duped
  // per root (one nudge per repo for the worker's lifetime); main null-guards
  // the git-worker forward-ref during the boot window (a dropped nudge is
  // recovered by the next full sweep + heartbeat floor).
  const nudgedRoots = new Set<string>();
  const maybeNudgeDiscovery = (repoRoot: string | null): void => {
    if (repoRoot === null || nudgedRoots.has(repoRoot) || shuttingDown) return;
    nudgedRoots.add(repoRoot);
    port.postMessage({
      kind: "nudge-discovery",
      root: repoRoot,
    } satisfies PlanDiscoveryNudgeMessage);
  };
  // The plan-dir callback `reconcilePlanDirs` invokes per discovered
  // `.keeper` dir — derive the repo root and nudge if new.
  const nudgeFromPlanDir = (planDir: string): void => {
    // `planDir` is `<root>/.keeper`; its parent is the repo root. Reuse the
    // pure ancestor walk by appending a synthetic child so it sees `.keeper`.
    maybeNudgeDiscovery(dirname(planDir));
  };

  // Observation gate: the live worker passes `isPathInHead` so an
  // uncommitted epic/task file lands in the scanner's pending set instead
  // of emitting a snapshot. Main drives the drain by posting
  // {@link RecheckPendingMessage} on every git-worker `GitSnapshot` pulse
  // (the cross-worker "HEAD may have moved" signal). The fourth ctor arg is the
  // The `onPendingChange` observer — it reconciles the reflog watches AND
  // nudges git-worker discovery for any repo that just gained a pending path
  // (a brand-new uncommitted epic is the load-bearing case for both).
  const scanner = new PlanScanner(
    (msg) => {
      port.postMessage(msg);
    },
    (m) => console.error(m),
    isPathInHead,
    // the batched per-repo probe `recheckPending` uses to drain the
    // gate without a per-path git spawn (kills the ~74s storm). The per-path
    // `isPathInHead` above still governs the FSEvents `onChange` path.
    isPathInHeadBatch,
    () => {
      // No-self-heal: a throw here would crash the worker and bounce the
      // daemon, so log+continue. Nudge BEFORE the reflog reconcile so a
      // brand-new repo gets its git-worker discovery hint even if the reflog
      // subscribe later fails.
      try {
        for (const root of scanner.pendingRepos()) {
          maybeNudgeDiscovery(root);
        }
        reconcileReflogWatches();
      } catch (err) {
        console.error(
          `[plan-worker] onPendingChange reconcile failed: ${stringifyErr(err)}`,
        );
      }
    },
    // post built backstop records/rollups UP to main (the SOLE sidecar
    // writer). Default clock (Date.now) is fine for the live worker.
    (m) => port.postMessage(m),
  );

  // Restart-seed: don't re-emit a snapshot already folded into the projection.
  try {
    seedFromDb(db, scanner);
  } catch (err) {
    // Non-fatal: worst case a stale snapshot re-emits once (the reducer's
    // idempotent upsert makes that a no-op anyway).
    console.error(`[plan-worker] restart-seed failed: ${stringifyErr(err)}`);
  }

  // Configured-root → its broad recursive FSEvents subscription. Keyed (vs a
  // flat array) so the mute-watcher re-arm can map a rescued root to the exact
  // subscription to tear down + replace. A root whose subscribe failed/raced
  // shutdown simply never enters the map (it is then unwatched until the next
  // heartbeat re-flags it).
  const subscriptions = new Map<string, AsyncSubscription>();
  // configured-root → its drop-recovery scheduler (each subscribe callback
  // closes over its own `root`). Keyed so the re-arm reuses the existing
  // scheduler for a root instead of leaking a second one. Cleared in shutdown
  // BEFORE unsubscribe so a queued re-scan can't touch a closing DB.
  const schedulers = new Map<string, RescanScheduler>();
  // fn-788 mute-watcher re-arm. Configured roots whose broad FSEvents
  // subscription went mute and was rescued by the heartbeat backstop (the scan
  // emitted a snapshot the FSEvents fast path missed). Flagged here, drained by
  // `drainResubscribe` on the next single-flight cycle: `await unsubscribe()`
  // THEN a fresh `subscribe()` with the IDENTICAL options. The re-arm replaces
  // ONLY the watcher stream — the PlanScanner change-gate / lastEmitted survives,
  // so the post-re-arm scan re-emits nothing that didn't actually change (no
  // phantom re-folds). One-shot per flag: a root that re-goes-mute is re-flagged
  // by a later heartbeat. No worker respawn, no DB write, no synthetic event.
  const pendingResubscribe = new Set<string>();
  // configured-root → monotonic subscribe generation. Bumped on every
  // (re)subscribe; the watcher callback captures its generation and no-ops if it
  // no longer matches — the in-flight-callback guard against a torn-down stream's
  // late batch touching state a re-arm already replaced.
  const subGeneration = new Map<string, number>();
  // Roots re-armed this cycle still inside their one-heartbeat flap-guard window
  // → wall-clock (`Date.now()`) ms at which each was re-subscribed. A still-mute
  // replacement that re-flags within the window is suppressed (don't churn the
  // stream); the flag is honored again once the new subscription has survived one
  // full heartbeat interval. Cleared as the window lapses.
  const reArmedAtMs = new Map<string, number>();
  // The `@parcel/watcher` module for the BROAD main-tree subscriptions, published
  // once the addon resolves. Distinct ref from `reflogWatcherModule` (same
  // module, but this one gates the main-tree re-arm trigger specifically). Null
  // until the addon loads — the heartbeat re-arm null-guards on it.
  let mainTreeWatcherModule: typeof import("@parcel/watcher") | null = null;
  // periodic reconcile backstop: a low-frequency heartbeat re-runs
  // `reconcilePlanDirs` across every configured root, so a brand-new
  // repo's first scaffold converges within one interval even if FSEvents
  // dropped its burst AND git-worker isn't yet watching it (it only
  // starts watching a repo's `.git` once an epic row for it exists).
  // Cancelled in shutdown alongside the drop-recovery schedulers.
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  // Fast `data_version` poll timer — armed AFTER seedFromDb (below) so
  // the seeded change-gate suppresses a first-bump re-emit storm; cleared in
  // shutdown alongside the heartbeat. Declared here so the shutdown handler
  // (registered before the timer is armed) can close over it.
  let dbPollTimer: ReturnType<typeof setInterval> | null = null;
  // periodic backstop-rollup flush timer — emits the denominator
  // (fires_total / rescues_total per backstop) on a slow cadence so the metric
  // survives a crash/restart without a line per no-op fire. Cleared in shutdown
  // alongside the heartbeat, with one final flush.
  let rollupTimer: ReturnType<typeof setInterval> | null = null;
  // `shuttingDown` is declared at the top of `main` so the reflog
  // reconcile + nudge callbacks can close over it.

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
      // main observed a `GitSnapshot`/`Commit` events row land — HEAD
      // may have advanced. Drain the observation gate's pending set so a
      // freshly-committed epic/task file emits its snapshot. Idempotent and
      // cheap when the set is empty.
      //
      // SCOPE to `msg.repo` — main stamps it with the originating
      // snapshot's `project_dir`, the single repo whose HEAD moved — so we
      // re-probe only that repo's pending paths (ONE batched git call) instead
      // of every repo's. A cross-repo pending set no longer starves the loop.
      if (shuttingDown) return;
      try {
        scanner.recheckPending(msg.repo);
      } catch (err) {
        console.error(
          `[plan-worker] recheckPending failed: ${stringifyErr(err)}`,
        );
      }
      return;
    }
    if (msg.type === "kick") {
      // a `set_*_approval` RPC write succeeded in the
      // server-worker; main kicked us. The approval mutation left the plan
      // file dirty/uncommitted, so re-run the GATED observation-gate drain so
      // an approval that never commits still converges promptly instead of
      // waiting on the 60s heartbeat. SAME gated `recheckPending()` the
      // `recheck-pending` branch runs — NOT a bypass: an uncommitted approval
      // re-runs the in-HEAD probe and stays in pending (the dup-dispatch guard
      // duplicate-dispatch guard). Idempotent and cheap when pending is empty.
      // Try/catch-wrapped — a throw here is in the no-self-heal path; log and
      // continue so a recheck failure can't crash the worker (and bounce the
      // daemon).
      if (shuttingDown) return;
      try {
        scanner.recheckPending();
      } catch (err) {
        console.error(
          `[plan-worker] kick recheckPending failed: ${stringifyErr(err)}`,
        );
      }
      return;
    }
    if (msg.type === "plan-commit-changed") {
      // authoritative ingest trigger. The
      // git-worker just observed a commit landing in `msg.repo` carrying
      // changed `.keeper/**` paths; re-ingest each from the COMMITTED worktree
      // bytes via the existing idempotent `onChange` / `onDelete` paths.
      // Drop-proof
      // (independent of the broad `~/code` FSEvents subscription) and
      // free of the mid-write partial-read race (plan commits
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
            // commit-driven ingest — the git-worker enumerated this
            // path from a landed commit, so it is provably in HEAD. Pass
            // `triggeredByCommit=true` to BYPASS the redundant fail-closed
            // `isTracked` probe whose 1s timeout silently bounced just-
            // committed files into pending (the ~60s board-removal lag).
            scanner.onChange(abs, true);
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
      for (const sched of schedulers.values()) {
        sched.cancel();
      }
      schedulers.clear();
      // cancel the periodic-reconcile heartbeat alongside the
      // drop-recovery schedulers so it can't tick against a closing DB
      // (mirrors the schedulers' BEFORE-unsubscribe ordering — the scan
      // re-checks `shuttingDown` belt-and-suspenders, but the clear is
      // what prevents a leaked timer under `bun test --isolate`).
      if (heartbeatTimer != null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      // cancel the fast `data_version` poll BEFORE unsubscribe + db
      // close so a queued tick can't read `data_version` / drive a reconcile
      // against a closing connection (a leaked interval strands
      // `bun test --isolate`). Same ordering as the heartbeat + schedulers.
      if (dbPollTimer != null) {
        clearInterval(dbPollTimer);
        dbPollTimer = null;
      }
      // cancel the periodic rollup flush, then flush ONE final rollup so
      // the denominator (fires_total / rescues_total per backstop) survives a
      // clean stop. postMessage is synchronous; main is still reading at this
      // point (it sends `shutdown` and awaits `close`).
      if (rollupTimer != null) {
        clearInterval(rollupTimer);
        rollupTimer = null;
      }
      scanner.flushBackstopRollups();
      // Release every subscription (external resources), then the db, then exit
      // clean. Mirrors transcript-worker's teardown but over the keyed map.
      void (async () => {
        for (const [root, sub] of [...subscriptions]) {
          subscriptions.delete(root);
          try {
            await sub.unsubscribe();
          } catch {
            // best-effort
          }
        }
        // release every `.git/logs/HEAD` reflog watch too (each is an
        // owned external resource — `terminate()` alone leaks it). Drain the
        // map so a racing reconcile can't re-add into a closing worker.
        for (const [root, sub] of [...reflogSubs]) {
          reflogSubs.delete(root);
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

  // periodic reconcile backstop. Independent of the @parcel/watcher
  // subscription (so it still ticks if the addon load is delayed) and of
  // git-worker's commit signal (so it covers the brand-new-repo case where
  // no `.git` is yet watched). The scan re-checks `shuttingDown` belt-and-
  // suspenders; the timer itself is cleared in the shutdown handler above.
  // Reuses the change-gated {@link reconcilePlanDirs} primitive — a
  // quiescent repo emits nothing across heartbeats.
  heartbeatTimer = setInterval(() => {
    if (shuttingDown) return;
    try {
      // tag as "heartbeat" so an emission here (a snapshot the
      // commit/FSEvents fast path missed) logs a "did real work" line —
      // the signature of the fast path being broken.
      // this IS the slow backstop — fold the aggregate emitted-boolean
      // into one uniform `missed-wake` record (rescued = did the change-gated
      // scan deliver work the fast paths missed). The shutdown guard above
      // gates both the scan AND the telemetry emit.
      //
      // fn-788 per-root attribution: collect WHICH configured roots emitted so
      // the mute-watcher re-arm flags exactly those (re-arming all roots on any
      // rescue is the stream-flap vector — rejected). The aggregate `rescued`
      // boolean keeps its semantics for `fireBackstop` (byte-compatible).
      const emittedRoots = new Set<string>();
      const rescued = reconcilePlanDirs(
        data.roots,
        scanner,
        "heartbeat",
        nudgeFromPlanDir,
        emittedRoots,
      );
      // per-wake-path attribution: classify whether the rescued repos
      // had a reflog watch armed. `absent` is the prime-suspect slow path — a
      // commit in a no-pending repo (so no reflog watch, no DB write) is
      // invisible to every fast path until this heartbeat. `present` means a
      // reflog watch existed but its FSEvents signal was nonetheless missed
      // (an FSEvents-reliability miss, not a coverage gap). Omit when nothing
      // is pending (no per-repo notion).
      scanner.fireBackstop(
        "plan-heartbeat",
        "data_version_poll",
        rescued,
        reflogWatchAttribution(),
      );
      // fn-788 mute-watcher re-arm. A heartbeat rescue means a configured root's
      // broad FSEvents stream missed a change — flag exactly the implicated
      // root(s) and kick the drain (the re-arm is OWNED by the single-flight
      // wake, never fired directly here — sequential teardown can't run inside a
      // sync timer tick). The flap guard suppresses a re-flag inside the
      // one-heartbeat window after a re-arm so a still-mute replacement doesn't
      // churn the stream forever; the window is honored once it lapses (the new
      // subscription survived a full interval, so a fresh rescue is a real
      // re-mute). A healthy root never emits, so it is never flagged.
      const nowMs = Date.now();
      let flaggedAny = false;
      for (const root of emittedRoots) {
        const armedAt = reArmedAtMs.get(root);
        if (armedAt !== undefined) {
          if (nowMs - armedAt < RECONCILE_HEARTBEAT_MS) {
            // Still inside the flap-guard window — suppress (don't re-churn).
            continue;
          }
          // Window lapsed: the replacement survived a full interval, so this is
          // a genuine re-mute. Clear the stamp and re-flag.
          reArmedAtMs.delete(root);
        }
        pendingResubscribe.add(root);
        flaggedAny = true;
      }
      // Drive the drain through the db-poll single-flight so a wake and the
      // re-arm drain never race on the subscription map. `onWake` runs the
      // resubscribe drain after its scan; nothing fires if the addon hasn't
      // loaded yet (the drain null-guards `mainTreeWatcherModule`).
      if (flaggedAny) onWake();
      // re-reconcile the reflog watches against the live union (pending
      // ∪ discovered plan repos). `onPendingChange` only fires on a pending
      // mutation, so a brand-new `.keeper` repo that never accrues a pending
      // path (a foreign commit lands its files already-in-HEAD before any
      // FSEvent gated them) would otherwise never arm its watch. This periodic
      // re-reconcile picks it up within one heartbeat — cheap (a shallow
      // readdir+stat per root; a no-op when the union hasn't changed).
      reconcileReflogWatches();
    } catch (err) {
      console.error(
        `[plan-worker] periodic reconcile failed: ${stringifyErr(err)}`,
      );
    }
  }, RECONCILE_HEARTBEAT_MS);

  // periodic backstop-rollup flush — checkpoint the denominator so it
  // survives a crash without a line per no-op fire. The shutdown handler clears
  // this and flushes one final rollup.
  rollupTimer = setInterval(() => {
    if (shuttingDown) return;
    try {
      scanner.flushBackstopRollups();
    } catch (err) {
      console.error(
        `[plan-worker] backstop rollup flush failed: ${stringifyErr(err)}`,
      );
    }
  }, BACKSTOP_ROLLUP_FLUSH_MS);

  // Fast `data_version` poll — the realtime trigger that collapses
  // close→emit to ~50ms. A bump means SOMETHING committed to keeper's DB; the
  // close→approve `Commit` fold that makes a plan file "ready" IS such a
  // write, so polling the DB surfaces it without waiting on the 60s heartbeat.
  //
  // The poll is a TRIGGER, not a data source: on a bump it runs a change-gated
  // `reconcilePlanDirs(..., "db-poll")` re-scan (so a `.keeper` change
  // whose FSEvent was dropped — and was therefore NEVER gated into pending —
  // is still recovered). The poll NEVER writes the DB.
  //
  // Invariant: the db-poll does NOT call `recheckPending`. A global recheck
  // spawns one synchronous `git cat-file` per pending path across all repos on
  // every DB bump — that per-path storm starves the loop and queues the
  // realtime bypass for tens of seconds. The pending drain is instead covered
  // by the repo-SCOPED triggers (the `recheck-pending` post on every
  // `GitSnapshot`/`Commit`, the per-repo reflog watch) plus the 5s heartbeat
  // floor, all batched-per-repo. The `reconcilePlanDirs` re-scan STAYS — it
  // is the FSEvents-drop recovery a recheck-only path cannot replace (a dropped
  // FSEvent never gated the path into pending in the first place).
  //
  // Single-flight coalescing (cloned from `src/autopilot-worker.ts`): a bump
  // arriving while the wake body runs coalesces into exactly ONE trailing
  // re-run, never a queue. The reconcile is change-gated so a quiescent board
  // emits nothing across bumps. The body is try/catch-wrapped (log+continue,
  // no self-heal) — a throw must not wedge the poll loop nor leak the in-flight
  // guard.
  const onWake = makeSingleFlight(
    () => {
      // the `data_version` poll IS a fast path — stamp `last_fast_path_at`
      // so a later heartbeat can compute staleness against it. NOT a missed-wake
      // record (a db-poll emit is a normal fast-path success, never a rescue).
      // label `db-poll` for per-wake-path attribution.
      scanner.markFastPath("db-poll");
      reconcilePlanDirs(data.roots, scanner, "db-poll", nudgeFromPlanDir);
      // fn-788: after the scan, drive the mute-watcher re-arm drain. The scan
      // above only READS the on-disk `.keeper` census — the drain is the sole
      // mutator of the `subscriptions` map on the wake path, so running it here
      // (inside the single-flight body, after the scan) is what makes a db-poll
      // wake and the re-arm drain never race on that map. The drain is async
      // (sequential unsubscribe→subscribe) and self-guards re-entrancy, so it is
      // kicked fire-and-forget; a no-op when nothing is flagged or the addon
      // hasn't loaded.
      void kickResubscribeDrain();
    },
    () => shuttingDown,
    (err) =>
      console.error(`[plan-worker] db-poll wake failed: ${stringifyErr(err)}`),
  );

  // fn-1096.3: a transient SQLITE_NOTADB on this poll's PRAGMA data_version
  // read is a boot-checkpoint view race (concurrent WAL checkpoint mid-read),
  // not corruption — tolerate via the shared helper (skip the tick, bounded
  // consecutive-miss rethrow) rather than letting it crash the worker. ONE
  // instance for this poll site so the consecutive-miss count is meaningful
  // across ticks (including the baseline seed read below).
  const dbPollNotadbTolerance = new NotadbTolerance();
  const emitDbPollNotadbSkip = (consecutiveMisses: number): void => {
    console.error(
      `[plan-worker] transient SQLITE_NOTADB on data_version poll — skipped tick (consecutive=${consecutiveMisses})`,
    );
    port.postMessage({
      kind: "backstop",
      record: buildTimeoutRecord({
        backstop: "notadb-skip",
        worker: "plan-worker",
        rescued: true,
        now: Date.now(),
        stalenessMs: null,
        detail: { consecutive_misses: String(consecutiveMisses) },
      }),
    } satisfies BackstopMessage);
  };

  // Init the baseline ONCE at startup from a naked autocommit `PRAGMA
  // data_version` read on the worker's existing read-only connection — NEVER
  // reset to 0 on recheck/restart (a reconnect would reset the baseline and
  // false-suppress). The read MUST stay in autocommit (no open BEGIN, or the
  // counter freezes for this connection). Armed AFTER seedFromDb so the seeded
  // change-gate absorbs the first bump's re-scan without a re-emit storm. A
  // tolerated NOTADB on this VERY FIRST read (the boot-checkpoint race is
  // most likely right here) seeds a 0 baseline — harmless: the next
  // successful poll's real version differs from 0 and fires one extra
  // (idempotent) reconcile, never a false suppression.
  const dataVersionQuery = db.query("PRAGMA data_version");
  const dbPollSeed = dbPollNotadbTolerance.poll(
    () => (dataVersionQuery.get() as { data_version: number }).data_version,
  );
  if (dbPollSeed.skipped) emitDbPollNotadbSkip(dbPollSeed.consecutiveMisses);
  let lastDataVersion = dbPollSeed.skipped ? 0 : dbPollSeed.value;
  const pollMs = Math.max(25, data.pollMs ?? PLAN_DB_POLL_MS);
  dbPollTimer = setInterval(() => {
    if (shuttingDown) return;
    // Read OUTSIDE any open BEGIN (autocommit) so the counter is live; only a
    // change is meaningful. Store the new version BEFORE onWake so a bump that
    // lands during the wake is observed on the next tick (its own re-run, or
    // the wakePending coalesce if it raced the running cycle).
    const outcome = dbPollNotadbTolerance.poll(
      () => (dataVersionQuery.get() as { data_version: number }).data_version,
    );
    if (outcome.skipped) {
      emitDbPollNotadbSkip(outcome.consecutiveMisses);
      return;
    }
    const cur = outcome.value;
    if (cur === lastDataVersion) return;
    lastDataVersion = cur;
    onWake();
  }, pollMs);

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

  // watcher seam: skip the native addon dlopen in the in-process tier and
  // run a polling degrade instead. The boot scan per root still seeds the
  // projection and advances the ghost-sweep barrier; the `data_version` poll +
  // periodic heartbeat (armed above) carry the live `.keeper` fold pipeline at
  // poll/heartbeat cadence. `reflogWatcherModule` stays null (the reflog fast
  // path is absent, covered by the heartbeat).
  if (data.disableNativeWatcher) {
    for (const root of data.roots) {
      if (!existsSync(root)) {
        console.error(
          `[plan-worker] root ${root} does not exist; not watching`,
        );
        // Still counts toward the sweep barrier — otherwise a missing root
        // would stall the boot ghost-sweep forever.
        noteBootScanDone();
        continue;
      }
      // Boot scan: pick up files that pre-existed this daemon's start without
      // waiting for a watcher event. The change-gate suppresses unchanged files.
      // A scan throw must not crash the worker (no self-heal) — log + advance the
      // barrier so a bad root can't stall the sweep for the others.
      try {
        scanRoot(root, scanner);
      } catch (err) {
        console.error(
          `[plan-worker] boot scan failed for ${root}: ${stringifyErr(err)}`,
        );
      }
      noteBootScanDone();
    }
    return;
  }

  // The broad recursive FSEvents subscription for ONE configured root. Shared
  // by the boot loop and the mute-watcher re-arm drain so BOTH paths use the
  // IDENTICAL subscribe options (`{ ignore: IGNORE_GLOBS }`, positive globs
  // only) and the IDENTICAL callback — the re-arm must not drift from boot or it
  // would silently change the watched surface. Resolves to the live
  // `AsyncSubscription` (registered in `subscriptions` by the caller) or null on
  // a lost-race / subscribe failure. Reuses the root's existing drop-recovery
  // scheduler when present (a re-arm keeps the same scheduler) and creates one
  // on first subscribe (boot).
  const subscribeRoot = async (
    watcher: typeof import("@parcel/watcher"),
    root: string,
  ): Promise<AsyncSubscription | null> => {
    // Per-root drop-recovery scheduler: a recoverable FSEvents drop schedules
    // a debounced, single-flight re-scan of THIS root's `.keeper` dirs via
    // the change-gated {@link reconcilePlanDirs} primitive — never an
    // unsubscribe+re-subscribe (the live subscription stays alive; the
    // drop-rescan recovers a lost batch without opening a no-watch gap — that
    // is DISTINCT from the mute-watcher re-arm below, which replaces a
    // subscription that stopped delivering entirely). The warm in-memory
    // change-gate (PlanScanner.lastEmitted) suppresses re-emits for unchanged
    // files, so recovery is idempotent. The scan re-checks shuttingDown so a
    // queued scan can't touch a closing DB.
    //
    // scoped to `.keeper` dirs (O(#projects)), NOT the full
    // recursive walk over the whole `~/code` tree the boot scan does.
    // The commit path (`plan-commit-changed`) + the boot sweep
    // continue to handle deletions, so an additive shallow rescan is
    // sufficient for the live drop-recovery window and dramatically
    // cheaper than re-walking the entire root.
    let rescan = schedulers.get(root);
    if (rescan === undefined) {
      rescan = new RescanScheduler(() => {
        if (shuttingDown) {
          return;
        }
        // tag as "fswatcher-drop" so a snapshot recovered here
        // (one the dropped FSEvents change would otherwise have lost) logs
        // a "did real work" line.
        // this is the FSEvents-drop backstop — fold the emitted-
        // boolean into one `rescan-drop` missed-wake record. The shutdown
        // guard above gates both the scan and the telemetry emit.
        const rescued = reconcilePlanDirs(
          [root],
          scanner,
          "fswatcher-drop",
          nudgeFromPlanDir,
        );
        // this drop-rescan is scoped to ONE `root`, so attribute the
        // reflog watch for that root specifically — `present`/`absent` only
        // when the root is actually pending (otherwise no per-repo notion).
        const reflogWatch = scanner.pendingRepos().has(root)
          ? reflogSubs.has(root)
            ? "present"
            : "absent"
          : undefined;
        scanner.fireBackstop("rescan-drop", "fsevents", rescued, reflogWatch);
      });
      schedulers.set(root, rescan);
    }
    // Active-generation guard: a batch can fire AFTER `unsubscribe()` resolves
    // (the parcel/watcher #190 stale-callback window). Bumping the generation on
    // every (re)subscribe and capturing it in the callback closure lets a
    // torn-down stream's late batch detect it is stale and no-op, so it can't
    // touch state a re-arm already replaced.
    const generation = (subGeneration.get(root) ?? 0) + 1;
    subGeneration.set(root, generation);
    try {
      const sub = await watcher.subscribe(
        root,
        (err, events) => {
          // Stale-callback guard: a batch from a torn-down stream (or one that
          // raced a re-arm) carries an older generation — drop it.
          if (subGeneration.get(root) !== generation) return;
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
          // a confirmed FSEvents batch is THE fast path for plan
          // files — stamp `last_fast_path_at` so a later heartbeat measures
          // staleness against it (and a working watcher keeps the heartbeat
          // a perpetual no-op rescue).
          // label `fsevents` for per-wake-path attribution.
          scanner.markFastPath("fsevents");
          for (const ev of events) {
            // The in-callback `.keeper/{epics,tasks}/*.json` filter (via
            // classifyPlanPath, applied inside onChange) is what guarantees
            // only real plan files reach the read path — the positive ignore
            // globs are belt-and-suspenders perf, not the correctness gate.
            // Route on path+existence, NOT event.type (plan writes via
            // atomic os.replace, so an update may surface as create/rename).
            if (ev.type === "delete") {
              scanner.onDelete(ev.path);
              continue;
            }
            scanner.onChange(ev.path);
          }
        },
        { ignore: IGNORE_GLOBS },
      );
      if (shuttingDown) {
        // Shutdown raced the subscribe resolution — release immediately.
        void sub.unsubscribe();
        return null;
      }
      subscriptions.set(root, sub);
      return sub;
    } catch (err) {
      // Per-root isolation: one root's subscribe failure must not kill the
      // others. Log and continue (no process exit). A re-arm subscribe failure
      // is non-fatal too — the root stays unwatched and the next heartbeat
      // rescue re-flags it.
      console.error(
        `[plan-worker] failed to subscribe to ${root}: ${stringifyErr(err)}`,
      );
      return null;
    }
  };

  // fn-788 mute-watcher re-arm drain. Replace each flagged root's broad FSEvents
  // subscription with a fresh one, SEQUENTIALLY (`await unsubscribe()` MUST
  // complete before `subscribe()` on the same tree — overlapping live FSEvents
  // streams on one tree is the machine-wide fseventsd-exhaustion vector,
  // parcel/watcher #190), bounded per cycle. Run UNDER the db-poll single-flight
  // (`onWake` below) so a wake and a drain never race on the subscription map.
  //
  // Producer state survives: only the watcher subscription is replaced — the
  // PlanScanner change-gate / lastEmitted is untouched, so the post-re-arm scan
  // (the existing `reconcilePlanDirs`) re-emits nothing that didn't actually
  // change (no phantom re-folds). The one-shot flag is cleared as it drains; a
  // re-mute re-flags it on a later heartbeat.
  const drainResubscribe = async (
    watcher: typeof import("@parcel/watcher"),
  ): Promise<void> => {
    if (pendingResubscribe.size === 0) return;
    const toRearm = decidePlanResubscribe(
      pendingResubscribe,
      MAX_SUBSCRIBES_PER_CYCLE,
    );
    for (const root of toRearm) {
      pendingResubscribe.delete(root);
      if (shuttingDown) return;
      // stat() the root before re-subscribing: a deleted-and-recreated dir is a
      // new inode FSEvents won't re-attach to, and a missing root must DEFER the
      // re-arm (it never re-subscribes a vanished tree). Leave it unflagged —
      // the next heartbeat rescue re-flags it once it exists again.
      if (!existsSync(root)) {
        console.error(
          `[plan-worker] re-arm deferred: root ${root} does not exist`,
        );
        continue;
      }
      console.error(`[plan-worker] re-arm: replacing mute watcher for ${root}`);
      // SEQUENTIAL teardown: bumping the generation (inside subscribeRoot) first
      // is not enough — the old stream must be FULLY unsubscribed before the new
      // subscribe. tear down THEN re-subscribe with the identical options.
      const old = subscriptions.get(root);
      if (old !== undefined) {
        subscriptions.delete(root);
        try {
          await old.unsubscribe();
        } catch {
          // best-effort — a failed unsubscribe on a mute stream is expected.
        }
      }
      if (shuttingDown) return;
      // Re-subscribe failure is non-fatal (subscribeRoot logs + returns null);
      // the root stays unwatched and the next heartbeat rescue re-flags it.
      const fresh = await subscribeRoot(watcher, root);
      // Flap guard: stamp the re-arm time only on a successful re-subscribe so a
      // still-mute replacement that re-flags within one heartbeat interval is
      // suppressed (don't churn the stream). A failed subscribe leaves no stamp,
      // so the next rescue re-flags immediately.
      if (fresh !== null) reArmedAtMs.set(root, Date.now());
      // Full rescan after the fresh subscribe (APFS coalescing collapses bursts,
      // so back-fill can't be reconstructed) — reuse the existing scoped scan
      // path. The change-gate suppresses unchanged files, so this re-emits only
      // what actually changed.
      try {
        reconcilePlanDirs([root], scanner, "fswatcher-drop", undefined);
      } catch (err) {
        console.error(
          `[plan-worker] re-arm rescan failed for ${root}: ${stringifyErr(err)}`,
        );
      }
    }
    // Reflog re-arm: when a rescued root's reflog watch is present-but-mute, drop
    // its `reflogSubs` entry so the existing `reconcileReflogWatches` re-derives
    // it (reuse that loop — no second reflog re-arm path).
    for (const root of toRearm) {
      if (reflogSubs.has(root) && existsSync(root)) {
        const sub = reflogSubs.get(root);
        reflogSubs.delete(root);
        if (sub !== undefined) {
          try {
            await sub.unsubscribe();
          } catch {
            // best-effort
          }
        }
      }
    }
    reconcileReflogWatches();
  };

  // Re-entrancy + module guard for the drain. The drain is async (sequential
  // unsubscribe→subscribe), so a wake arriving mid-drain must coalesce into one
  // trailing re-run instead of overlapping live teardowns on the same tree.
  // Null-guards `mainTreeWatcherModule` (the addon may not have loaded yet) and
  // re-runs once if a flag landed while draining (cap overflow OR a fresh
  // heartbeat rescue), mirroring the `makeSingleFlight` trailing-coalesce shape
  // but in the async domain.
  let draining = false;
  let drainPending = false;
  const kickResubscribeDrain = async (): Promise<void> => {
    if (draining) {
      drainPending = true;
      return;
    }
    const watcher = mainTreeWatcherModule;
    if (watcher === null || shuttingDown) return;
    draining = true;
    try {
      do {
        drainPending = false;
        if (shuttingDown) return;
        try {
          await drainResubscribe(watcher);
        } catch (err) {
          console.error(
            `[plan-worker] re-arm drain failed: ${stringifyErr(err)}`,
          );
        }
        // Cap overflow leaves the remainder flagged — loop to drain it.
        if (pendingResubscribe.size > 0) drainPending = true;
      } while (drainPending && !shuttingDown);
    } finally {
      draining = false;
    }
  };

  void import("@parcel/watcher")
    .then(async (watcher) => {
      // publish the module so `reconcileReflogWatches` can subscribe.
      // Set BEFORE the boot scans below so a pending path accrued during a
      // root's `scanRoot` immediately gets its `.git/logs/HEAD` watch.
      reflogWatcherModule = watcher;
      // expose the module + drain to the heartbeat re-arm trigger (armed before
      // the module resolved — it null-guards until this assignment lands).
      mainTreeWatcherModule = watcher;
      // Catch-up: a pending path may have been gated in before the module was
      // ready (e.g. a `recheck-pending`/`kick` post raced the addon load).
      // The boot scans below each fire `onPendingChange` too, but this guards
      // the no-boot-pending-but-message-arrived window.
      reconcileReflogWatches();
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
        const sub = await subscribeRoot(watcher, root);
        if (sub !== null) {
          // Boot scan: pick up files that pre-existed this daemon's start
          // (or were changed while keeperd was down) without waiting for a
          // watcher event. The change-gate suppresses unchanged files.
          scanRoot(root, scanner);
        }
        // This root's census is now recorded (or its subscribe failed/raced
        // shutdown — either way it must not stall the barrier); advance it.
        noteBootScanDone();
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
