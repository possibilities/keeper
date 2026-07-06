// Conformance spec for the pure-overlay-writer verbs (block / unblock / task
// reset) resolving their runtime-state writes to the epic's PRIMARY repo when run
// from a worktree LANE — the pure (git-free) tier. In worktree mode the cwd is
// the epic's lane, whose COMMITTED `.keeper/` defs would fool a cwd-first
// resolver into writing the gitignored runtime overlay to the lane (where it
// never lives). Routing every state write through resolvePlanStateContext lands
// the flip on primary; `--project` stays authoritative.
//
// The lane is simulated by seeding a full `.keeper/` tree in a "primary" dir
// (carrying the overlay), then a "lane" dir OUTSIDE any configured root holding
// ONLY the committed defs with state/ stripped — exactly what a real worktree
// checkout sees. The epic def's primary_repo points at the primary in both.

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FROZEN_CLOCK,
  gitInit,
  parseCliOutput,
  runCli,
  seedRuntime,
  seedState,
  setRoots,
} from "./harness.ts";

const ENV = {
  CLAUDE_CODE_SESSION_ID: "test-worktree-overlay",
  KEEPER_PLAN_ACTOR: "alice@example.com",
};

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

/** Stand up a primary (child of a configured root) + a sibling lane OUTSIDE any
 * root holding ONLY the committed defs (no state/). The primary's runtime overlay
 * for the task is seeded to `status`. */
function makeScenario(prefix: string, status: string): Scenario {
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
  seedRuntime(primary, taskId, { status, assignee: "alice@example.com" });

  seedState(lane, { epicId, nTasks: 1, primaryRepo: primary });
  rmSync(join(lane, ".keeper", "state"), { recursive: true, force: true });

  setRoots(home, [root]);
  return { root, primary, lane, home, epicId, taskId };
}

describe("block resolves the overlay flip to primary from a lane", () => {
  test("block-from-lane flips primary's overlay, never the lane's", () => {
    const { primary, lane, home, taskId } = makeScenario(
      "planctl-wbs-block-",
      "in_progress",
    );

    const r = runCli(["block", taskId, "--reason", "waiting on api"], {
      cwd: lane,
      home,
      env: ENV,
    });
    expect(r.code).toBe(0);
    expect(parseCliOutput(r.output).success).toBe(true);
    expect(runtimeStatus(primary, taskId)).toBe("blocked");
    expect(existsSync(statePath(lane, taskId))).toBe(false);
  });

  test("--project override stays authoritative from a lane", () => {
    const { primary, lane, home, taskId } = makeScenario(
      "planctl-wbs-block-proj-",
      "in_progress",
    );

    const r = runCli(
      ["block", taskId, "--reason", "stuck", "--project", primary],
      { cwd: lane, home, env: ENV },
    );
    expect(r.code).toBe(0);
    expect(runtimeStatus(primary, taskId)).toBe("blocked");
    expect(existsSync(statePath(lane, taskId))).toBe(false);
  });
});

describe("unblock resolves the overlay flip to primary from a lane", () => {
  test("unblock-from-lane flips primary's blocked overlay back to todo", () => {
    const { primary, lane, home, taskId } = makeScenario(
      "planctl-wbs-unblock-",
      "blocked",
    );

    const r = runCli(["unblock", taskId], { cwd: lane, home, env: ENV });
    expect(r.code).toBe(0);
    expect(parseCliOutput(r.output).success).toBe(true);
    expect(runtimeStatus(primary, taskId)).toBe("todo");
    expect(existsSync(statePath(lane, taskId))).toBe(false);
  });
});

describe("task reset resolves the overlay flip to primary from a lane", () => {
  test("reset-from-lane flips primary's overlay + clears primary's def state", () => {
    const { primary, lane, home, taskId, epicId } = makeScenario(
      "planctl-wbs-reset-",
      "done",
    );

    // Primary's committed def carries a stale worker_done_at + a filled spec —
    // exactly the residue reset clears. (The lane's identical defs are untouched.)
    const taskJsonPath = join(primary, ".keeper", "tasks", `${taskId}.json`);
    const taskDef = JSON.parse(readFileSync(taskJsonPath, "utf-8")) as Record<
      string,
      unknown
    >;
    taskDef.worker_done_at = "2026-01-01T00:00:00.000000Z";
    writeFileSync(taskJsonPath, JSON.stringify(taskDef), "utf-8");
    const specPath = join(primary, ".keeper", "specs", `${taskId}.md`);
    writeFileSync(
      specPath,
      "## Description\nx\n\n## Acceptance\n- [ ] x\n\n" +
        "## Done summary\nall shipped\n\n## Evidence\nlots\n",
      "utf-8",
    );

    const r = runCli(["task", "reset", taskId], {
      cwd: lane,
      home,
      env: { ...ENV, KEEPER_PLAN_NOW: FROZEN_CLOCK },
    });
    expect(r.code).toBe(0);
    expect(parseCliOutput(r.output).status).toBe("todo");

    // The flip + def cleanup landed in PRIMARY...
    expect(runtimeStatus(primary, taskId)).toBe("todo");
    const reread = JSON.parse(readFileSync(taskJsonPath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(reread.worker_done_at).toBeNull();
    const spec = readFileSync(specPath, "utf-8");
    expect(spec).not.toContain("all shipped");
    // ...the epic write (reset rides the integrity gate, bumping updated_at)
    // landed in primary too, and the marker stays null — a gate verb never arms...
    const epicDef = JSON.parse(
      readFileSync(
        join(primary, ".keeper", "epics", `${epicId}.json`),
        "utf-8",
      ),
    ) as Record<string, unknown>;
    expect(epicDef.updated_at).toBe(FROZEN_CLOCK);
    expect(epicDef.last_validated_at ?? null).toBeNull();
    // ...and the lane never gained a state overlay.
    expect(existsSync(statePath(lane, taskId))).toBe(false);
  });
});
