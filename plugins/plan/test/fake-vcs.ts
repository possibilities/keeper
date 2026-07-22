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
//
// The READ surface (isGitRepo / hasHead / resolveRef / trailerCommitShas /
// sourceCommitShas / committedTaskJson / shortStatusAndDiff / firstSourceShaShort)
// answers the post-worker verbs' git archaeology from an in-memory model: seeded
// source
// commits (fakeSourceCommit — a worker's `Task:`-trailer commit) and a committed
// `.keeper/` blob overlay (fakeCommitTaskJson + every commit() re-snapshot). The
// trailer matcher reproduces git's interpret-trailers all-or-nothing block rule,
// so a prose `Task:` mention and an fn-N.10 substring sibling are rejected exactly
// as real git rejects them.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

import type {
  GitResult,
  InProgressOp,
  NumstatRow,
  NumstatTotals,
  PlanVcs,
} from "../src/vcs.ts";

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

/** A seeded source commit — a worker's `Task:`-trailer commit the in-verb git
 * READS (trailer scan / source-commit find) return. Distinct from the auto-commit
 * log: source commits carry a raw message (with a trailer block) and an explicit
 * HEAD blob snapshot of any `.keeper/` paths visible at that commit. */
interface FakeSourceCommit {
  /** Full 40-char hex sha (deterministic, counter-derived). */
  sha: string;
  /** The raw commit message, including any trailing `Task:` trailer block. */
  message: string;
  /** The refs this commit is reachable from — the fake analogue of "which
   * branches contain it". Default `["HEAD"]` (the ordinary case: on the main
   * branch, found by a ref-less scan). A lane-ONLY commit carries the epic lane
   * ref `keeper/epic/<epic_id>` and NOT HEAD, so a HEAD scan misses it and only
   * the lane-ref scan finds it — exactly the worktree-epic pre-merge geometry. */
  refs: string[];
  /** The `git show --numstat` rows the commitNumstat read returns for this sha
   * (default []). Seeded so the selection-audit brief's diff-stat aggregation is
   * exercisable without real git. */
  numstat: NumstatRow[];
}

/** Per-repo fake state: the auto-commit log + the last committed `.keeper/`
 * snapshot (repo-relative POSIX path -> file content, excluding `state/`), plus
 * the seeded source commits + committed-blob overlay the READS consult. */
interface RepoState {
  log: FakeCommit[];
  snapshot: Map<string, string>;
  /** Armed one-shot failures for the next commit / status / index-reset call. */
  commitFailures: QueuedFailure[];
  statusFailures: QueuedFailure[];
  restoreFailures: QueuedFailure[];
  /** Seeded source commits, newest-LAST (a real `git log` reads newest-first, so
   * the read methods reverse this for their result order). */
  sourceCommits: FakeSourceCommit[];
  /** Committed `.keeper/` blob overlay (repo-relative POSIX path -> content) the
   * stateHeadVisible read consults — the fake analogue of HEAD:<path>. Seeded by
   * fakeCommitTaskJson; the auto-commit path also writes it on commit(). */
  committedBlobs: Map<string, string>;
  /** The in-progress operation inProgressOp(cwd) reports, armed by
   * armInProgressOp. Default "none" — the fake models no real git dir, so the
   * merge-window guard's refusal is driven from this armed state. */
  inProgressOp: InProgressOp;
}

const repos = new Map<string, RepoState>();
let commitCounter = 0;
/** Per-repo override for sessionDirtyPaths (tests): a `string[]` forces that
 * exact dirty set, `null` forces the fail-open (git-unreadable) signal. Unset ⇒
 * the fake derives the set from the `.keeper/` snapshot diff. */
const sessionDirtyOverrides = new Map<string, string[] | null>();
/** Whether the fake reports a present git binary. A test arms absence via
 * setGitBinaryPresent(false) to drive the fail-closed source-scan path. */
let gitBinaryPresent = true;
/** Per-repo flag forcing commitSetNumstat to report a `git show` failure
 * (error:true, zero totals) — the shallow / rewritten-sha numstat degrade a
 * test drives without real git. Set via setNumstatError, cleared by
 * resetFakeVcs. */
const numstatErrorRepos = new Set<string>();

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
      restoreFailures: [],
      sourceCommits: [],
      committedBlobs: new Map(),
      inProgressOp: "none",
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

/** Extract the trailer-block `Task:` values from a commit `message` the way git's
 * `interpret-trailers --parse` does: ONLY the final paragraph (the block after
 * the last blank line) counts as trailers, and only when every non-empty line in
 * it is a `Key: value` trailer line. A prose mention of `Task:` mid-body, or a
 * `Task:` line in a paragraph followed by more prose, is NOT a trailer. Returns
 * each `Task:` value, comma-split (so `Task: a, b` yields both), trimmed. */
