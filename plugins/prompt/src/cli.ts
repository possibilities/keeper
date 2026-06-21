// `keeper prompt <verb>` CLI dispatch — the snippet/bundle substrate engine.
//
// Hand-rolled dispatch modeled on plugins/plan/src/cli.ts: a top-level `--format
// json|yaml|human` plumbed to every verb (both positions), `--help` on stdout
// (exit 0) with a Commands section, and an unknown-command error on stderr
// (exit 2).
//
// The keep-verb surface (render, check-generated, render-plugin-templates,
// find-snippets, build-snippets, save-snippet, save-bundle, validate-bundles,
// list-bundles, show-bundle) is pre-wired here to handler stubs. The verb-port
// tasks fill in each `src/<verb>.ts` runner WITHOUT editing this dispatcher — the
// dispatch table, arg parsing, help text, and exit-code contract land once.

import { formatOutput, type OutputFormat } from "../../plan/src/format.ts";
import { runBuildSnippets } from "./build_snippets.ts";
import { run as runCheckGenerated } from "./check_generated.ts";
import { runFindSnippets } from "./find_snippets.ts";
import { runListBundles } from "./list_bundles.ts";
import { resolveProjectRoot } from "./project_root.ts";
import { run as runRender } from "./render.ts";
import { runRenderPluginTemplates } from "./render_plugin_templates.ts";
import { runSaveBundle } from "./save_bundle.ts";
import { runSaveSnippet } from "./save_snippet.ts";
import { runShowBundle } from "./show_bundle.ts";
import { runValidateBundles } from "./validate_bundles.ts";

const PROG = "keeper prompt";
const USAGE = `Usage: ${PROG} [OPTIONS] COMMAND [ARGS]...`;
const DESCRIPTION =
  "Runtime snippet/bundle substrate — find, read, compose, and persist context.";

interface CommandSpec {
  name: string;
  shortHelp: string;
}

// Registration order = help-listing order (alphabetical, matching click).
const COMMANDS: CommandSpec[] = [
  {
    name: "build-snippets",
    shortHelp: "Build _partials/snippets/_index.yaml from classified snippets.",
  },
  {
    name: "check-generated",
    shortHelp:
      "Detect the managed-file sidecar; emit the generated-guard message.",
  },
  {
    name: "find-snippets",
    shortHelp: "BM25-rank snippets against a query, with excerpts.",
  },
  {
    name: "list-bundles",
    shortHelp: "List bundles across one or all runtime namespaces.",
  },
  {
    name: "render",
    shortHelp: "Render a substrate ref (bundle/, sketch/, or bare snippet id).",
  },
  {
    name: "render-plugin-templates",
    shortHelp: "Render every plugin's command/skill/agent templates.",
  },
  {
    name: "save-bundle",
    shortHelp: "Atomically write a runtime bundle (bundle/ or sketch/).",
  },
  {
    name: "save-snippet",
    shortHelp: "Atomically write a snippet and update _index.yaml.",
  },
  {
    name: "show-bundle",
    shortHelp: "Load and emit a single bundle YAML by ref.",
  },
  {
    name: "validate-bundles",
    shortHelp: "Resolve every bundle snippet_id; non-zero on any miss.",
  },
];

interface ParsedArgs {
  format: OutputFormat | null;
  help: boolean;
  command: string | null;
  rest: string[];
}

