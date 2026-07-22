// Project resolution — the port of planctl/project.py.
//
// findGitRoot is a parent-walk for a `.git` entry (directory OR file, so a
// linked-worktree `.git` file counts), never honoring GIT_DIR. realpathSync
// matches Python's Path.resolve() symlink resolution (load-bearing on macOS,
// where the pytest tmp tree resolves /var -> /private/var). resolveProject
// hard-errors through emitError when no `.keeper/` data dir is present.
//
// A cwd inside a linked git worktree serves that lane's committed `.keeper`
// snapshot, which can lag the authoritative state repo. `classifyCwdVantage` is
// the single seam both the id-less (`resolveProject`) and the id-bearing
// (`resolveEpicGlobally`) resolvers route through, so the state repo is
// authoritative from every verb shape. Detection is positive-evidence — only a
// REGULAR-FILE `.git` resolving through its gitdir/commondir to a main checkout
// whose own `.git` samefile-backlinks the derived common dir AND positively
// carries a `.keeper/` redirects resolution there; anything weaker keeps the cwd
// resolution and annotates on stderr, never redirecting on a guess.

import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
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
 * STATE-AUTHORITY POLICY. The cwd-discovered root is classified for a LANE
 * VANTAGE (a linked worktree serving a potentially stale committed `.keeper`
 * snapshot). When the lane's main checkout is POSITIVELY derived (the
 * regular-`.git`-file + samefile backlink proof in `detectLaneVantage`) and
 * carries `.keeper`, the state repo — never the lane's lagging snapshot — is
 * authoritative for BOTH reads AND writes. A MUTATOR run from a lane cwd (e.g.
 * `set-branch`, `set-title`, `scaffold`, `refine-apply`) therefore writes and
 * auto-commits ONLY the main repo's `.keeper`, leaving the lane's own `.keeper`
 * byte-untouched and landing the commit in the MAIN repo's git history. This is
 * deliberate: a board has exactly one authoritative state home, and a worktree
 * lane is a source overlay, not a second state root. `--project <lane>` is the
 * sole intentional way to target a lane's own `.keeper` — an explicit override
 * never reaches here.
 *
 * A weaker vantage never redirects — it keeps the cwd resolution and annotates on
 * stderr, never a silent redirect on a guess:
 *  - a lane whose main checkout is derivable but carries no `.keeper`, and
 *  - a `.git` file / worktree structure that fails the positive-evidence proof
 *    (unreadable pointer, missing common dir, or a broken backlink),
 * each keep the cwd resolution and emit a stderr note.
 *
 * The note rides stderr, never stdout, so every read/inspection verb still emits
 * exactly one top-level JSON value. Explicit `--project` never reaches here. */
export function resolveProject(format: OutputFormat | null): ProjectContext {
  const { root: projectRoot, vantage } = classifyCwdVantage();

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

  annotateWeakVantage(vantage);

  return contextForRoot(projectRoot);
}

/** Emit the stderr note for a WEAKER lane vantage (lane_no_state / inconclusive)
 * — the one wording both the id-less `resolveProject` and the id-bearing verb
 * layer (`annotateIdReadVantage`) share, so "weaker vantage annotates, never
 * silently serves" is worded once. A `redirect` (a positively-derived state
 * repo) is announced by its own caller; `not_lane` emits nothing. */
function annotateWeakVantage(vantage: LaneVantage): void {
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
}

/** Surface the weaker-vantage note the id-BEARING verbs (show / cat /
 * refine-context / claim) would otherwise drop: they resolve cwd-then-global
 * through `resolveEpicGlobally`, which consumes only `classifyCwdVantage()
 * .effectiveRoot` (silently redirecting a proven lane, keeping cwd resolution
 * for a weaker one) and never annotates. Called at the verb entrypoint so a
 * lane_no_state / inconclusive cwd annotates on stderr just like `resolveProject`
 * — including when the subsequent resolution fails (e.g. TASK_NOT_FOUND), so the
 * operator sees WHY the id might be missing. Skipped under an explicit `--project`
 * (operator intent targets a concrete project) and for a non-lane cwd. */
export function annotateIdReadVantage(project: string | null): void {
  if (project !== null) {
    return;
  }
  annotateWeakVantage(classifyCwdVantage().vantage);
}

/** The lane-vantage outcome for a cwd-discovered project root. `not_lane` is an
 * ordinary checkout (a `.git` DIRECTORY, or no `.git`) — byte-identical current
 * behavior. `redirect` positively derived a main checkout carrying `.keeper`.
 * `lane_no_state` positively derived the main checkout but it lacks `.keeper`.
 * `inconclusive` is a `.git` FILE / worktree structure that failed the
 * positive-evidence proof (non-regular `.git`, unreadable pointer, missing common
 * dir, or a broken backlink) — annotate, never redirect. */
export type LaneVantage =
  | { kind: "not_lane" }
  | { kind: "redirect"; mainRoot: string }
  | { kind: "lane_no_state"; mainRoot: string }
  | { kind: "inconclusive" };

/** The cwd's git vantage — the SINGLE seam both the id-less (`resolveProject`)
 * and the id-bearing (`resolveEpicGlobally`'s cwd short-circuit) resolvers route
 * their state-authority redirect through, so a lane cwd resolves identically no
 * matter which verb shape reached it. `root` is the plain cwd project root
 * (`findProjectRoot`); `effectiveRoot` is the main STATE repo when `root` is a
 * redirect-eligible lane, else `root` itself. Pure — no stderr, no process
 * probes; callers own any annotation. */
export function classifyCwdVantage(): {
  root: string;
  vantage: LaneVantage;
  effectiveRoot: string;
} {
  const root = findProjectRoot();
  const vantage = detectLaneVantage(root);
  const effectiveRoot = vantage.kind === "redirect" ? vantage.mainRoot : root;
  return { root, vantage, effectiveRoot };
}

