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
// details}} shape — distinct from the flat emitError. STATE resolves through the
// central resolvePlanStateContext seam (cwd-then-global locate, then re-rooted to
// the epic's primary_repo); a same-id collision is disambiguated by claimability.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { assembleBrief, writeBrief } from "../brief.ts";
import { emitReadonly } from "../emit.ts";
import { formatOutput, type OutputFormat } from "../format.ts";
import { epicIdFromTask, isTaskId } from "../ids.ts";
import { resolveIncident } from "../incident.ts";
import { buildPlanInvocationReadonly } from "../invocation.ts";
import { mergeTaskState, workerAgentFor } from "../models.ts";
import {
  contextForRoot,
  type ProjectContext,
  resolvePlanStateContext,
  tryResolveOwningProjectForId,
} from "../project.ts";
import { resolveWorkerRepos } from "../runtime_status.ts";
import { writeWorkMarker } from "../session_markers.ts";
import {
  getActor,
  LocalFileStateStore,
  loadJsonSafe,
  nowIso,
} from "../store.ts";

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

/** Whether `taskId` in `projectRoot` is a claimable candidate (open epic +
 * todo/in_progress task). Disambiguates a same-id collision across projects.
 * Fails closed on a missing epic / unreadable state. Mirrors _is_claimable. */
function isClaimable(projectRoot: string, taskId: string): boolean {
  const ctx = contextForRoot(projectRoot);
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

/** Resolve the STATE-bearing context for `taskId`, PHYSICALLY rooted at the
 * epic's primary_repo. LOCATE cwd-then-global (`--project` authoritative),
 * mapping a locate failure to claim's typed envelope, then route STATE through
 * the central `resolvePlanStateContext` seam so the overlay + brief land in
 * PRIMARY even from a worktree lane — and even when primary is OUTSIDE the
 * configured roots (the lane's committed defs win the cwd-first locate, then the
 * resolver re-roots to primary). A same-id collision across projects is
 * disambiguated by claimability — exactly one claimable owner resolves silently;
 * else AMBIGUOUS_TASK_ID. */
function resolveProjectForTask(
  taskId: string,
  project: string | null,
  format: OutputFormat | null,
): ProjectContext {
  const located = tryResolveOwningProjectForId(taskId, project);
  if (!located.ok) {
    switch (located.reason) {
      case "no_project":
        emitClaimError(
          "NOT_A_PROJECT",
          `No plan project found at ${located.projectRoot}. Run 'keeper plan init' first.`,
          format,
        );
        break;
      case "not_found":
        emitClaimError(
          "TASK_NOT_FOUND",
          `Task not found: ${located.id}`,
          format,
        );
        break;
      case "ambiguous": {
        const claimable = located.owners.filter((root) =>
          isClaimable(root, taskId),
        );
        if (claimable.length === 1) {
          return resolvePlanStateContext(
            taskId,
            claimable[0] as string,
            format,
          );
        }
        emitClaimError(
          "AMBIGUOUS_TASK_ID",
          `Task ${located.id} exists in multiple projects; pass --project <path>.`,
          format,
          { candidates: located.owners },
        );
        break;
      }
    }
  }
  return resolvePlanStateContext(taskId, project, format);
}

interface ClaimArgs {
  taskId: string;
  force: boolean;
  note: string | null;
  project: string | null;
  format: OutputFormat | null;
}

/** The dispatch-injected Dispatched cell env contract, shared with the dispatch
 * seam: launchers always emit the three vars, non-empty exactly when a
 * Provider constraint translated the assigned cell. Reads dispatchConstraint
 * as the non-empty gate — model/tier ride along only when it fires. */
function readDispatchConstraint(): {
  dispatchedModel: string;
  dispatchedTier: string;
  dispatchConstraint: string;
  constrained: boolean;
} {
  const dispatchedModel = process.env.KEEPER_PLAN_DISPATCHED_MODEL ?? "";
  const dispatchedTier = process.env.KEEPER_PLAN_DISPATCHED_TIER ?? "";
  const dispatchConstraint = process.env.KEEPER_PLAN_DISPATCH_CONSTRAINT ?? "";
  return {
    dispatchedModel,
    dispatchedTier,
    dispatchConstraint,
    constrained: dispatchConstraint !== "",
  };
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

  // 4. resolve CODE routing via the runtime seam. target_repo follows the
  // worker's lane (KEEPER_PLAN_WORKTREE override -> task.target_repo ->
  // epic.primary_repo -> proj); the worker cds into it for code work, so a
  // worktree-mode claim MUST return the lane — else the worker works in the
  // shared main checkout and the lane stays empty. STATE (primary_repo /
  // state_repo) comes from the resolver's primary-rooted ctx, so the reported
  // value EQUALS the physical write site by construction.
  const projPath = ctx.projectPath;
  const primaryRepo = projPath;
  const { targetRepo } = resolveWorkerRepos(taskDef, epicDef, projPath);

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
  const model = (taskDef.model as string | null | undefined) ?? null;
  const auditRequired = taskDef.audit_required === true;
  const stateRepo = primaryRepo;
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

  const dispatch = readDispatchConstraint();

  // CAS under lock: read-merge-decide-write in one lock.
  let outcome = "CLAIMED";
  let claimedAt = "";
  let claimNoteFinal = "";
  let briefRef = "";
  let dispatchedResponse: Record<string, string> = {};

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
    // saveRuntime replaces the sidecar. A first claim captures the dispatched
    // cell; an ALREADY_MINE re-claim retains its prior stamped cell when the
    // launch carries no Provider constraint.
    if (dispatch.constrained) {
      newState.dispatched_model = dispatch.dispatchedModel;
      newState.dispatched_tier = dispatch.dispatchedTier;
      newState.dispatch_constraint = dispatch.dispatchConstraint;
    } else if (
      alreadyMine &&
      typeof runtime?.dispatch_constraint === "string" &&
      runtime.dispatch_constraint !== ""
    ) {
      newState.dispatched_model = runtime.dispatched_model;
      newState.dispatched_tier = runtime.dispatched_tier;
      newState.dispatch_constraint = runtime.dispatch_constraint;
    }
    if (
      typeof newState.dispatch_constraint === "string" &&
      newState.dispatch_constraint !== ""
    ) {
      dispatchedResponse = {
        dispatched_model:
          typeof newState.dispatched_model === "string"
            ? newState.dispatched_model
            : "",
        dispatched_tier:
          typeof newState.dispatched_tier === "string"
            ? newState.dispatched_tier
            : "",
        dispatch_constraint: newState.dispatch_constraint,
      };
    }
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

  // Surface any unresolved merge incident on THIS task's `work::<taskId>` sticky
  // row so the worker can record ownership via `keeper incident claim` — sourced
  // read-only from the incident read surface, never a plan-plugin DB read. Null
  // on the ordinary no-incident claim.
  const incident = resolveIncident(`work::${taskId}`);

  const pc = buildPlanInvocationReadonly("claim", ctx.projectPath, taskId);
  emitReadonly(
    {
      task_id: taskId,
      epic_id: epicId,
      target_repo: targetRepo,
      primary_repo: primaryRepo,
      tier,
      worker_model: model,
      ...dispatchedResponse,
      worker_agent: workerAgentFor(tier, model),
      task_state: taskState,
      epic_state: epicState,
      brief_ref: briefRef,
      incident,
    },
    pc,
  );
}
