/**
 * SLOW real-git contract test for the worktree-mode commit isolation hardening
 * (fn-972-harden-worktree-autopilot-correctness.1).
 *
 * The contract IS git's own worktree plumbing: a `keeper commit-work` run inside
 * a LINKED worktree must commit ONLY to that worktree's checked-out lane branch
 * (never main), must SKIP the push (lane work never reaches origin), and two such
 * runs in two linked worktrees of the SAME repo must each land on their own lane
 * — even while a producer (`git worktree prune`) races on the shared repo. None
 * of that can be validated against a fabrication; it needs a real repo + real
 * linked worktrees. The cwd-pinning + GIT_* env-strip DECISIONS are covered
 * git-free in `commit-work-worktree-isolation.test.ts`; this is the end-to-end
 * proof. Quarantined out of the fast tier (named `*.slow.test.ts`, allowlisted in
 * scripts/test-real-git-allowlist.txt).
 *
 * The pipeline is driven via `runForTest(argv, deps)` with `deps.cwd` pointed at
 * a linked worktree (no global `process.chdir`) and the REAL `spawnGitExec` git
 * runner; only the attribution read + lint + flock are stubbed (the file set is
 * supplied directly, there is nothing to lint, and the lock is exercised
 * elsewhere). Real git does the stage / commit / push-skip.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runForTest } from "../cli/commit-work";
import { spawnGitExec } from "../src/commit-work/git-exec";
import { type PushEnvelope, pushCommitted } from "../src/commit-work/push";
import { ensureWorktree, pruneWorktrees } from "../src/worktree-git";
import { initRepo as initGitRepo } from "./helpers/git-repo";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

/** Sync git for setup + assertions; throws on a non-zero exit. */
function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t.t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t.t",
    },
  });
  if (!r.success) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  }
  return r.stdout.toString().trim();
}

interface Scratch {
  repo: string;
  origin: string;
  seedTip: string;
  wt(name: string): string;
}

/**
 * A real-git scratch area: a `repo` with a seed commit on `main`, a bare `origin`
 * it tracks, and a factory for fresh (resolved) linked-worktree paths under the
 * same realpath'd parent so every path matches git's own realpath'd view (on
 * macOS `tmpdir()` is `/var/...` canonicalized to `/private/var/...`).
 */
function makeScratch(): Scratch {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "keeper-cwiso-")));
  tmpDirs.push(parent);
  const repo = join(parent, "repo");
  const origin = join(parent, "origin.git");
  Bun.spawnSync(["mkdir", "-p", repo]);
  initGitRepo(repo);
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "seed");
  const seedTip = git(repo, "rev-parse", "HEAD");
  // A bare origin the repo tracks, so we can assert lane work never reaches it.
  git(parent, "init", "--bare", "-q", origin);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "-u", "origin", "main");
  let n = 0;
  return {
    repo,
    origin,
    seedTip,
    wt(name: string): string {
      n += 1;
      return join(parent, `wt-${n}-${name}`);
    },
  };
}

/** Drive the real commit-work pipeline inside `worktree` (no chdir, real git). */
async function commitWorkIn(
  worktree: string,
  files: string[],
  message: string,
): Promise<{ code: number; stdout: string }> {
  return runForTest([message, "--session-id", "s-iso"], {
    cwd: worktree,
    gitRunner: spawnGitExec,
    discoverFiles: () => files,
    waitCaughtUp: async () => {},
    runLint: async () => {},
    acquireLock: () => ({ release: () => {} }),
  });
}

test("commit-work inside a linked worktree commits to the lane, skips push; main + origin untouched", async () => {
  const s = makeScratch();
  const wt = s.wt("lane");
  await ensureWorktree(s.repo, wt, "lane-a", s.seedTip, spawnGitExec);
  writeFileSync(join(wt, "laneA.txt"), "lane a work\n");

  const { code, stdout } = await commitWorkIn(
    wt,
    ["laneA.txt"],
    "feat: lane a",
  );
  expect(code).toBe(0);

  const lines = stdout.split("\n").filter((l) => l.length > 0);
  // Line 1 — the commit landed (the lane file is in the envelope).
  const line1 = JSON.parse(lines[0]);
  expect(line1.success).toBe(true);
  expect(line1.files).toEqual(["laneA.txt"]);
  // Line 2 — the push was SKIPPED (linked worktree), on the lane branch.
  expect(JSON.parse(lines[1])).toEqual({
    success: true,
    pushed: false,
    skipped: "worktree",
    branch: "lane-a",
  });

  // The commit is on lane-a ONLY: lane-a advanced past the seed, main did not.
  expect(git(s.repo, "rev-parse", "lane-a")).not.toBe(s.seedTip);
  expect(git(s.repo, "rev-parse", "main")).toBe(s.seedTip);
  // The lane file exists on lane-a, never on main.
  expect(git(s.repo, "cat-file", "-t", "lane-a:laneA.txt")).toBe("blob");
  const onMain = Bun.spawnSync([
    "git",
    "-C",
    s.repo,
    "cat-file",
    "-t",
    "main:laneA.txt",
  ]);
  expect(onMain.success).toBe(false);

  // Origin never saw the lane: no lane-a ref, origin/main still at the seed.
  expect(git(s.repo, "ls-remote", s.origin, "refs/heads/lane-a")).toBe("");
  expect(git(s.repo, "rev-parse", "refs/remotes/origin/main")).toBe(s.seedTip);
});

