// `keeper prompt <verb>` CLI dispatch — the snippet/bundle substrate engine.
//
// Hand-rolled dispatch modeled on plugins/plan/src/cli.ts: a top-level `--format
// json|human` plumbed to every verb (both positions), `--help` on stdout
// (exit 0) with a Commands section, and an unknown-command error on stderr
// (exit 2).
//
// The keep-verb surface (render, check-generated, render-plugin-templates,
// find-snippets, build-snippets, save-snippet, save-bundle, validate-bundles,
// list-bundles, show-bundle) is pre-wired here to handler stubs. The verb-port
// tasks fill in each `src/<verb>.ts` runner WITHOUT editing this dispatcher — the
// dispatch table, arg parsing, help text, and exit-code contract land once.

import { join, resolve } from "node:path";

import { formatOutput, type OutputFormat } from "../../plan/src/format.ts";
import { runBuildSnippets } from "./build_snippets.ts";
import { run as runCheckGenerated } from "./check_generated.ts";
import { PROMPT_COMMANDS, type PromptCommandDescriptor } from "./descriptor.ts";
import { runFindSnippets } from "./find_snippets.ts";
import { runListBundles } from "./list_bundles.ts";
import { runListSnippets } from "./list_snippets.ts";
import { resolveProjectRoot } from "./project_root.ts";
import { compilePromptArtifacts } from "./prompt_compiler.ts";
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

/** Terse operator runbook (agent-facing), distinct from the full `--help`. Pure —
 *  routed before any verb body so it never reads the corpus or writes. */
const AGENT_HELP = `keeper prompt — operator runbook (agent-facing)

Runtime snippet/bundle substrate — find, read, compose, and persist context. Every
read verb emits exactly ONE top-level JSON value; --format json|yaml|human (default json).

  keeper prompt render <ref>              # render a snippet/bundle to stdout (verbatim body)
  keeper prompt find-snippets "<query>" [--domain <d>] [--limit <n>]
  keeper prompt list-bundles              # available bundles (JSON)
  keeper prompt build-snippets --check    # verify _index.yaml is current (drift gate; no write)
  keeper prompt save-snippet --name <n> --domain <d> --summary <s>

Exit codes: 0 ok · 1 verb error · 2 unknown verb / bad option (Click parity). Footguns:
'build-snippets --check' is the drift gate — it exits non-zero on a stale index and
writes nothing (drop --check to rebuild); warnings go to stderr so --format stdout stays
clean for jq.
`;

interface ParsedArgs {
  format: OutputFormat | null;
  help: boolean;
  agentHelp: boolean;
  command: string | null;
  rest: string[];
}

/** Split argv into the top-level --format/--help/--agent-help and the command + its
 * args. --format is accepted before OR after the command name (mirrors plan's cli);
 * --agent-help is a top-level runbook request honored pre-command. */
