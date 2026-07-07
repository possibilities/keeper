/**
 * Tests for the pure DAG → worktree topology module (`src/worktree-plan.ts`,
 * fn-959). Fast-tier ONLY — the module is pure (no fs / git / clock), so these
 * are synthetic-DAG unit tests with zero side effects.
 *
 * Coverage (per the early-proof-point acceptance bar):
 *   - linear chain → ONE worktree, zero pre-merges;
 *   - diamond P→{A,B}→J → P,A,J on base + B on a rib + ONE pre-merge of B into
 *     base before J (the load-bearing topology proof);
 *   - wide fan-out → first child inherits, every other forks;
 *   - multi-root → first root inherits base, extra roots fork off base;
 *   - cycle → throws WorktreeCycleError;
 *   - single task → base, no merges, `__close__` pinned to base;
 *   - byte-identical re-derivation from the same DAG.
 */

import { expect, test } from "bun:test";
import { homedir } from "node:os";
import type { Task } from "../src/types";
import {
  baseBranchFor,
  CLOSE_SINK_ID,
  deriveWorktreePlan,
  repoToken,
  ribBranchFor,
  WorktreeCycleError,
  worktreePathFor,
} from "../src/worktree-plan";

const EPIC = "fn-1-foo";
const REPO = "/Users/x/code/foo";

function task(
  taskId: string,
  taskNumber: number,
  dependsOn: string[] = [],
): Task {
  return {
    task_id: taskId,
    epic_id: EPIC,
    task_number: taskNumber,
    title: taskId,
    target_repo: null,
    tier: null,
    model: null,
    worker_phase: "open",
    runtime_status: "todo",
    depends_on: dependsOn,
    jobs: [],
  };
}

/** Index a plan's assignments by node id for ergonomic assertions. */
function byNode(tasks: Task[]) {
  const plan = deriveWorktreePlan(EPIC, REPO, tasks);
  const map = new Map(plan.assignments.map((a) => [a.nodeId, a]));
  return { plan, map };
}

// ---------------------------------------------------------------------------

test("single task: base lane, no merges, __close__ pinned to base", () => {
  const { plan, map } = byNode([task("fn-1-foo.1", 1)]);
  const base = baseBranchFor(EPIC);

  const a = map.get("fn-1-foo.1");
  expect(a?.branch).toBe(base);
  expect(a?.inherited).toBe(true);
  expect(a?.preMerges).toEqual([]);
  expect(a?.assertBranch).toBe(base);
  expect(a?.worktreePath).toBe(plan.baseWorktreePath);

  const close = map.get(CLOSE_SINK_ID);
  expect(close?.isCloseSink).toBe(true);
  expect(close?.branch).toBe(base);
  expect(close?.preMerges).toEqual([]);
  // __close__ is always last.
  expect(plan.assignments.at(-1)?.nodeId).toBe(CLOSE_SINK_ID);
});

test("linear chain: one worktree shared, zero pre-merges anywhere", () => {
  const tasks = [
    task("fn-1-foo.1", 1),
    task("fn-1-foo.2", 2, ["fn-1-foo.1"]),
    task("fn-1-foo.3", 3, ["fn-1-foo.2"]),
  ];
  const { plan, map } = byNode(tasks);
  const base = baseBranchFor(EPIC);

  for (const id of ["fn-1-foo.1", "fn-1-foo.2", "fn-1-foo.3"]) {
    expect(map.get(id)?.branch).toBe(base);
    expect(map.get(id)?.inherited).toBe(true);
    expect(map.get(id)?.preMerges).toEqual([]);
  }
  // Every node + the closer share ONE worktree path.
  const paths = new Set(plan.assignments.map((a) => a.worktreePath));
  expect(paths.size).toBe(1);
  expect(map.get(CLOSE_SINK_ID)?.preMerges).toEqual([]);
});

