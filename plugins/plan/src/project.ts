// Project resolution — the port of planctl/project.py.
//
// findGitRoot is a parent-walk for a `.git` entry (directory OR file, so a
// linked-worktree `.git` file counts), never honoring GIT_DIR. realpathSync
// matches Python's Path.resolve() symlink resolution (load-bearing on macOS,
// where the pytest tmp tree resolves /var -> /private/var). resolveProject
// hard-errors through emitError when no `.keeper/` data dir is present.
//
// resolveProject also detects a LANE VANTAGE: a cwd inside a linked git
// worktree serves that lane's committed `.keeper` snapshot, which can lag the
// authoritative state repo. Detection is positive-evidence — only a readable
// `.git` FILE resolving through its gitdir/commondir to a main checkout that
// positively carries a `.keeper/` redirects resolution there; anything weaker
// keeps the cwd resolution and annotates on stderr, never redirecting on a
// guess.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";

import { resolveEpicGlobally } from "./discovery.ts";
import { emitError, type OutputFormat } from "./format.ts";
import { epicIdFromTask, isTaskId } from "./ids.ts";
import {
  hasDataDir,
  resolveDataDir,
  resolveDataDirOrDefault,
} from "./state_path.ts";
import { loadJsonSafe } from "./store.ts";

export interface ProjectContext {
  name: string;
  dataDir: string;
  stateDir: string;
  projectPath: string;
}

/** Resolve `start` (default cwd) and return it; falls back to the raw path when
 * it does not yet exist on disk (realpathSync would throw). */
function resolveStart(start?: string): string {
  const base = start ?? process.cwd();
  try {
    return realpathSync(base);
  } catch {
    return base;
  }
}

/** Nearest ancestor of `start` holding a `.git` entry, or null. */
export function findGitRoot(start?: string): string | null {
  let candidate = resolveStart(start);
  while (true) {
    if (existsSync(join(candidate, ".git"))) {
      return candidate;
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      return null;
    }
    candidate = parent;
  }
}

/** Git repo root, falling back to the resolved cwd. */
export function findProjectRoot(): string {
  return findGitRoot() ?? resolveStart();
}

/** Build a ProjectContext for `projectRoot`, resolving its `.keeper/` data dir.
 * The shared root→context builder every verb's local helper routes through, so
 * the data-dir resolution lives in one place. */
export function contextForRoot(projectRoot: string): ProjectContext {
  const dataDir = resolveDataDirOrDefault(projectRoot);
  return {
    name: basename(projectRoot),
    dataDir,
    stateDir: join(dataDir, "state"),
    projectPath: projectRoot,
  };
}

/** Resolve the current directory to a ProjectContext, erroring when no
 * `.keeper/` data dir is present. `format` selects the error envelope's
 * serialization.
 *
 * When the cwd-discovered root is a LANE VANTAGE (a linked worktree serving a
 * potentially stale committed `.keeper` snapshot), the resolution is corrected
 * or annotated per `detectLaneVantage`'s positive-evidence tri-state:
 *  - a positively derived main checkout carrying `.keeper` REDIRECTS resolution
 *    there (the lane's snapshot is bypassed), even when the lane itself has no
 *    data dir;
 *  - a lane whose main checkout is derivable but carries no `.keeper`, and a lane
 *    whose `.git` file is unreadable/malformed (main not derivable), keep the cwd
 *    resolution and emit a stderr note — never a silent redirect on a guess.
 *
 * The note rides stderr, never stdout, so every read/inspection verb still emits
 * exactly one top-level JSON value. Explicit `--project` never reaches here. */
export function resolveProject(format: OutputFormat | null): ProjectContext {
  const projectRoot = findProjectRoot();
  const vantage = detectLaneVantage(projectRoot);

  if (vantage.kind === "redirect") {
    annotateLane(
      "plan: cwd is a lane worktree; resolving plan state against the state " +
        `repo ${vantage.mainRoot}`,
    );
    return contextForRoot(vantage.mainRoot);
  }

  if (!hasDataDir(projectRoot)) {
    emitError("No plan project found. Run 'keeper plan init' first.", format);
  }

  if (vantage.kind === "lane_no_state") {
    annotateLane(
      "plan: cwd is a lane worktree; its committed .keeper snapshot may lag " +
        `the state repo and ${vantage.mainRoot} carries no .keeper — pass ` +
        "--project <state repo> for authoritative state",
    );
  } else if (vantage.kind === "inconclusive") {
    annotateLane(
      "plan: cwd's .git marks a linked worktree but the main checkout could " +
        "not be resolved; this read may reflect a lagging snapshot — pass " +
        "--project <state repo> if unexpected",
    );
  }

  return contextForRoot(projectRoot);
}

