// Shared commit-set derivation for the per-task audit gate's two verbs
// (`audit gate-check` / `audit submit-task`, src/verbs/audit_gate_check.ts +
// src/verbs/audit_submit_task.ts). Both MUST derive the exact same
// CommitGroup[] for a task's current commit set — this is the hash-parity
// boundary computeCommitSetHash keys idempotency on: any drift between the two
// derivations breaks it in either direction (a perpetual re-audit, or a stale
// short-circuit that skips a genuinely new commit).
//
// Mirrors reconcile's ordered scan-repo set (target_repo — the worker's lane,
// KEEPER_PLAN_WORKTREE-aware — then every epic.touched_repos entry, then
// primary_repo, de-duplicated) and its trailer-authentic findSourceCommits
// scan. Deliberately NOT commit_lookup.ts's findCommitGroups: that helper's
// repo set starts from primary_repo (touched_repos tri-state) and never
// includes target_repo, so it would miss a still-unmerged worktree-lane commit
// reconcile itself would see — the audit gate must agree with reconcile on what
// counts as "the task's current commits".

import { existsSync, realpathSync } from "node:fs";
import { join, resolve as resolveAbs } from "node:path";

import type { CommitGroup } from "./audit_artifacts.ts";
import { epicIdFromTask } from "./ids.ts";
import { normalizeTask } from "./models.ts";
import { resolveWorkerRepos } from "./runtime_status.ts";
import { loadJson, loadJsonSafe } from "./store.ts";
import { getVcs } from "./vcs.ts";
import { findSourceCommits, GitError } from "./verbs/reconcile.ts";

export { GitError };

/** realpath(p), falling back to the absolute path when it can't be resolved —
 * byte-identical to reconcile's private helper of the same contract. */
function realpathOr(p: string): string {
  const abs = resolveAbs(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function expandUser(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    const home = process.env.HOME ?? "";
    return home + p.slice(1);
  }
  return p;
}

export interface TaskCommitScan {
  epicId: string;
  commitGroups: CommitGroup[];
}

/** Ordered, de-duplicated scan-repo set for `taskId`: target_repo, then every
 * epic.touched_repos entry, then primary_repo. Byte-identical construction to
 * reconcile's inline scan-repo set so a task's covering commit set never
 * depends on which of the two callers computed it. */
function resolveScanRepos(
  taskDef: Record<string, unknown>,
  epicDef: Record<string, unknown>,
  primaryRepo: string,
): string[] {
  const { targetRepo } = resolveWorkerRepos(taskDef, epicDef, primaryRepo);
  const scanRepos: string[] = [targetRepo];
  for (const entry of (epicDef.touched_repos as unknown[] | null | undefined) ??
    []) {
    if (typeof entry === "string" && entry) {
      scanRepos.push(realpathOr(expandUser(entry)));
    }
  }
  scanRepos.push(primaryRepo);
  const seen = new Set<string>();
  return scanRepos.filter((r) => {
    if (seen.has(r)) {
      return false;
    }
    seen.add(r);
    return true;
  });
}

/** Derive `taskId`'s CURRENT commit set as `{epicId, commitGroups}` — the ONE
 * seam both `audit gate-check` and `audit submit-task` call, so their hashes
 * can never drift apart. `dataDir` / `primaryRepo` are the caller's already
 * state-resolved `ProjectContext` fields (`resolvePlanStateContext`'s
 * `dataDir` / `projectPath`). Fail-closed: propagates `GitError` (an absent
 * git binary, or any unexpected git failure) rather than returning a
 * fabricated empty set — callers surface it as a typed tooling error, never a
 * clean/not-covering envelope. A repo scanning zero source commits is simply
 * omitted from `commitGroups` (an empty-shas group would otherwise pollute the
 * hash with noise for repos this task never touched). */
export function deriveTaskCommitGroups(
  taskId: string,
  dataDir: string,
  primaryRepo: string,
): TaskCommitScan {
  const epicId = epicIdFromTask(taskId);
  const taskDef = normalizeTask(
    loadJson(join(dataDir, "tasks", `${taskId}.json`)),
  );
  const epicPath = join(dataDir, "epics", `${epicId}.json`);
  const epicDef = existsSync(epicPath) ? (loadJsonSafe(epicPath) ?? {}) : {};

  const scanRepos = resolveScanRepos(taskDef, epicDef, primaryRepo);
  const commitGroups: CommitGroup[] = [];
  for (const repo of scanRepos) {
    const shas = findSourceCommits(taskId, repo);
    if (shas.length > 0) {
      commitGroups.push({ repo, shas });
    }
  }
  return { epicId, commitGroups };
}

/** `taskId`'s OWN Task-trailed source commit shas in its RESOLVED target repo
 * ONLY (target+lane-aware, the reconcile seam) — the flat list `done` unions into
 * evidence so a normal worker close-out records its landing sha without any
 * --evidence. Constrained to the single target repo by construction: close later
 * validates every recorded sha against THAT repo's composed base, so a flat
 * evidence list can never carry a commit close would then test against the wrong
 * repo (a task committing outside its own target repo is a one-task/one-repo
 * contract violation, intentionally not recorded here). Fail-closed: an absent
 * git binary, an UNEXPECTED git failure, AND a target that is not a readable git
 * worktree all raise GitError — so a [] result means PROVEN-empty (a readable
 * worktree with no Task commits), never an UNKNOWN one. The caller decides whether
 * to surface or best-effort skip the GitError. */
export function deriveTaskTargetRepoCommits(
  taskId: string,
  dataDir: string,
  primaryRepo: string,
): string[] {
  const epicId = epicIdFromTask(taskId);
  const taskDef = normalizeTask(
    loadJson(join(dataDir, "tasks", `${taskId}.json`)),
  );
  const epicPath = join(dataDir, "epics", `${epicId}.json`);
  const epicDef = existsSync(epicPath) ? (loadJsonSafe(epicPath) ?? {}) : {};
  const { targetRepo } = resolveWorkerRepos(taskDef, epicDef, primaryRepo);
  // Positive git-repo proof BEFORE trusting an empty scan: findSourceCommits
  // returns [] for a non-git / missing repo (its fail-open contract for the
  // multi-repo audit callers), which would read PROVEN-empty when the target is
  // actually UNKNOWN. The done empty-evidence gate requires a proven-empty set, so
  // demand the single target be a readable git worktree here — else a typed
  // GitError the caller maps to scan_unverifiable. A born-or-unborn readable
  // worktree with no Task commits stays a legitimate proven-empty [].
  if (!getVcs().isGitRepo(targetRepo)) {
    throw new GitError(
      `target repo is not a readable git worktree: ${targetRepo}`,
    );
  }
  return findSourceCommits(taskId, targetRepo);
}
