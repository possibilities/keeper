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
 * the injected command seam.
 */

import { describe, expect, test } from "bun:test";
import { runForTest } from "../cli/commit-work";
import {
  buildGitEnv,
  GIT_DISCOVERY_ENV_VARS,
  type GitRunner,
} from "../src/commit-work/git-exec";
import { pushCommitted, pushExactCommit } from "../src/commit-work/push";
import {
  argvStartsWith,
  type FakeGitRule,
  fakeAsyncGit,
} from "./helpers/fake-git";

const FAKE_COMMIT = "abcdef0123456789abcdef0123456789abcdef01";

// The pipeline fixture supplies an explicit empty `deps.env`; no test mutates
// process-wide invocation identity carriers.

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
        when: (a) => argvStartsWith(a, "commit-tree"),
        result: { exitCode: 0, stdout: `${FAKE_COMMIT}\n` },
      },
      {
        when: (a) => argvStartsWith(a, "rev-parse", "--short", "HEAD"),
        result: { exitCode: 0, stdout: `${FAKE_COMMIT}\n` },
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
    const fake = fakeAsyncGit(rules);
    let privateUpdated = false;
    const run: GitRunner = async (args, options) => {
      if (args[0] === "status") {
        await fake.run(args, options);
        return { code: 0, stdout: "? f.txt\0", stderr: "" };
      }
      if (args[0] === "symbolic-ref" && args[1] === "-q") {
        await fake.run(args, options);
        return { code: 0, stdout: "refs/heads/keeper/epic/x\n", stderr: "" };
      }
      if (
        args[0] === "rev-parse" &&
        args[1] === "--verify" &&
        args[2] === "refs/heads/keeper/epic/x^{commit}"
      ) {
        await fake.run(args, options);
        return { code: 0, stdout: "parent\n", stderr: "" };
      }
      if (
        args[0] === "rev-parse" &&
        args[1] === "--verify" &&
        args[2] === "HEAD^{commit}"
      ) {
        await fake.run(args, options);
        return { code: 0, stdout: `${FAKE_COMMIT}\n`, stderr: "" };
      }
      if (args[0] === "hash-object") {
        await fake.run(args, options);
        return {
          code: 0,
          stdout: "1234567890123456789012345678901234567890\n",
          stderr: "",
        };
      }
      if (args[0] === "config" && args.includes("core.filemode")) {
        await fake.run(args, options);
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      if (args[0] === "update-index") {
        const result = await fake.run(args, options);
        if (result.code === 0 && options?.env?.GIT_INDEX_FILE) {
          privateUpdated = true;
        }
        return result;
      }
      if (args[0] === "ls-files" && options?.env?.GIT_INDEX_FILE) {
        await fake.run(args, options);
        return { code: 0, stdout: "100644 blob 0\tf.txt\0", stderr: "" };
      }
      if (args[0] === "write-tree" && options?.env?.GIT_INDEX_FILE) {
        await fake.run(args, options);
        return {
          code: 0,
          stdout: privateUpdated ? "tree\n" : "base-tree\n",
          stderr: "",
        };
      }
      if (args[0] === "interpret-trailers") {
        await fake.run(args, options);
        const message = options?.stdin
          ? new TextDecoder().decode(options.stdin)
          : "";
        const trailers = args
          .flatMap((arg, index) =>
            arg === "--trailer" ? [args[index + 1]] : [],
          )
          .filter((value): value is string => value !== undefined);
        return {
          code: 0,
          stdout: `${message.trimEnd()}\n\n${trailers.join("\n")}\n`,
          stderr: "",
        };
      }
      if (
        argvStartsWith(
          args,
          "rev-parse",
          "--path-format=absolute",
          "--git-dir",
        ) &&
        options?.cwd?.endsWith("/admin-worktree")
      ) {
        await fake.run(args, options);
        return {
          code: 0,
          stdout: "/repo/.git/worktrees/admin-worktree\n",
          stderr: "",
        };
      }
      if (args[0] === "cat-file" && args[1] === "commit") {
        await fake.run(args, options);
        return {
          code: 0,
          stdout:
            "tree tree\nparent parent\nauthor Test <t@example.com> 1 +0000\n" +
            "committer Test <t@example.com> 1 +0000\n\nmessage\n",
          stderr: "",
        };
      }
      return fake.run(args, options);
    };
    const { code, stdout } = await runForTest(
      [
        "feat: lane work",
        "--session-id",
        "11111111-1111-4111-8111-111111111111",
      ],
      {
        cwd: worktree,
        env: {},
        gitRunner: run,
        validateIdentity: () => true,
        directEvidence: () => ({
          currentSessionPaths: ["f.txt"],
          complete: true,
        }),
        readClaims: () => [],
        runLint: async () => {},
        acquireLock: () => ({ release: () => {} }),
        detectInProgress: async () => null,
        checkSharedCheckoutJam: () => false,
        privateIndexFs: {
          makeTempDir: () => "/tmp/keeper-worktree-isolation-test",
          removeTempDir: () => {},
          commitMarker: () => "worktree-test",
          inspectPath: () => ({ kind: "file", executable: false }),
          fingerprintIndex: () => "stable-private-index",
          targetIndexPath: () => "/repo/.git/index",
        },
      },
    );
    const { calls } = fake;

    expect(code).toBe(0);
    // Every repository operation stays pinned to the original lane; no
    // administrative worktree is created for commit publication.
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.cwd).toBe(worktree);
    }
    expect(calls.some((c) => c.args[0] === "worktree")).toBe(false);
    const commitTree = calls.find((c) => c.args[0] === "commit-tree");
    expect(commitTree?.cwd).toBe(worktree);
    expect(commitTree?.args.slice(0, 4)).toEqual([
      "commit-tree",
      "tree",
      "-p",
      "parent",
    ]);

    // The one terminal envelope carries the worktree push-skip fields.
    expect(JSON.parse(stdout)).toMatchObject({
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

  test("the exact-SHA API skips when the second linkage probe sees a worktree", async () => {
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
      if (argvStartsWith(args, "symbolic-ref")) {
        return { code: 0, stdout: "origin/main\n", stderr: "" };
      }
      if (argvStartsWith(args, "for-each-ref")) {
        return { code: 0, stdout: "main\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const env = await pushExactCommit(
      "/repo/wt/lane",
      FAKE_COMMIT,
      "refs/heads/main",
      run,
    );
    expect(env).toMatchObject({
      success: true,
      pushed: false,
      skipped: "worktree",
      branch: "main",
    });
    expect(seen.some((args) => args[0] === "push")).toBe(false);
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
