#!/usr/bin/env bun
/**
 * `keeper session files` — emit the session's on-hook dirty files grouped
 * by repo as a pretty JSON envelope. The native port of jobctl's
 * `run_show_session_files.py` (epic fn-715 task 3).
 *
 * A THIN pass-through over task 1's attribution reader (`getSessionDirtyFiles`,
 * the exclusion-AGNOSTIC shape) — parity with the `{job.files_mutated}` Stop
 * advice template var. The envelope is the Python `get_session_dirty_files`
 * dict verbatim: `{files_by_repo, cwd_repo}` with **snake_case keys and NO
 * `success` field** (the Python returns the reader dict straight to
 * `format_output`, which never adds a `success` key). The TS reader returns
 * camelCase (`filesByRepo`/`cwdRepo`), so this verb re-keys to the snake_case
 * wire shape for byte-parity.
 *
 * A Session reference is required; this verb never had ambient auto-detection.
 * The resolved Harness session must map to exactly one Keeper job because file
 * attribution is keyed by job id.
 */

import {
  type AttributionDeps,
  getSessionDirtyFiles,
} from "../src/commit-work/attribution";
import {
  type EnvelopeSink,
  emitEnvelope,
  errorEnvelope,
  processEnvelopeSink,
} from "./envelope";
import {
  resolveTrackedCliSession,
  type SessionReferenceCliDeps,
  trackedSessionProblem,
} from "./session-reference";

export const SESSION_FILES_SCHEMA_VERSION = 1;

const HELP = `keeper session files <session-reference> [options]

Emit one tracked Session's on-hook dirty files grouped by repo. The reference
may be a qualified native id, exact job/native id, or exact current/historical
title. The success payload remains \`{files_by_repo, cwd_repo}\`.

Options:
  --session <ref>       Shared Session reference (alternative to positional)
  --session-id <ref>    Compatibility alias of --session
  --cwd <dir>           Working directory for cwd_repo resolution (default $PWD)
  --help, -h            Show this help
`;

export interface SessionFilesDeps extends SessionReferenceCliDeps {
  attribution?: AttributionDeps;
}

interface ParsedArgs {
  sessionReference: string | null;
  cwd: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    sessionReference: null,
    cwd: null,
    help: false,
  };
  const setReference = (value: string | undefined, spelling: string): void => {
    if (value === undefined || value.length === 0) {
      process.stderr.write(
        `keeper session files: ${spelling} requires a value\n`,
      );
      process.exit(2);
    }
    if (parsed.sessionReference !== null) {
      process.stderr.write(
        "keeper session files: specify the Session reference only once\n",
      );
      process.exit(2);
    }
    parsed.sessionReference = value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--help" || a === "-h") {
      parsed.help = true;
    } else if (a === "--session" || a === "--session-id") {
      setReference(argv[++i], a);
    } else if (a.startsWith("--session=") || a.startsWith("--session-id=")) {
      const spelling = a.startsWith("--session-id=")
        ? "--session-id"
        : "--session";
      setReference(a.slice(a.indexOf("=") + 1), spelling);
    } else if (a === "--cwd") {
      parsed.cwd = argv[++i] ?? null;
    } else if (a.startsWith("--cwd=")) {
      parsed.cwd = a.slice("--cwd=".length);
    } else if (!a.startsWith("-")) {
      setReference(a, "<session-reference>");
    } else {
      process.stderr.write(
        `keeper session files: unexpected argument '${a}'\n`,
      );
      process.exit(2);
    }
  }
  return parsed;
}

export function main(
  argv: string[],
  deps: SessionFilesDeps = {},
  sink: EnvelopeSink = processEnvelopeSink,
): void {
  const args = parseArgs(argv);
  if (args.help) {
    sink.writeStdout(HELP);
    return;
  }
  if (args.sessionReference === null) {
    process.stderr.write(
      "keeper session files: <session-reference> or --session is required\n\n",
    );
    process.stderr.write(HELP);
    process.exit(2);
  }
  const resolution = resolveTrackedCliSession(args.sessionReference, deps);
  if (resolution.kind !== "resolved") {
    emitEnvelope(
      errorEnvelope(
        SESSION_FILES_SCHEMA_VERSION,
        trackedSessionProblem(resolution),
      ),
      sink,
    );
    return;
  }
  const cwd = args.cwd ?? process.cwd();
  try {
    const attribution =
      deps.dbPath !== undefined && deps.attribution?.dbPath === undefined
        ? { ...deps.attribution, dbPath: deps.dbPath }
        : deps.attribution;
    const { filesByRepo, cwdRepo } = getSessionDirtyFiles(
      resolution.job.jobId,
      cwd,
      attribution,
    );
    // Preserve the established snake_case success payload; only targeting and
    // typed failures move onto the shared Session contract in this slice.
    sink.writeStdout(
      `${JSON.stringify({ files_by_repo: filesByRepo, cwd_repo: cwdRepo }, null, 2)}\n`,
    );
  } catch {
    emitEnvelope(
      errorEnvelope(SESSION_FILES_SCHEMA_VERSION, {
        code: "read_failed",
        message: "could not read file attribution for the resolved Keeper job",
        recovery:
          "Retry the read; it opens keeper.db and git state read-only and never mutates either.",
      }),
      sink,
    );
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(3));
}
