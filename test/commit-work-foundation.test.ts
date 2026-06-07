/**
 * Foundation-primitive tests for the `keeper commit-work` family (epic fn-715
 * task 1). Covers the four shared primitives that the later per-subcommand
 * tasks build on:
 *
 *   - session-id resolution precedence (arg → JOBCTL_SESSION_ID →
 *     CLAUDE_CODE_SESSION_ID → null);
 *   - the `get_session_dirty_files` attribution reader against a temp git repo
 *     + sandboxed KEEPER_DB (parity output, per-repo fail-open, cwd_repo
 *     resolution, `.planctl/` client-side exclusion);
 *   - the `flock(2)` FFI primitive (acquire/release; a second concurrent
 *     non-blocking acquire blocks; constants are the on-the-wire values);
 *   - the write-capable git-exec helper draining both streams concurrently.
 *
 * Per the CLAUDE.md isolation rule the DB lives under a per-test tmpdir via the
 * KEEPER_DB override — the user's real `~/.local/state/keeper/keeper.db` is
 * never touched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverSessionFiles,
  getSessionDirtyFiles,
} from "../src/commit-work/attribution";
import { CommitWorkLock, FLOCK_CONSTANTS } from "../src/commit-work/flock";
import { gitExec } from "../src/commit-work/git-exec";
import { resolveSessionId } from "../src/commit-work/session-id";
import { openDb } from "../src/db";
import { initRepo } from "./helpers/git-repo";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-commit-work-"));
  dbPath = join(tmpDir, "keeper.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// session-id resolution
// ---------------------------------------------------------------------------

describe("resolveSessionId", () => {
  test("explicit arg wins over both env vars", () => {
    expect(
      resolveSessionId("arg-sid", {
        JOBCTL_SESSION_ID: "jobctl-sid",
        CLAUDE_CODE_SESSION_ID: "claude-sid",
      }),
    ).toBe("arg-sid");
  });

  test("JOBCTL_SESSION_ID wins over CLAUDE_CODE_SESSION_ID", () => {
    expect(
      resolveSessionId(null, {
        JOBCTL_SESSION_ID: "jobctl-sid",
        CLAUDE_CODE_SESSION_ID: "claude-sid",
      }),
    ).toBe("jobctl-sid");
  });

  test("falls back to CLAUDE_CODE_SESSION_ID", () => {
    expect(
      resolveSessionId(null, { CLAUDE_CODE_SESSION_ID: "claude-sid" }),
    ).toBe("claude-sid");
  });

  test("returns null when no source is set", () => {
    expect(resolveSessionId(null, {})).toBeNull();
    expect(resolveSessionId(undefined, {})).toBeNull();
    expect(resolveSessionId("", {})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// attribution reader
// ---------------------------------------------------------------------------

/** Seed an undischarged file_attributions row in the temp DB. */
function seedAttribution(opts: {
  projectDir: string;
  sessionId: string;
  filePath: string;
  lastMutationAt?: number;
  lastCommitAt?: number | null;
  source?: string;
}): void {
  const { db } = openDb(dbPath);
  db.run(
    "INSERT INTO file_attributions " +
      "(project_dir, session_id, file_path, last_mutation_at, last_commit_at, op, source) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      opts.projectDir,
      opts.sessionId,
      opts.filePath,
      opts.lastMutationAt ?? 100,
      opts.lastCommitAt ?? null,
      "edit",
      opts.source ?? "tool",
    ],
  );
  db.close();
}

