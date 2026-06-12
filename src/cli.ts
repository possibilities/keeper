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
import { dispatchGroup, type GroupSpec } from "./subgroup.ts";
import { runBlock } from "./verbs/block.ts";
import { runCat } from "./verbs/cat.ts";
import { runClaim } from "./verbs/claim.ts";
import { runDetect } from "./verbs/detect.ts";
import { runDone } from "./verbs/done.ts";
import { runEpicAddDeps } from "./verbs/epic_add_deps.ts";
import { runEpicAddDep, runEpicRmDep } from "./verbs/epic_dep_edit.ts";
import { runEpicSetBranch, runEpicSetTitle } from "./verbs/epic_set_plain.ts";
import {
  runEpicSetPrimaryRepo,
  runEpicSetTouchedRepos,
} from "./verbs/epic_set_repos.ts";
import {
  runEpicInvalidate,
  runEpicQueueJump,
} from "./verbs/epic_short_circuit.ts";
import { runEpics } from "./verbs/epics.ts";
import { runInit } from "./verbs/init.ts";
import { runList } from "./verbs/list.ts";
import { runReady } from "./verbs/ready.ts";
import { runRefineContext } from "./verbs/refine_context.ts";
import { runResolveTask } from "./verbs/resolve_task.ts";
import { runShow } from "./verbs/show.ts";
import { runStatePath } from "./verbs/state_path.ts";
import { runStatus } from "./verbs/status.ts";
import { runTaskReset } from "./verbs/task_reset.ts";
import {
  runTaskSetAcceptance,
  runTaskSetDescription,
} from "./verbs/task_set_section.ts";
import { runTaskSetTargetRepo } from "./verbs/task_set_target_repo.ts";
import { runTaskSetTier } from "./verbs/task_set_tier.ts";
import { runTasks } from "./verbs/tasks.ts";
import { runValidate } from "./verbs/validate.ts";

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
    name: "cat",
    shortHelp: "Print the raw spec markdown for an epic or task.",
    implemented: true,
  },
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
    name: "list",
    shortHelp: "List all epics and their tasks in a tree view.",
    implemented: true,
  },
  {
    name: "ready",
    shortHelp: "List tasks that are ready to be worked on.",
    implemented: true,
  },
  {
    name: "refine-context",
    shortHelp: "Fetch refine-state for /plan:plan (read-only).",
    implemented: true,
  },
  {
    name: "resolve-task",
    shortHelp: "Routing lookup to launch /plan:work.",
    implemented: true,
  },
  {
    name: "show",
    shortHelp: "Show detailed information about an epic or task.",
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
  {
    name: "tasks",
    shortHelp: "List tasks with optional filtering.",
    implemented: true,
  },
  {
    name: "validate",
    shortHelp: "Validate project data integrity.",
    implemented: true,
  },
];

const DESCRIPTION =
  "File-based task tracking for structured development workflows.";

