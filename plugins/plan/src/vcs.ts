// The git facade seam for plan-state persistence AND the in-verb git reads.
// Every git operation the auto-commit machinery performs — the dirty-path
// discovery buildPlanInvocation runs (`git status` over the data dirs), and the
// status/stage/commit the auto-commit itself runs — plus every read the
// post-worker verbs perform (the trailer scans, source-commit finds, HEAD
// visibility, status/diff snapshots) routes through the single PlanVcs installed
// here.
//
// Production installs nothing: getVcs() returns realGitVcs, the verbatim
// Bun.spawnSync(["git", ...]) implementation, so the binary's behavior is
// untouched. The bun:test harness installs a fake facade (setVcs) that records
// commits + diffs the .keeper/ tree against a snapshot and answers the reads
// from seeded fake source commits, so the default test tier spawns zero real
// git. resetVcs() restores the real facade.
//
// The WRITE surface is the minimal set the two persistence call sites need:
//  - dirtyDataDirPaths: invocation.ts's pre-commit dirty discovery (status over
//    the data dirs, untracked-files=all),
//  - currentHead / dirtyFilesForPathspecs / stage / commit: commit.ts's
//    auto-commit plumbing (the real implementation surfaces the contention
//    stderr the retry loop matches, so the fake can simulate it too).
//
// The READ surface is the set the post-worker verbs consult:
//  - isGitRepo / hasHead: the repo-shape gates,
//  - resolveRef: the epic-close lane-branch probe (present → scan that ref),
//  - trailerCommitShas: commit_lookup.ts's grep + interpret-trailers confirmed
//    scan (find-task-commit; the epic close scopes it to the lane ref),
//  - sourceCommitShas: reconcile.ts's %(trailers:valueonly) unit-sep scan,
//  - committedTaskJson: reconcile.ts's HEAD:<task.json> cat-file blob,
//  - shortStatusAndDiff / firstSourceShaShort: worker_resume.ts's nudge probes.

import { readFileSync, statSync } from "node:fs";

/** Which in-progress git operation a checkout's git dir currently holds, or
 * "none". An auto-commit that lands mid-operation is the fn-1183 destruction
 * window (a later `git merge --abort` discards the staged plan files), so the
 * pre-write guard refuses ANY of these — merge, cherry-pick, revert, rebase, or a
 * bare sequencer sequence — not just a merge. */
export type InProgressOp =
  | "merge"
  | "cherry-pick"
  | "revert"
  | "rebase"
  | "sequencer"
  | "none";

/** Result of a git invocation the auto-commit plumbing inspects: exit code plus
 * decoded stdout/stderr. The contention-retry loop matches stderr substrings, so
 * the fake must be able to return a non-zero exit with a chosen stderr. */
export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** One `git show --numstat` row for a commit: the changed path plus its added /
 * deleted line counts. A binary file (numstat `-`/`-`) folds to zero lines but
 * still contributes one changed path. The selection-audit brief aggregates these
 * across a task's source commits into its diff-stat signal. */
export interface NumstatRow {
  path: string;
  insertions: number;
  deletions: number;
}

/** The straight-summed diff totals over a SET of source commits — the only
 * well-defined aggregate over a non-linear commit_group (the commits share no
 * single range, so per-commit numstat is summed, a path touched in two commits
 * counting twice). `files` is the total changed-path row count across the set.
 * `error` is true when the underlying `git show` failed for at least one sha
 * (shallow clone / rewritten or missing sha): the totals are then best-effort
 * partial and the close brief records the numstat degrade. The close-brief
 * depth signal consumes this per repo. */
export interface NumstatTotals {
  insertions: number;
  deletions: number;
  files: number;
  error: boolean;
}

/** The git operations plan-state persistence performs. A real implementation
 * shells `git`; the test fake records commits + snapshot-diffs the data dir. */
export interface PlanVcs {
  /** Dirty (modified/untracked/deleted) data-dir paths from
   * `git status --porcelain --untracked-files=all -- <dataDirs>`, repo-relative
   * POSIX, rename "a -> b" taking b. The set buildPlanInvocation intersects with
   * the touched-paths log. */
  dirtyDataDirPaths(
    repoRoot: string,
    dataDirNames: readonly string[],
  ): Set<string>;

