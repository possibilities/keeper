#!/usr/bin/env bun
/**
 * `keeper` CLI dispatcher. Routes the first positional argv token to its
 * subcommand main; surfaces top-level help and version. Every subcommand
 * resolves to a `cli/<sub>.ts` module exporting its own `main(argv)`.
 *
 * Contract (per the spec's gap analysis):
 *   - Bare `keeper` → usage block on stderr, exit 1.
 *   - Unknown subcommand → usage block on stderr, exit 1.
 *   - `keeper --version` → version line on stdout, exit 0.
 *   - `keeper --help` / `keeper -h` → usage block on stdout, exit 0.
 *   - `keeper <sub> --help` → forwards the flag through to the subcommand's
 *     own `HELP` block (each subcommand main parses `--help` itself).
 *
 * Why a dispatch() factory with injectable handlers: the unit test in
 * `test/keeper-cli.test.ts` exercises routing without spawning a renderer.
 * Production code calls `main()` which wires the real subcommand mains.
 */

import { Clerc, defineCommand } from "@clerc/core";
import { completionsPlugin } from "@clerc/plugin-completions";
import packageJson from "../package.json" with { type: "json" };
import {
  type OptionDescriptor,
  PLAN_COMMANDS,
  type PlanCommand,
} from "../plugins/plan/src/descriptor.ts";
import { PROMPT_COMMANDS } from "../plugins/prompt/src/descriptor.ts";
import {
  type CommandDescriptor,
  type FlagDescriptor,
  type FormatMode,
  NATIVE_COMMANDS,
  type Visibility,
} from "./descriptor";

export const SUBCOMMANDS = [
  "board",
  "jobs",
  "dead-letter",
  "git",
  "autopilot",
  "usage",
  "frames",
  "dash",
  "status",
  "daemon",
  "query",
  "watch",
  "await",
  "commit-work",
  "baseline",
  "setup-tmux",
  "tabs",
  "session",
  "conversation",
  "transcript",
  "history",
  "resume",
  "show-job",
  "escalation-brief",
  "incident",
  "plan",
  "prompt",
  "projects",
  "note",
  "repo",
  "dispatch",
  "handoff",
  "agent",
  "reclaim",
  "bus",
  "statusline",
  "statusline-sink",
  "completions",
] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

/**
 * Per-subcommand metadata — a back-compat PROJECTION of the native descriptor
 * tree (`cli/descriptor.ts`, ADR 0008), which is the single source of truth for
 * every summary, verb list, and flag surface. The hand-maintained verb tables
 * retired: `SUBCOMMAND_META` now derives from `NATIVE_COMMANDS`, so it cannot
 * drift from the descriptor. `verbs` flattens a two-level subcommand's verb
 * names; `agentHelp` marks a subcommand carrying a `--agent-help` runbook.
 */
export interface SubcommandMeta {
  readonly summary: string;
  readonly verbs?: readonly string[];
  readonly agentHelp?: boolean;
}

function projectMeta(c: CommandDescriptor): SubcommandMeta {
  return {
    summary: c.summary,
    ...(c.verbs !== undefined ? { verbs: c.verbs.map((v) => v.name) } : {}),
    ...(c.agent_help === true ? { agentHelp: true } : {}),
  };
}

export const SUBCOMMAND_META: Record<Subcommand, SubcommandMeta> =
  Object.fromEntries(
    NATIVE_COMMANDS.map((c) => [c.name, projectMeta(c)]),
  ) as Record<Subcommand, SubcommandMeta>;

/** The public (non-internal) descriptors, in canonical order — the ones the
 *  human `USAGE` block lists. `internal` wiring commands are omitted here yet
 *  still carried in `keeper --help --json`. */
const PUBLIC_DESCRIPTORS: readonly CommandDescriptor[] = NATIVE_COMMANDS.filter(
  (c) => c.visibility !== "internal",
);

/** One plan `--flag` → a native `FlagDescriptor`. `--project` → `project`;
 *  `takesValue` picks string vs. boolean (the two `parseArgs` shapes). */
function planOptionToFlag(o: OptionDescriptor): FlagDescriptor {
  return {
    name: o.name.replace(/^-+/, ""),
    type: o.takesValue ? "string" : "boolean",
    summary: o.summary,
  };
}

