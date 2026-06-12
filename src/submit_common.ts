// Shared plumbing for the close-phase submit verbs — the byte-parity port of
// planctl/submit_common.py (audit/verdict/followup submit).
//
// The three submit verbs share the same skeleton: resolve the owning planctl
// project (cwd-walk or --project), read the payload under a 1 MiB byte cap, load
// the on-disk audit brief to stamp commit_set_hash + schema_version (a typed
// error when the brief is missing — close-preflight runs first), then persist
// commit-free via writeArtifact. They are runtime-state-only verbs (like claim /
// close-preflight): they mutate only gitignored state/audits/ and draw NO
// `.planctl/` commit.
//
// This module owns the bits common to all three: the byte-cap payload reader,
// the brief loader + schema gate, the project resolver, and the typed error
// emitter. Each verb's own run module owns its payload validation + envelope.

import { existsSync, readFileSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import {
  ArtifactSchemaTooNewError,
  AUDIT_SCHEMA_VERSION,
  briefPath,
} from "./audit_artifacts.ts";
import { formatOutput, type OutputFormat } from "./format.ts";
import { isEpicId, isTaskId } from "./ids.ts";
import { type ProjectContext, resolveProject } from "./project.ts";

/** Same 1 MiB stdin cap scaffold uses against a YAML billion-laughs DoS. A real
 * audit report / verdict / follow-up plan is a few KB; 1 MiB is generous.
 * Mirrors submit_common.MAX_STDIN_BYTES. */
export const MAX_STDIN_BYTES = 1 * 1024 * 1024;

/** A typed submit-error condition: code / human message / optional details,
 * carried as a throw so callers route it onto emitSubmitError at the verb
 * boundary (Python's emit_submit_error calls sys.exit directly; the bun port
 * keeps the exit at the CLI seam so the spine stays testable). */
export class SubmitError extends Error {
  readonly code: string;
  readonly details: unknown | undefined;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "SubmitError";
    this.code = code;
    this.details = details;
  }
}

/** Emit a typed submit error envelope and exit 1.
 *
 * Shape `{"success": false, "error": {"code", "message", "details?"}}` — the
 * house single-fetch error shape (claim / close-preflight). Routes through
 * formatOutput so `--format yaml` renders YAML. Mirrors emit_submit_error. */
export function emitSubmitError(
  code: string,
  message: string,
  format: OutputFormat | null,
  details?: unknown,
): never {
  const error: Record<string, unknown> = { code, message };
  if (details !== undefined) {
    error.details = details;
  }
  formatOutput({ success: false, error }, format);
  process.exit(1);
}

/** Read the payload from `fileArg` (or stdin on `-`) under the byte cap.
 *
 * Reads raw bytes pre-decode so the cap counts wire bytes, not post-newline
 * text. `-` reads stdin (a TTY stdin is rejected — a submit verb is always
 * piped); any other value is a file path. Over-cap and non-UTF-8 throw a typed
 * PAYLOAD_TOO_LARGE / BAD_ENCODING SubmitError; an unreadable file or TTY stdin
 * throws NO_STDIN. Mirrors read_payload_capped. */
