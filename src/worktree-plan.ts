/**
 * Pure DAG → worktree topology for autopilot's worktree mode (fn-959).
 *
 * Maps an epic's internal task DAG (the `depends_on` edges over `epic.tasks`)
 * onto a set of git worktree lanes, deterministically and WITHOUT touching the
 * filesystem, git, or the wall clock. The autopilot worker's PRODUCER path
 * consumes this plan to lazily create worktrees, run lane pre-merges, assert
 * HEAD, and pick each launch's cwd — but none of that lives here. This module
 * is a total function of the DAG alone, so it is cheap to prove correct under
 * synthetic-DAG unit tests before any git side effect exists.
 *
 * Topology rule (the same one the epic spec pins):
 *  - A maximal LINEAR chain of tasks shares ONE worktree (no merge between
 *    consecutive links).
 *  - The FIRST child of a fork inherits the parent's worktree; every other
 *    child FORKS a fresh sub-worktree (a "rib") off the parent's committed tip.
 *  - A FAN-IN task merges its incoming lane branches (exactly the DAG edges
 *    crossing a worktree boundary) into its own branch BEFORE it runs.
 *  - A synthetic `__close__` sink depends on all leaf tasks and is pinned to
 *    the epic base, so the closer sits where every lane has already merged in.
 *
 * Branch names are a pure function of stable ids only:
 *  - base: `keeper/epic/<epic_id>`
 *  - rib:  `keeper/epic/<epic_id>/<task_id>`
 * Worktree paths resolve to a SIBLING directory OUTSIDE the repo tree, derived
 * purely from the repo dir's parent + a slug of the branch.
 *
 * Determinism is sacred: the toposort breaks ties on the existing
 * `(task_number, task_id)` order, the inheritance walk consumes that one order,
 * and every derived name is a pure function of stable ids — so re-deriving the
 * plan from the same DAG is byte-identical. A `depends_on` cycle FAILS LOUD.
 */

import type { Task } from "./types";

/**
 * The synthetic sink node id. NOT a real task — it represents the epic closer,
 * which is keyed `close::<epic_id>` at dispatch time. It depends on every leaf
 * task so it sorts last and is pinned to the epic base branch/worktree, the
 * point where every lane has already merged in.
 */
export const CLOSE_SINK_ID = "__close__";

/**
 * Per-node worktree assignment — the derived launch geometry for one DAG node
 * (a real task, or the synthetic {@link CLOSE_SINK_ID} sink). Extends the
 * autopilot worker's `PlannedLaunch` shape with the worktree-mode fields the
 * producer needs: where to run, which branch HEAD must equal, and which lane
 * branches to merge in first.
 */
export interface WorktreeAssignment {
  /**
   * The DAG node id — a `task_id`, or {@link CLOSE_SINK_ID} for the synthetic
   * sink. The sink's launch is dispatched as the epic closer (`close::<epic_id>`).
   */
  nodeId: string;
  /** `true` IFF this is the synthetic `__close__` sink (pinned to base). */
  isCloseSink: boolean;
  /**
   * The git branch this node runs on. `keeper/epic/<epic_id>` for any node that
   * inherits the base lane; `keeper/epic/<epic_id>/<task_id>` for a rib.
   */
  branch: string;
  /**
   * Absolute path to this node's worktree — a SIBLING dir outside the repo
   * tree, a pure function of the repo dir + branch. Two nodes sharing a lane
   * (same branch) share this path byte-for-byte.
   */
  worktreePath: string;
  /**
   * `true` IFF this node INHERITED its parent's worktree (a linear-chain link
   * or the first child of a fork); `false` IFF it FORKED a fresh rib off the
   * parent's committed tip. A root inherits the base (`true`); an extra root
   * forks off base (`false`).
   */
  inherited: boolean;
  /**
   * The lane branches that MUST merge into {@link branch} before this node
   * runs — exactly the incoming DAG edges that cross a worktree boundary
   * (parent on a different branch than this node). Empty for a linear link.
   * Ordered by the toposort, so merges are a deterministic sequential pairwise
   * sequence (never octopus).
   */
  preMerges: string[];
  /**
   * The branch HEAD the producer must assert before dispatch — identical to
   * {@link branch}. Carried explicitly so the producer's HEAD-assertion never
   * has to re-derive it.
   */
  assertBranch: string;
}

