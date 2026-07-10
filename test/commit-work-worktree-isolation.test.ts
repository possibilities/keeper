/**
 * Fast-tier tests for the worktree-mode commit isolation hardening
 * (fn-972-harden-worktree-autopilot-correctness.1): zero real git, zero binary
 * spawn. They assert keeper's DECISIONS, not git's effect —
 *
 *  - {@link buildGitEnv} strips the GIT_* discovery vars (so a hostile inherited
 *    `GIT_DIR`/`GIT_WORK_TREE` can never override the explicit cwd) while keeping
 *    PATH/HOME and merging caller `extra`. Pure, against a synthetic source env
 *    (no global mutation).
 *  - the `runForTest` pipeline runs EVERY git op with `cwd: <resolved worktree>`,
 *    pinned via the injected `deps.cwd` + the `--show-toplevel` resolve.
 *  - {@link pushCommitted}'s defense-in-depth: a default-branch push from a
 *    linked worktree (the skip gate raced to a false negative) ABORTS loudly and
 *    issues no push; a real main-worktree push is unaffected.
 *
 * The end-to-end real-git proof (concurrent same-repo lane commits land on their
 * own branches, never main; push skipped) lives in the allowlisted slow sibling
 * `commit-work-worktree-isolation-realgit.slow.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runForTest } from "../cli/commit-work";
import {
  buildGitEnv,
  GIT_DISCOVERY_ENV_VARS,
  type GitRunner,
} from "../src/commit-work/git-exec";
import { pushCommitted } from "../src/commit-work/push";
import {
  argvStartsWith,
  type FakeGitRule,
  fakeAsyncGit,
} from "./helpers/fake-git";

// Clear the ambient session ids so the Job-Id trailer never injects (it would add
// an `interpret-trailers` git call); the pipeline stays fully test-controlled.
let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedEnv = {
    CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
    JOBCTL_SESSION_ID: process.env.JOBCTL_SESSION_ID,
    JOBCTL_JOB_ID: process.env.JOBCTL_JOB_ID,
    KEEPER_JOB_ID: process.env.KEEPER_JOB_ID,
  };
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.JOBCTL_SESSION_ID;
  delete process.env.JOBCTL_JOB_ID;
  delete process.env.KEEPER_JOB_ID;
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ---------------------------------------------------------------------------
// buildGitEnv — strip the inherited discovery vars
// ---------------------------------------------------------------------------

describe("buildGitEnv", () => {
  test("strips inherited GIT_* discovery vars, keeps the rest, merges extra", () => {
    const source = {
      PATH: "/usr/bin",
      HOME: "/home/x",
      GIT_DIR: "/evil/.git",
      GIT_WORK_TREE: "/evil",
      GIT_INDEX_FILE: "/evil/.git/index",
      GIT_COMMON_DIR: "/evil/.git",
      GIT_TERMINAL_PROMPT: "1",
    };
    const env = buildGitEnv({ GIT_TERMINAL_PROMPT: "0" }, source);

    // Every discovery var that could override cwd-based repo discovery is gone.
    for (const key of GIT_DISCOVERY_ENV_VARS) {
      expect(key in env).toBe(false);
    }
    // PATH/HOME ride through so git's credential + config discovery still works.
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/x");
    // Caller `extra` wins over the source (applied after the strip).
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    // The source object is never mutated.
    expect(source.GIT_DIR).toBe("/evil/.git");
  });

  test("with no extra, still strips discovery vars and preserves the rest", () => {
    const env = buildGitEnv(undefined, {
      PATH: "/bin",
      GIT_DIR: "/evil/.git",
    });
    expect("GIT_DIR" in env).toBe(false);
    expect(env.PATH).toBe("/bin");
  });
});

// ---------------------------------------------------------------------------
// runForTest — every git op is pinned to the resolved worktree cwd
// ---------------------------------------------------------------------------

describe("commit-work: worktree-pinned cwd threading", () => {
  test("every git spawn carries cwd=<resolved worktree>; push is skipped", async () => {
    const worktree = "/repo/wt/lane";
    const rules: FakeGitRule[] = [
      {
        when: (a) => argvStartsWith(a, "check-ignore"),
        result: { exitCode: 1 },
      },
      {
        when: (a) => argvStartsWith(a, "rev-parse", "--show-toplevel"),
        result: { exitCode: 0, stdout: `${worktree}\n` },
      },
      {
        when: (a) => argvStartsWith(a, "add", "-A", "--"),
        result: { exitCode: 0 },
      },
      {
        when: (a) => argvStartsWith(a, "diff", "--cached", "--name-only", "-z"),
        result: { exitCode: 0, stdout: "f.txt" },
      },
      {
        when: (a) => argvStartsWith(a, "commit", "-F", "-"),
        result: { exitCode: 0 },
      },
      {
        when: (a) => argvStartsWith(a, "rev-parse", "--short", "HEAD"),
        result: { exitCode: 0, stdout: "abc1234\n" },
      },
      // Push-leg detection: linked worktree (git-dir != common-dir, no submodule).
      {
        when: (a) =>
          argvStartsWith(a, "rev-parse", "--show-superproject-working-tree"),
        result: { exitCode: 0, stdout: "" },
      },
      {
        when: (a) =>
          argvStartsWith(a, "rev-parse", "--path-format=absolute", "--git-dir"),
        result: { exitCode: 0, stdout: "/repo/.git/worktrees/lane\n" },
      },
      {
        when: (a) =>
          argvStartsWith(
            a,
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ),
        result: { exitCode: 0, stdout: "/repo/.git\n" },
      },
      {
        when: (a) => argvStartsWith(a, "rev-parse", "--abbrev-ref", "HEAD"),
        result: { exitCode: 0, stdout: "keeper/epic/x\n" },
      },
    ];
    const { run, calls } = fakeAsyncGit(rules);
    const { code, stdout } = await runForTest(
      ["feat: lane work", "--session-id", "s1"],
      {
        cwd: worktree,
        gitRunner: run,
        discoverFiles: () => ["f.txt"],
        waitCaughtUp: async () => {},
        runLint: async () => {},
        acquireLock: () => ({ release: () => {} }),
      },
    );

    expect(code).toBe(0);
    // EVERY git spawn ran with the resolved worktree as cwd — nothing escaped to
    // the ambient process cwd.
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.cwd).toBe(worktree);
    }

    // Line 2 is the worktree push-skip (success, never pushed).
    const lines = stdout.split("\n").filter((l) => l.length > 0);
    expect(JSON.parse(lines[1])).toEqual({
      success: true,
      pushed: false,
      skipped: "worktree",
      branch: "keeper/epic/x",
    });
    expect(calls.some((c) => argvStartsWith(c.args, "push"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pushCommitted — defense-in-depth protected-branch abort
// ---------------------------------------------------------------------------

describe("pushCommitted: protected-branch abort", () => {
  test("aborts a default-branch push from a linked worktree (skip gate raced)", async () => {
    // The skip gate sees git-dir == common-dir (a main-like FALSE NEGATIVE — the
    // race window); the pre-push re-check resolves the worktree as LINKED with
    // HEAD on the default branch → ABORT, never push.
    let gitDirProbe = 0;
    const seen: string[][] = [];
    const run: GitRunner = async (args) => {
      seen.push([...args]);
      if (
        argvStartsWith(args, "rev-parse", "--show-superproject-working-tree")
      ) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (
        argvStartsWith(args, "rev-parse", "--path-format=absolute", "--git-dir")
      ) {
        gitDirProbe += 1;
        // 1st inLinkedWorktree (gate): == common (looks like main → not linked).
        // 2nd inLinkedWorktree (re-check): differs → linked.
        return {
          code: 0,
          stdout:
            gitDirProbe === 1 ? "/repo/.git\n" : "/repo/.git/worktrees/lane\n",
          stderr: "",
        };
      }
      if (
        argvStartsWith(
          args,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        )
      ) {
        return { code: 0, stdout: "/repo/.git\n", stderr: "" };
      }
      if (argvStartsWith(args, "rev-parse", "--abbrev-ref", "HEAD")) {
        return { code: 0, stdout: "main\n", stderr: "" };
      }
      if (argvStartsWith(args, "symbolic-ref")) {
        return { code: 0, stdout: "origin/main\n", stderr: "" };
      }
      if (argvStartsWith(args, "for-each-ref")) {
        return { code: 0, stdout: "main\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const env = await pushCommitted("/repo/wt/lane", run);
    expect(env.success).toBe(false);
    if (env.success) throw new Error("unreachable");
    expect(env.push_error_class).toBe("protected_branch");
    expect(env.push_error).toContain("main");
    expect(env.push_error).toContain("/repo/wt/lane");
    // The decision: never issued a push.
    expect(seen.some((a) => a[0] === "push")).toBe(false);
  });

  test("a real main worktree on the default branch still pushes (no false abort)", async () => {
    // git-dir == common-dir on EVERY probe → never linked → the abort short-
    // circuits and the normal push runs.
    const { run, calls } = fakeAsyncGit([
      {
        when: (a) =>
          argvStartsWith(a, "rev-parse", "--show-superproject-working-tree"),
        result: { exitCode: 0, stdout: "" },
      },
      {
        when: (a) =>
          argvStartsWith(a, "rev-parse", "--path-format=absolute", "--git-dir"),
        result: { exitCode: 0, stdout: "/repo/.git\n" },
      },
      {
        when: (a) =>
          argvStartsWith(
            a,
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ),
        result: { exitCode: 0, stdout: "/repo/.git\n" },
      },
      {
        when: (a) => argvStartsWith(a, "rev-parse", "--abbrev-ref", "HEAD"),
        result: { exitCode: 0, stdout: "main\n" },
      },
      {
        when: (a) => a.includes("@{u}"),
        result: { exitCode: 0, stdout: "origin/main\n" },
      },
      { when: (a) => argvStartsWith(a, "push"), result: { exitCode: 0 } },
    ]);
    const env = await pushCommitted("/repo", run);
    expect(env).toEqual({
      success: true,
      pushed: true,
      remote: "origin",
      branch: "main",
    });
    expect(calls.some((c) => argvStartsWith(c.args, "push"))).toBe(true);
  });
});
