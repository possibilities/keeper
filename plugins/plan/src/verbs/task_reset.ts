// task reset — the port of run_task_reset.py. Resets a task to todo: clears the
// runtime sidecar under the task lock, empties the spec's Done summary + Evidence
// sections, nulls worker_done_at on the task JSON, and (with --cascade) resets
// every dependent task too. Then the parent epic rides the shared post-write
// integrity gate. reset IS a gate member: the gate re-validates the tree and the
// spine bumps the epic's updated_at, but the marker is never touched.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { findDependents } from "../deps.ts";
import { emitMutating } from "../emit.ts";
import { emitError, type OutputFormat } from "../format.ts";
import { epicIdFromTask } from "../ids.ts";
import { runSetter } from "../integrity_gate.ts";
import { resolvePlanStateContext } from "../project.ts";
import { ensureValidTaskSpec, patchTaskSection } from "../specs.ts";
import {
  atomicWrite,
  atomicWriteJson,
  LocalFileStateStore,
  loadJson,
  loadJsonSafe,
  nowIso,
} from "../store.ts";

interface ResetArgs {
  taskId: string;
  cascade: boolean;
  project: string | null;
  format: OutputFormat | null;
}

export function runTaskReset(args: ResetArgs): void {
  const { taskId, cascade, project, format } = args;

  const ctx = resolvePlanStateContext(taskId, project, format);
  const dataDir = ctx.dataDir;
  const stateStore = new LocalFileStateStore(ctx.stateDir);

  const taskPath = join(dataDir, "tasks", `${taskId}.json`);
  if (!existsSync(taskPath)) {
    emitError(`Task not found: ${taskId}`, format);
  }

  const resetSingleTask = (tid: string): void => {
    const tPath = join(dataDir, "tasks", `${tid}.json`);
    const tDef = loadJson(tPath);

    const now = nowIso();
    const newState = { status: "todo", updated_at: now };
    stateStore.withTaskLock(tid, () => {
      stateStore.saveRuntime(tid, newState);
    });

    const specPath = join(dataDir, "specs", `${tid}.md`);
    if (!existsSync(specPath)) {
      emitError(`Spec file not found: ${specPath}`, format);
    }

    let specContent = readFileSync(specPath, "utf-8");
    try {
      ensureValidTaskSpec(specContent);
      specContent = patchTaskSection(specContent, "## Done summary", "");
      specContent = patchTaskSection(specContent, "## Evidence", "");
      ensureValidTaskSpec(specContent);
    } catch (e) {
      emitError(
        `Task spec is malformed for ${tid}: ${(e as Error).message}`,
        format,
      );
    }

    atomicWrite(specPath, specContent, dataDir);

    tDef.updated_at = now;
    // Clear worker_done_at so a re-run stamps a fresh one and the task reads
    // as un-done again.
    tDef.worker_done_at = null;
    atomicWriteJson(tPath, tDef, dataDir);
  };

  const epicId = epicIdFromTask(taskId);
  const cascadeReset: string[] = [];

  runSetter(epicId, dataDir, {
    verb: "reset",
    hooks: {
      apply: () => {
        resetSingleTask(taskId);

        if (cascade) {
          const tasksDir = join(dataDir, "tasks");
          const allTasks: Record<string, { depends_on?: string[] }> = {};
          if (existsSync(tasksDir)) {
            const prefix = `${epicId}.`;
            for (const name of readdirSync(tasksDir).sort()) {
              if (!name.startsWith(prefix) || !name.endsWith(".json")) {
                continue;
              }
              const middle = name.slice(prefix.length, -".json".length);
              if (middle.length === 0 || middle.includes(".")) {
                continue;
              }
              const td = loadJsonSafe(join(tasksDir, name));
              if (td) {
                const tid =
                  typeof td.id === "string"
                    ? td.id
                    : name.slice(0, -".json".length);
                allTasks[tid] = {
                  depends_on: (td.depends_on as string[] | undefined) ?? [],
                };
              }
            }
          }
          for (const depTid of findDependents(taskId, allTasks)) {
            resetSingleTask(depTid);
            cascadeReset.push(depTid);
          }
        }
      },
    },
  });

  emitMutating(
    { task_id: taskId, status: "todo", cascade_reset: cascadeReset },
    { verb: "reset", target: taskId, repoRoot: ctx.projectPath },
  );
}
