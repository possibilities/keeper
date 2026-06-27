/**
 * Fast-tier coverage for the PURE helpers + fake-git-driven decisions of
 * `src/worktree-git.ts` (fn-959.3). No real git: the pure parse functions take
 * captured-from-real-git strings, and the git-shelling wrappers run against a
 * recording {@link fakeAsyncGit} so the suite asserts keeper's DECISIONS (the
 * default-branch pick, the linked-worktree verdict, the porcelain parse, the
 * is-ancestor merge skip, the MERGE_HEAD-guarded abort, the prune --expire now,
 * the no-blind-force remove, the flock-around-merge). The end-to-end lifecycle
 * against a real repo lives in `worktree-git-realgit.slow.test.ts`.
 */

import { expect, test } from "bun:test";
import {
  branchExists,
  commitWorkLockPath,
  DEFAULT_BRANCH_FALLBACKS,
  ensureWorktree,
  epicBaseHasDoneState,
  isKeeperLaneEntry,
  isLinkedWorktree,
  isLinkedWorktreePure,
  mergeBranchInto,
  parseWorktreeList,
  pruneWorktrees,
  removeWorktree,
  resolveDefaultBranch,
  resolveDefaultBranchPure,
  type WorktreeEntry,
} from "../src/worktree-git";
import {
  argvStartsWith,
  type FakeGitRule,
  fakeAsyncGit,
} from "./helpers/fake-git";

// ---------------------------------------------------------------------------
// resolveDefaultBranchPure
// ---------------------------------------------------------------------------

test("resolveDefaultBranchPure: origin/HEAD resolved → strips remote prefix", () => {
  expect(
    resolveDefaultBranchPure({ code: 0, stdout: "origin/main\n" }, []),
  ).toBe("main");
  expect(
    resolveDefaultBranchPure({ code: 0, stdout: "origin/trunk\n" }, []),
  ).toBe("trunk");
});

test("resolveDefaultBranchPure: a slashless ref is returned verbatim", () => {
  expect(resolveDefaultBranchPure({ code: 0, stdout: "develop\n" }, [])).toBe(
    "develop",
  );
});

test("resolveDefaultBranchPure: no origin/HEAD → first existing fallback wins", () => {
  // master exists, main does not → master (main is first in the chain but absent).
  expect(
    resolveDefaultBranchPure({ code: 128, stdout: "" }, ["master", "feature"]),
  ).toBe("master");
  // main exists → main beats master (chain order).
  expect(
    resolveDefaultBranchPure({ code: 128, stdout: "" }, ["master", "main"]),
  ).toBe("main");
});

test("resolveDefaultBranchPure: no origin/HEAD, no known branch → main last resort", () => {
  expect(resolveDefaultBranchPure({ code: 128, stdout: "" }, ["weird"])).toBe(
    "main",
  );
  expect(resolveDefaultBranchPure({ code: 128, stdout: "" }, [])).toBe("main");
  expect(DEFAULT_BRANCH_FALLBACKS[0]).toBe("main");
});

test("resolveDefaultBranchPure: empty stdout on exit 0 falls through to fallback", () => {
  expect(
    resolveDefaultBranchPure({ code: 0, stdout: "  \n" }, ["master"]),
  ).toBe("master");
});

// ---------------------------------------------------------------------------
// isLinkedWorktreePure
// ---------------------------------------------------------------------------

test("isLinkedWorktreePure: git-dir differs from common-dir → linked", () => {
  expect(
    isLinkedWorktreePure({
      gitDir: "/repo/.git/worktrees/lane-b",
      gitCommonDir: "/repo/.git",
      superproject: "",
    }),
  ).toBe(true);
});

test("isLinkedWorktreePure: git-dir equals common-dir → main worktree, not linked", () => {
  expect(
    isLinkedWorktreePure({
      gitDir: "/repo/.git",
      gitCommonDir: "/repo/.git",
      superproject: "",
    }),
  ).toBe(false);
});

