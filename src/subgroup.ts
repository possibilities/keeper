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

import type { OutputFormat } from "./format.ts";

const PROG = "planctl";
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

/** A nested command group (`planctl <group> <sub> ...`). */
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
  lines.push("  --format [json|yaml|human]  Output format (default: json)");
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

/** Dispatch `planctl <group> <sub> [args]`. `groupArgs` is everything after the
 * group name (the global --format is intercepted before this and passed in).
 * `--help` with no subcommand (or as the first token) prints the group help and
 * returns true to signal the caller to stop. An unknown subcommand exits 2; a
 * known one runs its leaf. Returns true when handled. */
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
  spec.run(groupArgs.slice(1), format);
}
