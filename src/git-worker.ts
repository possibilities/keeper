/**
 * Git status producer worker. Snapshots planctl-backed git worktrees and posts
 * a synthetic snapshot message when the rendered git view changes.
 *
 * EVENT-DRIVEN, not polled: a snapshot fires only when one of four signals
 * arrives — (1) a `@parcel/watcher` event on the worktree (file content
 * changed), (2) a `@parcel/watcher` event on the git common-dir (commit,
 * checkout, branch-switch, fetch — operations that mutate refs/HEAD/index
 * without touching any worktree file, which the worktree subscription
 * intentionally never sees because it ignores `**\/.git/**`), (3) a
 * `PRAGMA data_version` bump on keeper's own DB (new tool event landed →
 * per-job touched-set may have changed → reattribution required), or (4) a
 * 60s heartbeat safety-net. Each signal feeds a per-root `RescanScheduler`
 * (trailing-debounce + single-flight) so a flurry collapses into one
 * `git status` shell-out. The per-root `lastByRoot` JSON dedupe absorbs
 * no-op snapshots.
 *
 * `PRAGMA data_version` polling is the only sanctioned DB change primitive
 * per the CLAUDE.md DO-NOT — it's a sub-ms autocommit counter read, not a
 * shell-out, and it's already foundational to `wake-worker.ts`.
 *
 * This worker is an event PRODUCER only: it owns no writable DB connection and
 * never mutates projections. Main inserts a `GitSnapshot` event, and the
 * reducer folds that persisted payload into `git_status`. When a watched root
 * stops being planctl-backed (its `.planctl/` directory was removed), the
 * worker also posts a `GitRootDropped` tombstone message from `unsubscribeRoot`
 * — main lifts it into a synthetic `GitRootDropped` event whose reducer fold
 * DELETEs the projection row, keeping `git_status` in sync with the worktree.
 */

import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { AsyncSubscription } from "@parcel/watcher";
import { openDb } from "./db";
import { parsePlanRef } from "./derivers";
import { isDropError, RescanScheduler } from "./rescan";
import type { ShutdownMessage } from "./wake-worker";

export interface GitWorkerData {
  dbPath: string;
}

export interface GitFileStatus {
  path: string;
  xy: string;
  index: string;
  worktree: string;
  kind: "ordinary" | "renamed" | "unmerged" | "untracked";
  orig_path?: string;
}

export interface GitJobFileTouch {
  path: string;
  ops: string[];
}

export interface GitJobView {
  job_id: string;
  title: string | null;
  state: string;
  cwd: string | null;
  plan_verb: string | null;
  plan_ref: string | null;
  touched: GitJobFileTouch[];
  dirty: GitFileStatus[];
  planctl: GitFileStatus[];
}

export interface GitSnapshotPayload {
  project_dir: string;
  branch: string | null;
  head_oid: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  dirty_files: GitFileStatus[];
  orphaned_files: GitFileStatus[];
  jobs: GitJobView[];
}

export interface GitSnapshotMessage extends GitSnapshotPayload {
  kind: "git-snapshot";
}

/**
 * Tombstone message: a watched root has stopped being planctl-backed (its
 * `.planctl/` directory disappeared, so `gitRootFor()` now returns null) and
 * the worker is unsubscribing. Main lifts this into a synthetic
 * `GitRootDropped` event whose reducer fold DELETEs the corresponding
 * `git_status` row — without it the projection would leak the final pre-drop
 * snapshot forever (the reducer's `projectGitStatus` is UPSERT-only).
 */
export interface GitRootDroppedMessage {
  kind: "git-root-dropped";
  project_dir: string;
}

export type GitWorkerMessage = GitSnapshotMessage | GitRootDroppedMessage;

interface ParsedGitStatus {
  branch: string | null;
  head_oid: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  files: GitFileStatus[];
}

interface JobRow {
  job_id: string;
  title: string | null;
  state: string;
  cwd: string | null;
  plan_verb: string | null;
  plan_ref: string | null;
}

interface EventRow {
  tool_name: string | null;
  cwd: string | null;
  data: string;
}