test("isLinkedWorktreePure: submodule guard — differing dirs but a superproject → not linked", () => {
  expect(
    isLinkedWorktreePure({
      gitDir: "/super/.git/modules/sub",
      gitCommonDir: "/super/.git/modules/sub",
      superproject: "/super",
    }),
  ).toBe(false);
  // Even when the dirs differ, a non-empty superproject vetoes "linked".
  expect(
    isLinkedWorktreePure({
      gitDir: "/super/.git/modules/sub/worktrees/x",
      gitCommonDir: "/super/.git/modules/sub",
      superproject: "/super\n",
    }),
  ).toBe(false);
});

test("isLinkedWorktreePure: a trailing slash difference is normalized away", () => {
  expect(
    isLinkedWorktreePure({
      gitDir: "/repo/.git/",
      gitCommonDir: "/repo/.git",
      superproject: "",
    }),
  ).toBe(false);
});

// ---------------------------------------------------------------------------
// parseWorktreeList
// ---------------------------------------------------------------------------

test("parseWorktreeList: parses path/HEAD/branch records split by blank lines", () => {
  const stdout = [
    "worktree /repo",
    "HEAD abc123",
    "branch refs/heads/main",
    "",
    "worktree /repo.worktrees/keeper-epic-fn-1-B",
    "HEAD def456",
    "branch refs/heads/keeper/epic/fn-1/B",
    "",
  ].join("\n");
  expect(parseWorktreeList(stdout)).toEqual([
    { path: "/repo", branch: "refs/heads/main", head: "abc123", bare: false },
    {
      path: "/repo.worktrees/keeper-epic-fn-1-B",
      branch: "refs/heads/keeper/epic/fn-1/B",
      head: "def456",
      bare: false,
    },
  ]);
});

test("parseWorktreeList: a detached entry has null branch; bare flag parses", () => {
  const stdout = [
    "worktree /bare",
    "bare",
    "",
    "worktree /detached",
    "HEAD aaa",
    "detached",
    "",
  ].join("\n");
  expect(parseWorktreeList(stdout)).toEqual([
    { path: "/bare", branch: null, head: null, bare: true },
    { path: "/detached", branch: null, head: "aaa", bare: false },
  ]);
});

test("parseWorktreeList: empty output → no entries", () => {
  expect(parseWorktreeList("")).toEqual([]);
});

// ---------------------------------------------------------------------------
// fn-972 BUG 4 — isKeeperLaneEntry (pure keeper-lane classifier for the
// recovery sweep's pass-1 filter)
// ---------------------------------------------------------------------------

const entry = (over: Partial<WorktreeEntry>): WorktreeEntry => ({
  path: "/wt",
  branch: null,
  head: "abc",
  bare: false,
  ...over,
});

test("isKeeperLaneEntry: a keeper base/rib branch → true; a foreign or detached entry → false", () => {
  // The base and the ribs both live under `keeper/epic/`.
  expect(
    isKeeperLaneEntry(entry({ branch: "refs/heads/keeper/epic/fn-1-foo" })),
  ).toBe(true);
  expect(
    isKeeperLaneEntry(
      entry({ branch: "refs/heads/keeper/epic/fn-1-foo/fn-1-foo.2" }),
    ),
  ).toBe(true);
  // A foreign linked worktree (e.g. another tool's `.claude/worktrees` lane) on a
  // non-keeper branch → never keeper's to recover.
  expect(isKeeperLaneEntry(entry({ branch: "refs/heads/some-feature" }))).toBe(
    false,
  );
  // A branch that merely CONTAINS the token elsewhere is not a lane.
  expect(
    isKeeperLaneEntry(entry({ branch: "refs/heads/feature/keeper/epic/x" })),
  ).toBe(false);
  // A detached entry (null branch) is never a lane.
  expect(isKeeperLaneEntry(entry({ branch: null }))).toBe(false);
});

// ---------------------------------------------------------------------------
// fn-972 BUG 3 — epicBaseHasDoneState (the lane-base done-state git confirm
// that decouples finalize from the main-worktree projection)
// ---------------------------------------------------------------------------

