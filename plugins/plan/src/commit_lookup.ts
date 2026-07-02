// Native in-process trailer scan — the byte-parity port of
// planctl/commit_lookup.py. A shared, verb-agnostic helper (sits alongside
// commit.ts / ids.ts, not a verb): findCommitGroups runs the trailer archaeology
// over an epic's resolved repo set and returns the grouped commit set
// find-task-commit flattens.
//
// The git boundary routes through the PlanVcs facade (src/vcs.ts): the repo-shape
// gate (`vcs.isGitRepo`) and the confirmed-trailer scan (`vcs.trailerCommitShas`,
// the `git log --grep` prefilter + `git interpret-trailers --parse` confirmation).
// Production runs verbatim git via realGitVcs; the test harness installs a fake.
//
// I/O-pure by contract: findCommitGroups RETURNS data or THROWS a typed exception
// (AllReposBrokenError) — never emits, commits, or exits. A clean miss is a normal
// empty result. AllReposBrokenError is raised ONLY when EVERY listed repo is
// missing / not a git repo; a single broken repo emits a stderr note and the scan
// continues. An empty resolved scan set (touched_repos === []) returns [] and
// never raises.

import { realpathSync } from "node:fs";
import { resolve as resolveAbs } from "node:path";

import { isTaskId } from "./ids.ts";
import { getVcs } from "./vcs.ts";

/** The keeper worktree lane base-branch prefix, re-derived LOCALLY here — the
 * plan plugin never imports src/worktree-git.ts (its KEEPER_EPIC_BRANCH_PREFIX)
 * to stay decoupled from the daemon internals. A parity test pins this literal to
 * keeper's constant, so a rename there fails loudly rather than silently
 * reintroducing the lane-blind close halt. */
export const KEEPER_EPIC_BRANCH_PREFIX = "keeper/epic/";

/** The deterministic epic lane base branch — `keeper/epic/<epic_id>` — checked
 * out by every worktree lane of the epic (identical in the primary AND every
 * secondary repo: reconcile derives it from the epic id alone, never the repo). */
export function laneBranchFor(epicId: string): string {
  return `${KEEPER_EPIC_BRANCH_PREFIX}${epicId}`;
}

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
 * resolved set returns [] and never throws. Mirrors find_commit_groups.
 *
 * `epicId`, when given (the epic-close callers — close-preflight/close-finalize),
 * makes the scan lane-aware: each repo is first probed for the deterministic lane
 * branch `keeper/epic/<epic_id>` (visible in the primary checkout's shared ref
 * store even before the lane merges to default). Present → scan that ref so
 * lane-ONLY commits appear; absent (or a probe failure) → scan HEAD exactly as
 * today, so a repo is never dropped, single-repo/non-worktree closes are
 * byte-identical, and a post-finalize re-run self-heals (lane pruned → HEAD
 * reaches the merged commits). Omitted (find-task-commit) → always HEAD. */
export function findCommitGroups(
  taskIds: string[],
  primaryRepo: string,
  touchedRepos: string[] | null | undefined,
  epicId?: string | null,
): CommitGroupResult[] {
  const repos = resolveRepoSet(primaryRepo, touchedRepos);
  if (repos.length === 0) {
    return [];
  }

  // Defense-in-depth: reject any malformed task id before building argv.
  const validTaskIds = taskIds.filter((tid) => isTaskId(tid));

  const vcs = getVcs();
  const laneRef = epicId ? laneBranchFor(epicId) : null;
  const grouped = new Map<string, string[]>();
  const order: string[] = [];
  const broken: string[] = [];
  let anyUsable = false;

  for (const repo of repos) {
    if (!vcs.isGitRepo(repo)) {
      process.stderr.write(
        `planctl.commit_lookup: skipping missing or non-git repo: ${repo}\n`,
      );
      broken.push(repo);
      continue;
    }
    anyUsable = true;
    // Lane probe (epic close only): scan the lane branch when it resolves in THIS
    // repo, else fall back to HEAD (undefined ref). Probed once per repo — the
    // lane ref may be present in the primary and absent in a secondary.
    const scanRef =
      laneRef !== null && vcs.resolveRef(laneRef, repo) !== null
        ? laneRef
        : undefined;
    for (const taskId of validTaskIds) {
      for (const sha of vcs.trailerCommitShas(taskId, repo, scanRef)) {
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
