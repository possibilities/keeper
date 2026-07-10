/**
 * Foundation-primitive tests for the `keeper commit-work` family (epic fn-715
 * task 1). Covers the four shared primitives that the later per-subcommand
 * tasks build on:
 *
 *   - session-id resolution precedence (arg → JOBCTL_SESSION_ID →
 *     CLAUDE_CODE_SESSION_ID → KEEPER_JOB_ID → null);
 *   - the `get_session_dirty_files` attribution reader against a temp git repo
 *     + sandboxed KEEPER_DB (parity output, per-repo fail-open, cwd_repo
 *     resolution, `.keeper/` board-dir client-side exclusion);
 *   - the `flock(2)` FFI primitive (acquire/release; a second concurrent
 *     non-blocking acquire blocks; constants are the on-the-wire values);
 *   - the write-capable git-exec helper draining both streams concurrently.
 *
 * Per the CLAUDE.md isolation rule the DB lives under a per-test tmpdir via the
 * KEEPER_DB override — the user's real `~/.local/state/keeper/keeper.db` is
 * never touched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverSessionFiles,
  getSessionDirtyFiles,
} from "../src/commit-work/attribution";
import { CommitWorkLock, FLOCK_CONSTANTS } from "../src/commit-work/flock";
import { resolveSessionId } from "../src/commit-work/session-id";
import { openDb } from "../src/db";
import { freshDbFile } from "./helpers/template-db";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-commit-work-"));
  dbPath = join(tmpDir, "keeper.db");
  // fn-769 file variant: seeds and the attribution reader open this SAME path
  // across separate connections, so the migrated schema must live on disk.
  // Pre-write the template image once (skipping the ladder); later opens pass
  // `migrate: false` since the file is already at the current schema_version.
  freshDbFile(dbPath).db.close();
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
      resolveSessionId(null, {
        CLAUDE_CODE_SESSION_ID: "claude-sid",
        KEEPER_JOB_ID: "pi-job",
      }),
    ).toBe("claude-sid");
  });

  test("uses KEEPER_JOB_ID for tracked Pi sessions", () => {
    expect(resolveSessionId(null, { KEEPER_JOB_ID: "pi-job" })).toBe("pi-job");
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
  const { db } = openDb(dbPath, { migrate: false });
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
  test("selects the cwd repo and drops .keeper/ board-dir paths client-side", () => {
    const repo = "/repo/d";
    for (const f of [
      "src/a.ts",
      ".keeper/epics/fn-1.json",
      ".keeper/specs/fn-1.md",
      "src/b.ts",
    ]) {
      seedAttribution({ projectDir: repo, sessionId: "s1", filePath: f });
    }

    const files = discoverSessionFiles("s1", "/cwd", {
      dbPath,
      liveDirtyPaths: () =>
        new Set([
          "src/a.ts",
          ".keeper/epics/fn-1.json",
          ".keeper/specs/fn-1.md",
          "src/b.ts",
        ]),
      gitRoot: () => repo,
    });

    // .keeper/ (live board) paths excluded; remaining sorted (parity output
    // order).
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

  test("acquireWithDeadline TIMES OUT (→ null) while another holder owns the lock", async () => {
    const lockPath = join(tmpDir, "keeper-commit-work.lock");
    const held = CommitWorkLock.acquire(lockPath);
    try {
      // Real FFI in-process: the held lock forces the bounded poll to exhaust its
      // (tiny) deadline and degrade to null — never a freeze on a blocking acquire.
      const start = Date.now();
      const timedOut = await CommitWorkLock.acquireWithDeadline(lockPath, 100);
      const elapsed = Date.now() - start;
      expect(timedOut).toBeNull();
      // It actually WAITED out the deadline (poll-retried), and bounded it — not an
      // instant null, not a runaway. Generous upper bound for CI scheduling jitter.
      expect(elapsed).toBeGreaterThanOrEqual(90);
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      held.release();
    }
  });

  test("acquireWithDeadline returns the lock once the holder releases", async () => {
    const lockPath = join(tmpDir, "keeper-commit-work.lock");
    const held = CommitWorkLock.acquire(lockPath);
    // Release shortly; the bounded poll must then acquire well within its deadline.
    setTimeout(() => held.release(), 30);
    const lock = await CommitWorkLock.acquireWithDeadline(lockPath, 5_000);
    expect(lock).not.toBeNull();
    lock?.release();
  });

  test("acquireWithDeadline takes a free lock on the first poll", async () => {
    const lockPath = join(tmpDir, "keeper-commit-work.lock");
    const lock = await CommitWorkLock.acquireWithDeadline(lockPath, 5_000);
    expect(lock).not.toBeNull();
    lock?.release();
    // And a fresh bounded acquire after release succeeds immediately too.
    const again = await CommitWorkLock.acquireWithDeadline(lockPath, 5_000);
    expect(again).not.toBeNull();
    again?.release();
  });
});