/**
 * Project one plan-descriptor command to the native `CommandDescriptor` the
 * `--help --json` index and completion tree consume. The plan CLI's pure-data
 * descriptor models name/summary/args/options/subcommands but NOT mutation,
 * daemon, or TTY needs — the plan dispatcher runs in-process, so `requires_daemon`
 * and `requires_tty` are truthfully `false`, and per-verb mutation is unmodeled
 * there, so it projects to `false` (the parent `plan` node already carries
 * `mutates: true`). The verb SET — names, flags, summaries, nesting — is what
 * these two introspection surfaces read.
 */
function planVerbToDescriptor(p: PlanCommand): CommandDescriptor {
  const base: CommandDescriptor = {
    name: p.name,
    summary: p.summary,
    visibility: "public",
    mutates: false,
    requires_daemon: false,
    requires_tty: false,
    flags: (p.options ?? []).map(planOptionToFlag),
  };
  return p.subcommands === undefined
    ? base
    : { ...base, verbs: p.subcommands.map(planVerbToDescriptor) };
}

let mergedCommandsCache: readonly CommandDescriptor[] | undefined;

/**
 * The native command tree with the `plan` and `prompt` verb sets merged in from
 * the plugins' OWN pure-data descriptor modules (ADR 0008) — the single anti-drift
 * seam feeding `keeper --help --json` and `buildCompletionCli`. Every other node
 * passes through `NATIVE_COMMANDS` untouched; only the two plugin subcommands gain
 * their verbs, so the dispatch tree (`buildKeeperCli`) — which reads
 * `SUBCOMMAND_META`, never this — keeps its residual pass-through unaffected. The
 * prompt descriptor is already `CommandDescriptor`-shaped; the plan descriptor is
 * projected via {@link planVerbToDescriptor}. Cached: the projection runs once, on
 * the first help/completion call, not on every dispatch.
 */
function mergedCommandTree(): readonly CommandDescriptor[] {
  if (mergedCommandsCache === undefined) {
    mergedCommandsCache = NATIVE_COMMANDS.map((c) =>
      c.name === "plan"
        ? { ...c, verbs: PLAN_COMMANDS.map(planVerbToDescriptor) }
        : c.name === "prompt"
          ? { ...c, verbs: PROMPT_COMMANDS }
          : c,
    );
  }
  return mergedCommandsCache;
}

/**
 * The shared exit-code taxonomy, published in `keeper --help --json` so every
 * one-shot command's exit semantics live in one machine-readable place. Codes
 * 0/1/2 are the common core; 3–5 and 9 are await-specific (and 3 doubles as
 * handoff's slug-collision). The one deliberate DIVERGENCE: `keeper <sub>`
 * unknown-subcommand exits 1, but the `plan`/`prompt` sub-CLIs exit 2 on an
 * unknown VERB (Click/argparse parity is frozen for Python byte-compat) —
 * documented here rather than silently reconciled.
 */
export const EXIT_CODES: Record<string, string> = {
  "0": "success — a bad board/domain state is still ok:true data at exit 0, never a nonzero exit",
  "1": "transport/usage/generic failure — the JSON error envelope still lands on stdout, never empty stdout + stderr prose",
  "2": "argument fault (dispatch/handoff/commit-work bad flags); also the plan/prompt sub-CLIs' unknown-verb exit (Click parity), whereas a keeper unknown-subcommand exits 1",
  "3": "await: own-deadline timeout; handoff: slug already in use",
  "4": "await: watched target was deleted",
  "5": "await: stuck verdict (only under --fail-on-stuck)",
  "6": "tabs restore: refused a non-TTY AMBIGUOUS selection (ranked table on stderr) — re-run with --generation <id> or on a TTY",
  "7": "tabs restore --apply: ZERO candidates without --allow-empty",
  "8": "tabs restore --apply: PARTIAL launch failure (restored/failed summary printed)",
  "9": "await --probe: evaluated cleanly, condition does not hold",
  "124":
    "agent panel wait: a chunk elapsed with no terminal answer — a re-issue signal to poll again, NOT a failure",
};

/** The `keeper --help --json` command index. A discovery/introspection surface,
 *  deliberately EXEMPT from the `{schema_version, ok, error, data}` one-shot
 *  envelope (like `watch`/`cat`) — it is neither a state read nor a mutate and
 *  cannot fail transport, so it prints its shape flat for a direct `jq
 *  '.subcommands'`. */
