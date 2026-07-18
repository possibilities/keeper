// worker resume verb — the port of planctl/run_worker_resume.py.
//
// The resume entrypoint for the content-blind /plan:work orchestrator. It is
// content-blind itself: it never inlines spec prose into the envelope. Instead
// it REGENERATES the out-of-band brief fresh (bake-fresh-on-each-entrypoint) via
// assembleBrief / writeBrief, returns a brief_ref handle plus a one-line process
// nudge, and stderr Note: lines. The respawned worker reads BRIEF_REF itself and
// finishes commit-then-done.
//
// Runtime-state-only / readonly — regenerating the brief lands it under
// gitignored state/briefs/; no .planctl/ commit fires. The success envelope
// renders via format_output WITHOUT a plan_invocation footer (the `worker`
// group is a plain group, so the readonly-trailer decorator never fires for
// `resume`). The typed-error path is the plain {success:false, error:msg}
// emitError shape (the invalid-id / spec-not-found message text carries the id).

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { assembleBrief, writeBrief } from "../brief.ts";
import { emitError, formatOutput, type OutputFormat } from "../format.ts";
import { isTaskId } from "../ids.ts";
import { mergeTaskState, workerAgentFor } from "../models.ts";
import { resolvePlanStateContext, resolveProject } from "../project.ts";
import { resolveWorkerRepos } from "../runtime_status.ts";
import { writeWorkMarker } from "../session_markers.ts";
import { LocalFileStateStore, loadJsonSafe } from "../store.ts";
import { getVcs } from "../vcs.ts";

/** Capture git status --short + diff HEAD --stat in the cwd via the facade.
 * Returns the joined non-empty parts, or "" when git is unavailable / produced
 * nothing. Mirrors _read_git_state. */
function readGitState(): string {
  return getVcs().shortStatusAndDiff(process.cwd());
}

/** Return the short sha of `taskId`'s source commit (cwd-local), or null if none.
 * Cheap `git log -1 --grep` lookup via the facade; no keeper shell-out (a resume
 * must work when keeper is down). Any git failure yields null. Mirrors
 * _find_source_commit_sha. */
function findSourceCommitSha(taskId: string): string | null {
  return getVcs().firstSourceShaShort(taskId, process.cwd());
}

