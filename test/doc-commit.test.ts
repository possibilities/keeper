/**
 * Unit tests for the dep-free `~/docs` per-write committer (fn-885 `.1`). Real
 * git is never mocked — `commitDocsPaths` spawns `git` directly, so every
 * assertion runs against a real `initRepo` tmp repo with an initial commit. The
 * `initRepo` helper disables gpgsign (the committer also passes
 * `-c commit.gpgsign=false`, but the fixture's host could carry a global config
 * that wedges the seed commits otherwise).
 *
 * Covered (per the task's test notes):
 *  - a write/update/delete commits the right pathspec with a mechanical subject;
 *  - a clean tree is a no-op (null, no new commit);
 *  - a simulated index.lock retries on the backoff and then commits;
 *  - a persistent lock exhausts the bounded retry → CommitFailed(commit_contended);
 *  - a detached HEAD and a mid-merge repo skip cleanly (null, no commit);
 *  - the commit is pathspec-scoped — an unrelated dirty file is NOT swept in.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDocSubject,
  CommitFailed,
  commitDocsPaths,
} from "../src/doc-commit";
import { initRepo } from "./helpers/git-repo";

let repo: string;

/** Run a git command in `repo` synchronously; throw on a non-zero exit. */
function git(...args: string[]): string {
  const res = Bun.spawnSync(["git", "-C", repo, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (res.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${res.stderr.toString().trim()}`,
    );
  }
  return res.stdout.toString();
}

function commitCount(): number {
  return Number(git("rev-list", "--count", "HEAD").trim());
}

function headSubject(): string {
  return git("log", "-1", "--format=%s").trim();
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "keeper-doc-commit-")));
  initRepo(repo);
  // Seed an initial commit so HEAD resolves (the committer skips an unborn HEAD).
  writeFileSync(join(repo, "seed.md"), "# seed\n");
  git("add", "--", "seed.md");
  git("commit", "-q", "-m", "init");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("buildDocSubject", () => {
  test("mechanical `docs: <verb> <relpath>` subject", () => {
    expect(buildDocSubject("write", "a.md")).toBe("docs: write a.md");
    expect(buildDocSubject("update", "sub/b.md")).toBe("docs: update sub/b.md");
    expect(buildDocSubject("delete", "c.md")).toBe("docs: delete c.md");
  });
});

describe("commitDocsPaths", () => {
  test("a fresh doc + sidecar commits both, pathspec-scoped, with the write subject", () => {
    const md = join(repo, "note.md");
    const yaml = join(repo, "note.yaml");
    writeFileSync(md, "# note\n");
    writeFileSync(yaml, "path: note.md\ntype: doc\n");
    const pre = commitCount();

    const sha = commitDocsPaths({
      paths: [md, yaml],
      repoRoot: repo,
      verb: "write",
    });
    expect(sha).not.toBeNull();
    expect((sha as string).length).toBe(40);
    expect(commitCount()).toBe(pre + 1);
    expect(headSubject()).toBe("docs: write note.md");
    // both files are now tracked & clean
    expect(git("status", "--porcelain").trim()).toBe("");
  });

  test("an update to an existing doc commits just the dirty .md", () => {
    const md = join(repo, "note.md");
    writeFileSync(md, "# note\n");
    git("add", "--", "note.md");
    git("commit", "-q", "-m", "seed note");
    writeFileSync(md, "# note edited\n");
    const pre = commitCount();

    const sha = commitDocsPaths({
      paths: [md],
      repoRoot: repo,
      verb: "update",
    });
    expect(sha).not.toBeNull();
    expect(commitCount()).toBe(pre + 1);
    expect(headSubject()).toBe("docs: update note.md");
  });

  test("a deletion commits the removal", () => {
    const md = join(repo, "gone.md");
    writeFileSync(md, "# gone\n");
    git("add", "--", "gone.md");
    git("commit", "-q", "-m", "seed gone");
    unlinkSync(md);
    const pre = commitCount();

    const sha = commitDocsPaths({
      paths: [md],
      repoRoot: repo,
      verb: "delete",
    });
    expect(sha).not.toBeNull();
    expect(commitCount()).toBe(pre + 1);
    expect(headSubject()).toBe("docs: delete gone.md");
    // the file is gone from the tree
    expect(git("ls-files", "gone.md").trim()).toBe("");
  });

  test("a clean tree is a no-op (null, no new commit)", () => {
    const md = join(repo, "seed.md"); // already committed, unchanged
    const pre = commitCount();
    const sha = commitDocsPaths({
      paths: [md],
      repoRoot: repo,
      verb: "update",
    });
    expect(sha).toBeNull();
    expect(commitCount()).toBe(pre);
  });

  test("an empty paths list is a no-op", () => {
    const pre = commitCount();
    expect(
      commitDocsPaths({ paths: [], repoRoot: repo, verb: "write" }),
    ).toBeNull();
    expect(commitCount()).toBe(pre);
  });

  test("pathspec-scoped — an unrelated dirty file is not swept in", () => {
    const md = join(repo, "scoped.md");
    const other = join(repo, "unrelated.txt");
    writeFileSync(md, "# scoped\n");
    writeFileSync(other, "noise\n");

    const sha = commitDocsPaths({ paths: [md], repoRoot: repo, verb: "write" });
    expect(sha).not.toBeNull();
    // only scoped.md was committed; unrelated.txt is still untracked & dirty
    expect(git("ls-files", "scoped.md").trim()).toBe("scoped.md");
    expect(git("status", "--porcelain", "unrelated.txt").trim()).toContain(
      "unrelated.txt",
    );
  });

  test("stale index.lock cleared on first backoff → bounded retry commits", () => {
    const md = join(repo, "contend.md");
    writeFileSync(md, "# contend\n");
    const lockFile = join(repo, ".git", "index.lock");
    writeFileSync(lockFile, ""); // git add will refuse: "File exists"
    const pre = commitCount();

    const backoffs: number[] = [];
    const sleep = (ms: number): void => {
      backoffs.push(ms);
      try {
        unlinkSync(lockFile); // clear the contention so the next attempt wins
      } catch {
        // already cleared
      }
    };

    const sha = commitDocsPaths(
      { paths: [md], repoRoot: repo, verb: "write" },
      sleep,
    );
    expect(sha).not.toBeNull();
    expect(commitCount()).toBe(pre + 1);
    expect(backoffs.length).toBeGreaterThanOrEqual(1);
  });

  test("persistent index.lock across all attempts → CommitFailed(commit_contended)", () => {
    const md = join(repo, "exhaust.md");
    writeFileSync(md, "# exhaust\n");
    const lockFile = join(repo, ".git", "index.lock");
    writeFileSync(lockFile, "");
    const sleep = (): void => {
      // never clear — every stage attempt fails with "File exists"
    };

    let caught: CommitFailed | null = null;
    try {
      commitDocsPaths({ paths: [md], repoRoot: repo, verb: "write" }, sleep);
    } catch (e) {
      caught = e as CommitFailed;
    } finally {
      try {
        unlinkSync(lockFile);
      } catch {
        // best-effort
      }
    }
    expect(caught).toBeInstanceOf(CommitFailed);
    expect((caught as CommitFailed).error).toBe("commit_contended");
  });

  test("a detached HEAD skips cleanly (null, no commit)", () => {
    const head = git("rev-parse", "HEAD").trim();
    git("checkout", "-q", head); // detach
    const md = join(repo, "detached.md");
    writeFileSync(md, "# detached\n");
    const pre = commitCount();

    const sha = commitDocsPaths({ paths: [md], repoRoot: repo, verb: "write" });
    expect(sha).toBeNull();
    expect(commitCount()).toBe(pre);
  });

  test("a mid-merge repo (MERGE_HEAD present) skips cleanly", () => {
    // Hand-place a MERGE_HEAD marker — the committer probes via
    // `git rev-parse --git-path MERGE_HEAD` + existence, no real merge needed.
    writeFileSync(
      join(repo, ".git", "MERGE_HEAD"),
      `${git("rev-parse", "HEAD").trim()}\n`,
    );
    const md = join(repo, "midmerge.md");
    writeFileSync(md, "# mid\n");
    const pre = commitCount();

    const sha = commitDocsPaths({ paths: [md], repoRoot: repo, verb: "write" });
    expect(sha).toBeNull();
    expect(commitCount()).toBe(pre);
  });

  test("a non-repo docs dir is a clean no-op (the symbolic-ref guard catches it)", () => {
    const nonRepo = realpathSync(
      mkdtempSync(join(tmpdir(), "keeper-nonrepo-")),
    );
    try {
      const md = join(nonRepo, "x.md");
      writeFileSync(md, "# x\n");
      // Not a git repo: `git symbolic-ref -q HEAD` exits non-zero, so the
      // detached/unborn-HEAD guard fires and the committer no-ops (null) rather
      // than throwing — exactly the fail-open behavior the hook relies on.
      expect(
        commitDocsPaths({ paths: [md], repoRoot: nonRepo, verb: "write" }),
      ).toBeNull();
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});