export interface HelpIndexFlag {
  name: string;
  type: FlagDescriptor["type"];
  short?: string;
  multiple?: boolean;
  default?: boolean | string;
  summary?: string;
}

/** One command node in the recursive `--help --json` tree — the descriptor
 *  projected to a JSON-friendly shape. `verbs`, when present, holds the same
 *  node type recursively (a two-level subcommand's verbs). */
export interface HelpIndexCommand {
  name: string;
  summary: string;
  visibility: Visibility;
  mutates: boolean;
  requires_daemon: boolean;
  requires_tty: boolean;
  agent_help: boolean;
  format_modes?: readonly FormatMode[];
  exit_codes?: Readonly<Record<string, string>>;
  flags: readonly HelpIndexFlag[];
  verbs?: readonly HelpIndexCommand[];
}

export interface HelpIndex {
  /** Self-describing note: the shape a machine consumer should expect. */
  schema: string;
  subcommands: readonly HelpIndexCommand[];
  exit_codes: Record<string, string>;
}

const HELP_INDEX_SCHEMA =
  "recursive command tree; each node = {name, summary, visibility, mutates, requires_daemon, requires_tty, agent_help, format_modes?, exit_codes?, flags[], verbs?}; top-level exit_codes is the shared taxonomy (per-command exit_codes carry the divergences)";

function toIndexFlag(f: FlagDescriptor): HelpIndexFlag {
  const flag: HelpIndexFlag = { name: f.name, type: f.type };
  if (f.short !== undefined) flag.short = f.short;
  if (f.multiple !== undefined) flag.multiple = f.multiple;
  if (f.default !== undefined) flag.default = f.default;
  if (f.summary !== undefined) flag.summary = f.summary;
  return flag;
}

function toIndexCommand(c: CommandDescriptor): HelpIndexCommand {
  const node: HelpIndexCommand = {
    name: c.name,
    summary: c.summary,
    visibility: c.visibility,
    mutates: c.mutates,
    requires_daemon: c.requires_daemon,
    requires_tty: c.requires_tty,
    agent_help: c.agent_help === true,
    flags: c.flags.map(toIndexFlag),
  };
  if (c.format_modes !== undefined) node.format_modes = c.format_modes;
  if (c.exit_codes !== undefined) node.exit_codes = c.exit_codes;
  if (c.verbs !== undefined) node.verbs = c.verbs.map(toIndexCommand);
  return node;
}

/** The `keeper --help --json` payload: the full recursive descriptor tree
 *  (every subcommand, INCLUDING `visibility:internal` ones) plus the shared
 *  exit-code taxonomy. Generated from the merged tree — native leaves plus the
 *  plan/prompt plugin descriptors' live verb sets — so the index cannot drift
 *  from either the native surface or the plugins' dispatchable reality. */
export function buildHelpIndex(): HelpIndex {
  return {
    schema: HELP_INDEX_SCHEMA,
    subcommands: mergedCommandTree().map(toIndexCommand),
    exit_codes: EXIT_CODES,
  };
}

const SUBCOMMAND_LINES = PUBLIC_DESCRIPTORS.map(
  (c) => `  ${c.name.padEnd(19)} ${c.summary}`,
).join("\n");

export const USAGE = `keeper — unified CLI for the keeper TUIs

Usage:
  keeper <subcommand> [options]

Subcommands:
${SUBCOMMAND_LINES}

Flags:
  --help, -h     Show this help (\`--help --json\` → machine-readable command index)
  --version, -V  Show keeper version

The five snapshot-capable viewer subcommands (board/jobs/git/autopilot/usage)
auto-detect a non-TTY stdout (piped, redirected, CI) and emit ONE current frame
followed by a machine-parseable \`keeper-meta:\` JSON line, then exit — instead of
streaming forever. Override per subcommand with \`--snapshot\` (force one-shot on a
TTY), \`--watch\` (force the live stream even when piped — never exits), or
\`--timeout <s>\` (snapshot wait, ~2s default). \`dash\` is the exception: it is
TTY-ONLY (no snapshot mode), so a non-TTY stdout exits 1 rather than printing a
frame.

Run \`keeper <subcommand> --help\` for subcommand-specific options, and
\`keeper --help --json\` for the machine-readable command index + exit-code table.
`;

export type SubcommandHandler = (argv: string[]) => Promise<void> | void;

