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

export const SUBCOMMANDS = [
  "board",
  "jobs",
  "git",
  "usage",
  "autopilot",
  "builds",
  "dash",
  "status",
  "query",
  "watch",
  "await",
  "commit-work",
  "baseline",
  "setup-tmux",
  "tabs",
  "session-state",
  "show-session-files",
  "search-history",
  "find-file-history",
  "show-session-events",
  "show-job",
  "session-summary",
  "plan",
  "prompt",
  "dispatch",
  "handoff",
  "agent",
  "reclaim",
  "bus",
  "statusline-sink",
  "completions",
] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

/**
 * Per-subcommand metadata — the SINGLE source of truth the human `USAGE` block
 * and the machine `keeper --help --json` command index are both generated from,
 * so the two can never drift. `verbs` enumerates a two-level subcommand's verb
 * names (a static table the dispatcher owns, NOT introspected from the sub-CLI);
 * `agentHelp` marks a subcommand that carries a `--agent-help` operator runbook
 * distinct from `--help` (the index publishes this so an agent never assumes a
 * runbook that isn't there). The `Record<Subcommand, …>` type enforces that a
 * new subcommand cannot land without a summary.
 */
export interface SubcommandMeta {
  readonly summary: string;
  readonly verbs?: readonly string[];
  readonly agentHelp?: boolean;
}

export const SUBCOMMAND_META: Record<Subcommand, SubcommandMeta> = {
  board: {
    summary: "Epics board (TTY: live TUI; non-TTY: one snapshot + exit)",
  },
  jobs: {
    summary:
      "Jobs list w/ dead-letter banner + 'r' replay (TTY: live; non-TTY: snapshot)",
  },
  git: {
    summary: "Git status frames (TTY: live TUI; non-TTY: one snapshot + exit)",
  },
  usage: {
    summary: "Usage frames (TTY: live TUI; non-TTY: one snapshot + exit)",
  },
  autopilot: {
    summary:
      "Dispatch log viewer (TTY: live TUI; non-TTY: one snapshot + exit)",
    verbs: [
      "pause",
      "play",
      "mode",
      "config",
      "arm",
      "disarm",
      "worktree",
      "retry",
    ],
    agentHelp: true,
  },
  builds: {
    summary:
      "Buildbot status dashboard (TTY: live TUI; non-TTY: one snapshot + exit)",
  },
  dash: {
    summary: "Read-only opening screen: header + PLAN + AGENTS (TTY-only)",
  },
  status: {
    summary:
      "One-shot unified board + autopilot JSON read (orient in one call)",
  },
  query: {
    summary: "One-shot read of an allowlisted daemon collection (JSON)",
  },
  watch: { summary: "NDJSON tail of coarse board deltas (never exits)" },
  await: { summary: "Block until a plan/git/job condition holds" },
  "commit-work": {
    summary: "Stage session-attributed files, lint, commit, push",
    agentHelp: true,
  },
  baseline: {
    summary:
      "Read the suite-baseline result at a commit (--wait triggers + blocks)",
  },
  "setup-tmux": {
    summary: "Provision the tmux control plane (dash + work sessions)",
  },
  tabs: {
    summary:
      "Restore keeper agents after a crash: `keeper tabs <list|restore|dump>`",
    verbs: ["list", "restore", "dump"],
  },
  "session-state": {
    summary: "Current session git context + on-hook files (JSON)",
  },
  "show-session-files": {
    summary: "Session's on-hook dirty files grouped by repo (JSON)",
  },
  "search-history": {
    summary: "Search UserPromptSubmit history by LIKE term (JSON)",
  },
  "find-file-history": {
    summary: "List file attributions matching a path fragment (JSON)",
  },
  "show-session-events": {
    summary: "Prompt/tool-call spine for one session (JSON)",
  },
  "show-job": {
    summary:
      "One job's full metadata by session-id/title/cwd/pane or auto-detect (JSON)",
  },
  "session-summary": {
    summary:
      "Bounded one-shot summary of one session (title/prompts/counts) — skip the transcript (JSON)",
  },
  plan: {
    summary:
      "The plan CLI: `keeper plan <verb>` runs the plan dispatcher in-process",
    verbs: [
      "status",
      "epics",
      "tasks",
      "ready",
      "show",
      "cat",
      "list",
      "scaffold",
      "init",
      "claim",
      "done",
      "block",
      "unblock",
      "verdict",
      "close-preflight",
      "close-finalize",
      "validate",
      "audit",
      "reconcile",
      "gist",
      "mv-repo",
      "followup",
    ],
  },
  prompt: {
    summary:
      "Snippet/bundle substrate engine: `keeper prompt <verb>` runs the prompt CLI in-process",
    verbs: [
      "render",
      "check-generated",
      "render-plugin-templates",
      "build-snippets",
      "find-snippets",
      "save-snippet",
      "save-bundle",
      "validate-bundles",
      "list-bundles",
      "show-bundle",
    ],
  },
  dispatch: {
    summary:
      "Manually fire one claude worker into a tmux window (client-side escape hatch)",
    agentHelp: true,
  },
  handoff: {
    summary:
      "Enqueue a fire-and-forget claude worker with a contextful brief (`keeper handoff show <id>` reads it)",
    agentHelp: true,
  },
  agent: {
    summary:
      "Launch an agent CLI: `keeper agent <claude|codex|pi> [args...]` (folded keeper agent launcher)",
    verbs: [
      "claude",
      "codex",
      "pi",
      "run",
      "wait",
      "panel",
      "presets",
      "transcript",
    ],
  },
  reclaim: {
    summary:
      "OFFLINE size-reclaim of the live keeper.db (daemon must be stopped)",
    agentHelp: true,
  },
  bus: {
    summary: "Agent Bus: `keeper bus <list|resolve|chat send|watch>`",
    verbs: ["list", "watch", "wake", "chat"],
  },
  "statusline-sink": {
    summary:
      "Coalesce a Claude Code statusLine payload (stdin) into a per-session leaf",
  },
  completions: {
    summary:
      "Emit a shell completion script: `keeper completions <bash|zsh|fish>`",
  },
};

