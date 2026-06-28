// Runtime-status overlay helpers for the TS dispatcher (the sole plan runtime).
// resolveWorkerRepos is the CODE-routing seam: it resolves `targetRepo` (the
// worker's lane in worktree mode) by reading the KEEPER_PLAN_WORKTREE override
// via expectedWorkerCwd, and so is NOT pure. State verbs (claim, done, reconcile,
// resolve-task) take their STATE-bearing primary_repo / state_repo from
// resolvePlanStateContext (the primary-rooted ctx), consuming only `targetRepo`
// here; `primaryRepo` is retained for worker-resume until it migrates. The
// remaining helpers are deterministic given their inputs.

import { realpathSync } from "node:fs";
import { resolve as resolveAbs } from "node:path";

/** The worktree-lane override: KEEPER_PLAN_WORKTREE. Empty/unset → undefined so
 * callers fall through to the ordinary fallback chain. Set producer-only at the
 * worker's child boundary (autopilot worktree mode), realpath-normalized so it
 * equals the worker's eventual process.cwd(); this PATH is NEVER an event-log
 * fold key, so re-fold stays deterministic. (Its sibling KEEPER_PLAN_WORKTREE_BRANCH
 * — the lane BRANCH, not consumed here — IS captured as the durable `jobs.worktree`
 * marker; only the path dangles at finalize.) Mirrors the clockOverride/getActor
 * impure-helper precedent in store.ts. */
export function worktreeOverride(): string | undefined {
  const v = process.env.KEEPER_PLAN_WORKTREE;
  return v ? v : undefined;
}

/** realpath(p), falling back to the absolute path when it can't be resolved —
 * the Path(...).resolve() contract (resolve symlinks, but a non-existent path
 * still normalizes to absolute). The ONE normalization the seam applies, so the
 * value a worker's pwd check compares against has a single definition. Private:
 * runtime emitters get the normalized pair from resolveWorkerRepos, never this. */
function realpathOr(p: string): string {
  const abs = resolveAbs(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** Expected cwd for a worker dispatched for `task` in `epic` — the raw,
 * un-normalized three-level fallback. In worktree mode the KEEPER_PLAN_WORKTREE
 * lane override wins outright so concurrent lanes don't collide in the shared
 * main checkout; otherwise: task.target_repo -> epic.primary_repo -> proj (a
 * null/empty level falls through, so a record with both null lands on `proj`).
 * Reads env via worktreeOverride, so this helper is NOT pure. PRIVATE to this
 * module — the only override-aware fallback chain; runtime emitters route
 * through resolveWorkerRepos so no verb re-derives it. */
function expectedWorkerCwd(
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

/** The canonical worker-repo resolver — the CODE-routing seam. Returns the
 * realpath-normalized pair:
 *   - targetRepo: override-aware (the worker's lane in worktree mode) via the
 *     three-level fallback in expectedWorkerCwd; the worker cds here for code.
 *     This is the field state verbs consume.
 *   - primaryRepo: ALWAYS the primary repo (epic.primary_repo -> proj), NEVER
 *     the lane. State verbs now take primary_repo / state_repo from the
 *     primary-rooted resolvePlanStateContext ctx instead; this field is retained
 *     for worker-resume until it migrates onto that seam.
 * Persistence/report verbs (scaffold, refine-apply, mv-repo,
 * task-set-target-repo, close-preflight, show) MUST NOT call this: routing them
 * through the lane override would write a lane path into plan state. */
export function resolveWorkerRepos(
  task: Record<string, unknown>,
  epic: Record<string, unknown>,
  proj: string,
): { targetRepo: string; primaryRepo: string } {
  return {
    targetRepo: realpathOr(expectedWorkerCwd(task, epic, proj)),
    primaryRepo: realpathOr(
      (epic.primary_repo as string | null | undefined) || proj,
    ),
  };
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