export interface DispatchDeps {
  /** Map of subcommand name → its `main(argv)` entry point. */
  handlers: Record<Subcommand, SubcommandHandler>;
  /** Sink for usage / version output (stdout in prod, captured in tests). */
  stdout: (s: string) => void;
  /** Sink for error output (stderr in prod, captured in tests). */
  stderr: (s: string) => void;
  /** Process exit shim — tests inject a thrower; prod uses `process.exit`. */
  exit: (code: number) => never;
  /** Source of truth for `--version`. */
  version: string;
}

/**
 * Build the Clerc-backed top-level command tree. Each public subcommand is a
 * PROXY command: its `ignore` hook stops parsing at the command path so Clerc
 * captures the entire residual argv verbatim in `context.ignored`, and the proxy
 * handler forwards that untouched array to the subcommand's own `main(argv)`.
 * This is the "proxy before leaf migration" seam — the framework owns command
 * discovery (and, later, completion generation) while every leaf keeps its
 * established parser and exit-code contract.
 *
 * Two-level verbs (`plan <verb>`, `prompt <verb>`, …) are deliberately NOT
 * registered as nested Clerc commands: a nested `plan status` command would make
 * Clerc's command resolver match the longer path and strip `status` out of the
 * residual, breaking the leaf-owned pass-through. Their verb tokens ride in the
 * residual instead; completion candidates come from the descriptor tree's verbs.
 */
export function buildKeeperCli(deps: {
  handlers: Record<Subcommand, SubcommandHandler>;
  version: string;
}): Clerc {
  const commands = SUBCOMMANDS.map((name) =>
    defineCommand(
      {
        name,
        description: SUBCOMMAND_META[name].summary,
        // Returning true on the very first residual token pushes that token and
        // every token after it into `context.ignored` untouched — never parsing
        // or normalizing a leaf's flags.
        ignore: () => true,
      },
      (ctx) => deps.handlers[name](ctx.ignored),
    ),
  );
  return Clerc.create({
    name: "keeper",
    scriptName: "keeper",
    version: deps.version,
  }).command(commands);
}

/** The shells `keeper completions <shell>` generates a script for. Deliberately
 *  a subset of the Clerc plugin's shells — powershell is unsupported. */
export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

export function isCompletionShell(s: string): s is CompletionShell {
  return (COMPLETION_SHELLS as readonly string[]).includes(s);
}

/** The hidden responder token. Generated scripts invoke `keeper complete -- <words>`
 *  on every TAB; it is a real command path but deliberately NOT a SUBCOMMAND, so
 *  `keeper --help --json` and the USAGE index never list it. */
export const COMPLETION_RESPONDER = "complete";

/**
 * Build a throwaway Clerc CLI whose command tree mirrors keeper's public surface
 * — every SUBCOMMAND plus each two-level verb registered as a `"<name> <verb>"`
 * nested command — wired to the completions plugin. It exists ONLY to generate
 * completion scripts and serve the hidden responder; it is never a dispatch
 * path. That separation is deliberate: registering the verbs as nested commands
 * (which would break `buildKeeperCli`'s residual pass-through) is safe here and
 * is exactly what lets the responder suggest `keeper plan <verb>`. `completions`
 * is skipped — the plugin registers that command (and the hidden `complete`)
 * itself, so both surface as candidates without a double registration.
 *
 * Built from the merged tree (ADR 0008): the completion surface is generated from
 * the SAME descriptor tree as `keeper --help --json` — native leaves plus the
 * plan/prompt plugin descriptors' verb sets — so a command or verb can never be
 * completable but undocumented, or vice versa, and plugin verbs cannot drift from
 * their dispatchable reality.
 */
export function buildCompletionCli(version: string): Clerc {
  const commands = mergedCommandTree()
    .filter((c) => c.name !== "completions")
    .flatMap((c) => {
      const parent = defineCommand({
        name: c.name,
        description: c.summary,
      });
      const verbs = (c.verbs ?? []).map((verb) =>
        defineCommand({
          name: `${c.name} ${verb.name}`,
          description:
            verb.summary === verb.name
              ? `${c.name} ${verb.name}`
              : verb.summary,
        }),
      );
      return [parent, ...verbs];
    });
  return Clerc.create({ name: "keeper", scriptName: "keeper", version })
    .command(commands)
    .use(completionsPlugin());
}

