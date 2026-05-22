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
 */

import type { Database } from "bun:sqlite";
import {
  type Dirent,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join, sep } from "node:path";
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
  /** Derived: `worker_done_at` present → "done", else "open". */
  status: string;
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
type PlanKind = "epic" | "task";

/**
 * Classify a watched path as an epic file, a task file, or neither, by matching
 * the `.planctl/epics/*.json` / `.planctl/tasks/*.json` shape. Uses the
 * platform path separator so it works under any root depth. A path NOT under a
 * `.planctl/{epics,tasks}` dir, or not ending in `.json`, returns `null` — the
 * callback then skips it (the in-callback filter the ignore globs can't express).
 *
 * Pure — does no I/O. Exported for unit reach.
 */
export function classifyPlanPath(path: string): PlanKind | null {
  if (!path.endsWith(".json")) {
    return null;
  }
  // Split into segments; the file must sit directly inside `.planctl/epics` or
  // `.planctl/tasks` (the planctl layout). Match the trailing
  // `.planctl / <epics|tasks> / <file>.json` triple.
  const segments = path.split(sep);
  const n = segments.length;
  if (n < 3) {
    return null;
  }
  if (segments[n - 3] !== ".planctl") {
    return null;
  }
  const dir = segments[n - 2];
  if (dir === "epics") {
    return "epic";
  }
  if (dir === "tasks") {
    return "task";
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
}

/** Raw planctl task JSON shape — only the fields we project. */
interface RawTask {
  id?: unknown;
  epic?: unknown;
  title?: unknown;
  target_repo?: unknown;
  worker_done_at?: unknown;
}

/** Coerce a value to a non-empty string, else null. */
function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
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
 */
export class PlanScanner {
  /** id → last-emitted serialized snapshot (the change-gate). */
  private readonly lastEmitted = new Map<string, string>();
  /** path → id, so a delete can drop the right change-gate entry. */
  private readonly pathToId = new Map<string, string>();
  /**
   * The set of planctl ids whose backing `.json` file was actually enumerated
   * on disk by a boot scan ({@link markSeen}, called from `scanPlanctlDir` for
   * EVERY file regardless of parse outcome). The boot-reconciliation
   * {@link sweep} diffs the projection against this census to retract ghosts —
   * projection ids whose file was deleted while the daemon was down (no live
   * `onDelete` ever fired). Keyed by the FILENAME-derived id (file basename
   * minus `.json`), NOT a parse result: a file mid-rewrite that fails to parse
   * still has its name on disk, so it is "seen" and never spuriously retracted.
   */
  private readonly seenOnDisk = new Set<string>();

  constructor(
    private readonly onSnapshot: (msg: PlanMessage) => void,
    private readonly log: (msg: string) => void = (m) => console.error(m),
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
   * Process a delete for `path`. Emits a tombstone so the projection retracts,
   * then drops the change-gate entry (so a re-created file re-emits). A path
   * with no change-gate entry (never folded) emits nothing — nothing to retract.
   *
   * The deleted file is already gone, so we cannot re-read it: the id comes from
   * the `pathToId` map and a task's parent `epicId` from the last-emitted
   * snapshot still held in the change-gate. The tombstone is the only
   * replay-deterministic way to fold a delete — it rides through the same
   * synthetic-event pipeline as the snapshot messages.
   */
  onDelete(path: string): void {
    const id = this.pathToId.get(path);
    if (id === undefined) {
      return; // never folded this path — nothing to retract.
    }
    const kind = classifyPlanPath(path);
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
    }
    // Drop the change-gate so a re-created file re-emits its snapshot.
    this.pathToId.delete(path);
    this.lastEmitted.delete(id);
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

    const msg =
      kind === "epic"
        ? buildEpicMessage(parsed as RawEpic)
        : buildTaskMessage(parsed as RawTask);
    if (msg === null) {
      // No usable id — can't key the projection. Skip-and-log.
      this.log(`[plan-worker] ${path} has no usable id; skipping`);
      return;
    }

    this.pathToId.set(path, msg.id);
    const serialized = JSON.stringify(msg);
    if (this.lastEmitted.get(msg.id) === serialized) {
      return; // change-gate: unchanged snapshot, suppress.
    }
    this.lastEmitted.set(msg.id, serialized);
    this.onSnapshot(msg);
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
 * other field is taken verbatim (coerced to string-or-null).
 */
export function buildEpicMessage(raw: RawEpic): PlanEpicMessage | null {
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
  };
}

/**
 * Build a `plan-task` message from a parsed task JSON, or null when the file has
 * no usable id. The number is derived from the id; status is DERIVED
 * (`worker_done_at` present → "done" else "open" — planctl tasks carry no
 * `status` field). Other fields are taken verbatim.
 */
export function buildTaskMessage(raw: RawTask): PlanTaskMessage | null {
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
    status: asString(raw.worker_done_at) !== null ? "done" : "open",
  };
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
 * Enumerate one `.planctl` dir's `epics/` + `tasks/` `*.json` files and run each
 * through the scanner. A missing `epics/` or `tasks/` subdir is fine (skip). The
 * change-gate handles re-emit suppression.
 */
function scanPlanctlDir(planctlDir: string, scanner: PlanScanner): void {
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
  const epics = db
    .query(
      "SELECT epic_id, epic_number, title, project_dir, status, tasks FROM epics",
    )
    .all() as {
    epic_id: string;
    epic_number: number | null;
    title: string | null;
    project_dir: string | null;
    status: string | null;
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
    };
    scanner.seed(e.epic_id, JSON.stringify(msg));

    // As of schema v7 each epic embeds its tasks as a JSON-array column. Decode
    // it and reconstruct each task's seed message field-for-field to match
    // {@link buildTaskMessage} — `taskNumberFromId` for the number,
    // `status ?? "open"` for the derived status — or the change-gate would
    // re-emit every plan-task on every boot. A malformed/NULL array is treated
    // as empty (one bad row never wedges the seed).
    let tasks: {
      task_id: string;
      epic_id: string | null;
      title: string | null;
      target_repo: string | null;
      status: string | null;
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
        // The projection stores the derived status verbatim; default to "open"
        // for a (legacy) NULL so the reconstructed seed matches a fresh scan.
        status: t.status ?? "open",
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
  const scanner = new PlanScanner((msg) => {
    port.postMessage(msg);
  });

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
  let shuttingDown = false;

  const closeDb = (): void => {
    try {
      db.close();
    } catch {
      // best-effort; exiting either way
    }
  };

  parentPort.on("message", (msg: ShutdownMessage | undefined) => {
    if (msg && msg.type === "shutdown") {
      shuttingDown = true;
      // Clear every armed re-scan timer FIRST (before unsubscribe / db close) so
      // a pending drop-recovery scan can't fire against a closing connection.
      for (const sched of schedulers.splice(0)) {
        sched.cancel();
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
        // a debounced, single-flight re-scan of THIS root via the change-gated
        // boot-scan primitive (scanRoot) — never an unsubscribe+re-subscribe (the
        // subscription stays alive; re-subscribing would open a no-watch gap). The
        // warm in-memory change-gate (PlanScanner.lastEmitted) suppresses re-emits
        // for unchanged files, so recovery is idempotent. The scan re-checks
        // shuttingDown so a queued scan can't touch a closing DB.
        const rescan = new RescanScheduler(() => {
          if (shuttingDown) {
            return;
          }
          scanRoot(root, scanner);
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
