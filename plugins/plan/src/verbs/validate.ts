// validate verb. Whole-project (or single --epic) structural integrity, emitting
// the NON-standard {valid, errors, warnings} envelope through the format path
// (NOT the success seam), exit 1 on invalid. Every path prints exactly ONE
// top-level JSON value.
//
// The --epic stamp state machine: when valid AND last_validated_at is null, write
// the marker + bump updated_at and auto-commit, THEN print the envelope with the
// plan_invocation MERGED in — so a printed value is the authoritative signal the
// .keeper/ commit landed. A commit failure folds the commit_failed details into
// that same single value + exit 1; an already-stamped epic is a pure no-op (no
// write, no commit) and prints the bare {valid, errors, warnings}.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { autoCommitFromInvocation, CommitFailed } from "../commit.ts";
import { formatOutput, type OutputFormat } from "../format.ts";
import { validateEpicIntegrityWithWarnings } from "../integrity.ts";
import { buildPlanInvocation, type MutatingInvocation } from "../invocation.ts";
import { SCHEMA_VERSION } from "../models.ts";
import { resolveProject } from "../project.ts";
import { atomicWriteJson, loadJson, loadJsonSafe, nowIso } from "../store.ts";

interface ValidateEnvelope {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** Render the validate envelope as human-readable text (mirrors
 * _render_human_validate). */
function renderHuman(data: ValidateEnvelope): string {
  const errors = data.errors ?? [];
  const warnings = data.warnings ?? [];
  const valid = data.valid ?? false;
  const lines: string[] = [];
  if (errors.length > 0) {
    lines.push("\nErrors:");
    for (const e of errors) {
      lines.push(`  - ${e}`);
    }
  }
  if (warnings.length > 0) {
    lines.push("\nWarnings:");
    for (const w of warnings) {
      lines.push(`  - ${w}`);
    }
  }
  if (valid && warnings.length === 0) {
    lines.push("\nValidation passed.");
  } else if (valid) {
    lines.push(`\nValidation passed with ${warnings.length} warning(s).`);
  } else {
    lines.push(
      `\nValidation failed with ${errors.length} error(s) and ${warnings.length} warning(s).`,
    );
  }
  return lines.join("\n");
}

/** Outcome of the non-exiting arm seam. `armed` flipped null→timestamp and
 * committed; `noop` found an already-stamped epic (a pure read); `commit_failed`
 * wrote the stamp to disk but its auto-commit failed — the compact envelope rides
 * along so an in-process caller can surface it verbatim without a hard-exit. */
export type ArmOutcome =
  | { kind: "armed"; invocation: MutatingInvocation }
  | { kind: "noop" }
  | { kind: "commit_failed"; failure: Record<string, unknown> };

/** Arm an epic's validation marker in-process: the null→timestamp write +
 * updated_at bump + auto-commit, factored out of the `validate --epic` verb so
 * close-finalize can arm a follow-up WITHOUT the CLI's process.exit (which would
 * skip runCaptured's stdout restore and corrupt the terminal envelope).
 * Idempotent — an already-stamped epic is a pure no-op (no write, no commit).
 * NEVER exits: on commit failure the stamp persists on disk (a re-run
 * short-circuits and does NOT re-commit; the next mutating verb's auto-commit
 * sweeps the dirty file) and the compact commit_failed envelope is returned. */
export function armEpicValidated(
  epicId: string,
  dataDir: string,
  projectPath: string,
): ArmOutcome {
  const epicPath = join(dataDir, "epics", `${epicId}.json`);
  const epicDef = loadJson(epicPath);
  if (
    epicDef.last_validated_at !== null &&
    epicDef.last_validated_at !== undefined
  ) {
    return { kind: "noop" };
  }
  epicDef.last_validated_at = nowIso();
  epicDef.updated_at = nowIso();
  atomicWriteJson(epicPath, epicDef, dataDir);

  const primaryRepo =
    (epicDef.primary_repo as string | null | undefined) ?? null;
  const pc = buildPlanInvocation("validate", epicId, null, {
    repoRoot: projectPath,
    primaryRepo,
  });
  // Auto-commit BEFORE the caller prints its NDJSON line, so a printed line is
  // the authoritative signal the commit landed.
  try {
    autoCommitFromInvocation(pc);
  } catch (exc) {
    if (!(exc instanceof CommitFailed)) {
      throw exc;
    }
    return {
      kind: "commit_failed",
      failure: {
        success: false,
        error: "commit_failed",
        details: { error: exc.error, message: exc.detail, ...exc.extra },
        plan_invocation: pc,
      },
    };
  }
  return { kind: "armed", invocation: pc };
}

/** Run validate. Returns the process exit code (0 valid, 1 invalid / commit
 * failure). The dispatcher must NOT fire the generic trailer for this verb. */
export function runValidate(
  epicId: string | null,
  format: OutputFormat | null,
): number {
  // The {valid, errors, warnings} envelope is frozen against yaml (it merges
  // plan_invocation on a fresh --epic stamp); a yaml request is an unsupported
  // mode, so it is a usage fault (exit 2) naming what validate renders, never a
  // silent JSON fallback.
  if (format === "yaml") {
    process.stderr.write(
      "Error: Invalid value for '--format': 'yaml' is not one of 'json', " +
        "'human' for 'validate'.\n",
    );
    return 2;
  }

  const ctx = resolveProject(format);
  const dataDir = ctx.dataDir;

  const errors: string[] = [];
  const warnings: string[] = [];

  // Root validation.
  const meta = loadJsonSafe(join(dataDir, "meta.json"));
  if (meta === null) {
    errors.push("meta.json is missing or invalid");
  } else {
    const sv = meta.schema_version;
    if (sv !== SCHEMA_VERSION) {
      errors.push(
        `Unsupported schema_version: ${sv === undefined ? "None" : String(sv)}`,
      );
    }
  }

  for (const d of ["epics", "specs", "tasks"]) {
    if (!existsSync(join(dataDir, d))) {
      errors.push(`Required directory missing: ${d}/`);
    }
  }

  // Collect epics to validate.
  const allEpicIds = new Set<string>();
  const epicsDir = join(dataDir, "epics");
  if (existsSync(epicsDir)) {
    for (const entry of readdirSync(epicsDir)) {
      if (entry.endsWith(".json")) {
        allEpicIds.add(entry.slice(0, -".json".length));
      }
    }
  }

  const epicIdsToCheck = epicId !== null ? [epicId] : [...allEpicIds].sort();

  for (const eid of epicIdsToCheck) {
    // A DONE epic's references are immutable: its missing-repo paths and dangling
    // cross-epic deps degrade to warnings so a whole-board run stays green on
    // debris no epic-file rewrite could fix. Live epics keep hard errors.
    const [epErrors, epWarnings] = validateEpicIntegrityWithWarnings(
      eid,
      dataDir,
      { tolerateDoneEpicDebris: true },
    );
    errors.push(...epErrors);
    warnings.push(...epWarnings);
  }

  const valid = errors.length === 0;

  // Marker-write: only with --epic, only on valid. Arm the marker FIRST (write +
  // commit) via the shared non-exiting seam, then print a SINGLE value: on a
  // fresh arm the {valid,errors,warnings} envelope with plan_invocation merged in
  // (the authoritative "commit landed" signal, printed AFTER the commit); on a
  // commit failure the same envelope with the commit_failed details folded in +
  // exit 1. An already-stamped epic falls through to the bare envelope below.
  if (valid && epicId !== null) {
    const armed = armEpicValidated(epicId, dataDir, ctx.projectPath);
    if (armed.kind === "commit_failed") {
      formatOutput({ valid, errors, warnings, ...armed.failure }, format, (d) =>
        renderHuman(d as ValidateEnvelope),
      );
      return 1;
    }
    if (armed.kind === "armed") {
      formatOutput(
        { valid, errors, warnings, plan_invocation: armed.invocation },
        format,
        (d) => renderHuman(d as ValidateEnvelope),
      );
      return 0;
    }
    // noop (already stamped): fall through to the bare envelope.
  }

  // Non-standard envelope: {valid, errors, warnings} — route through the format
  // path directly, NOT the success seam.
  formatOutput({ valid, errors, warnings }, format, (d) =>
    renderHuman(d as ValidateEnvelope),
  );

  return valid ? 0 : 1;
}