test("epicBaseHasDoneState: reads `git show <base>:<spec>` and returns status===done", async () => {
  const done = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "show"),
      result: {
        exitCode: 0,
        stdout: JSON.stringify({ id: "fn-1-foo", status: "done" }),
      },
    },
  ]);
  expect(await epicBaseHasDoneState("/repo", "fn-1-foo", done.run)).toBe(true);
  // It reads the epic spec at the LANE base tip — `keeper/epic/<id>` + the
  // `.keeper/epics/<id>.json` path, NOT the main worktree's working copy.
  expect(done.calls[0].args).toEqual([
    "show",
    "keeper/epic/fn-1-foo:.keeper/epics/fn-1-foo.json",
  ]);
  expect(done.calls[0].cwd).toBe("/repo");
});

test("epicBaseHasDoneState: a still-open spec, a non-zero show, or torn JSON → false", async () => {
  const open = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "show"),
      result: { exitCode: 0, stdout: JSON.stringify({ status: "open" }) },
    },
  ]);
  expect(await epicBaseHasDoneState("/repo", "fn-1-foo", open.run)).toBe(false);

  // Missing branch/file → `git show` exits non-zero.
  const missing = fakeAsyncGit([
    { when: (a) => argvStartsWith(a, "show"), result: { exitCode: 128 } },
  ]);
  expect(await epicBaseHasDoneState("/repo", "fn-1-foo", missing.run)).toBe(
    false,
  );

  // A torn / mid-write blob folds to false — never throws.
  const torn = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "show"),
      result: { exitCode: 0, stdout: "{not json" },
    },
  ]);
  expect(await epicBaseHasDoneState("/repo", "fn-1-foo", torn.run)).toBe(false);
});

// ---------------------------------------------------------------------------
// commitWorkLockPath
// ---------------------------------------------------------------------------

test("commitWorkLockPath: appends the lock name to the per-worktree git dir", async () => {
  const { run } = fakeAsyncGit([
    {
      when: (a) =>
        argvStartsWith(a, "rev-parse", "--path-format=absolute", "--git-dir"),
      result: { stdout: "/repo/.git\n" },
    },
  ]);
  expect(await commitWorkLockPath("/repo", run)).toBe(
    "/repo/.git/keeper-commit-work.lock",
  );
});

test("commitWorkLockPath: falls back to the worktree-anchored .git on a non-repo cwd", async () => {
  const { run } = fakeAsyncGit([
    {
      when: (a) =>
        argvStartsWith(a, "rev-parse", "--path-format=absolute", "--git-dir"),
      result: { exitCode: 128, stderr: "not a git repo" },
    },
  ]);
  // Never a bare relative `.git` (would resolve against the daemon's cwd) and
  // never `/keeper-commit-work.lock` (root, from empty stdout).
  expect(await commitWorkLockPath("/nowhere", run)).toBe(
    "/nowhere/.git/keeper-commit-work.lock",
  );
});

test("commitWorkLockPath: two linked worktrees get DISTINCT locks; a base-merge and base commit-work share ONE (identical argv)", async () => {
  const lockFor = (gitDir: string) =>
    commitWorkLockPath(
      "/repo",
      fakeAsyncGit([
        {
          when: (a) =>
            argvStartsWith(
              a,
              "rev-parse",
              "--path-format=absolute",
              "--git-dir",
            ),
          result: { stdout: `${gitDir}\n` },
        },
      ]).run,
    );

  // Disjoint linked worktrees never share a lock — the cross-lane serialization
  // this change drops.
  const laneA = await lockFor("/repo/.git/worktrees/A");
  const laneB = await lockFor("/repo/.git/worktrees/B");
  expect(laneA).toBe("/repo/.git/worktrees/A/keeper-commit-work.lock");
  expect(laneB).toBe("/repo/.git/worktrees/B/keeper-commit-work.lock");
  expect(laneA).not.toBe(laneB);

  // A base-merge and a base commit-work emit the SAME argv against the base's
  // own git dir → ONE lock — the serialization this change PRESERVES.
  const base = await lockFor("/repo/.git");
  expect(base).toBe("/repo/.git/keeper-commit-work.lock");
  expect(await lockFor("/repo/.git")).toBe(base);
});

