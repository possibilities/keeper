/**
 * Pure-data descriptor module for the `keeper plan` CLI surface (ADR 0008).
 *
 * This is the single source of truth the plan dispatcher (`src/cli.ts`) consumes:
 * the top-level `--help` command listing, the no-such-command validation, the
 * subgroup-name set, and every leaf's `--help` rendering read from
 * {@link PLAN_COMMANDS}. A top-level verb and a subgroup verb both render their
 * leaf help through the ONE shared renderer (`renderLeafHelp` in `subgroup.ts`)
 * fed by this data, so a verb's documented arguments/options cannot drift from a
 * second hand-maintained table.
 *
 * PURITY CONTRACT: this module is dependency-free data + types + pure lookups. It
 * imports NOTHING from `src/` or `cli/`, so the help path never boots a verb body,
 * opens state, or spawns git. Keep it types + literals + total-function lookups.
 *
 * The plan CLI is a hand-rolled argv router (not `node:util` parseArgs), so — per
 * the epic's Early proof point — a leaf DECLARES its flag surface here and the CLI
 * reads the declaration for help/validation rather than deriving a parseArgs
 * config from it. The value-parsing seam (`readOption`/`leafPositionals`) stays in
 * `cli.ts`; the metadata here is extracted to match it verb-for-verb.
 */

// ── argument / option model ──────────────────────────────────────────────────

/** One positional argument in a verb's usage line (e.g. `TASK_ID`). */
export interface ArgDescriptor {
  /** The metavar as it appears in usage (upper-case by convention). */
  readonly name: string;
  /** Repeatable trailing positional (rendered `NAME...`). */
  readonly variadic?: boolean;
  /** Not required (rendered `[NAME]`). */
  readonly optional?: boolean;
}

/** One `--flag` a verb accepts. `takesValue` distinguishes a value option
 *  (`--project PATH`) from a bare boolean flag (`--force`). */
export interface OptionDescriptor {
  /** The long spelling including the leading dashes (e.g. `--project`). */
  readonly name: string;
  /** Consumes the following token as its value (vs. a bare boolean flag). */
  readonly takesValue: boolean;
  /** One-line human description shown in leaf help. */
  readonly summary: string;
}

/**
 * One plan command — a top-level verb or a nested subgroup verb. `subcommands`
 * carries the two-level surface (`epic create`, `verdict submit`, …); a leaf has
 * `args`/`options` and no `subcommands`. `summary` is the short help the top-level
 * `--help` listing and the leaf-help paragraph render.
 */
export interface PlanCommand {
  readonly name: string;
  readonly summary: string;
  readonly args?: readonly ArgDescriptor[];
  readonly options?: readonly OptionDescriptor[];
  /** Output renderings this verb's `--format` advertises in leaf help. Absent
   *  means the standard read surface `["json", "human", "yaml"]`; a verb whose
   *  envelope is frozen against yaml (validate) or that is format-free (cat)
   *  narrows to `["json", "human"]` so its help never advertises a mode it does
   *  not render. */
  readonly formatModes?: readonly ("json" | "human" | "yaml")[];
  /** Nested verbs for a subgroup (`epic`, `task`, `audit`, …). */
  readonly subcommands?: readonly PlanCommand[];
}

/** The standard `--format` surface a read verb advertises when it declares no
 *  narrower {@link PlanCommand.formatModes}. */
export const DEFAULT_FORMAT_MODES: readonly ("json" | "human" | "yaml")[] = [
  "json",
  "human",
  "yaml",
];

// ── shared option fragments ──────────────────────────────────────────────────

const OPT_PROJECT: OptionDescriptor = {
  name: "--project",
  takesValue: true,
  summary: "Target project root (default: resolve from cwd)",
};
const OPT_FILE: OptionDescriptor = {
  name: "--file",
  takesValue: true,
  summary: "Path to the input document",
};
const OPT_LIMIT: OptionDescriptor = {
  name: "--limit",
  takesValue: true,
  summary: "Max rows to return (default: 50)",
};
const OPT_OFFSET: OptionDescriptor = {
  name: "--offset",
  takesValue: true,
  summary: "Row offset for paging (default: 0)",
};
const OPT_EPIC: OptionDescriptor = {
  name: "--epic",
  takesValue: true,
  summary: "Scope to one epic id",
};

