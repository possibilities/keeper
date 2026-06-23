// The fake VCS facade the bun:test harness installs in place of real git, so the
// default plan test tier spawns zero real `git`. It implements the PlanVcs
// interface (src/vcs.ts) over an in-memory per-repo model:
//
//  - initRepo(root) creates a `.git/` dir (enough for findGitRoot /
//    validateRepoPath / init's git-work-tree gate) and registers an empty repo;
//  - each repo holds a commit log [{sha, message, files}] and a snapshot of its
//    `.keeper/` tree (path -> content), EXCLUDING `.keeper/state/` exactly as the
//    inner `.gitignore` excludes it from real git;
//  - dirtyDataDirPaths / dirtyFilesForPathspecs diff the live filesystem against
//    the last snapshot (added/modified/deleted), so no-op / idempotency /
//    exactly-one-commit coverage survives — a clean tree diffs to empty;
//  - commit(msg, files) appends a log entry, re-snapshots, and returns a
//    deterministic fake sha;
//  - the harness assertion helpers (gitLogCount/gitHeadSha/gitHeadMessage/
//    gitFilesInHead/gitBaseline) read this log instead of real git.
//
// A test can install a faked NON-zero commit/status result (failNextCommit /
// failNextStatus) to exercise the CommitFailed / contention-retry paths without
// real git.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

import type { GitResult, PlanVcs } from "../src/vcs.ts";

/** One recorded commit — the fake log entry the assertion helpers read. */
export interface FakeCommit {
  sha: string;
  message: string;
  /** Repo-relative POSIX paths committed (the dirty subset, deletions included). */
  files: string[];
}

/** A queued failure a test arms to drive a CommitFailed / contention path. */
interface QueuedFailure {
  stderr: string;
}

/** Per-repo fake state: the commit log + the last committed `.keeper/` snapshot
 * (repo-relative POSIX path -> file content, excluding `state/`). */
interface RepoState {
  log: FakeCommit[];
  snapshot: Map<string, string>;
  /** Armed one-shot failures for the next commit / status call. */
  commitFailures: QueuedFailure[];
  statusFailures: QueuedFailure[];
}

const repos = new Map<string, RepoState>();
let commitCounter = 0;

/** Normalize a repo path to its realpath when it exists (the harness tmpdirs are
 * realpath'd; production resolves the project root through realpathSync too), so
 * a registered repo and a later lookup key match regardless of symlink form. */
function normRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

/** The RepoState for `root`, minting an empty one on first touch — a verb may
 * commit into a repo that was set up via a bare `.git/` dir without initRepo
 * (the diff against an empty snapshot then reports the whole tree as added,
 * matching real git's first-commit behavior). */
function repoFor(root: string): RepoState {
  const key = normRoot(root);
  let state = repos.get(key);
  if (!state) {
    state = {
      log: [],
      snapshot: new Map(),
      commitFailures: [],
      statusFailures: [],
    };
    repos.set(key, state);
  }
  return state;
}

/** Walk `.keeper/` under `root` recursively, returning repo-relative POSIX path
 * -> content for every file EXCEPT those under `.keeper/state/` (the inner
 * `.gitignore` excludes `state/`, so real git never reports them dirty). Empty
 * map when no `.keeper/` exists. */
function snapshotKeeperTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const dataDir = join(root, ".keeper");
  if (!existsSync(dataDir)) {
    return out;
  }
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = relative(root, abs).split(sep).join("/");
      // Mirror the inner `.gitignore`: skip the gitignored state/ subtree.
      if (rel === ".keeper/state" || rel.startsWith(".keeper/state/")) {
        continue;
      }
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(abs);
      } else {
        try {
          out.set(rel, readFileSync(abs, "utf-8"));
        } catch {
          out.set(rel, "");
        }
      }
    }
  };
  walk(dataDir);
  return out;
}

/** Repo-relative POSIX paths whose live content differs from `snapshot`
 * (added/modified/deleted). The set the dirty-discovery surfaces. */
function diffAgainstSnapshot(
  root: string,
  snapshot: Map<string, string>,
): Set<string> {
  const live = snapshotKeeperTree(root);
  const dirty = new Set<string>();
  for (const [path, content] of live) {
    if (snapshot.get(path) !== content) {
      dirty.add(path);
    }
  }
  for (const path of snapshot.keys()) {
    if (!live.has(path)) {
      dirty.add(path); // deleted
    }
  }
  return dirty;
}

/** True when `path` is matched by `spec` as git would: an exact path match or a
 * directory-prefix match (`spec` or `spec/` is a prefix of `path`). */
function pathspecMatches(spec: string, path: string): boolean {
  const norm = spec.endsWith("/") ? spec.slice(0, -1) : spec;
  return path === norm || path.startsWith(`${norm}/`);
}

