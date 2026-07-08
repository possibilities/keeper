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
 *  - rib:  `keeper/epic/<epic_id>--<task_id>` (FLAT: the `--` separator keeps a
 *    rib from ever being a path-prefix of the base ref — git rejects that as a
 *    directory/file ref conflict)
 * Worktree paths resolve to a directory under `~/worktrees/`, OUTSIDE the repo
 * tree, named `<repoName>-<hash>--<branch-slug>` (the dir-hash disambiguates
 * same-basename repos). The worktrees root is INJECTABLE (`worktreesRoot`): the
 * reconciler threads `${homedir()}/worktrees` in from the producer side so the
 * pure verdict path reaches no environment. When no root is injected the helpers
 * fall back to reading `homedir()` themselves — the one environment read here,
 * constant within the daemon process so re-derivation stays byte-identical, and
 * safe because that fallback runs producer-only, never in a fold.
 *
 * Determinism is sacred: the toposort breaks ties on the existing
 * `(task_number, task_id)` order, the inheritance walk consumes that one order,
 * and every derived name is a pure function of stable ids — so re-deriving the
 * plan from the same DAG is byte-identical. A `depends_on` cycle FAILS LOUD.
 */

import { homedir } from "node:os";

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
   * inherits the base lane; `keeper/epic/<epic_id>--<task_id>` for a rib.
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

/**
 * The rib branch for a forked task — the FLAT `keeper/epic/<epic_id>--<task_id>`.
 * The `--` separator (never `/`) keeps a rib from being a path-prefix of the base
 * ref `keeper/epic/<epic_id>`, which git rejects as a directory/file ref conflict
 * the moment a forked epic provisions its first rib alongside the base.
 */
export function ribBranchFor(epicId: string, taskId: string): string {
  return `keeper/epic/${epicId}--${taskId}`;
}

/**
 * The `<repoName>-<hash>` half of a lane path — a repo identifier built from
 * its basename plus a short stable digest, so two SAME-BASENAME repos (e.g.
 * `~/a/foo` and `~/b/foo`) never collide onto one token. Extracted as its own
 * function so a repo-scoped identifier OUTSIDE the worktree-path context (the
 * `repair::<repo-token>` escalation key — see `src/dispatch-command.ts` /
 * `cli/escalation-brief.ts`) can name a repo the identical way {@link
 * worktreePathFor} already does, without a second hand-rolled derivation that
 * could drift from it. PURE: no wall-clock/random/syscall, just the
 * (already realpath'd by the caller) repo dir; the trailing slash is
 * stripped first so `<dir>` and `<dir>/` map to the same token.
 */
export function repoToken(repoDir: string): string {
  const stripped = stripTrailingSlash(repoDir);
  const repoName = baseName(stripped) || "repo";
  return `${repoName}-${shortHash(stripped)}`;
}

/**
 * Resolve a branch to its worktree path: a dir under `~/worktrees/`, OUTSIDE the
 * repo tree, named `<repoToken>--<branch-slug>` ({@link repoToken} is
 * `<repoName>-<hash>`) where `slug` is the branch with `/` → `-`
 * (filesystem-safe; branch names are unique per lane, so the slug is
 * collision-free). A rib slug carries `--` twice
 * (`<repoName>-<hash>--keeper-epic-<id>--<task>`): the prefix separator and the
 * rib's own — still unambiguous + collision-free, since the slug is an injective
 * image of the unique branch name.
 *
 * PURE function of (repoDir, branch, worktreesRoot): the hash folds only the
 * (already realpath'd by the producer) repo dir, no wall-clock / random / syscall,
 * so the producer (provision) and teardown (removeWorktree) derive a byte-identical
 * path and the path-equality comparisons on both sides still hold. Kept outside
 * the repo tree so a worktree is never nested inside the repo it forks from.
 *
 * `worktreesRoot` is the parent dir every lane hangs under. When passed (the
 * autopilot reconciler injects `${homedir()}/worktrees` from the producer-side
 * snapshot), this function reaches NO environment — keeping the pure verdict path
 * env-free. When omitted, it falls back to reading `homedir()` itself, yielding the
 * byte-identical `${homedir()}/worktrees` root — safe because that fallback runs
 * PRODUCER-ONLY, never inside a fold.
 */
export function worktreePathFor(
  repoDir: string,
  branch: string,
  worktreesRoot?: string,
): string {
  const slug = branch.replace(/\//g, "-");
  const root = worktreesRoot ?? `${homedir()}/worktrees`;
  return `${root}/${repoToken(repoDir)}--${slug}`;
}

/**
 * Short stable digest of a string — FNV-1a 32-bit, base36-encoded. Pure +
 * dependency-free (no `node:crypto`, no new dep): a deterministic total function
 * of its input, identical across processes and runs. Used only to disambiguate
 * same-basename repo dirs in a worktree path — collision resistance need only be
 * good enough to separate a handful of local repo dirs, not cryptographic.
 */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * The stable dir-hash {@link worktreePathFor} folds into a lane path — {@link
 * shortHash} over the trailing-slash-stripped repo dir. Exported so a per-repo
 * synthetic dispatch key (the autopilot's `worktree-finalize:<epic>-<repoHash>`
 * per-repo finalize-failure row) hashes a repo dir the SAME way the lane path does,
 * so the producer level-clear targets the exact row it minted. Pure: no wall-clock /
 * random / syscall.
 */
export function repoDirHash(repoDir: string): string {
  return shortHash(stripTrailingSlash(repoDir));
}

/**
 * Derive the deterministic worktree plan for an epic's task DAG.
 *
 * @param epicId  The epic id — drives every derived branch name.
 * @param repoDir The epic's RESOLVED git toplevel (the producer resolves each
 *                epic's `target_repo`/`project_dir` to one toplevel before calling
 *                — see `classifyWorktreeRepos`) — drives worktree paths. Must be
 *                non-empty; an empty repo dir is a producer bug.
 * @param tasks   The epic's tasks (`epic.tasks`). Read-only; not mutated.
 * @param worktreesRoot The parent dir every lane path hangs under, threaded to
 *                {@link worktreePathFor}. When passed (the reconciler injects
 *                `${homedir()}/worktrees` producer-side), the derivation reaches no
 *                environment; when omitted it falls back to reading `homedir()`,
 *                yielding the byte-identical root.
 * @returns The {@link WorktreePlan} — base lane + every node assignment in
 *          toposort order, `__close__` last.
 * @throws WorktreeCycleError on a `depends_on` cycle.
 */
export function deriveWorktreePlan(
  epicId: string,
  repoDir: string,
  tasks: Task[],
  worktreesRoot?: string,
): WorktreePlan {
  const baseBranch = baseBranchFor(epicId);
  const baseWorktreePath = worktreePathFor(repoDir, baseBranch, worktreesRoot);

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
      worktreePath: worktreePathFor(repoDir, branch, worktreesRoot),
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

function baseName(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx < 0 ? p : p.slice(idx + 1);
}
