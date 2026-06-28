// Real-git worktree-lane lifecycle — the slow-tier proof the pure suite cannot
// give. Drives the full worktree-mode cycle on a real temp repo:
//   provision -> claim-in-lane (the Task-1 runtime seam) -> commit -> finalize
// where the FINALIZE step is the production `createWorktreeDriver().finalizeEpic`
// — the REAL close-sink merge + teardown, not a hand-rolled `git merge --no-ff`.
// It drives the exact config the routing bug failed on: the epic is done in the
// MAIN projection (isEpicDone true, simulating the closer's done-write to the
// PRIMARY repo) while the lane carries real commits and NO done-state of its own.
// Asserts the worker's commit lands on the LANE branch (never main), finalize
// merges it cleanly to main + pushes, and teardown removes the worktree + branch.
// The claim-in-lane step exercises resolveWorkerRepos (the one runtime seam claim
// routes through) against a REAL lane dir, so realpath normalization runs on a
// path that exists — coverage the fast tier (non-existent absolute paths) skips.
//
// CRITICAL: the commit step runs under an inherited main-pointed GIT_* env — the
// exact pollution that made lane commits leak onto main. The real commit path
// strips GIT_* so cwd alone decides the branch; without this scenario the test
// would not catch the original bug class.
//
// Gated describe.skipIf(!SLOW_ENABLED): the default `bun test` skips it; only the
// wired `bun run test:slow` (KEEPER_PLAN_RUN_SLOW=1) spawns the real `git`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createWorktreeDriver,
  type WorktreeLaunchInfo,
} from "../../../src/autopilot-worker.ts";
import { briefPath } from "../src/audit_artifacts.ts";
import { autoCommitFromInvocation } from "../src/commit.ts";
import { resolveWorkerRepos, worktreeOverride } from "../src/runtime_status.ts";
import {
  parseCliOutput,
  runCli,
  SLOW_ENABLED,
  seedRuntime,
  seedState,
} from "./harness.ts";

function git(args: string[], cwd: string): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
}

/** Non-throwing git for tolerant teardown — a mid-cycle failure must not mask
 * the assertion that tripped it. */
function gitQuiet(args: string[], cwd: string): void {
  Bun.spawnSync(["git", ...args], { cwd });
}

function headSha(cwd: string): string {
  return git(["rev-parse", "HEAD"], cwd).trim();
}

function commitCount(cwd: string): number {
  const proc = Bun.spawnSync(["git", "rev-list", "--count", "HEAD"], { cwd });
  if (proc.exitCode !== 0) {
    return 0;
  }
  return Number.parseInt(proc.stdout.toString().trim(), 10);
}

/** True iff `ancestor` is reachable from `ref` (exit 0/1, never throws). */
function isAncestor(ancestor: string, ref: string, cwd: string): boolean {
  return (
    Bun.spawnSync(["git", "merge-base", "--is-ancestor", ancestor, ref], {
      cwd,
    }).exitCode === 0
  );
}

/** Set or delete `process.env[key]` — the save/restore primitive for the GIT_*
 * and KEEPER_PLAN_WORKTREE pollution windows. */
function setOrDeleteEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe.skipIf(!SLOW_ENABLED)("worktree-lane lifecycle (real git)", () => {
  let main: string;
  let origin: string;

  beforeEach(() => {
    main = mkdtempSync(join(tmpdir(), "planctl-wt-main-"));
    git(["init", "-q", "-b", "main"], main);
    git(["config", "user.email", "test@planctl.local"], main);
    git(["config", "user.name", "Planctl Test"], main);
    git(["config", "commit.gpgsign", "false"], main);
    writeFileSync(join(main, "README"), "seed\n");
    git(["add", "README"], main);
    git(["commit", "-q", "-m", "seed"], main);
    // A bare origin so the real finalize push has a remote to fast-forward.
    origin = mkdtempSync(join(tmpdir(), "planctl-wt-origin-"));
    git(["init", "-q", "--bare", "-b", "main"], origin);
    git(["remote", "add", "origin", origin], main);
    git(["push", "-q", "-u", "origin", "main"], main);
  });

  afterEach(() => {
    for (const dir of [main, origin]) {
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("provision -> claim-in-lane -> commit -> finalize (real close-sink merge + teardown)", async () => {
    const seedSha = headSha(main);

    // PROVISION — a lane linked worktree on its own lane branch, forked off the
    // seed. `worktree add` wants a fresh path, so reserve a unique name then
    // remove the dir before adding.
    const lane = mkdtempSync(join(tmpdir(), "planctl-wt-lane-"));
    rmSync(lane, { recursive: true, force: true });
    const laneBranch = "keeper/epic/fn-984-lane";
    git(["worktree", "add", "-b", laneBranch, lane, "HEAD"], main);

    try {
      // CLAIM-IN-LANE — the runtime seam resolves the worker's target_repo to
      // the lane via KEEPER_PLAN_WORKTREE (winning over an explicit primary
      // target_repo), while plan STATE (primary_repo) stays on the primary repo.
      const priorWt = process.env.KEEPER_PLAN_WORKTREE;
      try {
        process.env.KEEPER_PLAN_WORKTREE = lane;
        expect(worktreeOverride()).toBe(lane);
        const repos = resolveWorkerRepos(
          { target_repo: main },
          { primary_repo: main },
          main,
        );
        // The worker cds into the lane (realpath-normalized real dir)...
        expect(repos.targetRepo).toBe(realpathSync(lane));
        // ...but plan state never follows the lane.
        expect(repos.primaryRepo).toBe(realpathSync(main));
      } finally {
        setOrDeleteEnv("KEEPER_PLAN_WORKTREE", priorWt);
      }

      // COMMIT — a worker commit on the lane, made under an inherited main-pointed
      // GIT_* env (the original lane-leak bug class). The real commit path strips
      // GIT_* so the explicit lane cwd alone decides the branch.
      const rel = "lane_work.txt";
      writeFileSync(join(lane, rel), "lane work\n");
      const prior = {
        GIT_DIR: process.env.GIT_DIR,
        GIT_WORK_TREE: process.env.GIT_WORK_TREE,
        GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
        GIT_COMMON_DIR: process.env.GIT_COMMON_DIR,
      };
      let sha: string | null;
      try {
        process.env.GIT_DIR = join(main, ".git");
        process.env.GIT_WORK_TREE = main;
        process.env.GIT_INDEX_FILE = join(main, ".git", "index");
        process.env.GIT_COMMON_DIR = join(main, ".git");
        sha = autoCommitFromInvocation({
          files: [rel],
          op: "done",
          target: "fn-984-lane.1",
          subject: "chore(plan): done fn-984-lane.1",
          state_repo: lane,
          repo_root: lane,
        });
      } finally {
        // Restore BEFORE any assertion git() call — the helper inherits env.
        for (const [k, v] of Object.entries(prior)) {
          setOrDeleteEnv(k, v);
        }
      }

      // The work commit advanced the LANE branch and left main untouched.
      expect(sha).not.toBeNull();
      expect(git(["rev-parse", `refs/heads/${laneBranch}`], main).trim()).toBe(
        sha as string,
      );
      expect(git(["rev-parse", "refs/heads/main"], main).trim()).toBe(seedSha);
      expect(commitCount(main)).toBe(1); // seed only — no leak

      // FINALIZE — the REAL close-sink merge + teardown. The epic is done in the
      // MAIN projection (isEpicDone → true, simulating the closer's done-write to
      // the PRIMARY repo); the lane carries real commits and NO done-state of its
      // own — the exact config the old lane-read gate failed on. finalizeEpic
      // merges the lane base into main, pushes once, and tears the lane down.
      const baseLane = realpathSync(lane);
      const finalizeInfo: WorktreeLaunchInfo = {
        assignment: {
          nodeId: "__close__",
          isCloseSink: true,
          branch: laneBranch,
          worktreePath: baseLane,
          inherited: true,
          preMerges: [],
          assertBranch: laneBranch,
        },
        baseBranch: laneBranch,
        baseWorktreePath: baseLane,
        repoDir: main,
        laneOrder: [
          { nodeId: "__close__", branch: laneBranch, worktreePath: baseLane },
        ],
        parentBranch: laneBranch,
      };
      const res = await createWorktreeDriver().finalizeEpic(
        finalizeInfo,
        async () => true,
      );
      expect(res).toEqual({ ok: true });

      // The lane work landed on main (merged), and the file is present on HEAD.
      expect(isAncestor(sha as string, "HEAD", main)).toBe(true);
      git(["cat-file", "-e", `HEAD:${rel}`], main);
      // finalize pushed once — origin/main advanced to the merged HEAD.
      expect(git(["rev-parse", "refs/remotes/origin/main"], main).trim()).toBe(
        headSha(main),
      );

      // TEARDOWN completed — the lane worktree + branch are gone, nothing leaks.
      expect(
        git(["worktree", "list", "--porcelain"], main).includes(baseLane),
      ).toBe(false);
      expect(git(["branch", "--list", laneBranch], main).trim()).toBe("");
    } finally {
      // Tolerant cleanup so a mid-cycle failure doesn't leak the worktree.
      gitQuiet(["worktree", "remove", "--force", lane], main);
      gitQuiet(["worktree", "prune"], main);
      rmSync(lane, { recursive: true, force: true });
    }
  });
});

// The close-phase plan-state-to-primary fix, proven on a REAL worktree: the
// gitignored state/ is genuinely absent from the lane checkout (not simulated by
// an rm as the pure tier does), while the committed defs are present. The pure
// analogue lives in worktree-close-state.test.ts.
describe.skipIf(!SLOW_ENABLED)(
  "close-preflight from a real lane worktree (real git)",
  () => {
    let main: string;
    let home: string;

    beforeEach(() => {
      main = realpathSync(mkdtempSync(join(tmpdir(), "planctl-wt-cpf-main-")));
      git(["init", "-q", "-b", "main"], main);
      git(["config", "user.email", "test@planctl.local"], main);
      git(["config", "user.name", "Planctl Test"], main);
      git(["config", "commit.gpgsign", "false"], main);
      home = realpathSync(mkdtempSync(join(tmpdir(), "planctl-wt-cpf-home-")));
    });

    afterEach(() => {
      for (const dir of [main, home]) {
        if (dir) {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    test("a done epic whose state lives only in primary reads ready-to-close from the lane", () => {
      const epicId = "fn-1-lane-close";
      const [, taskIds] = seedState(main, {
        epicId,
        nTasks: 2,
        primaryRepo: main,
      });
      for (const tid of taskIds) {
        seedRuntime(main, tid, { status: "done" });
      }

      // Commit the defs with REAL git — the inner .keeper/.gitignore (`state/`)
      // keeps the runtime overlay out of the index, so it stays primary-only.
      git(["add", ".keeper"], main);
      git(["commit", "-q", "-m", "seed defs"], main);

      // A real lane worktree: it checks out the committed defs but NOT the
      // gitignored state/ — the exact condition the routing fix addresses.
      const lane = mkdtempSync(join(tmpdir(), "planctl-wt-cpf-lane-"));
      rmSync(lane, { recursive: true, force: true });
      git(
        ["worktree", "add", "-q", "-b", "keeper/epic/lane", lane, "HEAD"],
        main,
      );

      try {
        const laneReal = realpathSync(lane);
        // The lane has the committed defs but the gitignored state/ is absent.
        expect(
          existsSync(join(laneReal, ".keeper", "epics", `${epicId}.json`)),
        ).toBe(true);
        expect(existsSync(join(laneReal, ".keeper", "state"))).toBe(false);

        const r = runCli(["close-preflight", epicId], { cwd: laneReal, home });
        expect(r.code).toBe(0);
        const env = parseCliOutput(r.output);
        expect(env.all_done).toBe(true);
        expect(env.primary_repo).toBe(main);

        // The brief landed in primary, never the lane.
        expect(existsSync(briefPath(main, epicId))).toBe(true);
        expect(existsSync(briefPath(laneReal, epicId))).toBe(false);
      } finally {
        gitQuiet(["worktree", "remove", "--force", lane], main);
        gitQuiet(["worktree", "prune"], main);
        rmSync(lane, { recursive: true, force: true });
      }
    });
  },
);