export function runWorkerResume(opts: {
  taskId: string;
  format: OutputFormat | null;
}): void {
  const { taskId, format } = opts;

  if (!isTaskId(taskId)) {
    emitError(`Invalid task id: '${taskId}'`, format);
  }

  // Committed DEFS (specs / tasks / epics) read from the locate ctx (cwd, so a
  // lane reads its byte-identical checked-out defs). Plan STATE — the runtime
  // overlay read + the regenerated brief write — routes through the central seam
  // to the epic's PRIMARY repo, never the lane's gitignored (absent) state/.
  const ctx = resolveProject(format);
  const dataDir = ctx.dataDir;

  // The spec markdown is the existence gate (Python: TASK_NOT_FOUND when absent).
  const specPath = join(dataDir, "specs", `${taskId}.md`);
  if (!existsSync(specPath)) {
    emitError(`Task spec not found: ${taskId}`, format);
  }

  const stateCtx = resolvePlanStateContext(taskId, null, format);

  // Read task status + tier. Under the commit-then-done contract, observing
  // `done` here means the source commit already landed.
  const taskPath = join(dataDir, "tasks", `${taskId}.json`);
  let status = "unknown";
  let tier: string | null = null;
  let model: string | null = null;
  let auditRequired = false;
  let dispatchedResponse: Record<string, string> = {};
  let epicId = taskId.includes(".")
    ? taskId.slice(0, taskId.lastIndexOf("."))
    : taskId;
  const stateStore = new LocalFileStateStore(stateCtx.stateDir);
  let taskDef: Record<string, unknown> = {};
  if (existsSync(taskPath)) {
    const loaded = loadJsonSafe(taskPath);
    if (loaded) {
      taskDef = loaded;
      const runtime = stateStore.loadRuntime(taskId);
      const merged = mergeTaskState(taskDef, runtime);
      status = (merged.status as string | undefined) ?? "unknown";
      epicId = (merged.epic as string | undefined) ?? epicId;
      tier = (merged.tier as string | null | undefined) ?? null;
      model = (merged.model as string | null | undefined) ?? null;
      auditRequired = merged.audit_required === true;
      if (
        typeof runtime?.dispatch_constraint === "string" &&
        runtime.dispatch_constraint !== ""
      ) {
        dispatchedResponse = {
          dispatched_model:
            typeof runtime.dispatched_model === "string"
              ? runtime.dispatched_model
              : "",
          dispatched_tier:
            typeof runtime.dispatched_tier === "string"
              ? runtime.dispatched_tier
              : "",
          dispatch_constraint: runtime.dispatch_constraint,
        };
      }
    }
  }

  // Resolve repos exactly as `claim` does so the cold-resume spawn prompt is
  // byte-uniform with the claim-path prompt.
  let epicDef: Record<string, unknown> = {};
  const epicPath = join(dataDir, "epics", `${epicId}.json`);
  if (existsSync(epicPath)) {
    epicDef = loadJsonSafe(epicPath) ?? {};
  }

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

  // Regenerate the brief fresh (bake-fresh-on-each-entrypoint). `worker resume`
  // always overwrites: it never reads a foreign brief.
  const briefDict = assembleBrief({
    taskId,
    epicId,
    targetRepo,
    primaryRepo,
    stateRepo,
    tier,
    auditRequired,
    dataDir,
  });

  const briefsDir = join(stateCtx.stateDir, "briefs");
  let briefRef: string;
  try {
    mkdirSync(briefsDir, { recursive: true });
    briefRef = writeBrief(briefsDir, taskId, briefDict);
  } catch (exc) {
    emitError(
      `failed to write brief for ${taskId}: ${(exc as Error).message}`,
      format,
    );
  }

  // Cheap process facts for the nudge.
  const sourceCommitSha = findSourceCommitSha(taskId);
  const gitState = readGitState();
  const dirtySessionFileCount = gitState
    ? gitState.split("\n").filter((ln) => ln.trim()).length
    : 0;

  const nudge =
    `Resume task ${taskId}. status=${status} ` +
    `source_commit=${sourceCommitSha ?? "null"} ` +
    `dirty_session_files=${dirtySessionFileCount}. ` +
    "Read BRIEF_REF, finish commit-then-done.";

  // Stderr notes always emit (independent of format) to inform the human without
  // cluttering the JSON/YAML stdout envelope.
  if (status !== "in_progress" && status !== "unknown") {
    process.stderr.write(
      `Note: task ${taskId} status is '${status}' (not in_progress)\n`,
    );
  }
  process.stderr.write(
    `Note: task ${taskId} tier is ${tier === null ? "None" : `'${tier}'`}\n`,
  );

  // Re-mark this session as working the task (guard contract). Success-path
  // only — typed-error paths above exit before reaching here. Fail-open.
  writeWorkMarker(taskId);

  // Python emit() with neither plan_invocation nor verb falls to the
  // format_output branch: the {success:true, ...} envelope renders in the
  // ambient --format WITHOUT a plan_invocation footer (the `worker` group is
  // a plain group, so the readonly-trailer decorator never fires for `resume`).
  formatOutput(
    {
      success: true,
      task_id: taskId,
      status,
      tier,
      worker_model: model,
      ...dispatchedResponse,
      worker_agent: workerAgentFor(tier, model),
      brief_ref: briefRef,
      nudge,
      target_repo: targetRepo,
      primary_repo: primaryRepo,
      source_commit_sha: sourceCommitSha,
      dirty_session_file_count: dirtySessionFileCount,
    },
    format,
  );
}