/** The lane-vantage outcome for a cwd-discovered project root. `not_lane` is an
 * ordinary checkout (a `.git` directory, or no `.git`) — byte-identical current
 * behavior. `redirect` positively derived a main checkout carrying `.keeper`.
 * `lane_no_state` positively derived the main checkout but it lacks `.keeper`.
 * `inconclusive` is a `.git` FILE whose worktree structure could not be read. */
type LaneVantage =
  | { kind: "not_lane" }
  | { kind: "redirect"; mainRoot: string }
  | { kind: "lane_no_state"; mainRoot: string }
  | { kind: "inconclusive" };

/** Classify `projectRoot`'s git vantage from the filesystem alone (no `git`
 * subprocess). A `.git` DIRECTORY (or absent `.git`) is positively not a lane. A
 * `.git` FILE marks a linked worktree: follow its `gitdir:` pointer to the
 * worktree git dir, then its `commondir` to the main checkout's git dir, whose
 * parent is the main toplevel. Only a positively derived main toplevel that
 * carries `.keeper` justifies redirecting; a self-resolving or unreadable
 * structure stays inconclusive. */
function detectLaneVantage(projectRoot: string): LaneVantage {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(join(projectRoot, ".git"));
  } catch {
    return { kind: "not_lane" };
  }
  if (st.isDirectory()) {
    return { kind: "not_lane" };
  }

  const worktreeGitDir = readGitdirPointer(
    join(projectRoot, ".git"),
    projectRoot,
  );
  if (worktreeGitDir === null) {
    return { kind: "inconclusive" };
  }
  const commonGitDir = readCommonDir(worktreeGitDir);
  if (commonGitDir === null) {
    return { kind: "inconclusive" };
  }

  // The common git dir is the main checkout's `.git`; its parent is that
  // toplevel. A structure resolving back onto the lane is a no-op, not a lane.
  const mainRoot = realpathOr(dirname(commonGitDir));
  if (mainRoot === projectRoot) {
    return { kind: "not_lane" };
  }
  return hasDataDir(mainRoot)
    ? { kind: "redirect", mainRoot }
    : { kind: "lane_no_state", mainRoot };
}

/** Follow a linked-worktree `.git` file's `gitdir:` line to the worktree git
 * dir. A relative pointer resolves against the `.git` file's directory. Null
 * when the file is unreadable or carries no `gitdir:` line. */
function readGitdirPointer(gitFilePath: string, base: string): string | null {
  let body: string;
  try {
    body = readFileSync(gitFilePath, "utf-8");
  } catch {
    return null;
  }
  const match = body.match(/^gitdir:\s*(.+?)\s*$/m);
  if (match === null) {
    return null;
  }
  const pointer = match[1] as string;
  return pointer.startsWith("/") ? pointer : resolvePath(base, pointer);
}

/** Resolve the worktree git dir's `commondir` to the main checkout's git dir.
 * Git writes it relative to the worktree git dir (usually `../..`). Null when
 * the file is absent, unreadable, or empty. */
function readCommonDir(worktreeGitDir: string): string | null {
  let body: string;
  try {
    body = readFileSync(join(worktreeGitDir, "commondir"), "utf-8");
  } catch {
    return null;
  }
  const rel = body.trim();
  if (rel.length === 0) {
    return null;
  }
  return rel.startsWith("/") ? rel : resolvePath(worktreeGitDir, rel);
}

/** Emit a one-line lane-vantage note to stderr. Kept OFF stdout so every
 * read/inspection verb still emits exactly one top-level JSON value there. */
