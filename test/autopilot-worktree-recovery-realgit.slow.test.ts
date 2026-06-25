/**
 * SLOW real-git contract test for the worktree crash/restart RECOVERY sweep
 * (`recoverWorktrees`, fn-959.7) wired in `src/autopilot-worker.ts`.
 *
 * The recovery contract IS git's own interrupted-merge + merge-to-default
 * plumbing against a real repo with a real remote: a crash mid-merge leaves a
 * `MERGE_HEAD` the sweep must abort + prune so the next cycle re-runs cleanly,
 * and a DONE epic whose `keeper/epic/<id>` base never reached the default branch
 * must be merged-to-default + pushed by the backstop — independent of the 1800s
 * recent-done window (git, not a projection read, is the authority). None of that
 * can be validated against a fabrication; it needs a real repo + remote.
 * Quarantined out of the fast tier (`*.slow.test.ts`, allowlisted in
 * scripts/test-real-git-allowlist.txt); the pass-level DECISIONS (which leg fires,
 * the idempotent skip, the keyed failures) are covered git-free in
 * `autopilot-worker.test.ts`.
 *
 * Importing `autopilot-worker.ts` is inert here: its bottom-of-file `main()` runs
 * only inside a real Worker with `role:"autopilot"`, so a main-thread import does
 * not boot a reconciler.
 */

import { afterAll, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverWorktrees } from "../src/autopilot-worker";
import { spawnGitExec } from "../src/commit-work/git-exec";
import { ensureWorktree, listWorktrees } from "../src/worktree-git";

const tmpDirs: string[] = [];
function trackDir(d: string): string {
  tmpDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

/** Sync git for setup/assertions; throws on a non-zero exit. */
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

function gitCommit(cwd: string, file: string, content: string, msg: string) {
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", msg);
}

/**
 * A real repo CLONED from a bare origin (so the recovery merge-to-default can
 * `git push`). Returns the work-repo path, the bare origin, and a fresh-worktree
 * path allocator under the same resolved parent (git realpath's macOS tmp paths).
 */
interface Scratch {
  repo: string;
  origin: string;
  wt(name: string): string;
}

function makeScratch(): Scratch {
  const parent = realpathSync(
    trackDir(mkdtempSync(join(tmpdir(), "keeper-wtrecover-"))),
  );
  const origin = join(parent, "origin.git");
  Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", origin]);
  const repo = join(parent, "repo");
  Bun.spawnSync(["mkdir", "-p", repo]);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "remote", "add", "origin", origin);
  gitCommit(repo, "seed.txt", "seed\n", "seed");
  git(repo, "push", "-q", "-u", "origin", "main");
  let n = 0;
  return {
    repo,
    origin,
    wt(name: string): string {
      n += 1;
      return join(parent, `wt-${n}-${name}`);
    },
  };
}

test("recoverWorktrees: a done epic's base that never merged is merged to default + pushed (window-independent)", async () => {
  const s = makeScratch();
  const tip = git(s.repo, "rev-parse", "HEAD");
  // A done epic's base branch with a commit that never merged into main.
  git(s.repo, "branch", "keeper/epic/fn-9-done", tip);
  const baseWt = s.wt("base");
  await ensureWorktree(
    s.repo,
    baseWt,
    "keeper/epic/fn-9-done",
    "keeper/epic/fn-9-done",
    spawnGitExec,
  );
  gitCommit(baseWt, "feature.txt", "the feature\n", "epic work on the base");

  // The epic IS done (the probe returns true regardless of any time window).
  const failures = await recoverWorktrees(
    [s.repo],
    async (id) => id === "fn-9-done",
    spawnGitExec,
  );
  expect(failures).toEqual([]);

  // The base merged into main in the repo's main worktree.
  expect(readFileSync(join(s.repo, "feature.txt"), "utf8")).toBe(
    "the feature\n",
  );
  expect(git(s.repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  // The single merge-to-default reached origin.
  expect(git(s.repo, "rev-parse", "main")).toBe(
    git(s.repo, "rev-parse", "origin/main"),
  );

  // Idempotent: a second sweep is a no-op (base is now an ancestor of main).
  const mainBefore = git(s.repo, "rev-parse", "main");
  const again = await recoverWorktrees(
    [s.repo],
    async () => true,
    spawnGitExec,
  );
  expect(again).toEqual([]);
  expect(git(s.repo, "rev-parse", "main")).toBe(mainBefore);
});

test("recoverWorktrees: an OPEN epic's base is NOT merged by the backstop", async () => {
  const s = makeScratch();
  const tip = git(s.repo, "rev-parse", "HEAD");
  git(s.repo, "branch", "keeper/epic/fn-7-open", tip);
  const baseWt = s.wt("open");
  await ensureWorktree(
    s.repo,
    baseWt,
    "keeper/epic/fn-7-open",
    "keeper/epic/fn-7-open",
    spawnGitExec,
  );
  gitCommit(baseWt, "wip.txt", "in progress\n", "open epic wip");

  const mainBefore = git(s.repo, "rev-parse", "main");
  const failures = await recoverWorktrees(
    [s.repo],
    async () => false, // epic still open
    spawnGitExec,
  );
  expect(failures).toEqual([]);
  // main is untouched — the open epic's base stays on its lane.
  expect(git(s.repo, "rev-parse", "main")).toBe(mainBefore);
});

test("recoverWorktrees: a crash leaving MERGE_HEAD in a lane is aborted + pruned, leaving a clean retryable tree", async () => {
  const s = makeScratch();
  const tip = git(s.repo, "rev-parse", "HEAD");
  // A base lane and a rib lane forked off the seed tip, with conflicting edits to
  // the same file → a guaranteed merge conflict.
  const baseWt = s.wt("base");
  await ensureWorktree(s.repo, baseWt, "keeper/epic/fn-5-x", tip, spawnGitExec);
  gitCommit(baseWt, "clash.txt", "base side\n", "base clash");
  const ribWt = s.wt("rib");
  await ensureWorktree(
    s.repo,
    ribWt,
    "keeper/epic/fn-5-x-rib",
    tip,
    spawnGitExec,
  );
  gitCommit(ribWt, "clash.txt", "rib side\n", "rib clash");

  // Simulate the crash: start a conflicting merge in the base lane WITHOUT the
  // driver, leaving a real MERGE_HEAD behind.
  const raw = await spawnGitExec(
    ["merge", "--no-edit", "keeper/epic/fn-5-x-rib"],
    {
      cwd: baseWt,
    },
  );
  expect(raw.code).not.toBe(0);
  expect(git(baseWt, "status", "--porcelain")).not.toBe("");

  // Recovery: the epic is NOT done (so the backstop merge does not fire) — only
  // the interrupted-merge abort pass runs.
  const failures = await recoverWorktrees(
    [s.repo],
    async () => false,
    spawnGitExec,
  );
  expect(failures).toEqual([]);

  // The lane's MERGE_HEAD is gone and the tree is clean — the next cycle can
  // re-run the merge from a clean state (level-triggered retry).
  const mergeHead = await spawnGitExec(
    ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
    { cwd: baseWt },
  );
  expect(mergeHead.code).not.toBe(0);
  expect(git(baseWt, "status", "--porcelain")).toBe("");
  // The lane is still registered (abort + prune does not remove a live lane).
  expect(
    (await listWorktrees(s.repo, spawnGitExec)).some((e) => e.path === baseWt),
  ).toBe(true);
});
