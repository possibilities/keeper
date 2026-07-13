/**
 * Unit tests for the dep-free `~/docs` Stop-hook pusher (fn-885 `.2`), de-gitted
 * for fn-904 `.3`: ZERO real git. `pushDocs` and `aheadOfUpstream` take an
 * injectable {@link PusherGitRunner}; every test drives them with a recording
 * fake that returns canned exit codes / captured-from-real-git push stderr
 * goldens. The lockfile machinery (acquire/reclaim/release) is real filesystem
 * code with no git, so it still runs against real files under a tmpdir.
 *
 * The thing under test is the pusher's DECISIONS, not git's effect:
 *  - the ahead / no-upstream / mid-op / detached guards each gate the push;
 *  - a push failure is classified + logged to the skip-log and returns cleanly
 *    (never throws — the Stop hook would exit 0);
 *  - `classifyPushError` keys the skip-log class off captured real-git stderr;
 *  - a live/orphaned/stale lock decides skip vs reclaim without touching git.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aheadOfUpstream,
  pushDocs,
} from "../plugins/keeper/plugin/hooks/docs-pusher";
import {
  PUSH_AUTH_FAILED,
  PUSH_NETWORK,
  PUSH_NON_FAST_FORWARD,
} from "./fixtures/git-push-goldens";
import {
  argvStartsWith,
  type FakeGitRule,
  fakePusherGit,
} from "./helpers/fake-git.ts";

let repo: string;
let logFile: string;

/** Find this repo's fake gitdir lockfile path (the pusher derives it via the
 * injected runner's `rev-parse --git-dir`, which our fake answers with `.git`). */
function lockPath(): string {
  return join(repo, ".git", "keeper-push.lock");
}

const testPidAlive = (pid: number): boolean => pid === process.pid;
const findDeadPid = (): number => 999_999;

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "keeper-docs-pusher-")));
  // The pusher resolves the lockfile + skip-log under `<repo>/.git`; the fake
  // runner answers `rev-parse --git-dir` with `.git`, so make the dir real.
  mkdirSync(join(repo, ".git"), { recursive: true });
  logFile = join(repo, "skip.log");
  process.env.KEEPER_DOCS_PUSH_LOG = logFile;
});

afterEach(() => {
  delete process.env.KEEPER_DOCS_PUSH_LOG;
  rmSync(repo, { recursive: true, force: true });
});

/**
 * The standard runner rule set: HEAD attached, mid-op markers absent, `--git-dir`
 * resolves to `.git`. The caller appends ahead-count + push rules.
 */
function baseRules(
  aheadCount: string | null,
  pushOutcome?: { exitCode: number; stdout?: string; stderr?: string },
): FakeGitRule[] {
  const rules: FakeGitRule[] = [
    // mid-op probes: --git-path <marker> resolves a path, but it never exists on
    // disk (the fake returns a path; existsSync(<tmp>/.git/MERGE_HEAD) is false).
    {
      when: (a: string[]) => argvStartsWith(a, "rev-parse", "--git-path"),
      result: { exitCode: 0, stdout: `.git/${"marker"}` },
    },
    // attached HEAD
    {
      when: (a: string[]) => argvStartsWith(a, "symbolic-ref", "-q", "HEAD"),
      result: { exitCode: 0, stdout: "refs/heads/main" },
    },
    // gitdir resolution for the lockfile + skip-log
    {
      when: (a: string[]) => argvStartsWith(a, "rev-parse", "--git-dir"),
      result: { exitCode: 0, stdout: ".git" },
    },
  ];
  if (aheadCount === null) {
    // No upstream → rev-list exits non-zero.
    rules.push({
      when: (a: string[]) => argvStartsWith(a, "rev-list", "--count"),
      result: { exitCode: 128, stdout: "" },
    });
  } else {
    rules.push({
      when: (a: string[]) => argvStartsWith(a, "rev-list", "--count"),
      result: { exitCode: 0, stdout: `${aheadCount}\n` },
    });
  }
  if (pushOutcome) {
    rules.push({
      when: (a: string[]) => argvStartsWith(a, "push", "--no-progress"),
      result: pushOutcome,
    });
  }
  return rules;
}