  /** Current HEAD sha, or "unknown" on failure (fresh repo / corrupt HEAD). */
  currentHead(cwd: string): string;

  /** Repo-relative paths under `pathspecs` git would stage (status --porcelain=v1
   * -- <specs>). Returns {files} on success or {error} carrying the verbatim
   * stderr so the caller raises CommitFailed("git_status"). */
  dirtyFilesForPathspecs(
    pathspecs: string[],
    cwd: string,
  ): GitResult & { files: string[] };

  /** Stage `files` (`git add -- <files>`). Returns the raw GitResult so the
   * caller raises CommitFailed("git_add") + matches index.lock contention. */
  stage(files: string[], cwd: string): GitResult;

  /** Commit `files` with `msg` (`commit -F - -- <files>`), then resolve HEAD.
   * Returns the commit GitResult plus the resolved sha (empty on commit failure
   * — the caller raises CommitFailed("git_commit") before reading sha). */
  commit(
    msg: string,
    files: string[],
    cwd: string,
  ): GitResult & { sha: string };

  /** Reset the index entries for `paths` back to HEAD (`git reset -q HEAD --
   * <paths>`), undoing a `git add` from a pathspec commit git then refused (the
   * mid-merge partial-commit window). The working tree is left untouched — the
   * caller restores those bytes separately. Returns the raw GitResult; a path
   * absent from HEAD is simply unstaged, and a path never staged (a gitignored
   * overlay) is a clean no-op. done's commit-failure unwind calls this so no
   * staged half-stamp survives into a later full-index merge-completion. */
  restoreIndexToHead(paths: string[], cwd: string): GitResult;

  // -------------------------------------------------------------------------
  // Read surface — the post-worker verbs' git archaeology.
  // -------------------------------------------------------------------------

  /** True iff the `git` binary is invokable at all (a `git --version` spawn that
   * did not ENOENT). Distinguishes "git absent" from "git present but not a work
   * tree" — the absent case must fail closed (the repo-shape gates collapse both
   * to a false isGitRepo, so the source scan probes this first to stay
   * fail-closed). */
  gitBinaryPresent(): boolean;

  /** True iff `repo` is an existing dir containing a git work tree. The repo-shape
   * gate commit_lookup / reconcile run before scanning. A missing git binary or a
   * non-repo dir reads false (NOT a throw) for the source scan. */
  isGitRepo(repo: string): boolean;

  /** True when `repo`'s HEAD points at a real commit (born branch). An unborn /
   * orphan branch reads false (a distinct signal, NOT an error). */
  hasHead(repo: string): boolean;

  /** The commit sha `ref` resolves to via `git rev-parse --verify <ref>`, or null
   * when the ref is absent / invalid / git unreadable — a clean miss AND any error
   * both fold to null, NEVER a throw. The epic-close scan probes the deterministic
   * lane branch per repo: non-null → scan that ref, null → fall back to HEAD (so a
   * repo without a lane, or a missing-ref error, is never dropped). */
  resolveRef(ref: string, repo: string): string | null;

  /** Full %H shas in `repo` carrying a confirmed `Task: <taskId>` trailer via the
   * commit_lookup technique (`git log --grep` prefilter +
   * `git interpret-trailers --parse` confirmation), newest-first. A clean miss is
   * []. `ref`, when given, scopes the scan to that revision (`git log <ref>`) — the
   * epic close scans the lane branch `keeper/epic/<epic_id>` to see lane-only
   * commits; omitted, the scan defaults to HEAD (find-task-commit's byte-identical
   * behavior). */
  trailerCommitShas(taskId: string, repo: string, ref?: string): string[];

  /** Full %H shas in `repo` carrying a trailer-authentic `Task: <taskId>` via the
   * reconcile technique (`%(trailers:key=Task,valueonly=true)` + unit-sep split,
   * exact-equality match), newest-first. [] when not a work tree / no born HEAD.
   * THROWS on an unexpected git failure (the caller fails closed to
   * tooling_error). */
  sourceCommitShas(taskId: string, repo: string): string[];

