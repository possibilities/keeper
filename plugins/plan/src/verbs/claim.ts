// claim verb — the port of planctl/run_claim.py.
//
// Asserts every precondition BEFORE any mutation (id valid, owning project
// resolves, target/primary repos, status/deps gate), assembles the brief
// out-of-band, then does a read-merge-decide-write CAS under lockTask. Outcomes:
// CLAIMED / ALREADY_MINE / CLAIMED_BY_OTHER. --force bypasses CLAIMED_BY_OTHER /
// TASK_BLOCKED / DEPS_UNMET but NEVER TASK_DONE. The brief is written AFTER
// saveRuntime inside the lock; the work marker is written after the CAS. claim
// mutates only gitignored state/, so it emits a readonly invocation (ZERO
// commits) carrying a brief_ref handle.
//
// The typed error envelope is the nested {success:false,error:{code,message,
// details}} shape — distinct from the flat emitError. Resolution is
// cwd-agnostic: roots discovery (findProjectsWithTask) or a --project override.

import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import { assembleBrief, writeBrief } from "../brief.ts";
import { findProjectsWithTask } from "../discovery.ts";
import { emitReadonly } from "../emit.ts";
import { formatOutput, type OutputFormat } from "../format.ts";
import { epicIdFromTask, isTaskId } from "../ids.ts";
import { buildPlanInvocationReadonly } from "../invocation.ts";
import { mergeTaskState, workerAgentForTier } from "../models.ts";
import { writeWorkMarker } from "../session_markers.ts";
import { hasDataDir, resolveDataDirOrDefault } from "../state_path.ts";
import {
  getActor,
  LocalFileStateStore,
  loadJsonSafe,
  nowIso,
} from "../store.ts";

interface ProjectCtx {
  dataDir: string;
  stateDir: string;
  projectPath: string;
}

/** Emit a typed claim error envelope {success:false,error:{code,message,
 * details?}} and exit 1. Routes through formatOutput so --format yaml renders
 * YAML. No plan_invocation — a failed precondition mutates nothing. Mirrors
 * _emit_claim_error. */
