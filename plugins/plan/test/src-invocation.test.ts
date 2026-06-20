// Unit tests for src/invocation.ts buildPlanctlInvocation (mutating). Pins the
// fail-closed session-id contract, the touched-paths ∩ dirty data-dir
// intersection (with --untracked-files=all so new files appear individually),
// the wire field order, path-traversal/non-data-dir rejection, and the
// state_repo precedence (primaryRepo over repoRoot).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPlanctlInvocation } from "../src/invocation.ts";

let repo: string;
const savedSid = process.env.CLAUDE_CODE_SESSION_ID;

function git(args: string[], cwd: string): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
}

/** Seed a touched-log record for `sid` naming `relPath`, and write the file so
 * git sees it dirty. Returns relPath. */
function seedTouched(sid: string, relPath: string, content = "x\n"): string {
  const touchedDir = join(repo, ".keeper", "state", "sessions", sid, "touched");
  mkdirSync(touchedDir, { recursive: true });
  writeFileSync(
    join(touchedDir, `${relPath.replace(/\W/g, "_")}.txt`),
    `${relPath}\n`,
  );
  const target = join(repo, relPath);
  mkdirSync(join(repo, relPath.split("/").slice(0, -1).join("/")), {
    recursive: true,
  });
  writeFileSync(target, content);
  return relPath;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "planctl-inv-test-"));
  git(["init", "-q"], repo);
  git(["config", "user.email", "t@p.local"], repo);
  git(["config", "user.name", "T"], repo);
  mkdirSync(join(repo, ".keeper"), { recursive: true });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  if (savedSid === undefined) {
    delete process.env.CLAUDE_CODE_SESSION_ID;
  } else {
    process.env.CLAUDE_CODE_SESSION_ID = savedSid;
  }
});

describe("buildPlanctlInvocation session-id (fail-closed)", () => {
  test("throws when CLAUDE_CODE_SESSION_ID is absent", () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    expect(() =>
      buildPlanctlInvocation("claim", "fn-1-x.1", null, { repoRoot: repo }),
    ).toThrow(/resolvable session_id/);
  });

  test("session_id rides on the payload verbatim", () => {
    process.env.CLAUDE_CODE_SESSION_ID = "sid-123";
    const inv = buildPlanctlInvocation("claim", "fn-1-x.1", null, {
      repoRoot: repo,
    });
    expect(inv.session_id).toBe("sid-123");
  });
});

describe("buildPlanctlInvocation files = touched ∩ dirty", () => {
  test("only touched paths that are also dirty appear, sorted", () => {
    process.env.CLAUDE_CODE_SESSION_ID = "sid-int";
    // Two touched+dirty paths (out of order), one touched-but-clean (committed).
    const b = seedTouched("sid-int", ".keeper/epics/b.json");
    const a = seedTouched("sid-int", ".keeper/epics/a.json");
    const clean = seedTouched("sid-int", ".keeper/epics/clean.json");
    git(["add", clean], repo);
    git(["commit", "-q", "-m", "commit clean"], repo);

    const inv = buildPlanctlInvocation("done", "fn-9-x.1", null, {
      repoRoot: repo,
    });
    // a, b are dirty (sorted); clean.json is committed so excluded.
    expect(inv.files).toEqual([a, b]);
  });

  test("subject uses buildSubject with the em-dash detail", () => {
    process.env.CLAUDE_CODE_SESSION_ID = "sid-subj";
    const inv = buildPlanctlInvocation("done", "fn-9-x.1", "shipped it", {
      repoRoot: repo,
    });
    expect(inv.subject).toBe("chore(plan): done fn-9-x.1 — shipped it");
  });
});

describe("buildPlanctlInvocation wire field order", () => {
  test("keys appear in the contract order", () => {
    process.env.CLAUDE_CODE_SESSION_ID = "sid-order";
    const inv = buildPlanctlInvocation("block", "fn-1-x.1", null, {
      repoRoot: repo,
    });
    expect(Object.keys(inv)).toEqual([
      "files",
      "op",
      "target",
      "subject",
      "touched_path_files",
      "repo_root",
      "state_repo",
      "queue_jump",
      "session_id",
    ]);
  });
});

describe("buildPlanctlInvocation state_repo precedence", () => {
  test("primaryRepo wins over repoRoot when given", () => {
    process.env.CLAUDE_CODE_SESSION_ID = "sid-sr";
    const inv = buildPlanctlInvocation("done", "fn-1-x.1", null, {
      repoRoot: repo,
      primaryRepo: "/some/primary",
    });
    expect(inv.state_repo).toBe("/some/primary");
    expect(inv.repo_root).toBe(repo);
  });

  test("falls back to repoRoot when primaryRepo absent", () => {
    process.env.CLAUDE_CODE_SESSION_ID = "sid-sr2";
    const inv = buildPlanctlInvocation("done", "fn-1-x.1", null, {
      repoRoot: repo,
    });
    expect(inv.state_repo).toBe(repo);
  });
});

describe("buildPlanctlInvocation touched-path validation (throws loud)", () => {
  test("path traversal in a touched record throws", () => {
    process.env.CLAUDE_CODE_SESSION_ID = "sid-trav";
    const touchedDir = join(
      repo,
      ".keeper",
      "state",
      "sessions",
      "sid-trav",
      "touched",
    );
    mkdirSync(touchedDir, { recursive: true });
    writeFileSync(join(touchedDir, "bad.txt"), ".keeper/../etc/passwd\n");
    expect(() =>
      buildPlanctlInvocation("done", "fn-1-x.1", null, { repoRoot: repo }),
    ).toThrow(/path traversal/);
  });

  test("a non-data-dir prefix in a touched record throws", () => {
    process.env.CLAUDE_CODE_SESSION_ID = "sid-pref";
    const touchedDir = join(
      repo,
      ".keeper",
      "state",
      "sessions",
      "sid-pref",
      "touched",
    );
    mkdirSync(touchedDir, { recursive: true });
    writeFileSync(join(touchedDir, "bad.txt"), "src/secret.ts\n");
    expect(() =>
      buildPlanctlInvocation("done", "fn-1-x.1", null, { repoRoot: repo }),
    ).toThrow(/non-data-dir/);
  });
});
