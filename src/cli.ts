// planctl-bun CLI dispatch — the read-only-subset entry point.
//
// Hand-rolled dispatch reproducing the click conventions the conformance harness
// pins: top-level `--format json|yaml|human` plumbed to every verb (both
// positions), `--help` on stdout (exit 0) with a Commands section, and an
// unknown-command error on stderr (exit 2) shaped like click's "No such command".
//
// state-path / detect / status / epics are implemented end-to-end. After a
// read-only verb runs, the trailing planctl_invocation NDJSON line is emitted by
// re-resolving the project (mirroring cli.py's _emit_readonly_invocation): a
// genuine resolve failure is swallowed, but a missing-project resolve raises the
// error envelope + exit 1 inline (the contract for detect's found-false tail).
// The trailer is suppressed for the cat/validate contract verbs by name.

import { autoCommitFromInvocation, CommitFailed } from "./commit.ts";
import { compactJson, type OutputFormat } from "./format.ts";
import {
  buildPlanctlInvocation,
  buildPlanctlInvocationReadonly,
} from "./invocation.ts";
import { resolveProject } from "./project.ts";
import { runDetect } from "./verbs/detect.ts";
import { runEpics } from "./verbs/epics.ts";
import { runStatePath } from "./verbs/state_path.ts";
import { runStatus } from "./verbs/status.ts";

const PROG = "planctl";
const USAGE = `Usage: ${PROG} [OPTIONS] COMMAND [ARGS]...`;

// Verbs that own their stdout contract and must bypass the trailer (raw markdown
// / non-standard envelopes). Mirrors cli.py _NO_TRACK_COMMANDS.
const NO_TRACK_COMMANDS = new Set(["cat", "validate"]);

interface CommandSpec {
  name: string;
  shortHelp: string;
  implemented: boolean;
}

// Registration order = help-listing order (alphabetical, matching click).
const COMMANDS: CommandSpec[] = [
  {
    name: "detect",
    shortHelp: "Check if cwd belongs to a planctl project.",
    implemented: true,
  },
  { name: "epics", shortHelp: "List all epics.", implemented: true },
  {
    name: "state-path",
    shortHelp: "Print the resolved state directory path.",
    implemented: true,
  },
  {
    name: "status",
    shortHelp: "Show overall project status.",
    implemented: true,
  },
];

const DESCRIPTION =
  "File-based task tracking for structured development workflows.";

interface ParsedArgs {
  format: OutputFormat | null;
  help: boolean;
  command: string | null;
  rest: string[];
}

/** Split argv into the top-level --format/--help and the command + its args.
 * --format is accepted before OR after the command name. */
function parseArgs(argv: string[]): ParsedArgs {
  let format: OutputFormat | null = null;
  let help = false;
  let command: string | null = null;
  const rest: string[] = [];

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i] as string;
    if (command === null) {
      if (arg === "--help") {
        help = true;
        i += 1;
      } else if (arg === "--format") {
        format = readFormat(argv[i + 1]);
        i += 2;
      } else if (arg.startsWith("--format=")) {
        format = readFormat(arg.slice("--format=".length));
        i += 1;
      } else if (arg.startsWith("-")) {
        unknownOption(arg);
      } else {
        command = arg;
        i += 1;
      }
    } else {
      // After the command name, still intercept the global --format/--help.
      if (arg === "--format") {
        format = readFormat(argv[i + 1]);
        i += 2;
      } else if (arg.startsWith("--format=")) {
        format = readFormat(arg.slice("--format=".length));
        i += 1;
      } else if (arg === "--help") {
        help = true;
        i += 1;
      } else {
        rest.push(arg);
        i += 1;
      }
    }
  }

  return { format, help, command, rest };
}

function readFormat(value: string | undefined): OutputFormat {
  if (value === "json" || value === "yaml" || value === "human") {
    return value;
  }
  usageError(
    `Invalid value for '--format': '${value ?? ""}' is not one of 'json', 'yaml', 'human'.`,
  );
}

function unknownOption(arg: string): never {
  usageError(`No such option: ${arg}`);
}

/** click's no-such-command error: usage + try-help on stderr, exit 2. */
function noSuchCommand(name: string): never {
  process.stderr.write(`${USAGE}\n`);
  process.stderr.write(`Try '${PROG} --help' for help.\n\n`);
  process.stderr.write(`Error: No such command '${name}'.\n`);
  process.exit(2);
}

function usageError(message: string): never {
  process.stderr.write(`${USAGE}\n`);
  process.stderr.write(`Try '${PROG} --help' for help.\n\n`);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(2);
}