/**
 * The full worktree plan for one epic: the base branch + every node's
 * assignment in deterministic toposort order (roots first, `__close__` last).
 */
export interface WorktreePlan {
  /** The epic base branch — `keeper/epic/<epic_id>`. */
  baseBranch: string;
  /** The epic base worktree path (the lane the closer + first root run on). */
  baseWorktreePath: string;
  /**
   * Every node's assignment, in toposort order. The last element is always the
   * synthetic {@link CLOSE_SINK_ID} sink.
   */
  assignments: WorktreeAssignment[];
}

/** Thrown when the task DAG contains a `depends_on` cycle. Fail loud. */
export class WorktreeCycleError extends Error {
  /** The node ids that remained unscheduled (the cycle members + downstream). */
  readonly unscheduled: string[];
  constructor(unscheduled: string[]) {
    super(
      `worktree-plan: depends_on cycle — could not toposort tasks: ${unscheduled.join(", ")}`,
    );
    this.name = "WorktreeCycleError";
    this.unscheduled = unscheduled;
  }
}

/** The base branch for an epic — `keeper/epic/<epic_id>`. */
export function baseBranchFor(epicId: string): string {
  return `keeper/epic/${epicId}`;
}

/** The rib branch for a forked task — `keeper/epic/<epic_id>/<task_id>`. */
export function ribBranchFor(epicId: string, taskId: string): string {
  return `keeper/epic/${epicId}/${taskId}`;
}

/**
 * Resolve a branch to its worktree path: a SIBLING dir outside the repo tree,
 * a pure function of the repo dir + branch. `<parent>/<repoName>.worktrees/<slug>`
 * where `slug` is the branch with `/` → `-` (filesystem-safe, collision-free
 * because branch names are themselves unique per lane). Kept OUTSIDE the repo
 * tree (a sibling under `<repoName>.worktrees`) so a worktree is never nested
 * inside the repo it forks from.
 */
