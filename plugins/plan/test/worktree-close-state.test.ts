// Conformance spec for the close phase resolving plan STATE to the epic's
// primary repo when the close runs from a worktree LANE — the pure (git-free)
// tier. In worktree mode the close orchestrator is dispatched into the epic's
// lane, but the runtime status overlay + close artifacts live ONLY in the
// primary repo (`.keeper/.gitignore` is `state/`, so state/ is never checked out
// into a lane) while the epic/task JSON defs ARE committed and so appear
// identical in both. A cwd-resolved context therefore reads stale lane state and
// reports TASKS_NOT_DONE; routing every plan-state read through a primary-rooted
// context fixes it.
//
// The lane is simulated by seeding a full .keeper/ tree in a "primary" dir
// (carrying the done runtime overlay), then a second "lane" dir carrying ONLY
// the committed defs (epic/task JSON + specs), with its state/ removed — exactly
// what a real worktree checkout sees. The epic def's primary_repo points back at
// the primary in both. The real-git analogue lives in worktree-lifecycle.test.ts
// (slow tier).

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { briefPath } from "../src/audit_artifacts.ts";
import {
  gitInit,
  parseCliOutput,
  runCli,
  seedRuntime,
  seedState,
} from "./harness.ts";

// Dirs minted per test, torn down in afterEach (these tests build their own
// primary/lane/home rather than using withProject's single-root fixture).
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

interface LaneScenario {
  primary: string;
  lane: string;
  home: string;
  epicId: string;
  taskIds: string[];
}

/** Stand up a primary repo carrying the done runtime overlay + a sibling lane
 * dir holding ONLY the committed defs (no state/). `statuses[i] === "done"`
 * marks task i+1 done in PRIMARY's overlay; the lane never carries any overlay. */
function makeLaneScenario(prefix: string, statuses: string[]): LaneScenario {
  const primary = freshDir(`${prefix}primary-`);
  const lane = freshDir(`${prefix}lane-`);
  const home = freshDir(`${prefix}home-`);
  const epicId = "fn-1-demo";

  // Both are git repos so findCommitGroups (primary) and the cwd-walk (lane)
  // see a `.git` entry; the fake VCS's isGitRepo just probes for it.
  gitInit(primary);
  gitInit(lane);

  const [, taskIds] = seedState(primary, {
    epicId,
    nTasks: statuses.length,
    primaryRepo: primary,
  });
  statuses.forEach((status, i) => {
    if (status === "done") {
      seedRuntime(primary, taskIds[i] as string, { status: "done" });
    }
  });

  // The lane carries the committed defs (identical to primary's) but NO state
  // overlay — exactly a worktree checkout where state/ is gitignored.
  seedState(lane, { epicId, nTasks: statuses.length, primaryRepo: primary });
  rmSync(join(lane, ".keeper", "state"), { recursive: true, force: true });

  return { primary, lane, home, epicId, taskIds };
}

