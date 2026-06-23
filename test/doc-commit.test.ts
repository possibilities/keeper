/**
 * Unit tests for the dep-free `~/docs` per-write committer (fn-885 `.1`),
 * de-gitted for fn-904 `.3`: ZERO real git. `commitDocsPaths` takes an
 * injectable {@link DocGitRunner}; every test drives it with a recording fake so
 * the assertions exercise the committer's DECISIONS — the staged pathspec, the
 * mechanical `docs: <verb> <relpath>` subject, the mid-op / detached skip, and
 * the bounded index.lock contention retry — never git's effect on a real repo.
 *
 * `buildDocSubject` stays a pure-string unit test. The contention paths model
 * git's lock-domain stderr (`index.lock` / `File exists` / `cannot lock ref`)
 * via canned outcomes, exactly the substrings the committer matches on.
 */

import { describe, expect, test } from "bun:test";
import {
  buildDocSubject,
  CommitFailed,
  commitDocsPaths,
} from "../src/doc-commit";
import {
  argvStartsWith,
  type FakeGitRule,
  fakeDocGit,
  type RecordedGitCall,
} from "./helpers/fake-git.ts";

const REPO = "/repo";

/** Rules for a clean attached HEAD repo that is NOT mid-operation, with the
 * given porcelain-v1 status output for the dirtiness probe. */
function cleanRepoRules(porcelainStatus: string): FakeGitRule[] {
  return [
    // mid-op probes: a marker path that never "exists" — but the committer tests
    // existence on disk via existsSync, and /repo/.git/MARKER doesn't exist, so
    // returning a non-existent path keeps the repo "not mid-operation".
    {
      when: (a) => argvStartsWith(a, "rev-parse", "--git-path"),
      result: { exitCode: 0, stdout: "/nonexistent/marker" },
    },
    // attached HEAD
    {
      when: (a) => argvStartsWith(a, "symbolic-ref", "-q", "HEAD"),
      result: { exitCode: 0, stdout: "refs/heads/main" },
    },
    // dirtiness probe
    {
      when: (a) => argvStartsWith(a, "status", "--porcelain=v1"),
      result: { exitCode: 0, stdout: porcelainStatus },
    },
    // resulting HEAD after the commit
    {
      when: (a) => argvStartsWith(a, "rev-parse", "HEAD"),
      result: { exitCode: 0, stdout: `${"a".repeat(40)}\n` },
    },
  ];
}

/** The commit call (`commit -F -`) recorded by a fake, or undefined. */
function commitCall(calls: RecordedGitCall[]): RecordedGitCall | undefined {
  return calls.find((c) => argvStartsWith(c.args, "-c"));
}

/** The add call (`add -A -- ...`), or undefined. */
function addCall(calls: RecordedGitCall[]): RecordedGitCall | undefined {
  return calls.find((c) => argvStartsWith(c.args, "add", "-A", "--"));
}

describe("buildDocSubject", () => {
  test("mechanical `docs: <verb> <relpath>` subject", () => {
    expect(buildDocSubject("write", "a.md")).toBe("docs: write a.md");
    expect(buildDocSubject("update", "sub/b.md")).toBe("docs: update sub/b.md");
    expect(buildDocSubject("delete", "c.md")).toBe("docs: delete c.md");
  });
});

