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

import { compactJson, type OutputFormat } from "./format.ts";
import { buildPlanctlInvocationReadonly } from "./invocation.ts";
import { resolveProject } from "./project.ts";
import { runBlock } from "./verbs/block.ts";
import { runClaim } from "./verbs/claim.ts";
import { runDetect } from "./verbs/detect.ts";
import { runEpics } from "./verbs/epics.ts";
import { runStatePath } from "./verbs/state_path.ts";
import { runStatus } from "./verbs/status.ts";

// Re-export the emit seam from its module so existing importers keep their
// import site; the definitions live in src/emit.ts.
export { emitMutating, emitReadonly } from "./emit.ts";

const PROG = "planctl";
const USAGE = `Usage: ${PROG} [OPTIONS] COMMAND [ARGS]...`;

// Verbs that own their stdout contract and must bypass the trailer (raw markdown
// / non-standard envelopes). Mirrors cli.py _NO_TRACK_COMMANDS.
const NO_TRACK_COMMANDS = new Set(["cat", "validate"]);

// Verbs that emit their OWN envelope with the planctl_invocation embedded
// (claim/block via emitReadonly; done/init via emitMutating) — the generic
// trailer must never fire on top. Mirrors cli.py's INVOCATION_EMITTED_SENTINEL.
const SELF_EMITTING_COMMANDS = new Set(["claim", "block"]);

interface CommandSpec {
  name: string;
  shortHelp: string;
  implemented: boolean;
}

// Registration order = help-listing order (alphabetical, matching click).
const COMMANDS: CommandSpec[] = [
  { name: "block", shortHelp: "Mark a task as blocked.", implemented: true },
  {
    name: "claim",
    shortHelp: "Claim a task and return the worker briefing.",
    implemented: true,
  },
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
    case "claim":
      runClaim({
        taskId: readPositional(rest),
        force: readFlag(rest, "--force"),
        note: readOption(rest, "--note"),
        project: readOption(rest, "--project"),
        format,
      });
      break;
    case "block":
      runBlock({
        taskId: readPositional(rest),
        reason: readOption(rest, "--reason"),
        reasonFile: readOption(rest, "--reason-file"),
        format,
      });
      break;
    default:
      noSuchCommand(command);
  }

  // claim/block emit their own envelope (with the readonly invocation embedded);
  // the generic trailer must not fire on top of it.
  if (!NO_TRACK_COMMANDS.has(command) && !SELF_EMITTING_COMMANDS.has(command)) {
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

/** True iff the boolean flag `name` is present in the remaining args. */
function readFlag(rest: string[], name: string): boolean {
  return rest.includes(name);
}

/** The first positional (non-`--`-prefixed) arg, or "" when absent. A value
 * immediately following a known value-taking option is skipped so it is not
 * mistaken for the positional. */
function readPositional(rest: string[]): string {
  const valueTaking = new Set([
    "--note",
    "--project",
    "--reason",
    "--reason-file",
  ]);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (arg.startsWith("--")) {
      // `--name=value` is self-contained; `--name value` consumes the next arg.
      if (!arg.includes("=") && valueTaking.has(arg)) {
        i += 1;
      }
      continue;
    }
    return arg;
  }
  return "";
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
