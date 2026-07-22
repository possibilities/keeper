// Registry behavioral conformance for the central plan-state resolver across the
// runtime-state verbs that route through it: done / claim / reconcile /
// resolve-task. Each is run from a worktree LANE with NO `--project`, asserting
// the STATE read/write lands in the epic's PRIMARY repo and the lane's
// `.keeper/state/` stays absent — the STATE-vs-PATH invariant. The lane wins the
// cwd-first locate (it carries byte-identical committed defs), then the resolver
// re-roots STATE to `epic.primary_repo`.
//
// Two root configurations are exercised per verb:
//   - primary IN the configured roots (the pre-existing discovery path), and
//   - primary OUTSIDE the configured roots — the hole this slice closes: `done`
//     SILENTLY wrote the lane and claim/reconcile/resolve-task HARD-ERRORED
//     TASK_NOT_FOUND. Both now resolve to primary via `epic.primary_repo`.
//
// CODE routing stays on the lane: KEEPER_PLAN_WORKTREE pins the worker's
// target_repo to the lane while STATE stays in primary, so a verb that surfaces
// target_repo reports the lane and primary_repo the primary — reported == the
// physical write site. The lane is simulated git-free (the fake VCS); the
// real-git analogue lives in worktree-lifecycle.test.ts (slow tier).

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  gitInit,
  parseCliOutput,
  runCli,
  seedRuntime,
  seedState,
  setRoots,
} from "./harness.ts";

const ACTOR = "alice@example.com";

const created: string[] = [];

afterEach(() => {
  for (const dir of created) {
    rmSync(dir, { recursive: true, force: true });
  }
  created.length = 0;
});

function freshDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

function statePath(root: string, taskId: string): string {
  return join(root, ".keeper", "state", "tasks", `${taskId}.state.json`);
}

function runtimeStatus(root: string, taskId: string): unknown {
  const p = statePath(root, taskId);
  if (!existsSync(p)) {
    return null;
  }
  return (JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>)
    .status;
}

interface Scenario {
  primary: string;
  lane: string;
  home: string;
  epicId: string;
  taskId: string;
}

/** Stand up a primary repo (carrying the runtime overlay) + a sibling lane dir
 * holding ONLY the committed defs (no state/). When `inRoots` the configured
 * roots point at the primary's parent; otherwise they point at an unrelated
 * empty dir so primary sits OUTSIDE the roots (the previously-broken path). The
 * primary's overlay is seeded to `seedStatus` (omit for a fresh todo task). */
function makeScenario(
  prefix: string,
  opts: { inRoots: boolean; seedStatus?: string },
): Scenario {
  const root = freshDir(`${prefix}root-`);
  const home = freshDir(`${prefix}home-`);
  const lane = freshDir(`${prefix}lane-`);
  const primary = join(root, "primary");
  mkdirSync(primary, { recursive: true });
  const epicId = "fn-1-demo";

  gitInit(primary);
  gitInit(lane);

  const [, taskIds] = seedState(primary, {
    epicId,
    nTasks: 1,
    primaryRepo: primary,
  });
  const taskId = taskIds[0] as string;
  if (opts.seedStatus) {
    seedRuntime(primary, taskId, {
      status: opts.seedStatus,
      assignee: ACTOR,
    });
  }

  // The lane carries the committed defs (identical to primary's) but NO state
  // overlay — exactly a worktree checkout where state/ is gitignored.
  seedState(lane, { epicId, nTasks: 1, primaryRepo: primary });
  rmSync(join(lane, ".keeper", "state"), { recursive: true, force: true });

  if (opts.inRoots) {
    setRoots(home, [root]);
  } else {
    // Roots point at an unrelated empty dir: primary is OUTSIDE them, so the old
    // roots-discovery resolution can't find it.
    const emptyRoot = freshDir(`${prefix}empty-`);
    setRoots(home, [emptyRoot]);
  }
  return { primary, lane, home, epicId, taskId };
}