// ---------------------------------------------------------------------------
// resolveDefaultBranch (wrapper) + isLinkedWorktree (wrapper)
// ---------------------------------------------------------------------------

test("resolveDefaultBranch: wires symbolic-ref + for-each-ref into the pure picker", async () => {
  const { run, calls } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "symbolic-ref"),
      result: { stdout: "origin/develop\n" },
    },
  ]);
  expect(await resolveDefaultBranch("/repo", run)).toBe("develop");
  expect(
    calls.some((c) => argvStartsWith(c.args, "symbolic-ref", "--short")),
  ).toBe(true);
});

test("resolveDefaultBranch: symbolic-ref fails → fallback over for-each-ref output", async () => {
  const rules: FakeGitRule[] = [
    {
      when: (a) => argvStartsWith(a, "symbolic-ref"),
      result: { exitCode: 128, stderr: "no origin/HEAD" },
    },
    {
      when: (a) => argvStartsWith(a, "for-each-ref"),
      result: { stdout: "feature\nmaster\n" },
    },
  ];
  expect(await resolveDefaultBranch("/repo", fakeAsyncGit(rules).run)).toBe(
    "master",
  );
});

test("isLinkedWorktree: differing git-dir/common-dir with no superproject → true", async () => {
  const { run } = fakeAsyncGit([
    {
      when: (a) => a.includes("--git-dir"),
      result: { stdout: "/repo/.git/worktrees/lane\n" },
    },
    {
      when: (a) => a.includes("--git-common-dir"),
      result: { stdout: "/repo/.git\n" },
    },
    {
      when: (a) => a.includes("--show-superproject-working-tree"),
      result: { stdout: "" },
    },
  ]);
  expect(await isLinkedWorktree("/repo.worktrees/lane", run)).toBe(true);
});

test("isLinkedWorktree: a probe failing exit fails safe to false", async () => {
  const { run } = fakeAsyncGit([
    {
      when: (a) => a.includes("--git-dir"),
      result: { exitCode: 128 },
    },
  ]);
  expect(await isLinkedWorktree("/nowhere", run)).toBe(false);
});

// ---------------------------------------------------------------------------
// pruneWorktrees — must always carry --expire now (default is 14 days).
// ---------------------------------------------------------------------------

test("pruneWorktrees: always passes --expire now", async () => {
  const { run, calls } = fakeAsyncGit();
  await pruneWorktrees("/repo", run);
  expect(calls).toHaveLength(1);
  expect(calls[0].args).toEqual(["worktree", "prune", "--expire", "now"]);
});

// ---------------------------------------------------------------------------
// ensureWorktree — idempotent / crash-recoverable add.
// ---------------------------------------------------------------------------

function worktreeListRule(stdout: string): FakeGitRule {
  return {
    when: (a) => argvStartsWith(a, "worktree", "list"),
    result: { stdout },
  };
}

test("ensureWorktree: already registered on the wanted branch → no add", async () => {
  const { run, calls } = fakeAsyncGit([
    worktreeListRule(
      "worktree /repo.worktrees/keeper-epic-e-B\nHEAD x\nbranch refs/heads/keeper/epic/e/B\n\n",
    ),
  ]);
  await ensureWorktree(
    "/repo",
    "/repo.worktrees/keeper-epic-e-B",
    "keeper/epic/e/B",
    "abc",
    run,
  );
  expect(calls.some((c) => argvStartsWith(c.args, "worktree", "add"))).toBe(
    false,
  );
});

test("ensureWorktree: path occupied by a DIFFERENT branch → throws loud", async () => {
  const { run } = fakeAsyncGit([
    worktreeListRule(
      "worktree /repo.worktrees/keeper-epic-e-B\nHEAD x\nbranch refs/heads/other\n\n",
    ),
  ]);
  await expect(
    ensureWorktree(
      "/repo",
      "/repo.worktrees/keeper-epic-e-B",
      "keeper/epic/e/B",
      "abc",
      run,
    ),
  ).rejects.toThrow(/already a worktree on/);
});

