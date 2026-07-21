/**
 * Fast-tier coverage for the PURE helpers + fake-git-driven decisions of
 * `src/worktree-git.ts` (fn-959.3). No real git: the pure parse functions take
 * captured-from-real-git strings, and the git-shelling wrappers run against a
 * recording {@link fakeAsyncGit} so the suite asserts keeper's DECISIONS (the
 * default-branch pick, the linked-worktree verdict, the porcelain parse, the
 * is-ancestor merge skip, the MERGE_HEAD-guarded abort, the prune --expire now,
 * the no-blind-force remove, the flock-around-merge).
 */

import { afterEach, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  GIT_SPAWN_TIMEOUT_CODE,
  type GitRunner,
} from "../src/commit-work/git-exec";
import {
  BASELINE_SCRATCH_PREFIX,
  backupThenCleanSharedCheckout,
  backupThenForceRemoveWorktree,
  baselineScratchPathFor,
  branchExists,
  classifyLaneOwnership,
  classifyLinkedWorktree,
  classifyPremergeRedundancy,
  commitWorkLockPath,
  currentBranch,
  DEFAULT_BRANCH_FALLBACKS,
  ensureWorktree,
  ensureWorktreeDepLink,
  enumerateEpicLaneBranches,
  epicIdFromKeeperLaneEntry,
  isBaselineScratchPath,
  isKeeperLaneEntry,
  isLinkedWorktree,
  isLinkedWorktreePure,
  isWorktreeDepPlant,
  keeperLaneIdentity,
  LANE_DIRT_INDEX_MAX_BYTES,
  type LockAcquirer,
  listEpicLaneBranches,
  losslessPremergeClean,
  measureBaseDrift,
  mergeBranchInto,
  mergeReadiness,
  parseWorktreeList,
  provisionScratchWorktree,
  pruneBaselineScratchWorktrees,
  pruneWorktreeHusk,
  pruneWorktrees,
  remotePushFastForwardable,
  removeScratchWorktree,
  removeWorktree,
  resolveDefaultBranch,
  resolveDefaultBranchPure,
  sharedCheckoutDirtSnapshotId,
  WORKTREE_DEP_LINK_NAME,
  type WorktreeEntry,
  worktreeDepLinkTarget,
} from "../src/worktree-git";
import { repoDirHash } from "../src/worktree-plan";
import {
  argvHas,
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
    "branch refs/heads/keeper/epic/fn-1--B",
    "",
  ].join("\n");
  expect(parseWorktreeList(stdout)).toEqual([
    { path: "/repo", branch: "refs/heads/main", head: "abc123", bare: false },
    {
      path: "/repo.worktrees/keeper-epic-fn-1-B",
      branch: "refs/heads/keeper/epic/fn-1--B",
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

test("parseWorktreeList: preserves the porcelain lock annotation", () => {
  expect(
    parseWorktreeList(
      "worktree /lane\nHEAD abc\nbranch refs/heads/keeper/epic/fn-1\nlocked maintenance\n\n",
    )[0]?.locked,
  ).toBe("maintenance");
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
      entry({ branch: "refs/heads/keeper/epic/fn-1-foo--fn-1-foo.2" }),
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

test("keeper lane identity recovers the epic and optional task from a base or rib", () => {
  // A base lane → the whole tail is the epic id.
  expect(
    epicIdFromKeeperLaneEntry(
      entry({ branch: "refs/heads/keeper/epic/fn-1-foo" }),
    ),
  ).toBe("fn-1-foo");
  // A rib lane (`<epic_id>--<task_id>`) → split on the FIRST `--`.
  const rib = entry({
    branch: "refs/heads/keeper/epic/fn-1-foo--fn-1-foo.2",
  });
  expect(epicIdFromKeeperLaneEntry(rib)).toBe("fn-1-foo");
  expect(keeperLaneIdentity(rib)).toEqual({
    epicId: "fn-1-foo",
    taskId: "fn-1-foo.2",
  });
  expect(
    keeperLaneIdentity(entry({ branch: "refs/heads/keeper/epic/fn-1-foo" })),
  ).toEqual({ epicId: "fn-1-foo", taskId: null });
  // A short branch (no `refs/heads/` prefix) is handled the same way.
  expect(
    epicIdFromKeeperLaneEntry(entry({ branch: "keeper/epic/fn-9-bar" })),
  ).toBe("fn-9-bar");
  // Non-keeper / detached / empty-tail → null (never a lane epic).
  expect(
    epicIdFromKeeperLaneEntry(entry({ branch: "refs/heads/some-feature" })),
  ).toBe(null);
  expect(epicIdFromKeeperLaneEntry(entry({ branch: null }))).toBe(null);
  expect(
    epicIdFromKeeperLaneEntry(entry({ branch: "refs/heads/keeper/epic/" })),
  ).toBe(null);
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

test("classifyLinkedWorktree: differing git-dir/common-dir, no superproject → linked", async () => {
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
  expect(await classifyLinkedWorktree("/repo.worktrees/lane", run)).toBe(
    "linked",
  );
});

test("classifyLinkedWorktree: equal git-dir/common-dir → standalone main checkout", async () => {
  const { run } = fakeAsyncGit([
    {
      when: (a) => a.includes("--git-dir"),
      result: { stdout: "/repo/.git\n" },
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
  expect(await classifyLinkedWorktree("/repo", run)).toBe("standalone");
});

test("classifyLinkedWorktree: a git-dir probe nonzero exit → error (defer, never fail-open)", async () => {
  // Distinct from `isLinkedWorktree`'s fail-open false: the caller must DEFER on
  // an inconclusive probe rather than fold it into the not-linked/off-branch path.
  const { run } = fakeAsyncGit([
    {
      when: (a) => a.includes("--git-dir"),
      result: { exitCode: 128 },
    },
  ]);
  expect(await classifyLinkedWorktree("/nowhere", run)).toBe("error");
});

test("classifyLaneOwnership: owned / foreign / ambiguous / locked truth table", async () => {
  const keeperEntry = entry({
    path: "/lane",
    branch: "refs/heads/keeper/epic/fn-1-foo",
  });
  const identityRunner =
    (laneGit: string, laneCommon: string, fail = false): GitRunner =>
    async (args, options) => {
      if (fail) return { code: 128, stdout: "", stderr: "probe failed" };
      const cwd = options?.cwd ?? "";
      const common = args.includes("--git-common-dir");
      return {
        code: 0,
        stdout:
          cwd === "/repo"
            ? "/repo/.git\n"
            : common
              ? `${laneCommon}\n`
              : `${laneGit}\n`,
        stderr: "",
      };
    };
  expect(
    await classifyLaneOwnership(
      "/repo",
      keeperEntry,
      identityRunner("/repo/.git/worktrees/lane", "/repo/.git"),
    ),
  ).toEqual({ kind: "owned", epicId: "fn-1-foo" });
  expect(
    (
      await classifyLaneOwnership(
        "/repo",
        keeperEntry,
        identityRunner("/other/.git/worktrees/lane", "/other/.git"),
      )
    ).kind,
  ).toBe("foreign");
  expect(
    (
      await classifyLaneOwnership(
        "/repo",
        keeperEntry,
        identityRunner("/lane/.git", "/lane/.git"),
      )
    ).kind,
  ).toBe("foreign");
  expect(
    (
      await classifyLaneOwnership(
        "/repo",
        keeperEntry,
        identityRunner("", "", true),
      )
    ).kind,
  ).toBe("ambiguous");
  expect(
    (
      await classifyLaneOwnership(
        "/repo",
        { ...keeperEntry, locked: "busy" },
        identityRunner("", ""),
      )
    ).kind,
  ).toBe("locked");
  expect(
    (
      await classifyLaneOwnership(
        "/repo",
        { ...keeperEntry, branch: "refs/heads/feature" },
        identityRunner("", ""),
      )
    ).kind,
  ).toBe("ambiguous");
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
      "worktree /repo.worktrees/keeper-epic-e-B\nHEAD x\nbranch refs/heads/keeper/epic/e--B\n\n",
    ),
  ]);
  await ensureWorktree(
    "/repo",
    "/repo.worktrees/keeper-epic-e-B",
    "keeper/epic/e--B",
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
  expect(
    ensureWorktree(
      "/repo",
      "/repo.worktrees/keeper-epic-e-B",
      "keeper/epic/e--B",
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
    "keeper/epic/e--B",
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
    "keeper/epic/e--B",
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
    "keeper/epic/e--B",
    "deadbeef",
    run,
  );
  const add = calls.find((c) => argvStartsWith(c.args, "worktree", "add"));
  expect(add?.args).toEqual([
    "worktree",
    "add",
    "/repo.worktrees/keeper-epic-e-B",
    "keeper/epic/e--B",
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
  expect(ensureWorktree("/repo", "/p", "b", "c", run)).rejects.toThrow(
    /fatal: boom/,
  );
});

type WorktreeDepEntry =
  | { kind: "dir" }
  | { kind: "symlink"; resolvesTo: string | null }
  | null;

function fakeWorktreeDepLinkFs(opts: {
  sourceStores?: string[];
  packageDirs?: string[];
  tree?: Record<string, string[]>;
  entries?: Record<string, WorktreeDepEntry>;
  missingWorktreeDirs?: string[];
}) {
  const SOURCE = "/repo";
  const LANE = "/repo.worktrees/lane";
  const stores = new Set(opts.sourceStores ?? []);
  const pkgs = new Set(opts.packageDirs ?? []);
  const tree = opts.tree ?? {};
  const entries: Record<string, WorktreeDepEntry> = { ...(opts.entries ?? {}) };
  const missingDirs = new Set(opts.missingWorktreeDirs ?? []);
  const symlinks: Array<[string, string, string]> = [];
  let unlinks = 0;
  const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
  const relUnder = (root: string, path: string): string | null =>
    path === root
      ? ""
      : path.startsWith(`${root}/`)
        ? path.slice(root.length + 1)
        : null;
  const storeDir = (rel: string): string | null =>
    rel === "node_modules"
      ? ""
      : rel.endsWith("/node_modules")
        ? rel.slice(0, -"/node_modules".length)
        : null;
  const realStore = (dir: string) =>
    `/private/repo${dir === "" ? "" : `/${dir}`}/node_modules`;
  return {
    fs: {
      async lstat(path: string) {
        const s = relUnder(SOURCE, path);
        if (s !== null && s.endsWith("/package.json")) {
          if (pkgs.has(s.slice(0, -"/package.json".length))) {
            return { isSymbolicLink: () => false };
          }
          throw missing();
        }
        const l = relUnder(LANE, path);
        const dir = l === null ? null : storeDir(l);
        if (dir !== null) {
          const entry = entries[dir] ?? null;
          if (entry === null) throw missing();
          return { isSymbolicLink: () => entry.kind === "symlink" };
        }
        throw missing();
      },
      async realpath(path: string) {
        const s = relUnder(SOURCE, path);
        const sDir = s === null ? null : storeDir(s);
        if (sDir !== null) {
          if (stores.has(sDir)) return realStore(sDir);
          throw missing();
        }
        const l = relUnder(LANE, path);
        const lDir = l === null ? null : storeDir(l);
        if (lDir !== null) {
          const entry = entries[lDir] ?? null;
          if (entry?.kind !== "symlink" || entry.resolvesTo === null) {
            throw missing();
          }
          return entry.resolvesTo;
        }
        throw missing();
      },
      async symlink(target: string, path: string, type: "dir") {
        const l = relUnder(LANE, path);
        const dir = l === null ? null : storeDir(l);
        if (dir === null) throw new Error(`unexpected symlink at ${path}`);
        if (missingDirs.has(dir)) throw missing();
        symlinks.push([target, path, type]);
        entries[dir] = { kind: "symlink", resolvesTo: realStore(dir) };
      },
      async unlink(path: string) {
        const l = relUnder(LANE, path);
        const dir = l === null ? null : storeDir(l);
        if (dir === null) throw new Error(`unexpected unlink at ${path}`);
        unlinks += 1;
        entries[dir] = null;
      },
      async readdir(path: string) {
        const s = relUnder(SOURCE, path);
        const names = s === null ? undefined : tree[s];
        if (names === undefined) throw missing();
        return names.map((name) => ({
          name,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        }));
      },
    },
    entry: (dir = "") => entries[dir] ?? null,
    symlinks,
    unlinks: () => unlinks,
  };
}

test("ensureWorktreeDepLink: a bare worktree links to its source dependency store", async () => {
  const fake = fakeWorktreeDepLinkFs({ sourceStores: [""] });
  await ensureWorktreeDepLink("/repo", "/repo.worktrees/lane", fake.fs);
  expect(fake.symlinks).toEqual([
    ["/repo/node_modules", "/repo.worktrees/lane/node_modules", "dir"],
  ]);
  expect(fake.entry()).toEqual({
    kind: "symlink",
    resolvesTo: "/private/repo/node_modules",
  });
});

test("ensureWorktreeDepLink: a correct link is an idempotent no-op", async () => {
  const fake = fakeWorktreeDepLinkFs({
    sourceStores: [""],
    entries: {
      "": { kind: "symlink", resolvesTo: "/private/repo/node_modules" },
    },
  });
  await ensureWorktreeDepLink("/repo", "/repo.worktrees/lane", fake.fs);
  expect(fake.symlinks).toEqual([]);
  expect(fake.unlinks()).toBe(0);
});

test("ensureWorktreeDepLink: a real worktree directory is left untouched", async () => {
  const fake = fakeWorktreeDepLinkFs({
    sourceStores: [""],
    entries: { "": { kind: "dir" } },
  });
  await ensureWorktreeDepLink("/repo", "/repo.worktrees/lane", fake.fs);
  expect(fake.entry()).toEqual({ kind: "dir" });
  expect(fake.symlinks).toEqual([]);
});

test("ensureWorktreeDepLink: a missing source dependency store is skipped", async () => {
  const fake = fakeWorktreeDepLinkFs({});
  await ensureWorktreeDepLink("/repo", "/repo.worktrees/lane", fake.fs);
  expect(fake.symlinks).toEqual([]);
  expect(fake.entry()).toBeNull();
});

test("ensureWorktreeDepLink: a broken link is replaced", async () => {
  const fake = fakeWorktreeDepLinkFs({
    sourceStores: [""],
    entries: { "": { kind: "symlink", resolvesTo: null } },
  });
  await ensureWorktreeDepLink("/repo", "/repo.worktrees/lane", fake.fs);
  expect(fake.unlinks()).toBe(1);
  expect(fake.symlinks).toEqual([
    ["/repo/node_modules", "/repo.worktrees/lane/node_modules", "dir"],
  ]);
});

test("ensureWorktreeDepLink: a stale link is replaced", async () => {
  const fake = fakeWorktreeDepLinkFs({
    sourceStores: [""],
    entries: { "": { kind: "symlink", resolvesTo: "/other/node_modules" } },
  });
  await ensureWorktreeDepLink("/repo", "/repo.worktrees/lane", fake.fs);
  expect(fake.unlinks()).toBe(1);
  expect(fake.entry()).toEqual({
    kind: "symlink",
    resolvesTo: "/private/repo/node_modules",
  });
});

test("ensureWorktreeDepLink: nested package dirs with source installs are planted too", async () => {
  const fake = fakeWorktreeDepLinkFs({
    sourceStores: ["", "plugins/prompt"],
    packageDirs: ["plugins/prompt", "integrations/pi-codex-pool"],
    tree: {
      "": ["integrations", "plugins"],
      plugins: ["prompt"],
      integrations: ["pi-codex-pool"],
      "plugins/prompt": [],
      "integrations/pi-codex-pool": [],
    },
  });
  await ensureWorktreeDepLink("/repo", "/repo.worktrees/lane", fake.fs);
  // Root first, then discovery order; a package with no source store plants nothing.
  expect(fake.symlinks).toEqual([
    ["/repo/node_modules", "/repo.worktrees/lane/node_modules", "dir"],
    [
      "/repo/plugins/prompt/node_modules",
      "/repo.worktrees/lane/plugins/prompt/node_modules",
      "dir",
    ],
  ]);
  expect(fake.entry("plugins/prompt")).toEqual({
    kind: "symlink",
    resolvesTo: "/private/repo/plugins/prompt/node_modules",
  });
  expect(fake.entry("integrations/pi-codex-pool")).toBeNull();
});

test("ensureWorktreeDepLink: discovery stops at the depth bound", async () => {
  const fake = fakeWorktreeDepLinkFs({
    sourceStores: ["", "a/b/c"],
    packageDirs: ["a/b/c"],
    tree: { "": ["a"], a: ["b"], "a/b": ["c"] },
  });
  await ensureWorktreeDepLink("/repo", "/repo.worktrees/lane", fake.fs);
  expect(fake.symlinks).toEqual([
    ["/repo/node_modules", "/repo.worktrees/lane/node_modules", "dir"],
  ]);
});

test("ensureWorktreeDepLink: a worktree lacking the nested dir (historical commit) is skipped, not fatal", async () => {
  const fake = fakeWorktreeDepLinkFs({
    sourceStores: ["", "plugins/prompt"],
    packageDirs: ["plugins/prompt"],
    tree: { "": ["plugins"], plugins: ["prompt"], "plugins/prompt": [] },
    missingWorktreeDirs: ["plugins/prompt"],
  });
  await ensureWorktreeDepLink("/repo", "/repo.worktrees/lane", fake.fs);
  expect(fake.symlinks).toEqual([
    ["/repo/node_modules", "/repo.worktrees/lane/node_modules", "dir"],
  ]);
  expect(fake.entry("plugins/prompt")).toBeNull();
});

test("worktreeDepLinkTarget: the planted-artifact definition — WORKTREE_DEP_LINK_NAME joined onto the source checkout", () => {
  expect(worktreeDepLinkTarget("/repo")).toBe(
    `/repo/${WORKTREE_DEP_LINK_NAME}`,
  );
  expect(WORKTREE_DEP_LINK_NAME).toBe("node_modules");
});

test("isWorktreeDepPlant: byte-identity against the seam's plant, never by name", () => {
  const target = worktreeDepLinkTarget("/repo");
  // The exact link the seam plants → keeper residue.
  expect(isWorktreeDepPlant("/repo", WORKTREE_DEP_LINK_NAME, target)).toBe(
    true,
  );
  // Same name, a retargeted link → replaced plant, work product not residue.
  expect(
    isWorktreeDepPlant("/repo", WORKTREE_DEP_LINK_NAME, "/other/node_modules"),
  ).toBe(false);
  // A RESOLVED realpath is not the RAW target the seam wrote → not identical.
  expect(
    isWorktreeDepPlant(
      "/repo",
      WORKTREE_DEP_LINK_NAME,
      "/private/repo/node_modules",
    ),
  ).toBe(false);
  // A real (non-symlink) entry carries no link target → never a plant.
  expect(isWorktreeDepPlant("/repo", WORKTREE_DEP_LINK_NAME, undefined)).toBe(
    false,
  );
  // The seam's target under a different name is not a plant.
  expect(isWorktreeDepPlant("/repo", "vendor", target)).toBe(false);
  // A nested entry whose target is the ROOT store is a retargeted link, not a plant.
  expect(
    isWorktreeDepPlant("/repo", `sub/${WORKTREE_DEP_LINK_NAME}`, target),
  ).toBe(false);
  // A nested plant matches on ITS OWN byte-identical nested target.
  expect(
    isWorktreeDepPlant(
      "/repo",
      `plugins/prompt/${WORKTREE_DEP_LINK_NAME}`,
      "/repo/plugins/prompt/node_modules",
    ),
  ).toBe(true);
  // A nested name with a foreign target stays work product.
  expect(
    isWorktreeDepPlant(
      "/repo",
      `plugins/prompt/${WORKTREE_DEP_LINK_NAME}`,
      "/other/plugins/prompt/node_modules",
    ),
  ).toBe(false);
  // Path traversal never classifies as a plant.
  expect(
    isWorktreeDepPlant(
      "/repo",
      `../escape/${WORKTREE_DEP_LINK_NAME}`,
      resolve("/repo", `../escape/${WORKTREE_DEP_LINK_NAME}`),
    ),
  ).toBe(false);
});

// ---------------------------------------------------------------------------
// measureBaseDrift — behind-count + merge-base age, tri-state on failure.
// ---------------------------------------------------------------------------

test("measureBaseDrift: measured — behind-count is the RIGHT (default-only) count, not the left", async () => {
  const { run, calls } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "rev-list", "--left-right", "--count"),
      result: { stdout: "1\t2\n" }, // 1 base-only, 2 default-only (behind)
    },
    {
      when: (a) => argvStartsWith(a, "merge-base"),
      result: { stdout: "deadbeef\n" },
    },
    {
      when: (a) => argvStartsWith(a, "show", "-s", "--format=%ct"),
      result: { stdout: "1700000000\n" },
    },
  ]);
  const res = await measureBaseDrift("/wt", "base", "main", run);
  expect(res).toEqual({
    kind: "measured",
    behindCount: 2,
    mergeBaseEpochSeconds: 1700000000,
  });
  expect(
    calls.some(
      (c) =>
        argvStartsWith(c.args, "rev-list", "--left-right", "--count") &&
        c.args.at(-1) === "base...main",
    ),
  ).toBe(true);
  expect(
    calls.some((c) =>
      argvStartsWith(c.args, "show", "-s", "--format=%ct", "deadbeef"),
    ),
  ).toBe(true);
});

test("measureBaseDrift: no drift — both sides at zero", async () => {
  const { run } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "rev-list", "--left-right", "--count"),
      result: { stdout: "0\t0\n" },
    },
    {
      when: (a) => argvStartsWith(a, "merge-base"),
      result: { stdout: "cafebabe\n" },
    },
    {
      when: (a) => argvStartsWith(a, "show", "-s", "--format=%ct"),
      result: { stdout: "1699999999\n" },
    },
  ]);
  const res = await measureBaseDrift("/wt", "base", "main", run);
  expect(res).toEqual({
    kind: "measured",
    behindCount: 0,
    mergeBaseEpochSeconds: 1699999999,
  });
});

test("measureBaseDrift: rev-list timeout (124) → inconclusive, never throws", async () => {
  const { run } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "rev-list", "--left-right", "--count"),
      result: { exitCode: GIT_SPAWN_TIMEOUT_CODE },
    },
  ]);
  const res = await measureBaseDrift("/wt", "base", "main", run);
  expect(res).toEqual({ kind: "inconclusive" });
});

