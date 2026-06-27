// reconcile verb — the port of planctl/run_reconcile.py. The keystone of the
// content-blind /plan:work orchestrator's post-worker phase: ONE read-only call
// collapsing planctl show + source-commit forensics + HEAD-visibility + epic
// tally into a single typed verdict the orchestrator switches on. The symmetric
// bookend to claim's pre-worker brief.
//
// The verdict is computed entirely from planctl-native data — no keeper
// shell-out, no mutation, no commit. Source-commit detection is trailer-authentic
// (the OTHER technique vs commit_lookup): the facade's `git log
// --format=%H%x1f%(trailers:key=Task,valueonly=true)` with exact-equality split
// on the unit separator, killing both the prose false-match and the fn-5.1/fn-5.10
// substring collision. state_head_visible reads the committed blob against
// state_repo (a DISTINCT cwd). The git boundary routes through the PlanVcs facade
// (src/vcs.ts). _GitError fail-closed: ANY unexpected git failure → tooling_error
// verdict, never a clean one.

import { existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve as resolveAbs } from "node:path";

import { findProjectsWithTask } from "../discovery.ts";
import { emitReadonly } from "../emit.ts";
import { formatOutput, type OutputFormat } from "../format.ts";
import { epicIdFromTask, isTaskId } from "../ids.ts";
import { buildPlanInvocationReadonly } from "../invocation.ts";
import { mergeTaskState, normalizeTask } from "../models.ts";
import { contextForRoot, type ProjectContext } from "../project.ts";
import { resolveWorkerRepos } from "../runtime_status.ts";
import { DATA_DIR_NAMES, hasDataDir } from "../state_path.ts";
import {
  LocalFileStateStore,
  loadJson,
  loadJsonSafe,
  nowIso,
} from "../store.ts";
import { getVcs } from "../vcs.ts";

/** The seven post-worker verdicts the orchestrator switches on. Every member
 * MUST have an orchestrator handler — the exhaustiveness test pins it. Mirrors
 * the Verdict enum. */
export const VERDICTS = {
  DONE: "done",
  IN_PROGRESS_COMMITTED: "in_progress_committed",
  IN_PROGRESS_UNCOMMITTED: "in_progress_uncommitted",
  BLOCKED: "blocked",
  STATE_UNCOMMITTED: "state_uncommitted",
  NOT_STARTED: "not_started",
  TOOLING_ERROR: "tooling_error",
} as const;

export type Verdict = (typeof VERDICTS)[keyof typeof VERDICTS];

/** A git subprocess failed unexpectedly — the fail-closed signal. Mirrors
 * _GitError. */
export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

/** Emit a typed reconcile error envelope and exit 1. Shape
 * {success:false, error:{code,message,details?}} — no plan_invocation line.
 * Mirrors _emit_reconcile_error. */
function emitReconcileError(
  code: string,
  message: string,
  format: OutputFormat | null,
  details?: Record<string, unknown>,
): never {
  const error: Record<string, unknown> = { code, message };
  if (details !== undefined) {
    error.details = details;
  }
  formatOutput({ success: false, error }, format);
  process.exit(1);
}

/** Resolve the owning project for `taskId` cwd-agnostically. Any same-id
 * collision surfaces as AMBIGUOUS_TASK_ID; --project is the escape hatch.
 * Mirrors _resolve_project_for_task. */
function resolveProjectForTask(
  taskId: string,
  project: string | null,
  format: OutputFormat | null,
): ProjectContext {
  if (project !== null) {
    const projectRoot = realpathOr(resolveAbs(expandUser(project)));
    if (!hasDataDir(projectRoot)) {
      emitReconcileError(
        "NOT_A_PROJECT",
        `No plan project found at ${projectRoot}. Run 'keeper plan init' first.`,
        format,
      );
    }
    const ctx = contextForRoot(projectRoot);
    if (!existsSync(join(ctx.dataDir, "tasks", `${taskId}.json`))) {
      emitReconcileError(
        "TASK_NOT_FOUND",
        `Task not found in ${projectRoot}: ${taskId}`,
        format,
      );
    }
    return ctx;
  }

  const matches = findProjectsWithTask(taskId);
  if (matches.length === 0) {
    emitReconcileError("TASK_NOT_FOUND", `Task not found: ${taskId}`, format);
  }
  if (matches.length === 1) {
    return contextForRoot(matches[0] as string);
  }
  emitReconcileError(
    "AMBIGUOUS_TASK_ID",
    `Task ${taskId} exists in multiple projects; pass --project <path>.`,
    format,
    { candidates: matches },
  );
}