// ---------------------------------------------------------------------------
// Public install/control surface.
// ---------------------------------------------------------------------------

/** Create a fake `.git/` dir under `root` and register an empty repo. The
 * `.git/` entry satisfies findGitRoot / validateRepoPath / init's git-work-tree
 * gate; the empty snapshot means the first commit reports the whole `.keeper/`
 * tree as added. Idempotent — a second call resets the repo to empty. */
export function initRepo(root: string): void {
  mkdirSync(join(root, ".git"), { recursive: true });
  const state = repoFor(root);
  state.log = [];
  state.snapshot = new Map();
  state.commitFailures = [];
  state.statusFailures = [];
}

/** Adopt the current `.keeper/` tree as the committed baseline WITHOUT recording
 * a log entry — the fake analogue of `git init` + an initial seed commit that the
 * test then ignores. After this, only later verb-driven changes diff as dirty.
 * Returns `root`. Used by gitBaseline. */
export function baselineRepo(root: string): string {
  initRepo(root);
  const state = repoFor(root);
  state.snapshot = snapshotKeeperTree(root);
  return root;
}

/** The recorded commit log for `root` (empty when none / unregistered). */
export function fakeLog(root: string): FakeCommit[] {
  return repos.get(normRoot(root))?.log ?? [];
}

/** Sorted repo-relative paths whose live `.keeper/` tree differs from the last
 * committed snapshot — the fake analogue of `git status --porcelain` over the
 * data dir. Empty means a clean tree. Used by clean-tree test assertions. */
export function fakeDirtyPaths(root: string): string[] {
  const state = repos.get(normRoot(root));
  if (!state) {
    return [];
  }
  return [...diffAgainstSnapshot(normRoot(root), state.snapshot)].sort();
}

/** Arm the NEXT commit() call against `root` to fail with `stderr` (one-shot).
 * Drives the CommitFailed("git_commit") / contention-retry paths. Default stderr
 * is a generic commit failure. */
export function failNextCommit(
  root: string,
  stderr = "fake commit failure",
): void {
  repoFor(root).commitFailures.push({ stderr });
}

/** Arm the NEXT status query (dirtyFilesForPathspecs) against `root` to fail with
 * `stderr` (one-shot). Drives the CommitFailed("git_status") path. */
export function failNextStatus(
  root: string,
  stderr = "fake status failure",
): void {
  repoFor(root).statusFailures.push({ stderr });
}

/** Clear all fake-repo state — call in a global beforeEach so per-test repos
 * never bleed across tests sharing a (reused) path. */
export function resetFakeVcs(): void {
  repos.clear();
  commitCounter = 0;
}

// ---------------------------------------------------------------------------
// The PlanVcs implementation the harness installs via setVcs.
// ---------------------------------------------------------------------------

const ok = (stdout = ""): GitResult => ({ exitCode: 0, stdout, stderr: "" });

export const fakeVcs: PlanVcs = {
  dirtyDataDirPaths(repoRoot, _dataDirNames): Set<string> {
    const state = repoFor(repoRoot);
    return diffAgainstSnapshot(normRoot(repoRoot), state.snapshot);
  },

  currentHead(cwd): string {
    const log = repoFor(cwd).log;
    return log.length > 0 ? (log[log.length - 1] as FakeCommit).sha : "unknown";
  },

  dirtyFilesForPathspecs(pathspecs, cwd) {
    const state = repoFor(cwd);
    const failure = state.statusFailures.shift();
    if (failure) {
      return { exitCode: 1, stdout: "", stderr: failure.stderr, files: [] };
    }
    const dirty = diffAgainstSnapshot(normRoot(cwd), state.snapshot);
    const files = [...dirty]
      .filter((path) => pathspecs.some((spec) => pathspecMatches(spec, path)))
      .sort();
    return { ...ok(), files };
  },

  stage(_files, _cwd): GitResult {
    // The fake commits directly from the dirty diff; staging is a no-op.
    return ok();
  },

  commit(_msg, files, cwd) {
    const state = repoFor(cwd);
    const failure = state.commitFailures.shift();
    if (failure) {
      return { exitCode: 1, stdout: "", stderr: failure.stderr, sha: "" };
    }
    commitCounter += 1;
    // A 40-char hex sha whose LEADING digits encode the counter, so distinct
    // commits also have distinct git-short (7-char) shas — a test comparing two
    // HEAD shas sees them differ exactly as real git would.
    const sha = commitCounter.toString(16).padStart(40, "0");
    state.log.push({ sha, message: _msg, files: [...files] });
    // Re-snapshot so a subsequent verb's diff isolates only ITS changes.
    state.snapshot = snapshotKeeperTree(normRoot(cwd));
    return { ...ok(), sha };
  },
};
