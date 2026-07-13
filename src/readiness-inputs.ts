/**
 * Neutral readiness-input loader — the ONE place the DB-sourced arguments
 * {@link computeReadiness} consumes are read off a projection, so the autopilot
 * reconciler (`loadReconcileSnapshot`) and the autoclose worker share a single
 * notion of "done" that can never drift. This module owns NO connection: every
 * caller passes its OWN read-only `db` handle; the loader only reads projections
 * (plus the git-seed probe that resolves `unseededRoots`) and writes nothing.
 *
 * Dep-light on purpose — it pulls only the shared projection helpers
 * (`collapseSubagentsByName` / `projectGitStatusByProjectDir` /
 * `projectPendingDispatches` — the SOLE `PendingDispatch` builder — plus
 * `orderEpicsForScheduling` and the git-seed gate) and NEVER the reconciler /
 * daemon dispatch graph, so a consumer worker can import it without dragging in
 * dispatch machinery.
 *
 * The other `computeReadiness` arguments are NOT loaded here: `now` is a caller
 * timestamp, and `eligibleEpicIds` / `laneKeyById` are DERIVED downstream
 * (armed-closure + worktree geometry) by the reconciler and don't affect a
 * `completed` verdict — a consumer that only needs done-detection passes
 * `undefined` / empty for those.
 */

import type { Database } from "bun:sqlite";
import {
  effectivePerRootCap,
  readGitProjectionFloor,
  readGitProjectionSeedRequired,
} from "./db";
import { unseededGatedRoots } from "./gated-roots";
import { memoizedGitToplevel } from "./git-toplevel";
import { orderEpicsForScheduling, type PendingDispatch } from "./readiness";
import {
  projectGitStatusByProjectDir,
  projectPendingDispatches,
} from "./readiness-client";
import { runQuery } from "./server-worker";
import { canonicalSubagentInvocations } from "./subagent-invocations";
import type { Epic, GitStatus, Job, SubagentInvocation } from "./types";

export type ReadinessQuery = typeof runQuery;

/**
 * The DB-sourced argument set both readiness consumers feed to
 * {@link computeReadiness} identically. Field names/shapes mirror the
 * `computeReadiness` parameters one-for-one.
 */
export interface ReadinessInputs {
  /** A collection read returned an ERROR frame, so this input set is not a
   *  complete observation and consumers must defer the tick. */
  readinessDegraded: boolean;
  /** Open scope merged with the recently-done window, deduped (open wins),
   *  ordered through the single scheduling seam. */
  epics: Epic[];
  /** `jobs` projection keyed by `job_id`. */
  jobs: Map<string, Job>;
  /** `subagent_invocations`, collapsed to the latest row per name. */
  subagentInvocations: SubagentInvocation[];
  /** Project-wide git status keyed by `project_dir`. */
  gitStatusByProjectDir: Map<
    string,
    { dirty_count: number; unattributed_to_live_count: number }
  >;
  /** Open `pending_dispatches` rows (launched-but-not-yet-bound workers), built
   *  through the SOLE `projectPendingDispatches` builder. */
  pendingDispatches: PendingDispatch[];
  /** The per-root git-seed gate: roots whose live-only git surface is unseeded
   *  (post-restart, pre-seed). EMPTY whenever `seed_required` is clear. A plain
   *  `Set` (not `ReadonlySet`) so it drops straight into the reconciler's snapshot
   *  field; `computeReadiness` reads it through a `ReadonlySet` param regardless. */
  unseededRoots: Set<string>;
  /** The EFFECTIVE per-root dispatch concurrency count N, derived from the stored
   *  `autopilot_state.max_concurrent_per_root` intent and worktree mode via
   *  {@link effectivePerRootCap} (worktree off ⇒ 1). */
  maxConcurrentPerRoot: number;
}

