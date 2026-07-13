/**
 * Unit tests for `keeper session-state` (epic fn-715 task 3). Drives
 * `buildSessionState(...)` IN-PROCESS with a faked git runner + synthetic
 * attribution deps — exercising the four git reads, the null-parity semantics,
 * and the session_files attribution swallow with ZERO real git and zero
 * subprocess (fn-904).
 *
 * Pins (per the task's test notes + acceptance):
 *  - empty repo (no commits) → head_sha null, branch is the pre-commit branch
 *    name (symbolic-ref still resolves the unborn branch);
 *  - detached HEAD → branch null, head_sha non-null;
 *  - session_files: the cwd-repo on-hook dirty set (minus .keeper/), and a DB
 *    hiccup degrades it to [] rather than throwing the verb;
 *  - the envelope carries the five fields + `success:true` in order.
 *
 * The DB read (`session_files`) routes through a sandboxed `KEEPER_DB`-style
 * `dbPath` injected via the attribution deps, so the test never reaches the
 * user's real DB (the CLAUDE.md isolation rule). No git tree exists; the git
 * runner is a synthetic recorder.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionState, type SessionStateDeps } from "../cli/session-state";
import type {
  GitExecOptions,
  GitExecResult,
  GitRunner,
} from "../src/commit-work/git-exec";
import { openDb } from "../src/db";
import { freshDbFile } from "./helpers/template-db";

let tmpDir: string;
let dbPath: string;
// A synthetic repo path the attribution `gitRoot` resolves cwd to. No real dir.
const REPO = "/synthetic/keeper-ss-repo";

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "keeper-ss-")));
  dbPath = join(tmpDir, "keeper.db");
  freshDbFile(dbPath).db.close();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Synthetic git runner — returns canned stdout/code per subcommand. Built from
// a scenario spec so each test states only the fields it cares about.
// ---------------------------------------------------------------------------

interface GitScenario {
  /** `git rev-parse HEAD`: the full sha, or null to fail (empty repo). */
  headSha: string | null;
  /** `git symbolic-ref --short HEAD`: branch name, or null to fail (detached). */
  branch: string | null;
  /** `git status --porcelain=v2 --branch` stdout. */
  statusPorcelain: string;
  /** `git log -<n> --oneline` stdout. */
  logOneline: string;
}

/**
 * A {@link GitRunner} that answers the four reads `buildSessionState` issues. A
 * null `headSha`/`branch` maps to a non-zero exit (mirrors real git's empty-repo
 * / detached-HEAD behavior the verb folds to JSON `null`).
 */
function fakeGit(scenario: GitScenario): GitRunner {
  return async (
    args: string[],
    _options?: GitExecOptions,
  ): Promise<GitExecResult> => {
    const sub = args[0];
    if (sub === "rev-parse") {
      return scenario.headSha === null
        ? { code: 128, stdout: "", stderr: "fatal: bad revision 'HEAD'\n" }
        : { code: 0, stdout: `${scenario.headSha}\n`, stderr: "" };
    }
    if (sub === "symbolic-ref") {
      return scenario.branch === null
        ? {
            code: 128,
            stdout: "",
            stderr: "fatal: ref HEAD is not a symbolic ref\n",
          }
        : { code: 0, stdout: `${scenario.branch}\n`, stderr: "" };
    }
    if (sub === "status") {
      return { code: 0, stdout: scenario.statusPorcelain, stderr: "" };
    }
    if (sub === "log") {
      return { code: 0, stdout: scenario.logOneline, stderr: "" };
    }
    throw new Error(`unexpected git subcommand in fakeGit: ${args.join(" ")}`);
  };
}

/** A populated, committed-repo scenario (overridable per test). */
function scenario(over: Partial<GitScenario> = {}): GitScenario {
  return {
    headSha: "a".repeat(40),
    branch: "main",
    statusPorcelain: "# branch.oid abc\n# branch.head main\n",
    logOneline: "abc123 init\n",
    ...over,
  };
}

