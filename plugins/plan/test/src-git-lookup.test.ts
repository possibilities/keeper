// Unit tests for the git-reading quartet's two trailer techniques —
// src/commit_lookup.ts (find-task-commit's grouped trailer scan) and
// src/reconcile.ts's findSourceCommits (the source-commit scan) — plus the
// reconcile verdict truth table + stateHeadVisible unborn-branch guard.
//
// keeper's DECISIONS are the subject here, not git's execution: the tests install
// the fake VCS facade and seed source commits / committed task JSON through it
// (fakeSourceCommit / fakeCommitTaskJson), so both lookup techniques run git-free.
// The fake's trailer matcher reproduces git's interpret-trailers all-or-nothing
// block rule, so a prose `Task:` mention and an fn-N.1/fn-N.10 substring sibling
// are rejected exactly as real git rejects them. The real-git cross-engine
// trailer-parsing parity is owned by the slow tier (git-lookup-realgit.slow).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AllReposBrokenError, findCommitGroups } from "../src/commit_lookup.ts";
import { resetVcs, setVcs } from "../src/vcs.ts";
import {
  computeVerdict,
  findSourceCommits,
  stateHeadVisible,
  VERDICTS,
} from "../src/verbs/reconcile.ts";
import {
  fakeCommitTaskJson,
  initRepo as fakeInitRepo,
  fakeSourceCommit,
  fakeVcs,
  resetFakeVcs,
} from "./fake-vcs.ts";

let repo: string;
// The realpath-resolved repo path — findCommitGroups / findSourceCommits resolve
// symlinks (macOS /var -> /private/var), so group results carry the resolved
// form. Expectations compare against this, not the raw mkdtemp path.
let resolvedRepo: string;

/** Seed a fake source commit carrying `body` (incl. any trailer block); return
 * the full fake sha. A worker's source commit is a plain commit whose message
 * ends in a `Task: <id>` trailer — modeled here without real git. */
function commit(body: string, cwd: string): string {
  return fakeSourceCommit(cwd, body);
}

beforeEach(() => {
  resetFakeVcs();
  setVcs(fakeVcs);
  repo = realpathSync(mkdtempSync(join(tmpdir(), "planctl-git-lookup-")));
  fakeInitRepo(repo);
  resolvedRepo = repo;
});

afterEach(() => {
  resetVcs();
  rmSync(repo, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// commit_lookup.findCommitGroups — the grouped confirmed-trailer scan.
// ---------------------------------------------------------------------------

describe("findCommitGroups (confirmed trailer scan)", () => {
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
    const broken = realpathSync(
      mkdtempSync(join(tmpdir(), "planctl-not-a-repo-")),
    );
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
// reconcile.findSourceCommits — the source-commit scan.
// ---------------------------------------------------------------------------

describe("findSourceCommits (trailer-authentic scan)", () => {
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
    const notRepo = realpathSync(
      mkdtempSync(join(tmpdir(), "planctl-not-a-repo-")),
    );
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
  test("both lookup techniques find the same Task: trailer commit", () => {
    const sha = commit(
      "feat(x): the work\n\nbody.\n\nTask: fn-7-feat.3\n",
      repo,
    );

    // Technique A: find-task-commit's grouped scan.
    const groups = findCommitGroups(["fn-7-feat.3"], repo, null);
    expect(groups).toEqual([{ repo: resolvedRepo, shas: [sha] }]);

    // Technique B: reconcile's source-commit scan.
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
    const unborn = realpathSync(mkdtempSync(join(tmpdir(), "planctl-unborn-")));
    try {
      fakeInitRepo(unborn);
      expect(stateHeadVisible(unborn, "fn-1-x.1")).toBe(false);
    } finally {
      rmSync(unborn, { recursive: true, force: true });
    }
  });

  test("committed task JSON with worker_done_at → true", () => {
    const rel = ".keeper/tasks/fn-1-x.1.json";
    mkdirSync(join(repo, ".keeper", "tasks"), { recursive: true });
    require("node:fs").writeFileSync(
      join(repo, rel),
      `${JSON.stringify({ id: "fn-1-x.1", worker_done_at: "2026-01-01T00:00:00Z" })}\n`,
    );
    fakeCommitTaskJson(repo, "fn-1-x.1");
    expect(stateHeadVisible(repo, "fn-1-x.1")).toBe(true);
  });

  test("path absent from HEAD → false", () => {
    // A born HEAD (a source commit exists) but no committed task JSON blob.
    commit("feat: seed\n\nTask: fn-1-x.1\n", repo);
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