/**
 * Load the {@link ReadinessInputs} off a read-only `db` handle. Pure read over
 * projections + the git-seed probe; owns no connection and writes nothing.
 * Deterministic given the projection state (same reads, same ordering seam as
 * the reconciler), so two callers over the same seeded db get identical inputs.
 */
export function loadReadinessInputs(
  db: Database,
  query: ReadinessQuery = runQuery,
): ReadinessInputs {
  let readinessDegraded = false;
  const read = (collection: string): Record<string, unknown>[] => {
    const frame = {
      type: "query" as const,
      collection,
      id: `readiness-inputs-${collection}`,
      limit: 0,
    };
    const res = query(db, 0, frame);
    if (res.type === "result") {
      return res.rows as Record<string, unknown>[];
    }
    readinessDegraded = true;
    return [];
  };

  // The default-scope (open) epics — the live work set — MERGED with the
  // recently-DONE window (`epics_recent_done`, time-bounded by its descriptor's
  // `recencyBound` on `updated_at`) so the close-row completion reap is
  // reachable. Dedup keys on `epic_id` with the OPEN row winning (a collision is
  // only a fold-lag transient; preferring the live row keeps arms on the freshest
  // view). Then routed through the single scheduling-order seam.
  const openEpics = read("epics") as unknown as Epic[];
  const doneEpics = read("epics_recent_done") as unknown as Epic[];
  const seenEpicIds = new Set<string>();
  const dedupedEpics: Epic[] = [];
  for (const epic of openEpics) {
    if (seenEpicIds.has(epic.epic_id)) {
      continue;
    }
    seenEpicIds.add(epic.epic_id);
    dedupedEpics.push(epic);
  }
  for (const epic of doneEpics) {
    if (seenEpicIds.has(epic.epic_id)) {
      continue;
    }
    seenEpicIds.add(epic.epic_id);
    dedupedEpics.push(epic);
  }
  const epics = orderEpicsForScheduling(dedupedEpics);

  const jobs = new Map<string, Job>();
  for (const row of read("jobs") as unknown as Job[]) {
    jobs.set(row.job_id, row);
  }

  const subagentInvocations = canonicalSubagentInvocations(
    read("subagent_invocations") as unknown as SubagentInvocation[],
  );

  const gitStatusByProjectDir = projectGitStatusByProjectDir(
    read("git") as unknown as GitStatus[],
  );

  // Built through the SOLE `projectPendingDispatches` builder so the readiness
  // paths agree on the launch-window occupancy set.
  const pendingDispatches = projectPendingDispatches(
    read("pending_dispatches"),
  );

  // The per-root dispatch concurrency count N is the EFFECTIVE cap derived from
  // the `autopilot_state` singleton's stored intent and worktree mode (both on
  // the SAME row — no extra query). Worktree off ⇒ 1 (shared checkout); worktree
  // on ⇒ the stored positive integer, else the default. A missing/malformed
  // stored value or an absent row fails closed to 1.
  const autopilotRow = read("autopilot_state")[0] as
    | { max_concurrent_per_root?: unknown; worktree_mode?: unknown }
    | undefined;
  const maxConcurrentPerRoot: number = effectivePerRootCap(
    autopilotRow?.max_concurrent_per_root,
    autopilotRow?.worktree_mode === 1,
  );

  // The PER-ROOT unseeded set: while `seed_required` is SET, a root is unseeded
  // iff it has no `git_status` row above the floor; the normalized read key maps
  // a subdir/symlink `target_repo` to its toplevel write key. While the flag is
  // CLEAR the set is EMPTY (the gate is fully off).
  const unseededRoots = readGitProjectionSeedRequired(db)
    ? unseededGatedRoots(db, readGitProjectionFloor(db), memoizedGitToplevel())
    : new Set<string>();

  return {
    readinessDegraded,
    epics,
    jobs,
    subagentInvocations,
    gitStatusByProjectDir,
    pendingDispatches,
    unseededRoots,
    maxConcurrentPerRoot,
  };
}