/** Run a completion-CLI parse with `console.log` (the plugin's sole output sink
 *  for both scripts and candidate lines) captured, and return the emitted text
 *  reproducing the real stdout (one trailing newline per logged line). */
async function captureConsoleLog(run: () => Promise<unknown>): Promise<string> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(
      args.map((a) => (typeof a === "string" ? a : String(a))).join(" "),
    );
  };
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines.map((line) => `${line}\n`).join("");
}

/** Generate the framework completion script for a shell (the `keeper completions
 *  <shell>` payload). */
export function generateCompletionScript(
  shell: CompletionShell,
  version: string,
): Promise<string> {
  return captureConsoleLog(() =>
    buildCompletionCli(version).parse(["completions", shell]),
  );
}

/** Serve one completion request. `words` are the argv tokens the generated
 *  script passes after `keeper complete --` (e.g. `["plan", ""]` for `keeper
 *  plan <TAB>`); returns the candidate lines (`value\tdescription`, plus the
 *  plugin's trailing directive line). */
export function completionResponder(
  words: string[],
  version: string,
): Promise<string> {
  return captureConsoleLog(() =>
    buildCompletionCli(version).parse([COMPLETION_RESPONDER, "--", ...words]),
  );
}

export const COMPLETIONS_HELP = `Usage: keeper completions <${COMPLETION_SHELLS.join(
  "|",
)}>

Emit a shell completion script for keeper on stdout. Source it (or install it
where your shell auto-loads completions) so <TAB> suggests subcommands + verbs.
The script wires <TAB> back to the hidden \`keeper complete\` responder, which
reads the same descriptor tree as \`keeper --help --json\` — so completions can
never drift from the dispatchable surface.

  bash   eval "$(keeper completions bash)"   (or write to a bash-completion.d file)
  zsh    keeper completions zsh > "\${fpath[1]}/_keeper"
  fish   keeper completions fish > ~/.config/fish/completions/keeper.fish
`;

/** The `keeper completions <shell>` handler: validate the shell against keeper's
 *  supported set, emit the framework-generated script, exit 0. `--help`/`-h`
 *  prints usage (exit 0, no state touched); a missing/unknown shell is an arg
 *  fault (exit 2) naming the supported shells — never a silent empty script. */
export async function runCompletionsCommand(
  argv: string[],
  io: {
    stdout: (s: string) => void;
    stderr: (s: string) => void;
    exit: (code: number) => never;
    version: string;
  },
): Promise<void> {
  const shell = argv[0];
  if (shell === "--help" || shell === "-h") {
    io.stdout(COMPLETIONS_HELP);
    return;
  }
  if (shell === undefined || !isCompletionShell(shell)) {
    io.stderr(
      `keeper completions: expected a shell (${COMPLETION_SHELLS.join("|")}), got ${
        shell === undefined ? "nothing" : `'${shell}'`
      }\n`,
    );
    io.exit(2);
  }
  io.stdout(await generateCompletionScript(shell, io.version));
}

/**
 * Pure dispatch: handles the top-level special cases (bare / unknown / --help /
 * --version / the hidden completion responder) with their pinned
 * stdout/stderr/exit contracts, then routes a known subcommand through the Clerc
 * proxy tree, which forwards the residual argv verbatim to the subcommand's
 * handler. Never returns on the special cases (always calls `exit`); awaits the
 * proxy route otherwise so the caller can `await` it.
 */