/** `PRAGMA data_version` cadence — same shape as `wake-worker.ts`. */
const DB_POLL_MS = 100;
/** Silent-watcher backstop, same shape as `transcript-worker.ts`. */
const HEARTBEAT_MS = 60_000;
const GIT_TIMEOUT_MS = 2000;
const FILE_TOOL_NAMES = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

/**
 * Positive ignore globs for `@parcel/watcher`. Mirrors `plan-worker.ts`'s
 * `IGNORE_GLOBS` — the same noise (build outputs, vendored deps, package
 * caches) that floods FSEvents under a broad watch root. Duplicated rather
 * than shared because the two workers may diverge over time.
 */
const GIT_IGNORE_GLOBS = [
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
 * Positive ignore globs for the sibling `@parcel/watcher` subscription on each
 * worktree's git common-dir. The point of that subscription is to fire on
 * commit/checkout/branch-switch/fetch — operations that mutate `HEAD`,
 * `index`, `refs/heads/**`, `refs/remotes/**`, or `packed-refs` without
 * touching any worktree file. Everything below is high-churn noise that
 * doesn't affect `git status` output: object packs (a single `git gc` emits
 * thousands of events under `objects/`), reflogs (every ref move appends to
 * `logs/`), user-installed hooks and git-lfs storage that we never read, and
 * transient `*.lock` files (`index.lock`, `HEAD.lock`, `refs/heads/foo.lock`)
 * created and removed on every git write. The 500ms scheduler debounce plus
 * the per-root JSON dedupe in `emitSnapshot` would absorb these as no-ops,
 * but pruning them at the watcher reduces the FSEvents pressure that itself
 * causes drop-recovery storms.
 */
const GIT_DIR_IGNORE_GLOBS = [
  "**/objects/**",
  "**/logs/**",
  "**/hooks/**",
  "**/lfs/**",
  "**/info/**",
  "**/*.lock",
];

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function normalizeRel(path: string): string {
  return path.split("\\").join("/");
}

function resolveEventPath(
  rawPath: string,
  root: string,
  cwd: string | null,
): string | null {
  if (rawPath.length === 0) {
    return null;
  }
  const abs = normalize(
    isAbsolute(rawPath) ? rawPath : join(cwd ?? root, rawPath),
  );
  if (!isInside(root, abs)) {
    return null;
  }
  return normalizeRel(relative(root, abs));
}

function touchOpForTool(toolName: string | null): string | null {
  switch (toolName) {
    case "Write":
      return "write";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "update";
    default:
      return null;
  }
}

export function extractFileTouches(
  row: EventRow,
  root: string,
): GitJobFileTouch[] {
  if (!FILE_TOOL_NAMES.has(row.tool_name ?? "")) {
    return [];
  }
  let parsed: { tool_input?: unknown };
  try {
    parsed = JSON.parse(row.data) as { tool_input?: unknown };
  } catch {
    return [];
  }
  const input = parsed.tool_input;
  if (typeof input !== "object" || input === null) {
    return [];
  }
  const key = row.tool_name === "NotebookEdit" ? "notebook_path" : "file_path";
  const candidate = (input as Record<string, unknown>)[key];
  if (typeof candidate !== "string") {
    return [];
  }
  const path = resolveEventPath(candidate, root, row.cwd);
  const op = touchOpForTool(row.tool_name);
  return path != null && op != null ? [{ path, ops: [op] }] : [];
}

