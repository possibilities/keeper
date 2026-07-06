// epic rm — the byte-parity port of planctl/run_epic_rm.py.
//
// The sanctioned delete verb: physically unlink every artifact an epic owns
// (epic JSON, epic + task spec markdowns, task JSONs, runtime state, lock
// files) and auto-commit the deletions into the OWNING repo's data dir.
//
// THE LOAD-BEARING ORDERING (the whole deletion-commit mechanism): the commit
// seam stages touched ∩ dirty, where touched paths come from the session log
// recordTouched writes. An unlink does NOT record-touch itself, so a naive
// delete loop leaves deletions out of the staged pathspec and silently never
// commits them. We therefore recordTouched EVERY path BEFORE unlinking it.
//
// State resolution routes through the central resolvePlanStateContext seam: it
// locates cwd-then-global (or honors --project) then PHYSICALLY roots the unlink
// set + commit at the epic's primary_repo, so a lane-run deletes PRIMARY's
// artifacts rather than the lane's checked-out defs. epic.primary_repo is also
// read off the def BEFORE the unlink for the commit's state_repo trailer. NOT an
// integrity-gate member — nothing to gate once the epic ceases to exist. No
// id-allocation lock (delete-only, no minting).

import {
  existsSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join, relative, resolve as resolvePath } from "node:path";

import { emitMutating, emitReadonly } from "../emit.ts";
import { emitError, type OutputFormat } from "../format.ts";
import { buildPlanInvocationReadonly } from "../invocation.ts";
import { mergeTaskState } from "../models.ts";
import { type ProjectContext, resolvePlanStateContext } from "../project.ts";
import { DATA_DIR_NAMES } from "../state_path.ts";
import { LocalFileStateStore, loadJsonSafe, recordTouched } from "../store.ts";

// Traversal guard: only filename-safe characters before we glob/unlink. Any
// character that could break out of the data dir's specs/ etc. is rejected here.
const EPIC_ID_PATH_RE = /^[A-Za-z0-9_-]+$/;

interface EpicRmArgs {
  epicId: string;
  force: boolean;
  dryRun: boolean;
  project: string | null;
  format: OutputFormat | null;
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] as string) : path;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Sorted glob of `<dir>/<prefix>` entries matching a suffix pattern. Mirrors
 * Path.glob over a missing dir (yields nothing). */
