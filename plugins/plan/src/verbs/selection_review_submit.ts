// selection-review-submit verb — validate an out-of-band auditor's verdict JSON
// and land the committed per-epic review dataset.
//
// Reads the verdict on stdin (`--file -`), validates it against the audit brief:
// a non-empty top-level rubric_version/judge_model_version/prompt_hash (the
// grading run's own provenance keys), the 3-way categorical enum, exact
// coverage of the brief's auditable task set (no missing, no extra, no
// duplicate), and a non-empty evidence sentence per verdict. A malformed
// verdict is rejected with the single distinct VERDICT_INVALID code, leaving no
// file.
//
// On a clean verdict it writes the committed review file at
// `<data-dir>/selection-reviews/<epic>.json` — schema-versioned, stamped with
// rubric_version/judge_model_version/prompt_hash, each verdict snapshotting the
// graded {tier, model} + the selection config/input hashes so a future
// re-select cannot orphan the join — riding the verb's auto-commit. The verb
// writes no board/overlay state; the envelope carries counts + graded task ids.
//
// Write-once: a second submit without `--force` is refused (REVIEW_EXISTS) so a
// committed dataset is never silently clobbered — the deliberate re-grade path.

import { existsSync, readFileSync } from "node:fs";

import { emitMutating } from "../emit.ts";
import { formatOutput, type OutputFormat } from "../format.ts";
import { isEpicId } from "../ids.ts";
import {
  resolvePlanStateContext,
  tryResolveOwningProjectForId,
} from "../project.ts";
import {
  isReviewVerdictValue,
  type ReviewCounts,
  type ReviewVerdict,
  SELECTION_AUDIT_BRIEF_SCHEMA_VERSION,
  SELECTION_REVIEW_SCHEMA_VERSION,
  type SelectionReviewFile,
  selectionAuditBriefPath,
  selectionReviewExists,
  writeSelectionReviewFile,
} from "../selection_review_file.ts";
import { nowIso } from "../store.ts";
import {
  emitSubmitError,
  readPayloadCapped,
  SubmitError,
} from "../submit_common.ts";

export interface SelectionReviewSubmitArgs {
  epicId: string;
  project: string | null;
  file: string;
  force: boolean;
  format: OutputFormat | null;
}

