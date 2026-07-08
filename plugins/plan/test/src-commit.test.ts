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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  acquirePlanCommitGuard,
  autoCommitFromInvocation,
  buildMessageWithTrailers,
  buildSubject,
  CommitFailed,
} from "../src/commit.ts";
import { acquireCommitWorkLock } from "../src/flock.ts";
import {
  type InProgressOp,
  type PlanVcs,
  realGitVcs,
  resetVcs,
  setVcs,
} from "../src/vcs.ts";
import { armInProgressOp } from "./fake-vcs.ts";
import {
  realCommitCount as commitCount,
  fakeDirtyPaths,
  firstJsonPayload,
  git,
  gitBaseline,
  gitLogCount,
  realHeadSha as headSha,
  runCli,
  SLOW_ENABLED,
  scaffoldEpic,
  scaffoldPlanYaml,
  seedRuntime,
  seedState,
  withProject,
  withTmpdir,
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

// ---------------------------------------------------------------------------
// Merge-window guard + commit-work serialization (the fn-1193 destruction window).
// ---------------------------------------------------------------------------
//
// acquirePlanCommitGuard probes the STATE repo for an in-progress op (refuse
// before writing, lock-free) then holds the shared commit-work flock across the
// write -> commit window. This block drives the guard directly through a stub
// facade + a real tmpdir lock file; the per-verb block below arms the fake VCS's
// in-progress probe and proves every mutating verb refuses.

describe("acquirePlanCommitGuard", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "planctl-guard-"));
  });
  afterEach(() => {
    resetVcs();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A facade reporting a fixed in-progress op + lock path — the two methods the
   * guard consults — delegating everything else to the real facade. */
  function stubVcs(op: InProgressOp, lockPath: string): PlanVcs {
    return {
      ...realGitVcs,
      inProgressOp: () => op,
      commitWorkLockPath: () => lockPath,
    };
  }

  test("an in-progress op refuses BEFORE acquiring the lock (lock-free)", () => {
    const lockPath = join(dir, "cw.lock");
    setVcs(stubVcs("merge", lockPath));
    const guard = acquirePlanCommitGuard("/any/state/repo");
    expect(guard.kind).toBe("refused");
    if (guard.kind === "refused") {
      expect(guard.detail).toBe("operation: merge");
      expect(guard.message).toContain("merge");
    }
    // The refusal never touched the lock — the deconflict-session case where the
    // caller HOLDS the lock must not block on it.
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a clean repo acquires the lock; release frees it for the next acquirer", () => {
    const lockPath = join(dir, "cw.lock");
    setVcs(stubVcs("none", lockPath));
    const guard = acquirePlanCommitGuard("/any/state/repo");
    expect(guard.kind).toBe("locked");
    // While held, a fresh non-blocking acquire on the SAME path is contended.
    const contended = acquireCommitWorkLock(lockPath, 0);
    expect(contended.kind).toBe("timeout");
    if (guard.kind === "locked") {
      guard.release();
    }
    // After release, the lock is free again.
    const after = acquireCommitWorkLock(lockPath, 200);
    expect(after.kind).toBe("acquired");
    if (after.kind === "acquired") {
      after.lock.release();
    }
  });

  test("a lock held past the deadline refuses (retryable), never proceeds", () => {
    const lockPath = join(dir, "cw.lock");
    const holder = acquireCommitWorkLock(lockPath, 200);
    expect(holder.kind).toBe("acquired");
    try {
      setVcs(stubVcs("none", lockPath));
      const guard = acquirePlanCommitGuard("/any/state/repo", 30);
      expect(guard.kind).toBe("refused");
      if (guard.kind === "refused") {
        expect(guard.detail).toBe("operation: commit-work-lock");
      }
    } finally {
      if (holder.kind === "acquired") {
        holder.lock.release();
      }
    }
  });

  test("an environmental acquire failure degrades to an unlocked proceed + stderr note", () => {
    // A lock path whose parent dir does not exist → openSync ENOENT → environmental.
    const bogus = join(dir, "no-such-subdir", "cw.lock");
    setVcs(stubVcs("none", bogus));
    let stderr = "";
    const priorWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown): boolean => {
      stderr += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    }) as typeof process.stderr.write;
    let guard: ReturnType<typeof acquirePlanCommitGuard>;
    try {
      guard = acquirePlanCommitGuard("/any/state/repo");
    } finally {
      process.stderr.write = priorWrite;
    }
    expect(guard.kind).toBe("locked");
    expect(stderr).toContain("proceeding unlocked");
    // The degraded release is a harmless no-op.
    if (guard.kind === "locked") {
      expect(() => guard.release()).not.toThrow();
    }
  });
});