function trailerTaskValues(message: string): string[] {
  const lines = message.replace(/\s+$/, "").split("\n");
  // Find the last paragraph: walk back from the end over non-blank lines.
  const end = lines.length;
  let start = end;
  while (start > 0 && lines[start - 1]?.trim() !== "") {
    start -= 1;
  }
  const block = lines.slice(start, end);
  if (block.length === 0) {
    return [];
  }
  // Every line in the block must be a `Key: value` trailer line, else this is a
  // prose paragraph (not a trailer block) — git's all-or-nothing rule.
  const trailerLine = /^[A-Za-z0-9][A-Za-z0-9-]*:\s?.*$/;
  if (!block.every((ln) => trailerLine.test(ln))) {
    return [];
  }
  const values: string[] = [];
  for (const ln of block) {
    const sep = ln.indexOf(":");
    const key = ln.slice(0, sep).trim();
    if (key !== "Task") {
      continue;
    }
    for (const v of ln.slice(sep + 1).split(",")) {
      const trimmed = v.trim();
      if (trimmed) {
        values.push(trimmed);
      }
    }
  }
  return values;
}

/** Source commits in `state` carrying a confirmed `Task: <taskId>` trailer AND
 * reachable from `ref` (default HEAD, matching a ref-less `git log`), NEWEST-FIRST
 * (a real `git log` reads newest-first). A ref-scoped scan (`keeper/epic/<id>`)
 * therefore sees a lane-only commit a HEAD scan omits. */
function matchingSourceShas(
  state: RepoState,
  taskId: string,
  ref?: string,
): string[] {
  const wantRef = ref ?? "HEAD";
  const shas: string[] = [];
  for (let i = state.sourceCommits.length - 1; i >= 0; i--) {
    const c = state.sourceCommits[i] as FakeSourceCommit;
    if (!c.refs.includes(wantRef)) {
      continue;
    }
    if (trailerTaskValues(c.message).includes(taskId)) {
      shas.push(c.sha);
    }
  }
  return shas;
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
  state.restoreFailures = [];
  state.sourceCommits = [];
  state.committedBlobs = new Map();
  state.inProgressOp = "none";
}

/** Adopt the current `.keeper/` tree as the committed baseline WITHOUT recording
 * a log entry — the fake analogue of `git init` + an initial seed commit that the
 * test then ignores. After this, only later verb-driven changes diff as dirty.
 * Returns `root`. Used by gitBaseline. */