// envWith the worktree override pinned to the lane so CODE routing follows the
// lane while STATE resolves to primary.
function laneEnv(lane: string): Record<string, string> {
  return {
    CLAUDE_CODE_SESSION_ID: "test-worktree-registry",
    KEEPER_PLAN_ACTOR: ACTOR,
    KEEPER_PLAN_WORKTREE: lane,
  };
}

for (const inRoots of [true, false]) {
  const label = inRoots ? "primary in roots" : "primary outside roots";
  describe(`plan-state resolver registry from a lane (${label})`, () => {
    test("claim writes the overlay + brief to primary, never the lane", () => {
      const { primary, lane, home, taskId } = makeScenario(
        `wsr-claim-${inRoots ? "in" : "out"}-`,
        { inRoots },
      );

      const r = runCli(["claim", taskId], {
        cwd: lane,
        home,
        env: laneEnv(lane),
      });
      expect(r.code).toBe(0);
      const payload = parseCliOutput(r.output);
      expect(payload.success).toBe(true);

      // STATE landed in primary; the lane never gained an overlay.
      expect(runtimeStatus(primary, taskId)).toBe("in_progress");
      expect(existsSync(statePath(lane, taskId))).toBe(false);
      // The brief landed under primary's gitignored state/, not the lane.
      expect(
        existsSync(
          join(primary, ".keeper", "state", "briefs", `${taskId}.json`),
        ),
      ).toBe(true);
      expect(
        existsSync(join(lane, ".keeper", "state", "briefs", `${taskId}.json`)),
      ).toBe(false);

      // CODE routing follows the lane; STATE is reported AT primary.
      expect(payload.target_repo).toBe(lane);
      expect(payload.primary_repo).toBe(realpathSync(primary));
    });

    test("done flips primary's overlay to done, never the lane", () => {
      const { primary, lane, home, taskId } = makeScenario(
        `wsr-done-${inRoots ? "in" : "out"}-`,
        { inRoots, seedStatus: "in_progress" },
      );

      const r = runCli(
        [
          "done",
          taskId,
          "--summary",
          "shipped from the lane",
          "--no-op-reason",
          "no code",
        ],
        {
          cwd: lane,
          home,
          env: laneEnv(lane),
        },
      );
      // Success proves done READ primary's in_progress overlay — a lane-resolved
      // read would see no overlay (todo) and fail the non-force gate.
      expect(r.code).toBe(0);
      expect(parseCliOutput(r.output).success).toBe(true);

      expect(runtimeStatus(primary, taskId)).toBe("done");
      expect(existsSync(statePath(lane, taskId))).toBe(false);
    });

    test("reconcile reads primary's overlay status, never the lane", () => {
      const { lane, home, taskId } = makeScenario(
        `wsr-recon-${inRoots ? "in" : "out"}-`,
        { inRoots, seedStatus: "in_progress" },
      );

      const r = runCli(["reconcile", taskId], {
        cwd: lane,
        home,
        env: laneEnv(lane),
      });
      expect(r.code).toBe(0);
      const payload = parseCliOutput(r.output);
      // The merged status reflects PRIMARY's overlay (in_progress); a lane read
      // would see todo (no overlay there).
      expect(payload.status).toBe("in_progress");
    });

    test("resolve-task reports primary state + lane code routing", () => {
      const { primary, lane, home, taskId } = makeScenario(
        `wsr-rt-${inRoots ? "in" : "out"}-`,
        { inRoots, seedStatus: "in_progress" },
      );

      const r = runCli(["resolve-task", taskId], {
        cwd: lane,
        home,
        env: laneEnv(lane),
      });
      expect(r.code).toBe(0);
      const payload = parseCliOutput(r.output);
      expect(payload.status).toBe("in_progress");
      // primary_repo / project_path resolve to primary; target_repo to the lane.
      expect(payload.primary_repo).toBe(realpathSync(primary));
      expect(payload.project_path).toBe(realpathSync(primary));
      expect(payload.target_repo).toBe(lane);
    });
  });
}
