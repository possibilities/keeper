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
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquirePlanCommitGuard,
  buildMessageWithTrailers,
  buildSubject,
} from "../src/commit.ts";
import { acquireCommitWorkLock } from "../src/flock.ts";
import {
  type InProgressOp,
  type PlanVcs,
  realGitVcs,
  resetVcs,
  setVcs,
} from "../src/vcs.ts";
import {
  armInProgressOp,
  armRestoreFailure,
  failNextCommit,
} from "./fake-vcs.ts";
import {
  fakeDirtyPaths,
  firstJsonPayload,
  gitBaseline,
  gitLogCount,
  runCli,
  scaffoldEpic,
  scaffoldPlanYaml,
  seedRuntime,
  seedState,
  withProject,
  withTmpdir,
} from "./harness.ts";

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

// ---------------------------------------------------------------------------
// happy path.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// state_repo / subject fallbacks + failures.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// sequential commits + lock-domain retry classification.
// ---------------------------------------------------------------------------

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
// Commit-failure rollback (fast tier, fake VCS): every mutating verb is a
// working-tree no-op on an auto-commit failure — fresh files unlinked, modified
// files restored to pre-verb bytes, nothing of the verb's left staged — while a
// rollback that itself slips stamps rollback_failed without masking commit_failed.
// The fake models no index, so staged-residue behavior is outside this seam
// (merge-window-rollback.test.ts); here the working-tree diff is the observable.
// ---------------------------------------------------------------------------

describe("mutating verbs roll back on a commit failure", () => {
  const getProj = withProject("planctl-rb-");
  const getTmp = withTmpdir("planctl-rb-done-");

  /** The commit_failed details sub-object — asserts the envelope is the
   * authoritative commit failure, then returns details for rollback inspection. */
  function commitFailedDetails(output: string): Record<string, unknown> {
    const payload = firstJsonPayload(output);
    expect(payload.success).toBe(false);
    expect(payload.error).toBe("commit_failed");
    return payload.details as Record<string, unknown>;
  }

  const DELTA_YAML =
    "add_tasks:\n  - title: Added\n    tier: medium\n    model: opus\n" +
    "    spec: |\n      ## Description\n      x\n\n      ## Acceptance\n" +
    "      - [ ] x\n\n      ## Done summary\n\n      ## Evidence\n";

  test("scaffold: fresh tree unlinked, no orphan files, no staged residue", () => {
    const proj = getProj();
    failNextCommit(proj.root);
    const planPath = join(proj.root, "_rb_scaffold.yaml");
    writeFileSync(
      planPath,
      scaffoldPlanYaml({ title: "Rollback", nTasks: 2 }),
      "utf-8",
    );

    const r = runCli(["scaffold", "--file", planPath], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).not.toBe(0);
    const details = commitFailedDetails(r.output);
    expect(details.rollback_failed).toBeUndefined();
    // The whole minted tree is gone — the working tree equals the pre-verb state.
    expect(fakeDirtyPaths(proj.root)).toEqual([]);
  });

  test("epic create: both fresh files unlinked", () => {
    const proj = getProj();
    failNextCommit(proj.root);

    const r = runCli(["epic", "create", "--title", "Rollback epic"], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).not.toBe(0);
    commitFailedDetails(r.output);
    expect(fakeDirtyPaths(proj.root)).toEqual([]);
  });

  test("refine-apply: fresh tasks unlinked AND existing rewrites restored", () => {
    const proj = getProj();
    const { epicId } = scaffoldEpic(proj, { nTasks: 1 });
    // Clean at the post-scaffold committed snapshot before the failing delta.
    expect(fakeDirtyPaths(proj.root)).toEqual([]);
    failNextCommit(proj.root);
    const deltaPath = join(proj.root, "_rb_delta.yaml");
    writeFileSync(deltaPath, DELTA_YAML, "utf-8");

    const r = runCli(["refine-apply", epicId, "--file", deltaPath], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).not.toBe(0);
    commitFailedDetails(r.output);
    // The fresh task is unlinked and the epic JSON's updated_at bump is reverted,
    // so the tree matches the post-scaffold committed snapshot byte-for-byte.
    expect(fakeDirtyPaths(proj.root)).toEqual([]);
  });

  test("assign-cells: task JSON, epic JSON, and fresh sidecar all restored", () => {
    const proj = getProj();
    const { epicId, taskIds } = scaffoldEpic(proj, { nTasks: 1 });
    failNextCommit(proj.root);
    const cellsPath = join(proj.root, "_rb_cells.yaml");
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
    commitFailedDetails(r.output);
    expect(fakeDirtyPaths(proj.root)).toEqual([]);
  });

  test("done: the three state files restored to pre-done bytes", () => {
    const root = getTmp();
    const [, taskIds] = seedState(root, { epicId: "fn-1-rb", nTasks: 1 });
    const taskId = taskIds[0] as string;
    seedRuntime(root, taskId, {
      status: "in_progress",
      assignee: "test@example.com",
    });
    gitBaseline(root);
    failNextCommit(root);

    const r = runCli(
      ["done", taskId, "--summary", "shipped", "--no-op-reason", "no code"],
      {
        cwd: root,
        env: { CLAUDE_CODE_SESSION_ID: "rb-done" },
      },
    );
    expect(r.code).not.toBe(0);
    commitFailedDetails(r.output);
    expect(fakeDirtyPaths(root)).toEqual([]);
    // The runtime overlay is back to in_progress — no half-stamped done survives.
    const overlay = JSON.parse(
      readFileSync(
        join(root, ".keeper", "state", "tasks", `${taskId}.state.json`),
        "utf-8",
      ),
    ) as Record<string, unknown>;
    expect(overlay.status).toBe("in_progress");
  });

  test("a rollback that itself fails stamps rollback_failed, never masking commit_failed", () => {
    const proj = getProj();
    failNextCommit(proj.root);
    // The index reset fails: the working-tree bytes still restore (real FS) but
    // the unconfirmed unstage reopens the destruction window — surfaced, not silent.
    armRestoreFailure(proj.root);
    const planPath = join(proj.root, "_rb_fail_scaffold.yaml");
    writeFileSync(
      planPath,
      scaffoldPlanYaml({ title: "Rollback fails", nTasks: 1 }),
      "utf-8",
    );

    const r = runCli(["scaffold", "--file", planPath], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).not.toBe(0);
    // commit_failed stays the primary error — rollback_failed only annotates it.
    const details = commitFailedDetails(r.output);
    expect(details.rollback_failed).toBe(true);
    const failedPaths = details.rollback_failed_paths as string[];
    expect(Array.isArray(failedPaths)).toBe(true);
    expect(failedPaths.length).toBeGreaterThan(0);
    // The reopened window is surfaced on stderr, not swallowed.
    expect(r.stderr).toContain("rollback incomplete");
    // The working tree still reverted despite the failed index reset.
    expect(fakeDirtyPaths(proj.root)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// EAFP backstop (real git, slow tier): the probe is best-effort, so a commit that
// slips past a STALE probe into a real merge window must still classify as the
// retryable merge_in_progress class — never the contention-retry arm — and the
// real facade's probe reports the same op the pre-write guard reads.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Commit-failure rollback (real git, slow tier): a real mid-merge partial-commit
// refusal leaves the verb's pathspec staged; the rollback must unstage it, unlink
// the fresh files, and restore the modified files to their pre-verb bytes — while
// the foreign merge state (MERGE_HEAD) is left entirely untouched. The fake VCS
// models no index, so this real `git reset HEAD -- <paths>` mid-merge is the only
// place the staged-residue half of the contract is observable.
// ---------------------------------------------------------------------------