function parseArgs(argv: string[]): ParsedArgs {
  let format: OutputFormat | null = null;
  let help = false;
  let agentHelp = false;
  let command: string | null = null;
  const rest: string[] = [];

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i] as string;
    if (command === null) {
      if (arg === "--help" || arg === "-h") {
        help = true;
        i += 1;
      } else if (arg === "--agent-help") {
        agentHelp = true;
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
    } else if (arg === "--help" || arg === "-h") {
      help = true;
      i += 1;
    } else {
      rest.push(arg);
      i += 1;
    }
  }

  return { format, help, agentHelp, command, rest };
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
  lines.push("  --format [json|human|yaml]  Output format (default: json)");
  lines.push("  --help, -h                  Show this message and exit.");
  lines.push("");
  lines.push("Commands:");
  const width = Math.max(...PROMPT_COMMANDS.map((c) => c.name.length));
  for (const cmd of PROMPT_COMMANDS) {
    lines.push(`  ${cmd.name.padEnd(width)}  ${cmd.summary}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

/** Render one verb's `--help` leaf help from its descriptor: a Usage line naming
 * the verb, its summary, an Arguments section (when it takes positionals), and an
 * Options section listing its own flags plus the injected `--format` and
 * `--help`. The verb body never runs — help short-circuits dispatch. */
function printLeafHelp(spec: PromptCommandDescriptor): void {
  const args = spec.args ?? [];
  const usageTail = args
    .map((a) => (a.required ? a.name : `[${a.name}]`))
    .join(" ");
  const lines: string[] = [];
  lines.push(
    `Usage: ${PROG} ${spec.name} [OPTIONS]${usageTail ? ` ${usageTail}` : ""}`,
  );
  lines.push("");
  lines.push(`  ${spec.summary}`);

  if (args.length > 0) {
    lines.push("");
    lines.push("Arguments:");
    const argWidth = Math.max(...args.map((a) => a.name.length));
    for (const a of args) {
      lines.push(`  ${a.name.padEnd(argWidth)}  ${a.summary}`);
    }
  }

  lines.push("");
  lines.push("Options:");
  const rows: [string, string][] = spec.flags.map((f) => [
    `--${f.name}${f.type === "string" ? " TEXT" : ""}`,
    f.summary ?? "",
  ]);
  rows.push(["--format [json|human|yaml]", "Output format (default: json)"]);
  rows.push(["--help, -h", "Show this message and exit."]);
  const optWidth = Math.max(...rows.map(([left]) => left.length));
  for (const [left, right] of rows) {
    lines.push(`  ${left.padEnd(optWidth)}  ${right}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

interface StrictLeafOptions {
  readonly strings: ReadonlyMap<string, string>;
  readonly booleans: ReadonlySet<string>;
}

/** Strict descriptor-driven option parser for compiler publication. No hidden
 * flags, positionals, empty values, or value-bearing booleans are accepted. */
function parseStrictLeafOptions(
  spec: PromptCommandDescriptor,
  args: readonly string[],
): StrictLeafOptions {
  const advertised = new Map(spec.flags.map((flag) => [flag.name, flag]));
  const strings = new Map<string, string>();
  const booleans = new Set<string>();
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (!arg.startsWith("--")) {
      usageError(`${spec.name} does not accept positional argument '${arg}'`);
    }
    const equals = arg.indexOf("=");
    const name = arg.slice(2, equals < 0 ? undefined : equals);
    const flag = advertised.get(name);
    if (flag === undefined) {
      usageError(`No such option for ${spec.name}: --${name}`);
    }
    if (seen.has(name)) {
      usageError(`${spec.name} option --${name} may be specified only once`);
    }
    seen.add(name);
    if (flag.type === "boolean") {
      if (equals >= 0) {
        usageError(`${spec.name} option --${name} does not take a value`);
      }
      booleans.add(name);
      continue;
    }
    let value: string | undefined;
    if (equals >= 0) {
      value = arg.slice(equals + 1);
    } else {
      index += 1;
      value = args[index];
    }
    if (value === undefined || value === "" || value.startsWith("--")) {
      usageError(`${spec.name} option --${name} requires a non-empty value`);
    }
    strings.set(name, value);
  }
  return { strings, booleans };
}

function dispatch(parsed: ParsedArgs): number {
  const { command, format } = parsed;
  if (command === null) {
    printHelp();
    return 0;
  }

  const spec = PROMPT_COMMANDS.find((c) => c.name === command);
  if (spec === undefined) {
    noSuchCommand(command);
  }

  // `--help`/`-h` on ANY resolved verb renders its leaf help and stops before the
  // verb body — never a write, never a daemon touch. An unknown verb is rejected
  // above (exit 2) before help is considered, matching click's group dispatch.
  if (parsed.help) {
    printLeafHelp(spec);
    return 0;
  }

  switch (command) {
    case "compile": {
      const options = parseStrictLeafOptions(spec, parsed.rest);
      const bundle = options.strings.get("bundle");
      const role = options.strings.get("role");
      const target = options.strings.get("target");
      if ((bundle === undefined) === (role === undefined)) {
        usageError("compile requires exactly one of --bundle or --role");
      }
      if (target === undefined) {
        usageError("compile requires --target");
      }
      if (target !== "pi") {
        usageError(`compile does not support target '${target}'`);
      }
      const projectRoot = options.strings.get("project-root");
      const agentDir = options.strings.get("agent-dir");
      try {
        const result = compilePromptArtifacts({
          request: {
            target: "pi",
            ...(bundle === undefined ? { role } : { bundle }),
          },
          check: options.booleans.has("check"),
          repoRoot:
            projectRoot === undefined ? undefined : resolve(projectRoot),
          targetDir:
            agentDir === undefined
              ? undefined
              : join(resolve(agentDir), "agents"),
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return result.ok ? 0 : 1;
      } catch (error) {
        process.stderr.write(
          `Error: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return 1;
      }
    }
    case "render": {
      const ref = positional(parsed.rest, ["--project-root"]);
      const explicit = readOption(parsed.rest, "--project-root") ?? null;
      const projectRoot = resolveProjectRoot(explicit);
      return runRender(ref, projectRoot, format);
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
      const query = positional(parsed.rest, [
        "--domain",
        "--scope",
        "--phase",
        "--bundle",
        "--limit",
        "--project-root",
      ]);
      const explicit = readOption(parsed.rest, "--project-root") ?? null;
      const projectRoot = resolveProjectRoot(explicit);
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
      const ref = positional(parsed.rest, [
        "--snippets",
        "--summary",
        "--tags",
      ]);
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
    case "list-snippets": {
      const explicit = readOption(parsed.rest, "--project-root") ?? null;
      const projectRoot = resolveProjectRoot(explicit);
      const domain = readOption(parsed.rest, "--domain") ?? null;
      return runListSnippets(projectRoot, domain, format, (rows, fmt) =>
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

/** First bare positional in a verb's rest, walking past value-bearing options and
 * their values so `--opt val <positional>` resolves `<positional>` rather than
 * the option's value. `valueOpts` names the `--name value` options the verb
 * accepts; boolean flags (e.g. `--force`) start with `-` and are skipped as
 * non-positionals. `--name=value` forms are self-contained and never consume the
 * following token. */
export function positional(
  rest: string[],
  valueOpts: readonly string[] = [],
): string | undefined {
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (!arg.startsWith("-")) {
      return arg;
    }
    if (valueOpts.includes(arg)) {
      // Skip the option's value so it can't be mistaken for the positional.
      i += 1;
    }
  }
  return undefined;
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
  if (parsed.agentHelp) {
    // Pure: static runbook text, rendered before any verb body or corpus read.
    process.stdout.write(AGENT_HELP);
    return 0;
  }
  return dispatch(parsed);
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
