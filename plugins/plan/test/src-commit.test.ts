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
import {
  realCommitCount as commitCount,
  git,
  realHeadSha as headSha,
  SLOW_ENABLED,
} from "./harness.ts";

// ---------------------------------------------------------------------------
// git tmp-repo harness + assertion helpers (the bun analogue of conftest's
// _git_commit_count / _git_head_* helpers).
// ---------------------------------------------------------------------------

let repo: string;

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

/** Set `process.env[key]` to `value`, or delete it when `value` is undefined —
 * the save/restore primitive for the GIT_* env-pollution test. */
function setOrDeleteEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

// Real-git repo setup runs ONLY in the slow tier — src-commit drives the REAL
// commit path (realGitVcs) directly (the real index.lock contention-retry +
// prev-sha resolution have no fake-VCS analogue), so it is a genuine real-git
// subject. The pure buildSubject / buildMessageWithTrailers describes below need
// no repo and run in the default tier; the autoCommitFromInvocation describes are
// describe.skipIf(!SLOW_ENABLED) — the wired `bun run test:slow`
// (KEEPER_PLAN_RUN_SLOW=1) is the only command that runs them — and only they
// touch `repo`.
beforeEach(() => {
  if (!SLOW_ENABLED) {
    return;
  }
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
  if (!SLOW_ENABLED || !repo) {
    return;
  }
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

describe.skipIf(!SLOW_ENABLED)("autoCommitFromInvocation no-op paths", () => {
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

describe.skipIf(!SLOW_ENABLED)("autoCommitFromInvocation happy path", () => {
  test("dirty files → commit lands, returns long sha, payload subject + trailers", () => {
    const rel = makeDirty(".keeper/epics/test_marker.txt");
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
    const rel = makeDirty(".keeper/epics/session_marker.txt");
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
    const rel = makeDirty(".keeper/epics/no_session_marker.txt");
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
    const rel = makeDirty(".keeper/epics/none_session_marker.txt");
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
    const inScope = makeDirty(".keeper/epics/scope_in.txt");
    const outScope = makeDirty(".keeper/epics/scope_out.txt");
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
      mkdirSync(join(fresh, ".keeper", "epics"), { recursive: true });
      writeFileSync(join(fresh, ".keeper", "epics", "first.txt"), "x\n");
      const sha = autoCommitFromInvocation({
        files: [".keeper/epics/first.txt"],
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

describe.skipIf(!SLOW_ENABLED)(
  "autoCommitFromInvocation failure shapes",
  () => {
    test("missing state_repo but repo_root present → works + warns to stderr", () => {
      const rel = makeDirty(".keeper/epics/fallback.txt");
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
          files: [".keeper/epics/no_repo.txt"],
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
      const rel = makeDirty(".keeper/epics/no_subject.txt");
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
  },
);

// ---------------------------------------------------------------------------
// sequential commits + lock-domain retry classification.
// ---------------------------------------------------------------------------

describe.skipIf(!SLOW_ENABLED)(
  "autoCommitFromInvocation sequential + retry",
  () => {
    test("two back-to-back commits both land with distinct shas", () => {
      const rel = makeDirty(".keeper/epics/seq1.txt");
      const sha1 = autoCommitFromInvocation({
        files: [rel],
        op: "approve",
        target: "fn-587-l1",
        subject: "chore(plan): approve fn-587-l1",
        state_repo: repo,
        repo_root: repo,
      });
      expect(sha1).not.toBeNull();
      const rel2 = makeDirty(".keeper/epics/seq2.txt");
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
      const rel = makeDirty(".keeper/epics/contend.txt");
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
      const rel = makeDirty(".keeper/epics/exhaust.txt");
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
  },
);

// ---------------------------------------------------------------------------
// worktree-lane isolation — the inherited-GIT_* reroute bug + its fix.
// ---------------------------------------------------------------------------
//
// In worktree-mode autopilot the worker/closer runs IN a lane linked worktree.
// If the environment carries the four worktree-routing GIT_* vars pointed at the
// MAIN repo (inherited from the producer / a git hook), git resolves the repo
// from them and IGNORES the cwd, so a plan-state commit made from inside the lane
// lands on the MAIN branch. vcs.ts strips those vars so the explicit cwd alone
// fixes the branch; this asserts the commit stays on the lane.

describe.skipIf(!SLOW_ENABLED)(
  "autoCommitFromInvocation worktree-lane isolation",
  () => {
    test("inherited main-pointed GIT_* does not pull a lane commit onto the main branch", () => {
      // `repo` (the beforeEach seed) is the MAIN worktree on its default branch.
      const defaultBranch = git(
        ["rev-parse", "--abbrev-ref", "HEAD"],
        repo,
      ).trim();
      const seedSha = headSha(repo);

      // A linked worktree on a lane branch forked off the seed. `worktree add`
      // wants a path that does not already exist, so reserve a unique name then
      // remove the dir before adding.
      const lane = mkdtempSync(join(tmpdir(), "planctl-lane-"));
      rmSync(lane, { recursive: true, force: true });
      const laneBranch = "keeper/epic/fn-972-lane";
      git(["worktree", "add", "-b", laneBranch, lane, "HEAD"], repo);
      try {
        const rel = ".keeper/epics/lane_marker.txt";
        mkdirSync(join(lane, ".keeper", "epics"), { recursive: true });
        writeFileSync(join(lane, rel), "lane\n");

        // Pollute the env with all four worktree-routing vars pointed at MAIN,
        // exactly as an inherited main-worktree context would.
        const prior = {
          GIT_DIR: process.env.GIT_DIR,
          GIT_WORK_TREE: process.env.GIT_WORK_TREE,
          GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
          GIT_COMMON_DIR: process.env.GIT_COMMON_DIR,
        };
        process.env.GIT_DIR = join(repo, ".git");
        process.env.GIT_WORK_TREE = repo;
        process.env.GIT_INDEX_FILE = join(repo, ".git", "index");
        process.env.GIT_COMMON_DIR = join(repo, ".git");

        let sha: string | null;
        try {
          sha = autoCommitFromInvocation({
            files: [rel],
            op: "done",
            target: "fn-972-lane.1",
            subject: "chore(plan): done fn-972-lane.1",
            state_repo: lane,
            repo_root: lane,
          });
        } finally {
          // Restore BEFORE any assertion git() call — the helper inherits env.
          for (const [k, v] of Object.entries(prior)) {
            setOrDeleteEnv(k, v);
          }
        }

        expect(sha).not.toBeNull();
        // The commit advanced the LANE branch...
        expect(
          git(["rev-parse", `refs/heads/${laneBranch}`], repo).trim(),
        ).toBe(sha);
        expect(headSha(lane)).toBe(sha as string);
        expect(commitCount(lane)).toBe(2); // seed + done
        // ...and left the default branch (main) untouched.
        expect(
          git(["rev-parse", `refs/heads/${defaultBranch}`], repo).trim(),
        ).toBe(seedSha);
        expect(commitCount(repo)).toBe(1); // seed only
      } finally {
        git(["worktree", "remove", "--force", lane], repo);
        rmSync(lane, { recursive: true, force: true });
      }
    });
  },
);
