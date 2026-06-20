// Unit tests for src/commit.ts — the committing seam. Ports the assertion set
// of tests/test_commit.py against real git tmp repos: no-op paths (files
// null/empty/clean-tree), happy-path sha shape + subject + forensic trailers,
// the Session-Id trailer (present/omitted/none), out-of-scope file isolation,
// state_repo/subject/missing-repo failure shapes, sequential commits, and the
// contention-retry classification incl. fresh-repo "unknown" prev-sha.
//
// buildSubject + buildMessageWithTrailers are pinned directly (byte-exact
// subject/trailer parity with Python).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  autoCommitFromInvocation,
  buildMessageWithTrailers,
  buildSubject,
  CommitFailed,
} from "../src/commit.ts";

// ---------------------------------------------------------------------------
// git tmp-repo harness + assertion helpers (the bun analogue of conftest's
// _git_commit_count / _git_head_* helpers).
// ---------------------------------------------------------------------------

let repo: string;

function git(args: string[], cwd: string): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
}

function commitCount(cwd: string): number {
  const proc = Bun.spawnSync(["git", "rev-list", "--count", "HEAD"], { cwd });
  if (proc.exitCode !== 0) {
    return 0; // fresh repo, no commits yet
  }
  return Number.parseInt(proc.stdout.toString().trim(), 10);
}

function headSha(cwd: string): string {
  return git(["rev-parse", "HEAD"], cwd).trim();
}

function headMessage(cwd: string): string {
  return git(["log", "-1", "--format=%B"], cwd).trim();
}

