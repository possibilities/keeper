/**
 * SLOW real-git contract test for `src/worktree-git.ts` (fn-959.3).
 *
 * The worktree driver's contract IS git's own worktree + merge plumbing: a
 * `git worktree add` registers a linked tree, a `merge-base --is-ancestor` skip
 * is idempotent, a conflicting `git merge` leaves a `MERGE_HEAD` that the abort
 * path must clear, a clean `git worktree remove` succeeds while a dirty one is
 * refused without `--force`, and `git worktree prune --expire now` clears a
 * stale admin entry. None of that can be validated against a fabrication — it
 * needs a real repo. Quarantined out of the fast tier (named `*.slow.test.ts`
 * and listed in scripts/test-real-git-allowlist.txt); the PURE helpers + the
 * fake-git-driven decisions are covered git-free in `worktree-git.test.ts`.
 *
 * Branch names here use a flat `epic-base` / `epic-rib-b` shape rather than the
 * topology module's `keeper/epic/<id>` + `keeper/epic/<id>/<task>` scheme: git
 * refs are a directory hierarchy, so a base ref and a rib ref nested UNDER it
 * (`keeper/epic/e` vs `keeper/epic/e/B`) are a D/F conflict git rejects. The
 * driver is branch-name-agnostic (names are parameters), so these flat names
 * exercise the identical base-lane + rib-lane + merge structure; the nested
 * naming is the topology module's (task .2) concern, flagged separately.
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
import { spawnGitExec } from "../src/commit-work/git-exec";
import {
  commitWorkLockPath,
  ensureWorktree,
  isLinkedWorktree,
  listWorktrees,
  mergeBranchInto,
  pruneWorktrees,
  removeWorktree,
  resolveDefaultBranch,
} from "../src/worktree-git";
import { initRepo as initGitRepo } from "./helpers/git-repo";

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

/** Sync git for setup assertions; throws on a non-zero exit. */
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

/** Commit `content` to `file` in `cwd` with the test identity. */
function gitCommit(cwd: string, file: string, content: string, msg: string) {
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", msg);
}

/**
 * A real-git scratch area: a single resolved (realpath'd) parent dir holding the
 * repo and every sibling worktree path. Resolving the parent ONCE means every
 * path we hand git already matches git's own realpath'd view — on macOS
 * `tmpdir()` is `/var/folders/...` which git canonicalizes to `/private/var/...`,
 * and an unresolved path would never match the registered worktree path.
 */
interface Scratch {
  repo: string;
  /** A fresh, not-yet-existing worktree path under the resolved parent. */
  wt(name: string): string;
}

function makeScratch(): Scratch {
  const parent = realpathSync(
    trackDir(mkdtempSync(join(tmpdir(), "keeper-wtgit-"))),
  );
  const repo = join(parent, "repo");
  // initGitRepo wants the dir to exist; mkdir via a worktree-add is wrong, so
  // create it as a plain dir then init.
  Bun.spawnSync(["mkdir", "-p", repo]);
  initGitRepo(repo);
  gitCommit(repo, "seed.txt", "seed\n", "seed");
  let n = 0;
  return {
    repo,
    wt(name: string): string {
      n += 1;
      return join(parent, `wt-${n}-${name}`);
    },
  };
}

// ---------------------------------------------------------------------------
// resolveDefaultBranch + isLinkedWorktree against real git.
// ---------------------------------------------------------------------------

test("resolveDefaultBranch: no origin → falls back to the existing main", async () => {
  const { repo } = makeScratch();
  expect(await resolveDefaultBranch(repo, spawnGitExec)).toBe("main");
});

test("isLinkedWorktree: main worktree → false; linked worktree → true", async () => {
  const s = makeScratch();
  const head = git(s.repo, "rev-parse", "HEAD");
  const wt = s.wt("linked");
  await ensureWorktree(s.repo, wt, "epic-rib-b", head, spawnGitExec);
  expect(await isLinkedWorktree(s.repo, spawnGitExec)).toBe(false);
  expect(await isLinkedWorktree(wt, spawnGitExec)).toBe(true);
});

// ---------------------------------------------------------------------------
// ensureWorktree / listWorktrees — idempotent add off a commitish.
// ---------------------------------------------------------------------------