  /** The per-file `git show --numstat` rows for commit `sha` in `repo` — one row
   * per changed path with its added / deleted line counts (binary `-` folds to
   * 0). [] on any failure / a missing sha (a clean read of nothing, never a
   * throw). The selection-audit brief consumes this to derive per-task diff
   * stats from the Task-trailer source commits. */
  commitNumstat(sha: string, repo: string): NumstatRow[];

  /** The per-commit numstat of every sha in `shas` SUMMED into one diff-total
   * (insertions / deletions / changed-path rows). An empty list is a clean zero
   * (no git spawn). A per-sha `git show` failure leaves `error` true with the
   * partial totals — the close brief lands the depth band at lean and records
   * the numstat degrade rather than trusting an under-counted diff. The
   * close-preflight depth signal consumes this once per commit_group. */
  commitSetNumstat(shas: string[], repo: string): NumstatTotals;

  /** The committed `HEAD:<dataDir>/tasks/<taskId>.json` parsed object for the
   * FIRST data dir under which it resolves, or null when the path is absent from
   * HEAD under every data dir (or HEAD is unborn). THROWS on an unexpected git
   * failure or invalid JSON. Used by reconcile.stateHeadVisible. */
  committedTaskJson(
    stateRepo: string,
    taskId: string,
    dataDirNames: readonly string[],
  ): Record<string, unknown> | null;

  /** `git status --short` + `git diff HEAD --stat` joined (non-empty parts), or ""
   * when git is unavailable / produced nothing. Run in `cwd`. Used by worker
   * resume's dirty-file nudge. */
  shortStatusAndDiff(cwd: string): string;

  /** The SHORT sha (%h) of `taskId`'s first source commit found via a cheap
   * `git log -1 --format=%h --grep="Task: <id>" --fixed-strings` in `cwd`, or
   * null on any failure / miss. Used by worker resume's nudge. */
  firstSourceShaShort(taskId: string, cwd: string): string | null;

  /** Repo-relative paths git reports dirty across `cwd`'s whole work tree via
   * `git status --porcelain=v1 --untracked-files=all` (modified / untracked /
   * deleted, rename taking the destination) — a worker's undischarged session
   * files, the close-out gate's observable. Returns [] for a clean tree and
   * `null` when git could not be read (missing binary / not a work tree / any
   * spawn failure): the FAIL-OPEN signal the gate surfaces as a VISIBLE marker
   * rather than a silent false-clean read. Used by reconcile's close-out probe. */
  sessionDirtyPaths(cwd: string): string[] | null;

  // -------------------------------------------------------------------------
  // Merge-window guard surface — the pre-write in-progress probe + the shared
  // commit-work lock path the write->commit window serializes on.
  // -------------------------------------------------------------------------

  /** Which in-progress operation `cwd`'s git dir holds — merge / cherry-pick /
   * revert / rebase / sequencer, or "none". Probed via `git rev-parse -q --verify`
   * of MERGE_HEAD / CHERRY_PICK_HEAD / REVERT_HEAD / REBASE_HEAD plus a non-empty
   * sequencer todo. `cwd` MUST be the STATE repo whose commit is about to run (a
   * linked worktree carries its OWN MERGE_HEAD / index), NOT the invoking process
   * cwd. A specific `*_HEAD` classifies the op; the sequencer todo is the fallback
   * for the between-picks window where no `*_HEAD` is currently set. Any probe
   * failure (git unreadable) reads "none" — the auto-commit stays the authority. */
  inProgressOp(cwd: string): InProgressOp;

  /** The commit-work lock path for `cwd`'s checkout —
   * `<git-dir>/keeper-commit-work.lock`, from `git rev-parse
   * --path-format=absolute --git-dir` — derived BYTE-IDENTICALLY to the daemon's
   * `commitWorkLockPath` (src/worktree-git.ts) so a plan verb's committer and the
   * daemon's base-merge / commit-work contend on the SAME file for one checkout. A
   * linked worktree keys on its OWN git dir; on a git error / empty stdout it
   * falls back to `<cwd>/.git/keeper-commit-work.lock` (never a bare relative
   * `.git`). */
  commitWorkLockPath(cwd: string): string;
}