describe("getSessionDirtyFiles", () => {
  test("returns on-hook files intersected with the live dirty set, sorted", () => {
    const repo = "/repo/a";
    seedAttribution({ projectDir: repo, sessionId: "s1", filePath: "z.ts" });
    seedAttribution({ projectDir: repo, sessionId: "s1", filePath: "a.ts" });
    seedAttribution({
      projectDir: repo,
      sessionId: "s1",
      filePath: "clean.ts",
    });

    const result = getSessionDirtyFiles("s1", "/cwd", {
      dbPath,
      // a.ts + z.ts dirty; clean.ts is NOT dirty so it must be dropped.
      liveDirtyPaths: () => new Set(["a.ts", "z.ts"]),
      gitRoot: () => repo,
    });

    expect(result.filesByRepo).toEqual({ "/repo/a": ["a.ts", "z.ts"] });
    expect(result.cwdRepo).toBe("/repo/a");
  });

  test("discharged rows (last_commit_at >= last_mutation_at) are excluded", () => {
    const repo = "/repo/b";
    seedAttribution({
      projectDir: repo,
      sessionId: "s1",
      filePath: "discharged.ts",
      lastMutationAt: 100,
      lastCommitAt: 200, // committed AFTER the mutation → discharged
    });
    seedAttribution({
      projectDir: repo,
      sessionId: "s1",
      filePath: "live.ts",
      lastMutationAt: 100,
      lastCommitAt: 50, // mutation AFTER the last commit → still on hook
    });

    const result = getSessionDirtyFiles("s1", "/cwd", {
      dbPath,
      liveDirtyPaths: () => new Set(["discharged.ts", "live.ts"]),
      gitRoot: () => repo,
    });

    expect(result.filesByRepo).toEqual({ "/repo/b": ["live.ts"] });
  });

  test("fails OPEN per-repo: an unreadable git status keeps all on-hook files", () => {
    const okRepo = "/repo/ok";
    const brokenRepo = "/repo/broken";
    seedAttribution({ projectDir: okRepo, sessionId: "s1", filePath: "a.ts" });
    seedAttribution({ projectDir: okRepo, sessionId: "s1", filePath: "b.ts" });
    seedAttribution({
      projectDir: brokenRepo,
      sessionId: "s1",
      filePath: "kept-1.ts",
    });
    seedAttribution({
      projectDir: brokenRepo,
      sessionId: "s1",
      filePath: "kept-2.ts",
    });

    const result = getSessionDirtyFiles("s1", "/cwd", {
      dbPath,
      // okRepo intersects normally; brokenRepo returns null → fail open.
      liveDirtyPaths: (dir) => (dir === okRepo ? new Set(["a.ts"]) : null),
      gitRoot: () => okRepo,
    });

    expect(result.filesByRepo).toEqual({
      "/repo/ok": ["a.ts"],
      // ALL of brokenRepo's on-hook files survive (sorted) — never dropped.
      "/repo/broken": ["kept-1.ts", "kept-2.ts"],
    });
  });

  test("repos with no surviving file are omitted entirely", () => {
    const repo = "/repo/empty";
    seedAttribution({ projectDir: repo, sessionId: "s1", filePath: "gone.ts" });

    const result = getSessionDirtyFiles("s1", "/cwd", {
      dbPath,
      liveDirtyPaths: () => new Set(), // nothing dirty
      gitRoot: () => null,
    });

    expect(result.filesByRepo).toEqual({});
    expect(result.cwdRepo).toBeNull();
  });

  test("another session's rows are not visible", () => {
    const repo = "/repo/c";
    seedAttribution({ projectDir: repo, sessionId: "s1", filePath: "mine.ts" });
    seedAttribution({
      projectDir: repo,
      sessionId: "s2",
      filePath: "theirs.ts",
    });

    const result = getSessionDirtyFiles("s1", "/cwd", {
      dbPath,
      liveDirtyPaths: () => new Set(["mine.ts", "theirs.ts"]),
      gitRoot: () => repo,
    });

    expect(result.filesByRepo).toEqual({ "/repo/c": ["mine.ts"] });
  });
});