test("measureBaseDrift: rev-list ambiguous ref (128) → inconclusive", async () => {
  const { run } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "rev-list", "--left-right", "--count"),
      result: { exitCode: 128, stderr: "fatal: ambiguous argument" },
    },
  ]);
  const res = await measureBaseDrift("/wt", "base", "main", run);
  expect(res).toEqual({ kind: "inconclusive" });
});

test("measureBaseDrift: rev-list spawn failure (127) → inconclusive", async () => {
  const { run } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "rev-list", "--left-right", "--count"),
      result: { exitCode: 127, stderr: "spawn ENOENT" },
    },
  ]);
  const res = await measureBaseDrift("/wt", "base", "main", run);
  expect(res).toEqual({ kind: "inconclusive" });
});

test("measureBaseDrift: rev-list output unparseable → inconclusive", async () => {
  const { run } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "rev-list", "--left-right", "--count"),
      result: { stdout: "not-a-count\n" },
    },
  ]);
  const res = await measureBaseDrift("/wt", "base", "main", run);
  expect(res).toEqual({ kind: "inconclusive" });
});

test("measureBaseDrift: merge-base lookup fails → inconclusive (no show call)", async () => {
  const { run, calls } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "rev-list", "--left-right", "--count"),
      result: { stdout: "0\t3\n" },
    },
    {
      when: (a) => argvStartsWith(a, "merge-base"),
      result: { exitCode: 128, stderr: "fatal: no merge base" },
    },
  ]);
  const res = await measureBaseDrift("/wt", "base", "main", run);
  expect(res).toEqual({ kind: "inconclusive" });
  expect(calls.some((c) => argvStartsWith(c.args, "show", "-s"))).toBe(false);
});

test("measureBaseDrift: merge-base commit-timestamp lookup times out → inconclusive", async () => {
  const { run } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "rev-list", "--left-right", "--count"),
      result: { stdout: "0\t5\n" },
    },
    {
      when: (a) => argvStartsWith(a, "merge-base"),
      result: { stdout: "deadbeef\n" },
    },
    {
      when: (a) => argvStartsWith(a, "show", "-s", "--format=%ct"),
      result: { exitCode: GIT_SPAWN_TIMEOUT_CODE },
    },
  ]);
  const res = await measureBaseDrift("/wt", "base", "main", run);
  expect(res).toEqual({ kind: "inconclusive" });
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
      when: (a) => argvStartsWith(a, "diff", "--name-only", "--diff-filter=U"),
      result: { stdout: "src/foo.ts\ndocs/conflicted guide.md\n" },
    },
    {
      when: (a) => argvStartsWith(a, "rev-parse", "--verify", "--quiet"),
      result: { exitCode: 0, stdout: "mergehead\n" }, // MERGE_HEAD present
    },
  ]);
  const lock = recordingLock();
  const res = await mergeBranchInto("/wt", "src", run, lock.acquire);
  expect(res).toEqual({
    kind: "conflict",
    stderr: "CONFLICT (content): foo.ts",
    conflictedFiles: ["src/foo.ts", "docs/conflicted guide.md"],
  });
  const diffIndex = calls.findIndex((c) =>
    argvStartsWith(c.args, "diff", "--name-only", "--diff-filter=U"),
  );
  const abortIndex = calls.findIndex((c) =>
    argvStartsWith(c.args, "merge", "--abort"),
  );
  expect(diffIndex).toBeGreaterThan(-1);
  expect(abortIndex).toBeGreaterThan(diffIndex);
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

// B2 — a SIGKILLed (124) merge must leave no MERGE_HEAD residue: run the same
// MERGE_HEAD-guarded abort the conflict path uses, kind still local-timeout.
const resolvedSourceRule: FakeGitRule = {
  when: (a) =>
    argvStartsWith(a, "rev-parse", "--quiet", "--verify") &&
    a.some((t) => t.endsWith("^{commit}")),
  result: { exitCode: 0 },
};
const notAncestorRule: FakeGitRule = {
  when: (a) => argvStartsWith(a, "merge-base", "--is-ancestor"),
  result: { exitCode: 1 },
};
const gitDirRule: FakeGitRule = {
  when: (a) =>
    argvStartsWith(a, "rev-parse", "--path-format=absolute", "--git-dir"),
  result: { stdout: "/wt/.git\n" },
};

