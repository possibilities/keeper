// Cross-CLI helper façade — the port of planctl/api.py's epic/task load helpers.
//
// loadEpic / loadTasksForEpic merge the committed def with the gitignored
// runtime sidecar and RAISE on a missing / half-written file (mirroring
// json.load), so callers handle the retry/skip exactly where Python catches
// FileNotFoundError / JSONDecodeError. taskSortKey / taskPriority pin the
// in-epic task ordering used by the list/ready/tasks read surface.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parseId } from "./ids.ts";
import { mergeEpicState, mergeTaskState, taskPriority } from "./models.ts";
import type { ProjectContext } from "./project.ts";
import { LocalFileStateStore, loadJson } from "./store.ts";

export { taskPriority };

/** Load an epic definition with its runtime sidecar merged in. Raises on an
 * absent or malformed epic JSON (loadJson throws). Mirrors api.load_epic — the
 * epic sidecar carries no overlay field today, so the merge is a normalize pass
 * kept symmetric with the task load path. */
export function loadEpic(
  project: ProjectContext,
  epicId: string,
): Record<string, unknown> {
  const epicPath = join(project.dataDir, "epics", `${epicId}.json`);
  const data = loadJson(epicPath);
  const stateStore = new LocalFileStateStore(project.stateDir);
  const epicRuntime = stateStore.loadEpicRuntime(epicId);
  return mergeEpicState(data, epicRuntime);
}

/** Load every task definition for `epicId` with runtime state merged in,
 * UNSORTED (use taskSortKey to order). Returns [] only when the tasks/ dir is
 * absent. Raises on a per-file race / half-write so the caller retries the whole
 * call. Mirrors api.load_tasks_for_epic — the `<epicId>.*.json` glob is sorted
 * at the call site for determinism across engines. */
export function loadTasksForEpic(
  project: ProjectContext,
  epicId: string,
): Record<string, unknown>[] {
  const tasksDir = join(project.dataDir, "tasks");
  if (!existsSync(tasksDir)) {
    return [];
  }
  const stateStore = new LocalFileStateStore(project.stateDir);
  const prefix = `${epicId}.`;

  // readdir order is arbitrary across engines — sort the matched filenames so
  // any downstream ordering that leaks listing order is deterministic.
  const names = readdirSync(tasksDir)
    .filter((n) => n.startsWith(prefix) && n.endsWith(".json"))
    .sort();

  const tasks: Record<string, unknown>[] = [];
  for (const name of names) {
    // Match Python's `glob(f"{epic_id}.*.json")`: the middle segment must be a
    // single task ordinal, not a deeper id — guard against `fn-1.2.extra.json`.
    const middle = name.slice(prefix.length, -".json".length);
    if (middle.length === 0 || middle.includes(".")) {
      continue;
    }
    const td = loadJson(join(tasksDir, name));
    const tid =
      typeof td.id === "string" ? td.id : name.slice(0, -".json".length);
    const runtime = stateStore.loadRuntime(tid);
    tasks.push(mergeTaskState(td, runtime));
  }
  return tasks;
}

/** Sort key for ordering tasks within an epic: the numeric `.M` suffix, or 999
 * for an unparseable id (sorts last). Mirrors api.task_sort_key — a one-tuple in
 * Python; a bare number suffices here since it's the sole component. */
export function taskSortKey(taskId: string): number {
  const [, taskNum] = parseId(taskId);
  return taskNum ?? 999;
}
