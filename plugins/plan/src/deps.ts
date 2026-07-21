// Dependency-graph operations — the byte-parity port of planctl/deps.py.
//
// detectCycles / findDependents retain the Python DFS path shape. detectCycles
// owns a stable lexicographic traversal so cycle strings do not depend on object
// insertion order, directory enumeration order, or the host platform.

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

  for (const dep of [...(graph[taskId]?.depends_on ?? [])].sort()) {
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
 * null when the graph is acyclic. Nodes and adjacency lists use one canonical
 * lexicographic order, making the surfaced cycle stable for every caller. */
export function detectCycles(graph: DepGraph): string[] | null {
  const visited = new Set<string>();
  for (const taskId of Object.keys(graph).sort()) {
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