describe("commitDocsPaths — decisions", () => {
  test("a fresh doc + sidecar stages both and commits with the write subject", () => {
    const fake = fakeDocGit(cleanRepoRules(" M note.md\n M note.yaml\n"));
    const sha = commitDocsPaths(
      {
        paths: [`${REPO}/note.md`, `${REPO}/note.yaml`],
        repoRoot: REPO,
        verb: "write",
      },
      () => {},
      fake.run,
    );
    expect(sha).toBe("a".repeat(40));
    // Staged the dirty subset reported by status, pathspec-scoped.
    expect(addCall(fake.calls)?.args).toEqual([
      "add",
      "-A",
      "--",
      "note.md",
      "note.yaml",
    ]);
    // Commit subject is the mechanical write subject; message via -F - stdin.
    const commit = commitCall(fake.calls);
    expect(commit?.args).toContain("commit");
    expect(commit?.args).toContain("commit.gpgsign=false");
    expect(commit?.stdin).toBe("docs: write note.md\n");
    // The commit is pathspec-scoped to exactly the dirty files.
    expect(commit?.args.slice(-3)).toEqual(["--", "note.md", "note.yaml"]);
  });

  test("an update commits just the dirty .md with the update subject", () => {
    const fake = fakeDocGit(cleanRepoRules(" M note.md\n"));
    const sha = commitDocsPaths(
      { paths: [`${REPO}/note.md`], repoRoot: REPO, verb: "update" },
      () => {},
      fake.run,
    );
    expect(sha).toBe("a".repeat(40));
    expect(addCall(fake.calls)?.args).toEqual(["add", "-A", "--", "note.md"]);
    expect(commitCall(fake.calls)?.stdin).toBe("docs: update note.md\n");
  });

  test("a deletion commits the removal with the delete subject", () => {
    const fake = fakeDocGit(cleanRepoRules(" D gone.md\n"));
    const sha = commitDocsPaths(
      { paths: [`${REPO}/gone.md`], repoRoot: REPO, verb: "delete" },
      () => {},
      fake.run,
    );
    expect(sha).toBe("a".repeat(40));
    expect(commitCall(fake.calls)?.stdin).toBe("docs: delete gone.md\n");
  });

  test("a clean tree is a no-op (null, no add/commit)", () => {
    const fake = fakeDocGit(cleanRepoRules(""));
    const sha = commitDocsPaths(
      { paths: [`${REPO}/seed.md`], repoRoot: REPO, verb: "update" },
      () => {},
      fake.run,
    );
    expect(sha).toBeNull();
    expect(addCall(fake.calls)).toBeUndefined();
    expect(commitCall(fake.calls)).toBeUndefined();
  });

  test("an empty paths list is a no-op (never touches git)", () => {
    const fake = fakeDocGit([]);
    expect(
      commitDocsPaths(
        { paths: [], repoRoot: REPO, verb: "write" },
        () => {},
        fake.run,
      ),
    ).toBeNull();
    expect(fake.calls.length).toBe(0);
  });

  test("pathspec-scoped — only the status-reported dirty files are staged", () => {
    // status under the scoped pathspec reports only scoped.md; an unrelated file
    // outside the pathspec never appears, so it is never staged.
    const fake = fakeDocGit(cleanRepoRules(" M scoped.md\n"));
    commitDocsPaths(
      { paths: [`${REPO}/scoped.md`], repoRoot: REPO, verb: "write" },
      () => {},
      fake.run,
    );
    expect(addCall(fake.calls)?.args).toEqual(["add", "-A", "--", "scoped.md"]);
    // The status probe was pathspec-scoped to scoped.md.
    const statusCall = fake.calls.find((c) =>
      argvStartsWith(c.args, "status", "--porcelain=v1"),
    );
    expect(statusCall?.args.slice(-2)).toEqual(["--", `${REPO}/scoped.md`]);
  });
});

describe("commitDocsPaths — skip guards", () => {
  test("a detached HEAD skips cleanly (null, no add/commit)", () => {
    const fake = fakeDocGit([
      {
        when: (a) => argvStartsWith(a, "rev-parse", "--git-path"),
        result: { exitCode: 0, stdout: "/nonexistent/marker" },
      },
      // symbolic-ref fails → detached
      {
        when: (a) => argvStartsWith(a, "symbolic-ref", "-q", "HEAD"),
        result: { exitCode: 1, stdout: "" },
      },
    ]);
    const sha = commitDocsPaths(
      { paths: [`${REPO}/detached.md`], repoRoot: REPO, verb: "write" },
      () => {},
      fake.run,
    );
    expect(sha).toBeNull();
    expect(addCall(fake.calls)).toBeUndefined();
  });
});