function annotateLane(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

/** A non-emitting owning-project resolution outcome: the resolved context, or a
 * typed reason a caller renders in its own error shape (cat's `Error:` stderr
 * line vs the JSON envelope). `kind` is "Task" / "Epic" for the message. */
export type OwningProjectResult =
  | { ok: true; ctx: ProjectContext }
  | { ok: false; reason: "no_project"; projectRoot: string; kind: string }
  | { ok: false; reason: "not_found"; id: string; kind: string }
  | {
      ok: false;
      reason: "ambiguous";
      id: string;
      owners: string[];
      kind: string;
    };

/** Resolve the project OWNING an id (epic OR task) cwd-then-global WITHOUT
 * emitting — returns a typed outcome the caller renders. Same resolution charter
 * as `resolveOwningProjectForId`; see that doc for the cwd-then-global ordering,
 * the task-via-epic indirection, and the `--project` bypass.
 *
 * `requireLeaf` (default true) gates whether a TASK id's own JSON must exist in
 * the resolved project. A consumer that owns its own leaf-existence error (cat,
 * which reports a missing SPEC by absolute path) passes `false` so the resolver
 * stops at the owning EPIC and defers the leaf check to the caller. */
export function tryResolveOwningProjectForId(
  id: string,
  project: string | null,
  requireLeaf = true,
): OwningProjectResult {
  const taskId = isTaskId(id) ? id : null;
  const epicId = taskId !== null ? epicIdFromTask(taskId) : id;
  const kind = taskId !== null ? "Task" : "Epic";

  if (project !== null) {
    const projectRoot = expandResolve(project);
    if (!hasDataDir(projectRoot)) {
      return { ok: false, reason: "no_project", projectRoot, kind };
    }
    // The override targets a concrete project; the leaf (task/epic JSON) must
    // exist there unless the caller defers the leaf check (requireLeaf=false,
    // task ids only — an epic id always gates on the epic JSON).
    const overrideLeaf = taskId === null || requireLeaf;
    if (overrideLeaf && !idExistsInProject(projectRoot, id, taskId !== null)) {
      return { ok: false, reason: "not_found", id, kind };
    }
    if (!overrideLeaf && !idExistsInProject(projectRoot, epicId, false)) {
      return { ok: false, reason: "not_found", id: epicId, kind: "Epic" };
    }
    return { ok: true, ctx: contextForRoot(projectRoot) };
  }

  const result = resolveEpicGlobally(epicId);
  if (result.ambiguous) {
    return { ok: false, reason: "ambiguous", id, owners: result.owners, kind };
  }
  if (!result.resolved) {
    // Report the input id as given (the task id, not its derived epic id).
    return { ok: false, reason: "not_found", id, kind };
  }
  // resolved => projectPath is non-null.
  const projectRoot = result.projectPath as string;
  // A task id resolves through its epic; when requireLeaf, the task JSON must
  // also exist in that owning project (an epic with no such task is a not-found
  // for the task id). requireLeaf=false defers that to the caller's leaf check.
  if (taskId !== null && requireLeaf) {
    if (!idExistsInProject(projectRoot, taskId, true)) {
      return { ok: false, reason: "not_found", id: taskId, kind };
    }
  }
  return { ok: true, ctx: contextForRoot(projectRoot) };
}

/** Resolve the project OWNING an id (epic OR task) cwd-then-global, so an
 * id-addressed verb run from a non-owning repo's cwd still finds the board that
 * carries it. The id is globally unique, so a bare `fn-N[.M]` resolves to its
 * owning project wherever it lives.
 *
 * Resolution order matches `resolveEpicGlobally`'s charter: cwd's own project
 * wins first (single-repo behavior is unchanged — the cwd project never falls
 * through to a foreign one), then the configured-roots discovery scan. A task id
 * resolves through its OWNING EPIC (same `resolveEpicGlobally` helper add-deps /
 * epic rm reuse — a task lives in the same project as its epic) and the task
 * JSON's presence in that project is the final not-found gate.
 *
 * Fails closed via `emitError`: not-found and ambiguous (a legacy dup id living
 * in two projects) each surface a clear message — the ambiguous case names every
 * owner and points at `--project`, never silently picking one. A non-null
 * `project` override bypasses discovery entirely (validates the path is a
 * project carrying the id), the documented escape hatch for an ambiguous id. */
export function resolveOwningProjectForId(
  id: string,
  project: string | null,
  format: OutputFormat | null,
): ProjectContext {
  const res = tryResolveOwningProjectForId(id, project);
  if (res.ok) {
    return res.ctx;
  }
  switch (res.reason) {
    case "no_project":
      emitError(
        `No plan project found at ${res.projectRoot}. Run 'keeper plan init' first.`,
        format,
      );
      break;
    case "ambiguous":
      emitError(
        `${res.kind} ${res.id} exists in multiple projects; pass --project ` +
          `<path>. Candidates: ${res.owners.join(", ")}`,
        format,
      );
      break;
    case "not_found":
      emitError(`${res.kind} not found: ${res.id}`, format);
      break;
  }
  // emitError exits; this is unreachable but satisfies the return type.
  throw new Error("unreachable");
}

/** The ONE seam every runtime-overlay / close-audit WRITER routes its
 * state-bearing context through, so no plan verb reads/writes runtime state from
 * a worktree lane when the primary repo owns that state. Three phases:
 *
 *  1. LOCATE the owning def cwd-then-global (`resolveOwningProjectForId`;
 *     `--project` bypasses discovery and fails loud on a bad path / missing id).
 *     A non-null `project` is authoritative for BOTH locating and physical state
 *     ownership — operator intent wins, so the locate ctx is returned outright.
 *  2. Read the cwd-INDEPENDENT `epic.primary_repo` field off the located,
 *     committed def; physical state lives at that repo (`contextForRoot`), never
 *     the locate root. A worktree lane carries byte-identical committed defs but
 *     no gitignored `state/`, so keying on the FIELD (not where defs sit, not
 *     roots-discovery) keeps state on primary even when primary is OUTSIDE the
 *     configured roots. A null `primary_repo` (single-repo board) degrades to the
 *     locate root — a no-op.
 *  3. FAIL LOUD when the resolved primary lacks its data dir OR this id's def — a
 *     stale `primary_repo` (changed on main after the lane was cut) trips here
 *     rather than silently writing lane-adjacent state.
 *
 * Code routing (where a worker edits/commits SOURCE) stays separate on cwd /
 * `resolveWorkerRepos().targetRepo` — this seam owns STATE only. */
export function resolvePlanStateContext(
  id: string,
  project: string | null,
  format: OutputFormat | null,
): ProjectContext {
  const locate = resolveOwningProjectForId(id, project, format);
  if (project !== null) {
    return locate;
  }

  const isTask = isTaskId(id);
  const epicId = isTask ? epicIdFromTask(id) : id;
  const epicDef = loadJsonSafe(join(locate.dataDir, "epics", `${epicId}.json`));
  const stateRoot = realpathOr(
    (epicDef?.primary_repo as string | null | undefined) || locate.projectPath,
  );

  if (!hasDataDir(stateRoot) || !idExistsInProject(stateRoot, id, isTask)) {
    emitError(
      `plan state owner for ${id} is unusable: ${stateRoot} is missing its ` +
        "data dir or definition (a stale epic.primary_repo?)",
      format,
    );
  }

  return contextForRoot(stateRoot);
}

/** Resolve `p` to an absolute path then through symlinks, falling back to the
 * absolute form when it does not yet exist on disk. */
function realpathOr(p: string): string {
  const abs = resolvePath(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** True iff `id` (a task or epic id) has its definition JSON under `projectRoot`'s
 * data dir. A task checks `tasks/<id>.json`, an epic `epics/<id>.json`. */
function idExistsInProject(
  projectRoot: string,
  id: string,
  isTask: boolean,
): boolean {
  const dataDir = resolveDataDir(projectRoot);
  if (dataDir === null) {
    return false;
  }
  const sub = isTask ? "tasks" : "epics";
  return existsSync(join(dataDir, sub, `${id}.json`));
}

/** Expand a leading `~` and resolve to an absolute path — the `--project` branch
 * shared with epic rm. Operators pass tilde / relative forms; mirror
 * `Path(project).expanduser().resolve()`. */
function expandResolve(p: string): string {
  let expanded = p;
  if (p === "~" || p.startsWith("~/")) {
    const home = process.env.HOME;
    if (home) {
      expanded = home + p.slice(1);
    }
  }
  return resolvePath(expanded);
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] as string) : path;
}
