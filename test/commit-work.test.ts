/**
 * Tests for `keeper commit-work` (epic fn-715 task 2), de-gitted for fn-904 `.3`:
 * ZERO real git, ZERO compiled-binary spawn, ZERO real linter. The verb's
 * `runForTest(argv, deps)` entry runs the FULL pipeline IN-PROCESS — file
 * discovery → gitignore filter → stage → stale-unstage → lint gate → commit →
 * push — against injected seams: a recording fake git runner returning canned
 * outputs / captured-from-real-git push stderr goldens, a fake attribution
 * discovery, a fake lint matrix, and a no-op flock. The byte-parity serializers
 * still run (output routes through the in-memory `writeOut` seam), so the compact
 * two-line NDJSON / pretty envelope SHAPES stay under test.
 *
 * The assertions are keeper's DECISIONS, not git's effect: the staged pathspec,
 * the committed message + Job-Id trailer, the push skip/classify, the
 * file_list_too_large / forbidden-trailer / no-session-id / lint_failed
 * envelopes, and the exact envelope bytes line-oriented consumers parse.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type CommitWorkDeps, runForTest } from "../cli/commit-work";
import { LintFailure } from "../src/commit-work/lint-matrix";
import {
  describePushNotReady,
  inLinkedWorktree,
  pushCommitted,
  remotePushTurnKey,
} from "../src/commit-work/push";
import { PUSH_NON_FAST_FORWARD } from "./fixtures/git-push-goldens";
import {
  argvStartsWith,
  type FakeGitRule,
  fakeAsyncGit,
} from "./helpers/fake-git.ts";

// The verb resolves a session id from the ambient env when no --session-id is
// passed; clear the harness ids so the no-session-id path is reachable and the
// Job-Id trailer is fully test-controlled.
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
      when: (a) => argvStartsWith(a, "commit", "-F", "-"),
      result: { exitCode: 0 },
    },
    {
      when: (a) => argvStartsWith(a, "rev-parse", "--short", "HEAD"),
      result: { exitCode: 0, stdout: "abc1234\n" },
    },
    {
      when: (a) => argvStartsWith(a, "rev-parse", "--abbrev-ref", "HEAD"),
      result: { exitCode: 0, stdout: "main\n" },
    },
  ];
  // @{u} probe: exit 128 → no upstream (first push sets it); exit 0 → configured.
  rules.push({
    when: (a) => a.includes("@{u}"),
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

/** Build deps from rules + a discovered file set. The git runner echoes the
 * commit message through `interpret-trailers`, appending `Job-Id: <jobId>` when
 * given — modeling git's trailer machinery so the commit message under test
 * carries (or omits) the trailer exactly as production would. */
function deps(opts: {
  files: string[];
  rules: FakeGitRule[];
  jobId?: string;
  runLint?: (files: string[], cwd: string) => Promise<void>;
}): { d: CommitWorkDeps; calls: ReturnType<typeof fakeAsyncGit>["calls"] } {
  const fake = fakeAsyncGit(opts.rules);
  const baseRun = fake.run;
  const run: typeof baseRun = async (args, options) => {
    if (args.includes("interpret-trailers")) {
      const msg = options?.stdin ? new TextDecoder().decode(options.stdin) : "";
      // Record the call (so it's in `calls`) then synthesize the trailer append.
      await baseRun(args, options);
      const out = opts.jobId ? `${msg}\nJob-Id: ${opts.jobId}\n` : msg;
      return { code: 0, stdout: out, stderr: "" };
    }
    return baseRun(args, options);
  };
  const d: CommitWorkDeps = {
    gitRunner: run,
    discoverFiles: () => opts.files,
    // No-op the read-side attribution wait: this suite injects the file set
    // directly, so there is nothing to wait for, and the default wait would
    // spawn real git + read the production DB — both banned here.
    waitCaughtUp: async () => {},
    runLint: opts.runLint ?? (async () => {}),
    acquireLock: () => ({ release: () => {} }),
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
});

// ---------------------------------------------------------------------------
// --preview-files
// ---------------------------------------------------------------------------