function emitClaimError(
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

/** Build a ProjectCtx from a project root, resolving its `.keeper/` data dir. */
function contextForRoot(projectRoot: string): ProjectCtx {
  const dataDir = resolveDataDirOrDefault(projectRoot);
  return {
    dataDir,
    stateDir: join(dataDir, "state"),
    projectPath: projectRoot,
  };
}

/** Expanduser-free resolve: absolutize + realpath (Python Path(p).resolve()).
 * The --project arg and the repo-fallback paths arrive absolute from callers /
 * config; a non-existent path falls back to its lexical absolute form. */
function resolveExpand(p: string): string {
  const abs = resolve(process.cwd(), p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** Whether `taskId` in `ctx` is a claimable candidate (open epic + todo/
 * in_progress task). Used to disambiguate same-id collisions. Fails closed on a
 * missing epic / unreadable state. Mirrors _is_claimable. */
function isClaimable(ctx: ProjectCtx, taskId: string): boolean {
  const taskPath = join(ctx.dataDir, "tasks", `${taskId}.json`);
  if (!existsSync(taskPath)) {
    return false;
  }
  try {
    const epicId = epicIdFromTask(taskId);
    const epicPath = join(ctx.dataDir, "epics", `${epicId}.json`);
    if (!existsSync(epicPath)) {
      return false;
    }
    const epicDef = loadJsonSafe(epicPath);
    if (!epicDef || epicDef.status !== "open") {
      return false;
    }
    const taskDef = loadJsonSafe(taskPath);
    if (!taskDef) {
      return false;
    }
    const runtime = new LocalFileStateStore(ctx.stateDir).loadRuntime(taskId);
    const status =
      (mergeTaskState(taskDef, runtime).status as string) ?? "todo";
    return status === "todo" || status === "in_progress";
  } catch {
    return false;
  }
}

/** Resolve the owning project for `taskId`, cwd-agnostically. --project override
 * resolves directly (NOT_A_PROJECT / TASK_NOT_FOUND); zero-arg scans roots via
 * findProjectsWithTask (one match → use; many → filter to claimable; else
 * AMBIGUOUS_TASK_ID; zero → TASK_NOT_FOUND). Mirrors _resolve_project_for_task. */
function resolveProjectForTask(
  taskId: string,
  project: string | null,
  format: OutputFormat | null,
): ProjectCtx {
  if (project !== null) {
    const projectRoot = resolveExpand(project);
    if (!hasDataDir(projectRoot)) {
      emitClaimError(
        "NOT_A_PROJECT",
        `No planctl project found at ${projectRoot}. Run 'planctl init' first.`,
        format,
      );
    }
    const ctx = contextForRoot(projectRoot);
    if (!existsSync(join(ctx.dataDir, "tasks", `${taskId}.json`))) {
      emitClaimError(
        "TASK_NOT_FOUND",
        `Task not found in ${projectRoot}: ${taskId}`,
        format,
      );
    }
    return ctx;
  }

  const matches = findProjectsWithTask(taskId);
  if (matches.length === 0) {
    emitClaimError("TASK_NOT_FOUND", `Task not found: ${taskId}`, format);
  }
  if (matches.length === 1) {
    return contextForRoot(matches[0] as string);
  }

  const contexts = matches.map((p) => contextForRoot(p));
  const claimable = contexts.filter((c) => isClaimable(c, taskId));
  if (claimable.length === 1) {
    return claimable[0] as ProjectCtx;
  }
  emitClaimError(
    "AMBIGUOUS_TASK_ID",
    `Task ${taskId} exists in multiple projects; pass --project <path>.`,
    format,
    { candidates: contexts.map((c) => c.projectPath) },
  );
}

interface ClaimArgs {
  taskId: string;
  force: boolean;
  note: string | null;
  project: string | null;
  format: OutputFormat | null;
}

export function runClaim(args: ClaimArgs): void {
  const { taskId, force, note, project, format } = args;

  // 1. validate id
  if (!isTaskId(taskId)) {
    emitClaimError("BAD_TASK_ID", `Invalid task ID: ${taskId}`, format);
  }

  // 2. resolve owning project (subsumes task-exists)
  const ctx = resolveProjectForTask(taskId, project, format);
  const dataDir = ctx.dataDir;
  const stateStore = new LocalFileStateStore(ctx.stateDir);

  const taskPath = join(dataDir, "tasks", `${taskId}.json`);
  const taskDef = loadJsonSafe(taskPath) ?? {};
  const actor = getActor();

  const epicId = epicIdFromTask(taskId);
  const epicPath = join(dataDir, "epics", `${epicId}.json`);
  const epicDef = existsSync(epicPath) ? (loadJsonSafe(epicPath) ?? {}) : {};

  // 4. resolve target_repo / primary_repo (three-level fallback, realpath-normalized)
  const projPath = ctx.projectPath;
  const expectedCwd =
    (taskDef.target_repo as string | null | undefined) ||
    (epicDef.primary_repo as string | null | undefined) ||
    projPath;
  const targetRepo = resolveExpand(expectedCwd);
  const primaryRepo = resolveExpand(
    (epicDef.primary_repo as string | null | undefined) || projPath,
  );

  // 5. status / deps gate (pre-check, no lock — the CAS re-reads under the lock)
  const runtimePre = stateStore.loadRuntime(taskId);
  const mergedPre = mergeTaskState(taskDef, runtimePre);
  const statusPre = (mergedPre.status as string) ?? "todo";

  if (statusPre === "done") {
    emitClaimError("TASK_DONE", `Task ${taskId} is already done`, format);
  }

  if (!force) {
    if (statusPre === "blocked") {
      emitClaimError("TASK_BLOCKED", `Task ${taskId} is blocked`, format);
    }
    if (statusPre === "in_progress") {
      const currentAssignee = mergedPre.assignee as string | undefined | null;
      if (currentAssignee && currentAssignee !== actor) {
        emitClaimError(
          "CLAIMED_BY_OTHER",
          `Task ${taskId} is claimed by ${currentAssignee}`,
          format,
          { assignee: currentAssignee },
        );
      }
    }
    const deps = (taskDef.depends_on as string[] | undefined) ?? [];
    if (deps.length > 0) {
      const tasksDir = join(dataDir, "tasks");
      const unmet: string[] = [];
      for (const depId of deps) {
        const depPath = join(tasksDir, `${depId}.json`);
        if (existsSync(depPath)) {
          const depRuntime = stateStore.loadRuntime(depId);
          const depStatus = (depRuntime?.status as string) ?? "todo";
          if (depStatus !== "done") {
            unmet.push(depId);
          }
        }
      }
      if (unmet.length > 0) {
        emitClaimError(
          "DEPS_UNMET",
          `Unmet dependencies for ${taskId}: ${unmet.join(", ")}`,
          format,
          { unmet },
        );
      }
    }
  }

  // Assemble the brief out-of-band (BEFORE the single mutation).
  const tier = (taskDef.tier as string | null | undefined) ?? null;
  const stateRepo = primaryRepo;
  const briefDict = assembleBrief({
    taskId,
    epicId,
    targetRepo,
    primaryRepo,
    stateRepo,
    tier,
    dataDir,
  });

  // CAS under lock: read-merge-decide-write in one lock.
  let outcome = "CLAIMED";
  let claimedAt = "";
  let claimNoteFinal = "";
  let briefRef = "";

  stateStore.withTaskLock(taskId, () => {
    const runtime = stateStore.loadRuntime(taskId);
    const merged = mergeTaskState(taskDef, runtime);
    const status = (merged.status as string) ?? "todo";

    if (status === "done") {
      emitClaimError("TASK_DONE", `Task ${taskId} is already done`, format);
    }

    const existingAssignee = merged.assignee as string | undefined | null;
    const alreadyMine =
      status === "in_progress" && existingAssignee === actor && !force;

    if (
      !force &&
      !alreadyMine &&
      status === "in_progress" &&
      existingAssignee &&
      existingAssignee !== actor
    ) {
      emitClaimError(
        "CLAIMED_BY_OTHER",
        `Task ${taskId} is claimed by ${existingAssignee}`,
        format,
        { assignee: existingAssignee },
      );
    }

    const now = nowIso();
    let claimNote = note ?? "";

    if (alreadyMine) {
      outcome = "ALREADY_MINE";
      claimedAt = (merged.claimed_at as string | undefined) ?? now;
      claimNote = (merged.claim_note as string | undefined) ?? claimNote;
    } else {
      outcome = "CLAIMED";
      claimedAt = now;
      if (force && status === "in_progress") {
        const prevAssignee = merged.assignee as string | undefined | null;
        if (prevAssignee && prevAssignee !== actor) {
          claimNote = note ?? `Taken over from ${prevAssignee}`;
        }
      }
    }
    claimNoteFinal = claimNote;

    const newState: Record<string, unknown> = {
      status: "in_progress",
      updated_at: now,
      assignee: actor,
      claimed_at: claimedAt,
      claim_note: claimNote,
      evidence: "evidence" in merged ? merged.evidence : null,
      blocked_reason: null,
    };
    stateStore.saveRuntime(taskId, newState);

    // Write the brief AFTER saveRuntime, inside the lock. A write failure leaves
    // the task in_progress (repair-on-reclaim) and surfaces BRIEF_WRITE_FAILED.
    const briefsDir = join(ctx.stateDir, "briefs");
    try {
      mkdirSync(briefsDir, { recursive: true });
      briefRef = writeBrief(briefsDir, taskId, briefDict);
    } catch (exc) {
      emitClaimError(
        "BRIEF_WRITE_FAILED",
        `failed to write brief for ${taskId}: ${(exc as Error).message}`,
        format,
      );
    }
  });

  const taskState: Record<string, unknown> = {
    status: "in_progress",
    assignee: actor,
    claimed_at: claimedAt,
    claim_note: claimNoteFinal,
    outcome,
  };
  // Python dict.get(key, default) semantics: a present key returns its stored
  // value (even null); only an ABSENT key falls back to the default. `?? null`
  // would wrongly coerce a stored null (e.g. touched_repos: null) to the
  // default, so branch on key presence.
  const epicState: Record<string, unknown> = {
    id: epicId,
    title: "title" in epicDef ? epicDef.title : null,
    status: "status" in epicDef ? epicDef.status : null,
    primary_repo: "primary_repo" in epicDef ? epicDef.primary_repo : null,
    touched_repos: "touched_repos" in epicDef ? epicDef.touched_repos : [],
  };

  // Mark this session as actively working the task (success path only, fail-open).
  writeWorkMarker(taskId);

  const pc = buildPlanInvocationReadonly("claim", ctx.projectPath, taskId);
  emitReadonly(
    {
      task_id: taskId,
      epic_id: epicId,
      target_repo: targetRepo,
      primary_repo: primaryRepo,
      tier,
      worker_agent: workerAgentForTier(tier),
      task_state: taskState,
      epic_state: epicState,
      brief_ref: briefRef,
    },
    pc,
  );
}