/**
 * The shared exit-code taxonomy, published in `keeper --help --json` so every
 * one-shot command's exit semantics live in one machine-readable place. Codes
 * 0/1/2 are the common core; 3–5 are await-specific (and 3 doubles as handoff's
 * slug-collision). The one deliberate DIVERGENCE: `keeper <sub>` unknown-
 * subcommand exits 1, but the `plan`/`prompt` sub-CLIs exit 2 on an unknown
 * VERB (Click/argparse parity is frozen for Python byte-compat) — documented
 * here rather than silently reconciled.
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
};

/** The `keeper --help --json` command index. A discovery/introspection surface,
 *  deliberately EXEMPT from the `{schema_version, ok, error, data}` one-shot
 *  envelope (like `watch`/`cat`) — it is neither a state read nor a mutate and
 *  cannot fail transport, so it prints its shape flat for a direct `jq
 *  '.subcommands'`. */
export interface HelpIndex {
  subcommands: Array<{
    name: Subcommand;
    summary: string;
    verbs?: readonly string[];
    agent_help: boolean;
  }>;
  exit_codes: Record<string, string>;
}

export function buildHelpIndex(): HelpIndex {
  return {
    subcommands: SUBCOMMANDS.map((name) => {
      const meta = SUBCOMMAND_META[name];
      const entry: HelpIndex["subcommands"][number] = {
        name,
        summary: meta.summary,
        agent_help: meta.agentHelp === true,
      };
      if (meta.verbs !== undefined) entry.verbs = meta.verbs;
      return entry;
    }),
    exit_codes: EXIT_CODES,
  };
}

const SUBCOMMAND_LINES = SUBCOMMANDS.map(
  (name) => `  ${name.padEnd(19)} ${SUBCOMMAND_META[name].summary}`,
).join("\n");

export const USAGE = `keeper — unified CLI for the keeper TUIs

Usage:
  keeper <subcommand> [options]

Subcommands:
${SUBCOMMAND_LINES}

Flags:
  --help, -h     Show this help (\`--help --json\` → machine-readable command index)
  --version, -V  Show keeper version

The six snapshot-capable viewer subcommands (board/jobs/git/usage/autopilot/builds)
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
 * residual instead; completion candidates come from `SUBCOMMAND_META[*].verbs`.
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
 */
export function buildCompletionCli(version: string): Clerc {
  const commands = SUBCOMMANDS.filter((name) => name !== "completions").flatMap(
    (name) => {
      const parent = defineCommand({
        name,
        description: SUBCOMMAND_META[name].summary,
      });
      const verbs = (SUBCOMMAND_META[name].verbs ?? []).map((verb) =>
        defineCommand({
          name: `${name} ${verb}`,
          description: `${name} ${verb}`,
        }),
      );
      return [parent, ...verbs];
    },
  );
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

/** The `keeper completions <shell>` handler: validate the shell against keeper's
 *  supported set, emit the framework-generated script, exit 0. A missing/unknown
 *  shell is an arg fault (exit 2) naming the supported shells — never a silent
 *  empty script. */
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
    git: async (argv) => (await import("./git")).main(argv),
    usage: async (argv) => (await import("./usage")).main(argv),
    autopilot: async (argv) => (await import("./autopilot")).main(argv),
    builds: async (argv) => (await import("./builds")).main(argv),
    dash: async (argv) => (await import("./dash")).main(argv),
    status: async (argv) => (await import("./status")).main(argv),
    query: async (argv) => (await import("./query")).main(argv),
    watch: async (argv) => (await import("./watch")).main(argv),
    await: async (argv) => (await import("./await")).main(argv),
    "commit-work": async (argv) => (await import("./commit-work")).main(argv),
    baseline: async (argv) => (await import("./baseline")).main(argv),
    "setup-tmux": async (argv) => (await import("./setup-tmux")).main(argv),
    tabs: async (argv) => (await import("./tabs")).main(argv),
    "session-state": async (argv) =>
      (await import("./session-state")).main(argv),
    "show-session-files": async (argv) =>
      (await import("./show-session-files")).main(argv),
    "search-history": async (argv) =>
      (await import("./search-history")).main(argv),
    "find-file-history": async (argv) =>
      (await import("./find-file-history")).main(argv),
    "show-session-events": async (argv) =>
      (await import("./show-session-events")).main(argv),
    "show-job": async (argv) => (await import("./show-job")).main(argv),
    "session-summary": async (argv) =>
      (await import("./session-summary")).main(argv),
    plan: async (argv) => (await import("./plan")).main(argv),
    prompt: async (argv) => (await import("./prompt")).main(argv),
    dispatch: async (argv) => (await import("./dispatch")).main(argv),
    handoff: async (argv) => (await import("./handoff")).main(argv),
    agent: async (argv) => (await import("./agent")).main(argv),
    reclaim: async (argv) => (await import("./reclaim")).main(argv),
    bus: async (argv) => (await import("./bus")).main(argv),
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
