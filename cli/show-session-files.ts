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
 * `--session-id` is REQUIRED (matches the Python's `required=True`); `--cwd`
 * defaults to `$PWD`. No session-id auto-resolution here — the caller always
 * supplies it explicitly.
 */

import { getSessionDirtyFiles } from "../src/commit-work/attribution";

const HELP = `keeper session files --session-id <id> [options]

Emit the session's Claude-mutated files still dirty in git, grouped by repo, as
a pretty JSON envelope \`{files_by_repo, cwd_repo}\`. Thin pass-through over the
attribution reader — the .keeper/ board is NOT excluded here (exclusion-agnostic shape).

Options:
  --session-id <id>    Claude Code session id (REQUIRED)
  --cwd <dir>          Working directory for cwd_repo resolution (default $PWD)
  --help, -h           Show this help
`;

interface ParsedArgs {
  sessionId: string | null;
  cwd: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { sessionId: null, cwd: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      parsed.help = true;
    } else if (a === "--session-id") {
      parsed.sessionId = argv[++i] ?? null;
    } else if (a.startsWith("--session-id=")) {
      parsed.sessionId = a.slice("--session-id=".length);
    } else if (a === "--cwd") {
      parsed.cwd = argv[++i] ?? null;
    } else if (a.startsWith("--cwd=")) {
      parsed.cwd = a.slice("--cwd=".length);
    } else {
      process.stderr.write(
        `keeper session files: unexpected argument '${a}'\n`,
      );
      process.exit(2);
    }
  }
  return parsed;
}

/** Emit a pretty (`indent=2`, trailing `\n`) JSON envelope. */
function printPretty(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function main(argv: string[]): void {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.sessionId === null) {
    process.stderr.write("keeper session files: --session-id is required\n\n");
    process.stderr.write(HELP);
    process.exit(2);
  }
  const cwd = args.cwd ?? process.cwd();
  const { filesByRepo, cwdRepo } = getSessionDirtyFiles(args.sessionId, cwd);
  // Re-key to the Python snake_case wire shape (NO `success` field — the
  // reader dict is returned verbatim by the Python).
  printPretty({ files_by_repo: filesByRepo, cwd_repo: cwdRepo });
}

if (import.meta.main) {
  main(Bun.argv.slice(3));
}
