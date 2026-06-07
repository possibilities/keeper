/**
 * Integration tests for `keeper commit-work` (epic fn-715 task 2). Spawns the
 * real CLI (`bun cli/keeper.ts commit-work ...`) against a temp git repo with a
 * sandboxed KEEPER_DB and seeded `file_attributions` rows, so the assertions
 * exercise the FULL stage → lint → commit → push pipeline and its exact stdout
 * byte shape — the compact two-line NDJSON line-oriented consumers depend on.
 *
 * Covered (per the task's test notes):
 *  - `--preview-files` lists the gitignore-filtered session-attributed set;
 *  - the `lint_failed` envelope on an injected ruff failure (compact, verbatim
 *    stderr, exit 1);
 *  - the two-line compact NDJSON on a successful stage→commit→push (a LOCAL
 *    bare remote stands in for origin);
 *  - the no-upstream path (`git rev-parse @{u}` exit 128 → `push -u origin
 *    HEAD`);
 *  - a session deletion stages as a removal (the `-A` pathspec semantics);
 *  - the file_list_too_large guard;
 *  - the forbidden-trailer gate;
 *  - the no-session-id failure;
 *  - the Job-Id trailer append.
 *
 * Per the CLAUDE.md isolation rule every spawn routes through a sandboxed base
 * env overriding ALL FOUR state paths (KEEPER_DB / KEEPER_DEAD_LETTER_DIR /
 * KEEPER_DROP_LOG / KEEPER_RESTORE_FILE) under the per-test tmpDir, and the
 * ambient CLAUDE_CODE_SESSION_ID / JOBCTL_* are cleared so the session id and
 * Job-Id trailer are fully controlled by the test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { sandboxEnv as buildSandboxEnv } from "./helpers/sandbox-env";

const ROOT = realpathSync(join(import.meta.dir, ".."));
const KEEPER_CLI = join(ROOT, "cli", "keeper.ts");

let tmpDir: string;
let dbPath: string;
let repo: string;

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "keeper-commit-work-it-")));
  dbPath = join(tmpDir, "keeper.db");
  repo = realpathSync(mkdtempSync(join(tmpdir(), "keeper-cw-repo-")));
  // Create the schema up front so the readonly attribution open always finds a
  // valid DB — the production invariant (the daemon creates keeper.db at boot;
  // the attribution reader, like the Python `get_session_dirty_files`, treats a
  // truly-absent DB as a hard error, NOT an empty result).
  openDb(dbPath).db.close();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

/**
 * Sandboxed base env (Family A): overrides ALL FIVE keeper state paths under
 * the per-test tmpDir AND clears every ambient session/job id source so the
 * test fully controls attribution + the Job-Id trailer. See
 * `test/helpers/sandbox-env.ts` for the shared core.
 */
function sandboxEnv(
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  return buildSandboxEnv({ tmpDir, dbPath, extra });
}