test("diamond P->{A,B}->J: P,A,J base + B rib + one pre-merge of B before J", () => {
  const tasks = [
    task("P", 1),
    task("A", 2, ["P"]),
    task("B", 3, ["P"]),
    task("J", 4, ["A", "B"]),
  ];
  const { map } = byNode(tasks);
  const base = baseBranchFor(EPIC);
  const ribB = ribBranchFor(EPIC, "B");

  // P, A, J ride the base lane.
  expect(map.get("P")?.branch).toBe(base);
  expect(map.get("A")?.branch).toBe(base);
  expect(map.get("J")?.branch).toBe(base);
  // B forks a rib off P's tip.
  expect(map.get("B")?.branch).toBe(ribB);
  expect(map.get("B")?.inherited).toBe(false);

  // P,A,J share the base worktree; B is its own.
  expect(map.get("A")?.worktreePath).toBe(map.get("P")?.worktreePath);
  expect(map.get("J")?.worktreePath).toBe(map.get("P")?.worktreePath);
  expect(map.get("B")?.worktreePath).not.toBe(map.get("P")?.worktreePath);

  // A→J is same-lane (no merge); B→J crosses → exactly ONE pre-merge of B.
  expect(map.get("A")?.preMerges).toEqual([]);
  expect(map.get("B")?.preMerges).toEqual([]);
  expect(map.get("J")?.preMerges).toEqual([ribB]);

  // The closer depends on the lone leaf J (on base) → no extra merge.
  expect(map.get(CLOSE_SINK_ID)?.preMerges).toEqual([]);
});

test("wide fan-out: first child inherits, every other child forks a rib", () => {
  const tasks = [
    task("P", 1),
    task("C1", 2, ["P"]),
    task("C2", 3, ["P"]),
    task("C3", 4, ["P"]),
  ];
  const { map } = byNode(tasks);
  const base = baseBranchFor(EPIC);

  expect(map.get("P")?.branch).toBe(base);
  // C1 (first in sort order) inherits base; C2/C3 fork.
  expect(map.get("C1")?.branch).toBe(base);
  expect(map.get("C1")?.inherited).toBe(true);
  expect(map.get("C2")?.branch).toBe(ribBranchFor(EPIC, "C2"));
  expect(map.get("C2")?.inherited).toBe(false);
  expect(map.get("C3")?.branch).toBe(ribBranchFor(EPIC, "C3"));
  expect(map.get("C3")?.inherited).toBe(false);

  // All three leaves are C1 (base), C2 (rib), C3 (rib): the closer merges the
  // two ribs into base, in toposort order.
  expect(map.get(CLOSE_SINK_ID)?.preMerges).toEqual([
    ribBranchFor(EPIC, "C2"),
    ribBranchFor(EPIC, "C3"),
  ]);
});

test("multi-root: first root inherits base, extra roots fork off base", () => {
  const tasks = [task("R1", 1), task("R2", 2), task("L", 3, ["R1", "R2"])];
  const { map } = byNode(tasks);
  const base = baseBranchFor(EPIC);

  expect(map.get("R1")?.branch).toBe(base);
  expect(map.get("R1")?.inherited).toBe(true);
  expect(map.get("R2")?.branch).toBe(ribBranchFor(EPIC, "R2"));
  expect(map.get("R2")?.inherited).toBe(false);
  // L's primary parent is R1 (sorts first) → inherits base; R2 crosses → merge.
  expect(map.get("L")?.branch).toBe(base);
  expect(map.get("L")?.preMerges).toEqual([ribBranchFor(EPIC, "R2")]);
});

test("disconnected DAG: every root after the first forks; closer collects all sinks", () => {
  // Two independent single-node components.
  const tasks = [task("X", 1), task("Y", 2)];
  const { map } = byNode(tasks);
  const base = baseBranchFor(EPIC);

  expect(map.get("X")?.branch).toBe(base);
  expect(map.get("Y")?.branch).toBe(ribBranchFor(EPIC, "Y"));
  // Both are leaves → closer merges Y's rib into base.
  expect(map.get(CLOSE_SINK_ID)?.preMerges).toEqual([ribBranchFor(EPIC, "Y")]);
});

test("cycle: fails loud with WorktreeCycleError", () => {
  const tasks = [
    task("fn-1-foo.1", 1, ["fn-1-foo.2"]),
    task("fn-1-foo.2", 2, ["fn-1-foo.1"]),
  ];
  expect(() => deriveWorktreePlan(EPIC, REPO, tasks)).toThrow(
    WorktreeCycleError,
  );
});

