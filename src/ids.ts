// ID parsing — the port of planctl/ids.py:parse_id. epics relies on the
// unparseable-sorts-as-999 behavior: an id that fails the regex yields
// [null, null], which the sort comparator maps to 999 so it sorts LAST.

// Mirrors ID_REGEX: fn-<num>[-slug][.<task>]. The slug arm matches either a
// >=2-char [a-z0-9]-bounded run or a 1-3 char short token.
const ID_REGEX =
  /^fn-(\d+)(?:-[a-z0-9][a-z0-9-]*[a-z0-9]|-[a-z0-9]{1,3})?(?:\.(\d+))?$/;

/** Parse an id into [epicNum, taskNum]. [epic, null] for an epic id,
 * [epic, task] for a task id, [null, null] when unparseable. */
export function parseId(idStr: string): [number | null, number | null] {
  const match = ID_REGEX.exec(idStr);
  if (!match) {
    return [null, null];
  }
  const epic = Number.parseInt(match[1] as string, 10);
  const task = match[2] !== undefined ? Number.parseInt(match[2], 10) : null;
  return [epic, task];
}

/** True iff `s` is a task id (epic-num AND task-num both parse). Mirrors
 * ids.is_task_id. */
export function isTaskId(s: string): boolean {
  const [epic, task] = parseId(s);
  return epic !== null && task !== null;
}

/** True iff `s` is an epic id (epic-num parses, task-num absent). Mirrors
 * ids.is_epic_id. */
export function isEpicId(s: string): boolean {
  const [epic, task] = parseId(s);
  return epic !== null && task === null;
}

/** Extract the epic id from a task id by stripping the final `.<task>` segment.
 * Throws on a non-task id. Mirrors ids.epic_id_from_task. */
export function epicIdFromTask(taskId: string): string {
  const [epic, task] = parseId(taskId);
  if (epic === null || task === null) {
    throw new Error(`Invalid task ID: ${taskId}`);
  }
  const dot = taskId.lastIndexOf(".");
  return taskId.slice(0, dot);
}