describe("commit-work: --preview-files", () => {
  test("lists session-attributed files (pretty), gitignore-filtered, no commit", async () => {
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
    expect(JSON.parse(stdout)).toEqual({
      success: true,
      files: ["a.txt", "b.txt"],
    });
    // Pretty indent=2 shape.
    expect(stdout).toBe(
      `${JSON.stringify({ success: true, files: ["a.txt", "b.txt"] }, null, 2)}\n`,
    );
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
    expect(JSON.parse(stdout).error).toContain("commit message is required");
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
    expect(JSON.parse(stdout).error).toContain("forbidden trailer pattern");
  });

  test("a single-line trailer-looking subject is allowed (gate is multi-line only)", async () => {
    const { d } = deps({
      files: ["a.txt"],
      rules: successRules({ stagedNames: ["a.txt"] }),
    });
    const { code, stdout } = await runForTest(
      ["Job-Id: not-really", "--session-id", "s1"],
      d,
    );
    const line1 = JSON.parse(stdout.split("\n")[0]);
    expect(code).toBe(0);
    expect(line1.success).toBe(true);
    expect(line1.commit_sha).toBe("abc1234");
  });
});

// ---------------------------------------------------------------------------
// empty file set
// ---------------------------------------------------------------------------

describe("commit-work: empty file set", () => {
  test("emits committed:false (pretty) when nothing is on the hook", async () => {
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
    expect(JSON.parse(stdout)).toEqual({
      success: true,
      committed: false,
      files: [],
    });
    expect(stdout).toBe(
      `${JSON.stringify({ success: true, committed: false, files: [] }, null, 2)}\n`,
    );
  });
});

// ---------------------------------------------------------------------------
// success path — two-line compact NDJSON
// ---------------------------------------------------------------------------