test("mergeBranchInto: a local-timeout (124) merge with MERGE_HEAD → guarded abort, still local-timeout, lock released", async () => {
  const { run, calls } = fakeAsyncGit([
    resolvedSourceRule,
    notAncestorRule,
    gitDirRule,
    {
      when: (a) => argvStartsWith(a, "merge", "--no-edit"),
      result: { exitCode: GIT_SPAWN_TIMEOUT_CODE }, // SIGKILLed transient stall
    },
    {
      when: (a) => argvStartsWith(a, "rev-parse", "--verify", "--quiet"),
      result: { exitCode: 0, stdout: "mergehead\n" }, // MERGE_HEAD residue present
    },
  ]);
  const lock = recordingLock();
  const res = await mergeBranchInto("/wt", "src", run, lock.acquire);
  // The classification stays local-timeout (a retry-skip) — the abort never
  // re-shapes it into a conflict.
  expect(res).toEqual({ kind: "local-timeout" });
  // The residue is cleared so next cycle does not read a spurious conflict.
  expect(calls.some((c) => argvStartsWith(c.args, "merge", "--abort"))).toBe(
    true,
  );
  expect(lock.events).toEqual([
    "acquire:/wt/.git/keeper-commit-work.lock",
    "release",
  ]);
});

test("mergeBranchInto: a local-timeout (124) merge with NO MERGE_HEAD → no spurious abort, still local-timeout", async () => {
  const { run, calls } = fakeAsyncGit([
    resolvedSourceRule,
    notAncestorRule,
    gitDirRule,
    {
      when: (a) => argvStartsWith(a, "merge", "--no-edit"),
      result: { exitCode: GIT_SPAWN_TIMEOUT_CODE },
    },
    {
      when: (a) => argvStartsWith(a, "rev-parse", "--verify", "--quiet"),
      result: { exitCode: 1 }, // no MERGE_HEAD — the kill landed before any merge state
    },
  ]);
  const res = await mergeBranchInto("/wt", "src", run, recordingLock().acquire);
  expect(res).toEqual({ kind: "local-timeout" });
  expect(calls.some((c) => argvStartsWith(c.args, "merge", "--abort"))).toBe(
    false,
  );
});

// fn-1114 — a conflict/timeout abort that ITSELF fails leaves the checkout
// mid-merge → the distinct `abort-failed` arm carrying the abort's stderr,
// instead of a silently-swallowed conflict/local-timeout. The single abort site
// is bounded by GIT_LOCAL_TIMEOUT_MS (a 124 abort surfaces here as abort-failed).
test("mergeBranchInto: conflict then a FAILED `merge --abort` → abort-failed carrying the abort stderr, lock released", async () => {
  const { run } = fakeAsyncGit([
    resolvedSourceRule,
    notAncestorRule,
    gitDirRule,
    {
      when: (a) => argvStartsWith(a, "merge", "--no-edit"),
      result: { exitCode: 1, stdout: "CONFLICT (content): foo.ts" },
    },
    {
      when: (a) => argvStartsWith(a, "rev-parse", "--verify", "--quiet"),
      result: { exitCode: 0, stdout: "mergehead\n" }, // MERGE_HEAD present
    },
    {
      when: (a) => argvStartsWith(a, "merge", "--abort"),
      result: { exitCode: 128, stderr: "fatal: could not abort the merge" },
    },
  ]);
  const lock = recordingLock();
  const res = await mergeBranchInto("/wt", "src", run, lock.acquire);
  expect(res.kind).toBe("abort-failed");
  if (res.kind === "abort-failed") {
    expect(res.stderr).toContain("could not abort");
  }
  // The lock is still released on the wedge path.
  expect(lock.events).toEqual([
    "acquire:/wt/.git/keeper-commit-work.lock",
    "release",
  ]);
});

