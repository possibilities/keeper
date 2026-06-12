// Data-normalization spine — the port of planctl/models.py's normalize/merge
// helpers. The read-only verbs consume mergeTaskState (absent runtime overlay
// -> status "todo") for status counting; normalizeEpic/normalizeTask land as
// spine utilities applying the same optional-field defaults Python does, so a
// later mutating-verb wave inherits the shape rather than re-deriving it.

export const SCHEMA_VERSION = 1;

/** Apply defaults for optional epic fields. Mirrors normalize_epic: scrub the
 * dead keys, then default every additive field. Mutates and returns `data`. */
export function normalizeEpic(
  data: Record<string, unknown>,
): Record<string, unknown> {
  for (const dead of ["draft", "audited_into", "auditor_done_at"]) {
    delete data[dead];
  }
  if (!("branch_name" in data)) {
    data.branch_name = "main";
  }
  if (!("depends_on_epics" in data)) {
    data.depends_on_epics = [];
  }
  if (!("last_validated_at" in data)) {
    data.last_validated_at = null;
  }
  if (!("primary_repo" in data)) {
    data.primary_repo = null;
  }
  if (!("touched_repos" in data)) {
    data.touched_repos = null;
  }
  if (!("closer_done_at" in data)) {
    data.closer_done_at = null;
  }
  if (!("close_reason" in data)) {
    data.close_reason = null;
  }
  if (!("snippets" in data)) {
    data.snippets = [];
  }
  if (!("bundles" in data)) {
    data.bundles = [];
  }
  if (!("queue_jump" in data)) {
    data.queue_jump = false;
  }
  if (!("created_by_close_of" in data)) {
    data.created_by_close_of = null;
  }
  return data;
}

/** Apply defaults for optional task fields. Mirrors normalize_task. Mutates
 * and returns `data`. */
export function normalizeTask(
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (!("priority" in data)) {
    data.priority = null;
  }
  if (!("depends_on" in data)) {
    data.depends_on = data.deps ?? [];
  }
  if (!("target_repo" in data)) {
    data.target_repo = null;
  }
  if (!("worker_done_at" in data)) {
    data.worker_done_at = null;
  }
  if (!("tier" in data)) {
    data.tier = null;
  }
  if (!("snippets" in data)) {
    data.snippets = [];
  }
  if (!("bundles" in data)) {
    data.bundles = [];
  }
  return data;
}

/** Merge a task definition with its runtime sidecar. Absent runtime defaults to
 * {status: "todo"}; runtime fields overwrite definition fields, then the merged
 * dict is normalized. Mirrors merge_task_state. */
export function mergeTaskState(
  definition: Record<string, unknown>,
  runtime: Record<string, unknown> | null,
): Record<string, unknown> {
  const overlay = runtime ?? { status: "todo" };
  const merged = { ...definition, ...overlay };
  normalizeTask(merged);
  return merged;
}
