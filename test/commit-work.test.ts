/**
 * Tests for `keeper commit-work` (epic fn-715 task 2), de-gitted for fn-904 `.3`:
 * ZERO real git, ZERO compiled-binary spawn, ZERO real linter. The verb's
 * `runForTest(argv, deps)` entry runs the FULL pipeline IN-PROCESS — file
 * discovery → gitignore filter → stage → stale-unstage → lint gate → commit →
 * push — against injected seams: a recording fake git runner returning canned
 * outputs / captured-from-real-git push stderr goldens, a fake attribution
 * discovery, a fake lint matrix, and a no-op flock. The byte-parity serializers
 * still run (output routes through the in-memory `writeOut` seam), so the one
 * compact versioned result envelope stays under test.
 *
 * The assertions are keeper's DECISIONS, not git's effect: the staged pathspec,
 * the committed message + Job-Id trailer, the push skip/classify, the
 * file_list_too_large / forbidden-trailer / no-session-id / lint_failed
 * envelopes, and the exact envelope bytes line-oriented consumers parse.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  constants,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOUNDED_INPUT_OPEN_FLAGS,
  type CommitWorkDeps,
  runForTest as runCommitWorkForTest,
  taskBoundToIdentity,
  trustedCommitWorkAuthority,
  trustedCommitWorkIdentity,
} from "../cli/commit-work";
import { GIT_SPAWN_TIMEOUT_CODE } from "../src/commit-work/git-exec";
import { LintFailure } from "../src/commit-work/lint-matrix";
import { MAX_COMMIT_MESSAGE_BYTES } from "../src/commit-work/private-index";
import {
  describePushNotReady,
  inLinkedWorktree,
  pushCommitted,
  remotePushTurnKey,
} from "../src/commit-work/push";
import {
  detectInProgressOperation,
  isReversionExcluded,
  sharedCheckoutJamActive,
} from "../src/commit-work/repo-state";
import {
  SHARED_DESYNC_DISTRESS_ID_PREFIX,
  SHARED_DIRTY_DISTRESS_ID_PREFIX,
  SHARED_DIRTY_DISTRESS_VERB,
} from "../src/dispatch-failure-key";
import { PUSH_NON_FAST_FORWARD } from "./fixtures/git-push-goldens";
import {
  argvStartsWith,
  type FakeGitRule,
  fakeAsyncGit,
} from "./helpers/fake-git.ts";
import { freshDbFile } from "./helpers/template-db.ts";

// Every pipeline fixture supplies `deps.env`, so identity tests never mutate or
// depend on the process-wide harness environment.
const TEST_ID = "11111111-1111-4111-8111-111111111111";
const FAKE_COMMIT = "abcdef0123456789abcdef0123456789abcdef01";
const FAKE_PARENT = "1111111111111111111111111111111111111111";
const FAKE_BASE_TREE = "2222222222222222222222222222222222222222";
const FAKE_TREE = "3333333333333333333333333333333333333333";

/** Keep the broad legacy scenarios readable while exercising UUID-only input. */
function runForTest(argv: string[], deps: CommitWorkDeps = {}) {
  return runCommitWorkForTest(
    argv.map((arg) => (arg === "s1" ? TEST_ID : arg)),
    {
      validateIdentity: () => true,
      validateTaskBinding: () => true,
      ...deps,
    },
  );
}

/**
 * The standard git rule set for a clean repo with `n` staged files. Models every
 * git call the success pipeline makes: git-dir (per-worktree lock + the push
 * skip-gate's git-dir/common-dir pair, equal here → main worktree), add,
 * staged-name read,
 * interpret-trailers (echoes stdin, optionally with a Job-Id trailer appended),
 * commit, short-sha, the @{u} probe + push. `stagedNames` is what `diff
 * --cached --name-only -z` reports back (the intersection that forms the commit
 * `files` list). `pushOutcome` overrides the default success push.
 */
function successRules(opts: {
  stagedNames: string[];
  jobId?: string;
  upstream?: "set" | "none";
  pushOutcome?: { exitCode: number; stdout?: string; stderr?: string };
}): FakeGitRule[] {
  const { stagedNames, jobId, upstream = "set", pushOutcome } = opts;
  const rules: FakeGitRule[] = [
    {
      when: (a) => argvStartsWith(a, "check-ignore"),
      result: { exitCode: 1, stdout: "" }, // none ignored
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
      when: (a) => argvStartsWith(a, "add", "-A", "--"),
      result: { exitCode: 0 },
    },
    {
      when: (a) => argvStartsWith(a, "diff", "--cached", "--name-only", "-z"),
      result: { exitCode: 0, stdout: stagedNames.join("\0") },
    },
    {
      when: (a) => argvStartsWith(a, "reset", "HEAD", "--"),
      result: { exitCode: 0 },
    },
    {
      when: (a) => a.includes("interpret-trailers"),
      // The trailer arm is matched against the recorded stdin separately; the
      // runner echoes stdin in the test wrapper below, so this rule is a no-op
      // fallback (overridden by the wrapper for the Job-Id append).
      result: { exitCode: 0, stdout: "" },
    },
    {
      when: (a) => argvStartsWith(a, "commit-tree"),
      result: { exitCode: 0, stdout: `${FAKE_COMMIT}\n` },
    },
    {
      when: (a) => argvStartsWith(a, "rev-parse", "--short", "HEAD"),
      result: { exitCode: 0, stdout: `${FAKE_COMMIT}\n` },
    },
    {
      when: (a) => argvStartsWith(a, "rev-parse", "--abbrev-ref", "HEAD"),
      result: { exitCode: 0, stdout: "main\n" },
    },
  ];
  // @{u} probe: exit 128 → no upstream (first push sets it); exit 0 → configured.
  rules.push({
    when: (a) => a.some((arg) => arg === "@{u}" || arg.endsWith("@{upstream}")),
    result:
      upstream === "none"
        ? { exitCode: 128 }
        : { exitCode: 0, stdout: "origin/main\n" },
  });
  rules.push({
    when: (a) => argvStartsWith(a, "push"),
    result: pushOutcome ?? { exitCode: 0 },
  });
  void jobId;
  return rules;
}

/** Build deps from rules + a discovered file set while modeling the exact
 * private-index, detached-admin, CAS-publish pipeline. */
