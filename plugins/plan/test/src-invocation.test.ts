// Unit tests for src/invocation.ts buildPlanctlInvocation (mutating). Pins the
// fail-closed session-id contract, the touched-paths ∩ dirty data-dir
// intersection (with --untracked-files=all so new files appear individually),
// the wire field order, path-traversal/non-data-dir rejection, and the
// state_repo precedence (primaryRepo over repoRoot).

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

import { buildPlanInvocation } from "../src/invocation.ts";
import { resetVcs, setVcs } from "../src/vcs.ts";
import {
  baselineRepo,
  initRepo as fakeInitRepo,
  fakeVcs,
  resetFakeVcs,
} from "./fake-vcs.ts";

let repo: string;
const savedSid = process.env.CLAUDE_CODE_SESSION_ID;
const savedKeeperJobId = process.env.KEEPER_JOB_ID;
const savedPlanSid = process.env.KEEPER_PLAN_SESSION_ID;

/** Seed a touched-log record for `sid` naming `relPath`, and write the file so
 * the fake dirty-discovery sees it dirty. Returns relPath. */
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
  resetFakeVcs();
  setVcs(fakeVcs);
  repo = realpathSync(mkdtempSync(join(tmpdir(), "planctl-inv-test-")));
  fakeInitRepo(repo);
  mkdirSync(join(repo, ".keeper"), { recursive: true });
  delete process.env.KEEPER_JOB_ID;
  delete process.env.KEEPER_PLAN_SESSION_ID;
});

afterEach(() => {
  resetVcs();
  rmSync(repo, { recursive: true, force: true });
  for (const [key, value] of [
    ["CLAUDE_CODE_SESSION_ID", savedSid],
    ["KEEPER_JOB_ID", savedKeeperJobId],
    ["KEEPER_PLAN_SESSION_ID", savedPlanSid],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("buildPlanctlInvocation session-id (fail-closed)", () => {
  test("throws when no tracked harness identity is present", () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    expect(() =>
      buildPlanInvocation("claim", "fn-1-x.1", null, { repoRoot: repo }),
    ).toThrow(/resolvable session_id/);
  });

  test("session_id rides on the payload verbatim", () => {
    process.env.CLAUDE_CODE_SESSION_ID = "sid-123";
    const inv = buildPlanInvocation("claim", "fn-1-x.1", null, {
      repoRoot: repo,
    });
    expect(inv.session_id).toBe("sid-123");
  });

  test("a tracked Pi job supplies the invocation identity", () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    process.env.KEEPER_JOB_ID = "pi-job-123";
    const inv = buildPlanInvocation("claim", "fn-1-x.1", null, {
      repoRoot: repo,
    });
    expect(inv.session_id).toBe("pi-job-123");
  });
});

describe("buildPlanctlInvocation files = touched ∩ dirty", () => {
  test("only touched paths that are also dirty appear, sorted", () => {
    process.env.CLAUDE_CODE_SESSION_ID = "sid-int";
    // Seed the touched+clean file, baseline it (the fake analogue of committing
    // it so it diffs clean), THEN seed the two touched+dirty paths.
    const clean = seedTouched("sid-int", ".keeper/epics/clean.json");
    baselineRepo(repo);
    expect(clean).toBe(".keeper/epics/clean.json");
    // Two touched+dirty paths (out of order); the clean one stays committed.
    const b = seedTouched("sid-int", ".keeper/epics/b.json");
    const a = seedTouched("sid-int", ".keeper/epics/a.json");

    const inv = buildPlanInvocation("done", "fn-9-x.1", null, {
      repoRoot: repo,
    });
    // a, b are dirty (sorted); clean.json is committed so excluded.
    expect(inv.files).toEqual([a, b]);
  });

  test("subject uses buildSubject with the em-dash detail", () => {
    process.env.CLAUDE_CODE_SESSION_ID = "sid-subj";
    const inv = buildPlanInvocation("done", "fn-9-x.1", "shipped it", {
      repoRoot: repo,
    });
    expect(inv.subject).toBe("chore(plan): done fn-9-x.1 — shipped it");
  });
});

describe("buildPlanctlInvocation wire field order", () => {
  test("keys appear in the contract order", () => {
    process.env.CLAUDE_CODE_SESSION_ID = "sid-order";
    const inv = buildPlanInvocation("block", "fn-1-x.1", null, {
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
      "session_id",
    ]);
  });
});

describe("buildPlanctlInvocation state_repo precedence", () => {
  test("primaryRepo wins over repoRoot when given", () => {
    process.env.CLAUDE_CODE_SESSION_ID = "sid-sr";
    const inv = buildPlanInvocation("done", "fn-1-x.1", null, {
      repoRoot: repo,
      primaryRepo: "/some/primary",
    });
    expect(inv.state_repo).toBe("/some/primary");
    expect(inv.repo_root).toBe(repo);
  });

  test("falls back to repoRoot when primaryRepo absent", () => {
    process.env.CLAUDE_CODE_SESSION_ID = "sid-sr2";
    const inv = buildPlanInvocation("done", "fn-1-x.1", null, {
      repoRoot: repo,
    });
    expect(inv.state_repo).toBe(repo);
  });
});

describe("buildPlanctlInvocation touched-path validation", () => {
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
      buildPlanInvocation("done", "fn-1-x.1", null, { repoRoot: repo }),
    ).toThrow(/path traversal/);
  });

  test("a non-data-dir prefix in a touched record is skipped, not thrown", () => {
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
      buildPlanInvocation("done", "fn-1-x.1", null, { repoRoot: repo }),
    ).not.toThrow();
  });

  test("a stale legacy .planctl/ record is skipped; valid records still land", () => {
    process.env.CLAUDE_CODE_SESSION_ID = "sid-stale";
    // One stale legacy `.planctl/` record (benign migration residue) alongside
    // two valid+dirty `.keeper/` records: the op succeeds, skipping the stale one.
    const touchedDir = join(
      repo,
      ".keeper",
      "state",
      "sessions",
      "sid-stale",
      "touched",
    );
    mkdirSync(touchedDir, { recursive: true });
    writeFileSync(
      join(touchedDir, "stale.txt"),
      ".planctl/epics/legacy.json\n",
    );
    const a = seedTouched("sid-stale", ".keeper/epics/a.json");
    const b = seedTouched("sid-stale", ".keeper/epics/b.json");

    const inv = buildPlanInvocation("done", "fn-1-x.1", null, {
      repoRoot: repo,
    });
    // Only the valid data-dir paths survive; the stale legacy record is dropped.
    expect(inv.files).toEqual([a, b]);
  });
});
