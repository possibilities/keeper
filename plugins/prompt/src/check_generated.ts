// `keeper prompt check-generated <file> --on {read,write}` — the generated-guard
// verb the keeper plan pre/post hooks shell. Port of promptctl
// run_check_generated.py.
//
// Reads the target file's companion sidecar `<file>.managed-file-dont-edit`; if
// present, parses `{source_template, sha256}` and emits an actionable message
// naming the absolute source template + the regenerate command. Compares the
// recorded `sha256` against the live file's bytes — a mismatch is drift
// (managed-and-modified) and surfaces in the message body.
//
// A file whose own name ends in `.managed-file-dont-edit` is treated as managed
// by virtue of its name alone (no sidecar-for-the-sidecar); the source template
// is reported as the primary file's sidecar pointer when readable, or
// `(source template unknown)` otherwise.
//
// Two modes (selected by --on):
//   write  the hard variant (PreToolUse Write/Edit): a BLOCKED message the hook
//     turns into a permissionDecision: deny.
//   read   the softer variant (PostToolUse Read): a non-blocking heads-up the
//     hook turns into additionalContext.
//
// Output is JSON on stdout, exit 0 (informational; exit 2 only on a bad --on).
// The verb is read-only and never raises — a malformed sidecar means we fall
// through to `{"marked": false}` rather than block every Write on a stray edit.
//
// The ONE deliberate diff vs the Python oracle: `regenerate_cmd` and the message
// bodies say `keeper prompt`, not `promptctl`.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const SIDECAR_SUFFIX = ".managed-file-dont-edit";

interface SidecarData {
  source_template?: unknown;
  sha256?: unknown;
  regenerate_cmd?: unknown;
}

/** Parse `<file>.managed-file-dont-edit` JSON, returning null on any failure
 * (unreadable, bad UTF-8, bad JSON, non-object). Mirrors _read_sidecar. */