// ── subgroup verb sets ───────────────────────────────────────────────────────
//
// Authored in the SAME order as the GroupSpec `commands` arrays in cli.ts so the
// group-help listing order is preserved. Summaries match the GroupSpec shortHelps.

const EPIC_SUBCOMMANDS: readonly PlanCommand[] = [
  {
    name: "add-dep",
    summary: "Add an epic-level dependency.",
    args: [{ name: "EPIC_ID" }, { name: "DEP_ID" }],
  },
  {
    name: "add-deps",
    summary: "Batch-wire N epic-level dependency edges (idempotent per edge).",
    args: [{ name: "EPIC_ID" }, { name: "DEP_ID", variadic: true }],
    options: [
      {
        name: "--skip-invalid",
        takesValue: false,
        summary: "Skip unresolvable dep ids instead of failing",
      },
    ],
  },
  {
    name: "close",
    summary: "Mark an epic as done.",
    args: [{ name: "EPIC_ID" }],
    options: [
      {
        name: "--force",
        takesValue: false,
        summary: "Close despite open tasks",
      },
      {
        name: "--reason",
        takesValue: true,
        summary: "Reason recorded on the close",
      },
      OPT_PROJECT,
    ],
  },
  {
    name: "create",
    summary: "Create a new epic.",
    options: [
      { name: "--title", takesValue: true, summary: "Epic title (required)" },
      {
        name: "--branch",
        takesValue: true,
        summary: "Branch name for the epic",
      },
      {
        name: "--spec-file",
        takesValue: true,
        summary: "Path to the epic spec markdown",
      },
      {
        name: "--primary-repo",
        takesValue: true,
        summary: "Primary repo path (metadata)",
      },
      {
        name: "--touched-repos",
        takesValue: true,
        summary: "Comma-separated touched-repo paths",
      },
    ],
  },
  {
    name: "invalidate",
    summary:
      "Clear validation marker (force re-validate on next validate run).",
    args: [{ name: "EPIC_ID" }],
  },
  {
    name: "rm",
    summary: "Remove an epic and all its artifacts (sanctioned delete verb).",
    args: [{ name: "EPIC_ID" }],
    options: [
      {
        name: "--force",
        takesValue: false,
        summary: "Delete in_progress/locked tasks too",
      },
      {
        name: "--dry-run",
        takesValue: false,
        summary: "Report what would be deleted",
      },
      OPT_PROJECT,
    ],
  },
  {
    name: "rm-dep",
    summary: "Remove an epic-level dependency.",
    args: [{ name: "EPIC_ID" }, { name: "DEP_ID" }],
  },
  {
    name: "set-branch",
    summary: "Set the branch name on an epic.",
    args: [{ name: "EPIC_ID" }],
    options: [
      { name: "--branch", takesValue: true, summary: "New branch name" },
    ],
  },
  {
    name: "set-primary-repo",
    summary: "Set the primary_repo path on an epic (metadata only).",
    args: [{ name: "EPIC_ID" }],
    options: [
      { name: "--path", takesValue: true, summary: "New primary_repo path" },
    ],
  },
  {
    name: "set-title",
    summary: "Rename an epic (ID remains unchanged).",
    args: [{ name: "EPIC_ID" }],
    options: [{ name: "--title", takesValue: true, summary: "New epic title" }],
  },
  {
    name: "set-touched-repos",
    summary: "Replace the touched_repos list on an epic.",
    args: [{ name: "EPIC_ID" }],
    options: [
      {
        name: "--paths",
        takesValue: true,
        summary: "Comma-separated repo paths",
      },
    ],
  },
];