export function worktreePathFor(repoDir: string, branch: string): string {
  const normalizedRepo = stripTrailingSlash(repoDir);
  const parent = parentDir(normalizedRepo);
  const repoName = baseName(normalizedRepo) || "repo";
  const slug = branch.replace(/\//g, "-");
  return `${parent}/${repoName}.worktrees/${slug}`;
}

/**
 * Derive the deterministic worktree plan for an epic's task DAG.
 *
 * @param epicId  The epic id — drives every derived branch name.
 * @param repoDir The epic's repo dir (its `project_dir`) — drives worktree
 *                paths. Must be non-empty; an empty repo dir is a producer bug.
 * @param tasks   The epic's tasks (`epic.tasks`). Read-only; not mutated.
 * @returns The {@link WorktreePlan} — base lane + every node assignment in
 *          toposort order, `__close__` last.
 * @throws WorktreeCycleError on a `depends_on` cycle.
 */
export function deriveWorktreePlan(
  epicId: string,
  repoDir: string,
  tasks: Task[],
): WorktreePlan {
  const baseBranch = baseBranchFor(epicId);
  const baseWorktreePath = worktreePathFor(repoDir, baseBranch);

  const order = toposort(tasks);

  // Restrict each node's parents to ids present in the DAG (a dangling
  // `depends_on` token — an upstream that is not one of this epic's tasks — is
  // ignored, never crosses a lane boundary). `byId` indexes the real tasks.
  const byId = new Map<string, Task>();
  for (const t of tasks) {
    byId.set(t.task_id, t);
  }
  const parentsOf = (taskId: string): string[] => {
    const t = byId.get(taskId);
    if (t === undefined) {
      return [];
    }
    return t.depends_on.filter((d) => byId.has(d));
  };

  // Per-node assigned branch. A node's PRIMARY parent is the first parent in
  // toposort order; the node INHERITS that parent's lane IFF no earlier child
  // of the SAME parent has already inherited it (linear chain / first child of
  // a fork), else it FORKS a rib off the parent's committed tip. "Taken" is
  // keyed by the PARENT NODE (`childInherited`), not by branch: a node sitting
  // on the base lane never blocks its OWN first child from inheriting base —
  // only a sibling that already inherited the same parent's lane does. This
  // guarantees two live nodes never share a branch concurrently (each lane has
  // at most one inheriting child per parent, and the chain is linear).
  const branchOf = new Map<string, string>();
  const inheritedFlag = new Map<string, boolean>();
  // The node each node forked-off-or-inherited-from (its primary parent). A
  // root has none. Used to EXCLUDE the fork/inherit source from pre-merges: a
  // rib forked off the primary's committed tip already carries the primary's
  // work, so that edge is never a merge.
  const primaryOf = new Map<string, string>();
  const childInherited = new Set<string>();
  // The first root sits on base; an extra root forks because base is already
  // occupied by the first root.
  let baseRootClaimed = false;
  // Position of each node in `order`, to pick the FIRST parent deterministically.
  const orderIndex = new Map<string, number>();
  order.forEach((id, i) => {
    orderIndex.set(id, i);
  });

  for (const taskId of order) {
    const parents = parentsOf(taskId);
    if (parents.length === 0) {
      // A root. The FIRST root sits on base; every extra root forks off base.
      if (!baseRootClaimed) {
        baseRootClaimed = true;
        branchOf.set(taskId, baseBranch);
        inheritedFlag.set(taskId, true);
      } else {
        branchOf.set(taskId, ribBranchFor(epicId, taskId));
        inheritedFlag.set(taskId, false);
      }
      continue;
    }
    // Primary parent = the parent earliest in toposort order.
    const primary = parents.reduce((best, p) =>
      (orderIndex.get(p) ?? 0) < (orderIndex.get(best) ?? 0) ? p : best,
    );
    primaryOf.set(taskId, primary);
    const primaryBranch = branchOf.get(primary);
    // Defensive: a parent always precedes its child in a valid toposort, so
    // `primaryBranch` is always defined here. Inherit it IFF no earlier child
    // of `primary` has already taken its lane; otherwise fork a rib.
    if (primaryBranch !== undefined && !childInherited.has(primary)) {
      childInherited.add(primary);
      branchOf.set(taskId, primaryBranch);
      inheritedFlag.set(taskId, true);
    } else {
      branchOf.set(taskId, ribBranchFor(epicId, taskId));
      inheritedFlag.set(taskId, false);
    }
  }

  // Build each real-task assignment. `preMerges` for a node = the distinct
  // branches of its NON-PRIMARY parents that differ from its own branch (the
  // fan-in DAG edges crossing a worktree boundary), ordered by the toposort for
  // determinism. The primary parent (the fork/inherit source) is excluded: an
  // inherited lane shares the branch (no merge), and a rib forked off the
  // primary's committed tip already carries the primary's work.
  const assignments: WorktreeAssignment[] = [];
  for (const taskId of order) {
    const branch = branchOf.get(taskId) ?? baseBranch;
    const primary = primaryOf.get(taskId);
    const primaryBranch =
      primary !== undefined ? branchOf.get(primary) : undefined;
    const preMerges = computePreMergesForBranches(
      parentsOf(taskId),
      branch,
      branchOf,
      orderIndex,
      primaryBranch,
    );
    assignments.push({
      nodeId: taskId,
      isCloseSink: false,
      branch,
      worktreePath: worktreePathFor(repoDir, branch),
      inherited: inheritedFlag.get(taskId) ?? true,
      preMerges,
      assertBranch: branch,
    });
  }

  // The synthetic `__close__` sink: depends on every LEAF task (a task that is
  // no other task's parent), pinned to base. Its pre-merges are the distinct
  // leaf branches that differ from base — every lane merges into base before
  // the closer runs.
  const isParent = new Set<string>();
  for (const t of tasks) {
    for (const d of t.depends_on) {
      if (byId.has(d)) {
        isParent.add(d);
      }
    }
  }
  const leaves = order.filter((id) => !isParent.has(id));
  const closePreMerges = computePreMergesForBranches(
    leaves,
    baseBranch,
    branchOf,
    orderIndex,
  );
  assignments.push({
    nodeId: CLOSE_SINK_ID,
    isCloseSink: true,
    branch: baseBranch,
    worktreePath: baseWorktreePath,
    inherited: true,
    preMerges: closePreMerges,
    assertBranch: baseBranch,
  });

  return { baseBranch, baseWorktreePath, assignments };
}

/**
 * Toposort `tasks` (Kahn's algorithm) with ties broken by the existing
 * `(task_number, task_id)` order — the same deterministic order the reducer
 * folds `epic.tasks` into. A node with the smallest indegree-zero `(task_number,
 * task_id)` is scheduled next, so the output order is a total function of the
 * DAG. Dangling `depends_on` tokens (an upstream not among `tasks`) are ignored.
 * FAILS LOUD with {@link WorktreeCycleError} if any node never reaches indegree
 * zero (a cycle).
 */
function toposort(tasks: Task[]): string[] {
  // Stable `(task_number, task_id)` order — the tiebreaker frontier sort. A
  // null `task_number` sorts after any numbered task (matching plan's "shell
  // element" handling), then by `task_id`.
  const sorted = [...tasks].sort(compareTask);
  const ids = sorted.map((t) => t.task_id);
  const idSet = new Set(ids);
  const rank = new Map<string, number>();
  sorted.forEach((t, i) => {
    rank.set(t.task_id, i);
  });

  // indegree = count of `depends_on` tokens that point at an in-DAG task.
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const id of ids) {
    indegree.set(id, 0);
    children.set(id, []);
  }
  for (const t of sorted) {
    for (const dep of t.depends_on) {
      if (idSet.has(dep)) {
        indegree.set(t.task_id, (indegree.get(t.task_id) ?? 0) + 1);
        children.get(dep)?.push(t.task_id);
      }
    }
  }

  // Frontier = indegree-zero nodes, kept in `(task_number, task_id)` order. We
  // re-scan for the min-rank ready node each step (DAGs here are tiny — task
  // counts in the low tens — so the simple O(V^2) scan is fine and keeps the
  // tiebreak trivially correct).
  const scheduled: string[] = [];
  const done = new Set<string>();
  while (scheduled.length < ids.length) {
    let next: string | null = null;
    let nextRank = Number.POSITIVE_INFINITY;
    for (const id of ids) {
      if (done.has(id)) {
        continue;
      }
      if ((indegree.get(id) ?? 0) !== 0) {
        continue;
      }
      const r = rank.get(id) ?? 0;
      if (r < nextRank) {
        nextRank = r;
        next = id;
      }
    }
    if (next === null) {
      // No indegree-zero node left but unscheduled nodes remain → a cycle.
      const unscheduled = ids.filter((id) => !done.has(id));
      throw new WorktreeCycleError(unscheduled);
    }
    scheduled.push(next);
    done.add(next);
    for (const child of children.get(next) ?? []) {
      indegree.set(child, (indegree.get(child) ?? 0) - 1);
    }
  }
  return scheduled;
}