// ---------------------------------------------------------------------------
// Real implementation — the verbatim git plumbing. Production default.
// ---------------------------------------------------------------------------

// The four git env vars that route the repo/index/work-tree BEFORE cwd is
// consulted. When any is set — inherited from a parent process that ran inside a
// DIFFERENT worktree (e.g. autopilot's worktree-mode producer, or a git hook) —
// git resolves the repo from them and IGNORES the explicit cwd, so a plan-state
// commit made from inside a lane worktree lands on the main repo's branch. They
// are stripped from every plan git spawn so the explicit cwd alone fixes the
// repo + branch. Everything else rides through untouched: GIT_CONFIG_GLOBAL /
// GIT_CONFIG_SYSTEM (committer identity, gpgsign, hooks) and PLANCTL_* /
// CLAUDE_CODE_SESSION_ID the conformance harness depends on.
const WORKTREE_ROUTING_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
] as const;

/** A snapshot of the live process env with the worktree-routing vars stripped.
 * Read at call time, so an in-process caller that reassigned process.env — the
 * bun:test harness installing the fixture's GIT_CONFIG_GLOBAL / committer
 * identity — is still reflected; only the cwd-overriding GIT_* vars are removed. */
function gitEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of WORKTREE_ROUTING_ENV) {
    delete env[key];
  }
  return env;
}

/** Run git with the sanitized process env (worktree-routing GIT_* stripped) and
 * an explicit cwd, so the cwd alone fixes the repo/branch. The env is passed
 * explicitly (not the default-snapshot inheritance) so an in-process caller that
 * reassigned process.env reaches git's config resolution. `input`, when given,
 * is fed to stdin (used for `commit -F -`). */
function runGit(args: string[], cwd: string, input?: string): GitResult {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    env: gitEnv(),
    ...(input !== undefined ? { stdin: Buffer.from(input) } : {}),
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/** Parse a `git status --porcelain` body (v1 or untracked-all): each line is
 * `XY <path>`, line[3:].trim() is the path, rename "a -> b" takes b. */
function parseStatusPaths(stdout: string, handleRename: boolean): string[] {
  const paths: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length < 4) {
      continue;
    }
    let rel = line.slice(3).trim();
    if (handleRename && rel.includes(" -> ")) {
      rel = rel.split(" -> ", 2)[1] as string;
    }
    if (rel) {
      paths.push(rel);
    }
  }
  return paths;
}

/** The production facade — verbatim `git` spawns. The byte-parity behavior the
 * compiled binary has always had; getVcs() returns this unless a test installs a
 * fake. */