/**
 * Stage + commit `file` and run the push-skip leg, ALL pinned to `wt` via the
 * real `spawnGitExec` (cwd=wt, GIT_* stripped). Returns the push envelope. Unlike
 * `runForTest`, the primitives carry no shared module state, so two of these run
 * truly concurrently without clobbering each other's output.
 */
async function laneStageCommitPush(
  wt: string,
  file: string,
  content: string,
  msg: string,
): Promise<PushEnvelope> {
  writeFileSync(join(wt, file), content);
  const add = await spawnGitExec(["add", "-A", "--", file], { cwd: wt });
  expect(add.code).toBe(0);
  const commit = await spawnGitExec(["commit", "-F", "-"], {
    cwd: wt,
    stdin: new TextEncoder().encode(msg),
  });
  expect(commit.code).toBe(0);
  return pushCommitted(wt, spawnGitExec);
}

test("concurrent same-repo lane commits each land on their own branch, never main — with a producer prune racing", async () => {
  const s = makeScratch();
  const wtA = s.wt("a");
  const wtB = s.wt("b");
  await ensureWorktree(s.repo, wtA, "lane-a", s.seedTip, spawnGitExec);
  await ensureWorktree(s.repo, wtB, "lane-b", s.seedTip, spawnGitExec);

  // Both lane commits run concurrently, RACED by `git worktree prune` on the
  // shared repo — exactly the un-flocked sibling producer op (autopilot-worker.ts)
  // that perturbed git-dir resolution in the original bug.
  const [pushA, pushB] = await Promise.all([
    laneStageCommitPush(wtA, "laneA.txt", "lane a\n", "feat: a"),
    laneStageCommitPush(wtB, "laneB.txt", "lane b\n", "feat: b"),
    pruneWorktrees(s.repo, spawnGitExec),
    pruneWorktrees(s.repo, spawnGitExec),
    pruneWorktrees(s.repo, spawnGitExec),
  ]);

  // Each push was skipped on its own lane (never pushed to origin).
  expect(pushA).toEqual({
    success: true,
    pushed: false,
    skipped: "worktree",
    branch: "lane-a",
  });
  expect(pushB).toEqual({
    success: true,
    pushed: false,
    skipped: "worktree",
    branch: "lane-b",
  });

  // Each lane advanced and carries ONLY its own file; main never moved.
  expect(git(s.repo, "rev-parse", "main")).toBe(s.seedTip);
  expect(git(s.repo, "rev-parse", "lane-a")).not.toBe(s.seedTip);
  expect(git(s.repo, "rev-parse", "lane-b")).not.toBe(s.seedTip);
  expect(git(s.repo, "cat-file", "-t", "lane-a:laneA.txt")).toBe("blob");
  expect(git(s.repo, "cat-file", "-t", "lane-b:laneB.txt")).toBe("blob");
  // No cross-contamination: lane-a has no lane-b file and vice-versa.
  expect(
    Bun.spawnSync(["git", "-C", s.repo, "cat-file", "-t", "lane-a:laneB.txt"])
      .success,
  ).toBe(false);
  expect(
    Bun.spawnSync(["git", "-C", s.repo, "cat-file", "-t", "lane-b:laneA.txt"])
      .success,
  ).toBe(false);
  // And main stayed clean of both lane files.
  expect(
    Bun.spawnSync(["git", "-C", s.repo, "cat-file", "-t", "main:laneA.txt"])
      .success,
  ).toBe(false);
  expect(
    Bun.spawnSync(["git", "-C", s.repo, "cat-file", "-t", "main:laneB.txt"])
      .success,
  ).toBe(false);
});