/** Run a git command in `repo` synchronously; throw on failure. */
function git(...args: string[]): string {
  const res = Bun.spawnSync(["git", "-C", repo, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (res.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${res.stderr.toString().trim()}`,
    );
  }
  return res.stdout.toString();
}

/** Initialize `repo` as a git repo with an identity and an initial commit. */
function initRepo(): void {
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  git("add", "--", "seed.txt");
  git("commit", "-q", "-m", "init");
}

/** Create a bare repo to serve as `origin` and wire it as the remote. */
function addBareOrigin(setUpstream: boolean): string {
  const bare = realpathSync(mkdtempSync(join(tmpdir(), "keeper-cw-bare-")));
  Bun.spawnSync(["git", "init", "-q", "--bare", bare]);
  git("remote", "add", "origin", bare);
  if (setUpstream) {
    git("push", "-q", "-u", "origin", "main");
  }
  return bare;
}

/** Seed an undischarged file_attributions row in the sandboxed DB. */
function seedAttribution(opts: {
  sessionId: string;
  filePath: string;
  lastMutationAt?: number;
  lastCommitAt?: number | null;
}): void {
  const { db } = openDb(dbPath);
  db.run(
    "INSERT INTO file_attributions " +
      "(project_dir, session_id, file_path, last_mutation_at, last_commit_at, op, source) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      repo,
      opts.sessionId,
      opts.filePath,
      opts.lastMutationAt ?? 100,
      opts.lastCommitAt ?? null,
      "edit",
      "tool",
    ],
  );
  db.close();
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn `keeper commit-work <args...>` in `repo` with the sandbox env. */
async function commitWork(
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
): Promise<RunResult> {
  const proc = Bun.spawn(["bun", KEEPER_CLI, "commit-work", ...args], {
    cwd: repo,
    env: sandboxEnv(extraEnv),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

// ---------------------------------------------------------------------------
// no session id
// ---------------------------------------------------------------------------

describe("commit-work: session id", () => {
  test("fails (exit 1) with a compact envelope when no session id resolves", async () => {
    initRepo();
    const res = await commitWork(["--preview-files"]);
    expect(res.code).toBe(1);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("no session id available");
    // Compact single line (no pretty indentation).
    expect(res.stdout).not.toContain("\n  ");
  });
});

// ---------------------------------------------------------------------------
// --preview-files
// ---------------------------------------------------------------------------

describe("commit-work: --preview-files", () => {
  test("lists session-attributed dirty files (pretty), gitignore-filtered, no commit", async () => {
    initRepo();
    writeFileSync(join(repo, "a.txt"), "a\n");
    writeFileSync(join(repo, "b.txt"), "b\n");
    writeFileSync(join(repo, "ignored.log"), "noise\n");
    writeFileSync(join(repo, ".gitignore"), "*.log\n");
    // All four on the hook; .gitignore must drop the untracked *.log.
    for (const f of ["a.txt", "b.txt", "ignored.log"]) {
      seedAttribution({ sessionId: "s1", filePath: f });
    }

    const res = await commitWork(["--preview-files", "--session-id", "s1"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed).toEqual({ success: true, files: ["a.txt", "b.txt"] });
    // Pretty indent=2 shape (the format_output path).
    expect(res.stdout).toBe(
      `${JSON.stringify({ success: true, files: ["a.txt", "b.txt"] }, null, 2)}\n`,
    );
    // No commit landed.
    const log = git("log", "--oneline");
    expect(log.split("\n").filter((l) => l).length).toBe(1);
  });

  test("file_list_too_large guard trips on the post-filter count", async () => {
    initRepo();
    for (let i = 0; i < 5; i++) {
      const f = `f${i}.txt`;
      writeFileSync(join(repo, f), `${i}\n`);
      seedAttribution({ sessionId: "s1", filePath: f });
    }
    const res = await commitWork([
      "--preview-files",
      "--session-id",
      "s1",
      "--max-files",
      "2",
    ]);
    expect(res.code).toBe(1);
    const parsed = JSON.parse(res.stdout);
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
    initRepo();
    for (let i = 0; i < 3; i++) {
      const f = `g${i}.txt`;
      writeFileSync(join(repo, f), `${i}\n`);
      seedAttribution({ sessionId: "s1", filePath: f });
    }
    const res = await commitWork([
      "--preview-files",
      "--session-id",
      "s1",
      "--max-files",
      "0",
    ]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.files.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// message validation
// ---------------------------------------------------------------------------

describe("commit-work: message validation", () => {
  test("requires a message when not previewing", async () => {
    initRepo();
    writeFileSync(join(repo, "a.txt"), "a\n");
    seedAttribution({ sessionId: "s1", filePath: "a.txt" });
    const res = await commitWork(["--session-id", "s1"]);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout).error).toContain(
      "commit message is required",
    );
  });

  test("rejects a multi-line message carrying a forbidden trailer", async () => {
    initRepo();
    writeFileSync(join(repo, "a.txt"), "a\n");
    seedAttribution({ sessionId: "s1", filePath: "a.txt" });
    const res = await commitWork([
      "test: subject\n\nSigned-off-by: x",
      "--session-id",
      "s1",
    ]);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout).error).toContain("forbidden trailer pattern");
  });

  test("a single-line message with a trailer-looking subject is allowed", async () => {
    // The gate fires ONLY on multi-line messages; a single line is exempt.
    initRepo();
    const bare = addBareOrigin(true);
    void bare;
    writeFileSync(join(repo, "a.txt"), "a\n");
    seedAttribution({ sessionId: "s1", filePath: "a.txt" });
    const res = await commitWork(["Job-Id: not-really", "--session-id", "s1"]);
    // Not rejected for the trailer; proceeds to commit (single line).
    const lines = res.stdout.trim().split("\n");
    const line1 = JSON.parse(lines[0]);
    expect(line1.success).toBe(true);
    expect(line1.commit_sha).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// no on-hook files
// ---------------------------------------------------------------------------

describe("commit-work: empty file set", () => {
  test("emits committed:false (pretty) when nothing is on the hook", async () => {
    initRepo();
    const res = await commitWork(["test: nothing", "--session-id", "s1"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed).toEqual({ success: true, committed: false, files: [] });
    expect(res.stdout).toBe(
      `${JSON.stringify({ success: true, committed: false, files: [] }, null, 2)}\n`,
    );
  });
});

// ---------------------------------------------------------------------------
// successful stage → commit → push (two-line compact NDJSON)
// ---------------------------------------------------------------------------

describe("commit-work: success path", () => {
  test("two-line compact NDJSON; both lines parse; commit + push land", async () => {
    initRepo();
    const bare = addBareOrigin(true);
    writeFileSync(join(repo, "a.txt"), "a\n");
    writeFileSync(join(repo, "b.txt"), "b\n");
    seedAttribution({ sessionId: "s1", filePath: "a.txt" });
    seedAttribution({ sessionId: "s1", filePath: "b.txt" });

    const res = await commitWork(["feat: add files", "--session-id", "s1"]);
    expect(res.code).toBe(0);

    const lines = res.stdout.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(2);

    // Line 1 — commit envelope (compact, sorted files).
    const line1 = JSON.parse(lines[0]);
    expect(line1.success).toBe(true);
    expect(line1.commit_sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(line1.files).toEqual(["a.txt", "b.txt"]);
    // Each line is compact: no leading-two-space pretty indentation.
    expect(lines[0]).not.toMatch(/^\s/);

    // Line 2 — push envelope.
    const line2 = JSON.parse(lines[1]);
    expect(line2).toEqual({
      success: true,
      pushed: true,
      remote: "origin",
      branch: "main",
    });

    // The commit really landed and the bare remote received it.
    expect(
      git("log", "--oneline")
        .split("\n")
        .filter((l) => l).length,
    ).toBe(2);
    const remoteLog = Bun.spawnSync([
      "git",
      "-C",
      bare,
      "log",
      "--oneline",
    ]).stdout.toString();
    expect(remoteLog).toContain("add files");
  });

  test("appends the Job-Id trailer from JOBCTL_JOB_ID", async () => {
    initRepo();
    addBareOrigin(true);
    writeFileSync(join(repo, "a.txt"), "a\n");
    seedAttribution({ sessionId: "s1", filePath: "a.txt" });

    const res = await commitWork(["feat: trailer", "--session-id", "s1"], {
      JOBCTL_JOB_ID: "job-abc",
    });
    expect(res.code).toBe(0);
    const body = git("log", "-1", "--format=%B");
    expect(body).toContain("Job-Id: job-abc");
  });

  test("no Job-Id trailer when no job id is resolvable", async () => {
    initRepo();
    addBareOrigin(true);
    writeFileSync(join(repo, "a.txt"), "a\n");
    seedAttribution({ sessionId: "s1", filePath: "a.txt" });

    // --session-id feeds attribution but NOT the trailer (which reads env only).
    const res = await commitWork(["feat: no trailer", "--session-id", "s1"]);
    expect(res.code).toBe(0);
    const body = git("log", "-1", "--format=%B");
    expect(body).not.toContain("Job-Id:");
  });
});

// ---------------------------------------------------------------------------
// no upstream (first push sets it)
// ---------------------------------------------------------------------------

describe("commit-work: no upstream", () => {
  test("sets upstream on first push (git rev-parse @{u} exit 128 path)", async () => {
    initRepo();
    // Remote added but NO upstream tracking set — the @{u} probe exits 128.
    const bare = addBareOrigin(false);
    writeFileSync(join(repo, "a.txt"), "a\n");
    seedAttribution({ sessionId: "s1", filePath: "a.txt" });

    const res = await commitWork(["feat: first push", "--session-id", "s1"]);
    expect(res.code).toBe(0);
    const lines = res.stdout.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
    const line2 = JSON.parse(lines[1]);
    expect(line2).toEqual({
      success: true,
      pushed: true,
      remote: "origin",
      branch: "main",
    });
    // Upstream is now configured.
    const upstream = git(
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{u}",
    ).trim();
    expect(upstream).toBe("origin/main");
    expect(
      Bun.spawnSync(["git", "-C", bare, "log", "--oneline"]).stdout.toString(),
    ).toContain("first push");
  });
});

// ---------------------------------------------------------------------------
// unicode-named file survives the staged-name intersection
// ---------------------------------------------------------------------------

describe("commit-work: unicode paths", () => {
  test("a non-ASCII filename round-trips into the commit files list", async () => {
    // git quotes non-ASCII paths in a non-`-z` `diff --cached --name-only`
    // (`"caf\303\251.txt"`); the `-z` staged-name read keeps the raw UTF-8 so
    // the intersection with the porcelain-v2 attribution set still matches.
    initRepo();
    addBareOrigin(true);
    writeFileSync(join(repo, "café.txt"), "x\n");
    seedAttribution({ sessionId: "s1", filePath: "café.txt" });

    const res = await commitWork(["feat: unicode", "--session-id", "s1"]);
    expect(res.code).toBe(0);
    const line1 = JSON.parse(res.stdout.split("\n")[0]);
    expect(line1.success).toBe(true);
    expect(line1.files).toEqual(["café.txt"]);
  });
});

// ---------------------------------------------------------------------------
// deletion stages as a removal
// ---------------------------------------------------------------------------

describe("commit-work: deletion staging", () => {
  test("a session-deleted tracked file stages + commits as a removal", async () => {
    initRepo();
    addBareOrigin(true);
    // Track then delete a file — it is on the hook and dirty (a deletion).
    writeFileSync(join(repo, "doomed.txt"), "bye\n");
    git("add", "--", "doomed.txt");
    git("commit", "-q", "-m", "add doomed");
    rmSync(join(repo, "doomed.txt"));
    seedAttribution({ sessionId: "s1", filePath: "doomed.txt" });

    const res = await commitWork(["chore: drop doomed", "--session-id", "s1"]);
    expect(res.code).toBe(0);
    const line1 = JSON.parse(res.stdout.split("\n")[0]);
    expect(line1.success).toBe(true);
    // The deletion is in the commit's file list.
    expect(line1.files).toEqual(["doomed.txt"]);
    // The file is gone from HEAD's tree.
    const tree = git("ls-tree", "--name-only", "HEAD");
    expect(tree).not.toContain("doomed.txt");
    // The last commit recorded it as a deletion (D status).
    const stat = git("show", "--name-status", "--format=", "HEAD").trim();
    expect(stat).toBe("D\tdoomed.txt");
  });
});

// ---------------------------------------------------------------------------
// lint_failed envelope
// ---------------------------------------------------------------------------

describe("commit-work: lint_failed", () => {
  test("emits a compact lint_failed envelope on an injected ruff failure", async () => {
    // A pyproject.toml + a staged .py file with a ruff violation triggers the
    // ruff arm; exit code is the sole pass/fail signal and stderr is verbatim.
    initRepo();
    addBareOrigin(true);
    writeFileSync(
      join(repo, "pyproject.toml"),
      '[project]\nname = "x"\nversion = "0"\n',
    );
    // F401: unused import — a deterministic ruff `check` failure.
    writeFileSync(join(repo, "bad.py"), "import os\n");
    seedAttribution({ sessionId: "s1", filePath: "bad.py" });

    const res = await commitWork(["feat: bad py", "--session-id", "s1"]);
    expect(res.code).toBe(1);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("lint_failed");
    // Single failing checker → the linter name (ruff), not "multiple".
    expect(parsed.linter).toBe("ruff");
    expect(parsed.files).toEqual(["bad.py"]);
    expect(typeof parsed.stderr).toBe("string");
    expect(parsed.stderr.length).toBeGreaterThan(0);
    // Compact single line.
    expect(res.stdout.trimEnd()).not.toContain("\n");
    // The commit did NOT land (lint gated it).
    expect(
      git("log", "--oneline")
        .split("\n")
        .filter((l) => l).length,
    ).toBe(1);
    // The lock file was released (it exists but is unheld) — a follow-up commit
    // succeeds, proving no leaked lock.
    writeFileSync(join(repo, "bad.py"), "x = 1\n");
    const res2 = await commitWork(["feat: fixed py", "--session-id", "s1"]);
    expect(res2.code).toBe(0);
  });
});
