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
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  GIT_OUTPUT_LIMIT_CODE,
  GIT_SPAWN_TIMEOUT_CODE,
  type GitExecOptions,
  type GitRunner,
  gitExec,
  spawnBoundedExec,
} from "../../src/commit-work/git-exec";
import {
  cleanupPrivateIndex,
  commitFrozenPrivateIndex,
  createFrozenPrivateIndex,
  type FrozenPrivateIndex,
  fingerprintIndexFileForTest,
  MAX_INDEX_FINGERPRINT_BYTES,
  type PrivateIndexError,
  reconcileAmbientIndexEntries,
} from "../../src/commit-work/private-index";
import { pushExactCommit } from "../../src/commit-work/push";
import { retryUntil } from "../helpers/retry-until";

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

test("commit-work rejects an actual FIFO input without waiting for a writer", async () => {
  const root = mkdtempSync(join(tmpdir(), "keeper-commit-work-fifo-"));
  roots.push(root);
  const fifo = join(root, "manifest.fifo");
  const made = Bun.spawnSync(["mkfifo", fifo]);
  expect(made.exitCode).toBe(0);

  const script = `
    import { runForTest } from "./cli/commit-work.ts";
    const result = await runForTest(["--preview-files", "--adopt-from", process.env.FIFO]);
    const envelope = JSON.parse(result.stdout);
    process.stdout.write(JSON.stringify({ code: result.code, outcome: envelope.outcome }));
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: join(import.meta.dir, "../.."),
    env: { ...process.env, FIFO: fifo },
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 2_000);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timer);

  expect(timedOut).toBe(false);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toEqual({
    code: 2,
    outcome: "argument_error",
  });
});

test("git-exec drains but fails closed on bounded output overflow", async () => {
  const { repo } = await repoWithBase({ "large.txt": "x".repeat(4_096) });
  const result = await gitExec(["show", "HEAD:large.txt"], {
    cwd: repo,
    maxStdoutBytes: 128,
  });
  expect(result.code).toBe(GIT_OUTPUT_LIMIT_CODE);
  expect(Buffer.byteLength(result.stdout)).toBe(128);
  expect(result.stderr).toContain("stdout output limit exceeded");
});

test("process timeout kills an escaped process-group descendant", async () => {
  const root = mkdtempSync(join(tmpdir(), "keeper-timeout-tree-"));
  roots.push(root);
  const marker = join(root, "escaped");
  const childScript =
    "await Bun.sleep(300); await Bun.write(process.env.MARKER, 'escaped')";
  const launcherScript = `
    Bun.spawn([process.execPath, "-e", ${JSON.stringify(childScript)}], {
      detached: true,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, MARKER: process.env.MARKER },
    });
  `;
  const script = `
    Bun.spawn([process.execPath, "-e", ${JSON.stringify(launcherScript)}], {
      detached: true,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, MARKER: process.env.MARKER },
    });
    await Bun.sleep(10_000);
  `;
  const started = performance.now();
  const result = await spawnBoundedExec([process.execPath, "-e", script], {
    timeoutMs: 50,
    env: { MARKER: marker },
  });
  expect(result.code).toBe(GIT_SPAWN_TIMEOUT_CODE);
  expect(performance.now() - started).toBeLessThan(1_000);

  const settleAt = Date.now() + 500;
  const containment = await retryUntil(
    () => {
      if (existsSync(marker)) return "escaped";
      return Date.now() >= settleAt ? "contained" : null;
    },
    700,
    20,
  );
  expect(containment).toBe("contained");
});

test("index fingerprinting rejects an oversized sparse file before reading it", () => {
  const root = mkdtempSync(join(tmpdir(), "keeper-index-bound-"));
  roots.push(root);
  const index = join(root, "index");
  writeFileSync(index, "index");
  truncateSync(index, MAX_INDEX_FINGERPRINT_BYTES + 1);
  expect(() => fingerprintIndexFileForTest(index)).toThrow(
    `index exceeds ${MAX_INDEX_FINGERPRINT_BYTES} fingerprint bytes`,
  );
});

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

  test("a clean filter cannot mutate another path before the baseline exists", async () => {
    const { root, repo, expected } = await repoWithBase({
      "selected.txt": "base\n",
      "other.txt": "other base\n",
      ".gitattributes": "selected.txt filter=keeper-test\n",
    });
    const filter = join(root, "mutating-clean-filter");
    writeFileSync(
      filter,
      `#!/bin/sh\nprintf 'filter mutation\\n' > ${shellQuote(join(repo, "other.txt"))}\ncat\n`,
      { mode: 0o755 },
    );
    await git(repo, ["config", "filter.keeper-test.clean", filter]);
    await git(repo, ["config", "filter.keeper-test.required", "true"]);
    writeFileSync(join(repo, "selected.txt"), "candidate\n");

    await expect(frozen(repo, ["selected.txt"])).rejects.toMatchObject({
      code: "surface_changed",
    });
    expect(readFileSync(join(repo, "other.txt"), "utf8")).toBe(
      "filter mutation\n",
    );
    expect(await git(repo, ["rev-parse", "refs/heads/main"])).toBe(expected);
  });
});

