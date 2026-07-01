// task set-tier — the port of run_task_set_tier.py. Persists the worker reasoning
// tier on the task JSON, gated on the configured efforts. NOT a restamp member (runtime
// detail, not validation-relevant structure), so it writes straight through the
// mutating seam and never touches last_validated_at. The emit verb is
// "task-set-tier" (distinct op + subject key from the section setters).

import { existsSync } from "node:fs";
import { join } from "node:path";

import { emitMutating } from "../emit.ts";
import { emitError, type OutputFormat } from "../format.ts";
import { isTaskId } from "../ids.ts";
import { configuredEfforts, normalizeTask } from "../models.ts";
import { resolveProject } from "../project.ts";
import { atomicWriteJson, loadJson, nowIso } from "../store.ts";

interface SetTierArgs {
  taskId: string;
  tier: string;
  format: OutputFormat | null;
}

export function runTaskSetTier(args: SetTierArgs): void {
  const { taskId, tier, format } = args;

  if (!isTaskId(taskId)) {
    emitError(`Invalid task ID: ${taskId}`, format);
  }
  const efforts = configuredEfforts();
  if (!efforts.includes(tier)) {
    emitError(
      `Invalid tier: '${tier}'. Must be one of: ${efforts.join(", ")}`,
      format,
    );
  }

  const ctx = resolveProject(format);
  const dataDir = ctx.dataDir;

  const taskPath = join(dataDir, "tasks", `${taskId}.json`);
  if (!existsSync(taskPath)) {
    emitError(`Task not found: ${taskId}`, format);
  }

  const taskDef = normalizeTask(loadJson(taskPath));
  const now = nowIso();
  taskDef.tier = tier;
  taskDef.updated_at = now;
  atomicWriteJson(taskPath, taskDef, dataDir);

  emitMutating(
    { task_id: taskId, tier },
    { verb: "task-set-tier", target: taskId, repoRoot: ctx.projectPath },
  );
}
