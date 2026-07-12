// audit gate-check verb — the read-only per-task audit-gate seam the
// content-blind /plan:work orchestrator polls between a flagged worker's
// commit and its done-stamp, so the orchestrator never opens the finding
// artifact or the worker's brief.
//
// Derives the task's CURRENT commit set itself (deriveTaskCommitGroups, the
// same derivation submit-task uses), compares it against the persisted
// per-task finding artifact's stamped commit_set_hash, and emits exactly one
// typed JSON root: {exists, covers_current_commits, status, finding_ref}.
// `status` is null unless the artifact is present AND readable AND its
// top-level status is one of clean/mild/severe — an absent artifact, an
// unparseable file, a too-new schema_version, or an out-of-enum status value
// all clamp to null/not-covering, the safe re-audit path (never a fabricated
// clean/mild/severe reading).
//
// Read-only: mutates nothing, self-emits the readonly invocation (files=null).
// Fail-closed on a git failure (GitError from deriveTaskCommitGroups): a typed
// tooling error exits 1 rather than a fabricated not-covering envelope.

import { existsSync } from "node:fs";

import {
  type CommitGroup,
  computeCommitSetHash,
  readTaskFinding,
  taskFindingPath,
} from "../audit_artifacts.ts";
import { deriveTaskCommitGroups, GitError } from "../audit_gate_commits.ts";
import { emitReadonly } from "../emit.ts";
import { formatOutput, type OutputFormat } from "../format.ts";
import { isTaskId } from "../ids.ts";
import { buildPlanInvocationReadonly } from "../invocation.ts";
import {
  type ProjectContext,
  resolvePlanStateContext,
  tryResolveOwningProjectForId,
} from "../project.ts";

/** The per-task finding artifact's top-level status vocabulary — distinct
 * from the per-finding accumulated-open/fixed vocabulary. */
const FINDING_STATUSES = new Set(["clean", "mild", "severe"]);

/** Emit a typed audit-gate-check error envelope and exit 1. Shape
 * {success:false, error:{code,message,details?}} — no plan_invocation line. */
function emitGateCheckError(
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

/** Resolve the STATE-bearing context for `taskId`, PHYSICALLY rooted at the
 * epic's primary_repo. LOCATE cwd-then-global (`--project` authoritative),
 * mapping a locate failure to gate-check's typed envelope, then route STATE
 * through the central `resolvePlanStateContext` seam — byte-identical
 * two-phase shape to reconcile's resolveProjectForTask, so the two content-
 * blind read verbs agree on which repo owns a task's state. */
function resolveProjectForTask(
  taskId: string,
  project: string | null,
  format: OutputFormat | null,
): ProjectContext {
  const located = tryResolveOwningProjectForId(taskId, project);
  if (!located.ok) {
    switch (located.reason) {
      case "no_project":
        emitGateCheckError(
          "NOT_A_PROJECT",
          `No plan project found at ${located.projectRoot}. Run 'keeper plan init' first.`,
          format,
        );
        break;
      case "not_found":
        emitGateCheckError(
          "TASK_NOT_FOUND",
          `Task not found: ${located.id}`,
          format,
        );
        break;
      case "ambiguous":
        emitGateCheckError(
          "AMBIGUOUS_TASK_ID",
          `Task ${located.id} exists in multiple projects; pass --project <path>.`,
          format,
          { candidates: located.owners },
        );
        break;
    }
  }
  return resolvePlanStateContext(taskId, project, format);
}

export interface AuditGateCheckArgs {
  taskId: string;
  project: string | null;
  format: OutputFormat | null;
}

export function runAuditGateCheck(args: AuditGateCheckArgs): void {
  const { taskId, project, format } = args;

  // 1. validate id (so epicIdFromTask's throw path is unreachable downstream).
  if (!isTaskId(taskId)) {
    emitGateCheckError("BAD_TASK_ID", `Invalid task ID: ${taskId}`, format);
  }

  // 2. resolve owning project cwd-agnostically (roots discovery or --project),
  //    physically rooted at primary_repo.
  const ctx = resolveProjectForTask(taskId, project, format);

  // 3. derive the CURRENT commit set — the SAME seam submit-task uses, so the
  //    two verbs' hashes can never drift apart. Fail closed on a git failure.
  let epicId: string;
  let commitGroups: CommitGroup[];
  try {
    const scan = deriveTaskCommitGroups(taskId, ctx.dataDir, ctx.projectPath);
    epicId = scan.epicId;
    commitGroups = scan.commitGroups;
  } catch (exc) {
    if (exc instanceof GitError) {
      emitGateCheckError("GIT_UNAVAILABLE", exc.message, format);
    }
    throw exc;
  }

  // 4. compare against the persisted per-task finding artifact. `exists`
  //    reflects on-disk presence regardless of readability; an unreadable
  //    artifact (bad JSON, too-new schema) clamps status/covers to the safe
  //    not-covering default without erroring the whole verb.
  const findingRef = taskFindingPath(ctx.projectPath, epicId, taskId);
  const exists = existsSync(findingRef);
  let status: string | null = null;
  let coversCurrentCommits = false;
  if (exists) {
    try {
      const raw = readTaskFinding(ctx.projectPath, epicId, taskId);
      if (raw !== null) {
        const rawStatus = raw.status;
        if (typeof rawStatus === "string" && FINDING_STATUSES.has(rawStatus)) {
          status = rawStatus;
        }
        const storedHash = raw.commit_set_hash;
        coversCurrentCommits =
          typeof storedHash === "string" &&
          storedHash === computeCommitSetHash(commitGroups);
      }
    } catch {
      // Unparseable JSON or a too-new schema_version — clamps to unreadable:
      // status stays null, covers_current_commits stays false.
    }
  }

  const pc = buildPlanInvocationReadonly(
    "audit gate-check",
    ctx.projectPath,
    taskId,
  );
  emitReadonly(
    {
      exists,
      covers_current_commits: coversCurrentCommits,
      status,
      finding_ref: findingRef,
    },
    pc,
  );
}