test("mergeBranchInto: a local-timeout (124) merge then a 124 abort → abort-failed with a timeout note", async () => {
  const { run } = fakeAsyncGit([
    resolvedSourceRule,
    notAncestorRule,
    gitDirRule,
    {
      when: (a) => argvStartsWith(a, "merge", "--no-edit"),
      result: { exitCode: GIT_SPAWN_TIMEOUT_CODE },
    },
    {
      when: (a) => argvStartsWith(a, "rev-parse", "--verify", "--quiet"),
      result: { exitCode: 0, stdout: "mergehead\n" }, // MERGE_HEAD residue present
    },
    {
      when: (a) => argvStartsWith(a, "merge", "--abort"),
      result: { exitCode: GIT_SPAWN_TIMEOUT_CODE }, // the abort itself SIGKILLed
    },
  ]);
  const res = await mergeBranchInto("/wt", "src", run, recordingLock().acquire);
  expect(res.kind).toBe("abort-failed");
  if (res.kind === "abort-failed") {
    expect(res.stderr).toContain("timed out");
  }
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

test("backupThenForceRemoveWorktree: snapshots staged, unstaged, and untracked dirt before force-remove", async () => {
  const root = mkdtempSync(join(tmpdir(), "keeper-lane-dirt-"));
  const lane = join(root, "lane");
  const spool = join(root, "spool");
  mkdirSync(join(lane, "nested"), { recursive: true });
  writeFileSync(join(lane, "loose.txt"), "loose dirt\n");
  writeFileSync(join(lane, "nested", "other.txt"), "other dirt\n");
  const { run, calls } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "diff", "--cached"),
      result: { stdout: "staged patch\n" },
    },
    {
      when: (a) => argvStartsWith(a, "diff", "--binary"),
      result: { stdout: "unstaged patch\n" },
    },
    {
      when: (a) => argvStartsWith(a, "ls-files", "--others"),
      result: { stdout: "loose.txt\0nested/other.txt\0" },
    },
  ]);
  try {
    const result = await backupThenForceRemoveWorktree(
      "/repo",
      entry({
        path: lane,
        branch: "refs/heads/keeper/epic/fn-1-foo",
      }),
      run,
      { spoolDir: spool, nowMs: () => 1234, snapshotId: () => "snap" },
    );
    expect(result).toEqual({
      kind: "removed",
      snapshotDir: join(spool, "snap"),
    });
    expect(readFileSync(join(spool, "snap", "staged.patch"), "utf8")).toBe(
      "staged patch\n",
    );
    expect(readFileSync(join(spool, "snap", "unstaged.patch"), "utf8")).toBe(
      "unstaged patch\n",
    );
    expect(
      readFileSync(join(spool, "snap", "untracked", "loose.txt"), "utf8"),
    ).toBe("loose dirt\n");
    expect(
      readFileSync(
        join(spool, "snap", "untracked", "nested", "other.txt"),
        "utf8",
      ),
    ).toBe("other dirt\n");
    const indexLine = readFileSync(join(spool, "index.ndjson"), "utf8");
    expect(Buffer.byteLength(indexLine)).toBeLessThanOrEqual(
      LANE_DIRT_INDEX_MAX_BYTES,
    );
    expect(JSON.parse(indexLine).untracked_count).toBe(2);
    expect(
      calls.some((c) =>
        argvStartsWith(c.args, "worktree", "remove", "--force", lane),
      ),
    ).toBe(true);
    expect(calls.some((c) => argvStartsWith(c.args, "worktree", "prune"))).toBe(
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backupThenForceRemoveWorktree: a failed snapshot never destroys", async () => {
  const root = mkdtempSync(join(tmpdir(), "keeper-lane-dirt-fail-"));
  const { run, calls } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "diff", "--cached"),
      result: { exitCode: 128, stderr: "cannot diff" },
    },
  ]);
  try {
    const result = await backupThenForceRemoveWorktree(
      "/repo",
      entry({
        path: join(root, "lane"),
        branch: "refs/heads/keeper/epic/fn-1-foo",
      }),
      run,
      { spoolDir: join(root, "spool") },
    );
    expect(result.kind).toBe("backup-failed");
    expect(
      calls.some((c) => argvStartsWith(c.args, "worktree", "remove")),
    ).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backupThenForceRemoveWorktree: a byte-identical dep-link plant is dropped — zero spool entries, no backup failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "keeper-lane-plant-only-"));
  const repo = join(root, "repo");
  const lane = join(root, "lane");
  const spool = join(root, "spool");
  mkdirSync(lane, { recursive: true });
  // Exactly what the provisioning seam plants for this repo checkout — an untracked
  // symlink whose raw target is `worktreeDepLinkTarget(repo)`, pointing OUT of the lane.
  symlinkSync(worktreeDepLinkTarget(repo), join(lane, WORKTREE_DEP_LINK_NAME));
  const { run, calls } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "ls-files", "--others"),
      result: { stdout: `${WORKTREE_DEP_LINK_NAME}\0` },
    },
  ]);
  try {
    const result = await backupThenForceRemoveWorktree(
      repo,
      entry({ path: lane, branch: "refs/heads/keeper/epic/fn-1-foo" }),
      run,
      { spoolDir: spool, snapshotId: () => "snap" },
    );
    // Residue only → nothing spooled: no snapshot dir, no index record.
    expect(result).toEqual({ kind: "removed", snapshotDir: null });
    expect(existsSync(spool)).toBe(false);
    // The lane is still force-removed and pruned (the plant deleted with it).
    expect(
      calls.some((c) =>
        argvStartsWith(c.args, "worktree", "remove", "--force", lane),
      ),
    ).toBe(true);
    expect(calls.some((c) => argvStartsWith(c.args, "worktree", "prune"))).toBe(
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backupThenForceRemoveWorktree: a foreign file spools while a byte-identical plant is dropped", async () => {
  const root = mkdtempSync(join(tmpdir(), "keeper-lane-plant-mixed-"));
  const repo = join(root, "repo");
  const lane = join(root, "lane");
  const spool = join(root, "spool");
  mkdirSync(lane, { recursive: true });
  writeFileSync(join(lane, "loose.txt"), "real work\n");
  symlinkSync(worktreeDepLinkTarget(repo), join(lane, WORKTREE_DEP_LINK_NAME));
  const { run } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "ls-files", "--others"),
      // git lists both; only the foreign file must reach the spool.
      result: { stdout: `loose.txt\0${WORKTREE_DEP_LINK_NAME}\0` },
    },
  ]);
  try {
    const result = await backupThenForceRemoveWorktree(
      repo,
      entry({ path: lane, branch: "refs/heads/keeper/epic/fn-1-foo" }),
      run,
      { spoolDir: spool, snapshotId: () => "snap" },
    );
    expect(result).toEqual({
      kind: "removed",
      snapshotDir: join(spool, "snap"),
    });
    // The foreign file spooled; the plant did not.
    expect(
      readFileSync(join(spool, "snap", "untracked", "loose.txt"), "utf8"),
    ).toBe("real work\n");
    expect(
      existsSync(join(spool, "snap", "untracked", WORKTREE_DEP_LINK_NAME)),
    ).toBe(false);
    const record = JSON.parse(
      readFileSync(join(spool, "index.ndjson"), "utf8"),
    );
    expect(record.untracked_count).toBe(1);
    expect(record.untracked_paths).toEqual(["loose.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backupThenForceRemoveWorktree: a replaced plant (real file at the dep-link path) spools as before", async () => {
  const root = mkdtempSync(join(tmpdir(), "keeper-lane-plant-replaced-"));
  const repo = join(root, "repo");
  const lane = join(root, "lane");
  const spool = join(root, "spool");
  mkdirSync(lane, { recursive: true });
  // The dep-link path holds real content now — no longer byte-identical, so work product.
  writeFileSync(
    join(lane, WORKTREE_DEP_LINK_NAME),
    "replaced with real work\n",
  );
  const { run } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "ls-files", "--others"),
      result: { stdout: `${WORKTREE_DEP_LINK_NAME}\0` },
    },
  ]);
  try {
    const result = await backupThenForceRemoveWorktree(
      repo,
      entry({ path: lane, branch: "refs/heads/keeper/epic/fn-1-foo" }),
      run,
      { spoolDir: spool, snapshotId: () => "snap" },
    );
    expect(result).toEqual({
      kind: "removed",
      snapshotDir: join(spool, "snap"),
    });
    expect(
      readFileSync(
        join(spool, "snap", "untracked", WORKTREE_DEP_LINK_NAME),
        "utf8",
      ),
    ).toBe("replaced with real work\n");
    expect(
      JSON.parse(readFileSync(join(spool, "index.ndjson"), "utf8"))
        .untracked_count,
    ).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backupThenCleanSharedCheckout: snapshots before reset and removes only non-ignored untracked files", async () => {
  const root = mkdtempSync(join(tmpdir(), "keeper-shared-dirt-"));
  const checkout = join(root, "repo");
  const spool = join(root, "spool");
  mkdirSync(checkout, { recursive: true });
  writeFileSync(join(checkout, "loose.txt"), "untracked\n");
  writeFileSync(join(checkout, "ignored.cache"), "ignored\n");
  const { run, calls } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "diff", "--cached"),
      result: { stdout: "staged\n" },
    },
    {
      when: (a) => argvStartsWith(a, "diff", "--binary"),
      result: { stdout: "unstaged\n" },
    },
    {
      when: (a) => argvStartsWith(a, "ls-files", "--others"),
      result: { stdout: "loose.txt\0" },
    },
  ]);
  try {
    const result = await backupThenCleanSharedCheckout(checkout, run, {
      spoolDir: spool,
      nowMs: () => 4567,
      snapshotId: () => "shared-snap",
    });
    expect(result).toEqual({
      kind: "cleaned",
      snapshotDir: join(spool, "shared-snap"),
    });
    expect(
      readFileSync(
        join(spool, "shared-snap", "untracked", "loose.txt"),
        "utf8",
      ),
    ).toBe("untracked\n");
    const resetAt = calls.findIndex((c) =>
      argvStartsWith(c.args, "reset", "--hard", "HEAD"),
    );
    const cleanAt = calls.findIndex((c) =>
      argvStartsWith(c.args, "clean", "-f", "-d"),
    );
    expect(resetAt).toBeGreaterThan(2);
    expect(cleanAt).toBeGreaterThan(resetAt);
    expect(calls[cleanAt]?.args).toEqual(["clean", "-f", "-d"]);
    expect(calls[cleanAt]?.args).not.toContain("-x");
    expect(existsSync(join(checkout, "ignored.cache"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backupThenCleanSharedCheckout: backup failure never resets or cleans", async () => {
  const root = mkdtempSync(join(tmpdir(), "keeper-shared-dirt-fail-"));
  const { run, calls } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "diff", "--cached"),
      result: { exitCode: 128, stderr: "cannot snapshot" },
    },
  ]);
  try {
    const result = await backupThenCleanSharedCheckout(root, run, {
      spoolDir: join(root, "spool"),
    });
    expect(result.kind).toBe("backup-failed");
    expect(calls.some((c) => argvStartsWith(c.args, "reset"))).toBe(false);
    expect(calls.some((c) => argvStartsWith(c.args, "clean"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backupThenCleanSharedCheckout: out-of-tree untracked symlinks fail backup before clean", async () => {
  const root = mkdtempSync(join(tmpdir(), "keeper-shared-dirt-link-"));
  const checkout = join(root, "repo");
  const outside = join(root, "outside.txt");
  mkdirSync(checkout, { recursive: true });
  writeFileSync(outside, "outside\n");
  symlinkSync(outside, join(checkout, "escape"));
  const { run, calls } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "ls-files", "--others"),
      result: { stdout: "escape\0" },
    },
  ]);
  try {
    const result = await backupThenCleanSharedCheckout(checkout, run, {
      spoolDir: join(root, "spool"),
    });
    expect(result.kind).toBe("backup-failed");
    expect(calls.some((c) => argvStartsWith(c.args, "reset"))).toBe(false);
    expect(calls.some((c) => argvStartsWith(c.args, "clean"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backupThenCleanSharedCheckout: retry dedups the content-keyed shared-checkout snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "keeper-shared-dirt-retry-"));
  const checkout = join(root, "repo");
  const spool = join(root, "spool");
  mkdirSync(checkout, { recursive: true });
  const { run, calls } = fakeAsyncGit();
  try {
    const options = { spoolDir: spool };
    expect(
      (await backupThenCleanSharedCheckout(checkout, run, options)).kind,
    ).toBe("cleaned");
    expect(
      (await backupThenCleanSharedCheckout(checkout, run, options)).kind,
    ).toBe("cleaned");
    expect(
      calls.filter((c) => argvStartsWith(c.args, "diff", "--cached")),
    ).toHaveLength(2);
    expect(
      readFileSync(join(spool, "index.ndjson"), "utf8").trim().split("\n"),
    ).toHaveLength(1);
    const entries = readdirSync(spool).sort();
    expect(entries).toHaveLength(2);
    expect(entries).toContain("index.ndjson");
    expect(
      entries.some((entry) =>
        entry.startsWith(`${sharedCheckoutDirtSnapshotId(checkout)}-`),
      ),
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backupThenCleanSharedCheckout: changed dirt in the same checkout gets a distinct snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "keeper-shared-dirt-new-episode-"));
  const checkout = join(root, "repo");
  const spool = join(root, "spool");
  mkdirSync(checkout, { recursive: true });
  const loose = join(checkout, "loose.txt");
  writeFileSync(loose, "first\n");
  const { run } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "ls-files", "--others"),
      result: { stdout: "loose.txt\0" },
    },
  ]);
  try {
    expect(
      (await backupThenCleanSharedCheckout(checkout, run, { spoolDir: spool }))
        .kind,
    ).toBe("cleaned");
    writeFileSync(loose, "second\n");
    expect(
      (await backupThenCleanSharedCheckout(checkout, run, { spoolDir: spool }))
        .kind,
    ).toBe("cleaned");
    const snapshots = readdirSync(spool).filter(
      (entry) => entry !== "index.ndjson",
    );
    expect(snapshots).toHaveLength(2);
    expect(
      readFileSync(join(spool, "index.ndjson"), "utf8").trim().split("\n"),
    ).toHaveLength(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// pruneWorktreeHusk — sweep a residue-only `.claude` husk after a clean remove.
// Real per-test tmpdirs (fs in tests is fine); the `git worktree prune` leg goes
// through the injected runner. The gate is the whole blast-radius defense, so the
// veto/abort paths are covered as thoroughly as the happy path.
// ---------------------------------------------------------------------------

const huskTmpDirs: string[] = [];
function makeHuskTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "keeper-husk-"));
  huskTmpDirs.push(dir);
  return dir;
}
function prunedFrom(calls: { args: string[]; cwd?: string }[]): string[] {
  return calls
    .filter((c) => argvStartsWith(c.args, "worktree", "prune"))
    .map((c) => c.cwd ?? "");
}
afterEach(() => {
  for (const dir of huskTmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneWorktreeHusk: only-`.claude` husk → dir swept + prune from the MAIN repo cwd", async () => {
  const wt = join(makeHuskTmp(), "wt");
  mkdirSync(join(wt, ".claude"), { recursive: true });
  writeFileSync(join(wt, ".claude", "settings.json"), "{}");
  const { run, calls } = fakeAsyncGit();
  await pruneWorktreeHusk("/main-repo", wt, run);
  expect(existsSync(wt)).toBe(false); // husk swept
  const prune = calls.find((c) => argvStartsWith(c.args, "worktree", "prune"));
  expect(prune?.args).toEqual(["worktree", "prune", "--expire", "now"]);
  // Pruned from the MAIN repo, NEVER from inside the removed path.
  expect(prune?.cwd).toBe("/main-repo");
});

test("pruneWorktreeHusk: deeply-nested plain files under `.claude` → still swept", async () => {
  const wt = join(makeHuskTmp(), "wt");
  mkdirSync(join(wt, ".claude", "a", "b"), { recursive: true });
  writeFileSync(join(wt, ".claude", "a", "b", "c.txt"), "residue");
  writeFileSync(join(wt, ".claude", "top.json"), "{}");
  const { run, calls } = fakeAsyncGit();
  await pruneWorktreeHusk("/main-repo", wt, run);
  expect(existsSync(wt)).toBe(false);
  expect(prunedFrom(calls)).toEqual(["/main-repo"]);
});

test("pruneWorktreeHusk: an empty husk dir → swept (vacuously residue-only)", async () => {
  const wt = join(makeHuskTmp(), "wt");
  mkdirSync(wt, { recursive: true });
  const { run, calls } = fakeAsyncGit();
  await pruneWorktreeHusk("/main-repo", wt, run);
  expect(existsSync(wt)).toBe(false);
  expect(prunedFrom(calls)).toEqual(["/main-repo"]);
});

test("pruneWorktreeHusk: an extra top-level entry (real ignored work) → dir byte-untouched, no prune", async () => {
  const wt = join(makeHuskTmp(), "wt");
  mkdirSync(join(wt, ".claude"), { recursive: true });
  mkdirSync(join(wt, "node_modules"), { recursive: true }); // real ignored work
  writeFileSync(join(wt, ".env"), "SECRET=1"); // a real dotfile
  const { run, calls } = fakeAsyncGit();
  await pruneWorktreeHusk("/main-repo", wt, run);
  expect(existsSync(wt)).toBe(true);
  expect(existsSync(join(wt, "node_modules"))).toBe(true);
  expect(existsSync(join(wt, ".env"))).toBe(true);
  expect(prunedFrom(calls)).toEqual([]);
});

test("pruneWorktreeHusk: a top-level `.git` gitlink present → vetoed (worktree not truly gone)", async () => {
  const wt = join(makeHuskTmp(), "wt");
  mkdirSync(join(wt, ".claude"), { recursive: true });
  writeFileSync(join(wt, ".git"), "gitdir: /repo/.git/worktrees/wt\n");
  const { run, calls } = fakeAsyncGit();
  await pruneWorktreeHusk("/main-repo", wt, run);
  expect(existsSync(wt)).toBe(true);
  expect(prunedFrom(calls)).toEqual([]);
});

test("pruneWorktreeHusk: a symlink INSIDE `.claude` → whole deletion vetoed, target never followed", async () => {
  const base = makeHuskTmp();
  const outside = join(base, "outside.txt");
  writeFileSync(outside, "important");
  const wt = join(base, "wt");
  mkdirSync(join(wt, ".claude"), { recursive: true });
  symlinkSync(outside, join(wt, ".claude", "link"));
  const { run, calls } = fakeAsyncGit();
  await pruneWorktreeHusk("/main-repo", wt, run);
  expect(existsSync(wt)).toBe(true); // vetoed
  expect(existsSync(outside)).toBe(true); // never followed / removed
  expect(prunedFrom(calls)).toEqual([]);
});

test("pruneWorktreeHusk: a top-level `.claude` that is a symlink → vetoed (never traversed)", async () => {
  const base = makeHuskTmp();
  const realClaude = join(base, "real-claude");
  mkdirSync(realClaude, { recursive: true });
  writeFileSync(join(realClaude, "f"), "x");
  const wt = join(base, "wt");
  mkdirSync(wt, { recursive: true });
  symlinkSync(realClaude, join(wt, ".claude"));
  const { run, calls } = fakeAsyncGit();
  await pruneWorktreeHusk("/main-repo", wt, run);
  expect(existsSync(wt)).toBe(true);
  expect(existsSync(realClaude)).toBe(true);
  expect(prunedFrom(calls)).toEqual([]);
});

test("pruneWorktreeHusk: the worktree path ITSELF is a symlink → left untouched, no prune", async () => {
  const base = makeHuskTmp();
  const realDir = join(base, "real");
  mkdirSync(join(realDir, ".claude"), { recursive: true });
  const wt = join(base, "wt-link");
  symlinkSync(realDir, wt);
  const { run, calls } = fakeAsyncGit();
  await pruneWorktreeHusk("/main-repo", wt, run);
  expect(lstatSync(wt).isSymbolicLink()).toBe(true); // the link is left in place
  expect(existsSync(realDir)).toBe(true); // its target is never removed
  expect(prunedFrom(calls)).toEqual([]);
});

test("pruneWorktreeHusk: an already-gone path → no-op (no throw, no prune)", async () => {
  const wt = join(makeHuskTmp(), "does-not-exist");
  const { run, calls } = fakeAsyncGit();
  await pruneWorktreeHusk("/main-repo", wt, run); // must not throw
  expect(prunedFrom(calls)).toEqual([]);
});

test("pruneWorktreeHusk: a prune failure PROPAGATES for the caller to swallow (dir already swept)", async () => {
  const wt = join(makeHuskTmp(), "wt");
  mkdirSync(join(wt, ".claude"), { recursive: true });
  const run: GitRunner = async (args) => {
    if (argvStartsWith(args, "worktree", "prune")) {
      throw new Error("prune boom");
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  await expect(pruneWorktreeHusk("/main-repo", wt, run)).rejects.toThrow(
    "prune boom",
  );
  // The rm ran BEFORE the prune, so the husk is already gone; the caller logs the
  // throw and teardown (already succeeded) is unaffected.
  expect(existsSync(wt)).toBe(false);
});

// ---------------------------------------------------------------------------
// fn-985 — mergeReadiness (the finalize/recover pre-merge clean-tree guard)
// ---------------------------------------------------------------------------

const onBranchRule = (branch: string): FakeGitRule => ({
  when: (a) => argvStartsWith(a, "rev-parse", "--abbrev-ref", "HEAD"),
  result: { exitCode: 0, stdout: `${branch}\n` },
});
const statusRule = (porcelain: string, exitCode = 0): FakeGitRule => ({
  when: (a) => argvStartsWith(a, "status", "--porcelain"),
  result: { exitCode, stdout: porcelain },
});

// fn-1114 shared rules. MERGE_HEAD probe rules are keyed on the MERGE_HEAD token
// so they never collide with the CHERRY_PICK_HEAD / REVERT_HEAD / MERGE_AUTOSTASH
// pseudo-ref probes.
const mergeHeadPresentRule = (sha: string): FakeGitRule => ({
  when: (a) => argvStartsWith(a, "rev-parse") && argvHas(a, "MERGE_HEAD"),
  result: { exitCode: 0, stdout: `${sha}\n` },
});
const mergeHeadAbsentRule: FakeGitRule = {
  when: (a) => argvStartsWith(a, "rev-parse") && argvHas(a, "MERGE_HEAD"),
  result: { exitCode: 1 },
};
const autostashAbsentRule: FakeGitRule = {
  when: (a) => argvStartsWith(a, "rev-parse") && argvHas(a, "MERGE_AUTOSTASH"),
  result: { exitCode: 1 },
};
const autostashPresentRule: FakeGitRule = {
  when: (a) => argvStartsWith(a, "rev-parse") && argvHas(a, "MERGE_AUTOSTASH"),
  result: { exitCode: 0, stdout: "stashsha\n" },
};
const pointsAtRule = (refs: string[], exitCode = 0): FakeGitRule => ({
  when: (a) =>
    argvStartsWith(a, "for-each-ref") &&
    a.some((t) => t.startsWith("--points-at=")),
  result: { exitCode, stdout: refs.length > 0 ? `${refs.join("\n")}\n` : "" },
});
// git-dir resolver for the on-disk in-progress probes (rebase dirs, index.lock).
const gitDirRepoRule: FakeGitRule = {
  when: (a) =>
    argvStartsWith(a, "rev-parse", "--path-format=absolute", "--git-dir"),
  result: { exitCode: 0, stdout: "/repo/.git\n" },
};
// A PathProbe reporting only the given git-dir leaf present.
const onlyPresent =
  (leaf: string): ((p: string) => boolean) =>
  (p) =>
    p === `/repo/.git/${leaf}`;
const nonePresent = (): boolean => false;

test("mergeReadiness: on the expected branch + clean tree → ready", async () => {
  const { run, calls } = fakeAsyncGit([onBranchRule("main"), statusRule("")]);
  expect(await mergeReadiness("/repo", "main", run)).toEqual({ kind: "ready" });
  // Most-specific-first ordering: the MERGE_HEAD probe precedes the dirty
  // (status) check (a stopped merge's tree is also dirty), and the dirty check
  // precedes the off-branch (abbrev-ref) verdict (the actionable dirty cause must
  // win over off-branch when a checkout is both).
  const idxOf = (pred: (a: string[]) => boolean): number =>
    calls.findIndex((c) => pred(c.args));
  const mergeHeadIdx = idxOf((a) => argvHas(a, "MERGE_HEAD"));
  const statusIdx = idxOf((a) => argvStartsWith(a, "status", "--porcelain"));
  const branchIdx = idxOf((a) =>
    argvStartsWith(a, "rev-parse", "--abbrev-ref"),
  );
  expect(mergeHeadIdx).toBeGreaterThanOrEqual(0);
  expect(mergeHeadIdx).toBeLessThan(statusIdx);
  expect(statusIdx).toBeLessThan(branchIdx);
});

test("mergeReadiness: a CLEAN tree off the expected branch → off-branch (dirty probed clean first)", async () => {
  const { run, calls } = fakeAsyncGit([
    onBranchRule("feature-x"),
    statusRule(""), // clean → the dirty check falls through to the branch verdict
  ]);
  expect(await mergeReadiness("/repo", "main", run)).toEqual({
    kind: "off-branch",
    head: "feature-x",
  });
  // Dirty-first: the working-tree probe runs BEFORE the off-branch verdict is
  // reached, so a dirty+off-branch checkout can never mask its dirty cause.
  expect(
    calls.some((c) => argvStartsWith(c.args, "status", "--porcelain")),
  ).toBe(true);
});

test("mergeReadiness: a DIRTY tree that is ALSO off the expected branch → dirty (the actionable cause, never masked as off-branch)", async () => {
  const { run } = fakeAsyncGit([
    onBranchRule("feature-x"), // off default...
    statusRule(" M src/foo.ts\n"), // ...AND dirty
  ]);
  const res = await mergeReadiness("/repo", "main", run);
  // The dirty cause wins: an operator sees "clean the tree", not a bare
  // off-branch that would mask the real blocker (the not-on-default masking bug).
  expect(res.kind).toBe("dirty");
  if (res.kind === "dirty") {
    expect(res.detail).toContain("src/foo.ts");
  }
});

test("mergeReadiness: detached HEAD (mid-rebase reports `HEAD`) → off-branch", async () => {
  const { run } = fakeAsyncGit([onBranchRule("HEAD")]);
  expect(await mergeReadiness("/repo", "main", run)).toEqual({
    kind: "off-branch",
    head: "HEAD",
  });
});

test("mergeReadiness: on-branch but a dirty/occupied tree → dirty with the porcelain detail", async () => {
  const { run } = fakeAsyncGit([
    onBranchRule("main"),
    statusRule(" M src/foo.ts\n?? scratch.txt\n"),
  ]);
  const res = await mergeReadiness("/repo", "main", run);
  expect(res.kind).toBe("dirty");
  if (res.kind === "dirty") {
    expect(res.detail).toContain("src/foo.ts");
  }
});

test("mergeReadiness: an untracked-only shared checkout → ready (probe excludes untracked)", async () => {
  // The human's checkout holds a benign untracked file (editor temp, .env, an
  // un-ignored artifact) a merge cannot disturb. The probe runs with
  // `--untracked-files=no`, so real git reports an empty tree → ready, NOT a
  // never-finalizing skip-and-retry.
  const { run, calls } = fakeAsyncGit([
    onBranchRule("main"),
    {
      when: (a) =>
        argvStartsWith(a, "status", "--porcelain") &&
        argvHas(a, "--untracked-files=no"),
      // -uno suppresses the untracked `?? scratch.txt` line → empty output.
      result: { exitCode: 0, stdout: "" },
    },
  ]);
  expect(await mergeReadiness("/repo", "main", run)).toEqual({ kind: "ready" });
  expect(calls.some((c) => argvHas(c.args, "--untracked-files=no"))).toBe(true);
});

test("mergeReadiness: a dirty tree with NO MERGE_HEAD → dirty (the MERGE_HEAD probe resolves absent)", async () => {
  const { run } = fakeAsyncGit([
    mergeHeadAbsentRule,
    onBranchRule("main"),
    statusRule(" M src/conflict.ts\n"),
  ]);
  // MERGE_HEAD probed and absent → the tree's dirt is a generic `dirty`, not a
  // mid-merge (a rebase-conflict `UU` tree with no MERGE_HEAD lands here too).
  expect((await mergeReadiness("/repo", "main", run)).kind).toBe("dirty");
});

test("mergeReadiness: a non-zero status exit fails safe to dirty (never spuriously ready)", async () => {
  const { run } = fakeAsyncGit([
    mergeHeadAbsentRule,
    onBranchRule("main"),
    statusRule("", 128),
  ]);
  expect((await mergeReadiness("/repo", "main", run)).kind).toBe("dirty");
});

// ---------------------------------------------------------------------------
// fn-1114 — mergeReadiness classifies a mid-merge distinctly (sha + sole-
// ownership + autostash), and NAMES the foreign non-merge in-progress states.
// ---------------------------------------------------------------------------

test("mergeReadiness: MERGE_HEAD present + sole keeper/epic branch at the sha, no autostash → mid-merge, owner keeper", async () => {
  const { run } = fakeAsyncGit([
    mergeHeadPresentRule("deadbeef"),
    pointsAtRule(["refs/heads/keeper/epic/fn-1-foo"]),
    autostashAbsentRule,
  ]);
  const res = await mergeReadiness("/repo", "main", run);
  expect(res).toEqual({
    kind: "mid-merge",
    mergeHead: "deadbeef",
    owner: "keeper",
    autostash: false,
  });
});

test("mergeReadiness: mid-merge is probed BEFORE dirty — a mid-merge tree never folds into dirty", async () => {
  const { run, calls } = fakeAsyncGit([
    mergeHeadPresentRule("deadbeef"),
    pointsAtRule(["refs/heads/keeper/epic/fn-1-foo"]),
    autostashAbsentRule,
    statusRule("UU src/conflict.ts\n"), // the mid-merge tree is ALSO dirty
  ]);
  expect((await mergeReadiness("/repo", "main", run)).kind).toBe("mid-merge");
  // The MERGE_HEAD win short-circuits before the porcelain dirty probe.
  expect(
    calls.some((c) => argvStartsWith(c.args, "status", "--porcelain")),
  ).toBe(false);
});

test("mergeReadiness: mid-merge with a FOREIGN branch also at the sha → owner foreign (not sole keeper)", async () => {
  const { run } = fakeAsyncGit([
    mergeHeadPresentRule("deadbeef"),
    pointsAtRule([
      "refs/heads/keeper/epic/fn-1-foo",
      "refs/heads/someones-feature",
    ]),
    autostashAbsentRule,
  ]);
  const res = await mergeReadiness("/repo", "main", run);
  expect(res.kind).toBe("mid-merge");
  if (res.kind === "mid-merge") {
    expect(res.owner).toBe("foreign");
  }
});

test("mergeReadiness: mid-merge with an EMPTY branch-set at the sha → owner foreign", async () => {
  const { run } = fakeAsyncGit([
    mergeHeadPresentRule("deadbeef"),
    pointsAtRule([]), // nothing points at the sha
    autostashAbsentRule,
  ]);
  const res = await mergeReadiness("/repo", "main", run);
  expect(res.kind).toBe("mid-merge");
  if (res.kind === "mid-merge") {
    expect(res.owner).toBe("foreign");
  }
});

test("mergeReadiness: mid-merge with a FAILED for-each-ref ownership probe → owner foreign", async () => {
  const { run } = fakeAsyncGit([
    mergeHeadPresentRule("deadbeef"),
    pointsAtRule([], GIT_SPAWN_TIMEOUT_CODE), // 124 — inconclusive → not ours
    autostashAbsentRule,
  ]);
  const res = await mergeReadiness("/repo", "main", run);
  expect(res.kind).toBe("mid-merge");
  if (res.kind === "mid-merge") {
    expect(res.owner).toBe("foreign");
  }
});

test("mergeReadiness: mid-merge with a present MERGE_AUTOSTASH → owner foreign, autostash true (never auto-abortable)", async () => {
  const { run } = fakeAsyncGit([
    mergeHeadPresentRule("deadbeef"),
    pointsAtRule(["refs/heads/keeper/epic/fn-1-foo"]), // sole keeper...
    autostashPresentRule, // ...but an autostash refuses ownership
  ]);
  const res = await mergeReadiness("/repo", "main", run);
  expect(res).toEqual({
    kind: "mid-merge",
    mergeHead: "deadbeef",
    owner: "foreign",
    autostash: true,
  });
});

test("mergeReadiness: mid-merge with a 124-timed-out autostash probe → owner foreign (inconclusive is not ours)", async () => {
  const { run } = fakeAsyncGit([
    mergeHeadPresentRule("deadbeef"),
    pointsAtRule(["refs/heads/keeper/epic/fn-1-foo"]),
    {
      when: (a) =>
        argvStartsWith(a, "rev-parse") && argvHas(a, "MERGE_AUTOSTASH"),
      result: { exitCode: GIT_SPAWN_TIMEOUT_CODE },
    },
  ]);
  const res = await mergeReadiness("/repo", "main", run);
  expect(res.kind).toBe("mid-merge");
  if (res.kind === "mid-merge") {
    expect(res.owner).toBe("foreign");
    expect(res.autostash).toBe(false); // unknown, reported as not-present
  }
});

test("mergeReadiness: a rebase-merge dir → dirty naming the rebase (detection only, never aborted)", async () => {
  const { run, calls } = fakeAsyncGit([
    mergeHeadAbsentRule,
    gitDirRepoRule,
    onBranchRule("main"),
    statusRule("UU src/x.ts\n"),
  ]);
  const res = await mergeReadiness(
    "/repo",
    "main",
    run,
    undefined,
    onlyPresent("rebase-merge"),
  );
  expect(res.kind).toBe("dirty");
  if (res.kind === "dirty") {
    expect(res.detail).toContain("rebase");
  }
  // Detection only — a foreign in-progress state is NEVER aborted.
  expect(calls.some((c) => argvStartsWith(c.args, "merge", "--abort"))).toBe(
    false,
  );
});

test("mergeReadiness: a rebase-apply dir → dirty naming the rebase", async () => {
  const { run } = fakeAsyncGit([
    mergeHeadAbsentRule,
    gitDirRepoRule,
    onBranchRule("main"),
  ]);
  const res = await mergeReadiness(
    "/repo",
    "main",
    run,
    undefined,
    onlyPresent("rebase-apply"),
  );
  expect(res.kind).toBe("dirty");
  if (res.kind === "dirty") {
    expect(res.detail).toContain("rebase");
  }
});

test("mergeReadiness: a CHERRY_PICK_HEAD → dirty naming the cherry-pick", async () => {
  const { run } = fakeAsyncGit([
    mergeHeadAbsentRule,
    gitDirRepoRule,
    {
      when: (a) =>
        argvStartsWith(a, "rev-parse") && argvHas(a, "CHERRY_PICK_HEAD"),
      result: { exitCode: 0, stdout: "picksha\n" },
    },
    onBranchRule("main"),
  ]);
  const res = await mergeReadiness(
    "/repo",
    "main",
    run,
    undefined,
    nonePresent,
  );
  expect(res.kind).toBe("dirty");
  if (res.kind === "dirty") {
    expect(res.detail).toContain("cherry-pick");
  }
});

test("mergeReadiness: a REVERT_HEAD → dirty naming the revert", async () => {
  const { run } = fakeAsyncGit([
    mergeHeadAbsentRule,
    gitDirRepoRule,
    {
      when: (a) => argvStartsWith(a, "rev-parse") && argvHas(a, "REVERT_HEAD"),
      result: { exitCode: 0, stdout: "revertsha\n" },
    },
    onBranchRule("main"),
  ]);
  const res = await mergeReadiness(
    "/repo",
    "main",
    run,
    undefined,
    nonePresent,
  );
  expect(res.kind).toBe("dirty");
  if (res.kind === "dirty") {
    expect(res.detail).toContain("revert");
  }
});

test("mergeReadiness: a stale index.lock on an otherwise-clean checkout → dirty naming it (never removed)", async () => {
  const { run, calls } = fakeAsyncGit([
    mergeHeadAbsentRule,
    gitDirRepoRule,
    onBranchRule("main"),
    statusRule(""), // clean tree — the lock is the only blocker
  ]);
  const res = await mergeReadiness(
    "/repo",
    "main",
    run,
    undefined,
    onlyPresent("index.lock"),
  );
  expect(res.kind).toBe("dirty");
  if (res.kind === "dirty") {
    expect(res.detail).toContain("index.lock");
  }
  // The lock is NAMED, never removed and never aborted around.
  expect(calls.some((c) => argvStartsWith(c.args, "merge", "--abort"))).toBe(
    false,
  );
});

// fn-988 — the would-clobber probe (an incoming lane path ∩ a main-untracked file)
const lsFilesOthersRule = (untracked: string): FakeGitRule => ({
  when: (a) => argvStartsWith(a, "ls-files", "--others", "--exclude-standard"),
  result: { exitCode: 0, stdout: untracked },
});
const lsTreeRule = (branch: string, tracked: string): FakeGitRule => ({
  when: (a) => argvStartsWith(a, "ls-tree", "-r", "--name-only", branch),
  result: { exitCode: 0, stdout: tracked },
});

test("mergeReadiness: an incoming path that collides with a main-untracked file → would-clobber", async () => {
  const { run } = fakeAsyncGit([
    onBranchRule("main"),
    statusRule(""), // -uno → clean
    lsFilesOthersRule("docs/new.md\nscratch.txt\n"),
    lsTreeRule("keeper/epic/fn-1-foo", "src/a.ts\ndocs/new.md\n"),
  ]);
  const res = await mergeReadiness(
    "/repo",
    "main",
    run,
    "keeper/epic/fn-1-foo",
  );
  expect(res.kind).toBe("would-clobber");
  if (res.kind === "would-clobber") {
    // ONLY the overlap (docs/new.md) blocks — scratch.txt + src/a.ts don't collide.
    expect(res.paths).toEqual(["docs/new.md"]);
  }
});

test("mergeReadiness: a benign untracked-only tree (no incoming overlap) → ready (no fn-987 regression)", async () => {
  const { run } = fakeAsyncGit([
    onBranchRule("main"),
    statusRule(""), // -uno → clean
    lsFilesOthersRule(".env\neditor.tmp\n"), // benign untracked
    lsTreeRule("keeper/epic/fn-1-foo", "src/a.ts\ndocs/new.md\n"), // no overlap
  ]);
  expect(
    await mergeReadiness("/repo", "main", run, "keeper/epic/fn-1-foo"),
  ).toEqual({ kind: "ready" });
});

test("mergeReadiness: no incomingBranch → the would-clobber probe is skipped entirely", async () => {
  const { run, calls } = fakeAsyncGit([onBranchRule("main"), statusRule("")]);
  expect(await mergeReadiness("/repo", "main", run)).toEqual({ kind: "ready" });
  // No incoming branch → never enumerates untracked/incoming paths.
  expect(calls.some((c) => argvStartsWith(c.args, "ls-files"))).toBe(false);
  expect(calls.some((c) => argvStartsWith(c.args, "ls-tree"))).toBe(false);
});

test("mergeReadiness: a clean main checkout with NO untracked files → ready (no ls-tree probe)", async () => {
  const { run, calls } = fakeAsyncGit([
    onBranchRule("main"),
    statusRule(""),
    lsFilesOthersRule(""), // no untracked at all
  ]);
  expect(
    await mergeReadiness("/repo", "main", run, "keeper/epic/fn-1-foo"),
  ).toEqual({ kind: "ready" });
  // An empty untracked set short-circuits BEFORE listing the incoming tree.
  expect(calls.some((c) => argvStartsWith(c.args, "ls-tree"))).toBe(false);
});

// B4 — the merge-path reads are bounded by GIT_LOCAL_TIMEOUT_MS and a 124
// SIGKILL degrades SAFELY: never a false clean/ready that could let a
// would-clobber merge through.
test("currentBranch: a 124-timed-out rev-parse → empty head (caller degrades to off-branch)", async () => {
  const { run } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "rev-parse", "--abbrev-ref", "HEAD"),
      result: { exitCode: GIT_SPAWN_TIMEOUT_CODE }, // SIGKILLed → empty stdout
    },
  ]);
  // "" never equals a real expected branch, so mergeReadiness reads off-branch.
  expect(await currentBranch("/repo", run)).toBe("");
  expect(await mergeReadiness("/repo", "main", run)).toEqual({
    kind: "off-branch",
    head: "",
  });
});