// ---------------------------------------------------------------------------
// git helpers — fail-closed. Any unexpected git failure throws GitError so the
// verb collapses to a `tooling_error` verdict. The git boundary routes through
// the PlanVcs facade (src/vcs.ts): production runs verbatim git, the test
// harness installs a fake.
// ---------------------------------------------------------------------------

/** Return shas in `repo` carrying a trailer-authentic `Task: <taskId>` via the
 * facade's %(trailers:valueonly) unit-sep scan. Returns [] when not a git work
 * tree or no born HEAD; an absent git binary or any OTHER git failure throws
 * GitError (fail closed). Mirrors _find_source_commits. */
export function findSourceCommits(taskId: string, repo: string): string[] {
  const vcs = getVcs();
  if (!vcs.gitBinaryPresent()) {
    // An absent git binary collapses isGitRepo to false indistinguishably from a
    // genuine not-a-work-tree. The fail-closed contract requires the absent-binary
    // case surface as tooling_error, never a clean empty verdict — only "git
    // present, not a work tree" stays a clean [].
    throw new GitError(`git binary not available for source scan in ${repo}`);
  }
  if (!vcs.isGitRepo(repo)) {
    return [];
  }
  if (!vcs.hasHead(repo)) {
    return [];
  }
  try {
    return vcs.sourceCommitShas(taskId, repo);
  } catch (exc) {
    throw new GitError((exc as Error).message);
  }
}

/** True when the committed HEAD:<task.json> carries worker_done_at. Reads the
 * committed blob against `stateRepo` (NOT target_repo, NOT cwd) under the
 * `.keeper/` data dir via the facade. Guards the unborn-branch case first.
 * Returns false (not a tooling error) when the repo is unborn or the path isn't
 * in HEAD under the data dir; throws GitError on any other failure.
 * Mirrors _state_head_visible. */
export function stateHeadVisible(stateRepo: string, taskId: string): boolean {
  if (!isDir(stateRepo)) {
    throw new GitError(`state_repo is not a directory: ${stateRepo}`);
  }
  const vcs = getVcs();
  if (!vcs.isGitRepo(stateRepo)) {
    throw new GitError(`state_repo is not a git work tree: ${stateRepo}`);
  }
  if (!vcs.hasHead(stateRepo)) {
    // Unborn branch — nothing committed yet. Distinct signal, not an error.
    return false;
  }
  let committed: Record<string, unknown> | null;
  try {
    committed = vcs.committedTaskJson(stateRepo, taskId, DATA_DIR_NAMES);
  } catch (exc) {
    throw new GitError((exc as Error).message);
  }
  if (committed === null) {
    // Committed JSON not yet visible under any data dir.
    return false;
  }
  return Boolean(committed.worker_done_at);
}

/** Return {done, total} for `epicId`'s tasks — REPORTING ONLY (not a verdict
 * input). Filters tasks/ to this epic's tasks and reuses the mergeTaskState
 * tally. Degrades to {done:0, total:0} if the tasks dir is missing. Mirrors
 * _epic_progress. */
function epicProgress(
  dataDir: string,
  epicId: string,
  stateStore: LocalFileStateStore,
): { done: number; total: number } {
  const tasksDir = join(dataDir, "tasks");
  let done = 0;
  let total = 0;
  let entries: string[];
  try {
    entries = require("node:fs")
      .readdirSync(tasksDir)
      .filter((n: string) => n.endsWith(".json"));
  } catch {
    return { done: 0, total: 0 };
  }
  for (const name of entries) {
    const taskDef = loadJsonSafe(join(tasksDir, name));
    if (!taskDef) {
      continue;
    }
    const tid =
      (taskDef.id as string | undefined) ?? name.replace(/\.json$/, "");
    let owningEpic: string;
    try {
      owningEpic = epicIdFromTask(tid);
    } catch {
      continue;
    }
    if (owningEpic !== epicId) {
      continue;
    }
    const runtime = stateStore.loadRuntime(tid);
    const merged = mergeTaskState(taskDef, runtime);
    total += 1;
    if (merged.status === "done") {
      done += 1;
    }
  }
  return { done, total };
}

/** Map (status, git signals) → Verdict per the truth table. Pure over
 * already-collected signals so the exhaustiveness test can drive it directly.
 * Mirrors _compute_verdict. */
export function computeVerdict(
  status: string,
  opts: { hasSourceCommit: boolean; stateHeadVisible: boolean },
): Verdict {
  if (status === "done") {
    return opts.stateHeadVisible ? VERDICTS.DONE : VERDICTS.STATE_UNCOMMITTED;
  }
  if (status === "in_progress") {
    return opts.hasSourceCommit
      ? VERDICTS.IN_PROGRESS_COMMITTED
      : VERDICTS.IN_PROGRESS_UNCOMMITTED;
  }
  if (status === "blocked") {
    return VERDICTS.BLOCKED;
  }
  // status === "todo" (or any unexpected literal) → not started.
  return VERDICTS.NOT_STARTED;
}

