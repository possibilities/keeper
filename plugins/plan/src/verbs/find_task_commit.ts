// find-task-commit verb — the port of planctl/run_find_task_commit.py. A
// read-only, task-keyed sibling of resolve-task: wraps the shared
// findCommitGroups native trailer scan and emits the keeper-compatible FLAT
// envelope the worker's predecessor-detection consumes:
//
//   {success: true, commits: [{sha: "<%H>", repo: "<abs-path>"}, ...]}
//
// The grouped [{repo, shas}] return is flattened to a single commits list —
// repo-outer first-seen order preserved, per-repo grep order preserved, shas
// already deduped within a group. Field names are sha/repo (NOT sha256/
// repo_path) for byte-compat with the harness-drop predecessor-detection.
//
// A clean miss is a normal empty success (commits:[], exit 0). The verb fails
// loud (COMMIT_LOOKUP_FAILED, exit 1, details.broken_repos) ONLY when every repo
// in the scan set is missing or not a git repo (AllReposBrokenError).
//
// Read-only: mutates nothing — self-emits the readonly invocation (files=null),
// so the dispatcher never fires the generic trailer. On the error path it emits
// the typed envelope + exit 1 (no invocation line — a failed precondition or
// all-broken scan mutates nothing).

import { existsSync, realpathSync } from "node:fs";
import { join, resolve as resolveAbs } from "node:path";

import {
  AllReposBrokenError,
  type CommitGroupResult,
  findCommitGroups,
} from "../commit_lookup.ts";
import { findProjectsWithTask } from "../discovery.ts";
import { emitReadonly } from "../emit.ts";
import { formatOutput, type OutputFormat } from "../format.ts";
import { epicIdFromTask, isTaskId } from "../ids.ts";
import { buildPlanctlInvocationReadonly } from "../invocation.ts";
import { contextForRoot, type ProjectContext } from "../project.ts";
import { hasDataDir } from "../state_path.ts";
import { loadJsonSafe } from "../store.ts";

/** Emit a typed find-task-commit error envelope and exit 1. Shape
 * {success:false, error:{code,message,details?}} — no planctl_invocation line.
 * Mirrors _emit_find_task_commit_error. */
function emitFindTaskCommitError(
  code: string,
  message: string,
  format: OutputFormat | null,
  details?: Record<string, unknown>,
): never {
  const error: Record<string, unknown> = { code, message };
  if (details !== undefined) {
    error.details = details;
  }
  formatOutput({ success: false, error }, format);
  process.exit(1);
}

/** Resolve the owning project for `taskId` cwd-agnostically. --project override
 * resolves directly (NOT_A_PROJECT / TASK_NOT_FOUND); else roots discovery via
 * findProjectsWithTask (TASK_NOT_FOUND on a miss, AMBIGUOUS_TASK_ID on a same-id
 * collision). Mirrors _resolve_project_for_task. */
function resolveProjectForTask(
  taskId: string,
  project: string | null,
  format: OutputFormat | null,
): ProjectContext {
  if (project !== null) {
    const projectRoot = realpathOr(resolveAbs(expandUser(project)));
    if (!hasDataDir(projectRoot)) {
      emitFindTaskCommitError(
        "NOT_A_PROJECT",
        `No planctl project found at ${projectRoot}. Run 'planctl init' first.`,
        format,
      );
    }
    const ctx = contextForRoot(projectRoot);
    if (!existsSync(join(ctx.dataDir, "tasks", `${taskId}.json`))) {
      emitFindTaskCommitError(
        "TASK_NOT_FOUND",
        `Task not found in ${projectRoot}: ${taskId}`,
        format,
      );
    }
    return ctx;
  }

  const matches = findProjectsWithTask(taskId);
  if (matches.length === 0) {
    emitFindTaskCommitError(
      "TASK_NOT_FOUND",
      `Task not found: ${taskId}`,
      format,
    );
  }
  if (matches.length === 1) {
    return contextForRoot(matches[0] as string);
  }
  emitFindTaskCommitError(
    "AMBIGUOUS_TASK_ID",
    `Task ${taskId} exists in multiple projects; pass --project <path>.`,
    format,
    { candidates: matches },
  );
}

export function runFindTaskCommit(opts: {
  taskId: string;
  project: string | null;
  format: OutputFormat | null;
}): void {
  const { taskId, project, format } = opts;

  // 1. validate id (so epicIdFromTask's throw path is unreachable).
  if (!isTaskId(taskId)) {
    emitFindTaskCommitError(
      "BAD_TASK_ID",
      `Invalid task ID: ${taskId}`,
      format,
    );
  }

  // 2. resolve owning project cwd-agnostically (roots discovery or --project).
  const ctx = resolveProjectForTask(taskId, project, format);
  const dataDir = ctx.dataDir;

  // 3. derive epic id; read the scan-set seeds off the epic record.
  const epicId = epicIdFromTask(taskId);
  const epicPath = join(dataDir, "epics", `${epicId}.json`);
  const epicDef = existsSync(epicPath) ? (loadJsonSafe(epicPath) ?? {}) : {};
  const primaryRepo = realpathOr(
    (epicDef.primary_repo as string | null | undefined) || ctx.projectPath,
  );
  const touchedRepos = epicDef.touched_repos as string[] | null | undefined;

  // 4. native trailer scan; flatten the grouped result to the flat
  //    keeper-compatible commits list. A clean miss is [] (exit 0);
  //    all-repos-broken raises and maps to COMMIT_LOOKUP_FAILED (exit 1).
  let groups: CommitGroupResult[];
  try {
    groups = findCommitGroups([taskId], primaryRepo, touchedRepos);
  } catch (exc) {
    if (exc instanceof AllReposBrokenError) {
      emitFindTaskCommitError(
        "COMMIT_LOOKUP_FAILED",
        "commit-trailer scan found no usable repo: every repo in the " +
          "scan set is missing or not a git repo",
        format,
        { broken_repos: exc.brokenRepos },
      );
    }
    throw exc;
  }

  const commits = groups.flatMap((group) =>
    group.shas.map((sha) => ({ sha, repo: group.repo })),
  );

  const pc = buildPlanctlInvocationReadonly(
    "find-task-commit",
    ctx.projectPath,
    taskId,
  );
  emitReadonly({ commits }, pc);
}

/** realpath(p), falling back to the absolute path when it can't be resolved. */
function realpathOr(p: string): string {
  const abs = resolveAbs(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function expandUser(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    const home = process.env.HOME ?? "";
    return home + p.slice(1);
  }
  return p;
}
