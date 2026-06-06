/**
 * Integration tests for `keeper find-task-commit` (epic fn-715 task 3). Spawns
 * the real CLI (`bun cli/keeper.ts find-task-commit ...`) against temp git repos
 * with a sandboxed KEEPER_DB so the assertions exercise the FULL two-stage
 * match + repo-resolution pipeline and its exact stdout byte shape.
 *
 * **The envelope is a planctl fail-loud contract** — `run_close_preflight`
 * parses `{success, commits:[{sha, repo}, ...]}` and treats shape drift or a
 * wrong exit code as COMMIT_LOOKUP_FAILED — so the tests pin:
 *  - the `{commits:[{sha, repo}]}` shape on a real `Task:`-trailered commit;
 *  - a clean miss → empty commits, exit 0 (NEVER success:false);
 *  - a prose `Task:` mention in the body (not a trailer) is dropped;
 *  - the `--repos` override + the three touched_repos branches
 *    (None=cwd-only, []=scan-nothing-success, all-broken=exit-1);
 *  - pretty `indent=2` output.
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

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "keeper-ftc-")));
  dbPath = join(tmpDir, "keeper.db");
  // A valid DB up front — the attribution reader (unused by find-task-commit
  // but the sandbox shares the path) treats a truly-absent DB as a hard error.
  openDb(dbPath).db.close();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
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

/** Run a git command in `cwd` synchronously; throw on failure. */
function git(cwd: string, ...args: string[]): string {
  const res = Bun.spawnSync(["git", "-C", cwd, ...args], {
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

/** Create a fresh git repo under tmpDir with an identity. Returns its path. */
function makeRepo(name: string): string {
  const repo = join(tmpDir, name);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  return repo;
}

/** Commit `msg` (body included) touching a new file. Returns the full SHA. */
function commit(repo: string, file: string, msg: string): string {
  writeFileSync(join(repo, file), `${file}\n`);
  git(repo, "add", "--", file);
  // -F via stdin so the multi-line body (with the trailer) survives intact.
  const res = Bun.spawnSync(["git", "-C", repo, "commit", "-q", "-F", "-"], {
    stdin: new TextEncoder().encode(msg),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (res.exitCode !== 0) {
    throw new Error(`commit failed: ${res.stderr.toString().trim()}`);
  }
  return git(repo, "rev-parse", "HEAD").trim();
}

/** Write a `.planctl/epics/<id>.json` under `dir` with the given fields. */
function writeEpicJson(
  dir: string,
  epicId: string,
  fields: Record<string, unknown>,
): void {
  const epicsDir = join(dir, ".planctl", "epics");
  mkdirSync(epicsDir, { recursive: true });
  writeFileSync(join(epicsDir, `${epicId}.json`), JSON.stringify(fields));
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn `keeper find-task-commit <args...>` in `cwd` with the sandbox env. */
async function findTaskCommit(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
): Promise<RunResult> {
  const proc = Bun.spawn(["bun", KEEPER_CLI, "find-task-commit", ...args], {
    cwd,
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
// the match: shape + clean miss
// ---------------------------------------------------------------------------

describe("find-task-commit: cwd-only (legacy / no epic state)", () => {
  test("finds a commit carrying a real Task: trailer (shape + pretty)", async () => {
    const repo = makeRepo("repo-a");
    const sha = commit(
      repo,
      "a.txt",
      "feat: add a\n\nbody line\n\nTask: fn-1-foo.1\n",
    );

    const res = await findTaskCommit(repo, ["fn-1-foo.1"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed).toEqual({
      success: true,
      commits: [{ sha, repo }],
    });
    // Pretty indent=2 (a nested key is indented by 2 spaces).
    expect(res.stdout).toContain('\n  "success": true');
  });

  test("clean miss → empty commits, exit 0 (NEVER success:false)", async () => {
    const repo = makeRepo("repo-miss");
    commit(repo, "x.txt", "feat: x\n\nTask: fn-9-other.2\n");

    const res = await findTaskCommit(repo, ["fn-1-foo.1"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed).toEqual({ success: true, commits: [] });
  });

  test("a prose 'Task:' mention in the body is NOT a trailer match", async () => {
    const repo = makeRepo("repo-prose");
    // The grep pre-filter matches the literal text, but interpret-trailers
    // --parse drops it (mid-body, not a trailer) so the post-filter rejects it.
    commit(
      repo,
      "p.txt",
      "fix: something\n\nThis fixes the Task: fn-1-foo.1 issue described above.\n",
    );

    const res = await findTaskCommit(repo, ["fn-1-foo.1"]);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ success: true, commits: [] });
  });

  test("a malformed (epic-only) Task: trailer value does not match", async () => {
    const repo = makeRepo("repo-malformed");
    // `Task: fn-1-foo` lacks the `.N` task suffix → parseTaskTrailers drops it.
    commit(repo, "m.txt", "feat: m\n\nTask: fn-1-foo\n");

    const res = await findTaskCommit(repo, ["fn-1-foo"]);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ success: true, commits: [] });
  });
});

// ---------------------------------------------------------------------------
// --repos override
// ---------------------------------------------------------------------------

describe("find-task-commit: --repos override", () => {
  test("scans exactly the override paths (absolute), aggregating across repos", async () => {
    const repoA = makeRepo("ov-a");
    const repoB = makeRepo("ov-b");
    const shaA = commit(repoA, "a.txt", "feat: a\n\nTask: fn-2-bar.3\n");
    const shaB = commit(repoB, "b.txt", "feat: b\n\nTask: fn-2-bar.3\n");

    // cwd is some THIRD dir; only the override paths are scanned.
    const cwd = makeRepo("ov-cwd");
    const res = await findTaskCommit(cwd, [
      "fn-2-bar.3",
      "--repos",
      `${repoA},${repoB}`,
    ]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.success).toBe(true);
    const set = new Set(
      parsed.commits.map((c: { sha: string; repo: string }) => c.sha),
    );
    expect(set).toEqual(new Set([shaA, shaB]));
  });

  test("--repos with ALL invalid paths → exit 1 (not-found / not-a-git-repo)", async () => {
    const cwd = makeRepo("inv-cwd");
    const missing = join(tmpDir, "does-not-exist");
    const notRepo = join(tmpDir, "not-a-repo");
    mkdirSync(notRepo, { recursive: true });

    const res = await findTaskCommit(cwd, [
      "fn-3-baz.1",
      "--repos",
      `${missing},${notRepo}`,
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("all repo paths failed");
  });

  test("--repos with a MIX of valid + invalid → success (any_success), exit 0", async () => {
    const repo = makeRepo("mix-valid");
    const sha = commit(repo, "v.txt", "feat: v\n\nTask: fn-4-qux.2\n");
    const missing = join(tmpDir, "gone");

    const res = await findTaskCommit(repo, [
      "fn-4-qux.2",
      "--repos",
      `${missing},${repo}`,
    ]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.commits).toEqual([{ sha, repo }]);
    expect(res.stderr).toContain("does not exist");
  });
});

// ---------------------------------------------------------------------------
// touched_repos branches
// ---------------------------------------------------------------------------

describe("find-task-commit: touched_repos resolution", () => {
  test("touched_repos:[] → scan nothing, success with empty commits, exit 0", async () => {
    const repo = makeRepo("tr-empty");
    // A commit that WOULD match in cwd — but touched_repos:[] means scan nothing.
    commit(repo, "e.txt", "feat: e\n\nTask: fn-5-empty.1\n");
    writeEpicJson(repo, "fn-5-empty", { touched_repos: [] });

    const res = await findTaskCommit(repo, ["fn-5-empty.1"]);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ success: true, commits: [] });
    expect(res.stderr).toContain("no repos to scan");
  });

  test("touched_repos:null (legacy) → cwd-only scan, exit 0", async () => {
    const repo = makeRepo("tr-null");
    const sha = commit(repo, "n.txt", "feat: n\n\nTask: fn-6-legacy.1\n");
    writeEpicJson(repo, "fn-6-legacy", { touched_repos: null });

    const res = await findTaskCommit(repo, ["fn-6-legacy.1"]);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      success: true,
      commits: [{ sha, repo }],
    });
  });

  test("touched_repos all-broken (named but none valid) → exit 1", async () => {
    const repo = makeRepo("tr-broken");
    writeEpicJson(repo, "fn-7-broken", {
      touched_repos: [join(tmpDir, "nope-1"), join(tmpDir, "nope-2")],
    });

    const res = await findTaskCommit(repo, ["fn-7-broken.1"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("all repo paths failed");
  });

  test("touched_repos with a valid entry → scans it (walk-up from a subdir)", async () => {
    const repo = makeRepo("tr-valid");
    const sha = commit(repo, "v.txt", "feat: v\n\nTask: fn-8-multi.4\n");
    writeEpicJson(repo, "fn-8-multi", { touched_repos: [repo] });
    // Run from a SUBDIR so the `.planctl/epics/<id>.json` walk-up is exercised.
    const subdir = join(repo, "src", "deep");
    mkdirSync(subdir, { recursive: true });

    const res = await findTaskCommit(subdir, ["fn-8-multi.4"]);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      success: true,
      commits: [{ sha, repo }],
    });
  });
});
