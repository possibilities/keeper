// close-preflight verb — the byte-parity port of planctl/run_close_preflight.py.
//
// The close-phase brief handoff (the symmetric bookend to claim's worker brief):
// assemble the audit brief — source commit groups, the ordinal task list with
// status + done summaries, and the canonical commit_set_hash — persist it
// commit-free under gitignored audits/<epic_id>/brief.json, then emit a
// content-blind envelope {primary_repo, tasks, all_done, brief_ref,
// commit_set_hash}. The commit_groups prose lives ONLY in the brief file.
//
// all_done is always true on success: a not-all-done epic is a typed
// TASKS_NOT_DONE error, not a false data field. The brief is assembled fully
// BEFORE any write; the writer is commit-free, so this verb mutates only
// gitignored state/ and draws no .planctl/ commit — it rides the dispatcher's
// auto-readonly invocation trailer (NOT a self-emit). On the error path it
// emits the typed envelope + exit 1.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve as resolveAbs } from "node:path";
import { loadEpic, loadTasksForEpic, taskSortKey } from "../api.ts";
import {
  AUDIT_SCHEMA_VERSION,
  computeCommitSetHash,
  writeBriefArtifact,
} from "../audit_artifacts.ts";
import {
  AllReposBrokenError,
  type CommitGroupResult,
  findCommitGroups,
} from "../commit_lookup.ts";
import { formatOutput, type OutputFormat } from "../format.ts";
import { isEpicId, isTaskId } from "../ids.ts";
import {
  contextForRoot,
  type ProjectContext,
  resolveProject,
} from "../project.ts";
import { claimCloseExclusive } from "../session_markers.ts";
import { getTaskSection } from "../specs.ts";
import { hasDataDir } from "../state_path.ts";

/** Emit a typed close-preflight error envelope and exit 1. Shape
 * {success:false, error:{code,message,details?}} — no plan_invocation line
 * (a failed read-only fetch mutates nothing). Mirrors _emit_preflight_error. */
