// unblock verb — the resume mirror of block.
//
// Flips a blocked task back to todo under lockTask: re-read runtime, error if not
// currently blocked, write the todo runtime state (status=todo, blocked_reason
// cleared) while preserving the claim history (assignee/claimed_at/claim_note/
// evidence). Mutates only gitignored state/, so it emits a readonly invocation
// (ZERO commits). The not-found / not-blocked gates use the flat emitError shape.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { emitReadonly } from "../emit.ts";
import { emitError, type OutputFormat } from "../format.ts";
import { isTaskId } from "../ids.ts";
import { buildPlanInvocationReadonly } from "../invocation.ts";
import { mergeTaskState } from "../models.ts";
import { resolveProject } from "../project.ts";
import { LocalFileStateStore, loadJsonSafe, nowIso } from "../store.ts";

interface UnblockArgs {
  taskId: string;
  format: OutputFormat | null;
}

export function runUnblock(args: UnblockArgs): void {
  const { taskId, format } = args;

  if (!isTaskId(taskId)) {
    emitError(`Invalid task ID: ${taskId}`, format);
  }

  const ctx = resolveProject(format);
  const dataDir = ctx.dataDir;
  const stateStore = new LocalFileStateStore(ctx.stateDir);

  const taskPath = join(dataDir, "tasks", `${taskId}.json`);
  if (!existsSync(taskPath)) {
    emitError(`Task not found: ${taskId}`, format);
  }

  const taskDef = loadJsonSafe(taskPath) ?? {};

  stateStore.withTaskLock(taskId, () => {
    const runtime = stateStore.loadRuntime(taskId);
    const merged = mergeTaskState(taskDef, runtime);
    const status = (merged.status as string) ?? "todo";

    if (status !== "blocked") {
      emitError(`Task ${taskId} is not blocked (status: ${status})`, format);
    }

    const now = nowIso();
    // Preserve the claim history exactly as block.ts keeps it — Python
    // dict.get(key, default): a present key keeps its stored value (even null);
    // only an absent key uses the default.
    const newState: Record<string, unknown> = {
      status: "todo",
      updated_at: now,
      blocked_reason: null,
      assignee: "assignee" in merged ? merged.assignee : null,
      claimed_at: "claimed_at" in merged ? merged.claimed_at : null,
      claim_note: "claim_note" in merged ? merged.claim_note : "",
      evidence: "evidence" in merged ? merged.evidence : null,
    };
    stateStore.saveRuntime(taskId, newState);
  });

  const pc = buildPlanInvocationReadonly("unblock", ctx.projectPath, taskId);
  emitReadonly({ task_id: taskId, status: "todo" }, pc);
}
