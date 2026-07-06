// keeper plan CLI dispatch — the hand-rolled command router.
//
// Reproduces the click conventions the conformance harness pins: top-level
// `--format json|human` plumbed to every verb (both positions), `--help` on
// stdout (exit 0) with a Commands section, and an unknown-command error on
// stderr (exit 2) shaped like click's "No such command".
//
// Every read/inspection verb emits exactly ONE top-level JSON value on stdout —
// no trailing provenance line rides the result stream (a two-value stream breaks
// json.load and jq). Verbs that need provenance in the event log (claim, block,
// done, the integrity-gate + close verbs, validate --epic on a fresh stamp) MERGE the
// plan_invocation into their own single envelope via the emit.ts self-emitters.

import type { OutputFormat } from "./format.ts";
import { dispatchGroup, type GroupSpec, leafUsageError } from "./subgroup.ts";
import { runAssignCells } from "./verbs/assign_cells.ts";
import { runAuditSubmit } from "./verbs/audit_submit.ts";
import { runBlock } from "./verbs/block.ts";
import { runCat } from "./verbs/cat.ts";
import { runClaim } from "./verbs/claim.ts";
import { runCloseFinalize } from "./verbs/close_finalize.ts";
import { runClosePreflight } from "./verbs/close_preflight.ts";
import { runDetect } from "./verbs/detect.ts";
import { runDone } from "./verbs/done.ts";
import { runEpicAddDeps } from "./verbs/epic_add_deps.ts";
import { runEpicClose } from "./verbs/epic_close.ts";
import { runEpicCreate } from "./verbs/epic_create.ts";
import { runEpicAddDep, runEpicRmDep } from "./verbs/epic_dep_edit.ts";
import { runEpicQuestion } from "./verbs/epic_question.ts";
import { runEpicRm } from "./verbs/epic_rm.ts";
import { runEpicSetBranch, runEpicSetTitle } from "./verbs/epic_set_plain.ts";
import {
  runEpicSetPrimaryRepo,
  runEpicSetTouchedRepos,
} from "./verbs/epic_set_repos.ts";
import { runEpicInvalidate } from "./verbs/epic_short_circuit.ts";
import { runEpics } from "./verbs/epics.ts";
import { runFindTaskCommit } from "./verbs/find_task_commit.ts";
import { runFollowupSubmit } from "./verbs/followup_submit.ts";
import { runGist } from "./verbs/gist.ts";
import { runInit } from "./verbs/init.ts";
import { runList } from "./verbs/list.ts";
import { runMvRepo } from "./verbs/mv_repo.ts";
import { runReady } from "./verbs/ready.ts";
import { runReconcile } from "./verbs/reconcile.ts";
import { runRefineApply } from "./verbs/refine_apply.ts";
import { runRefineContext } from "./verbs/refine_context.ts";
import { runResolveTask } from "./verbs/resolve_task.ts";
import { runScaffold } from "./verbs/scaffold.ts";
import { runSelectionBrief } from "./verbs/selection_brief.ts";
import { runShow } from "./verbs/show.ts";
import { runStatePath } from "./verbs/state_path.ts";
import { runStatus } from "./verbs/status.ts";
import { runTaskReset } from "./verbs/task_reset.ts";
import {
  runTaskSetAcceptance,
  runTaskSetDescription,
} from "./verbs/task_set_section.ts";
import { runTaskSetTargetRepo } from "./verbs/task_set_target_repo.ts";
import { runTasks } from "./verbs/tasks.ts";
import { runUnblock } from "./verbs/unblock.ts";
import { runValidate } from "./verbs/validate.ts";
import { runVerdictSubmit } from "./verbs/verdict_submit.ts";
import { runWorkerResume } from "./verbs/worker_resume.ts";

// Re-export the emit seam from its module so existing importers keep their
// import site; the definitions live in src/emit.ts.
export { emitMutating, emitReadonly } from "./emit.ts";

const PROG = "keeper plan";
const USAGE = `Usage: ${PROG} [OPTIONS] COMMAND [ARGS]...`;