function mergeTouches(touches: GitJobFileTouch[]): GitJobFileTouch[] {
  const byPath = new Map<string, Set<string>>();
  for (const touch of touches) {
    let ops = byPath.get(touch.path);
    if (ops == null) {
      ops = new Set();
      byPath.set(touch.path, ops);
    }
    for (const op of touch.ops) ops.add(op);
  }
  return [...byPath.entries()]
    .map(([path, ops]) => ({ path, ops: [...ops].sort() }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function isStatusTouchedBy(
  status: GitFileStatus,
  touched: Set<string>,
): boolean {
  return (
    touched.has(status.path) ||
    (status.orig_path != null && touched.has(status.orig_path))
  );
}

function parseBranchAheadBehind(value: string): {
  ahead: number | null;
  behind: number | null;
} {
  const m = value.match(/^\+(\d+) -(\d+)$/);
  if (m == null) {
    return { ahead: null, behind: null };
  }
  return { ahead: Number(m[1]), behind: Number(m[2]) };
}

export function parsePorcelainV2(raw: string): ParsedGitStatus {
  const records = raw.split("\0");
  const files: GitFileStatus[] = [];
  let branch: string | null = null;
  let headOid: string | null = null;
  let upstream: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec.length === 0) {
      continue;
    }
    if (rec.startsWith("# branch.head ")) {
      const value = rec.slice("# branch.head ".length);
      branch = value === "(detached)" ? null : value;
      continue;
    }
    if (rec.startsWith("# branch.oid ")) {
      const value = rec.slice("# branch.oid ".length);
      headOid = value === "(initial)" ? null : value;
      continue;
    }
    if (rec.startsWith("# branch.upstream ")) {
      upstream = rec.slice("# branch.upstream ".length);
      continue;
    }
    if (rec.startsWith("# branch.ab ")) {
      const parsed = parseBranchAheadBehind(rec.slice("# branch.ab ".length));
      ahead = parsed.ahead;
      behind = parsed.behind;
      continue;
    }

    const parts = rec.split(" ");
    if (parts[0] === "1") {
      const xy = parts[1] ?? "??";
      const path = parts.slice(8).join(" ");
      if (path.length > 0) {
        files.push({
          path,
          xy,
          index: xy[0] ?? ".",
          worktree: xy[1] ?? ".",
          kind: "ordinary",
        });
      }
    } else if (parts[0] === "2") {
      const xy = parts[1] ?? "??";
      const path = parts.slice(9).join(" ");
      const orig = records[++i] ?? "";
      if (path.length > 0) {
        files.push({
          path,
          xy,
          index: xy[0] ?? ".",
          worktree: xy[1] ?? ".",
          kind: "renamed",
          ...(orig.length > 0 ? { orig_path: orig } : {}),
        });
      }
    } else if (parts[0] === "u") {
      const xy = parts[1] ?? "UU";
      const path = parts.slice(10).join(" ");
      if (path.length > 0) {
        files.push({
          path,
          xy,
          index: xy[0] ?? "U",
          worktree: xy[1] ?? "U",
          kind: "unmerged",
        });
      }
    } else if (parts[0] === "?") {
      const path = rec.slice(2);
      if (path.length > 0) {
        files.push({
          path,
          xy: "??",
          index: "?",
          worktree: "?",
          kind: "untracked",
        });
      }
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { branch, head_oid: headOid, upstream, ahead, behind, files };
}

function gitOutput(args: string[]): string | null {
  try {
    const res = Bun.spawnSync(["git", ...args], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: GIT_TIMEOUT_MS,
    });
    if (!res.success || res.exitCode !== 0) {
      return null;
    }
    return res.stdout.toString();
  } catch {
    return null;
  }
}

function gitRootFor(path: string): string | null {
  const out = gitOutput(["-C", path, "rev-parse", "--show-toplevel"]);
  const root = out?.trim();
  if (!root) {
    return null;
  }
  return existsSync(join(root, ".planctl")) ? root : null;
}

/**
 * Absolute path to the git common-dir for `root`. Use `--git-common-dir`
 * rather than `--git-dir` so a linked worktree (where `<root>/.git` is a
 * gitfile pointing into `<main>/.git/worktrees/<name>/`) resolves to the
 * main repo's `.git/` — the place where shared refs (`refs/heads/*`,
 * `packed-refs`, `refs/remotes/*`) live. For a regular repo the two return
 * the same path. The worktree's own per-worktree `HEAD` and `index` sit
 * inside the common-dir at `worktrees/<name>/`, so this single subscription
 * covers both worktree-local and shared-ref mutations.
 *
 * git's default output is relative to `root`; we resolve to absolute so
 * `@parcel/watcher.subscribe` gets a stable canonical path.
 */
function gitCommonDirFor(root: string): string | null {
  const out = gitOutput(["-C", root, "rev-parse", "--git-common-dir"]);
  const value = out?.trim();
  if (!value) return null;
  const abs = isAbsolute(value) ? value : resolve(root, value);
  return existsSync(abs) ? abs : null;
}

function readStatus(root: string): ParsedGitStatus | null {
  const out = gitOutput([
    "-C",
    root,
    "status",
    "--porcelain=v2",
    "-z",
    "--branch",
    "--renames",
    "--untracked-files=all",
  ]);
  return out == null ? null : parsePorcelainV2(out);
}

function discoverProjectRoots(
  db: Database,
  cwdRootCache?: Map<string, string | null>,
): string[] {
  const candidates = new Set<string>();
  const jobRows = db
    .query("SELECT DISTINCT cwd FROM jobs WHERE cwd IS NOT NULL")
    .all() as { cwd: string }[];
  for (const row of jobRows) candidates.add(row.cwd);

  const epicRows = db.query("SELECT project_dir, tasks FROM epics").all() as {
    project_dir: string | null;
    tasks: string | null;
  }[];
  for (const row of epicRows) {
    if (row.project_dir != null) candidates.add(row.project_dir);
    if (row.tasks == null || row.tasks.length === 0) continue;
    try {
      const tasks = JSON.parse(row.tasks);
      if (!Array.isArray(tasks)) continue;
      for (const task of tasks) {
        const repo = (task as { target_repo?: unknown }).target_repo;
        if (typeof repo === "string" && repo.length > 0) {
          candidates.add(repo);
        }
      }
    } catch {
      // malformed embedded task array: ignore for discovery.
    }
  }

  const roots = new Set<string>();
  for (const candidate of candidates) {
    // cwd → root is stable for a session's lifetime, and a shell-out per cwd
    // per reconcile is the dominant cost. Memoize across reconciles (cleared
    // only by daemon restart).
    let root: string | null | undefined = cwdRootCache?.get(candidate);
    if (root === undefined) {
      root = gitRootFor(candidate);
      cwdRootCache?.set(candidate, root);
    }
    if (root != null) roots.add(root);
  }
  return [...roots].sort();
}

function liveJobsForRoot(db: Database, root: string): JobRow[] {
  const rows = db
    .query(
      `SELECT job_id, title, state, cwd, plan_verb, plan_ref
         FROM jobs
        WHERE cwd IS NOT NULL
          AND state IN ('working', 'stopped')
        ORDER BY created_at DESC, job_id ASC`,
    )
    .all() as JobRow[];
  return rows.filter((row) => row.cwd != null && isInside(root, row.cwd));
}

function touchesForJob(
  db: Database,
  root: string,
  jobId: string,
): GitJobFileTouch[] {
  const rows = db
    .query(
      `SELECT tool_name, cwd, data
         FROM events
        WHERE session_id = ?
          AND hook_event = 'PostToolUse'
          AND tool_name IN ('Write', 'Edit', 'MultiEdit', 'NotebookEdit')
        ORDER BY id ASC`,
    )
    .all(jobId) as EventRow[];
  return mergeTouches(rows.flatMap((row) => extractFileTouches(row, root)));
}

/**
 * Per-job set of `.planctl/{epics,tasks}/<id>.json` paths derived from the
 * session's mutation-verb planctl invocations. Gated on
 * `planctl_subject_present = 1` so read-only verbs (`cat`, `show`, `list`)
 * never attribute a file. Targets are mapped through `parsePlanRef` so only
 * canonical refs produce paths; malformed targets skip silently.
 */
function planctlPathsForJob(db: Database, jobId: string): Set<string> {
  const rows = db
    .query(
      `SELECT DISTINCT planctl_target
         FROM events
        WHERE session_id = ?
          AND planctl_op IS NOT NULL
          AND planctl_subject_present = 1
          AND planctl_target IS NOT NULL`,
    )
    .all(jobId) as { planctl_target: string }[];
  const paths = new Set<string>();
  for (const row of rows) {
    const parsed = parsePlanRef(row.planctl_target);
    if (parsed == null) continue;
    if (parsed.kind === "epic") {
      paths.add(`.planctl/epics/${parsed.epic_id}.json`);
    } else {
      paths.add(`.planctl/tasks/${parsed.task_id}.json`);
    }
  }
  return paths;
}

export function buildGitSnapshot(
  db: Database,
  projectDir: string,
  status: ParsedGitStatus,
): GitSnapshotPayload {
  const jobs = liveJobsForRoot(db, projectDir).map((job) => {
    const touched = touchesForJob(db, projectDir, job.job_id);
    const touchedSet = new Set(touched.map((t) => t.path));
    const planctlPaths = planctlPathsForJob(db, job.job_id);
    return {
      ...job,
      touched,
      dirty: status.files.filter((file) => isStatusTouchedBy(file, touchedSet)),
      planctl: status.files.filter((file) =>
        isStatusTouchedBy(file, planctlPaths),
      ),
    };
  });

  const touchedByLiveJobs = new Set<string>();
  for (const job of jobs) {
    for (const touch of job.touched) touchedByLiveJobs.add(touch.path);
    for (const file of job.planctl) touchedByLiveJobs.add(file.path);
  }
  const orphaned = status.files.filter(
    (file) => !isStatusTouchedBy(file, touchedByLiveJobs),
  );

  return {
    project_dir: projectDir,
    branch: status.branch,
    head_oid: status.head_oid,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    dirty_files: status.files,
    orphaned_files: orphaned,
    jobs,
  };
}

function startWorker(): void {
  if (parentPort == null) {
    console.error("[git-worker] no parentPort — not running as a Worker");
    process.exit(1);
  }
  const data = workerData as GitWorkerData | undefined;
  if (data == null || typeof data.dbPath !== "string") {
    console.error("[git-worker] missing dbPath in workerData");
    process.exit(1);
  }

  const { db } = openDb(data.dbPath, { readonly: true });
  const port = parentPort;

  const lastByRoot = new Map<string, string>();
  // Each watched root holds a worktree subscription and (best-effort) a
  // git-common-dir subscription. The git-dir sub may be null if the
  // common-dir lookup failed or the subscribe itself rejected (logged,
  // non-fatal — the heartbeat backstop still covers commit/checkout for
  // that root within 60s). Co-locating the two so unsubscribe + shutdown
  // can release them as a unit.
  interface RootSubscriptions {
    worktree: AsyncSubscription;
    gitDir: AsyncSubscription | null;
  }
  const subscriptions = new Map<string, RootSubscriptions>();
  const schedulers = new Map<string, RescanScheduler>();
  const cwdRootCache = new Map<string, string | null>();

  let watcherModule: typeof import("@parcel/watcher") | null = null;
  let dbPollTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let lastDataVersion: number | null = null;
  let shuttingDown = false;

  // Single-flight reconciler — DB poll + heartbeat + boot all call this and
  // must not double-subscribe across an `await`.
  let reconciling = false;
  let reconcilePending = false;

  function emitSnapshot(root: string): void {
    if (shuttingDown) return;
    let status: ParsedGitStatus | null;
    try {
      status = readStatus(root);
    } catch (err) {
      console.error(
        `[git-worker] readStatus failed for ${root}: ${stringifyErr(err)}`,
      );
      return;
    }
    if (status == null) return;
    let snapshot: GitSnapshotPayload;
    try {
      snapshot = buildGitSnapshot(db, root, status);
    } catch (err) {
      console.error(
        `[git-worker] buildGitSnapshot failed for ${root}: ${stringifyErr(err)}`,
      );
      return;
    }
    const key = JSON.stringify(snapshot);
    if (lastByRoot.get(root) === key) return;
    lastByRoot.set(root, key);
    port.postMessage({
      kind: "git-snapshot",
      ...snapshot,
    } satisfies GitSnapshotMessage);
  }

  function schedulerFor(root: string): RescanScheduler {
    let s = schedulers.get(root);
    if (s != null) return s;
    s = new RescanScheduler(() => emitSnapshot(root));
    schedulers.set(root, s);
    return s;
  }

  async function subscribeRoot(root: string): Promise<void> {
    if (shuttingDown || watcherModule == null) return;
    if (subscriptions.has(root)) return;
    const sched = schedulerFor(root);
    const mod = watcherModule;
    let worktreeSub: AsyncSubscription | null = null;
    let gitDirSub: AsyncSubscription | null = null;
    try {
      worktreeSub = await mod.subscribe(
        root,
        (err) => {
          if (err) {
            console.error(
              `[git-worker] watcher error for ${root}: ${stringifyErr(err)}`,
            );
            // A recoverable FSEvents drop: schedule a re-snapshot so the missed
            // change isn't lost. Non-drop errors keep today's swallow-and-log.
            if (isDropError(err)) sched.schedule();
            return;
          }
          // Any worktree change → debounced re-snapshot. The per-root JSON
          // dedupe absorbs no-ops, so over-firing is cheap.
          sched.schedule();
        },
        { ignore: GIT_IGNORE_GLOBS },
      );
      if (shuttingDown) {
        void worktreeSub.unsubscribe();
        return;
      }

      // Sibling subscription on the git common-dir. The worktree sub ignores
      // `**/.git/**` (and even without that ignore, FSEvents wouldn't fire on
      // refs/HEAD/index churn because git uses rename-replace and lockfile
      // dance under the gitdir). Without this, a `git commit` (which only
      // mutates `.git/index`, `.git/HEAD`, `.git/refs/...`, `.git/objects/...`)
      // is invisible to the worker until the 60s heartbeat — the bug the
      // human hit. A failure here is logged and tolerated: the root stays
      // subscribed to its worktree, and the heartbeat still covers it.
      const commonDir = gitCommonDirFor(root);
      if (commonDir != null) {
        try {
          gitDirSub = await mod.subscribe(
            commonDir,
            (err) => {
              if (err) {
                console.error(
                  `[git-worker] git-dir watcher error for ${commonDir}: ${stringifyErr(err)}`,
                );
                if (isDropError(err)) sched.schedule();
                return;
              }
              sched.schedule();
            },
            { ignore: GIT_DIR_IGNORE_GLOBS },
          );
        } catch (err) {
          console.error(
            `[git-worker] failed to subscribe to git-dir ${commonDir}: ${stringifyErr(err)}`,
          );
        }
      }
      if (shuttingDown) {
        if (gitDirSub != null) void gitDirSub.unsubscribe();
        void worktreeSub.unsubscribe();
        return;
      }

      subscriptions.set(root, { worktree: worktreeSub, gitDir: gitDirSub });
      // Initial snapshot for the newly-watched root.
      emitSnapshot(root);
    } catch (err) {
      // Only the worktree `await` can reach this catch — the git-dir branch
      // has its own inner try/catch, and every subsequent step is sync &
      // non-throwing. So `gitDirSub` is still null here; only `worktreeSub`
      // needs best-effort teardown.
      if (worktreeSub != null) void worktreeSub.unsubscribe();
      console.error(
        `[git-worker] failed to subscribe to ${root}: ${stringifyErr(err)}`,
      );
    }
  }

  async function unsubscribeRoot(root: string): Promise<void> {
    // Tombstone first — main lifts this into a synthetic GitRootDropped event
    // whose reducer fold DELETEs the projection row. Posting before teardown
    // keeps the producer-only contract: the event log is the sole driver of
    // git_status changes, so re-fold determinism extends to retractions.
    // Skip during shutdown — main has already cleared its onmessage handler
    // and posting would be a no-op that just races the worker's exit path.
    if (!shuttingDown) {
      port.postMessage({
        kind: "git-root-dropped",
        project_dir: root,
      } satisfies GitRootDroppedMessage);
    }
    const sub = subscriptions.get(root);
    if (sub != null) {
      subscriptions.delete(root);
      try {
        await sub.worktree.unsubscribe();
      } catch {
        // best-effort
      }
      if (sub.gitDir != null) {
        try {
          await sub.gitDir.unsubscribe();
        } catch {
          // best-effort
        }
      }
    }
    const sched = schedulers.get(root);
    if (sched != null) {
      sched.cancel();
      schedulers.delete(root);
    }
    lastByRoot.delete(root);
  }

  async function reconcileRoots(): Promise<void> {
    if (shuttingDown || watcherModule == null) return;
    if (reconciling) {
      reconcilePending = true;
      return;
    }
    reconciling = true;
    try {
      const desired = new Set(discoverProjectRoots(db, cwdRootCache));
      const current = new Set(subscriptions.keys());
      for (const root of desired) {
        if (!current.has(root)) await subscribeRoot(root);
      }
      for (const root of current) {
        if (!desired.has(root)) await unsubscribeRoot(root);
      }
    } finally {
      reconciling = false;
      if (reconcilePending) {
        reconcilePending = false;
        void reconcileRoots();
      }
    }
  }

  port.on("message", (msg: ShutdownMessage | undefined) => {
    if (msg?.type !== "shutdown") return;
    shuttingDown = true;
    if (dbPollTimer != null) clearInterval(dbPollTimer);
    if (heartbeatTimer != null) clearInterval(heartbeatTimer);
    // Cancel every armed scheduler BEFORE unsubscribe + db.close so a queued
    // re-scan can't fire against a closing connection. Mirrors plan-worker.
    for (const sched of schedulers.values()) sched.cancel();
    schedulers.clear();
    void (async () => {
      const subs = [...subscriptions.values()];
      subscriptions.clear();
      for (const sub of subs) {
        try {
          await sub.worktree.unsubscribe();
        } catch {
          // best-effort
        }
        if (sub.gitDir != null) {
          try {
            await sub.gitDir.unsubscribe();
          } catch {
            // best-effort
          }
        }
      }
      try {
        db.close();
      } catch {
        // best-effort
      }
      process.exit(0);
    })();
  });

  void import("@parcel/watcher")
    .then(async (mod) => {
      watcherModule = mod;
      await reconcileRoots();

      // DB-wake trigger. Per CLAUDE.md DO-NOT, `PRAGMA data_version` is the
      // ONLY sanctioned DB change primitive — `wake-worker.ts` uses the same
      // pattern. A bump means SOMETHING committed (new tool event, new job
      // row, new epic/task snapshot) and the touched-set or root membership
      // may have changed. Re-reconcile + schedule snapshots for every root;
      // the per-root JSON dedupe absorbs no-ops (including our own
      // GitSnapshot round-trips).
      const dataVersionQuery = db.query("PRAGMA data_version");
      lastDataVersion = (dataVersionQuery.get() as { data_version: number })
        .data_version;
      dbPollTimer = setInterval(() => {
        if (shuttingDown) return;
        const cur = (dataVersionQuery.get() as { data_version: number })
          .data_version;
        if (cur === lastDataVersion) return;
        lastDataVersion = cur;
        void reconcileRoots();
        for (const root of subscriptions.keys()) {
          schedulerFor(root).schedule();
        }
      }, DB_POLL_MS);

      // Silent-watcher backstop, mirroring transcript-worker. If a watcher
      // ever goes mute (observed parcel/watcher #174-style stalls under
      // sibling-worker crashes), the heartbeat catches the missed snapshot
      // within HEARTBEAT_MS. The per-root dedupe makes a healthy run free.
      heartbeatTimer = setInterval(() => {
        if (shuttingDown) return;
        void reconcileRoots();
        for (const root of subscriptions.keys()) emitSnapshot(root);
      }, HEARTBEAT_MS);
    })
    .catch((err) => {
      // Addon load failure is the sole unrecoverable surface. Exit non-zero →
      // daemon `fatalExit` → launchd restart, the single recovery path.
      console.error(
        `[git-worker] failed to load @parcel/watcher: ${stringifyErr(err)}`,
      );
      try {
        db.close();
      } catch {
        // best-effort
      }
      process.exit(1);
    });
}

if (!isMainThread) {
  startWorker();
}