test("worktree snapshot rejects a path created between status enumerations", async () => {
  const { repo } = await repoWithBase({
    "selected.txt": "base\n",
    ".gitignore": "ignored.txt\n",
  });
  writeFileSync(join(repo, "selected.txt"), "candidate\n");
  let statuses = 0;
  const run: GitRunner = async (args, options) => {
    const result = await gitExec(args, options);
    if (args[0] === "status") {
      statuses += 1;
      if (statuses === 1) writeFileSync(join(repo, "ignored.txt"), "raced\n");
    }
    return result;
  };
  await expect(frozen(repo, ["selected.txt"], run)).rejects.toThrow(
    "worktree status changed while fingerprinted",
  );
});

test("an unborn SHA-1 branch publishes a parentless initial commit atomically", async () => {
  const root = mkdtempSync(join(tmpdir(), "keeper-initial-commit-"));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Keeper Test"]);
  await git(repo, ["config", "user.email", "keeper@example.test"]);
  await git(repo, ["config", "commit.gpgSign", "false"]);
  writeFileSync(join(repo, "selected.txt"), "initial\n");

  const privateIndex = await frozen(repo, ["selected.txt"]);
  try {
    const committed = await commitFrozenPrivateIndex(
      privateIndex,
      "feat: initial atomic commit",
      repo,
      gitExec,
    );
    expect(await git(repo, ["rev-parse", "refs/heads/main"])).toBe(
      committed.sha,
    );
    expect(await git(repo, ["show", "-s", "--format=%P", committed.sha])).toBe(
      "",
    );
  } finally {
    cleanupPrivateIndex(privateIndex);
  }
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

  test("an executable reference-transaction hook is refused before the CAS", async () => {
    const { repo, expected } = await repoWithBase();
    const marker = join(repo, "reference-hook-ran");
    installHook(
      repo,
      "reference-transaction",
      `printf ran > ${shellQuote(marker)}`,
    );
    writeFileSync(join(repo, "selected.txt"), "keeper change\n");
    const recording = recordingRunner();
    const privateIndex = await frozen(repo, ["selected.txt"], recording.run);
    try {
      await expect(
        commitFrozenPrivateIndex(
          privateIndex,
          "feat: reject uncontrolled ref hook",
          repo,
          recording.run,
        ),
      ).rejects.toMatchObject({ code: "commit_failed" });
      expect(await git(repo, ["rev-parse", "refs/heads/main"])).toBe(expected);
      expect(existsSync(marker)).toBe(false);
      expect(
        recording.calls.filter((call) => call.args[0] === "update-ref"),
      ).toHaveLength(0);
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

  test("a target-context switch aborts before any hook runs", async () => {
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
      expect(existsSync(observed)).toBe(false);
      expect(await git(repo, ["symbolic-ref", "--short", "HEAD"])).toBe(
        "other",
      );
      expect(await git(repo, ["rev-parse", "refs/heads/main"])).toBe(expected);
    } finally {
      cleanupPrivateIndex(privateIndex);
    }
  });

  test("a hook cannot disable later hooks or signing through Git config", async () => {
    const { root, repo, expected } = await repoWithBase();
    const later = join(root, "later-hook-ran");
    installHook(
      repo,
      "pre-commit",
      `git config core.hooksPath ${shellQuote(join(root, "empty-hooks"))}`,
    );
    installHook(repo, "prepare-commit-msg", `touch ${shellQuote(later)}`);
    writeFileSync(join(repo, "selected.txt"), "config mutation\n");
    const privateIndex = await frozen(repo, ["selected.txt"]);
    try {
      await expect(
        commitFrozenPrivateIndex(
          privateIndex,
          "test: config mutation",
          repo,
          gitExec,
        ),
      ).rejects.toMatchObject({ code: "commit_hook_mutated" });
      expect(existsSync(later)).toBe(false);
      expect(await git(repo, ["rev-parse", "refs/heads/main"])).toBe(expected);
    } finally {
      cleanupPrivateIndex(privateIndex);
    }
  });

  test("an earlier hook cannot replace post-commit before publication", async () => {
    const { repo, expected } = await repoWithBase();
    const postCommit = join(repo, ".git", "hooks", "post-commit");
    installHook(repo, "post-commit", ":");
    installHook(
      repo,
      "pre-commit",
      `printf '\\n# replaced\\n' >> ${shellQuote(postCommit)}`,
    );
    writeFileSync(join(repo, "selected.txt"), "hook replacement\n");
    const privateIndex = await frozen(repo, ["selected.txt"]);
    try {
      await expect(
        commitFrozenPrivateIndex(
          privateIndex,
          "test: hook replacement",
          repo,
          gitExec,
        ),
      ).rejects.toMatchObject({ code: "commit_hook_mutated" });
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

  test("a hook mutating the private split-index companion aborts before publication", async () => {
    const { repo, expected } = await repoWithBase();
    await git(repo, ["config", "core.splitIndex", "true"]);
    writeFileSync(join(repo, "selected.txt"), "split-index candidate\n");
    installHook(
      repo,
      "pre-commit",
      'shared=$(git rev-parse --path-format=absolute --shared-index-path)\nprintf x >> "$shared"',
    );
    const privateIndex = await frozen(repo, ["selected.txt"]);
    try {
      await expect(
        commitFrozenPrivateIndex(
          privateIndex,
          "test: reject split-index companion mutation",
          repo,
          gitExec,
        ),
      ).rejects.toMatchObject({
        code: "commit_hook_mutated",
        committed: false,
      });
      expect(await git(repo, ["rev-parse", "refs/heads/main"])).toBe(expected);
    } finally {
      cleanupPrivateIndex(privateIndex);
    }
  });

  test("a hook mutating the target split-index companion aborts before publication", async () => {
    const { repo, expected } = await repoWithBase();
    await git(repo, ["config", "core.splitIndex", "true"]);
    await git(repo, ["update-index", "--split-index"]);
    writeFileSync(join(repo, "selected.txt"), "target split-index candidate\n");
    installHook(
      repo,
      "pre-commit",
      "unset GIT_INDEX_FILE GIT_DIR GIT_COMMON_DIR GIT_WORK_TREE\n" +
        "shared=$(git rev-parse --path-format=absolute --shared-index-path)\n" +
        'test -n "$shared"\n' +
        'printf x >> "$shared"',
    );
    const privateIndex = await frozen(repo, ["selected.txt"]);
    try {
      await expect(
        commitFrozenPrivateIndex(
          privateIndex,
          "test: reject target split-index companion mutation",
          repo,
          gitExec,
        ),
      ).rejects.toMatchObject({
        code: "commit_hook_mutated",
        committed: false,
      });
      expect(await git(repo, ["rev-parse", "refs/heads/main"])).toBe(expected);
    } finally {
      cleanupPrivateIndex(privateIndex);
    }
  });

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

  test("a real commit-msg hook cannot continuation-spoof Task", async () => {
    const { repo, expected } = await repoWithBase();
    writeFileSync(join(repo, "selected.txt"), "continuation hook input\n");
    installHook(
      repo,
      "commit-msg",
      'awk \'{ print; if ($0 ~ /^Task:/) print " forged-continuation" }\' "$1" > "$1.next"\n' +
        'mv "$1.next" "$1"',
    );
    const privateIndex = await frozen(repo, ["selected.txt"]);
    try {
      await expect(
        commitFrozenPrivateIndex(
          privateIndex,
          "test: protect task continuation\n\nTask: fn-hook.1",
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

  test("a real commit-msg hook cannot inject session or plan authority", async () => {
    const { repo, expected } = await repoWithBase();
    writeFileSync(join(repo, "selected.txt"), "authority hook input\n");
    installHook(
      repo,
      "commit-msg",
      `printf '\\nSession-Id: ${JOB_ID}\\nPlanctl-Op: refine-apply\\nPlanctl-Target: fn-999-forged.1\\n' >> "$1"`,
    );
    const privateIndex = await frozen(repo, ["selected.txt"]);
    try {
      await expect(
        commitFrozenPrivateIndex(
          privateIndex,
          "test: reject authority injection\n\nTask: fn-hook.1",
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
    let signingEnv: Record<string, string> | undefined;
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
        signingEnv = options?.env;
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
      const configCount = Number(signingEnv?.GIT_CONFIG_COUNT ?? "0");
      const capturedConfig = new Map(
        Array.from({ length: configCount }, (_, index) => [
          signingEnv?.[`GIT_CONFIG_KEY_${index}`],
          signingEnv?.[`GIT_CONFIG_VALUE_${index}`],
        ]),
      );
      expect(capturedConfig.get("gpg.format")).toBe("openpgp");
      expect(capturedConfig.get("gpg.openpgp.program")).toBe("gpg");
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

  test("a signer cannot mutate an ignored worktree path", async () => {
    const { repo, expected } = await repoWithBase({
      "selected.txt": "base\n",
      ".gitignore": ".env\n",
    });
    writeFileSync(join(repo, "selected.txt"), "selected candidate\n");
    writeFileSync(join(repo, ".env"), "before\n");
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
        writeFileSync(join(repo, ".env"), "signer changed it\n");
        return result;
      }
      return gitExec(args, options);
    };
    const privateIndex = await frozen(repo, ["selected.txt"], run);
    try {
      await expect(
        commitFrozenPrivateIndex(
          privateIndex,
          "test: ignored signer mutation",
          repo,
          run,
        ),
      ).rejects.toMatchObject({
        code: "commit_hook_mutated",
        commitSha: expect.any(String),
        committed: false,
      });
      expect(unreachable).toMatch(/^[0-9a-f]{40,64}$/);
      expect(await git(repo, ["rev-parse", "refs/heads/main"])).toBe(expected);
    } finally {
      cleanupPrivateIndex(privateIndex);
    }
  });

  test("a signer changing raw private-index flags cannot publish", async () => {
    const { repo, expected } = await repoWithBase();
    writeFileSync(
      join(repo, "selected.txt"),
      "private index signer mutation\n",
    );
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
        const mutation = await gitExec(
          ["update-index", "--assume-unchanged", "--", "selected.txt"],
          { cwd: repo, env: options?.env },
        );
        expect(mutation.code).toBe(0);
        return result;
      }
      return gitExec(args, options);
    };
    const privateIndex = await frozen(repo, ["selected.txt"], run);
    try {
      await expect(
        commitFrozenPrivateIndex(
          privateIndex,
          "test: private index signer mutation",
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
      expect(
        await git(
          repo,
          ["--no-optional-locks", "ls-files", "-v", "--", "selected.txt"],
          { env: { GIT_INDEX_FILE: privateIndex.indexPath } },
        ),
      ).toBe("h selected.txt");
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

  test("post-commit executes the captured bytes across a fingerprint-to-exec swap", async () => {
    const { repo } = await repoWithBase();
    const originalMarker = join(repo, "post-original");
    const replacementMarker = join(repo, "post-replacement");
    installHook(
      repo,
      "post-commit",
      `printf original > ${shellQuote(originalMarker)}`,
    );
    writeFileSync(join(repo, "selected.txt"), "post hook candidate\n");
    let swapped = false;
    const run: GitRunner = async (args, options) => {
      if (!swapped && args[0] === "hook" && args.includes("post-commit")) {
        swapped = true;
        installHook(
          repo,
          "post-commit",
          `printf replacement > ${shellQuote(replacementMarker)}`,
        );
      }
      return gitExec(args, options);
    };
    const privateIndex = await frozen(repo, ["selected.txt"], run);
    try {
      await commitFrozenPrivateIndex(
        privateIndex,
        "test: captured post hook",
        repo,
        run,
      );
      expect(swapped).toBe(true);
      expect(existsSync(originalMarker)).toBe(true);
      expect(existsSync(replacementMarker)).toBe(false);
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
      pushed: null,
      indeterminate: true,
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
