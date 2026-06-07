import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initRepo } from "./helpers/git-repo";

const WRAPPER = join(import.meta.dir, "..", "plugin", "bin", "git");
const REAL_GIT = "/usr/bin/git";
const TEST_SESSION_ID = "test-session-uuid-aaaaaaaa-bbbb";

/**
 * Spawn a process synchronously, return {code, stdout, stderr} as strings.
 *
 * Bun's spawnSync.exited is a number (not a Promise) so we don't need to
 * await anything — the `.exitCode` field on the returned object carries the
 * final code.
 */
function spawn(
  cmd: string[],
  opts: { cwd: string; env?: Record<string, string> } = { cwd: process.cwd() },
): { code: number; stdout: string; stderr: string } {
  const env = { PATH: "/usr/bin:/bin", ...(opts.env ?? {}) };
  const r = Bun.spawnSync({
    cmd,
    cwd: opts.cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}

/** Make a fresh tmp git repo with one staged file ready to commit. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "keeper-git-wrapper-"));
  // Init + identity + `commit.gpgsign false` via the shared helper. The
  // commit-time injection under test is driven explicitly by the WRAPPER /
  // REAL_GIT spawns below, so the setup binary doesn't matter here.
  initRepo(dir);
  writeFileSync(join(dir, "a.txt"), "hello\n");
  expect(spawn([REAL_GIT, "add", "a.txt"], { cwd: dir }).code).toBe(0);
  return dir;
}

/** Read the Session-Id trailer of the current HEAD commit. */
function headSessionTrailer(repo: string): string {
  const r = spawn(
    [
      REAL_GIT,
      "log",
      "-1",
      "--format=%(trailers:key=Session-Id,valueonly,only,unfold)",
    ],
    { cwd: repo },
  );
  expect(r.code).toBe(0);
  return r.stdout.trim();
}

/** Cleanup tracker — every test that creates a repo registers it here. */
const repos: string[] = [];
afterAll(() => {
  for (const r of repos) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function fresh(): string {
  const r = makeRepo();
  repos.push(r);
  return r;
}

describe("git wrapper — commit subcommand detection", () => {
  test("plain `git commit -m x` injects Session-Id trailer", () => {
    const repo = fresh();
    const r = spawn([WRAPPER, "commit", "-q", "-m", "x"], {
      cwd: repo,
      env: { CLAUDE_CODE_SESSION_ID: TEST_SESSION_ID },
    });
    expect(r.code).toBe(0);
    expect(headSessionTrailer(repo)).toBe(TEST_SESSION_ID);
  });

  test("`git -c K=V commit -m x` injects trailer (walks past -c)", () => {
    const repo = fresh();
    const r = spawn(
      [WRAPPER, "-c", "user.signingkey=fake", "commit", "-q", "-m", "x"],
      {
        cwd: repo,
        env: { CLAUDE_CODE_SESSION_ID: TEST_SESSION_ID },
      },
    );
    expect(r.code).toBe(0);
    expect(headSessionTrailer(repo)).toBe(TEST_SESSION_ID);
  });

  test("`git -C path commit -m x` injects trailer (walks past -C)", () => {
    const repo = fresh();
    const r = spawn([WRAPPER, "-C", repo, "commit", "-q", "-m", "x"], {
      cwd: "/tmp",
      env: { CLAUDE_CODE_SESSION_ID: TEST_SESSION_ID },
    });
    expect(r.code).toBe(0);
    expect(headSessionTrailer(repo)).toBe(TEST_SESSION_ID);
  });

  test("`git --no-pager commit -m x` injects trailer", () => {
    const repo = fresh();
    const r = spawn([WRAPPER, "--no-pager", "commit", "-q", "-m", "x"], {
      cwd: repo,
      env: { CLAUDE_CODE_SESSION_ID: TEST_SESSION_ID },
    });
    expect(r.code).toBe(0);
    expect(headSessionTrailer(repo)).toBe(TEST_SESSION_ID);
  });

  test("`git -p commit -m x` injects trailer (short --paginate)", () => {
    const repo = fresh();
    const r = spawn([WRAPPER, "-p", "commit", "-q", "-m", "x"], {
      cwd: repo,
      env: { CLAUDE_CODE_SESSION_ID: TEST_SESSION_ID },
    });
    expect(r.code).toBe(0);
    expect(headSessionTrailer(repo)).toBe(TEST_SESSION_ID);
  });

  test("`git --git-dir=PATH commit` injects trailer (= form)", () => {
    const repo = fresh();
    const r = spawn(
      [
        WRAPPER,
        `--git-dir=${repo}/.git`,
        `--work-tree=${repo}`,
        "commit",
        "-q",
        "-m",
        "x",
      ],
      {
        cwd: "/tmp",
        env: { CLAUDE_CODE_SESSION_ID: TEST_SESSION_ID },
      },
    );
    expect(r.code).toBe(0);
    expect(headSessionTrailer(repo)).toBe(TEST_SESSION_ID);
  });
});

describe("git wrapper — amend dedup", () => {
  test("`commit --amend --no-edit` with same session id does NOT duplicate trailer", () => {
    const repo = fresh();
    // Initial commit via wrapper.
    expect(
      spawn([WRAPPER, "commit", "-q", "-m", "x"], {
        cwd: repo,
        env: { CLAUDE_CODE_SESSION_ID: TEST_SESSION_ID },
      }).code,
    ).toBe(0);
    expect(headSessionTrailer(repo)).toBe(TEST_SESSION_ID);

    // Amend with same session id — addIfDifferentNeighbor should no-op.
    const r = spawn([WRAPPER, "commit", "-q", "--amend", "--no-edit"], {
      cwd: repo,
      env: { CLAUDE_CODE_SESSION_ID: TEST_SESSION_ID },
    });
    expect(r.code).toBe(0);

    // valueonly returns one line per trailer; expect exactly one Session-Id.
    const trailerOut = spawn(
      [
        REAL_GIT,
        "log",
        "-1",
        "--format=%(trailers:key=Session-Id,valueonly,only,unfold)",
      ],
      { cwd: repo },
    ).stdout.trim();
    const lines = trailerOut.split("\n").filter((l) => l.length > 0);
    expect(lines).toEqual([TEST_SESSION_ID]);
  });
});

describe("git wrapper — non-commit invocations pass through unmodified", () => {
  test("`git status` passes through (exit + stdout match real git)", () => {
    const repo = fresh();
    const wrapped = spawn([WRAPPER, "status", "--porcelain=v2"], {
      cwd: repo,
      env: { CLAUDE_CODE_SESSION_ID: TEST_SESSION_ID },
    });
    const real = spawn([REAL_GIT, "status", "--porcelain=v2"], {
      cwd: repo,
      env: { CLAUDE_CODE_SESSION_ID: TEST_SESSION_ID },
    });
    expect(wrapped.code).toBe(real.code);
    expect(wrapped.stdout).toBe(real.stdout);
  });

  test("`git log` passes through (exit + stdout match real git)", () => {
    const repo = fresh();
    // Need a commit so `log` has something to print.
    expect(
      spawn([REAL_GIT, "commit", "-q", "-m", "seed"], { cwd: repo }).code,
    ).toBe(0);
    const wrapped = spawn([WRAPPER, "log", "--oneline"], {
      cwd: repo,
      env: { CLAUDE_CODE_SESSION_ID: TEST_SESSION_ID },
    });
    const real = spawn([REAL_GIT, "log", "--oneline"], {
      cwd: repo,
      env: { CLAUDE_CODE_SESSION_ID: TEST_SESSION_ID },
    });
    expect(wrapped.code).toBe(real.code);
    expect(wrapped.stdout).toBe(real.stdout);
  });

  test("`git push` passes through unmodified (no trailer to inspect)", () => {
    // We don't actually want to push — just confirm the wrapper exec's real
    // git with the original argv. A bogus remote name makes git fail fast
    // with the same exit code through both paths, and the stderr shape
    // matches identically (both go to real git).
    const repo = fresh();
    expect(
      spawn([REAL_GIT, "commit", "-q", "-m", "seed"], { cwd: repo }).code,
    ).toBe(0);
    const wrapped = spawn([WRAPPER, "push", "no-such-remote-zzz", "main"], {
      cwd: repo,
      env: { CLAUDE_CODE_SESSION_ID: TEST_SESSION_ID },
    });
    const real = spawn([REAL_GIT, "push", "no-such-remote-zzz", "main"], {
      cwd: repo,
      env: { CLAUDE_CODE_SESSION_ID: TEST_SESSION_ID },
    });
    // Same failure code, same stderr — wrapper didn't touch the argv.
    expect(wrapped.code).toBe(real.code);
    expect(wrapped.code).not.toBe(0);
  });

  test("`git diff` passes through", () => {
    const repo = fresh();
    writeFileSync(join(repo, "a.txt"), "hello\nworld\n");
    const wrapped = spawn([WRAPPER, "diff"], {
      cwd: repo,
      env: { CLAUDE_CODE_SESSION_ID: TEST_SESSION_ID },
    });
    const real = spawn([REAL_GIT, "diff"], {
      cwd: repo,
      env: { CLAUDE_CODE_SESSION_ID: TEST_SESSION_ID },
    });
    expect(wrapped.code).toBe(real.code);
    expect(wrapped.stdout).toBe(real.stdout);
  });
});

describe("git wrapper — session id env handling", () => {
  test("no CLAUDE_CODE_SESSION_ID env → commit lands without trailer", () => {
    const repo = fresh();
    const r = spawn([WRAPPER, "commit", "-q", "-m", "x"], { cwd: repo });
    expect(r.code).toBe(0);
    expect(headSessionTrailer(repo)).toBe("");
  });

  test("empty CLAUDE_CODE_SESSION_ID env → commit lands without trailer", () => {
    const repo = fresh();
    const r = spawn([WRAPPER, "commit", "-q", "-m", "x"], {
      cwd: repo,
      env: { CLAUDE_CODE_SESSION_ID: "" },
    });
    expect(r.code).toBe(0);
    expect(headSessionTrailer(repo)).toBe("");
  });
});