export function baselineRepo(root: string): string {
  initRepo(root);
  const state = repoFor(root);
  const tree = snapshotKeeperTree(root);
  state.snapshot = tree;
  // The baseline commit IS in HEAD, so its `.keeper/` blobs are visible to the
  // stateHeadVisible read (mirrors a real seed commit).
  state.committedBlobs = new Map(tree);
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

/** Arm the NEXT restoreIndexToHead (`git reset HEAD -- <paths>`) against `root` to
 * report a non-zero exit (one-shot). Drives the commit-failure rollback's
 * unstage-failure path: the working-tree bytes still restore (real FS), but the
 * unconfirmed index reset makes restoreForRollback stamp `rollback_failed`. The
 * fake models no index, so an index-reset failure is the arm-able rollback slip. */
export function armRestoreFailure(
  root: string,
  stderr = "fake reset failure",
): void {
  repoFor(root).restoreFailures.push({ stderr });
}

/** Seed a worker source commit in `root` carrying `messageWithTrailers` (a raw
 * commit message, typically ending in a `Task: <id>` trailer block). The in-verb
 * git READS (find-task-commit's trailerCommitShas, reconcile's sourceCommitShas,
 * worker-resume's firstSourceShaShort) return its sha when the trailer matches.
 * Returns the full 40-char hex sha. The repo is auto-registered if needed, so a
 * test may seed without a prior initRepo.
 *
 * `opts.refs` overrides which refs reach the commit (default `["HEAD"]` — the
 * ordinary on-main commit a ref-less scan finds). Seed a LANE-ONLY commit with
 * `{ refs: ["keeper/epic/<id>"] }`: it is NOT on HEAD, so only the epic-close
 * lane-ref scan (and `resolveRef`'s lane probe) sees it. `opts.numstat` seeds the
 * per-file diff rows the commitNumstat read returns for the diff-stat brief. */
export function fakeSourceCommit(
  root: string,
  messageWithTrailers: string,
  opts?: { refs?: string[]; numstat?: NumstatRow[] },
): string {
  // Ensure a `.git/` exists so the isGitRepo gate passes for a bare seed.
  if (!existsSync(join(root, ".git"))) {
    mkdirSync(join(root, ".git"), { recursive: true });
  }
  const state = repoFor(root);
  commitCounter += 1;
  const sha = commitCounter.toString(16).padStart(40, "0");
  state.sourceCommits.push({
    sha,
    message: messageWithTrailers,
    refs: opts?.refs ?? ["HEAD"],
    numstat: opts?.numstat ?? [],
  });
  return sha;
}

/** Stamp `taskId`'s tracked task JSON into `root`'s committed-blob overlay so the
 * stateHeadVisible read sees it in HEAD. Reads the live `.keeper/tasks/<id>.json`
 * off disk (the test having written worker_done_at), mirroring a real
 * `git add` + `git commit` of the done stamp. */
export function fakeCommitTaskJson(root: string, taskId: string): void {
  const state = repoFor(root);
  const rel = `.keeper/tasks/${taskId}.json`;
  const abs = join(root, rel);
  try {
    state.committedBlobs.set(rel, readFileSync(abs, "utf-8"));
  } catch {
    // Nothing on disk to commit — leave the overlay untouched.
  }
}

/** Force `sessionDirtyPaths(root)` to return `value` (tests): a `string[]` is an
 * exact dirty set, `null` drives the fail-open (git-unreadable) signal the
 * close-out gate surfaces as a visible marker. Cleared by resetFakeVcs. */
export function setSessionDirty(root: string, value: string[] | null): void {
  sessionDirtyOverrides.set(normRoot(root), value);
}

/** Arm `root`'s fake in-progress-operation probe to report `op` — the state the
 * merge-window guard reads via inProgressOp(cwd) before writing. A test arms an
 * op here to prove a mutating verb refuses to write mid-operation. Reset to
 * "none" by initRepo / resetFakeVcs. */
export function armInProgressOp(root: string, op: InProgressOp): void {
  repoFor(root).inProgressOp = op;
}

/** Clear all fake-repo state — call in a global beforeEach so per-test repos
 * never bleed across tests sharing a (reused) path. */
export function resetFakeVcs(): void {
  repos.clear();
  commitCounter = 0;
  gitBinaryPresent = true;
  sessionDirtyOverrides.clear();
  numstatErrorRepos.clear();
}

/** Force `commitSetNumstat(_, root)` to report a `git show` failure (error:true,
 * zero totals) or restore normal summing — the numstat-degrade arm the close
 * brief lands at lean. Cleared by resetFakeVcs. */
export function setNumstatError(root: string, failing: boolean): void {
  const key = normRoot(root);
  if (failing) {
    numstatErrorRepos.add(key);
  } else {
    numstatErrorRepos.delete(key);
  }
}

/** Arm the fake to report git as absent (false) or present (true). Drives the
 * findSourceCommits fail-closed-on-absent-binary path. Reset to true by
 * resetFakeVcs. */
export function setGitBinaryPresent(present: boolean): void {
  gitBinaryPresent = present;
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
    // Re-snapshot so a subsequent verb's diff isolates only ITS changes, and
    // adopt the committed `.keeper/` tree into HEAD's blob overlay (so a later
    // stateHeadVisible read sees what this commit landed).
    const tree = snapshotKeeperTree(normRoot(cwd));
    state.snapshot = tree;
    state.committedBlobs = new Map(tree);
    return { ...ok(), sha };
  },

  restoreIndexToHead(_paths, cwd): GitResult {
    // The fake commits directly from the working-tree diff and models no index,
    // so an index reset is normally a no-op — precisely why F1's staged-half-stamp
    // bug is observable only under real git (the slow tier proves the real
    // unwind). An armed restore failure returns a non-zero exit so a test can
    // drive restoreForRollback's rollback_failed path.
    const failure = repoFor(cwd).restoreFailures.shift();
    if (failure) {
      return { exitCode: 1, stdout: "", stderr: failure.stderr };
    }
    return ok();
  },

  gitBinaryPresent(): boolean {
    return gitBinaryPresent;
  },

  isGitRepo(repo): boolean {
    return existsSync(join(repo, ".git"));
  },

  hasHead(repo): boolean {
    const state = repos.get(normRoot(repo));
    if (!state) {
      return false;
    }
    // A born HEAD: any auto-commit, baseline blob, or seeded source commit.
    return (
      state.log.length > 0 ||
      state.committedBlobs.size > 0 ||
      state.sourceCommits.length > 0
    );
  },

  resolveRef(ref, repo): string | null {
    const state = repos.get(normRoot(repo));
    if (!state) {
      return null;
    }
    // The ref resolves iff some seeded commit is reachable from it (newest such is
    // the tip). A lane that no commit carries reads absent → null → HEAD fallback.
    for (let i = state.sourceCommits.length - 1; i >= 0; i--) {
      const c = state.sourceCommits[i] as FakeSourceCommit;
      if (c.refs.includes(ref)) {
        return c.sha;
      }
    }
    return null;
  },

  isAncestor(commit, base, repo): boolean {
    // Reachability in the fake IS a seeded commit's `refs` membership: the commit
    // whose sha is `commit` is an ancestor of `base` iff it carries `base` among
    // the refs that reach it (a lane-only commit lacking HEAD is NOT an ancestor of
    // HEAD; a rib-only commit lacking the epic base is NOT an ancestor of it). An
    // unseeded sha reads false — the same fail-closed default realGitVcs gives a
    // bad object.
    const state = repos.get(normRoot(repo));
    if (!state) {
      return false;
    }
    for (const c of state.sourceCommits) {
      if (c.sha === commit) {
        return c.refs.includes(base);
      }
    }
    return false;
  },

  trailerCommitShas(taskId, repo, ref): string[] {
    return matchingSourceShas(repoFor(repo), taskId, ref);
  },

  sourceCommitShas(taskId, repo): string[] {
    return matchingSourceShas(repoFor(repo), taskId);
  },

  commitNumstat(sha, repo): NumstatRow[] {
    const state = repos.get(normRoot(repo));
    if (!state) {
      return [];
    }
    for (const c of state.sourceCommits) {
      if (c.sha === sha) {
        return c.numstat.map((r) => ({ ...r }));
      }
    }
    return [];
  },

  commitSetNumstat(shas, repo): NumstatTotals {
    const key = normRoot(repo);
    const totals: NumstatTotals = {
      insertions: 0,
      deletions: 0,
      files: 0,
      error: false,
    };
    if (numstatErrorRepos.has(key)) {
      return { ...totals, error: true };
    }
    const state = repos.get(key);
    if (!state) {
      return totals;
    }
    const bySha = new Map(state.sourceCommits.map((c) => [c.sha, c]));
    for (const sha of shas) {
      const c = bySha.get(sha);
      if (c === undefined) {
        continue;
      }
      for (const row of c.numstat) {
        totals.insertions += row.insertions;
        totals.deletions += row.deletions;
        totals.files += 1;
      }
    }
    return totals;
  },

  committedTaskJson(stateRepo, taskId, dataDirNames) {
    const state = repoFor(stateRepo);
    for (const dataDirName of dataDirNames) {
      const rel = `${dataDirName}/tasks/${taskId}.json`;
      const blob = state.committedBlobs.get(rel);
      if (blob === undefined) {
        continue;
      }
      try {
        return JSON.parse(blob) as Record<string, unknown>;
      } catch (exc) {
        throw new Error(
          `HEAD:${rel} is not valid JSON: ${(exc as Error).message}`,
        );
      }
    }
    return null;
  },

  shortStatusAndDiff(cwd): string {
    // The fake's dirty diff stands in for `git status --short`; the diff --stat
    // half is not modeled (worker-resume only counts dirty lines, which the
    // status half supplies). One line per dirty path, ` M ` prefix.
    const state = repos.get(normRoot(cwd));
    if (!state) {
      return "";
    }
    const dirty = [
      ...diffAgainstSnapshot(normRoot(cwd), state.snapshot),
    ].sort();
    return dirty.map((p) => ` M ${p}`).join("\n");
  },

  firstSourceShaShort(taskId, cwd): string | null {
    const shas = matchingSourceShas(repoFor(cwd), taskId);
    return shas.length > 0 ? (shas[0] as string).slice(0, 7) : null;
  },

  sessionDirtyPaths(cwd): string[] | null {
    const key = normRoot(cwd);
    if (sessionDirtyOverrides.has(key)) {
      return sessionDirtyOverrides.get(key) as string[] | null;
    }
    const state = repos.get(key);
    if (!state) {
      return [];
    }
    return [...diffAgainstSnapshot(key, state.snapshot)].sort();
  },

  inProgressOp(cwd): InProgressOp {
    const state = repos.get(normRoot(cwd));
    return state?.inProgressOp ?? "none";
  },

  commitWorkLockPath(cwd): string {
    // The fake models `.git` as a directory under the repo root, so the lock
    // path is `<root>/.git/keeper-commit-work.lock` — the same file both a plan
    // committer and the daemon key on for a main checkout (byte-parity with
    // realGitVcs is asserted against real git in the slow tier).
    return join(normRoot(cwd), ".git", "keeper-commit-work.lock");
  },
};
