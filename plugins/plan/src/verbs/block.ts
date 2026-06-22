// block verb — the port of planctl/run_block.py.
//
// Marks a task blocked under lockTask: re-read runtime, error if done, write the
// blocked runtime state (status=blocked, blocked_reason), then clear the work
// marker (only if it names this task). Resolves the project cwd-based via
// resolveProject (unlike claim's discovery). Mutates only gitignored state/, so
// it emits a readonly invocation (ZERO commits). The not-found / done gates use
// the flat emitError shape (NOT claim's nested typed envelope).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { emitReadonly } from "../emit.ts";
import { emitError, type OutputFormat } from "../format.ts";
import { isTaskId } from "../ids.ts";
import { buildPlanInvocationReadonly } from "../invocation.ts";
import { mergeTaskState } from "../models.ts";
import { resolveProject } from "../project.ts";
import { clearWorkMarker } from "../session_markers.ts";
import { LocalFileStateStore, loadJsonSafe, nowIso } from "../store.ts";

interface BlockArgs {
  taskId: string;
  reason: string | null;
  reasonFile: string | null;
  format: OutputFormat | null;
}

export function runBlock(args: BlockArgs): void {
  const { taskId, reason, reasonFile, format } = args;

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

  let reasonText = "";
  if (reason) {
    reasonText = reason;
  } else if (reasonFile) {
    reasonText = readFileSync(reasonFile, "utf-8");
  }

  stateStore.withTaskLock(taskId, () => {
    const runtime = stateStore.loadRuntime(taskId);
    const merged = mergeTaskState(taskDef, runtime);
    const status = (merged.status as string) ?? "todo";

    if (status === "done") {
      emitError(`Task ${taskId} is done and cannot be blocked`, format);
    }

    const now = nowIso();
    // Python dict.get(key, default): a present key keeps its stored value (even
    // null); only an absent key uses the default. Match that for claim_note's ""
    // default so a stored-null is not coerced.
    const newState: Record<string, unknown> = {
      status: "blocked",
      updated_at: now,
      blocked_reason: reasonText,
      assignee: "assignee" in merged ? merged.assignee : null,
      claimed_at: "claimed_at" in merged ? merged.claimed_at : null,
      claim_note: "claim_note" in merged ? merged.claim_note : "",
      evidence: "evidence" in merged ? merged.evidence : null,
    };
    stateStore.saveRuntime(taskId, newState);
  });

  // Clear this session's work marker — only if it names this task. Success-path
  // only, fail-open.
  clearWorkMarker(taskId);

  const pc = buildPlanInvocationReadonly("block", ctx.projectPath, taskId);
  emitReadonly(
    { task_id: taskId, status: "blocked", blocked_reason: reasonText },
    pc,
  );
}
