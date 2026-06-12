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

import { didSelfEmit } from "./emit.ts";
import { compactJson, type OutputFormat } from "./format.ts";
import { buildPlanctlInvocationReadonly } from "./invocation.ts";
import { resolveProject } from "./project.ts";
import {
  dispatchGroup,
  type GroupSpec,
  type SubcommandSpec,
} from "./subgroup.ts";
import { runBlock } from "./verbs/block.ts";
import { runClaim } from "./verbs/claim.ts";
import { runDetect } from "./verbs/detect.ts";
import { runDone } from "./verbs/done.ts";
import { runEpics } from "./verbs/epics.ts";
import { runInit } from "./verbs/init.ts";
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

// Subgroups ("planctl <group> <sub>"). A subgroup owns its own --help and
// subcommand dispatch, so post-command --help is routed to the group, not the
// top-level help.
const SUBGROUP_NAMES = new Set(["epic", "task"]);

// Whether a verb already printed its own planctl_invocation-bearing envelope is
// a RUNTIME fact (claim/block via emitReadonly, done via emitMutating always
// self-emit; init self-emits only on its committing path). The dispatcher reads
// the didSelfEmit() sentinel after the verb runs — the port of cli.py's
// INVOCATION_EMITTED_SENTINEL — rather than a static name set.

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
  { name: "done", shortHelp: "Mark a task as complete.", implemented: true },
  { name: "epic", shortHelp: "Manage epics.", implemented: true },
  { name: "epics", shortHelp: "List all epics.", implemented: true },
  {
    name: "init",
    shortHelp: "Initialize a planctl project for the current directory.",
    implemented: true,
  },
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
  { name: "task", shortHelp: "Manage tasks.", implemented: true },
];

const DESCRIPTION =
  "File-based task tracking for structured development workflows.";

// Leaf runner placeholder for a subcommand whose verb lands in a later wave
// task. The dispatch table + group help are the spine this task ships; the
// real runners replace this stub as each verb is ported. Registering the name
// keeps `<group> --help` listing it (click lists the command regardless of
// whether its callback is implemented) and routes an unknown sub to exit 2.
function notImplemented(verb: string): SubcommandSpec["run"] {
  return () => {
    process.stderr.write(`Error: ${verb} is not yet implemented.\n`);
    process.exit(2);
  };
}

// Subgroups registered in click's alphabetical list_commands order. The in-wave
// leaves carry a notImplemented stub until their porting task lands a runner;
// the short helps match the Python binary's collapsed short_help so group help
// is byte-faithful once the full command set is present.
const EPIC_GROUP: GroupSpec = {
  name: "epic",
  description: "Manage epics.",
  commands: [
    {
      name: "add-dep",
      shortHelp: "Add an epic-level dependency.",
      run: notImplemented("epic add-dep"),
    },
    {
      name: "add-deps",
      shortHelp:
        "Batch-wire N epic-level dependency edges (idempotent per edge).",
      run: notImplemented("epic add-deps"),
    },
    {
      name: "invalidate",
      shortHelp:
        "Clear validation marker (force re-validate on next validate run).",
      run: notImplemented("epic invalidate"),
    },
    {
      name: "queue-jump",
      shortHelp:
        "Flip queue_jump=true so the epic sorts to the front of the board (/plan:next).",
      run: notImplemented("epic queue-jump"),
    },
    {
      name: "rm-dep",
      shortHelp: "Remove an epic-level dependency.",
      run: notImplemented("epic rm-dep"),
    },
    {
      name: "set-branch",
      shortHelp: "Set the branch name on an epic.",
      run: notImplemented("epic set-branch"),
    },
    {
      name: "set-primary-repo",
      shortHelp: "Set the primary_repo path on an epic (metadata only).",
      run: notImplemented("epic set-primary-repo"),
    },
    {
      name: "set-title",
      shortHelp: "Rename an epic (ID remains unchanged).",
      run: notImplemented("epic set-title"),
    },
    {
      name: "set-touched-repos",
      shortHelp: "Replace the touched_repos list on an epic.",
      run: notImplemented("epic set-touched-repos"),
    },
  ],
};

const TASK_GROUP: GroupSpec = {
  name: "task",
  description: "Manage tasks.",
  commands: [
    {
      name: "reset",
      shortHelp: "Reset a task to todo status.",
      run: notImplemented("task reset"),
    },
    {
      name: "set-acceptance",
      shortHelp: "Set or replace the Acceptance section of a task spec.",
      run: notImplemented("task set-acceptance"),
    },
    {
      name: "set-description",
      shortHelp: "Set or replace the Description section of a task spec.",
      run: notImplemented("task set-description"),
    },
    {
      name: "set-target-repo",
      shortHelp: "Set the target_repo path on a task.",
      run: notImplemented("task set-target-repo"),
    },
    {
      name: "set-tier",
      shortHelp: "Persist the worker reasoning tier on a task.",
      run: notImplemented("task set-tier"),
    },
  ],
};

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
      // A subgroup owns its OWN --help (group help), so for epic/task the flag
      // is left in `rest` for dispatchGroup to render the group help.
      if (arg === "--format") {
        format = readFormat(argv[i + 1]);
        i += 2;
      } else if (arg.startsWith("--format=")) {
        format = readFormat(arg.slice("--format=".length));
        i += 1;
      } else if (arg === "--help" && !SUBGROUP_NAMES.has(command)) {
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
    case "done":
      runDone({
        taskId: readPositional(rest),
        summary: readOption(rest, "--summary"),
        evidence: readOption(rest, "--evidence"),
        force: readFlag(rest, "--force"),
        format,
      });
      break;
    case "init":
      runInit({ format });
      break;
    case "epic":
      // Subgroup: dispatch the leaf (or group help). The leaf owns its own
      // invocation tracking, so the parent never fires the generic trailer.
      dispatchGroup(EPIC_GROUP, rest, format);
      return 0;
    case "task":
      dispatchGroup(TASK_GROUP, rest, format);
      return 0;
    default:
      noSuchCommand(command);
  }

  // A self-emitting verb (claim/block/done always; init on its committing path)
  // already printed its invocation-bearing envelope — the generic trailer must
  // not fire on top. didSelfEmit() is the runtime sentinel.
  if (!NO_TRACK_COMMANDS.has(command) && !didSelfEmit()) {
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
    "--summary",
    "--evidence",
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