function readSidecar(sidecarPath: string): SidecarData | null {
  let text: string;
  try {
    text = readFileSync(sidecarPath, "utf-8");
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  return data as SidecarData;
}

/** Return [primary, sidecarData] describing the managed state of a file.
 *   regular file X with a sibling X.managed-file-dont-edit -> [X, data]
 *   the sidecar itself X.managed-file-dont-edit -> [X-primary, data|null]
 *   anything else -> [null, null]
 * Mirrors _resolve_managed. */
function resolveManaged(filePath: string): [string | null, SidecarData | null] {
  const name = basename(filePath);
  if (name.endsWith(SIDECAR_SUFFIX)) {
    const primaryName = name.slice(0, name.length - SIDECAR_SUFFIX.length);
    const primary = join(dirname(filePath), primaryName);
    return [primary, readSidecar(filePath)];
  }

  const sidecar = join(dirname(filePath), name + SIDECAR_SUFFIX);
  if (!isFile(sidecar)) {
    return [null, null];
  }
  const sidecarData = readSidecar(sidecar);
  if (sidecarData === null) {
    return [null, null];
  }
  return [filePath, sidecarData];
}

/** Walk up from `filePath`'s resolved dir to the nearest `.git` root, or null.
 * Mirrors _resolve_project_root (root-from-TARGET-FILE, not cwd). */
function resolveProjectRoot(filePath: string): string | null {
  let current = dirname(resolve(filePath));
  for (;;) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/** True iff the primary file's bytes don't match the sidecar's sha256. A missing
 * primary is NOT drift (deliberate deletion). Mirrors _detect_drift. */
function detectDrift(primary: string, expectedSha: string | null): boolean {
  if (!expectedSha) {
    return false;
  }
  let live: Buffer;
  try {
    live = readFileSync(primary);
  } catch {
    return false;
  }
  return createHash("sha256").update(live).digest("hex") !== expectedSha;
}

/** Hard message — PreToolUse Write/Edit deny reason. Mirrors
 * _build_block_message (verb substituted to `keeper prompt`). */
function buildBlockMessage(
  absSource: string,
  regenerateCmd: string,
  drift: boolean,
  editedSidecar: boolean,
): string {
  const what = editedSidecar
    ? "BLOCKED: this is a sidecar for a generated file. keeper prompt " +
      "regenerates it on every render, so editing it directly is silently " +
      "lost. Edit the source template instead.\n\n"
    : "BLOCKED: this is a generated file. keeper prompt overwrites it on " +
      "every render, so any edit here is silently lost.\n\n";
  const driftNote = drift ? DRIFT_NOTE : "";
  return (
    `${what}` +
    "Fix it at the source:\n" +
    `  1. Edit the template: ${absSource}\n` +
    `  2. Regenerate: ${regenerateCmd}\n\n` +
    "(Source identified from this file's `.managed-file-dont-edit` " +
    `sidecar.)${driftNote}`
  );
}

/** Soft message — PostToolUse Read additionalContext. Mirrors
 * _build_warn_message (verb substituted to `keeper prompt`). */
function buildWarnMessage(
  absSource: string,
  regenerateCmd: string,
  drift: boolean,
  editedSidecar: boolean,
): string {
  const intro = editedSidecar
    ? "Heads-up: this is a sidecar marker for a generated file. Edits here " +
      "are silently lost on the next render.\n\n"
    : "Heads-up: this is a generated file. Edits here are silently lost on " +
      "the next render.\n\n";
  const driftNote = drift ? DRIFT_NOTE : "";
  return (
    `${intro}` +
    `Source template: ${absSource}\n` +
    `Regenerate with: ${regenerateCmd}\n\n` +
    "(Source identified from this file's `.managed-file-dont-edit` " +
    `sidecar.)${driftNote}`
  );
}

const DRIFT_NOTE =
  "\n\nDrift detected: this file's bytes no longer match the sidecar's " +
  "recorded sha256 — someone edited it since the last render.";

/** `keeper prompt check-generated <file> --on <mode>` runner. Always emits a
 * JSON envelope on stdout and returns 0 (informational); returns 2 only on a
 * bad --on. Mirrors run_check_generated.py run. */
export function run(
  filePathStr: string | undefined,
  onMode: string | undefined,
): number {
  if (!filePathStr) {
    process.stdout.write(`${JSON.stringify({ marked: false })}\n`);
    return 0;
  }

  const modeFlag = (onMode ?? "write").toLowerCase();
  if (modeFlag !== "read" && modeFlag !== "write") {
    process.stderr.write(
      `Error: --on must be 'read' or 'write', got '${modeFlag}'\n`,
    );
    return 2;
  }
  const outputMode = modeFlag === "read" ? "warn" : "block";

  const editedSidecar = basename(filePathStr).endsWith(SIDECAR_SUFFIX);
  const [primary, sidecarData] = resolveManaged(filePathStr);

  // No sidecar (and not a sidecar itself) -> unmanaged. Pass through.
  if (primary === null) {
    process.stdout.write(`${JSON.stringify({ marked: false })}\n`);
    return 0;
  }

  let sourceRelative = "";
  let expectedSha: string | null = null;
  if (sidecarData !== null) {
    const sourceValue = sidecarData.source_template;
    if (typeof sourceValue === "string" && sourceValue.trim()) {
      sourceRelative = sourceValue.trim();
    }
    const shaValue = sidecarData.sha256;
    if (typeof shaValue === "string" && shaValue.trim()) {
      expectedSha = shaValue.trim();
    }
  }

  if (!sourceRelative && !editedSidecar) {
    // Sidecar exists but has no usable source_template — treat as unmanaged
    // rather than block on a broken contract.
    process.stdout.write(`${JSON.stringify({ marked: false })}\n`);
    return 0;
  }

  const projectRoot = resolveProjectRoot(filePathStr);
  if (projectRoot === null) {
    // No .git anywhere above the target — treat as unmarked; the marker is
    // meaningless without a project root, and the hook fires on EVERY rw.
    process.stdout.write(`${JSON.stringify({ marked: false })}\n`);
    return 0;
  }

  const absSource = sourceRelative
    ? resolve(join(projectRoot, sourceRelative))
    : "(source template unknown)";
  const regenerateCmd =
    validatedRegenerateCmd(sidecarData?.regenerate_cmd) ??
    `keeper prompt render-plugin-templates --project-root ${projectRoot}`;

  const drift = !editedSidecar && detectDrift(primary, expectedSha);

  const message =
    outputMode === "block"
      ? buildBlockMessage(absSource, regenerateCmd, drift, editedSidecar)
      : buildWarnMessage(absSource, regenerateCmd, drift, editedSidecar);

  const envelope = {
    marked: true,
    mode: outputMode,
    source_template: absSource,
    source_template_relative: sourceRelative,
    regenerate_cmd: regenerateCmd,
    drift,
    message,
  };
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  return 0;
}

function validatedRegenerateCmd(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    value.trim() !== value ||
    /[\0\r\n]/.test(value)
  ) {
    return null;
  }
  return /^keeper prompt compile --(?:role|bundle) [a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]* --target (?:pi|claude)$/.test(
    value,
  )
    ? value
    : null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