export const realGitVcs: PlanVcs = {
  dirtyDataDirPaths(repoRoot, dataDirNames): Set<string> {
    const result = runGit(
      [
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        ...dataDirNames.map((name) => `${name}/`),
      ],
      repoRoot,
    );
    return new Set(parseStatusPaths(result.stdout, true));
  },

  currentHead(cwd): string {
    const result = runGit(["rev-parse", "HEAD"], cwd);
    return result.exitCode === 0 ? result.stdout.trim() : "unknown";
  },

  dirtyFilesForPathspecs(pathspecs, cwd) {
    const result = runGit(
      ["status", "--porcelain=v1", "--", ...pathspecs],
      cwd,
    );
    // The rename arrow is left alone here (atomic-rename .keeper/ writes show as
    // M, not R) — handleRename=false matches the prior dirtyFilesForPathspecs.
    return { ...result, files: parseStatusPaths(result.stdout, false) };
  },

  stage(files, cwd): GitResult {
    return runGit(["add", "--", ...files], cwd);
  },

  commit(msg, files, cwd) {
    const commitResult = runGit(
      ["commit", "-F", "-", "--", ...files],
      cwd,
      msg,
    );
    if (commitResult.exitCode !== 0) {
      return { ...commitResult, sha: "" };
    }
    const shaResult = runGit(["rev-parse", "HEAD"], cwd);
    return { ...commitResult, sha: shaResult.stdout.trim() };
  },

  restoreIndexToHead(paths, cwd): GitResult {
    return runGit(["reset", "-q", "HEAD", "--", ...paths], cwd);
  },

  gitBinaryPresent(): boolean {
    // A spawn that ENOENTs (no git binary on PATH) throws, caught by runReadGit
    // → exitCode 1 with the ENOENT message in stderr. A present binary returns
    // exit 0. Any non-ENOENT non-zero (impossible for `--version`) reads present.
    const probe = runReadGit(["--version"], ".");
    return probe.exitCode === 0;
  },

  isGitRepo(repo): boolean {
    let isDir = false;
    try {
      isDir = statSync(repo).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      return false;
    }
    return runReadGit(["rev-parse", "--git-dir"], repo).exitCode === 0;
  },

  hasHead(repo): boolean {
    return runReadGit(["rev-parse", "--verify", "HEAD"], repo).exitCode === 0;
  },

  resolveRef(ref, repo): string | null {
    // `--quiet` makes an absent ref exit non-zero with no output instead of a
    // fatal error, so a clean miss and a genuine failure both land here as a
    // non-zero exit → null (the HEAD-fallback signal), never a throw.
    const result = runReadGit(["rev-parse", "--verify", "--quiet", ref], repo);
    if (result.exitCode !== 0) {
      return null;
    }
    const sha = result.stdout.trim();
    return sha.length > 0 ? sha : null;
  },

  trailerCommitShas(taskId, repo, ref): string[] {
    // Stage 1: `git log [<ref>] --grep` fixed-string prefilter; non-zero exit → [].
    // The optional revision (the epic lane branch) precedes the options so an
    // omitted ref scans HEAD exactly as before.
    const grep = runReadGit(
      [
        "log",
        ...(ref !== undefined ? [ref] : []),
        `--grep=Task: ${taskId}`,
        "-F",
        "--pretty=format:%H",
      ],
      repo,
    );
    if (grep.exitCode !== 0) {
      return [];
    }
    const candidates = grep.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    // Stage 2: per candidate, confirm a REAL `Task:` trailer via interpret-trailers.
    const confirmed: string[] = [];
    for (const sha of candidates) {
      if (hasRealTrailerValue(sha, taskId, repo)) {
        confirmed.push(sha);
      }
    }
    return confirmed;
  },

  sourceCommitShas(taskId, repo): string[] {
    const fmt = `--format=%H${FIELD_SEP}%(trailers:key=Task,valueonly=true)`;
    const proc = runReadGit(["log", fmt], repo);
    if (proc.exitCode !== 0) {
      throw new Error(
        `git log failed in ${repo} (exit ${proc.exitCode}): ${proc.stderr.trim()}`,
      );
    }
    const shas: string[] = [];
    for (const record of proc.stdout.split("\n")) {
      if (!record.includes(FIELD_SEP)) {
        continue;
      }
      const sepIdx = record.indexOf(FIELD_SEP);
      const sha = record.slice(0, sepIdx).trim();
      const trailerBlob = record.slice(sepIdx + 1);
      if (!sha) {
        continue;
      }
      const values = trailerBlob.replace(/,/g, "\n").split("\n");
      if (values.some((v) => v.trim() === taskId)) {
        shas.push(sha);
      }
    }
    return shas;
  },

  commitNumstat(sha, repo): NumstatRow[] {
    return showNumstat(sha, repo).rows;
  },

  commitSetNumstat(shas, repo): NumstatTotals {
    const totals: NumstatTotals = {
      insertions: 0,
      deletions: 0,
      files: 0,
      error: false,
    };
    for (const sha of shas) {
      const { rows, ok } = showNumstat(sha, repo);
      if (!ok) {
        totals.error = true;
      }
      for (const row of rows) {
        totals.insertions += row.insertions;
        totals.deletions += row.deletions;
        totals.files += 1;
      }
    }
    return totals;
  },

  committedTaskJson(stateRepo, taskId, dataDirNames) {
    for (const dataDirName of dataDirNames) {
      const relpath = `${dataDirName}/tasks/${taskId}.json`;
      const proc = runReadGit(
        ["cat-file", "blob", `HEAD:${relpath}`],
        stateRepo,
      );
      if (proc.exitCode !== 0) {
        // Path not present in HEAD under this data dir — try the next.
        continue;
      }
      try {
        return JSON.parse(proc.stdout) as Record<string, unknown>;
      } catch (exc) {
        throw new Error(
          `HEAD:${relpath} is not valid JSON: ${(exc as Error).message}`,
        );
      }
    }
    return null;
  },

  shortStatusAndDiff(cwd): string {
    const parts: string[] = [];
    for (const argv of [
      ["status", "--short"],
      ["diff", "HEAD", "--stat"],
    ]) {
      try {
        const proc = Bun.spawnSync(["git", ...argv], { cwd, env: gitEnv() });
        const out = proc.stdout.toString().trim();
        if (out) {
          parts.push(out);
        }
      } catch {
        // git binary absent — skip this probe.
      }
    }
    return parts.join("\n");
  },

  firstSourceShaShort(taskId, cwd): string | null {
    try {
      const proc = Bun.spawnSync(
        [
          "git",
          "log",
          "-1",
          "--format=%h",
          `--grep=Task: ${taskId}`,
          "--fixed-strings",
        ],
        { cwd, env: gitEnv() },
      );
      if (proc.exitCode !== 0) {
        return null;
      }
      const sha = proc.stdout.toString().trim();
      return sha || null;
    } catch {
      return null;
    }
  },

  sessionDirtyPaths(cwd): string[] | null {
    // Fail-OPEN: runReadGit maps a missing binary / non-repo / spawn failure to
    // a non-zero exit, which becomes `null` (the visible marker) rather than a
    // false-clean []. handleRename=true keeps a moved on-hook file in the set.
    const result = runReadGit(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      cwd,
    );
    if (result.exitCode !== 0) {
      return null;
    }
    return parseStatusPaths(result.stdout, true);
  },

  inProgressOp(cwd): InProgressOp {
    // `-q --verify` exits non-zero silently on an absent ref, so exit 0 == that
    // pseudo-ref exists == that op is in flight. cwd fixes the STATE repo's git
    // dir (a linked worktree has its own MERGE_HEAD). Specific op first; the
    // sequencer todo is the fallback for the between-picks window.
    const headRef = (ref: string): boolean =>
      runReadGit(["rev-parse", "-q", "--verify", ref], cwd).exitCode === 0;
    if (headRef("MERGE_HEAD")) {
      return "merge";
    }
    if (headRef("CHERRY_PICK_HEAD")) {
      return "cherry-pick";
    }
    if (headRef("REVERT_HEAD")) {
      return "revert";
    }
    if (headRef("REBASE_HEAD")) {
      return "rebase";
    }
    // A cherry-pick / revert sequence with remaining picks but no `*_HEAD` set.
    // `--git-path` resolves sequencer/todo against this checkout's OWN git dir,
    // so a linked worktree reads its own sequencer, not the common dir's.
    const todo = runReadGit(
      ["rev-parse", "--path-format=absolute", "--git-path", "sequencer/todo"],
      cwd,
    );
    if (todo.exitCode === 0) {
      const path = todo.stdout.trim();
      if (path.length > 0 && sequencerTodoActive(path)) {
        return "sequencer";
      }
    }
    return "none";
  },

  commitWorkLockPath(cwd): string {
    const res = runReadGit(
      ["rev-parse", "--path-format=absolute", "--git-dir"],
      cwd,
    );
    const gitDir = res.stdout.trim();
    const dir =
      res.exitCode === 0 && gitDir.length > 0
        ? gitDir
        : joinGitPath(cwd, ".git");
    return joinGitPath(dir, "keeper-commit-work.lock");
  },
};