describe("pushDocs — guards", () => {
  test("pushes when local is ahead of @{u}", () => {
    const fake = fakePusherGit(baseRules("1", { exitCode: 0 }));
    expect(pushDocs(repo, fake.run, testPidAlive)).toBe("pushed");
    // The push was actually issued (decision: push, not skip).
    expect(
      fake.calls.some((c) => argvStartsWith(c.args, "push", "--no-progress")),
    ).toBe(true);
    // Lock released after a successful push.
    expect(existsSync(lockPath())).toBe(false);
  });

  test("no-op when not ahead (0 commits) — no push issued", () => {
    const fake = fakePusherGit(baseRules("0"));
    expect(pushDocs(repo, fake.run, testPidAlive)).toBe("not-ahead");
    expect(fake.calls.some((c) => argvStartsWith(c.args, "push"))).toBe(false);
  });

  test("no-op when there is no upstream — no push issued", () => {
    const fake = fakePusherGit(baseRules(null));
    expect(pushDocs(repo, fake.run, testPidAlive)).toBe("no-upstream");
    expect(aheadOfUpstream(repo, fake.run)).toBeNull();
    expect(fake.calls.some((c) => argvStartsWith(c.args, "push"))).toBe(false);
  });

  test("mid-operation repo skips before any push", () => {
    // A --git-path marker that DOES exist on disk → mid-op guard fires.
    writeFileSync(join(repo, ".git", "MERGE_HEAD"), "deadbeef\n");
    const fake = fakePusherGit([
      {
        when: (a) => argvStartsWith(a, "rev-parse", "--git-path", "MERGE_HEAD"),
        result: { exitCode: 0, stdout: ".git/MERGE_HEAD" },
      },
    ]);
    expect(pushDocs(repo, fake.run, testPidAlive)).toBe("mid-op");
    expect(fake.calls.some((c) => argvStartsWith(c.args, "push"))).toBe(false);
  });

  test("detached HEAD skips before any push", () => {
    const fake = fakePusherGit([
      // mid-op probes all clean (no marker exists)
      {
        when: (a) => argvStartsWith(a, "rev-parse", "--git-path"),
        result: { exitCode: 0, stdout: ".git/marker" },
      },
      // symbolic-ref fails → detached
      {
        when: (a) => argvStartsWith(a, "symbolic-ref", "-q", "HEAD"),
        result: { exitCode: 1, stdout: "" },
      },
    ]);
    expect(pushDocs(repo, fake.run, testPidAlive)).toBe("detached");
    expect(fake.calls.some((c) => argvStartsWith(c.args, "push"))).toBe(false);
  });
});

describe("pushDocs — push failure is classified, logged, and never throws", () => {
  test("non-fast-forward → push-failed, skip-log carries non_fast_forward", () => {
    const fake = fakePusherGit(
      baseRules("1", { exitCode: 1, stderr: PUSH_NON_FAST_FORWARD }),
    );
    let outcome = "";
    expect(() => {
      outcome = pushDocs(repo, fake.run, testPidAlive);
    }).not.toThrow();
    expect(outcome).toBe("push-failed");
    // No rebase / force ever issued — only the single push attempt.
    expect(
      fake.calls.filter((c) => argvStartsWith(c.args, "push")).length,
    ).toBe(1);
    expect(fake.calls.some((c) => argvHasForce(c.args))).toBe(false);
    const log = readFileSync(logFile, "utf8");
    expect(log).toContain("push-skipped");
    expect(log).toContain("class=non_fast_forward");
    // Lock released even on the failure path.
    expect(existsSync(lockPath())).toBe(false);
  });

  test("auth failure → push-failed, skip-log carries auth", () => {
    const fake = fakePusherGit(
      baseRules("2", { exitCode: 128, stderr: PUSH_AUTH_FAILED }),
    );
    expect(pushDocs(repo, fake.run, testPidAlive)).toBe("push-failed");
    expect(readFileSync(logFile, "utf8")).toContain("class=auth");
  });

  test("network failure → push-failed, skip-log carries network", () => {
    const fake = fakePusherGit(
      baseRules("1", { exitCode: 128, stderr: PUSH_NETWORK }),
    );
    expect(pushDocs(repo, fake.run, testPidAlive)).toBe("push-failed");
    expect(readFileSync(logFile, "utf8")).toContain("class=network");
  });
});

describe("pushDocs — lockfile decision (real files, no git)", () => {
  test("a live, fresh lock prevents the push and logs the skip", () => {
    // Pre-create the lock stamped with THIS (live) pid — a live holder blocks.
    writeFileSync(lockPath(), `${process.pid}\n`);
    const fake = fakePusherGit(baseRules("1", { exitCode: 0 }));
    expect(pushDocs(repo, fake.run, testPidAlive)).toBe("locked");
    // No push issued — the lock gated it.
    expect(fake.calls.some((c) => argvStartsWith(c.args, "push"))).toBe(false);
    expect(readFileSync(logFile, "utf8")).toContain("class=locked");
  });

  test("an orphaned lock (holder pid gone) is reclaimed and the push proceeds", () => {
    writeFileSync(lockPath(), `${findDeadPid()}\n`);
    const fake = fakePusherGit(baseRules("1", { exitCode: 0 }));
    expect(pushDocs(repo, fake.run, testPidAlive)).toBe("pushed");
    expect(existsSync(lockPath())).toBe(false);
  });

  test("an orphaned lock older than the staleness threshold is reclaimed", () => {
    // Live pid (liveness alone would NOT reclaim), but mtime past >60s threshold.
    writeFileSync(lockPath(), `${process.pid}\n`);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockPath(), old, old);
    const fake = fakePusherGit(baseRules("1", { exitCode: 0 }));
    expect(pushDocs(repo, fake.run, testPidAlive)).toBe("pushed");
    expect(existsSync(lockPath())).toBe(false);
  });

  test("a released lock allows the next push", () => {
    const fake = fakePusherGit(baseRules("1", { exitCode: 0 }));
    expect(pushDocs(repo, fake.run, testPidAlive)).toBe("pushed");
    expect(existsSync(lockPath())).toBe(false);
    // Second turn: lock is gone, push proceeds again.
    const fake2 = fakePusherGit(baseRules("1", { exitCode: 0 }));
    expect(pushDocs(repo, fake2.run, testPidAlive)).toBe("pushed");
  });
});

/** True when argv contains a force-push flag (must never appear). */
function argvHasForce(args: string[]): boolean {
  return args.some(
    (a) => a === "--force" || a === "-f" || a.startsWith("--force-with-lease"),
  );
}