/** Build the deps with a faked git runner + a fixed `gitRoot`/`liveDirtyPaths`. */
function deps(over: Partial<SessionStateDeps> = {}): SessionStateDeps {
  return {
    gitRunner: fakeGit(scenario()),
    attribution: {
      dbPath,
      // cwd always resolves to the synthetic repo (no real git toplevel probe).
      gitRoot: () => REPO,
      // FAIL-OPEN dirty set: keep every on-hook candidate (the seeded rows
      // ARE the dirty set under test). A null here means "git unreadable".
      liveDirtyPaths: () => null,
    },
    ...over,
  };
}

/** Seed an undischarged file_attributions row in the sandboxed DB. */
function seedAttribution(opts: { sessionId: string; filePath: string }): void {
  const { db } = openDb(dbPath);
  db.run(
    "INSERT INTO file_attributions " +
      "(project_dir, session_id, file_path, last_mutation_at, last_commit_at, op, source) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
    [REPO, opts.sessionId, opts.filePath, 100, null, "edit", "tool"],
  );
  db.close();
}

// ---------------------------------------------------------------------------
// null parity
// ---------------------------------------------------------------------------

describe("session-state: null parity", () => {
  test("empty repo → head_sha is null (not '' / not a throw)", async () => {
    const env = await buildSessionState(
      { sessionId: null, logCount: 5 },
      deps({
        // Unborn branch: symbolic-ref still resolves the name, but rev-parse
        // HEAD fails (no commit) → head_sha null.
        gitRunner: fakeGit(scenario({ headSha: null, branch: "main" })),
      }),
    );
    expect(env.success).toBe(true);
    expect(env.head_sha).toBeNull();
    // branch resolves the unborn branch name — the string "main", NOT null/"".
    expect(env.branch).toBe("main");
  });

  test("detached HEAD → branch is null, head_sha is non-null", async () => {
    const sha = "b".repeat(40);
    const env = await buildSessionState(
      { sessionId: null, logCount: 5 },
      deps({ gitRunner: fakeGit(scenario({ headSha: sha, branch: null })) }),
    );
    expect(env.branch).toBeNull();
    expect(env.head_sha).toBe(sha);
  });

  test("the five fields + success appear in order", async () => {
    const env = await buildSessionState(
      { sessionId: null, logCount: 5 },
      deps({
        gitRunner: fakeGit(
          scenario({
            statusPorcelain: "# branch.oid abc\n# branch.head main\n",
          }),
        ),
      }),
    );
    expect(Object.keys(env)).toEqual([
      "success",
      "status_porcelain",
      "log_oneline",
      "head_sha",
      "branch",
      "session_files",
    ]);
    // status_porcelain carries the v2 --branch header.
    expect(env.status_porcelain).toContain("# branch.head");

    // The CLI emits this envelope via `JSON.stringify(env, null, 2)` (pretty
    // indent=2). Pin that rendering directly — a top-level key is two-space
    // indented and `success` leads with `true`.
    const pretty = JSON.stringify(env, null, 2);
    expect(pretty).toContain('\n  "success": true');
  });
});

// ---------------------------------------------------------------------------
// session_files
// ---------------------------------------------------------------------------

describe("session-state: session_files", () => {
  test("returns the cwd-repo on-hook dirty set (minus .keeper/)", async () => {
    // Two dirty work files + one .keeper file (excluded client-side).
    seedAttribution({ sessionId: "s1", filePath: "work.ts" });
    seedAttribution({
      sessionId: "s1",
      filePath: ".keeper/epics/fn-1.json",
    });

    const env = await buildSessionState(
      { sessionId: "s1", logCount: 5 },
      deps(),
    );
    expect(env.session_files).toEqual(["work.ts"]);
  });

  test("no session id resolves → session_files is [] (informational)", async () => {
    const env = await buildSessionState(
      { sessionId: null, logCount: 5 },
      deps(),
    );
    expect(env.session_files).toEqual([]);
  });

  test("a DB hiccup degrades session_files to [] (never throws the verb)", async () => {
    // Corrupt the sandboxed DB file in place — the readonly attribution open
    // throws on the malformed header. The verb must swallow it to [] (the
    // Python bare-except parity) and still return the git context intact.
    writeFileSync(dbPath, "this is not a sqlite database\n");

    const env = await buildSessionState(
      { sessionId: "s1", logCount: 5 },
      deps(),
    );
    expect(env.success).toBe(true);
    expect(env.session_files).toEqual([]);
    // The git context still landed.
    expect(env.head_sha).not.toBeNull();
  });
});