const TASK_SUBCOMMANDS: readonly PlanCommand[] = [
  {
    name: "reset",
    summary: "Reset a task to todo status.",
    args: [{ name: "TASK_ID" }],
    options: [
      {
        name: "--cascade",
        takesValue: false,
        summary: "Also reset dependents",
      },
      OPT_PROJECT,
    ],
  },
  {
    name: "set-acceptance",
    summary: "Set or replace the Acceptance section of a task spec.",
    args: [{ name: "TASK_ID" }],
    options: [OPT_FILE],
  },
  {
    name: "set-description",
    summary: "Set or replace the Description section of a task spec.",
    args: [{ name: "TASK_ID" }],
    options: [OPT_FILE],
  },
  {
    name: "set-target-repo",
    summary: "Set the target_repo path on a task.",
    args: [{ name: "TASK_ID" }],
    options: [
      { name: "--path", takesValue: true, summary: "New target_repo path" },
    ],
  },
];

const AUDIT_SUBCOMMANDS: readonly PlanCommand[] = [
  {
    name: "submit",
    summary: "Persist the quality-auditor's report markdown (commit-free).",
    args: [{ name: "EPIC_ID" }],
    options: [
      {
        name: "--file",
        takesValue: true,
        summary: "Report markdown path (required)",
      },
      { name: "--findings", takesValue: true, summary: "Finding count" },
      {
        name: "--risk",
        takesValue: true,
        summary: "Risk level: Low|Medium|High (required)",
      },
      OPT_PROJECT,
    ],
  },
];

const VERDICT_SUBCOMMANDS: readonly PlanCommand[] = [
  {
    name: "submit",
    summary:
      "Validate + persist the close-planner's verdict JSON (commit-free).",
    args: [{ name: "EPIC_ID" }],
    options: [
      {
        name: "--file",
        takesValue: true,
        summary: "Verdict JSON path (required)",
      },
      OPT_PROJECT,
    ],
  },
];

const FOLLOWUP_SUBCOMMANDS: readonly PlanCommand[] = [
  {
    name: "submit",
    summary:
      "Validate + persist the close-planner's follow-up plan YAML (commit-free).",
    args: [{ name: "EPIC_ID" }],
    options: [
      {
        name: "--file",
        takesValue: true,
        summary: "Follow-up plan YAML path (required)",
      },
      OPT_PROJECT,
    ],
  },
];

const WORKER_SUBCOMMANDS: readonly PlanCommand[] = [
  {
    name: "resume",
    summary:
      "Emit a ready-to-paste respawn prompt for a dropped in-progress task.",
    args: [{ name: "TASK_ID" }],
  },
];

// ── the plan command tree ────────────────────────────────────────────────────
//
// Registration order = help-listing order (alphabetical, matching click). The
// summaries match the COMMANDS shortHelps the top-level `--help` listing renders.

