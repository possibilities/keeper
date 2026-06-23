// The git facade seam for plan-state persistence. Every git operation the
// auto-commit machinery performs — the dirty-path discovery buildPlanInvocation
// runs (`git status` over the data dirs), and the status/stage/commit the
// auto-commit itself runs — routes through the single PlanVcs installed here.
//
// Production installs nothing: getVcs() returns realGitVcs, the verbatim
// Bun.spawnSync(["git", ...]) implementation, so the binary's behavior is
// untouched. The bun:test harness installs a fake facade (setVcs) that records
// commits + diffs the .keeper/ tree against a snapshot, so the default test tier
// spawns zero real git. resetVcs() restores the real facade.
//
// The interface is the minimal surface the two production call sites need:
//  - dirtyDataDirPaths: invocation.ts's pre-commit dirty discovery (status over
//    the data dirs, untracked-files=all),
//  - currentHead / dirtyFilesForPathspecs / stage / commit: commit.ts's
//    auto-commit plumbing (the real implementation surfaces the contention
//    stderr the retry loop matches, so the fake can simulate it too).

/** Result of a git invocation the auto-commit plumbing inspects: exit code plus
 * decoded stdout/stderr. The contention-retry loop matches stderr substrings, so
 * the fake must be able to return a non-zero exit with a chosen stderr. */
export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
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
}

// ---------------------------------------------------------------------------
// Real implementation — the verbatim git plumbing. Production default.
// ---------------------------------------------------------------------------

/** Run git with the live process env and an explicit cwd. The env is passed
 * explicitly (not the default-snapshot inheritance) so an in-process caller that
 * reassigned process.env — the bun:test harness installing the fixture's
 * GIT_CONFIG_GLOBAL / committer identity — reaches git's config resolution.
 * `input`, when given, is fed to stdin (used for `commit -F -`). */
function runGit(args: string[], cwd: string, input?: string): GitResult {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    env: process.env,
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
};

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
