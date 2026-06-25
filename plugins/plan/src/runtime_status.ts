// Runtime-status overlay helpers for the TS dispatcher (the sole plan runtime).
// expectedWorkerCwd reads the KEEPER_PLAN_WORKTREE override and so is NOT pure —
// see its note. The remaining helpers are deterministic given their inputs.
// resolve-task and the post-worker verbs read the expected worker/closer cwd off
// these.

/** The worktree-lane override: KEEPER_PLAN_WORKTREE. Empty/unset → undefined so
 * callers fall through to the ordinary fallback chain. Set producer-only at the
 * worker's child boundary (autopilot worktree mode), realpath-normalized so it
 * equals the worker's eventual process.cwd(); NEVER an event-log fold key, so
 * re-fold stays deterministic. Mirrors the clockOverride/getActor impure-helper
 * precedent in store.ts. */
export function worktreeOverride(): string | undefined {
  const v = process.env.KEEPER_PLAN_WORKTREE;
  return v ? v : undefined;
}

/** Expected cwd for a worker dispatched for `task` in `epic`. In worktree mode
 * the KEEPER_PLAN_WORKTREE lane override wins outright so concurrent lanes don't
 * collide in the shared main checkout; otherwise the three-level fallback
 * applies: task.target_repo -> epic.primary_repo -> proj (a null/empty level
 * falls through, so a record with both null lands on `proj`). Reads env via
 * worktreeOverride, so this helper is NOT pure. */
export function expectedWorkerCwd(
  task: Record<string, unknown>,
  epic: Record<string, unknown>,
  proj: string,
): string {
  return (
    worktreeOverride() ||
    (task.target_repo as string | null | undefined) ||
    (epic.primary_repo as string | null | undefined) ||
    proj
  );
}

/** Expected cwd for a closer dispatched for `epic`. Two-level fallback:
 * epic.primary_repo -> proj. NOT a production seam — the live closer resolves its
 * repo cwd-bound via resolveProject() (a cwd-walk), so launching it in the lane
 * cwd lands it there without an env override. Retained as a pure reference for
 * the fallback shape; do not route production resolution through it. */
export function expectedCloserCwd(
  epic: Record<string, unknown>,
  proj: string,
): string {
  return (epic.primary_repo as string | null | undefined) || proj;
}