export async function dispatch(
  argv: string[],
  deps: DispatchDeps,
): Promise<void> {
  // Top-level flags MUST be examined before subcommand routing — otherwise
  // `keeper --help` (a valid invocation) would fall into the "unknown
  // subcommand" branch and exit non-zero.
  if (argv.length === 0) {
    deps.stderr(USAGE);
    deps.exit(1);
  }

  const first = argv[0] as string;

  if (first === "--version" || first === "-V") {
    deps.stdout(`keeper ${deps.version}\n`);
    deps.exit(0);
  }

  if (first === "--help" || first === "-h") {
    // `keeper --help --json` → the machine-readable command index (a flat,
    // envelope-exempt introspection shape); plain `--help` → the human USAGE.
    if (argv.includes("--json")) {
      deps.stdout(`${JSON.stringify(buildHelpIndex(), null, 2)}\n`);
      deps.exit(0);
    }
    deps.stdout(USAGE);
    deps.exit(0);
  }

  // Hidden completion responder. Generated scripts invoke `keeper complete --
  // <words>` on every TAB; it is a real command path deliberately kept OUT of
  // SUBCOMMANDS (so it never appears in `keeper --help --json` or USAGE). Route
  // it explicitly, before the unknown-subcommand guard, so every OTHER unknown
  // token still errors exactly as before.
  if (first === COMPLETION_RESPONDER) {
    const sep = argv.indexOf("--");
    const words = sep === -1 ? argv.slice(1) : argv.slice(sep + 1);
    deps.stdout(await completionResponder(words, deps.version));
    deps.exit(0);
  }

  if (!isSubcommand(first)) {
    deps.stderr(`keeper: unknown subcommand '${first}'\n\n`);
    deps.stderr(USAGE);
    deps.exit(1);
  }

  // Route the known subcommand through the Clerc proxy tree. The proxy's `ignore`
  // hook hands the leaf handler the exact residual argv (`argv.slice(1)`).
  await buildKeeperCli(deps).parse(argv);
}

export function isSubcommand(s: string): s is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(s);
}

export async function main(): Promise<void> {
  // Lazy-load subcommand modules so a `dispatch()` unit test that injects
  // stub handlers never pays the cost of importing the real (eventually
  // OpenTUI-backed) renderers. Each `cli/<sub>.ts` exports `main(argv)`.
  const handlers: Record<Subcommand, SubcommandHandler> = {
    board: async (argv) => (await import("./board")).main(argv),
    jobs: async (argv) => (await import("./jobs")).main(argv),
    "dead-letter": async (argv) => (await import("./dead-letter")).main(argv),
    git: async (argv) => (await import("./git")).main(argv),
    autopilot: async (argv) => (await import("./autopilot")).main(argv),
    usage: async (argv) => (await import("./usage")).main(argv),
    frames: async (argv) => (await import("./frames")).main(argv),
    dash: async (argv) => (await import("./dash")).main(argv),
    status: async (argv) => (await import("./status")).main(argv),
    daemon: async (argv) => (await import("./daemon")).main(argv),
    query: async (argv) => (await import("./query")).main(argv),
    watch: async (argv) => (await import("./watch")).main(argv),
    await: async (argv) => (await import("./await")).main(argv),
    "commit-work": async (argv) => (await import("./commit-work")).main(argv),
    baseline: async (argv) => (await import("./baseline")).main(argv),
    "setup-tmux": async (argv) => (await import("./setup-tmux")).main(argv),
    tabs: async (argv) => (await import("./tabs")).main(argv),
    session: async (argv) => (await import("./session")).main(argv),
    conversation: async (argv) => (await import("./conversation")).main(argv),
    transcript: async (argv) => (await import("./transcript")).main(argv),
    history: async (argv) => (await import("./history")).main(argv),
    resume: async (argv) => (await import("./resume")).main(argv),
    "show-job": async (argv) => (await import("./show-job")).main(argv),
    "escalation-brief": async (argv) =>
      (await import("./escalation-brief")).main(argv),
    incident: async (argv) => (await import("./incident")).main(argv),
    plan: async (argv) => (await import("./plan")).main(argv),
    prompt: async (argv) => (await import("./prompt")).main(argv),
    projects: async (argv) => (await import("./projects")).main(argv),
    note: async (argv) => (await import("./note")).main(argv),
    repo: async (argv) => (await import("./repo")).main(argv),
    dispatch: async (argv) => (await import("./dispatch")).main(argv),
    handoff: async (argv) => (await import("./handoff")).main(argv),
    agent: async (argv) => (await import("./agent")).main(argv),
    reclaim: async (argv) => (await import("./reclaim")).main(argv),
    bus: async (argv) => (await import("./bus")).main(argv),
    statusline: async (argv) => (await import("./statusline")).main(argv),
    "statusline-sink": async (argv) =>
      (await import("./statusline-sink")).main(argv),
    completions: (argv) =>
      runCompletionsCommand(argv, {
        stdout: (s) => process.stdout.write(s),
        stderr: (s) => process.stderr.write(s),
        exit: (code) => process.exit(code),
        version: packageJson.version,
      }),
  };

  await dispatch(Bun.argv.slice(2), {
    handlers,
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    exit: (code) => process.exit(code),
    version: packageJson.version,
  });
}

if (import.meta.main) {
  void main();
}