test("ensureWorktree: fresh path → prune then add -b off the commitish", async () => {
  const { run, calls } = fakeAsyncGit([
    worktreeListRule(""), // nothing registered
    // branch does not exist → rev-parse --verify returns non-zero
    {
      when: (a) => argvStartsWith(a, "rev-parse", "--verify"),
      result: { exitCode: 1 },
    },
  ]);
  await ensureWorktree(
    "/repo",
    "/repo.worktrees/keeper-epic-e-B",
    "keeper/epic/e/B",
    "deadbeef",
    run,
  );
  // prune --expire now ran before the add.
  const pruneIdx = calls.findIndex((c) =>
    argvStartsWith(c.args, "worktree", "prune"),
  );
  const addIdx = calls.findIndex((c) =>
    argvStartsWith(c.args, "worktree", "add"),
  );
  expect(pruneIdx).toBeGreaterThanOrEqual(0);
  expect(addIdx).toBeGreaterThan(pruneIdx);
  expect(calls[addIdx].args).toEqual([
    "worktree",
    "add",
    "-b",
    "keeper/epic/e/B",
    "/repo.worktrees/keeper-epic-e-B",
    "deadbeef",
  ]);
});

test("branchExists: rev-parse --verify exit 0 → true, non-zero → false", async () => {
  const present = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "rev-parse", "--verify", "--quiet"),
      result: { exitCode: 0, stdout: "abc\n" },
    },
  ]);
  expect(await branchExists("/repo", "keeper/epic/fn-1-foo", present.run)).toBe(
    true,
  );
  // It verifies the fully-qualified ref, not the bare name.
  expect(present.calls[0].args).toEqual([
    "rev-parse",
    "--verify",
    "--quiet",
    "refs/heads/keeper/epic/fn-1-foo",
  ]);

  const absent = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "rev-parse", "--verify", "--quiet"),
      result: { exitCode: 1 },
    },
  ]);
  expect(await branchExists("/repo", "keeper/epic/fn-1-foo", absent.run)).toBe(
    false,
  );
});

test("ensureWorktree: branch already exists (crashed prior add) → checkout, no -b", async () => {
  const { run, calls } = fakeAsyncGit([
    worktreeListRule(""),
    {
      when: (a) => argvStartsWith(a, "rev-parse", "--verify"),
      result: { exitCode: 0, stdout: "abc\n" }, // branch exists
    },
  ]);
  await ensureWorktree(
    "/repo",
    "/repo.worktrees/keeper-epic-e-B",
    "keeper/epic/e/B",
    "deadbeef",
    run,
  );
  const add = calls.find((c) => argvStartsWith(c.args, "worktree", "add"));
  expect(add?.args).toEqual([
    "worktree",
    "add",
    "/repo.worktrees/keeper-epic-e-B",
    "keeper/epic/e/B",
  ]);
});

test("ensureWorktree: a failing add throws with git stderr", async () => {
  const { run } = fakeAsyncGit([
    worktreeListRule(""),
    {
      when: (a) => argvStartsWith(a, "rev-parse", "--verify"),
      result: { exitCode: 1 },
    },
    {
      when: (a) => argvStartsWith(a, "worktree", "add"),
      result: { exitCode: 128, stderr: "fatal: boom" },
    },
  ]);
  await expect(ensureWorktree("/repo", "/p", "b", "c", run)).rejects.toThrow(
    /fatal: boom/,
  );
});

// ---------------------------------------------------------------------------
// mergeBranchInto — sequential pairwise, is-ancestor skip, MERGE_HEAD abort,
// flock around the merge window.
// ---------------------------------------------------------------------------

/** A lock stub recording acquire/release ordering. */
function recordingLock() {
  const events: string[] = [];
  const acquire = (lockPath: string) => {
    events.push(`acquire:${lockPath}`);
    return {
      release() {
        events.push("release");
      },
    };
  };
  return { acquire, events };
}

