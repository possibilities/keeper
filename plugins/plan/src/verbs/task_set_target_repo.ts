// task set-target-repo — persists the resolved target_repo on the task JSON, then
// uses the pre-gate hook to recompute epic.touched_repos from the union of every
// DIRECT-child task's target_repo (so the post-write integrity check sees the
// final tree) before the shared integrity gate runs. The marker is left untouched
// (arm-exclusive latch). The epic write and the task write ride one auto-commit
// (two files in the pathspec).

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { emitMutating } from "../emit.ts";
import { emitError, type OutputFormat } from "../format.ts";
import { epicIdFromTask } from "../ids.ts";
import { runSetter } from "../integrity_gate.ts";
import { resolveProject } from "../project.ts";
import {
  atomicWriteJson,
  loadJson,
  loadJsonSafe,
  nowIso,
  resolveUserPath,
} from "../store.ts";

interface SetTargetRepoArgs {
  taskId: string;
  path: string;
  format: OutputFormat | null;
}

export function runTaskSetTargetRepo(args: SetTargetRepoArgs): void {
  const { taskId, path: pathArg, format } = args;

  const ctx = resolveProject(format);
  const dataDir = ctx.dataDir;

  const taskPath = join(dataDir, "tasks", `${taskId}.json`);
  if (!existsSync(taskPath)) {
    emitError(`Task not found: ${taskId}`, format);
  }

  const resolved = resolveUserPath(pathArg);

  const epicId = epicIdFromTask(taskId);
  const epicPath = join(dataDir, "epics", `${epicId}.json`);

  // The parent epic may not exist — when it doesn't, the task write still lands
  // and no recompute/gate runs (there would be no epic tree to re-validate).
  // primary_repo for the emit's state_repo is read from the epic.
  let primaryRepo: string | null = null;

  if (!existsSync(epicPath)) {
    const taskDef = loadJson(taskPath);
    taskDef.target_repo = resolved;
    taskDef.updated_at = nowIso();
    atomicWriteJson(taskPath, taskDef, dataDir);
    emitMutating(
      { task_id: taskId, target_repo: resolved },
      {
        verb: "set-target-repo",
        target: taskId,
        repoRoot: ctx.projectPath,
        primaryRepo,
      },
    );
    return;
  }

  runSetter(epicId, dataDir, {
    verb: "set-target-repo",
    // updated_at is bumped in preGate (alongside touched_repos), so the gate
    // spine's tail is a no-op (stampUpdatedAt=false) and the marker is untouched.
    stampUpdatedAt: false,
    hooks: {
      apply: () => {
        const taskDef = loadJson(taskPath);
        taskDef.target_repo = resolved;
        taskDef.updated_at = nowIso();
        atomicWriteJson(taskPath, taskDef, dataDir);
      },
      // Pre-gate: recompute touched_repos from the union of direct-child
      // target_repos (this task's new value included) and write it onto the
      // epic JSON BEFORE the integrity gate runs. updated_at bumps here too.
      preGate: () => {
        const epicDef = loadJson(epicPath);
        const tasksDir = join(dataDir, "tasks");
        const prefix = `${epicId}.`;
        const targetRepos = new Set<string>();
        if (existsSync(tasksDir)) {
          for (const name of readdirSync(tasksDir).sort()) {
            if (!name.startsWith(prefix) || !name.endsWith(".json")) {
              continue;
            }
            const suffix = name.slice(prefix.length, -".json".length);
            // Direct children only: a single segment after the prefix.
            if (suffix.length === 0 || suffix.includes(".")) {
              continue;
            }
            const sibling = loadJsonSafe(join(tasksDir, name));
            const tr = sibling?.target_repo;
            if (typeof tr === "string" && tr) {
              targetRepos.add(tr);
            }
          }
        }
        epicDef.touched_repos = [...targetRepos].sort();
        epicDef.updated_at = nowIso();
        atomicWriteJson(epicPath, epicDef, dataDir);
      },
    },
  });

  primaryRepo =
    (loadJsonSafe(epicPath)?.primary_repo as string | null | undefined) ?? null;

  emitMutating(
    { task_id: taskId, target_repo: resolved },
    {
      verb: "set-target-repo",
      target: taskId,
      repoRoot: ctx.projectPath,
      primaryRepo,
    },
  );
}
