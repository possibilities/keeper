// Dependency-graph operations — the byte-parity port of planctl/deps.py.
//
// detectCycles / findDependents reproduce the Python DFS exactly so the cycle
// strings the integrity-gate + add-dep verbs surface match across engines. Python's
// dict iteration is insertion-ordered; readdir / object-key order is arbitrary
// across engines, so callers that build the graph from a directory listing MUST
// sort the node ids AND each adjacency list at the construction site (see the
// epic-dep walkers) — these functions then walk a deterministic structure.

/** A node's record in the dependency graph: only `depends_on` is consulted. */
export interface DepNode {
  depends_on?: string[];
}

export type DepGraph = Record<string, DepNode>;

/** DFS from `taskId`, returning a cycle path or [] when none is reachable.
 * Mirrors deps.has_cycle: a back-edge into the recursion stack returns
 * `[taskId, dep]`; the recursive arm prepends `taskId` onto the discovered
 * cycle. `visited` and `recStack` are shared across the whole detect pass. */
export function hasCycle(
  graph: DepGraph,
  taskId: string,
  visited: Set<string>,
  recStack: Set<string>,
): string[] {
  visited.add(taskId);
  recStack.add(taskId);

  for (const dep of graph[taskId]?.depends_on ?? []) {
    if (!visited.has(dep)) {
      const cycle = hasCycle(graph, dep, visited, recStack);
      if (cycle.length > 0) {
        return [taskId, ...cycle];
      }
    } else if (recStack.has(dep)) {
      return [taskId, dep];
    }
  }

  recStack.delete(taskId);
  return [];
}

/** Run hasCycle from each unvisited node, returning the first cycle path or
 * null when the graph is acyclic. Mirrors deps.detect_cycles — iteration order
 * over `graph` keys decides which cycle surfaces first, so the caller pre-sorts
 * the node ids (and each adjacency list) for cross-engine determinism. */
export function detectCycles(graph: DepGraph): string[] | null {
  const visited = new Set<string>();
  for (const taskId of Object.keys(graph)) {
    if (!visited.has(taskId)) {
      const cycle = hasCycle(graph, taskId, visited, new Set<string>());
      if (cycle.length > 0) {
        return cycle;
      }
    }
  }
  return null;
}

/** Every task that directly OR transitively depends on `taskId`. Mirrors
 * deps.find_dependents: a BFS over the reverse edges (`allTasks[*].depends_on`
 * containing the current node), returned in discovery order. The returned list
 * order follows Python's set-to-list conversion only loosely; callers that need
 * a stable order sort the result. */
export function findDependents(taskId: string, allTasks: DepGraph): string[] {
  const dependents = new Set<string>();
  const toCheck: string[] = [taskId];
  const checked = new Set<string>();

  while (toCheck.length > 0) {
    const checking = toCheck.shift() as string;
    if (checked.has(checking)) {
      continue;
    }
    checked.add(checking);

    for (const [tid, tdata] of Object.entries(allTasks)) {
      if (checked.has(tid) || dependents.has(tid)) {
        continue;
      }
      const deps = tdata.depends_on ?? [];
      if (deps.includes(checking)) {
        dependents.add(tid);
        toCheck.push(tid);
      }
    }
  }

  return [...dependents];
}