function emitSubmitErrorLocal(
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

/** Typed epic-resolution preflight (mirrors selection-brief / audit-brief). */
function preflightEpicResolution(
  epicId: string,
  project: string | null,
  format: OutputFormat | null,
): void {
  const res = tryResolveOwningProjectForId(epicId, project);
  if (res.ok) {
    return;
  }
  if (res.reason === "no_project") {
    emitSubmitErrorLocal(
      "NOT_A_PROJECT",
      `no plan project found at ${res.projectRoot}`,
      format,
      { project: res.projectRoot },
    );
  }
  if (res.reason === "ambiguous") {
    emitSubmitErrorLocal(
      "AMBIGUOUS_EPIC_ID",
      `epic ${res.id} exists in multiple projects; pass --project`,
      format,
      { owners: res.owners },
    );
  }
  emitSubmitErrorLocal("EPIC_NOT_FOUND", `epic not found: ${res.id}`, format, {
    epic_id: res.id,
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One auditable-task record from the brief — the snapshot source for a verdict. */
interface BriefTask {
  taskId: string;
  tier: string;
  model: string;
  configHash: string;
  inputHash: string;
}

export function runSelectionReviewSubmit(
  args: SelectionReviewSubmitArgs,
): void {
  const { epicId, project, file, force, format } = args;

  if (!isEpicId(epicId)) {
    emitSubmitErrorLocal(
      "BAD_EPIC_ID",
      `invalid epic id: ${epicId || "<empty>"}`,
      format,
    );
  }

  preflightEpicResolution(epicId, project, format);
  const ctx = resolvePlanStateContext(epicId, project, format);
  const dataDir = ctx.dataDir;

  // The audit brief pins the auditable task set + each cell's snapshot fields; a
  // missing brief means selection-audit-brief was never run.
  const briefRef = selectionAuditBriefPath(dataDir, epicId);
  if (!existsSync(briefRef)) {
    emitSubmitErrorLocal(
      "BRIEF_MISSING",
      `no selection audit brief for ${epicId} at ${briefRef}; ` +
        `run \`keeper plan selection-audit-brief ${epicId}\` first`,
      format,
      { expected: briefRef },
    );
  }
  let brief: Record<string, unknown>;
  try {
    brief = JSON.parse(readFileSync(briefRef, "utf-8")) as Record<
      string,
      unknown
    >;
  } catch (exc) {
    emitSubmitErrorLocal(
      "BRIEF_CORRUPT",
      `could not read audit brief ${briefRef}: ${describeError(exc)}`,
      format,
    );
  }
  const briefVersion = brief.schema_version;
  if (
    typeof briefVersion === "number" &&
    briefVersion > SELECTION_AUDIT_BRIEF_SCHEMA_VERSION
  ) {
    emitSubmitErrorLocal(
      "BRIEF_CORRUPT",
      `audit brief schema_version ${briefVersion} is newer than this keeper ` +
        `plan knows (${SELECTION_AUDIT_BRIEF_SCHEMA_VERSION}); upgrade keeper plan`,
      format,
    );
  }

  // Write-once guard.
  if (!force && selectionReviewExists(dataDir, epicId)) {
    emitSubmitErrorLocal(
      "REVIEW_EXISTS",
      `a committed selection review already exists for ${epicId}; ` +
        "pass --force to overwrite it",
      format,
      { epic_id: epicId },
    );
  }

  // The auditable-task snapshot map, in brief order (the coverage source of
  // truth + the per-verdict {tier, model, hashes} snapshot).
  const briefTasks: BriefTask[] = [];
  const briefTaskById = new Map<string, BriefTask>();
  const rawAuditable = Array.isArray(brief.auditable_tasks)
    ? (brief.auditable_tasks as unknown[])
    : [];
  for (const entry of rawAuditable) {
    if (!isPlainObject(entry) || typeof entry.task_id !== "string") {
      continue;
    }
    const bt: BriefTask = {
      taskId: entry.task_id,
      tier: typeof entry.tier === "string" ? entry.tier : "",
      model: typeof entry.model === "string" ? entry.model : "",
      configHash:
        typeof entry.config_hash === "string" ? entry.config_hash : "",
      inputHash: typeof entry.input_hash === "string" ? entry.input_hash : "",
    };
    briefTasks.push(bt);
    briefTaskById.set(bt.taskId, bt);
  }

  // Read + parse the verdict payload. Input-plumbing faults (no stdin / too
  // large / bad encoding) surface with their own SubmitError codes; a parse or
  // shape/coverage fault is the single distinct VERDICT_INVALID.
  let raw: string;
  try {
    raw = readPayloadCapped(file, "verdict JSON");
  } catch (exc) {
    if (exc instanceof SubmitError) {
      emitSubmitError(exc.code, exc.message, format, exc.details);
    }
    throw exc;
  }

  const errors: string[] = [];
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (exc) {
    emitSubmitErrorLocal(
      "VERDICT_INVALID",
      "verdict is not valid JSON",
      format,
      { errors: [`not valid JSON: ${describeError(exc)}`] },
    );
  }

  if (!isPlainObject(payload) || !Array.isArray(payload.verdicts)) {
    emitSubmitErrorLocal(
      "VERDICT_INVALID",
      "verdict must be a mapping with a `verdicts` list",
      format,
      { errors: ["top-level `verdicts` must be a list"] },
    );
  }

  const payloadObj = payload as Record<string, unknown>;
  const verdictNodes = payloadObj.verdicts as unknown[];
  const seen = new Set<string>();
  const parsed: { taskId: string; verdict: string; evidence: string }[] = [];

  // The grading run's own provenance keys — required alongside the verdicts so
  // a rubric or judge-model change never masquerades as a policy shift.
  const rubricVersion =
    typeof payloadObj.rubric_version === "string"
      ? payloadObj.rubric_version
      : "";
  if (rubricVersion.trim() === "") {
    errors.push("top-level `rubric_version` must be a non-empty string");
  }
  const judgeModelVersion =
    typeof payloadObj.judge_model_version === "string"
      ? payloadObj.judge_model_version
      : "";
  if (judgeModelVersion.trim() === "") {
    errors.push("top-level `judge_model_version` must be a non-empty string");
  }
  const promptHash =
    typeof payloadObj.prompt_hash === "string" ? payloadObj.prompt_hash : "";
  if (promptHash.trim() === "") {
    errors.push("top-level `prompt_hash` must be a non-empty string");
  }

  for (let i = 0; i < verdictNodes.length; i += 1) {
    const prefix = `verdicts #${i + 1}`;
    const node = verdictNodes[i];
    if (!isPlainObject(node)) {
      errors.push(`${prefix}: must be a mapping`);
      continue;
    }
    const taskId = typeof node.task_id === "string" ? node.task_id : "";
    if (taskId === "") {
      errors.push(`${prefix}: \`task_id\` must be a non-empty string`);
    } else if (!briefTaskById.has(taskId)) {
      errors.push(
        `${prefix} (${taskId}): not an auditable task of this epic (extra verdict)`,
      );
    } else if (seen.has(taskId)) {
      errors.push(`${prefix} (${taskId}): duplicate verdict for the task`);
    }
    if (taskId !== "") {
      seen.add(taskId);
    }

    if (!isReviewVerdictValue(node.verdict)) {
      errors.push(
        `${prefix} (${taskId || "?"}): \`verdict\` must be one of ` +
          "underpowered, right_sized, overpowered",
      );
    }
    const evidence = typeof node.evidence === "string" ? node.evidence : "";
    if (evidence.trim() === "") {
      errors.push(
        `${prefix} (${taskId || "?"}): \`evidence\` must be a non-empty string`,
      );
    }

    parsed.push({
      taskId,
      verdict: isReviewVerdictValue(node.verdict) ? node.verdict : "",
      evidence,
    });
  }

  // Exact coverage: every auditable task graded exactly once.
  for (const bt of briefTasks) {
    if (!seen.has(bt.taskId)) {
      errors.push(
        `coverage: auditable task ${bt.taskId} has no verdict (missing)`,
      );
    }
  }

  if (errors.length > 0) {
    emitSubmitErrorLocal(
      "VERDICT_INVALID",
      "one or more verdicts are invalid",
      format,
      { errors: errors.slice(0, 10) },
    );
  }

  // Validated. Build the committed review file: snapshot the graded cell + hashes
  // from the brief per verdict so re-selects cannot orphan the join.
  const counts: ReviewCounts = {
    underpowered: 0,
    right_sized: 0,
    overpowered: 0,
  };
  const verdicts: ReviewVerdict[] = parsed.map((p) => {
    const bt = briefTaskById.get(p.taskId) as BriefTask;
    counts[p.verdict as keyof ReviewCounts] += 1;
    return {
      task_id: p.taskId,
      verdict: p.verdict as ReviewVerdict["verdict"],
      evidence: p.evidence,
      tier: bt.tier,
      model: bt.model,
      config_hash: bt.configHash,
      input_hash: bt.inputHash,
    };
  });

  const now = nowIso();
  const reviewFile: SelectionReviewFile = {
    schema_version: SELECTION_REVIEW_SCHEMA_VERSION,
    epic_id: epicId,
    created_at: now,
    selection_config_hash:
      typeof brief.selection_config_hash === "string"
        ? brief.selection_config_hash
        : "",
    selection_input_hash:
      typeof brief.selection_input_hash === "string"
        ? brief.selection_input_hash
        : "",
    rubric_version: rubricVersion,
    judge_model_version: judgeModelVersion,
    prompt_hash: promptHash,
    counts,
    verdicts,
  };
  const reviewRef = writeSelectionReviewFile(dataDir, reviewFile);

  emitMutating(
    {
      epic_id: epicId,
      review_ref: reviewRef,
      counts,
      graded_task_ids: verdicts.map((v) => v.task_id),
    },
    {
      verb: "selection-review-submit",
      target: epicId,
      repoRoot: ctx.projectPath,
      primaryRepo: ctx.projectPath,
    },
  );
}

function describeError(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}
