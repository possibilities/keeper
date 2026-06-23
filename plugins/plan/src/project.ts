// Project resolution — the port of planctl/project.py.
//
// findGitRoot is a parent-walk for a `.git` entry (directory OR file, so a
// linked-worktree `.git` file counts), never honoring GIT_DIR. realpathSync
// matches Python's Path.resolve() symlink resolution (load-bearing on macOS,
// where the pytest tmp tree resolves /var -> /private/var). resolveProject
// hard-errors through emitError when no `.keeper/` data dir is present.

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";

import { resolveEpicGlobally } from "./discovery.ts";
import { emitError, type OutputFormat } from "./format.ts";
import { epicIdFromTask, isTaskId } from "./ids.ts";
import {
  hasDataDir,
  resolveDataDir,
  resolveDataDirOrDefault,
} from "./state_path.ts";

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
 * `.keeper/` data dir is present. `format`
 * selects the error envelope's serialization. */
export function resolveProject(format: OutputFormat | null): ProjectContext {
  const projectRoot = findProjectRoot();

  if (!hasDataDir(projectRoot)) {
    emitError("No plan project found. Run 'keeper plan init' first.", format);
  }

  return contextForRoot(projectRoot);
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

/** Resolve a `--project` override to a validated project root for the read-only
 * trailer, mirroring the per-verb --project branch: the flag is expanded with
 * `expandUser` (tilde form) BEFORE the absolute check, so a `~/proj` form agrees
 * with the verb. An absolute path whose data dir exists resolves to its
 * realpath; anything else (unset, relative, or not a project) returns null so the
 * caller falls back to cwd resolution. Trailer-only — it never errors, since the
 * verb already validated the flag. */
export function trailerProjectRoot(project: string | null): string | null {
  if (project === null) {
    return null;
  }
  const expanded = expandUser(project);
  if (!isAbsolute(expanded)) {
    return null;
  }
  let root: string;
  try {
    root = realpathSync(expanded);
  } catch {
    root = expanded;
  }
  return hasDataDir(root) ? root : null;
}

/** Expand a leading `~` / `~/` to $HOME, matching the verb's --project branch. */
function expandUser(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return (process.env.HOME ?? "") + p.slice(1);
  }
  return p;
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] as string) : path;
}
