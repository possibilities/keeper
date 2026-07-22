// Conformance spec for the worker `done` flip resolving the task's runtime
// state to the epic's PRIMARY repo when `done` runs from a worktree LANE — the
// pure (git-free) tier. In worktree mode the worker/closer cwd is the epic's
// lane, whose COMMITTED `.keeper/` defs would fool a cwd-first resolver into
// writing the gitignored runtime overlay to the lane (where it never lives, so
// done reads back "not in_progress"). Routing done's owning-project resolution
// through lane-blind roots discovery (like claim) lands the flip on primary.
//
// The lane is simulated by seeding a full `.keeper/` tree in a "primary" dir
// (an immediate child of a configured root, carrying the in_progress overlay),
// then a second "lane" dir OUTSIDE any configured root holding ONLY the
// committed defs with state/ stripped — exactly what a real worktree checkout
// sees. The epic def's primary_repo points at the primary in both. The real-git
// analogue lives in worktree-lifecycle.test.ts (slow tier).

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

// done fails closed without a session id; the actor matches the seeded assignee
// so the non-force in_progress + assignee gate passes when state resolves right.
const ENV = {
  CLAUDE_CODE_SESSION_ID: "test-worktree-done",
  KEEPER_PLAN_ACTOR: "alice@example.com",
};

// Dirs minted per test, torn down in afterEach (these tests build their own
// root/primary/lane/home rather than using withProject's single-root fixture).
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
  root: string;
  primary: string;
  lane: string;
  home: string;
  epicId: string;
  taskId: string;
}

/** Stand up a primary repo (an immediate child of a configured root, carrying
 * the in_progress runtime overlay) + a sibling lane dir OUTSIDE any root holding
 * ONLY the committed defs (no state/). Roots point at the primary's parent, so
 * lane-blind discovery lands on primary and never the lane. */
function makeScenario(prefix: string): Scenario {
  const root = freshDir(`${prefix}root-`);
  const home = freshDir(`${prefix}home-`);
  const lane = freshDir(`${prefix}lane-`);
  const primary = join(root, "primary");
  mkdirSync(primary, { recursive: true });
  const epicId = "fn-1-demo";

  // Both are git repos so the fake VCS sees a `.git` entry on each.
  gitInit(primary);
  gitInit(lane);

  const [, taskIds] = seedState(primary, {
    epicId,
    nTasks: 1,
    primaryRepo: primary,
  });
  const taskId = taskIds[0] as string;
  // The task is in_progress in PRIMARY's overlay ONLY.
  seedRuntime(primary, taskId, {
    status: "in_progress",
    assignee: "alice@example.com",
  });

  // The lane carries the committed defs (identical to primary's) but NO state
  // overlay — exactly a worktree checkout where state/ is gitignored.
  seedState(lane, { epicId, nTasks: 1, primaryRepo: primary });
  rmSync(join(lane, ".keeper", "state"), { recursive: true, force: true });

  setRoots(home, [root]);
  return { root, primary, lane, home, epicId, taskId };
}

describe("done resolves the runtime flip to primary from a lane", () => {
  test("done-from-lane flips primary's overlay, never the lane's", () => {
    const { primary, lane, home, taskId } = makeScenario("planctl-wds-ok-");

    const r = runCli(
      [
        "done",
        taskId,
        "--summary",
        "shipped from the lane",
        "--no-op-reason",
        "fixture: no code",
      ],
      {
        cwd: lane,
        home,
        env: ENV,
      },
    );
    // Success proves done read PRIMARY's in_progress overlay — a lane-resolved
    // read would see no overlay (status todo) and fail "not in_progress".
    expect(r.code).toBe(0);
    expect(parseCliOutput(r.output).success).toBe(true);

    // The flip landed in PRIMARY's gitignored overlay...
    expect(runtimeStatus(primary, taskId)).toBe("done");
    // ...and the lane never gained a state overlay (the invariant honored).
    expect(existsSync(statePath(lane, taskId))).toBe(false);
  });

  test("--project override stays authoritative from a lane", () => {
    const { primary, lane, home, taskId } = makeScenario("planctl-wds-proj-");

    const r = runCli(
      [
        "done",
        taskId,
        "--summary",
        "via project override",
        "--no-op-reason",
        "fixture: no code",
        "--project",
        primary,
      ],
      { cwd: lane, home, env: ENV },
    );
    expect(r.code).toBe(0);
    expect(runtimeStatus(primary, taskId)).toBe("done");
    expect(existsSync(statePath(lane, taskId))).toBe(false);
  });

  test("single-project non-worktree use is unaffected (no configured roots)", () => {
    // With no roots config, lane-blind discovery yields zero, so done falls back
    // to the shared cwd-then-global resolver and still flips the cwd project.
    const { primary, taskId } = makeScenario("planctl-wds-single-");
    const homeNoRoots = freshDir("planctl-wds-noroots-home-");

    const r = runCli(
      [
        "done",
        taskId,
        "--summary",
        "single project",
        "--no-op-reason",
        "fixture: no code",
      ],
      {
        cwd: primary,
        home: homeNoRoots,
        env: ENV,
      },
    );
    expect(r.code).toBe(0);
    expect(runtimeStatus(primary, taskId)).toBe("done");
  });
});
