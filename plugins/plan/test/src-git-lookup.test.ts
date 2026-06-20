// Unit tests for the git-reading quartet's two trailer techniques —
// src/commit_lookup.ts (the `git log --grep` + `git interpret-trailers --parse`
// confirmation scan find-task-commit wraps) and src/reconcile.ts's
// findSourceCommits (the `%(trailers:key=Task,valueonly=true)` unit-separator
// split reconcile uses). Both must extract the SAME logical answer from a
// `Task:`-trailer commit while rejecting prose false-matches and fn-N.1/fn-N.10
// substring collisions.
//
// The 4-way trailer round-trip: a commit carrying a real `Task:` trailer (the
// shape every worker's source commit lands, engine-independent) is read back
// through BOTH bun lookup techniques and BOTH must agree — the bun half of the
// cross-engine parity the conformance suite pins against the Python reference.
// Plus the reconcile verdict truth table + stateHeadVisible unborn-branch guard.

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

import { AllReposBrokenError, findCommitGroups } from "../src/commit_lookup.ts";
import {
  computeVerdict,
  findSourceCommits,
  stateHeadVisible,
  VERDICTS,
} from "../src/verbs/reconcile.ts";

let repo: string;
// The realpath-resolved repo path — findCommitGroups / findSourceCommits
// resolve symlinks (macOS /var -> /private/var), so group results carry the
// resolved form. Expectations compare against this, not the raw mkdtemp path.
let resolvedRepo: string;

function git(args: string[], cwd: string): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
}

/** Land an empty commit carrying `body` (incl. any trailer block); return the
 * full %H. Workers create source commits with a plain `git commit` whose message
 * ends in a `Task: <id>` trailer — engine-independent, so this is the shared
 * "both engines write" half of the round-trip. */
