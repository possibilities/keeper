// validate verb — the port of planctl/run_validate.py. Whole-project (or single
// --epic) structural integrity, emitting the NON-standard {valid, errors,
// warnings} envelope through the format path (NOT the success seam), exit 1 on
// invalid, NO trailer (the dispatcher lists validate in NO_TRACK_COMMANDS). The
// --epic stamp state machine: when valid AND last_validated_at is null, write
// the marker + bump updated_at, then auto-commit BEFORE printing a SECOND
// compact plan_invocation line — so the printed line is the authoritative
// signal the .planctl/ commit landed; a commit failure prints a compact
// commit_failed line + exit 1 (the invocation line is NOT printed); an already-
// stamped epic is a pure no-op (no write, no commit, no second line).

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { autoCommitFromInvocation, CommitFailed } from "../commit.ts";
import {
  compactJson,
  formatOutput,
  type OutputFormat,
  pyDefaultJson,
} from "../format.ts";
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
    const [epErrors, epWarnings] = validateEpicIntegrityWithWarnings(
      eid,
      dataDir,
    );
    errors.push(...epErrors);
    warnings.push(...epWarnings);
  }

  const valid = errors.length === 0;

  // Non-standard envelope: {valid, errors, warnings} — route through the format
  // path directly, NOT the success seam.
  formatOutput({ valid, errors, warnings }, format, (d) =>
    renderHuman(d as ValidateEnvelope),
  );

  // Marker-write: only with --epic, only on valid. Delegates to the shared
  // non-exiting arm seam, then applies the CLI's exiting envelope contract — on
  // commit failure print the compact failure envelope + exit 1 (the invocation
  // line is NOT printed); on a fresh arm print the spaced plan_invocation line
  // (distinct from the compact commit_failed line); an already-stamped epic
  // prints nothing.
  if (valid && epicId !== null) {
    const armed = armEpicValidated(epicId, dataDir, ctx.projectPath);
    if (armed.kind === "commit_failed") {
      process.stdout.write(`${compactJson(armed.failure)}\n`);
      process.exit(1);
    }
    if (armed.kind === "armed") {
      // Python prints this line with json.dumps(obj) (default spaced
      // separators) — distinct from the compact commit_failed line above.
      process.stdout.write(
        `${pyDefaultJson({ plan_invocation: armed.invocation })}\n`,
      );
    }
  }

  return valid ? 0 : 1;
}