test("ensureWorktree: creates a lane off the base tip, then is a no-op on re-run", async () => {
  const s = makeScratch();
  const head = git(s.repo, "rev-parse", "HEAD");
  const wt = s.wt("lane");
  const branch = "epic-rib-b";

  await ensureWorktree(s.repo, wt, branch, head, spawnGitExec);
  const listed = await listWorktrees(s.repo, spawnGitExec);
  const entry = listed.find((e) => e.path === wt);
  expect(entry).toBeDefined();
  expect(entry?.branch).toBe(`refs/heads/${branch}`);
  // The lane's tip equals the base tip it forked off.
  expect(git(wt, "rev-parse", "HEAD")).toBe(head);

  // Idempotent: a second ensure with the same args does not error or re-add.
  await ensureWorktree(s.repo, wt, branch, head, spawnGitExec);
  const listed2 = await listWorktrees(s.repo, spawnGitExec);
  expect(listed2.filter((e) => e.path === wt)).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// mergeBranchInto — clean merge, idempotent ancestor skip, conflict abort.
// ---------------------------------------------------------------------------

test("mergeBranchInto: clean pairwise merge brings the source commit into the base", async () => {
  const s = makeScratch();
  const tip = git(s.repo, "rev-parse", "HEAD");

  const baseWt = s.wt("base");
  await ensureWorktree(s.repo, baseWt, "epic-base", tip, spawnGitExec);

  const ribWt = s.wt("rib");
  const rib = "epic-rib-b";
  await ensureWorktree(s.repo, ribWt, rib, tip, spawnGitExec);
  gitCommit(ribWt, "rib.txt", "rib work\n", "rib commit");

  const res = await mergeBranchInto(baseWt, rib, spawnGitExec);
  expect(res).toEqual({ kind: "merged" });
  // The rib's file now exists on the base lane.
  expect(readFileSync(join(baseWt, "rib.txt"), "utf8")).toBe("rib work\n");

  // Idempotent: merging the same source again is a skip (already an ancestor).
  const again = await mergeBranchInto(baseWt, rib, spawnGitExec);
  expect(again).toEqual({ kind: "already-merged" });
});

test("mergeBranchInto: conflict aborts (MERGE_HEAD cleared) and reports conflict", async () => {
  const s = makeScratch();
  const tip = git(s.repo, "rev-parse", "HEAD");

  const baseWt = s.wt("base");
  await ensureWorktree(s.repo, baseWt, "epic-base", tip, spawnGitExec);
  // Both lanes touch the SAME file with divergent content → guaranteed conflict.
  gitCommit(baseWt, "clash.txt", "base side\n", "base clash");

  const ribWt = s.wt("rib");
  const rib = "epic-rib-b";
  await ensureWorktree(s.repo, ribWt, rib, tip, spawnGitExec);
  gitCommit(ribWt, "clash.txt", "rib side\n", "rib clash");

  const res = await mergeBranchInto(baseWt, rib, spawnGitExec);
  expect(res.kind).toBe("conflict");

  // The abort cleared MERGE_HEAD — the base lane is back to a clean merge state.
  const mergeHead = await spawnGitExec(
    ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
    { cwd: baseWt },
  );
  expect(mergeHead.code).not.toBe(0);
  // Working tree is clean (no leftover conflict markers staged).
  expect(git(baseWt, "status", "--porcelain")).toBe("");
});

// ---------------------------------------------------------------------------
// Merges take the shared commit-work flock.
// ---------------------------------------------------------------------------

test("mergeBranchInto: a clean merge runs while holding the shared commit-work flock", async () => {
  const s = makeScratch();
  const tip = git(s.repo, "rev-parse", "HEAD");
  const baseWt = s.wt("base");
  await ensureWorktree(s.repo, baseWt, "epic-base", tip, spawnGitExec);
  const ribWt = s.wt("rib");
  const rib = "epic-rib-b";
  await ensureWorktree(s.repo, ribWt, rib, tip, spawnGitExec);
  gitCommit(ribWt, "rib.txt", "rib\n", "rib");

  const lockPath = await commitWorkLockPath(baseWt, spawnGitExec);
  // The lock path resolves to the shared common dir, identical from either lane.
  expect(lockPath).toBe(await commitWorkLockPath(ribWt, spawnGitExec));

  let acquired = "";
  let released = false;
  const res = await mergeBranchInto(baseWt, rib, spawnGitExec, (p) => {
    acquired = p;
    return {
      release() {
        released = true;
      },
    };
  });
  expect(res).toEqual({ kind: "merged" });
  expect(acquired).toBe(lockPath);
  expect(released).toBe(true);
});

// ---------------------------------------------------------------------------
// removeWorktree / pruneWorktrees — clean remove, dirty refusal, prune.
// ---------------------------------------------------------------------------

test("removeWorktree: clean lane removed; idempotent on a gone path", async () => {
  const s = makeScratch();
  const tip = git(s.repo, "rev-parse", "HEAD");
  const wt = s.wt("rm");
  await ensureWorktree(s.repo, wt, "epic-rib-b", tip, spawnGitExec);

  expect(await removeWorktree(s.repo, wt, spawnGitExec)).toEqual({
    kind: "removed",
  });
  // Gone from the registry.
  const listed = await listWorktrees(s.repo, spawnGitExec);
  expect(listed.some((e) => e.path === wt)).toBe(false);
  // Idempotent: removing again is still "removed".
  expect(await removeWorktree(s.repo, wt, spawnGitExec)).toEqual({
    kind: "removed",
  });
});

test("removeWorktree: a dirty lane is REFUSED, never blind-forced", async () => {
  const s = makeScratch();
  const tip = git(s.repo, "rev-parse", "HEAD");
  const wt = s.wt("dirty");
  await ensureWorktree(s.repo, wt, "epic-rib-b", tip, spawnGitExec);
  // Leave an uncommitted change to a TRACKED file → git refuses a non-force
  // remove (an untracked-only tree can be removed cleanly by modern git).
  writeFileSync(join(wt, "seed.txt"), "locally modified\n");

  const res = await removeWorktree(s.repo, wt, spawnGitExec);
  expect(res.kind).toBe("dirty");
  // Still registered — never forced away.
  const listed = await listWorktrees(s.repo, spawnGitExec);
  expect(listed.some((e) => e.path === wt)).toBe(true);
});

test("pruneWorktrees: --expire now clears a stale admin entry whose dir is gone", async () => {
  const s = makeScratch();
  const tip = git(s.repo, "rev-parse", "HEAD");
  const wt = s.wt("prune");
  await ensureWorktree(s.repo, wt, "epic-rib-b", tip, spawnGitExec);
  // Simulate a crash: the worktree directory vanishes but the admin entry stays.
  rmSync(wt, { recursive: true, force: true });
  expect(
    (await listWorktrees(s.repo, spawnGitExec)).some((e) => e.path === wt),
  ).toBe(true);

  await pruneWorktrees(s.repo, spawnGitExec);
  // The stale entry is gone after prune --expire now.
  expect(
    (await listWorktrees(s.repo, spawnGitExec)).some((e) => e.path === wt),
  ).toBe(false);
});