function headFiles(cwd: string): string[] {
  return git(["show", "--name-only", "--format=", "HEAD"], cwd)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function makeDirty(rel: string, content = "dirty\n"): string {
  const target = join(repo, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return rel;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "planctl-commit-test-"));
  git(["init", "-q"], repo);
  git(["config", "user.email", "test@planctl.local"], repo);
  git(["config", "user.name", "Planctl Test"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
  // An initial commit so HEAD exists for the happy-path tests.
  writeFileSync(join(repo, "README"), "seed\n");
  git(["add", "README"], repo);
  git(["commit", "-q", "-m", "seed"], repo);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// buildSubject / buildMessageWithTrailers — byte-exact composition.
// ---------------------------------------------------------------------------

describe("buildSubject", () => {
  test("no detail: chore(plan): <verb> <id>", () => {
    expect(buildSubject("done", "fn-1-x.1")).toBe("chore(plan): done fn-1-x.1");
  });

  test("with detail: em-dash (U+2014) join, collapsed newlines, trimmed", () => {
    expect(buildSubject("scaffold", "fn-2-y", "  added\nthings  ")).toBe(
      "chore(plan): scaffold fn-2-y — added things",
    );
  });
});

describe("buildMessageWithTrailers", () => {
  test("stamps the exact uuid; omits Session-Id when falsy", () => {
    const sid = "abcdabcd-1234-4567-89ab-cdefcdefcdef";
    const withSid = buildMessageWithTrailers(
      "chore(plan): scaffold fn-1",
      "scaffold",
      "fn-1",
      "deadbeef",
      sid,
    );
    expect(withSid.trimEnd().endsWith(`Session-Id: ${sid}`)).toBe(true);

    const withoutSid = buildMessageWithTrailers(
      "chore(plan): scaffold fn-1",
      "scaffold",
      "fn-1",
      "deadbeef",
      null,
    );
    expect(withoutSid.includes("Session-Id:")).toBe(false);

    const dflt = buildMessageWithTrailers(
      "chore(plan): scaffold fn-1",
      "scaffold",
      "fn-1",
      "deadbeef",
    );
    expect(dflt.includes("Session-Id:")).toBe(false);
  });

  test("subject, blank line, then trailers in order", () => {
    const msg = buildMessageWithTrailers(
      "chore(plan): done fn-1.1",
      "done",
      "fn-1.1",
      "cafef00d",
    );
    expect(msg).toBe(
      "chore(plan): done fn-1.1\n\n" +
        "Planctl-Op: done\n" +
        "Planctl-Target: fn-1.1\n" +
        "Planctl-Prev-Op: cafef00d\n",
    );
  });
});

// ---------------------------------------------------------------------------
// no-op paths.
// ---------------------------------------------------------------------------

describe("autoCommitFromInvocation no-op paths", () => {
  test("files=null is a no-op return — no git ops", () => {
    const pre = commitCount(repo);
    const sha = autoCommitFromInvocation({
      files: null,
      op: "show",
      target: "fn-1-noop",
      subject: null,
      state_repo: repo,
      repo_root: repo,
    });
    expect(sha).toBeNull();
    expect(commitCount(repo)).toBe(pre);
  });

  test("files=[] is a no-op return", () => {
    const pre = commitCount(repo);
    const sha = autoCommitFromInvocation({
      files: [],
      op: "claim",
      target: "fn-1-noop.1",
      subject: "chore(plan): claim fn-1-noop.1",
      state_repo: repo,
      repo_root: repo,
    });
    expect(sha).toBeNull();
    expect(commitCount(repo)).toBe(pre);
  });

  test("files listed but tree clean for them — no-op (no empty commit)", () => {
    const tracked = "some_clean_file.txt";
    makeDirty(tracked, "clean\n");
    git(["add", tracked], repo);
    git(["commit", "-q", "-m", "prep clean file"], repo);

    const pre = commitCount(repo);
    const sha = autoCommitFromInvocation({
      files: [tracked],
      op: "noop-clean",
      target: "fn-1-noop",
      subject: "chore(plan): noop-clean fn-1-noop",
      state_repo: repo,
      repo_root: repo,
    });
    expect(sha).toBeNull();
    expect(commitCount(repo)).toBe(pre);
  });
});

// ---------------------------------------------------------------------------
// happy path.
// ---------------------------------------------------------------------------

describe("autoCommitFromInvocation happy path", () => {
  test("dirty files → commit lands, returns long sha, payload subject + trailers", () => {
    const rel = makeDirty(".planctl/epics/test_marker.txt");
    const pre = commitCount(repo);
    const subject = "chore(plan): approve fn-587-x";

    const sha = autoCommitFromInvocation({
      files: [rel],
      op: "approve",
      target: "fn-587-x",
      subject,
      state_repo: repo,
      repo_root: repo,
    });

    expect(sha).not.toBeNull();
    expect((sha as string).length).toBe(40);
    expect(commitCount(repo)).toBe(pre + 1);
    expect(headSha(repo)).toBe(sha as string);
    const msg = headMessage(repo);
    expect(msg.split("\n")[0]).toBe(subject);
    expect(msg).toContain("Planctl-Op: approve");
    expect(msg).toContain("Planctl-Target: fn-587-x");
    expect(msg).toContain("Planctl-Prev-Op: ");
    expect(headFiles(repo)).toContain(rel);
  });

  test("session_id stamps Session-Id trailer verbatim alongside the forensics", () => {
    const rel = makeDirty(".planctl/epics/session_marker.txt");
    const sid = "11111111-2222-4333-8444-555555555555";
    const sha = autoCommitFromInvocation({
      files: [rel],
      op: "scaffold",
      target: "fn-695-x",
      subject: "chore(plan): scaffold fn-695-x",
      session_id: sid,
      state_repo: repo,
      repo_root: repo,
    });
    expect(sha).not.toBeNull();
    const msg = headMessage(repo);
    expect(msg).toContain(`Session-Id: ${sid}`);
    expect(msg).toContain("Planctl-Op: scaffold");
    expect(msg).toContain("Planctl-Target: fn-695-x");
    expect(msg).toContain("Planctl-Prev-Op: ");
  });

  test("missing session_id key → Session-Id omitted, commit still lands", () => {
    const rel = makeDirty(".planctl/epics/no_session_marker.txt");
    const pre = commitCount(repo);
    const sha = autoCommitFromInvocation({
      files: [rel],
      op: "scaffold",
      target: "fn-695-y",
      subject: "chore(plan): scaffold fn-695-y",
      state_repo: repo,
      repo_root: repo,
    });
    expect(sha).not.toBeNull();
    expect(commitCount(repo)).toBe(pre + 1);
    const msg = headMessage(repo);
    expect(msg.includes("Session-Id:")).toBe(false);
    expect(msg).toContain("Planctl-Op: scaffold");
    expect(msg).toContain("Planctl-Target: fn-695-y");
  });

  test("explicit session_id=null → Session-Id omitted", () => {
    const rel = makeDirty(".planctl/epics/none_session_marker.txt");
    const sha = autoCommitFromInvocation({
      files: [rel],
      op: "refine-apply",
      target: "fn-695-z",
      subject: "chore(plan): refine-apply fn-695-z",
      session_id: null,
      state_repo: repo,
      repo_root: repo,
    });
    expect(sha).not.toBeNull();
    expect(headMessage(repo).includes("Session-Id:")).toBe(false);
  });

  test("out-of-scope dirty file is NOT staged and stays dirty", () => {
    const inScope = makeDirty(".planctl/epics/scope_in.txt");
    const outScope = makeDirty(".planctl/epics/scope_out.txt");
    const sha = autoCommitFromInvocation({
      files: [inScope],
      op: "approve",
      target: "fn-587-y",
      subject: "chore(plan): approve fn-587-y",
      state_repo: repo,
      repo_root: repo,
    });
    expect(sha).not.toBeNull();
    const files = headFiles(repo);
    expect(files).toContain(inScope);
    expect(files).not.toContain(outScope);
    const status = git(["status", "--porcelain", "--", outScope], repo);
    expect(status.trim().length).toBeGreaterThan(0);
  });

  test("fresh repo (no HEAD): prev-sha sentinel is 'unknown'", () => {
    // A brand-new repo with no initial commit — currentHead must render
    // "unknown" rather than crash, and the commit still lands.
    const fresh = mkdtempSync(join(tmpdir(), "planctl-fresh-"));
    git(["init", "-q"], fresh);
    git(["config", "user.email", "t@p.local"], fresh);
    git(["config", "user.name", "T"], fresh);
    git(["config", "commit.gpgsign", "false"], fresh);
    try {
      mkdirSync(join(fresh, ".planctl", "epics"), { recursive: true });
      writeFileSync(join(fresh, ".planctl", "epics", "first.txt"), "x\n");
      const sha = autoCommitFromInvocation({
        files: [".planctl/epics/first.txt"],
        op: "init",
        target: "proj",
        subject: "chore(plan): init proj",
        state_repo: fresh,
        repo_root: fresh,
      });
      expect(sha).not.toBeNull();
      expect(git(["log", "-1", "--format=%B"], fresh)).toContain(
        "Planctl-Prev-Op: unknown",
      );
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// state_repo / subject fallbacks + failures.
// ---------------------------------------------------------------------------

describe("autoCommitFromInvocation failure shapes", () => {
  test("missing state_repo but repo_root present → works + warns to stderr", () => {
    const rel = makeDirty(".planctl/epics/fallback.txt");
    const sha = autoCommitFromInvocation({
      files: [rel],
      op: "approve",
      target: "fn-587-fb",
      subject: "chore(plan): approve fn-587-fb",
      repo_root: repo,
    });
    expect(sha).not.toBeNull();
  });

  test("no state_repo and no repo_root → CommitFailed(missing_state_repo)", () => {
    let caught: CommitFailed | null = null;
    try {
      autoCommitFromInvocation({
        files: [".planctl/epics/no_repo.txt"],
        op: "approve",
        target: "fn-587-nr",
        subject: "chore(plan): approve fn-587-nr",
      });
    } catch (e) {
      caught = e as CommitFailed;
    }
    expect(caught).toBeInstanceOf(CommitFailed);
    expect((caught as CommitFailed).error).toBe("missing_state_repo");
  });

  test("missing subject → CommitFailed(missing_subject)", () => {
    const rel = makeDirty(".planctl/epics/no_subject.txt");
    let caught: CommitFailed | null = null;
    try {
      autoCommitFromInvocation({
        files: [rel],
        op: "approve",
        target: "fn-587-ns",
        state_repo: repo,
        repo_root: repo,
      });
    } catch (e) {
      caught = e as CommitFailed;
    }
    expect(caught).toBeInstanceOf(CommitFailed);
    expect((caught as CommitFailed).error).toBe("missing_subject");
  });
});

// ---------------------------------------------------------------------------
// sequential commits + lock-domain retry classification.
// ---------------------------------------------------------------------------

describe("autoCommitFromInvocation sequential + retry", () => {
  test("two back-to-back commits both land with distinct shas", () => {
    const rel = makeDirty(".planctl/epics/seq1.txt");
    const sha1 = autoCommitFromInvocation({
      files: [rel],
      op: "approve",
      target: "fn-587-l1",
      subject: "chore(plan): approve fn-587-l1",
      state_repo: repo,
      repo_root: repo,
    });
    expect(sha1).not.toBeNull();
    const rel2 = makeDirty(".planctl/epics/seq2.txt");
    const sha2 = autoCommitFromInvocation({
      files: [rel2],
      op: "approve",
      target: "fn-587-l2",
      subject: "chore(plan): approve fn-587-l2",
      state_repo: repo,
      repo_root: repo,
    });
    expect(sha2).not.toBeNull();
    expect(sha2).not.toBe(sha1);
  });

  test("stale index.lock cleared on first backoff → bounded retry commits", () => {
    const rel = makeDirty(".planctl/epics/contend.txt");
    const pre = commitCount(repo);
    const lockFile = join(repo, ".git", "index.lock");
    writeFileSync(lockFile, ""); // git add will refuse: "File exists"

    const backoffs: number[] = [];
    const sleep = (_ms: number): void => {
      backoffs.push(_ms);
      // First backoff: clear the contention so the next attempt succeeds.
      try {
        unlinkSync(lockFile);
      } catch {
        // already cleared
      }
    };

    const sha = autoCommitFromInvocation(
      {
        files: [rel],
        op: "approve",
        target: "fn-640-retry",
        subject: "chore(plan): approve fn-640-retry",
        state_repo: repo,
        repo_root: repo,
      },
      sleep,
    );

    expect(sha).not.toBeNull();
    expect((sha as string).length).toBe(40);
    expect(commitCount(repo)).toBe(pre + 1);
    expect(backoffs.length).toBeGreaterThanOrEqual(1);
  });

  test("persistent index.lock across all attempts → CommitFailed(commit_contended)", () => {
    const rel = makeDirty(".planctl/epics/exhaust.txt");
    const lockFile = join(repo, ".git", "index.lock");
    writeFileSync(lockFile, "");
    const sleep = (_ms: number): void => {
      // never clear the lock — every stage attempt fails with "File exists"
    };

    let caught: CommitFailed | null = null;
    try {
      autoCommitFromInvocation(
        {
          files: [rel],
          op: "approve",
          target: "fn-640-exhaust",
          subject: "chore(plan): approve fn-640-exhaust",
          state_repo: repo,
          repo_root: repo,
        },
        sleep,
      );
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
});
