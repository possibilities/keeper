// audit submit-task verb — the write half of the per-task audit gate's typed
// seam, paired with `audit gate-check` (audit_gate_check.ts). Persists the
// task-scoped quality-auditor's findings payload commit-free into the per-task
// finding artifact (audits/<epic_id>/tasks/<task_id>.json), wrapping the
// existing audit_artifacts writeTaskFinding helper — no reimplementation of
// reading, writing, or hashing.
//
// `commits` is NEVER trusted from the caller: it is derived server-side via
// deriveTaskCommitGroups (the SAME seam gate-check reads), so the stamped
// commit_set_hash always agrees between the two verbs and a caller cannot
// forge coverage over commits it never produced. The top-level `status` comes
// from the required `--status` flag (clean/mild/severe — the artifact-level
// vocabulary, distinct from each finding's own accumulated-open/fixed
// vocabulary); an out-of-enum value is a typed error. Each entry in the
// payload's `findings` list is stamped `status: "accumulated-open"` when its
// own status is absent.
//
// Runtime-state-only (like claim / audit submit): mutates only gitignored
// state/audits/ and draws NO .keeper/ commit. Last-writer-wins.

import {
  AUDIT_SCHEMA_VERSION,
  type CommitGroup,
  writeTaskFinding,
} from "../audit_artifacts.ts";
import { deriveTaskCommitGroups, GitError } from "../audit_gate_commits.ts";
import { formatOutput, type OutputFormat } from "../format.ts";
import { isTaskId } from "../ids.ts";
import {
  type ProjectContext,
  resolvePlanStateContext,
  tryResolveOwningProjectForId,
} from "../project.ts";
import {
  emitSubmitError,
  readPayloadCapped,
  SubmitError,
} from "../submit_common.ts";

// The artifact-level status vocabulary (top-level `status`), distinct from the
// per-finding accumulated-open/fixed vocabulary stamped below.
const FINDING_STATUSES = ["clean", "mild", "severe"] as const;

/** Resolve the STATE-bearing context for `taskId`, PHYSICALLY rooted at the
 * epic's primary_repo — byte-identical two-phase shape to gate-check's own
 * resolveProjectForTask, so the two verbs agree on which repo owns a task's
 * state. Throws SubmitError on a locate failure (caught at the verb boundary);
 * `resolvePlanStateContext`'s own internal failure path exits directly via its
 * `format`-rendered prose error, matching every other state-context caller. */
function resolveProjectForTask(
  taskId: string,
  project: string | null,
  format: OutputFormat | null,
): ProjectContext {
  const located = tryResolveOwningProjectForId(taskId, project);
  if (!located.ok) {
    switch (located.reason) {
      case "no_project":
        throw new SubmitError(
          "NOT_A_PROJECT",
          `No plan project found at ${located.projectRoot}. Run 'keeper plan init' first.`,
        );
      case "not_found":
        throw new SubmitError(
          "TASK_NOT_FOUND",
          `Task not found: ${located.id}`,
        );
      case "ambiguous":
        throw new SubmitError(
          "AMBIGUOUS_TASK_ID",
          `Task ${located.id} exists in multiple projects; pass --project <path>.`,
          { candidates: located.owners },
        );
    }
  }
  return resolvePlanStateContext(taskId, project, format);
}

/** Coerce the payload's `findings` field to a stampable array: non-array
 * (including absent) becomes `[]`; each plain-object entry lacking its own
 * `status` is stamped `"accumulated-open"`. A non-object entry passes through
 * unchanged — the writer's own coerceCommitGroups-style defense lives in
 * audit_artifacts, this is purely the default-stamping pass. */
function stampFindingDefaults(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return entry;
    }
    const rec = entry as Record<string, unknown>;
    return rec.status === undefined
      ? { ...rec, status: "accumulated-open" }
      : rec;
  });
}

export interface AuditSubmitTaskArgs {
  taskId: string;
  project: string | null;
  file: string;
  status: string;
  format: OutputFormat | null;
}

export function runAuditSubmitTask(args: AuditSubmitTaskArgs): void {
  const { taskId, project, file, status, format } = args;

  try {
    if (!(FINDING_STATUSES as readonly string[]).includes(status)) {
      throw new SubmitError(
        "BAD_STATUS",
        `--status must be one of ${FINDING_STATUSES.join(", ")}; got '${status}'`,
      );
    }
    if (!isTaskId(taskId)) {
      throw new SubmitError("BAD_TASK_ID", `Invalid task ID: ${taskId}`);
    }

    const ctx = resolveProjectForTask(taskId, project, format);

    // Derive the CURRENT commit set — the SAME seam gate-check reads, so the
    // stamped hash always matches gate-check's independent recomputation.
    let epicId: string;
    let commitGroups: CommitGroup[];
    try {
      const scan = deriveTaskCommitGroups(taskId, ctx.dataDir, ctx.projectPath);
      epicId = scan.epicId;
      commitGroups = scan.commitGroups;
    } catch (exc) {
      if (exc instanceof GitError) {
        throw new SubmitError("GIT_UNAVAILABLE", exc.message);
      }
      throw exc;
    }

    const raw = readPayloadCapped(file, "task finding payload");
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch (exc) {
      throw new SubmitError(
        "BAD_JSON",
        `task finding payload is not valid JSON: ${describeError(exc)}`,
      );
    }
    if (
      payload === null ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      throw new SubmitError(
        "BAD_PAYLOAD",
        "task finding payload must be a JSON object",
      );
    }
    const payloadObj = payload as Record<string, unknown>;

    // Spread the caller's payload FIRST, then override the security-critical
    // keys (status, commits) so a caller-supplied value can never win — commits
    // is always server-derived, status is always the validated --status flag.
    const finding = {
      ...payloadObj,
      status,
      commits: commitGroups,
      findings: stampFindingDefaults(payloadObj.findings),
    };

    const dest = writeTaskFinding(ctx.projectPath, epicId, taskId, finding);

    formatOutput(
      {
        success: true,
        finding_ref: dest,
        task_id: taskId,
        epic_id: epicId,
        status,
        schema_version: AUDIT_SCHEMA_VERSION,
      },
      format,
    );
  } catch (exc) {
    if (exc instanceof SubmitError) {
      emitSubmitError(exc.code, exc.message, format, exc.details);
    }
    throw exc;
  }
}

function describeError(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}
