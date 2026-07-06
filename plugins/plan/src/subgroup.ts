// Nested-group dispatch — the port of click's group-help + no-such-command
// shapes for planctl's `epic` / `task` (and the close-phase) subgroups.
//
// A subgroup renders `--help` as click's FormattedGroup does: a Usage line, the
// group docstring paragraph, an Options section (the injected --format plus
// --help), and a Commands section whose help column is padded to the widest
// subcommand name and whose help text WRAPS at width 80 with the continuation
// indented to the help column (matching click.HelpFormatter.write_dl). An
// unknown subcommand prints the group usage + try-help on stderr and exits 2,
// byte-identical to click's "No such command".
//
// Leaf runners are looked up in the group's `commands` registry by name; the
// dispatch is data-driven so each verb wave plugs its leaf in without touching
// the dispatch seam.

import {
  type ArgDescriptor,
  type PlanCommand,
  planCommand,
} from "./descriptor.ts";
import type { OutputFormat } from "./format.ts";

const PROG = "keeper plan";
// click's effective help wrap width: max_content_width (80) minus its 2-column
// right margin. Verified against the Python binary's group-help wrap points.
const HELP_WIDTH = 78;

/** One registered subcommand: its listed short help and its leaf runner.
 * `run` receives the post-name argv (the subcommand's own args) plus the
 * resolved top-level --format. */
export interface SubcommandSpec {
  name: string;
  shortHelp: string;
  run: (rest: string[], format: OutputFormat | null) => void;
}

/** A nested command group (`keeper plan <group> <sub> ...`). */
export interface GroupSpec {
  name: string;
  description: string;
  commands: SubcommandSpec[];
}

function groupUsage(group: string): string {
  return `Usage: ${PROG} ${group} [OPTIONS] COMMAND [ARGS]...`;
}

/** click's no-such-command on a subgroup: group usage + try-help on stderr,
 * exit 2. */
export function noSuchSubcommand(group: string, name: string): never {
  process.stderr.write(`${groupUsage(group)}\n`);
  process.stderr.write(`Try '${PROG} ${group} --help' for help.\n\n`);
  process.stderr.write(`Error: No such command '${name}'.\n`);
  process.exit(2);
}

/** click's parameter usage error on a leaf subcommand (e.g. an out-of-Choice
 * --risk): the leaf's own Usage line + try-help on stderr, then `Error:
 * <message>`, exit 2. `argsHint` is the trailing usage tail (e.g. "EPIC_ID") so
 * the line reads `Usage: keeper plan <group> <sub> [OPTIONS] <argsHint>`. */
export function leafUsageError(
  group: string,
  sub: string,
  argsHint: string,
  message: string,
): never {
  const tail = argsHint ? ` ${argsHint}` : "";
  process.stderr.write(`Usage: ${PROG} ${group} ${sub} [OPTIONS]${tail}\n`);
  process.stderr.write(`Try '${PROG} ${group} ${sub} --help' for help.\n\n`);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(2);
}

/** Wrap `text` to `width`, emitting the first line bare and every continuation
 * line prefixed with `indent` spaces — the layout click.HelpFormatter.write_dl
 * produces for a definition's help column. Greedy word wrap on single spaces
 * (planctl's short helps carry no tabs); a word longer than the column is
 * emitted on its own line rather than split, matching click's textwrap defaults
 * for these strings. */
function wrapHelp(text: string, indent: number, width: number): string[] {
  const avail = Math.max(width - indent, 1);
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current === "") {
      current = word;
    } else if (current.length + 1 + word.length <= avail) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") {
    lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
}

/** Render `group --help` byte-identically to click's FormattedGroup: Usage, the
 * description paragraph, the Options section (--format + --help), and a wrapped
 * Commands section. The Commands listing follows registration order; callers
 * register in click's alphabetical list_commands order. */
