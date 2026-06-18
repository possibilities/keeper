// Native in-process trailer scan — the byte-parity port of
// planctl/commit_lookup.py. A shared, verb-agnostic helper (sits alongside
// commit.ts / ids.ts, not a verb): findCommitGroups performs the
// `git log --grep` + `git interpret-trailers --parse` archaeology over an epic's
// resolved repo set and returns the grouped commit set find-task-commit flattens.
//
// I/O-pure by contract: it RETURNS data or THROWS a typed exception
// (AllReposBrokenError) — never emits, commits, or exits. The two-stage match
// per scanned repo:
//
//   1. `git log --grep="Task: <task_id>" -F --pretty=format:%H` — `-F` is a
//      fixed-string match (no regex), so anchors are omitted; a loose prefilter.
//   2. Per candidate sha, `git log -1 --format=%B <sha>` piped via stdin to
//      `git interpret-trailers --parse` confirms a REAL `Task:` trailer whose
//      value equals <task_id> AND passes isTaskId — dropping prose false-matches.
//
// A clean miss is a normal empty result. AllReposBrokenError is raised ONLY when
// EVERY listed repo is missing / not a git repo; a single broken repo emits a
// stderr note and the scan continues. An empty resolved scan set
// (touched_repos === []) returns [] and never raises.

import { realpathSync, statSync } from "node:fs";
import { resolve as resolveAbs } from "node:path";

import { isTaskId } from "./ids.ts";

/** Raised when every repo in the resolved scan set is missing or not a git repo.
 * Carries the broken repo paths so the calling verb can surface them in its
 * error envelope (details.broken_repos). A scan set with even one usable repo
 * never raises; an empty resolved set is NOT broken (it returns []). Mirrors
 * AllReposBrokenError. */
export class AllReposBrokenError extends Error {
  readonly brokenRepos: string[];

  constructor(brokenRepos: string[]) {
    super(
      `all repos in the scan set are missing or not git repos: ${brokenRepos.join(", ")}`,
    );
    this.name = "AllReposBrokenError";
    this.brokenRepos = brokenRepos;
  }
}

/** Absolutize + symlink-resolve, falling back to the lexical absolute path when
 * the target does not exist (Path(p).resolve() semantics; realpathSync resolves
 * symlinks, load-bearing on macOS /var -> /private/var). */
