// The two primitives the durable-id-reservation epic composes: the plan flock
// module's SYNCHRONOUS deadline-bounded commit-work acquire (fast tier, real
// flock(2) on a tmpfile — no git, no subprocess), and the PlanVcs facade's
// in-progress-operation probe + commit-work lock-path derivation (fake tier for
// classification + fast lock-path shape; slow tier for real-git parity).
//
// Fast tier spawns ZERO real git: flock(2) is a pure in-process FFI syscall on a
// plain file, and the probe/lock-path fast tests drive the in-memory fake. The
// real-git classification + daemon lock-path byte-parity live behind
// describe.skipIf(!SLOW_ENABLED) (KEEPER_PLAN_RUN_SLOW).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireCommitWorkLock,
  COMMIT_WORK_LOCK_DEADLINE_MS,
  F_GETFD,
  FD_CLOEXEC,
  fcntl,
  type HeldCommitWorkLock,
} from "../src/flock.ts";
import { realGitVcs } from "../src/vcs.ts";
import {
  armInProgressOp,
  fakeVcs,
  initRepo,
  resetFakeVcs,
} from "./fake-vcs.ts";
import { git, gitQuiet, SLOW_ENABLED } from "./harness.ts";

// ---------------------------------------------------------------------------
// Synchronous commit-work lock acquire — real flock(2), in-process, no git.
// ---------------------------------------------------------------------------