test("mergeReadiness: a 124-timed-out status read → dirty (safe not-ready, never false ready)", async () => {
  const { run } = fakeAsyncGit([
    onBranchRule("main"),
    statusRule("", GIT_SPAWN_TIMEOUT_CODE),
  ]);
  expect((await mergeReadiness("/repo", "main", run)).kind).toBe("dirty");
});

test("mergeReadiness: a 124-timed-out ls-files clobber probe → dirty, NOT a false no-clobber ready", async () => {
  const { run } = fakeAsyncGit([
    onBranchRule("main"),
    statusRule(""), // -uno → clean tree
    {
      when: (a) => argvStartsWith(a, "ls-files", "--others"),
      result: { exitCode: GIT_SPAWN_TIMEOUT_CODE },
    },
  ]);
  const res = await mergeReadiness(
    "/repo",
    "main",
    run,
    "keeper/epic/fn-1-foo",
  );
  expect(res.kind).toBe("dirty");
});

test("mergeReadiness: a 124-timed-out ls-tree clobber probe → dirty, NOT a false no-clobber ready", async () => {
  const { run } = fakeAsyncGit([
    onBranchRule("main"),
    statusRule(""),
    lsFilesOthersRule("scratch.txt\n"), // some untracked → the ls-tree probe runs
    {
      when: (a) => argvStartsWith(a, "ls-tree", "-r", "--name-only"),
      result: { exitCode: GIT_SPAWN_TIMEOUT_CODE },
    },
  ]);
  const res = await mergeReadiness(
    "/repo",
    "main",
    run,
    "keeper/epic/fn-1-foo",
  );
  expect(res.kind).toBe("dirty");
});