function resolvePath(p: string): string {
  const abs = resolveAbs(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** Run git in `repo`, never throwing on a non-zero exit. `input`, when given, is
 * fed to stdin (used for `interpret-trailers --parse`). Returns exit code +
 * decoded stdout. A missing git binary surfaces as a non-zero exit (Bun's spawn
 * throws on ENOENT — caught and reported as failure), mirroring the Python
 * helpers' check=False + errors="replace" tolerance for the lookup paths. */
function runGit(
  args: string[],
  repo: string,
  input?: string,
): { exitCode: number; stdout: string } {
  try {
    const proc = Bun.spawnSync(["git", ...args], {
      cwd: repo,
      ...(input !== undefined ? { stdin: Buffer.from(input) } : {}),
    });
    return { exitCode: proc.exitCode, stdout: proc.stdout.toString() };
  } catch {
    return { exitCode: 1, stdout: "" };
  }
}

/** Resolve the repo set from the touched_repos tri-state:
 *   - null / undefined → [primaryRepo] (legacy / single-repo epic),
 *   - []               → [] (human set "scan nothing"; not collapsed to primary),
 *   - non-empty list   → each entry resolved to an absolute path.
 * Mirrors _resolve_repo_set. primaryRepo arrives already resolved. */
function resolveRepoSet(
  primaryRepo: string,
  touchedRepos: string[] | null | undefined,
): string[] {
  if (touchedRepos === null || touchedRepos === undefined) {
    return [resolvePath(primaryRepo)];
  }
  return touchedRepos.map((r) => resolvePath(r));
}

/** True iff `repo` is an existing dir containing a git repo. Mirrors
 * _is_git_repo: a non-dir is false; otherwise `git rev-parse --git-dir` exit 0. */
function isGitRepo(repo: string): boolean {
  let isDir = false;
  try {
    isDir = statSync(repo).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return false;
  }
  return runGit(["rev-parse", "--git-dir"], repo).exitCode === 0;
}

/** `git log --grep` prefilter (fixed-string). Returns candidate shas. `-F`
 * disables regex, so no anchors. A non-zero exit (e.g. unborn branch) yields []
 * — confirmation is the post-filter's job. Mirrors _grep_candidates. */
function grepCandidates(taskId: string, repo: string): string[] {
  const result = runGit(
    ["log", `--grep=Task: ${taskId}`, "-F", "--pretty=format:%H"],
    repo,
  );
  if (result.exitCode !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Parse `sha`'s trailers into {key: [value, ...]} (multi-valued). Two git calls:
 * `git log -1 --format=%B <sha>` for the raw body, piped to
 * `git interpret-trailers --parse` (strips prose, leaving real `Key: value`
 * trailer lines). Returns {} when either call exits non-zero or the parse output
 * is empty. Each output line is partitioned on the FIRST ":" (so a colon in the
 * value survives); both sides stripped; lines without ":" or with an empty key
 * are skipped. Mirrors _load_trailers. */
function loadTrailers(sha: string, repo: string): Map<string, string[]> {
  const body = runGit(["log", "-1", "--format=%B", sha], repo);
  if (body.exitCode !== 0) {
    return new Map();
  }
  const parsed = runGit(["interpret-trailers", "--parse"], repo, body.stdout);
  if (parsed.exitCode !== 0) {
    return new Map();
  }

  const trailers = new Map<string, string[]>();
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
    if (!key) {
      continue;
    }
    const existing = trailers.get(key);
    if (existing) {
      existing.push(value);
    } else {
      trailers.set(key, [value]);
    }
  }
  return trailers;
}

/** Confirm a real `Task: <taskId>` trailer on `sha`. True iff some value in the
 * commit's `Task:` trailer list equals taskId AND passes isTaskId (the gate
 * drops a garbage trailer value before the membership test). Mirrors
 * _has_real_task_trailer. */
function hasRealTaskTrailer(
  sha: string,
  taskId: string,
  repo: string,
): boolean {
  const trailers = loadTrailers(sha, repo);
  for (const value of trailers.get("Task") ?? []) {
    if (value === taskId && isTaskId(value)) {
      return true;
    }
  }
  return false;
}

/** A grouped commit set: {repo: <abs-path>, shas: [<%H>, ...]}. */
export interface CommitGroupResult {
  repo: string;
  shas: string[];
}

/** Find the source commits for `taskIds` grouped by repo. Scans the repo set
 * resolved from the touched_repos tri-state (repo-outer, task-inner) for commits
 * carrying a confirmed `Task: <task_id>` trailer; returns
 * [{repo, shas}, ...] in repo-outer first-seen order (= touched_repos order).
 * Shas are deduped within a repo group; full %H. A clean miss is an empty result.
 * Throws AllReposBrokenError only when EVERY resolved repo is missing or not a
 * git repo; a single broken entry is skipped with a stderr note; an empty
 * resolved set returns [] and never throws. Mirrors find_commit_groups. */
export function findCommitGroups(
  taskIds: string[],
  primaryRepo: string,
  touchedRepos: string[] | null | undefined,
): CommitGroupResult[] {
  const repos = resolveRepoSet(primaryRepo, touchedRepos);
  if (repos.length === 0) {
    return [];
  }

  // Defense-in-depth: reject any malformed task id before building argv.
  const validTaskIds = taskIds.filter((tid) => isTaskId(tid));

  const grouped = new Map<string, string[]>();
  const order: string[] = [];
  const broken: string[] = [];
  let anyUsable = false;

  for (const repo of repos) {
    if (!isGitRepo(repo)) {
      process.stderr.write(
        `planctl.commit_lookup: skipping missing or non-git repo: ${repo}\n`,
      );
      broken.push(repo);
      continue;
    }
    anyUsable = true;
    for (const taskId of validTaskIds) {
      for (const sha of grepCandidates(taskId, repo)) {
        if (!hasRealTaskTrailer(sha, taskId, repo)) {
          continue;
        }
        let shas = grouped.get(repo);
        if (shas === undefined) {
          shas = [];
          grouped.set(repo, shas);
          order.push(repo);
        }
        if (!shas.includes(sha)) {
          shas.push(sha);
        }
      }
    }
  }

  if (!anyUsable) {
    throw new AllReposBrokenError(broken);
  }

  return order.map((repo) => ({ repo, shas: grouped.get(repo) as string[] }));
}