function commit(body: string, cwd: string): string {
  const proc = Bun.spawnSync(["git", "commit", "--allow-empty", "-F", "-"], {
    cwd,
    stdin: Buffer.from(body),
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git commit failed: ${proc.stderr.toString()}`);
  }
  return git(["rev-parse", "HEAD"], cwd).trim();
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "planctl-git-lookup-"));
  git(["init", "-q"], repo);
  git(["config", "user.email", "test@planctl.local"], repo);
  git(["config", "user.name", "Planctl Test"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
  writeFileSync(join(repo, "README"), "seed\n");
  git(["add", "README"], repo);
  git(["commit", "-q", "-m", "seed"], repo);
  resolvedRepo = realpathSync(repo);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// commit_lookup.findCommitGroups — the grep + interpret-trailers technique.
// ---------------------------------------------------------------------------

describe("findCommitGroups (grep + interpret-trailers --parse)", () => {
  test("a real Task: trailer commit is grouped under its repo", () => {
    const sha = commit("feat: work\n\nTask: fn-1-x.1\n", repo);
    const groups = findCommitGroups(["fn-1-x.1"], repo, null);
    expect(groups).toEqual([{ repo: resolvedRepo, shas: [sha] }]);
  });

  test("clean miss → empty result (never raises)", () => {
    expect(findCommitGroups(["fn-1-x.1"], repo, null)).toEqual([]);
  });

  test("a prose `Task:` mention is dropped by the trailer post-filter", () => {
    commit("chore: note\n\nfixes the Task: fn-1-x.1 issue in prose\n", repo);
    expect(findCommitGroups(["fn-1-x.1"], repo, null)).toEqual([]);
  });

  test("fn-N.1 does NOT match an fn-N.10 sibling trailer (substring)", () => {
    commit("feat: sibling\n\nTask: fn-1-x.10\n", repo);
    expect(findCommitGroups(["fn-1-x.1"], repo, null)).toEqual([]);
  });

  test("two commits for one task flatten in grep (newest-first) order", () => {
    const older = commit("feat: a\n\nTask: fn-1-x.1\n", repo);
    const newer = commit("feat: b\n\nTask: fn-1-x.1\n", repo);
    const groups = findCommitGroups(["fn-1-x.1"], repo, null);
    expect(groups).toEqual([{ repo: resolvedRepo, shas: [newer, older] }]);
  });

  test("touched_repos=[] returns [] without raising", () => {
    expect(findCommitGroups(["fn-1-x.1"], repo, [])).toEqual([]);
  });

  test("every repo missing/non-git → AllReposBrokenError", () => {
    const broken = mkdtempSync(join(tmpdir(), "planctl-not-a-repo-"));
    try {
      expect(() => findCommitGroups(["fn-1-x.1"], repo, [broken])).toThrow(
        AllReposBrokenError,
      );
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// reconcile.findSourceCommits — the %(trailers:…valueonly) unit-sep technique.
// ---------------------------------------------------------------------------

describe("findSourceCommits (%(trailers) valueonly + unit-sep split)", () => {
  test("a real Task: trailer commit is returned", () => {
    const sha = commit("feat: work\n\nTask: fn-1-x.1\n", repo);
    expect(findSourceCommits("fn-1-x.1", repo)).toContain(sha);
  });

  test("a prose body `Task:` line (not a trailer block) does not match", () => {
    commit(
      "feat: x\n\nTask: fn-1-x.1\n\nmore prose after, not the trailer block.\n",
      repo,
    );
    expect(findSourceCommits("fn-1-x.1", repo)).toEqual([]);
  });

  test("fn-N.1 does NOT match an fn-N.10 trailer (no substring collision)", () => {
    commit("feat: sibling\n\nTask: fn-1-x.10\n", repo);
    expect(findSourceCommits("fn-1-x.1", repo)).toEqual([]);
  });

  test("a comma-joined `Task: a, b` trailer matches both ids", () => {
    const sha = commit("feat: both\n\nTask: fn-1-x.1, fn-1-x.2\n", repo);
    expect(findSourceCommits("fn-1-x.1", repo)).toContain(sha);
    expect(findSourceCommits("fn-1-x.2", repo)).toContain(sha);
  });

  test("not a git work tree → [] (not an error for the source scan)", () => {
    const notRepo = mkdtempSync(join(tmpdir(), "planctl-not-a-repo-"));
    try {
      expect(findSourceCommits("fn-1-x.1", notRepo)).toEqual([]);
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The 4-way round-trip: one Task: trailer commit, both techniques agree.
// ---------------------------------------------------------------------------

describe("4-way trailer round-trip", () => {
  test("both bun lookup techniques find the same Task: trailer commit", () => {
    const sha = commit(
      "feat(x): the work\n\nbody.\n\nTask: fn-7-feat.3\n",
      repo,
    );

    // Technique A: grep + interpret-trailers (find-task-commit's path).
    const groups = findCommitGroups(["fn-7-feat.3"], repo, null);
    expect(groups).toEqual([{ repo: resolvedRepo, shas: [sha] }]);

    // Technique B: %(trailers) valueonly + unit-sep split (reconcile's path).
    expect(findSourceCommits("fn-7-feat.3", repo)).toEqual([sha]);

    // Both reject the substring sibling and a prose false-match identically.
    commit("feat: sibling\n\nTask: fn-7-feat.30\n", repo);
    commit("chore: note\n\nmentions Task: fn-7-feat.3 mid prose\n", repo);
    expect(findCommitGroups(["fn-7-feat.3"], repo, null)).toEqual([
      { repo: resolvedRepo, shas: [sha] },
    ]);
    expect(findSourceCommits("fn-7-feat.3", repo)).toEqual([sha]);
  });
});

// ---------------------------------------------------------------------------
// stateHeadVisible — unborn-branch guard + worker_done_at probe.
// ---------------------------------------------------------------------------

describe("stateHeadVisible", () => {
  test("unborn branch (no born HEAD) → false, not a throw", () => {
    const unborn = mkdtempSync(join(tmpdir(), "planctl-unborn-"));
    try {
      git(["init", "-q"], unborn);
      expect(stateHeadVisible(unborn, "fn-1-x.1")).toBe(false);
    } finally {
      rmSync(unborn, { recursive: true, force: true });
    }
  });

  test("committed task JSON with worker_done_at → true", () => {
    const rel = ".keeper/tasks/fn-1-x.1.json";
    mkdirSync(join(repo, ".keeper", "tasks"), { recursive: true });
    writeFileSync(
      join(repo, rel),
      `${JSON.stringify({ id: "fn-1-x.1", worker_done_at: "2026-01-01T00:00:00Z" })}\n`,
    );
    git(["add", rel], repo);
    git(["commit", "-q", "-m", "chore(planctl): done fn-1-x.1"], repo);
    expect(stateHeadVisible(repo, "fn-1-x.1")).toBe(true);
  });

  test("path absent from HEAD → false", () => {
    expect(stateHeadVisible(repo, "fn-1-x.1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeVerdict — the pure truth table reconcile drives.
// ---------------------------------------------------------------------------

describe("computeVerdict truth table", () => {
  test("done + head-visible → done", () => {
    expect(
      computeVerdict("done", {
        hasSourceCommit: false,
        stateHeadVisible: true,
      }),
    ).toBe(VERDICTS.DONE);
  });
  test("done + head-invisible → state_uncommitted", () => {
    expect(
      computeVerdict("done", {
        hasSourceCommit: false,
        stateHeadVisible: false,
      }),
    ).toBe(VERDICTS.STATE_UNCOMMITTED);
  });
  test("in_progress + source commit → in_progress_committed", () => {
    expect(
      computeVerdict("in_progress", {
        hasSourceCommit: true,
        stateHeadVisible: false,
      }),
    ).toBe(VERDICTS.IN_PROGRESS_COMMITTED);
  });
  test("in_progress + no source commit → in_progress_uncommitted", () => {
    expect(
      computeVerdict("in_progress", {
        hasSourceCommit: false,
        stateHeadVisible: false,
      }),
    ).toBe(VERDICTS.IN_PROGRESS_UNCOMMITTED);
  });
  test("blocked → blocked", () => {
    expect(
      computeVerdict("blocked", {
        hasSourceCommit: false,
        stateHeadVisible: false,
      }),
    ).toBe(VERDICTS.BLOCKED);
  });
  test("todo (or unexpected) → not_started", () => {
    expect(
      computeVerdict("todo", {
        hasSourceCommit: false,
        stateHeadVisible: false,
      }),
    ).toBe(VERDICTS.NOT_STARTED);
  });
});
