// followup submit verb — the byte-parity port of planctl/run_followup_submit.py.
//
// Validates the close-planner's follow-up plan YAML via scaffold's DRY-RUN
// semantics — the assert-all half of scaffold's flow (validateScaffoldYaml),
// reusing scaffold's leaf checkers + failure-code priority — WITHOUT the mutate
// phase: it mints nothing, needs no CLAUDE_CODE_SESSION_ID, allocates no fn-N. It
// then cross-checks the YAML task count against the persisted verdict's distinct
// non-null kept/merged ordinals (the expected follow-up cluster count) so a plan
// that under/over-provisions tasks is rejected at emission. On success it
// persists the YAML commit-free under audits/<epic_id>/followup.yaml + a sidecar.
//
// Runtime-state-only (like claim): NO .planctl/ commit. Last-writer-wins.

import { existsSync, readFileSync } from "node:fs";

import {
  AUDIT_SCHEMA_VERSION,
  followupPath,
  verdictPath,
  writeArtifact,
} from "../audit_artifacts.ts";
import { formatOutput, type OutputFormat } from "../format.ts";
import { serializeStateJson } from "../store.ts";
import {
  emitSubmitError,
  readPayloadCapped,
  resolveAuditContext,
  SubmitError,
} from "../submit_common.ts";
import { validateScaffoldYaml } from "./scaffold.ts";

export interface FollowupSubmitArgs {
  epicId: string;
  project: string | null;
  file: string;
  format: OutputFormat | null;
}

/** Distinct non-null kept/merged ordinals in the persisted verdict. A culled
 * decision carries task:null (no follow-up); kept / merged-into-* carry an
 * integer ordinal. Multiple findings can merge into the same ordinal, so DISTINCT
 * ordinals = the number of follow-up tasks the plan should provision. Mirrors
 * _expected_cluster_count. */
function expectedClusterCount(verdict: Record<string, unknown>): number {
  const decisions = Array.isArray(verdict.decisions) ? verdict.decisions : [];
  const clusters = new Set<number>();
  for (const d of decisions) {
    if (d !== null && typeof d === "object") {
      const task = (d as Record<string, unknown>).task;
      if (typeof task === "number" && Number.isInteger(task)) {
        clusters.add(task);
      }
    }
  }
  return clusters.size;
}

export function runFollowupSubmit(args: FollowupSubmitArgs): void {
  const { epicId, project, file, format } = args;

  try {
    const { primaryRepo, brief } = resolveAuditContext(epicId, project, format);

    // The task-count cross-check needs the persisted verdict — submit it first.
    const vp = verdictPath(primaryRepo, epicId);
    if (!existsSync(vp)) {
      throw new SubmitError(
        "VERDICT_MISSING",
        `no verdict for ${epicId} at ${vp}; ` +
          "run `planctl verdict submit` before the follow-up plan",
        { expected: vp },
      );
    }
    let verdict: Record<string, unknown>;
    try {
      verdict = JSON.parse(readFileSync(vp, "utf-8")) as Record<
        string,
        unknown
      >;
    } catch (exc) {
      throw new SubmitError(
        "BRIEF_CORRUPT",
        `could not read verdict ${vp}: ${describeError(exc)}`,
      );
    }

    const followupYaml = readPayloadCapped(file, "follow-up YAML");

    // Scaffold dry-run: the assert-all half, no mint. Reuses scaffold's leaf
    // checkers + exact failure-code priority. Surfaces scaffold's codes verbatim.
    const result = validateScaffoldYaml(
      Buffer.from(followupYaml, "utf-8"),
      "followup",
    );
    if (!result.ok) {
      throw new SubmitError(result.code, result.message, result.details);
    }

    const expected = expectedClusterCount(verdict);
    if (result.nTasks !== expected) {
      throw new SubmitError(
        "TASK_COUNT_MISMATCH",
        `follow-up plan has ${result.nTasks} task(s) but the verdict's ` +
          `distinct kept/merged ordinals expect ${expected}`,
        { actual_tasks: result.nTasks, expected_tasks: expected },
      );
    }

    // Validated. Persist the raw YAML + a hash-stamped sidecar (the YAML itself
    // is scaffold's wire shape and carries no provenance slot).
    const followupDest = followupPath(primaryRepo, epicId);
    writeArtifact(followupDest, followupYaml);
    const meta = {
      schema_version: AUDIT_SCHEMA_VERSION,
      epic_id: epicId,
      commit_set_hash: brief.commit_set_hash ?? null,
      task_count: result.nTasks,
    };
    const metaDest = `${followupDest}.meta.json`;
    writeArtifact(metaDest, serializeStateJson(meta));

    formatOutput(
      {
        success: true,
        followup_ref: followupDest,
        meta_ref: metaDest,
        commit_set_hash: brief.commit_set_hash ?? null,
        task_count: result.nTasks,
        expected_tasks: expected,
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
