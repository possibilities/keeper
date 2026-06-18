// verdict submit verb — the byte-parity port of planctl/run_verdict_submit.py.
//
// Validates the close-planner's verdict JSON at emission: structural
// (VERDICT_SCHEMA, additionalProperties:false on every node) THEN the cross-field
// invariants jsonschema cannot express (merged-into targets reference a real fid;
// culled => task null; kept/merged => non-null ordinal; fatal:true => non-empty
// reason). A reject surfaces the typed, MINIMAL VERDICT_INVALID envelope (top-3
// errors + the schema fragment for the first failing path only). On success it
// stamps the brief's commit_set_hash + schema_version into the persisted record
// and writes it commit-free under audits/<epic_id>/verdict.json.
//
// Runtime-state-only (like claim): NO .planctl/ commit. Last-writer-wins.

import {
  AUDIT_SCHEMA_VERSION,
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
import {
  buildRejectEnvelope,
  crossFieldErrors,
  schemaErrors,
} from "../verdict_schema.ts";

export interface VerdictSubmitArgs {
  epicId: string;
  project: string | null;
  file: string;
  format: OutputFormat | null;
}

export function runVerdictSubmit(args: VerdictSubmitArgs): void {
  const { epicId, project, file, format } = args;

  try {
    const { primaryRepo, brief } = resolveAuditContext(epicId, project, format);
    const raw = readPayloadCapped(file, "verdict JSON");

    let verdict: unknown;
    try {
      verdict = JSON.parse(raw);
    } catch (exc) {
      throw new SubmitError(
        "BAD_JSON",
        `verdict is not valid JSON: ${describeError(exc)}`,
      );
    }

    // Structural pass first; if it fails the cross-field pass would key-error on
    // the missing/wrong-typed fields, so short-circuit on structural errors.
    let errors = schemaErrors(verdict);
    if (errors.length === 0) {
      errors = crossFieldErrors(verdict as Record<string, unknown>);
    }
    if (errors.length > 0) {
      formatOutput(buildRejectEnvelope(errors), format);
      process.exit(1);
    }

    const verdictObj = verdict as Record<string, unknown>;
    // Validated. Persist the wire payload PLUS the provenance stamp (the schema
    // rejects unknown top-level keys, so the stamp folds in post-validation).
    const record = {
      schema_version: AUDIT_SCHEMA_VERSION,
      commit_set_hash: brief.commit_set_hash ?? null,
      ...verdictObj,
    };
    const verdictDest = verdictPath(primaryRepo, epicId);
    writeArtifact(verdictDest, serializeStateJson(record));

    // Distinct non-null kept/merged ordinals — the expected follow-up cluster
    // count `followup submit` cross-checks against. Echoed for the close-planner.
    const decisions = Array.isArray(verdictObj.decisions)
      ? verdictObj.decisions
      : [];
    const clusters = new Set<number>();
    for (const d of decisions) {
      if (d !== null && typeof d === "object") {
        const task = (d as Record<string, unknown>).task;
        if (typeof task === "number" && Number.isInteger(task)) {
          clusters.add(task);
        }
      }
    }
    const expectedClusters = Array.from(clusters).sort((a, b) => a - b);

    formatOutput(
      {
        success: true,
        verdict_ref: verdictDest,
        commit_set_hash: brief.commit_set_hash ?? null,
        fatal: verdictObj.fatal ?? null,
        decision_count: decisions.length,
        expected_clusters: expectedClusters,
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