test("dangling depends_on token is ignored (treated as a root)", () => {
  const tasks = [task("fn-1-foo.1", 1, ["fn-9-nope.1"])];
  const { map } = byNode(tasks);
  // The dangling upstream is not in the DAG → fn-1-foo.1 is a root on base.
  expect(map.get("fn-1-foo.1")?.branch).toBe(baseBranchFor(EPIC));
  expect(map.get("fn-1-foo.1")?.preMerges).toEqual([]);
});

test("branch + path names are pure functions of stable ids", () => {
  expect(baseBranchFor("fn-42-x")).toBe("keeper/epic/fn-42-x");
  expect(ribBranchFor("fn-42-x", "fn-42-x.3")).toBe(
    "keeper/epic/fn-42-x--fn-42-x.3",
  );
  // Worktree path: under ~/worktrees, `<repoName>-<hash>--<branch-slug>`, branch
  // slugged. The hash is a stable digest of the repo dir (disambiguates
  // same-basename repos); assert the legible shape without pinning the digest.
  const base = worktreePathFor("/Users/x/code/foo", "keeper/epic/fn-1-foo");
  expect(base).toMatch(
    new RegExp(`^${homedir()}/worktrees/foo-[0-9a-z]+--keeper-epic-fn-1-foo$`),
  );
  // A rib slug carries `--` twice (the prefix separator + the rib's own), still
  // collision-free. A trailing slash on the repo dir folds to the same lane.
  expect(
    worktreePathFor("/Users/x/code/foo/", "keeper/epic/fn-1-foo--fn-1-foo.2"),
  ).toMatch(
    new RegExp(
      `^${homedir()}/worktrees/foo-[0-9a-z]+--keeper-epic-fn-1-foo--fn-1-foo.2$`,
    ),
  );
  // A trailing slash hashes to the same dir-hash as the bare repo dir.
  expect(worktreePathFor("/Users/x/code/foo/", "keeper/epic/fn-1-foo")).toBe(
    base,
  );
  // The worktree is OUTSIDE the repo tree (never nested under it).
  const wt = worktreePathFor("/Users/x/code/foo", "keeper/epic/fn-1-foo");
  expect(wt.startsWith("/Users/x/code/foo/")).toBe(false);
});

test("worktreePathFor disambiguates same-basename repos; stable + pure", () => {
  // Two repos with the SAME basename (`foo`) hosting a SAME-id epic must NOT
  // collide onto one worktree dir — the dir-hash separates them.
  const a = worktreePathFor("/Users/x/code/foo", "keeper/epic/fn-1-foo");
  const b = worktreePathFor("/Users/y/work/foo", "keeper/epic/fn-1-foo");
  expect(a).not.toBe(b);
  // Both still legible under ~/worktrees with the `foo` basename preserved.
  expect(a.startsWith(`${homedir()}/worktrees/foo-`)).toBe(true);
  expect(b.startsWith(`${homedir()}/worktrees/foo-`)).toBe(true);

  // Same repo + same branch → byte-identical across calls (pure, deterministic):
  // the producer (provision) and teardown (removeWorktree) derive one path.
  expect(worktreePathFor("/Users/x/code/foo", "keeper/epic/fn-1-foo")).toBe(a);
});

test("repoToken is the `<repoName>-<hash>` prefix worktreePathFor bakes into every lane path", () => {
  // The `repair::<repo-token>` escalation key (src/dispatch-command.ts,
  // cli/escalation-brief.ts) reuses THIS derivation rather than a second
  // hand-rolled one — so it must match the leading segment of a lane path
  // byte-for-byte, not merely look similar.
  const token = repoToken("/Users/x/code/foo");
  expect(token).toMatch(/^foo-[0-9a-z]+$/);
  const lane = worktreePathFor("/Users/x/code/foo", "keeper/epic/fn-1-foo");
  expect(lane).toBe(`${homedir()}/worktrees/${token}--keeper-epic-fn-1-foo`);

  // Pure + trailing-slash-insensitive, same as worktreePathFor.
  expect(repoToken("/Users/x/code/foo/")).toBe(token);
  expect(repoToken("/Users/x/code/foo")).toBe(token);

  // Disambiguates same-basename repos the identical way worktreePathFor does.
  expect(repoToken("/Users/y/work/foo")).not.toBe(token);
});

