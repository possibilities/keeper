// Real-git base + rib + fan-in fork topology — the slow-tier proof that the FLAT
// rib branch scheme (`keeper/epic/<id>--<task>`) provisions a FORKED DAG with NO
// git directory/file ref collision, that listEpicBaseBranches enumerates only the
// base (never a rib), that the fan-in merges every lane, and that teardown prunes
// BOTH the base AND the ribs (no leak). The 1-lane worktree-lifecycle test cannot
// catch this: a directory/file ref conflict only arises once a rib is provisioned
// ALONGSIDE the base ref it would otherwise nest under, and only a multi-rib board
// exercises the base-vs-rib enumeration split.
//
// Gated describe.skipIf(!SLOW_ENABLED): the default `bun test` skips it; only the
// wired `bun run test:slow` (KEEPER_PLAN_RUN_SLOW=1) spawns the real `git`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listEpicBaseBranches } from "../../../src/worktree-git.ts";
import { baseBranchFor, ribBranchFor } from "../../../src/worktree-plan.ts";
import { git, gitQuiet, isAncestor, SLOW_ENABLED } from "./harness.ts";

describe.skipIf(!SLOW_ENABLED)("worktree fork topology (real git)", () => {
  let main: string;
  const lanes: string[] = [];

  /** Reserve a unique worktree path then remove the dir so `worktree add` (which
   * wants a fresh path) can create it; track it for tolerant cleanup. */
  function reserveLane(): string {
    const lane = mkdtempSync(join(tmpdir(), "planctl-wt-fork-lane-"));
    rmSync(lane, { recursive: true, force: true });
    lanes.push(lane);
    return lane;
  }

  beforeEach(() => {
    lanes.length = 0;
    main = mkdtempSync(join(tmpdir(), "planctl-wt-fork-main-"));
    git(["init", "-q", "-b", "main"], main);
    git(["config", "user.email", "test@planctl.local"], main);
    git(["config", "user.name", "Planctl Test"], main);
    git(["config", "commit.gpgsign", "false"], main);
    writeFileSync(join(main, "README"), "seed\n");
    git(["add", "README"], main);
    git(["commit", "-q", "-m", "seed"], main);
  });

  afterEach(() => {
    for (const lane of lanes) {
      gitQuiet(["worktree", "remove", "--force", lane], main);
      rmSync(lane, { recursive: true, force: true });
    }
    gitQuiet(["worktree", "prune"], main);
    if (main) {
      rmSync(main, { recursive: true, force: true });
    }
  });

  test("base + 2 ribs + fan-in: no D/F ref collision, base-only enumeration, fan-in merges, teardown prunes base + ribs", async () => {
    const epicId = "fn-985-fork";
    const base = baseBranchFor(epicId); // keeper/epic/fn-985-fork
    const ribA = ribBranchFor(epicId, `${epicId}.2`); // keeper/epic/fn-985-fork--fn-985-fork.2
    const ribB = ribBranchFor(epicId, `${epicId}.3`); // keeper/epic/fn-985-fork--fn-985-fork.3

    // The core invariant: a rib must NEVER be a path-prefix of the base ref (the
    // directory/file ref conflict). A slashed rib would `startsWith(base + "/")`.
    expect(ribA.startsWith(`${base}/`)).toBe(false);
    expect(ribB.startsWith(`${base}/`)).toBe(false);

    // PROVISION the base lane off the seed.
    const baseLane = reserveLane();
    git(["worktree", "add", "-b", base, baseLane, "HEAD"], main);

    // PROVISION two ribs forked off the base tip. THIS is the R1 explosion point:
    // with a slashed `keeper/epic/<id>/<task>` rib, git cannot hold both the base
    // ref (a file at `keeper/epic/<id>`) and the rib (a dir `keeper/epic/<id>/`)
    // at once — `worktree add` would fail. The flat `--` scheme provisions cleanly.
    const laneA = reserveLane();
    git(["worktree", "add", "-b", ribA, laneA, base], main);
    const laneB = reserveLane();
    git(["worktree", "add", "-b", ribB, laneB, base], main);

    // listEpicBaseBranches must enumerate the BASE only — never mis-count a rib as
    // a base (a misclassified rib would be merged to the default branch). Run it
    // against REAL git refs (the default `gitExec` runner).
    const enumerated = await listEpicBaseBranches(main);
    expect(enumerated).toEqual([{ branch: base, epicId }]);

    // COMMIT distinct work on each rib.
    writeFileSync(join(laneA, "a.txt"), "rib A\n");
    git(["add", "a.txt"], laneA);
    git(["commit", "-q", "-m", "rib A work"], laneA);
    const shaA = git(["rev-parse", "HEAD"], laneA).trim();

    writeFileSync(join(laneB, "b.txt"), "rib B\n");
    git(["add", "b.txt"], laneB);
    git(["commit", "-q", "-m", "rib B work"], laneB);
    const shaB = git(["rev-parse", "HEAD"], laneB).trim();

    // FAN-IN on the base lane: merge both ribs (sequential pairwise, never octopus).
    git(["merge", "--no-ff", "-m", "merge rib A", ribA], baseLane);
    git(["merge", "--no-ff", "-m", "merge rib B", ribB], baseLane);
    // Both ribs' work landed on the base lane.
    expect(isAncestor(shaA, "HEAD", baseLane)).toBe(true);
    expect(isAncestor(shaB, "HEAD", baseLane)).toBe(true);
    git(["cat-file", "-e", "HEAD:a.txt"], baseLane);
    git(["cat-file", "-e", "HEAD:b.txt"], baseLane);

    // MERGE base into main (the single push-to-default at close) in the main worktree.
    git(["merge", "--no-ff", "-m", "merge base into main", base], main);
    const baseTip = git(["rev-parse", `refs/heads/${base}`], main).trim();
    expect(isAncestor(baseTip, "HEAD", main)).toBe(true);

    // TEARDOWN — remove every worktree, THEN delete the now fully-merged base + rib
    // branches. Order matters: a branch checked out in a worktree can't be deleted.
    for (const lane of [baseLane, laneA, laneB]) {
      git(["worktree", "remove", lane], main);
    }
    for (const br of [ribA, ribB, base]) {
      git(["branch", "-D", br], main);
    }

    // Nothing leaks: no `keeper/epic/*` branch and no registered lane worktree left,
    // and a re-enumeration finds no base to recover.
    expect(git(["branch", "--list", "keeper/epic/*"], main).trim()).toBe("");
    expect(await listEpicBaseBranches(main)).toEqual([]);
    const wtList = git(["worktree", "list", "--porcelain"], main);
    for (const lane of [baseLane, laneA, laneB]) {
      expect(wtList.includes(lane)).toBe(false);
    }
  });
});