// ---------------------------------------------------------------------------
// fn-988 — listEpicLaneBranches (base + rib cleanup enumeration)
// ---------------------------------------------------------------------------

test("listEpicLaneBranches: enumerates bases AND ribs, each tagged + epicId recovered", async () => {
  const { run } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "for-each-ref"),
      result: {
        exitCode: 0,
        stdout: [
          "keeper/epic/fn-1-foo",
          "keeper/epic/fn-1-foo--fn-1-foo.2",
          "keeper/epic/fn-1-foo--fn-1-foo.3",
          "keeper/epic/fn-2-bar",
          "refs/heads/not-a-lane", // ignored (no prefix)
        ].join("\n"),
      },
    },
  ]);
  expect(await listEpicLaneBranches("/repo", run)).toEqual([
    { branch: "keeper/epic/fn-1-foo", epicId: "fn-1-foo", isRib: false },
    {
      branch: "keeper/epic/fn-1-foo--fn-1-foo.2",
      epicId: "fn-1-foo",
      isRib: true,
    },
    {
      branch: "keeper/epic/fn-1-foo--fn-1-foo.3",
      epicId: "fn-1-foo",
      isRib: true,
    },
    { branch: "keeper/epic/fn-2-bar", epicId: "fn-2-bar", isRib: false },
  ]);
});

// ---------------------------------------------------------------------------
// fn-1014 — enumerateEpicLaneBranches (the code-surfacing present/absent/
// inconclusive enumeration the cross-epic merge-gate's absent-implies-merged arm
// needs; closes the `[]`-collapse + no-timeout gap of listEpicLaneBranches).
// ---------------------------------------------------------------------------

test("enumerateEpicLaneBranches: success → { ok:true } carrying the full keeper/epic short-name set (bases AND ribs)", async () => {
  const { run, calls } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "for-each-ref"),
      result: {
        exitCode: 0,
        stdout: [
          "keeper/epic/fn-1-foo",
          "keeper/epic/fn-1-foo--fn-1-foo.2",
          "keeper/epic/fn-2-bar",
          "refs/heads/not-a-lane", // ignored (no prefix)
        ].join("\n"),
      },
    },
  ]);
  const res = await enumerateEpicLaneBranches("/repo", run);
  expect(res).toEqual({
    ok: true,
    branches: new Set([
      "keeper/epic/fn-1-foo",
      "keeper/epic/fn-1-foo--fn-1-foo.2",
      "keeper/epic/fn-2-bar",
    ]),
  });
  // The read is TIME-BOUND (unlike listEpicLaneBranches) so an fsmonitor stall
  // can't wedge the cycle.
  expect(calls.some((c) => argvStartsWith(c.args, "for-each-ref"))).toBe(true);
});

test("enumerateEpicLaneBranches: a lane-less repo → { ok:true, branches: ∅ } — a DEFINITIVE absence, NOT a failure", async () => {
  const { run } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "for-each-ref"),
      result: { exitCode: 0, stdout: "" },
    },
  ]);
  const res = await enumerateEpicLaneBranches("/repo", run);
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.branches.size).toBe(0);
  }
});

test("enumerateEpicLaneBranches: a non-zero for-each-ref exit → { ok:false } (NEVER collapsed to an empty set)", async () => {
  const { run } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "for-each-ref"),
      result: { exitCode: 1 },
    },
  ]);
  expect(await enumerateEpicLaneBranches("/repo", run)).toEqual({ ok: false });
});

test("enumerateEpicLaneBranches: a 124 SIGKILL timeout → { ok:false } (the caller DEFERS, never reads a stalled probe as absent)", async () => {
  const { run } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "for-each-ref"),
      result: { exitCode: GIT_SPAWN_TIMEOUT_CODE },
    },
  ]);
  expect(await enumerateEpicLaneBranches("/repo", run)).toEqual({ ok: false });
});

// ---------------------------------------------------------------------------
// fn-985 — remotePushFastForwardable (non-fast-forward precheck, no fetch)
// ---------------------------------------------------------------------------

test("remotePushFastForwardable: cached origin ref is an ancestor of local → fast-forwardable (no fetch)", async () => {
  const { run, calls } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "rev-parse", "--verify", "--quiet"),
      result: { exitCode: 0, stdout: "abc\n" }, // origin/main resolves
    },
    {
      when: (a) => argvStartsWith(a, "merge-base", "--is-ancestor"),
      result: { exitCode: 0 }, // origin is contained in local
    },
  ]);
  expect(await remotePushFastForwardable("/repo", "main", run)).toBe(
    "fast-forwardable",
  );
  // It checked the CACHED remote-tracking ref — never a fetch.
  expect(calls.some((c) => argvStartsWith(c.args, "fetch"))).toBe(false);
  expect(
    calls.some((c) =>
      argvStartsWith(
        c.args,
        "rev-parse",
        "--verify",
        "--quiet",
        "refs/remotes/origin/main",
      ),
    ),
  ).toBe(true);
});

test("remotePushFastForwardable: origin ahead of local (not an ancestor) → NOT fast-forwardable", async () => {
  const { run, calls } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "rev-parse", "--verify", "--quiet"),
      result: { exitCode: 0, stdout: "abc\n" },
    },
    {
      when: (a) => argvStartsWith(a, "merge-base", "--is-ancestor"),
      result: { exitCode: 1 }, // origin has commits local lacks
    },
  ]);
  expect(await remotePushFastForwardable("/repo", "main", run)).toBe(
    "non-fast-forwardable",
  );
  expect(calls.some((c) => argvStartsWith(c.args, "fetch"))).toBe(false);
});

test("remotePushFastForwardable: unresolved remote-tracking ref → 'unknown' (defer, do NOT block), no is-ancestor probe", async () => {
  const { run, calls } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "rev-parse", "--verify", "--quiet"),
      result: { exitCode: 1 }, // origin/main does not resolve (never-pushed default)
    },
  ]);
  // An unresolved origin/<default> is NOT a proven non-FF — it DEFERS to the
  // authoritative turn-key probe rather than minting a false permanent skip that
  // would deadlock a never-pushed-default first finalize push.
  expect(await remotePushFastForwardable("/repo", "main", run)).toBe("unknown");
  expect(calls.some((c) => argvStartsWith(c.args, "merge-base"))).toBe(false);
});

// ---------------------------------------------------------------------------
// Baseline scratch worktrees — detached checkouts for the suite-baseline runner.
// Pure-seam only: every git op through the recording fake, no real git.
// ---------------------------------------------------------------------------

const SCRATCH_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const OTHER_SHA = "cafef00dcafef00dcafef00dcafef00dcafef00d";

// A fresh detached scratch entry the list rule can report as registered.
function scratchEntryLine(path: string): string {
  return `worktree ${path}\nHEAD ${SCRATCH_SHA}\ndetached\n\n`;
}
function revParseHeadRule(sha: string): FakeGitRule {
  return {
    when: (a) => argvStartsWith(a, "rev-parse", "HEAD"),
    result: { stdout: `${sha}\n` },
  };
}
function statusRuleFor(porcelain: string): FakeGitRule {
  return {
    when: (a) => argvStartsWith(a, "status", "--porcelain"),
    result: { stdout: porcelain },
  };
}

