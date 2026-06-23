/**
 * The GATED git-root set — the roots a readiness verdict can reference, derived
 * deterministically from the `epics` projection. This is the single source of
 * truth shared by:
 *
 *   - the boot-seed producer (`git-boot-seed.ts`), which must establish a
 *     `git_status` row for every gated root BEFORE serving so the readiness gate
 *     never sees a gated root as empty-merely-because-unseeded; and
 *   - main's above-floor `GitSnapshot` fold (`projectGitStatus` in `reducer.ts`),
 *     which clears `seed_required` once every gated root has been seeded — the
 *     producer-only self-heal for a root the boot-seed missed/failed.
 *
 * A gated root is keyed identically to the per-root mutex's `effectiveRoot`
 * (`readiness.ts`): a task's `target_repo` when set, else the epic's
 * `project_dir`; plus the epic's own `project_dir` (the close-row root). Only
 * OPEN epics gate — a completed epic dispatches nothing, so its roots never
 * darken the board.
 *
 * PURE event-derived: reads only the `epics` projection (no wall-clock / env /
 * FS), so calling it inside a fold preserves re-fold determinism.
 */

import type { Database } from "bun:sqlite";

/**
 * The per-root key used by the readiness mutex: `target_repo` when non-empty,
 * else `project_dir`. Mirrors `effectiveRoot` in `readiness.ts` exactly so the
 * gated set this module derives matches the set the gate consults.
 */
function effectiveRoot(
  targetRepo: string | null,
  projectDir: string | null,
): string {
  if (targetRepo != null && targetRepo !== "") {
    return targetRepo;
  }
  return projectDir ?? "";
}

/**
 * Derive the gated git-root set from the `epics` projection: for every OPEN
 * epic, the close-row root (`effectiveRoot(null, project_dir)`) plus each task's
 * `effectiveRoot(target_repo, project_dir)`. Empty-string roots (no
 * `target_repo` AND no `project_dir`) are dropped — they key nothing the gate
 * can reference and resolve to no real repo. Sorted for stable iteration.
 */
export function gatedGitRoots(db: Database): string[] {
  const rows = db
    .query("SELECT project_dir, tasks FROM epics WHERE status = 'open'")
    .all() as { project_dir: string | null; tasks: string | null }[];

  const roots = new Set<string>();
  for (const row of rows) {
    const projectDir = row.project_dir;
    // The close-row root: the epic's own project_dir.
    const closeRoot = effectiveRoot(null, projectDir);
    if (closeRoot !== "") roots.add(closeRoot);

    if (row.tasks == null || row.tasks.length === 0) continue;
    let tasks: unknown;
    try {
      tasks = JSON.parse(row.tasks);
    } catch {
      // Malformed embedded task array: the close-row root above still gates.
      continue;
    }
    if (!Array.isArray(tasks)) continue;
    for (const task of tasks) {
      const repo = (task as { target_repo?: unknown }).target_repo;
      const targetRepo = typeof repo === "string" ? repo : null;
      const root = effectiveRoot(targetRepo, projectDir);
      if (root !== "") roots.add(root);
    }
  }
  return Array.from(roots).sort();
}

/**
 * The subset of gated roots NOT yet seeded ABOVE the floor — a gated root with
 * NO `git_status` row whose `last_event_id > floor`. This is the per-root analog
 * of {@link allGatedRootsSeeded}: the readiness gate forces `{kind:unknown}` for
 * a verdict ONLY when its `effectiveRoot` is in this set, so one stale/failed
 * root darks only ITS own rows, never the whole board. The empty set ⇔ every
 * gated root is seeded ⇔ the gate is fully off (byte-identical to the legacy
 * "seeded" path). Sorted for stable iteration.
 *
 * Callers gate the invocation on `seed_required`: while the flag is CLEAR the
 * gate is off entirely (pass an empty set, never call this) so a clean root that
 * `retractGitStatus` later DELETEd (going clean drops its `git_status` row) never
 * re-wedges — the gate is bounded to the `seed_required`-set window.
 *
 * PURE: reads only `epics` + `git_status` projections.
 */
export function unseededGatedRoots(db: Database, floor: number): Set<string> {
  const roots = gatedGitRoots(db);
  const unseeded = new Set<string>();
  if (roots.length === 0) return unseeded;
  // INVARIANT: a gated root MUST already be its own git toplevel. We look it up
  // by the RAW effectiveRoot, but the boot-seed / live git-worker WRITE the row
  // under resolveGitToplevel(root) (`git-boot-seed.ts`). The two keys agree only
  // when effectiveRoot === resolveGitToplevel(effectiveRoot); the per-root mutex
  // assumes the same identity. Under fn-905's self-clear a key mismatch is no
  // longer a transient stall — the root never clears seed_required and stays
  // forced-`unknown` forever.
  const stmt = db.prepare(
    "SELECT 1 FROM git_status WHERE project_dir = ? AND last_event_id > ? LIMIT 1",
  );
  for (const root of roots) {
    if (stmt.get(root, floor) == null) unseeded.add(root);
  }
  return unseeded;
}

/**
 * True iff every gated root has a `git_status` row seeded ABOVE the floor
 * (`last_event_id > floor`) — i.e. a fresh snapshot from this boot's seed or a
 * post-boot live emit, not a stale pre-floor row. The boot-seed and the
 * above-floor fold both consult this to decide whether `seed_required` may
 * clear. An empty gated set is vacuously satisfied (no work to gate).
 *
 * PURE: reads only `epics` + `git_status` projections.
 */
export function allGatedRootsSeeded(db: Database, floor: number): boolean {
  const roots = gatedGitRoots(db);
  if (roots.length === 0) return true;
  // Same raw-key INVARIANT as unseededGatedRoots: the gated root MUST already be
  // its own git toplevel (keyed identically to the boot-seed / live git-worker
  // resolveGitToplevel write key), or it never seeds and seed_required never
  // clears.
  const stmt = db.prepare(
    "SELECT 1 FROM git_status WHERE project_dir = ? AND last_event_id > ? LIMIT 1",
  );
  for (const root of roots) {
    if (stmt.get(root, floor) == null) return false;
  }
  return true;
}