// %x1f (ASCII unit separator) field delimiter for sourceCommitShas — cannot
// appear in a sha or trailer value, so the split is unambiguous.
const FIELD_SEP = "\x1f";

/** Run a read-only git probe in `repo`, never throwing on a non-zero exit; a
 * missing git binary surfaces as a non-zero exit (Bun's spawn throws on ENOENT —
 * caught here). The sanitized env (worktree-routing GIT_* stripped) keeps `repo`
 * authoritative — an inherited GIT_DIR must not redirect a trailer / HEAD scan to
 * another worktree's branch. */
function runReadGit(args: string[], repo: string, input?: string): GitResult {
  try {
    const proc = Bun.spawnSync(["git", ...args], {
      cwd: repo,
      env: gitEnv(),
      ...(input !== undefined ? { stdin: Buffer.from(input) } : {}),
    });
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    };
  } catch (exc) {
    return { exitCode: 1, stdout: "", stderr: (exc as Error).message };
  }
}

/** True when the sequencer todo at `path` names at least one remaining pick — a
 * non-blank, non-comment line. git deletes the whole sequencer dir when a
 * cherry-pick / revert finishes, so a present, active todo means the sequence is
 * still in flight. Any read error reads as not-active (classify "none"). */
function sequencerTodoActive(path: string): boolean {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return false;
  }
  return content.split("\n").some((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("#");
  });
}