describe("commit-work: success path", () => {
  test("two-line compact NDJSON; both parse; stage + commit + push issued", async () => {
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
    expect(lines.length).toBe(2);

    // Line 1 — commit envelope (compact, sorted files).
    const line1 = JSON.parse(lines[0]);
    expect(line1.success).toBe(true);
    expect(line1.commit_sha).toBe("abc1234");
    expect(line1.files).toEqual(["a.txt", "b.txt"]);
    expect(lines[0]).not.toMatch(/^\s/); // compact

    // Line 2 — push envelope.
    expect(JSON.parse(lines[1])).toEqual({
      success: true,
      pushed: true,
      remote: "origin",
      branch: "main",
    });

    // Decisions: staged the discovered files pathspec-scoped, then committed.
    const add = calls.find((c) => argvStartsWith(c.args, "add", "-A", "--"));
    expect(add?.args).toEqual(["add", "-A", "--", "a.txt", "b.txt"]);
    expect(calls.some((c) => argvStartsWith(c.args, "commit", "-F", "-"))).toBe(
      true,
    );
    expect(calls.some((c) => argvStartsWith(c.args, "push"))).toBe(true);
  });

  test("appends the Job-Id trailer from JOBCTL_JOB_ID", async () => {
    process.env.JOBCTL_JOB_ID = "job-abc";
    const { d, calls } = deps({
      files: ["a.txt"],
      jobId: "job-abc",
      rules: successRules({ stagedNames: ["a.txt"] }),
    });
    const { code } = await runForTest(
      ["feat: trailer", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(0);
    // The committed message (fed via commit -F - stdin) carries the trailer.
    const commit = calls.find((c) =>
      argvStartsWith(c.args, "commit", "-F", "-"),
    );
    expect(commit?.stdin).toContain("Job-Id: job-abc");
  });

  test("no Job-Id trailer when no job id is resolvable", async () => {
    // --session-id feeds attribution but NOT the trailer (env only). No
    // JOBCTL_JOB_ID + cleared CLAUDE_CODE_SESSION_ID → no trailer.
    const { d, calls } = deps({
      files: ["a.txt"],
      rules: successRules({ stagedNames: ["a.txt"] }),
    });
    const { code } = await runForTest(
      ["feat: no trailer", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(0);
    const commit = calls.find((c) =>
      argvStartsWith(c.args, "commit", "-F", "-"),
    );
    expect(commit?.stdin).not.toContain("Job-Id:");
  });
});

// ---------------------------------------------------------------------------
// no upstream (first push sets it)
// ---------------------------------------------------------------------------

describe("commit-work: no upstream", () => {
  test("sets upstream on first push (@{u} probe exits 128 → push -u origin HEAD)", async () => {
    const { d, calls } = deps({
      files: ["a.txt"],
      rules: successRules({ stagedNames: ["a.txt"], upstream: "none" }),
    });
    const { code, stdout } = await runForTest(
      ["feat: first push", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(0);
    const lines = stdout.split("\n").filter((l) => l.length > 0);
    expect(JSON.parse(lines[1])).toEqual({
      success: true,
      pushed: true,
      remote: "origin",
      branch: "main",
    });
    // The decision: push WITH -u origin HEAD to set the missing upstream.
    const push = calls.find((c) => argvStartsWith(c.args, "push"));
    expect(push?.args).toContain("-u");
    expect(push?.args).toContain("origin");
    expect(push?.args).toContain("HEAD");
  });
});

// ---------------------------------------------------------------------------
// push failure classified (captured-from-real-git stderr golden)
// ---------------------------------------------------------------------------

describe("commit-work: push failure", () => {
  test("a non-fast-forward push → exit 1, classified push envelope (compact)", async () => {
    const { d } = deps({
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
    const lines = stdout.split("\n").filter((l) => l.length > 0);
    // Line 1 commit succeeded; line 2 is the classified failure.
    const line2 = JSON.parse(lines[1]);
    expect(line2.success).toBe(false);
    expect(line2.pushed).toBe(false);
    expect(line2.push_error_class).toBe("non_fast_forward");
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
    expect(lines.length).toBe(2);
    // Line 1 — the commit still landed.
    expect(JSON.parse(lines[0]).success).toBe(true);
    // Line 2 — the distinct skipped envelope (compact).
    expect(JSON.parse(lines[1])).toEqual({
      success: true,
      pushed: false,
      skipped: "worktree",
      branch: "main",
    });
    expect(lines[1]).not.toMatch(/^\s/); // compact

    // The DECISION: committed, never pushed.
    expect(calls.some((c) => argvStartsWith(c.args, "commit", "-F", "-"))).toBe(
      true,
    );
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
    const lines = stdout.split("\n").filter((l) => l.length > 0);
    expect(JSON.parse(lines[1])).toEqual({
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
    const lines = stdout.split("\n").filter((l) => l.length > 0);
    // Despite git-dir != common-dir, the superproject guard vetoes the skip.
    expect(JSON.parse(lines[1])).toEqual({
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
    // `add -A -- doomed.txt` records the removal; the staged-name read reports it.
    const { d, calls } = deps({
      files: ["doomed.txt"],
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
    // The deletion is staged via the -A pathspec form.
    const add = calls.find((c) => argvStartsWith(c.args, "add", "-A", "--"));
    expect(add?.args).toEqual(["add", "-A", "--", "doomed.txt"]);
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
});

// ---------------------------------------------------------------------------
// index-purity gate (stale_index_carryover) + pathspec-limited commit
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
    // Recovery names BOTH paths forward: the explicit override AND plain git.
    expect(typeof parsed.hint).toBe("string");
    expect(parsed.hint.length).toBeGreaterThan(0);
    expect(parsed.recovery).toContain("--allow-stale-unstage");
    expect(parsed.recovery).toContain("git add");
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

  test("--allow-stale-unstage restores the reset argv and commits attributed-only", async () => {
    const { d, calls } = deps({
      files: ["a.txt"],
      rules: successRules({ stagedNames: ["a.txt", "stale.txt"] }),
    });
    const { code, stdout } = await runForTest(
      ["feat: only a", "--session-id", "s1", "--allow-stale-unstage"],
      d,
    );
    expect(code).toBe(0);
    // The stale path was unstaged via `reset HEAD -- stale.txt`.
    const reset = calls.find((c) => argvStartsWith(c.args, "reset", "HEAD"));
    expect(reset?.args).toEqual(["reset", "HEAD", "--", "stale.txt"]);
    // Then the commit proceeded, pathspec-limited to the attributed set only.
    const commit = calls.find((c) =>
      argvStartsWith(c.args, "commit", "-F", "-"),
    );
    expect(commit?.args).toEqual(["commit", "-F", "-", "--", "a.txt"]);
    // Line 1 reports the attributed file only.
    expect(JSON.parse(stdout.split("\n")[0]).files).toEqual(["a.txt"]);
  });

  test("empty resolved pathspec yields nothing_to_commit; no commit/push", async () => {
    // Files discovered + staged, but nothing actually lands in the index.
    const { d, calls } = deps({
      files: ["a.txt"],
      rules: successRules({ stagedNames: [] }),
    });
    const { code, stdout } = await runForTest(
      ["feat: no-op", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("nothing_to_commit");
    expect(typeof parsed.hint).toBe("string");
    expect(calls.some((c) => argvStartsWith(c.args, "commit", "-F", "-"))).toBe(
      false,
    );
    expect(calls.some((c) => argvStartsWith(c.args, "push"))).toBe(false);
  });
});

describe("commit-work: pathspec-limited commit", () => {
  test("commit argv carries the sorted pathspec after `--` + the literal-pathspecs env; staged read is --no-renames", async () => {
    const { d, calls } = deps({
      files: ["b.txt", "a.txt"],
      rules: successRules({ stagedNames: ["a.txt", "b.txt"] }),
    });
    const { code } = await runForTest(["feat: two", "--session-id", "s1"], d);
    expect(code).toBe(0);
    const commit = calls.find((c) =>
      argvStartsWith(c.args, "commit", "-F", "-"),
    );
    // `--only` mode: message flags, then `--`, then the exact attributed pathspec.
    expect(commit?.args).toEqual(["commit", "-F", "-", "--", "a.txt", "b.txt"]);
    // Pathspec magic disabled so poisoned-index paths can't smuggle options.
    expect(commit?.env?.GIT_LITERAL_PATHSPECS).toBe("1");
    // The staged-name read forces --no-renames so a rename splits into both halves.
    const diff = calls.find((c) =>
      argvStartsWith(c.args, "diff", "--cached", "--name-only", "-z"),
    );
    expect(diff?.args).toContain("--no-renames");
  });

  test("a rename's A and D halves both ride the pathspec when both are attributed", async () => {
    // With --no-renames a rename reports the new path (A) and old path (D); when
    // both are attributed the pathspec is rename-complete.
    const { d, calls } = deps({
      files: ["dir/new.txt", "dir/old.txt"],
      rules: successRules({ stagedNames: ["dir/new.txt", "dir/old.txt"] }),
    });
    const { code } = await runForTest(
      ["refactor: rename", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(0);
    const commit = calls.find((c) =>
      argvStartsWith(c.args, "commit", "-F", "-"),
    );
    expect(commit?.args).toEqual([
      "commit",
      "-F",
      "-",
      "--",
      "dir/new.txt",
      "dir/old.txt",
    ]);
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

  test("a deletion rides the pathspec even though it is skipped by lint", async () => {
    // doomed.txt is staged as a removal (not on disk) — it must appear in the
    // commit pathspec, which is built from staged NAMES not the lint list.
    const { d, calls } = deps({
      files: ["doomed.txt"],
      rules: successRules({ stagedNames: ["doomed.txt"] }),
    });
    const { code } = await runForTest(
      ["chore: drop doomed", "--session-id", "s1"],
      d,
    );
    expect(code).toBe(0);
    const commit = calls.find((c) =>
      argvStartsWith(c.args, "commit", "-F", "-"),
    );
    expect(commit?.args).toEqual(["commit", "-F", "-", "--", "doomed.txt"]);
  });

  test("git commit non-zero maps to a commit-failure envelope preserving git's stderr", async () => {
    // Mid-merge partial-commit refusal is the live specimen.
    const mergeRefusal = "fatal: cannot do a partial commit during a merge";
    const { d, calls } = deps({
      files: ["a.txt"],
      rules: [
        {
          when: (a) => argvStartsWith(a, "commit", "-F", "-"),
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
    expect(parsed.error).toBe(`git commit failed: ${mergeRefusal}`);
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
      files: ["a.txt"],
      rules: successRules({ stagedNames: [] }),
    },
    {
      name: "git commit failure",
      argv: ["feat: fails", "--session-id", "s1"],
      files: ["a.txt"],
      rules: [
        {
          when: (a: string[]) => argvStartsWith(a, "commit", "-F", "-"),
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
      expect(code).toBe(1);
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