function deps(opts: {
  files: string[];
  rules: FakeGitRule[];
  absentFiles?: string[];
  privateStagedNames?: string[];
  runLint?: (files: string[], cwd: string) => Promise<void>;
  detectInProgress?: CommitWorkDeps["detectInProgress"];
  checkSharedCheckoutJam?: CommitWorkDeps["checkSharedCheckoutJam"];
  fingerprintIndex?: (path: string) => string;
}): { d: CommitWorkDeps; calls: ReturnType<typeof fakeAsyncGit>["calls"] } {
  const fake = fakeAsyncGit(opts.rules);
  const baseRun = fake.run;
  let privateUpdated = false;
  let published = false;
  const selected = [...opts.files].sort();
  const run: typeof baseRun = async (args, options) => {
    if (
      argvStartsWith(args, "diff", "--cached", "--name-only", "-z") &&
      options?.env?.GIT_INDEX_FILE
    ) {
      await baseRun(args, options);
      return {
        code: 0,
        stdout: (opts.privateStagedNames ?? selected).join("\0"),
        stderr: "",
      };
    }
    if (args[0] === "interpret-trailers") {
      const base = await baseRun(args, options);
      if (base.code !== 0) return base;
      const msg = options?.stdin ? new TextDecoder().decode(options.stdin) : "";
      const trailers = args
        .flatMap((arg, index) => (arg === "--trailer" ? [args[index + 1]] : []))
        .filter((value): value is string => value !== undefined);
      const input = msg.trimEnd();
      const separator =
        /\n\n[A-Za-z0-9-]+:[^\n]*(?:\n[A-Za-z0-9-]+:[^\n]*)*$/.test(input)
          ? "\n"
          : "\n\n";
      return {
        code: 0,
        stdout: `${input}${separator}${trailers.join("\n")}\n`,
        stderr: "",
      };
    }
    if (argvStartsWith(args, "rev-parse", "--show-toplevel")) {
      await baseRun(args, options);
      return { code: 0, stdout: "/repo\n", stderr: "" };
    }
    if (args[0] === "status") {
      await baseRun(args, options);
      const ignored = await baseRun(["check-ignore", "-z", "--stdin"], {
        cwd: options?.cwd,
        stdin: new TextEncoder().encode(`${opts.files.join("\0")}\0`),
      });
      const ignoredSet = new Set(ignored.stdout.split("\0").filter(Boolean));
      const dirty = opts.files.filter((path) => !ignoredSet.has(path));
      return {
        code: 0,
        stdout: `${dirty.map((path) => `? ${path}`).join("\0")}\0`,
        stderr: "",
      };
    }
    if (args[0] === "symbolic-ref" && args[1] === "-q") {
      await baseRun(args, options);
      return { code: 0, stdout: "refs/heads/main\n", stderr: "" };
    }
    if (
      args[0] === "rev-parse" &&
      args[1] === "--verify" &&
      args[2] === "refs/heads/main^{commit}"
    ) {
      await baseRun(args, options);
      return {
        code: 0,
        stdout: published ? `${FAKE_COMMIT}\n` : `${FAKE_PARENT}\n`,
        stderr: "",
      };
    }
    if (
      args[0] === "rev-parse" &&
      args[1] === "--verify" &&
      args[2] === "HEAD^{commit}"
    ) {
      await baseRun(args, options);
      return { code: 0, stdout: `${FAKE_COMMIT}\n`, stderr: "" };
    }
    if (args[0] === "read-tree") {
      return baseRun(args, options);
    }
    if (args[0] === "ls-tree") {
      const base = await baseRun(args, options);
      return base.stdout || base.code !== 0
        ? base
        : { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "hash-object") {
      const base = await baseRun(args, options);
      if (base.code !== 0 || base.stdout) return base;
      const path = args.at(-1) ?? "";
      const index = Math.max(0, selected.indexOf(path));
      return {
        code: 0,
        stdout: `${(index + 1).toString(16).padStart(40, "0")}\n`,
        stderr: "",
      };
    }
    if (args[0] === "config" && args.includes("core.filemode")) {
      await baseRun(args, options);
      return { code: 0, stdout: "true\n", stderr: "" };
    }
    if (args[0] === "update-index") {
      const base = await baseRun(args, options);
      if (base.code === 0 && options?.env?.GIT_INDEX_FILE) {
        privateUpdated = true;
      }
      return base;
    }
    if (args[0] === "ls-files" && options?.env?.GIT_INDEX_FILE) {
      const base = await baseRun(args, options);
      if (base.code !== 0 || base.stdout) return base;
      return {
        code: 0,
        stdout: `${selected
          .map((path, index) => `100644 blob${index} 0\t${path}\0`)
          .join("")}`,
        stderr: "",
      };
    }
    if (args[0] === "write-tree" && options?.env?.GIT_INDEX_FILE) {
      const base = await baseRun(args, options);
      if (base.code !== 0) return base;
      return {
        code: 0,
        stdout: `${privateUpdated ? FAKE_TREE : FAKE_BASE_TREE}\n`,
        stderr: "",
      };
    }
    if (args[0] === "worktree" && args[1] === "add") {
      return baseRun(args, options);
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
      await baseRun(args, options);
      return {
        code: 0,
        stdout: "/repo/.git/worktrees/admin-worktree\n",
        stderr: "",
      };
    }
    if (args[0] === "commit" && options?.env?.GIT_INDEX_FILE) {
      return baseRun(args, options);
    }
    if (args[0] === "cat-file" && args[1] === "commit") {
      await baseRun(args, options);
      return {
        code: 0,
        stdout:
          `tree ${FAKE_TREE}\nparent ${FAKE_PARENT}\nauthor Test <t@example.com> 1 +0000\n` +
          "committer Test <t@example.com> 1 +0000\n\nmessage\n",
        stderr: "",
      };
    }
    if (args[0] === "update-ref") {
      const base = await baseRun(args, options);
      if (base.code === 0) published = true;
      return base;
    }
    return baseRun(args, options);
  };
  const absent = new Set(opts.absentFiles ?? []);
  const d: CommitWorkDeps = {
    env: {},
    cwd: "/repo",
    gitRunner: run,
    directEvidence: () => ({
      currentSessionPaths: opts.files,
      complete: true,
    }),
    readClaims: () => [],
    runLint: opts.runLint ?? (async () => {}),
    acquireLock: () => ({ release: () => {} }),
    privateIndexFs: {
      makeTempDir: () => "/tmp/keeper-commit-work-broad-test",
      removeTempDir: () => {},
      commitMarker: () => "broad-test",
      inspectPath: (absolutePath) => ({
        kind: [...absent].some((path) => absolutePath.endsWith(`/${path}`))
          ? "absent"
          : "file",
        executable: false,
      }),
      fingerprintIndex: opts.fingerprintIndex ?? (() => "stable-private-index"),
      targetIndexPath: () => "/repo/.git/index",
    },
    detectInProgress: opts.detectInProgress ?? (async () => null),
    checkSharedCheckoutJam: opts.checkSharedCheckoutJam ?? (() => false),
  };
  return { d, calls: fake.calls };
}

// ---------------------------------------------------------------------------
// session id
// ---------------------------------------------------------------------------

describe("commit-work: session id", () => {
  test("fails (exit 1) with a compact envelope when no session id resolves", async () => {
    const { d } = deps({ files: [], rules: [] });
    const { code, stdout } = await runForTest(["--preview-files"], d);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("no_session_id");
    expect(parsed.hint).toContain("git");
    // Compact single line (no pretty indentation).
    expect(stdout).not.toContain("\n  ");
  });

  test("default authority binds Claude and Pi identities to exact process ancestry", async () => {
    const root = mkdtempSync(join(tmpdir(), "keeper-commit-authority-"));
    const path = join(root, "keeper.db");
    const { db } = freshDbFile(path);
    const sibling = "44444444-4444-4444-8444-444444444444";
    const legacy = "55555555-5555-4555-8555-555555555555";
    const processOptions = {
      currentPid: 9000,
      read: (pid: number) => {
        if (pid === 9000) return { ppid: 8000, startTime: "linux:900" };
        if (pid === 8000) return { ppid: 4242, startTime: "linux:800" };
        if (pid === 4242) return { ppid: 1, startTime: "linux:100" };
        return null;
      },
    };
    try {
      db.run(
        `INSERT INTO jobs
           (job_id, created_at, state, updated_at, harness, plan_verb, plan_ref,
            pid, start_time)
         VALUES (?, 1, 'working', 1, 'claude', 'work', 'fn-1-task.1', 4242, 'linux:100'),
                (?, 1, 'working', 1, 'pi', 'work', 'fn-1-task.1', 4242, 'linux:100'),
                (?, 1, 'stopped', 1, 'claude', 'work', 'fn-1-task.1', 4242, 'linux:100'),
                (?, 1, 'working', 1, 'claude', 'work', 'fn-1-task.1', 5252, 'linux:200'),
                (?, 1, 'working', 1, NULL, 'work', 'fn-1-task.1', 4242, 'linux:100')`,
        [
          TEST_ID,
          "22222222-2222-4222-8222-222222222222",
          "33333333-3333-4333-8333-333333333333",
          sibling,
          legacy,
        ],
      );
      expect(
        await trustedCommitWorkIdentity(TEST_ID, path, processOptions),
      ).toBe(true);
      expect(taskBoundToIdentity(TEST_ID, "fn-1-task.1", path)).toBe(true);
      expect(taskBoundToIdentity(TEST_ID, "fn-1-other.1", path)).toBe(false);
      expect(
        await trustedCommitWorkIdentity(
          "22222222-2222-4222-8222-222222222222",
          path,
          processOptions,
        ),
      ).toBe(true);
      expect(
        taskBoundToIdentity(
          "22222222-2222-4222-8222-222222222222",
          "fn-1-task.1",
          path,
        ),
      ).toBe(true);
      expect(
        await trustedCommitWorkAuthority(
          "22222222-2222-4222-8222-222222222222",
          "fn-1-other.9",
          path,
          processOptions,
        ),
      ).toBe("task_unbound");
      expect(
        await trustedCommitWorkIdentity(
          "33333333-3333-4333-8333-333333333333",
          path,
          processOptions,
        ),
      ).toBe(false);
      // A live Claude sibling cannot borrow its UUID: its pid is not an ancestor.
      expect(
        await trustedCommitWorkIdentity(sibling, path, processOptions),
      ).toBe(false);
      // Pre-harness rows are not sufficient evidence for the Claude-only verb.
      expect(
        await trustedCommitWorkIdentity(legacy, path, processOptions),
      ).toBe(false);
      expect(taskBoundToIdentity(legacy, "fn-1-task.1", path)).toBe(false);

      let rebound = false;
      expect(
        await trustedCommitWorkAuthority(TEST_ID, "fn-1-task.1", path, {
          currentPid: 9000,
          read: (pid) => {
            if (pid === 8000 && !rebound) {
              db.run(
                "UPDATE jobs SET plan_ref = 'fn-1-other.2' WHERE job_id = ?",
                [TEST_ID],
              );
              rebound = true;
            }
            return processOptions.read(pid);
          },
        }),
      ).toBe("identity_untrusted");
      expect(rebound).toBe(true);
      db.run("UPDATE jobs SET plan_ref = 'fn-1-task.1' WHERE job_id = ?", [
        TEST_ID,
      ]);

      let harnessSwapped = false;
      expect(
        await trustedCommitWorkIdentity(TEST_ID, path, {
          currentPid: 9000,
          read: (pid) => {
            if (pid === 8000 && !harnessSwapped) {
              db.run("UPDATE jobs SET harness = 'pi' WHERE job_id = ?", [
                TEST_ID,
              ]);
              harnessSwapped = true;
            }
            return processOptions.read(pid);
          },
        }),
      ).toBe(false);
      expect(harnessSwapped).toBe(true);
      db.run("UPDATE jobs SET harness = 'claude' WHERE job_id = ?", [TEST_ID]);

      let revoked = false;
      expect(
        await trustedCommitWorkIdentity(TEST_ID, path, {
          currentPid: 9000,
          read: (pid) => {
            if (pid === 8000 && !revoked) {
              db.run("UPDATE jobs SET state = 'stopped' WHERE job_id = ?", [
                TEST_ID,
              ]);
              revoked = true;
            }
            return processOptions.read(pid);
          },
        }),
      ).toBe(false);
      expect(revoked).toBe(true);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects an identity not bound to an active supported job", async () => {
    const { d } = deps({ files: [], rules: [] });
    const { code, stdout } = await runForTest(
      ["--preview-files", "--session-id", "s1"],
      { ...d, validateIdentity: () => false },
    );
    expect(code).toBe(1);
    expect(JSON.parse(stdout).outcome).toBe("identity_untrusted");
  });

  test("rejects a Task id not bound to this work session", async () => {
    const { d } = deps({ files: [], rules: [] });
    const { code, stdout } = await runForTest(
      ["--preview-files", "--session-id", "s1", "--task-id", "fn-1-task.1"],
      { ...d, validateTaskBinding: () => false },
    );
    expect(code).toBe(1);
    expect(JSON.parse(stdout).outcome).toBe("task_unbound");
  });
});

// ---------------------------------------------------------------------------
// --preview-files
// ---------------------------------------------------------------------------

describe("commit-work: --preview-files", () => {
  test("lists session-attributed files, gitignore-filtered, with no commit", async () => {
    // discovery returns three; check-ignore drops the *.log.
    const rules: FakeGitRule[] = [
      {
        when: (a) => argvStartsWith(a, "check-ignore"),
        result: { exitCode: 0, stdout: "ignored.log\0" },
      },
    ];
    const { d, calls } = deps({
      files: ["a.txt", "b.txt", "ignored.log"],
      rules,
    });
    const { code, stdout } = await runForTest(
      ["--preview-files", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      schema_version: 1,
      kind: "commit-work-result",
      outcome: "preview",
      success: true,
      files: ["a.txt", "b.txt"],
    });
    expect(stdout.trimEnd()).not.toContain("\n");
    // No commit issued in preview mode.
    expect(calls.some((c) => argvStartsWith(c.args, "commit"))).toBe(false);
  });

  test("file_list_too_large guard trips on the post-filter count", async () => {
    const { d } = deps({
      files: ["f0.txt", "f1.txt", "f2.txt", "f3.txt", "f4.txt"],
      rules: [
        {
          when: (a) => argvStartsWith(a, "check-ignore"),
          result: { exitCode: 1 },
        },
      ],
    });
    const { code, stdout } = await runForTest(
      ["--preview-files", "--session-id", "s1", "--max-files", "2"],
      d,
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.error).toBe("file_list_too_large");
    expect(parsed.count).toBe(5);
    expect(parsed.limit).toBe(2);
    expect(parsed.sample).toEqual([
      "f0.txt",
      "f1.txt",
      "f2.txt",
      "f3.txt",
      "f4.txt",
    ]);
  });

  test("--max-files 0 disables the guard", async () => {
    const { d } = deps({
      files: ["g0.txt", "g1.txt", "g2.txt"],
      rules: [
        {
          when: (a) => argvStartsWith(a, "check-ignore"),
          result: { exitCode: 1 },
        },
      ],
    });
    const { code, stdout } = await runForTest(
      ["--preview-files", "--session-id", "s1", "--max-files", "0"],
      d,
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout).files.length).toBe(3);
  });

  test("--max-files 0 keeps the result envelope bounded", async () => {
    const files = Array.from(
      { length: 600 },
      (_, i) => `f${i}-${"x".repeat(1_990)}`,
    );
    const { d } = deps({
      files,
      rules: [
        {
          when: (a) => argvStartsWith(a, "check-ignore"),
          result: { exitCode: 1 },
        },
      ],
    });
    const { code, stdout } = await runForTest(
      ["--preview-files", "--session-id", "s1", "--max-files", "0"],
      d,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as {
      files: string[];
      file_total: number;
      files_truncated: boolean;
    };
    expect(parsed.file_total).toBe(600);
    expect(parsed.files).toHaveLength(500);
    expect(parsed.files_truncated).toBe(true);
    expect(parsed.files.every((path) => path.length <= 1_024)).toBe(true);
    expect(Buffer.byteLength(stdout)).toBeLessThan(750_000);
  });
});

// ---------------------------------------------------------------------------
// message validation
// ---------------------------------------------------------------------------

describe("commit-work: message validation", () => {
  test("requires a message when not previewing", async () => {
    const { d } = deps({
      files: ["a.txt"],
      rules: [
        {
          when: (a) => argvStartsWith(a, "check-ignore"),
          result: { exitCode: 1 },
        },
      ],
    });
    const { code, stdout } = await runForTest(["--session-id", "s1"], d);
    expect(code).toBe(1);
    expect(JSON.parse(stdout).outcome).toBe("message_required");
  });

  test("rejects an oversized positional message before discovery", async () => {
    const { code, stdout } = await runForTest([
      "x".repeat(MAX_COMMIT_MESSAGE_BYTES + 1),
      "--session-id",
      "s1",
    ]);
    expect(code).toBe(2);
    expect(JSON.parse(stdout).outcome).toBe("argument_error");
  });

  test("rejects a multi-line message carrying a forbidden trailer", async () => {
    const { d } = deps({
      files: ["a.txt"],
      rules: [
        {
          when: (a) => argvStartsWith(a, "check-ignore"),
          result: { exitCode: 1 },
        },
      ],
    });
    const { code, stdout } = await runForTest(
      ["test: subject\n\nSigned-off-by: x", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(1);
    expect(JSON.parse(stdout).outcome).toBe("forbidden_trailer");
  });

  test("forbidden trailer keys are rejected even as a single-line subject", async () => {
    for (const message of [
      "Job-Id: not-really",
      "Keeper-Commit-Id: user-forged",
    ]) {
      const { d } = deps({
        files: ["a.txt"],
        rules: successRules({ stagedNames: ["a.txt"] }),
      });
      const { code, stdout } = await runForTest(
        [message, "--session-id", "s1"],
        d,
      );
      expect(code).toBe(1);
      expect(JSON.parse(stdout).outcome).toBe("forbidden_trailer");
    }
  });

  test("caller-supplied Task trailers are always rejected", async () => {
    const { d } = deps({ files: ["a.txt"], rules: [] });
    const { code, stdout } = await runForTest(
      ["feat: forged\n\nTask: fn-1-forged.1", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(1);
    expect(JSON.parse(stdout).outcome).toBe("forbidden_trailer");
  });

  test("--task-id validates and appends exactly one trusted Task trailer", async () => {
    const taskId = "fn-1-task.2";
    const { d, calls } = deps({
      files: ["a.txt"],
      rules: successRules({ stagedNames: ["a.txt"] }),
    });
    const landed = await runForTest(
      ["feat: wrapped", "--session-id", "s1", "--task-id", taskId],
      d,
    );
    expect(landed.code).toBe(0);
    const trailers = calls.find((call) =>
      argvStartsWith(call.args, "interpret-trailers"),
    );
    const message =
      typeof trailers?.stdin === "string"
        ? trailers.stdin
        : new TextDecoder().decode(trailers?.stdin);
    expect(message.match(/^Task:/gm)).toEqual(["Task:"]);
    expect(message).toContain(`Task: ${taskId}`);

    const forged = await runForTest(
      [
        "feat: wrapped\n\nTask: fn-999-forged.1",
        "--session-id",
        "s1",
        "--task-id",
        taskId,
      ],
      d,
    );
    expect(forged.code).toBe(1);
    expect(JSON.parse(forged.stdout).outcome).toBe("forbidden_trailer");

    const invalid = await runForTest([
      "--preview-files",
      "--task-id",
      "not-a-task",
    ]);
    expect(invalid.code).toBe(2);
    expect(JSON.parse(invalid.stdout).outcome).toBe("argument_error");
  });
});

// ---------------------------------------------------------------------------
// empty file set
// ---------------------------------------------------------------------------

describe("commit-work: empty file set", () => {
  test("emits committed:false when nothing is on the hook", async () => {
    const { d } = deps({
      files: [],
      rules: [
        {
          when: (a) => argvStartsWith(a, "check-ignore"),
          result: { exitCode: 1 },
        },
      ],
    });
    const { code, stdout } = await runForTest(
      ["test: nothing", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      schema_version: 1,
      outcome: "nothing_to_commit",
      success: true,
      committed: false,
      files: [],
    });
    expect(stdout.trimEnd()).not.toContain("\n");
  });
});

// ---------------------------------------------------------------------------
// success path — one compact versioned envelope
// ---------------------------------------------------------------------------

describe("commit-work: success path", () => {
  test("one compact envelope carries commit + push; both operations issue", async () => {
    const { d, calls } = deps({
      files: ["a.txt", "b.txt"],
      rules: successRules({ stagedNames: ["a.txt", "b.txt"] }),
    });
    const { code, stdout } = await runForTest(
      ["feat: add files", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(0);

    const lines = stdout.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(1);

    const envelope = JSON.parse(lines[0]);
    expect(envelope).toMatchObject({
      schema_version: 1,
      success: true,
      commit_sha: FAKE_COMMIT,
      files: ["a.txt", "b.txt"],
      pushed: true,
      remote: "origin",
      branch: "main",
    });
    expect(lines[0]).not.toMatch(/^\s/);

    // Decisions: populated only the two exact private-index entries, then committed.
    const exact = calls.find(
      (c) => c.args[0] === "update-index" && c.env?.GIT_INDEX_FILE,
    );
    expect(exact?.args).toEqual(["update-index", "-z", "--index-info"]);
    expect(exact?.stdin).toContain("\ta.txt\0");
    expect(exact?.stdin).toContain("\tb.txt\0");
    expect(calls.some((c) => c.args[0] === "add")).toBe(false);
    expect(calls.some((c) => argvStartsWith(c.args, "commit-tree"))).toBe(true);
    expect(calls.some((c) => argvStartsWith(c.args, "push"))).toBe(true);
  });

  test("revoked authority after the final ownership scan blocks publication", async () => {
    const { d, calls } = deps({
      files: ["a.txt"],
      rules: successRules({ stagedNames: ["a.txt"] }),
    });
    let validations = 0;
    const result = await runForTest(
      ["feat: bounded authority", "--session-id", "s1"],
      {
        ...d,
        validateIdentity: () => {
          validations += 1;
          return validations < 3;
        },
      },
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).outcome).toBe("identity_untrusted");
    expect(validations).toBe(3);
    expect(calls.some((call) => call.args[0] === "update-ref")).toBe(false);
  });

  test("appends the Job-Id trailer from explicit --session-id", async () => {
    const { d, calls } = deps({
      files: ["a.txt"],
      rules: successRules({ stagedNames: ["a.txt"] }),
    });
    const { code } = await runForTest(
      ["feat: trailer", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(0);
    const trailers = calls.find((c) =>
      argvStartsWith(c.args, "interpret-trailers"),
    );
    expect(trailers?.args).toContain(`Job-Id: ${TEST_ID}`);
  });

  test("exact adoption still requires an invocation identity", async () => {
    const { d, calls } = deps({
      files: ["a.txt"],
      rules: successRules({ stagedNames: ["a.txt"] }),
    });
    const { code, stdout } = await runForTest(
      ["feat: no identity", "--adopt", "a.txt"],
      d,
    );
    expect(code).toBe(1);
    expect(JSON.parse(stdout).outcome).toBe("no_session_id");
    expect(calls).toHaveLength(0);
  });
});

describe("commit-work: adoption manifests", () => {
  test("opens untrusted input paths nonblocking before descriptor validation", () => {
    expect(BOUNDED_INPUT_OPEN_FLAGS & constants.O_RDONLY).toBe(
      constants.O_RDONLY,
    );
    expect(BOUNDED_INPUT_OPEN_FLAGS & constants.O_NONBLOCK).toBe(
      constants.O_NONBLOCK,
    );
  });

  test("adopts exact JSON paths without shell interpolation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-adopt-manifest-"));
    try {
      const manifest = join(dir, "paths.json");
      writeFileSync(
        manifest,
        JSON.stringify({
          schema_version: 1,
          kind: "commit-work-adoption",
          paths: ["generated file.ts"],
        }),
      );
      const { d } = deps({
        files: ["generated file.ts"],
        rules: successRules({ stagedNames: ["generated file.ts"] }),
      });
      d.directEvidence = () => ({ complete: true });
      const { code, stdout } = await runForTest(
        [
          "feat: adopt manifest",
          "--session-id",
          "s1",
          "--adopt-from",
          manifest,
        ],
        d,
      );
      expect(code).toBe(0);
      const envelope = JSON.parse(stdout) as {
        selection: { adopted_total: number; adopted_sample: string[] };
      };
      expect(envelope.selection.adopted_total).toBe(1);
      expect(envelope.selection.adopted_sample).toEqual(["generated file.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reads a commit message file as inert data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-message-file-"));
    try {
      const messageFile = join(dir, "message.txt");
      const message = "feat: keep $(touch nope) and 'quotes' literal\n";
      writeFileSync(messageFile, message);
      const { d, calls } = deps({
        files: ["a.txt"],
        rules: successRules({ stagedNames: ["a.txt"] }),
      });
      const { code } = await runForTest(
        ["--message-file", messageFile, "--session-id", "s1"],
        d,
      );
      expect(code).toBe(0);
      const trailers = calls.find((call) =>
        argvStartsWith(call.args, "interpret-trailers"),
      );
      const renderedMessage =
        typeof trailers?.stdin === "string"
          ? trailers.stdin
          : new TextDecoder().decode(trailers?.stdin);
      expect(renderedMessage).toContain(
        "feat: keep $(touch nope) and 'quotes' literal",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects an unversioned manifest as an argument error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-adopt-manifest-"));
    try {
      const manifest = join(dir, "paths.json");
      writeFileSync(manifest, JSON.stringify(["a.ts"]));
      const { code, stdout } = await runForTest([
        "--preview-files",
        "--adopt-from",
        manifest,
      ]);
      expect(code).toBe(2);
      expect(JSON.parse(stdout).outcome).toBe("argument_error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects manifest path counts before spreading an attacker-sized array", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-adopt-count-"));
    try {
      const manifest = join(dir, "paths.json");
      writeFileSync(
        manifest,
        JSON.stringify({
          schema_version: 1,
          kind: "commit-work-adoption",
          paths: Array.from({ length: 10_001 }, (_, i) => `p${i}`),
        }),
      );
      const { code, stdout } = await runForTest([
        "--preview-files",
        "--adopt-from",
        manifest,
      ]);
      expect(code).toBe(2);
      expect(JSON.parse(stdout).outcome).toBe("argument_error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("caps cumulative manifest bytes and manifest-file count", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-adopt-total-"));
    try {
      const paths = Array.from(
        { length: 4_500 },
        (_, i) => `${String(i).padStart(4, "0")}-${"x".repeat(110)}.ts`,
      );
      const first = join(dir, "first.json");
      const second = join(dir, "second.json");
      const body = JSON.stringify({
        schema_version: 1,
        kind: "commit-work-adoption",
        paths,
      });
      expect(Buffer.byteLength(body)).toBeLessThan(1_048_576);
      expect(Buffer.byteLength(body) * 2).toBeGreaterThan(1_048_576);
      writeFileSync(first, body);
      writeFileSync(second, body);
      const cumulative = await runForTest([
        "--preview-files",
        "--adopt-from",
        first,
        "--adopt-from",
        second,
      ]);
      expect(cumulative.code).toBe(2);
      expect(JSON.parse(cumulative.stdout).outcome).toBe("argument_error");

      const tinyFiles: string[] = [];
      for (let i = 0; i < 33; i++) {
        const path = join(dir, `tiny-${i}.json`);
        writeFileSync(
          path,
          JSON.stringify({
            schema_version: 1,
            kind: "commit-work-adoption",
            paths: [],
          }),
        );
        tinyFiles.push(path);
      }
      const argv = ["--preview-files"];
      for (const path of tinyFiles) argv.push("--adopt-from", path);
      const tooMany = await runForTest(argv);
      expect(tooMany.code).toBe(2);
      expect(JSON.parse(tooMany.stdout).outcome).toBe("argument_error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts the exact manifest byte cap and rejects NUL or non-regular inputs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-adopt-boundary-"));
    try {
      const manifest = join(dir, "boundary.json");
      const body = JSON.stringify({
        schema_version: 1,
        kind: "commit-work-adoption",
        paths: ["a.ts"],
      });
      writeFileSync(manifest, body + " ".repeat(1_048_576 - body.length));
      const { d } = deps({
        files: ["a.ts"],
        rules: successRules({ stagedNames: ["a.ts"] }),
      });
      d.directEvidence = () => ({ complete: true });
      const boundary = await runForTest(
        ["--preview-files", "--session-id", "s1", "--adopt-from", manifest],
        d,
      );
      expect(boundary.code).toBe(0);

      const nulManifest = join(dir, "nul.json");
      writeFileSync(
        nulManifest,
        JSON.stringify({
          schema_version: 1,
          kind: "commit-work-adoption",
          paths: ["bad\0path"],
        }),
      );
      const nulPath = await runForTest([
        "--preview-files",
        "--adopt-from",
        nulManifest,
      ]);
      expect(nulPath.code).toBe(2);
      expect(JSON.parse(nulPath.stdout).outcome).toBe("argument_error");

      const nonRegular = await runForTest([
        "--preview-files",
        "--adopt-from",
        dir,
      ]);
      expect(nonRegular.code).toBe(2);
      expect(JSON.parse(nonRegular.stdout).outcome).toBe("argument_error");

      const messageFile = join(dir, "message.txt");
      writeFileSync(messageFile, "feat: bad\0message");
      const nulMessage = await runForTest(["--message-file", messageFile]);
      expect(nulMessage.code).toBe(2);
      expect(JSON.parse(nulMessage.stdout).outcome).toBe("argument_error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// receipts-pending ownership outcome
// ---------------------------------------------------------------------------

describe("commit-work: receipts pending", () => {
  for (const stalledIngester of [false, true]) {
    test(`reports bounded ingest lag with stalled_ingester=${stalledIngester}`, async () => {
      const { d } = deps({
        files: ["a.txt"],
        rules: [
          {
            when: (a) => argvStartsWith(a, "check-ignore"),
            result: { exitCode: 1 },
          },
        ],
      });
      const { code, stdout } = await runForTest(
        ["feat: adopt", "--session-id", "s1", "--adopt", "a.txt"],
        {
          ...d,
          readClaims: () => [
            {
              path: "a.txt",
              sessionId: "22222222-2222-4222-8222-222222222222",
              liveness: "unknown",
              receiptsPending: {
                events: 3,
                seconds: 12,
                stalledIngester,
                otherwiseTerminal: true,
              },
            },
          ],
        },
      );
      expect(code).toBe(1);
      expect(JSON.parse(stdout)).toMatchObject({
        outcome: "receipts_pending",
        error: "receipts_pending",
        ingest_lag_events: 3,
        ingest_lag_seconds: 12,
        stalled_ingester: stalledIngester,
      });
    });
  }
});

// ---------------------------------------------------------------------------
// no upstream (first push sets it)
// ---------------------------------------------------------------------------

describe("commit-work: no upstream", () => {
  test("sets upstream on first exact-SHA push when the captured branch has none", async () => {
    const { d, calls } = deps({
      files: ["a.txt"],
      rules: successRules({ stagedNames: ["a.txt"], upstream: "none" }),
    });
    const { code, stdout } = await runForTest(
      ["feat: first push", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      success: true,
      pushed: true,
      remote: "origin",
      branch: "main",
    });
    const push = calls.find((c) => argvStartsWith(c.args, "push"));
    expect(push?.args).toEqual([
      "push",
      "--no-progress",
      "origin",
      `${FAKE_COMMIT}:refs/heads/main`,
    ]);
    expect(
      calls.some((c) =>
        argvStartsWith(
          c.args,
          "branch",
          "--set-upstream-to=origin/main",
          "main",
        ),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// push failure classified (captured-from-real-git stderr golden)
// ---------------------------------------------------------------------------

describe("commit-work: push failure", () => {
  test("a non-fast-forward push → exit 1, classified push envelope (compact)", async () => {
    const { d, calls } = deps({
      files: ["a.txt"],
      rules: successRules({
        stagedNames: ["a.txt"],
        pushOutcome: { exitCode: 1, stderr: PUSH_NON_FAST_FORWARD },
      }),
    });
    const { code, stdout } = await runForTest(
      ["feat: nff", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(1);
    const envelope = JSON.parse(stdout);
    expect(envelope.success).toBe(false);
    expect(envelope.commit_sha).toBe(FAKE_COMMIT);
    expect(envelope.pushed).toBe(false);
    expect(envelope.push_error_class).toBe("non_fast_forward");
    const push = calls.find((call) => call.args[0] === "push");
    expect(push?.args).toContain(`${FAKE_COMMIT}:refs/heads/main`);
    expect(
      push?.args.some((arg) => arg === "--force" || arg.startsWith("+")),
    ).toBe(false);
  });

  test("a timed-out push reports unknown remote state", async () => {
    const { d } = deps({
      files: ["a.txt"],
      rules: successRules({
        stagedNames: ["a.txt"],
        pushOutcome: {
          exitCode: GIT_SPAWN_TIMEOUT_CODE,
          stderr: "push timed out",
        },
      }),
    });
    const { code, stdout } = await runForTest(
      ["feat: uncertain remote", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({
      outcome: "push_state_indeterminate",
      success: false,
      committed: true,
      pushed: null,
      push_error_class: "timeout",
    });
  });
});

// ---------------------------------------------------------------------------
// linked-worktree push skip (generic; submodule-guarded)
// ---------------------------------------------------------------------------

/**
 * Rules shaping the worktree DETECTION probes `pushCommitted` issues before the
 * push leg. `kind` selects the topology:
 *   - "main"      → git-dir == git-common-dir (the main worktree) → pushes.
 *   - "worktree"  → git-dir != git-common-dir, no superproject → push SKIPPED.
 *   - "submodule" → git-dir != git-common-dir BUT superproject non-empty →
 *                   guarded false-positive → still pushes.
 */
function detectionRules(
  kind: "main" | "worktree" | "submodule",
): FakeGitRule[] {
  const superproject = kind === "submodule" ? "/repo/super\n" : ""; // non-empty only in a submodule
  const gitDir =
    kind === "main" ? "/repo/.git\n" : "/repo/.git/worktrees/lane\n"; // linked worktree / submodule git dir differ
  const commonDir = "/repo/.git\n";
  return [
    {
      when: (a) =>
        argvStartsWith(a, "rev-parse", "--show-superproject-working-tree"),
      result: { exitCode: 0, stdout: superproject },
    },
    {
      when: (a) =>
        argvStartsWith(a, "rev-parse", "--path-format=absolute", "--git-dir"),
      result: { exitCode: 0, stdout: gitDir },
    },
    {
      when: (a) =>
        argvStartsWith(
          a,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ),
      result: { exitCode: 0, stdout: commonDir },
    },
  ];
}

describe("commit-work: linked-worktree push skip", () => {
  test("in a linked worktree, commits but SKIPS push with a skipped:worktree envelope", async () => {
    const { d, calls } = deps({
      files: ["a.txt"],
      rules: [
        ...detectionRules("worktree"),
        ...successRules({ stagedNames: ["a.txt"] }),
      ],
    });
    const { code, stdout } = await runForTest(
      ["feat: in worktree", "--session-id", "s1"],
      d,
    );
    // Skip is a SUCCESS — exit 0.
    expect(code).toBe(0);

    const lines = stdout.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      success: true,
      pushed: false,
      skipped: "worktree",
      branch: "main",
    });
    expect(lines[0]).not.toMatch(/^\s/);

    // The DECISION: committed, never pushed.
    expect(calls.some((c) => argvStartsWith(c.args, "commit-tree"))).toBe(true);
    expect(calls.some((c) => argvStartsWith(c.args, "push"))).toBe(false);
  });

  test("main-tree behavior unchanged — git-dir == common-dir → pushes", async () => {
    const { d, calls } = deps({
      files: ["a.txt"],
      rules: [
        ...detectionRules("main"),
        ...successRules({ stagedNames: ["a.txt"] }),
      ],
    });
    const { code, stdout } = await runForTest(
      ["feat: main tree", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      success: true,
      pushed: true,
      remote: "origin",
      branch: "main",
    });
    expect(calls.some((c) => argvStartsWith(c.args, "push"))).toBe(true);
  });

  test("submodule checkout still pushes (false-positive guarded by superproject)", async () => {
    const { d, calls } = deps({
      files: ["a.txt"],
      rules: [
        ...detectionRules("submodule"),
        ...successRules({ stagedNames: ["a.txt"] }),
      ],
    });
    const { code, stdout } = await runForTest(
      ["feat: in submodule", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(0);
    // Despite git-dir != common-dir, the superproject guard vetoes the skip.
    expect(JSON.parse(stdout)).toMatchObject({
      success: true,
      pushed: true,
      remote: "origin",
      branch: "main",
    });
    expect(calls.some((c) => argvStartsWith(c.args, "push"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deletion staging
// ---------------------------------------------------------------------------

describe("commit-work: deletion staging", () => {
  test("a session-deleted tracked file stages + commits as a removal", async () => {
    const { d, calls } = deps({
      files: ["doomed.txt"],
      absentFiles: ["doomed.txt"],
      rules: successRules({ stagedNames: ["doomed.txt"] }),
    });
    const { code, stdout } = await runForTest(
      ["chore: drop doomed", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(0);
    const line1 = JSON.parse(stdout.split("\n")[0]);
    expect(line1.success).toBe(true);
    expect(line1.files).toEqual(["doomed.txt"]);
    const exact = calls.find(
      (c) => c.args[0] === "update-index" && c.env?.GIT_INDEX_FILE,
    );
    expect(exact?.args).toEqual(["update-index", "-z", "--index-info"]);
    expect(exact?.stdin).toMatch(/^0 0{40} 0\tdoomed\.txt\0$/);
    expect(calls.some((c) => c.args[0] === "add")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// lint_failed envelope
// ---------------------------------------------------------------------------

describe("commit-work: lint_failed", () => {
  test("emits a compact lint_failed envelope when the lint matrix throws", async () => {
    const { d, calls } = deps({
      files: ["bad.py"],
      rules: successRules({ stagedNames: ["bad.py"] }),
      runLint: async () => {
        throw new LintFailure("F401 unused import", "ruff", ["bad.py"]);
      },
    });
    const { code, stdout } = await runForTest(
      ["feat: bad py", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("lint_failed");
    expect(parsed.linter).toBe("ruff");
    expect(parsed.files).toEqual(["bad.py"]);
    expect(typeof parsed.stderr).toBe("string");
    expect(parsed.stderr.length).toBeGreaterThan(0);
    // Recovery contract present + non-empty, steering fix→restage→re-invoke.
    expect(typeof parsed.recovery).toBe("string");
    expect(parsed.recovery.length).toBeGreaterThan(0);
    expect(parsed.recovery).toContain("re-invoke `keeper commit-work`");
    expect(parsed.recovery).toContain("not a coverage gap");
    // Compact single line.
    expect(stdout.trimEnd()).not.toContain("\n");
    // The commit was GATED — never issued.
    expect(calls.some((c) => argvStartsWith(c.args, "commit", "-F", "-"))).toBe(
      false,
    );
  });

  test("a linter cannot mutate and re-baseline the ambient index", async () => {
    let targetChanged = false;
    const { d, calls } = deps({
      files: ["a.ts"],
      rules: successRules({ stagedNames: ["a.ts"] }),
      runLint: async () => {
        targetChanged = true;
      },
      fingerprintIndex: (path) =>
        path === "/repo/.git/index" && targetChanged
          ? "changed-target-index"
          : "stable-private-index",
    });
    const { code, stdout } = await runForTest(
      ["feat: guarded lint", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(1);
    expect(JSON.parse(stdout).outcome).toBe("surface_changed");
    expect(calls.some((call) => call.args[0] === "commit-tree")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// index-purity gate (stale_index_carryover) + isolated-index commit
// ---------------------------------------------------------------------------

/** A flock stand-in that COUNTS release() calls, so a test can assert every
 * in-lock failure path releases the lock (via the outer `finally`). */
function recordingLock(): {
  acquire: () => { release: () => void };
  count: () => number;
} {
  let released = 0;
  return {
    acquire: () => ({
      release: () => {
        released += 1;
      },
    }),
    count: () => released,
  };
}

describe("commit-work: index-purity gate", () => {
  test("fails by default with a stale_index_carryover envelope; no commit/push", async () => {
    // Attributed = a.txt; the index also carries two unattributed paths.
    const { d, calls } = deps({
      files: ["a.txt"],
      rules: successRules({
        stagedNames: ["a.txt", "stale-b.txt", "stale-a.txt"],
      }),
    });
    const { code, stdout } = await runForTest(
      ["feat: only a", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("stale_index_carryover");
    expect(parsed.count).toBe(2);
    // Sorted sample of the offending staged-but-unattributed paths.
    expect(parsed.sample).toEqual(["stale-a.txt", "stale-b.txt"]);
    // Recovery names both ownership decisions: exact adoption or narrow unstage.
    expect(typeof parsed.hint).toBe("string");
    expect(parsed.hint.length).toBeGreaterThan(0);
    expect(parsed.recovery).toContain("--allow-stale-unstage");
    expect(parsed.recovery).toContain("--adopt");
    expect(parsed.recovery).not.toContain("git commit");
    // Compact single line.
    expect(stdout).not.toContain("\n  ");
    // The commit was GATED — neither commit nor push issued, and the index was
    // NOT silently reset.
    expect(calls.some((c) => argvStartsWith(c.args, "commit", "-F", "-"))).toBe(
      false,
    );
    expect(calls.some((c) => argvStartsWith(c.args, "push"))).toBe(false);
    expect(calls.some((c) => argvStartsWith(c.args, "reset", "HEAD"))).toBe(
      false,
    );
  });

  test("ambient staged-name discovery includes type changes", async () => {
    const { d, calls } = deps({
      files: ["a.txt"],
      rules: successRules({ stagedNames: ["a.txt", "type-changed"] }),
    });
    const { code, stdout } = await runForTest(
      ["feat: only a", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({
      outcome: "stale_index_carryover",
      sample: ["type-changed"],
    });
    const scan = calls.find(
      (call) =>
        argvStartsWith(call.args, "diff", "--cached", "--name-only", "-z") &&
        !call.env?.GIT_INDEX_FILE,
    );
    expect(scan?.args).toContain("--diff-filter=ACDMRT");
  });

  test("sample is capped at 20 while count carries the full total", async () => {
    // 25 stale paths, zero-padded so lexical sort is numeric-stable.
    const stale = Array.from(
      { length: 25 },
      (_, i) => `stale-${String(i).padStart(2, "0")}.txt`,
    );
    const { d } = deps({
      files: ["keep.txt"],
      rules: successRules({ stagedNames: ["keep.txt", ...stale] }),
    });
    const { code, stdout } = await runForTest(
      ["feat: keep", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.error).toBe("stale_index_carryover");
    expect(parsed.count).toBe(25);
    expect(parsed.sample.length).toBe(20);
    expect(parsed.sample).toEqual(stale.slice(0, 20));
  });

  test("--allow-stale-unstage restores exact base entries and commits attributed-only", async () => {
    const { d, calls } = deps({
      files: ["a.txt"],
      rules: successRules({ stagedNames: ["a.txt", "stale.txt"] }),
    });
    const { code, stdout } = await runForTest(
      ["feat: only a", "--session-id", "s1", "--allow-stale-unstage"],
      d,
    );
    expect(code).toBe(0);
    const ambient = calls.filter(
      (c) => c.args[0] === "update-index" && !c.env?.GIT_INDEX_FILE,
    );
    expect(ambient[0]).toMatchObject({
      args: ["update-index", "-z", "--index-info"],
    });
    expect(ambient[0]?.stdin).toMatch(/^0 0{40} 0\tstale\.txt\0$/);
    const exact = calls.find(
      (c) => c.args[0] === "update-index" && c.env?.GIT_INDEX_FILE,
    );
    expect(exact?.stdin).toContain("\ta.txt\0");
    expect(calls.some((c) => c.args[0] === "reset")).toBe(false);
    const commit = calls.find((c) => argvStartsWith(c.args, "commit-tree"));
    expect(commit?.args.slice(0, 5)).toEqual([
      "commit-tree",
      FAKE_TREE,
      "-p",
      FAKE_PARENT,
      "-F",
    ]);
    // Line 1 reports the attributed file only.
    expect(JSON.parse(stdout.split("\n")[0]).files).toEqual(["a.txt"]);
  });

  test("an empty ambient staged read does not suppress private-index content", async () => {
    // Ambient staged names do not define the isolated index's selected content.
    const { d, calls } = deps({
      files: ["a.txt"],
      rules: successRules({ stagedNames: [] }),
    });
    const { code, stdout } = await runForTest(
      ["feat: no-op", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.files).toEqual(["a.txt"]);
    expect(calls.some((c) => argvStartsWith(c.args, "commit-tree"))).toBe(true);
    expect(calls.some((c) => argvStartsWith(c.args, "push"))).toBe(true);
  });
});

describe("commit-work: isolated-index commit", () => {
  test("private index-info carries sorted exact entries into commit-tree", async () => {
    const { d, calls } = deps({
      files: ["b.txt", "a.txt"],
      rules: successRules({ stagedNames: ["a.txt", "b.txt"] }),
    });
    const { code } = await runForTest(["feat: two", "--session-id", "s1"], d);
    expect(code).toBe(0);
    const exact = calls.find(
      (c) => c.args[0] === "update-index" && c.env?.GIT_INDEX_FILE,
    );
    expect(exact?.args).toEqual(["update-index", "-z", "--index-info"]);
    expect(exact?.stdin?.indexOf("\ta.txt\0")).toBeLessThan(
      exact?.stdin?.indexOf("\tb.txt\0") ?? -1,
    );
    expect(calls.some((c) => c.args[0] === "add")).toBe(false);
    const commit = calls.find((c) => argvStartsWith(c.args, "commit-tree"));
    expect(commit?.args.slice(0, 5)).toEqual([
      "commit-tree",
      FAKE_TREE,
      "-p",
      FAKE_PARENT,
      "-F",
    ]);
    // The staged-name read forces --no-renames so a rename splits into both halves.
    const diff = calls.find((c) =>
      argvStartsWith(c.args, "diff", "--cached", "--name-only", "-z"),
    );
    expect(diff?.args).toContain("--no-renames");
  });

  test("a private staged-name expansion outside selection refuses before lint", async () => {
    let linted = false;
    const { d, calls } = deps({
      files: ["a.txt"],
      privateStagedNames: ["a.txt", "implicit.txt"],
      rules: successRules({ stagedNames: ["a.txt"] }),
      runLint: async () => {
        linted = true;
      },
    });
    const { code, stdout } = await runForTest(
      ["feat: exact only", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({
      outcome: "stage_failed",
      stderr_sample: expect.stringContaining("extras: implicit.txt"),
    });
    expect(linted).toBe(false);
    expect(calls.some((call) => call.args[0] === "commit-tree")).toBe(false);
  });

  test("a rename's A and D halves both become exact entries when attributed", async () => {
    // With --no-renames discovery reports both halves; exact index-info then
    // writes only those two stage-0 identities.
    const { d, calls } = deps({
      files: ["dir/new.txt", "dir/old.txt"],
      rules: successRules({ stagedNames: ["dir/new.txt", "dir/old.txt"] }),
    });
    const { code } = await runForTest(
      ["refactor: rename", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(0);
    const exact = calls.find(
      (c) => c.args[0] === "update-index" && c.env?.GIT_INDEX_FILE,
    );
    expect(exact?.stdin).toContain("\tdir/new.txt\0");
    expect(exact?.stdin).toContain("\tdir/old.txt\0");
    expect(calls.some((c) => c.args[0] === "add")).toBe(false);
  });

  test("a rename with one unattributed half fires the gate (all-or-nothing)", async () => {
    // Only the new path is attributed; the D half (old path) is stale.
    const { d, calls } = deps({
      files: ["dir/new.txt"],
      rules: successRules({ stagedNames: ["dir/new.txt", "dir/old.txt"] }),
    });
    const { code, stdout } = await runForTest(
      ["refactor: half rename", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.error).toBe("stale_index_carryover");
    expect(parsed.sample).toEqual(["dir/old.txt"]);
    expect(calls.some((c) => argvStartsWith(c.args, "commit", "-F", "-"))).toBe(
      false,
    );
  });

  test("a deletion emits an exact removal and is skipped by lint", async () => {
    const { d, calls } = deps({
      files: ["doomed.txt"],
      absentFiles: ["doomed.txt"],
      rules: successRules({ stagedNames: ["doomed.txt"] }),
    });
    const { code } = await runForTest(
      ["chore: drop doomed", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(0);
    const exact = calls.find(
      (c) => c.args[0] === "update-index" && c.env?.GIT_INDEX_FILE,
    );
    expect(exact?.stdin).toMatch(/^0 0{40} 0\tdoomed\.txt\0$/);
  });

  test("post-commit failure reports a committed-local result and never pushes", async () => {
    const { d, calls } = deps({
      files: ["a.txt"],
      rules: [
        {
          when: (args) =>
            argvStartsWith(
              args,
              "hook",
              "run",
              "--ignore-missing",
              "post-commit",
            ),
          result: { exitCode: 1, stderr: "post hook failed" },
        },
        ...successRules({ stagedNames: ["a.txt"] }),
      ],
    });
    const { code, stdout } = await runForTest(
      ["feat: committed local", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({
      outcome: "post_commit_hook_failed",
      success: false,
      committed: true,
      pushed: false,
      commit_sha: FAKE_COMMIT,
      stderr: "post hook failed",
    });
    expect(calls.filter((call) => call.args[0] === "update-ref")).toHaveLength(
      1,
    );
    expect(calls.some((call) => call.args[0] === "push")).toBe(false);
  });

  test("git commit-tree non-zero maps to a commit-failure envelope preserving git's stderr", async () => {
    const mergeRefusal = "fatal: commit creation declined";
    const { d, calls } = deps({
      files: ["a.txt"],
      rules: [
        {
          when: (a) => argvStartsWith(a, "commit-tree"),
          result: { exitCode: 1, stderr: mergeRefusal },
        },
        ...successRules({ stagedNames: ["a.txt"] }),
      ],
    });
    const { code, stdout } = await runForTest(
      ["feat: mid-merge", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.success).toBe(false);
    expect(parsed.outcome).toBe("commit_failed");
    expect(parsed.stderr).toBe(mergeRefusal);
    // Commit failed → push never runs.
    expect(calls.some((c) => argvStartsWith(c.args, "push"))).toBe(false);
  });
});

describe("commit-work: flock released on every in-lock failure path", () => {
  const scenarios: {
    name: string;
    argv: string[];
    files: string[];
    rules: FakeGitRule[];
  }[] = [
    {
      name: "stale_index_carryover gate",
      argv: ["feat: gated", "--session-id", "s1"],
      files: ["a.txt"],
      rules: successRules({ stagedNames: ["a.txt", "stale.txt"] }),
    },
    {
      name: "nothing_to_commit",
      argv: ["feat: no-op", "--session-id", "s1"],
      files: [],
      rules: successRules({ stagedNames: [] }),
    },
    {
      name: "git commit failure",
      argv: ["feat: fails", "--session-id", "s1"],
      files: ["a.txt"],
      rules: [
        {
          when: (a: string[]) => argvStartsWith(a, "commit-tree"),
          result: { exitCode: 1, stderr: "fatal: nope" },
        },
        ...successRules({ stagedNames: ["a.txt"] }),
      ],
    },
  ];
  for (const s of scenarios) {
    test(`releases the flock on ${s.name}`, async () => {
      const { d } = deps({ files: s.files, rules: s.rules });
      const lock = recordingLock();
      d.acquireLock = lock.acquire;
      const { code } = await runForTest(s.argv, d);
      expect(code).toBe(s.name === "nothing_to_commit" ? 0 : 1);
      expect(lock.count()).toBeGreaterThanOrEqual(1);
    });
  }
});

// ---------------------------------------------------------------------------
// inLinkedWorktree / pushCommitted detection unit tests
// ---------------------------------------------------------------------------

describe("inLinkedWorktree", () => {
  test("true when git-dir != git-common-dir and no superproject (linked worktree)", async () => {
    const { run } = fakeAsyncGit(detectionRules("worktree"));
    expect(await inLinkedWorktree("/repo/wt", run)).toBe(true);
  });

  test("false in the main worktree (git-dir == git-common-dir)", async () => {
    const { run } = fakeAsyncGit(detectionRules("main"));
    expect(await inLinkedWorktree("/repo", run)).toBe(false);
  });

  test("false in a submodule even though git-dir != git-common-dir (guarded)", async () => {
    const { run, calls } = fakeAsyncGit(detectionRules("submodule"));
    expect(await inLinkedWorktree("/repo/sub", run)).toBe(false);
    // The superproject guard short-circuits — git-dir is never even probed.
    expect(
      calls.some((c) =>
        argvStartsWith(
          c.args,
          "rev-parse",
          "--path-format=absolute",
          "--git-dir",
        ),
      ),
    ).toBe(false);
  });

  test("fail-open: a git error on the dir probes returns false (push not suppressed)", async () => {
    const { run } = fakeAsyncGit([
      {
        when: (a) =>
          argvStartsWith(a, "rev-parse", "--show-superproject-working-tree"),
        result: { exitCode: 0, stdout: "" },
      },
      {
        when: (a) =>
          argvStartsWith(a, "rev-parse", "--path-format=absolute", "--git-dir"),
        result: { exitCode: 128, stderr: "fatal: not a git repository" },
      },
    ]);
    expect(await inLinkedWorktree("/nowhere", run)).toBe(false);
  });
});

describe("pushCommitted: worktree skip gate", () => {
  test("returns the skipped:worktree envelope without issuing a push", async () => {
    const { run, calls } = fakeAsyncGit([
      ...detectionRules("worktree"),
      {
        when: (a) => argvStartsWith(a, "rev-parse", "--abbrev-ref", "HEAD"),
        result: { exitCode: 0, stdout: "keeper/epic/x/lane\n" },
      },
    ]);
    const env = await pushCommitted("/repo/wt", run);
    expect(env).toEqual({
      success: true,
      pushed: false,
      skipped: "worktree",
      branch: "keeper/epic/x/lane",
    });
    expect(calls.some((c) => argvStartsWith(c.args, "push"))).toBe(false);
    // The @{u} upstream probe is also skipped — the gate is BEFORE it.
    expect(calls.some((c) => c.args.includes("@{u}"))).toBe(false);
  });
});

describe("remotePushTurnKey: pre-merge push-readiness probe", () => {
  test("all gates pass → ready, in order, no fetch", async () => {
    const { run, calls } = fakeAsyncGit([]); // every call defaults to exit 0
    expect(await remotePushTurnKey("/repo", run)).toEqual({ ready: true });
    expect(calls.map((c) => c.args.join(" "))).toEqual([
      "remote get-url origin",
      "rev-parse --abbrev-ref --symbolic-full-name @{push}",
      "push --dry-run --no-progress",
    ]);
    expect(calls.some((c) => argvStartsWith(c.args, "fetch"))).toBe(false);
    // GIT_TERMINAL_PROMPT=0 + ssh BatchMode so a credential wall fails fast.
    expect(calls[2]?.env?.GIT_TERMINAL_PROMPT).toBe("0");
    expect(calls[2]?.env?.GIT_SSH_COMMAND).toContain("BatchMode=yes");
  });

  test("no origin remote → not ready (no-remote), never probes @{push} or dry-run", async () => {
    const { run, calls } = fakeAsyncGit([
      {
        when: (a) => argvStartsWith(a, "remote", "get-url"),
        result: { exitCode: 2, stderr: "error: No such remote 'origin'" },
      },
    ]);
    expect(await remotePushTurnKey("/repo", run)).toEqual({
      ready: false,
      reason: { kind: "no-remote" },
    });
    expect(calls.some((c) => c.args.includes("@{push}"))).toBe(false);
    expect(calls.some((c) => argvStartsWith(c.args, "push"))).toBe(false);
  });

  test("no @{push} target → not ready (no-push-target), uses @{push} NOT @{upstream}", async () => {
    const { run, calls } = fakeAsyncGit([
      {
        when: (a) => a.includes("@{push}"),
        result: { exitCode: 128, stderr: "fatal: no push destination" },
      },
    ]);
    expect(await remotePushTurnKey("/repo", run)).toEqual({
      ready: false,
      reason: { kind: "no-push-target" },
    });
    expect(calls.some((c) => c.args.includes("@{upstream}"))).toBe(false);
    expect(calls.some((c) => argvStartsWith(c.args, "push"))).toBe(false);
  });

  test("dry-run rejected → not ready, reason carries the classified push-error class", async () => {
    const { run } = fakeAsyncGit([
      {
        when: (a) => argvStartsWith(a, "push", "--dry-run"),
        result: {
          exitCode: 1,
          stderr: "fatal: Authentication failed for 'https://host/r.git'",
        },
      },
    ]);
    const res = await remotePushTurnKey("/repo", run);
    expect(res.ready).toBe(false);
    if (!res.ready && res.reason.kind === "dry-run-rejected") {
      expect(res.reason.pushErrorClass).toBe("auth");
      expect(describePushNotReady(res.reason)).toContain("auth");
    } else {
      throw new Error("expected a dry-run-rejected reason");
    }
  });
});

// ---------------------------------------------------------------------------
// Gate 1 — in-progress operation refusal (detectInProgressOperation + pipeline)
// ---------------------------------------------------------------------------

describe("detectInProgressOperation", () => {
  test("MERGE_HEAD present → merge, via `rev-parse -q --verify`", async () => {
    const { run, calls } = fakeAsyncGit([
      {
        when: (a) =>
          argvStartsWith(a, "rev-parse", "-q", "--verify", "MERGE_HEAD"),
        result: { exitCode: 0, stdout: "deadbeef\n" },
      },
    ]);
    expect(await detectInProgressOperation("/repo", run)).toBe("merge");
    expect(
      calls.some((c) =>
        argvStartsWith(c.args, "rev-parse", "-q", "--verify", "MERGE_HEAD"),
      ),
    ).toBe(true);
  });

  test("CHERRY_PICK_HEAD present → cherry-pick", async () => {
    const { run } = fakeAsyncGit([
      {
        when: (a) =>
          argvStartsWith(a, "rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"),
        result: { exitCode: 0, stdout: "cafe1234\n" },
      },
    ]);
    expect(await detectInProgressOperation("/repo", run)).toBe("cherry-pick");
  });

  test("REVERT_HEAD present → revert", async () => {
    const { run } = fakeAsyncGit([
      {
        when: (a) =>
          argvStartsWith(a, "rev-parse", "-q", "--verify", "REVERT_HEAD"),
        result: { exitCode: 0, stdout: "beef5678\n" },
      },
    ]);
    expect(await detectInProgressOperation("/repo", run)).toBe("revert");
  });

  test("rebase-merge dir → rebase, via `--git-path`-resolved existence", async () => {
    // Ref probes default to empty stdout (not present); the dir probe resolves a
    // path and the injected pathExists reports it present.
    const { run, calls } = fakeAsyncGit([
      {
        when: (a) =>
          argvStartsWith(a, "rev-parse", "--git-path", "rebase-merge"),
        result: { exitCode: 0, stdout: "/repo/.git/rebase-merge\n" },
      },
    ]);
    const exists = (p: string) => p === "/repo/.git/rebase-merge";
    expect(await detectInProgressOperation("/repo", run, exists)).toBe(
      "rebase",
    );
    // The probe used `rev-parse --git-path` (worktree-portable), asserted in argv.
    expect(
      calls.some((c) =>
        argvStartsWith(c.args, "rev-parse", "--git-path", "rebase-merge"),
      ),
    ).toBe(true);
  });

  test("rebase-apply dir → rebase (am backend)", async () => {
    const { run } = fakeAsyncGit([
      {
        when: (a) =>
          argvStartsWith(a, "rev-parse", "--git-path", "rebase-apply"),
        result: { exitCode: 0, stdout: "/repo/.git/rebase-apply\n" },
      },
    ]);
    const exists = (p: string) => p === "/repo/.git/rebase-apply";
    expect(await detectInProgressOperation("/repo", run, exists)).toBe(
      "rebase",
    );
  });

  test("BISECT_LOG file → bisect", async () => {
    const { run, calls } = fakeAsyncGit([
      {
        when: (a) => argvStartsWith(a, "rev-parse", "--git-path", "BISECT_LOG"),
        result: { exitCode: 0, stdout: "/repo/.git/BISECT_LOG\n" },
      },
    ]);
    const exists = (p: string) => p === "/repo/.git/BISECT_LOG";
    expect(await detectInProgressOperation("/repo", run, exists)).toBe(
      "bisect",
    );
    expect(
      calls.some((c) =>
        argvStartsWith(c.args, "rev-parse", "--git-path", "BISECT_LOG"),
      ),
    ).toBe(true);
  });

  test("a resolved relative --git-path is joined to cwd before the existence check", async () => {
    const { run } = fakeAsyncGit([
      {
        when: (a) =>
          argvStartsWith(a, "rev-parse", "--git-path", "rebase-merge"),
        result: { exitCode: 0, stdout: ".git/rebase-merge\n" },
      },
    ]);
    const exists = (p: string) => p === "/wt/.git/rebase-merge";
    expect(await detectInProgressOperation("/wt", run, exists)).toBe("rebase");
  });

  test("quiescent repo (no ref, no state dir) → null", async () => {
    // Every ref probe returns empty; every dir probe resolves a path that does
    // not exist.
    const { run } = fakeAsyncGit([
      {
        when: (a) => argvStartsWith(a, "rev-parse", "--git-path"),
        result: { exitCode: 0, stdout: "/repo/.git/whatever\n" },
      },
    ]);
    expect(
      await detectInProgressOperation("/repo", run, () => false),
    ).toBeNull();
  });
});

describe("commit-work: operation_in_progress gate (pipeline)", () => {
  for (const op of [
    "merge",
    "cherry-pick",
    "revert",
    "rebase",
    "bisect",
  ] as const) {
    test(`refuses with an operation_in_progress envelope mid-${op}; no commit/push`, async () => {
      const { d, calls } = deps({
        files: ["a.txt"],
        rules: successRules({ stagedNames: ["a.txt"] }),
        detectInProgress: async () => op,
      });
      const { code, stdout } = await runForTest(
        [`feat: mid-${op}`, "--session-id", "s1"],
        d,
      );
      expect(code).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe("operation_in_progress");
      expect(parsed.operation).toBe(op);
      expect(typeof parsed.recovery).toBe("string");
      expect(parsed.recovery.length).toBeGreaterThan(0);
      // Refused pre-lock — neither commit nor push issued.
      expect(
        calls.some((c) => argvStartsWith(c.args, "commit", "-F", "-")),
      ).toBe(false);
      expect(calls.some((c) => argvStartsWith(c.args, "push"))).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Gate 2 — shared-checkout jam refusal (pipeline + real-DB parity)
// ---------------------------------------------------------------------------

describe("commit-work: shared_checkout_jam gate (pipeline)", () => {
  test("a live jam row refuses with a shared_checkout_jam envelope; no commit", async () => {
    const { d, calls } = deps({
      files: ["a.txt"],
      rules: successRules({ stagedNames: ["a.txt"] }),
      checkSharedCheckoutJam: () => true,
    });
    const { code, stdout } = await runForTest(
      ["feat: jammed", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("shared_checkout_jam");
    expect(typeof parsed.recovery).toBe("string");
    expect(parsed.recovery).toContain("--override-jam");
    expect(calls.some((c) => argvStartsWith(c.args, "commit", "-F", "-"))).toBe(
      false,
    );
  });

  test("a jam appearing while waiting for the lock is rechecked before build", async () => {
    let probes = 0;
    const { d, calls } = deps({
      files: ["a.txt"],
      rules: successRules({ stagedNames: ["a.txt"] }),
      checkSharedCheckoutJam: () => {
        probes += 1;
        return probes === 2;
      },
    });
    const { code, stdout } = await runForTest(
      ["feat: raced jam", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(1);
    expect(probes).toBe(2);
    expect(JSON.parse(stdout).outcome).toBe("shared_checkout_jam");
    expect(calls.some((call) => call.args[0] === "hash-object")).toBe(false);
  });

  test("--override-jam proceeds past a live jam row and commits", async () => {
    const { d, calls } = deps({
      files: ["a.txt"],
      rules: successRules({ stagedNames: ["a.txt"] }),
      checkSharedCheckoutJam: () => true,
    });
    const { code } = await runForTest(
      ["feat: overridden", "--session-id", "s1", "--override-jam"],
      d,
    );
    expect(code).toBe(0);
    expect(calls.some((c) => argvStartsWith(c.args, "commit-tree"))).toBe(true);
  });

  test("a throwing jam probe fails open — the commit proceeds", async () => {
    const { d, calls } = deps({
      files: ["a.txt"],
      rules: successRules({ stagedNames: ["a.txt"] }),
      checkSharedCheckoutJam: () => {
        throw new Error("keeper.db locked");
      },
    });
    const { code } = await runForTest(
      ["feat: fail-open", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(0);
    expect(calls.some((c) => argvStartsWith(c.args, "commit-tree"))).toBe(true);
  });
});

describe("sharedCheckoutJamActive: real-DB provenance parity + fail-open", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "keeper-jam-"));
    dbPath = join(tmpDir, "keeper.db");
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Seed one `dispatch_failures` row directly (a projection table). */
  function seedRow(verb: string, id: string, dir: string | null): void {
    const { db } = freshDbFile(dbPath);
    db.query(
      "INSERT INTO dispatch_failures " +
        "(verb, id, reason, dir, ts, last_event_id, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(verb, id, "shared-checkout state", dir, 1.0, 1, 1.0, 1.0);
    db.close();
  }

  test("a producer-shaped dir (trailing slash + un-realpath'd) matches the normalized toplevel", () => {
    // The distress row's `dir` provenance is the producer's repo-dir plumbing
    // (epics.project_dir), NOT `git rev-parse --show-toplevel` output — so it may
    // carry a trailing slash and a pre-realpath symlink (macOS /var → /private/var).
    // The worktree we pass is the realpath'd toplevel (what resolveWorktreeRoot
    // returns). Normalizing BOTH sides (realpath + trailing-slash strip) converges.
    const producerDir = `${tmpDir}/`; // trailing slash, pre-realpath
    const worktree = realpathSync(tmpDir); // git-realpath'd toplevel
    seedRow(
      SHARED_DIRTY_DISTRESS_VERB,
      `${SHARED_DIRTY_DISTRESS_ID_PREFIX}abc123`,
      producerDir,
    );
    expect(sharedCheckoutJamActive(worktree, dbPath)).toBe(true);
  });

  test("a desync row for this repo also fires the gate", () => {
    seedRow(
      SHARED_DIRTY_DISTRESS_VERB,
      `${SHARED_DESYNC_DISTRESS_ID_PREFIX}def456`,
      tmpDir,
    );
    expect(sharedCheckoutJamActive(realpathSync(tmpDir), dbPath)).toBe(true);
  });

  test("a row naming a DIFFERENT repo does not fire", () => {
    seedRow(
      SHARED_DIRTY_DISTRESS_VERB,
      `${SHARED_DIRTY_DISTRESS_ID_PREFIX}other`,
      "/some/other/repo",
    );
    expect(sharedCheckoutJamActive(realpathSync(tmpDir), dbPath)).toBe(false);
  });

  test("a non-distress dispatch_failures row (wrong verb/id) never matches", () => {
    // A close::<epic> merge-conflict row in THIS dir must not be read as a jam.
    seedRow("close", "fn-999", tmpDir);
    expect(sharedCheckoutJamActive(realpathSync(tmpDir), dbPath)).toBe(false);
  });

  test("no keeper.db present → fail open (false), commit-work keeps working", () => {
    expect(
      sharedCheckoutJamActive(realpathSync(tmpDir), join(tmpDir, "absent.db")),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gate 3 — mass-reversion tripwire (pipeline, canned ls-files/cat-file)
// ---------------------------------------------------------------------------

/** One staged path's blob geometry for the reversion probe. */
interface RevSpec {
  path: string;
  indexOid: string;
  mode?: string;
  stage?: string;
  headOid?: string;
  ancestors?: Record<number, string>;
}

/**
 * Build the `ls-files -s -z` + `cat-file --batch-check` canned rules for a set of
 * staged specs. `cat-file` output is ordered to match the probe's spec order
 * (candidates in the given order, HEAD:P then HEAD~1:P..HEAD~30:P per path),
 * skipping gitlinks + excluded globs exactly as the analyzer does.
 */
function reversionRules(specs: RevSpec[]): FakeGitRule[] {
  const lsOut = `${specs
    .map(
      (s) => `${s.mode ?? "100644"} ${s.indexOid} ${s.stage ?? "0"}\t${s.path}`,
    )
    .join("\0")}\0`;
  // Candidate order must match the analyzer's: it filters the SORTED staged set,
  // so sort by path here to keep the cat-file output correlated spec-for-spec.
  const candidates = specs
    .filter(
      (s) => (s.mode ?? "100644") !== "160000" && !isReversionExcluded(s.path),
    )
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const lines: string[] = [];
  for (const s of candidates) {
    lines.push(s.headOid ? `${s.headOid} blob 12` : `HEAD:${s.path} missing`);
    for (let k = 1; k <= 30; k++) {
      const oid = s.ancestors?.[k];
      lines.push(oid ? `${oid} blob 12` : `HEAD~${k}:${s.path} missing`);
    }
  }
  const catOut = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  return [
    {
      when: (a) => argvStartsWith(a, "ls-files", "-s", "-z"),
      result: { exitCode: 0, stdout: lsOut },
    },
    {
      when: (a) => argvStartsWith(a, "cat-file", "--batch-check"),
      result: { exitCode: 0, stdout: catOut },
    },
  ];
}

/** A reverting spec: index blob == HEAD~2 ancestor blob, differs from HEAD. */
function reverting(path: string, n: number): RevSpec {
  return {
    path,
    indexOid: `rev${n}`,
    headOid: `head${n}`,
    ancestors: { 2: `rev${n}` },
  };
}

/** A normal spec: index blob == HEAD blob (no change vs HEAD → never a candidate). */
function normal(path: string, n: number): RevSpec {
  return { path, indexOid: `cur${n}`, headOid: `cur${n}` };
}

describe("commit-work: mass_reversion tripwire", () => {
  test("5 reversions in a 10-path set (>=5 AND >=30%) aborts, naming the flagged paths", async () => {
    const specs: RevSpec[] = [
      ...[0, 1, 2, 3, 4].map((i) => reverting(`f${i}.txt`, i)),
      ...[5, 6, 7, 8, 9].map((i) => normal(`f${i}.txt`, i)),
    ];
    const files = specs.map((s) => s.path);
    const { d, calls } = deps({
      files,
      rules: [
        ...reversionRules(specs),
        ...successRules({ stagedNames: files }),
      ],
    });
    const { code, stdout } = await runForTest(
      ["feat: sweep", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.error).toBe("mass_reversion");
    expect(parsed.count).toBe(5);
    expect(parsed.staged).toBe(10);
    expect(parsed.sample).toEqual([
      "f0.txt",
      "f1.txt",
      "f2.txt",
      "f3.txt",
      "f4.txt",
    ]);
    // Aborted before commit/push (and the single batched cat-file was used).
    expect(calls.some((c) => argvStartsWith(c.args, "commit", "-F", "-"))).toBe(
      false,
    );
    const catCalls = calls.filter((c) =>
      argvStartsWith(c.args, "cat-file", "--batch-check"),
    );
    expect(catCalls.length).toBe(1);
  });

  test("4 reversions (below the count floor) does NOT trip — commit proceeds", async () => {
    const specs: RevSpec[] = [
      ...[0, 1, 2, 3].map((i) => reverting(`f${i}.txt`, i)),
      ...[4, 5, 6, 7, 8, 9].map((i) => normal(`f${i}.txt`, i)),
    ];
    const files = specs.map((s) => s.path);
    const { d, calls } = deps({
      files,
      rules: [
        ...reversionRules(specs),
        ...successRules({ stagedNames: files }),
      ],
    });
    const { code } = await runForTest(["feat: minor", "--session-id", "s1"], d);
    expect(code).toBe(0);
    expect(calls.some((c) => argvStartsWith(c.args, "commit-tree"))).toBe(true);
  });

  test("fraction denominator: 5 reversions in a 20-path set (< 30%) does NOT trip", async () => {
    const specs: RevSpec[] = [
      ...[0, 1, 2, 3, 4].map((i) =>
        reverting(`f${String(i).padStart(2, "0")}.txt`, i),
      ),
      ...Array.from({ length: 15 }, (_, k) => k + 5).map((i) =>
        normal(`f${String(i).padStart(2, "0")}.txt`, i),
      ),
    ];
    const files = specs.map((s) => s.path);
    const { d, calls } = deps({
      files,
      rules: [
        ...reversionRules(specs),
        ...successRules({ stagedNames: files }),
      ],
    });
    const { code } = await runForTest(
      ["feat: big change", "--session-id", "s1"],
      d,
    );
    // 5 >= 5 but 5 < 0.30 * 20 (= 6) → no trip.
    expect(code).toBe(0);
    expect(calls.some((c) => argvStartsWith(c.args, "commit-tree"))).toBe(true);
  });

  test("a gitlink (mode 160000) is excluded from the numerator", async () => {
    // 4 real reversions + one gitlink whose (would-be) index oid matches an
    // ancestor: excluded, so count stays 4 → no trip.
    const specs: RevSpec[] = [
      ...[0, 1, 2, 3].map((i) => reverting(`f${i}.txt`, i)),
      {
        path: "vendored",
        mode: "160000",
        indexOid: "rev9",
        headOid: "head9",
        ancestors: { 2: "rev9" },
      },
      ...[5, 6, 7, 8, 9].map((i) => normal(`f${i}.txt`, i)),
    ];
    const files = specs.map((s) => s.path).sort();
    const { d, calls } = deps({
      files,
      rules: [
        ...reversionRules(specs),
        ...successRules({ stagedNames: files }),
      ],
    });
    const { code } = await runForTest(
      ["feat: gitlink", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(0);
    expect(calls.some((c) => argvStartsWith(c.args, "commit-tree"))).toBe(true);
  });

  test("an excluded-glob surface (corpus) is skipped from the numerator", async () => {
    // 4 real reversions + a plugins/prompt/corpus/** reversion (excluded) → 4, no trip.
    const specs: RevSpec[] = [
      ...[0, 1, 2, 3].map((i) => reverting(`f${i}.txt`, i)),
      reverting("plugins/prompt/corpus/snip.md", 9),
    ];
    const files = specs.map((s) => s.path).sort();
    const { d, calls } = deps({
      files,
      rules: [
        ...reversionRules(specs),
        ...successRules({ stagedNames: files }),
      ],
    });
    const { code } = await runForTest(
      ["feat: corpus", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(0);
    expect(calls.some((c) => argvStartsWith(c.args, "commit-tree"))).toBe(true);
  });

  test("short history (all ancestors missing) degrades to no signal", async () => {
    // Every path reverts in principle, but HEAD~k are all missing (root reached),
    // so no ancestor blob is ever found → no candidates → no trip.
    const specs: RevSpec[] = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
      path: `f${i}.txt`,
      indexOid: `idx${i}`,
      headOid: `head${i}`,
      ancestors: {}, // all HEAD~k missing
    }));
    const files = specs.map((s) => s.path);
    const { d, calls } = deps({
      files,
      rules: [
        ...reversionRules(specs),
        ...successRules({ stagedNames: files }),
      ],
    });
    const { code } = await runForTest(
      ["feat: shallow", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(0);
    expect(calls.some((c) => argvStartsWith(c.args, "commit-tree"))).toBe(true);
  });

  test("a missing HEAD blob (re-added deleted file) still counts as a reversion", async () => {
    // 5 paths absent at HEAD (HEAD:P missing) whose index matches HEAD~3 —
    // re-introducing old content of a deleted file. The missing-object line is
    // parsed as no-blob (differs from index), so the ancestor match still trips.
    const specs: RevSpec[] = [0, 1, 2, 3, 4].map((i) => ({
      path: `f${i}.txt`,
      indexOid: `back${i}`,
      // headOid omitted → HEAD:P missing line
      ancestors: { 3: `back${i}` },
    }));
    const files = specs.map((s) => s.path);
    const { d } = deps({
      files,
      rules: [
        ...reversionRules(specs),
        ...successRules({ stagedNames: files }),
      ],
    });
    const { code, stdout } = await runForTest(
      ["feat: readd", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(1);
    expect(JSON.parse(stdout).error).toBe("mass_reversion");
  });

  test("--allow-mass-reversion proceeds past the tripwire and commits", async () => {
    const specs: RevSpec[] = [0, 1, 2, 3, 4].map((i) =>
      reverting(`f${i}.txt`, i),
    );
    const files = specs.map((s) => s.path);
    const { d, calls } = deps({
      files,
      rules: [
        ...reversionRules(specs),
        ...successRules({ stagedNames: files }),
      ],
    });
    const { code } = await runForTest(
      [
        "revert: intended bulk revert",
        "--session-id",
        "s1",
        "--allow-mass-reversion",
      ],
      d,
    );
    expect(code).toBe(0);
    expect(calls.some((c) => argvStartsWith(c.args, "commit-tree"))).toBe(true);
  });

  test("an unmerged (stage>0) index entry refuses with unmerged_paths", async () => {
    const specs: RevSpec[] = [
      { path: "conflicted.txt", indexOid: "aaa", stage: "2" },
      { path: "clean.txt", indexOid: "bbb", headOid: "bbb" },
    ];
    const files = specs.map((s) => s.path).sort();
    const { d, calls } = deps({
      files,
      rules: [
        ...reversionRules(specs),
        ...successRules({ stagedNames: files }),
      ],
    });
    const { code, stdout } = await runForTest(
      ["feat: unmerged", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.error).toBe("unmerged_paths");
    expect(parsed.sample).toContain("conflicted.txt");
    expect(calls.some((c) => argvStartsWith(c.args, "commit", "-F", "-"))).toBe(
      false,
    );
    // Refused on ls-files alone — no cat-file probe needed.
    expect(calls.some((c) => argvStartsWith(c.args, "cat-file"))).toBe(false);
  });
});