function globSorted(dir: string, test: (name: string) => boolean): string[] {
  if (!isDir(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter(test)
    .sort()
    .map((name) => join(dir, name));
}

/** Sorted list of every path belonging to *epicId*. Missing files/dirs are
 * simply absent. Mirrors _collect_unlink_set. */
function collectUnlinkSet(epicId: string, ctx: ProjectContext): string[] {
  const dataDir = ctx.dataDir;
  const stateDir = ctx.stateDir;
  const paths: string[] = [];

  const epicJson = join(dataDir, "epics", `${epicId}.json`);
  if (existsSync(epicJson)) {
    paths.push(epicJson);
  }

  const specsDir = join(dataDir, "specs");
  if (isDir(specsDir)) {
    const epicSpec = join(specsDir, `${epicId}.md`);
    if (existsSync(epicSpec)) {
      paths.push(epicSpec);
    }
    paths.push(
      ...globSorted(
        specsDir,
        (n) => n.startsWith(`${epicId}.`) && n.endsWith(".md"),
      ),
    );
  }

  const tasksDir = join(dataDir, "tasks");
  paths.push(
    ...globSorted(
      tasksDir,
      (n) => n.startsWith(`${epicId}.`) && n.endsWith(".json"),
    ),
  );

  const stateTasksDir = join(stateDir, "tasks");
  paths.push(
    ...globSorted(
      stateTasksDir,
      (n) => n.startsWith(`${epicId}.`) && n.endsWith(".state.json"),
    ),
  );

  const stateLocksDir = join(stateDir, "locks");
  paths.push(
    ...globSorted(
      stateLocksDir,
      (n) => n.startsWith(`${epicId}.`) && n.endsWith(".lock"),
    ),
  );

  // Dedupe preserving insertion order.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const p of paths) {
    if (seen.has(p)) {
      continue;
    }
    seen.add(p);
    unique.push(p);
  }
  return unique;
}

/** Task ids that are in_progress or hold a lock file. Mirrors
 * _collect_live_tasks (narrowed to the statuses that actually block rm). */
function collectLiveTasks(epicId: string, ctx: ProjectContext): string[] {
  const live: string[] = [];
  const dataDir = ctx.dataDir;
  const stateStore = new LocalFileStateStore(ctx.stateDir);

  const tasksDir = join(dataDir, "tasks");
  for (const f of globSorted(
    tasksDir,
    (n) => n.startsWith(`${epicId}.`) && n.endsWith(".json"),
  )) {
    const taskDef = loadJsonSafe(f);
    if (taskDef === null) {
      continue;
    }
    const tid = (taskDef.id as string | undefined) ?? stem(f, ".json");
    const runtime = stateStore.loadRuntime(tid);
    const merged = mergeTaskState(taskDef, runtime);
    if (merged.status === "in_progress") {
      live.push(`${tid} (in_progress)`);
    }
  }

  const locksDir = join(ctx.stateDir, "locks");
  for (const lock of globSorted(
    locksDir,
    (n) => n.startsWith(`${epicId}.`) && n.endsWith(".lock"),
  )) {
    const tid = stem(lock, ".lock");
    const entry = `${tid} (locked)`;
    if (!live.includes(entry)) {
      live.push(entry);
    }
  }

  return live;
}

/** Ids of other epics in the same project whose depends_on_epics references
 * *epicId*. Surfaced as a non-blocking warning. Mirrors
 * _collect_dangling_dependents. */
function collectDanglingDependents(
  epicId: string,
  ctx: ProjectContext,
): string[] {
  const epicsDir = join(ctx.dataDir, "epics");
  const dependents: string[] = [];
  for (const f of globSorted(
    epicsDir,
    (n) => n.startsWith("fn-") && n.endsWith(".json"),
  )) {
    if (stem(f, ".json") === epicId) {
      continue;
    }
    const epicDef = loadJsonSafe(f);
    if (!epicDef) {
      continue;
    }
    const deps = (epicDef.depends_on_epics as string[] | undefined) ?? [];
    if (deps.includes(epicId)) {
      dependents.push((epicDef.id as string | undefined) ?? stem(f, ".json"));
    }
  }
  return dependents;
}

function stem(path: string, ext: string): string {
  const base = basename(path);
  return base.endsWith(ext) ? base.slice(0, -ext.length) : base;
}

export function runEpicRm(args: EpicRmArgs): void {
  const { epicId, force, dryRun, project, format } = args;

  // Traversal guard before we touch the filesystem.
  if (!EPIC_ID_PATH_RE.test(epicId || "")) {
    emitError(`Invalid epic id: ${pyRepr(epicId)}`, format);
  }

  // Route through the central state seam: a lane-run resolves the destructive
  // unlink set + commit to the epic's PRIMARY repo (never the lane's checked-out
  // defs, which would orphan primary's artifacts). `--project` stays
  // authoritative; a missing/stale primary fails loud rather than touching the
  // lane.
  const ctx = resolvePlanStateContext(epicId, project, format);
  const dataDir = ctx.dataDir;

  // Read epic.primary_repo BEFORE collecting/unlinking — the commit routes by
  // it, and the epic JSON is part of the unlink set.
  const epicPath = join(dataDir, "epics", `${epicId}.json`);
  const epicDef = loadJsonSafe(epicPath) ?? {};
  const primaryRepo =
    (epicDef.primary_repo as string | null | undefined) ?? null;

  // Guard: refuse if any task is in_progress or holds a lock unless --force.
  if (!force) {
    const live = collectLiveTasks(epicId, ctx);
    if (live.length > 0) {
      emitError(
        `Cannot rm ${epicId}: ${live.length} task(s) live: ${live.join(", ")}. ` +
          "Re-run with --force to override.",
        format,
      );
    }
  }

  const unlinkSet = collectUnlinkSet(epicId, ctx);
  const dependents = collectDanglingDependents(epicId, ctx);

  // Repo-relative POSIX paths for the envelope payload.
  const repoRoot = ctx.projectPath;
  const relPaths: string[] = [];
  for (const p of unlinkSet) {
    relPaths.push(toRepoRel(p, repoRoot));
  }

  const warnings: string[] = [];
  if (dependents.length > 0) {
    warnings.push(
      `${dependents.length} dependent epic(s) will become dangling: ${dependents.join(", ")}`,
    );
  }

  // Count only task DEFINITION JSONs (tasks/<id>.M.json).
  const taskCount = unlinkSet.filter((p) => isTaskDefJson(p)).length;

  if (dryRun) {
    // No writes, no commit. Routes through a readonly invocation (mirrors
    // Python's emit({...}) whose click decorator emits its own read-only line).
    const pc = buildPlanInvocationReadonly("rm", ctx.projectPath, epicId);
    emitReadonly(
      {
        epic_id: epicId,
        dry_run: true,
        removed_files: relPaths,
        task_count: taskCount,
        dependents,
        warnings,
      },
      pc,
    );
    return;
  }

  // Delete: record-then-unlink per path so the auto-commit picks the deletion
  // up via touched ∩ dirty. We pass dataDir explicitly so the recorder never
  // has to resolve the about-to-be-deleted file. Missing files are idempotent.
  for (const p of unlinkSet) {
    try {
      recordTouched(p, dataDir);
    } catch {
      // belt-and-suspenders: a recorder bug never strands a partial delete.
    }
    try {
      unlinkSync(p);
    } catch {
      // idempotent: already cleared / racy concurrent unlink.
    }
  }

  emitMutating(
    {
      epic_id: epicId,
      removed_files: relPaths,
      task_count: taskCount,
      dependents,
      warnings,
    },
    {
      verb: "rm",
      target: epicId,
      repoRoot: ctx.projectPath,
      primaryRepo,
    },
  );
}

/** True iff `p` is a tasks/<id>.M.json directly under the `.keeper/` data dir.
 * Mirrors the Python p.parent.name == "tasks" and p.parent.parent.name ==
 * data-dir check. */
function isTaskDefJson(p: string): boolean {
  const parts = resolvePath(p).split("/");
  return (
    parts.length >= 3 &&
    parts[parts.length - 2] === "tasks" &&
    DATA_DIR_NAMES.includes(parts[parts.length - 3] as string)
  );
}

/** Path relative to repoRoot in POSIX form, or the POSIX absolute path when it
 * lies outside the root (the Python relative_to ValueError fallback). */
function toRepoRel(p: string, repoRoot: string): string {
  const rel = relative(resolveReal(repoRoot), resolveReal(p));
  if (rel.startsWith("..")) {
    return resolvePath(p).split("\\").join("/");
  }
  return rel.split("\\").join("/");
}

/** realpath when resolvable, else the plain absolute path. */
function resolveReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolvePath(p);
  }
}

/** Python !r for a string id in the traversal-guard message. */
function pyRepr(v: string): string {
  return `'${v}'`;
}
