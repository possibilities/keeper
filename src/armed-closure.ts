/**
 * Transitive-upstream dep-closure for the autopilot's `armed` mode (fn-751).
 *
 * In `armed` mode the reconciler dispatches `work` ONLY for explicitly-armed
 * epics PLUS every epic those armed epics transitively depend on — so arming
 * an epic also pulls in the prerequisites it can't complete without instead of
 * deadlocking on an unarmed upstream. {@link computeEligibleEpics} computes
 * that eligible set; the reconcile loop's mode arm suppresses `work` launches
 * for any epic NOT in it (`approve` / `close` / completion-reap stay
 * mode-exempt).
 *
 * This is a PURE function of its inputs — no DB read, no wall-clock, no
 * mutation of the passed maps. The autopilot worker recomputes it from the
 * fresh projection snapshot every cycle (no caching across cycles — the DAG
 * shifts as epics resolve/dangle).
 */

import type { Epic } from "./types";

/**
 * Compute the set of epic ids eligible for `work` dispatch in `armed` mode:
 * the armed epics themselves UNION every epic reachable by walking their
 * transitive upstream dependencies (the deps each epic NEEDS, i.e. its
 * `resolved_epic_deps[].resolved_epic_id`).
 *
 * Implementation is a single multi-source BFS seeded with EVERY armed id and a
 * SHARED `visited` set:
 *  - cycle-safe by construction — a visited node is never re-enqueued, so a
 *    user-authored dep cycle terminates with all its members in the set
 *    rather than hanging the reconciler;
 *  - O(V+E) over the reachable subgraph (one shared visited set avoids the
 *    per-root visited-alias bug a per-armed-root BFS would hit);
 *  - skips a `resolved_epic_id === null` edge (dangling / ambiguous — the
 *    token resolves to nothing) and an id absent from `epicById` (stale /
 *    unfolded upstream), so neither throws nor pollutes the set;
 *  - no cross-project special-casing — `resolved_epic_id` is followed wherever
 *    it points (an armed epic's cross-project upstream is included exactly as
 *    a same-project one would be).
 *
 * The returned set IS `visited`: every armed node plus all transitive
 * upstreams. An armed id absent from `epicById` (stale/unfolded) is still
 * seeded into the set — its own membership makes it eligible even though we
 * can't walk its deps — but it contributes no edges.
 *
 * @param armedIds   The explicitly-armed epic ids (the `armed_epics` presence
 *                   set from the projection). Empty → empty result.
 * @param epicById   Lookup from epic id → folded {@link Epic} (the snapshot
 *                   `epics` indexed by `epic_id`), the substrate for walking
 *                   `resolved_epic_deps`.
 * @returns The eligible-epic id set (armed ∪ transitive upstreams).
 */
export function computeEligibleEpics(
  armedIds: Set<string>,
  epicById: Map<string, Epic>,
): Set<string> {
  const visited = new Set<string>();
  // Multi-source BFS frontier seeded with every armed id. A visited node is
  // marked on ENQUEUE (not dequeue) so it can never be enqueued twice — the
  // cycle-safety guarantee.
  const queue: string[] = [];
  for (const id of armedIds) {
    if (!visited.has(id)) {
      visited.add(id);
      queue.push(id);
    }
  }

  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) {
      continue;
    }
    const epic = epicById.get(id);
    if (epic === undefined) {
      // Stale/unfolded id (an armed id we can't resolve, or — unreachable for
      // a walked upstream since we gate below): it's in the set via its own
      // membership but contributes no edges.
      continue;
    }
    const deps = epic.resolved_epic_deps;
    if (deps === null) {
      continue;
    }
    for (const dep of deps) {
      const upstreamId = dep.resolved_epic_id;
      // Skip dangling (null) edges and upstreams not present in the lookup —
      // following either would be a no-op or a throw on the next `.get`.
      if (upstreamId === null || !epicById.has(upstreamId)) {
        continue;
      }
      if (!visited.has(upstreamId)) {
        visited.add(upstreamId);
        queue.push(upstreamId);
      }
    }
  }

  return visited;
}
