// Runtime-status overlay helpers — pure, no I/O. The byte-parity port of the
// cwd-derivation helpers in planctl/runtime_status.py. Deterministic given the
// same input records; resolve-task and the close-phase verbs read the expected
// worker/closer cwd off these.

/** Expected cwd for a worker dispatched for `task` in `epic`. Three-level
 * fallback: task.target_repo -> epic.primary_repo -> proj. Mirrors
 * _expected_worker_cwd: a null/empty target_repo (or null primary_repo) falls
 * through to the next level, so a record with both null lands on `proj`. */
export function expectedWorkerCwd(
  task: Record<string, unknown>,
  epic: Record<string, unknown>,
  proj: string,
): string {
  return (
    (task.target_repo as string | null | undefined) ||
    (epic.primary_repo as string | null | undefined) ||
    proj
  );
}

/** Expected cwd for a closer dispatched for `epic`. Two-level fallback:
 * epic.primary_repo -> proj. Mirrors _expected_closer_cwd. */
export function expectedCloserCwd(
  epic: Record<string, unknown>,
  proj: string,
): string {
  return (epic.primary_repo as string | null | undefined) || proj;
}