// Every mutating verb refuses a mid-operation state repo: nothing written, no
// commit, a typed retryable merge_in_progress envelope naming the operation. The
// fake VCS's armInProgressOp drives the probe; withProject/seedState build the
// state repo (a real `.git/` so the commit-work lock is a real file the probe
// never reaches).
describe("mutating verbs refuse a mid-operation state repo", () => {
  const getProj = withProject("planctl-mg-");
  const getTmp = withTmpdir("planctl-mg-done-");

  /** The converged plan-family error sub-object off a refused verb's envelope. */
  function refusalError(output: string): Record<string, unknown> {
    const payload = firstJsonPayload(output);
    expect(payload.success).toBe(false);
    return payload.error as Record<string, unknown>;
  }

  test("scaffold refuses, writing no plan file and recording no commit", () => {
    const proj = getProj();
    armInProgressOp(proj.root, "merge");
    const before = gitLogCount(proj.root);
    const planPath = join(proj.root, "_mg_scaffold.yaml");
    writeFileSync(
      planPath,
      scaffoldPlanYaml({ title: "Blocked", nTasks: 1 }),
      "utf-8",
    );

    const r = runCli(["scaffold", "--file", planPath], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).not.toBe(0);
    const err = refusalError(r.output);
    expect(err.code).toBe("merge_in_progress");
    expect(JSON.stringify(err.details)).toContain("operation: merge");
    expect(gitLogCount(proj.root)).toBe(before);
    expect(fakeDirtyPaths(proj.root)).toEqual([]);
  });

  test("epic create refuses (cherry-pick), no commit", () => {
    const proj = getProj();
    armInProgressOp(proj.root, "cherry-pick");
    const before = gitLogCount(proj.root);

    const r = runCli(["epic", "create", "--title", "Blocked epic"], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).not.toBe(0);
    const err = refusalError(r.output);
    expect(err.code).toBe("merge_in_progress");
    expect(JSON.stringify(err.details)).toContain("operation: cherry-pick");
    expect(gitLogCount(proj.root)).toBe(before);
    expect(fakeDirtyPaths(proj.root)).toEqual([]);
  });

  test("refine-apply refuses (revert), no commit", () => {
    const proj = getProj();
    const { epicId } = scaffoldEpic(proj, { nTasks: 1 });
    armInProgressOp(proj.root, "revert");
    const before = gitLogCount(proj.root);
    const deltaPath = join(proj.root, "_mg_delta.yaml");
    writeFileSync(
      deltaPath,
      "add_tasks:\n  - title: Added\n    tier: medium\n    model: opus\n" +
        "    spec: |\n      ## Description\n      x\n\n      ## Acceptance\n" +
        "      - [ ] x\n\n      ## Done summary\n\n      ## Evidence\n",
      "utf-8",
    );

    const r = runCli(["refine-apply", epicId, "--file", deltaPath], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).not.toBe(0);
    const err = refusalError(r.output);
    expect(err.code).toBe("merge_in_progress");
    expect(JSON.stringify(err.details)).toContain("operation: revert");
    expect(gitLogCount(proj.root)).toBe(before);
    expect(fakeDirtyPaths(proj.root)).toEqual([]);
  });

  test("assign-cells refuses (rebase), no commit", () => {
    const proj = getProj();
    const { epicId, taskIds } = scaffoldEpic(proj, { nTasks: 1 });
    armInProgressOp(proj.root, "rebase");
    const before = gitLogCount(proj.root);
    const cellsPath = join(proj.root, "_mg_cells.yaml");
    writeFileSync(
      cellsPath,
      `cells:\n  - task_id: ${taskIds[0]}\n    tier: medium\n    model: opus\n` +
        "    label_source: heuristic-default\n" +
        "selection:\n  harness: none\n  model: none\n  config_hash: h\n" +
        "  input_hash: i\n  outcome: ok\n",
      "utf-8",
    );

    const r = runCli(["assign-cells", epicId, "--file", cellsPath], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).not.toBe(0);
    const err = refusalError(r.output);
    expect(err.code).toBe("merge_in_progress");
    expect(JSON.stringify(err.details)).toContain("operation: rebase");
    expect(gitLogCount(proj.root)).toBe(before);
    expect(fakeDirtyPaths(proj.root)).toEqual([]);
  });

  test("done refuses (sequencer), leaving the runtime overlay untouched", () => {
    const root = getTmp();
    const [, taskIds] = seedState(root, { epicId: "fn-1-mg", nTasks: 1 });
    const taskId = taskIds[0] as string;
    seedRuntime(root, taskId, {
      status: "in_progress",
      assignee: "test@example.com",
    });
    gitBaseline(root);
    armInProgressOp(root, "sequencer");
    const before = gitLogCount(root);

    const r = runCli(["done", taskId, "--summary", "shipped"], {
      cwd: root,
      env: { CLAUDE_CODE_SESSION_ID: "test-mg-done" },
    });
    expect(r.code).not.toBe(0);
    const err = refusalError(r.output);
    expect(err.code).toBe("merge_in_progress");
    expect(JSON.stringify(err.details)).toContain("operation: sequencer");
    expect(gitLogCount(root)).toBe(before);
    expect(fakeDirtyPaths(root)).toEqual([]);
    // The overlay is byte-untouched — no half-stamped done for the daemon to fold.
    const overlay = JSON.parse(
      readFileSync(
        join(root, ".keeper", "state", "tasks", `${taskId}.state.json`),
        "utf-8",
      ),
    ) as Record<string, unknown>;
    expect(overlay.status).toBe("in_progress");
  });
});