/** Join a git dir and a leaf, BYTE-MATCHING src/worktree-git.ts's `joinPath`
 * (the module boundary forbids importing it): strip a trailing slash on `dir`
 * (defensive — `--path-format=absolute` never emits one) then append under a
 * single separator, so {@link realGitVcs.commitWorkLockPath} derives the exact
 * file the daemon does for a checkout. */
function joinGitPath(dir: string, name: string): string {
  const base =
    dir.length > 1 && dir.endsWith("/") ? dir.replace(/\/+$/, "") : dir;
  return base.endsWith("/") ? `${base}${name}` : `${base}/${name}`;
}

/** Run `git show --numstat --format=` for one commit and parse its rows. The
 * empty `--format=` suppresses the commit header so stdout is numstat rows only;
 * each row is `<added>\t<deleted>\t<path>` (binary files show `-`/`-`, folding to
 * 0 lines but still one changed path). `ok` is false on a non-zero exit (missing
 * / rewritten / shallow sha) so a caller summing a set can flag the degrade. */
function showNumstat(
  sha: string,
  repo: string,
): { rows: NumstatRow[]; ok: boolean } {
  const proc = runReadGit(["show", "--numstat", "--format=", sha], repo);
  if (proc.exitCode !== 0) {
    return { rows: [], ok: false };
  }
  const rows: NumstatRow[] = [];
  for (const line of proc.stdout.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const parts = line.split("\t");
    if (parts.length < 3) {
      continue;
    }
    const addRaw = parts[0] as string;
    const delRaw = parts[1] as string;
    const path = parts.slice(2).join("\t");
    if (path === "") {
      continue;
    }
    rows.push({
      path,
      insertions: addRaw === "-" ? 0 : Number.parseInt(addRaw, 10) || 0,
      deletions: delRaw === "-" ? 0 : Number.parseInt(delRaw, 10) || 0,
    });
  }
  return { rows, ok: true };
}

/** Confirm a real `Task: <taskId>` trailer on `sha` via
 * `git log -1 --format=%B <sha>` piped to `git interpret-trailers --parse`,
 * exact-equality on the parsed value. Mirrors commit_lookup's _has_real_task_trailer
 * (the isTaskId gate is applied by the caller's candidate set / the seeding path).
 */
function hasRealTrailerValue(
  sha: string,
  taskId: string,
  repo: string,
): boolean {
  const body = runReadGit(["log", "-1", "--format=%B", sha], repo);
  if (body.exitCode !== 0) {
    return false;
  }
  const parsed = runReadGit(
    ["interpret-trailers", "--parse"],
    repo,
    body.stdout,
  );
  if (parsed.exitCode !== 0) {
    return false;
  }
  for (const rawLine of parsed.stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const sep = line.indexOf(":");
    if (sep < 0) {
      continue;
    }
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key === "Task" && value === taskId) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Installed-facade seam. Production never calls setVcs, so getVcs() returns the
// real facade; the test harness installs a fake and resets it on teardown.
// ---------------------------------------------------------------------------

let installed: PlanVcs = realGitVcs;

/** The currently installed facade. Defaults to realGitVcs; the test harness
 * swaps in a fake via setVcs. */
export function getVcs(): PlanVcs {
  return installed;
}

/** Install `vcs` as the active facade (tests only). */
export function setVcs(vcs: PlanVcs): void {
  installed = vcs;
}

/** Restore the real git facade (test teardown). */
export function resetVcs(): void {
  installed = realGitVcs;
}