function emitPreflightError(
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

/** Read a task's `## Done summary` straight from its spec markdown. The summary
 * is patched into specs/<task_id>.md by done (not a runtime field). A missing
 * spec or empty section yields "". Mirrors _done_summary. */
function doneSummary(dataDir: string, taskId: string): string {
  const specPath = join(dataDir, "specs", `${taskId}.md`);
  if (!existsSync(specPath)) {
    return "";
  }
  return getTaskSection(readFileSync(specPath, "utf-8"), "## Done summary");
}

export interface ClosePreflightArgs {
  epicId: string;
  project: string | null;
  format: OutputFormat | null;
}

export function runClosePreflight(args: ClosePreflightArgs): void {
  const { epicId, project, format } = args;

  // Three-way id branch: epic-shape proceeds; a task-shape id names the parent
  // epic in the error; garbage is bad.
  if (!isEpicId(epicId)) {
    if (isTaskId(epicId)) {
      const parent = epicId.slice(0, epicId.lastIndexOf("."));
      emitPreflightError(
        "BAD_EPIC_ID",
        `close operates on epics, not tasks — parent epic is ${parent}`,
        format,
        { task_id: epicId, parent_epic: parent },
      );
    }
    emitPreflightError("BAD_EPIC_ID", `Invalid epic ID: ${epicId}`, format);
  }

  // --project <abs_path> bypasses the cwd-walk. Absolute only; relative raises
  // UsageError (exit 2). Unset → resolveProject() cwd-walk.
  let ctx: ProjectContext;
  if (project !== null) {
    const projectPathObj = expandUser(project);
    if (!isAbsolute(projectPathObj)) {
      usageError(`--project requires an absolute path, got: ${project}`);
    }
    const projectRoot = realpathOr(resolveAbs(projectPathObj));
    if (!hasDataDir(projectRoot)) {
      emitPreflightError(
        "NOT_A_PROJECT",
        `No plan project found at ${projectRoot}. Run 'keeper plan init' first.`,
        format,
      );
    }
    ctx = contextForRoot(projectRoot);
  } else {
    ctx = resolveProject(format);
  }

  const epicPath = join(ctx.dataDir, "epics", `${epicId}.json`);
  if (!existsSync(epicPath)) {
    emitPreflightError(
      "EPIC_NOT_FOUND",
      `Epic not found in ${ctx.projectPath}: ${epicId}`,
      format,
    );
  }

  const epicDef = loadEpic(ctx, epicId);
  const primaryRepo = realpathOr(
    (epicDef.primary_repo as string | null | undefined) || ctx.projectPath,
  );
  const touchedRepos = epicDef.touched_repos as string[] | null | undefined;

  // Route EVERY plan-state read through a primary-rooted context, never the
  // cwd ctx. In worktree mode the close runs from the epic's lane, but plan
  // STATE (the runtime status overlay + done summaries) lives ONLY in the
  // primary repo (`.keeper/.gitignore` is `state/`) — the committed defs are
  // identical lane vs primary, so a cwd-resolved ctx silently reads stale
  // lane state and reports TASKS_NOT_DONE. When cwd==primary (non-worktree /
  // --project), contextForRoot(primaryRepo) is identical to ctx (a no-op).
  const stateCtx = contextForRoot(primaryRepo);

  // Tasks, ordinal-sorted, with runtime state merged in (from primary).
  const mergedTasks = loadTasksForEpic(stateCtx, epicId).sort(
    (a, b) =>
      taskSortKey((a.id as string) ?? "") - taskSortKey((b.id as string) ?? ""),
  );
  const tasks = mergedTasks.map((t) => ({
    id: t.id as string | undefined,
    title: t.title as string | undefined,
    status: (t.status as string | undefined) ?? "todo",
    target_repo: (t.target_repo as string | null) ?? null,
  }));
  const allDone = tasks.length > 0 && tasks.every((t) => t.status === "done");

  // Close operates only on a fully-done epic; not-all-done is a typed error.
  if (!allDone) {
    const notDone = tasks.filter((t) => t.status !== "done").map((t) => t.id);
    emitPreflightError(
      "TASKS_NOT_DONE",
      `epic ${epicId} is not ready to close — ${notDone.length} task(s) not done`,
      format,
      { not_done: notDone },
    );
  }

  // commit_groups via the in-process native trailer scan; fail loud (nothing
  // written) on an all-repos-broken condition.
  let commitGroups: CommitGroupResult[];
  try {
    commitGroups = findCommitGroups(
      tasks.filter((t) => t.id).map((t) => t.id as string),
      primaryRepo,
      touchedRepos,
      epicId,
    );
  } catch (exc) {
    if (exc instanceof AllReposBrokenError) {
      emitPreflightError(
        "COMMIT_LOOKUP_FAILED",
        "commit-trailer scan found no usable repo: every repo in the scan " +
          "set is missing or not a git repo",
        format,
        { broken_repos: exc.brokenRepos },
      );
    }
    throw exc;
  }
  const commitSetHash = computeCommitSetHash(commitGroups);

  // Assemble the full brief, then write it atomically + commit-free. The brief
  // carries commit_groups + the ordinal task list with done summaries; the
  // envelope carries only the handle + hash.
  const brief = {
    schema_version: AUDIT_SCHEMA_VERSION,
    epic_id: epicId,
    primary_repo: primaryRepo,
    touched_repos: touchedRepos ?? null,
    commit_set_hash: commitSetHash,
    commit_groups: commitGroups,
    snippet_context: "",
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      target_repo: t.target_repo,
      done_summary: t.id ? doneSummary(stateCtx.dataDir, t.id) : "",
    })),
  };
  const briefRef = writeBriefArtifact(primaryRepo, epicId, brief);

  // Claim the close exclusively (guard contract + duplicate-close guard). Writes
  // this session's close marker, then asserts no rival live closer holds the
  // epic — a second concurrent claimant fails loud so it exits instead of
  // re-running the whole audit. Success path only; fail-open on marker IO.
  const lost = claimCloseExclusive(epicId);
  if (lost !== null) {
    emitPreflightError(
      "CLOSE_ALREADY_CLAIMED",
      `epic ${epicId} is already being closed by another live session — ` +
        "resume that closer over the bus rather than starting a second one",
      format,
      { held_by_session: lost.heldBy },
    );
  }

  formatOutput(
    {
      success: true,
      primary_repo: primaryRepo,
      tasks,
      all_done: true,
      brief_ref: briefRef,
      commit_set_hash: commitSetHash,
    },
    format,
  );
}

/** click UsageError shape: usage + try-help on stderr, exit 2. */
function usageError(message: string): never {
  process.stderr.write(
    "Usage: keeper plan close-preflight [OPTIONS] EPIC_ID\n",
  );
  process.stderr.write(
    "Try 'keeper plan close-preflight --help' for help.\n\n",
  );
  process.stderr.write(`Error: ${message}\n`);
  process.exit(2);
}

function realpathOr(p: string): string {
  const abs = resolveAbs(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function isAbsolute(p: string): boolean {
  return p.startsWith("/");
}

function expandUser(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    const home = process.env.HOME ?? "";
    return home + p.slice(1);
  }
  return p;
}
