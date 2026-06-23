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
 * fn-921 gated-root key reconciliation. The READ key is the raw `effectiveRoot`
 * (`target_repo ?? project_dir`); the boot-seed + live git-worker WRITE the
 * `git_status` row under `resolveGitToplevel(root)`. The two agree only when
 * `effectiveRoot === resolveGitToplevel(effectiveRoot)` — true for a repo
 * registered at its own toplevel, but a `target_repo` pointing at a SUBDIR, or a
 * symlinked/`/var`-vs-`/private/var` path, mismatches. Under fn-905's self-clear
 * a mismatch is no longer a transient stall: the root never acquires an
 * above-floor row under the read key, so `seed_required` never clears and the
 * root stays forced-`unknown` FOREVER.
 *
 * `resolveRoot` lets a caller that MAY shell out to git (the server-worker /
 * autopilot read sites, the boot-seed producer) normalize the read key to the
 * write key via `resolveGitToplevel` (memoized). The reducer fold MUST NOT call
 * git, so it passes no resolver — the identity default, byte-identical for the
 * common `effectiveRoot === toplevel` case (every `.keeper`-backed epic/task
 * root, which is what the fold's self-clear must handle). A non-fold caller
 * supplies the resolver so a subdir/symlink `target_repo` still clears.
 */
function seededLookupKey(
  root: string,
  resolveRoot: ((root: string) => string) | undefined,
): string {
  if (resolveRoot == null) return root;
  try {
    return resolveRoot(root);
  } catch {
    // A resolve failure falls back to the raw key — no worse than the
    // no-resolver default, never throws (this runs in producer + read paths).
    return root;
  }
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
 * The returned set holds the RAW `effectiveRoot`s (the readiness gate keys on
 * those) even when `resolveRoot` is supplied — only the seeded-lookup is
 * normalized; see {@link seededLookupKey}.
 *
 * Callers gate the invocation on `seed_required`: while the flag is CLEAR the
 * gate is off entirely (pass an empty set, never call this) so a clean root that
 * `retractGitStatus` later DELETEd (going clean drops its `git_status` row) never
 * re-wedges — the gate is bounded to the `seed_required`-set window.
 *
 * PURE w.r.t. the DB (reads only `epics` + `git_status`); `resolveRoot`, when
 * given, may shell out to git — so it is passed ONLY by non-fold callers.
 */
export function unseededGatedRoots(
  db: Database,
  floor: number,
  resolveRoot?: (root: string) => string,
): Set<string> {
  const roots = gatedGitRoots(db);
  const unseeded = new Set<string>();
  if (roots.length === 0) return unseeded;
  const stmt = db.prepare(
    "SELECT 1 FROM git_status WHERE project_dir = ? AND last_event_id > ? LIMIT 1",
  );
  for (const root of roots) {
    const key = seededLookupKey(root, resolveRoot);
    if (stmt.get(key, floor) == null) unseeded.add(root);
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
 * PURE w.r.t. the DB (reads only `epics` + `git_status`); `resolveRoot`, when
 * given, may shell out to git (see {@link seededLookupKey}) — so the reducer
 * fold passes NONE (identity, byte-identical for the common case) while the
 * boot-seed producer passes `resolveGitToplevel` to reconcile a subdir/symlink
 * gated key.
 */
export function allGatedRootsSeeded(
  db: Database,
  floor: number,
  resolveRoot?: (root: string) => string,
): boolean {
  const roots = gatedGitRoots(db);
  if (roots.length === 0) return true;
  const stmt = db.prepare(
    "SELECT 1 FROM git_status WHERE project_dir = ? AND last_event_id > ? LIMIT 1",
  );
  for (const root of roots) {
    const key = seededLookupKey(root, resolveRoot);
    if (stmt.get(key, floor) == null) return false;
  }
  return true;
}