test("mergeBranchInto: source already an ancestor → already-merged, no merge, no lock", async () => {
  const { run, calls } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "merge-base", "--is-ancestor"),
      result: { exitCode: 0 },
    },
  ]);
  const lock = recordingLock();
  const res = await mergeBranchInto("/wt", "src", run, lock.acquire);
  expect(res).toEqual({ kind: "already-merged" });
  expect(calls.some((c) => argvStartsWith(c.args, "merge", "--no-edit"))).toBe(
    false,
  );
  expect(lock.events).toEqual([]); // no lock taken on the skip path
});

test("mergeBranchInto: clean merge → merged, lock acquired+released around merge", async () => {
  const { run, calls } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "merge-base", "--is-ancestor"),
      result: { exitCode: 1 }, // not an ancestor → must merge
    },
    {
      when: (a) =>
        argvStartsWith(a, "rev-parse", "--path-format=absolute", "--git-dir"),
      result: { stdout: "/wt/.git\n" },
    },
    {
      when: (a) => argvStartsWith(a, "merge", "--no-edit"),
      result: { exitCode: 0 },
    },
  ]);
  const lock = recordingLock();
  const res = await mergeBranchInto("/wt", "src", run, lock.acquire);
  expect(res).toEqual({ kind: "merged" });
  expect(lock.events).toEqual([
    "acquire:/wt/.git/keeper-commit-work.lock",
    "release",
  ]);
  expect(calls.some((c) => argvStartsWith(c.args, "merge", "--no-edit"))).toBe(
    true,
  );
});

test("mergeBranchInto: conflict with MERGE_HEAD → abort, conflict, lock released", async () => {
  const { run, calls } = fakeAsyncGit([
    {
      // Source resolves (`refs/heads/<src>^{commit}` exit 0) — NOT a phantom, so
      // the merge path runs. Keyed on the `^{commit}` suffix, not the shared
      // `rev-parse --verify` prefix, so it can't collide with the MERGE_HEAD rule.
      when: (a) =>
        argvStartsWith(a, "rev-parse", "--quiet", "--verify") &&
        a.some((t) => t.endsWith("^{commit}")),
      result: { exitCode: 0 },
    },
    {
      when: (a) => argvStartsWith(a, "merge-base", "--is-ancestor"),
      result: { exitCode: 1 },
    },
    {
      when: (a) =>
        argvStartsWith(a, "rev-parse", "--path-format=absolute", "--git-dir"),
      result: { stdout: "/wt/.git\n" },
    },
    {
      when: (a) => argvStartsWith(a, "merge", "--no-edit"),
      result: { exitCode: 1, stdout: "CONFLICT (content): foo.ts" },
    },
    {
      when: (a) => argvStartsWith(a, "rev-parse", "--verify", "--quiet"),
      result: { exitCode: 0, stdout: "mergehead\n" }, // MERGE_HEAD present
    },
  ]);
  const lock = recordingLock();
  const res = await mergeBranchInto("/wt", "src", run, lock.acquire);
  expect(res.kind).toBe("conflict");
  if (res.kind === "conflict") {
    expect(res.stderr).toContain("CONFLICT");
  }
  expect(calls.some((c) => argvStartsWith(c.args, "merge", "--abort"))).toBe(
    true,
  );
  expect(lock.events).toEqual([
    "acquire:/wt/.git/keeper-commit-work.lock",
    "release",
  ]);
});