describe("close-preflight resolves plan-state to primary from a lane", () => {
  test("a done epic reads ready-to-close from the lane (state resolved to primary)", () => {
    const { primary, lane, home, epicId, taskIds } = makeLaneScenario(
      "planctl-wcs-ok-",
      ["done", "done"],
    );

    const r = runCli(["close-preflight", epicId], { cwd: lane, home });
    expect(r.code).toBe(0);
    const env = parseCliOutput(r.output);
    expect(env.all_done).toBe(true);
    // The envelope's primary_repo is the epic's primary, not the lane cwd.
    expect(env.primary_repo).toBe(primary);
    const tasks = env.tasks as Array<Record<string, unknown>>;
    expect(tasks.map((t) => t.id)).toEqual(taskIds);
    expect(tasks.map((t) => t.status)).toEqual(["done", "done"]);

    // The brief landed in PRIMARY, never the lane (state always resolves to
    // primary — the invariant this honors).
    expect(existsSync(briefPath(primary, epicId))).toBe(true);
    expect(existsSync(briefPath(lane, epicId))).toBe(false);
  });

  test("primary's actual not-done state is read truthfully from the lane", () => {
    // The fix reads primary's REAL state, not a blanket pass: one task done +
    // one todo in primary still surfaces TASKS_NOT_DONE naming the open task.
    const { lane, home, epicId, taskIds } = makeLaneScenario(
      "planctl-wcs-nd-",
      ["done", "todo"],
    );

    const r = runCli(["close-preflight", epicId], { cwd: lane, home });
    expect(r.code).toBe(1);
    const error = parseCliOutput(r.output).error as Record<string, unknown>;
    expect(error.code).toBe("TASKS_NOT_DONE");
    expect((error.details as Record<string, unknown>).not_done).toEqual([
      taskIds[1],
    ]);
  });

  test("non-worktree path is unchanged: --project==cwd resolves identically", () => {
    // When cwd is the primary (the non-worktree close path), contextForRoot of
    // the primary is a no-op over the cwd ctx — the success envelope is the same.
    const { primary, home, epicId } = makeLaneScenario("planctl-wcs-np-", [
      "done",
    ]);
    const r = runCli(["close-preflight", epicId, "--project", primary], {
      cwd: primary,
      home,
    });
    expect(r.code).toBe(0);
    const env = parseCliOutput(r.output);
    expect(env.all_done).toBe(true);
    expect(env.primary_repo).toBe(primary);
    expect(existsSync(briefPath(primary, epicId))).toBe(true);
  });
});

describe("close-phase submits resolve artifacts to primary from a lane", () => {
  // resolveAuditContext is the shared brief-finding seam every submit verb
  // (audit / verdict / followup) routes through, so `--project "$PRIMARY_REPO"`
  // from a lane cwd makes all three find the brief in primary. Audit submit is
  // the canonical lock; a verdict submit confirms the same seam from a second
  // verb entry.

  function seedBriefViaPreflight(s: LaneScenario): void {
    const pre = runCli(["close-preflight", s.epicId], {
      cwd: s.lane,
      home: s.home,
    });
    expect(pre.code).toBe(0);
    expect(existsSync(briefPath(s.primary, s.epicId))).toBe(true);
  }

  test("audit submit from a lane with --project=primary finds the brief", () => {
    const s = makeLaneScenario("planctl-wcs-sub-", ["done"]);
    seedBriefViaPreflight(s);

    const ok = runCli(
      [
        "audit",
        "submit",
        s.epicId,
        "--project",
        s.primary,
        "--file",
        "-",
        "--risk",
        "Low",
      ],
      { cwd: s.lane, home: s.home, input: "# report\n" },
    );
    expect(ok.code).toBe(0);
    expect(parseCliOutput(ok.output).success).toBe(true);
  });

  test("audit submit from a lane WITHOUT --project misses the brief (BRIEF_MISSING)", () => {
    // The regression this fix's --project wiring exists to prevent: a lane-cwd
    // submit with no --project cwd-walks into the lane, where no brief lives.
    const s = makeLaneScenario("planctl-wcs-miss-", ["done"]);
    seedBriefViaPreflight(s);

    const miss = runCli(
      ["audit", "submit", s.epicId, "--file", "-", "--risk", "Low"],
      { cwd: s.lane, home: s.home, input: "# report\n" },
    );
    expect(miss.code).toBe(1);
    expect(
      (parseCliOutput(miss.output).error as Record<string, unknown>).code,
    ).toBe("BRIEF_MISSING");
  });

  test("verdict submit from a lane with --project=primary clears brief resolution", () => {
    const s = makeLaneScenario("planctl-wcs-vsub-", ["done"]);
    seedBriefViaPreflight(s);

    // A `{}` payload fails verdict validation, but the point is that --project
    // routes past the shared brief-finding seam: the error is NOT BRIEF_MISSING.
    const r = runCli(
      ["verdict", "submit", s.epicId, "--project", s.primary, "--file", "-"],
      { cwd: s.lane, home: s.home, input: "{}\n" },
    );
    expect(r.code).toBe(1);
    const error = parseCliOutput(r.output).error as Record<string, unknown>;
    expect(error.code).not.toBe("BRIEF_MISSING");
  });
});