test("re-derivation from the same DAG is byte-identical", () => {
  const tasks = [
    task("P", 1),
    task("A", 2, ["P"]),
    task("B", 3, ["P"]),
    task("J", 4, ["A", "B"]),
  ];
  const a = deriveWorktreePlan(EPIC, REPO, tasks);
  const b = deriveWorktreePlan(EPIC, REPO, tasks);
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));

  // Input task ORDER must not change the output (the toposort is keyed on
  // (task_number, task_id), not array position).
  const shuffled = [tasks[3], tasks[1], tasks[0], tasks[2]];
  const c = deriveWorktreePlan(EPIC, REPO, shuffled);
  expect(JSON.stringify(c)).toBe(JSON.stringify(a));
});

test("tie-break is (task_number, task_id): equal numbers fall back to id order", () => {
  // Two children of P with the SAME task_number → the lexard-smaller task_id is
  // the primary/first child and inherits base.
  const tasks = [
    task("P", 1),
    task("fn-1-foo.zeta", 2, ["P"]),
    task("fn-1-foo.alpha", 2, ["P"]),
  ];
  const { map } = byNode(tasks);
  // alpha < zeta → alpha inherits base, zeta forks.
  expect(map.get("fn-1-foo.alpha")?.branch).toBe(baseBranchFor(EPIC));
  expect(map.get("fn-1-foo.zeta")?.branch).toBe(
    ribBranchFor(EPIC, "fn-1-foo.zeta"),
  );
});

// ---------------------------------------------------------------------------
// fn-1034 — per-group derivation for a CLUSTERED multi-repo epic. Each per-repo
// group calls deriveWorktreePlan with ONLY its own tasks, so a `depends_on` token
// pointing at a SIBLING group's task (a cross-repo edge) is out-of-group and
// dropped by the in-group parent filter — it never forks a lane across the repo
// boundary. Cross-repo deps survive ONLY as readiness serialization barriers.
// ---------------------------------------------------------------------------

test("fn-1034 per-group: an out-of-group depends_on token is dropped (cross-repo edge → in-group root)", () => {
  // `g.1` depends on `other.9`, which lives in a SIBLING repo group and is NOT in
  // the tasks passed here — so `g.1` has no in-group parent and rides the base
  // lane as a root (no rib, no pre-merge). The cross-repo edge is invisible to the
  // lane geometry.
  const { plan, map } = byNode([task("g.1", 1, ["other.9"])]);
  const base = baseBranchFor(EPIC);
  const a = map.get("g.1");
  expect(a?.branch).toBe(base);
  expect(a?.inherited).toBe(true);
  expect(a?.preMerges).toEqual([]);
  // No rib was cut for the phantom cross-repo parent.
  expect(plan.assignments.map((x) => x.nodeId)).toEqual(["g.1", CLOSE_SINK_ID]);
});

test("fn-1034 per-group: an in-group fork still ribs; only the cross-repo token is filtered", () => {
  // `g.J` fans in an IN-GROUP rib (`g.B`) AND a cross-repo token (`other.9`). The
  // in-group fork/merge is preserved; the cross-repo token is dropped.
  const tasks = [
    task("g.P", 1),
    task("g.A", 2, ["g.P"]),
    task("g.B", 3, ["g.P"]),
    task("g.J", 4, ["g.A", "g.B", "other.9"]),
  ];
  const { map } = byNode(tasks);
  const base = baseBranchFor(EPIC);
  // The in-group diamond is intact: B ribs, J pre-merges B.
  expect(map.get("g.B")?.branch).toBe(ribBranchFor(EPIC, "g.B"));
  expect(map.get("g.J")?.branch).toBe(base);
  expect(map.get("g.J")?.preMerges).toEqual([ribBranchFor(EPIC, "g.B")]);
});