describe("acquireCommitWorkLock", () => {
  let tmpDir: string;
  const held: HeldCommitWorkLock[] = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "planctl-flock-"));
  });
  afterEach(() => {
    // Release any lock a test forgot so a later test never contends a leak.
    while (held.length > 0) {
      held.pop()?.release();
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const lockPath = (): string => join(tmpDir, "keeper-commit-work.lock");

  test("fcntl constants are the on-the-wire <fcntl.h> values", () => {
    expect(F_GETFD).toBe(1);
    expect(FD_CLOEXEC).toBe(1);
  });

  test("acquires a free lock; the held fd is close-on-exec", () => {
    const outcome = acquireCommitWorkLock(lockPath(), 5_000);
    expect(outcome.kind).toBe("acquired");
    if (outcome.kind !== "acquired") {
      return;
    }
    held.push(outcome.lock);
    // Independently read the fd's flags back through fcntl(F_GETFD): the epic's
    // risk is a lock fd inherited across a git spawn, so CLOEXEC MUST be set.
    const flags = fcntl(outcome.lock.fd, F_GETFD, 0);
    expect(flags).toBeGreaterThanOrEqual(0);
    expect(flags & FD_CLOEXEC).toBe(FD_CLOEXEC);
  });

  test("release round-trips; a re-acquire after release succeeds; release is idempotent", () => {
    const first = acquireCommitWorkLock(lockPath(), 5_000);
    expect(first.kind).toBe("acquired");
    if (first.kind !== "acquired") {
      return;
    }
    first.lock.release();
    expect(() => first.lock.release()).not.toThrow(); // idempotent

    const second = acquireCommitWorkLock(lockPath(), 5_000);
    expect(second.kind).toBe("acquired");
    if (second.kind === "acquired") {
      second.lock.release();
    }
  });

  test("a free lock is won on the FIRST poll — no sleep", () => {
    // Inject a throwing sleep: an immediate acquire must never reach a backoff.
    const outcome = acquireCommitWorkLock(lockPath(), 5_000, () => {
      throw new Error("must not sleep when the lock is free");
    });
    expect(outcome.kind).toBe("acquired");
    if (outcome.kind === "acquired") {
      outcome.lock.release();
    }
  });

  test("a contended lock TIMES OUT (bounded), never freezes on a blocking acquire", () => {
    const holder = acquireCommitWorkLock(lockPath(), 5_000);
    expect(holder.kind).toBe("acquired");
    if (holder.kind !== "acquired") {
      return;
    }
    held.push(holder.lock);
    // A second acquire of the SAME file (a distinct open-file-description in the
    // same process) contends: the bounded poll must exhaust its tiny deadline and
    // report timeout — never a runaway, never a freeze.
    const start = Date.now();
    const contended = acquireCommitWorkLock(lockPath(), 100);
    const elapsed = Date.now() - start;
    expect(contended.kind).toBe("timeout");
    // It actually WAITED out the deadline (poll-retried) and bounded it. Generous
    // upper bound for CI scheduling jitter.
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(5_000);
  });

  test("an unopenable lock path is ENVIRONMENTAL, never a false timeout", () => {
    // A missing intermediate directory makes openSync ENOENT — that is not
    // contention, so the caller must be able to fail the verb rather than retry.
    const bad = join(tmpDir, "no-such-dir", "keeper-commit-work.lock");
    const outcome = acquireCommitWorkLock(bad, 5_000);
    expect(outcome.kind).toBe("environmental");
    if (outcome.kind === "environmental") {
      expect(outcome.message).toContain(bad);
    }
  });

  test("the default deadline is the 45s the daemon side uses", () => {
    expect(COMMIT_WORK_LOCK_DEADLINE_MS).toBe(45_000);
  });
});

// ---------------------------------------------------------------------------
// Fake facade — in-progress probe classification + lock-path shape (no git).
// ---------------------------------------------------------------------------

describe("fakeVcs.inProgressOp / commitWorkLockPath", () => {
  let root: string;

  beforeEach(() => {
    resetFakeVcs();
    root = mkdtempSync(join(tmpdir(), "planctl-fake-vcs-"));
    initRepo(root);
  });
  afterEach(() => {
    resetFakeVcs();
    rmSync(root, { recursive: true, force: true });
  });

  test("a fresh repo is 'none'", () => {
    expect(fakeVcs.inProgressOp(root)).toBe("none");
  });

  test("each armed in-progress state is reported back", () => {
    for (const op of [
      "merge",
      "cherry-pick",
      "revert",
      "rebase",
      "sequencer",
    ] as const) {
      armInProgressOp(root, op);
      expect(fakeVcs.inProgressOp(root)).toBe(op);
    }
    // Disarming returns to none.
    armInProgressOp(root, "none");
    expect(fakeVcs.inProgressOp(root)).toBe("none");
  });

  test("an unregistered repo reads 'none'", () => {
    expect(fakeVcs.inProgressOp(join(tmpdir(), "never-registered"))).toBe(
      "none",
    );
  });

  test("the lock path is <root>/.git/keeper-commit-work.lock", () => {
    // The fake realpath-normalizes the root (as production does), so compare
    // against the realpath'd expectation, not the raw tmpdir symlink form.
    expect(fakeVcs.commitWorkLockPath(root)).toBe(
      join(realpathSync(root), ".git", "keeper-commit-work.lock"),
    );
  });
});

// ---------------------------------------------------------------------------
// Real git — probe classification for each in-progress state + daemon lock-path
// byte-parity. Slow tier only (spawns the git binary).
// ---------------------------------------------------------------------------

describe.skipIf(!SLOW_ENABLED)("realGitVcs (real git)", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "planctl-realvcs-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  /** A real repo with one seed commit on `main`, file `f` = "base\n". */
  function seedRepo(name: string): string {
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    git(["init", "-q"], dir); // isolation config pins identity + init.defaultBranch=main
    writeFileSync(join(dir, "f"), "base\n");
    git(["add", "f"], dir);
    git(["commit", "-qm", "base"], dir);
    return dir;
  }

  function writeCommit(dir: string, content: string, msg: string): void {
    writeFileSync(join(dir, "f"), content);
    git(["commit", "-qam", msg], dir);
  }

  test("a clean repo is 'none'", () => {
    expect(realGitVcs.inProgressOp(seedRepo("clean"))).toBe("none");
  });

  test("a conflicted merge is 'merge'", () => {
    const r = seedRepo("merge");
    git(["checkout", "-q", "-b", "other"], r);
    writeCommit(r, "other\n", "other");
    git(["checkout", "-q", "main"], r);
    writeCommit(r, "mine\n", "mine");
    gitQuiet(["merge", "other"], r); // conflicts, exit 1
    expect(realGitVcs.inProgressOp(r)).toBe("merge");
  });

  test("a conflicted cherry-pick is 'cherry-pick'", () => {
    const r = seedRepo("cp");
    git(["checkout", "-q", "-b", "feat"], r);
    writeCommit(r, "feat\n", "feat");
    const featSha = git(["rev-parse", "HEAD"], r).trim();
    git(["checkout", "-q", "main"], r);
    writeCommit(r, "main2\n", "main2");
    gitQuiet(["cherry-pick", featSha], r); // conflicts
    expect(realGitVcs.inProgressOp(r)).toBe("cherry-pick");
  });

  test("a conflicted revert is 'revert'", () => {
    const r = seedRepo("rv");
    writeCommit(r, "v2\n", "B");
    const bSha = git(["rev-parse", "HEAD"], r).trim();
    writeCommit(r, "v3\n", "C");
    gitQuiet(["revert", "--no-edit", bSha], r); // conflicts
    expect(realGitVcs.inProgressOp(r)).toBe("revert");
  });

  test("a stopped rebase is 'rebase'", () => {
    const r = seedRepo("rb");
    git(["checkout", "-q", "-b", "topic"], r);
    writeCommit(r, "topic\n", "T");
    git(["checkout", "-q", "main"], r);
    writeCommit(r, "main2\n", "M");
    git(["checkout", "-q", "topic"], r);
    gitQuiet(["rebase", "main"], r); // conflicts, stops
    expect(realGitVcs.inProgressOp(r)).toBe("rebase");
  });

  test("a bare sequencer todo (no *_HEAD) is 'sequencer'; a comment-only todo is 'none'", () => {
    const r = seedRepo("seq");
    const seqDir = join(r, ".git", "sequencer");
    const todo = join(seqDir, "todo");
    const sha = git(["rev-parse", "HEAD"], r).trim();
    mkdirSync(seqDir, { recursive: true });
    // A remaining pick with no CHERRY_PICK_HEAD set — the between-picks window.
    writeFileSync(todo, `pick ${sha} base\n`);
    expect(realGitVcs.inProgressOp(r)).toBe("sequencer");
    // A todo that names no remaining operation (comments / blanks only) is inert.
    writeFileSync(todo, "# nothing pending\n\n");
    expect(realGitVcs.inProgressOp(r)).toBe("none");
  });

  test("commitWorkLockPath is byte-identical to the daemon's <git-dir>/keeper-commit-work.lock", () => {
    const r = seedRepo("lockmain");
    // Independent source of truth: derive the git dir directly, then append the
    // fixed leaf — the SAME formula src/worktree-git.ts commitWorkLockPath uses.
    const gitDir = git(
      ["rev-parse", "--path-format=absolute", "--git-dir"],
      r,
    ).trim();
    const expected = `${gitDir}/keeper-commit-work.lock`;
    expect(realGitVcs.commitWorkLockPath(r)).toBe(expected);
  });

  test("a linked worktree keys the lock on its OWN git dir, distinct from the main checkout", () => {
    const r = seedRepo("lockwt");
    const laneDir = join(base, "lane");
    git(["worktree", "add", "-q", "-b", "lane", laneDir, "HEAD"], r);

    const mainLock = realGitVcs.commitWorkLockPath(r);
    const laneLock = realGitVcs.commitWorkLockPath(laneDir);

    // The lane derives against its own per-worktree git dir (independently
    // computed), and that path differs from the main checkout's.
    const laneGitDir = git(
      ["rev-parse", "--path-format=absolute", "--git-dir"],
      laneDir,
    ).trim();
    expect(laneLock).toBe(`${laneGitDir}/keeper-commit-work.lock`);
    expect(laneLock).not.toBe(mainLock);

    git(["worktree", "remove", "--force", laneDir], r);
  });
});