describe("commitDocsPaths — contention retry", () => {
  test("a transient index.lock retries on the backoff and then commits", () => {
    let addAttempts = 0;
    const rules: FakeGitRule[] = [
      {
        when: (a) => argvStartsWith(a, "rev-parse", "--git-path"),
        result: { exitCode: 0, stdout: "/nonexistent/marker" },
      },
      {
        when: (a) => argvStartsWith(a, "symbolic-ref", "-q", "HEAD"),
        result: { exitCode: 0, stdout: "refs/heads/main" },
      },
      {
        when: (a) => argvStartsWith(a, "status", "--porcelain=v1"),
        result: { exitCode: 0, stdout: " M contend.md\n" },
      },
      {
        when: (a) => argvStartsWith(a, "rev-parse", "HEAD"),
        result: { exitCode: 0, stdout: `${"b".repeat(40)}\n` },
      },
    ];
    // A stateful add rule: first attempt fails with "File exists" (index.lock
    // contention), the second succeeds.
    const fake = fakeDocGit(rules);
    const baseRun = fake.run;
    const run = (a: string[], cwd: string, input?: string) => {
      if (argvStartsWith(a, "add", "-A", "--")) {
        addAttempts += 1;
        if (addAttempts === 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr:
              "fatal: Unable to create '/repo/.git/index.lock': File exists",
          };
        }
      }
      return baseRun(a, cwd, input);
    };

    const backoffs: number[] = [];
    const sha = commitDocsPaths(
      { paths: [`${REPO}/contend.md`], repoRoot: REPO, verb: "write" },
      (ms) => backoffs.push(ms),
      run,
    );
    expect(sha).toBe("b".repeat(40));
    expect(addAttempts).toBe(2);
    expect(backoffs.length).toBeGreaterThanOrEqual(1);
  });

  test("a persistent index.lock across all attempts → CommitFailed(commit_contended)", () => {
    const rules: FakeGitRule[] = [
      {
        when: (a) => argvStartsWith(a, "rev-parse", "--git-path"),
        result: { exitCode: 0, stdout: "/nonexistent/marker" },
      },
      {
        when: (a) => argvStartsWith(a, "symbolic-ref", "-q", "HEAD"),
        result: { exitCode: 0, stdout: "refs/heads/main" },
      },
      {
        when: (a) => argvStartsWith(a, "status", "--porcelain=v1"),
        result: { exitCode: 0, stdout: " M exhaust.md\n" },
      },
      // add always fails with the index.lock contention substring
      {
        when: (a) => argvStartsWith(a, "add", "-A", "--"),
        result: {
          exitCode: 1,
          stderr:
            "fatal: Unable to create '/repo/.git/index.lock': File exists",
        },
      },
    ];
    const fake = fakeDocGit(rules);

    let caught: CommitFailed | null = null;
    try {
      commitDocsPaths(
        { paths: [`${REPO}/exhaust.md`], repoRoot: REPO, verb: "write" },
        () => {},
        fake.run,
      );
    } catch (e) {
      caught = e as CommitFailed;
    }
    expect(caught).toBeInstanceOf(CommitFailed);
    expect((caught as CommitFailed).error).toBe("commit_contended");
  });

  test("a genuine add failure (not contention) surfaces immediately", () => {
    const rules: FakeGitRule[] = [
      {
        when: (a) => argvStartsWith(a, "rev-parse", "--git-path"),
        result: { exitCode: 0, stdout: "/nonexistent/marker" },
      },
      {
        when: (a) => argvStartsWith(a, "symbolic-ref", "-q", "HEAD"),
        result: { exitCode: 0, stdout: "refs/heads/main" },
      },
      {
        when: (a) => argvStartsWith(a, "status", "--porcelain=v1"),
        result: { exitCode: 0, stdout: " M bad.md\n" },
      },
      {
        when: (a) => argvStartsWith(a, "add", "-A", "--"),
        result: { exitCode: 128, stderr: "fatal: pathspec error" },
      },
    ];
    const fake = fakeDocGit(rules);
    let caught: CommitFailed | null = null;
    try {
      commitDocsPaths(
        { paths: [`${REPO}/bad.md`], repoRoot: REPO, verb: "write" },
        () => {},
        fake.run,
      );
    } catch (e) {
      caught = e as CommitFailed;
    }
    expect(caught).toBeInstanceOf(CommitFailed);
    // Surfaced as the original git_add error, NOT retried into commit_contended.
    expect((caught as CommitFailed).error).toBe("git_add");
  });
});