export function runReconcile(opts: {
  taskId: string;
  project: string | null;
  format: OutputFormat | null;
  // Injectable for the fail-closed test: a hook that replaces the
  // stateHeadVisible probe (the Python test monkeypatches _state_head_visible).
  stateHeadVisibleFn?: (stateRepo: string, taskId: string) => boolean;
}): void {
  const { taskId, project, format } = opts;
  const stateHeadVisibleImpl = opts.stateHeadVisibleFn ?? stateHeadVisible;

  // 1. validate id
  if (!isTaskId(taskId)) {
    emitReconcileError("BAD_TASK_ID", `Invalid task ID: ${taskId}`, format);
  }

  // 2. resolve owning project cwd-agnostically (roots discovery or --project)
  const ctx = resolveProjectForTask(taskId, project, format);
  const dataDir = ctx.dataDir;

  const taskPath = join(dataDir, "tasks", `${taskId}.json`);
  const taskDef = normalizeTask(loadJson(taskPath));

  const epicId = epicIdFromTask(taskId);
  const epicPath = join(dataDir, "epics", `${epicId}.json`);
  const epicDef = existsSync(epicPath) ? loadJson(epicPath) : {};

  // 3. merged runtime status (definition + state-dir overlay).
  const stateStore = new LocalFileStateStore(ctx.stateDir);
  const runtime = stateStore.loadRuntime(taskId);
  const merged = mergeTaskState(taskDef, runtime);
  const status = (merged.status as string | undefined) ?? "todo";
  const blockedReason =
    status === "blocked" ? (merged.blocked_reason ?? null) : null;

  // 4. resolve repos. SOURCE scan runs against target_repo + touched_repos;
  //    state cat-file runs against state_repo — a DISTINCT cwd.
  // target_repo follows the worker's lane (KEEPER_PLAN_WORKTREE override-aware);
  // primary_repo / state_repo ALWAYS stay in the primary repo, never the lane —
  // both via the one runtime seam.
  const projPath = ctx.projectPath;
  const { targetRepo, primaryRepo } = resolveWorkerRepos(
    taskDef,
    epicDef,
    projPath,
  );
  const stateRepo = primaryRepo;

  // Source-scan repo set: target_repo, then every touched_repos entry, then
  // primary_repo — de-duplicated, order-preserving (realpath-normalized).
  const scanRepos: string[] = [targetRepo];
  for (const entry of (epicDef.touched_repos as unknown[] | null | undefined) ??
    []) {
    if (typeof entry === "string" && entry) {
      scanRepos.push(realpathOr(expandUser(entry)));
    }
  }
  scanRepos.push(primaryRepo);
  const seen = new Set<string>();
  const orderedScanRepos = scanRepos.filter((r) => {
    if (seen.has(r)) {
      return false;
    }
    seen.add(r);
    return true;
  });

  // 5. collect git signals — fail closed to `tooling_error` on any git error.
  const sourceCommits: { sha: string; repo: string }[] = [];
  let verdict: Verdict;
  let headVisible: boolean;
  try {
    for (const repo of orderedScanRepos) {
      for (const sha of findSourceCommits(taskId, repo)) {
        sourceCommits.push({ sha, repo });
      }
    }
    headVisible = stateHeadVisibleImpl(stateRepo, taskId);
    verdict = computeVerdict(status, {
      hasSourceCommit: sourceCommits.length > 0,
      stateHeadVisible: headVisible,
    });
  } catch (exc) {
    if (!(exc instanceof GitError)) {
      throw exc;
    }
    // Fail closed: never a clean verdict on a git failure.
    verdict = VERDICTS.TOOLING_ERROR;
    headVisible = false;
  }

  // 6. epic progress — reporting only, never a verdict input. Degrade gracefully.
  const progress = epicProgress(dataDir, epicId, stateStore);

  const pc = buildPlanInvocationReadonly("reconcile", projPath, taskId);
  emitReadonly(
    {
      verdict,
      task_id: taskId,
      epic_id: epicId,
      status,
      source_commits: sourceCommits,
      state_head_visible: headVisible,
      epic_progress: progress,
      assessed_at: nowIso(),
      blocked_reason: blockedReason,
    },
    pc,
  );
}

/** realpath(p), falling back to the absolute path when it can't be resolved. */
function realpathOr(p: string): string {
  const abs = resolveAbs(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function expandUser(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    const home = process.env.HOME ?? "";
    return home + p.slice(1);
  }
  return p;
}