function printHelp(): void {
  const lines: string[] = [];
  lines.push(USAGE);
  lines.push("");
  lines.push(`  ${DESCRIPTION}`);
  lines.push("");
  lines.push("Options:");
  lines.push("  --format [json|yaml|human]  Output format (default: json)");
  lines.push("  --help                      Show this message and exit.");
  lines.push("");
  lines.push("Commands:");
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  for (const cmd of COMMANDS) {
    lines.push(`  ${cmd.name.padEnd(width)}  ${cmd.shortHelp}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

/** Emit the trailing read-only planctl_invocation NDJSON line by re-resolving
 * the project — the port of cli.py:_emit_readonly_invocation. resolveProject
 * raises the missing-project error envelope + exit 1 when no `.planctl/`
 * resolves (terminating before any trailer prints); a genuine non-exit failure
 * is swallowed so a tracing side-effect never breaks the CLI. */
function emitTrailer(verb: string, format: OutputFormat | null): void {
  const ctx = resolveProject(format);
  try {
    const envelope = {
      planctl_invocation: buildPlanctlInvocationReadonly(verb, ctx.projectPath),
    };
    process.stdout.write(`${compactJson(envelope)}\n`);
  } catch {
    // Never fail the CLI over a tracing side-effect.
  }
}

/** The committing-seam emit path for mutating verbs — the port of
 * output.emit()'s mutating branch and the runner's commit ordering. Build the
 * planctl_invocation (a fail-closed session id or a bad touched-path throws,
 * surfacing verbatim), run the auto-commit BEFORE printing, then:
 *  - on a commit failure, print ONE compact line
 *    {"success":false,"error":"commit_failed","details":...,"planctl_invocation":...}
 *    and process.exit(1) — the success envelope is NEVER printed;
 *  - on success, embed the invocation under planctl_invocation and print ONE
 *    compact NDJSON line {"success":true, ...data, planctl_invocation}.
 * Mutating verbs never print the read-only trailer — this path replaces it. */
export function emitMutating(
  data: Record<string, unknown>,
  opts: {
    verb: string;
    target: string;
    detail?: string | null;
    repoRoot: string;
    primaryRepo?: string | null;
    queueJump?: boolean;
  },
): void {
  // Build the invocation FIRST — a fail-closed session id or a path-traversal
  // touched-path throws here and surfaces verbatim (no commit attempted).
  const invocation = buildPlanctlInvocation(
    opts.verb,
    opts.target,
    opts.detail,
    {
      repoRoot: opts.repoRoot,
      primaryRepo: opts.primaryRepo,
      queueJump: opts.queueJump,
    },
  );

  // Per-verb auto-commit BEFORE the success envelope prints, so an envelope
  // success:true on stdout is the authoritative signal that the .planctl/ commit
  // landed. On a hard failure, emit the compact failure envelope and exit 1.
  try {
    autoCommitFromInvocation(invocation);
  } catch (exc) {
    if (!(exc instanceof CommitFailed)) {
      throw exc;
    }
    const failure = {
      success: false,
      error: "commit_failed",
      details: {
        error: exc.error,
        message: exc.detail,
        ...exc.extra,
      },
      planctl_invocation: invocation,
    };
    process.stdout.write(`${compactJson(failure)}\n`);
    process.exit(1);
  }

  const envelope = {
    success: true,
    ...data,
    planctl_invocation: invocation,
  };
  process.stdout.write(`${compactJson(envelope)}\n`);
}

function dispatch(parsed: ParsedArgs): number {
  const { command, format, rest } = parsed;
  if (command === null) {
    printHelp();
    return 0;
  }

  const spec = COMMANDS.find((c) => c.name === command);
  if (spec === undefined) {
    noSuchCommand(command);
  }

  switch (command) {
    case "state-path": {
      const taskId = readOption(rest, "--task");
      runStatePath(format, taskId);
      break;
    }
    case "detect":
      runDetect(format);
      break;
    case "status":
      runStatus(format);
      break;
    case "epics":
      runEpics(format);
      break;
    default:
      noSuchCommand(command);
  }

  if (!NO_TRACK_COMMANDS.has(command)) {
    emitTrailer(command, format);
  }
  return 0;
}

/** Read a `--name value` / `--name=value` option from the remaining args. */
function readOption(rest: string[], name: string): string | null {
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (arg === name) {
      return rest[i + 1] ?? null;
    }
    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
  }
  return null;
}

export function main(argv: string[]): number {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    printHelp();
    return 0;
  }
  return dispatch(parsed);
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