// Subgroups ("keeper plan <group> <sub>"). A subgroup owns its own --help and
// subcommand dispatch, so post-command --help is routed to the group, not the
// top-level help.
const SUBGROUP_NAMES = new Set([
  "audit",
  "epic",
  "followup",
  "task",
  "verdict",
  "worker",
]);

interface CommandSpec {
  name: string;
  shortHelp: string;
  implemented: boolean;
}

// Registration order = help-listing order (alphabetical, matching click).
const COMMANDS: CommandSpec[] = [
  {
    name: "assign-cells",
    shortHelp:
      "Batch-overwrite a ghost epic's tier/model cells + write a sidecar.",
    implemented: true,
  },
  {
    name: "audit",
    shortHelp: "Close-phase audit-artifact submit verbs.",
    implemented: true,
  },
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
    name: "close-finalize",
    shortHelp: "Run the /plan:close saga to its outcome.",
    implemented: true,
  },
  {
    name: "close-preflight",
    shortHelp: "Write the /plan:close brief and emit the handoff.",
    implemented: true,
  },
  {
    name: "detect",
    shortHelp: "Check if cwd belongs to a plan project.",
    implemented: true,
  },
  { name: "done", shortHelp: "Mark a task as complete.", implemented: true },
  { name: "epic", shortHelp: "Manage epics.", implemented: true },
  { name: "epics", shortHelp: "List all epics.", implemented: true },
  {
    name: "epic-question",
    shortHelp: "Set or clear an epic-level parked question (board-visible).",
    implemented: true,
  },
  {
    name: "find-task-commit",
    shortHelp: "Look up a task's source commits.",
    implemented: true,
  },
  {
    name: "followup",
    shortHelp: "Close-phase follow-up-plan submit verb.",
    implemented: true,
  },
  {
    name: "gist",
    shortHelp: "Create a multifile gist for an epic.",
    implemented: true,
  },
  {
    name: "init",
    shortHelp: "Initialize a plan project for the current directory.",
    implemented: true,
  },
  {
    name: "list",
    shortHelp: "List all epics and their tasks in a tree view.",
    implemented: true,
  },
  {
    name: "mv-repo",
    shortHelp: "Rewrite stored board paths for a renamed repo (metadata only).",
    implemented: true,
  },
  {
    name: "ready",
    shortHelp: "List tasks that are ready to be worked on.",
    implemented: true,
  },
  {
    name: "reconcile",
    shortHelp: "Post-worker verdict for /plan:work (read-only).",
    implemented: true,
  },
  {
    name: "refine-apply",
    shortHelp: "Apply a refine delta to an existing epic tree.",
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
    name: "scaffold",
    shortHelp: "Materialize a whole epic tree from one YAML.",
    implemented: true,
  },
  {
    name: "selection-brief",
    shortHelp: "Write the model/effort selector brief for an epic.",
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
    name: "unblock",
    shortHelp: "Flip a blocked task back to todo.",
    implemented: true,
  },
  {
    name: "validate",
    shortHelp: "Validate project data integrity.",
    implemented: true,
  },
  {
    name: "verdict",
    shortHelp: "Close-phase verdict submit verb.",
    implemented: true,
  },
  {
    name: "worker",
    shortHelp: "Worker resume helpers for dropped /plan:work invocations.",
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

/** Reject any `--option` token in `rest` not in `known`, click's parse-time
 * "No such option" usage error (exit 2). `--name=value` forms are split on `=`
 * before the membership check. Positional args are ignored. */
function rejectUnknownLeafOptions(
  group: string,
  sub: string,
  argsHint: string,
  rest: string[],
  known: Set<string>,
): void {
  for (const arg of rest) {
    if (!arg.startsWith("--")) {
      continue;
    }
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (!known.has(name)) {
      leafUsageError(group, sub, argsHint, `No such option: ${name}`);
    }
  }
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
      name: "close",
      shortHelp: "Mark an epic as done.",
      run: (rest, format) => {
        // click rejects unknown options at parse time (exit 2) — the
        // removed --audit-required flag must still error. Only --force and
        // --reason are accepted here.
        rejectUnknownLeafOptions(
          "epic",
          "close",
          "EPIC_ID",
          rest,
          new Set(["--force", "--reason", "--project"]),
        );
        const [epicId] = leafPositionals(
          rest,
          new Set(["--reason", "--project"]),
        );
        runEpicClose({
          epicId: epicId ?? "",
          force: leafFlag(rest, "--force"),
          reason: leafOption(rest, "--reason"),
          project: leafOption(rest, "--project"),
          format,
        });
      },
    },
    {
      name: "create",
      shortHelp: "Create a new epic.",
      run: (rest, format) => {
        runEpicCreate({
          title: leafOption(rest, "--title") ?? "",
          branch: leafOption(rest, "--branch"),
          specFile: leafOption(rest, "--spec-file"),
          primaryRepo: leafOption(rest, "--primary-repo"),
          touchedRepos: leafOption(rest, "--touched-repos"),
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
      name: "rm",
      shortHelp:
        "Remove an epic and all its artifacts (sanctioned delete verb).",
      run: (rest, format) => {
        const [epicId] = leafPositionals(rest, new Set(["--project"]));
        runEpicRm({
          epicId: epicId ?? "",
          force: leafFlag(rest, "--force"),
          dryRun: leafFlag(rest, "--dry-run"),
          project: leafOption(rest, "--project"),
          format,
        });
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
        const [taskId] = leafPositionals(rest, new Set(["--project"]));
        runTaskReset({
          taskId: taskId ?? "",
          cascade: leafFlag(rest, "--cascade"),
          project: leafOption(rest, "--project"),
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
  ],
};

// The `worker` subgroup — resume helpers for dropped /plan:work invocations.
// `resume` is read-only (regenerates the brief under gitignored state/briefs/,
// zero commits) and emits its single envelope via format_output.
const WORKER_GROUP: GroupSpec = {
  name: "worker",
  description: "Worker resume helpers for dropped /plan:work invocations.",
  commands: [
    {
      name: "resume",
      shortHelp:
        "Emit a ready-to-paste respawn prompt for a dropped in-progress task.",
      run: (rest, format) => {
        runWorkerResume({ taskId: readPositional(rest), format });
      },
    },
  ],
};

// Close-phase submit subgroups (audit/verdict/followup submit). Each uses
// FormattedGroup semantics: the leaf emits {success:true,...} via formatOutput
// (or the typed error envelope + exit 1) as a single JSON value. All three are
// runtime-state-only — zero .keeper/ commits.
const AUDIT_RISK_CHOICES = ["Low", "Medium", "High"];

const AUDIT_GROUP: GroupSpec = {
  name: "audit",
  description: "Close-phase audit-artifact submit verbs.",
  commands: [
    {
      name: "submit",
      shortHelp: "Persist the quality-auditor's report markdown (commit-free).",
      run: (rest, format) => {
        const valueTaking = new Set([
          "--file",
          "--findings",
          "--risk",
          "--project",
        ]);
        const [epicId] = leafPositionals(rest, valueTaking);
        const findingsRaw = leafOption(rest, "--findings");
        // --file / --risk are click `required=True`; --risk is a click.Choice.
        // click validates these at PARSE time (exit 2), before the verb body.
        const fileArg = leafOption(rest, "--file");
        if (fileArg === null) {
          leafUsageError(
            "audit",
            "submit",
            "EPIC_ID",
            "Missing option '--file'.",
          );
        }
        const riskArg = leafOption(rest, "--risk");
        if (riskArg === null) {
          leafUsageError(
            "audit",
            "submit",
            "EPIC_ID",
            "Missing option '--risk'. Choose from:\n\tLow,\n\tMedium,\n\tHigh",
          );
        }
        if (!AUDIT_RISK_CHOICES.includes(riskArg)) {
          leafUsageError(
            "audit",
            "submit",
            "EPIC_ID",
            `Invalid value for '--risk': '${riskArg}' is not one of ` +
              "'Low', 'Medium', 'High'.",
          );
        }
        runAuditSubmit({
          epicId: epicId ?? "",
          file: fileArg,
          findings: findingsRaw === null ? 0 : Number.parseInt(findingsRaw, 10),
          risk: riskArg,
          project: leafOption(rest, "--project"),
          format,
        });
      },
    },
  ],
};

const VERDICT_GROUP: GroupSpec = {
  name: "verdict",
  description: "Close-phase verdict submit verb.",
  commands: [
    {
      name: "submit",
      shortHelp:
        "Validate + persist the close-planner's verdict JSON (commit-free).",
      run: (rest, format) => {
        const valueTaking = new Set(["--file", "--project"]);
        const [epicId] = leafPositionals(rest, valueTaking);
        const fileArg = leafOption(rest, "--file");
        if (fileArg === null) {
          leafUsageError(
            "verdict",
            "submit",
            "EPIC_ID",
            "Missing option '--file'.",
          );
        }
        runVerdictSubmit({
          epicId: epicId ?? "",
          file: fileArg,
          project: leafOption(rest, "--project"),
          format,
        });
      },
    },
  ],
};

const FOLLOWUP_GROUP: GroupSpec = {
  name: "followup",
  description: "Close-phase follow-up-plan submit verb.",
  commands: [
    {
      name: "submit",
      shortHelp:
        "Validate + persist the close-planner's follow-up plan YAML (commit-free).",
      run: (rest, format) => {
        const valueTaking = new Set(["--file", "--project"]);
        const [epicId] = leafPositionals(rest, valueTaking);
        const fileArg = leafOption(rest, "--file");
        if (fileArg === null) {
          leafUsageError(
            "followup",
            "submit",
            "EPIC_ID",
            "Missing option '--file'.",
          );
        }
        runFollowupSubmit({
          epicId: epicId ?? "",
          file: fileArg,
          project: leafOption(rest, "--project"),
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
  if (value === "json" || value === "human") {
    return value;
  }
  usageError(
    `Invalid value for '--format': '${value ?? ""}' is not one of 'json', 'human'.`,
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
  lines.push("  --format [json|human]       Output format (default: json)");
  lines.push("  --help                      Show this message and exit.");
  lines.push("");
  lines.push("To orient on the board, prefer the keeper-native surfaces over");
  lines.push("hand-parsing a read verb: `keeper status` for the board, and");
  lines.push(
    "`keeper query tasks` for per-task detail (tier/model/deps + verdict).",
  );
  lines.push("Every read verb still emits exactly one clean JSON value.");
  lines.push("");
  lines.push("Commands:");
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  for (const cmd of COMMANDS) {
    lines.push(`  ${cmd.name.padEnd(width)}  ${cmd.shortHelp}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
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
      // found-true → {found:true} exit 0; found-false → a single
      // {success:false, found:false, error} value + exit 1, so the `detect || init`
      // idiom survives on the exit code with exactly one JSON value either way.
      return runDetect(format);
    case "status":
      runStatus(format);
      break;
    case "epics":
      runEpics({
        format,
        limit: readIntOption(rest, "--limit", 50, 1),
        offset: readIntOption(rest, "--offset", 0, 0),
      });
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
        project: readOption(rest, "--project"),
        format,
      });
      break;
    case "unblock":
      runUnblock({
        taskId: readPositional(rest),
        project: readOption(rest, "--project"),
        format,
      });
      break;
    case "epic-question": {
      // Positional epic id, then either a positional question text or
      // --clear. --project is value-taking, so it must be skipped when
      // scanning for the id/question positionals.
      const valueTaking = new Set(["--project"]);
      const [epicId, question] = leafPositionals(rest, valueTaking);
      runEpicQuestion({
        epicId: epicId ?? "",
        question: question ?? null,
        clear: readFlag(rest, "--clear"),
        project: readOption(rest, "--project"),
        format,
      });
      break;
    }
    case "done":
      // readPositional already skips --project / --summary / --evidence values.
      runDone({
        taskId: readPositional(rest),
        summary: readOption(rest, "--summary"),
        evidence: readOption(rest, "--evidence"),
        force: readFlag(rest, "--force"),
        project: readOption(rest, "--project"),
        format,
      });
      break;
    case "init":
      runInit({ format });
      break;
    case "close-preflight":
      // Read-only brief handoff: emits one payload envelope via formatOutput; the
      // error path exits 1 before that.
      runClosePreflight({
        epicId: readPositionalSkipping(rest, new Set(["--project"])),
        project: readOption(rest, "--project"),
        format,
      });
      break;
    case "close-finalize":
      // Self-emits its readonly invocation via emitReadonly, merged into its own
      // single envelope. --selection-verdict feeds an optional pre-selected cell
      // set that finalize folds into the follow-up scaffold input.
      runCloseFinalize({
        epicId: readPositionalSkipping(
          rest,
          new Set(["--project", "--selection-verdict"]),
        ),
        project: readOption(rest, "--project"),
        format,
        selectionVerdict: readOption(rest, "--selection-verdict"),
      });
      break;
    case "gist":
      // Read-only: emits one payload envelope via formatOutput.
      runGist({
        epicId: readPositionalSkipping(rest, new Set(["--desc"])),
        public: readFlag(rest, "--public"),
        noOpen: readFlag(rest, "--no-open"),
        description: readOption(rest, "--desc"),
        format,
      });
      break;
    case "epic":
      // Subgroup: dispatch the leaf (or group help). The leaf owns its own
      // single envelope (a mutating self-emit or a FormattedGroup payload).
      dispatchGroup(EPIC_GROUP, rest, format);
      return 0;
    case "task":
      dispatchGroup(TASK_GROUP, rest, format);
      return 0;
    case "assign-cells": {
      // Self-emits (emitMutating on success / emitFailureEnvelope or the integrity
      // gate's integrity_failed line on failure) and owns its exit code — return
      // it directly. Same arg shape as refine-apply: epic id positional, --file
      // value-taking so the positional scan skips its value.
      const epicId = readPositionalSkipping(rest, new Set(["--file"]));
      return runAssignCells({
        epicId,
        file: readOption(rest, "--file") ?? "",
      });
    }
    case "refine-apply": {
      // Self-emits (emitMutating on success / emitFailureEnvelope or the integrity
      // gate's integrity_failed line on failure) and owns its exit code — return
      // it directly. The epic id is the positional; --file is value-taking, so the
      // positional scan must skip its value.
      const epicId = readPositionalSkipping(rest, new Set(["--file"]));
      return runRefineApply({
        epicId,
        file: readOption(rest, "--file") ?? "",
      });
    }
    case "scaffold":
      // Self-emits (emitMutating on success / emitFailureEnvelope on failure)
      // and owns its exit code — return it directly.
      return runScaffold({
        file: readOption(rest, "--file") ?? "",
        allowDuplicate: readFlag(rest, "--allow-duplicate"),
        createdByCloseOf: null,
      });
    case "selection-brief":
      // Commit-free brief handoff: writes gitignored state/ and emits one
      // payload envelope; the selector subagent reads the brief itself.
      // --from-followup briefs the stored follow-up document instead of the live
      // epic's todo tasks (ordinal-keyed tasks, document-anchored input_hash).
      runSelectionBrief({
        epicId: readPositionalSkipping(rest, new Set(["--project"])),
        project: readOption(rest, "--project"),
        format,
        fromFollowup: readFlag(rest, "--from-followup"),
      });
      break;
    case "show":
      // Read-only: emits one payload envelope via formatOutput.
      runShow(readPositional(rest), readOption(rest, "--project"), format);
      break;
    case "cat":
      // Format-free: cat owns its raw-markdown stdout + exit code.
      return runCat(readPositional(rest), readOption(rest, "--project"));
    case "list":
      runList({
        format,
        limit: readIntOption(rest, "--limit", 50, 1),
        offset: readIntOption(rest, "--offset", 0, 0),
      });
      break;
    case "mv-repo": {
      // Self-emits (emitMutating on success / emitError on a bad <new>) and owns
      // its exit code — return it directly. Two positionals: <oldPath> <newPath>.
      const [oldPath, newPath] = leafPositionals(rest, new Set());
      return runMvRepo({
        oldPath: oldPath ?? "",
        newPath: newPath ?? "",
        format,
      });
    }
    case "ready":
      // Read-only: emits one payload envelope. --epic is an OPTION, not a positional.
      runReady(readOption(rest, "--epic") ?? "", format);
      break;
    case "tasks":
      runTasks({
        epic: readOption(rest, "--epic"),
        status: readOption(rest, "--status"),
        format,
        limit: readIntOption(rest, "--limit", 50, 1),
        offset: readIntOption(rest, "--offset", 0, 0),
      });
      break;
    case "resolve-task":
      // Self-emits its readonly invocation merged into its single payload line.
      runResolveTask({
        taskId: readPositional(rest),
        project: readOption(rest, "--project"),
        format,
      });
      break;
    case "find-task-commit":
      // Self-emits its readonly invocation via emitReadonly, merged into its
      // single envelope.
      runFindTaskCommit({
        taskId: readPositional(rest),
        project: readOption(rest, "--project"),
        format,
      });
      break;
    case "reconcile":
      // Self-emits its readonly invocation via emitReadonly, merged into its
      // single envelope.
      runReconcile({
        taskId: readPositional(rest),
        project: readOption(rest, "--project"),
        format,
      });
      break;
    case "audit":
      // Subgroup: `submit` emits one envelope via format_output (FormattedGroup).
      dispatchGroup(AUDIT_GROUP, rest, format);
      return 0;
    case "verdict":
      dispatchGroup(VERDICT_GROUP, rest, format);
      return 0;
    case "followup":
      dispatchGroup(FOLLOWUP_GROUP, rest, format);
      return 0;
    case "worker":
      // Subgroup: dispatch the leaf (or group help). `resume` emits one envelope
      // via format_output (FormattedGroup).
      dispatchGroup(WORKER_GROUP, rest, format);
      return 0;
    case "refine-context":
      // Read path emits one payload envelope; the --invalidate path self-emits its
      // merged invocation. Either way, a single JSON value.
      runRefineContext({
        epicId: readPositional(rest),
        invalidate: readFlag(rest, "--invalidate"),
        project: readOption(rest, "--project"),
        format,
      });
      break;
    case "validate":
      // Non-standard {valid,errors,warnings} envelope: validate owns its stdout +
      // exit code, merging the plan_invocation into the same value on a fresh
      // --epic stamp (a single JSON value on every path).
      return runValidate(readOption(rest, "--epic"), format);
    default:
      noSuchCommand(command);
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

/** Parse an integer paging option, defaulting when absent. A malformed value
 * (non-numeric, fractional, or below `min`) is CLI misuse: write a clear
 * message to stderr and exit 2 (mirrors `keeper board --timeout`). */
function readIntOption(
  rest: string[],
  name: string,
  def: number,
  min: number,
): number {
  const raw = readOption(rest, name);
  if (raw === null) {
    return def;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    process.stderr.write(
      `keeper plan: ${name} must be an integer >= ${min} (got '${raw}')\n`,
    );
    process.exit(2);
  }
  return n;
}

/** The first positional (non-`--`-prefixed) arg, or "" when absent. A value
 * immediately following a value-taking option in `valueTaking` is skipped so it
 * is not mistaken for the positional. */
function readPositionalSkipping(
  rest: string[],
  valueTaking: Set<string>,
): string {
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

/** The first positional, skipping the standard value-taking options. */
function readPositional(rest: string[]): string {
  return readPositionalSkipping(
    rest,
    new Set([
      "--note",
      "--project",
      "--reason",
      "--reason-file",
      "--summary",
      "--evidence",
    ]),
  );
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