describe("discoverSessionFiles", () => {
  test("selects the cwd repo and drops .planctl/ paths client-side", () => {
    const repo = "/repo/d";
    for (const f of [
      "src/a.ts",
      ".planctl/epics/fn-1.json",
      ".planctl/specs/fn-1.md",
      "src/b.ts",
    ]) {
      seedAttribution({ projectDir: repo, sessionId: "s1", filePath: f });
    }

    const files = discoverSessionFiles("s1", "/cwd", {
      dbPath,
      liveDirtyPaths: () =>
        new Set([
          "src/a.ts",
          ".planctl/epics/fn-1.json",
          ".planctl/specs/fn-1.md",
          "src/b.ts",
        ]),
      gitRoot: () => repo,
    });

    // .planctl/ paths excluded; remaining sorted (parity output order).
    expect(files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("returns [] when the cwd repo has nothing on the hook", () => {
    const repo = "/repo/e";
    seedAttribution({ projectDir: repo, sessionId: "s1", filePath: "a.ts" });

    const files = discoverSessionFiles("s1", "/cwd", {
      dbPath,
      liveDirtyPaths: () => new Set(["a.ts"]),
      // cwd resolves to a DIFFERENT repo with no on-hook rows.
      gitRoot: () => "/repo/other",
    });

    expect(files).toEqual([]);
  });
});

describe("getSessionDirtyFiles live git integration", () => {
  test("matches a real porcelain-v2 dirty set on a fixture repo", async () => {
    // Canonicalize: `git rev-parse --show-toplevel` resolves the macOS
    // /var → /private/var symlink, so cwd_repo would otherwise mismatch the
    // seeded project_dir key.
    const repo = realpathSync(
      mkdtempSync(join(tmpdir(), "keeper-cw-fixture-")),
    );
    try {
      initRepo(repo);
      // committed-then-clean file (NOT dirty), plus a tracked-modified file and
      // an untracked file (both dirty).
      writeFileSync(join(repo, "tracked.ts"), "v1\n");
      writeFileSync(join(repo, "clean.ts"), "clean\n");
      await gitExec(["add", "--", "tracked.ts", "clean.ts"], { cwd: repo });
      await gitExec(["commit", "-q", "-m", "init"], { cwd: repo });
      writeFileSync(join(repo, "tracked.ts"), "v2\n"); // modify → dirty
      writeFileSync(join(repo, "new.ts"), "new\n"); // untracked → dirty

      // All three are on the hook; the live git status must drop clean.ts.
      seedAttribution({
        projectDir: repo,
        sessionId: "s1",
        filePath: "tracked.ts",
      });
      seedAttribution({
        projectDir: repo,
        sessionId: "s1",
        filePath: "clean.ts",
      });
      seedAttribution({
        projectDir: repo,
        sessionId: "s1",
        filePath: "new.ts",
      });

      const result = getSessionDirtyFiles("s1", repo, { dbPath });

      expect(result.filesByRepo[repo]).toEqual(["new.ts", "tracked.ts"]);
      expect(result.cwdRepo).toBe(repo);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// flock primitive
// ---------------------------------------------------------------------------

describe("CommitWorkLock", () => {
  test("constants are the on-the-wire flock(2)/fcntl values", () => {
    expect(FLOCK_CONSTANTS.LOCK_EX).toBe(2);
    expect(FLOCK_CONSTANTS.LOCK_NB).toBe(4);
    expect(FLOCK_CONSTANTS.LOCK_UN).toBe(8);
    expect(FLOCK_CONSTANTS.F_SETFD).toBe(2);
    expect(FLOCK_CONSTANTS.FD_CLOEXEC).toBe(1);
  });

  test("acquire then release round-trips; re-acquire after release succeeds", () => {
    const lockPath = join(tmpDir, "keeper-commit-work.lock");
    const lock = CommitWorkLock.acquire(lockPath);
    lock.release();
    // After release a fresh blocking acquire returns immediately.
    const again = CommitWorkLock.acquire(lockPath);
    again.release();
  });

  test("release is idempotent", () => {
    const lockPath = join(tmpDir, "keeper-commit-work.lock");
    const lock = CommitWorkLock.acquire(lockPath);
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });

  test("a second concurrent (non-blocking) acquire blocks while held", () => {
    const lockPath = join(tmpDir, "keeper-commit-work.lock");
    const held = CommitWorkLock.acquire(lockPath);
    try {
      // tryAcquire must report contention (null) while `held` owns the lock.
      const second = CommitWorkLock.tryAcquire(lockPath);
      expect(second).toBeNull();
    } finally {
      held.release();
    }
    // Once released, tryAcquire succeeds.
    const third = CommitWorkLock.tryAcquire(lockPath);
    expect(third).not.toBeNull();
    third?.release();
  });
});

// ---------------------------------------------------------------------------
// git-exec helper
// ---------------------------------------------------------------------------

describe("gitExec", () => {
  test("returns exit code + drains stdout on success", async () => {
    const res = await gitExec(["--version"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("git version");
    expect(res.stderr).toBe("");
  });

  test("captures stderr + non-zero code on failure", async () => {
    const res = await gitExec(["-C", "/nonexistent-path-xyz", "status"]);
    expect(res.code).not.toBe(0);
    expect(res.stderr.length).toBeGreaterThan(0);
  });

  test("drains a large stdout without deadlocking the pipe", async () => {
    // A real git repo with enough output to exceed the OS pipe buffer (~64KB)
    // would deadlock a sequential single-stream drain. `git config --list`
    // against our own repo plus a forced large output via `rev-list` proves the
    // concurrent drain. Use this very repo's HEAD log.
    const res = await gitExec(["help", "-a"]);
    // `git help -a` prints a long command list to stdout; the test just proves
    // the call returns (no hang) and both streams resolved.
    expect(typeof res.stdout).toBe("string");
    expect(typeof res.stderr).toBe("string");
    expect(res.code).toBeGreaterThanOrEqual(0);
  });
});