test("baselineScratchPathFor: prefixed, repo-disambiguated, sha-keyed — never a lane path", () => {
  const p = baselineScratchPathFor("/home/me/repo", SCRATCH_SHA, "/wtroot");
  expect(p).toBe(
    `/wtroot/${BASELINE_SCRATCH_PREFIX}${repoDirHash("/home/me/repo")}-${SCRATCH_SHA}`,
  );
  // A lane path (worktreePathFor scheme: `<repoName>-<hash>--keeper-epic-<...>`)
  // can never carry the scratch prefix, and the scratch path never carries a lane
  // shape — the two are structurally disjoint.
  expect(isBaselineScratchPath(p)).toBe(true);
  expect(p.includes("--keeper-epic-")).toBe(false);
  // Same repo, different sha → distinct path (keyed by sha).
  expect(
    baselineScratchPathFor("/home/me/repo", OTHER_SHA, "/wtroot"),
  ).not.toBe(p);
});

test("isBaselineScratchPath: true only for the scratch prefix, false for a lane / other", () => {
  expect(
    isBaselineScratchPath(
      `/wtroot/${BASELINE_SCRATCH_PREFIX}abc-${SCRATCH_SHA}`,
    ),
  ).toBe(true);
  // trailing slash tolerated
  expect(
    isBaselineScratchPath(
      `/wtroot/${BASELINE_SCRATCH_PREFIX}abc-${SCRATCH_SHA}/`,
    ),
  ).toBe(true);
  // a real lane path shape
  expect(
    isBaselineScratchPath("/wtroot/keeper-1a2b3c--keeper-epic-fn-1-foo"),
  ).toBe(false);
  expect(isBaselineScratchPath("/wtroot/some-other-dir")).toBe(false);
});

test("provisionScratchWorktree: fresh add + HEAD==sha + clean → ready, detached add argv, verified in the scratch cwd", async () => {
  const scratch = baselineScratchPathFor("/repo", SCRATCH_SHA, "/wtroot");
  const { run, calls } = fakeAsyncGit([
    worktreeListRule(""), // nothing registered — the pre-add reap is a no-op remove
    revParseHeadRule(SCRATCH_SHA),
    statusRuleFor(""), // clean tree
  ]);
  const res = await provisionScratchWorktree(
    "/repo",
    scratch,
    SCRATCH_SHA,
    run,
  );
  expect(res).toEqual({ kind: "ready", path: scratch });
  // The checkout is a DETACHED add at exactly the sha.
  const add = calls.find((c) => argvStartsWith(c.args, "worktree", "add"));
  expect(add?.args).toEqual([
    "worktree",
    "add",
    "--detach",
    scratch,
    SCRATCH_SHA,
  ]);
  // HEAD + status verification ran INSIDE the scratch worktree, not the main repo.
  const head = calls.find((c) => argvStartsWith(c.args, "rev-parse", "HEAD"));
  const status = calls.find((c) =>
    argvStartsWith(c.args, "status", "--porcelain"),
  );
  expect(head?.cwd).toBe(scratch);
  expect(status?.cwd).toBe(scratch);
});

test("provisionScratchWorktree: unresolvable sha (add fails) → typed checkout-failed carrying git stderr, no throw", async () => {
  const scratch = baselineScratchPathFor("/repo", SCRATCH_SHA, "/wtroot");
  const { run, calls } = fakeAsyncGit([
    worktreeListRule(""),
    {
      when: (a) => argvStartsWith(a, "worktree", "add"),
      result: { exitCode: 128, stderr: "fatal: invalid reference: deadbeef" },
    },
  ]);
  const res = await provisionScratchWorktree(
    "/repo",
    scratch,
    SCRATCH_SHA,
    run,
  );
  expect(res.kind).toBe("checkout-failed");
  if (res.kind === "checkout-failed") {
    expect(res.detail).toContain("invalid reference");
  }
  // Never verified a failed checkout — no HEAD/status probe on the phantom tree.
  expect(calls.some((c) => argvStartsWith(c.args, "rev-parse", "HEAD"))).toBe(
    false,
  );
  // Cleanup pruned the admin husk even on the failure path.
  expect(calls.some((c) => argvStartsWith(c.args, "worktree", "prune"))).toBe(
    true,
  );
});

test("provisionScratchWorktree: HEAD lands off the requested sha → checkout-failed AND the scratch tree is force-reaped", async () => {
  const scratch = baselineScratchPathFor("/repo", SCRATCH_SHA, "/wtroot");
  const { run, calls } = fakeAsyncGit([
    // The add registers the scratch entry, so the post-mismatch reap must remove it.
    worktreeListRule(scratchEntryLine(scratch)),
    revParseHeadRule(OTHER_SHA), // landed off the requested sha
  ]);
  const res = await provisionScratchWorktree(
    "/repo",
    scratch,
    SCRATCH_SHA,
    run,
  );
  expect(res.kind).toBe("checkout-failed");
  if (res.kind === "checkout-failed") {
    expect(res.detail).toContain(`expected ${SCRATCH_SHA}`);
  }
  // Reaped with --force (a dirty/partial scratch tree is a throwaway).
  const forced = calls.filter(
    (c) =>
      argvStartsWith(c.args, "worktree", "remove") &&
      argvHas(c.args, "--force"),
  );
  expect(forced.length).toBeGreaterThanOrEqual(1);
  expect(forced[0].args).toEqual([
    "worktree",
    "remove",
    "--force",
    "--force",
    scratch,
  ]);
});

test("provisionScratchWorktree: dirty scratch tree → checkout-failed (never a clean-key result), reaped", async () => {
  const scratch = baselineScratchPathFor("/repo", SCRATCH_SHA, "/wtroot");
  const { run, calls } = fakeAsyncGit([
    worktreeListRule(scratchEntryLine(scratch)),
    revParseHeadRule(SCRATCH_SHA), // HEAD is right
    statusRuleFor(" M src/foo.ts\n"), // but the tree is dirty
  ]);
  const res = await provisionScratchWorktree(
    "/repo",
    scratch,
    SCRATCH_SHA,
    run,
  );
  expect(res.kind).toBe("checkout-failed");
  if (res.kind === "checkout-failed") {
    expect(res.detail).toContain("not clean");
  }
  expect(
    calls.some(
      (c) =>
        argvStartsWith(c.args, "worktree", "remove") &&
        argvHas(c.args, "--force"),
    ),
  ).toBe(true);
});

test("removeScratchWorktree: registered scratch → force-removed + pruned (idempotent throwaway)", async () => {
  const scratch = baselineScratchPathFor("/repo", SCRATCH_SHA, "/wtroot");
  const { run, calls } = fakeAsyncGit([
    worktreeListRule(scratchEntryLine(scratch)),
  ]);
  await removeScratchWorktree("/repo", scratch, run);
  const rm = calls.find((c) => argvStartsWith(c.args, "worktree", "remove"));
  // Double `--force`: the second is what clears git's own `initializing` lock
  // on a scratch whose `worktree add` was cut mid-flight.
  expect(rm?.args).toEqual([
    "worktree",
    "remove",
    "--force",
    "--force",
    scratch,
  ]);
  expect(calls.some((c) => argvStartsWith(c.args, "worktree", "prune"))).toBe(
    true,
  );
});

test("removeScratchWorktree: a failed remove is logged, never thrown, and the admin prune still runs", async () => {
  const scratch = baselineScratchPathFor("/repo", SCRATCH_SHA, "/wtroot");
  const { run, calls } = fakeAsyncGit([
    worktreeListRule(scratchEntryLine(scratch)),
    {
      when: (a) => argvStartsWith(a, "worktree", "remove"),
      result: {
        exitCode: 128,
        stderr:
          "fatal: cannot remove a locked working tree, lock reason: initializing",
      },
    },
  ]);
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    await removeScratchWorktree("/repo", scratch, run);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0]?.[0])).toContain("scratch reap failed");
  } finally {
    errSpy.mockRestore();
  }
  expect(calls.some((c) => argvStartsWith(c.args, "worktree", "prune"))).toBe(
    true,
  );
});

test("removeScratchWorktree: not registered → no remove, still prunes (idempotent)", async () => {
  const scratch = baselineScratchPathFor("/repo", SCRATCH_SHA, "/wtroot");
  const { run, calls } = fakeAsyncGit([worktreeListRule("")]);
  await removeScratchWorktree("/repo", scratch, run);
  expect(calls.some((c) => argvStartsWith(c.args, "worktree", "remove"))).toBe(
    false,
  );
  expect(calls.some((c) => argvStartsWith(c.args, "worktree", "prune"))).toBe(
    true,
  );
});

test("removeScratchWorktree: a non-scratch path throws — the --force can never reach a lane", async () => {
  const { run } = fakeAsyncGit([]);
  expect(
    removeScratchWorktree(
      "/repo",
      "/wtroot/keeper-1a2b--keeper-epic-fn-1-foo",
      run,
    ),
  ).rejects.toThrow(/refusing to force-remove non-scratch path/);
});

test("pruneBaselineScratchWorktrees: reaps only scratch entries by prefix, never a lane, returns the reaped paths", async () => {
  const scratch = baselineScratchPathFor("/repo", SCRATCH_SHA, "/wtroot");
  const lane = "/wtroot/keeper-1a2b--keeper-epic-fn-1-foo";
  const { run, calls } = fakeAsyncGit([
    worktreeListRule(
      "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n" +
        `worktree ${lane}\nHEAD y\nbranch refs/heads/keeper/epic/fn-1-foo\n\n` +
        scratchEntryLine(scratch),
    ),
  ]);
  const reaped = await pruneBaselineScratchWorktrees("/repo", run);
  expect(reaped).toEqual([scratch]);
  // Only the scratch path was ever force-removed; the lane + main are untouched.
  const removed = calls
    .filter((c) => argvStartsWith(c.args, "worktree", "remove"))
    .map((c) => c.args[c.args.length - 1]);
  expect(removed).toEqual([scratch]);
});

test("pruneBaselineScratchWorktrees: no scratch entries → empty result, no remove", async () => {
  const { run, calls } = fakeAsyncGit([
    worktreeListRule("worktree /repo\nHEAD x\nbranch refs/heads/main\n\n"),
  ]);
  expect(await pruneBaselineScratchWorktrees("/repo", run)).toEqual([]);
  expect(calls.some((c) => argvStartsWith(c.args, "worktree", "remove"))).toBe(
    false,
  );
});

// ---------------------------------------------------------------------------
// classifyPremergeRedundancy — the blob-equality probe for the fan-in pre-merge
// clean. Pure fake-git: a `status --porcelain=v2 -z` enumerates + pre-classifies
// the dirty set, then per surviving candidate a filtered `hash-object` + an
// incoming-blob `rev-parse`. Airtight: only an unstaged, non-mode, tracked change
// whose filtered blob == the incoming blob (and != HEAD) is provably redundant.
// ---------------------------------------------------------------------------

const HEAD_HASH = "1111111111111111111111111111111111111111";
const INC_HASH = "2222222222222222222222222222222222222222";
const OTHER_HASH = "3333333333333333333333333333333333333333";

/** A porcelain-v2 `1` (ordinary change) record. Fields never carry spaces except
 *  the trailing path, mirroring git-status(1). */
function v2Line(o: {
  xy?: string;
  mH?: string;
  mI?: string;
  mW?: string;
  hH?: string;
  hI?: string;
  path: string;
}): string {
  const xy = o.xy ?? ".M";
  const mH = o.mH ?? "100644";
  const mI = o.mI ?? "100644";
  const mW = o.mW ?? "100644";
  const hH = o.hH ?? HEAD_HASH;
  const hI = o.hI ?? HEAD_HASH;
  return `1 ${xy} N... ${mH} ${mI} ${mW} ${hH} ${hI} ${o.path}`;
}

function premergeProbeRules(o: {
  statusV2: string;
  statusCode?: number;
  wtHash?: string;
  wtCode?: number;
  incHash?: string;
  incCode?: number;
}): FakeGitRule[] {
  return [
    {
      when: (a) => argvStartsWith(a, "status", "--porcelain=v2"),
      result: { exitCode: o.statusCode ?? 0, stdout: o.statusV2 },
    },
    {
      when: (a) => argvStartsWith(a, "hash-object"),
      result: {
        exitCode: o.wtCode ?? 0,
        stdout: o.wtHash ? `${o.wtHash}\n` : "",
      },
    },
    {
      when: (a) =>
        argvStartsWith(a, "rev-parse", "--verify") &&
        (a[a.length - 1] ?? "").includes(":"),
      result: {
        exitCode: o.incCode ?? 0,
        stdout: o.incHash ? `${o.incHash}\n` : "",
      },
    },
  ];
}

test("classifyPremergeRedundancy: an unstaged modify whose filtered blob == incoming (!= HEAD) → redundant", async () => {
  const { run } = fakeAsyncGit(
    premergeProbeRules({
      statusV2: `${v2Line({ path: "src/foo.ts" })}\0`,
      wtHash: INC_HASH,
      incHash: INC_HASH,
    }),
  );
  expect(await classifyPremergeRedundancy("/base", "rib", run)).toEqual({
    kind: "redundant",
    paths: ["src/foo.ts"],
  });
});