// Leaf-arg parsing for subgroup verbs. A leaf receives the post-name argv (its
// own positionals + options). Options are `--name value` / `--name=value`;
// `--flag` is a bare boolean. Positionals are everything that is not an option
// or an option value. `valueTaking` lists the option names that consume the next
// token so a positional scan skips it.
function leafOption(rest: string[], name: string): string | null {
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

function leafFlag(rest: string[], name: string): boolean {
  return rest.includes(name);
}

function leafPositionals(rest: string[], valueTaking: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (arg.startsWith("--")) {
      if (!arg.includes("=") && valueTaking.has(arg)) {
        i += 1;
      }
      continue;
    }
    out.push(arg);
  }
  return out;
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
      run: (rest, format) => {
        const [epicId, depId] = leafPositionals(rest, new Set());
        runEpicAddDep({
          epicId: epicId ?? "",
          depId: depId ?? "",
          format,
        });
      },
    },
    {
      name: "add-deps",
      shortHelp:
        "Batch-wire N epic-level dependency edges (idempotent per edge).",
      run: (rest, format) => {
        const positionals = leafPositionals(rest, new Set());
        const [epicId, ...depIds] = positionals;
        runEpicAddDeps({
          epicId: epicId ?? "",
          depIds,
          skipInvalid: leafFlag(rest, "--skip-invalid"),
          format,
        });
      },
    },
    {
      name: "invalidate",
      shortHelp:
        "Clear validation marker (force re-validate on next validate run).",
      run: (rest, format) => {
        const [epicId] = leafPositionals(rest, new Set());
        runEpicInvalidate({ epicId: epicId ?? "", format });
      },
    },
    {
      name: "queue-jump",
      shortHelp:
        "Flip queue_jump=true so the epic sorts to the front of the board (/plan:next).",
      run: (rest, format) => {
        const [epicId] = leafPositionals(rest, new Set());
        runEpicQueueJump({ epicId: epicId ?? "", format });
      },
    },
    {
      name: "rm-dep",
      shortHelp: "Remove an epic-level dependency.",
      run: (rest, format) => {
        const [epicId, depId] = leafPositionals(rest, new Set());
        runEpicRmDep({
          epicId: epicId ?? "",
          depId: depId ?? "",
          format,
        });
      },
    },
    {
      name: "set-branch",
      shortHelp: "Set the branch name on an epic.",
      run: (rest, format) => {
        const [epicId] = leafPositionals(rest, new Set(["--branch"]));
        runEpicSetBranch({
          epicId: epicId ?? "",
          branch: leafOption(rest, "--branch") ?? "",
          format,
        });
      },
    },
    {
      name: "set-primary-repo",
      shortHelp: "Set the primary_repo path on an epic (metadata only).",
      run: (rest, format) => {
        const [epicId] = leafPositionals(rest, new Set(["--path"]));
        runEpicSetPrimaryRepo({
          epicId: epicId ?? "",
          path: leafOption(rest, "--path") ?? "",
          format,
        });
      },
    },
    {
      name: "set-title",
      shortHelp: "Rename an epic (ID remains unchanged).",
      run: (rest, format) => {
        const [epicId] = leafPositionals(rest, new Set(["--title"]));
        runEpicSetTitle({
          epicId: epicId ?? "",
          title: leafOption(rest, "--title") ?? "",
          format,
        });
      },
    },
    {
      name: "set-touched-repos",
      shortHelp: "Replace the touched_repos list on an epic.",
      run: (rest, format) => {
        const [epicId] = leafPositionals(rest, new Set(["--paths"]));
        runEpicSetTouchedRepos({
          epicId: epicId ?? "",
          paths: leafOption(rest, "--paths") ?? "",
          format,
        });
      },
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
      run: (rest, format) => {
        const [taskId] = leafPositionals(rest, new Set());
        runTaskReset({
          taskId: taskId ?? "",
          cascade: leafFlag(rest, "--cascade"),
          format,
        });
      },
    },
    {
      name: "set-acceptance",
      shortHelp: "Set or replace the Acceptance section of a task spec.",
      run: (rest, format) => {
        const [taskId] = leafPositionals(rest, new Set(["--file"]));
        runTaskSetAcceptance({
          taskId: taskId ?? "",
          file: leafOption(rest, "--file"),
          format,
        });
      },
    },
    {
      name: "set-description",
      shortHelp: "Set or replace the Description section of a task spec.",
      run: (rest, format) => {
        const [taskId] = leafPositionals(rest, new Set(["--file"]));
        runTaskSetDescription({
          taskId: taskId ?? "",
          file: leafOption(rest, "--file"),
          format,
        });
      },
    },
    {
      name: "set-target-repo",
      shortHelp: "Set the target_repo path on a task.",
      run: (rest, format) => {
        const [taskId] = leafPositionals(rest, new Set(["--path"]));
        runTaskSetTargetRepo({
          taskId: taskId ?? "",
          path: leafOption(rest, "--path") ?? "",
          format,
        });
      },
    },
    {
      name: "set-tier",
      shortHelp: "Persist the worker reasoning tier on a task.",
      run: (rest, format) => {
        const [taskId] = leafPositionals(rest, new Set(["--tier"]));
        runTaskSetTier({
          taskId: taskId ?? "",
          tier: leafOption(rest, "--tier") ?? "",
          format,
        });
      },
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
function emitTrailer(
  verb: string,
  format: OutputFormat | null,
  target: string | null,
): void {
  const ctx = resolveProject(format);
  try {
    const envelope = {
      planctl_invocation: buildPlanctlInvocationReadonly(
        verb,
        ctx.projectPath,
        target,
      ),
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

  // The generic readonly trailer's target: the verb's first positional id when
  // it has one (show / refine-context), else null. The id-bearing cases set it.
  let trailerTarget: string | null = null;

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
    case "show": {
      const id = readPositional(rest);
      runShow(id, format);
      trailerTarget = id.startsWith("fn-") ? id : null;
      break;
    }
    case "cat":
      // Format-free, no trailer: cat owns its stdout + exit code.
      return runCat(readPositional(rest));
    case "list":
      runList(format);
      break;
    case "ready":
      // --epic is an OPTION, not a positional, so the trailer target stays null.
      runReady(readOption(rest, "--epic") ?? "", format);
      break;
    case "tasks":
      runTasks({
        epic: readOption(rest, "--epic"),
        status: readOption(rest, "--status"),
        format,
      });
      break;
    case "resolve-task":
      // Self-emits its readonly invocation (merged into the payload line) — the
      // generic trailer never fires (didSelfEmit() guards it below).
      runResolveTask({
        taskId: readPositional(rest),
        project: readOption(rest, "--project"),
        format,
      });
      break;
    case "refine-context": {
      const id = readPositional(rest);
      runRefineContext({
        epicId: id,
        invalidate: readFlag(rest, "--invalidate"),
        format,
      });
      trailerTarget = id.startsWith("fn-") ? id : null;
      break;
    }
    case "validate":
      // Non-standard {valid,errors,warnings} envelope, no trailer: validate owns
      // its stdout + exit code (and the --epic stamp line).
      return runValidate(readOption(rest, "--epic"), format);
    default:
      noSuchCommand(command);
  }

  // A self-emitting verb (claim/block/done always; init on its committing path)
  // already printed its invocation-bearing envelope — the generic trailer must
  // not fire on top. didSelfEmit() is the runtime sentinel.
  if (!NO_TRACK_COMMANDS.has(command) && !didSelfEmit()) {
    emitTrailer(command, format, trailerTarget);
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