export function readPayloadCapped(fileArg: string, label: string): string {
  let raw: Buffer;
  if (fileArg === "-") {
    if (process.stdin.isTTY) {
      throw new SubmitError(
        "NO_STDIN",
        `stdin is a TTY — pipe the ${label} on stdin (pass \`--file -\`)`,
      );
    }
    try {
      // Read MAX+1 bytes off fd 0 (reject-don't-truncate): an over-cap stream
      // reports got=MAX+1 no matter how much was piped, matching
      // sys.stdin.buffer.read(MAX_STDIN_BYTES + 1).
      raw = readCappedFd(0, MAX_STDIN_BYTES + 1);
    } catch (exc) {
      throw new SubmitError(
        "NO_STDIN",
        `could not read ${label} from stdin: ${describeError(exc)}`,
      );
    }
  } else {
    try {
      raw = readFileSync(fileArg);
    } catch (exc) {
      throw new SubmitError(
        "NO_STDIN",
        `could not read ${label} file ${fileArg}: ${describeError(exc)}`,
      );
    }
  }

  if (raw.length > MAX_STDIN_BYTES) {
    throw new SubmitError(
      "PAYLOAD_TOO_LARGE",
      `${label} exceeds ${MAX_STDIN_BYTES} bytes (got ${raw.length})`,
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch (exc) {
    throw new SubmitError(
      "BAD_ENCODING",
      `${label} is not valid UTF-8: ${describeError(exc)}`,
    );
  }
}

export interface AuditContext {
  primaryRepo: string;
  brief: Record<string, unknown>;
}

/** Resolve the project + load the on-disk brief for `epicId`.
 *
 * Returns `{primaryRepo, brief}` where `primaryRepo` is the resolved absolute
 * state-repo path (from the brief, which close-preflight stamped) and `brief` is
 * the parsed `audits/<epic_id>/brief.json` dict.
 *
 * Typed errors (thrown as SubmitError): BAD_EPIC_ID (garbage / task-shaped id),
 * NOT_A_PROJECT (`--project` path has no .planctl/), BRIEF_MISSING (no brief —
 * run close-preflight first), BRIEF_CORRUPT (unparseable JSON or a too-new
 * schema_version). Mirrors resolve_audit_context. */
export function resolveAuditContext(
  epicId: string,
  project: string | null,
  format: OutputFormat | null,
): AuditContext {
  if (!isEpicId(epicId)) {
    if (isTaskId(epicId)) {
      const parent = epicId.slice(0, epicId.lastIndexOf("."));
      throw new SubmitError(
        "BAD_EPIC_ID",
        `close operates on epics, not tasks — parent epic is ${parent}`,
        { task_id: epicId, parent_epic: parent },
      );
    }
    throw new SubmitError("BAD_EPIC_ID", `Invalid epic ID: ${epicId}`);
  }

  let ctx: ProjectContext;
  if (project !== null) {
    if (!isAbsolute(expandUser(project))) {
      // Mirrors click.UsageError — surfaced via the same SubmitError channel
      // (the CLI seam maps UsageError shape separately, but the spine flags it).
      throw new SubmitError(
        "BAD_PROJECT_PATH",
        `--project requires an absolute path, got: ${project}`,
      );
    }
    const projectRoot = resolveResolved(expandUser(project));
    if (!existsSync(join(projectRoot, ".planctl"))) {
      throw new SubmitError(
        "NOT_A_PROJECT",
        `No planctl project found at ${projectRoot}. Run 'planctl init' first.`,
      );
    }
    const planctlDir = join(projectRoot, ".planctl");
    ctx = {
      name: basename(projectRoot),
      dataDir: planctlDir,
      stateDir: join(planctlDir, "state"),
      projectPath: projectRoot,
    };
  } else {
    ctx = resolveProject(format);
  }

  // The brief's primary_repo is the authoritative state repo (close-preflight
  // stamped it from epic.primary_repo). Resolve the brief path against the
  // project's own path to FIND it, then trust the brief's value.
  const bp = briefPath(ctx.projectPath, epicId);
  if (!existsSync(bp)) {
    throw new SubmitError(
      "BRIEF_MISSING",
      `no audit brief for ${epicId} at ${bp}; ` +
        `run \`planctl close-preflight ${epicId}\` first`,
      { expected: bp },
    );
  }
  let brief: Record<string, unknown>;
  try {
    brief = JSON.parse(readFileSync(bp, "utf-8")) as Record<string, unknown>;
  } catch (exc) {
    throw new SubmitError(
      "BRIEF_CORRUPT",
      `could not read brief ${bp}: ${describeError(exc)}`,
    );
  }

  const foundVersion = brief.schema_version;
  if (
    typeof foundVersion === "number" &&
    Number.isInteger(foundVersion) &&
    foundVersion > AUDIT_SCHEMA_VERSION
  ) {
    const exc = new ArtifactSchemaTooNewError(foundVersion);
    throw new SubmitError("BRIEF_CORRUPT", exc.message, {
      found: exc.found,
      known: exc.known,
    });
  }

  const primaryRaw = brief.primary_repo;
  const primaryRepo = resolveResolved(
    typeof primaryRaw === "string" && primaryRaw ? primaryRaw : ctx.projectPath,
  );
  return { primaryRepo, brief };
}

/** Read up to `cap` bytes from `fd` by chunked accumulation. Stops at EOF or
 * once `cap` bytes are in hand — the reject-don't-truncate contract. */
function readCappedFd(fd: number, cap: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  const bufSize = 64 * 1024;
  const buf = Buffer.allocUnsafe(bufSize);
  while (total < cap) {
    const want = Math.min(bufSize, cap - total);
    let n: number;
    try {
      n = readSync(fd, buf, 0, want, null);
    } catch (exc) {
      if (isEof(exc)) {
        break;
      }
      throw exc;
    }
    if (n === 0) {
      break;
    }
    chunks.push(Buffer.from(buf.subarray(0, n)));
    total += n;
  }
  return Buffer.concat(chunks, total);
}

function isEof(exc: unknown): boolean {
  return (
    typeof exc === "object" &&
    exc !== null &&
    (exc as { code?: string }).code === "EOF"
  );
}

function expandUser(pathArg: string): string {
  if (pathArg === "~" || pathArg.startsWith("~/")) {
    return (process.env.HOME ?? "") + pathArg.slice(1);
  }
  return pathArg;
}

function resolveResolved(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] as string) : path;
}

function describeError(exc: unknown): string {
  if (exc instanceof Error) {
    return exc.message;
  }
  return String(exc);
}