// ---------------------------------------------------------------------------
// EAFP backstop (real git, slow tier): the probe is best-effort, so a commit that
// slips past a STALE probe into a real merge window must still classify as the
// retryable merge_in_progress class — never the contention-retry arm — and the
// real facade's probe reports the same op the pre-write guard reads.
// ---------------------------------------------------------------------------

describe.skipIf(!SLOW_ENABLED)("merge-window EAFP (real git)", () => {
  test("a real partial-commit refusal classifies as merge_in_progress", () => {
    const rel = makeDirty(".keeper/epics/eafp_marker.txt");
    const seedSha = git(["rev-parse", "HEAD"], repo).trim();
    // A live MERGE_HEAD makes git refuse a pathspec (partial) commit exactly as
    // the shared-checkout merge window does.
    writeFileSync(join(repo, ".git", "MERGE_HEAD"), `${seedSha}\n`, "utf-8");

    let caught: CommitFailed | null = null;
    try {
      autoCommitFromInvocation({
        files: [rel],
        op: "scaffold",
        target: "fn-1-eafp",
        subject: "chore(plan): scaffold fn-1-eafp",
        state_repo: repo,
        repo_root: repo,
      });
    } catch (e) {
      caught = e as CommitFailed;
    }
    expect(caught).toBeInstanceOf(CommitFailed);
    expect((caught as CommitFailed).error).toBe("merge_in_progress");
    expect((caught as CommitFailed).extra.operation).toBe("merge");
    expect((caught as CommitFailed).detail).toContain(
      "partial commit during a merge",
    );
  });

  test("the real facade's probe + guard refuse a live MERGE_HEAD", () => {
    const seedSha = git(["rev-parse", "HEAD"], repo).trim();
    writeFileSync(join(repo, ".git", "MERGE_HEAD"), `${seedSha}\n`, "utf-8");
    // src-commit runs on the real facade by default; be explicit.
    resetVcs();
    expect(realGitVcs.inProgressOp(repo)).toBe("merge");
    const guard = acquirePlanCommitGuard(repo);
    expect(guard.kind).toBe("refused");
    if (guard.kind === "refused") {
      expect(guard.detail).toBe("operation: merge");
    }
  });
});