/** Deterministic `(task_number, task_id)` task order. */
function compareTask(a: Task, b: Task): number {
  const an = a.task_number;
  const bn = b.task_number;
  if (an !== bn) {
    if (an === null) {
      return 1;
    }
    if (bn === null) {
      return -1;
    }
    return an - bn;
  }
  return a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0;
}

/**
 * Given a set of upstream node ids, return the distinct upstream branches that
 * differ from `ownBranch` AND from `excludeBranch`, ordered by the upstreams'
 * toposort position. `excludeBranch` is the node's primary parent's branch (the
 * fork/inherit source) — never a merge. Shared by the per-task pre-merge and
 * the `__close__` sink's leaf-merge computation (the sink passes no exclusion,
 * since its base is not forked off any one leaf).
 */
function computePreMergesForBranches(
  upstreams: string[],
  ownBranch: string,
  branchOf: Map<string, string>,
  orderIndex: Map<string, number>,
  excludeBranch?: string,
): string[] {
  const seen = new Set<string>();
  const out: { branch: string; rank: number }[] = [];
  for (const up of upstreams) {
    const b = branchOf.get(up);
    if (
      b === undefined ||
      b === ownBranch ||
      b === excludeBranch ||
      seen.has(b)
    ) {
      continue;
    }
    seen.add(b);
    out.push({ branch: b, rank: orderIndex.get(up) ?? 0 });
  }
  out.sort((x, y) => x.rank - y.rank);
  return out.map((e) => e.branch);
}

// --- Pure path helpers (no node:path — keep the module dependency-free) ------

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.replace(/\/+$/, "") : p;
}

function parentDir(p: string): string {
  const idx = p.lastIndexOf("/");
  if (idx < 0) {
    return ".";
  }
  if (idx === 0) {
    return "/";
  }
  return p.slice(0, idx);
}

function baseName(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx < 0 ? p : p.slice(idx + 1);
}
