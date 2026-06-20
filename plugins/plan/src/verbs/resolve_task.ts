// resolve-task verb — the port of planctl/run_resolve_task.py. A read-only
// routing lookup: validate the task id, resolve its owning project cwd-
// agnostically (roots discovery or --project), then return the routing subset
// (task_id, epic_id, project_path, target_repo, primary_repo, tier, worker_agent,
// status) with the readonly plan_invocation MERGED into the same payload line.
// tier is surfaced as an explicit JSON null when unset. Typed errors —
// BAD_TASK_ID / NOT_A_PROJECT / TASK_NOT_FOUND / AMBIGUOUS_TASK_ID — emit the
// {success:false, error:{code,message,details?}} envelope + exit 1, mutating
// nothing. Self-emits, so the dispatcher never fires the generic trailer.

import { existsSync, realpathSync } from "node:fs";
import { join, resolve as resolveAbs } from "node:path";

import { findProjectsWithTask } from "../discovery.ts";
import { emitReadonly } from "../emit.ts";
import { formatOutput, type OutputFormat } from "../format.ts";
import { epicIdFromTask, isTaskId } from "../ids.ts";
import { buildPlanctlInvocationReadonly } from "../invocation.ts";
import {
  mergeTaskState,
  normalizeTask,
  workerAgentForTier,
} from "../models.ts";
import { contextForRoot, type ProjectContext } from "../project.ts";
import { expectedWorkerCwd } from "../runtime_status.ts";
import { hasDataDir } from "../state_path.ts";
import { LocalFileStateStore, loadJson, loadJsonSafe } from "../store.ts";

/** Emit a typed resolve-task error envelope and exit 1. No plan_invocation —
 * a failed precondition mutates nothing. */
function emitResolveError(
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

/** Resolve the owning project for taskId cwd-agnostically. Any same-id
 * collision is surfaced as AMBIGUOUS_TASK_ID (no claimable filtering — this is
 * routing, not claiming). Mirrors _resolve_project_for_task. */
function resolveProjectForTask(
  taskId: string,
  project: string | null,
  format: OutputFormat | null,
): ProjectContext {
  if (project !== null) {
    const projectRoot = realpathOr(resolveAbs(expandUser(project)));
    if (!hasDataDir(projectRoot)) {
      emitResolveError(
        "NOT_A_PROJECT",
        `No planctl project found at ${projectRoot}. Run 'planctl init' first.`,
        format,
      );
    }
    const ctx = contextForRoot(projectRoot);
    if (!existsSync(join(ctx.dataDir, "tasks", `${taskId}.json`))) {
      emitResolveError(
        "TASK_NOT_FOUND",
        `Task not found in ${projectRoot}: ${taskId}`,
        format,
      );
    }
    return ctx;
  }

  const matches = findProjectsWithTask(taskId);
  if (matches.length === 0) {
    emitResolveError("TASK_NOT_FOUND", `Task not found: ${taskId}`, format);
  }
  if (matches.length === 1) {
    return contextForRoot(matches[0] as string);
  }
  emitResolveError(
    "AMBIGUOUS_TASK_ID",
    `Task ${taskId} exists in multiple projects; pass --project <path>.`,
    format,
    { candidates: matches },
  );
}

export function runResolveTask(opts: {
  taskId: string;
  project: string | null;
  format: OutputFormat | null;
}): void {
  const { taskId, project, format } = opts;

  if (!isTaskId(taskId)) {
    emitResolveError("BAD_TASK_ID", `Invalid task ID: ${taskId}`, format);
  }

  const ctx = resolveProjectForTask(taskId, project, format);

  const taskPath = join(ctx.dataDir, "tasks", `${taskId}.json`);
  const taskDef = normalizeTask(loadJson(taskPath));

  const epicId = epicIdFromTask(taskId);
  const epicPath = join(ctx.dataDir, "epics", `${epicId}.json`);
  const epicDef = existsSync(epicPath) ? (loadJsonSafe(epicPath) ?? {}) : {};

  const projPath = ctx.projectPath;
  const targetRepo = realpathOr(expectedWorkerCwd(taskDef, epicDef, projPath));
  const primaryRepo = realpathOr(
    (epicDef.primary_repo as string | null | undefined) || projPath,
  );

  const store = new LocalFileStateStore(ctx.stateDir);
  const runtime = store.loadRuntime(taskId);
  const merged = mergeTaskState(taskDef, runtime);
  const status = (merged.status as string | undefined) ?? "todo";

  const tier = (taskDef.tier as string | null) ?? null;

  const pc = buildPlanctlInvocationReadonly("resolve-task", projPath, taskId);
  emitReadonly(
    {
      task_id: taskId,
      epic_id: epicId,
      project_path: projPath,
      target_repo: targetRepo,
      primary_repo: primaryRepo,
      tier,
      worker_agent: workerAgentForTier(tier),
      status,
    },
    pc,
  );
}

/** realpath(p), falling back to the absolute path when it can't be resolved —
 * the Path(...).resolve() contract (resolve symlinks, but a non-existent path
 * still normalizes to absolute). */
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