test("classifyPremergeRedundancy: multiple redundant paths → all restorable", async () => {
  const { run } = fakeAsyncGit(
    premergeProbeRules({
      statusV2: `${v2Line({ path: "a.ts" })}\0${v2Line({ path: "b.ts" })}\0`,
      wtHash: INC_HASH,
      incHash: INC_HASH,
    }),
  );
  expect(await classifyPremergeRedundancy("/base", "rib", run)).toEqual({
    kind: "redundant",
    paths: ["a.ts", "b.ts"],
  });
});

test("classifyPremergeRedundancy: an empty (clean-after-refresh) tree → redundant with no paths", async () => {
  const { run } = fakeAsyncGit(premergeProbeRules({ statusV2: "" }));
  expect(await classifyPremergeRedundancy("/base", "rib", run)).toEqual({
    kind: "redundant",
    paths: [],
  });
});

test("classifyPremergeRedundancy: an ADD (no HEAD blob) → not-redundant", async () => {
  const { run } = fakeAsyncGit(
    premergeProbeRules({
      statusV2: `${v2Line({ xy: "A.", mH: "000000", path: "new.ts" })}\0`,
      wtHash: INC_HASH,
      incHash: INC_HASH,
    }),
  );
  const res = await classifyPremergeRedundancy("/base", "rib", run);
  expect(res.kind).toBe("not-redundant");
  if (res.kind === "not-redundant") expect(res.reason).toContain("new.ts");
});

test("classifyPremergeRedundancy: a DELETE (no worktree blob) → not-redundant", async () => {
  const { run } = fakeAsyncGit(
    premergeProbeRules({
      statusV2: `${v2Line({ xy: ".D", mW: "000000", path: "gone.ts" })}\0`,
    }),
  );
  const res = await classifyPremergeRedundancy("/base", "rib", run);
  expect(res.kind).toBe("not-redundant");
  if (res.kind === "not-redundant") expect(res.reason).toContain("gone.ts");
});

test("classifyPremergeRedundancy: a mode-only flip (blob identical, mode changed) → not-redundant", async () => {
  const { run } = fakeAsyncGit(
    premergeProbeRules({
      statusV2: `${v2Line({ mW: "100755", path: "exe.sh" })}\0`,
      wtHash: INC_HASH,
      incHash: INC_HASH,
    }),
  );
  const res = await classifyPremergeRedundancy("/base", "rib", run);
  expect(res.kind).toBe("not-redundant");
  if (res.kind === "not-redundant") expect(res.reason).toContain("mode change");
});

test("classifyPremergeRedundancy: a STAGED change (index != HEAD) → not-redundant", async () => {
  const { run } = fakeAsyncGit(
    premergeProbeRules({
      statusV2: `${v2Line({ xy: "M.", hI: OTHER_HASH, path: "staged.ts" })}\0`,
      wtHash: INC_HASH,
      incHash: INC_HASH,
    }),
  );
  const res = await classifyPremergeRedundancy("/base", "rib", run);
  expect(res.kind).toBe("not-redundant");
  if (res.kind === "not-redundant") expect(res.reason).toContain("staged");
});

test("classifyPremergeRedundancy: an untracked file → not-redundant", async () => {
  const { run } = fakeAsyncGit(
    premergeProbeRules({ statusV2: "? scratch.txt\0" }),
  );
  const res = await classifyPremergeRedundancy("/base", "rib", run);
  expect(res.kind).toBe("not-redundant");
  if (res.kind === "not-redundant") expect(res.reason).toContain("untracked");
});

test("classifyPremergeRedundancy: incoming blob == HEAD (merge would not re-apply) → not-redundant", async () => {
  const { run } = fakeAsyncGit(
    premergeProbeRules({
      statusV2: `${v2Line({ path: "src/foo.ts" })}\0`,
      wtHash: HEAD_HASH,
      incHash: HEAD_HASH,
    }),
  );
  const res = await classifyPremergeRedundancy("/base", "rib", run);
  expect(res.kind).toBe("not-redundant");
  if (res.kind === "not-redundant") expect(res.reason).toContain("equals HEAD");
});

test("classifyPremergeRedundancy: working blob differs from incoming → not-redundant", async () => {
  const { run } = fakeAsyncGit(
    premergeProbeRules({
      statusV2: `${v2Line({ path: "src/foo.ts" })}\0`,
      wtHash: OTHER_HASH,
      incHash: INC_HASH,
    }),
  );
  const res = await classifyPremergeRedundancy("/base", "rib", run);
  expect(res.kind).toBe("not-redundant");
  if (res.kind === "not-redundant") expect(res.reason).toContain("differs");
});

test("classifyPremergeRedundancy: incoming rib has no blob for the path → not-redundant", async () => {
  const { run } = fakeAsyncGit(
    premergeProbeRules({
      statusV2: `${v2Line({ path: "src/foo.ts" })}\0`,
      wtHash: INC_HASH,
      incCode: 1,
    }),
  );
  const res = await classifyPremergeRedundancy("/base", "rib", run);
  expect(res.kind).toBe("not-redundant");
  if (res.kind === "not-redundant") expect(res.reason).toContain("no blob");
});

test("classifyPremergeRedundancy: a hash-object timeout fails SAFE → not-redundant", async () => {
  const { run } = fakeAsyncGit(
    premergeProbeRules({
      statusV2: `${v2Line({ path: "src/foo.ts" })}\0`,
      wtCode: GIT_SPAWN_TIMEOUT_CODE,
    }),
  );
  const res = await classifyPremergeRedundancy("/base", "rib", run);
  expect(res.kind).toBe("not-redundant");
  if (res.kind === "not-redundant") expect(res.reason).toContain("timed out");
});

test("classifyPremergeRedundancy: a status probe timeout fails SAFE → not-redundant", async () => {
  const { run } = fakeAsyncGit(
    premergeProbeRules({
      statusV2: "",
      statusCode: GIT_SPAWN_TIMEOUT_CODE,
    }),
  );
  const res = await classifyPremergeRedundancy("/base", "rib", run);
  expect(res.kind).toBe("not-redundant");
  if (res.kind === "not-redundant") expect(res.reason).toContain("timed out");
});

test("classifyPremergeRedundancy: ANY not-redundant path poisons the whole set (all-or-nothing)", async () => {
  const { run } = fakeAsyncGit(
    premergeProbeRules({
      // One redundant modify + one untracked → not-redundant overall.
      statusV2: `${v2Line({ path: "ok.ts" })}\0? scratch.txt\0`,
      wtHash: INC_HASH,
      incHash: INC_HASH,
    }),
  );
  expect((await classifyPremergeRedundancy("/base", "rib", run)).kind).toBe(
    "not-redundant",
  );
});

// ---------------------------------------------------------------------------
// losslessPremergeClean — the flock-guarded orchestrator: attribution guard →
// lock → refresh → probe → restore → mergeReadiness re-probe. Only a base that
// re-probes `ready` returns `ready`; every doubt is a retry-skip (no discard).
// ---------------------------------------------------------------------------

const okLock: LockAcquirer = () => ({ release() {} });
const timeoutLock: LockAcquirer = () => null;

/** The full happy-path rule set: a redundant leak that restores + re-probes clean. */
function cleanHappyRules(branch: string): FakeGitRule[] {
  return [
    {
      when: (a) => argvStartsWith(a, "rev-parse", "--path-format=absolute"),
      result: { exitCode: 0, stdout: "/base/.git\n" },
    },
    // --really-refresh exits non-zero on a dirty tree — tolerated (only 124/127 stall).
    {
      when: (a) => argvStartsWith(a, "update-index"),
      result: { exitCode: 1 },
    },
    {
      when: (a) => argvStartsWith(a, "status", "--porcelain=v2"),
      result: { exitCode: 0, stdout: `${v2Line({ path: "src/foo.ts" })}\0` },
    },
    {
      when: (a) => argvStartsWith(a, "hash-object"),
      result: { exitCode: 0, stdout: `${INC_HASH}\n` },
    },
    {
      when: (a) =>
        argvStartsWith(a, "rev-parse", "--verify") &&
        (a[a.length - 1] ?? "").includes(":"),
      result: { exitCode: 0, stdout: `${INC_HASH}\n` },
    },
    {
      when: (a) => argvStartsWith(a, "restore"),
      result: { exitCode: 0 },
    },
    // The mergeReadiness re-probe: on-branch + (default) clean status + no MERGE_HEAD.
    {
      when: (a) => argvStartsWith(a, "rev-parse", "--abbrev-ref", "HEAD"),
      result: { exitCode: 0, stdout: `${branch}\n` },
    },
  ];
}

test("losslessPremergeClean: null attribution → retry (do-not-discard), no git shelled", async () => {
  const { run, calls } = fakeAsyncGit([]);
  const res = await losslessPremergeClean(
    "/base",
    "keeper/epic/fn-1-foo",
    "keeper/epic/fn-1-foo--fn-1-foo.2",
    null,
    run,
    okLock,
  );
  expect(res.kind).toBe("retry");
  expect(calls).toEqual([]);
});

test("losslessPremergeClean: a lock-timeout → retry (never a blind restore)", async () => {
  const { run, calls } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "rev-parse", "--path-format=absolute"),
      result: { exitCode: 0, stdout: "/base/.git\n" },
    },
  ]);
  const res = await losslessPremergeClean(
    "/base",
    "keeper/epic/fn-1-foo",
    "keeper/epic/fn-1-foo--fn-1-foo.2",
    new Set(),
    run,
    timeoutLock,
  );
  expect(res.kind).toBe("retry");
  // Never reached the restore.
  expect(calls.some((c) => argvStartsWith(c.args, "restore"))).toBe(false);
});

test("losslessPremergeClean: a not-redundant base → retry, no restore", async () => {
  const { run, calls } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "rev-parse", "--path-format=absolute"),
      result: { exitCode: 0, stdout: "/base/.git\n" },
    },
    { when: (a) => argvStartsWith(a, "update-index"), result: { exitCode: 1 } },
    {
      when: (a) => argvStartsWith(a, "status", "--porcelain=v2"),
      result: { exitCode: 0, stdout: "? scratch.txt\0" }, // untracked → not redundant
    },
  ]);
  const res = await losslessPremergeClean(
    "/base",
    "keeper/epic/fn-1-foo",
    "keeper/epic/fn-1-foo--fn-1-foo.2",
    new Set(),
    run,
    okLock,
  );
  expect(res.kind).toBe("retry");
  expect(calls.some((c) => argvStartsWith(c.args, "restore"))).toBe(false);
});

test("losslessPremergeClean: a redundant path ATTRIBUTED to a live job → retry, no restore", async () => {
  const { run, calls } = fakeAsyncGit([
    {
      when: (a) => argvStartsWith(a, "rev-parse", "--path-format=absolute"),
      result: { exitCode: 0, stdout: "/base/.git\n" },
    },
    { when: (a) => argvStartsWith(a, "update-index"), result: { exitCode: 1 } },
    {
      when: (a) => argvStartsWith(a, "status", "--porcelain=v2"),
      result: { exitCode: 0, stdout: `${v2Line({ path: "src/foo.ts" })}\0` },
    },
    {
      when: (a) => argvStartsWith(a, "hash-object"),
      result: { exitCode: 0, stdout: `${INC_HASH}\n` },
    },
    {
      when: (a) =>
        argvStartsWith(a, "rev-parse", "--verify") &&
        (a[a.length - 1] ?? "").includes(":"),
      result: { exitCode: 0, stdout: `${INC_HASH}\n` },
    },
  ]);
  const res = await losslessPremergeClean(
    "/base",
    "keeper/epic/fn-1-foo",
    "keeper/epic/fn-1-foo--fn-1-foo.2",
    new Set(["src/foo.ts"]), // a live job owns this exact path
    run,
    okLock,
  );
  expect(res.kind).toBe("retry");
  if (res.kind === "retry") expect(res.reason).toContain("live job");
  expect(calls.some((c) => argvStartsWith(c.args, "restore"))).toBe(false);
});

test("losslessPremergeClean: a redundant + unattributed leak → restores to HEAD, re-probes ready", async () => {
  const branch = "keeper/epic/fn-1-foo";
  const { run, calls } = fakeAsyncGit(cleanHappyRules(branch));
  const res = await losslessPremergeClean(
    "/base",
    branch,
    "keeper/epic/fn-1-foo--fn-1-foo.2",
    new Set(),
    run,
    okLock,
  );
  expect(res).toEqual({ kind: "ready" });
  // It restored the EXACT proven path after `--`, never a bare `git restore .`.
  const restore = calls.find((c) => argvStartsWith(c.args, "restore"));
  expect(restore?.args).toEqual([
    "restore",
    "--source=HEAD",
    "--worktree",
    "--",
    "src/foo.ts",
  ]);
});

test("losslessPremergeClean: a failed restore → retry (never proceeds to merge)", async () => {
  const branch = "keeper/epic/fn-1-foo";
  // Prepend a failing restore rule (first-match-wins) over the happy set.
  const rules: FakeGitRule[] = [
    { when: (a) => argvStartsWith(a, "restore"), result: { exitCode: 1 } },
    ...cleanHappyRules(branch),
  ];
  const { run } = fakeAsyncGit(rules);
  const res = await losslessPremergeClean(
    "/base",
    branch,
    "keeper/epic/fn-1-foo--fn-1-foo.2",
    new Set(),
    run,
    okLock,
  );
  expect(res.kind).toBe("retry");
  if (res.kind === "retry") expect(res.reason).toContain("restore failed");
});
