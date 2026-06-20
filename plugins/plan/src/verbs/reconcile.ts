// reconcile verb — the port of planctl/run_reconcile.py. The keystone of the
// content-blind /plan:work orchestrator's post-worker phase: ONE read-only call
// collapsing planctl show + source-commit forensics + HEAD-visibility + epic
// tally into a single typed verdict the orchestrator switches on. The symmetric
// bookend to claim's pre-worker brief.
//
// The verdict is computed entirely from planctl-native data — no keeper
// shell-out, no mutation, no commit. Source-commit detection is trailer-authentic
// (the OTHER technique vs commit_lookup): `git log --format=%H%x1f%(trailers:
// key=Task,valueonly=true)` with exact-equality split on the unit separator,
// killing both the prose false-match and the fn-5.1/fn-5.10 substring collision.
// state_head_visible cat-files against state_repo (a DISTINCT cwd). _GitError
// fail-closed: ANY unexpected git failure → tooling_error verdict, never a clean
// one.

import { existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve as resolveAbs } from "node:path";

import { findProjectsWithTask } from "../discovery.ts";
import { emitReadonly } from "../emit.ts";
import { formatOutput, type OutputFormat } from "../format.ts";
import { epicIdFromTask, isTaskId } from "../ids.ts";
import { buildPlanctlInvocationReadonly } from "../invocation.ts";
import { mergeTaskState, normalizeTask } from "../models.ts";
import { contextForRoot, type ProjectContext } from "../project.ts";
import { expectedWorkerCwd } from "../runtime_status.ts";
import { DATA_DIR_NAMES, hasDataDir } from "../state_path.ts";
import {
  LocalFileStateStore,
  loadJson,
  loadJsonSafe,
  nowIso,
} from "../store.ts";

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

// %x1f (ASCII unit separator) is the per-record field delimiter — it cannot
// appear in a sha or a trailer value, so the split is unambiguous even when a
// trailer value itself contains commas or spaces.
const FIELD_SEP = "\x1f";

/** Emit a typed reconcile error envelope and exit 1. Shape
 * {success:false, error:{code,message,details?}} — no planctl_invocation line.
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
        `No planctl project found at ${projectRoot}. Run 'planctl init' first.`,
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
// git helpers — fail-closed. Any unexpected non-zero / missing binary throws
// GitError so the verb collapses to a `tooling_error` verdict.
// ---------------------------------------------------------------------------

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Run git in `cwd` without an exit check. A missing git binary still throws
 * GitError (the tool is absent — fail closed); the caller inspects returncode
 * for the expected-non-zero cases. Mirrors _run_git_raw. */
function runGitRaw(args: string[], cwd: string): GitResult {
  try {
    const proc = Bun.spawnSync(["git", ...args], { cwd });
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    };
  } catch (exc) {
    throw new GitError(`git binary not found: ${(exc as Error).message}`);
  }
}

/** Run git in `cwd`, throwing GitError on any non-zero exit. Callers expecting a
 * legitimate non-zero (unborn HEAD, path-not-in-HEAD) use runGitRaw. Mirrors
 * _run_git. */
function runGit(args: string[], cwd: string): GitResult {
  const proc = runGitRaw(args, cwd);
  if (proc.exitCode !== 0) {
    throw new GitError(
      `git ${args.join(" ")} failed in ${cwd} ` +
        `(exit ${proc.exitCode}): ${proc.stderr.trim()}`,
    );
  }
  return proc;
}

/** True when `cwd` is inside a git work tree. A non-repo dir is NOT a tooling
 * error for the SOURCE scan (a target_repo may legitimately not be checked out
 * here) — `rev-parse --is-inside-work-tree` exit 128 reads as false. Mirrors
 * _is_git_repo. */
function isGitRepo(cwd: string): boolean {
  if (!isDir(cwd)) {
    return false;
  }
  const proc = runGitRaw(["rev-parse", "--is-inside-work-tree"], cwd);
  return proc.exitCode === 0 && proc.stdout.trim() === "true";
}

/** True when `cwd`'s HEAD points at a real commit (born branch). `rev-parse
 * --verify HEAD` exits 128 on an empty/orphan repo (unborn branch) — read as
 * false (a distinct signal, NOT a tooling error). A missing git binary still
 * throws via runGitRaw. Mirrors _has_head. */
function hasHead(cwd: string): boolean {
  return runGitRaw(["rev-parse", "--verify", "HEAD"], cwd).exitCode === 0;
}

/** Return shas in `repo` carrying a trailer-authentic `Task: <taskId>`.
 * Trailer-authentic, NOT substring: `git log` emits each commit's sha and the
 * parsed value of its Task trailer (%(trailers:key=Task,valueonly=true)),
 * field-separated by %x1f. Exact-equality match. valueonly joins multiple
 * values, so split on both newlines and commas before the equality check.
 * Returns [] when not a git work tree or no born HEAD; any OTHER git failure
 * throws GitError. Mirrors _find_source_commits. */
export function findSourceCommits(taskId: string, repo: string): string[] {
  if (!isGitRepo(repo)) {
    return [];
  }
  if (!hasHead(repo)) {
    return [];
  }

  const fmt = `--format=%H${FIELD_SEP}%(trailers:key=Task,valueonly=true)`;
  const proc = runGit(["log", fmt], repo);

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
    // Normalize commas → newlines so both `Task: a, b` and stacked `Task: a` /
    // `Task: b` forms split into individual candidate values.
    const values = trailerBlob.replace(/,/g, "\n").split("\n");
    if (values.some((v) => v.trim() === taskId)) {
      shas.push(sha);
    }
  }
  return shas;
}

/** True when the committed HEAD:<task.json> carries worker_done_at. Runs
 * cat-file against `stateRepo` (NOT target_repo, NOT cwd) at the repo-relative
 * `<data-dir>/tasks/<id>.json` under the `.keeper/` data dir. Guards the
 * unborn-branch case first. Returns false (not a tooling error) when the repo is
 * unborn or the path isn't in HEAD under the data dir; throws GitError on any
 * other git failure.
 * Mirrors _state_head_visible. */
export function stateHeadVisible(stateRepo: string, taskId: string): boolean {
  if (!isDir(stateRepo)) {
    throw new GitError(`state_repo is not a directory: ${stateRepo}`);
  }
  if (!isGitRepo(stateRepo)) {
    throw new GitError(`state_repo is not a git work tree: ${stateRepo}`);
  }
  if (!hasHead(stateRepo)) {
    // Unborn branch — nothing committed yet. Distinct signal, not an error.
    return false;
  }

  for (const dataDirName of DATA_DIR_NAMES) {
    const relpath = `${dataDirName}/tasks/${taskId}.json`;
    const proc = runGitRaw(["cat-file", "blob", `HEAD:${relpath}`], stateRepo);
    if (proc.exitCode !== 0) {
      // Path not present in HEAD under this data dir — try the next.
      continue;
    }
    let committed: Record<string, unknown>;
    try {
      committed = JSON.parse(proc.stdout);
    } catch (exc) {
      throw new GitError(
        `HEAD:${relpath} is not valid JSON: ${(exc as Error).message}`,
      );
    }
    return Boolean(committed.worker_done_at);
  }
  // Committed JSON not yet visible under any data dir.
  return false;
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
  const projPath = ctx.projectPath;
  const targetRepo = realpathOr(expectedWorkerCwd(taskDef, epicDef, projPath));
  const primaryRepo = realpathOr(
    (epicDef.primary_repo as string | null | undefined) || projPath,
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

  const pc = buildPlanctlInvocationReadonly("reconcile", projPath, taskId);
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
