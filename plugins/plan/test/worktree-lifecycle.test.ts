// Real-git worktree-lane lifecycle — the slow-tier proof the pure suite cannot
// give. Drives the full worktree-mode cycle on a real temp repo:
//   provision -> claim-in-lane (the Task-1 runtime seam) -> commit -> merge ->
//   teardown
// and asserts the worker's commit lands on the LANE branch (never main), merges
// cleanly to main, and teardown removes the worktree + branch. The claim-in-lane
// step exercises resolveWorkerRepos (the one runtime seam claim routes through)
// against a REAL lane dir, so realpath normalization runs on a path that exists —
// coverage the fast tier (non-existent absolute paths) structurally skips.
//
// CRITICAL: the commit step runs under an inherited main-pointed GIT_* env — the
// exact pollution that made lane commits leak onto main. The real commit path
// strips GIT_* so cwd alone decides the branch; without this scenario the test
// would not catch the original bug class.
//
// Gated describe.skipIf(!SLOW_ENABLED): the default `bun test` skips it; only the
// wired `bun run test:slow` (KEEPER_PLAN_RUN_SLOW=1) spawns the real `git`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { autoCommitFromInvocation } from "../src/commit.ts";
import { resolveWorkerRepos, worktreeOverride } from "../src/runtime_status.ts";
import { SLOW_ENABLED } from "./harness.ts";

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

  beforeEach(() => {
    main = mkdtempSync(join(tmpdir(), "planctl-wt-main-"));
    git(["init", "-q", "-b", "main"], main);
    git(["config", "user.email", "test@planctl.local"], main);
    git(["config", "user.name", "Planctl Test"], main);
    git(["config", "commit.gpgsign", "false"], main);
    writeFileSync(join(main, "README"), "seed\n");
    git(["add", "README"], main);
    git(["commit", "-q", "-m", "seed"], main);
  });

  afterEach(() => {
    if (main) {
      rmSync(main, { recursive: true, force: true });
    }
  });

  test("provision -> claim-in-lane -> commit -> merge -> teardown", () => {
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

      // MERGE lane -> main — the cycle lands the lane work on the default branch.
      git(["merge", "--no-ff", "-m", "merge lane into main", laneBranch], main);
      expect(isAncestor(sha as string, "HEAD", main)).toBe(true);
      // The merged file is present on main's HEAD tree + working copy.
      git(["cat-file", "-e", `HEAD:${rel}`], main);
      expect(commitCount(main)).toBe(3); // seed + lane work + merge

      // TEARDOWN — remove the worktree, then delete the (now fully merged) lane
      // branch. Order matters: a branch checked out in a worktree can't be deleted.
      git(["worktree", "remove", "--force", lane], main);
      git(["branch", "-D", laneBranch], main);
      expect(
        git(["worktree", "list", "--porcelain"], main).includes(lane),
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
