// resolve-task verb — the port of planctl/run_resolve_task.py. A read-only
// routing lookup: validate the task id, resolve its owning project cwd-
// agnostically (roots discovery or --project), then return the routing subset
// (task_id, epic_id, project_path, target_repo, primary_repo, tier, worker_model,
// worker_agent, status) with the readonly plan_invocation MERGED into the same
// payload line. tier + worker_model surface as explicit JSON null when unset.
// Typed errors —
// BAD_TASK_ID / NOT_A_PROJECT / TASK_NOT_FOUND / AMBIGUOUS_TASK_ID — emit the
// {success:false, error:{code,message,details?}} envelope + exit 1, mutating
// nothing. Self-emits, so the dispatcher never fires the generic trailer.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { emitReadonly } from "../emit.ts";
import { formatOutput, type OutputFormat } from "../format.ts";
import { epicIdFromTask, isTaskId } from "../ids.ts";
import { buildPlanInvocationReadonly } from "../invocation.ts";
import { mergeTaskState, normalizeTask, workerAgentFor } from "../models.ts";
import {
  annotateIdReadVantage,
  type ProjectContext,
  resolvePlanStateContext,
  tryResolveOwningProjectForId,
} from "../project.ts";
import { resolveWorkerRepos } from "../runtime_status.ts";
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

/** Resolve the STATE-bearing context for `taskId`, PHYSICALLY rooted at the
 * epic's primary_repo. LOCATE cwd-then-global (`--project` authoritative),
 * mapping a locate failure to resolve-task's typed envelope, then route STATE
 * through the central `resolvePlanStateContext` seam so the reported
 * primary_repo / state + the status read target PRIMARY even from a worktree
 * lane — and even when primary is OUTSIDE the configured roots. CODE routing
 * (target_repo) stays the lane seam, resolved separately. */
function resolveProjectForTask(
  taskId: string,
  project: string | null,
  format: OutputFormat | null,
): ProjectContext {
  const located = tryResolveOwningProjectForId(taskId, project);
  if (!located.ok) {
    switch (located.reason) {
      case "no_project":
        emitResolveError(
          "NOT_A_PROJECT",
          `No plan project found at ${located.projectRoot}. Run 'keeper plan init' first.`,
          format,
        );
        break;
      case "not_found":
        emitResolveError(
          "TASK_NOT_FOUND",
          `Task not found: ${located.id}`,
          format,
        );
        break;
      case "ambiguous":
        emitResolveError(
          "AMBIGUOUS_TASK_ID",
          `Task ${located.id} exists in multiple projects; pass --project <path>.`,
          format,
          { candidates: located.owners },
        );
        break;
    }
  }
  return resolvePlanStateContext(taskId, project, format);
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

  // Surface the weaker-vantage note the id-bearing resolution would drop, BEFORE
  // resolving — so a lane_no_state / inconclusive cwd annotates even when the
  // resolution then fails TASK_NOT_FOUND (the operator sees why the id is
  // missing). No-op under --project or a non-lane cwd.
  annotateIdReadVantage(project);

  const ctx = resolveProjectForTask(taskId, project, format);

  const taskPath = join(ctx.dataDir, "tasks", `${taskId}.json`);
  const taskDef = normalizeTask(loadJson(taskPath));

  const epicId = epicIdFromTask(taskId);
  const epicPath = join(ctx.dataDir, "epics", `${epicId}.json`);
  const epicDef = existsSync(epicPath) ? (loadJsonSafe(epicPath) ?? {}) : {};

  // target_repo follows the worker's lane (KEEPER_PLAN_WORKTREE override-aware)
  // via the runtime seam — CODE routing only. primary_repo / project_path are
  // the resolver's primary-rooted ctx, so the reported value EQUALS the physical
  // state site (never the lane), even when primary is outside the configured
  // roots.
  const projPath = ctx.projectPath;
  const primaryRepo = projPath;
  const { targetRepo } = resolveWorkerRepos(taskDef, epicDef, projPath);

  const store = new LocalFileStateStore(ctx.stateDir);
  const runtime = store.loadRuntime(taskId);
  const merged = mergeTaskState(taskDef, runtime);
  const status = (merged.status as string | undefined) ?? "todo";
  const dispatchedResponse: Record<string, string> =
    typeof runtime?.dispatch_constraint === "string" &&
    runtime.dispatch_constraint !== ""
      ? {
          dispatched_model:
            typeof runtime.dispatched_model === "string"
              ? runtime.dispatched_model
              : "",
          dispatched_tier:
            typeof runtime.dispatched_tier === "string"
              ? runtime.dispatched_tier
              : "",
          dispatch_constraint: runtime.dispatch_constraint,
        }
      : {};

  const tier = (taskDef.tier as string | null) ?? null;
  const model = (taskDef.model as string | null) ?? null;

  const pc = buildPlanInvocationReadonly("resolve-task", projPath, taskId);
  emitReadonly(
    {
      task_id: taskId,
      epic_id: epicId,
      project_path: projPath,
      target_repo: targetRepo,
      primary_repo: primaryRepo,
      tier,
      worker_model: model,
      ...dispatchedResponse,
      worker_agent: workerAgentFor(tier, model),
      status,
    },
    pc,
  );
}
