/**
 * Integration tests for `keeper session-state` (epic fn-715 task 3). Spawns the
 * real CLI (`bun cli/keeper.ts session-state ...`) against temp git repos with a
 * sandboxed KEEPER_DB so the assertions exercise the four git reads + the null
 * parity semantics + the session_files attribution swallow.
 *
 * Pins (per the task's test notes + acceptance):
 *  - empty repo (no commits) → head_sha null, branch is the pre-commit branch
 *    name (symbolic-ref still resolves the unborn branch);
 *  - detached HEAD → branch null, head_sha non-null;
 *  - session_files: the cwd-repo on-hook dirty set (minus .planctl/), and a DB
 *    hiccup degrades it to [] rather than throwing the verb;
 *  - the envelope is pretty indent=2 with `success:true`.
 *
 * Per the CLAUDE.md isolation rule the spawn routes through a sandboxed base env
 * overriding ALL FOUR state paths under the per-test tmpDir.
 */

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
import { openDb } from "../src/db";

const ROOT = realpathSync(join(import.meta.dir, ".."));
const KEEPER_CLI = join(ROOT, "cli", "keeper.ts");

let tmpDir: string;
let dbPath: string;
let repo: string;

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "keeper-ss-")));
  dbPath = join(tmpDir, "keeper.db");
  repo = realpathSync(mkdtempSync(join(tmpdir(), "keeper-ss-repo-")));
  openDb(dbPath).db.close();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

/** Sandboxed base env overriding ALL FIVE keeper state paths + clearing ids. */
function sandboxEnv(
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string | undefined> = {
    ...(process.env as Record<string, string>),
  };
  env.CLAUDE_CODE_SESSION_ID = undefined;
  env.JOBCTL_SESSION_ID = undefined;
  env.JOBCTL_JOB_ID = undefined;
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  env.KEEPER_DB = dbPath;
  env.KEEPER_DEAD_LETTER_DIR = join(tmpDir, "dead-letters");
  env.KEEPER_DROP_LOG = join(tmpDir, "hook-drops.ndjson");
  env.KEEPER_RESTORE_FILE = join(tmpDir, "restore.json");
  env.KEEPER_BACKSTOP_LOG = join(tmpDir, "backstop.ndjson");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
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

/** Initialize `repo` as a git repo with an identity (NO commit yet). */
function initRepoBare(): void {
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
}

/** Add an initial commit to `repo`. Returns its full SHA. */
function initialCommit(): string {
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  git("add", "--", "seed.txt");
  git("commit", "-q", "-m", "init");
  return git("rev-parse", "HEAD").trim();
}

/** Seed an undischarged file_attributions row in the sandboxed DB. */
function seedAttribution(opts: { sessionId: string; filePath: string }): void {
  const { db } = openDb(dbPath);
  db.run(
    "INSERT INTO file_attributions " +
      "(project_dir, session_id, file_path, last_mutation_at, last_commit_at, op, source) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
    [repo, opts.sessionId, opts.filePath, 100, null, "edit", "tool"],
  );
  db.close();
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn `keeper session-state <args...>` in `repo` with the sandbox env. */
async function sessionState(
  args: string[] = [],
  extraEnv: Record<string, string | undefined> = {},
): Promise<RunResult> {
  const proc = Bun.spawn(["bun", KEEPER_CLI, "session-state", ...args], {
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
// null parity
// ---------------------------------------------------------------------------

describe("session-state: null parity", () => {
  test("empty repo → head_sha is null (not '' / not a throw)", async () => {
    initRepoBare(); // no commit
    const res = await sessionState();
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.head_sha).toBeNull();
    // branch resolves the unborn branch name (symbolic-ref --short HEAD works
    // before the first commit) — it is the string "main", NOT null/"".
    expect(parsed.branch).toBe("main");
  });

  test("detached HEAD → branch is null, head_sha is non-null", async () => {
    initRepoBare();
    const sha = initialCommit();
    // Detach onto the commit.
    git("checkout", "-q", sha);

    const res = await sessionState();
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.branch).toBeNull();
    expect(parsed.head_sha).toBe(sha);
  });

  test("pretty indent=2 envelope with the five fields + success", async () => {
    initRepoBare();
    initialCommit();
    const res = await sessionState();
    const parsed = JSON.parse(res.stdout);
    expect(Object.keys(parsed)).toEqual([
      "success",
      "status_porcelain",
      "log_oneline",
      "head_sha",
      "branch",
      "session_files",
    ]);
    // Pretty: a top-level key is indented by two spaces.
    expect(res.stdout).toContain('\n  "success": true');
    // status_porcelain carries the v2 --branch header.
    expect(parsed.status_porcelain).toContain("# branch.head");
  });
});

// ---------------------------------------------------------------------------
// session_files
// ---------------------------------------------------------------------------

describe("session-state: session_files", () => {
  test("returns the cwd-repo on-hook dirty set (minus .planctl/)", async () => {
    initRepoBare();
    initialCommit();
    // Two dirty work files + one .planctl file (excluded client-side).
    writeFileSync(join(repo, "work.ts"), "w\n");
    mkdirSync(join(repo, ".planctl", "epics"), { recursive: true });
    writeFileSync(join(repo, ".planctl", "epics", "fn-1.json"), "{}\n");
    seedAttribution({ sessionId: "s1", filePath: "work.ts" });
    seedAttribution({
      sessionId: "s1",
      filePath: ".planctl/epics/fn-1.json",
    });

    const res = await sessionState(["--session-id", "s1"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.session_files).toEqual(["work.ts"]);
  });

  test("no session id resolves → session_files is [] (informational)", async () => {
    initRepoBare();
    initialCommit();
    const res = await sessionState();
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).session_files).toEqual([]);
  });

  test("a DB hiccup degrades session_files to [] (never throws the verb)", async () => {
    initRepoBare();
    initialCommit();
    // Corrupt the sandboxed DB file in place — the readonly attribution open
    // throws on the malformed header. The verb must swallow it to [] (the
    // Python bare-except parity) and still exit 0 with the git context intact.
    // Overwriting dbPath keeps the CLAUDE.md isolation rule (state paths stay
    // sandbox-pinned; we never reach the user's real DB).
    writeFileSync(dbPath, "this is not a sqlite database\n");

    const res = await sessionState(["--session-id", "s1"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.session_files).toEqual([]);
    // The git context still landed.
    expect(parsed.head_sha).not.toBeNull();
  });
});
