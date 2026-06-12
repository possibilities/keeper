// audit submit verb — the byte-parity port of planctl/run_audit_submit.py.
//
// Persists the content-blind quality-auditor's report markdown for <epic_id>:
// stamps it with the brief's commit_set_hash + schema_version, writes the
// markdown commit-free under audits/<epic_id>/report.md plus a small
// report.meta.json sidecar (version, hash, findings count, risk), and returns a
// content-blind envelope echoing the handle + the findings/risk flags.
//
// Runtime-state-only (like claim / close-preflight): mutates only gitignored
// state/audits/ and draws NO .planctl/ commit. Last-writer-wins.

import {
  AUDIT_SCHEMA_VERSION,
  reportMetaPath,
  reportPath,
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

// Accepted --risk values, mirroring the auditor's three-level risk label.
const RISK_LEVELS = ["Low", "Medium", "High"] as const;

export interface AuditSubmitArgs {
  epicId: string;
  project: string | null;
  file: string;
  findings: number;
  risk: string;
  format: OutputFormat | null;
}

export function runAuditSubmit(args: AuditSubmitArgs): void {
  const { epicId, project, file, findings, risk, format } = args;

  try {
    if (!(RISK_LEVELS as readonly string[]).includes(risk)) {
      throw new SubmitError(
        "BAD_RISK",
        `--risk must be one of ${RISK_LEVELS.join(", ")}; got ${pyRepr(risk)}`,
      );
    }

    const { primaryRepo, brief } = resolveAuditContext(epicId, project, format);
    const reportMd = readPayloadCapped(file, "audit report");

    const commitSetHash = brief.commit_set_hash ?? null;

    const reportDest = reportPath(primaryRepo, epicId);
    writeArtifact(reportDest, reportMd);

    // The meta sidecar carries the stamped hash + the echoed flags so a reader
    // (close-finalize) gets the report's provenance without re-parsing markdown.
    const meta = {
      schema_version: AUDIT_SCHEMA_VERSION,
      epic_id: epicId,
      commit_set_hash: commitSetHash,
      findings,
      risk,
    };
    const metaDest = reportMetaPath(primaryRepo, epicId);
    writeArtifact(metaDest, serializeStateJson(meta));

    formatOutput(
      {
        success: true,
        report_ref: reportDest,
        meta_ref: metaDest,
        commit_set_hash: commitSetHash,
        findings,
        risk,
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

/** python !r repr for the BAD_RISK message — single-quoted for a string. */
function pyRepr(value: string): string {
  return `'${value}'`;
}