test("mergeBranchInto: merge fails with NO MERGE_HEAD → no spurious abort", async () => {
  const { run, calls } = fakeAsyncGit([
    {
      // Source resolves — the genuine no-MERGE_HEAD conflict path stays covered
      // (this is NOT classified as `missing-source`).
      when: (a) =>
        argvStartsWith(a, "rev-parse", "--quiet", "--verify") &&
        a.some((t) => t.endsWith("^{commit}")),
      result: { exitCode: 0 },
    },
    {
      when: (a) => argvStartsWith(a, "merge-base", "--is-ancestor"),
      result: { exitCode: 1 },
    },
    {
      when: (a) =>
        argvStartsWith(a, "rev-parse", "--path-format=absolute", "--git-dir"),
      result: { stdout: "/wt/.git\n" },
    },
    {
      when: (a) => argvStartsWith(a, "merge", "--no-edit"),
      result: { exitCode: 128, stderr: "fatal: not something we can merge" },
    },
    {
      when: (a) => argvStartsWith(a, "rev-parse", "--verify", "--quiet"),
      result: { exitCode: 1 }, // no MERGE_HEAD
    },
  ]);
  const res = await mergeBranchInto("/wt", "src", run, recordingLock().acquire);
  expect(res.kind).toBe("conflict");
  expect(calls.some((c) => argvStartsWith(c.args, "merge", "--abort"))).toBe(
    false,
  );
});

test("mergeBranchInto: phantom/unresolvable source → missing-source, no merge, no abort, no lock", async () => {
  const { run, calls } = fakeAsyncGit([
    {
      // `refs/heads/<src>^{commit}` does not resolve — a phantom lane never
      // created (its task's work landed on the default branch).
      when: (a) =>
        argvStartsWith(a, "rev-parse", "--quiet", "--verify") &&
        a.some((t) => t.endsWith("^{commit}")),
      result: { exitCode: 1 },
    },
  ]);
  const lock = recordingLock();
  const res = await mergeBranchInto("/wt", "src", run, lock.acquire);
  expect(res).toEqual({ kind: "missing-source" });
  // The probe short-circuits BEFORE merge-base, any merge, and any abort.
  expect(
    calls.some((c) => argvStartsWith(c.args, "merge-base", "--is-ancestor")),
  ).toBe(false);
  expect(calls.some((c) => argvStartsWith(c.args, "merge", "--no-edit"))).toBe(
    false,
  );
  expect(calls.some((c) => argvStartsWith(c.args, "merge", "--abort"))).toBe(
    false,
  );
  expect(lock.events).toEqual([]); // no lock taken on the phantom path
});

// ---------------------------------------------------------------------------
// removeWorktree — never blind-force; report a dirty refusal.
// ---------------------------------------------------------------------------

test("removeWorktree: not registered → removed (idempotent), no remove call", async () => {
  const { run, calls } = fakeAsyncGit([worktreeListRule("")]);
  expect(await removeWorktree("/repo", "/gone", run)).toEqual({
    kind: "removed",
  });
  expect(calls.some((c) => argvStartsWith(c.args, "worktree", "remove"))).toBe(
    false,
  );
});

test("removeWorktree: registered + clean → git worktree remove (no --force)", async () => {
  const { run, calls } = fakeAsyncGit([
    worktreeListRule("worktree /wt\nHEAD x\nbranch refs/heads/b\n\n"),
    {
      when: (a) => argvStartsWith(a, "worktree", "remove"),
      result: { exitCode: 0 },
    },
  ]);
  expect(await removeWorktree("/repo", "/wt", run)).toEqual({
    kind: "removed",
  });
  const rm = calls.find((c) => argvStartsWith(c.args, "worktree", "remove"));
  expect(rm?.args).toEqual(["worktree", "remove", "/wt"]);
  expect(rm?.args.includes("--force")).toBe(false);
});

test("removeWorktree: dirty tree → remove fails → dirty result, never forced", async () => {
  const { run, calls } = fakeAsyncGit([
    worktreeListRule("worktree /wt\nHEAD x\nbranch refs/heads/b\n\n"),
    {
      when: (a) => argvStartsWith(a, "worktree", "remove"),
      result: { exitCode: 1, stderr: "contains modified or untracked files" },
    },
  ]);
  const res = await removeWorktree("/repo", "/wt", run);
  expect(res.kind).toBe("dirty");
  if (res.kind === "dirty") {
    expect(res.stderr).toContain("modified or untracked");
  }
  // Never a second, forced attempt.
  expect(
    calls.filter((c) => argvStartsWith(c.args, "worktree", "remove")),
  ).toHaveLength(1);
});