export const PLAN_COMMANDS: readonly PlanCommand[] = [
  {
    name: "assign-cells",
    summary:
      "Batch-overwrite a ghost epic's tier/model cells + write a sidecar.",
    args: [{ name: "EPIC_ID" }],
    options: [OPT_FILE],
  },
  {
    name: "audit",
    summary: "Close-phase audit-artifact submit verbs.",
    subcommands: AUDIT_SUBCOMMANDS,
  },
  {
    name: "block",
    summary: "Mark a task as blocked.",
    args: [{ name: "TASK_ID" }],
    options: [
      { name: "--reason", takesValue: true, summary: "Block reason text" },
      {
        name: "--reason-file",
        takesValue: true,
        summary: "Read the reason from a file",
      },
      OPT_PROJECT,
    ],
  },
  {
    name: "cat",
    summary: "Print the raw spec markdown for an epic or task.",
    args: [{ name: "ID" }],
    options: [OPT_PROJECT],
    // Format-free: cat emits raw markdown regardless of --format, so its help
    // never advertises yaml.
    formatModes: ["json", "human"],
  },
  {
    name: "claim",
    summary: "Claim a task and return the worker briefing.",
    args: [{ name: "TASK_ID" }],
    options: [
      {
        name: "--force",
        takesValue: false,
        summary: "Claim despite an existing claim",
      },
      { name: "--note", takesValue: true, summary: "Claim note" },
      OPT_PROJECT,
    ],
  },
  {
    name: "close-finalize",
    summary: "Run the /plan:close saga to its outcome.",
    args: [{ name: "EPIC_ID" }],
    options: [
      OPT_PROJECT,
      {
        name: "--selection-verdict",
        takesValue: true,
        summary:
          "Pre-selected cell verdict to fold into the follow-up scaffold",
      },
    ],
  },
  {
    name: "close-preflight",
    summary: "Write the /plan:close brief and emit the handoff.",
    args: [{ name: "EPIC_ID" }],
    options: [OPT_PROJECT],
  },
  {
    name: "detect",
    summary: "Check if cwd belongs to a plan project.",
  },
  {
    name: "done",
    summary: "Mark a task as complete.",
    args: [{ name: "TASK_ID" }],
    options: [
      { name: "--summary", takesValue: true, summary: "Done summary text" },
      { name: "--evidence", takesValue: true, summary: "Evidence text" },
      {
        name: "--force",
        takesValue: false,
        summary: "Complete despite gate failures",
      },
      OPT_PROJECT,
    ],
  },
  {
    name: "epic",
    summary: "Manage epics.",
    subcommands: EPIC_SUBCOMMANDS,
  },
  {
    name: "epics",
    summary: "List all epics.",
    options: [OPT_LIMIT, OPT_OFFSET],
  },
  {
    name: "epic-question",
    summary: "Set or clear an epic-level parked question (board-visible).",
    args: [{ name: "EPIC_ID" }, { name: "QUESTION", optional: true }],
    options: [
      {
        name: "--clear",
        takesValue: false,
        summary: "Clear the parked question",
      },
      OPT_PROJECT,
    ],
  },
  {
    name: "find-task-commit",
    summary: "Look up a task's source commits.",
    args: [{ name: "TASK_ID" }],
    options: [OPT_PROJECT],
  },
  {
    name: "followup",
    summary: "Close-phase follow-up-plan submit verb.",
    subcommands: FOLLOWUP_SUBCOMMANDS,
  },
  {
    name: "gist",
    summary: "Create a multifile gist for an epic.",
    args: [{ name: "EPIC_ID" }],
    options: [
      { name: "--public", takesValue: false, summary: "Make the gist public" },
      {
        name: "--no-open",
        takesValue: false,
        summary: "Do not open the gist in a browser",
      },
      { name: "--desc", takesValue: true, summary: "Gist description" },
    ],
  },
  {
    name: "init",
    summary: "Initialize a plan project for the current directory.",
  },
  {
    name: "list",
    summary: "List all epics and their tasks in a tree view.",
    options: [OPT_LIMIT, OPT_OFFSET],
  },
  {
    name: "mv-repo",
    summary: "Rewrite stored board paths for a renamed repo (metadata only).",
    args: [{ name: "OLD_PATH" }, { name: "NEW_PATH" }],
  },
  {
    name: "ready",
    summary: "List tasks that are ready to be worked on.",
    options: [OPT_EPIC],
  },
  {
    name: "reconcile",
    summary: "Post-worker verdict for /plan:work (read-only).",
    args: [{ name: "TASK_ID" }],
    options: [OPT_PROJECT],
  },
  {
    name: "refine-apply",
    summary: "Apply a refine delta to an existing epic tree.",
    args: [{ name: "EPIC_ID" }],
    options: [OPT_FILE],
  },
  {
    name: "refine-context",
    summary: "Fetch refine-state for /plan:plan (read-only).",
    args: [{ name: "EPIC_ID" }],
    options: [
      {
        name: "--invalidate",
        takesValue: false,
        summary: "Clear the validation marker as a side effect",
      },
      OPT_PROJECT,
    ],
  },
  {
    name: "resolve-task",
    summary: "Routing lookup to launch /plan:work.",
    args: [{ name: "TASK_ID" }],
    options: [OPT_PROJECT],
  },
  {
    name: "scaffold",
    summary: "Materialize a whole epic tree from one YAML.",
    options: [
      { name: "--file", takesValue: true, summary: "Scaffold YAML path" },
      {
        name: "--allow-duplicate",
        takesValue: false,
        summary: "Permit a same-slug sibling epic",
      },
    ],
  },
  {
    name: "selection-audit-brief",
    summary: "Write the committed selection-audit brief for a closed epic.",
    args: [{ name: "EPIC_ID" }],
    options: [
      OPT_PROJECT,
      {
        name: "--force",
        takesValue: false,
        summary: "Re-derive despite an existing committed brief",
      },
    ],
  },
  {
    name: "selection-brief",
    summary: "Write the model/effort selector brief for an epic.",
    args: [{ name: "EPIC_ID" }],
    options: [
      OPT_PROJECT,
      {
        name: "--from-followup",
        takesValue: false,
        summary:
          "Brief the stored follow-up document instead of live todo tasks",
      },
    ],
  },
  {
    name: "selection-review",
    summary:
      "Set or clear an epic-level selection-review record (board-visible).",
    args: [{ name: "EPIC_ID" }],
    options: [
      {
        name: "--set",
        takesValue: true,
        summary: "Store the review payload (a small JSON verdict summary)",
      },
      {
        name: "--clear",
        takesValue: false,
        summary: "Clear the selection-review record",
      },
      OPT_PROJECT,
    ],
  },
  {
    name: "selection-review-submit",
    summary:
      "Validate the auditor verdict + land the committed selection-review dataset.",
    args: [{ name: "EPIC_ID" }],
    options: [
      {
        name: "--file",
        takesValue: true,
        summary: "Verdict JSON path (`-` for stdin)",
      },
      {
        name: "--force",
        takesValue: false,
        summary: "Overwrite an existing committed review",
      },
      OPT_PROJECT,
    ],
  },
  {
    name: "show",
    summary: "Show detailed information about an epic or task.",
    args: [{ name: "ID" }],
    options: [OPT_PROJECT],
  },
  {
    name: "state-path",
    summary: "Print the resolved state directory path.",
    options: [
      {
        name: "--task",
        takesValue: true,
        summary: "Resolve against a task id",
      },
    ],
  },
  {
    name: "status",
    summary: "Show overall project status.",
  },
  {
    name: "task",
    summary: "Manage tasks.",
    subcommands: TASK_SUBCOMMANDS,
  },
  {
    name: "tasks",
    summary: "List tasks with optional filtering.",
    options: [
      OPT_EPIC,
      { name: "--status", takesValue: true, summary: "Filter by task status" },
      OPT_LIMIT,
      OPT_OFFSET,
    ],
  },
  {
    name: "unblock",
    summary: "Flip a blocked task back to todo.",
    args: [{ name: "TASK_ID" }],
    options: [OPT_PROJECT],
  },
  {
    name: "validate",
    summary: "Validate project data integrity.",
    options: [
      {
        name: "--epic",
        takesValue: true,
        summary: "Validate + arm one epic (mutating stamp)",
      },
    ],
    // The {valid, errors, warnings} envelope is frozen against yaml, so its help
    // never advertises it and a --format yaml request is a usage fault.
    formatModes: ["json", "human"],
  },
  {
    name: "verdict",
    summary: "Close-phase verdict submit verb.",
    subcommands: VERDICT_SUBCOMMANDS,
  },
  {
    name: "worker",
    summary: "Worker resume helpers for dropped /plan:work invocations.",
    subcommands: WORKER_SUBCOMMANDS,
  },
];

// ── lookups (pure) ───────────────────────────────────────────────────────────

const BY_NAME: ReadonlyMap<string, PlanCommand> = new Map(
  PLAN_COMMANDS.map((c) => [c.name, c]),
);

/** The descriptor for a top-level plan command, or `undefined`. */
export function planCommand(name: string): PlanCommand | undefined {
  return BY_NAME.get(name);
}

/** True when `name` is a top-level command that owns nested subcommands (a
 *  subgroup like `epic` / `task` / `audit`). */
export function isSubgroup(name: string): boolean {
  return (BY_NAME.get(name)?.subcommands?.length ?? 0) > 0;
}

/** The set of subgroup command names, derived from the tree. */
export const SUBGROUP_NAMES: ReadonlySet<string> = new Set(
  PLAN_COMMANDS.filter((c) => (c.subcommands?.length ?? 0) > 0).map(
    (c) => c.name,
  ),
);