/** Split argv into the top-level --format/--help and the command + its args.
 * --format is accepted before OR after the command name (mirrors plan's cli). */
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
        usageError(`No such option: ${arg}`);
      } else {
        command = arg;
        i += 1;
      }
    } else if (arg === "--format") {
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

function dispatch(parsed: ParsedArgs): number {
  const { command, format } = parsed;
  if (command === null) {
    printHelp();
    return 0;
  }

  const spec = COMMANDS.find((c) => c.name === command);
  if (spec === undefined) {
    noSuchCommand(command);
  }

  // Every keep-verb is pre-wired to a stub. Verb-port tasks (3/4/5) replace the
  // matching case body with a call into its `src/<verb>.ts` runner.
  switch (command) {
    case "render": {
      const ref = parsed.rest.find((a) => !a.startsWith("-"));
      return runRender(ref, format);
    }
    case "check-generated": {
      const file = parsed.rest.find((a) => !a.startsWith("-"));
      return runCheckGenerated(file, readOption(parsed.rest, "--on"));
    }
    case "render-plugin-templates": {
      const explicit = readOption(parsed.rest, "--project-root") ?? null;
      const projectRoot = resolveProjectRoot(explicit);
      return runRenderPluginTemplates({ projectRoot });
    }
    case "build-snippets": {
      const check = parsed.rest.includes("--check");
      const projectRoot = resolveProjectRoot(null);
      return runBuildSnippets({ check, projectRoot });
    }
    case "find-snippets": {
      const query = positional(parsed.rest);
      const projectRoot = resolveProjectRoot(null);
      const limitStr = readOption(parsed.rest, "--limit");
      return runFindSnippets(
        query,
        projectRoot,
        {
          domain: readOption(parsed.rest, "--domain") ?? null,
          scope: readOption(parsed.rest, "--scope") ?? null,
          phase: readOption(parsed.rest, "--phase") ?? null,
          bundle: readOption(parsed.rest, "--bundle") ?? null,
          limit: limitStr !== undefined ? Number(limitStr) : undefined,
        },
        format,
        (rows, fmt) => formatOutput(rows, fmt),
      );
    }
    case "save-snippet": {
      const projectRoot = resolveProjectRoot(null);
      return runSaveSnippet(
        projectRoot,
        {
          name: readOption(parsed.rest, "--name") ?? "",
          domain: readOption(parsed.rest, "--domain") ?? "",
          summary: readOption(parsed.rest, "--summary") ?? "",
          body: readOption(parsed.rest, "--body") ?? null,
          tags: readOption(parsed.rest, "--tags") ?? null,
          scope: readOption(parsed.rest, "--scope") ?? null,
          phase: readOption(parsed.rest, "--phase") ?? null,
          related: readOption(parsed.rest, "--related") ?? null,
          audience: readOption(parsed.rest, "--audience") ?? null,
          severity: readOption(parsed.rest, "--severity") ?? null,
          force: parsed.rest.includes("--force"),
        },
        format,
        (row, fmt) => formatOutput(row, fmt),
      );
    }
    case "save-bundle": {
      const ref = positional(parsed.rest);
      const projectRoot = resolveProjectRoot(null);
      return runSaveBundle(
        ref,
        projectRoot,
        {
          snippets: readOption(parsed.rest, "--snippets") ?? null,
          summary: readOption(parsed.rest, "--summary") ?? null,
          tags: readOption(parsed.rest, "--tags") ?? null,
          append: parsed.rest.includes("--append"),
          force: parsed.rest.includes("--force"),
        },
        format,
        (row, fmt) => formatOutput(row, fmt),
      );
    }
    case "validate-bundles": {
      const projectRoot = resolveProjectRoot(null);
      return runValidateBundles(projectRoot);
    }
    case "list-bundles": {
      const projectRoot = resolveProjectRoot(null);
      const namespace = readOption(parsed.rest, "--namespace") ?? null;
      return runListBundles(projectRoot, namespace, format, (rows, fmt) =>
        formatOutput(rows, fmt),
      );
    }
    case "show-bundle": {
      const ref = positional(parsed.rest);
      const projectRoot = resolveProjectRoot(null);
      return runShowBundle(ref, projectRoot, format, (row, fmt) =>
        formatOutput(row, fmt),
      );
    }
    default:
      noSuchCommand(command);
  }
}

/** First non-flag positional in a verb's rest (skips `--flag value` pairs is the
 * caller's job — here we just take the first arg not starting with `-`). */
function positional(rest: string[]): string | undefined {
  return rest.find((a) => !a.startsWith("-"));
}

/** Read the value of a `--name value` or `--name=value` option from a verb's
 * positional rest. Returns undefined when absent. */
function readOption(rest: string[], name: string): string | undefined {
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (arg === name) {
      return rest[i + 1];
    }
    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

export function main(argv: string[]): number {
  const parsed = parseArgs(argv);
  if (parsed.help && parsed.command === null) {
    printHelp();
    return 0;
  }
  return dispatch(parsed);
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