/** Classify an ARBITRARY repo path's git vantage (not just the cwd), through the
 * same positive-evidence `detectLaneVantage` seam. The source-staleness check
 * routes a worker's resolved TARGET repo through this so a lane target is
 * detected from the filesystem alone, independent of where the verb ran. */
export function classifyRepoVantage(repoPath: string): LaneVantage {
  return detectLaneVantage(realpathOr(repoPath));
}

/** The source-staleness warning for a worker whose TARGET source tree may lag
 * the state repo — persisted into the brief and echoed on both the claim and
 * worker-resume envelopes + stderr, so every entrypoint carries it identically.
 *
 * The target is a lane when `KEEPER_PLAN_WORKTREE` is set (the producer-proven
 * lane path the worker cds into) OR the resolved `targetRepo` classifies as a
 * positively-derived worktree lane (`redirect` / `lane_no_state`); a non-lane
 * target (an ordinary checkout) classifies `not_lane` and yields null. A lane
 * target carries the warning even when it EQUALS the state repo — an explicit
 * `--project <lane>` makes target and state equal while the lane's SOURCE still
 * lags its own local default, so target/state equality says nothing about source
 * freshness and never suppresses. The advice verifies suspected-absent source
 * against the TARGET repo's own local
 * default/main checkout — the state repo is STATE authority, never source
 * authority (in multi-repo work it can be a different git repository) — and
 * defers a base refresh to the producer; the worker never merges/pulls/rebases
 * the lane (base freshness is producer-owned). Conservative "may predate"
 * wording, no fabricated behind-count. */
export function sourceStalenessWarning(
  targetRepo: string,
  stateRepo: string,
): string | null {
  const producerLane = (process.env.KEEPER_PLAN_WORKTREE ?? "") !== "";
  const kind = producerLane ? null : classifyRepoVantage(targetRepo).kind;
  const targetIsLane =
    producerLane || kind === "redirect" || kind === "lane_no_state";
  if (!targetIsLane) {
    return null;
  }
  return (
    `the worker's target source tree ${targetRepo} is a worktree lane whose ` +
    `committed source may predate the state authority ${stateRepo}; before ` +
    "concluding cited source is absent, verify it against the target repo's " +
    "own local default/main checkout, and on confirmed staleness STOP and " +
    "defer for a producer base refresh — never merge, pull, or rebase the " +
    "lane yourself (base freshness is producer-owned)"
  );
}

/** Classify `projectRoot`'s git vantage from the filesystem alone (no `git`
 * subprocess), positive-evidence only. A `.git` DIRECTORY (or absent `.git`) is
 * positively not a lane. A linked worktree is marked by a `.git` REGULAR FILE (an
 * lstat: a symlink or any other node type is NOT positive evidence). Its
 * `gitdir:` pointer leads to the worktree git dir, whose `commondir` leads to the
 * main checkout's git dir — which MUST exist and be a directory. The redirect
 * fires ONLY when the derived main toplevel's OWN `.git` resolves (samefile) to
 * that SAME common git dir, so a forged `commondir` pointing at an unrelated
 * directory whose parent merely carries a `.keeper/` is rejected as inconclusive.
 * A proven main toplevel carrying `.keeper` redirects; one without is
 * `lane_no_state`; every failed proof is `inconclusive`. */
function detectLaneVantage(projectRoot: string): LaneVantage {
  const gitPath = join(projectRoot, ".git");
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(gitPath);
  } catch {
    return { kind: "not_lane" };
  }
  // A `.git` DIRECTORY is its own repo — positively not a lane.
  if (st.isDirectory()) {
    return { kind: "not_lane" };
  }
  // A linked-worktree marker is a REGULAR FILE. A symlink (or any other node
  // type) is forgeable indirection, not positive evidence — inconclusive.
  if (!st.isFile()) {
    return { kind: "inconclusive" };
  }

  const worktreeGitDir = readGitdirPointer(gitPath, projectRoot);
  if (worktreeGitDir === null) {
    return { kind: "inconclusive" };
  }
  const commonGitDir = readCommonDir(worktreeGitDir);
  if (commonGitDir === null) {
    return { kind: "inconclusive" };
  }
  // The common git dir must EXIST and be a directory (the main checkout's `.git`).
  if (!isDirectoryPath(commonGitDir)) {
    return { kind: "inconclusive" };
  }

  // The common git dir's parent is the candidate main toplevel. A structure
  // resolving back onto the lane is a no-op, not a lane.
  const mainRoot = realpathOr(dirname(commonGitDir));
  if (mainRoot === projectRoot) {
    return { kind: "not_lane" };
  }
  // Backlink proof (samefile): the main toplevel's OWN `.git` must resolve to the
  // SAME node as the derived common git dir. A forged `commondir` pointing at an
  // unrelated directory fails here — no redirect on a guess.
  if (!sameFile(join(mainRoot, ".git"), commonGitDir)) {
    return { kind: "inconclusive" };
  }
  return hasDataDir(mainRoot)
    ? { kind: "redirect", mainRoot }
    : { kind: "lane_no_state", mainRoot };
}

/** True iff `p` exists and is a directory (following symlinks); false on any
 * stat error. */
function isDirectoryPath(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Samefile check: `a` and `b` resolve (through symlinks) to the SAME path.
 * False when either does not exist — a non-resolvable node is never proof. */
function sameFile(a: string, b: string): boolean {
  let ra: string;
  let rb: string;
  try {
    ra = realpathSync(a);
    rb = realpathSync(b);
  } catch {
    return false;
  }
  return ra === rb;
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