export function printGroupHelp(group: GroupSpec): void {
  const lines: string[] = [];
  lines.push(groupUsage(group.name));
  lines.push("");
  lines.push(`  ${group.description}`);
  lines.push("");
  lines.push("Options:");
  lines.push("  --format [json|human]       Output format (default: json)");
  lines.push("  --help                      Show this message and exit.");
  lines.push("");
  lines.push("Commands:");

  const nameWidth = Math.max(...group.commands.map((c) => c.name.length));
  // Help column = 2 leading spaces + padded name + 2-space gap.
  const helpCol = 2 + nameWidth + 2;
  for (const cmd of group.commands) {
    const wrapped = wrapHelp(cmd.shortHelp, helpCol, HELP_WIDTH);
    const head = `  ${cmd.name.padEnd(nameWidth)}  ${wrapped[0] ?? ""}`;
    lines.push(head.trimEnd() === "" ? "" : head);
    for (const cont of wrapped.slice(1)) {
      lines.push(`${" ".repeat(helpCol)}${cont}`);
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

/** One positional argument as it appears in a usage line / Arguments listing:
 * `NAME`, `NAME...` (variadic), `[NAME]` (optional). */
function fmtArg(arg: ArgDescriptor): string {
  const base = arg.variadic ? `${arg.name}...` : arg.name;
  return arg.optional ? `[${base}]` : base;
}

/** The ONE shared leaf-help renderer, fed by a pure-data {@link PlanCommand}
 * descriptor. Both a top-level verb (`keeper plan show --help`) and a subgroup
 * verb (`keeper plan epic create --help`) render through this so their documented
 * argument/option surface cannot drift from a second table. `progPath` is the
 * full command path up to and including the verb (e.g. `keeper plan epic create`).
 *
 * Structural shape (Usage + summary + Arguments + Options) is the contract; no
 * conformance test pins the exact bytes, only that `--help` exits 0. The `--format`
 * / `--help` options are injected (click's FormattedGroup convention) after the
 * verb's own options. Exits via the caller after printing — the verb body never
 * runs. */
export function renderLeafHelp(progPath: string, cmd: PlanCommand): void {
  const args = cmd.args ?? [];
  const options = cmd.options ?? [];
  const lines: string[] = [];

  const argsTail = args.map(fmtArg).join(" ");
  lines.push(`Usage: ${progPath} [OPTIONS]${argsTail ? ` ${argsTail}` : ""}`);
  lines.push("");
  for (const wrapped of wrapHelp(cmd.summary, 2, HELP_WIDTH)) {
    lines.push(`  ${wrapped}`);
  }

  if (args.length > 0) {
    lines.push("");
    lines.push("Arguments:");
    for (const arg of args) {
      lines.push(`  ${fmtArg(arg)}`);
    }
  }

  // Verb options first, then the two injected meta options — one uniform column.
  const rows = [
    ...options.map((o) => ({
      label: o.takesValue ? `${o.name} TEXT` : o.name,
      summary: o.summary,
    })),
    {
      label: "--format [json|human]",
      summary: "Output format (default: json)",
    },
    { label: "--help", summary: "Show this message and exit." },
  ];
  const width = Math.max(...rows.map((r) => r.label.length));
  lines.push("");
  lines.push("Options:");
  for (const row of rows) {
    lines.push(`  ${row.label.padEnd(width)}  ${row.summary}`);
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

/** Dispatch `keeper plan <group> <sub> [args]`. `groupArgs` is everything after the
 * group name (the global --format is intercepted before this and passed in).
 * `--help` with no subcommand (or as the first token) prints the group help. A
 * known subcommand whose args carry `--help` renders the descriptor-fed leaf help
 * (exit 0) through the shared renderer. An unknown subcommand exits 2; a known one
 * runs its leaf. */
export function dispatchGroup(
  group: GroupSpec,
  groupArgs: string[],
  format: OutputFormat | null,
): void {
  // No subcommand, or --help before any subcommand -> group help.
  const first = groupArgs[0];
  if (first === undefined || first === "--help") {
    printGroupHelp(group);
    return;
  }

  const spec = group.commands.find((c) => c.name === first);
  if (spec === undefined) {
    noSuchSubcommand(group.name, first);
  }
  // A known leaf with --help in its args renders the leaf help (exit 0) — click
  // intercepts --help before the verb body runs.
  if (groupArgs.slice(1).includes("--help")) {
    const subDesc = planCommand(group.name)?.subcommands?.find(
      (s) => s.name === first,
    );
    // The descriptor tree carries every dispatchable subgroup verb, so a missing
    // entry is a wiring bug; fall back to the spec's short help so `--help` still
    // renders (never a crash) while the leaf's arg surface stays undocumented.
    renderLeafHelp(
      `${PROG} ${group.name} ${spec.name}`,
      subDesc ?? { name: spec.name, summary: spec.shortHelp },
    );
    return;
  }
  spec.run(groupArgs.slice(1), format);
}
