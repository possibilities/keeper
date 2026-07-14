import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  GIT_SPAWN_TIMEOUT_CODE,
  type GitExecOptions,
  type GitRunner,
  gitExec,
} from "../../src/commit-work/git-exec";
import {
  cleanupPrivateIndex,
  commitFrozenPrivateIndex,
  createFrozenPrivateIndex,
  type FrozenPrivateIndex,
  type PrivateIndexError,
  reconcileAmbientIndexEntries,
} from "../../src/commit-work/private-index";
import { pushExactCommit } from "../../src/commit-work/push";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function git(
  cwd: string,
  args: string[],
  options: Omit<GitExecOptions, "cwd"> = {},
): Promise<string> {
  const result = await gitExec(args, { ...options, cwd });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function repoWithBase(
  files: Record<string, string> = { "selected.txt": "base\n" },
): Promise<{ root: string; repo: string; expected: string }> {
  const root = mkdtempSync(join(tmpdir(), "keeper-publication-realgit-"));
  roots.push(root);
  const repoPath = join(root, "repo");
  mkdirSync(repoPath);
  const repo = realpathSync(repoPath);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Keeper Test"]);
  await git(repo, ["config", "user.email", "keeper@example.test"]);
  await git(repo, ["config", "commit.gpgSign", "false"]);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(repo, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  await git(repo, ["add", "--", ...Object.keys(files)]);
  await git(repo, ["commit", "-m", "base"]);
  return { root, repo, expected: await git(repo, ["rev-parse", "HEAD"]) };
}

function recordingRunner(): {
  run: GitRunner;
  calls: Array<{ args: string[]; options: GitExecOptions }>;
} {
  const calls: Array<{ args: string[]; options: GitExecOptions }> = [];
  const run: GitRunner = async (args, options = {}) => {
    calls.push({ args: [...args], options: { ...options } });
    return gitExec(args, options);
  };
  return { run, calls };
}

async function frozen(
  repo: string,
  paths: string[],
  run: GitRunner = gitExec,
): Promise<FrozenPrivateIndex> {
  return createFrozenPrivateIndex(repo, paths, run);
}

async function worktreePaths(repo: string): Promise<string[]> {
  const raw = await git(repo, ["worktree", "list", "--porcelain", "-z"]);
  return raw
    .split("\0")
    .filter((record) => record.startsWith("worktree "))
    .map((record) => record.slice("worktree ".length));
}

function installHookAt(hooksDir: string, name: string, body: string): void {
  mkdirSync(hooksDir, { recursive: true });
  const hook = join(hooksDir, name);
  writeFileSync(hook, `#!/bin/sh\nset -eu\n${body}\n`);
  chmodSync(hook, 0o755);
}

function installHook(repo: string, name: string, body: string): void {
  installHookAt(join(repo, ".git", "hooks"), name, body);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

describe("commit-work real-git exact index construction", () => {
  test("file to directory conversion refuses a partial selection and allows all affected paths", async () => {
    const { repo } = await repoWithBase({ node: "tracked file\n" });
    unlinkSync(join(repo, "node"));
    mkdirSync(join(repo, "node"));
    writeFileSync(join(repo, "node", "child.txt"), "selected child\n");

    await expect(frozen(repo, ["node"])).rejects.toMatchObject({
      code: "directory_file_conflict",
      paths: ["node/child.txt"],
    });

    const privateIndex = await frozen(repo, ["node", "node/child.txt"]);
    try {
      expect(privateIndex.entries).toEqual([
        expect.objectContaining({ path: "node", kind: "absent" }),
        expect.objectContaining({ path: "node/child.txt", kind: "file" }),
      ]);
      const committed = await commitFrozenPrivateIndex(
        privateIndex,
        "feat: replace file with directory",
        repo,
        gitExec,
      );
      expect(
        (await git(repo, ["ls-tree", "-r", "--name-only", committed.sha]))
          .split("\n")
          .filter(Boolean),
      ).toEqual(["node/child.txt"]);
    } finally {
      cleanupPrivateIndex(privateIndex);
    }
  });

  test("directory to file conversion refuses omitted descendants and allows all affected paths", async () => {
    const { repo } = await repoWithBase({
      "node/a.txt": "a\n",
      "node/b.txt": "b\n",
    });
    rmSync(join(repo, "node"), { recursive: true });
    writeFileSync(join(repo, "node"), "replacement file\n");

    await expect(frozen(repo, ["node"])).rejects.toMatchObject({
      code: "directory_file_conflict",
      paths: ["node/a.txt", "node/b.txt"],
    });

    const privateIndex = await frozen(repo, [
      "node",
      "node/a.txt",
      "node/b.txt",
    ]);
    try {
      const committed = await commitFrozenPrivateIndex(
        privateIndex,
        "feat: replace directory with file",
        repo,
        gitExec,
      );
      expect(
        (await git(repo, ["ls-tree", "-r", "--name-only", committed.sha]))
          .split("\n")
          .filter(Boolean),
      ).toEqual(["node"]);
    } finally {
      cleanupPrivateIndex(privateIndex);
    }
  });

  test("weird names, executable modes, and symlinks survive exact index plumbing", async () => {
    const weird = "odd\\name\nwith\ttabs.txt";
    const { repo } = await repoWithBase({
      [weird]: "base\n",
      "mode.sh": "echo base\n",
    });
    writeFileSync(join(repo, weird), "changed\n");
    chmodSync(join(repo, "mode.sh"), 0o755);
    symlinkSync("target with spaces", join(repo, "link"));

    const privateIndex = await frozen(repo, [weird, "mode.sh", "link"]);
    try {
      const committed = await commitFrozenPrivateIndex(
        privateIndex,
        "test: preserve exact git identities",
        repo,
        gitExec,
      );
      const tree = await git(repo, ["ls-tree", "-r", "-z", committed.sha]);
      const modes = new Map(
        tree
          .split("\0")
          .filter(Boolean)
          .map((record) => {
            const tab = record.indexOf("\t");
            return [
              record.slice(tab + 1),
              record.slice(0, tab).split(" ")[0] ?? "",
            ];
          }),
      );
      expect(modes.get(weird)).toBe("100644");
      expect(modes.get("mode.sh")).toBe("100755");
      expect(modes.get("link")).toBe("120000");
      expect(await git(repo, ["show", `${committed.sha}:link`])).toBe(
        "target with spaces",
      );
    } finally {
      cleanupPrivateIndex(privateIndex);
    }
  });

  test("ambient reconciliation preserves a foreign staged entry byte-for-byte", async () => {
    const { repo } = await repoWithBase({
      "selected.txt": "selected base\n",
      "foreign.txt": "foreign base\n",
    });
    writeFileSync(join(repo, "foreign.txt"), "foreign staged\n");
    await git(repo, ["add", "--", "foreign.txt"]);
    const foreignBefore = await git(repo, [
      "ls-files",
      "-s",
      "--",
      "foreign.txt",
    ]);
    writeFileSync(join(repo, "selected.txt"), "selected keeper\n");

    const privateIndex = await frozen(repo, ["selected.txt"]);
    try {
      await commitFrozenPrivateIndex(
        privateIndex,
        "feat: selected only",
        repo,
        gitExec,
      );
      await reconcileAmbientIndexEntries(
        privateIndex.entries,
        privateIndex.expectedHead,
        repo,
        gitExec,
      );
      expect(await git(repo, ["ls-files", "-s", "--", "foreign.txt"])).toBe(
        foreignBefore,
      );
      expect(
        (await git(repo, ["diff", "--cached", "--name-only", "-z"]))
          .split("\0")
          .filter(Boolean),
      ).toEqual(["foreign.txt"]);
    } finally {
      cleanupPrivateIndex(privateIndex);
    }
  });
});

describe("commit-work real-git atomic plumbing publication", () => {
  test("commit-tree uses the frozen tree and parent, then publishes one CAS", async () => {
    const { repo, expected } = await repoWithBase();
    writeFileSync(join(repo, "selected.txt"), "keeper change\n");
    const recording = recordingRunner();
    const privateIndex = await frozen(repo, ["selected.txt"], recording.run);
    try {
      const committed = await commitFrozenPrivateIndex(
        privateIndex,
        "feat: atomic plumbing commit",
        repo,
        recording.run,
      );
      expect(await git(repo, ["rev-parse", "refs/heads/main"])).toBe(
        committed.sha,
      );
      expect(
        await git(repo, ["show", "-s", "--format=%P", committed.sha]),
      ).toBe(expected);
      const commitTree = recording.calls.find(
        (call) => call.args[0] === "commit-tree",
      );
      expect(commitTree?.args.slice(0, 5)).toEqual([
        "commit-tree",
        privateIndex.tree,
        "-p",
        expected,
        "-F",
      ]);
      expect(commitTree?.options.cwd).toBe(repo);
      expect(
        recording.calls.filter((call) => call.args[0] === "update-ref"),
      ).toHaveLength(1);
      expect(recording.calls.some((call) => call.args[0] === "worktree")).toBe(
        false,
      );
      expect(await worktreePaths(repo)).toEqual([repo]);
    } finally {
      cleanupPrivateIndex(privateIndex);
    }
  });

  test("hook tree mutation discards the temporary commit and never moves main", async () => {
    const { repo, expected } = await repoWithBase();
    writeFileSync(join(repo, "selected.txt"), "frozen change\n");
    const hook = join(repo, ".git", "hooks", "pre-commit");
    writeFileSync(
      hook,
      "#!/bin/sh\nprintf 'hook mutation\\n' > selected.txt\ngit add -- selected.txt\n",
    );
    chmodSync(hook, 0o755);

    const privateIndex = await frozen(repo, ["selected.txt"]);
    try {
      let error: PrivateIndexError | null = null;
      try {
        await commitFrozenPrivateIndex(
          privateIndex,
          "test: hook mutation",
          repo,
          gitExec,
        );
      } catch (caught) {
        error = caught as PrivateIndexError;
      }
      expect(error).toMatchObject({
        code: "commit_hook_mutated",
        committed: false,
        indeterminate: false,
      });
      expect(await git(repo, ["rev-parse", "refs/heads/main"])).toBe(expected);
      expect(await worktreePaths(repo)).toEqual([repo]);
    } finally {
      cleanupPrivateIndex(privateIndex);
    }
  });

  test("an operation starting during a hook aborts before commit creation", async () => {
    const { repo, expected } = await repoWithBase();
    writeFileSync(join(repo, "selected.txt"), "merge-race change\n");
    installHook(
      repo,
      "pre-commit",
      `printf '%s\\n' ${shellQuote(expected)} > .git/MERGE_HEAD`,
    );
    const recording = recordingRunner();
    const privateIndex = await frozen(repo, ["selected.txt"], recording.run);
    let probes = 0;
    try {
      await expect(
        commitFrozenPrivateIndex(
          privateIndex,
          "feat: reject merge race",
          repo,
          recording.run,
          {},
          {
            beforeCommit: async () => {
              probes += 1;
              return existsSync(join(repo, ".git", "MERGE_HEAD"))
                ? "merge"
                : null;
            },
          },
        ),
      ).rejects.toMatchObject({
        code: "operation_in_progress",
        operation: "merge",
      });
      expect(probes).toBe(2);
      expect(
        recording.calls.some((call) => call.args[0] === "commit-tree"),
      ).toBe(false);
      expect(await git(repo, ["rev-parse", "refs/heads/main"])).toBe(expected);
    } finally {
      cleanupPrivateIndex(privateIndex);
    }
  });

  test("switching the original symbolic HEAD aborts before publication", async () => {
    const { repo, expected } = await repoWithBase();
    await git(repo, ["branch", "other", expected]);
    writeFileSync(join(repo, "selected.txt"), "branch-race change\n");
    const privateIndex = await frozen(repo, ["selected.txt"]);
    let switched = false;
    try {
      await expect(
        commitFrozenPrivateIndex(
          privateIndex,
          "feat: captured branch",
          repo,
          gitExec,
          {},
          {
            beforeCommit: async () => {
              if (!switched) {
                switched = true;
                await git(repo, ["switch", "other"]);
              }
              return null;
            },
          },
        ),
      ).rejects.toMatchObject({ code: "commit_hook_mutated" });
      expect(await git(repo, ["symbolic-ref", "HEAD"])).toBe(
        "refs/heads/other",
      );
      expect(await git(repo, ["rev-parse", "refs/heads/main"])).toBe(expected);
      expect(await git(repo, ["rev-parse", "refs/heads/other"])).toBe(expected);
    } finally {
      cleanupPrivateIndex(privateIndex);
    }
  });

  test("CAS failure leaves the competing ref intact and performs no rollback", async () => {
    const { repo, expected } = await repoWithBase();
    await git(repo, ["switch", "-c", "competitor"]);
    writeFileSync(join(repo, "race.txt"), "competing commit\n");
    await git(repo, ["add", "--", "race.txt"]);
    await git(repo, ["commit", "-m", "competitor"]);
    const competitor = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["switch", "main"]);
    writeFileSync(join(repo, "selected.txt"), "keeper candidate\n");

    const recording = recordingRunner();
    const privateIndex = await frozen(repo, ["selected.txt"], recording.run);
    try {
      let error: PrivateIndexError | null = null;
      try {
        await commitFrozenPrivateIndex(
          privateIndex,
          "feat: lose CAS",
          repo,
          recording.run,
          {},
          {
            beforeCommit: async () => {
              if (
                (await git(repo, ["rev-parse", "refs/heads/main"])) === expected
              ) {
                await git(repo, [
                  "update-ref",
                  "refs/heads/main",
                  competitor,
                  expected,
                ]);
              }
              return null;
            },
          },
        );
      } catch (caught) {
        error = caught as PrivateIndexError;
      }
      expect(error).toMatchObject({
        code: "ref_conflict",
        committed: false,
        indeterminate: false,
      });
      expect(await git(repo, ["rev-parse", "refs/heads/main"])).toBe(
        competitor,
      );
      expect(
        recording.calls.filter((call) => call.args[0] === "update-ref"),
      ).toHaveLength(1);
      expect(await worktreePaths(repo)).toEqual([repo]);
    } finally {
      cleanupPrivateIndex(privateIndex);
    }
  });

  test("hooks remain in the original target worktree context", async () => {
    const { root, repo, expected } = await repoWithBase();
    await git(repo, ["branch", "other", expected]);
    const observed = join(root, "observed-hook-branch");
    installHook(
      repo,
      "pre-commit",
      `git symbolic-ref --short HEAD > ${shellQuote(observed)}`,
    );
    writeFileSync(join(repo, "selected.txt"), "target-context change\n");
    const privateIndex = await frozen(repo, ["selected.txt"]);
    let switched = false;
    try {
      await expect(
        commitFrozenPrivateIndex(
          privateIndex,
          "test: hook target context",
          repo,
          gitExec,
          {},
          {
            beforeCommit: async () => {
              if (!switched) {
                switched = true;
                await git(repo, ["switch", "other"]);
              }
              return null;
            },
          },
        ),
      ).rejects.toMatchObject({ code: "commit_hook_mutated" });
      expect(readFileSync(observed, "utf8").trim()).toBe("other");
      expect(await git(repo, ["symbolic-ref", "--short", "HEAD"])).toBe(
        "other",
      );
      expect(await git(repo, ["rev-parse", "refs/heads/main"])).toBe(expected);
    } finally {
      cleanupPrivateIndex(privateIndex);
    }
  });

  test("linked target worktree config controls hooks, identity, and signing", async () => {
    const { root, repo } = await repoWithBase();
    await git(repo, ["config", "extensions.worktreeConfig", "true"]);
    await git(repo, ["config", "user.name", "Common Identity"]);
    await git(repo, ["config", "user.email", "common@example.test"]);

    const targetPath = join(root, "target");
    await git(repo, ["worktree", "add", "-b", "target", targetPath, "main"]);
    const target = realpathSync(targetPath);
    const targetHooks = join(root, "target-hooks");
    const observed = join(root, "target-hooks-observed");
    await git(target, ["config", "--worktree", "core.hooksPath", targetHooks]);
    await git(target, ["config", "--worktree", "user.name", "Target Identity"]);
    await git(target, [
      "config",
      "--worktree",
      "user.email",
      "target@example.test",
    ]);
    await git(target, ["config", "--worktree", "commit.gpgSign", "true"]);

    installHook(repo, "pre-commit", "exit 97");
    installHookAt(
      targetHooks,
      "pre-commit",
      `printf 'pre:%s:%s\\n' "$(git config --get user.email)" "$(git symbolic-ref --short HEAD)" >> ${shellQuote(observed)}`,
    );
    installHookAt(
      targetHooks,
      "post-commit",
      `printf 'post:%s:%s\\n' "$(git config --get user.email)" "$(git rev-parse HEAD)" >> ${shellQuote(observed)}`,
    );

    writeFileSync(join(target, "selected.txt"), "target-local config\n");
    let signingSeen = false;
    const calls: Array<{ args: string[]; options: GitExecOptions }> = [];
    const run: GitRunner = async (args, options = {}) => {
      calls.push({ args: [...args], options: { ...options } });
      if (args[0] === "commit-tree" && args.includes("-S")) {
        signingSeen = true;
        return gitExec(
          args.filter((arg) => arg !== "-S"),
          options,
        );
      }
      return gitExec(args, options);
    };

    const privateIndex = await frozen(target, ["selected.txt"], run);
    try {
      const committed = await commitFrozenPrivateIndex(
        privateIndex,
        "test: target worktree config",
        target,
        run,
      );
      expect(signingSeen).toBe(true);
      expect(
        (
          await git(target, [
            "show",
            "-s",
            "--format=%an%x00%ae",
            committed.sha,
          ])
        ).split("\0"),
      ).toEqual(["Target Identity", "target@example.test"]);
      expect(readFileSync(observed, "utf8").trim().split("\n")).toEqual([
        "pre:target@example.test:target",
        `post:target@example.test:${committed.sha}`,
      ]);

      const contextual = calls.filter(
        (call) =>
          call.args[0] === "hook" ||
          call.args[0] === "commit-tree" ||
          (call.args[0] === "config" && call.args.includes("commit.gpgSign")),
      );
      expect(contextual.length).toBeGreaterThanOrEqual(6);
      for (const call of contextual) {
        expect(call.options.cwd).toBe(target);
        expect(call.options.env?.GIT_INDEX_FILE).toBe(privateIndex.indexPath);
        expect(call.options.env?.GIT_DIR).toBeUndefined();
        expect(call.options.env?.GIT_COMMON_DIR).toBeUndefined();
        expect(call.options.env?.GIT_WORK_TREE).toBeUndefined();
      }
    } finally {
      cleanupPrivateIndex(privateIndex);
    }
  });

  for (const hookName of [
    "pre-commit",
    "prepare-commit-msg",
    "commit-msg",
  ] as const) {
    test(`${hookName} worktree/index mutation aborts before ref publication`, async () => {
      const { repo, expected } = await repoWithBase();
      writeFileSync(join(repo, "selected.txt"), "frozen hook input\n");
      installHook(
        repo,
        hookName,
        "printf 'mutated by hook\\n' > selected.txt\ngit add -- selected.txt",
      );
      const privateIndex = await frozen(repo, ["selected.txt"]);
      try {
        await expect(
          commitFrozenPrivateIndex(
            privateIndex,
            `test: ${hookName} mutation`,
            repo,
            gitExec,
          ),
        ).rejects.toMatchObject({
          code: "commit_hook_mutated",
          committed: false,
        });
        expect(await git(repo, ["rev-parse", "refs/heads/main"])).toBe(
          expected,
        );
      } finally {
        cleanupPrivateIndex(privateIndex);
      }
    });
  }

  for (const mutation of ["--skip-worktree", "--assume-unchanged"] as const) {
    test(`a hook setting ${mutation} aborts despite an unchanged tree`, async () => {
      const { repo, expected } = await repoWithBase();
      writeFileSync(join(repo, "selected.txt"), "flag-only hook candidate\n");
      installHook(
        repo,
        "pre-commit",
        `git update-index ${mutation} -- selected.txt`,
      );
      const privateIndex = await frozen(repo, ["selected.txt"]);
      try {
        await expect(
          commitFrozenPrivateIndex(
            privateIndex,
            `test: reject ${mutation}`,
            repo,
            gitExec,
          ),
        ).rejects.toMatchObject({
          code: "commit_hook_mutated",
          stderr: "commit hook changed the private index file",
          committed: false,
        });
        expect(await git(repo, ["rev-parse", "refs/heads/main"])).toBe(
          expected,
        );
      } finally {
        cleanupPrivateIndex(privateIndex);
      }
    });
  }

  for (const [mutation, flag] of [
    ["--assume-unchanged", "h"],
    ["--skip-worktree", "S"],
  ] as const) {
    test(`an ambient ${mutation} hook mutation is reported and preserved`, async () => {
      const { repo, expected } = await repoWithBase();
      writeFileSync(join(repo, "selected.txt"), "ambient flag candidate\n");
      installHook(
        repo,
        "pre-commit",
        `unset GIT_INDEX_FILE GIT_DIR GIT_COMMON_DIR GIT_WORK_TREE\ngit update-index ${mutation} -- selected.txt`,
      );
      const privateIndex = await frozen(repo, ["selected.txt"]);
      try {
        await expect(
          commitFrozenPrivateIndex(
            privateIndex,
            `test: ambient ${mutation}`,
            repo,
            gitExec,
          ),
        ).rejects.toMatchObject({
          code: "commit_hook_mutated",
          stderr: "commit hook changed the target worktree index file",
          committed: false,
        });
        expect(await git(repo, ["rev-parse", "refs/heads/main"])).toBe(
          expected,
        );
        expect(await git(repo, ["ls-files", "-v", "--", "selected.txt"])).toBe(
          `${flag} selected.txt`,
        );
      } finally {
        cleanupPrivateIndex(privateIndex);
      }
    });
  }

  test("a hook mutating the real ambient index also aborts before publication", async () => {
    const { repo, expected } = await repoWithBase();
    writeFileSync(join(repo, "selected.txt"), "ambient index candidate\n");
    installHook(
      repo,
      "pre-commit",
      "unset GIT_INDEX_FILE GIT_DIR GIT_COMMON_DIR GIT_WORK_TREE\ngit add -- selected.txt",
    );
    const privateIndex = await frozen(repo, ["selected.txt"]);
    try {
      await expect(
        commitFrozenPrivateIndex(
          privateIndex,
          "test: ambient hook mutation",
          repo,
          gitExec,
        ),
      ).rejects.toMatchObject({ code: "commit_hook_mutated" });
      expect(await git(repo, ["rev-parse", "refs/heads/main"])).toBe(expected);
    } finally {
      cleanupPrivateIndex(privateIndex);
    }
  });

  test("a message hook stripping an internal trailer aborts before publication", async () => {
    const { repo, expected } = await repoWithBase();
    writeFileSync(join(repo, "selected.txt"), "message hook input\n");
    installHook(
      repo,
      "commit-msg",
      'grep -v \'^Keeper-Commit-Id:\' "$1" > "$1.next"\nmv "$1.next" "$1"',
    );
    const privateIndex = await frozen(repo, ["selected.txt"]);
    try {
      await expect(
        commitFrozenPrivateIndex(
          privateIndex,
          "test: preserve internal trailers\n\nTask: fn-hook.1",
          repo,
          gitExec,
          {},
          { jobId: JOB_ID },
        ),
      ).rejects.toMatchObject({ code: "commit_hook_mutated" });
      expect(await git(repo, ["rev-parse", "refs/heads/main"])).toBe(expected);
    } finally {
      cleanupPrivateIndex(privateIndex);
    }
  });

  test("commit signing adds -S while retaining the explicit tree and parent", async () => {
    const { repo, expected } = await repoWithBase();
    writeFileSync(join(repo, "selected.txt"), "signed candidate\n");
    let signingArgv: string[] | undefined;
    const run: GitRunner = async (args, options) => {
      if (
        args[0] === "config" &&
        args.includes("--get") &&
        args.includes("commit.gpgSign")
      ) {
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      if (args[0] === "commit-tree") {
        signingArgv = [...args];
        return gitExec(
          args.filter((arg) => arg !== "-S"),
          options,
        );
      }
      return gitExec(args, options);
    };
    const privateIndex = await frozen(repo, ["selected.txt"], run);
    try {
      await commitFrozenPrivateIndex(
        privateIndex,
        "test: signing argv",
        repo,
        run,
      );
      expect(signingArgv).toContain("-S");
      expect(signingArgv?.slice(0, 4)).toEqual([
        "commit-tree",
        privateIndex.tree,
        "-p",
        expected,
      ]);
    } finally {
      cleanupPrivateIndex(privateIndex);
    }
  });

  test("signer mutation is revalidated after commit-tree and before CAS", async () => {
    const { repo, expected } = await repoWithBase();
    writeFileSync(join(repo, "selected.txt"), "signer mutation candidate\n");
    let unreachable = "";
    const run: GitRunner = async (args, options) => {
      if (
        args[0] === "config" &&
        args.includes("--get") &&
        args.includes("commit.gpgSign")
      ) {
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      if (args[0] === "commit-tree") {
        const result = await gitExec(
          args.filter((arg) => arg !== "-S"),
          options,
        );
        unreachable = result.stdout.trim();
        await gitExec(
          ["update-index", "--assume-unchanged", "--", "selected.txt"],
          {
            cwd: repo,
          },
        );
        return result;
      }
      return gitExec(args, options);
    };
    const privateIndex = await frozen(repo, ["selected.txt"], run);
    try {
      await expect(
        commitFrozenPrivateIndex(
          privateIndex,
          "test: signer mutation",
          repo,
          run,
        ),
      ).rejects.toMatchObject({
        code: "commit_hook_mutated",
        commitSha: expect.any(String),
        committed: false,
      });
      expect(unreachable).toMatch(/^[0-9a-f]{40,64}$/);
      expect(await git(repo, ["cat-file", "-t", unreachable])).toBe("commit");
      expect(await git(repo, ["rev-parse", "refs/heads/main"])).toBe(expected);
      expect(await git(repo, ["ls-files", "-v", "--", "selected.txt"])).toBe(
        "h selected.txt",
      );
    } finally {
      cleanupPrivateIndex(privateIndex);
    }
  });

  test("a signing failure is typed and leaves the target ref untouched", async () => {
    const { repo, expected } = await repoWithBase();
    writeFileSync(join(repo, "selected.txt"), "unsigned candidate\n");
    const run: GitRunner = async (args, options) => {
      if (
        args[0] === "config" &&
        args.includes("--get") &&
        args.includes("commit.gpgSign")
      ) {
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      if (args[0] === "commit-tree") {
        return { code: 1, stdout: "", stderr: "signing failed" };
      }
      return gitExec(args, options);
    };
    const privateIndex = await frozen(repo, ["selected.txt"], run);
    try {
      await expect(
        commitFrozenPrivateIndex(
          privateIndex,
          "test: signing failure",
          repo,
          run,
        ),
      ).rejects.toMatchObject({
        code: "commit_signing_failed",
        stderr: "signing failed",
      });
      expect(await git(repo, ["rev-parse", "refs/heads/main"])).toBe(expected);
    } finally {
      cleanupPrivateIndex(privateIndex);
    }
  });

  test("post-commit hook failure is committed-local and never rewinds", async () => {
    const { repo, expected } = await repoWithBase();
    writeFileSync(join(repo, "selected.txt"), "post hook candidate\n");
    installHook(repo, "post-commit", "echo post-failed >&2\nexit 7");
    const privateIndex = await frozen(repo, ["selected.txt"]);
    try {
      const committed = await commitFrozenPrivateIndex(
        privateIndex,
        "test: post hook failure",
        repo,
        gitExec,
      );
      expect(committed.postCommitHookWarning).toMatchObject({
        code: "post_commit_hook_failed",
      });
      expect(committed.postCommitHookWarning?.stderr).toContain("post-failed");
      expect(await git(repo, ["rev-parse", "refs/heads/main"])).toBe(
        committed.sha,
      );
      expect(committed.sha).not.toBe(expected);
    } finally {
      cleanupPrivateIndex(privateIndex);
    }
  });

  test("private message files are removed after publication", async () => {
    const { repo } = await repoWithBase();
    writeFileSync(join(repo, "selected.txt"), "cleanup candidate\n");
    const privateIndex = await frozen(repo, ["selected.txt"]);
    try {
      await commitFrozenPrivateIndex(
        privateIndex,
        "test: private cleanup",
        repo,
        gitExec,
      );
      expect(
        readdirSync(privateIndex.dir).filter((name) =>
          name.startsWith("message-"),
        ),
      ).toEqual([]);
    } finally {
      cleanupPrivateIndex(privateIndex);
    }
  });

  test("failed pre-commit leaves no admin state and private cleanup is bounded", async () => {
    const { repo } = await repoWithBase();
    writeFileSync(join(repo, "selected.txt"), "candidate\n");
    const hook = join(repo, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    const privateIndex = await frozen(repo, ["selected.txt"]);
    expect(existsSync(privateIndex.dir)).toBe(true);
    await expect(
      commitFrozenPrivateIndex(
        privateIndex,
        "test: hook refusal",
        repo,
        gitExec,
      ),
    ).rejects.toMatchObject({ code: "commit_failed" });
    expect(await worktreePaths(repo)).toEqual([repo]);
    cleanupPrivateIndex(privateIndex);
    expect(existsSync(privateIndex.dir)).toBe(false);
  });
});

describe("commit-work real-git exact push and trailers", () => {
  test("pushes the Keeper commit SHA even after the local branch advances", async () => {
    const { root, repo, expected } = await repoWithBase();
    const remote = join(root, "origin.git");
    await git(root, ["init", "--bare", remote]);
    await git(repo, ["remote", "add", "origin", remote]);
    await git(repo, ["push", "-u", "origin", "main"]);
    writeFileSync(join(repo, "selected.txt"), "keeper push candidate\n");
    const privateIndex = await frozen(repo, ["selected.txt"]);
    try {
      const committed = await commitFrozenPrivateIndex(
        privateIndex,
        "feat: exact push source",
        repo,
        gitExec,
      );
      writeFileSync(join(repo, "later.txt"), "later local commit\n");
      await git(repo, ["add", "--", "later.txt"]);
      await git(repo, ["commit", "-m", "later local"]);
      const later = await git(repo, ["rev-parse", "HEAD"]);
      expect(later).not.toBe(committed.sha);

      await expect(
        pushExactCommit(repo, committed.sha, "refs/heads/main", gitExec),
      ).resolves.toMatchObject({ success: true, pushed: true, branch: "main" });
      expect(await git(remote, ["rev-parse", "refs/heads/main"])).toBe(
        committed.sha,
      );
      expect(await git(repo, ["rev-parse", "refs/heads/main"])).toBe(later);
      expect(
        await git(repo, [
          "merge-base",
          "--is-ancestor",
          expected,
          committed.sha,
        ]),
      ).toBe("");
    } finally {
      cleanupPrivateIndex(privateIndex);
    }
  });

  test("an exact push timeout retains its typed classification", async () => {
    const run: GitRunner = async (args) => {
      if (
        args[0] === "rev-parse" &&
        args[1] === "--show-superproject-working-tree"
      ) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse" && args.includes("--git-dir")) {
        return { code: 0, stdout: "/repo/.git\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
        return { code: 0, stdout: "/repo/.git\n", stderr: "" };
      }
      if (
        args[0] === "rev-parse" &&
        args.some((arg) => arg.includes("@{upstream}"))
      ) {
        return { code: 0, stdout: "origin/main\n", stderr: "" };
      }
      if (args[0] === "push") {
        return {
          code: GIT_SPAWN_TIMEOUT_CODE,
          stdout: "",
          stderr: "push timed out",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    await expect(
      pushExactCommit(
        "/repo",
        "cccccccccccccccccccccccccccccccccccccccc",
        "refs/heads/main",
        run,
      ),
    ).resolves.toMatchObject({
      success: false,
      pushed: false,
      push_error_class: "timeout",
      push_error: "push timed out",
    });
  });

  test("remote success followed by tracking failure remains pushed with a warning", async () => {
    const seen: string[][] = [];
    const run: GitRunner = async (args) => {
      seen.push([...args]);
      if (
        args[0] === "rev-parse" &&
        args[1] === "--show-superproject-working-tree"
      ) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse" && args.includes("--git-dir")) {
        return { code: 0, stdout: "/repo/.git\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
        return { code: 0, stdout: "/repo/.git\n", stderr: "" };
      }
      if (
        args[0] === "rev-parse" &&
        args.some((arg) => arg.includes("@{upstream}"))
      ) {
        return { code: 128, stdout: "", stderr: "no upstream" };
      }
      if (args[0] === "push") {
        return { code: 0, stdout: "pushed\n", stderr: "" };
      }
      if (args[0] === "branch") {
        return { code: 1, stdout: "", stderr: "tracking setup failed" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    await expect(
      pushExactCommit(
        "/repo",
        "cccccccccccccccccccccccccccccccccccccccc",
        "refs/heads/main",
        run,
      ),
    ).resolves.toMatchObject({
      success: true,
      pushed: true,
      remote: "origin",
      branch: "main",
      tracking_warning_class: "tracking_setup_failed",
      tracking_warning: "tracking setup failed",
    });
    expect(seen.find((args) => args[0] === "push")).toContain(
      "cccccccccccccccccccccccccccccccccccccccc:refs/heads/main",
    );
    expect(
      seen.flat().some((arg) => arg === "HEAD" || arg.includes("@{u}")),
    ).toBe(false);
  });

  test("Task, Job-Id, and Keeper-Commit-Id remain one parseable trailer block", async () => {
    const { repo } = await repoWithBase();
    writeFileSync(join(repo, "selected.txt"), "trailer change\n");
    const fs = { commitMarker: () => "real-trailer" };
    const privateIndex = await createFrozenPrivateIndex(
      repo,
      ["selected.txt"],
      gitExec,
      fs,
    );
    try {
      const committed = await commitFrozenPrivateIndex(
        privateIndex,
        "feat: trailer block\n\nTask: fn-real.1",
        repo,
        gitExec,
        fs,
        { jobId: JOB_ID },
      );
      const body = await git(repo, [
        "show",
        "-s",
        "--format=%B",
        committed.sha,
      ]);
      const parsed = await git(repo, ["interpret-trailers", "--parse"], {
        stdin: new TextEncoder().encode(`${body}\n`),
      });
      expect(parsed.split("\n")).toEqual([
        "Task: fn-real.1",
        `Job-Id: ${JOB_ID}`,
        "Keeper-Commit-Id: keeper-commit-work:real-trailer",
      ]);
    } finally {
      cleanupPrivateIndex(privateIndex);
    }
  });
});
